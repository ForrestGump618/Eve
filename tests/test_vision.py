"""Tests for the vision-model client and the ``analyze_image`` tool.

All HTTP traffic is served by an in-memory httpx MockTransport; no network calls
and no real API keys are required.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

from omicslab.agent import vision as vision_module
from omicslab.agent.types import ToolResult
from omicslab.agent.vision import VisionClient, VisionError, tiny_png
from omicslab.agent.vision_tools import _tool_analyze_image
from omicslab.config import Settings


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


def _configure(settings: Settings, *, base: str = "https://vision.example.test/v1") -> None:
    settings.update(
        {
            "vision_enabled": True,
            "vision_model": "vision-test",
            "vision_base_url": base,
            "vision_api_key": "sk-vision-test",
        }
    )
    settings.save()


def _patch_transport(monkeypatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def recording_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(recording_handler)
    real_client = httpx.AsyncClient

    class FakeAsyncClient(real_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(vision_module.httpx, "AsyncClient", FakeAsyncClient)
    return seen


def test_tiny_png_is_a_valid_png() -> None:
    data = tiny_png(16, (10, 200, 30))
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert b"IHDR" in data and b"IEND" in data
    assert len(data) > 60


def test_unconfigured_client_raises_actionable_error(settings: Settings) -> None:
    client = VisionClient(settings)
    assert client.configured is False
    assert "视觉" in str(client.config().get("error") or "")
    with pytest.raises(VisionError):
        asyncio.run(client.describe(tiny_png()))


def test_openai_compatible_describe(settings: Settings, monkeypatch) -> None:
    _configure(settings)

    def handler(request: httpx.Request) -> httpx.Response:
        payload = request.read().decode("utf-8")
        assert "image_url" in payload and "data:image/png;base64," in payload
        return httpx.Response(200, json={"choices": [{"message": {"content": "红色示意图"}}]})

    seen = _patch_transport(monkeypatch, handler)
    text = asyncio.run(VisionClient(settings).describe(tiny_png(), "这是什么颜色？"))
    assert text == "红色示意图"
    assert len(seen) == 1
    assert seen[0].url.path.endswith("/chat/completions")
    assert seen[0].headers["authorization"] == "Bearer sk-vision-test"


def test_anthropic_describe(settings: Settings, monkeypatch) -> None:
    _configure(settings, base="https://api.anthropic.test")

    def handler(request: httpx.Request) -> httpx.Response:
        payload = request.read().decode("utf-8")
        assert '"type": "image"' in payload or '"type":"image"' in payload
        return httpx.Response(200, json={"content": [{"type": "text", "text": "折线图上升"}]})

    seen = _patch_transport(monkeypatch, handler)
    text = asyncio.run(VisionClient(settings).describe(tiny_png(), "描述图表"))
    assert text == "折线图上升"
    assert seen[0].url.path.endswith("/v1/messages")
    assert seen[0].headers["x-api-key"] == "sk-vision-test"


def test_vision_test_endpoint_reports_ok(settings: Settings, monkeypatch) -> None:
    _configure(settings)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "红色"}}]})

    _patch_transport(monkeypatch, handler)
    result = asyncio.run(VisionClient(settings).test())
    assert result["ok"] is True
    assert result["reply"] == "红色"
    assert result["error"] is None


def test_analyze_image_tool_unconfigured(settings: Settings) -> None:
    class Ctx:
        def __init__(self, settings: Settings) -> None:
            self.settings = settings
            self.registry = None

    result = asyncio.run(_tool_analyze_image(Ctx(settings), {"path": "figure.png"}))
    assert isinstance(result, ToolResult)
    assert result.ok is False
    assert "视觉" in result.content


def test_analyze_image_tool_reads_workspace_file(settings: Settings, monkeypatch) -> None:
    _configure(settings)
    image = settings.workspace / "chart.png"
    image.write_bytes(tiny_png())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "柱状图显示差异"}}]})

    _patch_transport(monkeypatch, handler)

    class Ctx:
        def __init__(self, settings: Settings) -> None:
            self.settings = settings
            self.registry = None

        def resolve_in_workspace(self, raw: str) -> Path:
            return settings.workspace / raw

        def check_cancelled(self) -> None:
            return None

    result = asyncio.run(_tool_analyze_image(Ctx(settings), {"path": "chart.png"}))
    assert result.ok is True
    assert "柱状图显示差异" in result.content
