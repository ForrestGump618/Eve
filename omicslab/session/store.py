"""Conversation persistence on top of the local filesystem.

One JSON file per conversation under ``<home>/conversations/<id>.json``.
Writes are atomic (temp file + ``os.replace``) so a crashed process never
leaves a half-written conversation behind.
"""

from __future__ import annotations

import copy
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from omicslab.agent.types import ChatMessage, Conversation
from omicslab.config import ConfigError, Settings
from omicslab.utils import atomic_write_text

logger = logging.getLogger("omicslab.session.store")

CID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_TITLE_CHARS = 200
DEFAULT_TITLE = "新会话"


class ConversationNotFound(KeyError, ConfigError):
    """Raised when a conversation id does not resolve to a readable file.

    Inherits from both ``KeyError`` (dictionary-like lookups) and
    ``ConfigError`` (the project error convention) so callers catching either
    one behave correctly.
    """

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return str(self.args[0]) if self.args else "conversation not found"


class ConversationStore:
    """Create/read/update/delete conversations persisted as JSON files."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._summaries: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}

    # -- paths -------------------------------------------------------------
    @property
    def root(self) -> Path:
        return self.settings.conversations_dir

    def _ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, cid: str) -> Path:
        key = str(cid or "").strip()
        if not CID_RE.match(key):
            raise ConversationNotFound(f"非法的会话 id: {cid!r}")
        return self.root / f"{key}.json"

    # -- public API --------------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        """Return conversation summaries ordered by ``updated_at`` desc.

        Corrupt or unreadable files are skipped with a warning; a single bad
        file must never break the conversation sidebar.
        """
        self._ensure_root()
        summaries: list[dict[str, Any]] = []
        try:
            paths = sorted(self.root.glob("*.json"))
        except OSError as exc:  # pragma: no cover - unusual fs failure
            logger.warning("无法列出会话目录 %s: %s", self.root, exc)
            return summaries
        for path in paths:
            try:
                stat = path.stat()
                stamp = (stat.st_mtime_ns, stat.st_size)
                cached = self._summaries.get(path.stem)
                if cached and cached[0] == stamp:
                    summaries.append(copy.deepcopy(cached[1]))
                    continue
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("会话文件不是 JSON 对象")
                conversation = Conversation.from_dict(data)
                summary = conversation.summary()
                summary["message_count"] = len(conversation.messages)
                summaries.append(summary)
                self._summaries[path.stem] = (stamp, copy.deepcopy(summary))
            except (OSError, ValueError, TypeError, KeyError) as exc:
                logger.warning("跳过损坏的会话文件 %s: %s", path, exc)
                continue
        if len(self._summaries) > 512:
            self._summaries = dict(list(self._summaries.items())[-512:])
        summaries.sort(key=lambda item: float(item.get("updated_at") or 0.0), reverse=True)
        return summaries

    def get(self, cid: str) -> Conversation:
        """Load a conversation; raises ``ConversationNotFound`` when missing."""
        path = self._path(cid)
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise ConversationNotFound(str(cid)) from exc
        except OSError as exc:
            raise ConversationNotFound(f"{cid}: {exc}") from exc
        try:
            data = json.loads(text)
        except ValueError as exc:
            logger.warning("会话文件损坏 %s: %s", path, exc)
            raise ConversationNotFound(f"{cid}（文件损坏）") from exc
        if not isinstance(data, dict):
            raise ConversationNotFound(f"{cid}（文件格式错误）")
        conversation = Conversation.from_dict(data)
        # Trust the file name as the canonical id.
        conversation.id = path.stem
        return conversation

    def create(self, agent: str = "lead", title: str = DEFAULT_TITLE) -> Conversation:
        """Create and persist a new empty conversation."""
        conversation = Conversation(agent=str(agent or "lead"), title=_clean_title(title))
        self.save(conversation)
        logger.info("新建会话 %s（agent=%s）", conversation.id, conversation.agent)
        return conversation

    def save(self, conv: Conversation) -> None:
        """Persist a conversation atomically (also refreshes ``updated_at``)."""
        if conv is None:
            raise TypeError("ConversationStore.save() 需要一个 Conversation 对象")
        if not CID_RE.match(str(conv.id or "")):
            raise ConfigError(f"非法的会话 id: {conv.id!r}")
        conv.title = _clean_title(conv.title)
        conv.updated_at = time.time()
        with self._lock:
            # UI metadata must survive a later save from an in-flight run's object.
            path = self._path(conv.id)
            if path.exists():
                saved = self.get(conv.id)
                for key in ("archived", "pinned"):
                    if key in saved.meta:
                        conv.meta[key] = saved.meta[key]
            self._write_locked(conv)

    def _write_locked(self, conv: Conversation) -> None:
        self._ensure_root()
        atomic_write_text(self._path(conv.id), json.dumps(conv.to_dict(), ensure_ascii=False, indent=2))
        self._summaries.pop(conv.id, None)

    def update_metadata(self, cid: str, patch: dict[str, Any]) -> Conversation:
        with self._lock:
            conv = self.get(cid)
            if "title" in patch:
                conv.title = _clean_title(patch["title"])
            for key in ("archived", "pinned"):
                if key in patch:
                    if not isinstance(patch[key], bool):
                        raise ValueError(f"{key} must be boolean")
                    conv.meta[key] = patch[key]
            # Archiving/pinning doesn't promote an old conversation to most recent.
            self._write_locked(conv)
            return conv

    def delete(self, cid: str) -> bool:
        """Delete a conversation file; returns False when it did not exist."""
        path = self._path(cid)
        with self._lock:
            try:
                path.unlink()
                logger.info("已删除会话 %s", cid)
                return True
            except FileNotFoundError:
                return False
            except OSError as exc:
                raise ConfigError(f"删除会话失败: {exc}") from exc

    def rename(self, cid: str, title: str) -> Conversation:
        """Update the title of an existing conversation."""
        conversation = self.get(cid)
        conversation.title = _clean_title(title)
        self.save(conversation)
        return conversation

    # -- convenience used by the agent loop --------------------------------
    def append_message(self, cid: str, message: ChatMessage) -> Conversation:
        """Append one message to a conversation and persist it."""
        conversation = self.get(cid)
        conversation.messages.append(message)
        self.save(conversation)
        return conversation

    def exists(self, cid: str) -> bool:
        try:
            return self._path(cid).is_file()
        except ConversationNotFound:
            return False

    def count(self) -> int:
        try:
            return sum(1 for _ in self.root.glob("*.json"))
        except OSError:
            return 0


def _clean_title(title: Any) -> str:
    text = str(title if title is not None else "").strip()
    if not text:
        text = DEFAULT_TITLE
    if len(text) > MAX_TITLE_CHARS:
        text = text[:MAX_TITLE_CHARS]
    return text
