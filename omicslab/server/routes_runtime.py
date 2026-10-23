"""Runtime observability, agent task tree, diagnostics and runtime config."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..runtime.events import RunNotFound, TaskNotFound

router = APIRouter(tags=["runtime"])


def _state(request: Request) -> Any:
    return request.app.state.omicslab


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _error(message: str, code: str, status: int = 400, **extra: Any) -> HTTPException:
    detail: dict[str, Any] = {"message": message, "code": code}
    detail.update(extra)
    return HTTPException(status_code=status, detail={"error": detail})


@router.get("/api/runtime/timeline/{trace_id}")
async def get_timeline(request: Request, trace_id: str, after_seq: int = 0, limit: int = 500) -> dict[str, Any]:
    state = _state(request)
    return state.runs.timeline(trace_id, after_seq=max(0, after_seq), limit=max(1, min(limit, 2000)))


@router.get("/api/runtime/runs")
async def list_runs(
    request: Request,
    session_id: str | None = None,
    status: str | None = None,
    parent_run_id: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    state = _state(request)
    runs = state.events.list_runs(
        session_id=session_id,
        status=status,
        parent_run_id=parent_run_id,
        limit=max(1, min(limit, 500)),
    )
    return {"runs": runs}


@router.get("/api/runtime/runs/{run_id}/children")
async def run_children(request: Request, run_id: str) -> dict[str, Any]:
    state = _state(request)
    children = state.events.list_agent_tasks(parent_run_id=run_id, limit=500)
    return {"run_id": run_id, "children": children}


@router.get("/api/runtime/agent-tasks/{task_id}")
async def agent_task(request: Request, task_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.runs.agent_task(task_id)
    except TaskNotFound:
        raise _error("子任务不存在", "task_not_found", 404)


@router.get("/api/runtime/agent-tasks/{task_id}/runs")
async def agent_task_runs(request: Request, task_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        task = state.events.get_agent_task(task_id)
    except TaskNotFound:
        task = None
    if task is None:
        raise _error("子任务不存在", "task_not_found", 404)
    return {"task": task, "runs": task.get("runs") or []}


@router.get("/api/runtime/diagnostics")
async def diagnostics(request: Request) -> dict[str, Any]:
    state = _state(request)
    return state.diagnostics()


@router.get("/api/runtime/config")
async def get_runtime_config(request: Request) -> dict[str, Any]:
    state = _state(request)
    settings = state.settings
    return {
        "approval_policy": getattr(state.approver, "policy", settings.approval_policy),
        "max_parallel_runs": int(getattr(settings, "max_parallel_runs", 8) or 8),
        "max_child_tasks": int(getattr(settings, "max_child_tasks", 4) or 4),
        "max_child_depth": int(getattr(settings, "max_child_depth", 2) or 2),
        "max_workspace_scopes": int(getattr(settings, "max_workspace_scopes", 4) or 4),
        "default_agent": state.default_agent_info(),
    }


@router.put("/api/runtime/config")
async def update_runtime_config(request: Request) -> dict[str, Any]:
    state = _state(request)
    body = await _json(request)
    patch = body.get("patch") if isinstance(body.get("patch"), dict) else body
    allowed = {
        "approval_policy",
        "max_parallel_runs",
        "max_child_tasks",
        "max_child_depth",
        "max_workspace_scopes",
        "default_agent",
    }
    clean = {key: value for key, value in (patch or {}).items() if key in allowed}
    if not clean:
        raise _error("没有可更新的运行配置字段", "invalid_patch")
    try:
        state.settings.update(clean)
        state.settings.save()
    except Exception as exc:
        raise _error(f"配置无效：{exc}", "invalid_config")
    state.rebuild_approver()
    return await get_runtime_config(request)


@router.get("/api/agents/default")
async def default_agent(request: Request) -> dict[str, Any]:
    state = _state(request)
    info = state.default_agent_info()
    agent = state.agents.get(info["agent_id"])
    info["agent"] = agent.to_dict() if hasattr(agent, "to_dict") else None
    return info
