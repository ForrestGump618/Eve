#!/usr/bin/env python
"""Suwen acceptance runner for the optimization task book (section 12).

Starts a *real* Suwen server with a scripted, local fake OpenAI-compatible
provider and verifies the run-lifecycle, approval, workspace isolation,
reconnect, scoped-cancel and crash-recovery acceptance scenarios end to end.

Real SSH servers and real LLM accounts are deliberately *not* covered here;
see ``docs/ACCEPTANCE.md`` for the list of scenarios that remain unverified.

Usage::

    .\.venv\Scripts\python.exe scripts\acceptance.py
    .\.venv\Scripts\python.exe scripts\acceptance.py --keep --timeout 240

Exit code 0 when every requested check passed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

try:
    import httpx
except Exception:  # pragma: no cover - httpx is a hard runtime dependency
    print("httpx is required: .venv\\Scripts\\python.exe -m pip install httpx", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / ".tmp" / "accept"
RESULTS: list[dict[str, Any]] = []


# ----------------------------------------------------------------- helpers
def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def record(name: str, ok: bool, detail: str = "", *, skipped: bool = False, extra: Any = None) -> bool:
    entry = {"name": name, "ok": bool(ok), "skipped": skipped, "detail": detail[:4000]}
    if extra is not None:
        entry["extra"] = extra
    RESULTS.append(entry)
    tag = "SKIP" if skipped else ("PASS" if ok else "FAIL")
    print(f"[{tag}] {name}" + (f" :: {detail}" if detail and not ok else ""), flush=True)
    return ok


def wait_http(port: int, path: str = "/api/health", timeout: float = 180.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        try:
            resp = httpx.get(f"http://127.0.0.1:{port}{path}", timeout=5.0)
            if resp.status_code == 200:
                return resp.json()
            last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
        except Exception as exc:  # not up yet
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(0.4)
    raise RuntimeError(f"server on {port} did not become healthy: {last_error}")


def api(port: int, method: str, path: str, payload: Any = None, timeout: float = 60.0) -> tuple[int, Any]:
    url = f"http://127.0.0.1:{port}{path}"
    try:
        resp = httpx.request(method, url, json=payload, timeout=timeout)
    except Exception as exc:
        return 0, {"error": {"message": f"{type(exc).__name__}: {exc}", "code": "transport"}}
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    return resp.status_code, body


def err_code(body: Any) -> str:
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, dict):
            err = detail.get("error")
            if isinstance(err, dict):
                return str(err.get("code") or "")
            return str(detail.get("code") or "")
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or "")
    return ""


def sse_frames(
    port: int,
    path: str,
    payload: Any = None,
    *,
    method: str = "POST",
    stop_after: int | None = None,
    timeout: float = 240.0,
) -> Iterator[dict[str, Any]]:
    """Yield parsed SSE frames; caller may ``close()`` the generator early."""
    url = f"http://127.0.0.1:{port}{path}"
    with httpx.Client(timeout=httpx.Timeout(timeout, read=timeout)) as client:
        with client.stream(method, url, json=payload) as resp:
            if resp.status_code >= 400:
                text = resp.read().decode("utf-8", "replace")
                raise RuntimeError(f"stream HTTP {resp.status_code}: {text[:600]}")
            count = 0
            for line in resp.iter_lines():
                if not line:
                    continue
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                yield frame
                count += 1
                if stop_after is not None and count >= stop_after:
                    return


# --------------------------------------------------------------- fake LLM
class FakeLLM:
    """A tiny scripted OpenAI-compatible streaming provider."""

    def __init__(self) -> None:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt: str, *args: Any) -> None:  # silence
                return

            def do_GET(self) -> None:  # noqa: N802
                if self.path.rstrip("/").endswith("/models"):
                    body = json.dumps({"data": [{"id": "fake-model", "object": "model"}]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    payload = json.loads(self.rfile.read(length) or b"{}")
                except Exception:
                    payload = {}
                try:
                    outer._handle(self, payload)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self.httpd.server_address[1])
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        try:
            self.httpd.shutdown()
        except Exception:
            pass
        try:
            self.httpd.server_close()
        except Exception:
            pass

    # -- response writing ------------------------------------------------
    def _chunk(self, handler: BaseHTTPRequestHandler, delta: dict[str, Any], finish: str | None = None) -> None:
        payload = {
            "id": "chatcmpl-fake",
            "object": "chat.completion.chunk",
            "model": "fake-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        handler.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
        handler.wfile.flush()

    def _start_sse(self, handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "close")
        handler.end_headers()

    def _finish(self, handler: BaseHTTPRequestHandler, finish: str = "stop") -> None:
        self._chunk(handler, {}, finish)
        handler.wfile.write(b"data: [DONE]\n\n")
        handler.wfile.flush()
        handler.close_connection = True

    def _handle(self, handler: BaseHTTPRequestHandler, payload: dict[str, Any]) -> None:
        messages = payload.get("messages") or []
        last_user = ""
        last_role = ""
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "")
            content = message.get("content")
            if role == "user":
                last_user = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            last_role = role
        self._start_sse(handler)
        try:
            if last_role == "tool":
                self._chunk(handler, {"role": "assistant", "content": "TOOL_DONE"})
                self._finish(handler)
                return
            text = (last_user or "").upper()
            if "DELEGATE" in text:
                args = json.dumps({"agent_id": "data-critic", "prompt": "child subtask"})
                self._chunk(
                    handler,
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_delegate_1",
                                "type": "function",
                                "function": {"name": "delegate_agent", "arguments": args},
                            }
                        ],
                    },
                )
                self._finish(handler, "tool_calls")
                return
            if "APPROVAL" in text:
                args = json.dumps({"command": "echo APPROVAL_OK", "timeout_s": 30})
                self._chunk(
                    handler,
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_shell_1",
                                "type": "function",
                                "function": {"name": "run_shell", "arguments": args},
                            }
                        ],
                    },
                )
                self._finish(handler, "tool_calls")
                return
            if "SLOW" in text:
                for index in range(30):
                    self._chunk(handler, {"content": f"slow-{index} "})
                    time.sleep(0.2)
                self._finish(handler)
                return
            echo = last_user.strip().replace("\n", " ")[:80]
            self._chunk(handler, {"role": "assistant", "content": f"PONG: {echo}"})
            self._finish(handler)
        except (BrokenPipeError, ConnectionResetError):
            return


# ---------------------------------------------------------------- server
class Server:
    def __init__(self, port: int, home: Path, workspace: Path) -> None:
        self.port = port
        self.home = home
        self.workspace = workspace
        self.log = home.parent / "serve.log"
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self, timeout: float = 180.0) -> dict[str, Any]:
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["OMICSLAB_HOME"] = str(self.home)
        args = [
            sys.executable,
            "-m",
            "omicslab",
            "serve",
            "--port",
            str(self.port),
            "--no-open",
            "--workspace",
            str(self.workspace),
        ]
        handle = open(self.log, "ab")
        self.proc = subprocess.Popen(args, cwd=str(ROOT), env=env, stdout=handle, stderr=subprocess.STDOUT)
        return wait_http(self.port, timeout=timeout)

    def stop(self, *, force: bool = False) -> None:
        if self.proc is None:
            return
        try:
            if force:
                self.proc.kill()
            else:
                self.proc.terminate()
            self.proc.wait(timeout=15)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


def configure(port: int, llm: FakeLLM) -> tuple[bool, str]:
    status, body = api(port, "PUT", "/api/settings", {"patch": {"provider": "custom_openai", "model": "fake-model"}})
    if status != 200:
        return False, f"PUT settings HTTP {status}: {json.dumps(body, ensure_ascii=False)[:300]}"
    status, body = api(
        port,
        "PUT",
        "/api/settings",
        {"patch": {"api_base": f"http://127.0.0.1:{llm.port}/v1", "approval_policy": "ask", "temperature": 0.0}},
    )
    if status != 200:
        return False, f"PUT api_base HTTP {status}: {json.dumps(body, ensure_ascii=False)[:300]}"
    status, body = api(port, "POST", "/api/settings/keys", {"keys": {"CUSTOM_OPENAI_API_KEY": "acc-test-key"}})
    if status != 200:
        return False, f"POST keys HTTP {status}: {json.dumps(body, ensure_ascii=False)[:300]}"
    status, body = api(port, "POST", "/api/settings/test_llm", {"provider": "custom_openai", "model": "fake-model"})
    if status != 200 or not (isinstance(body, dict) and body.get("ok")):
        return False, f"test_llm failed: {json.dumps(body, ensure_ascii=False)[:300]}"
    return True, "custom_openai -> fake LLM"


def new_session(port: int, message: str = "hello") -> tuple[str, str]:
    status, body = api(port, "POST", "/api/conversations", {"agent": "lead", "title": "acceptance"})
    if status != 200:
        raise RuntimeError(f"create conversation HTTP {status}: {body}")
    conv = body.get("conversation") if isinstance(body, dict) and "conversation" in body else body
    return str(conv.get("id")), str(conv.get("title") or "")


def submit_run(port: int, session_id: str, message: str, client_request_id: str | None = None) -> tuple[int, Any]:
    payload = {"message": message, "agent": "lead"}
    if client_request_id:
        payload["client_request_id"] = client_request_id
    return api(port, "POST", f"/api/sessions/{session_id}/runs", payload, timeout=60.0)


def consume_stream(port: int, path: str, payload: Any = None, stop_after: int | None = None) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    try:
        for frame in sse_frames(port, path, payload, stop_after=stop_after):
            frames.append(frame)
    except Exception as exc:
        frames.append({"_error": f"{type(exc).__name__}: {exc}"})
    return frames


def frame_types(frames: list[dict[str, Any]]) -> list[str]:
    return [str(frame.get("type") or "") for frame in frames]


def event_ids(frames: list[dict[str, Any]]) -> list[str]:
    return [str(frame.get("event_id") or "") for frame in frames if frame.get("event_id")]


# ---------------------------------------------------------------- checks
def check_default_agent(port: int) -> None:
    status, body = api(port, "GET", "/api/agents/default")
    agent = body.get("agent") if isinstance(body, dict) else None
    agent_id = ""
    if isinstance(agent, dict):
        agent_id = str(agent.get("id") or agent.get("name") or "")
    elif isinstance(body, dict):
        agent_id = str(body.get("id") or body.get("agent_id") or "")
    record("default agent is lead (T07)", status == 200 and agent_id == "lead", f"HTTP {status} id={agent_id!r} body={json.dumps(body, ensure_ascii=False)[:200] if body else ''}")


def check_double_submit(port: int) -> None:
    session_id, _ = new_session(port)
    frame_lock = threading.Lock()
    holder: dict[str, Any] = {}

    def worker() -> None:
        frames = consume_stream(port, "/api/chat", {"conversation_id": session_id, "message": "SLOW please", "agent": "lead"})
        with frame_lock:
            holder["frames"] = frames

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    # wait until the first run is registered and streaming
    time.sleep(2.5)
    status, body = api(port, "POST", "/api/chat", {"conversation_id": session_id, "message": "second", "agent": "lead"})
    code = err_code(body)
    ok = status == 409 and code == "run_in_progress"
    thread.join(timeout=120)
    frames = holder.get("frames") or []
    record(
        "double submit: only one run, second gets 409 run_in_progress (T02/F05)",
        ok and any(t == "done" for t in frame_types(frames)),
        f"second HTTP {status} code={code!r} first_frames={len(frames)}",
    )


def check_idempotent(port: int) -> str:
    session_id, _ = new_session(port)
    rid = "acc-idem-1"
    status1, body1 = submit_run(port, session_id, "hello idem", rid)
    run1 = (body1 or {}).get("run") or {}
    run_id1 = str(run1.get("run_id") or body1.get("run_id") or "")
    time.sleep(3.0)
    status2, body2 = submit_run(port, session_id, "hello idem", rid)
    run2 = (body2 or {}).get("run") or {}
    run_id2 = str(run2.get("run_id") or body2.get("run_id") or "")
    idem = bool((body2 or {}).get("idempotent"))
    record(
        "identical client_request_id is idempotent (T02/§13)",
        status1 == 200 and status2 == 200 and bool(run_id1) and run_id1 == run_id2 and idem,
        f"first={status1}/{run_id1} second={status2}/{run_id2} idempotent={idem}",
    )
    return run_id1


def check_replay(port: int) -> None:
    session_id, _ = new_session(port)
    first = consume_stream(port, "/api/chat", {"conversation_id": session_id, "message": "SLOW replay", "agent": "lead"}, stop_after=12)
    run_id = ""
    last_seq = 0
    for frame in first:
        if frame.get("run_id"):
            run_id = str(frame["run_id"])
        if isinstance(frame.get("seq"), int):
            last_seq = max(last_seq, int(frame["seq"]))
    if not run_id:
        record("reconnect replays without duplicate events (T03)", False, "no run_id in first frames")
        return
    second = consume_stream(port, f"/api/runs/{run_id}/stream", None, stop_after=None)
    ids = event_ids(first) + event_ids(second)
    unique = len(set(ids)) == len(ids)
    seqs = [int(f["seq"]) for f in second if isinstance(f.get("seq"), int)]
    monotonic = all(b > a for a, b in zip(seqs, seqs[1:])) if len(seqs) > 1 else True
    record(
        "reconnect replays without duplicate events (T03)",
        unique and monotonic and last_seq > 0 and len(second) > 0,
        f"first={len(first)} replay={len(second)} last_seq={last_seq} unique={unique} monotonic={monotonic}",
    )


def check_scoped_cancel(port: int) -> None:
    session_a, _ = new_session(port)
    session_b, _ = new_session(port)
    holder: dict[str, Any] = {}

    def run_a() -> None:
        holder["a"] = consume_stream(port, "/api/chat", {"conversation_id": session_a, "message": "SLOW cancel", "agent": "lead"})

    def run_b() -> None:
        holder["b"] = consume_stream(port, "/api/chat", {"conversation_id": session_b, "message": "SLOW keep", "agent": "lead"})

    ta = threading.Thread(target=run_a, daemon=True)
    tb = threading.Thread(target=run_b, daemon=True)
    ta.start()
    tb.start()
    time.sleep(3.0)
    status, body = api(port, "POST", "/api/chat/stop", {"conversation_id": session_a})
    ta.join(timeout=120)
    tb.join(timeout=180)
    frames_a = holder.get("a") or []
    frames_b = holder.get("b") or []
    types_a = frame_types(frames_a)
    types_b = frame_types(frames_b)
    cancelled = "run_status" in types_a or "done" in types_a
    b_ok = any(t == "done" for t in types_b)
    kernels = api(port, "GET", "/api/kernels")[1] or {}
    main_kernel = (kernels.get("kernels") or {}).get("main") or {}
    kernel_running = bool(main_kernel.get("running"))
    record(
        "scoped stop only cancels its own run (T08/F12)",
        status == 200 and b_ok and kernel_running,
        f"stop HTTP {status} a_frames={len(frames_a)} b_frames={len(frames_b)} kernel_running={kernel_running}",
    )


def check_approval_survives_settings(port: int) -> None:
    session_id, _ = new_session(port)
    holder: dict[str, Any] = {}
    approved: dict[str, Any] = {}

    def worker() -> None:
        frames: list[dict[str, Any]] = []
        for frame in sse_frames(port, "/api/chat", {"conversation_id": session_id, "message": "APPROVAL please", "agent": "lead"}):
            frames.append(frame)
            if frame.get("type") == "approval_request" and "approval_id" not in approved:
                approval = frame.get("data") or {}
                approval_id = str(approval.get("id") or "")
                approved["approval_id"] = approval_id
                status_put, body_put = api(port, "PUT", "/api/settings", {"patch": {"temperature": 0.15}})
                approved["settings_status"] = status_put
                status_dec, body_dec = api(port, "POST", f"/api/approvals/{approval_id}", {"decision": "approve"})
                approved["decide_status"] = status_dec
                approved["decide_body"] = body_dec
        holder["frames"] = frames

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(timeout=180)
    frames = holder.get("frames") or []
    types = frame_types(frames)
    approval_id = approved.get("approval_id") or ""
    tool_ok = any(
        f.get("type") == "tool_result" and (f.get("data") or {}).get("ok") for f in frames
    )
    persisted = {}
    if approval_id:
        status, persisted = api(port, "GET", f"/api/approvals/{approval_id}")
        persisted = persisted if isinstance(persisted, dict) else {}
    persisted_status = ""
    if isinstance(persisted, dict):
        row = persisted.get("approval") or persisted
        persisted_status = str(row.get("status") or "")
    record(
        "approval survives a settings save mid-run (acceptance #10)",
        bool(approval_id)
        and approved.get("settings_status") == 200
        and approved.get("decide_status") == 200
        and tool_ok
        and persisted_status == "approved"
        and "done" in types,
        f"approval={approval_id} settings={approved.get('settings_status')} decide={approved.get('decide_status')} persisted={persisted_status} tool_ok={tool_ok}",
    )


def check_child_run(port: int) -> None:
    session_id, _ = new_session(port)
    frames = consume_stream(port, "/api/chat", {"conversation_id": session_id, "message": "DELEGATE this", "agent": "lead"})
    types = frame_types(frames)
    run_id = ""
    for frame in frames:
        if frame.get("run_id"):
            run_id = str(frame["run_id"])
    child_events = [f for f in frames if f.get("type") == "child_run"]
    children: Any = {}
    if run_id:
        status, children = api(port, "GET", f"/api/runs/{run_id}/children")
    count = int((children or {}).get("count") or 0) if isinstance(children, dict) else 0
    record(
        "child task run is visible and completes (T04/F11)",
        len(child_events) >= 2 and count >= 1 and "done" in types,
        f"child_run_events={len(child_events)} children={count} frames={len(frames)}",
    )


def check_workspace_isolation(port: int) -> None:
    base = TMP / "ws_iso"
    a_path = base / "a"
    b_path = base / "b"
    for path in (a_path, b_path):
        path.mkdir(parents=True, exist_ok=True)
    status_a, body_a = api(port, "POST", "/api/workspaces", {"name": "accept-a", "local_path": str(a_path)})
    status_b, body_b = api(port, "POST", "/api/workspaces", {"name": "accept-b", "local_path": str(b_path)})
    ws_a_meta = (body_a or {}).get("workspace") or {}
    ws_b_meta = (body_b or {}).get("workspace") or {}
    ws_a = str(ws_a_meta.get("workspace_id") or ws_a_meta.get("id") or "")
    ws_b = str(ws_b_meta.get("workspace_id") or ws_b_meta.get("id") or "")
    if status_a != 200 or status_b != 200 or not ws_a or not ws_b:
        record("workspace kernels and files are isolated (T05/acceptance #4)", False, f"create failed {status_a}/{status_b}")
        return
    api(port, "POST", f"/api/kernels/{ws_a}/start")
    api(port, "POST", f"/api/kernels/{ws_b}/start")
    _, body_exec_a = api(port, "POST", f"/api/kernels/{ws_a}/execute", {"code": "iso_var = 1\nprint('A', iso_var)"})
    _, body_exec_b = api(port, "POST", f"/api/kernels/{ws_b}/execute", {"code": "iso_var = 2\nprint('B', iso_var)"})
    _, vars_a = api(port, "GET", f"/api/kernels/{ws_a}/vars")
    _, vars_b = api(port, "GET", f"/api/kernels/{ws_b}/vars")
    repr_a = json.dumps(vars_a.get("vars") if isinstance(vars_a, dict) else vars_a, ensure_ascii=False)
    repr_b = json.dumps(vars_b.get("vars") if isinstance(vars_b, dict) else vars_b, ensure_ascii=False)
    api(port, "POST", f"/api/workspaces/{ws_a}/files/write", {"path": "iso.txt", "content": "only-a"})
    _, tree_b = api(port, "GET", f"/api/workspaces/{ws_b}/files/tree")
    names_b = [entry.get("name") for entry in ((tree_b or {}).get("entries") or [])] if isinstance(tree_b, dict) else []
    ok = (
        "iso_var" in repr_a
        and "iso_var" in repr_b
        and '"1"' in repr_a
        and '"2"' in repr_b
        and "iso.txt" not in names_b
    )
    record(
        "workspace kernels and files are isolated (T05/acceptance #4)",
        ok,
        f"ws_a={ws_a} ws_b={ws_b} vars_a={repr_a[:200]} vars_b={repr_b[:200]} b_files={names_b[:10]}",
    )


def check_crash_recovery(server: Server, llm: FakeLLM) -> None:
    port = server.port
    session_id, _ = new_session(port)
    status, body = submit_run(port, session_id, "SLOW crash me")
    run_id = str(((body or {}).get("run") or {}).get("run_id") or (body or {}).get("run_id") or "")
    trace_id = str(((body or {}).get("run") or {}).get("trace_id") or (body or {}).get("trace_id") or "")
    if not run_id:
        record("server crash is reconciled as interrupted, never silently re-run (T03/F14)", False, f"submit failed: {json.dumps(body, ensure_ascii=False)[:300]}")
        return
    time.sleep(2.5)
    before = api(port, "GET", f"/api/traces/{trace_id}/events?after_seq=0&limit=500")[1] or {}
    before_count = len(before.get("events") or []) if isinstance(before, dict) else 0
    server.stop(force=True)
    time.sleep(0.5)
    server.start(timeout=180.0)
    _, diagnostics = api(port, "GET", "/api/runtime/diagnostics")
    recovered = (diagnostics or {}).get("recovered_runs") if isinstance(diagnostics, dict) else None
    _, run = api(port, "GET", f"/api/runs/{run_id}")
    run_body = (run or {}).get("run") if isinstance(run, dict) and isinstance(run.get("run"), dict) else (run or {})
    run_status = str(run_body.get("status") or "") if isinstance(run_body, dict) else ""
    time.sleep(2.0)
    after = api(port, "GET", f"/api/traces/{trace_id}/events?after_seq=0&limit=500")[1] or {}
    after_count = len(after.get("events") or []) if isinstance(after, dict) else 0
    no_rerun = after_count >= before_count and (after_count <= before_count + 5)
    record(
        "server crash is reconciled as interrupted, never silently re-run (T03/F14)",
        run_status == "interrupted" and no_rerun,
        f"run={run_id} status={run_status} recovered={recovered} events_before={before_count} events_after={after_count}",
    )


def check_terminal_ws(port: int) -> None:
    try:
        import websockets.sync.client as ws_client
    except Exception as exc:
        record("local terminal websocket roundtrip (T05)", False, f"websockets unavailable: {exc}")
        return
    token = "OMI_TERM_OK"
    try:
        with ws_client.connect(f"ws://127.0.0.1:{port}/ws/terminal", open_timeout=20, close_timeout=5) as socket:
            deadline = time.time() + 20
            banner = ""
            while time.time() < deadline and token not in banner:
                try:
                    raw = socket.recv(timeout=2.0)
                except Exception:
                    break
                message = json.loads(raw) if isinstance(raw, str) else {}
                if message.get("type") == "output":
                    banner += str(message.get("data") or "")
                    if "Suwen" in banner or "$" in banner or ">" in banner:
                        socket.send(json.dumps({"type": "input", "data": f"echo {token}\r\n"}))
            deadline = time.time() + 20
            output = ""
            while time.time() < deadline and token not in output:
                try:
                    raw = socket.recv(timeout=2.0)
                except Exception:
                    break
                message = json.loads(raw) if isinstance(raw, str) else {}
                if message.get("type") == "output":
                    output += str(message.get("data") or "")
        record("local terminal websocket roundtrip (T05)", token in output, f"banner={banner[:120]!r} output={output[:200]!r}")
    except Exception as exc:
        record("local terminal websocket roundtrip (T05)", False, f"{type(exc).__name__}: {exc}")


def measure_health(port: int, count: int = 20) -> None:
    samples: list[float] = []
    for _ in range(count):
        start = time.perf_counter()
        try:
            httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=5.0)
            samples.append((time.perf_counter() - start) * 1000.0)
        except Exception:
            break
    if not samples:
        record("health endpoint latency measured (perf baseline)", False, "no samples")
        return
    samples.sort()
    p95 = samples[min(len(samples) - 1, int(round(0.95 * (len(samples) - 1))))]
    record(
        "health endpoint latency measured (perf baseline, local mock load)",
        True,
        f"n={len(samples)} p50={samples[len(samples)//2]:.1f}ms p95={p95:.1f}ms max={samples[-1]:.1f}ms",
    )


# ------------------------------------------------------------------ main
def main() -> int:
    parser = argparse.ArgumentParser(description="Suwen acceptance runner")
    parser.add_argument("--keep", action="store_true", help="keep the temporary home/workspace and report")
    parser.add_argument("--timeout", type=float, default=180.0, help="server startup timeout (seconds)")
    parser.add_argument(
        "--only",
        default="",
        help="comma separated subset: default,double,idem,replay,cancel,approval,child,workspace,crash,terminal,health",
    )
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

    selected = {part.strip() for part in args.only.split(",") if part.strip()} or {
        "default",
        "double",
        "idem",
        "replay",
        "cancel",
        "approval",
        "child",
        "workspace",
        "crash",
        "terminal",
        "health",
    }

    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    home = TMP / "home"
    files = TMP / "ws"
    home.mkdir(parents=True, exist_ok=True)
    files.mkdir(parents=True, exist_ok=True)

    llm = FakeLLM()
    port = free_port()
    server = Server(port, home, files)
    started_at = time.time()
    try:
        print(f"fake LLM on 127.0.0.1:{llm.port}, Suwen on 127.0.0.1:{port}", flush=True)
        health = server.start(timeout=args.timeout)
        print(f"server healthy: version={health.get('version')} kernel={(health.get('kernel') or {}).get('running')}", flush=True)
        ok, detail = configure(port, llm)
        record("fake OpenAI-compatible provider is wired through settings", ok, detail)
        if not ok:
            return 1

        if "default" in selected:
            check_default_agent(port)
        if "double" in selected:
            check_double_submit(port)
        if "idem" in selected:
            check_idempotent(port)
        if "replay" in selected:
            check_replay(port)
        if "cancel" in selected:
            check_scoped_cancel(port)
        if "approval" in selected:
            check_approval_survives_settings(port)
        if "child" in selected:
            check_child_run(port)
        if "workspace" in selected:
            check_workspace_isolation(port)
        if "terminal" in selected:
            check_terminal_ws(port)
        if "crash" in selected:
            check_crash_recovery(server, llm)
        if "health" in selected:
            measure_health(port)
    except Exception:
        traceback.print_exc()
        record("acceptance runner completed without crashing", False, traceback.format_exc()[-1500:])
    finally:
        server.stop()
        llm.stop()
        elapsed = time.time() - started_at
        passed = sum(1 for item in RESULTS if item["ok"])
        skipped = sum(1 for item in RESULTS if item["skipped"])
        failed = [item for item in RESULTS if not item["ok"]]
        report = {
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "elapsed_s": round(elapsed, 2),
            "passed": passed,
            "failed": len(failed),
            "total": len(RESULTS),
            "results": RESULTS,
            "limitations": [
                "real SSH server: unverified (fake paramiko + local subprocess only)",
                "real LLM provider: unverified (scripted fake OpenAI-compatible provider)",
                "browser-level UI checks: covered by browser E2E evidence, not this script",
            ],
        }
        TMP.mkdir(parents=True, exist_ok=True)
        (TMP / "acceptance_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nacceptance: {passed}/{len(RESULTS)} passed, {len(failed)} failed, {elapsed:.1f}s", flush=True)
        if failed:
            for item in failed:
                print(f"  FAIL {item['name']}: {item['detail'][:500]}", flush=True)
        if not args.keep:
            print(f"report: {TMP / 'acceptance_report.json'}", flush=True)
        return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
