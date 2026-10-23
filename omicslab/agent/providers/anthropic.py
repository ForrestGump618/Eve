"""Anthropic Messages API provider (streaming + tool use)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from ...config import LLMTarget
from .base import BaseProvider, LLMError, ProviderConfig

logger = logging.getLogger("omicslab.llm.anthropic")


class AnthropicProvider(BaseProvider):
    name = "anthropic"
    family = "anthropic"

    def _endpoint(self) -> str:
        base = (self.target.api_base or "https://api.anthropic.com").strip().rstrip("/")
        if base.endswith("/v1/messages"):
            return base
        if base.endswith("/v1"):
            return base + "/messages"
        return base + "/v1/messages"

    def _convert_messages(self, messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
        system_parts: list[str] = []
        out: list[dict[str, Any]] = []
        pending_tool_results: list[dict[str, Any]] = []

        def flush_tool_results() -> None:
            nonlocal pending_tool_results
            if pending_tool_results:
                out.append({"role": "user", "content": pending_tool_results})
                pending_tool_results = []

        for item in messages:
            role = item.get("role")
            if role == "system":
                system_parts.append(str(item.get("content") or ""))
                continue
            if role == "tool":
                pending_tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": item.get("tool_call_id") or "",
                        "content": str(item.get("content") or ""),
                    }
                )
                continue
            flush_tool_results()
            if role == "assistant":
                blocks: list[dict[str, Any]] = []
                text = item.get("content")
                if text:
                    blocks.append({"type": "text", "text": str(text)})
                for tc in item.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        parsed = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                    except Exception:
                        parsed = {"_raw": str(raw_args)}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": tc.get("id") or "",
                            "name": fn.get("name") or "",
                            "input": parsed if isinstance(parsed, dict) else {},
                        }
                    )
                if not blocks:
                    blocks = [{"type": "text", "text": ""}]
                out.append({"role": "assistant", "content": blocks})
            else:
                content = item.get("content")
                out.append({"role": "user", "content": str(content if content is not None else "")})
        flush_tool_results()
        return "\n\n".join(p for p in system_parts if p), out

    def _convert_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for tool in tools:
            fn = tool.get("function") or tool
            out.append(
                {
                    "name": fn.get("name") or "",
                    "description": fn.get("description") or "",
                    "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                }
            )
        return out

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        config: ProviderConfig | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        cfg = config or ProviderConfig()
        key = self.require_key(self.target)
        import httpx

        system, converted = self._convert_messages(messages)
        payload: dict[str, Any] = {
            "model": self.target.model,
            "max_tokens": int(cfg.max_tokens) if cfg.max_tokens and cfg.max_tokens > 0 else 8192,
            "messages": converted,
            "stream": True,
        }
        if system:
            payload["system"] = system
        if cfg.temperature is not None:
            payload["temperature"] = max(0.0, min(1.0, float(cfg.temperature)))
        if tools:
            payload["tools"] = self._convert_tools(tools)

        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }
        timeout = httpx.Timeout(connect=20.0, read=float(cfg.timeout_s), write=30.0, pool=20.0)

        tool_blocks: dict[int, dict[str, Any]] = {}
        text_parts: list[str] = []
        finish_reason = "stop"
        input_tokens = 0
        output_tokens = 0
        got_any = False

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    async with client.stream("POST", self._endpoint(), json=payload, headers=headers) as resp:
                        if resp.status_code >= 400:
                            body = (await resp.aread()).decode("utf-8", "replace")
                            raise LLMError(
                                f"{self.target.label or 'Anthropic'} 返回 HTTP {resp.status_code}: {body[:800]}",
                                status=resp.status_code,
                                retryable=resp.status_code in (429, 500, 502, 503, 504),
                            )
                        async for line in resp.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if not data:
                                continue
                            try:
                                event = json.loads(data)
                            except Exception:
                                continue
                            etype = event.get("type")
                            if etype == "message_start":
                                usage = (event.get("message") or {}).get("usage") or {}
                                input_tokens = int(usage.get("input_tokens") or 0)
                            elif etype == "content_block_start":
                                index = int(event.get("index") or 0)
                                block = event.get("content_block") or {}
                                if block.get("type") == "tool_use":
                                    tool_blocks[index] = {
                                        "id": block.get("id") or "",
                                        "name": block.get("name") or "",
                                        "arguments": "",
                                    }
                            elif etype == "content_block_delta":
                                index = int(event.get("index") or 0)
                                delta = event.get("delta") or {}
                                if delta.get("type") == "text_delta":
                                    text = delta.get("text") or ""
                                    if text:
                                        got_any = True
                                        text_parts.append(text)
                                        yield {"type": "text", "delta": text}
                                elif delta.get("type") == "input_json_delta":
                                    partial = delta.get("partial_json") or ""
                                    slot = tool_blocks.get(index)
                                    if slot is not None:
                                        slot["arguments"] += partial
                                elif delta.get("type") == "thinking_delta":
                                    thinking = delta.get("thinking") or ""
                                    if thinking:
                                        yield {"type": "reasoning", "delta": thinking}
                            elif etype == "message_delta":
                                delta = event.get("delta") or {}
                                if delta.get("stop_reason"):
                                    finish_reason = str(delta["stop_reason"])
                                usage = event.get("usage") or {}
                                if usage.get("output_tokens") is not None:
                                    output_tokens = int(usage["output_tokens"])
                            elif etype == "error":
                                err = event.get("error") or {}
                                raise LLMError(f"模型返回错误: {err.get('message') or err}")
                break
            except LLMError as exc:
                if not exc.retryable or attempt == 1:
                    raise
                await asyncio.sleep(1.2)
            except Exception as exc:
                if attempt == 1:
                    raise LLMError(f"无法连接模型服务({self.target.label or 'Anthropic'}): {exc}") from exc
                await asyncio.sleep(1.2)

        if tool_blocks:
            tool_calls = []
            for index in sorted(tool_blocks):
                slot = tool_blocks[index]
                args = slot["arguments"]
                if not args:
                    args = "{}"
                try:
                    json.loads(args)
                except Exception:
                    args = json.dumps({"_raw": args}, ensure_ascii=False)
                tool_calls.append(
                    {
                        "id": slot["id"] or f"toolu_{index}",
                        "type": "function",
                        "function": {"name": slot["name"], "arguments": args},
                    }
                )
            yield {"type": "tool_calls", "tool_calls": tool_calls}
            finish_reason = "tool_use"
        if input_tokens or output_tokens:
            yield {
                "type": "usage",
                "usage": {
                    "prompt_tokens": input_tokens,
                    "completion_tokens": output_tokens,
                    "total_tokens": input_tokens + output_tokens,
                },
            }
        elif got_any:
            yield {"type": "usage", "usage": self.estimate_usage(messages, "".join(text_parts))}
        yield {"type": "done", "finish_reason": "tool_calls" if finish_reason == "tool_use" else finish_reason}
