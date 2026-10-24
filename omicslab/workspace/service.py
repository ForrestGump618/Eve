"""Workspace registry and conversation binding.

Workspaces are the unit of isolation: a conversation binds to exactly one
workspace, and a run inherits the binding. The registry only stores metadata;
files are never moved or deleted by this service.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import Settings
from ..utils import atomic_write_text

logger = logging.getLogger("omicslab.workspace")

DEFAULT_WORKSPACE_ID = "ws_main"
STATUSES = {"idle", "in_use", "offline", "unknown"}


class WorkspaceError(ValueError):
    """Invalid workspace operation."""


@dataclass
class Workspace:
    workspace_id: str
    name: str
    backend: str = "local"
    local_path: str = ""
    remote: dict[str, Any] = field(default_factory=dict)
    conversation_id: str | None = None
    project_id: str | None = None
    status: str = "idle"
    created_at: float = field(default_factory=lambda: time.time())
    updated_at: float = field(default_factory=lambda: time.time())
    default: bool = False

    @property
    def root(self) -> Path | None:
        if self.backend != "local" or not self.local_path:
            return None
        return Path(self.local_path).expanduser().resolve()

    @property
    def scope(self) -> str:
        return "main" if self.default else f"ws:{self.workspace_id}"

    def to_dict(self) -> dict[str, Any]:
        data = {
            "workspace_id": self.workspace_id,
            "name": self.name,
            "backend": self.backend,
            "local_path": self.local_path,
            "remote": dict(self.remote or {}),
            "conversation_id": self.conversation_id,
            "project_id": self.project_id,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "default": self.default,
        }
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Workspace":
        return cls(
            workspace_id=str(data.get("workspace_id") or ""),
            name=str(data.get("name") or ""),
            backend=str(data.get("backend") or "local"),
            local_path=str(data.get("local_path") or ""),
            remote=dict(data.get("remote") or {}),
            conversation_id=data.get("conversation_id"),
            project_id=data.get("project_id"),
            status=str(data.get("status") or "idle"),
            created_at=float(data.get("created_at") or time.time()),
            updated_at=float(data.get("updated_at") or time.time()),
            default=bool(data.get("default")),
        )


class WorkspaceService:
    """Thread-safe registry persisted under ``<home>/workspaces.json``."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.path = Path(settings.home) / "workspaces.json"
        self._lock = threading.RLock()
        self._workspaces: dict[str, Workspace] = {}
        self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> None:
        with self._lock:
            raw: dict[str, Any] = {}
            if self.path.exists():
                try:
                    raw = json.loads(self.path.read_text(encoding="utf-8"))
                except Exception:
                    logger.exception("读取工作区注册表失败，将重建：%s", self.path)
                    raw = {}
            items = raw.get("workspaces") if isinstance(raw, dict) else None
            if not isinstance(items, list) or not items:
                self._workspaces = {DEFAULT_WORKSPACE_ID: self._default_record()}
                self._save_locked()
                return
            for item in items:
                if not isinstance(item, dict):
                    continue
                ws = Workspace.from_dict(item)
                if ws.workspace_id:
                    self._workspaces[ws.workspace_id] = ws
            if DEFAULT_WORKSPACE_ID not in self._workspaces:
                self._workspaces[DEFAULT_WORKSPACE_ID] = self._default_record()
            # exactly one default
            defaults = [ws for ws in self._workspaces.values() if ws.default]
            if not defaults:
                self._workspaces[DEFAULT_WORKSPACE_ID].default = True
            elif len(defaults) > 1:
                for ws in defaults[1:]:
                    ws.default = False
            self._save_locked()

    def _default_record(self) -> Workspace:
        return Workspace(
            workspace_id=DEFAULT_WORKSPACE_ID,
            name="主工作区",
            backend="local",
            local_path=str(Path(self.settings.workspace).resolve()),
            status="idle",
            default=True,
        )

    def _save_locked(self) -> None:
        payload = {
            "version": 1,
            "workspaces": [ws.to_dict() for ws in self._workspaces.values()],
        }
        try:
            atomic_write_text(self.path, json.dumps(payload, ensure_ascii=False, indent=2))
        except Exception:
            logger.exception("写入工作区注册表失败")

    def _save(self) -> None:
        with self._lock:
            self._save_locked()

    # -- queries -----------------------------------------------------------
    def list(self) -> list[Workspace]:
        with self._lock:
            items = list(self._workspaces.values())
        items.sort(key=lambda ws: (not ws.default, ws.created_at))
        return items

    def get(self, workspace_id: str | None) -> Workspace | None:
        if not workspace_id:
            return None
        with self._lock:
            return self._workspaces.get(str(workspace_id))

    def default(self) -> Workspace:
        with self._lock:
            for ws in self._workspaces.values():
                if ws.default:
                    return ws
            ws = self._default_record()
            self._workspaces[ws.workspace_id] = ws
            self._save_locked()
            return ws

    def workspace_for_conversation(self, conversation_id: str | None) -> Workspace:
        if conversation_id:
            with self._lock:
                for ws in self._workspaces.values():
                    if ws.conversation_id == conversation_id:
                        return ws
        return self.default()

    def public(self, ws: Workspace | None) -> dict[str, Any]:
        if ws is None:
            return {}
        data = ws.to_dict()
        root = ws.root
        data["resolved_path"] = str(root) if root else str(ws.remote.get("root") or "~")
        data["scope"] = ws.scope
        data["online"] = True if ws.backend == "local" else None
        data.pop("local_path", None)
        return data

    def resolve_root(self, ws: Workspace | None) -> Path:
        root = ws.root if ws is not None else None
        if root is None:
            raise WorkspaceError("该工作区不是本地目录，无法使用本地文件工具")
        return root

    # -- mutations ---------------------------------------------------------
    def create(
        self,
        name: str = "",
        *,
        local_path: str = "",
        backend: str = "local",
        remote: dict[str, Any] | None = None,
        workspace_id: str | None = None,
    ) -> Workspace:
        backend = (backend or "local").strip().lower()
        if backend not in {"local", "ssh"}:
            raise WorkspaceError(f"不支持的工作区后端：{backend}")
        with self._lock:
            ws_id = workspace_id or f"ws_{uuid.uuid4().hex[:10]}"
            if ws_id in self._workspaces:
                raise WorkspaceError(f"工作区已存在：{ws_id}")
            if backend == "local":
                base = Path(self.settings.workspace).resolve()
                if local_path:
                    candidate = Path(local_path).expanduser()
                    directory = candidate if candidate.is_absolute() else (base / candidate)
                else:
                    directory = base / "workspaces" / ws_id
                directory = directory.resolve()
                try:
                    directory.mkdir(parents=True, exist_ok=True)
                except OSError as exc:
                    raise WorkspaceError(f"无法创建工作区目录：{exc}") from exc
                record = Workspace(
                    workspace_id=ws_id,
                    name=name.strip() or f"工作区 {len(self._workspaces)}",
                    backend="local",
                    local_path=str(directory),
                )
            else:
                remote_data = {key: value for key, value in dict(remote or {}).items()
                               if key in {"profile_id", "root", "host", "username", "python", "cwd"}}
                if not remote_data.get("profile_id"):
                    raise WorkspaceError("SSH 工作区需要提供 profile_id")
                remote_data.setdefault("root", "~")
                record = Workspace(
                    workspace_id=ws_id,
                    name=name.strip() or f"SSH 工作区 {len(self._workspaces)}",
                    backend="ssh",
                    local_path="",
                    remote=remote_data,
                )
            self._workspaces[ws_id] = record
            self._save_locked()
            return record

    def delete(self, workspace_id: str) -> Workspace:
        with self._lock:
            ws = self._workspaces.get(str(workspace_id))
            if ws is None:
                raise WorkspaceError(f"工作区不存在：{workspace_id}")
            if ws.default:
                raise WorkspaceError("默认工作区不能删除")
            if ws.status == "in_use":
                raise WorkspaceError("工作区正在使用中，无法删除")
            self._workspaces.pop(ws.workspace_id, None)
            self._save_locked()
            return ws

    def bind_conversation(self, conversation_id: str, workspace_id: str) -> Workspace:
        conversation_id = str(conversation_id or "").strip()
        if not conversation_id:
            raise WorkspaceError("conversation_id 不能为空")
        with self._lock:
            ws = self._workspaces.get(str(workspace_id))
            if ws is None:
                raise WorkspaceError(f"工作区不存在：{workspace_id}")
            for other in self._workspaces.values():
                if other.workspace_id != ws.workspace_id and other.conversation_id == conversation_id:
                    other.conversation_id = None
                    other.updated_at = time.time()
            ws.conversation_id = conversation_id
            ws.updated_at = time.time()
            self._save_locked()
            return ws

    def mark_in_use(self, workspace_id: str) -> None:
        with self._lock:
            ws = self._workspaces.get(str(workspace_id))
            if ws is not None and ws.status != "in_use":
                ws.status = "in_use"
                ws.updated_at = time.time()
                self._save_locked()

    def mark_idle(self, workspace_id: str) -> None:
        if not workspace_id:
            return
        with self._lock:
            ws = self._workspaces.get(str(workspace_id))
            if ws is not None and ws.status == "in_use":
                ws.status = "idle"
                ws.updated_at = time.time()
                self._save_locked()
