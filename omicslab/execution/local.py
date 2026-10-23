"""Local execution backend: kernel + shell + files on this machine."""

from __future__ import annotations

import asyncio
import logging
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..config import Settings
from ..server import files as files_api
from .base import BackendError, BackendUnavailable, ExecutionBackend

logger = logging.getLogger("omicslab.execution.local")


def _quote_cwd(cwd: str) -> str:
    return f"cd /d {subprocess.list2cmdline([cwd])} && " if sys.platform == "win32" else f"cd {shlex.quote(cwd)} && "


class LocalExecutionBackend(ExecutionBackend):
    kind = "local"

    def __init__(self, settings: Settings, workspace: Any, kernel: Any) -> None:
        super().__init__(workspace)
        self.settings = settings
        self.kernel = kernel
        self._root = Path(workspace.root) if getattr(workspace, "root", None) else Path(settings.workspace)

    # -- lifecycle ---------------------------------------------------------
    @property
    def root(self) -> Path:
        return self._root

    async def start(self) -> None:
        await self.kernel.start()

    async def close(self) -> None:
        # Kernels are pooled per workspace and stopped by the app lifespan.
        return None

    async def status(self) -> dict[str, Any]:
        try:
            kernel_status = self.kernel.status()
        except Exception:  # pragma: no cover - defensive
            kernel_status = {"running": False}
        return {
            "backend": self.kind,
            "workspace_id": getattr(self.workspace, "workspace_id", None),
            "root": str(self._root),
            "kernel": kernel_status,
        }

    async def interrupt(self) -> None:
        try:
            await self.kernel.interrupt()
        except Exception:
            logger.exception("中断内核失败")

    # -- compute -----------------------------------------------------------
    async def execute_python(self, code: str, timeout_s: float | None = None) -> dict[str, Any]:
        return await self.kernel.execute(code, timeout_s=timeout_s)

    async def list_vars(self) -> list[dict[str, Any]]:
        return await self.kernel.list_vars()

    async def var_detail(self, name: str) -> dict[str, Any]:
        return await self.kernel.var_detail(name)

    async def shell(
        self, command: str, *, cwd: str = "", timeout_s: float | None = None
    ) -> dict[str, Any]:
        workdir = self._root
        if cwd:
            candidate = (self._root / cwd).resolve()
            try:
                candidate.relative_to(self._root)
            except ValueError as exc:
                raise BackendError(f"工作目录越出工作区：{cwd}") from exc
            if not candidate.is_dir():
                raise BackendError(f"工作目录不存在：{cwd}")
            workdir = candidate
        return await asyncio.to_thread(self._run_shell_sync, command, workdir, timeout_s)

    def _run_shell_sync(self, command: str, workdir: Path, timeout_s: float | None) -> dict[str, Any]:
        timeout = float(timeout_s or self.settings.shell_timeout_s or 120)
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(workdir),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "exit_code": -1,
                "stdout": (exc.stdout or "") if isinstance(exc.stdout, str) else "",
                "stderr": f"命令超时（>{timeout:.0f}s）",
                "timed_out": True,
            }
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": proc.stdout or "",
            "stderr": proc.stderr or "",
            "timed_out": False,
        }

    # -- files -------------------------------------------------------------
    async def list_dir(self, rel: str = ".", *, show_hidden: bool = False) -> dict[str, Any]:
        return await asyncio.to_thread(
            files_api.list_dir, self.settings, rel, show_hidden=show_hidden, root=self._root
        )

    async def read_text(self, rel: str, max_bytes: int = 200_000) -> dict[str, Any]:
        return await asyncio.to_thread(
            files_api.read_text, self.settings, rel, max_bytes, root=self._root
        )

    async def write_text(self, rel: str, content: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            files_api.write_text, self.settings, rel, content, root=self._root
        )

    async def make_dir(self, rel: str) -> dict[str, Any]:
        return await asyncio.to_thread(files_api.make_dir, self.settings, rel, root=self._root)

    async def delete_path(self, rel: str) -> dict[str, Any]:
        return await asyncio.to_thread(files_api.delete_path, self.settings, rel, root=self._root)

    async def save_upload(self, rel_dir: str, filename: str, data: bytes) -> dict[str, Any]:
        return await asyncio.to_thread(
            files_api.save_upload, self.settings, rel_dir, filename, data, root=self._root
        )

    async def read_bytes(self, rel: str) -> tuple[bytes, str, str]:
        def _read() -> tuple[bytes, str, str]:
            path = files_api.resolve_path(self.settings, rel, root=self._root)
            if not path.is_file():
                raise BackendError(f"文件不存在：{rel}")
            data = path.read_bytes()
            return data, path.name, files_api.guess_mime(path)

        return await asyncio.to_thread(_read)
