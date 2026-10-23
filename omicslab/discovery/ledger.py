"""Durable, file-based ledger for discovery projects.

Layout (under ``<home>/discovery/<project_id>/``)::

    project.json      # Project record
    hypotheses.jsonl  # append-only Hypothesis records
    evidence.jsonl    # append-only Evidence records
    insights.jsonl    # append-only Insight records
    rounds.jsonl      # append-only DiscoveryRound records
    strategies.json   # Strategy bank (rewritten atomically)
    report.md         # final (or partial) markdown report

JSONL keeps the full history (including corrections) while the project file is
small and cheap to read.  Writes are atomic (``tmp`` + ``replace``) so a crash
never leaves a half-written ledger.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from ..config import Settings
from ..utils import atomic_write_text
from .types import (
    DiscoveryRound,
    Evidence,
    Hypothesis,
    Insight,
    Project,
    Strategy,
    iso_now,
)

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ProjectNotFound(KeyError):
    """Unknown or invalid discovery project id."""


class ProjectStore:
    """Read/write the discovery ledger for one OmicsLab home directory."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = Path(settings.discovery_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    # -- helpers -----------------------------------------------------------
    def _dir(self, project_id: str) -> Path:
        pid = str(project_id or "").strip()
        if not _ID_RE.match(pid):
            raise ProjectNotFound(project_id)
        return self.root / pid

    def _read_json(self, path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _write_json(self, path: Path, data: Any) -> None:
        atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))

    def _read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        records: list[dict[str, Any]] = []
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if isinstance(item, dict):
                    records.append(item)
        except OSError:
            return []
        return records

    def _append(self, path: Path, record: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            # Fall back to a full rewrite so a transient lock cannot lose data.
            existing = self._read_jsonl(path)
            existing.append(record)
            atomic_write_text(path, "\n".join(json.dumps(r, ensure_ascii=False) for r in existing) + "\n")

    # -- projects ----------------------------------------------------------
    def list_projects(self) -> list[Project]:
        projects: list[Project] = []
        if not self.root.is_dir():
            return projects
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            data = self._read_json(child / "project.json", None)
            if isinstance(data, dict):
                projects.append(Project.from_dict(data))
        projects.sort(key=lambda item: item.updated_at, reverse=True)
        return projects

    def create(
        self,
        title: str,
        objective: str,
        *,
        domain: str = "biomedicine",
        agent: str = "lead",
        data_hints: list[str] | None = None,
        max_rounds: int = 4,
        budget_minutes: int = 90,
    ) -> Project:
        title = (title or "").strip() or (objective or "").strip()[:40] or "未命名发现项目"
        project = Project(
            title=title,
            objective=(objective or "").strip(),
            domain=(domain or "biomedicine").strip(),
            agent=(agent or "lead").strip(),
            data_hints=[str(item) for item in (data_hints or []) if str(item).strip()],
            max_rounds=max(1, min(int(max_rounds or 4), 12)),
            budget_minutes=max(5, min(int(budget_minutes or 90), 480)),
        )
        self._dir(project.id).mkdir(parents=True, exist_ok=True)
        self.save(project)
        return project

    def exists(self, project_id: str) -> bool:
        try:
            return (self._dir(project_id) / "project.json").is_file()
        except ProjectNotFound:
            return False

    def get(self, project_id: str) -> Project:
        data = self._read_json(self._dir(project_id) / "project.json", None)
        if not isinstance(data, dict):
            raise ProjectNotFound(project_id)
        return Project.from_dict(data)

    def save(self, project: Project) -> Project:
        project.updated_at = iso_now()
        path = self._dir(project.id) / "project.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._write_json(path, project.to_dict())
        return project

    def update_status(self, project_id: str, status: str, summary: str = "") -> Project:
        project = self.get(project_id)
        project.status = status
        if summary:
            project.summary = summary
        return self.save(project)

    def delete(self, project_id: str) -> None:
        directory = self._dir(project_id)
        if not directory.is_dir():
            raise ProjectNotFound(project_id)
        shutil.rmtree(directory, ignore_errors=True)

    # -- hypotheses --------------------------------------------------------
    def list_hypotheses(self, project_id: str) -> list[Hypothesis]:
        raw = self._read_jsonl(self._dir(project_id) / "hypotheses.jsonl")
        latest: dict[str, Hypothesis] = {}
        order: list[str] = []
        for item in raw:
            hypothesis = Hypothesis.from_dict(item)
            if hypothesis.id not in latest:
                order.append(hypothesis.id)
            latest[hypothesis.id] = hypothesis
        return [latest[hid] for hid in order]

    def append_hypothesis(self, hypothesis: Hypothesis) -> Hypothesis:
        self._append(self._dir(hypothesis.project_id) / "hypotheses.jsonl", hypothesis.to_dict())
        return hypothesis

    def update_hypothesis(self, hypothesis: Hypothesis) -> Hypothesis:
        hypothesis.updated_at = iso_now()
        self.append_hypothesis(hypothesis)
        # Keep the project timestamp fresh for list ordering.
        try:
            self.save(self.get(hypothesis.project_id))
        except ProjectNotFound:
            pass
        return hypothesis

    def get_hypothesis(self, project_id: str, hypothesis_id: str) -> Hypothesis | None:
        for hypothesis in self.list_hypotheses(project_id):
            if hypothesis.id == hypothesis_id:
                return hypothesis
        return None

    # -- evidence / insights ----------------------------------------------
    def list_evidence(self, project_id: str) -> list[Evidence]:
        return [
            Evidence.from_dict(item)
            for item in self._read_jsonl(self._dir(project_id) / "evidence.jsonl")
        ]

    def add_evidence(self, evidence: Evidence) -> Evidence:
        self._append(self._dir(evidence.project_id) / "evidence.jsonl", evidence.to_dict())
        return evidence

    def list_insights(self, project_id: str) -> list[Insight]:
        return [
            Insight.from_dict(item)
            for item in self._read_jsonl(self._dir(project_id) / "insights.jsonl")
        ]

    def add_insight(self, insight: Insight) -> Insight:
        self._append(self._dir(insight.project_id) / "insights.jsonl", insight.to_dict())
        return insight

    # -- strategies --------------------------------------------------------
    def list_strategies(self, project_id: str) -> list[Strategy]:
        raw = self._read_json(self._dir(project_id) / "strategies.json", [])
        if not isinstance(raw, list):
            return []
        return [Strategy.from_dict(item) for item in raw if isinstance(item, dict)]

    def save_strategies(self, project_id: str, strategies: list[Strategy]) -> None:
        self._write_json(
            self._dir(project_id) / "strategies.json",
            [item.to_dict() for item in strategies],
        )

    def upsert_strategy(self, strategy: Strategy) -> Strategy:
        strategies = self.list_strategies(strategy.project_id)
        replaced = False
        for index, existing in enumerate(strategies):
            if existing.id == strategy.id:
                strategies[index] = strategy
                replaced = True
                break
        if not replaced:
            strategies.append(strategy)
        self.save_strategies(strategy.project_id, strategies)
        return strategy

    # -- rounds / report ---------------------------------------------------
    def list_rounds(self, project_id: str) -> list[DiscoveryRound]:
        """Return one entry per round.

        A round is appended twice (pre-registration and evaluation), so JSONL
        replay keeps only the newest record for each round id.
        """
        latest: dict[str, DiscoveryRound] = {}
        order: list[str] = []
        for item in self._read_jsonl(self._dir(project_id) / "rounds.jsonl"):
            record = DiscoveryRound.from_dict(item)
            if record.id not in latest:
                order.append(record.id)
            latest[record.id] = record
        rounds = [latest[round_id] for round_id in order]
        rounds.sort(key=lambda item: item.index)
        return rounds

    def append_round(self, record: DiscoveryRound) -> DiscoveryRound:
        self._append(self._dir(record.project_id) / "rounds.jsonl", record.to_dict())
        return record

    def write_report(self, project_id: str, markdown: str) -> Path:
        path = self._dir(project_id) / "report.md"
        atomic_write_text(path, markdown)
        return path

    def read_report(self, project_id: str) -> str:
        path = self._dir(project_id) / "report.md"
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return ""

    # -- convenience -------------------------------------------------------
    def snapshot(self, project_id: str) -> dict[str, Any]:
        """Full ledger snapshot for the API/UI."""
        return {
            "project": self.get(project_id).to_dict(),
            "hypotheses": [item.to_dict() for item in self.list_hypotheses(project_id)],
            "evidence": [item.to_dict() for item in self.list_evidence(project_id)],
            "insights": [item.to_dict() for item in self.list_insights(project_id)],
            "strategies": [item.to_dict() for item in self.list_strategies(project_id)],
            "rounds": [item.to_dict() for item in self.list_rounds(project_id)],
        }


__all__ = ["ProjectNotFound", "ProjectStore"]
