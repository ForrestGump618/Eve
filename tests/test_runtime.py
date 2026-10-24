"""Tests for the runtime layer: event store, run service, workspaces, approvals.

These cover the T05 acceptance surface (idempotent submit, session conflict,
replayable trace, scoped cancel) and the T06 child-task limits, without starting
a kernel or calling a real LLM: a fake loop emits the same AgentEvent stream the
real AgentLoop produces.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from omicslab.agent.approvals import Approver
from omicslab.agent.types import AgentCancelled, AgentEvent
from omicslab.config import Settings
from omicslab.runtime.events import EventStore, RunConflict
from omicslab.runtime.runs import RunService
from omicslab.session.store import ConversationStore
from omicslab.workspace.service import WorkspaceService


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


@pytest.fixture()
def events(settings: Settings) -> EventStore:
    store = EventStore(settings.home / "runtime" / "events.db")
    try:
        yield store  # type: ignore[misc]
    finally:
        store.close()


def _make_run(store: EventStore, *, run_id: str = "run_1", session_id: str = "c_1",
              client_request_id: str | None = None, status: str = "preparing") -> dict:
    return store.create_run(
        {
            "run_id": run_id,
            "trace_id": f"tr_{run_id}",
            "session_id": session_id,
            "client_request_id": client_request_id,
            "status": status,
        }
    )


# -- event store -----------------------------------------------------------


def test_event_store_schema_and_event_ordering(events: EventStore) -> None:
    assert events.schema_version == 3
    run = _make_run(events)
    assert run["run_id"] == "run_1"
    assert events.get_run("run_1")["status"] == "preparing"

    first = events.append_event("tr_run_1", "run_1", "text", {"delta": "a"})
    second = events.append_event("tr_run_1", "run_1", "text", {"delta": "b"})
    assert first["seq"] < second["seq"]
    assert events.max_seq("tr_run_1") == second["seq"]

    page = events.list_events("tr_run_1", after_seq=first["seq"])
    assert [row["seq"] for row in page] == [second["seq"]]
    assert events.update_run("run_1", status="succeeded")["status"] == "succeeded"


def test_event_store_client_request_id_is_unique(events: EventStore) -> None:
    _make_run(events, client_request_id="req-1")
    with pytest.raises(RunConflict):
        _make_run(events, run_id="run_2", client_request_id="req-1")
    assert events.find_by_client_request("req-1")["run_id"] == "run_1"
    assert events.find_by_client_request("missing") is None


def test_event_store_bulk_append_is_idempotent(events: EventStore) -> None:
    _make_run(events)
    item = {"trace_id": "tr_run_1", "run_id": "run_1", "type": "text",
            "payload": {"delta": "x"}, "event_id": "ev_fixed"}
    events.append_events_bulk([item])
    events.append_events_bulk([dict(item)])
    assert len(events.list_events("tr_run_1")) == 1


def test_event_store_recover_runs(events: EventStore) -> None:
    _make_run(events, status="running")
    recovered = events.recover_runs()
    assert len(recovered) == 1
    row = events.get_run("run_1")
    assert row["status"] == "interrupted"
    assert row["meta"]["recovered"] is True
    statuses = [e["data"].get("status") for e in events.list_events("tr_run_1")]
    assert "interrupted" in statuses
    assert events.recover_runs() == []


# -- run service -----------------------------------------------------------


class FakeLoop:
    """Minimal stand-in for AgentLoop.run with a controllable duration."""

    def __init__(self, delay: float = 0.0, fail: bool = False) -> None:
        self.delay = delay
        self.fail = fail

    async def run(self, conv, message, **kwargs):  # noqa: ANN001 - test double
        emit = kwargs.get("emit")
        if emit is not None:
            await emit(AgentEvent("text", {"delta": f"echo:{message}"}))
        if self.delay:
            cancel_event = kwargs.get("cancel_event")
            steps = max(1, int(self.delay / 0.02))
            for _ in range(steps):
                if cancel_event is not None and cancel_event.is_set():
                    raise AgentCancelled("cancelled")
                await asyncio.sleep(0.02)
        if self.fail:
            return {
                "finish_reason": "error",
                "text": "",
                "error": {"message": "fake failure", "code": "llm_error"},
                "usage": {},
            }
        return {"finish_reason": "stop", "text": f"echo:{message}", "usage": {"total_tokens": 3}}


def _service(settings: Settings, events: EventStore, loop: FakeLoop,
             *, max_parallel_runs: int = 8) -> RunService:
    return RunService(
        settings,
        events,
        loop_provider=lambda: loop,
        store=ConversationStore(settings),
        workspace_service=WorkspaceService(settings),
        max_parallel_runs=max_parallel_runs,
    )


async def _wait_terminal(events: EventStore, run_id: str, timeout: float = 5.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        row = events.get_run(run_id)
        if row and row["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return row
        await asyncio.sleep(0.02)
    raise AssertionError(f"run {run_id} did not finish")


@pytest.mark.asyncio()
async def test_run_service_success_and_idempotency(settings: Settings, events: EventStore) -> None:
    store = ConversationStore(settings)
    conv = store.create(agent="lead", title="t")
    service = _service(settings, events, FakeLoop())

    result = await service.submit(session_id=conv.id, message="hello", client_request_id="req-1")
    assert result["idempotent"] is False
    run_id = result["run"]["run_id"]
    row = await _wait_terminal(events, run_id)
    assert row["status"] == "succeeded"
    assert row["finish_reason"] == "stop"
    assert row["result_text"] == "echo:hello"
    timeline = service.timeline(result["run"]["trace_id"])
    assert timeline["max_seq"] >= 1

    replay = await service.submit(session_id=conv.id, message="hello", client_request_id="req-1")
    assert replay["idempotent"] is True
    assert replay["run"]["run_id"] == run_id


@pytest.mark.asyncio()
async def test_controlled_stop_settles_with_diagnostics_and_never_claims_success(settings, events):
    class StoppedLoop:
        async def run(self, conv, message, **kwargs):
            reason = {"code":"no_progress", "message":"missing directory", "counters":{"tool_calls":6}}
            await kwargs['emit'](AgentEvent('stop_reason', reason))
            return {"finish_reason":"stop", "text":"目录不存在，已停止重试。", "stop_reason":reason}
    conv = ConversationStore(settings).create(agent='lead', title='stopped')
    service = _service(settings, events, StoppedLoop())
    submitted = await service.submit(session_id=conv.id, message='inspect')
    run_id = submitted['run']['run_id']
    row = await _wait_terminal(events, run_id)
    assert row['status']=='interrupted'
    assert row['finish_reason']=='no_progress'
    assert row['meta']['stop_reason']['counters']['tool_calls']==6
    assert service.snapshot(run_id)['stop_reason']['code']=='no_progress'
    trace = events.list_events(row['trace_id'])
    done = next(e for e in trace if e['type']=='done')
    assert done['data']['stop_reason']['code']=='no_progress'


@pytest.mark.asyncio()
async def test_run_service_rejects_second_active_run(settings: Settings, events: EventStore) -> None:
    store = ConversationStore(settings)
    conv = store.create(agent="lead", title="t")
    service = _service(settings, events, FakeLoop(delay=0.4))
    first = await service.submit(session_id=conv.id, message="slow")
    with pytest.raises(RunConflict) as excinfo:
        await service.submit(session_id=conv.id, message="second")
    assert excinfo.value.run_id == first["run"]["run_id"]
    await asyncio.gather(*[t for t in asyncio.all_tasks() if t is not asyncio.current_task()])


@pytest.mark.asyncio()
async def test_run_service_scoped_cancel(settings: Settings, events: EventStore) -> None:
    store = ConversationStore(settings)
    conv = store.create(agent="lead", title="t")
    service = _service(settings, events, FakeLoop(delay=3.0))
    result = await service.submit(session_id=conv.id, message="slow")
    run_id = result["run"]["run_id"]
    handle = service.get_handle(run_id)
    assert handle is not None
    await service.cancel(run_id, "测试取消")
    deadline = asyncio.get_running_loop().time() + 5
    while asyncio.get_running_loop().time() < deadline:
        row = events.get_run(run_id)
        if row["status"] == "cancelled":
            break
        await asyncio.sleep(0.02)
    assert events.get_run(run_id)["status"] == "cancelled"
    assert events.get_run(run_id)["finish_reason"] == "cancelled"


@pytest.mark.asyncio()
async def test_child_run_limits_and_events(settings: Settings, events: EventStore) -> None:
    settings.max_child_tasks = 2
    store = ConversationStore(settings)
    conv = store.create(agent="lead", title="t")
    conv.meta.update(restricted_channel=True,inherited_toolsets=['system'])
    store.save(conv)
    loop = FakeLoop(delay=0.6)
    service = _service(settings, events, loop)
    result = await service.submit(session_id=conv.id, message="parent")
    parent_handle = service.get_handle(result["run"]["run_id"])
    assert parent_handle is not None

    child_a = await service.submit_child(parent_handle, prompt="child a", agent_id="data-critic")
    assert child_a['handle'].conversation.meta['restricted_channel'] is True
    assert child_a['handle'].conversation.meta['inherited_toolsets']==['system']
    child_b = await service.submit_child(parent_handle, prompt="child b")
    with pytest.raises(ValueError, match="\u5b50\u4efb\u52a1"):
        await service.submit_child(parent_handle, prompt="child c")

    await service.wait_child(child_a)
    await service.wait_child(child_b)
    await _wait_terminal(events, parent_handle.run_id)

    tasks = events.list_agent_tasks(parent_run_id=parent_handle.run_id)
    assert len(tasks) == 2
    assert {t["status"] for t in tasks} == {"succeeded"}
    child_events = [e for e in events.list_events(parent_handle.trace_id) if e["type"] == "child_run"]
    assert len(child_events) >= 4  # running + terminal frame for each child


@pytest.mark.asyncio()
async def test_child_depth_limit(settings: Settings, events: EventStore) -> None:
    settings.max_child_depth = 1
    store = ConversationStore(settings)
    conv = store.create(agent="lead", title="t")
    service = _service(settings, events, FakeLoop(delay=0.8))
    result = await service.submit(session_id=conv.id, message="parent")
    parent_handle = service.get_handle(result["run"]["run_id"])
    assert parent_handle is not None
    child = await service.submit_child(parent_handle, prompt="level one")
    child_handle = child["handle"]
    with pytest.raises(ValueError, match="\u6df1\u5ea6"):
        await service.submit_child(child_handle, prompt="level two")
    await service.wait_child(child)
    await _wait_terminal(events, parent_handle.run_id)


# -- workspaces ------------------------------------------------------------


def test_workspace_service_default_and_binding(settings: Settings) -> None:
    service = WorkspaceService(settings)
    default = service.default()
    assert default.workspace_id == "ws_main"
    assert Path(default.root) == Path(settings.workspace)
    assert default.scope == "main"

    created = service.create("实验数据")
    assert created.scope == f"ws:{created.workspace_id}"
    assert Path(created.root).is_dir()
    service.bind_conversation("c_bind", created.workspace_id)
    assert service.workspace_for_conversation("c_bind").workspace_id == created.workspace_id
    assert any(ws.workspace_id == created.workspace_id for ws in service.list())

    service.delete(created.workspace_id)
    assert service.workspace_for_conversation("c_bind").workspace_id == "ws_main"


# -- approvals -------------------------------------------------------------


class _FakeCtx:
    def __init__(self, run_id: str, emitted: list) -> None:
        self.run_id = run_id
        self.conversation_id = "conv_1"
        self.agent_task_id = None
        self.cancel_event = asyncio.Event()
        self.workspace_ctx = None
        self.backend = None
        self._emitted = emitted

    async def emit(self, event: AgentEvent) -> None:
        self._emitted.append(event)


@pytest.mark.asyncio()
async def test_approver_scoped_cancel_and_resolve() -> None:
    emitted: list = []
    approver = Approver(policy="ask", timeout_s=5.0)
    ctx_a = _FakeCtx("run_a", emitted)
    ctx_b = _FakeCtx("run_b", emitted)
    task_a = asyncio.create_task(approver.request(ctx_a, "run_shell", {"command": "x"}, "需要审批"))
    task_b = asyncio.create_task(approver.request(ctx_b, "run_shell", {"command": "y"}, "需要审批"))
    await asyncio.sleep(0.05)
    assert approver.pending_count == 2
    assert emitted and emitted[0].type == "approval_request"
    payload = emitted[0].data
    assert payload["run_id"] == "run_a"
    assert payload["id"].startswith("ap_")

    approver.cancel_for_run("run_a", "取消父运行")
    assert await task_a is False
    assert approver.pending_count == 1

    pending = approver.pending(run_id="run_b")
    assert len(pending) == 1
    assert approver.resolve(pending[0]["id"], True) is True
    assert await task_b is True

    approver.cancel_all("关闭")
    assert approver.pending_count == 0

def test_approval_target_normalises_workspace_shapes(tmp_path: Path) -> None:
    """Approval payloads must describe the workspace, not leaked Path methods."""
    from types import SimpleNamespace

    from omicslab.agent.approvals import _target_from_ctx

    class _Backend:
        kind = "local"

    root = tmp_path / "ws"
    root.mkdir()
    for ctx in (
        SimpleNamespace(backend=_Backend(), workspace=root, connection_id=""),
        SimpleNamespace(backend=_Backend(), workspace=str(root)),
        SimpleNamespace(backend=None, workspace_ctx=SimpleNamespace(root=root, cwd=None, connection_id="")),
    ):
        target = _target_from_ctx(ctx)
        assert target["kind"] == "local"
        assert target["root"] == str(root)
        assert target["cwd"] == str(root)
        assert "bound method" not in target["cwd"]
