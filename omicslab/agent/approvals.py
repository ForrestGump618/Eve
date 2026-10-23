"""Human-in-the-loop approval broker for risky tools.

``run_shell``, ``write_file`` and remote write operations are marked
``requires_approval``. The tool registry delegates the decision here:

- ``policy == "auto"``  → approve immediately (no UI round trip);
- ``policy == "ask"``   → emit an ``approval_request`` event over the active
  SSE stream and wait for ``resolve()`` to be called by the HTTP endpoint.

The broker is thread safe: ``resolve()`` may be invoked from any thread (the
FastAPI handler normally runs in the same event loop, but keeping the
``call_soon_threadsafe`` fallback avoids nasty production surprises).

Approval records carry their owning ``run_id`` / ``agent_task_id`` so that:

* the UI can show the origin (host, directory, tool, child task);
* cancelling one run/task only denies *its* approvals (never ``cancel_all``
  for unrelated work);
* configuration changes just call :meth:`Approver.set_policy` and keep the
  same broker instance, so in-flight approvals remain resolvable.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from omicslab.agent.types import AgentEvent

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from omicslab.agent.tools import ToolContext

logger = logging.getLogger("omicslab.agent.approvals")

VALID_POLICIES = {"auto", "ask"}


@dataclass
class _PendingApproval:
    """Internal bookkeeping for one in-flight approval request."""

    approval_id: str
    tool: str
    arguments: dict[str, Any]
    reason: str
    created_at: float
    future: asyncio.Future[bool]
    loop: asyncio.AbstractEventLoop
    conversation_id: str = ""
    run_id: str = ""
    agent_task_id: str = ""
    target: dict[str, Any] = field(default_factory=dict)
    expires_at: float = 0.0


def _set_result_safe(future: asyncio.Future[bool], approved: bool) -> None:
    """Resolve a future from another thread without raising on a closed loop."""
    if future.done():
        return
    try:
        future.set_result(bool(approved))
    except (RuntimeError, asyncio.InvalidStateError):  # pragma: no cover - race
        logger.debug("审批 future 已被取消或循环已关闭，忽略结果")


def _call_or_value(obj: Any, name: str) -> Any:
    """Read ``obj.name``; call it when it is a property-like method."""
    value = getattr(obj, name, None)
    if callable(value):
        try:
            value = value()
        except Exception:  # pragma: no cover - defensive
            return None
    return value


def _target_from_ctx(ctx: "ToolContext") -> dict[str, Any]:
    """Describe *where* a tool would execute (host/dir/connection).

    ``ctx.workspace_ctx`` is normally a :class:`Workspace` record, but the loop
    may also expose the resolved workspace root (a ``Path``) or a plain string.
    Older code blindly used attribute access which leaked ``Path.cwd`` bound
    methods (and ``Path.root == "\\"``) into approval payloads, so normalise
    every accepted shape here.
    """
    target: dict[str, Any] = {}
    backend = getattr(ctx, "backend", None)
    raw = getattr(ctx, "workspace_ctx", None)
    if raw is None:
        raw = getattr(ctx, "workspace", None)

    kind = str(getattr(backend, "kind", "") or "")
    root = ""
    cwd = ""
    connection_id = ""

    if isinstance(raw, str):
        root = raw
        cwd = raw
    elif isinstance(raw, os.PathLike):
        root = os.fspath(raw)
        cwd = root
    elif raw is not None:
        root_value = _call_or_value(raw, "root")
        root = str(root_value) if root_value else ""
        cwd_value = _call_or_value(raw, "cwd")
        cwd = str(cwd_value) if cwd_value else root
        connection_id = str(_call_or_value(raw, "connection_id") or "")
        if not kind:
            kind = str(_call_or_value(raw, "backend_kind") or _call_or_value(raw, "backend") or "")

    if not root:
        fallback = getattr(ctx, "workspace", "")
        root = str(fallback or "")
        cwd = cwd or root
    if not kind:
        kind = "local" if root else ""
    if kind:
        target.update(
            {
                "kind": kind,
                "root": root,
                "cwd": cwd or root,
                "connection_id": connection_id,
            }
        )
    profile_id = str(getattr(ctx, "connection_id", "") or "") or connection_id
    if profile_id:
        target.setdefault("connection_id", profile_id)
    return target


class Approver:
    """Approval policy engine shared by the server and the agent loop."""

    def __init__(self, policy: str = "auto", timeout_s: float = 120.0) -> None:
        self.policy = self._normalise_policy(policy)
        try:
            timeout = float(timeout_s)
        except (TypeError, ValueError):
            timeout = 120.0
        self.timeout_s = min(max(timeout, 0.01), 3600.0)
        self._pending: dict[str, _PendingApproval] = {}
        self._lock = threading.RLock()
        self.resolved_count = 0
        self.denied_count = 0

    # -- configuration -----------------------------------------------------
    @staticmethod
    def _normalise_policy(policy: str | None) -> str:
        normalised = str(policy or "auto").strip().lower()
        if normalised not in VALID_POLICIES:
            logger.warning("未知审批策略 %r，回退到 auto", policy)
            return "auto"
        return normalised

    def set_policy(self, policy: str) -> str:
        """Update the policy in place (stable broker identity).

        Existing pending approvals are untouched: whoever was asked keeps the
        right to resolve them, so a settings save cannot drop live approvals.
        """
        self.policy = self._normalise_policy(policy)
        logger.info("审批策略已更新为 %s", self.policy)
        return self.policy

    # -- introspection -----------------------------------------------------
    def pending(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """Return metadata for every approval awaiting a decision."""
        with self._lock:
            entries = list(self._pending.values())
        if run_id:
            entries = [entry for entry in entries if entry.run_id == str(run_id)]
        entries.sort(key=lambda entry: entry.created_at)
        return [
            {
                "id": entry.approval_id,
                "tool": entry.tool,
                "arguments": entry.arguments,
                "reason": entry.reason,
                "created_at": entry.created_at,
                "conversation_id": entry.conversation_id,
                "run_id": entry.run_id,
                "agent_task_id": entry.agent_task_id,
                "target": dict(entry.target or {}),
                "expires_at": entry.expires_at,
            }
            for entry in entries
        ]

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    # -- request path ------------------------------------------------------
    async def request(
        self,
        ctx: "ToolContext",
        tool: str,
        arguments: dict[str, Any],
        reason: str,
        *, force_ask: bool = False,
    ) -> bool:
        """Ask the user whether a tool call may proceed.

        Returns True when approved, False when denied/timed out/cancelled.
        """
        if self.policy != "ask" and not force_ask:
            return True

        cancel_event = getattr(ctx, "cancel_event", None)
        if cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
            logger.info("审批请求 %s 因会话取消而直接拒绝", tool)
            return False

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - request always runs in a loop
            logger.warning("审批请求不在事件循环中，默认拒绝")
            return False

        approval_id = f"ap_{uuid.uuid4().hex[:10]}"
        future: asyncio.Future[bool] = loop.create_future()
        now = time.time()
        entry = _PendingApproval(
            approval_id=approval_id,
            tool=str(tool),
            arguments=dict(arguments or {}),
            reason=str(reason or ""),
            created_at=now,
            future=future,
            loop=loop,
            conversation_id=str(getattr(ctx, "conversation_id", "") or ""),
            run_id=str(getattr(ctx, "run_id", "") or ""),
            agent_task_id=str(getattr(ctx, "agent_task_id", "") or ""),
            target=_target_from_ctx(ctx),
            expires_at=now + float(self.timeout_s),
        )
        with self._lock:
            self._pending[approval_id] = entry

        emit = getattr(ctx, "emit", None)
        payload = {
            "id": approval_id,
            "tool": entry.tool,
            "arguments": entry.arguments,
            "reason": entry.reason,
            "run_id": entry.run_id,
            "agent_task_id": entry.agent_task_id,
            "conversation_id": entry.conversation_id,
            "target": entry.target,
            "expires_at": entry.expires_at,
        }
        try:
            if emit is not None:
                await emit(AgentEvent("approval_request", payload))
            else:  # pragma: no cover - a context without emit cannot ask a human
                logger.warning("审批策略为 ask 但当前上下文没有 emit 通道，默认拒绝")
                return False
            try:
                approved = await asyncio.wait_for(future, timeout=self.timeout_s)
            except asyncio.TimeoutError:
                logger.warning(
                    "审批请求 %s（工具 %s）等待 %.1fs 超时，已自动拒绝",
                    approval_id,
                    entry.tool,
                    self.timeout_s,
                )
                return False
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("审批请求 %s 异常，已拒绝: %s", approval_id, exc)
                return False
            return bool(approved)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("发送审批请求 %s 失败，已拒绝: %s", approval_id, exc)
            return False
        finally:
            with self._lock:
                self._pending.pop(approval_id, None)
            if not future.done():
                future.cancel()

    # -- resolution path ---------------------------------------------------
    def resolve(self, approval_id: str, approved: bool) -> bool:
        """Resolve a pending approval. Returns False for unknown ids."""
        key = str(approval_id or "").strip()
        with self._lock:
            entry = self._pending.pop(key, None)
        if entry is None:
            logger.debug("审批请求 %r 不存在或已处理", approval_id)
            return False

        future = entry.future
        if future.done():
            return True
        try:
            running_loop: asyncio.AbstractEventLoop | None
            try:
                running_loop = asyncio.get_running_loop()
            except RuntimeError:
                running_loop = None
            if running_loop is entry.loop:
                future.set_result(bool(approved))
            else:
                entry.loop.call_soon_threadsafe(_set_result_safe, future, bool(approved))
        except RuntimeError:  # pragma: no cover - closed loop during shutdown
            logger.warning("审批请求 %s 的事件循环已关闭", approval_id)
            return False
        with self._lock:
            self.resolved_count += 1
            if not approved:
                self.denied_count += 1
        logger.info("审批请求 %s 已处理：%s", approval_id, "同意" if approved else "拒绝")
        return True

    # -- cancellation ------------------------------------------------------
    def _deny_entries(self, entries: list[_PendingApproval], reason: str) -> int:
        if reason:
            logger.info("取消 %d 个审批：%s", len(entries), reason)
        count = 0
        for entry in entries:
            future = entry.future
            if future.done():
                continue
            try:
                try:
                    running_loop = asyncio.get_running_loop()
                except RuntimeError:
                    running_loop = None
                if running_loop is entry.loop:
                    future.set_result(False)
                else:
                    entry.loop.call_soon_threadsafe(_set_result_safe, future, False)
                count += 1
            except RuntimeError:  # pragma: no cover
                continue
        return count

    def _pop_where(self, predicate) -> list[_PendingApproval]:
        with self._lock:
            matched = [entry for entry in self._pending.values() if predicate(entry)]
            for entry in matched:
                self._pending.pop(entry.approval_id, None)
        return matched

    def cancel_all(self, reason: str = "") -> int:
        """Deny every pending request (used on shutdown only)."""
        with self._lock:
            entries = list(self._pending.values())
            self._pending.clear()
        return self._deny_entries(entries, reason)

    def cancel_for_run(self, run_id: str, reason: str = "") -> int:
        """Deny approvals owned by one run (and its child tasks)."""
        key = str(run_id or "").strip()
        if not key:
            return 0
        entries = self._pop_where(
            lambda entry: entry.run_id == key or entry.agent_task_id.startswith(f"task-for-run:{key}")
        )
        return self._deny_entries(entries, reason or f"运行 {key} 已取消")

    def cancel_for_task(self, task_id: str, reason: str = "") -> int:
        """Deny approvals owned by one child task."""
        key = str(task_id or "").strip()
        if not key:
            return 0
        entries = self._pop_where(lambda entry: entry.agent_task_id == key)
        return self._deny_entries(entries, reason or f"子任务 {key} 已取消")
