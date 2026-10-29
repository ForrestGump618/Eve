"""Chat endpoint: runs (durable, resumable) + trace streaming.

This module is intentionally thin. All lifecycle logic lives in
:class:`omicslab.runtime.runs.RunService`; the HTTP layer only:

* maps the request onto a run (idempotent through ``client_request_id``);
* streams the run trace as SSE (with sequence numbers for resumption);
* exposes trace replay, scoped cancel and steering;
* renders pending approvals and resolves them.

Breaking a connection **never** cancels a run: a run only stops through the
scoped cancel endpoint (or a shutdown).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..agent.types import AgentEvent, new_id
from ..runtime.events import ACTIVE_STATUSES, TERMINAL_STATUSES, RunConflict, RunNotFound, TaskNotFound, utc_now

router = APIRouter(tags=["chat"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

_TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def _sse(payload: Any) -> str:
    """Serialize one SSE frame.

    Trace frames are plain dicts; discovery/legacy streams still emit
    ``AgentEvent`` objects, so accept both shapes instead of stringifying them.
    """
    if hasattr(payload, "to_dict"):
        payload = payload.to_dict()
    elif not isinstance(payload, dict):
        payload = {"type": "message", "data": {"value": str(payload)}}
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _state(request: Request) -> Any:
    return request.app.state.omicslab


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _stream_frames(state: Any, run: dict[str, Any], *, after_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
    return state.runs.subscribe(run["trace_id"], after_seq=after_seq)


def _sse_response(frames: AsyncIterator[dict[str, Any]], *, request: Request) -> StreamingResponse:
    async def gen() -> AsyncIterator[str]:
        try:
            async for frame in frames:
                if await request.is_disconnected():
                    break
                yield _sse(frame)
        except asyncio.CancelledError:  # client gone / server shutdown
            return
        except Exception as exc:  # pragma: no cover - stream must end cleanly
            yield _sse({"type": "error", "data": {"message": f"事件流中断：{exc}", "code": "stream_error"}})
        finally:
            aclose = getattr(frames, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:
                    pass

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


def _workspace_binding(state: Any, conversation: Any, workspace_id: str | None) -> Any:
    if state.workspaces is None:
        if workspace_id or (conversation.meta or {}).get("workspace_id"):
            raise HTTPException(503, "工作区服务不可用；禁止回退默认目录")
        return None
    bound = (conversation.meta or {}).get("workspace_id")
    if bound and workspace_id and bound != workspace_id and conversation.messages:
        raise HTTPException(409, "会话已绑定其他工作区，请新建会话后切换执行环境")
    requested = workspace_id or bound
    workspace = state.workspaces.get(requested) if requested else state.workspaces.workspace_for_conversation(conversation.id)
    if requested and workspace is None:
        raise HTTPException(404, "绑定的工作区不存在；禁止回退默认目录")
    workspace = workspace or state.workspaces.default()
    state.workspaces.bind_conversation(conversation.id, workspace.workspace_id)
    conversation.meta["workspace_id"] = workspace.workspace_id
    state.store.save(conversation)
    return workspace


@router.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    """Start a run and stream its trace.

    Body fields: ``message`` (required), ``conversation_id``, ``agent``,
    ``provider``, ``model``, ``workspace_id``, ``attachments``,
    ``client_request_id``.
    """
    state = _state(request)
    body = await _json(request)
    message = str(body.get("message") or "").strip()
    if not message and not body.get("attachments"):
        raise HTTPException(status_code=400, detail={"error": {"message": "message 不能为空", "code": "invalid_message"}})

    conversation_id = str(body.get("conversation_id") or "").strip()
    agent_id = str(body.get("agent") or "").strip() or state.default_agent_info()["agent_id"]
    conversation = None
    created_new = False
    if conversation_id:
        try:
            conversation = state.store.get(conversation_id)
        except Exception:
            conversation = None
    client_request_hint = str(body.get("client_request_id") or "").strip()
    if conversation is None and client_request_hint:
        existing = state.events.find_by_client_request(client_request_hint) if state.events else None
        if existing and existing.get("session_id"):
            try:
                conversation = state.store.get(str(existing["session_id"]))
            except Exception:
                conversation = None
    if conversation is None:
        conversation = state.store.create(agent=agent_id, title="新会话")
        created_new = True
    if not conversation.agent:
        conversation.agent = agent_id

    workspace = _workspace_binding(state, conversation, str(body.get("workspace_id") or "").strip() or None)
    from ..agent.permissions import validate_mode
    try:
        permission_mode = validate_mode(body.get("permission_mode", "ask"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    attachments = body.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []

    try:
        submitted = await state.runs.submit(
            session_id=conversation.id,
            message=message,
            agent_id=agent_id,
            client_request_id=str(body.get("client_request_id") or "").strip() or None,
            workspace_id=getattr(workspace, "workspace_id", None),
            permission_mode=permission_mode,
            provider=str(body.get("provider") or "").strip() or None,
            model=str(body.get("model") or "").strip() or None,
            attachments=[a for a in attachments if isinstance(a, dict)],
            conversation=conversation,
            **({"collaboration_mode": body["collaboration_mode"]} if "collaboration_mode" in body else {}),
        )
    except RunConflict:
        active = state.events.active_run_for_session(conversation.id) or {}
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "message": "该会话已有运行中的任务",
                    "code": "run_in_progress",
                    "run_id": active.get("run_id"),
                    "trace_id": active.get("trace_id"),
                }
            },
        )
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": {"message": "会话不存在", "code": "session_not_found"}})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": {"message": f"提交运行失败：{exc}", "code": "submit_failed"}})

    snapshot = submitted["run"]
    if created_new and snapshot.get("session_id") and snapshot["session_id"] != conversation.id:
        # A retried request with the same client_request_id reuses the original
        # run (and its conversation); drop the freshly created placeholder.
        try:
            state.store.delete(conversation.id)
        except Exception:
            pass
        try:
            conversation = state.store.get(str(snapshot["session_id"]))
            workspace = _workspace_binding(state, conversation, getattr(workspace, "workspace_id", None))
        except Exception:
            pass
    run_id = snapshot["run_id"]
    run = state.events.get_run(run_id) or {}
    message_id = run.get("meta", {}).get("message_id") if isinstance(run.get("meta"), dict) else None
    connected = {
        "type": "connected",
        "data": {
            "conversation_id": conversation.id,
            "session_id": conversation.id,
            "run_id": run_id,
            "trace_id": snapshot.get("trace_id") or run.get("trace_id"),
            "message_id": message_id or new_id("m"),
            "agent": agent_id,
            "workspace": snapshot.get("workspace") or {},
            "idempotent": bool(submitted.get("idempotent")),
            "ts": utc_now(),
        },
        "ts": utc_now(),
    }
    frames = _prepend(state, connected, _stream_frames(state, run or snapshot))
    return _sse_response(frames, request=request)


async def _prepend(state: Any, first: dict[str, Any], frames: AsyncIterator[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    yield first
    async for frame in frames:
        yield frame


@router.get("/api/runs/{run_id}/stream")
async def stream_run(request: Request, run_id: str, after_seq: int = 0) -> StreamingResponse:
    """Resume a trace from ``after_seq`` (works after a browser refresh)."""
    state = _state(request)
    run = state.events.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail={"error": {"message": "运行不存在", "code": "run_not_found"}})
    connected = {
        "type": "connected",
        "data": {
            "run_id": run_id,
            "trace_id": run["trace_id"],
            "session_id": run["session_id"],
            "conversation_id": run["session_id"],
            "status": run["status"],
            "resumed": True,
            "ts": utc_now(),
        },
        "ts": utc_now(),
    }
    frames = _prepend(state, connected, state.runs.subscribe(run["trace_id"], after_seq=max(0, after_seq)))
    return _sse_response(frames, request=request)


@router.post("/api/chat/stop")
async def stop_chat(request: Request) -> dict[str, Any]:
    """Scoped stop: only the active run of this conversation/session.

    The shared kernel and other conversations are untouched.
    """
    state = _state(request)
    body = await _json(request)
    session_id = str(body.get("conversation_id") or body.get("session_id") or "").strip()
    run_id = str(body.get("run_id") or "").strip()
    if not run_id and session_id:
        active = state.events.active_run_for_session(session_id) or {}
        run_id = active.get("run_id") or ""
    if not run_id:
        return {"ok": False, "stopped": False, "detail": "没有可停止的运行"}
    try:
        result = await state.runs.cancel(run_id, "用户停止生成")
    except RunNotFound:
        return {"ok": False, "stopped": False, "detail": "运行不存在"}
    return {"ok": True, "stopped": True, "run_id": run_id, "status": result.get("status")}


@router.get("/api/runs/{run_id}")
async def get_run(request: Request, run_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.runs.snapshot(run_id)
    except RunNotFound:
        raise HTTPException(status_code=404, detail={"error": {"message": "运行不存在", "code": "run_not_found"}})


@router.get("/api/sessions/{session_id}/runs")
async def session_runs(request: Request, session_id: str, limit: int = 50) -> dict[str, Any]:
    state = _state(request)
    runs = state.events.list_runs(session_id=session_id, limit=max(1, min(limit, 200)))
    return {
        "session_id": session_id,
        "runs": [state.runs.snapshot(run["run_id"]) if run.get("run_id") else run for run in runs],
    }


@router.post("/api/runs/{run_id}/resume")
async def resume_run(request: Request, run_id: str) -> dict[str, Any]:
    state = _state(request)
    row = state.events.get_run(run_id)
    if not row:
        raise HTTPException(404, "运行不存在")
    if row["status"] not in {"interrupted", "failed", "cancelled", "unknown"}:
        raise HTTPException(409, "只能从已停止的运行恢复")
    body = await _json(request)
    if body.get("confirm_unknown") is not True:
        raise HTTPException(400, "需先确认未知操作已核对；恢复后高风险工具重新请求批准")
    task_id = (row.get("meta") or {}).get("harness_task_id")
    harness = getattr(state.runs.loop, "desktop_harness", None)
    if not task_id or harness is None:
        raise HTTPException(409, "没有可恢复的统一 Harness 检查点")
    workspace = row.get("workspace") or {}
    workspace_id = (row.get("meta") or {}).get("workspace_id") or workspace.get("workspace_id")
    current = state.workspaces.get(workspace_id)
    current_root = (str(current.root) if current.root else str((current.remote or {}).get("root") or "~")) if current else None
    if not current or current.backend != workspace.get("backend", "local") or (current.remote or {}) != (workspace.get("remote") or {}) or current_root != workspace.get("resolved_path", workspace.get("local_path", "")):
        raise HTTPException(409, "原工作区已变化或不存在，不能自动换环境恢复")
    previous = await harness.rpc("task.snapshot", id=task_id)
    if previous["status"] not in {"completed", "failed", "cancelled"}:
        await harness.rpc("control", id=task_id, action="cancel")
    checkpoint = next((e for e in reversed(previous.get("events", [])) if e["type"] == "agent.checkpoint"), None)
    if not checkpoint:
        raise HTTPException(409, "运行在检查点提交前中断，不能声称已恢复执行")
    prompt = (previous["steps"][-1].get("input") or {}).get("prompt")
    if not prompt:
        raise HTTPException(409, "原始任务目标不可恢复")
    try:
        return await state.runs.submit(session_id=row["session_id"], message=prompt,
                                       agent_id=row.get("agent_id"), workspace_id=workspace_id,
                                       provider=(row.get("meta") or {}).get("provider"), model=(row.get("meta") or {}).get("model"),
                                       permission_mode="ask", resume_task_id=task_id)
    except RunConflict as exc:
        raise HTTPException(409, "会话已有运行中的任务，请先结束该任务") from exc


@router.post("/api/runs/{run_id}/cancel")
async def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        row = state.events.get_run(run_id)
    except Exception:
        row = None
    if row is None:
        raise HTTPException(status_code=404, detail={"error": {"message": "运行不存在", "code": "run_not_found"}})
    status = str(row.get("status") or "")
    if status in TERMINAL_STATUSES:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "message": "运行已结束，无法取消",
                    "code": "run_finished",
                    "run_id": run_id,
                    "status": status,
                }
            },
        )
    try:
        return await state.runs.cancel(run_id, "用户停止生成")
    except RunNotFound:
        raise HTTPException(status_code=404, detail={"error": {"message": "运行不存在", "code": "run_not_found"}})


async def _guidance_call(state: Any, run_id: str, method: str, **params: Any) -> dict[str, Any]:
    row = state.events.get_run(run_id)
    if not row:
        raise HTTPException(404, "运行不存在")
    task_id = (row.get("meta") or {}).get("harness_task_id")
    harness = getattr(state.runs.loop, "desktop_harness", None)
    if not task_id or harness is None:
        raise HTTPException(409, "此运行尚未进入支持引导队列的统一 Harness")
    try:
        return await harness.rpc(method, id=task_id, **params)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)[:500]) from exc


@router.get("/api/runs/{run_id}/guidance")
async def list_guidance(request: Request, run_id: str) -> dict[str, Any]:
    return await _guidance_call(_state(request), run_id, "task.guidance.list")


@router.patch("/api/runs/{run_id}/guidance/{message_id}")
async def change_guidance(request: Request, run_id: str, message_id: str) -> dict[str, Any]:
    body = await _json(request)
    result = await _guidance_call(_state(request), run_id, "task.guidance.change", messageId=message_id,
                                  action=body.get("action"), expectedVersion=body.get("expectedVersion"),
                                  **({"content": body["content"]} if "content" in body else {}),
                                  **({"quote": body["quote"]} if "quote" in body else {}))
    return {"ok": True, **result}


@router.post("/api/runs/{run_id}/messages")
async def steer_run(request: Request, run_id: str) -> dict[str, Any]:
    """Append a user message to a live run (steering; never restarts it)."""
    state = _state(request)
    body = await _json(request)
    content = str(body.get("content") or body.get("message") or "").strip()
    row = state.events.get_run(run_id)
    if row and (row.get("meta") or {}).get("harness_task_id"):
        result = await _guidance_call(state, run_id, "task.guidance.change", content=content,
                                      quote=str(body.get("quote") or ""), action=body.get("action", "send"))
        return {"ok": True, **result}
    try:
        result = await state.runs.append_user_message(run_id, content)
    except RunNotFound:
        raise HTTPException(status_code=404, detail={"error": {"message": "运行不存在", "code": "run_not_found"}})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": {"message": str(exc), "code": "invalid_message"}})
    if not result.get("ok"):
        raise HTTPException(
            status_code=409,
            detail={"error": {"message": result.get("detail") or "运行已结束，请开始新的对话", "code": "run_finished"}},
        )
    return result


# -- approvals -------------------------------------------------------------
@router.post("/api/approvals/{approval_id}")
async def resolve_approval(request: Request, approval_id: str) -> dict[str, Any]:
    state = _state(request)
    body = await _json(request)
    decision = body.get("decision", body.get("approved"))
    if isinstance(decision, str):
        approved = decision.strip().lower() in {"approve", "approved", "yes", "true", "allow", "1", "同意"}
    else:
        approved = bool(decision)
    ok = state.approver.resolve(approval_id, approved)
    if not ok:
        raise HTTPException(status_code=404, detail={"error": {"message": "审批请求不存在或已处理", "code": "approval_not_found"}})
    try:
        row = state.events.get_approval(approval_id)
        if row:
            state.events.update_approval(approval_id, status="approved" if approved else "denied")
            await state.runs.emit_external(
                row["run_id"],
                "approval_resolved",
                {"id": approval_id, "approved": approved, "decided_at": utc_now()},
            )
    except Exception:
        pass
    return {"ok": True, "approval_id": approval_id, "approved": approved}


@router.get("/api/approvals")
async def list_approvals(request: Request, run_id: str | None = None, status: str | None = None) -> dict[str, Any]:
    state = _state(request)
    pending = state.approver.pending(run_id)
    if status and status != "pending":
        pending = []
    persisted: list[dict[str, Any]] = []
    try:
        persisted = state.events.list_approvals(run_id=run_id, status=status or "pending")
    except Exception:
        persisted = []
    return {"pending": pending, "persisted": persisted, "policy": state.approver.policy}


@router.get("/api/approvals/{approval_id}")
async def get_approval(request: Request, approval_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        row = state.events.get_approval(approval_id)
    except Exception:
        row = None
    if row is None:
        raise HTTPException(status_code=404, detail={"error": {"message": "审批请求不存在", "code": "approval_not_found"}})
    return row


@router.post("/api/sessions/{session_id}/runs")
async def create_session_run(request: Request, session_id: str) -> dict[str, Any]:
    """Create a run for an existing session without opening the SSE stream.

    The browser uses this to start work and then subscribe with
    ``GET /api/runs/{run_id}/stream``; ``POST /api/chat`` remains the convenience
    endpoint that streams immediately.
    """
    state = _state(request)
    body = await _json(request)
    message = str(body.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail={"error": {"message": "message 不能为空", "code": "invalid_message"}})
    try:
        conversation = state.store.get(session_id)
    except Exception:
        conversation = None
    if conversation is None:
        raise HTTPException(status_code=404, detail={"error": {"message": "会话不存在", "code": "session_not_found"}})
    agent_id = str(body.get("agent") or "").strip() or state.default_agent_info()["agent_id"]
    workspace = _workspace_binding(state, conversation, str(body.get("workspace_id") or "").strip() or None)
    from ..agent.permissions import validate_mode
    try:
        permission_mode = validate_mode(body.get("permission_mode", "ask"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    attachments = body.get("attachments") or []
    selection = conversation.meta.get("execution") or {}
    provider = str(body.get("provider") or selection.get("provider") or "").strip() or None
    model = str(body.get("model") or selection.get("model") or "").strip() or None
    conversation.meta["execution"] = {"provider": provider or "", "model": model or "", "permission_mode": permission_mode}
    state.store.save(conversation)
    try:
        result = await state.runs.submit(
            session_id=conversation.id,
            message=message,
            agent_id=agent_id,
            client_request_id=str(body.get("client_request_id") or "").strip() or None,
            workspace_id=getattr(workspace, "workspace_id", None),
            permission_mode=permission_mode,
            provider=provider,
            model=model,
            attachments=[a for a in attachments if isinstance(a, dict)] if isinstance(attachments, list) else [],
            conversation=conversation,
            **({"collaboration_mode": body["collaboration_mode"]} if "collaboration_mode" in body else {}),
        )
    except RunConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={"error": {"message": "该会话已有进行中的任务", "code": "run_in_progress", "run_id": str(exc)}},
        )
    run = (result.get("run") or {}) if isinstance(result, dict) else {}
    return {
        "run": run,
        "run_id": run.get("run_id"),
        "trace_id": run.get("trace_id"),
        "session_id": conversation.id,
        "idempotent": bool(result.get("idempotent")) if isinstance(result, dict) else False,
        "stream_url": f"/api/runs/{run.get('run_id')}/stream",
    }


@router.get("/api/traces/{trace_id}/events")
async def trace_events(request: Request, trace_id: str, after_seq: int = 0, limit: int = 500) -> dict[str, Any]:
    """Alias of /api/runtime/timeline/{trace_id} for the conversation UI."""
    state = _state(request)
    return state.runs.timeline(trace_id, after_seq=max(0, after_seq), limit=max(1, min(limit, 2000)))


@router.get("/api/runs/{run_id}/children")
async def run_children(request: Request, run_id: str) -> dict[str, Any]:
    state = _state(request)
    children = state.events.list_agent_tasks(parent_run_id=run_id, limit=500)
    return {"run_id": run_id, "children": children, "count": len(children)}


@router.get("/api/agent-tasks/{task_id}")
async def get_agent_task(request: Request, task_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.runs.agent_task(task_id)
    except TaskNotFound:
        raise HTTPException(status_code=404, detail={"error": {"message": "子任务不存在", "code": "task_not_found"}})


@router.get("/api/agent-tasks/{task_id}/runs")
async def get_agent_task_runs(request: Request, task_id: str) -> dict[str, Any]:
    state = _state(request)
    task = None
    try:
        task = state.events.get_agent_task(task_id)
    except Exception:
        task = None
    if task is None:
        raise HTTPException(status_code=404, detail={"error": {"message": "子任务不存在", "code": "task_not_found"}})
    runs: list[dict[str, Any]] = []
    for key in ("run_id", "parent_run_id"):
        run_id = task.get(key)
        if not run_id:
            continue
        try:
            run = state.events.get_run(str(run_id))
        except Exception:
            run = None
        if run and all(str(item.get("run_id")) != str(run.get("run_id")) for item in runs):
            runs.append(run)
    if not runs:
        try:
            related = state.events.list_runs(limit=200)
        except Exception:
            related = []
        for run in related:
            meta = run.get("meta") or {}
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            if isinstance(meta, dict) and str(meta.get("task_id") or "") == str(task_id):
                runs.append(run)
    return {"task": task, "runs": runs}


@router.get("/api/events/ping")
async def ping(request: Request) -> dict[str, Any]:
    return {"ok": True, "ts": utc_now()}
