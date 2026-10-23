"""Execution backends: local (this machine) and remote (SSH)."""

from __future__ import annotations

import importlib
from typing import Any, Awaitable, Callable

from .base import (
    BackendBase,
    BackendError,
    BackendUnavailable,
    BackendUnsupported,
    ExecutionBackend,
    RemoteUnavailable,
)
from .local import LocalExecutionBackend

__all__ = [
    "BackendBase",
    "BackendError",
    "BackendUnavailable",
    "BackendUnsupported",
    "ExecutionBackend",
    "LocalExecutionBackend",
    "RemoteUnavailable",
    "SSHExecutionBackend",
    "make_backend",
]


def _load_ssh_backend() -> type[ExecutionBackend] | None:
    try:
        module = importlib.import_module("omicslab.execution.ssh_backend")
    except ImportError:
        return None
    for name in ("SSHExecutionBackend", "SSHBackend", "RemoteExecutionBackend"):
        candidate = getattr(module, name, None)
        if candidate is not None:
            return candidate
    return None


async def make_backend(
    settings: Any,
    workspace: Any,
    *,
    kernel_provider: Callable[[str], Awaitable[Any]] | None = None,
    connections: Any = None,
) -> ExecutionBackend:
    """Build the backend for a workspace.

    Local workspaces get a pooled kernel; SSH workspaces use the remote backend
    when it is available and fail explicitly otherwise (never silently local).
    """
    backend_kind = str(getattr(workspace, "backend", "local") or "local")
    if backend_kind == "local":
        if kernel_provider is None:
            raise BackendUnavailable("本地后端缺少内核提供者")
        kernel = await kernel_provider(getattr(workspace, "scope", "main"))
        backend = LocalExecutionBackend(settings, workspace, kernel)
        await backend.start()
        return backend
    if backend_kind == "ssh":
        factory = _load_ssh_backend()
        if factory is None:
            raise BackendUnavailable(
                "SSH 执行后端尚未安装/接入，请先完成远端后端配置后再在 SSH 工作区运行"
            )
        try:
            backend = factory(workspace, settings=settings, connections=connections)
        except TypeError:
            backend = factory(workspace)
        await backend.start()
        return backend
    raise BackendUnsupported(f"未知工作区后端：{backend_kind}")
