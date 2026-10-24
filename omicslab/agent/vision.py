"""Vision-model client: describe charts, microscopy images and screenshots.

SuWen keeps the *chat* model optional/multimodal-agnostic: when a user
attaches an image, the agent loop can call this client to turn the image into
text once, then feed that text to any text-only LLM.  The same client powers the
``analyze_image`` tool for follow-up questions on a specific figure.

Two wire formats are supported:

* OpenAI-compatible ``POST {base}/chat/completions`` with ``image_url`` content
  blocks (OpenAI, Qwen-VL via DashScope compatible mode, Zhipu, Moonshot,
  SiliconFlow, OpenRouter, Ollama, local vLLM, ...).
* Anthropic ``POST {base}/v1/messages`` with base64 ``image`` blocks.

No SDK dependency: plain ``httpx`` keeps the distribution small and offline
installable.
"""

from __future__ import annotations

import base64
import struct
import zlib
from pathlib import Path
from typing import Any, Union

import httpx

from ..config import Settings

ImageInput = Union[bytes, bytearray, str, Path]

_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}
_ALLOWED_MIME = set(_MIME_BY_EXT.values())
MAX_IMAGE_BYTES = 12 * 1024 * 1024


class VisionError(RuntimeError):
    """Raised when the vision model is not configured or the call fails."""


class VisionClient:
    """Async client for one-shot image understanding calls."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    # -- configuration -----------------------------------------------------
    def config(self) -> dict[str, Any]:
        return self.settings.vision_config()

    @property
    def configured(self) -> bool:
        try:
            return bool(self.config().get("configured"))
        except Exception:  # pragma: no cover - defensive
            return False

    def _resolve(
        self,
        model: str = "",
        base_url: str = "",
        api_key: str = "",
    ) -> tuple[str, str, str, str]:
        cfg = self.config()
        resolved_model = (model or cfg.get("model") or "").strip()
        resolved_base = (base_url or cfg.get("base_url") or "").strip().rstrip("/")
        resolved_key = (api_key or self.settings.vision_key() or "").strip()
        if not resolved_key:
            raise VisionError(
                "视觉模型未配置 API Key：请在设置页“视觉模型”卡片填写，"
                "或设置环境变量 VISION_API_KEY。"
            )
        if not resolved_model:
            raise VisionError("视觉模型未配置模型名称（如 gpt-4o-mini / qwen-vl-plus）。")
        if not resolved_base:
            raise VisionError("视觉模型未配置 API 地址（如 https://api.openai.com/v1）。")
        family = "anthropic" if "anthropic" in resolved_base.lower() else "openai"
        if family == "anthropic" and resolved_base.endswith("/v1"):
            resolved_base = resolved_base[: -len("/v1")]
        return resolved_model, resolved_base, resolved_key, family

    # -- image loading -----------------------------------------------------
    def _resolve_path(self, image: ImageInput) -> Path:
        if isinstance(image, (bytes, bytearray)):
            raise TypeError("not a path")
        path = Path(str(image)).expanduser()
        if path.is_file():
            return path
        for root in (self.settings.workspace, self.settings.figures_dir):
            candidate = root / str(image)
            if candidate.is_file():
                return candidate
        raise VisionError(f"找不到图片文件：{image}")

    def _load(self, image: ImageInput) -> tuple[bytes, str]:
        if isinstance(image, (bytes, bytearray)):
            data = bytes(image)
            mime = "image/png"
            if data.startswith(b"\xff\xd8"):
                mime = "image/jpeg"
            elif data.startswith(b"GIF8"):
                mime = "image/gif"
        else:
            path = self._resolve_path(image)
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise VisionError(f"读取图片失败：{exc}") from exc
            mime = _MIME_BY_EXT.get(path.suffix.lower(), "")
            if not mime:
                mime = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
        if not data:
            raise VisionError("图片为空文件。")
        if len(data) > MAX_IMAGE_BYTES:
            raise VisionError(
                f"图片过大（{len(data) / 1024 / 1024:.1f}MB），视觉模型最多支持 12MB。"
            )
        if mime not in _ALLOWED_MIME:
            mime = "image/png"
        return data, mime

    # -- request building --------------------------------------------------
    @staticmethod
    def _data_url(data: bytes, mime: str) -> str:
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"

    def _build_request(
        self,
        family: str,
        base: str,
        model: str,
        key: str,
        data: bytes,
        mime: str,
        prompt: str,
        max_tokens: int,
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        if family == "anthropic":
            url = base + "/v1/messages"
            headers = {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            body = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": base64.b64encode(data).decode("ascii"),
                                },
                            },
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            }
            return url, headers, body
        url = base if base.endswith("/chat/completions") else base + "/chat/completions"
        headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
        body = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": 0.0,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": self._data_url(data, mime)}},
                    ],
                }
            ],
        }
        return url, headers, body

    @staticmethod
    def _parse_reply(family: str, payload: dict[str, Any]) -> str:
        if family == "anthropic":
            blocks = payload.get("content") or []
            texts = [
                str(block.get("text") or "")
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            ]
            return "\n".join(t for t in texts if t).strip()
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                    parts.append(str(block.get("text") or ""))
            return "\n".join(p for p in parts if p).strip()
        return ""

    # -- public API --------------------------------------------------------
    async def describe(
        self,
        image: ImageInput,
        prompt: str = "",
        *,
        model: str = "",
        base_url: str = "",
        api_key: str = "",
        timeout_s: int = 120,
        max_tokens: int = 1200,
    ) -> str:
        """Return a natural-language description/answer for one image."""
        resolved_model, base, key, family = self._resolve(model, base_url, api_key)
        data, mime = self._load(image)
        question = (prompt or "").strip() or (
            "请详细描述这张图片的内容；如果它是科研图表（折线图/散点图/柱状图/热图/显微图像等），"
            "请说明坐标轴、数据趋势、分组差异、统计标注和可能的生物学含义。"
        )
        url, headers, body = self._build_request(
            family, base, resolved_model, key, data, mime, question, max_tokens
        )
        try:
            async with httpx.AsyncClient(timeout=float(timeout_s)) as client:
                response = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise VisionError(f"视觉模型连接失败：{exc}") from exc
        if response.status_code >= 400:
            detail = response.text[:600]
            raise VisionError(f"视觉模型返回 HTTP {response.status_code}：{detail}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise VisionError(f"视觉模型返回了非 JSON 内容：{response.text[:300]}") from exc
        text = self._parse_reply(family, payload)
        if not text:
            raise VisionError("视觉模型返回了空内容，请检查模型名是否是多模态模型。")
        return text

    async def test(
        self,
        *,
        model: str = "",
        base_url: str = "",
        api_key: str = "",
        timeout_s: int = 60,
    ) -> dict[str, Any]:
        """Send one tiny image and report latency/response for the settings page."""
        import time

        started = time.perf_counter()
        try:
            desc = await self.describe(
                tiny_png(),
                "这张图片是什么颜色？只回答颜色。",
                model=model,
                base_url=base_url,
                api_key=api_key,
                timeout_s=timeout_s,
                max_tokens=32,
            )
        except Exception as exc:
            return {
                "ok": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "reply": "",
                "error": str(exc),
            }
        return {
            "ok": True,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "reply": desc[:300],
            "error": None,
        }


def tiny_png(size: int = 32, rgb: tuple[int, int, int] = (220, 40, 40)) -> bytes:
    """Create a small solid-colour PNG without Pillow (for connectivity tests)."""
    width = height = max(8, min(int(size), 128))
    r, g, b = rgb
    raw = bytearray()
    row = bytes((r, g, b)) * width
    for _ in range(height):
        raw.append(0)  # filter type 0
        raw.extend(row)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


__all__ = ["VisionClient", "VisionError", "tiny_png", "MAX_IMAGE_BYTES"]
