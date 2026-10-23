"""Typed records for the RSI discovery engine.

The discovery subsystem keeps a durable, inspectable ledger per project.  Every
record is a plain dataclass with ``to_dict``/``from_dict`` so it can be appended
to JSONL files and streamed to the UI without a database dependency.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ..agent.types import new_id


def iso_now() -> str:
    """UTC timestamp with ``Z`` suffix (stable across platforms)."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


HYPOTHESIS_STATUSES = ("proposed", "testing", "supported", "refuted", "inconclusive")
EVIDENCE_KINDS = ("data", "statistics", "literature", "experiment", "critique")
EVIDENCE_STRENGTHS = ("strong", "moderate", "weak")
# Two-level reproducibility: code_recorded only proves the code was captured;
# rerun_verified additionally requires explicit re-run evidence.
EVIDENCE_REPRODUCIBILITY = ("none", "code_recorded", "rerun_verified")
PROJECT_STATUSES = ("idle", "running", "paused", "done", "failed", "cancelled")


@dataclass
class Hypothesis:
    id: str = field(default_factory=lambda: new_id("hy"))
    project_id: str = ""
    statement: str = ""
    rationale: str = ""
    prediction: str = ""
    test_plan: str = ""
    success_criteria: str = ""
    status: str = "proposed"
    confidence: float = 0.5
    evidence_ids: list[str] = field(default_factory=list)
    round: int = 0
    parent_id: str | None = None
    tags: list[str] = field(default_factory=list)
    source: str = "llm"
    created_at: str = field(default_factory=iso_now)
    updated_at: str = field(default_factory=iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "statement": self.statement,
            "rationale": self.rationale,
            "prediction": self.prediction,
            "test_plan": self.test_plan,
            "success_criteria": self.success_criteria,
            "status": self.status,
            "confidence": round(float(self.confidence), 4),
            "evidence_ids": list(self.evidence_ids),
            "round": int(self.round),
            "parent_id": self.parent_id,
            "tags": list(self.tags),
            "source": self.source,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Hypothesis":
        return cls(
            id=str(data.get("id") or new_id("hy")),
            project_id=str(data.get("project_id") or ""),
            statement=str(data.get("statement") or ""),
            rationale=str(data.get("rationale") or ""),
            prediction=str(data.get("prediction") or ""),
            test_plan=str(data.get("test_plan") or ""),
            success_criteria=str(data.get("success_criteria") or ""),
            status=str(data.get("status") or "proposed"),
            confidence=float(data.get("confidence") or 0.5),
            evidence_ids=list(data.get("evidence_ids") or []),
            round=int(data.get("round") or 0),
            parent_id=data.get("parent_id"),
            tags=list(data.get("tags") or []),
            source=str(data.get("source") or "llm"),
            created_at=str(data.get("created_at") or iso_now()),
            updated_at=str(data.get("updated_at") or iso_now()),
        )


@dataclass
class Evidence:
    id: str = field(default_factory=lambda: new_id("ev"))
    project_id: str = ""
    hypothesis_id: str = ""
    kind: str = "data"
    summary: str = ""
    code: str = ""
    result_excerpt: str = ""
    figures: list[str] = field(default_factory=list)
    strength: str = "moderate"
    reproducibility: str = "none"
    analysis_result: dict[str, Any] | None = None
    round: int = 0
    created_at: str = field(default_factory=iso_now)

    @property
    def reproducible(self) -> bool:
        """Backward-compatible boolean view of the reproducibility level."""
        return self.reproducibility != "none"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "hypothesis_id": self.hypothesis_id,
            "kind": self.kind,
            "summary": self.summary,
            "code": self.code,
            "result_excerpt": self.result_excerpt,
            "figures": list(self.figures),
            "strength": self.strength,
            # Legacy key kept for existing UI clients (web/js/views/discovery.js).
            "reproducible": bool(self.reproducible),
            "reproducibility": self.reproducibility,
            "analysis_result": dict(self.analysis_result) if isinstance(self.analysis_result, dict) else None,
            "round": int(self.round),
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Evidence":
        reproducibility = str(data.get("reproducibility") or "").strip().lower()
        if reproducibility not in EVIDENCE_REPRODUCIBILITY:
            # Legacy records only had ``reproducible: bool``; True meant "code ran".
            reproducibility = "code_recorded" if bool(data.get("reproducible")) else "none"
        analysis_result = data.get("analysis_result")
        if not isinstance(analysis_result, dict):
            analysis_result = None
        return cls(
            id=str(data.get("id") or new_id("ev")),
            project_id=str(data.get("project_id") or ""),
            hypothesis_id=str(data.get("hypothesis_id") or ""),
            kind=str(data.get("kind") or "data"),
            summary=str(data.get("summary") or ""),
            code=str(data.get("code") or ""),
            result_excerpt=str(data.get("result_excerpt") or ""),
            figures=list(data.get("figures") or []),
            strength=str(data.get("strength") or "moderate"),
            reproducibility=reproducibility,
            analysis_result=analysis_result,
            round=int(data.get("round") or 0),
            created_at=str(data.get("created_at") or iso_now()),
        )


@dataclass
class Insight:
    id: str = field(default_factory=lambda: new_id("in"))
    project_id: str = ""
    text: str = ""
    confidence: float = 0.5
    evidence_ids: list[str] = field(default_factory=list)
    round: int = 0
    created_at: str = field(default_factory=iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "text": self.text,
            "confidence": round(float(self.confidence), 4),
            "evidence_ids": list(self.evidence_ids),
            "round": int(self.round),
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Insight":
        return cls(
            id=str(data.get("id") or new_id("in")),
            project_id=str(data.get("project_id") or ""),
            text=str(data.get("text") or ""),
            confidence=float(data.get("confidence") or 0.5),
            evidence_ids=list(data.get("evidence_ids") or []),
            round=int(data.get("round") or 0),
            created_at=str(data.get("created_at") or iso_now()),
        )


@dataclass
class Strategy:
    id: str = field(default_factory=lambda: new_id("st"))
    project_id: str = ""
    name: str = ""
    description: str = ""
    prompt_hint: str = ""
    uses: int = 0
    successes: int = 0
    reward: float = 0.5
    lineage: str | None = None
    created_at: str = field(default_factory=iso_now)
    updated_at: str = field(default_factory=iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "name": self.name,
            "description": self.description,
            "prompt_hint": self.prompt_hint,
            "uses": int(self.uses),
            "successes": int(self.successes),
            "reward": round(float(self.reward), 4),
            "lineage": self.lineage,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Strategy":
        return cls(
            id=str(data.get("id") or new_id("st")),
            project_id=str(data.get("project_id") or ""),
            name=str(data.get("name") or ""),
            description=str(data.get("description") or ""),
            prompt_hint=str(data.get("prompt_hint") or ""),
            uses=int(data.get("uses") or 0),
            successes=int(data.get("successes") or 0),
            reward=float(data.get("reward") if data.get("reward") is not None else 0.5),
            lineage=data.get("lineage"),
            created_at=str(data.get("created_at") or iso_now()),
            updated_at=str(data.get("updated_at") or iso_now()),
        )


@dataclass
class DiscoveryRound:
    id: str = field(default_factory=lambda: new_id("rt"))
    project_id: str = ""
    index: int = 1
    strategy_id: str = ""
    hypothesis_id: str = ""
    plan: str = ""
    prediction: str = ""
    success_criteria: str = ""
    outcome: str = ""
    reward: float = 0.0
    reflection: str = ""
    started_at: str = field(default_factory=iso_now)
    ended_at: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "index": int(self.index),
            "strategy_id": self.strategy_id,
            "hypothesis_id": self.hypothesis_id,
            "plan": self.plan,
            "prediction": self.prediction,
            "success_criteria": self.success_criteria,
            "outcome": self.outcome,
            "reward": round(float(self.reward), 4),
            "reflection": self.reflection,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DiscoveryRound":
        return cls(
            id=str(data.get("id") or new_id("rt")),
            project_id=str(data.get("project_id") or ""),
            index=int(data.get("index") or 1),
            strategy_id=str(data.get("strategy_id") or ""),
            hypothesis_id=str(data.get("hypothesis_id") or ""),
            plan=str(data.get("plan") or ""),
            prediction=str(data.get("prediction") or ""),
            success_criteria=str(data.get("success_criteria") or ""),
            outcome=str(data.get("outcome") or ""),
            reward=float(data.get("reward") or 0.0),
            reflection=str(data.get("reflection") or ""),
            started_at=str(data.get("started_at") or iso_now()),
            ended_at=str(data.get("ended_at") or ""),
            error=str(data.get("error") or ""),
        )


@dataclass
class Project:
    id: str = field(default_factory=lambda: new_id("dp"))
    title: str = ""
    objective: str = ""
    domain: str = "biomedicine"
    agent: str = "lead"
    data_hints: list[str] = field(default_factory=list)
    max_rounds: int = 4
    budget_minutes: int = 90
    status: str = "idle"
    current_round: int = 0
    rounds_count: int = 0
    summary: str = ""
    created_at: str = field(default_factory=iso_now)
    updated_at: str = field(default_factory=iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "objective": self.objective,
            "domain": self.domain,
            "agent": self.agent,
            "data_hints": list(self.data_hints),
            "max_rounds": int(self.max_rounds),
            "budget_minutes": int(self.budget_minutes),
            "status": self.status,
            "current_round": int(self.current_round),
            "rounds_count": int(self.rounds_count),
            "summary": self.summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        return cls(
            id=str(data.get("id") or new_id("dp")),
            title=str(data.get("title") or ""),
            objective=str(data.get("objective") or ""),
            domain=str(data.get("domain") or "biomedicine"),
            agent=str(data.get("agent") or "lead"),
            data_hints=list(data.get("data_hints") or []),
            max_rounds=max(1, min(int(data.get("max_rounds") or 4), 12)),
            budget_minutes=max(5, min(int(data.get("budget_minutes") or 90), 480)),
            status=str(data.get("status") or "idle"),
            current_round=int(data.get("current_round") or 0),
            rounds_count=int(data.get("rounds_count") or 0),
            summary=str(data.get("summary") or ""),
            created_at=str(data.get("created_at") or iso_now()),
            updated_at=str(data.get("updated_at") or iso_now()),
        )


__all__ = [
    "DiscoveryRound",
    "EVIDENCE_KINDS",
    "EVIDENCE_REPRODUCIBILITY",
    "EVIDENCE_STRENGTHS",
    "Evidence",
    "HYPOTHESIS_STATUSES",
    "Hypothesis",
    "Insight",
    "PROJECT_STATUSES",
    "Project",
    "Strategy",
    "iso_now",
]
