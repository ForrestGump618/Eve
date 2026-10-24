"""Tests for session persistence (``ConversationStore``) and background jobs.

Offline only: the Python jobs spawn a fresh interpreter via
``settings.resolve_kernel_python()`` (pinned to the running interpreter in the
fixture) and the shell jobs run a trivial ``echo`` through the platform shell.

Run with the project virtualenv::

    .venv\\Scripts\\python.exe -m pytest tests/test_session.py -q
"""

from __future__ import annotations

import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from omicslab.agent.types import ChatMessage, Conversation
from omicslab.config import ConfigError, Settings
from omicslab.session.jobs import (
    JOB_ID_RE,
    STATUS_CANCELLED,
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_RUNNING,
    JobManager,
)
from omicslab.session.store import (
    ConversationNotFound,
    ConversationStore,
)

# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    """Isolated Settings rooted in the pytest tmp directory."""
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


@pytest.fixture()
def store(settings: Settings) -> ConversationStore:
    return ConversationStore(settings)


def wait_job(jobs: JobManager, job_id: str, timeout: float = 20.0) -> dict:
    """Block until a job stops running and return its final snapshot."""
    deadline = time.monotonic() + timeout
    snapshot = jobs.get(job_id)
    while time.monotonic() < deadline:
        snapshot = jobs.get(job_id)
        if snapshot["status"] != STATUS_RUNNING:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(f"任务 {job_id} 未在 {timeout}s 内结束: {snapshot}")


def wait_for_log(jobs: JobManager, job_id: str, timeout: float = 20.0) -> dict:
    """Block until the job has produced some log output."""
    deadline = time.monotonic() + timeout
    snapshot = jobs.get(job_id)
    while time.monotonic() < deadline:
        snapshot = jobs.get(job_id)
        if snapshot["log_bytes"] > 0:
            return snapshot
        if snapshot["status"] != STATUS_RUNNING:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(f"任务 {job_id} 未在 {timeout}s 内产生日志")


# ---------------------------------------------------------------------------
# ConversationStore: basic CRUD
# ---------------------------------------------------------------------------


def test_create_get_roundtrip(settings: Settings, store: ConversationStore) -> None:
    conversation = store.create(agent="lead", title="测试会话")
    assert conversation.id
    assert conversation.agent == "lead"
    assert conversation.title == "测试会话"
    assert conversation.messages == []
    assert store.exists(conversation.id)
    assert (settings.conversations_dir / f"{conversation.id}.json").is_file()

    loaded = store.get(conversation.id)
    assert loaded.id == conversation.id
    assert loaded.title == "测试会话"
    assert loaded.agent == "lead"


def test_save_persists_messages_and_metadata(
    settings: Settings, store: ConversationStore
) -> None:
    conversation = store.create(title="带消息")
    conversation.meta["provider"] = "deepseek"
    conversation.messages.append(ChatMessage(role="user", content="你好"))
    conversation.messages.append(ChatMessage(role="assistant", content="你好，我是 OmicsLab"))
    store.save(conversation)

    loaded = store.get(conversation.id)
    assert loaded.meta["provider"] == "deepseek"
    assert [message.role for message in loaded.messages] == ["user", "assistant"]
    assert loaded.messages[1].content == "你好，我是 OmicsLab"

    # The on-disk file is plain JSON with the project shape.
    payload = json.loads(
        (settings.conversations_dir / f"{conversation.id}.json").read_text(encoding="utf-8")
    )
    assert payload["id"] == conversation.id
    assert payload["title"] == "带消息"
    assert isinstance(payload["messages"], list)


def test_append_message(settings: Settings, store: ConversationStore) -> None:
    conversation = store.create()
    updated = store.append_message(conversation.id, ChatMessage(role="user", content="第一条"))
    assert len(updated.messages) == 1
    store.append_message(conversation.id, ChatMessage(role="assistant", content="第二条"))
    loaded = store.get(conversation.id)
    assert [message.content for message in loaded.messages] == ["第一条", "第二条"]


def test_list_summaries_and_ordering(settings: Settings, store: ConversationStore) -> None:
    first = store.create(title="第一个")
    time.sleep(0.02)
    second = store.create(title="第二个")
    time.sleep(0.02)
    store.append_message(second.id, ChatMessage(role="user", content="hi"))
    # Saving the first conversation again refreshes its updated_at and moves it first.
    store.save(first)

    summaries = store.list()
    assert [item["id"] for item in summaries] == [first.id, second.id]
    assert summaries[0]["message_count"] == 0
    assert summaries[1]["message_count"] == 1
    for summary in summaries:
        assert {"id", "title", "agent", "created_at", "updated_at", "message_count"} <= set(summary)


def test_list_skips_corrupt_conversation_files(
    settings: Settings, store: ConversationStore
) -> None:
    good = store.create(title="好的")
    corrupt = settings.conversations_dir / "corrupt.json"
    corrupt.write_text("{ this is not json", encoding="utf-8")
    summary_file = settings.conversations_dir / "wrong_shape.json"
    summary_file.write_text("[]", encoding="utf-8")

    summaries = store.list()
    assert [item["id"] for item in summaries] == [good.id]


def test_rename_and_delete(settings: Settings, store: ConversationStore) -> None:
    conversation = store.create(title="旧标题")
    renamed = store.rename(conversation.id, "新标题")
    assert renamed.title == "新标题"
    assert store.get(conversation.id).title == "新标题"

    # Empty titles fall back to the default.
    store.rename(conversation.id, "   ")
    assert store.get(conversation.id).title == "新会话"

    assert store.delete(conversation.id) is True
    assert store.delete(conversation.id) is False
    assert store.exists(conversation.id) is False
    with pytest.raises(ConversationNotFound):
        store.get(conversation.id)


def test_get_missing_and_invalid_ids(store: ConversationStore) -> None:
    with pytest.raises(ConversationNotFound):
        store.get("c_missing")
    for bad in ("", "bad id", "../escape", "a" * 81):
        with pytest.raises(ConversationNotFound):
            store.get(bad)
        with pytest.raises(ConversationNotFound):
            store.delete(bad)
    assert store.exists("../escape") is False


def test_save_rejects_invalid_id(store: ConversationStore) -> None:
    conversation = Conversation()
    conversation.id = "bad id"
    with pytest.raises(ConfigError):
        store.save(conversation)


def test_save_is_atomic_and_leaves_no_temp_files(
    settings: Settings, store: ConversationStore
) -> None:
    conversation = store.create(title="原子写")
    for index in range(5):
        conversation.title = f"标题 {index}"
        store.save(conversation)
    leftovers = [path for path in settings.conversations_dir.glob("*.tmp")]
    assert leftovers == []
    payload = json.loads(
        (settings.conversations_dir / f"{conversation.id}.json").read_text(encoding="utf-8")
    )
    assert payload["title"] == "标题 4"


def test_rename_missing_conversation(store: ConversationStore) -> None:
    with pytest.raises(ConversationNotFound):
        store.rename("c_missing", "title")


def test_count_and_root(settings: Settings, store: ConversationStore) -> None:
    root = store.root
    assert root == settings.conversations_dir
    assert store.count() == 0
    store.create()
    store.create()
    assert store.count() == 2
    assert len(store.list()) == 2


def test_concurrent_saves_are_safe(settings: Settings, store: ConversationStore) -> None:
    conversation = store.create(title="并发")

    def save_many(index: int) -> None:
        for _ in range(10):
            conversation.title = f"并发 {index}"
            store.save(conversation)

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(save_many, index) for index in range(4)]
        for future in futures:
            future.result()

    payload = json.loads(
        (settings.conversations_dir / f"{conversation.id}.json").read_text(encoding="utf-8")
    )
    assert payload["title"].startswith("并发")
    assert store.count() == 1


# ---------------------------------------------------------------------------
# JobManager: python jobs
# ---------------------------------------------------------------------------


def test_python_job_success_and_log_offsets(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "print('job-ok')", name="测试任务")
        assert JOB_ID_RE.match(snapshot["id"])
        assert snapshot["name"] == "测试任务"
        assert snapshot["kind"] == "python"
        assert snapshot["status"] in {STATUS_RUNNING, STATUS_DONE}

        final = wait_job(jobs, snapshot["id"])
        assert final["status"] == STATUS_DONE
        assert final["exit_code"] == 0
        assert final["ended_at"] is not None
        assert final["log_bytes"] > 0

        first = jobs.log(snapshot["id"])
        assert "job-ok" in first["text"]
        assert first["eof"] is True
        assert first["next_offset"] == len(first["text"])

        second = jobs.log(snapshot["id"], first["next_offset"])
        assert second["text"] == ""
        assert second["eof"] is True

        limited = jobs.log(snapshot["id"], 0, max_chars=5)
        assert len(limited["text"]) <= 5

        log_file = settings.jobs_dir / f"{snapshot['id']}.log"
        assert log_file.is_file()
        assert log_file.stat().st_size == final["log_bytes"]
    finally:
        jobs.shutdown()


@pytest.mark.parametrize('exit_code', [0, 3])
def test_process_exit_waits_for_committed_job_result(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, exit_code: int
) -> None:
    jobs = JobManager(settings)
    finish_reached = threading.Event()
    release_finish = threading.Event()
    original_finish = jobs._finish

    def delayed_finish(job, status, code):
        finish_reached.set()
        release_finish.wait(timeout=10)
        original_finish(job, status, code)

    monkeypatch.setattr(jobs, '_finish', delayed_finish)
    try:
        submitted = jobs.submit('python', f'import sys; sys.exit({exit_code})')
        assert finish_reached.wait(timeout=10)
        # The OS child has exited, but the worker has not published its result.
        pending = jobs.get(submitted['id'])
        assert pending['status'] == STATUS_RUNNING
        assert pending['exit_code'] is None
        assert pending['ended_at'] is None
        assert jobs.log(submitted['id'])['eof'] is False

        release_finish.set()
        completed = wait_job(jobs, submitted['id'])
        assert completed['status'] == (STATUS_DONE if exit_code == 0 else STATUS_FAILED)
        assert completed['exit_code'] == exit_code
        assert completed['ended_at'] is not None
        assert jobs.log(submitted['id'])['eof'] is True
    finally:
        release_finish.set()
        jobs.shutdown()


def test_python_job_exception_is_failed(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "1 / 0")
        final = wait_job(jobs, snapshot["id"])
        assert final["status"] == STATUS_FAILED
        assert final["exit_code"] != 0
        payload = jobs.log(snapshot["id"], 0)
        assert "ZeroDivisionError" in payload["text"]
    finally:
        jobs.shutdown()


def test_python_job_system_exit_code(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "import sys; sys.exit(3)")
        final = wait_job(jobs, snapshot["id"])
        assert final["status"] == STATUS_FAILED
        assert final["exit_code"] == 3
    finally:
        jobs.shutdown()


def test_python_job_name_defaults_and_truncation(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        first = jobs.submit("python", "print(1)")
        wait_job(jobs, first["id"])
        second = jobs.submit("shell", "echo 1", name="x" * 500)
        wait_job(jobs, second["id"])
        assert first["name"] == "Python 任务"
        assert second["name"].startswith("x" * 100)
        assert len(second["name"]) <= 120
    finally:
        jobs.shutdown()


# ---------------------------------------------------------------------------
# JobManager: shell jobs
# ---------------------------------------------------------------------------


def test_shell_job_success(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("shell", "echo shell-job-ok", name="shell")
        final = wait_job(jobs, snapshot["id"])
        assert final["status"] == STATUS_DONE
        assert final["exit_code"] == 0
        payload = jobs.log(snapshot["id"], 0)
        assert "shell-job-ok" in payload["text"]
    finally:
        jobs.shutdown()


# ---------------------------------------------------------------------------
# JobManager: listing, validation, cancellation, shutdown
# ---------------------------------------------------------------------------


def test_list_orders_by_start_time(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        first = jobs.submit("python", "print(1)", name="第一个任务")
        time.sleep(0.01)
        second = jobs.submit("python", "print(2)", name="第二个任务")
        wait_job(jobs, first["id"])
        wait_job(jobs, second["id"])
        listed = jobs.list()
        assert [item["id"] for item in listed[:2]] == [second["id"], first["id"]]
        assert len(jobs.list()) == 2
    finally:
        jobs.shutdown()


def test_submit_validation(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        with pytest.raises(ValueError):
            jobs.submit("ruby", "puts 1")
        with pytest.raises(ValueError):
            jobs.submit("python", "")
        with pytest.raises(ValueError):
            jobs.submit("shell", "   \n  ")
    finally:
        jobs.shutdown()


def test_aliases_and_bad_names(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        for kind in ("py", "PYTHON", "Python"):
            snapshot = jobs.submit(kind, "print(1)")
            wait_job(jobs, snapshot["id"])
            assert snapshot["kind"] == "python"
        # Extra whitespace in the kind is tolerated.
        shell_job = jobs.submit(" shell ", "echo ok")
        wait_job(jobs, shell_job["id"])
        assert shell_job["kind"] == "shell"
    finally:
        jobs.shutdown()


def test_unknown_job_ids(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        for jid in ("j_00000000", "not-a-job", "", "../escape"):
            with pytest.raises(KeyError):
                jobs.get(jid)
            with pytest.raises(KeyError):
                jobs.log(jid)
            with pytest.raises(KeyError):
                jobs.cancel(jid)
    finally:
        jobs.shutdown()


def test_cancel_running_job(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit(
            "python", "import time\nprint('started', flush=True)\ntime.sleep(8)"
        )
        job_id = snapshot["id"]
        wait_for_log(jobs, job_id)
        assert jobs.cancel(job_id) is True
        final = wait_job(jobs, job_id, timeout=20.0)
        assert final["status"] == STATUS_CANCELLED
        assert jobs.cancel(job_id) is False
    finally:
        jobs.shutdown()


def test_cancel_finished_job_returns_false(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "print('done')")
        wait_job(jobs, snapshot["id"])
        assert jobs.cancel(snapshot["id"]) is False
    finally:
        jobs.shutdown()


def test_shutdown_terminates_running_jobs(settings: Settings) -> None:
    jobs = JobManager(settings)
    snapshot = jobs.submit("python", "import time\nprint('started', flush=True)\ntime.sleep(8)")
    job_id = snapshot["id"]
    try:
        wait_for_log(jobs, job_id)
        jobs.shutdown()
        final = wait_job(jobs, job_id, timeout=20.0)
        assert final["status"] == STATUS_CANCELLED
        with pytest.raises(ConfigError):
            jobs.submit("python", "print(1)")
        # Shutdown is idempotent.
        jobs.shutdown()
    finally:
        jobs.shutdown()


def test_job_log_missing_file_tolerated(settings: Settings) -> None:
    jobs = JobManager(settings)
    try:
        snapshot = jobs.submit("python", "print('hello')")
        wait_job(jobs, snapshot["id"])
        (settings.jobs_dir / f"{snapshot['id']}.log").unlink()
        payload = jobs.log(snapshot["id"], 0)
        assert payload["text"] == ""
        assert payload["eof"] is True
    finally:
        jobs.shutdown()
