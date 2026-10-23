"""Function registry REST endpoints."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request

from ..registry.index import RegistryError, RegistryIndex

logger = logging.getLogger("omicslab.server.registry")

router = APIRouter(tags=["registry"])


def _state(request: Request) -> object:
    return request.app.state.omicslab


def _index(request: Request) -> RegistryIndex:
    state = _state(request)
    index = getattr(state, "registry_index", None)
    if isinstance(index, RegistryIndex):
        return index
    return RegistryIndex(state.settings)


def _error(message: str, code: str, status: int = 400, detail: str = "") -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code, "detail": detail})


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


@router.get("/api/registry/search")
async def registry_search(request: Request, q: str = "", limit: int = 10) -> dict:
    index = _index(request)
    try:
        limit = max(1, min(int(limit), 50))
    except (TypeError, ValueError):
        limit = 10
    ready = index.exists()
    items = index.search(q, limit=limit) if ready else []
    return {"items": items, "query": q, "ready": ready, "stats": index.stats()}


@router.get("/api/registry/modules")
async def registry_modules(request: Request) -> dict:
    index = _index(request)
    return {"modules": index.modules(), "ready": index.exists(), "stats": index.stats()}


@router.get("/api/registry/function")
async def registry_function(request: Request, name: str = "") -> dict:
    index = _index(request)
    item = index.get(name)
    if item is None:
        raise _error(f"索引中没有函数 {name!r}（可先刷新索引）", "registry_missing", 404)
    return {"item": item, "ready": True}


@router.post("/api/registry/refresh")
async def registry_refresh(request: Request) -> dict:
    body = await _json(request)
    packages = body.get("packages")
    if packages is not None and not isinstance(packages, list):
        raise _error("packages 必须是字符串数组", "invalid_packages")
    index = _index(request)
    try:
        stats = await asyncio.wait_for(
            asyncio.to_thread(index.refresh, packages), timeout=300
        )
    except RegistryError as exc:
        raise _error(str(exc), "registry_failed", 500)
    except asyncio.TimeoutError:
        raise _error("函数索引构建超时（>300s），请减少扫描包数量后重试", "registry_timeout", 504)
    return {"ok": True, "stats": stats, "modules": index.modules()}
