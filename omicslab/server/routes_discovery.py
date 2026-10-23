"""Discovery / RSI REST + SSE endpoints.

A discovery run is a long-lived task, so it is streamed with the same SSE
envelope used by chat (``data: {"type": ..., "data": ..., "ts": ...}``).  Project
state lives in the file-based ledger, which means a run survives page reloads and
can be resumed after the server restarts.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..agent.types import AgentEvent
from ..discovery.ledger import ProjectNotFound
from .chat import SSE_HEADERS, _sse

logger = logging.getLogger("omicslab.server.discovery")

router = APIRouter(tags=["discovery"])


def _state(request: Request) -> object:
    return request.app.state.omicslab


def _error(message: str, code: str, status: int = 400, detail: str = "") -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code, "detail": detail})


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _project_summary(project) -> dict:
    return project.to_dict()


@router.get("/api/discovery/projects")
async def list_projects(request: Request) -> dict:
    state = _state(request)
    projects = state.discovery_store.list_projects()
    running = {item.id for item in projects if state.discovery_running(item.id)}
    return {
        "projects": [
            {**_project_summary(item), "live": item.id in running}
            for item in projects
        ]
    }


@router.post("/api/discovery/projects")
async def create_project(request: Request) -> dict:
    state = _state(request)
    body = await _json(request)
    objective = str(body.get("objective") or "").strip()
    if not objective:
        raise _error("objective 不能为空", "discovery_invalid")
    hints = body.get("data_hints") or []
    if isinstance(hints, str):
        hints = [item.strip() for item in hints.replace("\n", ",").split(",") if item.strip()]
    if not isinstance(hints, list):
        hints = []
    project = state.discovery_store.create(
        title=str(body.get("title") or ""),
        objective=objective,
        domain=str(body.get("domain") or "biomedicine"),
        agent=str(body.get("agent") or state.settings.default_agent),
        data_hints=[str(item) for item in hints],
        max_rounds=int(body.get("max_rounds") or 3),
        budget_minutes=int(body.get("budget_minutes") or 30),
    )
    return {"ok": True, "project": project.to_dict()}


@router.get("/api/discovery/projects/{project_id}")
async def get_project(project_id: str, request: Request) -> dict:
    state = _state(request)
    try:
        snapshot = state.discovery_store.snapshot(project_id)
    except ProjectNotFound:
        raise _error("发现项目不存在", "discovery_not_found", 404)
    snapshot["report"] = state.discovery_store.read_report(project_id)
    snapshot["live"] = state.discovery_running(project_id)
    return snapshot


@router.get("/api/discovery/projects/{project_id}/report")
async def get_report(project_id: str, request: Request) -> dict:
    state = _state(request)
    try:
        project = state.discovery_store.get(project_id)
        markdown = state.discovery_store.read_report(project_id)
    except ProjectNotFound:
        raise _error("发现项目不存在", "discovery_not_found", 404)
    return {
        "project_id": project.id,
        "title": project.title,
        "status": project.status,
        "markdown": markdown,
    }


@router.delete("/api/discovery/projects/{project_id}")
async def delete_project(project_id: str, request: Request) -> dict:
    state = _state(request)
    if state.discovery_running(project_id):
        raise _error("该项目正在运行中，请先停止后再删除", "discovery_running", 409)
    try:
        state.discovery_store.delete(project_id)
    except ProjectNotFound:
        raise _error("发现项目不存在", "discovery_not_found", 404)
    return {"ok": True}


@router.post("/api/discovery/projects/{project_id}/stop")
async def stop_project(project_id: str, request: Request) -> dict:
    state = _state(request)
    stopped = state.stop_discovery(project_id)
    if not stopped:
        return {"ok": False, "message": "该项目当前没有运行中的任务"}
    return {"ok": True}


@router.post("/api/discovery/projects/{project_id}/run")
async def run_project(project_id: str, request: Request) -> StreamingResponse:
    state = _state(request)
    try:
        state.discovery_store.get(project_id)
    except ProjectNotFound:
        raise _error("发现项目不存在", "discovery_not_found", 404)
    if state.discovery_running(project_id):
        raise _error("该项目正在运行中，请先停止或等待完成", "discovery_running", 409)

    queue: asyncio.Queue = asyncio.Queue()
    cancel_event = state.begin_discovery(project_id)

    async def emit(event: AgentEvent) -> None:
        await queue.put(("event", event))

    async def runner() -> None:
        try:
            result = await state.discovery_engine.run(
                project_id,
                emit=emit,
                cancel_event=cancel_event,
                approver=state.approver,
            )
            await queue.put(
                (
                    "event",
                    AgentEvent(
                        type="discovery",
                        data={"kind": "finished", "project_id": project_id, "result": result},
                    ),
                )
            )
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("发现项目运行失败：%s", exc)
            await queue.put(
                (
                    "event",
                    AgentEvent(type="error", data={"message": f"发现项目运行失败：{exc}"}),
                )
            )
        finally:
            state.end_discovery(project_id)
            await queue.put(("end", None))

    task = asyncio.create_task(runner())

    async def stream():
        yield _sse(
            AgentEvent(
                type="connected",
                data={"project_id": project_id, "mode": "discovery"},
            )
        )
        try:
            while True:
                kind, payload = await queue.get()
                if kind == "end":
                    break
                try:
                    if await request.is_disconnected():
                        cancel_event.set()
                        break
                except Exception:
                    pass
                yield _sse(payload)
        finally:
            if not task.done():
                cancel_event.set()
        status = "unknown"
        try:
            status = state.discovery_store.get(project_id).status
        except Exception:
            pass
        yield _sse(AgentEvent(type="done", data={"project_id": project_id, "status": status}))

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


__all__ = ["router"]
