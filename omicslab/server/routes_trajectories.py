"""Trajectory REST endpoints (turn replay / audit)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..trajectories import delete_trajectory, list_trajectories, load_trajectory

router = APIRouter(tags=["trajectories"])


def _state(request: Request) -> object:
    return request.app.state.omicslab


def _error(message: str, code: str, status: int = 404) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code, "detail": ""})


@router.get("/api/trajectories")
async def trajectories_list(request: Request, conversation_id: str = "") -> dict:
    state = _state(request)
    items = list_trajectories(state.settings, conversation_id)
    return {"items": items, "count": len(items)}


@router.get("/api/trajectories/{conversation_id}/{turn_id}")
async def trajectory_read(request: Request, conversation_id: str, turn_id: str) -> dict:
    state = _state(request)
    payload = load_trajectory(state.settings, conversation_id, turn_id)
    if payload is None:
        raise _error(f"未找到轨迹 {turn_id!r}", "trajectory_missing")
    return payload


@router.delete("/api/trajectories/{conversation_id}/{turn_id}")
async def trajectory_delete(request: Request, conversation_id: str, turn_id: str) -> dict:
    state = _state(request)
    removed = delete_trajectory(state.settings, conversation_id, turn_id)
    if not removed:
        raise _error(f"未找到轨迹 {turn_id!r}", "trajectory_missing")
    return {"ok": True, "deleted": turn_id}
