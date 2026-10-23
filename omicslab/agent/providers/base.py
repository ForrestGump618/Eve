"""LLM provider abstraction.

Providers stream a sequence of normalized delta events:

``{"type": "text", "delta": "..."}``
    assistant visible text.
``{"type": "reasoning", "delta": "..."}``
    chain-of-thought style reasoning (DeepSeek-R1, Qwen, ...).
``{"type": "tool_calls", "tool_calls": [...]}``
    fully assembled OpenAI-style tool calls, emitted once per response.
``{"type": "usage", "usage": {...}}``
    token accounting when the provider reports it.
``{"type": "done", "finish_reason": "stop"|"tool_calls"|"length"|"error"}``
    terminal event; the agent loop uses ``finish_reason`` to decide whether to
    start another tool round.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from ...config import LLMTarget


class LLMError(RuntimeError):
    """Raised when an LLM request cannot be completed."""

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.retryable = retryable


@dataclass
class ProviderConfig:
    temperature: float | None = 0.0
    max_tokens: int = 0
    timeout_s: float = 180.0
    extra: dict[str, Any] = field(default_factory=dict)


class BaseProvider:
    """Base class for concrete providers."""

    name = "base"
    family = "openai"

    def __init__(self, target: LLMTarget) -> None:
        self.target = target

    # -- to be implemented by subclasses ---------------------------------
    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        config: ProviderConfig | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        raise NotImplementedError
        yield {}  # pragma: no cover

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def estimate_usage(messages: list[dict[str, Any]], completion_text: str) -> dict[str, int]:
        def size_of(obj: Any) -> int:
            text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)
            return max(1, len(text) // 3)

        prompt = 0
        for item in messages:
            prompt += size_of(item.get("content") or "")
            if item.get("tool_calls"):
                prompt += size_of(item["tool_calls"])
        completion = max(1, len(completion_text) // 3)
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
        }

    @staticmethod
    def require_key(target: LLMTarget) -> str:
        key = (target.api_key or "").strip()
        if not key and target.family != "mock":
            raise LLMError(
                f"未配置 {target.label or target.provider} 的 API Key。请在设置页填写，"
                f"或设置环境变量。",
                status=None,
            )
        return key


def tool_result_content_blocks(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group consecutive OpenAI ``tool`` messages into Anthropic tool_result blocks."""
    blocks: list[dict[str, Any]] = []
    for item in messages:
        if item.get("role") == "tool":
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": item.get("tool_call_id") or "",
                    "content": str(item.get("content") or ""),
                }
            )
    return blocks
