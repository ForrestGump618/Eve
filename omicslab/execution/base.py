"""Execution backend interfaces.

A backend is the only component allowed to touch a workspace's compute:
kernel, shell, files and figures. Tools and routes therefore stay agnostic
about whether a workspace lives on this machine or on a remote SSH server.
"""

from __future__ import annotations

from typing import Any


class BackendError(RuntimeError):
    """Base error for execution backend failures."""


class BackendUnavailable(BackendError):
    """The backend cannot be used right now (missing dependency, offline...)."""


class BackendUnsupported(BackendError):
    """The backend does not implement the requested capability."""


# Compatibility aliases used by the remote (SSH) backend contract.
RemoteUnavailable = BackendUnavailable
BackendBase = None  # populated below, kept for import symmetry


class ExecutionBackend:
    kind = "abstract"

    def __init__(self, workspace: Any) -> None:
        self.workspace = workspace

    # -- lifecycle ---------------------------------------------------------
    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def interrupt(self) -> None:
        return None

    async def status(self) -> dict[str, Any]:
        return {"backend": self.kind, "workspace": getattr(self.workspace, "workspace_id", None)}

    # -- compute -----------------------------------------------------------
    async def execute_python(self, code: str, timeout_s: float | None = None) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持 Python 执行")

    async def list_vars(self) -> list[dict[str, Any]]:
        raise BackendUnavailable("该后端不支持变量内省")

    async def var_detail(self, name: str) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持变量内省")

    async def shell(self, command: str, *, cwd: str = "", timeout_s: float | None = None) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持 Shell 执行")

    # -- files -------------------------------------------------------------
    async def list_dir(self, rel: str = ".", *, show_hidden: bool = False) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持文件浏览")

    async def read_text(self, rel: str, max_bytes: int = 200_000) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持文件读取")

    async def write_text(self, rel: str, content: str) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持文件写入")

    async def make_dir(self, rel: str) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持目录创建")

    async def delete_path(self, rel: str) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持删除")

    async def save_upload(self, rel_dir: str, filename: str, data: bytes) -> dict[str, Any]:
        raise BackendUnavailable("该后端不支持上传")

    async def read_bytes(self, rel: str) -> tuple[bytes, str, str]:
        raise BackendUnavailable("该后端不支持下载")

    def describe(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "workspace_id": getattr(self.workspace, "workspace_id", None),
            "backend": getattr(self.workspace, "backend", None),
            "root": str(getattr(self.workspace, "root", "") or ""),
        }


BackendBase = ExecutionBackend
