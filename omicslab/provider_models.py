"""Bounded, authenticated provider model discovery without changing the default."""
from urllib.parse import urlsplit

import httpx

from .config import ConfigError


async def discover_models(target):
    url = urlsplit(target.api_base)
    if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"})) or url.username or url.password or url.query or url.fragment:
        raise ConfigError("模型地址需要 HTTPS 或本地 HTTP，且不能包含凭据")
    anthropic = target.family == "anthropic"
    base = target.api_base.rstrip("/")
    endpoint = base + ("/v1/models" if anthropic and not base.endswith("/v1") else "/models")
    headers = ({"x-api-key": target.api_key, "anthropic-version": "2023-06-01"} if anthropic
               else {"Authorization": "Bearer " + target.api_key} if target.api_key else {})
    models = []
    params = {"limit": 100} if anthropic else {}
    truncated = False
    async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as client:
        for _ in range(5):
            async with client.stream("GET", endpoint, headers=headers, params=params) as response:
                if response.status_code != 200:
                    raise ConfigError(f"模型列表请求 HTTP {response.status_code}；可手动填写模型，已保存配置保持不变")
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 2_000_000:
                        raise ConfigError("供应商模型列表超过 2 MB")
            import json
            data = json.loads(raw)
            entries = data.get("data")
            if not isinstance(entries, list):
                raise ConfigError("供应商未返回标准模型列表，可手动配置模型")
            for item in entries:
                value = item.get("id") if isinstance(item, dict) else None
                if isinstance(value, str) and 0 < len(value) <= 160 and not any(ord(c) < 32 for c in value) and value not in models:
                    models.append(value)
            truncated = bool(data.get("has_more")) or len(models) > 500
            if len(models) >= 500 or not anthropic or not data.get("has_more"):
                break
            cursor = data.get("last_id")
            if not isinstance(cursor, str) or not cursor:
                break
            params["after_id"] = cursor
    if not models:
        raise ConfigError("供应商返回空模型列表，可手动配置；未覆盖已保存列表")
    return {"models": models[:500], "truncated": truncated, "provider": target.provider}
