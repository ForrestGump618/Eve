"""Background job execution managed by the session layer.

Two kinds of jobs are supported:

- ``python``: runs a code snippet in a **fresh** Python process using
  ``settings.resolve_kernel_python()``. It does not share state with the
  interactive Jupyter kernel on purpose (isolation, no event-loop coupling).
- ``shell``: runs a command through the platform shell with ``cwd`` fixed to
  the workspace.

Each job owns one worker thread (never bound to the HTTP request loop), one
process, and one log file ``<home>/jobs/<id>.log``. The public API is
synchronous, matching ``CONTRACTS.md`` §6.2.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omicslab.config import ConfigError, Settings

logger = logging.getLogger("omicslab.session.jobs")

JOB_ID_RE = re.compile(r"^j_[0-9a-f]{8}$")
MAX_NAME_CHARS = 120
TERMINATE_GRACE_S = 2.0

# Windows: do not pop up a console window for shell jobs.
_CREATE_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"


@dataclass
class Job:
    """Internal representation of one background job."""

    id: str
    name: str
    kind: str
    code: str
    log_path: Path
    started_at: float
    status: str = STATUS_RUNNING
    ended_at: float | None = None
    exit_code: int | None = None
    error: str | None = None
    proc: subprocess.Popen[Any] | None = None
    cancelled: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)


class JobManager:
    """Submit/list/inspect/cancel background jobs; owns their logs."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._shutdown = threading.Event()

    # -- paths -------------------------------------------------------------
    @property
    def log_dir(self) -> Path:
        return Path(self.settings.jobs_dir)

    @property
    def workspace(self) -> Path:
        return Path(self.settings.workspace)

    # -- public API --------------------------------------------------------
    def submit(self, kind: str, code: str, name: str = "") -> dict[str, Any]:
        """Start a background job and return its initial snapshot."""
        job_kind = str(kind or "python").strip().lower()
        if job_kind == "py":
            job_kind = "python"
        if job_kind not in {"python", "shell"}:
            raise ValueError(f"不支持的任务类型: {kind!r}（仅支持 python / shell）")
        code_text = str(code or "")
        if not code_text.strip():
            raise ValueError("任务代码不能为空。")
        if self._shutdown.is_set():
            raise ConfigError("后台任务管理器已关闭，无法接受新任务。")

        job_id = self._new_job_id()
        display_name = str(name or "").strip()
        if not display_name:
            display_name = "Python 任务" if job_kind == "python" else "Shell 任务"
        if len(display_name) > MAX_NAME_CHARS:
            display_name = display_name[:MAX_NAME_CHARS]

        log_dir = self.log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{job_id}.log"
        try:
            log_path.write_text("", encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"无法创建任务日志 {log_path}: {exc}") from exc

        job = Job(
            id=job_id,
            name=display_name,
            kind=job_kind,
            code=code_text,
            log_path=log_path,
            started_at=time.time(),
        )
        with self._lock:
            self._jobs[job_id] = job
        thread = threading.Thread(
            target=self._run_job,
            args=(job,),
            name=f"omicslab-job-{job_id}",
            daemon=True,
        )
        thread.start()
        logger.info("已提交后台任务 %s（%s）", job_id, display_name)
        return self._snapshot(job)

    def list(self) -> list[dict[str, Any]]:
        """Return job snapshots, most recently started first."""
        with self._lock:
            jobs = list(self._jobs.values())
        jobs.sort(key=lambda job: job.started_at, reverse=True)
        return [self._snapshot(job) for job in jobs]

    def get(self, jid: str) -> dict[str, Any]:
        """Return one job snapshot; raises ``KeyError`` when unknown."""
        job = self._require(jid)
        return self._snapshot(job)

    def log(self, jid: str, offset: int = 0, max_chars: int | None = None) -> dict[str, Any]:
        """Read a log increment starting at ``offset`` (character offset).

        Returns ``{"text", "next_offset", "eof"}``. ``eof`` is True once the
        job finished and all output has been read.
        """
        job = self._require(jid)
        try:
            start = max(0, int(offset))
        except (TypeError, ValueError):
            start = 0
        text = ""
        try:
            text = job.log_path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            text = ""
        except OSError as exc:
            logger.warning("读取任务 %s 日志失败: %s", jid, exc)
        full_len = len(text)
        payload = text[start:]
        if max_chars is not None:
            try:
                limit = max(0, int(max_chars))
            except (TypeError, ValueError):
                limit = None
            if limit is not None and len(payload) > limit:
                payload = payload[-limit:] if limit else ""
        next_offset = max(start, full_len)
        status = self._effective_status(job)
        eof = status != STATUS_RUNNING and next_offset >= full_len
        return {"text": payload, "next_offset": next_offset, "eof": eof}

    def cancel(self, jid: str) -> bool:
        """Terminate a running job. Returns False when it is not running."""
        job = self._require(jid)
        with job.lock:
            if job.status != STATUS_RUNNING:
                return False
            job.cancelled = True
            proc = job.proc
        if proc is not None:
            _terminate_process(proc, job.kind == "shell")
            logger.info("已请求终止后台任务 %s", jid)
        return True

    def shutdown(self) -> None:
        """Terminate every running job; used on server shutdown."""
        self._shutdown.set()
        with self._lock:
            jobs = list(self._jobs.values())
        running = [job for job in jobs if job.status == STATUS_RUNNING]
        for job in running:
            with job.lock:
                job.cancelled = True
                proc = job.proc
            if proc is not None:
                _terminate_process(proc, job.kind == "shell")
        logger.info("后台任务管理器关闭（终止 %d 个运行中任务）", len(running))

    # -- internals ---------------------------------------------------------
    def _new_job_id(self) -> str:
        for _ in range(50):
            candidate = f"j_{uuid.uuid4().hex[:8]}"
            with self._lock:
                if candidate not in self._jobs:
                    return candidate
        return f"j_{uuid.uuid4().hex[:8]}"  # pragma: no cover - astronomically unlikely

    def _require(self, jid: str) -> Job:
        key = str(jid or "").strip()
        with self._lock:
            job = self._jobs.get(key)
        if job is None:
            raise KeyError(key)
        return job

    def _effective_status(self, job: Job) -> str:
        with job.lock:
            # Process exit alone is not a committed job result: the worker still
            # has to close its output handle and publish all final metadata.
            return job.status

    def _snapshot(self, job: Job) -> dict[str, Any]:
        with job.lock:
            status = job.status
            ended_at = job.ended_at
            exit_code = job.exit_code
        log_bytes = 0
        try:
            log_bytes = job.log_path.stat().st_size
        except OSError:
            pass
        return {
            "id": job.id,
            "name": job.name,
            "kind": job.kind,
            "status": status,
            "started_at": job.started_at,
            "ended_at": ended_at,
            "exit_code": exit_code,
            "log_bytes": log_bytes,
        }

    # -- job execution (worker thread) ------------------------------------
    def _run_job(self, job: Job) -> None:
        exit_code: int | None = None
        try:
            if job.cancelled:
                self._finish(job, STATUS_CANCELLED, None)
                return
            if job.kind == "python":
                exit_code = self._run_python(job)
            else:
                exit_code = self._run_shell(job)
        except Exception as exc:  # noqa: BLE001 - job worker must never die
            logger.exception("后台任务 %s 执行失败", job.id)
            self._append_log(job, f"\n[omicslab] 任务执行失败: {exc}\n")
            job.error = str(exc)
            exit_code = 1
        finally:
            with job.lock:
                cancelled = job.cancelled
            if cancelled:
                status = STATUS_CANCELLED
            elif exit_code == 0:
                status = STATUS_DONE
            else:
                status = STATUS_FAILED
            self._finish(job, status, exit_code)
            logger.info("后台任务 %s 结束：%s（exit=%s）", job.id, status, exit_code)

    def _finish(self, job: Job, status: str, exit_code: int | None) -> None:
        with job.lock:
            job.status = status
            job.ended_at = time.time()
            job.exit_code = exit_code

    def _run_python(self, job: Job) -> int:
        """Run the snippet in a fresh interpreter; returns the exit code.

        The snippet is written to ``<home>/jobs/<id>.py`` and executed as a
        regular script.  Deliberately avoids ``asyncio`` subprocess support:
        the server can run on a Windows selector loop (no subprocess support)
        and job workers must never depend on a live event loop.
        """
        interpreter = self.settings.resolve_kernel_python()
        cwd = self.workspace
        cwd.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["MPLBACKEND"] = "Agg"
        env["PYTHONUNBUFFERED"] = "1"
        env.setdefault("PYTHONIOENCODING", "utf-8")
        script_path = job.log_path.with_suffix(".py")
        try:
            script_path.write_text(job.code, encoding="utf-8")
        except OSError as exc:
            self._append_log(job, f"[omicslab] 无法写入任务脚本: {exc}\n")
            return 1
        with open(job.log_path, "a", encoding="utf-8", errors="replace", buffering=1) as handle:
            try:
                proc = subprocess.Popen(
                    [interpreter, "-u", str(script_path)],
                    cwd=str(cwd),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    creationflags=_CREATE_FLAGS,
                )
            except FileNotFoundError as exc:
                handle.write(f"[omicslab] 找不到 Python 解释器 {interpreter!r}: {exc}\n")
                handle.flush()
                return 1
            except OSError as exc:
                handle.write(f"[omicslab] 启动 Python 子进程失败: {exc}\n")
                handle.flush()
                return 1
            with job.lock:
                job.proc = proc
            if self._shutdown.is_set() or job.cancelled:
                _terminate_process(proc)
            exit_code = proc.wait()
        return int(exit_code)

    def _run_shell(self, job: Job) -> int:
        """Run a shell command; stdout+stderr are redirected to the log file."""
        cwd = self.workspace
        cwd.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["MPLBACKEND"] = "Agg"
        env["PYTHONUNBUFFERED"] = "1"
        env.setdefault("PYTHONIOENCODING", "utf-8")
        command = job.code
        with open(job.log_path, "a", encoding="utf-8", errors="replace", buffering=1) as handle:
            try:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=str(cwd),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    creationflags=_CREATE_FLAGS,
                )
            except OSError as exc:
                handle.write(f"[omicslab] 启动命令失败: {exc}\n")
                handle.flush()
                return 1
            with job.lock:
                job.proc = proc
            if self._shutdown.is_set() or job.cancelled:
                _terminate_process(proc, is_shell=True)
            exit_code = proc.wait()
        return int(exit_code)

    def _append_log(self, job: Job, text: str) -> None:
        try:
            with open(job.log_path, "a", encoding="utf-8", errors="replace") as handle:
                handle.write(text)
        except OSError:  # pragma: no cover - log dir removed under us
            logger.warning("写入任务 %s 日志失败", job.id)


# ---------------------------------------------------------------------------
# Process termination helpers
# ---------------------------------------------------------------------------


def _process_returncode(proc: Any) -> int | None:
    """Return a process exit code for a ``subprocess.Popen`` handle."""
    if proc is None:
        return None
    poll = getattr(proc, "poll", None)
    if callable(poll):
        try:
            return poll()
        except OSError:
            return None
    return getattr(proc, "returncode", None)


def _wait_returncode(proc: Any, timeout: float) -> bool:
    """Poll until the process reports an exit code, without blocking a loop."""
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if _process_returncode(proc) is not None:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)


def _terminate_process(proc: Any, is_shell: bool = False) -> None:
    """Terminate a process (and its tree for shell jobs) with a kill fallback."""
    if proc is None or _process_returncode(proc) is not None:
        return
    if is_shell and os.name == "nt":
        # Killing cmd.exe alone would leave grandchildren running.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=_CREATE_FLAGS,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        proc.terminate()
    except OSError:
        pass
    if _wait_returncode(proc, TERMINATE_GRACE_S):
        return
    try:
        proc.kill()
    except (OSError, ProcessLookupError):
        pass
    if _wait_returncode(proc, TERMINATE_GRACE_S):
        return
    logger.warning("进程 %s 未能被终止", getattr(proc, "pid", "?"))
