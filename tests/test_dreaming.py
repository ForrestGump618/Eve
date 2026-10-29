"""Dreaming candidates are scoped, redacted, deduplicated and review-gated."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from omicslab.agent.templates import load_agents
from omicslab.agent.tools import build_registry
from omicslab.agent.types import ChatMessage
from omicslab.config import Settings
from omicslab.suwen.service import Platform
from omicslab.workspace.service import WorkspaceService


@pytest.fixture
def platform(tmp_path):
    settings = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    settings.ensure_dirs()
    workspaces = WorkspaceService(settings)
    state = SimpleNamespace(
        settings=settings,
        workspaces=workspaces,
        registry=build_registry(settings),
        agents=load_agents(settings),
        loop=SimpleNamespace(),
        llm_info=lambda: {"provider": "mock", "model": "mock-model", "configured": True},
        vision_info=lambda: {"enabled": False, "configured": False, "model": "", "base_url": "", "has_key": False},
        rebuild_approver=lambda: None,
    )
    store = __import__("omicslab.session.store", fromlist=["ConversationStore"]).ConversationStore(settings)
    state.store = store
    service = Platform(state)
    state.platform = service
    yield service
    service.store.close()


def conversation(service: Platform, text: str, scope: str = "ws_main"):
    row = service.state.store.create(agent="lead", title="既往分析")
    row.messages.append(ChatMessage(role="user", content=text))
    row.meta["workspace_id"] = scope
    service.state.store.save(row)
    return row


def fake_model(candidates):
    async def model(scope, messages):
        return json.dumps({"candidates": candidates}, ensure_ascii=False), "mock-reflection"

    return model


@pytest.mark.asyncio
async def test_dreaming_is_opt_in_and_acceptance_creates_only_a_memory(platform, monkeypatch):
    row = conversation(platform, "这个项目反复遗漏同一条样本过滤规则。")
    with pytest.raises(ValueError, match="做梦已关闭"):
        await platform.dreaming.run("ws_main")
    assert platform.dreaming.update("ws_main", {"auto": True})["auto"] is True
    with pytest.raises(ValueError, match="布尔值"):
        platform.dreaming.update("ws_main", {"auto": "yes"})
    platform.dreaming.update("ws_main", {"enabled": True})
    monkeypatch.setattr(platform.dreaming, "_model", fake_model([{
        "kind": "memory",
        "title": "记录样本过滤规则",
        "summary": "后续分析开始前先核对样本过滤规则，避免重复遗漏。",
        "rationale": "既往会话中出现了同一类失败，证据来自当前工作区会话。",
        "evidence_refs": [f"conversation:{row.id}"],
        "suggested_steps": ["读取数据字典", "记录过滤依据"],
        "confidence": 0.82,
    }]))
    result = await platform.dreaming.run("ws_main", focus="sessions")
    assert result["status"] == "completed"
    assert len(result["candidate_ids"]) == 1
    assert platform.store.list("knowledge", "ws_main") == []
    candidate = platform.store.get("dream_candidate", result["candidate_ids"][0], "ws_main")
    assert candidate["status"] == "pending"
    accepted = await platform.dreaming.accept("ws_main", candidate["id"], note="确认")
    assert accepted["status"] == "accepted"
    assert accepted["accepted_result"]["kind"] == "memory"
    assert len(platform.store.list("knowledge", "ws_main")) == 1


@pytest.mark.asyncio
async def test_dreaming_is_scoped_redacted_and_deduplicated(platform, monkeypatch):
    own = conversation(platform, "主工作区使用 HTAN 队列；sk-secretvalue123 不应被保存。")
    other = platform.state.workspaces.create("另一个项目")
    conversation(platform, "OTHER_SCOPE_MARKER 不属于主工作区。", other.workspace_id)
    platform.dreaming.update("ws_main", {"enabled": True})
    prompts = []

    async def model(scope, messages):
        prompts.append(messages[-1]["content"])
        return json.dumps({"candidates": [{
            "kind": "memory",
            "title": "统一样本规则 sk-secretvalue123",
            "summary": "主工作区反复需要先核对 HTAN 样本规则，sk-secretvalue123 不应保留。",
            "rationale": "这是跨会话重复出现的执行模式，但需要用户确认适用范围。",
            "evidence_refs": [f"conversation:{own.id}"],
            "suggested_steps": ["检查数据字典"],
            "confidence": 0.7,
        }]}, ensure_ascii=False), "mock"

    monkeypatch.setattr(platform.dreaming, "_model", model)
    first = await platform.dreaming.run("ws_main", focus="sessions")
    second = await platform.dreaming.run("ws_main", focus="sessions")
    assert "OTHER_SCOPE_MARKER" not in prompts[0]
    assert "HTAN" in prompts[0]
    assert second["duplicates"] == first["candidate_ids"]
    candidate = platform.store.get("dream_candidate", first["candidate_ids"][0], "ws_main")
    assert "sk-secretvalue123" not in json.dumps(candidate, ensure_ascii=False)
    assert "[redacted]" in candidate["title"]


@pytest.mark.asyncio
async def test_sage_gate_blocks_acceptance_and_skill_drafts_stay_disabled(platform, monkeypatch):
    row = conversation(platform, "多次手工重复同一套差异表达流程。")
    platform.dreaming.update("ws_main", {"enabled": True})
    monkeypatch.setattr(platform.dreaming, "_model", fake_model([{
        "kind": "skill",
        "title": "差异表达检查清单",
        "summary": "把重复出现的差异表达检查步骤整理为默认停用的技能草稿。",
        "rationale": "会话中多次出现同样的人工检查顺序，适合形成可复核技能。",
        "evidence_refs": [f"conversation:{row.id}"],
        "suggested_steps": ["核对分组", "检查批次", "运行敏感性分析"],
        "confidence": 0.77,
    }]))
    run = await platform.dreaming.run("ws_main", focus="sessions")
    candidate = platform.store.get("dream_candidate", run["candidate_ids"][0], "ws_main")
    platform.config.update("models", {"verification": "sage"}, "ws_main")

    async def reject(scope, value):
        return {"passed": False, "summary": "证据不足以固化流程"}

    monkeypatch.setattr(platform.dreaming, "_sage_model_async", reject)
    with pytest.raises(ValueError, match="Sage 门禁未通过"):
        await platform.dreaming.accept("ws_main", candidate["id"])
    assert platform.store.list("skill", "ws_main") == []

    async def accept(scope, value):
        return {"passed": True, "summary": "证据与范围一致"}

    monkeypatch.setattr(platform.dreaming, "_sage_model_async", accept)
    accepted = await platform.dreaming.accept("ws_main", candidate["id"])
    draft = platform.store.get("skill", accepted["accepted_result"]["id"], "ws_main")
    assert draft["enabled"] is False
    assert draft["test_status"] == "not_run"
    assert (__import__("pathlib").Path(draft["path"]) / "SKILL.md").is_file()


@pytest.mark.asyncio
async def test_missing_evidence_cannot_be_accepted(platform, monkeypatch):
    row = conversation(platform, "有一条需要复核的会话。")
    platform.dreaming.update("ws_main", {"enabled": True})
    monkeypatch.setattr(platform.dreaming, "_model", fake_model([{
        "kind": "correction",
        "title": "修正历史结论",
        "summary": "需要重新核对旧结论是否仍被当前证据支持。",
        "rationale": "候选声称存在旧结论，但引用了一个不存在的来源。",
        "evidence_refs": ["conversation:missing"],
        "suggested_steps": ["重新检索证据"],
        "confidence": 0.4,
    }]))
    run = await platform.dreaming.run("ws_main", focus="sessions")
    candidate = platform.store.get("dream_candidate", run["candidate_ids"][0], "ws_main")
    assert candidate["sage_gate"]["status"] == "failed"
    with pytest.raises(ValueError, match="Sage 门禁未通过"):
        await platform.dreaming.accept("ws_main", candidate["id"])
    assert platform.store.list("knowledge", "ws_main") == []
