"""Per-model sampling, context and Sage verification at the real gateway boundary."""
from types import SimpleNamespace

import omicslab.suwen.models as model_module
from omicslab.suwen.models import ModelGateway, RoutedProvider
from omicslab.agent.providers import ProviderConfig
from test_suwen_platform import p


def _gateway(p, monkeypatch, model="selected-test-model"):
    def resolve(provider, model=None, **kwargs):
        return SimpleNamespace(
            provider=provider or "mock", model=model,
            api_base="http://127.0.0.1/v1", api_key=None,
        )
    monkeypatch.setattr(p.settings, "resolve_llm", resolve)
    return ModelGateway(p)


def test_prepare_applies_numeric_temperature_and_model_context(p, monkeypatch):
    p.config.update("models", {"context_window": 64000, "capabilities": {
        "selected-test-model": {
            "temperature": 0.7, "context_window": 16000, "max_output": 1024,
            "modalities": ["text", "image"],
        },
    }})
    gateway = _gateway(p, monkeypatch)
    settings = SimpleNamespace(request_timeout_s=30)
    agent = SimpleNamespace(id="lead", category="research")
    _, cfg, target = gateway.prepare(settings, "mock", "selected-test-model", agent, None)
    assert target.model == "selected-test-model"
    assert cfg.temperature == 0.7
    assert cfg.max_tokens == 1024
    assert cfg.extra["model_context_window"] == 16000
    assert cfg.extra["modalities"] == ["text", "image"]


def test_sage_is_enabled_only_for_compatible_model(p, monkeypatch):
    captured = []

    class Provider:
        def __init__(self, target):
            self.target = target

        async def stream_chat(self, messages, tools, cfg):
            captured.append(cfg.extra)
            yield {"type": "text", "text": "checked"}

    monkeypatch.setattr(model_module, "make_provider", Provider)
    gateway = _gateway(p, monkeypatch)
    p.config.update("models", {"verification": "sage", "sage_verification": False})
    target = gateway.resolve_target({"provider": "mock", "model": "sage-a1.5"})

    async def collect(model):
        target.model = model
        return [event async for event in RoutedProvider(
            gateway, target, "ws_main", "lead",
            p.config.get("models", "ws_main")["value"],
        ).stream_chat([{"role": "user", "content": "check"}], None,
                      ProviderConfig(max_tokens=32, extra={}))]

    import asyncio
    asyncio.run(collect("sage-a1.5"))
    asyncio.run(collect("ordinary-model"))
    assert captured[0]["chat_template_kwargs"] == {"verification": True}
    assert "chat_template_kwargs" not in captured[1]


def test_auxiliary_profile_routes_only_its_task_tag(p, monkeypatch):
    resolved = []

    def resolve(provider, model=None, **kwargs):
        resolved.append((provider, model, kwargs))
        return SimpleNamespace(
            provider=provider or "mock",
            model=model or "global-default",
            api_base=kwargs.get("api_base_override") or "http://127.0.0.1/v1",
            api_key=None,
        )

    monkeypatch.setattr(p.settings, "resolve_llm", resolve)
    p.config.update("models", {
        "roles": {
            "reasoning": {"provider": "mock", "model": "reasoning-default"},
            "text": {"provider": "mock", "model": "ordinary-text"},
        },
        "auxiliary_profiles": {
            "literature.embedding": {
                "provider": "custom_openai",
                "model": "science-embed",
                "api_base": "https://embed.example/v1",
            },
        },
    }, "ws_main")
    gateway = ModelGateway(p)
    settings = SimpleNamespace(request_timeout_s=30)
    agent = SimpleNamespace(id="lead", category="research")
    backend = SimpleNamespace(workspace=p.require_workspace("ws_main"))

    _, _, tagged = gateway.prepare(
        settings, None, None, agent, backend, task_tag="literature.embedding",
    )
    _, _, ordinary = gateway.prepare(
        settings, None, None, agent, backend, task_text="ordinary work",
    )

    assert (tagged.provider, tagged.model, tagged.api_base) == (
        "custom_openai", "science-embed", "https://embed.example/v1",
    )
    assert (ordinary.provider, ordinary.model) == ("mock", "ordinary-text")
    assert ordinary.api_base != tagged.api_base


def test_auxiliary_profile_falls_back_to_role_model_when_unconfigured(p, monkeypatch):
    resolved = []

    def resolve(provider, model=None, **kwargs):
        resolved.append((provider, model))
        return SimpleNamespace(
            provider=provider or "mock",
            model=model or "global-default",
            api_base="http://127.0.0.1/v1",
            api_key=None,
        )

    monkeypatch.setattr(p.settings, "resolve_llm", resolve)
    p.config.update("models", {
        "roles": {"reasoning": {"provider": "mock", "model": "role-reasoner"}},
    }, "ws_main")
    gateway = ModelGateway(p)
    agent = SimpleNamespace(id="lead", category="research")
    backend = SimpleNamespace(workspace=p.require_workspace("ws_main"))

    _, _, target = gateway.prepare(
        SimpleNamespace(request_timeout_s=30),
        None,
        None,
        agent,
        backend,
        task_tag="reflection.reasoning",
    )

    assert target.model == "role-reasoner"
    assert resolved == [("mock", "role-reasoner")]
    route = p.store.logs("ws_main", limit=20)
    assert any(
        row.get("kind") == "model.task_route"
        and row.get("data", {}).get("source") == "fallback"
        for row in route
    )
