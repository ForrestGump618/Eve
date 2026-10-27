"""Local execution backend: kernel + shell + files on this machine."""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import signal
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
        return await self._run_shell_async(command, workdir, timeout_s)

    async def _run_shell_async(
        self, command: str, workdir: Path, timeout_s: float | None
    ) -> dict[str, Any]:
        timeout = float(timeout_s or self.settings.shell_timeout_s or 120)
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(workdir),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
            start_new_session=sys.platform != "win32",
        )
        captured = 0
        limited = False
        async def capture(stream):
            nonlocal captured, limited
            chunks = []
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    break
                remaining = max(0, 1_000_000-captured)
                if len(chunk) > remaining:
                    limited = True
                kept = chunk[:remaining]
                captured += len(kept)
                if kept:
                    chunks.append(kept)
            return b"".join(chunks)
        collection = asyncio.gather(capture(process.stdout), capture(process.stderr), process.wait())
        try:
            stdout, stderr, _ = await asyncio.wait_for(asyncio.shield(collection), timeout=timeout)
        except asyncio.TimeoutError:
            await self._terminate_process(process)
            await asyncio.gather(collection, return_exceptions=True)
            return {
                "ok": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": f"命令超时（>{timeout:.0f}s）",
                "timed_out": True,
            }
        except asyncio.CancelledError:
            await self._terminate_process(process)
            await asyncio.gather(collection, return_exceptions=True)
            raise
        stdout_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")
        return {
            "ok": process.returncode == 0 and not limited,
            "exit_code": process.returncode,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "timed_out": False,
            "truncated": limited,
            "status": "output_limited" if limited else "ok" if process.returncode == 0 else "nonzero",
        }

    async def _terminate_process(self, process: asyncio.subprocess.Process) -> None:
        """Stop the owned shell tree without joining the bridge's event loop."""
        if process.returncode is not None:
            return
        if sys.platform == "win32":
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(process.pid), "/T", "/F",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(killer.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                if killer.returncode is None:
                    killer.kill()
        else:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await asyncio.wait_for(process.wait(), timeout=5)

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
