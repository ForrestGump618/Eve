"""OpenAI-compatible chat completions provider (streaming, tool calling).

Works with DeepSeek, OpenAI, Qwen/DashScope compatible mode, Zhipu, Moonshot,
Ollama, OpenRouter, SiliconFlow and any custom OpenAI-compatible endpoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from ...config import LLMTarget
from .base import BaseProvider, LLMError, ProviderConfig

logger = logging.getLogger("omicslab.llm.openai")


class OpenAICompatProvider(BaseProvider):
    name = "openai"
    family = "openai"

    def _endpoint(self) -> str:
        base = (self.target.api_base or "").strip().rstrip("/")
        if not base:
            raise LLMError("未配置 API Base URL。", status=None)
        if base.endswith("/chat/completions"):
            return base
        return base + "/chat/completions"

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        key = (self.target.api_key or "").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        if self.target.provider == "openrouter":
            headers["HTTP-Referer"] = "https://github.com/omicslab/omicslab"
            headers["X-Title"] = "Eve"
        return headers

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        config: ProviderConfig | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        cfg = config or ProviderConfig()
        self.require_key(self.target)
        import httpx

        payload: dict[str, Any] = {
            "model": self.target.model,
            "messages": messages,
            "stream": True,
        }
        if cfg.temperature is not None:
            payload["temperature"] = float(cfg.temperature)
        if cfg.max_tokens and cfg.max_tokens > 0:
            token_parameter = cfg.extra.get('token_parameter', 'max_tokens')
            if token_parameter not in {'max_tokens', 'max_completion_tokens'}:
                token_parameter = 'max_tokens'
            payload[token_parameter] = int(cfg.max_tokens)
        if cfg.extra.get('chat_template_kwargs'):
            payload['chat_template_kwargs'] = cfg.extra['chat_template_kwargs']
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if self.target.provider in ("openai", "deepseek"):
            payload["stream_options"] = {"include_usage": True}

        timeout = httpx.Timeout(connect=20.0, read=float(cfg.timeout_s), write=30.0, pool=20.0)
        headers = self._headers()
        url = self._endpoint()

        tool_calls: dict[int, dict[str, Any]] = {}
        text_parts: list[str] = []
        finish_reason = "stop"
        usage: dict[str, Any] | None = None
        got_any = False

        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    async with client.stream("POST", url, json=payload, headers=headers) as resp:
                        if resp.status_code >= 400:
                            body = (await resp.aread()).decode("utf-8", "replace")
                            detail = body[:800]
                            if resp.status_code == 400 and not got_any and attempt < 2:
                                if 'temperature' in detail.lower() and 'temperature' in payload:
                                    payload.pop('temperature')
                                    continue
                                if 'max_completion_tokens' in detail and 'max_tokens' in payload:
                                    payload['max_completion_tokens'] = payload.pop('max_tokens')
                                    continue
                            raise LLMError(
                                f"{self.target.label or self.target.provider} 返回 HTTP {resp.status_code}: {detail}",
                                status=resp.status_code,
                                retryable=resp.status_code in (429, 500, 502, 503, 504),
                            )
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            if not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if not data or data == "[DONE]":
                                continue
                            try:
                                chunk = json.loads(data)
                            except Exception:
                                continue
                            if chunk.get("error"):
                                err = chunk["error"]
                                msg = err.get("message") if isinstance(err, dict) else str(err)
                                raise LLMError(f"模型返回错误: {msg}")
                            if chunk.get("usage"):
                                usage = chunk["usage"]
                            choices = chunk.get("choices") or []
                            if not choices:
                                continue
                            choice = choices[0] or {}
                            delta = choice.get("delta") or {}
                            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                            if reasoning:
                                got_any = True
                                yield {"type": "reasoning", "delta": str(reasoning)}
                            content = delta.get("content")
                            if content:
                                got_any = True
                                text_parts.append(str(content))
                                yield {"type": "text", "delta": str(content)}
                            for tc in delta.get("tool_calls") or []:
                                got_any = True
                                index = int(tc.get("index", 0) or 0)
                                slot = tool_calls.setdefault(
                                    index,
                                    {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                                )
                                if tc.get("id"):
                                    slot["id"] = tc["id"]
                                fn = tc.get("function") or {}
                                if fn.get("name"):
                                    slot["function"]["name"] += fn["name"]
                                if fn.get("arguments"):
                                    slot["function"]["arguments"] += fn["arguments"]
                            if choice.get("finish_reason"):
                                finish_reason = str(choice["finish_reason"])
                last_exc = None
                break
            except LLMError as exc:
                last_exc = exc
                if got_any or not exc.retryable or attempt == 2:
                    raise
                await asyncio.sleep(1.2)
            except Exception as exc:  # network errors
                last_exc = exc
                if got_any or attempt == 2:
                    raise LLMError(f"无法连接模型服务({self.target.label or self.target.provider}): {exc}") from exc
                await asyncio.sleep(1.2)
        if last_exc is not None:
            raise LLMError(f"模型请求失败: {last_exc}")

        if tool_calls:
            assembled = []
            for index in sorted(tool_calls):
                slot = tool_calls[index]
                if not slot["id"]:
                    slot["id"] = f"call_{index}_{abs(hash(slot['function']['name'])) % 100000}"
                assembled.append(slot)
            finish_reason = "tool_calls"
            yield {"type": "tool_calls", "tool_calls": assembled}
        if usage:
            yield {
                "type": "usage",
                "usage": {
                    "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                    "completion_tokens": int(usage.get("completion_tokens") or 0),
                    "total_tokens": int(usage.get("total_tokens") or 0),
                },
            }
        elif got_any:
            yield {"type": "usage", "usage": self.estimate_usage(messages, "".join(text_parts))}
        yield {"type": "done", "finish_reason": finish_reason if finish_reason != "tool_calls" else "tool_calls"}
