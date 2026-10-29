"""Real queue, event DB and conversation stores; the model loop is deterministic."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from omicslab.agent.types import ChatMessage
from omicslab.runtime.events import EventStore
from omicslab.runtime.runs import RunService
from omicslab.server.routes_harness import router as harness_router
from omicslab.server.chat import router as chat_router
from omicslab.server.routes_workspace_tools import router as team_router
from omicslab.session.store import ConversationStore
from omicslab.suwen.store import PlatformStore
from omicslab.suwen.teams import (
    approve_team, assign_member, create_team, create_bound_team, forward_user_message,
    publish_task_result, send_message, team_mailbox, team_snapshot,
)
from test_suwen_platform import p


class ModelLoop:
    def __init__(self, platform):
        self.platform = platform
        self.calls = []
        self.hold = {}

    async def run(self, conversation, message, **kwargs):
        self.calls.append((conversation.id, message, kwargs))
        conversation.messages.append(ChatMessage(role="user", content=message))
        self.platform.state.store.save(conversation)
        if conversation.id in self.hold:
            released = asyncio.create_task(self.hold[conversation.id].wait())
            cancelled = asyncio.create_task(kwargs['cancel_event'].wait())
            try:
                await asyncio.wait({released, cancelled}, return_when=asyncio.FIRST_COMPLETED)
                if kwargs['cancel_event'].is_set():
                    return {"finish_reason": "cancelled", "text": ""}
            finally:
                released.cancel()
                cancelled.cancel()
                await asyncio.gather(released, cancelled, return_exceptions=True)
        member = conversation.meta.get("team_member")
        return {"finish_reason": "completed", "text": f"evidence from {member or 'captain'}: verified output"}


@pytest.fixture
def runtime(p):
    p.state.store = ConversationStore(p.settings)
    p.state.events = EventStore(p.settings.home / "runtime" / "team-tests.db")
    p.state.loop = ModelLoop(p)
    p.state.runs = RunService(p.settings, p.state.events, loop_provider=lambda: p.state.loop,
                              store=p.state.store, workspace_service=p.state.workspaces)
    p.store.put("config", "team_policy", {"value": {"dispatch_interval_s": 0.01, "run_poll_interval_s": 0.005}})
    yield p
    p.state.events.close()


async def finish(p, result):
    handle = p.state.runs.get_handle(result["run"]["run_id"])
    if handle:
        await asyncio.wait_for(handle.task, 2)


async def delegated_submit(p, approve=True, **kwargs):
    result = await p.state.runs.submit(**kwargs)
    run = p.state.events.get_run(result["run"]["run_id"])
    create_bound_team(p, run["meta"]["workspace_id"], run, {"members": [
        {"id": "execution", "name": "Executor", "goal": "Execute original user goal and return evidence"},
        {"id": "review", "name": "Independent verifier", "goal": "Verify committed executor results", "depends_on": ["execution"]},
    ]})
    if approve:
        team_id = p.state.events.get_run(run["run_id"])["meta"]["team_id"]
        approve_team(p, run["meta"]["workspace_id"], team_id)
    result["run"] = p.state.runs.snapshot(run["run_id"])
    return result


async def until(predicate):
    async def poll():
        while not predicate():
            await asyncio.sleep(0.005)
    await asyncio.wait_for(poll(), 3)


async def test_native_team_submit_is_draft_idempotent_and_bound_to_request(runtime):
    p = runtime
    captain = p.state.store.create()
    kwargs = dict(session_id=captain.id, message="Inspect real measurements", workspace_id="ws_main",
                  client_request_id="root-request", collaboration_mode="team", permission_mode="review",
                  provider="mock", model="selected-test-model")
    result = await delegated_submit(p, approve=False, **kwargs)
    await finish(p, result)
    retry = await p.state.runs.submit(**kwargs)
    assert retry["idempotent"] is True
    team_id = result["run"]["meta"]["team_id"]
    assert result["run"]["team_id"] == team_id
    assert retry["run"]["team_id"] == team_id
    assert len(p.store.list("team", "ws_main")) == 1
    assert p.store.list("task", "ws_main") == []
    assert team_mailbox(p, "ws_main", team_id) == []
    team = p.store.get("team", team_id, "ws_main")
    assert team["draft"] is True and team["user_goal"] == kwargs["message"]
    assert team["source_request_id"] == "root-request"
    assert team["source_run_id"] == result["run"]["run_id"]
    assert [m["id"] for m in team["members"]] == ["execution", "review"]
    assert team["members"][1]["depends_on"] == ["execution"]
    assert all(m["permission_mode"] == "review" for m in team["members"])
    assert all(m["provider"] == "mock" and m["model"] == "selected-test-model" for m in team["members"])
    assert team_id in p.state.loop.calls[0][1]
    other = p.state.store.create()
    with pytest.raises(ValueError, match="another session"):
        await p.state.runs.submit(**{**kwargs, "session_id": other.id})


async def test_approval_queue_seeds_goal_then_committed_result_and_captain_handoff(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Verify dataset D with source evidence",
                                     collaboration_mode="team", permission_mode="ask")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    team = team_snapshot(p, "ws_main", p.store.get("team", team_id, "ws_main"))
    original = team_mailbox(p, "ws_main", team_id)
    assert len(original) == 1 and original[0]["kind"] == "user_goal"
    assert original[0]["content"] == "Verify dataset D with source evidence"
    assert all(m["task"]["status"] == "queued" for m in team["members"])
    await p.tasks.start()
    try:
        await until(lambda: all(p.store.get("task", m["task_id"], "ws_main")["status"] == "succeeded"
                                for m in team["members"]))
        summary_id = p.store.get("team", team_id, "ws_main")["summary_task_id"]
        await until(lambda: p.store.get("task", summary_id, "ws_main")["status"] == "succeeded")
        calls = p.state.loop.calls[1:3]
        assert len(calls) == 2 and calls[0][0] != calls[1][0]
        assert all("Verify dataset D with source evidence" in message for _, message, _ in calls)
        assert "evidence from execution: verified output" in calls[1][1]
        assert all(call[2]["run_ctx"].permission_mode == "ask" for call in calls)
        assert all(call[2]["run_ctx"].workspace.workspace_id == "ws_main" for call in calls)
        results = [m for m in team_mailbox(p, "ws_main", team_id, "captain") if m.get("kind") == "task_result"]
        assert len(results) == 2
        assert all(m["task_status"] == "succeeded" and m["run_id"] for m in results)
        assert all("verified output" in m["content"] for m in results)
        for member in team["members"]:
            publish_task_result(p, "ws_main", member["task_id"])
        assert len([m for m in team_mailbox(p, "ws_main", team_id, "captain") if m.get("kind") == "task_result"]) == 2
        assert p.state.loop.calls[-1][0] == captain.id
        assert "evidence from execution: verified output" in p.state.loop.calls[-1][1]
        assert "evidence from review: verified output" in p.state.loop.calls[-1][1]
        assert "status=running" in p.state.loop.calls[-1][1]
        assert "draft awaiting" not in p.state.loop.calls[-1][1].lower()
        assert p.state.loop.calls[-1][2]["run_ctx"].permission_mode == "ask"
        # Completion schedules exactly one captain summary, never a new team.
        assert len(p.state.events.list_runs(limit=100)) == 4
        assert len(p.store.list("task", "ws_main")) == 3
        assert len(p.store.list("team", "ws_main")) == 1
    finally:
        await p.tasks.close()
    next_turn = await p.state.runs.submit(session_id=captain.id, message="Summarize completed work")
    await finish(p, next_turn)
    assert "evidence from execution: verified output" in p.state.loop.calls[-1][1]
    assert "evidence from review: verified output" in p.state.loop.calls[-1][1]
    restarted = PlatformStore(p.settings.home)
    try:
        assert len(restarted.list("team_message", "ws_main")) == 4  # original, two results, next user turn
    finally:
        restarted.close()


async def test_captain_execution_uses_actual_approved_status(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, approve=False, session_id=captain.id, message="Approve before captain executes", collaboration_mode="team")
    await finish(p, root)
    message = p.state.loop.calls[-1][1]
    assert "status=draft" in message
    assert "draft awaiting" in message.lower()
    approve_team(p, "ws_main", root["run"]["team_id"])
    next_turn = await p.state.runs.submit(session_id=captain.id, message="Continue approved team")
    await finish(p, next_turn)
    assert "status=queued" in p.state.loop.calls[-1][1]
    assert "draft awaiting" not in p.state.loop.calls[-1][1].lower()


@pytest.mark.parametrize("summary_status,expected", [
    ("queued", "queued"), ("running", "running"), ("paused", "paused"),
    ("waiting_approval", "paused"), ("interrupted", "paused"), ("budget_limited", "paused"),
    ("failed", "failed"), ("cancelled", "cancelled"), ("needs_review", "needs_review"),
    ("succeeded", "succeeded"),
])
def test_team_status_includes_captain_summary(runtime, summary_status, expected):
    p = runtime
    team = create_team(p, "ws_main", {"members": [{"id": "worker", "goal": "Work"}]})
    p.tasks.patch(team["members"][0]["task_id"], "ws_main", status="succeeded")
    summary = p.tasks.create("ws_main", {"prompt": "Aggregate"})
    p.tasks.patch(summary["id"], "ws_main", status=summary_status)
    team = p.store.put("team", team["id"], {**team, "summary_task_id": summary["id"]}, "ws_main")
    snapshot = team_snapshot(p, "ws_main", team)
    assert snapshot["status"] == expected
    assert snapshot["summary_status"] == summary_status
    assert snapshot["summary_task"]["id"] == summary["id"]


async def test_running_summary_obeys_team_pause_resume_cancel_and_archive_guards(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Controlled team", collaboration_mode="team", permission_mode="full")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    team = team_snapshot(p, "ws_main", p.store.get("team", team_id, "ws_main"))
    gate = p.state.loop.hold[captain.id] = asyncio.Event()
    for member in team["members"]:
        p.tasks.patch(member["task_id"], "ws_main", status="succeeded", result="Verified evidence")
    summary_id = p.store.get("team", team_id, "ws_main")["summary_task_id"]
    app = FastAPI()
    app.state.omicslab = p.state
    app.state.harness_token = "test-token"
    app.include_router(team_router)
    app.include_router(harness_router)
    await p.tasks.start()
    def summary_running():
        task = p.store.get("task", summary_id, "ws_main")
        return task["status"] == "running" and task["nodes"]["work"].get("run_id")
    try:
        await until(summary_running)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            denied = await client.post(f"/api/teams/{team_id}/archive", json={})
            assert denied.status_code == 409
            run_id = p.store.get("task", summary_id, "ws_main")["nodes"]["work"]["run_id"]
            p.state.runs.get_handle(run_id).backend = SimpleNamespace()
            denied = await client.post(f"/api/harness/runs/{run_id}/tool", headers={"authorization": "Bearer test-token"},
                                      json={"operation": "team_archive", "arguments": {"id": team_id}})
            assert denied.status_code == 422
            paused = await client.post(f"/api/teams/{team_id}/pause", json={})
            assert paused.status_code == 200 and paused.json()["errors"] == []
            assert paused.json()["status"] == "paused" and paused.json()["summary_status"] == "paused"
            assert summary_id not in p.tasks.active
            assert p.state.events.active_run_for_session(captain.id) is None
            resumed = await client.post(f"/api/teams/{team_id}/resume", json={})
            assert resumed.status_code == 200 and resumed.json()["summary_status"] == "queued"
            await until(summary_running)
            cancelled = await client.post(f"/api/teams/{team_id}/cancel", json={})
            assert cancelled.status_code == 200 and cancelled.json()["errors"] == []
            assert cancelled.json()["status"] == "cancelled" and cancelled.json()["summary_status"] == "cancelled"
            assert summary_id not in p.tasks.active
            assert p.state.events.active_run_for_session(captain.id) is None
            archived = await client.post(f"/api/teams/{team_id}/archive", json={})
            assert archived.status_code == 200 and archived.json()["archived"] is True
            assert p.store.get("task", summary_id, "ws_main")["status"] == "cancelled"
            assert len(p.store.list("task", "ws_main")) == 3
    finally:
        gate.set()
        await p.tasks.close()


async def test_cancelling_last_member_does_not_enqueue_post_cancel_summary(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Cancel before dispatch", collaboration_mode="team")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(team_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        cancelled = await client.post(f"/api/teams/{team_id}/cancel", json={})
        assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
        assert cancelled.json()["summary_task_id"] is None
        assert all(m["task"]["status"] == "cancelled" for m in cancelled.json()["members"])
        archived = await client.post(f"/api/teams/{team_id}/archive", json={})
        assert archived.status_code == 200
    assert len(p.store.list("task", "ws_main")) == 2


async def test_captain_summary_waits_for_busy_session_and_reports_failures_once(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Original failed analysis", collaboration_mode="team",
                                     permission_mode="review", provider="mock", model="selected-model")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    team = team_snapshot(p, "ws_main", p.store.get("team", team_id, "ws_main"))
    gate = p.state.loop.hold[captain.id] = asyncio.Event()
    active = await p.state.runs.submit(session_id=captain.id, message="Captain is busy")
    p.tasks.patch(team["members"][0]["task_id"], "ws_main", status="failed", error="input missing")
    p.tasks.patch(team["members"][1]["task_id"], "ws_main", status="cancelled", error="review cancelled")
    summary_id = p.store.get("team", team_id, "ws_main")["summary_task_id"]
    await p.tasks.start()
    try:
        await asyncio.sleep(0.04)
        assert p.store.get("task", summary_id, "ws_main")["status"] == "queued"
        assert p.state.events.active_run_for_session(captain.id)["run_id"] == active["run"]["run_id"]
        for member in team["members"]:
            publish_task_result(p, "ws_main", member["task_id"])
        assert p.store.get("team", team_id, "ws_main")["summary_task_id"] == summary_id
        assert len(p.store.list("task", "ws_main")) == 3
        gate.set()
        await finish(p, active)
        await until(lambda: p.store.get("task", summary_id, "ws_main")["status"] == "succeeded")
        assert len(p.state.loop.calls) == 3
        session, prompt, kwargs = p.state.loop.calls[-1]
        assert session == captain.id
        assert "input missing" in prompt and "review cancelled" in prompt
        assert '"status": "failed"' in prompt and '"status": "cancelled"' in prompt
        assert kwargs["run_ctx"].permission_mode == "review"
        assert kwargs["provider"] == "mock" and kwargs["model"] == "selected-model"
        assert len(p.store.list("team", "ws_main")) == 1
        assert len(p.store.list("task", "ws_main")) == 3
        assert len([m for m in team_mailbox(p, "ws_main", team_id) if m["sender"] == "user"]) == 2
        summary_run = p.state.events.get_run(p.store.get("task", summary_id, "ws_main")["nodes"]["work"]["run_id"])
        assert summary_run["meta"]["internal_task_id"] == summary_id
        assert summary_run["meta"]["team_id"] == team_id
    finally:
        gate.set()
        await finish(p, active)
        await p.tasks.close()


async def test_desktop_guidance_endpoint_forwards_when_included_idempotently(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Work", collaboration_mode="team")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    team = team_snapshot(p, "ws_main", p.store.get("team", team_id, "ws_main"))
    gate = p.state.loop.hold[captain.id] = asyncio.Event()
    active = await p.state.runs.submit(session_id=captain.id, message="Coordinate")
    handle = p.state.runs.get_handle(active["run"]["run_id"])
    rpc_calls = []
    async def rpc(method, **params):
        rpc_calls.append((method, params))
        return {"id": "desktop-guidance", "status": "queued"}
    p.state.loop.desktop_harness = SimpleNamespace(rpc=rpc)
    row = p.state.events.get_run(handle.run_id)
    p.state.events.update_run(handle.run_id, meta={**row["meta"], "harness_task_id": "desktop-task"})
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(chat_router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            response = await client.post(f"/api/runs/{handle.run_id}/messages", json={"content": "Corrected live instruction", "action": "queue"})
        assert response.status_code == 200
        assert rpc_calls[0][0] == "task.guidance.change"
        assert not any(m["content"] == "Corrected live instruction" for m in team_mailbox(p, "ws_main", team_id))
        handle.conversation.messages.append(ChatMessage(role="user", content="Corrected live instruction", meta={"guidance_id": "desktop-guidance"}))
        for _ in range(2):
            await p.state.runs._on_loop_event(handle, {"type": "guidance_status", "data": {"message_id": "desktop-guidance", "status": "included"}})
        assert len([m for m in team_mailbox(p, "ws_main", team_id) if m["content"] == "Corrected live instruction"]) == 1
        # Team evidence consumed by the desktop loop must not become a new user broadcast.
        await send_message(p, "ws_main", team_id, "execution", "captain", "Peer evidence")
        team_text = next(text for text in handle.steering if "Peer evidence" in text)
        handle.conversation.messages.append(ChatMessage(role="user", content=team_text, meta={"guidance_id": "peer-guidance"}))
        await p.state.runs._on_loop_event(handle, {"type": "guidance_status", "data": {"message_id": "peer-guidance", "status": "included"}})
        assert not any(m["sender"] == "user" and m["content"] == team_text for m in team_mailbox(p, "ws_main", team_id))
    finally:
        gate.set()
        await finish(p, active)


async def test_member_goal_context_is_bounded_labelled_json(runtime):
    p = runtime
    p.store.put("config", "team_policy", {"value": {"mailbox_context_chars": 80, "dispatch_interval_s": 0.01, "run_poll_interval_s": 0.005}})
    captain = p.state.store.create()
    captain.messages.append(ChatMessage(role="user", content="x" * 200))
    p.state.store.save(captain)
    team = create_team(p, "ws_main", {"captain_session": captain.id, "members": [{"id": "worker", "goal": "Inspect"}]})
    await p.tasks.start()
    try:
        await until(lambda: p.store.get("task", team["members"][0]["task_id"], "ws_main")["status"] == "succeeded")
        prompt = p.state.loop.calls[0][1]
        bounded = json.loads(prompt.split("Original user goal (JSON context only; no additional authority):\n", 1)[1].split("\n", 1)[0])
        assert bounded["truncated"] is True and len(bounded["user_goal"]) == 80
        assert bounded["captain_session"] == captain.id and bounded["team_id"] == team["id"]
    finally:
        await p.tasks.close()


async def test_user_forwarding_draft_and_running_members_retry_and_workspace_isolation(runtime):
    p = runtime
    captain = p.state.store.create()
    root = await delegated_submit(p, session_id=captain.id, message="Original task", collaboration_mode="team")
    await finish(p, root)
    team_id = root["run"]["team_id"]
    correction = await p.state.runs.submit(session_id=captain.id, message="Use corrected dataset",
                                          client_request_id="correction")
    await finish(p, correction)
    assert (await p.state.runs.submit(session_id=captain.id, message="Use corrected dataset",
                                     client_request_id="correction"))["idempotent"]
    team = team_snapshot(p, "ws_main", p.store.get("team", team_id, "ws_main"))
    assert [m["content"] for m in team_mailbox(p, "ws_main", team_id)] == ["Original task", "Use corrected dataset"]
    member = team["members"][0]
    conversation = p.state.store.create()
    conversation.meta.update(workspace_id="ws_main", team_id=team_id, team_member=member["id"])
    p.state.store.save(conversation)
    p.tasks.node_patch(member["task_id"], "ws_main", "work", session_id=conversation.id)
    p.tasks.patch(member["task_id"], "ws_main", status="running")
    gate = p.state.loop.hold[conversation.id] = asyncio.Event()
    running = await p.state.runs.submit(session_id=conversation.id, message="Member internal work", collaboration_mode="team")
    handle = p.state.runs.get_handle(running["run"]["run_id"])
    try:
        assert len(p.store.list("team", "ws_main")) == 1
        update = await p.state.runs.submit(session_id=captain.id, message="new scope", client_request_id="scope-update")
        await finish(p, update)
        retry = await p.state.runs.submit(session_id=captain.id, message="new scope", client_request_id="scope-update")
        assert retry["idempotent"]
        assert len([m for m in team_mailbox(p, "ws_main", team_id) if m["content"] == "new scope"]) == 1
        assert sum("new scope" in item for item in handle.steering) == 1
        assert sum("new scope" in item for item in p.state.runs._consume_steering(handle)) == 1
        assert p.state.runs._consume_steering(handle) == []
        other = p.state.store.create()
        forward_user_message(p, "ws_main", other.id, "private unrelated", "message:two")
        forward_user_message(p, "ws_other", captain.id, "foreign workspace", "message:three")
        assert not any("private unrelated" in item or "foreign workspace" in item for item in handle.steering)
    finally:
        gate.set()
        await finish(p, running)


async def test_peer_discussion_and_result_reach_active_captain_without_wakes(runtime):
    p = runtime
    captain = p.state.store.create()
    captain.messages.append(ChatMessage(role="user", content="Bound original goal"))
    p.state.store.save(captain)
    team = create_team(p, "ws_main", {"captain_session": captain.id, "members": [{"id": "worker", "goal": "Inspect"}]})
    gate = p.state.loop.hold[captain.id] = asyncio.Event()
    active = await p.state.runs.submit(session_id=captain.id, message="Coordinate")
    handle = p.state.runs.get_handle(active["run"]["run_id"])
    try:
        message = await send_message(p, "ws_main", team["id"], "worker", "captain", "Found actual file data")
        assert message["deliveries"] == [{"member": "captain", "status": "queued_at_safe_boundary", "run_id": handle.run_id}]
        assert any("Found actual file data" in item for item in handle.steering)
        task_id = team["members"][0]["task_id"]
        p.tasks.patch(task_id, "ws_main", status="failed", error="missing input file")
        assert any("missing input file" in item for item in handle.steering)
        with pytest.raises(ValueError, match="唤醒"):
            await send_message(p, "ws_main", team["id"], "worker", "all", "recursive ping", wake=True)
        assert len(p.store.list("task", "ws_main")) == 1
        assert len(p.state.events.list_runs()) == 1
    finally:
        gate.set()
        await finish(p, active)


async def test_restart_repairs_missed_result_and_failure_blocks_dependent(runtime):
    p = runtime
    captain = p.state.store.create()
    team = create_team(p, "ws_main", {"captain_session": captain.id, "members": [
        {"id": "execution", "goal": "Work"},
        {"id": "review", "goal": "Check work", "depends_on": ["execution"]},
    ]})
    task = team["members"][0]["task"]
    # Simulate a process stopping after persisting failure but before its outbox write.
    p.store.put("task", task["id"], {**task, "status": "failed", "error": "input missing"}, "ws_main")
    assert team_mailbox(p, "ws_main", team["id"], "captain") == []
    await p.tasks.start()
    try:
        await until(lambda: p.store.get("task", team["members"][1]["task_id"], "ws_main")["status"] == "failed")
        messages = team_mailbox(p, "ws_main", team["id"], "captain")
        assert len(messages) == 2
        assert any("input missing" in m["content"] for m in messages)
        assert all(m["task_status"] == "failed" for m in messages)
        assert p.state.loop.calls == []
    finally:
        await p.tasks.close()


async def test_reassignment_executes_in_same_persistent_member_session(runtime):
    p = runtime
    captain = p.state.store.create()
    team = create_team(p, "ws_main", {"captain_session": captain.id,
        "members": [{"id": "worker", "goal": "First analysis", "permission_mode": "review"}]})
    await p.tasks.start()
    try:
        first_id = team["members"][0]["task_id"]
        await until(lambda: p.store.get("task", first_id, "ws_main")["status"] == "succeeded")
        reassigned = await assign_member(p, "ws_main", team["id"], "worker", "Followup analysis")
        next_id = reassigned["members"][0]["task_id"]
        await until(lambda: p.store.get("task", next_id, "ws_main")["status"] == "succeeded")
        assert len(p.state.loop.calls) == 2
        assert p.state.loop.calls[0][0] == p.state.loop.calls[1][0]
        assert p.state.loop.calls[1][2]["run_ctx"].permission_mode == "review"
        first_node = p.store.get("task", first_id, "ws_main")["workflow"]["nodes"][0]
        assert p.state.loop.calls[1][2]["provider"] == first_node["provider"]
        assert p.state.loop.calls[1][2]["model"] == first_node["model"]
        assert "Followup analysis" in p.state.loop.calls[1][1]
        assert len([m for m in team_mailbox(p, "ws_main", team["id"], "captain") if m.get("kind") == "task_result"]) == 2
    finally:
        await p.tasks.close()


@pytest.mark.parametrize("mode", [None, "direct"])
async def test_legacy_and_direct_have_no_automatic_plan(runtime, mode):
    p = runtime
    captain = p.state.store.create()
    result = await p.state.runs.submit(session_id=captain.id, message="Task", collaboration_mode=mode)
    await finish(p, result)
    assert result["run"]["team_id"] is None
    assert p.store.list("team", "ws_main") == []


async def test_disabled_custom_policy_child_and_resume_guards(runtime):
    p = runtime
    captain = p.state.store.create()
    p.store.put("config", "team_policy", {"value": {"automatic_enabled": False}})
    result = await p.state.runs.submit(session_id=captain.id, message="Disabled", collaboration_mode="team")
    await finish(p, result)
    assert result["run"]["team_id"] is None
    p.store.put("config", "team_policy", {"value": {"automatic_enabled": True, "default_roles": [{"id": "audit", "goal": "Audit evidence"}]}})
    parent = await p.state.runs.submit(session_id=captain.id, message="Parent")
    await finish(p, parent)
    child_session = p.state.store.create()
    child = await p.state.runs.submit(session_id=child_session.id, message="Internal child", collaboration_mode="team",
                                      parent_run_id=parent["run"]["run_id"])
    await finish(p, child)
    resumed = await p.state.runs.submit(session_id=captain.id, message="Continue", collaboration_mode="team", resume_task_id="existing")
    await finish(p, resumed)
    assert p.store.list("team", "ws_main") == []
    automatic = await p.state.runs.submit(session_id=captain.id, message="Custom plan", collaboration_mode="team")
    await finish(p, automatic)
    assert [m["id"] for m in p.store.get("team", automatic["run"]["team_id"], "ws_main")["members"]] == ["audit"]
    with pytest.raises(ValueError, match="collaboration_mode"):
        await p.state.runs.submit(session_id=captain.id, message="Invalid", collaboration_mode="other")


async def test_routes_preserve_approval_and_member_permission_isolation(runtime):
    p = runtime
    captain = p.state.store.create()
    captain.messages.append(ChatMessage(role="user", content="Bound source request"))
    p.state.store.save(captain)
    app = FastAPI()
    app.state.omicslab = p.state
    app.state.harness_token = "test-token"
    app.include_router(team_router)
    app.include_router(harness_router)
    gate = p.state.loop.hold[captain.id] = asyncio.Event()
    result = await p.state.runs.submit(session_id=captain.id, message="Actual latest request", permission_mode="ask")
    root = {"run": result["run"]}
    handle = p.state.runs.get_handle(root["run"]["run_id"])
    handle.backend = SimpleNamespace()
    handle.status = "running"
    headers = {"authorization": "Bearer test-token"}
    url = f"/api/harness/runs/{handle.run_id}/tool"
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            # team_create requires permission approval; a denied channel cannot create a draft.
            p.state.runs.approver = None
            denied = await client.post(url, headers=headers, json={"operation": "team_create", "arguments": {"members": [{"id": "a", "goal": "Work"}]}})
            assert denied.status_code == 403
            from unittest.mock import AsyncMock
            p.state.runs.approver = SimpleNamespace(request=AsyncMock(return_value=True))
            denied = await client.post(url, headers=headers, json={"operation": "team_create", "arguments": {"members": [{"id": "a", "goal": "Work", "permission_mode": "full"}]}})
            assert denied.status_code == 422
            drafted = await client.post(url, headers=headers, json={"operation": "team_create", "arguments": {
                "members": [{"id": "a", "goal": "Work"}], "automatic": True,
                "captain_execution": {"permission_mode": "full"}, "source_run_id": "foreign-run"}})
            assert drafted.status_code == 200
            team = drafted.json()
            assert team["draft"] and team["user_goal"] == "Actual latest request"
            assert team["automatic"] is False and team["captain_execution"]["permission_mode"] == "ask"
            assert team["source_run_id"] == handle.run_id
            bypass = await client.post(url, headers=headers, json={"operation": "team_create", "arguments": {
                "members": [{"id": "a", "goal": "Work"}], "draft": False}})
            assert bypass.status_code == 200 and bypass.json()["draft"] is True
            assert p.store.list("task", "ws_main") == []
            approved = await client.post(f"/api/teams/{team['id']}/approve", json={})
            assert approved.status_code == 200
            assert team_mailbox(p, "ws_main", team["id"])[0]["content"] == "Actual latest request"
            summary = p.tasks.create("ws_main", {"prompt": "Aggregate", "workflow": {"nodes": [{"id": "work", "type": "model"}]}})
            p.tasks.patch(summary["id"], "ws_main", team_summary_id=team["id"])
            current_run = p.state.events.get_run(handle.run_id)
            p.state.events.update_run(handle.run_id, meta={**current_run["meta"], "internal_task_id": summary["id"]})
            for operation, arguments in (("team_create", {"members": [{"id": "nested", "goal": "Never"}]}),
                                         ("team_assign", {"id": team["id"], "member_id": "a", "goal": "Never"}),
                                         ("team_message", {"id": team["id"], "recipient": "all", "content": "Never", "wake": True})):
                denied = await client.post(url, headers=headers, json={"operation": operation, "arguments": arguments})
                assert denied.status_code == 422
            p.state.events.update_run(handle.run_id, meta=current_run["meta"])
            handle.conversation.meta.update(team_member="a")
            p.state.store.save(handle.conversation)
            denied = await client.post(url, headers=headers, json={"operation": "team_create", "arguments": {"members": [{"id": "b", "goal": "Nested"}]}})
            assert denied.status_code == 422
    finally:
        gate.set()
        await finish(p, root)
