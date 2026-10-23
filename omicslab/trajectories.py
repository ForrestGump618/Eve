"""Turn trajectory recording.

每轮对话都会在 ``<home>/trajectories/<conversation_id>/<turn_id>.jsonl`` 写一份
可回放的轨迹：meta 头、按时间顺序的 AgentEvent、以及结束记录。轨迹用于审计
模型行为、复现工具调用、以及作为 RSI 发现项目的证据材料。

记录失败绝不打断主流程（``_safe`` 包装所有 IO）。
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .agent.types import AgentEvent, new_id
from .config import Settings

logger = logging.getLogger("omicslab.trajectories")

TURN_FILE_SUFFIX = ".jsonl"
_SAFE_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _valid_id(token: str) -> bool:
    token = str(token or "")
    return bool(token) and len(token) <= 80 and all(ch in _SAFE_ID_CHARS for ch in token)


def _safe(func):
    """Best-effort wrapper: trajectory recording must never break a turn."""

    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception:  # pragma: no cover - disk/permission edge cases
            logger.warning("轨迹记录失败（已忽略）：%s", func.__name__, exc_info=True)
            return None

    return wrapper


def _conversation_dir(settings: Settings, conversation_id: str) -> Path:
    if not _valid_id(conversation_id):
        raise ValueError(f"非法会话 ID：{conversation_id!r}")
    return settings.trajectories_dir / conversation_id


class TrajectoryRecorder:
    """Append-only writer for one conversation turn."""

    def __init__(
        self,
        settings: Settings,
        conversation_id: str,
        *,
        agent: str = "lead",
        provider: str = "",
        model: str = "",
        turn_id: str | None = None,
    ) -> None:
        self.settings = settings
        self.conversation_id = str(conversation_id)
        self.agent = str(agent or "lead")
        self.provider = str(provider or "")
        self.model = str(model or "")
        self.turn_id = turn_id or new_id("turn")
        self.started_at = _now_iso()
        self._events = 0
        self._path = _conversation_dir(settings, self.conversation_id) / (
            self.turn_id + TURN_FILE_SUFFIX
        )

    @property
    def path(self) -> Path:
        return self._path

    def _append(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(payload, ensure_ascii=False, default=str)
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    @_safe
    def start(self) -> "TrajectoryRecorder":
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # A turn id is unique; truncate defensively in case of a rerun.
        self._path.write_text("", encoding="utf-8")
        self._append(
            {
                "type": "meta",
                "conversation_id": self.conversation_id,
                "turn_id": self.turn_id,
                "agent": self.agent,
                "provider": self.provider,
                "model": self.model,
                "started_at": self.started_at,
                "ts": self.started_at,
                "workspace": str(self.settings.workspace),
            }
        )
        return self

    @_safe
    def record(self, event: AgentEvent) -> None:
        if not isinstance(event, AgentEvent):
            return
        self._events += 1
        self._append({"type": "event", "event": event.to_dict()})

    @_safe
    def finish(
        self,
        finish_reason: str = "done",
        *,
        usage: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        self._append(
            {
                "type": "done",
                "turn_id": self.turn_id,
                "finish_reason": str(finish_reason or "done"),
                "usage": usage or {},
                "error": str(error or ""),
                "events": self._events,
                "ended_at": _now_iso(),
            }
        )


# ---------------------------------------------------------------------------
# read side (used by the REST API)
# ---------------------------------------------------------------------------


def list_trajectories(settings: Settings, conversation_id: str = "") -> list[dict[str, Any]]:
    """List recorded turns, newest first."""
    items: list[dict[str, Any]] = []
    try:
        root = settings.trajectories_dir
    except OSError:
        return items
    if not root.is_dir():
        return items
    conversation_ids: list[str]
    if conversation_id:
        conversation_ids = [conversation_id] if _valid_id(conversation_id) else []
    else:
        conversation_ids = sorted(
            entry.name for entry in root.iterdir() if entry.is_dir() and _valid_id(entry.name)
        )
    for cid in conversation_ids:
        directory = root / cid
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*" + TURN_FILE_SUFFIX), reverse=True):
            try:
                stat = path.stat()
            except OSError:
                continue
            items.append(
                {
                    "turn_id": path.stem,
                    "conversation_id": cid,
                    "path": str(path),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                    "finish_reason": _read_finish_reason(path),
                }
            )
    items.sort(key=lambda item: item.get("mtime") or 0.0, reverse=True)
    return items


def _iter_records(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    yield record
    except OSError:
        return


def _read_finish_reason(path: Path) -> str:
    reason = ""
    for record in _iter_records(path):
        if record.get("type") == "done":
            reason = str(record.get("finish_reason") or "")
    return reason


def load_trajectory(
    settings: Settings, conversation_id: str, turn_id: str
) -> dict[str, Any] | None:
    """Load one turn: metadata, events and the done record."""
    if not _valid_id(conversation_id) or not _valid_id(turn_id):
        return None
    path = _conversation_dir(settings, conversation_id) / (turn_id + TURN_FILE_SUFFIX)
    if not path.is_file():
        return None
    meta: dict[str, Any] = {}
    done: dict[str, Any] = {}
    events: list[dict[str, Any]] = []
    for record in _iter_records(path):
        kind = record.get("type")
        if kind == "meta":
            meta = record
        elif kind == "event":
            event = record.get("event")
            if isinstance(event, dict):
                events.append(event)
        elif kind == "done":
            done = record
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return {
        "turn_id": turn_id,
        "conversation_id": conversation_id,
        "path": str(path),
        "size": size,
        "meta": meta,
        "events": events,
        "done": done,
    }


def delete_trajectory(settings: Settings, conversation_id: str, turn_id: str) -> bool:
    if not _valid_id(conversation_id) or not _valid_id(turn_id):
        return False
    path = _conversation_dir(settings, conversation_id) / (turn_id + TURN_FILE_SUFFIX)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


__all__ = [
    "TrajectoryRecorder",
    "delete_trajectory",
    "list_trajectories",
    "load_trajectory",
]
