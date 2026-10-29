"""User-facing context inspection and teams; execution remains in existing services."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Request
from ..suwen.teams import (create_team, team_snapshot, approve_team, send_message, team_mailbox, assign_member,
                           team_task_ids, team_has_active_tasks, ensure_captain_summary)
from .routes_platform import platform, body

router = APIRouter(tags=["workspace-tools"])


@router.get("/api/context/insights")
async def context_insights(request: Request, scope: str = "ws_main", days: int = 7):
    p = platform(request)
    p.require_workspace(scope)
    if days not in {7, 30, 0}:
        raise HTTPException(422, "范围需要为 7、30 或 0（全部）")
    state = request.app.state.omicslab
    summaries = state.store.list()
    conversations = {c["id"]: c for c in summaries if (c.get("workspace_id") or "ws_main") == scope}
    rows = await asyncio.to_thread(state.events.list_run_summaries, 500)
    cutoff = (datetime.now(timezone.utc)-timedelta(days=days)).isoformat() if days else ""
    daily, sessions = {}, {}
    for run in rows:
        if run["session_id"] not in conversations or run["created_at"] < cutoff:
            continue
        day = run["created_at"][:10]
        usage = run.get("usage") or {}
        tokens = sum(int(usage.get(k) or 0) for k in ("prompt_tokens", "completion_tokens"))
        tokens = int(usage.get("total_tokens") or tokens)
        d = daily.setdefault(day, {"day": day, "tokens": 0, "runs": 0})
        d["tokens"] += tokens
        d["runs"] += 1
        s = sessions.setdefault(run["session_id"], {**conversations[run["session_id"]], "tokens": 0, "runs": 0, "failed": 0, "days": []})
        if day not in s["days"]:
            s["days"].append(day)
        s["tokens"] += tokens
        s["runs"] += 1
        s["failed"] += int(run["status"] in {"failed", "interrupted", "unknown"})
    return {"scope": scope, "days": days, "daily": sorted(daily.values(), key=lambda d: d["day"]),
            "sessions": list(sessions.values()), "tokens": sum(d["tokens"] for d in daily.values()),
            "runs": sum(d["runs"] for d in daily.values()), "limited": len(rows) == 500,
            "cost": None, "cache_hit_rate": None, "accounting": "provider-reported run usage; missing usage excluded"}


def conversation(request, cid):
    state = request.app.state.omicslab
    try:
        return state, state.store.get(cid)
    except KeyError as exc:
        raise HTTPException(404, "会话不存在") from exc


@router.get("/api/conversations/{cid}/context")
async def context_inspect(request: Request, cid: str, query: str = ""):
    state, conv = conversation(request, cid)
    categories = {}
    for message in conv.messages:
        categories[message.role] = categories.get(message.role, 0) + len(message.content.encode("utf-8"))
    matches = [{"id": m.id, "role": m.role, "text": m.content[:1200], "ts": m.ts}
               for m in conv.messages if query and query.casefold() in m.content.casefold()][:50]
    runs = state.events.list_runs(session_id=cid, limit=30)
    task_id = next(((r.get("meta") or {}).get("harness_task_id") for r in runs
                    if (r.get("meta") or {}).get("harness_task_id")), None)
    result = {"conversation_id": cid, "task_id": task_id, "composition": categories,
              "estimated": True, "compositionAccounting": "utf8-bytes-upper-bound",
              "message_count": len(conv.messages), "matches": matches,
              "usage": {key: sum(int((r.get("usage") or {}).get(key) or 0) for r in runs)
                        for key in ("prompt_tokens", "completion_tokens", "total_tokens")}}
    adapter = getattr(state.loop, "desktop_harness", None)
    if adapter and task_id:
        try:
            result["harness"] = await adapter.rpc("contextInspect", id=task_id)
        except Exception:
            result["harness_error"] = "Harness 上下文暂不可读；会话原文保留"
    result["runs"] = [{key: r.get(key) for key in ("run_id", "trace_id", "status", "created_at", "started_at", "ended_at", "usage", "parent_run_id")} for r in runs]
    if hasattr(state.events, "list_events"):
        result["events"] = [e for r in runs[:5] for e in state.events.list_events(r["trace_id"], limit=200)
                            if e["type"] not in {"assistant_delta", "reasoning_delta", "heartbeat"}][-300:]
    return result


@router.post("/api/conversations/{cid}/context/{action}")
async def context_action(request: Request, cid: str, action: str):
    state, conv = conversation(request, cid)
    payload = await body(request)
    allowed = {r.get("meta", {}).get("harness_task_id")
               for r in state.events.list_runs(session_id=cid, limit=500)}
    task_id = payload.get("task_id")
    if task_id not in allowed or not task_id:
        raise HTTPException(404, "上下文不属于当前会话")
    adapter = getattr(state.loop, "desktop_harness", None)
    methods = {"compact": "contextCompact", "restore": "contextRestore", "source": "contextSource",
               "requests": "contextRequests", "request": "contextRequest", "search": "contextSearch"}
    if not adapter or action not in methods:
        raise HTTPException(400, "上下文操作不可用")
    try:
        return await adapter.rpc(methods[action], id=task_id,
                                 **{key: payload[key] for key in ("version", "source", "sequence", "offset", "query") if key in payload})
    except (RuntimeError, asyncio.TimeoutError) as exc:
        raise HTTPException(409, str(exc)[:300]) from exc


@router.get("/api/teams")
async def teams_list(request: Request, scope: str = "ws_main", archived: bool = False, captain_session: str | None = None):
    p = platform(request)
    p.require_workspace(scope)
    if captain_session:
        _captain_scope(p, captain_session, scope)
    return {"items": [team_snapshot(p, scope, t) for t in p.store.list("team", scope)
                      if bool(t.get("archived")) == archived and (not captain_session or t.get("captain_session") == captain_session)]}


def _captain_scope(p, cid, scope=None):
    try:
        conv = p.state.store.get(cid)
    except KeyError as exc:
        raise HTTPException(404, "会话不存在") from exc
    bound = conv.meta.get("workspace_id") or "ws_main"
    if conv.meta.get("team_member") or (scope and bound != scope):
        raise HTTPException(403, "此会话不是当前工作区的队长")
    p.require_workspace(bound)
    return bound


def _conversation_members(p, cid, scope):
    items = []
    for team in p.store.list("team", scope):
        if team.get("captain_session") != cid or team.get("archived") or team.get("draft"):
            continue
        for member in team_snapshot(p, scope, team)["members"]:
            task = member["task"] or {}
            session = task.get("nodes", {}).get("work", {}).get("session_id")
            items.append({"id": member["id"], "member_id": member["id"], "team_id": team["id"],
                          "captain_session": cid, "scope": scope, "workspace_id": scope,
                          "name": member.get("name") or member["id"], "goal": member["goal"],
                          "task_id": member.get("task_id"), "conversation_id": session, "session_id": session,
                          "status": task.get("status", "missing"), "provider": member.get("provider"),
                          "model": member.get("model"), "permission_mode": member.get("permission_mode", "full")})
    return items


@router.get("/api/conversations/{cid}/members")
async def conversation_members(request: Request, cid: str, scope: str | None = None):
    p = platform(request)
    scope = _captain_scope(p, cid, scope)
    return {"captain_session": cid, "scope": scope, "items": _conversation_members(p, cid, scope)}


@router.post("/api/conversations/{cid}/members/{member_id}/messages")
async def conversation_member_message(request: Request, cid: str, member_id: str, scope: str | None = None):
    p = platform(request)
    scope = _captain_scope(p, cid, scope)
    payload = await body(request)
    matches = [m for m in _conversation_members(p, cid, scope) if m["member_id"] == member_id
               and (not payload.get("team_id") or m["team_id"] == payload["team_id"])]
    if not matches:
        raise HTTPException(404, "此会话没有该成员")
    if len(matches) != 1:
        raise HTTPException(409, "请提供 team_id 区分同名成员")
    member = matches[0]
    key = payload.get("client_request_id")
    if key is not None and (not isinstance(key, str) or not key.strip() or len(key) > 200):
        raise HTTPException(422, "client_request_id 无效")
    try:
        message = await send_message(p, scope, member["team_id"], "user", member_id, payload.get("content"),
                                     wake=True, source_key=f"member-chat:{cid}:{member_id}:{key}" if key else None)
        current = next(m for m in _conversation_members(p, cid, scope)
                       if m["team_id"] == member["team_id"] and m["member_id"] == member_id)
        return {"message": message, "member": current, "conversation_id": current["conversation_id"], "team_id": current["team_id"]}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/api/teams")
async def teams_create(request: Request, scope: str = "ws_main"):
    p = platform(request)
    payload = await body(request)
    try:
        captain = payload.get("captain_session")
        if captain:
            conv = p.state.store.get(captain)
            if (conv.meta.get("workspace_id") or "ws_main") != scope:
                raise ValueError("队长会话不属于当前工作区")
        return create_team(p, scope, {**payload, "draft": True})
    except (ValueError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/api/teams/{id}/{action}")
async def teams_control(request: Request, id: str, action: str, scope: str = "ws_main"):
    p = platform(request)
    p.require_workspace(scope)
    team = p.store.get("team", id, scope)
    if not team:
        raise HTTPException(404, "团队不存在")
    payload = await body(request)
    if action in {"approve", "archive", "message", "assign", "messages"}:
        try:
            if action == "approve":
                return approve_team(p, scope, id)
            if action == "message":
                return await send_message(p, scope, id, "user", payload.get("recipient"), payload.get("content"), wake=payload.get("wake") is True)
            if action == "messages":
                return {"items": team_mailbox(p, scope, id)}
            if action == "assign":
                return await assign_member(p, scope, id, payload.get("member_id"), payload.get("goal"), confirmed=payload.get("confirmed") is True)
            if team_has_active_tasks(p, scope, team):
                raise ValueError("请先取消活动任务，再归档团队；归档保留所有执行记录")
            return p.store.put("team", id, {**team, "archived": True}, scope, expected=team["revision"])
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
    if action not in {"pause", "resume", "cancel"}:
        raise HTTPException(400, "未知团队操作")
    if team.get("archived"):
        raise HTTPException(409, "已归档团队不能更改执行状态")
    with p.store.lock:
        team = p.store.get("team", id, scope)
        team = p.store.put("team", id, {**team, "control_status": None if action == "resume" else
                                       "paused" if action == "pause" else "cancelled"}, scope, expected=team["revision"])
    errors = []
    stopping = []
    for task_id in team_task_ids(team):
        task = p.store.get("task", task_id, scope)
        if not task:
            errors.append("团队任务不存在")
            continue
        eligible = (task["status"] in {"paused", "interrupted", "failed", "budget_limited", "needs_review", "waiting_approval"}
                    if action == "resume" else task["status"] not in {"succeeded", "cancelled", "failed"})
        if not eligible:
            continue
        try:
            worker = p.tasks.active.get(task_id)
            handles = getattr(getattr(p.state, "runs", None), "_handles", {})
            runs = [handle.task for node in task.get("nodes", {}).values()
                    if (handle := handles.get(node.get("run_id"))) and handle.task]
            await p.tasks.control(task["id"], scope, action, payload.get("confirmed", False))
            if action in {"pause", "cancel"}:
                stopping.extend(([worker] if worker else []) + runs)
        except ValueError as exc:
            errors.append(str(exc))
    if stopping:
        await asyncio.gather(*stopping, return_exceptions=True)
    if action == "resume":
        ensure_captain_summary(p, scope, id)
    return {**team_snapshot(p, scope, p.store.get("team", id, scope)), "errors": errors}
