"""Workspace-bound sidebar adapters. Reuse the same backend and write verifier."""
import re
from fastapi import APIRouter, Request, HTTPException
from .routes_platform import platform, body
from .routes_harness import execute_backend

router = APIRouter(tags=["sidebar"])


@router.get("/api/workspaces/{id}/sidebar/files")
async def sidebar_files(request: Request, id: str, query: str = "", path: str = "."):
    if not query.strip() or len(query) > 500:
        raise HTTPException(422, "请输入 1—500 字符的检索词")
    p = platform(request)
    try:
        return await execute_backend(await p.backend(id), "search_files", {"query": query, "path": path})
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)[:500]) from exc


@router.api_route("/api/workspaces/{id}/sidebar/editor", methods=["GET", "POST"])
async def sidebar_editor(request: Request, id: str, path: str = ""):
    p = platform(request)
    try:
        backend = await p.backend(id)
        if request.method == "GET":
            return await execute_backend(backend, "read_file", {"path": path, "limit": 2000})
        payload = await body(request)
        return await execute_backend(backend, "write_file", payload)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)[:500]) from exc


@router.get("/api/workspaces/{id}/sidebar/git")
async def sidebar_git(request: Request, id: str, commit: str = ""):
    p = platform(request)
    if commit and not re.fullmatch(r"[a-f0-9]{7,40}", commit):
        raise HTTPException(422, "提交 ID 无效")
    backend = await p.backend(id)
    commands = ([("detail", f"git --no-pager show --no-ext-diff --no-textconv --stat --format=fuller {commit}")] if commit else [
        ("status", "git --no-optional-locks -c core.quotepath=false status --short"),
        ("graph", "git --no-pager log --all -n 100 --decorate --oneline --graph"),
        ("branches", "git branch --all --no-color"),
    ])
    results = {}
    for key, command in commands:
        result = await backend.shell(command, timeout_s=15)
        if not result.get("ok") or result.get("truncated"):
            raise HTTPException(409, f"Git {key} 未完成：{str(result.get('stderr') or result.get('status') or '非 Git 工作区')[:500]}")
        results[key] = str(result.get("stdout") or "")[:100000]
    return {**results, "workspace_id": id, "read_only": True, "history_limit": 100}
