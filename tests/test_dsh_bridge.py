"""DSH transport and turn regressions; no LLM requests or Jupyter kernels."""
from __future__ import annotations

import asyncio
import io
from functools import wraps
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from omicslab.agent.types import AgentCancelled
from omicslab.cli import CliApprover
from omicslab.config import Settings
from omicslab.integrations.dsh import BridgeError, DshBridge, PROTOCOL
from omicslab.session.store import ConversationStore

ROOT = Path(__file__).resolve().parents[1]


def run_async(test):
    """Keep these focused tests runnable without the optional pytest-asyncio plugin."""
    @wraps(test)
    def wrapped(*args, **kwargs):
        async def execute():
            try:
                return await test(*args, **kwargs)
            finally:
                if "fake_bridge" in kwargs:
                    await kwargs["fake_bridge"][0]._drain()
        return asyncio.run(execute())
    return wrapped


def test_stdio_hello_metadata_errors_and_shutdown_with_open_stdin(tmp_path):
    """Exercise the real CLI, including Windows exit with a blocked stdin reader."""
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    frames = queue.Queue()
    with (tmp_path / "stderr.log").open("wb") as stderr:
        proc = subprocess.Popen(
            [sys.executable, "-m", "omicslab", "dsh", "--stdio",
             "--workspace", str(tmp_path / "workspace"), "--home", str(tmp_path / "home")],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, env=env,
        )

        def read_frames():
            for raw in iter(proc.stdout.readline, b""):
                frames.put(raw)
            frames.put(None)

        reader = threading.Thread(target=read_frames, daemon=True)
        reader.start()

        def receive():
            raw = frames.get(timeout=30)
            assert raw is not None, "bridge exited before responding"
            return json.loads(raw.decode("utf-8"))

        def request(req_id, op, params=None):
            proc.stdin.write((json.dumps({"id": req_id, "op": op, "params": params or {}}) + "\n").encode())
            proc.stdin.flush()
            response = receive()
            assert response["id"] == req_id
            return response

        try:
            hello = receive()
            assert hello["kind"] == "hello"
            assert hello["protocol"] == PROTOCOL
            assert {"run.start", "run.status", "cancel", "shutdown"} <= set(hello["ops"])
            response = request("hello", "hello")
            assert response["ok"] is True
            assert response["result"]["protocol"] == PROTOCOL
            assert Path(response["result"]["workspace"]) == tmp_path / "workspace"
            assert request("ping", "ping")["result"]["pong"] is True
            proc.stdin.write(b'{broken json\n')
            proc.stdin.flush()
            bad = receive()
            assert bad["ok"] is False and bad["error"]["code"] == "bad_json"
            unknown = request("unknown", "unsupported.operation")
            assert unknown["ok"] is False and unknown["error"]["code"] == "unknown_op"
            for op, key, identifier in [("skills", "skills", "name"), ("agents", "agents", "id")]:
                response = request(op, op)
                assert response["ok"] is True
                result = response["result"]
                assert result["count"] == len(result[key]) > 0
                assert result["state"] == "cold"
                ids = [item[identifier] for item in result[key]]
                assert ids == sorted(ids)
            status = request("status", "status", {"light": True})["result"]
            assert status["state"] == "cold", "metadata requests must not create a kernel"
            shutdown = request("bye", "shutdown")
            assert shutdown["ok"] is True and shutdown["result"]["shutdown"] is True
            # Keep stdin open until exit: communicate() would hide the blocked-reader regression.
            assert proc.wait(timeout=15) == 0
            reader.join(timeout=5)
            assert not reader.is_alive()
            assert frames.get(timeout=5) is None
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            proc.stdin.close()
            proc.stdout.close()


@pytest.mark.parametrize("raw,code", [
    (b'{', "bad_json"), (b'\xff', "bad_json"), (b'[]', "bad_request"),
    (b'{"id":"x"}', "bad_request"),
    (b'{"id":"x","op":"ping","params":[1]}', "bad_request"),
    (b'{"id":"x","op":"no.such.op"}', "unknown_op"),
])
@run_async
async def test_bad_frames_return_errors_without_poisoning_next_request(raw, code):
    bridge = DshBridge()
    bridge._out = io.BytesIO()
    await bridge._dispatch_raw(raw)
    if bridge._tasks:
        await asyncio.gather(*list(bridge._tasks))
    response = json.loads(bridge._out.getvalue())
    assert response["ok"] is False
    assert response["error"]["code"] == code
    bridge._out = io.BytesIO()
    await bridge._dispatch_raw(b'{"id":"healthy","op":"ping"}')
    await asyncio.gather(*list(bridge._tasks))
    response = json.loads(bridge._out.getvalue())
    assert response["id"] == "healthy" and response["result"]["pong"] is True


@pytest.fixture
def fake_bridge(tmp_path):
    settings = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home", provider="mock")
    settings.ensure_dirs()
    state = SimpleNamespace(
        settings=settings, store=ConversationStore(settings), loop=SimpleNamespace(run=AsyncMock()),
        approver=SimpleNamespace(resolve=Mock(return_value=True)), shutdown=AsyncMock(),
    )
    bridge = DshBridge()
    bridge._settings = settings
    bridge._state = state
    bridge._out = io.BytesIO()
    return bridge, state


@run_async
async def test_async_start_poll_busy_and_completion(fake_bridge):
    bridge, state = fake_bridge
    started, release = asyncio.Event(), asyncio.Event()

    async def run(conv, prompt, *, emit, **kwargs):
        assert prompt == "study"
        started.set()
        await emit({"type": "tool_call", "data": {"name": "probe"}})
        await emit({"type": "tool_result", "data": {"ok": True}})
        await emit({"type": "usage", "data": {"usage": {"total_tokens": 17}}})
        await release.wait()
        return {"text": "finished", "finish_reason": "stop"}

    state.loop.run.side_effect = run
    submitted = await bridge._call("run.start", {"prompt": "study", "title": "Regression", "sessionId": "host-session"}, "start")
    assert submitted["status"] == "running" and submitted["pollWith"] == "run.status"
    await asyncio.wait_for(started.wait(), 1)
    running = await bridge._call("run.status", {"turnId": submitted["turnId"], "waitMs": 1}, "poll")
    assert running["status"] == "running"
    assert not bridge._turns[submitted["turnId"]]["task"].cancelled(), "poll timeout must shield the turn"
    before = len(state.store.list())
    with pytest.raises(BridgeError) as error:
        await bridge._call("run.start", {"prompt": "second"}, "second")
    assert error.value.code == "busy"
    assert len(state.store.list()) == before
    release.set()
    done = await bridge._call("run.status", {"waitMs": 1000}, "poll-done")
    assert done["status"] == "done" and done["text"] == "finished"
    assert done["finishReason"] == "stop" and done["timedOut"] is False
    assert done["usage"] == {"total_tokens": 17}
    assert done["result"]["toolCalls"] == done["result"]["toolResults"] == 1
    assert done["result"]["events"] == 3
    assert done["result"]["sessionId"] == "host-session"
    assert bridge._active is None
    assert bridge._out.getvalue() == b"", "run.start defaults to polling without orphaned stream events"


@run_async
async def test_cancel_reaches_agent_and_releases_busy_slot(fake_bridge):
    bridge, state = fake_bridge
    started = asyncio.Event()

    async def run(*args, cancel_event, **kwargs):
        started.set()
        await cancel_event.wait()
        raise AgentCancelled()

    state.loop.run.side_effect = run
    assert (await bridge._call("cancel", {}, "idle"))["cancelled"] is False
    submitted = await bridge._call("run.start", {"prompt": "cancel me"}, "start")
    await asyncio.wait_for(started.wait(), 1)
    cancelled = await bridge._call("cancel", {}, "cancel")
    assert cancelled["cancelled"] is True and cancelled["requestId"] == "start"
    result = await bridge._call("run.status", {"turnId": submitted["turnId"], "waitMs": 1000}, "poll")
    assert result["status"] == "done" and result["finishReason"] == "cancelled"
    assert bridge._active is None
    assert (await bridge._call("cancel", {}, "again"))["cancelled"] is False


@run_async
async def test_timeout_reports_timeout_instead_of_cancelled(fake_bridge):
    bridge, state = fake_bridge
    cancellation_seen = asyncio.Event()

    async def run(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancellation_seen.set()

    state.loop.run.side_effect = run
    # 真实默认宽限是 15s（给 agent 协作退出）；测试把宽限压到 0.2s 以便快速断言。
    bridge._cancel_grace_s = 0.2
    submitted = await bridge._call("run.start", {"prompt": "never completes", "timeoutMs": 10}, "start")
    # Poll after completion so a propagated CancelledError does not obscure the recorded status.
    task = bridge._turns[submitted["turnId"]]["task"]
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
    result = await bridge._call("run.status", {"turnId": submitted["turnId"]}, "poll")
    assert cancellation_seen.is_set()
    assert result["status"] == "done", result
    assert result["finishReason"] == "timeout"
    assert result["timedOut"] is True
    assert result["result"]["error"]["code"] == "timeout"
    assert bridge._active is None


@run_async
async def test_failed_turn_is_reported_and_bridge_can_start_another(fake_bridge):
    bridge, state = fake_bridge
    state.loop.run.side_effect = RuntimeError("provider failed")
    await bridge._call("run.start", {"prompt": "fail"}, "fail")
    failed = await bridge._call("run.status", {"waitMs": 1000}, "poll")
    assert failed["status"] == "done" and failed["finishReason"] == "error"
    assert failed["result"]["error"] == {"code": "turn_error", "message": "provider failed"}
    state.loop.run.side_effect = None
    state.loop.run.return_value = {"text": "recovered", "finish_reason": "stop"}
    await bridge._call("run.start", {"prompt": "retry"}, "retry")
    assert (await bridge._call("run.status", {"waitMs": 1000}, "poll"))["text"] == "recovered"


@pytest.mark.parametrize("params,code", [({}, "invalid_request"), ({"turnId": "missing"}, "not_found")])
@run_async
async def test_status_requires_existing_turn(params, code):
    with pytest.raises(BridgeError) as error:
        await DshBridge()._call("run.status", params, "poll")
    assert error.value.code == code


@pytest.mark.parametrize("mode,approved", [("auto", True), ("deny", False), ("client", None)])
@run_async
async def test_bridge_approval_modes_emit_and_resolve(fake_bridge, mode, approved):
    bridge, state = fake_bridge
    counters = {}
    emit = bridge._make_emitter("request", state, mode, counters=counters)
    await emit({"type": "approval_request", "data": {"id": "approval-1", "tool": "probe"}})
    frame = json.loads(bridge._out.getvalue())
    assert frame["kind"] == "event" and frame["id"] == "request" and frame["seq"] == 1
    data = frame["event"]["data"]
    assert data["mode"] == mode
    assert counters["events"] == 1
    if approved is None:
        assert data["pending"] is True
        state.approver.resolve.assert_not_called()
        resolved = await bridge._call("approval.resolve", {"id": "approval-1", "approved": True}, "resolve")
        assert resolved["resolved"] is True and resolved["approved"] is True
        state.approver.resolve.assert_called_once_with("approval-1", True)
    else:
        assert data["approved"] is approved and data["resolved"] is True
        state.approver.resolve.assert_called_once_with("approval-1", approved)


@pytest.mark.parametrize("policy,interactive,force_ask,expected", [
    ("auto", False, True, True), ("ask", False, True, True),
    ("deny", False, True, False), ("deny", True, True, False),
    ("auto", True, False, True),
])
@run_async
async def test_cli_approver_non_prompting_policies(monkeypatch, policy, interactive, force_ask, expected):
    prompt = Mock(side_effect=AssertionError("input must not be called"))
    monkeypatch.setattr("builtins.input", prompt)
    approver = CliApprover(policy, interactive=interactive)
    assert await approver.request(None, "probe", {}, "reason", force_ask=force_ask) is expected
    prompt.assert_not_called()


@pytest.mark.parametrize("answer,expected", [("yes", True), ("允许", True), ("n", False), ("", False)])
@run_async
async def test_cli_force_ask_prompts_interactive_auto(monkeypatch, answer, expected):
    prompt = Mock(return_value=answer)
    monkeypatch.setattr("builtins.input", prompt)
    approver = CliApprover("auto", interactive=True)
    assert await approver.request(None, "probe", {"path": "data"}, "review", force_ask=True) is expected
    prompt.assert_called_once()
    assert "probe" in prompt.call_args.args[0] and "review" in prompt.call_args.args[0]


@pytest.mark.parametrize("exception", [EOFError, KeyboardInterrupt])
@run_async
async def test_cli_force_ask_declines_when_input_ends(monkeypatch, exception):
    monkeypatch.setattr("builtins.input", Mock(side_effect=exception))
    assert await CliApprover("auto", interactive=True).request(None, "probe", {}, "", force_ask=True) is False
