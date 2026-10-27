from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from omicslab.agent.types import Conversation
from omicslab.config import Settings
from omicslab.runtime.desktop_harness import DesktopHarness


@pytest.mark.asyncio
async def test_unified_turn_does_not_send_hidden_call_or_iteration_limits(tmp_path: Path) -> None:
    calls: list[tuple[str, dict]] = []

    class Adapter(DesktopHarness):
        async def rpc(self, method: str, **params):
            calls.append((method, params))
            if method == "create":
                return {"id": "task_unbounded"}
            if method == "task.snapshot":
                return {
                    "status": "completed",
                    "events": [],
                    "stream": {"text": "verified result"},
                    "tokens": 42,
                    "steps": [{
                        "output": {
                            "text": "verified result",
                            "traceId": "trace_unbounded",
                            "sources": [],
                            "verification": {"passed": True},
                        }
                    }],
                }
            raise AssertionError(f"unexpected RPC: {method}")

    settings = Settings(
        workspace=tmp_path / "workspace",
        home=tmp_path / "home",
        provider="openai",
        model="test-model",
    )
    settings.ensure_dirs()
    llm = SimpleNamespace(
        provider="openai",
        model="test-model",
        family="openai",
        api_key="test-only-key",
        api_base="https://example.invalid/v1",
        label="test",
    )
    settings.resolve_llm = lambda provider=None, model=None: llm  # type: ignore[method-assign]
    loop = SimpleNamespace(settings=settings, registry=SimpleNamespace(platform=None), _save=lambda conv: None)
    backend = SimpleNamespace(kind="local", root=settings.workspace)
    adapter = Adapter({"token": "unused", "pipe": "unused"})

    result = await adapter.run(
        loop,
        Conversation(),
        "return the verified result",
        backend=backend,
        run_ctx=SimpleNamespace(permission_mode="full", run_id="run_test"),
    )

    create = next(params for method, params in calls if method == "create")
    assert create["limits"] == {"maxTokens": 240000, "maxWallMs": 630000}
    assert "maxCalls" not in create["limits"]
    assert "maxTurns" not in create["limits"]
    assert "maxIterations" not in create["limits"]
    assert create["steps"][0]["timeoutMs"] == 600000
    assert result["finish_reason"] == "stop"
    assert result["text"] == "verified result"
