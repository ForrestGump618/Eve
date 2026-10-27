"""Shared event and message types used across the agent loop, server and CLI."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


EventType = Literal[
    "connected",
    "status",
    "text",
    "text_snapshot",
    "reasoning",
    "tool_call",
    "tool_result",
    "approval_request",
    "figure",
    "usage",
    "error",
    "done",
    "stop_reason",
    "resource_degraded",
]


@dataclass
class AgentEvent:
    """A single SSE event emitted while an agent turn runs."""

    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "data": self.data, "ts": self.ts}

    def to_sse(self) -> str:
        return f"data: {json.dumps(self.to_dict(), ensure_ascii=False)}\n\n"


@dataclass
class ToolResult:
    """Normalised tool execution result."""

    tool_call_id: str
    name: str
    ok: bool
    content: str
    data: dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0
    error: str | None = None

    def llm_content(self, max_chars: int = 24000) -> str:
        """Render for the LLM conversation, truncating oversized payloads."""
        body = self.content if self.content else ""
        if not self.ok and self.error:
            body = f"ERROR: {self.error}\n{body}".strip()
        if len(body) > max_chars:
            head = body[: int(max_chars * 0.7)]
            tail = body[-int(max_chars * 0.2) :]
            removed = len(body) - len(head) - len(tail)
            body = f"{head}\n...[truncated {removed} chars]...\n{tail}"
        return body


@dataclass
class ChatMessage:
    """A persisted conversation message."""

    role: Literal["user", "assistant", "system", "tool", "error"]
    content: str = ""
    id: str = field(default_factory=lambda: new_id("m"))
    ts: float = field(default_factory=time.time)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None
    figures: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "ts": self.ts,
        }
        if self.tool_calls:
            payload["tool_calls"] = self.tool_calls
        if self.tool_call_id:
            payload["tool_call_id"] = self.tool_call_id
        if self.name:
            payload["name"] = self.name
        if self.figures:
            payload["figures"] = self.figures
        if self.meta:
            payload["meta"] = self.meta
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChatMessage":
        return cls(
            role=data.get("role", "assistant"),
            content=data.get("content", "") or "",
            id=data.get("id") or new_id("m"),
            ts=float(data.get("ts") or time.time()),
            tool_calls=data.get("tool_calls") or [],
            tool_call_id=data.get("tool_call_id"),
            name=data.get("name"),
            figures=data.get("figures") or [],
            meta=data.get("meta") or {},
        )


@dataclass
class Conversation:
    id: str = field(default_factory=lambda: new_id("c"))
    title: str = "新会话"
    agent: str = "lead"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    messages: list[ChatMessage] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "agent": self.agent,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "message_count": len(self.messages),
            "archived": bool(self.meta.get("archived")),
            "pinned": bool(self.meta.get("pinned")),
            "workspace_id": self.meta.get("workspace_id"),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "agent": self.agent,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "messages": [m.to_dict() for m in self.messages],
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Conversation":
        return cls(
            id=data.get("id") or new_id("c"),
            title=data.get("title") or "新会话",
            agent=data.get("agent") or "lead",
            created_at=float(data.get("created_at") or time.time()),
            updated_at=float(data.get("updated_at") or time.time()),
            messages=[ChatMessage.from_dict(m) for m in (data.get("messages") or []) if isinstance(m, dict)],
            meta=data.get("meta") or {},
        )


class AgentCancelled(Exception):
    """Raised inside the agent loop when the user stops generation."""


class ToolError(RuntimeError):
    """Raised by a tool implementation for an expected, explainable failure."""
