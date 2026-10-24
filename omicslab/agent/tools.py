"""Agent tools: specifications, execution context and the built-in registry.

The registry is the single place that knows how to validate tool arguments,
ask for human approval and turn handler behaviour into a :class:`ToolResult`.
Handlers are ``async def`` and must never raise into the agent loop: every
failure is converted to a friendly Chinese error result by
:meth:`ToolRegistry.execute`.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

from omicslab.agent.approvals import Approver
from omicslab.agent.memory import MAX_BODY_BYTES as MEMORY_MAX_BODY_BYTES
from omicslab.agent.memory import MemoryError, MemoryStore
from omicslab.agent.skills import (
    catalog_text as skills_catalog_text,
    load_skills,
    skill_detail_text,
)
from omicslab.agent.templates import (
    AgentTemplate,
    catalog_text as agents_catalog_text,
    get_agent,
    load_agents,
)
from omicslab.agent.types import AgentEvent, ToolError, ToolResult
from omicslab.config import ConfigError, Settings
from omicslab.session.jobs import JobManager
from omicslab.utils import (
    atomic_write_text,
    human_size,
    iso_from_ts,
    iso_now,
    safe_join,
    strip_ansi,
    truncate,
)

logger = logging.getLogger("omicslab.agent.tools")

MAX_TOOL_CONTENT = 20_000
MAX_READ_BYTES = 8 * 1024 * 1024
MAX_WRITE_BYTES = 5 * 1024 * 1024
MAX_SHELL_OUTPUT = 20_000
MAX_LIST_ENTRIES = 400
_NOISE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    "node_modules",
    ".tox",
    "build",
    "dist",
}


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------


@dataclass
class ToolContext:
    """Per-request execution environment handed to tool handlers.

    The loop/server constructs one context per conversation turn. Optional
    collaborators (``kernel``, ``jobs``, ``memory``, ``approver``) may be
    shared across turns; when omitted the context creates its own instance
    lazily from ``settings``.
    """

    settings: Settings
    kernel: Any = None
    registry: "ToolRegistry | None" = None
    workspace: Path | None = None
    conversation_id: str = ""
    agent_id: str = "lead"
    emit: Callable[[AgentEvent], Awaitable[None]] | None = None
    cancel_event: asyncio.Event | None = None
    approver: Approver | None = None
    jobs: JobManager | None = None
    memory: MemoryStore | None = None

    # -- lazy collaborators -------------------------------------------------
    def ensure_approver(self) -> Approver:
        if self.approver is None:
            policy = getattr(self.settings, "approval_policy", "auto") or "auto"
            self.approver = Approver(policy=policy)
        return self.approver

    def ensure_jobs(self) -> JobManager:
        if self.jobs is None:
            self.jobs = JobManager(self.settings)
        return self.jobs

    def ensure_memory(self) -> MemoryStore:
        if self.memory is None:
            self.memory = MemoryStore(self.settings)
        return self.memory

    # -- workspace helpers --------------------------------------------------
    @property
    def workspace_root(self) -> Path:
        if self.workspace is not None:
            return Path(self.workspace)
        return Path(self.settings.workspace)

    def resolve_in_workspace(self, relative: str | None) -> Path:
        """Resolve ``relative`` inside the workspace, rejecting escapes."""
        target = safe_join(self.workspace_root, relative or ".")
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        return target

    # -- cancellation -------------------------------------------------------
    @property
    def is_cancelled(self) -> bool:
        event = self.cancel_event
        return bool(event is not None and event.is_set())

    def check_cancelled(self) -> None:
        """Raise when the surrounding turn has been cancelled."""
        if self.is_cancelled:
            raise ToolError("操作已取消。")

    # -- event bridge -------------------------------------------------------
    async def emit_event(self, event: AgentEvent) -> None:
        """Best-effort event emission; missing sinks are ignored."""
        sink = self.emit
        if sink is None:
            return
        try:
            result = sink(event)
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - UI sink failure
            logger.warning("事件发送失败（%s）：%s", getattr(event, "type", "?"), exc)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


ToolHandler = Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]


@dataclass
class ToolSpec:
    """Static declaration of one tool (schema + handler)."""

    name: str
    description: str
    parameters: dict[str, Any]
    toolset: str
    handler: ToolHandler
    requires_approval: bool = False


class ToolRegistry:
    """A name-addressed collection of tool specifications."""

    def __init__(self, specs: Iterable[ToolSpec]) -> None:
        self._specs: dict[str, ToolSpec] = {}
        for spec in specs:
            if spec.name in self._specs:
                raise ValueError(f"重复的工具名称：{spec.name}")
            if not callable(spec.handler):
                raise TypeError(f"工具 {spec.name} 的 handler 不可调用")
            if not isinstance(spec.parameters, dict):
                raise TypeError(f"工具 {spec.name} 的 parameters 必须是 JSON Schema 对象")
            self._specs[spec.name] = spec

    # -- basic accessors ----------------------------------------------------
    def get(self, name: str) -> ToolSpec:
        """Return a spec by name; raises ``KeyError`` when unknown."""
        try:
            return self._specs[str(name)]
        except KeyError:
            raise KeyError(str(name)) from None

    def has(self, name: str) -> bool:
        return str(name) in self._specs

    def names(self) -> list[str]:
        return list(self._specs)

    def specs(self) -> list[ToolSpec]:
        return list(self._specs.values())

    def register(self, spec: ToolSpec) -> None:
        """Add one tool spec (validated the same way as constructor input)."""
        if spec.name in self._specs:
            raise ValueError(f"重复的工具名称：{spec.name}")
        if not callable(spec.handler):
            raise TypeError(f"工具 {spec.name} 的 handler 不可调用")
        if not isinstance(spec.parameters, dict):
            raise TypeError(f"工具 {spec.name} 的 parameters 必须是 JSON Schema 对象")
        self._specs[spec.name] = spec

    def list_specs(self, toolsets: list[str] | None = None) -> list[dict[str, Any]]:
        """Return OpenAI-compatible tool declarations, filtered by toolset."""
        allowed = (
            {str(item).strip() for item in toolsets if str(item).strip()}
            if toolsets is not None
            else None
        )
        declarations: list[dict[str, Any]] = []
        for spec in self._specs.values():
            if allowed is not None and spec.toolset not in allowed:
                continue
            declarations.append(
                {
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": spec.parameters,
                    },
                }
            )
        return declarations

    # -- execution ----------------------------------------------------------
    async def execute(
        self,
        ctx: ToolContext,
        name: str,
        arguments: dict[str, Any] | None,
    ) -> ToolResult:
        """Validate, approve and run one tool call.

        This method never raises for tool-level failures; the loop receives a
        :class:`ToolResult` with ``ok=False`` and a user/model friendly error.
        """
        started = time.perf_counter()
        tool_call_id = f"call_{uuid.uuid4().hex[:8]}"
        tool_name = str(name or "")
        spec = self._specs.get(tool_name)
        if spec is None:
            available = "、".join(self._specs) if self._specs else "（无）"
            message = f"未知工具：{tool_name}"
            return ToolResult(
                tool_call_id=tool_call_id,
                name=tool_name,
                ok=False,
                content=f"错误：未知工具 '{tool_name}'。可用工具：{available}。",
                error=message,
                duration_ms=_elapsed_ms(started),
            )

        # Normalise arguments: the model sometimes emits a JSON string.
        args: dict[str, Any] = {}
        if isinstance(arguments, dict):
            args = arguments
        elif isinstance(arguments, str) and arguments.strip():
            try:
                parsed = json.loads(arguments)
                if isinstance(parsed, dict):
                    args = parsed
                else:
                    return _failure(spec, tool_call_id, started, "参数必须是 JSON 对象。")
            except ValueError as exc:
                return _failure(spec, tool_call_id, started, f"参数不是合法 JSON：{exc}")
        elif arguments is not None:
            return _failure(spec, tool_call_id, started, "参数必须是 JSON 对象。")

        platform = getattr(self, "platform", None)
        permission = None
        if platform is not None:
            try:
                permission = platform.permissions(ctx, spec)
            except ToolError as exc:
                return _failure(spec, tool_call_id, started, str(exc))
        # The platform's explicit ask policy cannot be bypassed by legacy auto mode.
        if permission == "ask" or (permission is None and spec.requires_approval):
            try:
                approver = ctx.ensure_approver()
                approved = await approver.request(
                    ctx,
                    spec.name,
                    args,
                    _approval_reason(spec, args),
                    **({"force_ask": True} if permission == "ask" else {}),
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - approver is defensive
                logger.exception("审批流程异常：%s", exc)
                return _failure(spec, tool_call_id, started, f"审批流程异常：{exc}")
            if not approved:
                return _failure(
                    spec,
                    tool_call_id,
                    started,
                    "用户拒绝了该操作（或审批超时）。请改用其他方式，或向用户说明需要该操作。",
                )

        try:
            ctx.check_cancelled()
        except ToolError as exc:
            return _failure(spec, tool_call_id, started, str(exc))

        try:
            if platform is not None and tool_name == 'write_file':
                scope = getattr(getattr(getattr(ctx, 'backend', None), 'workspace', None), 'workspace_id', 'ws_main')
                try:
                    await platform.snapshot(scope, str(args.get('path') or ''), getattr(ctx, 'run_id', ''), 'before-write')
                except (OSError, ValueError, RuntimeError):
                    pass  # A new or oversized file has no eligible snapshot.
            from .remote_tools import REMOTE_TOOLS, execute_remote
            backend = getattr(ctx, "backend", None)
            if platform is not None:
                result = await platform.execute_tool(ctx, spec, args)
            elif getattr(backend, "kind", None) == "ssh" and tool_name in REMOTE_TOOLS:
                result = await execute_remote(ctx, tool_name, args)
            else:
                result = await spec.handler(ctx, args)
            if platform is not None and tool_name == 'write_file' and result.ok:
                try:
                    await platform.snapshot(scope, str(args.get('path') or ''), getattr(ctx, 'run_id', ''), 'after-write')
                except Exception as exc:
                    platform.store.audit('artifact.snapshot_failed', {'error': str(exc)}, scope)
        except asyncio.CancelledError:
            raise
        except ToolError as exc:
            logger.info("工具 %s 失败：%s", spec.name, exc)
            return _failure(spec, tool_call_id, started, str(exc))
        except (ValueError, KeyError) as exc:
            logger.info("工具 %s 参数错误：%s", spec.name, exc)
            return _failure(spec, tool_call_id, started, str(exc))
        except Exception as exc:  # noqa: BLE001 - tool errors never escape
            logger.exception("工具 %s 执行异常", spec.name)
            message = f"工具执行失败：{exc}"
            return _failure(spec, tool_call_id, started, message)

        if not isinstance(result, ToolResult):
            logger.warning("工具 %s 返回了非 ToolResult 对象：%r", spec.name, type(result))
            result = ToolResult(
                tool_call_id=tool_call_id,
                name=spec.name,
                ok=True,
                content=str(result),
            )
        result.tool_call_id = result.tool_call_id or tool_call_id
        result.name = result.name or spec.name
        result.duration_ms = result.duration_ms or _elapsed_ms(started)
        if len(result.content) > MAX_TOOL_CONTENT:
            result.content = truncate(result.content, MAX_TOOL_CONTENT - 40)
        return result


def _failure(spec: ToolSpec, tool_call_id: str, started: float, message: str) -> ToolResult:
    return ToolResult(
        tool_call_id=tool_call_id,
        name=spec.name,
        ok=False,
        content=f"错误：{message}",
        error=message,
        duration_ms=_elapsed_ms(started),
    )


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


def _approval_reason(spec: ToolSpec, arguments: dict[str, Any]) -> str:
    """Human readable reason shown in the approval card."""
    if spec.name == "run_shell":
        command = truncate(str(arguments.get("command") or ""), 160)
        return f"即将在工作区执行 Shell 命令：{command}"
    if spec.name == "write_file":
        target = str(arguments.get("path") or "")
        content = arguments.get("content")
        size = human_size(len(str(content).encode("utf-8"))) if content is not None else "未知大小"
        return f"即将写入文件：{target}（{size}）"
    return f"工具 {spec.name} 需要用户确认后才能执行。"


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


def _arg_raw(arguments: dict[str, Any], key: str) -> Any:
    return arguments.get(key) if isinstance(arguments, dict) else None


def _arg_str(
    arguments: dict[str, Any],
    key: str,
    default: str | None = None,
    *,
    required: bool = False,
) -> str:
    value = _arg_raw(arguments, key)
    if value is None or value == "":
        if required:
            raise ToolError(f"缺少必填参数 `{key}`。")
        return default or ""
    if isinstance(value, (dict, list, tuple)):
        raise ToolError(f"参数 `{key}` 必须是字符串。")
    return str(value)


def _arg_opt_str(arguments: dict[str, Any], key: str) -> str | None:
    value = _arg_raw(arguments, key)
    if value is None or value == "":
        return None
    if isinstance(value, (dict, list, tuple)):
        raise ToolError(f"参数 `{key}` 必须是字符串。")
    return str(value)


def _arg_int(
    arguments: dict[str, Any],
    key: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    value = _arg_raw(arguments, key)
    if value is None or value == "":
        result = default
    elif isinstance(value, bool):
        raise ToolError(f"参数 `{key}` 必须是整数。")
    else:
        try:
            result = int(float(value)) if isinstance(value, str) else int(value)
        except (TypeError, ValueError):
            raise ToolError(f"参数 `{key}` 必须是整数。") from None
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _arg_float(
    arguments: dict[str, Any],
    key: str,
    default: float | None = None,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    value = _arg_raw(arguments, key)
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise ToolError(f"参数 `{key}` 必须是数字。")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ToolError(f"参数 `{key}` 必须是数字。") from None
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _parse_size(value: Any, default: int) -> int:
    """Parse ``max_bytes`` accepting ints, floats and ``"64KB"`` strings."""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(min(max(float(value), 0.0), MAX_READ_BYTES))
    text = str(value).strip().lower().replace(" ", "")
    units = (
        ("kib", 1024),
        ("kb", 1024),
        ("k", 1024),
        ("mib", 1024**2),
        ("mb", 1024**2),
        ("m", 1024**2),
        ("gib", 1024**3),
        ("gb", 1024**3),
        ("b", 1),
    )
    for suffix, factor in units:
        if text.endswith(suffix):
            number = text[: -len(suffix)]
            try:
                return int(min(max(float(number) * factor, 0.0), MAX_READ_BYTES))
            except ValueError:
                break
    try:
        return int(min(max(float(text), 0.0), MAX_READ_BYTES))
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# JSON Schema helpers
# ---------------------------------------------------------------------------


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required or []),
    }


def _prop(
    type_: str,
    description: str,
    **extra: Any,
) -> dict[str, Any]:
    prop: dict[str, Any] = {"type": type_, "description": description}
    prop.update(extra)
    return prop


# ---------------------------------------------------------------------------
# Handler: Python kernel
# ---------------------------------------------------------------------------


@dataclass
class _KernelRun:
    """Normalised result of one kernel execution."""

    text_parts: list[str]
    figures: list[dict[str, Any]]
    ok: bool
    error: str | None
    duration_ms: int
    execution_count: int | None
    interrupted: bool = False


async def _call_kernel_execute(
    kernel: Any,
    code: str,
    timeout_s: float | None,
    emit: Callable[[AgentEvent], Awaitable[None]] | None = None,
) -> Any:
    """Call ``kernel.execute`` tolerantly for async/sync implementations."""
    execute = getattr(kernel, "execute", None)
    if execute is None:
        raise ToolError("内核不支持 execute 方法，无法运行代码。")
    kwargs: dict[str, Any] = {}
    try:
        signature = inspect.signature(execute)
        params = signature.parameters
        if timeout_s is not None and "timeout_s" in params:
            kwargs["timeout_s"] = timeout_s
        if emit is not None and "emit" in params:
            kwargs["emit"] = emit
    except (TypeError, ValueError):  # pragma: no cover - C callables
        if timeout_s is not None:
            kwargs["timeout_s"] = timeout_s

    result = execute(code, **kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


def _normalise_kernel_result(result: Any) -> _KernelRun:
    """Convert a ``KernelService.execute`` payload into a uniform structure."""
    text_parts: list[str] = []
    figures: list[dict[str, Any]] = []
    ok = True
    error: str | None = None
    duration_ms = 0
    execution_count: int | None = None
    interrupted = False

    if isinstance(result, str):
        text_parts.append(result)
        return _KernelRun(text_parts, figures, True, None, 0, None)
    if not isinstance(result, dict):
        text_parts.append(str(result))
        return _KernelRun(text_parts, figures, True, None, 0, None)

    try:
        duration_ms = int(result.get("duration_ms") or 0)
    except (TypeError, ValueError):
        duration_ms = 0
    try:
        if result.get("execution_count") is not None:
            execution_count = int(result["execution_count"])
    except (TypeError, ValueError):
        execution_count = None
    interrupted = bool(result.get("interrupted"))
    if result.get("ok") is False and not interrupted:
        ok = False
    error = str(result.get("error")) if result.get("error") else None

    outputs = result.get("outputs") or []
    if isinstance(outputs, dict):
        outputs = [outputs]
    if isinstance(outputs, list):
        for item in outputs:
            if not isinstance(item, dict):
                text_parts.append(str(item))
                continue
            out_type = str(item.get("type") or item.get("output_type") or "stream")
            if out_type == "stream":
                text = _as_text(item.get("text"))
                if text:
                    text_parts.append(text)
            elif out_type in {"result", "display"}:
                text = _as_text(item.get("text"))
                if text:
                    text_parts.append(text)
            elif out_type == "image":
                figure = _figure_from_payload(item)
                if figure:
                    figures.append(figure)
            elif out_type == "error":
                ename = str(item.get("ename") or "Error")
                evalue = _as_text(item.get("evalue"))
                traceback_text = _as_text(item.get("traceback"))
                detail = f"{ename}: {evalue}".strip(": ")
                if traceback_text and traceback_text not in detail:
                    detail = f"{detail}\n{traceback_text}" if detail else traceback_text
                text_parts.append(detail)
                if not error:
                    error = detail
                ok = False

    raw_figures = result.get("figures") or []
    if isinstance(raw_figures, list):
        for raw in raw_figures:
            figure = _figure_from_payload(raw)
            if figure:
                figures.append(figure)

    if interrupted:
        ok = False
        error = error or "执行被中断。"
        text_parts.append("\n[内核] 执行被中断。")
    elif not ok and error and not any(error in part for part in text_parts):
        text_parts.append(error)

    return _KernelRun(text_parts, _dedupe_figures(figures), ok, error, duration_ms, execution_count, interrupted)


async def _run_code_collect(kernel: Any, code: str) -> str:
    """Fallback for kernels exposing only ``run_code_collect``."""
    collect = getattr(kernel, "run_code_collect", None)
    if collect is None:
        raise ToolError("当前内核不可用（缺少 execute / run_code_collect）。")
    result = collect(code)
    if inspect.isawaitable(result):
        result = await result
    return _as_text(result)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return "".join(_as_text(item) for item in value)
    return str(value)


def _figure_from_payload(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "")
    url = str(raw.get("url") or "")
    mime = str(raw.get("mime") or raw.get("mime_type") or "image/png")
    try:
        size = int(raw.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if not name and url:
        name = url.rstrip("/").rsplit("/", 1)[-1]
    if not name and not url:
        return None
    figure: dict[str, Any] = {"name": name, "url": url, "mime": mime, "size": size}
    return figure


def _dedupe_figures(figures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for figure in figures:
        key = str(figure.get("url") or "") + "\x00" + str(figure.get("name") or "")
        if key in seen:
            continue
        seen.add(key)
        unique.append(figure)
    return unique


def _figure_markdown(figures: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for index, figure in enumerate(figures, start=1):
        name = str(figure.get("name") or "")
        url = str(figure.get("url") or "")
        # Prefer the URL so the rendered message can show the image; the name
        # stays as the label because the model references figures by filename.
        target = url or name
        size = int(figure.get("size") or 0)
        label = name or f"figure_{index}"
        extra = f"（{figure.get('mime') or 'image/png'}，{human_size(size)}）" if size else ""
        lines.append(f"![{label}]({target}){extra}")
    return lines


async def _tool_run_python_code(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    code = _arg_str(arguments, "code", required=True)
    if not code.strip():
        raise ToolError("参数 `code` 不能为空。")
    timeout_s = _arg_float(arguments, "timeout_s", None, minimum=1.0, maximum=3600.0)
    kernel = ctx.kernel
    if kernel is None:
        raise ToolError("Python 内核尚未就绪，请稍后重试。")

    started = time.perf_counter()

    if not hasattr(kernel, "execute"):
        collected = await _run_code_collect(kernel, code)
        text = truncate(collected.strip(), MAX_TOOL_CONTENT - 200) if collected.strip() else "（无输出）"
        return ToolResult(
            tool_call_id="",
            name="run_python_code",
            ok=True,
            content=text,
            data={"figures": [], "execution_count": None, "duration_ms": _elapsed_ms(started)},
            duration_ms=_elapsed_ms(started),
        )

    raw = await _call_kernel_execute(kernel, code, timeout_s)
    run = _normalise_kernel_result(raw)
    duration_ms = run.duration_ms or _elapsed_ms(started)

    parts: list[str] = []
    output_text = "\n".join(part.rstrip("\n") for part in run.text_parts if part and part.strip())
    output_text = strip_ansi(output_text).strip()
    if output_text:
        parts.append(output_text)
    else:
        parts.append("（无输出）")

    figure_lines = _figure_markdown(run.figures)
    if figure_lines:
        parts.append("\n".join(figure_lines))

    status_text = "中断" if run.interrupted else ("成功" if run.ok else "失败")
    if run.execution_count is not None:
        header = f"[执行{status_text} | {duration_ms} ms | In [{run.execution_count}]]"
    else:
        header = f"[执行{status_text} | {duration_ms} ms]"
    content = header + "\n" + "\n\n".join(parts)
    if not run.ok and run.error:
        content += f"\n\n错误：{truncate(run.error, 2000)}"
    content = truncate(content, MAX_TOOL_CONTENT - 40)

    return ToolResult(
        tool_call_id="",
        name="run_python_code",
        ok=run.ok,
        content=content,
        data={
            "figures": run.figures,
            "execution_count": run.execution_count,
            "duration_ms": duration_ms,
            "interrupted": run.interrupted,
            "error": run.error,
        },
        error=run.error,
        duration_ms=duration_ms,
    )


# ---------------------------------------------------------------------------
# Handler: Shell
# ---------------------------------------------------------------------------


async def _tool_run_shell(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    command = _arg_str(arguments, "command", required=True).strip()
    if not command:
        raise ToolError("参数 `command` 不能为空。")
    cwd_value = _arg_opt_str(arguments, "cwd")
    default_timeout = float(getattr(ctx.settings, "shell_timeout_s", 120) or 120)
    timeout_s = _arg_float(
        arguments,
        "timeout",
        _arg_float(arguments, "timeout_s", default_timeout, minimum=1.0, maximum=3600.0),
        minimum=1.0,
        maximum=3600.0,
    )
    assert timeout_s is not None
    if not bool(getattr(ctx.settings, "allow_shell", True)):
        raise ToolError("当前配置禁用了 Shell 工具（settings.allow_shell=false）。")

    workdir = ctx.resolve_in_workspace(cwd_value or ".")
    if not workdir.exists():
        raise ToolError(f"工作目录不存在：{_display_path(workdir, ctx)}")
    if not workdir.is_dir():
        raise ToolError(f"cwd 不是目录：{_display_path(workdir, ctx)}")

    env = os.environ.copy()
    env["MPLBACKEND"] = env.get("MPLBACKEND", "Agg")
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("PYTHONIOENCODING", "utf-8")

    started = time.perf_counter()
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if create_no_window:
            kwargs["creationflags"] = create_no_window

    timed_out = False

    def _run_sync() -> tuple[int | None, bytes, bytes]:
        """Run the shell in a plain subprocess.

        ``asyncio`` subprocess support is not available on every event loop
        (Windows selector loops raise ``NotImplementedError``), so the shell
        runs in a worker thread instead.
        """
        nonlocal timed_out
        proc: subprocess.Popen[Any] | None = None
        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=str(workdir),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                **kwargs,
            )
            try:
                out, err = proc.communicate(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                timed_out = True
                _terminate_sync_process(proc)
                try:
                    out, err = proc.communicate(timeout=3.0)
                except (subprocess.TimeoutExpired, ValueError):
                    out, err = b"", b""
            return proc.returncode, out or b"", err or b""
        finally:
            if proc is not None and proc.poll() is None:  # pragma: no cover
                _terminate_sync_process(proc)

    try:
        exit_code, stdout_bytes, stderr_bytes = await asyncio.to_thread(_run_sync)
    except OSError as exc:
        raise ToolError(f"无法启动 Shell 进程：{exc}") from exc

    duration_ms = _elapsed_ms(started)
    stdout_text = strip_ansi(stdout_bytes.decode("utf-8", "replace")).strip()
    stderr_text = strip_ansi(stderr_bytes.decode("utf-8", "replace")).strip()

    parts: list[str] = []
    if stdout_text:
        parts.append(stdout_text)
    if stderr_text:
        parts.append("--- stderr ---\n" + stderr_text)
    if not parts:
        parts.append("（无输出）")
    content = "\n".join(parts)
    if timed_out:
        content += f"\n\n[超时] 命令超过 {timeout_s:.0f}s 未结束，已被终止。"
    content += f"\n[退出码 {exit_code}]"
    content = truncate(content, MAX_TOOL_CONTENT - 40)

    ok = (not timed_out) and exit_code == 0
    error: str | None = None
    if timed_out:
        error = f"命令执行超时（>{timeout_s:.0f}s），已终止。"
    elif exit_code != 0:
        error = f"命令退出码为 {exit_code}。"

    return ToolResult(
        tool_call_id="",
        name="run_shell",
        ok=ok,
        content=content,
        data={
            "command": command,
            "cwd": str(workdir),
            "exit_code": exit_code,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
        },
        error=error,
        duration_ms=duration_ms,
    )


def _terminate_sync_process(proc: "subprocess.Popen[Any] | None") -> None:
    """Terminate then kill a shell process (and its tree on Windows)."""
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        # Killing the shell alone can leave grandchildren running.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        proc.terminate()
    except (ProcessLookupError, OSError):
        return
    try:
        proc.wait(timeout=2.0)
        return
    except subprocess.TimeoutExpired:
        pass
    except OSError:  # pragma: no cover
        return
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        return
    try:
        proc.wait(timeout=2.0)
    except (subprocess.TimeoutExpired, OSError):  # pragma: no cover
        logger.warning("Shell 子进程未能被终止")


# ---------------------------------------------------------------------------
# Handlers: files
# ---------------------------------------------------------------------------


def _display_path(path: Path, ctx: ToolContext) -> str:
    """Workspace-relative POSIX path when possible, absolute otherwise."""
    try:
        return path.resolve().relative_to(ctx.workspace_root.resolve()).as_posix()
    except (ValueError, OSError):
        return str(path)


async def _tool_list_files(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    rel = _arg_str(arguments, "path", ".")
    depth = _arg_int(arguments, "depth", 1, minimum=1, maximum=8)
    root = ctx.resolve_in_workspace(rel)
    if not root.exists():
        raise ToolError(f"路径不存在：{_display_path(root, ctx)}")
    if root.is_file():
        stat = root.stat()
        rel_path = _display_path(root, ctx)
        return ToolResult(
            tool_call_id="",
            name="list_files",
            ok=True,
            content=f"{rel_path}（文件，{human_size(stat.st_size)}）",
            data={"path": rel_path, "entries": [{"path": rel_path, "type": "file", "size": stat.st_size}]},
        )

    entries: list[dict[str, Any]] = []
    truncated_flag = False

    def _walk(directory: Path, current_depth: int) -> None:
        nonlocal truncated_flag
        if current_depth > depth or truncated_flag:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
        except OSError as exc:
            logger.warning("无法列出目录 %s: %s", directory, exc)
            return
        for child in children:
            if len(entries) >= MAX_LIST_ENTRIES:
                truncated_flag = True
                return
            if child.name in _NOISE_DIRS:
                continue
            try:
                is_dir = child.is_dir()
                size = 0 if is_dir else child.stat().st_size
            except OSError:
                is_dir, size = False, 0
            entries.append(
                {
                    "path": _display_path(child, ctx),
                    "type": "dir" if is_dir else "file",
                    "size": size,
                }
            )
            if is_dir:
                _walk(child, current_depth + 1)

    _walk(root, 1)
    lines = [
        f"{item['path']}/" if item["type"] == "dir" else f"{item['path']}（{human_size(item['size'])}）"
        for item in entries
    ]
    if not lines:
        lines = ["（空目录）"]
    if truncated_flag:
        lines.append(f"…（目录项超过 {MAX_LIST_ENTRIES} 个，已截断；可缩小 path 或 depth）")
    header = f"{_display_path(root, ctx)}/（{len(entries)} 项，depth={depth}）"
    return ToolResult(
        tool_call_id="",
        name="list_files",
        ok=True,
        content=header + "\n" + "\n".join(lines),
        data={"path": _display_path(root, ctx), "entries": entries, "truncated": truncated_flag},
    )


async def _tool_read_file(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    rel = _arg_str(arguments, "path", required=True)
    max_bytes = _parse_size(_arg_raw(arguments, "max_bytes"), 200_000)
    target = ctx.resolve_in_workspace(rel)
    if not target.exists():
        raise ToolError(f"文件不存在：{_display_path(target, ctx)}")
    if not target.is_file():
        raise ToolError(f"不是普通文件：{_display_path(target, ctx)}（读取目录请用 list_files）")
    try:
        size = target.stat().st_size
    except OSError as exc:
        raise ToolError(f"无法读取文件信息：{exc}") from exc

    try:
        with open(target, "rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError as exc:
        raise ToolError(f"无法读取文件：{exc}") from exc
    truncated_flag = len(raw) > max_bytes
    raw = raw[:max_bytes]
    if b"\x00" in raw[:4096]:
        preview = raw[:200].hex()
        return ToolResult(
            tool_call_id="",
            name="read_file",
            ok=True,
            content=(
                f"（二进制文件，{human_size(size)}，不按文本显示；前 200 字节 hex）\n{preview}"
            ),
            data={"path": _display_path(target, ctx), "size": size, "binary": True},
        )

    text = raw.decode("utf-8", "replace")
    if truncated_flag:
        text += (
            f"\n…（文件较大，仅显示前 {max_bytes} 字节，共 {human_size(size)}；"
            "如需更多可增大参数 max_bytes）"
        )
    return ToolResult(
        tool_call_id="",
        name="read_file",
        ok=True,
        content=truncate(text, MAX_TOOL_CONTENT - 40),
        data={
            "path": _display_path(target, ctx),
            "size": size,
            "truncated": truncated_flag,
            "bytes_read": len(raw),
        },
    )


async def _tool_write_file(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    rel = _arg_str(arguments, "path", required=True)
    content = _arg_raw(arguments, "content")
    if content is None:
        raise ToolError("缺少必填参数 `content`。")
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False, indent=2)
    if not bool(getattr(ctx.settings, "allow_file_write", True)):
        raise ToolError("当前配置禁用了文件写入（settings.allow_file_write=false）。")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_BYTES:
        raise ToolError(
            f"写入内容过大（{human_size(len(encoded))}），单次上限为 {human_size(MAX_WRITE_BYTES)}。"
        )
    target = ctx.resolve_in_workspace(rel)
    existed = target.exists()
    if existed and target.is_dir():
        raise ToolError(f"目标是目录，不能写入文件：{_display_path(target, ctx)}")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, content)
    except OSError as exc:
        raise ToolError(f"写入文件失败：{exc}") from exc
    rel_path = _display_path(target, ctx)
    action = "已覆盖" if existed else "已创建"
    return ToolResult(
        tool_call_id="",
        name="write_file",
        ok=True,
        content=f"{action}文件 {rel_path}（{human_size(len(encoded))}）。",
        data={"path": rel_path, "bytes": len(encoded), "created": not existed},
    )


# ---------------------------------------------------------------------------
# Handlers: skills
# ---------------------------------------------------------------------------


async def _tool_skill_list(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    skills = getattr(ctx, "scoped_skills", None)
    if skills is None:
        skills = await asyncio.to_thread(load_skills, ctx.settings)
    if not skills:
        return ToolResult(
            tool_call_id="",
            name="skill_list",
            ok=True,
            content="当前没有可用技能。可以继续用 Python 工具直接分析。",
            data={"skills": []},
        )
    text = skills_catalog_text(skills)
    return ToolResult(
        tool_call_id="",
        name="skill_list",
        ok=True,
        content=truncate(text, MAX_TOOL_CONTENT - 40),
        data={"skills": [skill.to_dict() for skill in skills.values()]},
    )


async def _tool_skill_view(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    name = _arg_str(arguments, "name", required=True).strip()
    skills = getattr(ctx, "scoped_skills", None)
    if skills is None:
        skills = await asyncio.to_thread(load_skills, ctx.settings)
    skill = skills.get(name)
    if skill is None:
        # Accept the directory name as an alias, like ``skills.find_skill``.
        for candidate in skills.values():
            if candidate.path.parent.name == name:
                skill = candidate
                break
    if skill is None:
        available = "、".join(skills) if skills else "（无）"
        raise ToolError(f"未找到技能 '{name}'。可用技能：{available}")
    return ToolResult(
        tool_call_id="",
        name="skill_view",
        ok=True,
        content=truncate(skill_detail_text(skill), MAX_TOOL_CONTENT - 40),
        data={**skill.to_dict()},
    )


# ---------------------------------------------------------------------------
# Handlers: memory
# ---------------------------------------------------------------------------


async def _tool_memory_list(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    store = ctx.ensure_memory()
    items = await asyncio.to_thread(store.list)
    if not items:
        return ToolResult(
            tool_call_id="",
            name="memory_list",
            ok=True,
            content="（暂无长期记忆。可用 memory_create 记录项目约定、数据字典或结论。）",
            data={"memories": []},
        )
    lines = [f"长期记忆（{len(items)} 条，按更新时间倒序）："]
    for item in items:
        lines.append(
            f"- {item['slug']}: {item['title']}（{iso_from_ts(item['updated_at']) or '未知时间'}，"
            f"{human_size(item['size'])}）"
        )
    return ToolResult(
        tool_call_id="",
        name="memory_list",
        ok=True,
        content=truncate("\n".join(lines), MAX_TOOL_CONTENT - 40),
        data={"memories": items},
    )


async def _tool_memory_view(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    slug = _arg_str(arguments, "slug", required=True).strip()
    store = ctx.ensure_memory()
    try:
        item = await asyncio.to_thread(store.get, slug)
    except KeyError:
        raise ToolError(f"记忆 '{slug}' 不存在。先用 memory_list 查看可用条目。") from None
    except (MemoryError, OSError) as exc:
        raise ToolError(str(exc)) from exc
    content = (
        f"# {item['title']}\n"
        f"（slug: {item['slug']}，更新于 {iso_from_ts(item['updated_at']) or '未知'}）\n\n"
        f"{item['body']}"
    )
    return ToolResult(
        tool_call_id="",
        name="memory_view",
        ok=True,
        content=truncate(content, MAX_TOOL_CONTENT - 40),
        data={k: item[k] for k in ("slug", "title", "created_at", "updated_at", "size")},
    )


async def _tool_memory_create(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    slug = _arg_str(arguments, "slug", required=True).strip()
    title = _arg_str(arguments, "title", required=True).strip()
    body = _arg_str(arguments, "body", required=True)
    if not body.strip():
        raise ToolError("参数 `body` 不能为空。")
    if len(body.encode("utf-8")) > MEMORY_MAX_BODY_BYTES:
        raise ToolError(
            f"记忆正文过大（上限 {human_size(MEMORY_MAX_BODY_BYTES)}），请精简后再写入。"
        )
    store = ctx.ensure_memory()
    try:
        existing = await asyncio.to_thread(store.get, slug)
        del existing
    except KeyError:
        pass
    except (MemoryError, OSError) as exc:
        raise ToolError(str(exc)) from exc
    else:
        raise ToolError(f"记忆 '{slug}' 已存在。请用 memory_edit 修改，或换一个 slug。")
    try:
        item = await asyncio.to_thread(store.put, slug, title, body)
    except MemoryError as exc:
        raise ToolError(str(exc)) from exc
    return ToolResult(
        tool_call_id="",
        name="memory_create",
        ok=True,
        content=f"已创建记忆 '{item['slug']}'：{item['title']}（{human_size(item['size'])}）。",
        data={"slug": item["slug"], "title": item["title"], "size": item["size"]},
    )


async def _tool_memory_edit(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    slug = _arg_str(arguments, "slug", required=True).strip()
    title = _arg_opt_str(arguments, "title")
    body = _arg_opt_str(arguments, "body")
    if title is None and body is None:
        raise ToolError("至少需要提供 `title` 或 `body` 之一。")
    store = ctx.ensure_memory()
    try:
        existing = await asyncio.to_thread(store.get, slug)
    except KeyError:
        raise ToolError(f"记忆 '{slug}' 不存在。可用 memory_create 新建。") from None
    except (MemoryError, OSError) as exc:
        raise ToolError(str(exc)) from exc
    new_title = existing["title"] if title is None else title
    new_body = existing["body"] if body is None else body
    if len(new_body.encode("utf-8")) > MEMORY_MAX_BODY_BYTES:
        raise ToolError(
            f"记忆正文过大（上限 {human_size(MEMORY_MAX_BODY_BYTES)}），请精简后再写入。"
        )
    try:
        item = await asyncio.to_thread(store.put, slug, new_title, new_body)
    except MemoryError as exc:
        raise ToolError(str(exc)) from exc
    return ToolResult(
        tool_call_id="",
        name="memory_edit",
        ok=True,
        content=f"已更新记忆 '{item['slug']}'：{item['title']}（{human_size(item['size'])}）。",
        data={"slug": item["slug"], "title": item["title"], "size": item["size"]},
    )


# ---------------------------------------------------------------------------
# Handlers: agents
# ---------------------------------------------------------------------------


async def _tool_agent_list(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    category = _arg_opt_str(arguments, "category")
    agents = await asyncio.to_thread(load_agents, ctx.settings)
    filtered = {
        key: template
        for key, template in agents.items()
        if category is None or template.category == category
    }
    text = agents_catalog_text(filtered)
    if category is not None and not filtered:
        text = f"没有分类为 '{category}' 的智能体。\n\n" + agents_catalog_text(agents)
    return ToolResult(
        tool_call_id="",
        name="agent_list",
        ok=True,
        content=truncate(text, MAX_TOOL_CONTENT - 40),
        data={"agents": [template.to_dict() for template in filtered.values()], "category": category},
    )


async def _tool_delegate_agent(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    prompt = _arg_str(arguments, "prompt", required=True).strip()
    if not prompt:
        raise ToolError("参数 `prompt` 不能为空。")
    # Accept the common aliases models actually emit ("agent", "agent_name") so a
    # delegation never silently falls back to the lead agent.
    agent_id = (
        _arg_opt_str(arguments, "agent_id")
        or _arg_opt_str(arguments, "agent")
        or _arg_opt_str(arguments, "agent_name")
        or ""
    ).strip() or None
    agents = await asyncio.to_thread(load_agents, ctx.settings)
    if agent_id is not None and agent_id not in agents:
        available = "、".join(agents)
        raise ToolError(f"未知智能体 '{agent_id}'。可用智能体：{available}")

    # Preferred path: the loop injects a restricted sub-agent runner.
    run_sub = getattr(ctx, "run_sub", None)
    if callable(run_sub):
        result = run_sub(prompt, agent_id)
        if inspect.isawaitable(result):
            result = await result
        text = str(result or "").strip()
        if not text:
            text = "（子智能体没有返回内容）"
        text = truncate(text, MAX_TOOL_CONTENT - 200)
        return ToolResult(
            tool_call_id="",
            name="delegate_agent",
            ok=True,
            content=f"子智能体（{agent_id or 'lead'}）返回：\n{text}",
            data={"agent_id": agent_id or "lead", "mode": "subagent", "length": len(text)},
        )

    # Fallback: single-shot LLM call, documented in the tool description.
    template = get_agent(ctx.settings, agent_id or ctx.agent_id, agents)
    text = await _single_shot_completion(ctx, template, prompt)
    return ToolResult(
        tool_call_id="",
        name="delegate_agent",
        ok=True,
        content=f"子智能体（{template.id}）单轮回复：\n{text}",
        data={"agent_id": template.id, "mode": "single_shot", "length": len(text)},
    )


def _resolve_llm_callable() -> Callable[..., Any] | None:
    """Best-effort lookup of the provider chat entry point."""
    import importlib

    for module_name in (
        "omicslab.agent.providers",
        "omicslab.agent.providers.base",
        "omicslab.agent.providers.client",
    ):
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        except Exception:  # pragma: no cover - import side effects
            logger.warning("导入 %s 失败", module_name, exc_info=True)
            continue
        for attribute in ("chat", "acomplete", "complete", "acompletion", "call_llm"):
            candidate = getattr(module, attribute, None)
            if callable(candidate):
                return candidate
    return None


async def _single_shot_completion(
    ctx: ToolContext,
    template: AgentTemplate,
    prompt: str,
) -> str:
    """Run one LLM completion with the target agent's instructions.

    This fallback exists only when the loop does not inject ``run_sub``; it
    performs a *single* model call and therefore cannot use tools. The
    docstring of ``delegate_agent`` tells the model this limitation.
    """
    callable_ = _resolve_llm_callable()
    if callable_ is None:
        raise ToolError(
            "当前运行时未提供子智能体执行器（run_sub），也无法访问 LLM 客户端，因此无法委派。"
            "请直接自己完成任务，或让用户通过界面切换到该智能体。"
        )
    messages = [
        {"role": "system", "content": template.instructions},
        {"role": "user", "content": prompt},
    ]

    async def _call() -> Any:
        if inspect.iscoroutinefunction(callable_):
            try:
                return await callable_(messages, ctx.settings)
            except TypeError:
                return await callable_(messages=messages, settings=ctx.settings)
        try:
            return await asyncio.to_thread(callable_, messages, ctx.settings)
        except TypeError:
            return await asyncio.to_thread(
                lambda: callable_(messages=messages, settings=ctx.settings)
            )

    try:
        result = await _call()
    except Exception as exc:  # pragma: no cover - provider failure path
        logger.warning("委派单轮 LLM 调用失败: %s", exc)
        raise ToolError(f"调用 LLM 失败：{exc}") from exc
    return truncate(_extract_chat_text(result), MAX_TOOL_CONTENT - 200)


def _extract_chat_text(result: Any) -> str:
    """Extract assistant text from common provider response shapes."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        choices = result.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict):
                    return _as_text(message.get("content"))
                if message is not None:
                    return _as_text(getattr(message, "content", message))
                return _as_text(first.get("text"))
        for key in ("content", "text", "output", "response"):
            if key in result:
                return _as_text(result[key])
        return json.dumps(result, ensure_ascii=False)[:4000]
    return _as_text(getattr(result, "content", result))


# ---------------------------------------------------------------------------
# Handlers: background jobs
# ---------------------------------------------------------------------------


async def _tool_submit_background_job(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    kind = (_arg_opt_str(arguments, "kind") or "python").strip().lower()
    if kind in {"py", "python"}:
        kind = "python"
    elif kind in {"shell", "bash", "cmd", "sh"}:
        kind = "shell"
    else:
        raise ToolError("参数 `kind` 仅支持 'python' 或 'shell'。")
    code = _arg_opt_str(arguments, "code") or _arg_opt_str(arguments, "command") or ""
    if not code.strip():
        raise ToolError("缺少任务代码：python 任务用 `code`，shell 任务用 `command` 或 `code`。")
    if kind == "shell" and not bool(getattr(ctx.settings, "allow_shell", True)):
        raise ToolError("当前配置禁用了 Shell 工具，无法提交 shell 后台任务。")
    name = _arg_opt_str(arguments, "name") or ""
    jobs = ctx.ensure_jobs()
    try:
        snapshot = await asyncio.to_thread(jobs.submit, kind, code, name)
    except (ValueError, ConfigError) as exc:
        raise ToolError(str(exc)) from exc
    return ToolResult(
        tool_call_id="",
        name="submit_background_job",
        ok=True,
        content=(
            f"已提交后台任务 {snapshot['id']}（{snapshot['name']}，类型 {snapshot['kind']}）。"
            "可用 job_status 查询进度与日志。"
        ),
        data={"job": snapshot},
    )


async def _tool_job_status(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    jobs = ctx.ensure_jobs()
    jid = _arg_opt_str(arguments, "job_id")
    tail = _arg_int(arguments, "tail", 4000, minimum=0, maximum=20_000)
    if not jid:
        snapshots = await asyncio.to_thread(jobs.list)
        if not snapshots:
            return ToolResult(
                tool_call_id="",
                name="job_status",
                ok=True,
                content="当前没有后台任务。",
                data={"jobs": []},
            )
        lines = [f"后台任务（{len(snapshots)} 个）："]
        for item in snapshots:
            lines.append(
                f"- {item['id']} [{item['status']}] {item['name']}"
                f"（{item['kind']}，{human_size(item['log_bytes'])} 日志）"
            )
        return ToolResult(
            tool_call_id="",
            name="job_status",
            ok=True,
            content="\n".join(lines),
            data={"jobs": snapshots},
        )

    try:
        snapshot = await asyncio.to_thread(jobs.get, jid)
        log_payload = await asyncio.to_thread(jobs.log, jid, 0, tail)
    except KeyError:
        raise ToolError(f"后台任务 '{jid}' 不存在。可省略 job_id 查看全部任务。") from None

    lines = [
        f"任务 {snapshot['id']}：{snapshot['name']}",
        f"状态：{snapshot['status']}，类型：{snapshot['kind']}，退出码：{snapshot['exit_code']}",
    ]
    if snapshot.get("started_at"):
        lines.append(f"开始：{iso_from_ts(snapshot['started_at'])}")
    if snapshot.get("ended_at"):
        lines.append(f"结束：{iso_from_ts(snapshot['ended_at'])}")
    log_text = str(log_payload.get("text") or "").strip()
    lines.append("日志：" + ("（空）" if not log_text else ""))
    content = "\n".join(lines) + ("\n" + log_text if log_text else "")
    return ToolResult(
        tool_call_id="",
        name="job_status",
        ok=True,
        content=truncate(content, MAX_TOOL_CONTENT - 40),
        data={"job": snapshot, "log": log_payload},
    )


# ---------------------------------------------------------------------------
# Handlers: system / notebook
# ---------------------------------------------------------------------------


async def _tool_get_system_info(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    settings = ctx.settings
    workspace = ctx.workspace_root
    info: dict[str, Any] = {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "cpu_count": os.cpu_count(),
        "workspace": str(workspace),
        "home": str(settings.home),
        "approval_policy": getattr(settings, "approval_policy", "auto"),
        "allow_shell": bool(getattr(settings, "allow_shell", True)),
        "allow_file_write": bool(getattr(settings, "allow_file_write", True)),
        "agent": ctx.agent_id,
        "conversation_id": ctx.conversation_id,
        "now": iso_now(),
    }
    try:
        usage = shutil.disk_usage(str(workspace))
        info["disk"] = {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "total_human": human_size(usage.total),
            "free_human": human_size(usage.free),
        }
    except OSError:
        info["disk"] = None

    kernel = ctx.kernel
    kernel_info: Any = None
    if kernel is not None:
        raw_info = getattr(kernel, "info", None)
        if raw_info is not None:
            try:
                raw_info = raw_info() if callable(raw_info) else raw_info
                if inspect.isawaitable(raw_info):
                    raw_info = await raw_info
                kernel_info = raw_info if isinstance(raw_info, dict) else _as_text(raw_info)
            except Exception as exc:  # pragma: no cover - kernel may be restarting
                kernel_info = f"（获取内核信息失败：{exc}）"
        else:
            status = getattr(kernel, "status", None)
            kernel_info = {"status": _as_text(status)} if status is not None else {"status": "unknown"}
    info["kernel"] = kernel_info or {"status": "unavailable"}

    try:
        skills = await asyncio.to_thread(load_skills, settings)
        info["skills_count"] = len(skills)
    except Exception:  # pragma: no cover - defensive
        info["skills_count"] = None
    try:
        agents = await asyncio.to_thread(load_agents, settings)
        info["agents_count"] = len(agents)
    except Exception:  # pragma: no cover - defensive
        info["agents_count"] = None
    try:
        jobs_snapshot = await asyncio.to_thread(ctx.ensure_jobs().list)
        info["jobs_running"] = sum(1 for item in jobs_snapshot if item.get("status") == "running")
        info["jobs_total"] = len(jobs_snapshot)
    except Exception:  # pragma: no cover - defensive
        info["jobs_running"] = None
        info["jobs_total"] = None

    lines = [
        "## 系统信息",
        f"- 平台：{info['platform']}",
        f"- Python：{info['python']}（{info['python_executable']}）",
        f"- CPU 核心：{info['cpu_count']}",
        f"- 工作区：{info['workspace']}",
        f"- 用户目录：{info['home']}",
        f"- 审批策略：{info['approval_policy']}；Shell：{'开' if info['allow_shell'] else '关'}；"
        f"文件写入：{'开' if info['allow_file_write'] else '关'}",
        f"- 智能体：{info['agent']}；会话：{info['conversation_id'] or '（无）'}",
        f"- 技能数：{info['skills_count']}；智能体模板数：{info['agents_count']}",
        f"- 后台任务：运行中 {info['jobs_running']} / 共 {info['jobs_total']}",
    ]
    if info["disk"]:
        lines.append(
            f"- 磁盘：剩余 {info['disk']['free_human']} / 共 {info['disk']['total_human']}"
        )
    lines.append(f"- 内核：{json.dumps(info['kernel'], ensure_ascii=False, default=str)[:600]}")
    return ToolResult(
        tool_call_id="",
        name="get_system_info",
        ok=True,
        content="\n".join(lines),
        data=info,
    )


async def _tool_export_notebook(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    rel = _arg_opt_str(arguments, "path")
    if not rel:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        rel = f"notebooks/omicslab_export_{stamp}.ipynb"
    target = ctx.resolve_in_workspace(rel)
    kernel = ctx.kernel
    notebook: dict[str, Any] | None = None

    build_notebook = getattr(kernel, "build_notebook", None) if kernel is not None else None
    if callable(build_notebook):
        try:
            candidate = build_notebook()
            if inspect.isawaitable(candidate):
                candidate = await candidate
            if isinstance(candidate, dict) and candidate.get("cells") is not None:
                notebook = candidate
            else:
                logger.warning("kernel.build_notebook() 返回了非 notebook 对象：%r", type(candidate))
        except Exception as exc:  # pragma: no cover - kernel-side failure
            logger.warning("kernel.build_notebook() 失败，回退到历史构建: %s", exc)

    if notebook is None:
        notebook = _build_notebook_from_history(kernel)

    try:
        text = json.dumps(notebook, ensure_ascii=False, indent=1)
    except (TypeError, ValueError):
        text = json.dumps(notebook, ensure_ascii=False, indent=1, default=str)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, text)
    except OSError as exc:
        raise ToolError(f"写入 Notebook 失败：{exc}") from exc

    cell_count = len(notebook.get("cells") or [])
    rel_path = _display_path(target, ctx)
    return ToolResult(
        tool_call_id="",
        name="export_notebook",
        ok=True,
        content=f"已导出 Notebook：{rel_path}（{cell_count} 个 cell，{human_size(len(text.encode('utf-8')))}）。",
        data={"path": rel_path, "cells": cell_count, "bytes": len(text.encode("utf-8"))},
    )


def _build_notebook_from_history(kernel: Any) -> dict[str, Any]:
    """Minimal nbformat 4.5 document built from ``kernel.history``."""
    history = getattr(kernel, "history", None) if kernel is not None else None
    cells: list[dict[str, Any]] = []
    if isinstance(history, list):
        for index, entry in enumerate(history, start=1):
            if not isinstance(entry, dict):
                continue
            code = _as_text(entry.get("code"))
            outputs = _convert_outputs(entry.get("outputs"))
            outputs.extend(_convert_history_figures(entry.get("figures")))
            cells.append(
                {
                    "cell_type": "code",
                    "execution_count": index,
                    "id": f"cell-{index}",
                    "metadata": {},
                    "outputs": outputs,
                    "source": code.splitlines(keepends=True) or [""],
                }
            )
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _convert_history_figures(raw_figures: Any) -> list[dict[str, Any]]:
    """Render kernel history figures as nbformat ``display_data`` outputs.

    Only a text reference is emitted because the image lives on disk and the
    notebook keeps a stable relative path instead of inlined base64 data.
    """
    converted: list[dict[str, Any]] = []
    if not isinstance(raw_figures, list):
        return converted
    for raw in raw_figures:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "")
        url = str(raw.get("url") or "")
        reference = " ".join(part for part in (name, url) if part)
        if not reference:
            continue
        converted.append(
            {
                "output_type": "display_data",
                "data": {"text/plain": f"[figure] {reference}"},
                "metadata": {},
            }
        )
    return converted


def _convert_outputs(raw_outputs: Any) -> list[dict[str, Any]]:
    """Convert kernel output dicts into nbformat output dicts (best effort)."""
    converted: list[dict[str, Any]] = []
    if not isinstance(raw_outputs, list):
        return converted
    for raw in raw_outputs:
        if not isinstance(raw, dict):
            continue
        out_type = str(raw.get("type") or raw.get("output_type") or "stream")
        if out_type == "stream":
            converted.append(
                {
                    "output_type": "stream",
                    "name": str(raw.get("name") or "stdout"),
                    "text": _as_text(raw.get("text")),
                }
            )
        elif out_type in {"result", "display"}:
            text = _as_text(raw.get("text"))
            data: dict[str, Any] = {"text/plain": text} if text else {}
            if not data:
                continue
            output: dict[str, Any] = {
                "output_type": "execute_result" if out_type == "result" else "display_data",
                "data": data,
                "metadata": {},
            }
            if out_type == "result":
                output["execution_count"] = raw.get("execution_count")
            converted.append(output)
        elif out_type == "image":
            url = str(raw.get("url") or "")
            name = str(raw.get("name") or "")
            converted.append(
                {
                    "output_type": "display_data",
                    "data": {"text/plain": f"[figure] {name or url}".strip()},
                    "metadata": {},
                }
            )
        elif out_type == "error":
            converted.append(
                {
                    "output_type": "error",
                    "ename": str(raw.get("ename") or "Error"),
                    "evalue": _as_text(raw.get("evalue")),
                    "traceback": [
                        line
                        for line in _as_text(raw.get("traceback")).splitlines()
                        if line.strip()
                    ],
                }
            )
    return converted


# ---------------------------------------------------------------------------
# Specification catalogue
# ---------------------------------------------------------------------------


def build_default_specs() -> list[ToolSpec]:
    """Return every built-in tool specification in presentation order."""
    specs: list[ToolSpec] = [
        ToolSpec(
            name="run_python_code",
            description=(
                "在持久化的 Python 内核中执行代码并返回文本输出和图表。"
                "内核变量在会话内保留，可复用之前创建的变量（例如 adata）。"
                "绘图请保存到 figures/ 目录。"
            ),
            parameters=_schema(
                {
                    "code": _prop("string", "要执行的 Python 代码。"),
                    "timeout_s": _prop(
                        "number",
                        "可选超时秒数（默认使用服务端内核超时设置）。",
                        minimum=1,
                        maximum=3600,
                    ),
                },
                required=["code"],
            ),
            toolset="python",
            handler=_tool_run_python_code,
        ),
        ToolSpec(
            name="run_shell",
            description=(
                "在工作区目录执行 Shell/PowerShell 命令并返回输出。"
                "需要用户批准；非零退出码会以 ok=false 返回。"
            ),
            parameters=_schema(
                {
                    "command": _prop("string", "要执行的 Shell 命令。"),
                    "cwd": _prop("string", "可选工作目录（相对工作区，默认工作区根目录）。"),
                    "timeout": _prop("number", "可选超时秒数，默认 120。", minimum=1, maximum=3600),
                },
                required=["command"],
            ),
            toolset="shell",
            handler=_tool_run_shell,
            requires_approval=True,
        ),
        ToolSpec(
            name="list_files",
            description="列出工作区内的文件与目录（默认只列一层）。",
            parameters=_schema(
                {
                    "path": _prop("string", "相对工作区的路径，默认 '.'。"),
                    "depth": _prop("integer", "递归深度 1-8，默认 1。", minimum=1, maximum=8),
                },
            ),
            toolset="files",
            handler=_tool_list_files,
        ),
        ToolSpec(
            name="read_file",
            description="读取工作区内文本文件的内容（默认最多 200KB）。",
            parameters=_schema(
                {
                    "path": _prop("string", "相对工作区的文件路径。"),
                    "max_bytes": _prop(
                        "integer",
                        "最多读取的字节数，默认 200000，上限 8388608。",
                        minimum=0,
                    ),
                },
                required=["path"],
            ),
            toolset="files",
            handler=_tool_read_file,
        ),
        ToolSpec(
            name="write_file",
            description="把文本写入工作区内的文件（覆盖旧内容）。需要用户批准。",
            parameters=_schema(
                {
                    "path": _prop("string", "相对工作区的目标文件路径。"),
                    "content": _prop("string", "要写入的完整文本内容。"),
                },
                required=["path", "content"],
            ),
            toolset="files",
            handler=_tool_write_file,
            requires_approval=True,
        ),
        ToolSpec(
            name="skill_list",
            description="列出所有可用的领域技能（SKILL.md 指南）及其适用场景。",
            parameters=_schema({}),
            toolset="skills",
            handler=_tool_skill_list,
        ),
        ToolSpec(
            name="skill_view",
            description="查看某个技能的完整指南（步骤、脚本约定、注意事项）。",
            parameters=_schema(
                {"name": _prop("string", "技能名称（见 skill_list）。")},
                required=["name"],
            ),
            toolset="skills",
            handler=_tool_skill_view,
        ),
        ToolSpec(
            name="memory_list",
            description="列出长期记忆条目（项目约定、数据字典、既往结论）。",
            parameters=_schema({}),
            toolset="memory",
            handler=_tool_memory_list,
        ),
        ToolSpec(
            name="memory_view",
            description="查看一条长期记忆的完整正文。",
            parameters=_schema(
                {"slug": _prop("string", "记忆标识（见 memory_list）。")},
                required=["slug"],
            ),
            toolset="memory",
            handler=_tool_memory_view,
        ),
        ToolSpec(
            name="memory_create",
            description="新建一条长期记忆（适用于跨会话需要保留的事实与约定）。",
            parameters=_schema(
                {
                    "slug": _prop("string", "标识，仅字母/数字/下划线/短横线，1-64 字符。"),
                    "title": _prop("string", "标题。"),
                    "body": _prop("string", "Markdown 正文，不超过 64KB。"),
                },
                required=["slug", "title", "body"],
            ),
            toolset="memory",
            handler=_tool_memory_create,
        ),
        ToolSpec(
            name="memory_edit",
            description="修改一条已有长期记忆的标题或正文。",
            parameters=_schema(
                {
                    "slug": _prop("string", "记忆标识。"),
                    "title": _prop("string", "可选，新标题。"),
                    "body": _prop("string", "可选，新正文（覆盖旧正文）。"),
                },
                required=["slug"],
            ),
            toolset="memory",
            handler=_tool_memory_edit,
        ),
        ToolSpec(
            name="agent_list",
            description="列出可用智能体及其职责，用于了解可委派的对象。",
            parameters=_schema({"category": _prop("string", "可选分类过滤。")}),
            toolset="agents",
            handler=_tool_agent_list,
        ),
        ToolSpec(
            name="delegate_agent",
            description=(
                "把一段子任务委派给另一个智能体执行，并返回其最终文本。"
                "在支持 run_sub 的运行时中子智能体拥有完整工具；"
                "否则退化为单轮 LLM 回复（不能调用工具）。"
            ),
            parameters=_schema(
                {
                    "prompt": _prop("string", "交给子智能体的自包含任务说明。"),
                    "agent_id": _prop("string", "目标智能体 id（见 agent_list），默认 lead。"),
                },
                required=["prompt"],
            ),
            toolset="agents",
            handler=_tool_delegate_agent,
        ),
        ToolSpec(
            name="submit_background_job",
            description=(
                "提交后台任务（独立进程，不阻塞对话）。python 任务在全新解释器中运行，"
                "不共享交互内核变量；日志写入 jobs 目录。"
            ),
            parameters=_schema(
                {
                    "kind": _prop("string", "任务类型：python 或 shell。", enum=["python", "shell"]),
                    "code": _prop("string", "python 代码，或 shell 命令。"),
                    "name": _prop("string", "可选任务名称。"),
                },
                required=["kind", "code"],
            ),
            toolset="jobs",
            handler=_tool_submit_background_job,
        ),
        ToolSpec(
            name="job_status",
            description="查询后台任务状态与日志；省略 job_id 时列出全部任务。",
            parameters=_schema(
                {
                    "job_id": _prop("string", "可选任务 id（形如 j_1a2b3c4d）。"),
                    "tail": _prop(
                        "integer",
                        "返回日志末尾的最大字符数，默认 4000。",
                        minimum=0,
                        maximum=20000,
                    ),
                },
            ),
            toolset="jobs",
            handler=_tool_job_status,
        ),
        ToolSpec(
            name="get_system_info",
            description="查看运行环境、工作区路径、内核/技能/任务等系统信息。",
            parameters=_schema({}),
            toolset="system",
            handler=_tool_get_system_info,
        ),
        ToolSpec(
            name="export_notebook",
            description="把当前内核的执行历史导出为 Jupyter Notebook（.ipynb）。",
            parameters=_schema(
                {
                    "path": _prop(
                        "string",
                        "可选输出路径（相对工作区），默认 notebooks/omicslab_export_<时间>.ipynb。",
                    )
                },
            ),
            toolset="notebook",
            handler=_tool_export_notebook,
        ),
    ]
    return specs


def build_registry(settings: Settings) -> ToolRegistry:
    """Build the default registry plus optional stage-2 tool packs.

    Each extra pack lives in its own package so the feature modules stay
    independently testable; a broken/optional pack must never break the agent
    loop, therefore every registration is isolated and logged.
    """
    registry = ToolRegistry(build_default_specs())
    extra_registrars = (
        ("omicslab.registry.tools", "register_registry_tools"),
        ("omicslab.agent.vision_tools", "register_vision_tools"),
        ("omicslab.discovery.tools", "register_discovery_tools"),
        ("omicslab.ssh.tools", "register_ssh_tools"),
    )
    for module_name, attr in extra_registrars:
        try:
            module = importlib.import_module(module_name)
            register = getattr(module, attr)
            register(registry, settings)
        except ImportError:
            continue
        except Exception:  # pragma: no cover - optional pack must not break core
            logger.exception("注册可选工具包失败：%s", module_name)
    return registry


__all__ = [
    "MAX_TOOL_CONTENT",
    "ToolContext",
    "ToolRegistry",
    "ToolSpec",
    "build_default_specs",
    "build_registry",
]
