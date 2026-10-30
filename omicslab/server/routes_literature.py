"""Literature radar API: search, ingestion, feed and proactive review."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from omicslab.suwen.literature import SOURCE_LABELS

router = APIRouter(prefix="/api/literature", tags=["Literature"])


def _platform(request: Request):
    return request.app.state.omicslab.platform


def _guarded(call):
    try:
        return call()
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def _json(request: Request) -> dict[str, Any]:
    try:
        value = await request.json()
    except Exception as exc:
        raise HTTPException(400, "请求需要 JSON 对象") from exc
    if not isinstance(value, dict):
        raise HTTPException(400, "请求需要 JSON 对象")
    return value


def _bounded_number(
    data: dict[str, Any],
    key: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
    integer: bool = False,
) -> float | int:
    raw = data.get(key, default)
    if isinstance(raw, bool):
        raise HTTPException(422, f"{key} 需要数值")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, f"{key} 需要数值") from exc
    if not minimum <= value <= maximum:
        raise HTTPException(422, f"{key} 必须在 {minimum}—{maximum} 之间")
    return int(value) if integer else value


@router.post("/search")
async def search(request: Request, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    query = str(data.get("query") or "").strip()
    sources = data.get("sources")
    if sources is not None and (
        not isinstance(sources, list)
        or any(not isinstance(item, str) for item in sources)
    ):
        raise HTTPException(422, "sources 需要来源名称数组")
    if sources is not None:
        unknown = sorted(set(sources) - set(SOURCE_LABELS))
        if unknown:
            raise HTTPException(422, "未知文献来源：" + ",".join(unknown))
    action = lambda: p.literature.search(
            scope,
            query,
            sources=sources,
            date_from=str(data.get("date_from") or ""),
            date_to=str(data.get("date_to") or ""),
            limit=_bounded_number(
                data,
                "limit",
                8,
                minimum=1,
                maximum=200,
                integer=True,
            ),
            type_filter=str(data.get("type_filter") or "all"),
            min_interestingness=_bounded_number(
                data,
                "min_interestingness",
                0,
                minimum=0,
                maximum=1,
            ),
            cross_discipline_weight=(
                _bounded_number(
                    data,
                    "cross_discipline_weight",
                    0,
                    minimum=0,
                    maximum=1,
                )
                if data.get("cross_discipline_weight") is not None
                else None
            ),
            ground_novelty=data.get("ground_novelty") is not False,
        )
    if data.get('background') is True:
        return p.literature.dispatch(scope, 'search', action)
    return await _guarded_async(action())


async def _guarded_async(awaitable):
    try:
        return await awaitable
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/ingest")
async def ingest(request: Request, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    content_type = (request.headers.get("content-type") or "").lower()
    if content_type.startswith("multipart/form-data"):
        settings = p.literature.settings(scope)
        maximum = int(settings.get("max_upload_mb", 10)) * 1_000_000
        try:
            length = int(request.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length and length > maximum + 1_000_000:
            raise HTTPException(413, "文献文件超过大小限制")
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(422, "没有收到 PDF 文件")
        data = await upload.read()
        if len(data) > maximum:
            raise HTTPException(413, "文献文件超过大小限制")
        name = str(form.get("name") or getattr(upload, "filename", "") or "uploaded-paper.pdf")
        return await _guarded_async(
            p.literature.ingest(scope, name=name, data=data)
        )
    body = await _json(request)
    reference = str(
        body.get("reference")
        or body.get("title")
        or body.get("url")
        or body.get("doi")
        or body.get("pmid")
        or ""
    ).strip()
    if reference:
        return await _guarded_async(
            p.literature.ingest_reference(
                scope,
                reference,
                name=str(body.get("name") or ""),
            )
        )
    return await _guarded_async(
        p.literature.ingest(
            scope,
            name=str(body.get("name") or ""),
            path=str(body.get("path") or ""),
        )
    )


@router.get("/status")
async def status(request: Request, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    return _guarded(lambda: p.literature.status(scope))


@router.post("/run")
async def run(request: Request, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    if data.get('background') is True:
        if not p.literature.settings(scope).get('daily_enabled'):
            raise HTTPException(422, '每日文献循环已关闭')
        return p.literature.dispatch(scope, 'daily', lambda: p.literature.run(scope,
            trigger=str(data.get('trigger') or 'manual'), force=data.get('force') is True))
    return await _guarded_async(
        p.literature.run(
            scope,
            trigger=str(data.get("trigger") or "manual"),
            force=data.get("force") is True,
        )
    )


@router.get("/reflections")
async def reflections(
    request: Request,
    scope: str = "ws_main",
    status: str = "pending",
    limit: int = 30,
):
    p = _platform(request)
    p.require_workspace(scope)
    if status not in {"pending", "all", "accepted", "rejected", "stale"}:
        raise HTTPException(422, "反思状态无效")
    rows = p.store.list(
        "literature_reflection",
        scope,
        limit=min(int(p.literature.settings(scope).get("scan_limit", 1_000)), max(1, int(limit))),
    )
    if status != "all":
        rows = [row for row in rows if row.get("status") == status]
    return {"items": rows}


@router.get("/feed")
async def feed(
    request: Request,
    scope: str = "ws_main",
    limit: int = 30,
):
    p = _platform(request)
    p.require_workspace(scope)
    return _guarded(lambda: p.literature.feed(scope, limit))


@router.post("/feed/{feed_id}/comments")
async def comment(request: Request, feed_id: str, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    return await _guarded_async(
        p.literature.comment(scope, feed_id, str(data.get("text") or ""))
    )


@router.post("/feedback")
async def feedback(request: Request, scope: str = "ws_main"):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    rating = _bounded_number(
        data,
        "rating",
        0,
        minimum=-1,
        maximum=1,
        integer=True,
    )
    return _guarded(
        lambda: p.literature.feedback(
            scope,
            paper_id=str(data.get("paper_id") or ""),
            rating=int(rating),
            note=str(data.get("note") or ""),
            action=str(data.get("action") or "rate"),
        )
    )


@router.get("/proactive")
async def proactive(
    request: Request,
    scope: str = "ws_main",
    include_silent: bool = False,
):
    p = _platform(request)
    p.require_workspace(scope)
    return _guarded(lambda: p.literature.proactive(scope, include_silent))


@router.post("/proactive/{message_id}/send")
async def proactive_send(
    request: Request,
    message_id: str,
    scope: str = "ws_main",
):
    p = _platform(request)
    p.require_workspace(scope)
    return _guarded(lambda: p.literature.send_proactive(scope, message_id))


@router.post("/proactive/{message_id}/dismiss")
async def proactive_dismiss(
    request: Request,
    message_id: str,
    scope: str = "ws_main",
):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    return _guarded(
        lambda: p.literature.dismiss_proactive(
            scope,
            message_id,
            str(data.get("reason") or ""),
        )
    )


@router.post("/proactive/{message_id}/reply")
async def proactive_reply(
    request: Request,
    message_id: str,
    scope: str = "ws_main",
):
    p = _platform(request)
    p.require_workspace(scope)
    data = await _json(request)
    return await _guarded_async(
        p.literature.reply_proactive(
            scope,
            message_id,
            str(data.get("text") or ""),
        )
    )


__all__ = ["router"]
