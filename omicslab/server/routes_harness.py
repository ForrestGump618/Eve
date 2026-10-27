"""Authenticated adapter: the desktop loop reuses the selected Python backend.

The run handle, not model arguments, owns workspace, backend and permissions.
There is deliberately no local fallback and no arbitrary URL/process routing.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import posixpath
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from ..agent.permissions import needs_approval

router = APIRouter(tags=["harness"])


async def authorize(state: Any, handle: Any, tool: str, arguments: dict[str, Any]) -> None:
    ask, reason = needs_approval(handle.permission_mode, tool, arguments)
    await state.runs._emit(handle, "permission_decision", {
        "tool": tool, "mode": handle.permission_mode, "decision": "ask" if ask else "allow",
        "reason": reason, "workspace_id": handle.workspace.workspace_id,
    })
    if not ask:
        return
    if state.runs.approver is None:
        raise HTTPException(403, "审批通道不可用，未执行操作")
    ctx = SimpleNamespace(
        run_id=handle.run_id, conversation_id=handle.session_id,
        backend=handle.backend, workspace_ctx=handle.workspace,
        workspace=getattr(handle.backend, "root", ""),
        connection_id=getattr(handle.backend, "profile_id", ""),
        cancel_event=handle.cancel_event,
        emit=lambda event: state.runs._on_loop_event(handle, event),
    )
    if not await state.runs.approver.request(ctx, tool, arguments, reason, force_ask=True):
        raise HTTPException(403, "操作未获批准或审批已取消/过期；未执行")


async def execute_backend(backend: Any, operation: str, args: dict[str, Any]) -> dict[str, Any]:
    path = str(args.get("path") or ".")
    if operation == "list_directory":
        result = await backend.list_dir(path)
        entries = result.get("entries", [])
        offset = max(0, int(args.get("offset") or 0))
        return {**result, "entries": entries[offset:offset+200], "total": len(entries),
                "nextOffset": offset+200 if offset+200 < len(entries) else None}
    if operation == "read_file":
        result = await backend.read_text(path, max_bytes=2_000_000)
        content = str(result.get("content", result.get("text", "")) or "")
        if "\0" in content or result.get("truncated") or result.get("binary"):
            raise ValueError("文件不是完整文本，不能作为覆盖依据")
        lines = content.splitlines(keepends=True)
        start = max(1, int(args.get("startLine") or 1))
        limit = max(1, min(2000, int(args.get("limit") or 400)))
        selected = "".join(lines[start-1:start-1+limit])
        clipped = len(selected) > 28000
        return {**result, "content": selected[:28000],
                "sha256": hashlib.sha256(content.encode()).hexdigest(), "totalLines": len(lines),
                "startLine": start, "truncated": clipped or start-1+limit < len(lines),
                "nextStartLine": start+limit if not clipped and start-1+limit < len(lines) else None}
    if operation == "write_file":
        content = args.get("content")
        if not isinstance(content, str) or len(content) > 200_000:
            raise ValueError("文件内容无效或超过上限")
        # Distinguish missing files from transport failures. Never treat a failed
        # read on a disconnected host as permission to overwrite an unseen file.
        listing = await backend.list_dir(str(posixpath.dirname(path.replace('\\', '/')) or '.'))
        name = path.replace('\\', '/').rsplit('/', 1)[-1]
        exists = any(e.get("name") == name for e in listing.get("entries", []))
        if exists:
            old = await backend.read_text(path, max_bytes=2_000_000)
            actual = hashlib.sha256(str(old.get("content", old.get("text", "")) or "").encode()).hexdigest()
            if old.get("truncated") or actual != args.get("expectedSha256"):
                raise ValueError("文件已变化；请重新读取并提供匹配的 expectedSha256")
        elif args.get("expectedSha256"):
            raise ValueError("预期文件不存在")
        result = await backend.write_text(path, content)
        confirmed = await backend.read_text(path, max_bytes=2_000_000)
        sha = hashlib.sha256(content.encode()).hexdigest()
        if confirmed.get("content", confirmed.get("text")) != content:
            raise ValueError("写入后读取验证失败，不能标记成功")
        return {**result, "sha256": sha, "verified": True, "created": not exists}
    if operation == "search_files":
        query = str(args.get("query") or "").casefold()
        if not query:
            raise ValueError("检索词不能为空")
        queue, matches, visited = [path], [], 0
        skipped = 0
        while queue and visited < 600 and len(matches) < 80:
            current = queue.pop(0)
            result = await backend.list_dir(current)
            for entry in result.get("entries", []):
                if visited >= 600 or len(matches) >= 80:
                    break
                visited += 1
                name = str(entry.get("name") or "")
                if name in {".git", "node_modules", ".venv", "__pycache__"} or entry.get("is_symlink"):
                    continue
                child = str(entry.get("path") or entry.get("rel") or (current.rstrip('/')+'/'+name))
                if entry.get("is_dir"):
                    queue.append(child)
                    continue
                if int(entry.get("size") or 0) > 1_000_000:
                    skipped += 1
                    continue
                try:
                    text = await backend.read_text(child, max_bytes=1_000_000)
                except Exception:
                    # Do not hide transport failure as a successful empty search.
                    raise
                content = str(text.get("content", text.get("text", "")) or "")
                if "\0" in content:
                    skipped += 1
                    continue
                for line, value in enumerate(content.splitlines(), 1):
                    if query in value.casefold():
                        matches.append({"path": child, "line": line, "text": value[:400]})
                        if len(matches) >= 80:
                            break
        return {"matches": matches, "visited": visited, "skipped": skipped,
                "limited": bool(queue) or visited >= 600 or len(matches) >= 80}
    if operation == "run_shell":
        result = await backend.shell(str(args.get("command") or ""), cwd=str(args.get("cwd") or ""),
                                     timeout_s=min(120, max(1, float(args.get("timeoutSeconds") or 60))))
        if not result.get("ok") or result.get("timed_out"):
            raise ValueError(f"命令未成功：{str(result)[:2500]}")
        return result
    if operation == "run_skill":
        from ..execution.skill_runner import runner_source
        result = await backend.execute_python(runner_source(args), timeout_s=135)
        if not result.get("ok"):
            raise ValueError(f"远程技能执行失败：{str(result)[:2500]}")
        try:
            output = json.loads(result.get("stdout") or "")
        except (ValueError, TypeError) as exc:
            raise ValueError("远程技能未返回有效结构化结果") from exc
        if output.get("exitCode") != 0 or output.get("timedOut") or output.get("truncated"):
            raise ValueError(f"远程技能未成功：{str(output)[:2500]}")
        return output
    raise ValueError("不支持的工作区操作")


@router.post("/api/harness/runs/{run_id}/tool")
async def harness_tool(request: Request, run_id: str) -> dict[str, Any]:
    token = getattr(request.app.state, "harness_token", "")
    if not token or not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
        raise HTTPException(403, "仅桌面运行时可以访问执行适配器")
    state = request.app.state.omicslab
    handle = state.runs._handles.get(run_id)
    if handle is None or handle.cancel_event.is_set() or handle.status not in {"running", "waiting_approval"}:
        raise HTTPException(409, "任务已停止或执行上下文不可恢复；禁止回退本地执行")
    body = await request.json()
    operation, args = body.get("operation"), body.get("arguments")
    if not isinstance(operation, str) or not isinstance(args, dict):
        raise HTTPException(400, "无效工具请求")
    async def perform():
        if operation == "authorize":
            await authorize(state, handle, str(args.get("tool") or ""), args.get("arguments") or {})
            return {"approved": True, "mode": handle.permission_mode}
        if handle.backend is None:
            raise HTTPException(503, "执行后端不可用；禁止回退本地执行")
        if operation in {"research_list", "research_create", "research_record"}:
            service = state.platform.research
            scope = handle.workspace.workspace_id
            if operation == "research_list":
                return {"items": service.agent_list(scope)}
            await authorize(state, handle, operation, args)
            try:
                if operation == "research_create":
                    return service.create(scope, args)
                if args.get("stage") == "finalize" or args.get("human_approved"):
                    raise ValueError("模型不能代替用户复核结题")
                return await service.record(scope, str(args.get("id") or ""), args, run_id=run_id)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        if operation in {"write_file", "run_shell", "run_skill"}:
            await authorize(state, handle, "skill_run" if operation == "run_skill" else operation, args)
        try:
            result = await execute_backend(handle.backend, operation, args)
            return {**result, "execution_target": {"kind": handle.workspace.backend,
                    "workspace_id": handle.workspace.workspace_id, "root": str(handle.backend.root)}}
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(422, str(exc)[:3000]) from exc
    task = asyncio.create_task(perform())
    cancelled = asyncio.create_task(handle.cancel_event.wait())
    try:
        # Task cancellation is explicit and scoped. Losing an HTTP observer must
        # not cancel workspace work (the same rule as the chat SSE transport).
        done, _ = await asyncio.wait({task, cancelled}, return_when=asyncio.FIRST_COMPLETED)
        if cancelled in done:
            raise HTTPException(409, "任务已取消；操作结果需核对")
        return await task
    finally:
        cancelled.cancel()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, cancelled, return_exceptions=True)
