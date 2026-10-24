"""Run orchestration: one durable execution unit per user turn.

The run registry is deliberately thin: every observable fact is appended to the
``EventStore`` before it is broadcast, so a page reload / reconnect replays the
same trace instead of trusting in-memory state.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from ..agent.types import (
    AgentCancelled,
    AgentEvent,
    ChatMessage,
    Conversation,
    new_id,
)
from ..config import ConfigError
from ..agent.providers.base import LLMError
from .events import (
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    EventStore,
    RunConflict,
    RunNotFound,
    TaskNotFound,
    utc_now,
)

logger = logging.getLogger("omicslab.runtime.runs")

HEARTBEAT_INTERVAL_S = 15.0
REPLAY_LIMIT = 5000
SUBSCRIBER_QUEUE_SIZE = 20000


def run_snapshot(row: dict[str, Any], *, children: list[dict[str, Any]] | None = None,
                 approvals: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Public representation of a run (contract §7.2)."""
    row = dict(row or {})
    status = row.get("status") or "unknown"
    return {
        "run_id": row.get("run_id"),
        "trace_id": row.get("trace_id"),
        "session_id": row.get("session_id"),
        "parent_run_id": row.get("parent_run_id"),
        "root_run_id": row.get("root_run_id"),
        "status": status,
        "agent_id": row.get("agent_id"),
        "workspace": row.get("workspace") or {},
        "created_at": row.get("created_at"),
        "started_at": row.get("started_at"),
        "ended_at": row.get("ended_at"),
        "last_activity": row.get("last_activity"),
        "finish_reason": row.get("finish_reason"),
        "error": row.get("error"),
        "usage": row.get("usage") or {},
        "result_text": row.get("result_text") or "",
        "evidence_gate": (row.get("meta") or {}).get("evidence_gate"),
        "client_request_id": row.get("client_request_id"),
        "children": children or [],
        "approvals": approvals or [],
        "actions": {"cancel": status in ACTIVE_STATUSES},
    }


class RunHandle:
    """Live state for a run that is executing in this process."""

    def __init__(
        self,
        *,
        run: dict[str, Any],
        conversation: Conversation,
        cancel_event: asyncio.Event,
        steering: list[str],
    ) -> None:
        self.run_id: str = run["run_id"]
        self.trace_id: str = run["trace_id"]
        self.session_id: str = run["session_id"]
        self.conversation = conversation
        self.cancel_event = cancel_event
        self.steering = steering
        self.status: str = run.get("status") or "preparing"
        self.task: asyncio.Task[Any] | None = None
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self.emit_lock = asyncio.Lock()
        self.cancel_requested = False
        self.backend: Any = None
        self.workspace: Any = None
        self.started_monotonic = time.monotonic()

    def broadcast(self, event: dict[str, Any]) -> None:
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer: drop the oldest event, the client can resume by seq.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:  # pragma: no cover - defensive
                    pass


class RunService:
    """Owns run lifecycle, event persistence and trace fan-out."""

    def __init__(
        self,
        settings: Any,
        events: EventStore,
        *,
        loop_provider: Callable[[], Any],
        store: Any,
        workspace_service: Any = None,
        backend_factory: Callable[[Any, "RunHandle"], Awaitable[Any]] | None = None,
        approver: Any = None,
        max_parallel_runs: int = 8,
    ) -> None:
        self.settings = settings
        self.events = events
        self.store = store
        self._loop_provider = loop_provider
        self.workspace_service = workspace_service
        self.backend_factory = backend_factory
        self.approver = approver
        self.max_parallel_runs = max(1, int(max_parallel_runs))
        self._handles: dict[str, RunHandle] = {}
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._session_runs: dict[str, str] = {}
        self._global_lock = asyncio.Lock()

    # -- helpers -----------------------------------------------------------
    @property
    def loop(self) -> Any:
        return self._loop_provider()

    def _session_lock(self, session_id: str) -> asyncio.Lock:
        lock = self._session_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[session_id] = lock
        return lock

    def get_handle(self, run_id: str) -> RunHandle | None:
        return self._handles.get(run_id)

    def active_runs(self) -> list[RunHandle]:
        return [h for h in self._handles.values() if h.status in ACTIVE_STATUSES]

    def active_runs_in_scope(self, scope: str) -> list[RunHandle]:
        out = []
        for handle in self.active_runs():
            try:
                ws = handle.workspace
                if ws is not None and getattr(ws, "scope", "") == scope:
                    out.append(handle)
            except Exception:
                continue
        return out

    async def _graceful_finalize(self) -> None:
        """Interrupted runs recovered at startup get a terminal run_status frame."""
        try:
            recovered = self.events.recover_runs()
        except Exception:  # pragma: no cover - defensive
            logger.exception("恢复中断运行失败")
            return
        for run in recovered:
            try:
                await self._broadcast_external(
                    run["trace_id"],
                    {
                        "type": "run_status",
                        "data": {"run_id": run["run_id"], "status": "interrupted", "recovered": True},
                        "ts": utc_now(),
                    },
                )
            except Exception:  # pragma: no cover
                pass

    async def recover(self) -> list[dict[str, Any]]:
        return self.events.recover_runs()

    # -- create / execute --------------------------------------------------
    async def submit(
        self,
        *,
        session_id: str,
        message: str,
        agent_id: str | None = None,
        client_request_id: str | None = None,
        workspace_id: str | None = None,
        parent_run_id: str | None = None,
        root_run_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
        conversation: Conversation | None = None,
    ) -> dict[str, Any]:
        if client_request_id:
            existing = self.events.find_by_client_request(client_request_id)
            if existing:
                return {"run": run_snapshot(existing), "idempotent": True}
        if not str(message or "").strip():
            raise ValueError("message 不能为空")
        if conversation is None:
            conversation = self.store.get(session_id)
            if conversation is None:
                raise KeyError(session_id)

        # Fail fast on a run that is already active for this session.
        active = self.events.active_run_for_session(session_id)
        if active is not None:
            raise RunConflict(active["run_id"])

        ws = None
        if self.workspace_service is not None:
            ws = (
                self.workspace_service.get(workspace_id)
                if workspace_id
                else self.workspace_service.workspace_for_conversation(session_id)
            )
            if workspace_id and ws is None:
                raise ValueError(f"工作区不存在：{workspace_id}")
            ws = ws or self.workspace_service.default()
        workspace_public = self.workspace_service.public(ws) if (ws is not None and self.workspace_service) else {}

        run = self.events.create_run(
            {
                "run_id": new_id("run"),
                "trace_id": new_id("tr"),
                "session_id": session_id,
                "parent_run_id": parent_run_id,
                "root_run_id": root_run_id,
                "client_request_id": client_request_id or None,
                "status": "preparing",
                "agent_id": agent_id or conversation.agent,
                "workspace": workspace_public,
                "created_at": utc_now(),
                "meta": {"workspace_id": ws.workspace_id if ws is not None else None},
            }
        )
        cancel_event = asyncio.Event()
        handle = RunHandle(
            run=run,
            conversation=conversation,
            cancel_event=cancel_event,
            steering=[],
        )
        handle.workspace = ws
        self._handles[handle.run_id] = handle
        self._session_runs[session_id] = handle.run_id
        await self._emit(
            handle,
            "run_status",
            {"run_id": handle.run_id, "status": "preparing", "session_id": session_id},
        )
        handle.task = asyncio.create_task(
            self._execute(
                handle,
                message=message,
                agent_id=agent_id or conversation.agent,
                provider=provider,
                model=model,
                attachments=attachments or [],
            )
        )
        return {"run": run_snapshot(self.events.get_run(handle.run_id) or run), "idempotent": False}

    async def _execute(
        self,
        handle: RunHandle,
        *,
        message: str,
        agent_id: str,
        provider: str | None,
        model: str | None,
        attachments: list[dict[str, Any]],
    ) -> None:
        status = "running"
        error: dict[str, Any] | None = None
        finish_reason = ""
        text = ""
        usage: dict[str, Any] = {}
        try:
            self.events.update_run(
                handle.run_id,
                status="running",
                started_at=utc_now(),
                last_activity=utc_now(),
            )
            handle.status = "running"
            await self._emit(
                handle,
                "run_status",
                {"run_id": handle.run_id, "status": "running", "session_id": handle.session_id},
            )

            backend = None
            if self.backend_factory is not None and handle.workspace is not None:
                try:
                    backend = await self.backend_factory(handle.workspace, handle)
                    handle.backend = backend
                except Exception as exc:  # backend unavailable -> fail explicitly
                    raise RuntimeError(f"执行后端不可用：{exc}") from exc

            kwargs: dict[str, Any] = {
                "emit": lambda event: self._on_loop_event(handle, event),
                "cancel_event": handle.cancel_event,
                "approver": self.approver,
                "agent_id": agent_id,
                "provider": provider,
                "model": model,
                "attachments": attachments,
                "run_id": handle.run_id,
                "run_ctx": handle,
                "steer": lambda: self._consume_steering(handle),
            }
            if handle.workspace is not None:
                kwargs["workspace"] = getattr(handle.workspace, "root", None)
            if backend is not None:
                kwargs["backend"] = backend
            result = await self.loop.run(handle.conversation, message, **kwargs)
            if result.get("evidence_gate"):
                record = self.events.get_run(handle.run_id)
                self.events.update_run(handle.run_id, meta=dict(record.get("meta") or {}, evidence_gate=result["evidence_gate"]))
            finish_reason = str(result.get("finish_reason") or "")
            text = str(result.get("text") or "")
            usage = result.get("usage") or {}
            if finish_reason == "cancelled" or handle.cancel_requested:
                status = "cancelled"
            elif finish_reason in {"error", "max_iterations"}:
                status = "failed"
                error = {"message": (result.get("error") or {}).get("message") if isinstance(result.get("error"), dict) else result.get("error") or "运行失败", "code": finish_reason}
            else:
                status = "succeeded"
        except AgentCancelled:
            status = "cancelled"
            finish_reason = "cancelled"
        except asyncio.CancelledError:
            status = "interrupted"
            finish_reason = "interrupted"
            raise
        except ConfigError as exc:
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "config_error"}
        except LLMError as exc:
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "llm_error"}
        except Exception as exc:  # noqa: BLE001 - surface failures, never伪装成功
            logger.exception("运行 %s 失败", handle.run_id)
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "internal_error"}
        finally:
            handle.status = status
            ended = utc_now()
            try:
                self.events.update_run(
                    handle.run_id,
                    status=status,
                    ended_at=ended,
                    finish_reason=finish_reason or status,
                    error=error,
                    usage=usage,
                    result_text=text[-8000:],
                    last_activity=ended,
                )
            except Exception:  # pragma: no cover
                logger.exception("写入运行终态失败")
            try:
                await self._emit(
                    handle,
                    "done",
                    {
                        "run_id": handle.run_id,
                        "session_id": handle.session_id,
                        "finish_reason": finish_reason or status,
                        "status": status,
                    },
                )
            except Exception:  # pragma: no cover
                logger.exception("写入 done 事件失败")
            try:
                self._cleanup_handle(handle)
            except Exception:  # pragma: no cover
                pass

    def _cleanup_handle(self, handle: RunHandle) -> None:
        self._handles.pop(handle.run_id, None)
        if self.workspace_service is not None and handle.workspace is not None:
            try:
                self.workspace_service.mark_idle(getattr(handle.workspace, "workspace_id", ""))
            except Exception:
                pass
        for queue in list(handle.subscribers):
            try:
                queue.put_nowait({"type": "stream_end", "data": {"run_id": handle.run_id}})
            except Exception:
                pass

    def _consume_steering(self, handle: RunHandle) -> list[str]:
        if not handle.steering:
            return []
        messages = list(handle.steering)
        handle.steering.clear()
        return messages

    # -- event plumbing ----------------------------------------------------
    async def _on_loop_event(self, handle: RunHandle, event: AgentEvent | dict[str, Any]) -> None:
        if isinstance(event, AgentEvent):
            event_type = event.type
            data = event.data or {}
            ts = event.ts
        else:
            event_type = str(event.get("type") or "event")
            data = event.get("data") or {}
            ts = event.get("ts")
        if event_type == "approval_request":
            handle.status = "waiting_approval"
            self._persist_approval(handle, data)
        elif event_type in {"approval_resolved", "tool_result", "text", "reasoning", "tool_call"}:
            if handle.status == "waiting_approval":
                handle.status = "running"
        await self._emit(handle, event_type, data, ts=ts)

    def _persist_approval(self, handle: RunHandle, data: dict[str, Any]) -> None:
        approval_id = data.get("id") or data.get("approval_id")
        if not approval_id:
            return
        try:
            self.events.create_approval(
                {
                    "approval_id": approval_id,
                    "run_id": handle.run_id,
                    "tool": data.get("tool") or "",
                    "arguments": data.get("arguments") or {},
                    "reason": data.get("reason") or "",
                    "target": data.get("target") or {},
                    "status": "pending",
                }
            )
        except Exception:  # pragma: no cover
            logger.exception("持久化审批请求失败")

    async def _emit(
        self,
        handle: RunHandle,
        event_type: str,
        data: dict[str, Any],
        *,
        ts: str | None = None,
    ) -> dict[str, Any]:
        payload = dict(data or {})
        payload.setdefault("run_id", handle.run_id)
        payload.setdefault("session_id", handle.session_id)
        async with handle.emit_lock:
            stored = self.events.append_event(handle.trace_id, handle.run_id, event_type, payload, ts=ts)
            try:
                self.events.update_run(handle.run_id, last_activity=stored.get("ts") or utc_now())
            except Exception:  # pragma: no cover
                pass
            frame = {
                "type": event_type,
                "data": payload,
                "ts": stored.get("ts"),
                "seq": stored.get("seq"),
                "event_id": stored.get("event_id"),
                "run_id": handle.run_id,
                "trace_id": handle.trace_id,
                "session_id": handle.session_id,
            }
            handle.broadcast(frame)
            return frame

    async def emit_external(self, run_id: str, event_type: str, data: dict[str, Any]) -> None:
        handle = self._handles.get(run_id)
        if handle is not None:
            await self._emit(handle, event_type, data)
            return
        run = self.events.get_run(run_id)
        if not run:
            return
        payload = dict(data or {})
        payload.setdefault("run_id", run_id)
        stored = self.events.append_event(run["trace_id"], run_id, event_type, payload)
        await self._broadcast_external(
            run["trace_id"],
            {
                "type": event_type,
                "data": payload,
                "ts": stored.get("ts"),
                "seq": stored.get("seq"),
                "event_id": stored.get("event_id"),
                "run_id": run_id,
                "trace_id": run["trace_id"],
                "session_id": run["session_id"],
            },
        )

    async def _broadcast_external(self, trace_id: str, frame: dict[str, Any]) -> None:
        # Nothing live for a completed/recovered trace; replay covers it.
        return None

    # -- queries -----------------------------------------------------------
    def snapshot(self, run_id: str) -> dict[str, Any]:
        row = self.events.get_run(run_id)
        if row is None:
            raise RunNotFound(run_id)
        children = self.events.list_agent_tasks(parent_run_id=run_id)
        approvals = self.events.list_approvals(run_id=run_id)
        return run_snapshot(row, children=children, approvals=approvals)

    def timeline(self, trace_id: str, after_seq: int = 0, limit: int = 1000) -> dict[str, Any]:
        events = self.events.list_events(trace_id, after_seq=after_seq, limit=limit)
        run = self.events.run_for_trace(trace_id) or {}
        return {
            "trace_id": trace_id,
            "run": run_snapshot(run) if run else None,
            "events": events,
            "next_seq": events[-1]["seq"] if events else after_seq,
            "max_seq": self.events.max_seq(trace_id),
        }

    async def subscribe(self, trace_id: str, after_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        handle = None
        run = self.events.run_for_trace(trace_id)
        if run is not None:
            handle = self._handles.get(run["run_id"])
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
        if handle is not None:
            handle.subscribers.add(queue)
        try:
            events = self.events.list_events(trace_id, after_seq=after_seq, limit=REPLAY_LIMIT)
            cursor = after_seq
            for event in events:
                frame = {
                    "type": event["type"],
                    "data": event["data"],
                    "ts": event["ts"],
                    "seq": event["seq"],
                    "event_id": event["event_id"],
                    "run_id": event["run_id"],
                    "trace_id": trace_id,
                    "session_id": (run or {}).get("session_id"),
                }
                cursor = event["seq"]
                yield frame
            if len(events) >= REPLAY_LIMIT:
                yield {
                    "type": "stream_gap",
                    "data": {"next_seq": cursor, "limit": REPLAY_LIMIT},
                    "seq": cursor,
                    "trace_id": trace_id,
                }
            while True:
                terminal = False
                if run is not None:
                    fresh = self.events.get_run(run["run_id"]) or {}
                    terminal = fresh.get("status") in TERMINAL_STATUSES
                if terminal and handle is None:
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_INTERVAL_S)
                except asyncio.TimeoutError:
                    yield {"type": "heartbeat", "data": {}, "trace_id": trace_id, "seq": cursor}
                    continue
                if frame.get("type") == "stream_end":
                    break
                seq = frame.get("seq")
                if isinstance(seq, int):
                    if seq <= cursor:
                        continue
                    cursor = seq
                yield frame
            if run is not None:
                fresh = self.events.get_run(run["run_id"]) or {}
                if fresh.get("status") in TERMINAL_STATUSES:
                    yield {
                        "type": "stream_end",
                        "data": {"run_id": run["run_id"], "status": fresh.get("status")},
                        "trace_id": trace_id,
                        "seq": cursor,
                    }
        finally:
            if handle is not None:
                handle.subscribers.discard(queue)

    # -- cancel / steering -------------------------------------------------
    async def cancel(self, run_id: str, reason: str = "用户停止") -> dict[str, Any]:
        run = self.events.get_run(run_id)
        if run is None:
            raise RunNotFound(run_id)
        if run["status"] in TERMINAL_STATUSES:
            return {"ok": False, "status": run["status"], "detail": "运行已结束"}
        handle = self._handles.get(run_id)
        if handle is not None and not handle.cancel_requested:
            handle.cancel_requested = True
            handle.status = "stopping"
            self.events.update_run(run_id, status="stopping")
            await self._emit(handle, "run_status", {"run_id": run_id, "status": "stopping", "reason": reason})
            handle.cancel_event.set()
            backend = handle.backend
            loop = self.loop
            platform = getattr(getattr(loop, 'registry', None), 'platform', None)
            workspace_id = getattr(handle.workspace, 'workspace_id', '')
            if backend is not None and platform is not None and platform.active_compute.get(workspace_id) == run_id:
                try:
                    await asyncio.wait_for(backend.interrupt(), timeout=5)
                except Exception as exc:
                    platform.store.audit('run.interrupt_failed', {'run': run_id, 'error': str(exc)}, workspace_id)
            if self.approver is not None:
                try:
                    self.approver.cancel_for_run(run_id, reason)
                except Exception:
                    logger.exception("取消审批失败")
            asyncio.create_task(self._finalize_cancel(handle))
        return {"ok": True, "status": "stopping", "run": self.snapshot(run_id)}

    async def cancel_all(self, reason: str = "服务关闭") -> None:
        handles = list(self._handles.values())
        for handle in handles:
            await self.cancel(handle.run_id, reason)
        tasks = [handle.task for handle in handles if handle.task is not None]
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=16)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _finalize_cancel(self, handle: RunHandle) -> None:
        task = handle.task
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=15.0)
        except asyncio.TimeoutError:
            logger.warning("运行 %s 取消超时，标记为 interrupted", handle.run_id)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.events.update_run(
                handle.run_id,
                status="interrupted",
                ended_at=utc_now(),
                finish_reason="interrupted",
                error={"message": "取消超时，运行中断", "code": "cancel_timeout"},
            )
            handle.status = "interrupted"
        except Exception:
            pass

    async def append_user_message(self, run_id: str, content: str) -> dict[str, Any]:
        content = str(content or "").strip()
        if not content:
            raise ValueError("content 不能为空")
        run = self.events.get_run(run_id)
        if run is None:
            raise RunNotFound(run_id)
        if run["status"] in TERMINAL_STATUSES:
            return {"ok": False, "status": run["status"], "detail": "运行已结束"}
        handle = self._handles.get(run_id)
        if handle is None:
            return {"ok": False, "status": run["status"], "detail": "运行不在当前进程中"}
        message = ChatMessage(role="user", content=content, ts=utc_now())
        handle.conversation.messages.append(message)
        handle.steering.append(content)
        try:
            self.store.save(handle.conversation)
        except Exception:  # pragma: no cover
            logger.exception("保存追加消息失败")
        await self._emit(
            handle,
            "user_message",
            {"run_id": run_id, "message_id": message.id, "content": content, "projected": True},
        )
        return {"ok": True, "status": run["status"], "seq": None}

    # -- child tasks (batch C: agent tree) ---------------------------------
    def _child_stats(self, parent_handle: RunHandle) -> tuple[int, int]:
        parent = self.events.get_run(parent_handle.run_id) or {}
        meta = dict(parent.get("meta") or {})
        depth = int(meta.get("depth", 0) or 0) + 1
        children = self.events.list_agent_tasks(parent_run_id=parent_handle.run_id, limit=500)
        return depth, len(children)

    async def submit_child(
        self,
        parent_handle: RunHandle,
        *,
        prompt: str,
        agent_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """Create and start a child run under ``parent_handle``.

        The child gets its own run/trace (so it can be inspected independently)
        and publishes ``child_run`` events on the parent trace. Limit violations
        raise ``ValueError`` with an actionable Chinese message.
        """
        prompt = str(prompt or "").strip()
        if not prompt:
            raise ValueError("子任务 prompt 不能为空")
        parent = self.events.get_run(parent_handle.run_id)
        if parent is None:
            raise RunNotFound(parent_handle.run_id)
        if parent.get("status") in TERMINAL_STATUSES:
            raise ValueError("父运行已结束，不能再派生子任务")
        depth, child_count = self._child_stats(parent_handle)
        max_depth = int(getattr(self.settings, "max_child_depth", 2) or 2)
        if depth > max_depth:
            raise ValueError(f"子智能体嵌套深度超限（{depth} > {max_depth}），请拆解为更扁平的任务")
        max_children = int(getattr(self.settings, "max_child_tasks", 4) or 4)
        if child_count >= max_children:
            raise ValueError(f"单个运行最多派生 {max_children} 个子任务，当前已创建 {child_count} 个")
        if len(self.active_runs()) >= self.max_parallel_runs:
            raise ValueError(f"并发运行数已达上限（{self.max_parallel_runs}），请等待其他任务结束")

        child_agent = agent_id or parent.get("agent_id") or "lead"
        run = self.events.create_run(
            {
                "run_id": new_id("run"),
                "trace_id": new_id("tr"),
                "session_id": parent["session_id"],
                "parent_run_id": parent_handle.run_id,
                "root_run_id": parent.get("root_run_id") or parent_handle.run_id,
                "status": "preparing",
                "agent_id": child_agent,
                "workspace": parent.get("workspace") or {},
                "created_at": utc_now(),
                "meta": {
                    "role": "child",
                    "depth": depth,
                    "parent_run_id": parent_handle.run_id,
                },
            }
        )
        task = self.events.create_agent_task(
            {
                "task_id": new_id("task"),
                "parent_run_id": parent_handle.run_id,
                "run_id": run["run_id"],
                "session_id": parent["session_id"],
                "profile": child_agent,
                "status": "running",
                "goal": prompt[:4000],
                "budget": {"depth": depth, "max_depth": max_depth},
                "position": child_count,
                "created_at": utc_now(),
            }
        )
        conversation = Conversation(agent=child_agent, title=f"子任务 · {child_agent}")
        conversation.meta['restricted_channel']=bool(parent_handle.conversation.meta.get('restricted_channel'))
        inherited=parent_handle.conversation.meta.get('inherited_toolsets')
        profile=getattr(getattr(self.loop,'registry',None),'platform',None)
        if profile is not None:
            parent_agent=profile.store.get('agent',parent_handle.conversation.agent)
            if parent_agent is not None:
                allowed=parent_agent.get('toolsets',[])
                inherited=allowed if inherited is None else list(set(inherited)&set(allowed))
        if inherited is not None:conversation.meta['inherited_toolsets']=inherited
        conversation.messages.append(ChatMessage(role="user", content=prompt))
        child_handle = RunHandle(
            run=run,
            conversation=conversation,
            cancel_event=asyncio.Event(),
            steering=[],
        )
        child_handle.workspace = parent_handle.workspace
        child_handle.backend = parent_handle.backend
        self._handles[run["run_id"]] = child_handle
        await self._emit(
            parent_handle,
            "child_run",
            {
                "task_id": task["task_id"],
                "child_run_id": run["run_id"],
                "child_trace_id": run["trace_id"],
                "agent_id": child_agent,
                "depth": depth,
                "status": "running",
                "prompt_preview": prompt[:200],
                "parent_run_id": parent_handle.run_id,
            },
        )
        child_handle.task = asyncio.create_task(
            self._run_child(
                child_handle,
                parent_handle,
                task,
                prompt=prompt,
                agent_id=child_agent,
                provider=provider,
                model=model,
            )
        )
        return {
            "task": task,
            "run": run_snapshot(self.events.get_run(run["run_id"]) or run),
            "handle": child_handle,
        }

    async def _run_child(
        self,
        handle: RunHandle,
        parent_handle: RunHandle,
        task: dict[str, Any],
        *,
        prompt: str,
        agent_id: str,
        provider: str | None,
        model: str | None,
    ) -> dict[str, Any]:
        status = "succeeded"
        error: dict[str, Any] | None = None
        text = ""
        usage: dict[str, Any] = {}
        finish_reason = ""
        started = time.monotonic()
        try:
            self.events.update_run(handle.run_id, status="running", started_at=utc_now())
            handle.status = "running"
            kwargs: dict[str, Any] = {
                "emit": lambda event: self._on_loop_event(handle, event),
                "cancel_event": handle.cancel_event,
                "approver": self.approver,
                "agent_id": agent_id,
                "provider": provider,
                "model": model,
                "run_id": handle.run_id,
                "run_ctx": handle,
                "steer": lambda: self._consume_steering(handle),
                "agent_task_id": task["task_id"],
            }
            if handle.workspace is not None:
                kwargs["workspace"] = getattr(handle.workspace, "root", None)
            if handle.backend is not None:
                kwargs["backend"] = handle.backend
            result = await self.loop.run(handle.conversation, prompt, **kwargs)
            finish_reason = str(result.get("finish_reason") or "")
            text = str(result.get("text") or "")
            usage = result.get("usage") or {}
            if finish_reason == "cancelled" or handle.cancel_requested:
                status = "cancelled"
            elif finish_reason in {"error", "max_iterations"}:
                status = "failed"
                err = result.get("error")
                error = err if isinstance(err, dict) else {"message": str(err or "子任务失败"), "code": finish_reason}
            else:
                status = "succeeded"
        except AgentCancelled:
            status = "cancelled"
            finish_reason = "cancelled"
        except asyncio.CancelledError:
            status = "interrupted"
            finish_reason = "interrupted"
            raise
        except ConfigError as exc:
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "config_error"}
        except LLMError as exc:
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "llm_error"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("子任务 %s 失败", handle.run_id)
            status = "failed"
            finish_reason = "error"
            error = {"message": str(exc), "code": "internal_error"}
        finally:
            ended = utc_now()
            duration_ms = int((time.monotonic() - started) * 1000)
            handle.status = status
            try:
                self.events.update_run(
                    handle.run_id,
                    status=status,
                    ended_at=ended,
                    finish_reason=finish_reason or status,
                    error=error,
                    usage=usage,
                    result_text=text[-8000:],
                    last_activity=ended,
                )
            except Exception:  # pragma: no cover
                logger.exception("写入子运行终态失败")
            try:
                self.events.update_agent_task(
                    task["task_id"],
                    status="succeeded" if status == "succeeded" else status,
                    ended_at=ended,
                    result={"text": text[:8000], "usage": usage, "finish_reason": finish_reason, "duration_ms": duration_ms},
                    error=error,
                )
            except Exception:  # pragma: no cover
                logger.exception("写入子任务终态失败")
            try:
                await self._emit(
                    handle,
                    "done",
                    {
                        "run_id": handle.run_id,
                        "session_id": handle.session_id,
                        "finish_reason": finish_reason or status,
                        "status": status,
                        "agent_task_id": task["task_id"],
                    },
                )
            except Exception:  # pragma: no cover
                pass
            try:
                await self._emit(
                    parent_handle,
                    "child_run",
                    {
                        "task_id": task["task_id"],
                        "child_run_id": handle.run_id,
                        "child_trace_id": handle.trace_id,
                        "agent_id": agent_id,
                        "status": status,
                        "finish_reason": finish_reason or status,
                        "duration_ms": duration_ms,
                        "error": error,
                        "result_preview": text[:600],
                        "parent_run_id": parent_handle.run_id,
                    },
                )
            except Exception:  # pragma: no cover
                pass
            try:
                self._cleanup_handle(handle)
            except Exception:  # pragma: no cover
                pass
        return {"status": status, "text": text, "error": error, "task_id": task["task_id"], "run_id": handle.run_id}

    async def wait_child(self, child: dict[str, Any]) -> dict[str, Any]:
        handle = child.get("handle")
        if handle is None or handle.task is None:
            raise RunNotFound(str((child.get("run") or {}).get("run_id") or ""))
        return await asyncio.shield(handle.task)

    # -- child tasks -------------------------------------------------------
    def agent_task(self, task_id: str) -> dict[str, Any]:
        task = self.events.get_agent_task(task_id)
        if task is None:
            raise TaskNotFound(task_id)
        return task
