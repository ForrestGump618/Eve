"""Tests for the RSI discovery ledger, tools and engine (offline, heuristic path).

The T10 acceptance rule is exercised at engine level: only a structured
``AnalysisResult`` submitted through ``discovery_record_analysis_result`` may
change the verdict; assistant narrative claiming "显著/支持" is ignored.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from omicslab.agent.types import AgentEvent, ChatMessage
from omicslab.agent.tools import ToolContext, ToolRegistry
from omicslab.config import Settings
from omicslab.discovery.engine import DiscoveryEngine
from omicslab.discovery.ledger import ProjectNotFound, ProjectStore
from omicslab.discovery.tools import register_discovery_tools
from omicslab.discovery.types import (
    DiscoveryRound,
    Evidence,
    Hypothesis,
    Insight,
    new_id,
)


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


def test_ledger_crud_and_round_dedupe(settings: Settings) -> None:
    store = ProjectStore(settings)
    project = store.create("测试项目", "比较两组差异", data_hints=["a.csv"], max_rounds=2)
    assert store.exists(project.id)
    assert store.get(project.id).title == "测试项目"
    assert [p.id for p in store.list_projects()] == [project.id]

    hypothesis = store.append_hypothesis(
        Hypothesis(id=new_id("hy"), project_id=project.id, statement="H1", rationale="r")
    )
    assert store.get_hypothesis(project.id, hypothesis.id).statement == "H1"
    hypothesis.status = "testing"
    store.update_hypothesis(hypothesis)
    assert store.get_hypothesis(project.id, hypothesis.id).status == "testing"

    store.add_evidence(Evidence(id=new_id("ev"), project_id=project.id, hypothesis_id=hypothesis.id, kind="experiment", summary="ok"))
    assert len(store.list_evidence(project.id)) == 1
    store.add_insight(Insight(id=new_id("in"), project_id=project.id, text="洞察一", confidence=0.5))
    assert store.list_insights(project.id)[0].text == "洞察一"

    round_id = new_id("rt")
    store.append_round(DiscoveryRound(id=round_id, project_id=project.id, index=1))
    store.append_round(DiscoveryRound(id=round_id, project_id=project.id, index=1, outcome="supported"))
    rounds = store.list_rounds(project.id)
    assert len(rounds) == 1 and rounds[0].outcome == "supported"

    store.write_report(project.id, "# 报告")
    assert store.read_report(project.id) == "# 报告"
    store.delete(project.id)
    with pytest.raises(ProjectNotFound):
        store.get(project.id)


def analysis_payload(**overrides) -> dict:
    data = {
        "data_sha256": "a" * 64,
        "script_sha256": "b" * 64,
        "seed": 42,
        "test": "Welch t-test",
        "effect_size": 0.9,
        "ci_low": 0.5,
        "ci_high": 1.3,
        "p_value": 0.001,
        "q_value_or_none": 0.004,
        "correction": "BH-FDR",
        "method": "two-sided",
        "sample_definition": "两组各 20 个样本",
        "exclusions": ["排除缺失值样本"],
        "execution_status": "completed",
        "artifact_refs": ["results/table.csv"],
        "environment": {"python": "3.11.9"},
        "sample_size": 40,
    }
    data.update(overrides)
    return data


class FakeLoop:
    """Stand-in for AgentLoop that simulates one executed analysis turn."""

    def __init__(self, structured: dict | None = None) -> None:
        self.calls = 0
        self.structured = structured

    async def run(self, conversation, prompt, **kwargs) -> dict:
        self.calls += 1
        emit = kwargs.get("emit")
        if emit is not None:
            await emit(
                AgentEvent(
                    type="tool_call",
                    data={"id": "call_1", "name": "run_python_code", "arguments": {"code": "print('p=0.001')"}},
                )
            )
            await emit(
                AgentEvent(
                    type="tool_result",
                    data={"id": "call_1", "name": "run_python_code", "ok": True, "preview": "p=0.001, effect size 0.9"},
                )
            )
            if self.structured is not None:
                await emit(
                    AgentEvent(
                        type="tool_result",
                        data={
                            "id": "call_2",
                            "name": "discovery_record_analysis_result",
                            "ok": True,
                            "preview": "已记录结构化分析结果",
                            "data": {"analysis_result": self.structured},
                        },
                    )
                )
        conversation.messages.append(
            ChatMessage(
                role="assistant",
                content="结论: 支持。p=0.001，Cohen's d=0.9，BH-FDR 校正后显著，n=40。",
            )
        )
        return {"finish_reason": "done"}


class SequencedLoop:
    """Emits one structured payload per call; supports re-run failure/delay."""

    def __init__(
        self,
        payloads: list[dict | None],
        *,
        second_error: Exception | None = None,
        second_delay: float = 0.0,
    ) -> None:
        self.payloads = list(payloads)
        self.second_error = second_error
        self.second_delay = second_delay
        self.calls = 0
        self.prompts: list[str] = []

    async def run(self, conversation, prompt, **kwargs) -> dict:
        index = self.calls
        self.calls += 1
        self.prompts.append(str(prompt))
        if index >= 1:
            if self.second_delay:
                await asyncio.sleep(self.second_delay)
            if self.second_error is not None:
                raise self.second_error
        payload = self.payloads[min(index, len(self.payloads) - 1)] if self.payloads else None
        emit = kwargs.get("emit")
        if emit is not None:
            await emit(
                AgentEvent(
                    type="tool_call",
                    data={
                        "id": f"call_{index}_py",
                        "name": "run_python_code",
                        "arguments": {"code": "print('p=0.001')"},
                    },
                )
            )
            await emit(
                AgentEvent(
                    type="tool_result",
                    data={
                        "id": f"call_{index}_py",
                        "name": "run_python_code",
                        "ok": True,
                        "preview": "p=0.001, effect size 0.9",
                    },
                )
            )
            if payload is not None:
                await emit(
                    AgentEvent(
                        type="tool_result",
                        data={
                            "id": f"call_{index}_rec",
                            "name": "discovery_record_analysis_result",
                            "ok": True,
                            "preview": "已记录结构化分析结果",
                            "data": {"analysis_result": payload},
                        },
                    )
                )
        conversation.messages.append(
            ChatMessage(role="assistant", content="结论: 支持。p=0.001（叙述不参与判定）。")
        )
        return {"finish_reason": "done"}


def build_engine(settings: Settings, monkeypatch, loop, **engine_kwargs):
    """Create a project + engine wired to an offline loop."""
    store = ProjectStore(settings)
    project = store.create("引擎测试", "检验两组均值差异", max_rounds=1, budget_minutes=5)
    engine = DiscoveryEngine(
        settings, kernel=None, registry=None, store=store, loop=loop, **engine_kwargs
    )

    async def fake_json(*args, **kwargs):
        return None

    monkeypatch.setattr(engine, "_complete", lambda *a, **k: _async(""))
    monkeypatch.setattr(engine, "_complete_json", fake_json)
    return engine, store, project


def run_engine(settings: Settings, monkeypatch, loop, **engine_kwargs):
    engine, store, project = build_engine(
        settings, monkeypatch, loop, **engine_kwargs
    )

    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)

    result = asyncio.run(engine.run(project.id, emit=emit))
    return store, project, result, events


def test_engine_structured_result_supports_hypothesis(settings: Settings, monkeypatch) -> None:
    store, project, result, events = run_engine(settings, monkeypatch, FakeLoop(analysis_payload()))
    assert result["status"] == "done"
    assert result["rounds"] == 1
    assert store.get(project.id).status == "done"

    hypotheses = store.list_hypotheses(project.id)
    assert hypotheses and hypotheses[0].status == "supported"
    evidence = store.list_evidence(project.id)
    assert len(evidence) == 1
    assert evidence[0].kind == "experiment"
    assert evidence[0].strength == "strong"
    assert evidence[0].reproducibility == "code_recorded"
    assert evidence[0].analysis_result is not None
    assert evidence[0].analysis_result["p_value"] == pytest.approx(0.001)

    rounds = store.list_rounds(project.id)
    assert len(rounds) == 1
    assert "判定=supported" in (rounds[0].outcome or "")

    report = store.read_report(project.id)
    assert "RSI" in report and "假设结果" in report
    assert "p=0.001" in report
    assert "CI [0.5, 1.3]" in report
    assert "可复现性=code_recorded" in report
    assert project.id in str(result["report_path"])
    assert any(event.type == "discovery" for event in events)


def test_engine_text_only_claims_are_inconclusive(settings: Settings, monkeypatch) -> None:
    store, project, result, _ = run_engine(settings, monkeypatch, FakeLoop())
    assert result["status"] == "done"
    hypotheses = store.list_hypotheses(project.id)
    assert hypotheses and hypotheses[0].status == "inconclusive"
    evidence = store.list_evidence(project.id)
    assert len(evidence) == 1
    assert evidence[0].kind == "critique"
    assert evidence[0].analysis_result is None
    report = store.read_report(project.id)
    assert "不可判定" in report and "证据不足" in report


def test_engine_failed_execution_is_inconclusive(settings: Settings, monkeypatch) -> None:
    store, project, result, _ = run_engine(
        settings, monkeypatch, FakeLoop(analysis_payload(execution_status="failed"))
    )
    assert result["status"] == "done"
    hypotheses = store.list_hypotheses(project.id)
    assert hypotheses and hypotheses[0].status == "inconclusive"
    evidence = store.list_evidence(project.id)
    assert evidence[0].kind == "critique"
    assert evidence[0].analysis_result is not None
    report = store.read_report(project.id)
    assert "执行状态：failed" in report
    assert "不可判定" in report


def test_analysis_result_tool_records_structured_payload(settings: Settings) -> None:
    registry = ToolRegistry([])
    register_discovery_tools(registry, settings)
    names = {item["function"]["name"] for item in registry.list_specs(["discovery"])}
    assert "discovery_record_analysis_result" in names

    ctx = ToolContext(settings=settings, registry=registry, workspace=settings.workspace)
    result = asyncio.run(
        registry.execute(ctx, "discovery_record_analysis_result", analysis_payload())
    )
    assert result.ok is True
    assert result.data["analysis_result"]["p_value"] == pytest.approx(0.001)
    assert result.data["errors"] == []

    broken = analysis_payload()
    broken.pop("data_sha256")
    rejected = asyncio.run(registry.execute(ctx, "discovery_record_analysis_result", broken))
    assert rejected.ok is False
    assert rejected.data["analysis_result"] is None
    assert any("data_sha256" in item for item in rejected.data["errors"])


def test_rerun_verification_disabled_keeps_code_recorded(
    settings: Settings, monkeypatch
) -> None:
    """Default off: a single execution stays at code_recorded."""
    loop = SequencedLoop([analysis_payload()])
    store, project, result, _events = run_engine(settings, monkeypatch, loop)
    assert result["status"] == "done"
    assert loop.calls == 1
    assert store.list_evidence(project.id)[0].reproducibility == "code_recorded"


def test_rerun_verification_upgrades_reproducibility(
    settings: Settings, monkeypatch
) -> None:
    """Two anchored, hash-identical runs upgrade the evidence to rerun_verified."""
    loop = SequencedLoop([analysis_payload(), analysis_payload()])
    store, project, result, _events = run_engine(
        settings, monkeypatch, loop, rerun_verification=True
    )
    assert result["status"] == "done"
    assert loop.calls == 2
    assert "重跑复核" in loop.prompts[1]
    evidence = store.list_evidence(project.id)[0]
    assert evidence.reproducibility == "rerun_verified"
    assert "可复现性升级为 rerun_verified" in evidence.summary
    report = store.read_report(project.id)
    assert "rerun_verified 1 条" in report
    assert "升级原因" in report


def test_rerun_verification_hash_mismatch_keeps_code_recorded(
    settings: Settings, monkeypatch
) -> None:
    """A re-run with different data bytes must not upgrade reproducibility."""
    loop = SequencedLoop([analysis_payload(), analysis_payload(data_sha256="c" * 64)])
    store, project, result, _events = run_engine(
        settings, monkeypatch, loop, rerun_verification=True
    )
    assert result["status"] == "done"
    assert loop.calls == 2
    evidence = store.list_evidence(project.id)[0]
    assert evidence.reproducibility == "code_recorded"
    assert "哈希与首次不一致" in evidence.summary
    report = store.read_report(project.id)
    assert "rerun_verified 0 条" in report
    assert "哈希与首次不一致" in report


def test_rerun_verification_exception_is_safe(settings: Settings, monkeypatch) -> None:
    """A failing re-run must be recorded, not crash the engine."""
    loop = SequencedLoop(
        [analysis_payload(), analysis_payload()],
        second_error=RuntimeError("rerun boom"),
    )
    store, project, result, _events = run_engine(
        settings, monkeypatch, loop, rerun_verification=True
    )
    assert result["status"] == "done"
    assert loop.calls == 2
    evidence = store.list_evidence(project.id)[0]
    assert evidence.reproducibility == "code_recorded"
    assert "重跑复核异常" in evidence.summary


def test_rerun_verification_timeout_is_safe(settings: Settings, monkeypatch) -> None:
    """A timed-out re-run degrades to code_recorded without hanging."""
    loop = SequencedLoop([analysis_payload(), analysis_payload()], second_delay=0.5)
    engine, store, project = build_engine(
        settings, monkeypatch, loop, rerun_verification=True
    )
    engine.rerun_timeout_s = 0.05
    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)

    result = asyncio.run(engine.run(project.id, emit=emit))
    assert result["status"] == "done"
    evidence = store.list_evidence(project.id)[0]
    assert evidence.reproducibility == "code_recorded"
    assert "重跑复核超时" in evidence.summary


def test_rerun_verification_settings_attribute_enables(
    settings: Settings, monkeypatch
) -> None:
    """``None`` reads settings.discovery_rerun_verification when present."""
    settings.discovery_rerun_verification = True
    loop = SequencedLoop([analysis_payload(), analysis_payload()])
    store, project, result, _events = run_engine(settings, monkeypatch, loop)
    assert result["status"] == "done"
    assert loop.calls == 2
    assert store.list_evidence(project.id)[0].reproducibility == "rerun_verified"


def _async(value):
    async def _inner(*args, **kwargs):
        return value

    return _inner()
