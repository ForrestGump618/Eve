"""Workspace registry, per-workspace kernels and workspace-scoped files.

A workspace is the isolation unit: each conversation binds to one workspace and
each workspace scope owns its own kernel (never the shared global kernel).
"""

from __future__ import annotations

import asyncio
from urllib.parse import quote
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..workspace import WorkspaceError
from . import files as fileops

router = APIRouter(tags=["workspaces"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024


def _state(request: Request) -> Any:
    return request.app.state.omicslab


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _error(message: str, code: str, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"message": message, "code": code}})


def _workspace(state: Any, workspace_id: str) -> Any:
    if state.workspaces is None:
        raise _error("工作区服务不可用", "workspaces_unavailable", 500)
    workspace = state.workspaces.get(workspace_id)
    if workspace is None:
        raise _error(f"工作区不存在：{workspace_id}", "workspace_not_found", 404)
    return workspace


def _local_root(workspace: Any) -> Path:
    if getattr(workspace, "backend", "local") != "local":
        raise _error("该工作区不是本地目录，本地文件接口不可用（请使用 SSH 接口）", "workspace_not_local")
    root = workspace.root
    if root is None:
        raise _error("工作区目录不可用", "workspace_root_missing", 500)
    return root


async def _remote_call(state, workspace, method, *args, **kwargs):
    from ..execution.ssh_backend import SSHExecutionBackend
    from ..execution.base import BackendError, BackendUnavailable
    backend = SSHExecutionBackend(workspace, settings=state.settings)
    try:
        await backend.start()
        return await getattr(backend, method)(*args, **kwargs)
    except BackendUnavailable as exc:
        raise _error(str(exc), "remote_unavailable", 503)
    except BackendError as exc:
        raise _error(str(exc), "remote_operation_failed")
    finally:
        await backend.close()


# -- registry --------------------------------------------------------------
@router.get("/api/workspaces")
async def list_workspaces(request: Request) -> dict[str, Any]:
    state = _state(request)
    if state.workspaces is None:
        return {"workspaces": [], "default_id": None, "limit": 0, "kernels": {}}
    items = state.workspaces_public()
    default = state.workspaces.default()
    return {
        "workspaces": items,
        "default_id": default.workspace_id,
        "limit": int(getattr(state.settings, "max_workspace_scopes", 4) or 4),
        "kernels": state.kernel_status_all(),
    }


@router.post("/api/workspaces")
async def create_workspace(request: Request) -> dict[str, Any]:
    state = _state(request)
    body = await _json(request)
    remote = body.get("remote") if isinstance(body.get("remote"), dict) else {}
    if body.get("backend") == "ssh":
        from ..ssh.connections import get_connection_service
        service = get_connection_service(state.settings)
        try:
            profile_id = str(remote.get("profile_id") or "")
            profile = service.get_profile(profile_id)
            info = await asyncio.to_thread(service.probe, profile_id, str(remote.get("root") or "~"))
        except Exception as exc:
            raise _error(str(exc), "remote_unavailable", 503)
        if not (info.get("ok") and info.get("exists") and info.get("is_dir")):
            raise _error("远程目录不可用，请检查连接及路径", "remote_root_invalid")
        remote = {"profile_id": profile_id, "root": info["path"],
                  "host": profile.get("host", ""), "username": profile.get("username", "")}
    try:
        workspace = state.workspaces.create(
            str(body.get("name") or ""),
            local_path=str(body.get("local_path") or ""),
            backend=str(body.get("backend") or "local"),
            remote=remote,
        )
    except WorkspaceError as exc:
        raise _error(str(exc), "workspace_invalid")
    except Exception as exc:
        raise _error(f"创建工作区失败：{exc}", "workspace_create_failed", 500)
    return {"workspace": state.workspaces.public(workspace)}


@router.get("/api/workspaces/{workspace_id}")
async def get_workspace(request: Request, workspace_id: str) -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    scope = workspace.scope
    kernel_status = state.kernel_status_all().get(scope)
    return {
        "workspace": state.workspaces.public(workspace),
        "kernel": kernel_status,
        "runs": [
            {"run_id": handle.run_id, "status": handle.status, "session_id": handle.session_id}
            for handle in (state.runs.active_runs_in_scope(scope) if state.runs else [])
        ],
    }


@router.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(request: Request, workspace_id: str) -> dict[str, Any]:
    state = _state(request)
    try:
        workspace = state.workspaces.delete(workspace_id)
    except WorkspaceError as exc:
        raise _error(str(exc), "workspace_delete_refused")
    scope = workspace.scope
    if scope in state.kernels:
        await state.stop_kernel(scope)
        state.kernels.pop(scope, None)
    return {"ok": True, "workspace_id": workspace_id}


@router.post("/api/workspaces/{workspace_id}/probe")
async def probe_workspace(request: Request, workspace_id: str) -> dict[str, Any]:
    """Lightweight readiness probe (local path writable / SSH reachability)."""
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if getattr(workspace, "backend", "local") == "local":
        root = _local_root(workspace)
        writable = False
        try:
            import tempfile

            with tempfile.NamedTemporaryFile(dir=str(root), prefix=".omicslab-probe-", delete=True):
                writable = True
        except Exception:
            writable = False
        entries = 0
        try:
            entries = len(list(root.iterdir()))
        except Exception:
            entries = 0
        return {
            "workspace_id": workspace_id,
            "backend": "local",
            "ok": bool(root.exists() and writable),
            "exists": root.exists(),
            "writable": writable,
            "entries": entries,
            "path": str(root),
            "kernel": state.kernel_status_all().get(workspace.scope),
        }
    # SSH: try the connection service, never assume reachability.
    remote = dict(getattr(workspace, "remote", {}) or {})
    result: dict[str, Any] = {
        "workspace_id": workspace_id,
        "backend": "ssh",
        "ok": False,
        "remote": remote,
        "detail": "SSH 工作区探测需要连接服务",
    }
    try:
        from ..ssh.connections import get_connection_service

        service = get_connection_service(state.settings)
        profile_id = remote.get("profile_id")
        if profile_id:
            info = await __import__("asyncio").to_thread(service.probe, profile_id, str(remote.get("root") or "~"))
            result.update({"ok": bool(info.get("ok") and info.get("exists") and info.get("is_dir")),
                           "path": info.get("path"), "entries": len(info.get("entries") or []), "detail": info})
    except Exception as exc:
        result["detail"] = f"SSH 探测不可用：{exc}"
    return result


# -- kernels ---------------------------------------------------------------
def _normalize_scope(state: Any, scope: str) -> str:
    """Accept either ``main``, ``ws:<id>`` or a bare workspace id as a kernel scope."""
    scope = (scope or "").strip()
    if scope == "main" or scope.startswith("ws:"):
        return scope
    if state.workspaces is not None:
        workspace = state.workspaces.get(scope)
        if workspace is not None:
            return workspace.scope
    return scope


@router.get("/api/kernels")
async def list_kernels(request: Request) -> dict[str, Any]:
    state = _state(request)
    return {"kernels": state.kernel_status_all()}


@router.post("/api/kernels/{scope}/start")
async def start_kernel(request: Request, scope: str) -> dict[str, Any]:
    state = _state(request)
    scope = _normalize_scope(state, scope)
    if scope not in {"main"} and not scope.startswith("ws:"):
        raise _error("未知的内核作用域", "invalid_scope", 404)
    try:
        kernel = await state.kernel_for(scope)
    except Exception as exc:
        raise _error(f"内核启动失败：{exc}", "kernel_start_failed", 500)
    return {"scope": scope, "status": kernel.status()}


@router.post("/api/kernels/{scope}/restart")
async def restart_kernel(request: Request, scope: str) -> dict[str, Any]:
    state = _state(request)
    scope = _normalize_scope(state, scope)
    try:
        kernel = await state.restart_kernel(scope)
    except Exception as exc:
        raise _error(f"内核重启失败：{exc}", "kernel_restart_failed", 500)
    return {"scope": scope, "status": kernel.status()}


@router.post("/api/kernels/{scope}/stop")
async def stop_kernel(request: Request, scope: str) -> dict[str, Any]:
    state = _state(request)
    scope = _normalize_scope(state, scope)
    stopped = await state.stop_kernel(scope)
    return {"scope": scope, "stopped": stopped}


@router.post("/api/kernels/{scope}/execute")
async def kernel_execute(request: Request, scope: str) -> dict[str, Any]:
    """Execute code in one workspace-scoped kernel (verification & UI console)."""
    state = _state(request)
    scope = _normalize_scope(state, scope)
    if scope not in {"main"} and not scope.startswith("ws:"):
        raise _error("未知的内核作用域", "invalid_scope", 404)
    body = await _json(request)
    code = str(body.get("code") or "")
    if not code.strip():
        raise _error("代码不能为空", "empty_code")
    timeout_s: float | None = None
    raw_timeout = body.get("timeout_s")
    if raw_timeout is not None:
        try:
            timeout_s = float(raw_timeout)
        except (TypeError, ValueError):
            timeout_s = None
        if timeout_s is not None and timeout_s <= 0:
            timeout_s = None
    kernel = await state.kernel_for(scope)
    platform = getattr(state, 'platform', None)
    if platform is not None:
        result = await platform.execute_console(state.workspace_for_scope(scope), kernel, code, timeout_s)
    else:
        result = await kernel.execute(code, timeout_s=timeout_s)
    result["scope"] = scope
    return result


@router.get("/api/kernels/{scope}/vars")
async def kernel_vars(request: Request, scope: str) -> dict[str, Any]:
    """List user variables in one workspace-scoped kernel (isolation check)."""
    state = _state(request)
    scope = _normalize_scope(state, scope)
    if scope not in {"main"} and not scope.startswith("ws:"):
        raise _error("未知的内核作用域", "invalid_scope", 404)
    kernel = await state.kernel_for(scope)
    try:
        items = await kernel.list_vars()
    except Exception as exc:
        raise _error(f"读取变量失败：{exc}", "kernel_vars_failed", 500)
    return {"scope": scope, "vars": items}


@router.get("/api/kernels/{scope}/vars/{name}")
async def kernel_var_detail(request: Request, scope: str, name: str):
    state = _state(request)
    kernel = await state.kernel_for(_normalize_scope(state, scope))
    return await kernel.var_detail(name)


# -- workspace-scoped files ------------------------------------------------
@router.get("/api/workspaces/{workspace_id}/jobs")
async def ws_jobs(request: Request, workspace_id: str):
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        return {"jobs": await _remote_call(state, workspace, "process_list")}
    return {"jobs": await asyncio.to_thread(state.jobs.list)}


@router.get("/api/workspaces/{workspace_id}/jobs/{job_id}/log")
async def ws_job_log(request: Request, workspace_id: str, job_id: str):
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        return await _remote_call(state, workspace, "process_log", job_id)
    return await asyncio.to_thread(state.jobs.log, job_id, 0, 20000)


@router.post("/api/workspaces/{workspace_id}/jobs/{job_id}/cancel")
async def ws_job_cancel(request: Request, workspace_id: str, job_id: str):
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        return await _remote_call(state, workspace, "process_cancel", job_id)
    return await asyncio.to_thread(state.jobs.cancel, job_id)


@router.get("/api/workspaces/{workspace_id}/files/tree")
async def ws_tree(request: Request, workspace_id: str, path: str = "", show_hidden: bool = False) -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        data = await _remote_call(state, workspace, "list_dir", path, show_hidden=show_hidden)
        data["workspace_id"] = workspace_id
        return data
    root = _local_root(workspace)
    try:
        data = fileops.list_dir(state.settings, path, show_hidden=show_hidden, root=root)
    except Exception as exc:
        raise _error(f"读取目录失败：{exc}", "file_tree_failed")
    data["workspace_id"] = workspace_id
    return data


@router.get("/api/workspaces/{workspace_id}/files/read")
async def ws_read(request: Request, workspace_id: str, path: str, max_bytes: int = 200_000) -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        data = await _remote_call(state, workspace, "read_text", path, max_bytes=max_bytes)
        data["text"] = data.get("content", "")
        return data
    root = _local_root(workspace)
    try:
        return fileops.read_text(state.settings, path, max_bytes=max_bytes, root=root)
    except Exception as exc:
        raise _error(f"读取文件失败：{exc}", "file_read_failed")


@router.get("/api/workspaces/{workspace_id}/files/raw")
async def ws_raw(request: Request, workspace_id: str, path: str) -> FileResponse:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        data, filename, mime = await _remote_call(state, workspace, "read_bytes", path)
        return Response(data, media_type=mime, headers={"Content-Disposition": "inline; filename*=UTF-8\'\'" + quote(filename)})
    root = _local_root(workspace)
    try:
        resolved = fileops.resolve_path(state.settings, path, root=root)
    except Exception as exc:
        raise _error(f"文件路径无效：{exc}", "invalid_path")
    if not resolved.is_file():
        raise _error("文件不存在", "file_not_found", 404)
    return FileResponse(str(resolved), media_type=fileops.guess_mime(resolved), filename=resolved.name)


@router.post("/api/workspaces/{workspace_id}/files/write")
async def ws_write(request: Request, workspace_id: str) -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    body = await _json(request)
    path = str(body.get("path") or "").strip()
    if not path:
        raise _error("path 不能为空", "invalid_path")
    if workspace.backend == "ssh":
        return await _remote_call(state, workspace, "write_text", path, str(body.get("content") or ""))
    root = _local_root(workspace)
    try:
        return fileops.write_text(state.settings, path, str(body.get("content") or ""), root=root)
    except Exception as exc:
        raise _error(f"写入文件失败：{exc}", "file_write_failed")


@router.post("/api/workspaces/{workspace_id}/files/mkdir")
async def ws_mkdir(request: Request, workspace_id: str) -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    body = await _json(request)
    if workspace.backend == "ssh":
        return await _remote_call(state, workspace, "make_dir", str(body.get("path") or ""))
    root = _local_root(workspace)
    try:
        return fileops.make_dir(state.settings, str(body.get("path") or ""), root=root)
    except Exception as exc:
        raise _error(f"创建目录失败：{exc}", "mkdir_failed")


@router.delete("/api/workspaces/{workspace_id}/files")
async def ws_delete(request: Request, workspace_id: str, path: str = "") -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    if workspace.backend == "ssh":
        if path.strip() in {"", ".", "/", "~"}:
            raise _error("不能删除工作区根目录", "invalid_path")
        return await _remote_call(state, workspace, "delete_path", path)
    root = _local_root(workspace)
    try:
        return fileops.delete_path(state.settings, path, root=root)
    except Exception as exc:
        raise _error(f"删除失败：{exc}", "delete_failed")


@router.post("/api/workspaces/{workspace_id}/files/upload")
async def ws_upload(request: Request, workspace_id: str, file: UploadFile, dir: str = "") -> dict[str, Any]:
    state = _state(request)
    workspace = _workspace(state, workspace_id)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise _error("文件过大（上限 200MB）", "file_too_large", 413)
    if workspace.backend == "ssh":
        return await _remote_call(state, workspace, "save_upload", dir, file.filename or "upload.bin", data)
    root = _local_root(workspace)
    try:
        return fileops.save_upload(state.settings, dir, file.filename or "upload.bin", data, root=root)
    except Exception as exc:
        raise _error(f"上传失败：{exc}", "upload_failed")
