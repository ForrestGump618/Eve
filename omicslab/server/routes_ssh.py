"""SSH REST API 路由（CONTRACTS-2 §6.3 / CONTRACTS-3 §6，修复 F10）。

所有端点都通过 :func:`omicslab.ssh.connections.get_connection_service` 取得
**进程内共享**的 SSH 连接服务，因此界面上的“测试连接”（含临时密码）、Agent
``ssh_*`` 工具、``SSHExecutionBackend`` 与终端使用同一份连接与内存凭据。

错误约定（由 ``server/app.py`` 的 HTTPException 处理器统一输出）：

* 参数缺失/非法 → 400 ``bad_request``；
* 未找到档案 → 404 ``not_found``；
* 连接失败 → 502 ``ssh_error``；
* 文件超过 200 MB → 413 ``too_large``；
* 远端命令非零退出仍返回 HTTP 200，由 ``ok``/``status`` 反映真实结果；
  已提交但失联的命令返回 ``status="unknown"`` 并附带对账信息。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..ssh.connections import get_connection_service, reset_for_tests
from ..ssh.manager import (
    DEFAULT_TIMEOUT_S,
    MAX_TIMEOUT_S,
    SSHError,
    SSHProfileNotFound,
    SSHValidationError,
)
from .files import guess_mime

logger = logging.getLogger("omicslab.server.routes_ssh")

router = APIRouter()

MAX_TRANSFER_BYTES = 200 * 1024 * 1024
_UPLOAD_CHUNK = 1024 * 1024
_PROFILE_FIELDS = (
    "name",
    "host",
    "port",
    "username",
    "auth",
    "key_path",
    "tags",
    "password",
    "remember_password",
)


# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------


def _state(request: Request) -> Any:
    return request.app.state.omicslab


def _service(request: Request) -> Any:
    return get_connection_service(_state(request).settings)


def _manager(request: Request) -> Any:
    """兼容旧调用：返回共享服务的 manager。"""
    return _service(request).manager


def reset_managers() -> None:
    """关闭共享连接服务（测试/应用退出用）。"""
    reset_for_tests()


def _error(message: str, code: str = "bad_request", status: int = 400, detail: Any = "") -> None:
    raise HTTPException(status_code=status, detail={"message": message, "code": code, "detail": detail})


def _ssh_error(exc: Exception) -> None:
    """把 SSH 异常归一化为契约错误码。"""
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, SSHProfileNotFound):
        _error(str(exc), "not_found", 404)
    if isinstance(exc, SSHValidationError):
        _error(str(exc), "bad_request", 400)
    if isinstance(exc, SSHError):
        detail = getattr(exc, "detail", "") or ""
        message = str(exc)
        if not message.startswith("SSH 连接失败"):
            message = f"SSH 连接失败: {message}"
        _error(message, "ssh_error", 502, detail)
    _error(f"SSH 操作失败: {exc}", "internal_error", 500)


async def _json(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _require(body: dict[str, Any], key: str, label: str | None = None) -> str:
    value = _text(body.get(key))
    if not value:
        _error(f"缺少参数: {label or key}", "bad_request", 400)
    return value


def _profile_fields(body: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for key in _PROFILE_FIELDS:
        if key not in body:
            continue
        value = body.get(key)
        if key == "port":
            if value in (None, ""):
                continue
            try:
                fields[key] = int(value)
            except (TypeError, ValueError):
                _error("端口必须是整数", "bad_request", 400)
        elif key == "remember_password":
            fields[key] = bool(value)
        elif key == "tags":
            if isinstance(value, str):
                fields[key] = [part.strip() for part in value.replace("，", ",").split(",") if part.strip()]
            elif isinstance(value, list):
                fields[key] = [str(part).strip() for part in value if str(part).strip()]
            else:
                _error("tags 必须是字符串数组", "bad_request", 400)
        elif key == "password":
            fields[key] = "" if value is None else str(value)
        else:
            fields[key] = "" if value is None else str(value).strip()
    return fields


def _timeout_value(body: dict[str, Any]) -> float:
    raw = body.get("timeout_s")
    if raw in (None, ""):
        return float(DEFAULT_TIMEOUT_S)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        _error("timeout_s 必须是数字", "bad_request", 400)
    if value <= 0:
        _error("timeout_s 必须大于 0", "bad_request", 400)
    return min(value, float(MAX_TIMEOUT_S))


def _tmp_dir(settings: Any) -> Path:
    path = Path(settings.home) / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_basename(name: str) -> str:
    base = Path(str(name or "").replace("\\", "/")).name
    return base or "download"


def _cleanup(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.debug("清理临时文件失败: %s", path)


# ---------------------------------------------------------------------------
# 档案 CRUD
# ---------------------------------------------------------------------------


@router.get("/api/ssh/profiles")
async def ssh_profiles(request: Request) -> dict[str, Any]:
    service = _service(request)
    try:
        profiles = await asyncio.to_thread(service.list_profiles)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return {"profiles": profiles}


@router.post("/api/ssh/profiles")
async def ssh_profile_create(request: Request) -> dict[str, Any]:
    body = await _json(request)
    fields = _profile_fields(body)
    _require(fields, "name", "名称")
    _require(fields, "host", "主机")
    _require(fields, "username", "用户名")
    service = _service(request)
    try:
        profile = await asyncio.to_thread(service.add_profile, **fields)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return {"profile": profile}


@router.patch("/api/ssh/profiles/{profile_id}")
async def ssh_profile_update(profile_id: str, request: Request) -> dict[str, Any]:
    body = await _json(request)
    fields = _profile_fields(body)
    if not fields:
        _error("没有可更新的字段", "bad_request", 400)
    service = _service(request)
    try:
        profile = await asyncio.to_thread(service.update_profile, profile_id, **fields)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return {"profile": profile}


@router.delete("/api/ssh/profiles/{profile_id}")
async def ssh_profile_delete(profile_id: str, request: Request) -> dict[str, Any]:
    service = _service(request)
    try:
        await asyncio.to_thread(service.remove_profile, profile_id)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return {"ok": True}


# ---------------------------------------------------------------------------
# 连接测试（F10：临时密码写入共享内存凭据，显式 remember 才落盘）
# ---------------------------------------------------------------------------


@router.post("/api/ssh/profiles/{profile_id}/test")
async def ssh_profile_test(profile_id: str, request: Request) -> dict[str, Any]:
    body = await _json(request)
    password = body.get("password")
    remember = bool(body.get("remember") or body.get("remember_password"))
    service = _service(request)
    try:
        result = await asyncio.to_thread(
            service.test_connection,
            profile_id,
            None if password in (None, "") else str(password),
            remember=remember,
        )
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return result


@router.post("/api/ssh/test")
async def ssh_test_adhoc(request: Request) -> dict[str, Any]:
    """测试尚未保存的档案（工作区向导），不会写入 ssh.json。"""
    body = await _json(request)
    profile = body.get("profile") if isinstance(body.get("profile"), dict) else body
    password = body.get("password")
    remember = bool(body.get("remember") or body.get("remember_password"))
    service = _service(request)
    try:
        result = await asyncio.to_thread(
            service.test_profile,
            dict(profile or {}),
            password=None if password in (None, "") else str(password),
            remember=remember,
        )
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return result


@router.post("/api/ssh/profiles/{profile_id}/remember")
async def ssh_profile_remember(profile_id: str, request: Request) -> dict[str, Any]:
    body = await _json(request)
    password = _text(body.get("password"))
    if not password:
        _error("缺少参数: password", "bad_request", 400)
    service = _service(request)
    try:
        profile = await asyncio.to_thread(service.remember_password, profile_id, password)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return {"profile": profile}


# ---------------------------------------------------------------------------
# 命令执行 / 目录 / 信息
# ---------------------------------------------------------------------------


@router.post("/api/ssh/exec")
async def ssh_exec(request: Request) -> dict[str, Any]:
    body = await _json(request)
    profile_id = _require(body, "profile_id", "profile_id")
    command = _require(body, "command", "command")
    cwd = _text(body.get("cwd")) or None
    timeout_s = _timeout_value(body)
    idempotent = bool(body.get("idempotent"))
    service = _service(request)
    try:
        result = await asyncio.to_thread(
            service.exec,
            profile_id,
            command,
            cwd=cwd,
            timeout_s=timeout_s,
            idempotent=idempotent,
        )
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    return result


@router.get("/api/ssh/ls")
async def ssh_ls(
    request: Request,
    profile_id: str = Query("", description="SSH 档案 ID"),
    path: str = Query(".", description="远端目录"),
) -> dict[str, Any]:
    if not _text(profile_id):
        _error("缺少参数: profile_id", "bad_request", 400)
    service = _service(request)
    try:
        return await asyncio.to_thread(service.list_dir, profile_id, path or ".")
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)


@router.get("/api/ssh/info")
async def ssh_info(
    request: Request,
    profile_id: str = Query("", description="SSH 档案 ID"),
) -> dict[str, Any]:
    if not _text(profile_id):
        _error("缺少参数: profile_id", "bad_request", 400)
    service = _service(request)
    try:
        return await asyncio.to_thread(service.remote_info, profile_id)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)


@router.get("/api/ssh/diagnostics")
async def ssh_diagnostics(request: Request) -> dict[str, Any]:
    service = _service(request)
    try:
        data = await asyncio.to_thread(service.diagnostics)
        commands = await asyncio.to_thread(service.recent_commands, 10)
        credentials = await asyncio.to_thread(service.credential_status)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    data["recent_commands"] = commands
    data["credentials"] = credentials
    return data


# ---------------------------------------------------------------------------
# 上传 / 下载（200 MB 限制先检查再传输，避免整文件读入内存）
# ---------------------------------------------------------------------------


@router.post("/api/ssh/upload")
async def ssh_upload(
    request: Request,
    file: UploadFile = File(...),
    profile_id: str = Form(...),
    remote_path: str = Form(...),
) -> dict[str, Any]:
    profile_id = _text(profile_id)
    remote_path = _text(remote_path)
    if not profile_id:
        _error("缺少参数: profile_id", "bad_request", 400)
    if not remote_path:
        _error("缺少参数: remote_path", "bad_request", 400)
    filename = _safe_basename(file.filename or "upload.bin")
    declared = getattr(file, "size", None)
    if declared is not None and int(declared) > MAX_TRANSFER_BYTES:
        _error("文件超过 200MB 限制", "too_large", 413)
    settings = _state(request).settings
    tmp_dir = _tmp_dir(settings)
    temp_path = tmp_dir / f"upload-{uuid.uuid4().hex}-{filename}"
    written = 0
    try:
        with temp_path.open("wb") as handle:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_TRANSFER_BYTES:
                    _error("文件超过 200MB 限制", "too_large", 413)
                handle.write(chunk)
        if written == 0:
            _error("上传文件为空", "bad_request", 400)
        service = _service(request)
        target = remote_path
        if target.endswith("/"):
            target = f"{target.rstrip('/')}/{filename}"
        try:
            result = await asyncio.to_thread(
                service.put_file, profile_id, temp_path, target
            )
        except Exception as exc:  # noqa: BLE001
            _ssh_error(exc)
        return {
            "ok": True,
            "remote_path": result.get("remote_path") or target,
            "bytes": int(result.get("bytes") or written),
            "name": filename,
        }
    finally:
        _cleanup(temp_path)
        try:
            await file.close()
        except Exception:  # pragma: no cover - 防御
            pass


@router.get("/api/ssh/download")
async def ssh_download(
    request: Request,
    profile_id: str = Query("", description="SSH 档案 ID"),
    remote_path: str = Query("", description="远端文件路径"),
) -> FileResponse:
    profile_id = _text(profile_id)
    remote_path = _text(remote_path)
    if not profile_id:
        _error("缺少参数: profile_id", "bad_request", 400)
    if not remote_path:
        _error("缺少参数: remote_path", "bad_request", 400)
    service = _service(request)
    try:
        info = await asyncio.to_thread(service.stat, profile_id, remote_path)
    except Exception as exc:  # noqa: BLE001
        _ssh_error(exc)
    if not info.get("exists"):
        _error(f"远端文件不存在: {remote_path}", "not_found", 404)
    if info.get("is_dir"):
        _error("不能下载目录，请指定文件路径", "bad_request", 400)
    size = int(info.get("size") or 0)
    if size > MAX_TRANSFER_BYTES:
        _error("文件超过 200MB 限制", "too_large", 413)
    settings = _state(request).settings
    temp_path = _tmp_dir(settings) / f"download-{uuid.uuid4().hex}-{_safe_basename(remote_path)}"
    try:
        try:
            result = await asyncio.to_thread(
                service.get_file, profile_id, remote_path, temp_path
            )
        except Exception as exc:  # noqa: BLE001
            _ssh_error(exc)
        actual = int(result.get("bytes") or 0)
        if actual > MAX_TRANSFER_BYTES:
            _error("文件超过 200MB 限制", "too_large", 413)
    except Exception:
        _cleanup(temp_path)
        raise
    filename = _safe_basename(remote_path)
    return FileResponse(
        str(temp_path),
        media_type=guess_mime(filename),
        filename=filename,
        background=BackgroundTask(_cleanup, temp_path),
    )
