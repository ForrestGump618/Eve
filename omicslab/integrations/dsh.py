"""DeepSeek Harness (DSH) bridge: headless stdio control plane for SuWen.

素问 SuWen 原本只有两种入口：``suwen serve``（FastAPI Web 工作台，需要
fastapi/uvicorn）和 ``suwen cli``（终端交互）。DSH 插件需要一个可以被
Node 宿主进程长期持有、按需启动、可流式读取事件、可取消的进程内 API，
因此本模块提供一个最小的 NDJSON-over-stdio 协议实现：

* 一行一个 UTF-8 JSON 对象，``stdin`` 进 ``stdout`` 出；
* stdout 在启动时被重定向到 stderr，因此任何第三方库的 ``print`` /
  warnings 都不会污染协议流（``stderr`` 留给日志，插件会自行收集）；
* 请求/响应 + 服务端事件（``kind: "event"``）两条流，事件复用 SuWen 内部
  的 :class:`omicslab.agent.types.AgentEvent` 结构（type/data/ts）；
* 复用 :class:`omicslab.server.state.AppState` 与 ``AgentLoop``，与
  Web 工作台共享同一套会话库、内核、技能、记忆与发现台账；
* 不依赖 FastAPI，可以用最小 Python 环境运行。

协议版本：``suwen-dsh/1``。

请求帧::

    {"id": "req-1", "op": "status", "params": {...}}

响应帧::

    {"id": "req-1", "ok": true, "result": {...}}
    {"id": "req-1", "ok": false, "error": {"code": "...", "message": "..."}}

事件帧::

    {"kind": "event", "id": "req-1", "seq": 3, "ts": 1712.0,
     "event": {"type": "text", "data": {...}, "ts": 1711.9}}

支持的操作见 :data:`OPS`。长任务（``run`` / ``discovery.run``）同一时刻只
允许一个，用 ``cancel`` 取消；其余操作（``status``/``skills``/...）可以并发。
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
import json
import logging
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

from .. import __app_name__, __version__
from ..agent.types import AgentCancelled, AgentEvent

PROTOCOL = "suwen-dsh/1"

#: 单行请求上限（8 MiB）。超过则返回 ``request_too_large``。
MAX_REQUEST_BYTES = 8 * 1024 * 1024

#: 单个事件帧的序列化上限（字符）。超过时截断字符串字段，插件仍可用
#: ``transcript`` 读取完整会话消息。
MAX_EVENT_CHARS = 400_000

#: 长任务超时（毫秒）默认值，0 表示不设上限。
DEFAULT_TURN_TIMEOUT_MS = 0

#: 取消后等待 agent 优雅退出的时间（秒）。
CANCEL_GRACE_S = 15.0

#: 退出时等待 AppState.shutdown 的时间（秒）。
SHUTDOWN_TIMEOUT_S = 20.0


class _TurnTimeout(Exception):
    """内部信号：长任务超时且已尽力取消，由调用方翻译成对外错误。"""


async def _settle_task(task: "asyncio.Task[Any]", timeout_ms: int, cancel_event: asyncio.Event, grace_s: float = CANCEL_GRACE_S) -> Any:
    """等待长任务；超时时先协作取消，再给 CANCEL_GRACE_S 收尾。

    不能用 ``asyncio.wait_for(task, ...)``：它超时会立刻取消 ``task``，随后再 await
    同一个 task 会抛 ``CancelledError``（BaseException），绕过普通异常处理，把真实
    的超时误报成"取消"。``asyncio.wait`` 只等待、不取消，因此可以保留协作取消窗口。
    """
    if timeout_ms:
        done, _ = await asyncio.wait({task}, timeout=timeout_ms / 1000)
        if not done:
            cancel_event.set()
            done, _ = await asyncio.wait({task}, timeout=grace_s)
            if not done:
                task.cancel()
                try:
                    await task
                except BaseException:  # noqa: BLE001 - 取消后的收尾，异常不再外抛
                    pass
                raise _TurnTimeout(f"超过 {timeout_ms / 1000:.0f}s 未完成")
    return await task

#: 全部支持的操作（``hello`` 帧会原样返回给客户端）。
OPS: tuple[str, ...] = (
    "hello",
    "ping",
    "status",
    "skills",
    "skill",
    "agents",
    "tools",
    "conversations",
    "transcript",
    "run",
    "run.start",
    "run.status",
    "cancel",
    "approval.resolve",
    "discovery.list",
    "discovery.create",
    "discovery.status",
    "discovery.report",
    "discovery.run",
    "shutdown",
)

_APPROVAL_MODES = ("auto", "client", "deny")


class BridgeError(Exception):
    """带错误码的协议级错误；会被转换成 ``ok: false`` 响应。"""

    def __init__(self, code: str, message: str, *, hint: str = "", details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.details = details

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            payload["hint"] = self.hint
        if self.details is not None:
            payload["details"] = _jsonable(self.details)
        return payload


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------
def _jsonable(value: Any) -> Any:
    """把 dataclass / Path / ``to_dict()`` 对象转成可 JSON 序列化的结构。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: _jsonable(getattr(value, field.name)) for field in dataclasses.fields(value)}
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        try:
            return _jsonable(to_dict())
        except Exception:  # pragma: no cover - defensive
            pass
    if hasattr(value, "__dict__"):
        return {k: _jsonable(v) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def _shrink(value: Any, *, max_str: int = 120_000, max_items: int = 500) -> Any:
    """限制单帧大小：超长字符串截断、超长数组截断，并标记 ``_truncated``。"""
    if isinstance(value, str):
        if len(value) > max_str:
            return value[:max_str] + f"\n…[truncated {len(value) - max_str} chars]"
        return value
    if isinstance(value, dict):
        return {k: _shrink(v, max_str=max_str, max_items=max_items) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        items = [_shrink(v, max_str=max_str, max_items=max_items) for v in list(value)[:max_items]]
        if len(value) > max_items:
            items.append({"_truncated": True, "omitted": len(value) - max_items})
        return items
    return value


def _event_payload(event: Any) -> dict[str, Any]:
    """把 AgentEvent 或任意事件对象转成 ``{"type","data","ts"}``。"""
    if isinstance(event, AgentEvent):
        return _jsonable(event.to_dict())
    if isinstance(event, dict):
        return _jsonable(dict(event))
    to_dict = getattr(event, "to_dict", None)
    if callable(to_dict):
        try:
            return _jsonable(to_dict())
        except Exception:  # pragma: no cover - defensive
            pass
    return {"type": "status", "data": {"message": str(event)}, "ts": time.time()}


def _have(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


# ---------------------------------------------------------------------------
# bridge
# ---------------------------------------------------------------------------
class DshBridge:
    """一个 stdio NDJSON 会话。由 :func:`serve_stdio` 创建并运行。"""

    def __init__(
        self,
        *,
        workspace: str | None = None,
        home: str | None = None,
        approval: str = "auto",
        log_level: str = "WARNING",
    ) -> None:
        if approval not in _APPROVAL_MODES:
            raise ValueError(f"approval 只能是 {_APPROVAL_MODES} 之一，收到 {approval!r}")
        self._workspace_arg = workspace
        self._home_arg = home
        self._approval = approval
        self._log_level = str(log_level or "WARNING").upper()

        self._settings: Any = None
        self._state: Any = None
        self._state_lock = asyncio.Lock()
        self._last_conversation: str | None = None

        self._out: Any = None
        self._seq = 0
        self._tasks: set[asyncio.Task[Any]] = set()
        self._active: dict[str, Any] | None = None
        # 异步轮次（run.start / run.status）：让 DSH 侧把一次研究轮次当作
        # 「提交任务 + 轮询结果」，从而不受单次工具调用超时限制。
        self._turns: dict[str, dict[str, Any]] = {}
        self._turn_seq = 0
        self._last_turn: str | None = None
        self._shutdown_event: asyncio.Event | None = None
        # 超时后等待 agent 协作退出的秒数；测试可调小以免等待 15s。
        self._cancel_grace_s = CANCEL_GRACE_S
        self._started_at = time.time()
        self._stopping = False

    # -- output ---------------------------------------------------------
    def _write(self, payload: dict[str, Any]) -> None:
        if self._out is None or self._stopping:
            return
        try:
            data = json.dumps(payload, ensure_ascii=False, default=str)
            self._out.write((data + "\n").encode("utf-8"))
        except (BrokenPipeError, OSError):  # pragma: no cover - parent gone
            self._stopping = True
            if self._shutdown_event is not None:
                self._shutdown_event.set()

    def _write_event(self, req_id: Any, event: dict[str, Any]) -> None:
        self._seq += 1
        payload = _shrink(event)
        try:
            size = len(json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:  # pragma: no cover - defensive
            size = 0
        if size > MAX_EVENT_CHARS:
            payload = _shrink(payload, max_str=20_000, max_items=100)
            payload = {"_oversized": size, **payload}
        self._write({"kind": "event", "id": req_id, "seq": self._seq, "ts": time.time(), "event": payload})

    # -- settings / state ----------------------------------------------
    async def _settings_obj(self) -> Any:
        if self._settings is not None:
            return self._settings
        from ..config import load_settings

        settings = load_settings(workspace=self._workspace_arg, home=self._home_arg)
        settings.ensure_dirs()
        self._settings = settings
        return settings

    async def _state_obj(self) -> Any:
        if self._state is not None:
            return self._state
        async with self._state_lock:
            if self._state is not None:
                return self._state
            settings = await self._settings_obj()
            from ..server.state import AppState

            state = await AppState.create(settings)
            self._state = state
            logging.getLogger("omicslab.dsh").info(
                "AppState ready: workspace=%s home=%s", settings.workspace, settings.home
            )
            return state

    async def _skills_map(self) -> dict[str, Any]:
        if self._state is not None:
            return self._state.skills
        from ..agent.skills import load_skills

        return load_skills(await self._settings_obj())

    async def _agents_map(self) -> dict[str, Any]:
        if self._state is not None:
            return self._state.agents
        from ..agent.templates import load_agents

        return load_agents(await self._settings_obj())

    # -- helpers --------------------------------------------------------
    def _active_summary(self) -> dict[str, Any] | None:
        active = self._active
        if active is None:
            return None
        return {
            "kind": active["kind"],
            "requestId": active["req_id"],
            "elapsedMs": int((time.time() - active["started"]) * 1000),
        }

    async def _long(self, req_id: Any, kind: str, work: Callable[[asyncio.Event], Any]) -> Any:
        if self._active is not None:
            raise BridgeError(
                "busy",
                f"另一个长任务正在执行：{self._active['kind']}",
                hint="先调用 op=cancel 取消当前任务，再重试。",
            )
        cancel_event = asyncio.Event()
        self._active = {"req_id": req_id, "kind": kind, "started": time.time(), "cancel": cancel_event}
        try:
            return await work(cancel_event)
        finally:
            self._active = None

    def _make_emitter(
        self,
        req_id: Any,
        state: Any,
        approval_mode: str,
        *,
        counters: dict[str, int],
        stream: bool = True,
    ) -> Callable[[Any], Awaitable[None]]:
        """构造一个 emit 回调：写事件、统计用量、自动或转发审批。

        SuWen 的 ``EventSink`` 是协程（``Callable[[AgentEvent], Awaitable[None]]``），
        因此这里必须返回 ``async def``，否则 ``await emit(event)`` 会在
        ``NoneType`` 上报错。

        ``stream=False`` 时只统计不发送事件帧（``run.start`` 的异步轮次用，
        避免事件帧挂在一个已经结束的请求 id 上）。
        """

        async def emit(event: Any) -> None:
            payload = _event_payload(event)
            etype = str(payload.get("type") or "")
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            if etype == "approval_request":
                approval_id = data.get("id")
                payload["data"] = dict(data)
                if approval_mode == "client":
                    payload["data"]["mode"] = "client"
                    payload["data"]["pending"] = True
                else:
                    approved = approval_mode == "auto"
                    resolved = False
                    if approval_id:
                        try:
                            resolved = bool(state.approver.resolve(approval_id, approved))
                        except Exception:  # pragma: no cover - defensive
                            logging.getLogger("omicslab.dsh").debug("resolve approval failed", exc_info=True)
                    payload["data"]["mode"] = approval_mode
                    payload["data"]["approved"] = approved
                    payload["data"]["resolved"] = resolved
            elif etype == "usage":
                usage = data.get("usage") if isinstance(data.get("usage"), dict) else data
                counters["usage_events"] = counters.get("usage_events", 0) + 1
                if isinstance(usage, dict):
                    counters["last_usage"] = usage  # type: ignore[assignment]
            elif etype == "tool_call":
                counters["tool_calls"] = counters.get("tool_calls", 0) + 1
            elif etype == "tool_result":
                counters["tool_results"] = counters.get("tool_results", 0) + 1
            elif etype == "figure":
                counters["figures"] = counters.get("figures", 0) + 1
            elif etype == "text":
                counters["text_events"] = counters.get("text_events", 0) + 1
            counters["events"] = counters.get("events", 0) + 1
            if stream:
                self._write_event(req_id, payload)

        return emit

    async def _await_long_task(self, task: asyncio.Task[Any], cancel_event: asyncio.Event, timeout_ms: int) -> Any:
        """等待长任务；超时后先请求取消，再给 CANCEL_GRACE_S 优雅收尾。"""
        try:
            return await _settle_task(task, timeout_ms, cancel_event, self._cancel_grace_s)
        except _TurnTimeout:
            raise BridgeError(
                "timeout",
                f"任务超过 {timeout_ms / 1000:.0f}s 未完成，已请求取消",
                hint="缩短 prompt 范围，或在插件配置中调大 timeoutSeconds。",
            ) from None

    # -- ops: metadata --------------------------------------------------
    async def _op_hello(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        settings = await self._settings_obj()
        return {
            "protocol": PROTOCOL,
            "bridge": "suwen-dsh",
            "app": __app_name__,
            "version": __version__,
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "platform": sys.platform,
            "pid": os.getpid(),
            "cwd": os.getcwd(),
            "workspace": str(settings.workspace),
            "home": str(settings.home),
            "approval": self._approval,
            "ops": list(OPS),
            "missing": [name for name in ("fastapi", "uvicorn") if not _have(name)],
        }

    async def _op_ping(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        return {"pong": True, "ts": time.time(), "uptimeMs": int((time.time() - self._started_at) * 1000)}

    def _settings_summary(self, settings: Any) -> dict[str, Any]:
        return {
            "provider": getattr(settings, "provider", ""),
            "model": getattr(settings, "model", ""),
            "api_base": getattr(settings, "api_base", ""),
            "approval_policy": getattr(settings, "approval_policy", ""),
            "max_iterations": getattr(settings, "max_iterations", 0),
            "language": getattr(settings, "language", ""),
            "default_agent": getattr(settings, "default_agent", ""),
            "workspace": str(getattr(settings, "workspace", "")),
            "home": str(getattr(settings, "home", "")),
        }

    async def _op_status(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        settings = await self._settings_obj()
        result: dict[str, Any] = {
            "ok": True,
            "version": __version__,
            "app": __app_name__,
            "protocol": PROTOCOL,
            "workspace": str(settings.workspace),
            "home": str(settings.home),
            "settings": self._settings_summary(settings),
            "state": "cold",
            "approval": self._approval,
            "active": self._active_summary(),
            "turns": {
                "tracked": len(self._turns),
                "running": [turn_id for turn_id, turn in self._turns.items() if turn["status"] == "running"],
                "last": self._last_turn,
            },
            "python": sys.version.split()[0],
            "missing": [name for name in ("fastapi", "uvicorn") if not _have(name)],
        }
        if bool(params.get("light")):
            return result
        try:
            state = await self._state_obj()
        except Exception as exc:  # noqa: BLE001 - 状态冷启动失败也要可诊断
            logging.getLogger("omicslab.dsh").warning("AppState cold start failed: %s", exc)
            result["state"] = "error"
            result["ok"] = False
            result["error"] = {"code": "state_start_failed", "message": str(exc), "traceback": traceback.format_exc()[-4000:]}
            return result
        result["state"] = "ready"
        try:
            result["health"] = _jsonable(state.health())
        except Exception as exc:  # pragma: no cover - defensive
            result["health"] = {"ok": False, "error": str(exc)}
        try:
            result["llm"] = _jsonable(state.llm_info())
            result["vision"] = _jsonable(state.vision_info())
        except Exception:  # pragma: no cover - defensive
            pass
        result["agents"] = len(getattr(state, "agents", {}) or {})
        result["skills"] = len(getattr(state, "skills", {}) or {})
        try:
            result["tools"] = list(state.registry.names())
        except Exception:  # pragma: no cover - defensive
            result["tools"] = []
        result["startup_error"] = getattr(state, "startup_error", "")
        try:
            projects = state.discovery_store.list_projects() or []
            result["discovery"] = {"count": len(projects), "projects": [_jsonable(p) for p in projects[:20]]}
        except Exception:  # pragma: no cover - defensive
            result["discovery"] = {"count": 0, "projects": []}
        return result

    async def _op_skills(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        skills = await self._skills_map()
        items = [_jsonable(skill.to_dict()) for skill in skills.values()]
        items.sort(key=lambda item: str(item.get("name", "")))
        return {"count": len(items), "skills": items, "state": "ready" if self._state is not None else "cold"}

    async def _op_skill(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        if not name:
            raise BridgeError("invalid_request", "缺少参数 name")
        skills = await self._skills_map()
        skill = skills.get(name)
        if skill is None:
            raise BridgeError("not_found", f"技能不存在：{name}", hint="先调用 skills 列出全部技能。")
        payload = _jsonable(skill.to_dict())
        payload["body"] = skill.body
        payload["files"] = list(skill.files)
        return {"skill": payload}

    async def _op_agents(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        agents = await self._agents_map()
        items = [_jsonable(agent.to_dict()) for agent in agents.values()]
        items.sort(key=lambda item: str(item.get("id", "")))
        return {"count": len(items), "agents": items, "state": "ready" if self._state is not None else "cold"}

    async def _op_tools(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        state = await self._state_obj()
        items: list[dict[str, Any]] = []
        try:
            specs = state.registry.specs()
        except Exception:  # pragma: no cover - defensive
            specs = []
        for spec in specs or []:
            items.append(
                {
                    "name": getattr(spec, "name", ""),
                    "description": getattr(spec, "description", ""),
                    "toolset": getattr(spec, "toolset", ""),
                    "requiresApproval": bool(getattr(spec, "requires_approval", False)),
                }
            )
        return {"count": len(items), "tools": items}

    # -- ops: conversations --------------------------------------------
    async def _op_conversations(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        state = await self._state_obj()
        limit = max(1, min(int(params.get("limit") or 20), 200))
        conversations = state.store.list() or []
        items = [_jsonable(item) for item in conversations[:limit]]
        return {"count": len(items), "total": len(conversations), "last": self._last_conversation, "conversations": items}

    async def _op_transcript(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        from ..session.store import ConversationNotFound

        state = await self._state_obj()
        conversation_id = str(params.get("conversationId") or self._last_conversation or "").strip()
        if not conversation_id:
            raise BridgeError("invalid_request", "缺少参数 conversationId，且当前没有最近会话")
        try:
            conv = state.store.get(conversation_id)
        except ConversationNotFound as exc:
            raise BridgeError("not_found", f"会话不存在：{conversation_id}", details=str(exc)) from exc
        offset = max(0, int(params.get("offset") or 0))
        limit = max(1, min(int(params.get("limit") or 100), 500))
        messages = [_jsonable(message.to_dict()) for message in conv.messages[offset : offset + limit]]
        return {
            "conversation": _jsonable(conv.summary()),
            "total": len(conv.messages),
            "offset": offset,
            "count": len(messages),
            "messages": messages,
        }

    # -- ops: long tasks -----------------------------------------------
    async def _prepare_turn(self, params: dict[str, Any], req_id: Any, *, stream: bool) -> dict[str, Any]:
        """校验一轮请求，返回可直接执行的轮次运行器（``run`` / ``run.start`` 共用）。"""
        prompt = str(params.get("prompt") or "").strip()
        if not prompt:
            raise BridgeError("invalid_request", "缺少参数 prompt")
        approval_mode = str(params.get("approval") or self._approval)
        if approval_mode not in _APPROVAL_MODES:
            raise BridgeError("invalid_request", f"approval 只能是 {_APPROVAL_MODES} 之一")
        timeout_ms = int(params.get("timeoutMs") or DEFAULT_TURN_TIMEOUT_MS)
        agent_id = str(params.get("agentId") or "").strip() or None
        provider = str(params.get("provider") or "").strip() or None
        model = str(params.get("model") or "").strip() or None
        from ..session.store import ConversationNotFound

        state = await self._state_obj()

        conv = None
        conversation_id = str(params.get("conversationId") or "").strip() or None
        if conversation_id:
            try:
                conv = state.store.get(conversation_id)
            except ConversationNotFound as exc:
                raise BridgeError("not_found", f"会话不存在：{conversation_id}", details=str(exc)) from exc
        if conv is None:
            title = str(params.get("title") or "").strip()
            conv = state.store.create(agent=agent_id or getattr(state.settings, "default_agent", "lead"), title=title)
        self._last_conversation = conv.id

        started = time.time()
        counters: dict[str, Any] = {}
        emit = self._make_emitter(req_id, state, approval_mode, counters=counters, stream=stream)

        async def run_turn(cancel_event: asyncio.Event) -> dict[str, Any]:
            coro = state.loop.run(
                conv,
                prompt,
                emit=emit,
                cancel_event=cancel_event,
                approver=state.approver,
                agent_id=agent_id,
                provider=provider,
                model=model,
            )
            task = asyncio.ensure_future(coro)
            timed_out = False
            try:
                if timeout_ms:
                    try:
                        result = await _settle_task(task, timeout_ms, cancel_event, self._cancel_grace_s)
                    except _TurnTimeout:
                        timed_out = True
                        result = {
                            "finish_reason": "timeout",
                            "error": {"code": "timeout", "message": f"本轮超过 {timeout_ms / 1000:.0f}s 未完成，已请求取消"},
                        }
                else:
                    result = await task
            except asyncio.CancelledError:
                result = {"finish_reason": "cancelled", "stop_reason": {"code": "cancelled", "message": "用户取消"}}
            except AgentCancelled:
                result = {"finish_reason": "cancelled", "stop_reason": {"code": "cancelled", "message": "用户取消"}}
            except Exception as exc:  # noqa: BLE001 - 一轮失败不应终止桥接
                logging.getLogger("omicslab.dsh").warning("turn failed", exc_info=True)
                result = {"finish_reason": "error", "error": {"code": "turn_error", "message": str(exc)}}
            if not isinstance(result, dict):
                result = {"finish_reason": "error", "error": {"code": "bad_result", "message": str(result)}}
            payload = _jsonable(result)
            payload.update(
                {
                    "conversationId": conv.id,
                    "conversationTitle": conv.title,
                    "agent": getattr(conv, "agent", None),
                    "toolCalls": counters.get("tool_calls", 0),
                    "toolResults": counters.get("tool_results", 0),
                    "figures": counters.get("figures", 0),
                    "events": counters.get("events", 0),
                    "usage": counters.get("last_usage"),
                    "durationMs": int((time.time() - started) * 1000),
                    "timedOut": timed_out,
                    "messages": len(conv.messages),
                    "sessionId": params.get("sessionId"),
                }
            )
            return payload

        return {
            "prompt": prompt,
            "conversationId": conv.id,
            "conversationTitle": conv.title,
            "agent": getattr(conv, "agent", None),
            "run": run_turn,
        }

    async def _op_run(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        """同步执行一轮：事件边跑边发，最终返回结果（客户端需保持请求打开）。"""
        prepared = await self._prepare_turn(params, req_id, stream=True)
        return await self._long(req_id, "run", prepared["run"])

    async def _op_run_start(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        """提交一轮研究（不等待完成）：立即返回 ``turnId``，由 ``run.status`` 轮询。"""
        if self._active is not None:
            raise BridgeError(
                "busy",
                f"另一个长任务正在执行：{self._active['kind']}",
                hint="先调用 op=cancel 取消当前任务，再重试。",
            )
        prepared = await self._prepare_turn(params, req_id, stream=bool(params.get("stream")))
        self._turn_seq += 1
        turn_id = f"t{self._turn_seq:06d}"
        cancel_event = asyncio.Event()
        self._active = {"req_id": req_id, "kind": "run", "started": time.time(), "cancel": cancel_event}
        record: dict[str, Any] = {
            "id": turn_id,
            "requestId": req_id,
            "started": time.time(),
            "finishedAt": None,
            "cancel": cancel_event,
            "conversationId": prepared["conversationId"],
            "conversationTitle": prepared["conversationTitle"],
            "agent": prepared["agent"],
            "status": "running",
            "result": None,
            "error": None,
            "task": None,
        }
        self._turns[turn_id] = record
        self._last_turn = turn_id
        task = asyncio.ensure_future(prepared["run"](cancel_event))
        record["task"] = task
        self._tasks.add(task)

        def _finish(done: asyncio.Task[Any]) -> None:
            self._tasks.discard(done)
            try:
                if done.cancelled():
                    record["status"] = "cancelled"
                    record["error"] = {"code": "cancelled", "message": "轮次已取消"}
                else:
                    exc = done.exception()
                    if exc is not None:
                        record["status"] = "error"
                        record["error"] = {"code": "turn_error", "message": str(exc)}
                        logging.getLogger("omicslab.dsh").warning("async turn failed: %s", exc, exc_info=exc)
                    else:
                        record["status"] = "done"
                        record["result"] = _jsonable(done.result())
            finally:
                record["finishedAt"] = time.time()
                if self._active is not None and self._active.get("req_id") == req_id:
                    self._active = None
                self._prune_turns()

        task.add_done_callback(_finish)
        return {
            "turnId": turn_id,
            "status": "running",
            "conversationId": prepared["conversationId"],
            "conversationTitle": prepared["conversationTitle"],
            "agent": prepared["agent"],
            "startedAt": record["started"],
            "pollWith": "run.status",
        }

    def _prune_turns(self) -> None:
        """只保留最近 20 个已结束轮次，避免长期运行内存增长。"""
        if len(self._turns) <= 20:
            return
        finished = [(turn["started"], turn_id) for turn_id, turn in self._turns.items() if turn["status"] != "running"]
        finished.sort()
        for _started, turn_id in finished[: max(0, len(self._turns) - 20)]:
            self._turns.pop(turn_id, None)

    async def _op_run_status(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        """查询异步轮次：``waitMs>0`` 时最多等待那么久，适合「长轮询」。"""
        turn_id = str(params.get("turnId") or params.get("turn_id") or "").strip() or self._last_turn
        if not turn_id:
            raise BridgeError("invalid_request", "缺少参数 turnId（先调用 run.start 提交一轮）")
        record = self._turns.get(turn_id)
        if record is None:
            raise BridgeError(
                "not_found",
                f"轮次不存在：{turn_id}",
                hint="异步轮次只保存在当前桥接进程内存中；进程重启后请用 transcript 读取历史消息。",
            )
        wait_ms = max(0, min(int(params.get("waitMs") or 0), 600_000))
        task = record.get("task")
        if wait_ms and record["status"] == "running" and isinstance(task, asyncio.Task):
            try:
                await asyncio.wait_for(asyncio.shield(task), wait_ms / 1000)
            except asyncio.TimeoutError:
                pass
            except Exception:  # noqa: BLE001 - 轮次错误已记录在 record 中
                pass
        out: dict[str, Any] = {
            "turnId": turn_id,
            "status": record["status"],
            "conversationId": record.get("conversationId"),
            "conversationTitle": record.get("conversationTitle"),
            "agent": record.get("agent"),
            "elapsedMs": int(((record.get("finishedAt") or time.time()) - record["started"]) * 1000),
            "requestId": record.get("requestId"),
        }
        result = record.get("result")
        if isinstance(result, dict):
            out["result"] = result
            out["text"] = result.get("text")
            out["finishReason"] = result.get("finish_reason")
            out["usage"] = result.get("usage")
            out["timedOut"] = bool(result.get("timedOut"))
        if record["status"] in ("error", "cancelled"):
            out["error"] = record.get("error") or {"code": record["status"], "message": record["status"]}
        return out

    async def _op_cancel(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        active = self._active
        if active is None:
            return {"cancelled": False, "reason": "没有正在执行的长任务"}
        active["cancel"].set()
        logging.getLogger("omicslab.dsh").info("cancel requested for %s", active["kind"])
        return {
            "cancelled": True,
            "kind": active["kind"],
            "requestId": active["req_id"],
            "elapsedMs": int((time.time() - active["started"]) * 1000),
        }

    async def _op_approval_resolve(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        approval_id = str(params.get("id") or params.get("approvalId") or "").strip()
        if not approval_id:
            raise BridgeError("invalid_request", "缺少参数 id（approval_request.id）")
        approved = bool(params.get("approved"))
        reason = str(params.get("reason") or "").strip()
        state = await self._state_obj()
        try:
            resolved = bool(state.approver.resolve(approval_id, approved))
        except Exception as exc:  # pragma: no cover - defensive
            raise BridgeError("resolve_failed", f"审批请求处理失败：{exc}") from exc
        return {"id": approval_id, "approved": approved, "resolved": resolved, "reason": reason}

    # -- ops: discovery -------------------------------------------------
    async def _discovery_project(self, params: dict[str, Any]) -> tuple[Any, Any]:
        project_id = str(params.get("projectId") or params.get("project_id") or "").strip()
        if not project_id:
            raise BridgeError("invalid_request", "缺少参数 projectId")
        state = await self._state_obj()
        project = state.discovery_store.get(project_id)
        if project is None:
            raise BridgeError("not_found", f"发现项目不存在：{project_id}", hint="先调用 discovery.create 或 discovery.list。")
        return state, project

    async def _op_discovery_list(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        state = await self._state_obj()
        projects = state.discovery_store.list_projects() or []
        items = [_jsonable(project) for project in projects]
        return {"count": len(items), "projects": items}

    async def _op_discovery_create(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        objective = str(params.get("objective") or "").strip()
        if not objective:
            raise BridgeError("invalid_request", "缺少参数 objective（可检验的研究目标）")
        state = await self._state_obj()
        data_hints = params.get("dataHints") or params.get("data_hints") or []
        if isinstance(data_hints, str):
            data_hints = [chunk.strip() for chunk in data_hints.split(",") if chunk.strip()]
        if not isinstance(data_hints, list):
            data_hints = []
        project = state.discovery_store.create(
            title=str(params.get("title") or "").strip(),
            objective=objective,
            domain=str(params.get("domain") or "biomedicine"),
            agent=str(params.get("agent") or "lead"),
            data_hints=[str(item) for item in data_hints],
            max_rounds=int(params.get("maxRounds") or 3),
            budget_minutes=int(params.get("budgetMinutes") or 30),
        )
        return {"project": _jsonable(project)}

    async def _op_discovery_status(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        state, project = await self._discovery_project(params)
        snapshot = state.discovery_store.snapshot(project.id) or {}
        return {
            "project": _jsonable(project),
            "hypotheses": _jsonable(snapshot.get("hypotheses", [])),
            "evidence": _jsonable(snapshot.get("evidence", [])),
            "insights": _jsonable(snapshot.get("insights", [])),
        }

    async def _op_discovery_report(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        _state, project = await self._discovery_project(params)
        report = ""
        try:
            raw = _state.discovery_store.read_report(project.id)
            if raw is not None:
                report = raw if isinstance(raw, str) else str(raw)
        except Exception as exc:  # noqa: BLE001 - 报告尚未生成是正常状态
            raise BridgeError("not_found", f"项目报告尚未生成：{exc}", hint="先运行 discovery.run 生成报告。") from exc
        max_chars = max(1000, min(int(params.get("maxChars") or 120_000), 400_000))
        return {
            "projectId": project.id,
            "chars": len(report),
            "truncated": len(report) > max_chars,
            "content": report[:max_chars],
        }

    async def _op_discovery_run(self, params: dict[str, Any], req_id: Any) -> dict[str, Any]:
        state, project = await self._discovery_project(params)
        approval_mode = str(params.get("approval") or self._approval)
        if approval_mode not in _APPROVAL_MODES:
            raise BridgeError("invalid_request", f"approval 只能是 {_APPROVAL_MODES} 之一")
        timeout_ms = int(params.get("timeoutMs") or 0)
        started = time.time()
        counters: dict[str, Any] = {}
        emit = self._make_emitter(req_id, state, approval_mode, counters=counters)

        async def work(cancel_event: asyncio.Event) -> dict[str, Any]:
            coro = state.discovery_engine.run(
                project.id,
                emit=emit,
                cancel_event=cancel_event,
                approver=state.approver,
            )
            task = asyncio.ensure_future(coro)
            timed_out = False
            try:
                if timeout_ms:
                    try:
                        result = await _settle_task(task, timeout_ms, cancel_event, self._cancel_grace_s)
                    except _TurnTimeout:
                        timed_out = True
                        result = {"status": "timeout", "error": f"超过 {timeout_ms / 1000:.0f}s 未完成"}
                else:
                    result = await task
            except asyncio.CancelledError:
                result = {"status": "cancelled"}
            except AgentCancelled:
                result = {"status": "cancelled"}
            except Exception as exc:  # noqa: BLE001
                logging.getLogger("omicslab.dsh").warning("discovery run failed", exc_info=True)
                result = {"status": "error", "error": str(exc)}
            if not isinstance(result, dict):
                result = {"status": "error", "error": str(result)}
            payload = _jsonable(result)
            payload.update(
                {
                    "projectId": project.id,
                    "events": counters.get("events", 0),
                    "toolCalls": counters.get("tool_calls", 0),
                    "durationMs": int((time.time() - started) * 1000),
                    "timedOut": timed_out,
                }
            )
            return payload

        return await self._long(req_id, "discovery.run", work)

    # -- dispatch -------------------------------------------------------
    async def _call(self, op: str, params: dict[str, Any], req_id: Any) -> Any:
        handlers: dict[str, Callable[[dict[str, Any], Any], Any]] = {
            "hello": self._op_hello,
            "ping": self._op_ping,
            "status": self._op_status,
            "skills": self._op_skills,
            "skill": self._op_skill,
            "agents": self._op_agents,
            "tools": self._op_tools,
            "conversations": self._op_conversations,
            "transcript": self._op_transcript,
            "run": self._op_run,
            "run.start": self._op_run_start,
            "run.status": self._op_run_status,
            "cancel": self._op_cancel,
            "approval.resolve": self._op_approval_resolve,
            "discovery.list": self._op_discovery_list,
            "discovery.create": self._op_discovery_create,
            "discovery.status": self._op_discovery_status,
            "discovery.report": self._op_discovery_report,
            "discovery.run": self._op_discovery_run,
        }
        handler = handlers.get(op)
        if handler is None:
            raise BridgeError(
                "unknown_op",
                f"未知操作：{op}",
                hint=f"支持的操作：{', '.join(OPS)}",
            )
        return await handler(params, req_id)

    async def _execute(self, req_id: Any, op: str, params: dict[str, Any]) -> None:
        try:
            result = await self._call(op, params, req_id)
            self._write({"id": req_id, "op": op, "ok": True, "result": _jsonable(result)})
        except BridgeError as exc:
            self._write({"id": req_id, "op": op, "ok": False, "error": exc.to_payload()})
        except asyncio.CancelledError:  # pragma: no cover - 由 _drain 触发
            raise
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成协议错误
            logging.getLogger("omicslab.dsh").error("op %s failed: %s", op, exc, exc_info=True)
            self._write(
                {
                    "id": req_id,
                    "op": op,
                    "ok": False,
                    "error": {
                        "code": "internal_error",
                        "message": str(exc),
                        "traceback": traceback.format_exc()[-4000:],
                    },
                }
            )

    async def _dispatch_raw(self, raw: bytes) -> None:
        raw = raw.strip()
        if not raw:
            return
        if len(raw) > MAX_REQUEST_BYTES:
            self._write(
                {
                    "id": None,
                    "ok": False,
                    "error": {"code": "request_too_large", "message": f"请求超过 {MAX_REQUEST_BYTES} 字节"},
                }
            )
            return
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self._write(
                {
                    "id": None,
                    "ok": False,
                    "error": {"code": "bad_json", "message": f"无法解析请求 JSON：{exc}"},
                }
            )
            return
        if not isinstance(request, dict):
            self._write({"id": None, "ok": False, "error": {"code": "bad_request", "message": "请求必须是 JSON 对象"}})
            return
        req_id = request.get("id")
        op = str(request.get("op") or "").strip()
        params = request.get("params") or {}
        if not op:
            self._write({"id": req_id, "ok": False, "error": {"code": "bad_request", "message": "缺少 op 字段"}})
            return
        if not isinstance(params, dict):
            self._write({"id": req_id, "ok": False, "error": {"code": "bad_request", "message": "params 必须是 JSON 对象"}})
            return
        if op == "shutdown":
            self._write({"id": req_id, "ok": True, "result": {"shutdown": True, "uptimeMs": int((time.time() - self._started_at) * 1000)}})
            if self._shutdown_event is not None:
                self._shutdown_event.set()
            return
        task = asyncio.ensure_future(self._execute(req_id, op, params))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # -- lifecycle ------------------------------------------------------
    async def _drain(self) -> None:
        active = self._active
        if active is not None:
            active["cancel"].set()
        for turn in list(self._turns.values()):
            cancel = turn.get("cancel")
            if isinstance(cancel, asyncio.Event):
                cancel.set()
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._close_state()

    async def _close_state(self) -> None:
        state = self._state
        self._state = None
        if state is None:
            return
        try:
            await asyncio.wait_for(state.shutdown(), SHUTDOWN_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - 退出时尽力而为
            logging.getLogger("omicslab.dsh").warning("state shutdown failed", exc_info=True)

    async def run(self) -> int:
        """启动 stdio 服务循环，返回进程退出码。"""
        # 先把真正的 stdout 保存下来，再把 fd 1 指向 stderr：任何库的 print
        # 都只会进日志，不会破坏 NDJSON 协议流。
        try:
            self._out = os.fdopen(os.dup(1), "wb", buffering=0)
            os.dup2(2, 1)
            try:
                sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover
                pass
        except OSError:  # pragma: no cover - 非常规环境（无 fd）
            self._out = getattr(sys.stdout, "buffer", None)

        _setup_logging(self._log_level)
        self._shutdown_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()

        fd = _stdin_fd()
        if fd is None:  # pragma: no cover - 无 fd 的嵌入环境回退到文本读行
            stdin = getattr(sys.stdin, "buffer", None) or sys.stdin

            def reader() -> None:
                try:
                    while True:
                        chunk = stdin.readline(MAX_REQUEST_BYTES + 1)
                        if not chunk:
                            break
                        loop.call_soon_threadsafe(queue.put_nowait, ("line", chunk))
                except Exception:  # pragma: no cover - 父进程关闭管道
                    logging.getLogger("omicslab.dsh").debug("stdin reader stopped", exc_info=True)
                finally:
                    try:
                        loop.call_soon_threadsafe(queue.put_nowait, ("eof", b""))
                    except RuntimeError:  # pragma: no cover - loop 已关闭
                        pass

            threading.Thread(target=reader, name="suwen-dsh-stdin", daemon=True).start()
        else:
            # 用 os.read 直接读 fd 0：不经过 sys.stdin 的 BufferedReader，
            # 避免守护线程在解释器退出时仍持有缓冲区锁而触发
            # `_enter_buffered_busy` 崩溃（Windows 上表现为 0xC0000005）。
            buffer = bytearray()
            discarding = False

            def _emit_line(line: bytes) -> None:
                loop.call_soon_threadsafe(queue.put_nowait, ("line", line))

            def reader_fd() -> None:
                nonlocal buffer, discarding
                try:
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        buffer.extend(chunk)
                        while True:
                            idx = buffer.find(b"\n")
                            if idx < 0:
                                break
                            line = bytes(buffer[: idx + 1])
                            del buffer[: idx + 1]
                            if discarding:
                                discarding = False
                                continue
                            _emit_line(line)
                        if len(buffer) > MAX_REQUEST_BYTES + 1:
                            if not discarding:
                                _emit_line(bytes(buffer))
                            buffer.clear()
                            discarding = True
                except Exception:  # pragma: no cover - 父进程关闭管道
                    logging.getLogger("omicslab.dsh").debug("stdin reader stopped", exc_info=True)
                finally:
                    if buffer and not discarding:
                        try:
                            _emit_line(bytes(buffer))
                        except RuntimeError:  # pragma: no cover - loop 已关闭
                            pass
                    try:
                        loop.call_soon_threadsafe(queue.put_nowait, ("eof", b""))
                    except RuntimeError:  # pragma: no cover - loop 已关闭
                        pass

            threading.Thread(target=reader_fd, name="suwen-dsh-stdin", daemon=True).start()
        self._write(
            {
                "kind": "hello",
                "protocol": PROTOCOL,
                "bridge": "suwen-dsh",
                "app": __app_name__,
                "version": __version__,
                "pid": os.getpid(),
                "ops": list(OPS),
                "approval": self._approval,
                "ts": time.time(),
            }
        )

        while not self._shutdown_event.is_set():
            kind, chunk = await queue.get()
            if kind == "eof":
                break
            try:
                await self._dispatch_raw(chunk)
            except Exception:  # pragma: no cover - 单帧错误不应终止服务
                logging.getLogger("omicslab.dsh").error("dispatch failed", exc_info=True)
        await self._drain()
        # 注意：不要在这里关闭 fd 0。reader 线程通常仍阻塞在 ``os.read(fd)``
        # 上，Windows CRT 无法安全地跨线程关闭一个正在被读取的 fd（会死锁）。
        # reader 是守护线程，解释器退出时随进程结束即可。
        return 0


def _stdin_fd() -> int | None:
    """返回可用于 ``os.read`` 的 stdin 文件描述符。

    交互式终端（``isatty()``）返回 ``None``，退回文本读行路径；管道/重定向
    返回原始 fd，这样 stdin 读取线程不持有 ``BufferedReader`` 的锁。
    """
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return None
    except Exception:  # pragma: no cover - 非常规 stdin
        return None
    try:
        stream = getattr(sys.stdin, "buffer", None) or sys.stdin
        return int(stream.fileno())
    except Exception:  # pragma: no cover - 无 fd
        return None


def _setup_logging(level: str) -> None:
    """把日志定向到 stderr（fd 2），避免污染协议流。"""
    numeric = getattr(logging, level, None)
    if not isinstance(numeric, int):
        numeric = logging.WARNING
    root = logging.getLogger()
    root.setLevel(numeric)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.handlers = [handler]
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(max(numeric, logging.WARNING))


def serve_stdio(
    *,
    workspace: str | None = None,
    home: str | None = None,
    approval: str = "auto",
    log_level: str = "WARNING",
) -> int:
    """以 stdio NDJSON 模式运行桥接（由 ``suwen dsh`` 子命令调用）。"""
    bridge = DshBridge(workspace=workspace, home=home, approval=approval, log_level=log_level)
    try:
        return asyncio.run(bridge.run())
    except KeyboardInterrupt:  # pragma: no cover - 父进程 Ctrl+C
        return 130
