"""Regression tests: shell/tool subprocesses must not require a Proactor loop.

The server intentionally runs on a Windows *selector* event loop (ZMQ kernels
need ``add_reader``, which the Proactor loop lacks).  Selector loops cannot use
``asyncio.create_subprocess_*`` on Windows, so ``run_shell`` and background
Python jobs must use plain ``subprocess`` + a worker thread.  These tests pin
that behaviour so the server cannot regress to ``NotImplementedError``.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

from omicslab.agent.tools import ToolContext, _tool_run_shell
from omicslab.config import Settings
from omicslab.session.jobs import STATUS_DONE, STATUS_FAILED, JobManager


@pytest.fixture()
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Isolated settings whose kernel Python is the running interpreter."""
    monkeypatch.setenv("OMICSLAB_KERNEL_PYTHON", sys.executable)
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.approval_policy = "auto"
    result.ensure_dirs()
    return result


def test_run_shell_on_selector_loop(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, workspace=settings.workspace)
    loop = asyncio.SelectorEventLoop()
    try:
        result = loop.run_until_complete(
            _tool_run_shell(ctx, {"command": "echo omicslab-shell-ok"})
        )
    finally:
        loop.close()
    assert result.ok, result.content
    assert "omicslab-shell-ok" in result.content
    assert result.data["exit_code"] == 0


def test_run_shell_timeout_on_selector_loop(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, workspace=settings.workspace)
    loop = asyncio.SelectorEventLoop()
    try:
        result = loop.run_until_complete(
            _tool_run_shell(ctx, {"command": "ping 127.0.0.1 -n 10", "timeout": 1} if sys.platform == "win32"
                            else {"command": "sleep 10", "timeout": 1})
        )
    finally:
        loop.close()
    assert not result.ok
    assert result.data["timed_out"] is True


def test_python_job_runs_without_event_loop(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "print('omicslab-job-ok')", name="compat")
        job_id = snapshot["id"]
        deadline = time.time() + 60
        status = snapshot["status"]
        while time.time() < deadline:
            status = jobs.get(job_id)["status"]
            if status in (STATUS_DONE, STATUS_FAILED):
                break
            time.sleep(0.2)
        assert status == STATUS_DONE, jobs.log(job_id, 0)
        payload = jobs.log(job_id, 0)
        assert "omicslab-job-ok" in payload["text"]
    finally:
        jobs.shutdown()


def test_python_job_reports_traceback(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "raise RuntimeError('boom-job')", name="compat-fail")
        job_id = snapshot["id"]
        deadline = time.time() + 60
        status = snapshot["status"]
        while time.time() < deadline:
            status = jobs.get(job_id)["status"]
            if status in (STATUS_DONE, STATUS_FAILED):
                break
            time.sleep(0.2)
        assert status == STATUS_FAILED
        payload = jobs.log(job_id, 0)
        assert "boom-job" in payload["text"]
    finally:
        jobs.shutdown()
