"""SSH Agent 工具（CONTRACTS-2 §6.4 / CONTRACTS-3 §6）。

把 :class:`omicslab.ssh.connections.ConnectionService` 的能力暴露给 Agent：

* ``ssh_list_profiles`` —— 列出已保存的远程主机档案；
* ``ssh_exec`` —— 在远端执行**一次性**命令（**需要审批**，支持 cwd）；
* ``ssh_upload`` —— 上传本地文件到远端（**需要审批**）；
* ``ssh_download`` —— 从远端下载文件到本地；
* ``ssh_remote_info`` —— 采集远端系统信息。

F10 修复：工具不再自带 ``SSHManager`` 缓存，而是与 HTTP 路由/SSHBackend/终端
共用 :func:`get_connection_service` 的进程内单例，因此 UI“测试连接”输入的
临时密码对 Agent 同样可见。

所有工具在异常时返回 ``ToolResult(ok=False)``，不会把异常抛给 Agent 主循环；
SSH 操作在线程中执行，避免阻塞事件循环。执行结果中的 ``status="unknown"``
表示命令已提交但结果未知，工具会明确提示不要重复执行。
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..agent.types import ToolError, ToolResult
from ..utils import truncate
from .connections import get_connection_service, reset_for_tests
from .manager import (
    DEFAULT_TIMEOUT_S,
    SSHError,
    SSHProfileNotFound,
    SSHValidationError,
)

if TYPE_CHECKING:  # pragma: no cover - 仅用于类型标注，避免与 agent.tools 循环导入
    from ..agent.tools import ToolContext, ToolRegistry

logger = logging.getLogger("omicslab.ssh.tools")

TOOLSET = "ssh"


# ---------------------------------------------------------------------------
# 参数与 schema 小工具
# ---------------------------------------------------------------------------


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": "object", "properties": properties}
    # Always emit ``required`` (possibly empty) so the schema stays OpenAI-compatible.
    payload["required"] = list(required or [])
    return payload


def _prop(kind: str, description: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": kind, "description": description}
    payload.update(extra)
    return payload


def _arg_str(arguments: dict[str, Any], key: str, *, required: bool = True) -> str:
    value = arguments.get(key)
    if value is None or value == "":
        if required:
            raise ToolError(f"缺少参数: {key}")
        return ""
    if not isinstance(value, str):
        raise ToolError(f"参数 {key} 必须是字符串")
    return value.strip()


def _arg_int(arguments: dict[str, Any], key: str, default: int) -> int:
    value = arguments.get(key)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ToolError(f"参数 {key} 必须是整数") from None


def _ok(name: str, content: str, data: dict[str, Any] | None = None) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        name=name,
        ok=True,
        content=content,
        data=data or {},
    )


def _fail(name: str, message: str) -> ToolResult:
    text = message.strip() or "SSH 工具执行失败"
    return ToolResult(
        tool_call_id="",
        name=name,
        ok=False,
        content=text,
        error=text,
    )


# ---------------------------------------------------------------------------
# 连接服务解析（进程内单例：HTTP / 工具 / 终端 / SSHBackend 共用）
# ---------------------------------------------------------------------------


def _service_for(settings: Any) -> Any:
    return get_connection_service(settings)


def _manager_for(settings: Any) -> Any:
    """兼容旧调用：返回共享单例的 SSHManager。"""
    return _service_for(settings).manager


def reset_managers() -> None:
    """关闭并清空共享连接服务（应用退出/测试清理用）。"""
    reset_for_tests()


def _describe_profile(profile: dict[str, Any]) -> str:
    auth = "私钥" if profile.get("auth") == "key" else "密码"
    if profile.get("credential_stored"):
        saved = "已保存到系统凭据库" if profile.get("credential_stored") else "仅内存"
    elif profile.get("has_password_saved"):
        saved = "仅内存"
    else:
        saved = "未保存"
    status = "可用" if profile.get("last_ok") else ("上次失败" if profile.get("last_error") else "未测试")
    return (
        f"- {profile.get('name')} · {profile.get('username')}@{profile.get('host')}:"
        f"{profile.get('port')}（{auth}认证，密码{saved}，{status}）"
    )


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------


async def _tool_ssh_list_profiles(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = "ssh_list_profiles"
    try:
        service = _service_for(ctx.settings)
        profiles = await asyncio.to_thread(service.list_profiles)
    except SSHError as exc:
        return _fail(name, str(exc))
    except Exception as exc:  # pragma: no cover - 兜底
        logger.exception("ssh_list_profiles 失败")
        return _fail(name, f"读取 SSH 档案失败: {exc}")
    if not profiles:
        return _ok(name, "暂无 SSH 档案。可以先通过 SSH 页面或 API 添加远程主机。", {"profiles": []})
    lines = [f"共 {len(profiles)} 个 SSH 档案：", *(_describe_profile(item) for item in profiles)]
    return _ok(name, "\n".join(lines), {"profiles": profiles})


async def _tool_ssh_exec(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = "ssh_exec"
    try:
        profile_id = _arg_str(arguments, "profile_id")
        command = _arg_str(arguments, "command")
        timeout_s = _arg_int(arguments, "timeout_s", DEFAULT_TIMEOUT_S)
        cwd = _arg_str(arguments, "cwd", required=False) or None
        service = _service_for(ctx.settings)
        result = await asyncio.to_thread(
            service.exec,
            profile_id,
            command,
            cwd=cwd,
            timeout_s=timeout_s,
        )
    except (ToolError, SSHValidationError, SSHProfileNotFound, SSHError) as exc:
        return _fail(name, str(exc))
    except Exception as exc:  # pragma: no cover - 兜底
        logger.exception("ssh_exec 失败")
        return _fail(name, f"SSH 命令执行失败: {exc}")

    status = str(result.get("status") or "ok")
    stdout = truncate(str(result.get("stdout") or ""), 8000)
    stderr = truncate(str(result.get("stderr") or ""), 8000)
    parts: list[str] = []
    if status == "unknown":
        reconciliation = result.get("reconciliation") or {}
        message = str(reconciliation.get("message") or "")
        parts.append("⚠️ 执行结果未知：命令已提交到远端，但连接中断。")
        if message:
            parts.append(message)
        parts.append(f"命令 ID：{result.get('command_id') or '未知'}")
    else:
        parts.append(f"状态 {status} · 退出码 {result.get('exit_code')} · 耗时 {result.get('duration_ms')} ms")
    parts.append(f"$ {command}")
    if cwd:
        parts.append(f"（工作目录：{cwd}）")
    if stdout:
        parts.extend(["--- stdout ---", stdout])
    if stderr:
        parts.extend(["--- stderr ---", stderr])
    if not stdout and not stderr and status != "unknown":
        parts.append("（无输出）")
    ok = bool(result.get("ok")) and status == "ok"
    content = "\n".join(parts)
    if not ok:
        return ToolResult(
            tool_call_id="",
            name=name,
            ok=False,
            content=content,
            data={
                "status": status,
                "exit_code": result.get("exit_code"),
                "stdout": truncate(str(result.get("stdout") or ""), 20000),
                "stderr": truncate(str(result.get("stderr") or ""), 20000),
                "duration_ms": result.get("duration_ms"),
                "command_id": result.get("command_id"),
                "reconciliation": result.get("reconciliation"),
            },
            error=content,
        )
    return _ok(
        name,
        content,
        {
            "status": status,
            "ok": True,
            "exit_code": result.get("exit_code"),
            "stdout": truncate(str(result.get("stdout") or ""), 20000),
            "stderr": truncate(str(result.get("stderr") or ""), 20000),
            "duration_ms": result.get("duration_ms"),
            "command_id": result.get("command_id"),
            "cwd": cwd,
        },
    )


async def _tool_ssh_upload(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = "ssh_upload"
    try:
        profile_id = _arg_str(arguments, "profile_id")
        local_path = _arg_str(arguments, "local_path")
        remote_path = _arg_str(arguments, "remote_path")
        service = _service_for(ctx.settings)
        result = await asyncio.to_thread(
            service.put_file, profile_id, Path(local_path), remote_path
        )
    except (ToolError, SSHValidationError, SSHProfileNotFound, SSHError) as exc:
        return _fail(name, str(exc))
    except Exception as exc:  # pragma: no cover - 兜底
        logger.exception("ssh_upload 失败")
        return _fail(name, f"SSH 上传失败: {exc}")
    size = result.get("bytes")
    content = f"已上传 {Path(local_path).name} → {result.get('remote_path')}（{size} 字节）"
    return _ok(
        name,
        content,
        {"bytes": size, "remote_path": result.get("remote_path"), "local_path": local_path},
    )


async def _tool_ssh_download(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = "ssh_download"
    try:
        profile_id = _arg_str(arguments, "profile_id")
        remote_path = _arg_str(arguments, "remote_path")
        local_path = _arg_str(arguments, "local_path")
        service = _service_for(ctx.settings)
        result = await asyncio.to_thread(
            service.get_file, profile_id, remote_path, Path(local_path)
        )
    except (ToolError, SSHValidationError, SSHProfileNotFound, SSHError) as exc:
        return _fail(name, str(exc))
    except Exception as exc:  # pragma: no cover - 兜底
        logger.exception("ssh_download 失败")
        return _fail(name, f"SSH 下载失败: {exc}")
    size = result.get("bytes")
    content = f"已下载 {remote_path} → {result.get('local_path')}（{size} 字节）"
    return _ok(
        name,
        content,
        {"bytes": size, "remote_path": remote_path, "local_path": result.get("local_path")},
    )


async def _tool_ssh_remote_info(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = "ssh_remote_info"
    try:
        profile_id = _arg_str(arguments, "profile_id")
        service = _service_for(ctx.settings)
        info = await asyncio.to_thread(service.remote_info, profile_id)
    except (ToolError, SSHValidationError, SSHProfileNotFound, SSHError) as exc:
        return _fail(name, str(exc))
    except Exception as exc:  # pragma: no cover - 兜底
        logger.exception("ssh_remote_info 失败")
        return _fail(name, f"读取远端信息失败: {exc}")

    def show(value: Any, fallback: str = "未知") -> str:
        if value is None or value == "":
            return fallback
        return str(value)

    lines = [
        f"系统: {show(info.get('uname'))}",
        f"Python: {show(info.get('python'))}",
        f"CPU 核心数: {show(info.get('cpu_count'))}",
        f"内存: {show(info.get('mem_total_mb'))} MB",
        f"GPU: {show(info.get('gpu'))}",
        f"磁盘可用: {show(info.get('disk_free_gb'))} GB",
    ]
    return _ok(name, "\n".join(lines), dict(info))


# ---------------------------------------------------------------------------
# 注册
# ---------------------------------------------------------------------------


def _specs(settings: Any) -> list[Any]:
    from ..agent.tools import ToolSpec

    profile_prop = _prop("string", "SSH 档案 ID（由 ssh_list_profiles 获取）")
    return [
        ToolSpec(
            name="ssh_list_profiles",
            description="列出已保存的 SSH 远程主机档案（不含密码），返回档案 ID 与连接状态。",
            parameters=_schema({}),
            toolset=TOOLSET,
            handler=_tool_ssh_list_profiles,
        ),
        ToolSpec(
            name="ssh_exec",
            description=(
                "在远端主机执行一次性 Shell 命令并返回状态、退出码、stdout、stderr 与耗时。"
                "远端命令不会保留上一次 cd；可用 cwd 指定本次工作目录。"
                "结果未知（status=unknown）时表示命令已提交但连接中断，不要自动重复执行；需要用户审批。"
            ),
            parameters=_schema(
                {
                    "profile_id": profile_prop,
                    "command": _prop("string", "要在远端执行的命令"),
                    "timeout_s": _prop(
                        "integer",
                        "超时时间（秒），默认 120",
                        minimum=1,
                        maximum=3600,
                    ),
                    "cwd": _prop("string", "本次命令的远端工作目录（可选，不保留到后续命令）"),
                },
                required=["profile_id", "command"],
            ),
            toolset=TOOLSET,
            handler=_tool_ssh_exec,
            requires_approval=True,
        ),
        ToolSpec(
            name="ssh_upload",
            description="把本地文件上传到远端主机指定路径；需要用户审批。",
            parameters=_schema(
                {
                    "profile_id": profile_prop,
                    "local_path": _prop("string", "本地文件路径（绝对路径或相对工作区路径）"),
                    "remote_path": _prop("string", "远端目标路径（文件路径，目录会自动创建）"),
                },
                required=["profile_id", "local_path", "remote_path"],
            ),
            toolset=TOOLSET,
            handler=_tool_ssh_upload,
            requires_approval=True,
        ),
        ToolSpec(
            name="ssh_download",
            description="从远端主机下载文件到本地路径。",
            parameters=_schema(
                {
                    "profile_id": profile_prop,
                    "remote_path": _prop("string", "远端文件路径"),
                    "local_path": _prop("string", "本地保存路径"),
                },
                required=["profile_id", "remote_path", "local_path"],
            ),
            toolset=TOOLSET,
            handler=_tool_ssh_download,
        ),
        ToolSpec(
            name="ssh_remote_info",
            description="采集远端主机的系统信息（系统版本、Python、CPU、内存、GPU、磁盘可用空间）。",
            parameters=_schema({"profile_id": profile_prop}, required=["profile_id"]),
            toolset=TOOLSET,
            handler=_tool_ssh_remote_info,
        ),
    ]


def register_ssh_tools(registry: ToolRegistry, settings: Any) -> None:
    """把 SSH 工具注册进既有 ToolRegistry。

    契约中的 ToolRegistry 只提供构造期注入，没有运行时 register 方法；
    因此这里直接向内部的 ``_specs`` 字典写入，并对重名工具跳过（幂等）。
    """
    if registry is None:
        raise ToolError("register_ssh_tools 需要 ToolRegistry 实例")
    specs_attr = getattr(registry, "_specs", None)
    if not isinstance(specs_attr, dict):
        raise ToolError("当前 ToolRegistry 不支持运行时注册（缺少 _specs 字典）")
    specs = _specs(settings)
    added = 0
    for spec in specs:
        if spec.name in specs_attr:
            logger.warning("SSH 工具 %s 已存在，跳过注册", spec.name)
            continue
        specs_attr[spec.name] = spec
        added += 1
    logger.debug("已注册 %d/%d 个 SSH 工具", added, len(specs))
