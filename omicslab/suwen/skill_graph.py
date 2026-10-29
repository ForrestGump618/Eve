"""Bounded, dependency-aware skill retrieval with execution feedback.

The graph is deliberately conservative: literature-derived skills enter the
catalogue disabled and therefore never appear in the active graph until a user
enables them. Successful runs strengthen co-use edges; failed or abandoned
retrievals never do.
"""
from __future__ import annotations

import hashlib
import math
import re
import time
from collections import defaultdict
from typing import Any

from ..agent.skills import Skill
from .knowledge import terms
from .store import Conflict, uid


def _edge_id(source: str, target: str, kind: str) -> str:
    return hashlib.sha256(f"{source}\0{target}\0{kind}".encode()).hexdigest()[:24]


class SkillGraph:
    def __init__(self, platform):
        self.platform = platform
        self.store = platform.store

    @staticmethod
    def _reference_matcher(names: set[str]):
        canonical = {name.casefold(): name for name in names}
        alternatives = "|".join(
            re.escape(name)
            for name in sorted(names, key=lambda item: (-len(item), item))
        )
        pattern = re.compile(
            rf"(?<![\w-])(?:{alternatives})(?![\w-])",
            re.I,
        ) if alternatives else None
        return pattern, canonical

    @staticmethod
    def _references(skill: Skill, matcher) -> set[str]:
        pattern, canonical = matcher
        valid_names = set(canonical.values())
        found = {
            name
            for name in skill.dependencies
            if name in valid_names and name != skill.name
        }
        if pattern is not None:
            for match in pattern.finditer(skill.body[:16_000]):
                name = canonical.get(match.group(0).casefold())
                if name and name != skill.name:
                    found.add(name)
        return found

    def _put(self, kind: str, identifier: str, value: dict[str, Any], scope: str) -> dict[str, Any]:
        for _ in range(4):
            current = self.store.get(kind, identifier, scope)
            try:
                return self.store.put(kind, identifier, value, scope,
                                      expected=current["revision"] if current else 0)
            except Conflict:
                continue
        return self.store.put(kind, identifier, value, scope)

    def sync(self, scope: str, skills: dict[str, Skill]) -> None:
        """Upsert active nodes and explicit/inferred dependency edges."""
        names = set(skills)
        now = time.time()
        existing = {
            row["id"]: row
            for row in self.store.list("skill_node", scope, limit=5000)
        }
        names_digest = hashlib.sha256(
            "\0".join(sorted(names)).encode("utf-8")
        ).hexdigest()
        matcher = None
        for name, skill in skills.items():
            old = existing.get(name) or {}
            content_digest = hashlib.sha256(
                "\0".join((
                    names_digest,
                    name,
                    skill.description,
                    skill.source,
                    str(skill.path),
                    *skill.dependencies,
                    skill.body[:16_000],
                )).encode("utf-8")
            ).hexdigest()
            if old.get("content_digest") == content_digest and old.get("active"):
                continue
            if matcher is None:
                matcher = self._reference_matcher(names)
            node = {
                "name": name,
                "description": skill.description[:800],
                "source": skill.source,
                "path": str(skill.path),
                "dependencies": sorted(self._references(skill, matcher)),
                "active": True,
                "content_digest": content_digest,
                "last_seen": now,
                "retrievals": int(old.get("retrievals") or 0),
                "views": int(old.get("views") or 0),
                "uses": int(old.get("uses") or 0),
                "successes": int(old.get("successes") or 0),
                "failures": int(old.get("failures") or 0),
            }
            if any(node.get(key) != old.get(key) for key in
                   ("description", "source", "path", "dependencies", "active",
                    "content_digest")):
                self._put("skill_node", name, node, scope)
            for target in node["dependencies"]:
                edge_key = _edge_id(name, target, "dependency")
                previous = self.store.get("skill_edge", edge_key, scope)
                if previous:
                    continue
                self._put("skill_edge", edge_key, {
                    "source": name,
                    "target": target,
                    "kind": "dependency",
                    "weight": 1.0,
                    "evidence": 1,
                    "created_at": now,
                }, scope)
        # Deactivate stale filesystem nodes without deleting their execution
        # evidence. Re-enabling a skill restores the same node.
        for node in existing.values():
            if node["id"] not in names and node.get("active"):
                self._put("skill_node", node["id"], dict(node, active=False), scope)

    def _lexical_score(self, query: str, skill: Skill) -> float:
        wanted = terms(query)
        if not wanted:
            return 0.0
        words = terms(" ".join((skill.name, skill.description, skill.when_to_use,
                                skill.body[:5000])))
        overlap = sum(min(count, words.get(term, 0)) for term, count in wanted.items())
        return overlap / math.sqrt(max(1, sum(words.values())))

    def select(
        self,
        scope: str,
        query: str,
        skills: dict[str, Skill],
        *,
        max_skills: int = 8,
        max_chars: int = 6000,
    ) -> dict[str, Skill]:
        """Return a bounded, dependency-closed skill bundle.

        Lexical seeds are ranked first. Personalized PageRank then propagates
        mass backwards through dependency edges so a high-level request also
        retrieves its prerequisites instead of losing them to top-k search.
        """
        if not skills:
            return {}
        self.sync(scope, skills)
        limit = max(1, min(20, int(max_skills or 8)))
        seeds: dict[str, float] = {}
        for name, skill in skills.items():
            score = self._lexical_score(query, skill)
            node = self.store.get("skill_node", name, scope) or {}
            successes = int(node.get("successes") or 0)
            failures = int(node.get("failures") or 0)
            if successes or failures:
                score += (successes + 1) / (successes + failures + 2) * 0.04
            if score > 0:
                seeds[name] = score
        if not seeds:
            # A neutral start still returns a small, stable set of core skills.
            seeds = {name: 1.0 for name in sorted(skills)[:limit]}
        top = max(seeds.values()) or 1.0
        seeds = {name: score / top for name, score in seeds.items()}

        edges = self.store.list("skill_edge", scope, limit=5000)
        neighbours: dict[str, dict[str, float]] = defaultdict(dict)
        for edge in edges:
            source, target = edge.get("source"), edge.get("target")
            if source not in skills or target not in skills:
                continue
            weight = float(edge.get("weight") or 0)
            if weight <= 0:
                continue
            if edge.get("kind") == "dependency":
                # Reverse-aware edge: dependent -> prerequisite.
                neighbours[source][target] = max(neighbours[source].get(target, 0), weight)
                neighbours[target][source] = max(neighbours[target].get(source, 0), 0.15 * weight)
            else:
                neighbours[source][target] = max(neighbours[source].get(target, 0), weight)
                neighbours[target][source] = max(neighbours[target].get(source, 0), weight)

        rank = {name: seeds.get(name, 0.0) for name in skills}
        for _ in range(12):
            updated = {}
            for name in skills:
                incoming = sum(rank.get(other, 0.0) * weight
                               for other, weight in neighbours.get(name, {}).items())
                updated[name] = 0.18 * seeds.get(name, 0.0) + 0.82 * incoming
            total = sum(updated.values()) or 1.0
            rank = {name: value / total for name, value in updated.items()}

        ordered = sorted(skills, key=lambda name: (rank.get(name, 0), seeds.get(name, 0), name),
                         reverse=True)

        def dependencies(name: str) -> set[str]:
            explicit = set(skills[name].dependencies or [])
            node = self.store.get("skill_node", name, scope) or {}
            inferred = set(node.get("dependencies") or [])
            return {
                item
                for item in explicit | inferred
                if item in skills and item != name
            }

        def closure(name: str) -> list[str]:
            result: list[str] = []
            visited: set[str] = set()
            visiting: set[str] = set()

            def visit(current: str) -> None:
                if current in visited or current in visiting:
                    return
                visiting.add(current)
                for dependency in sorted(dependencies(current)):
                    visit(dependency)
                visiting.remove(current)
                visited.add(current)
                result.append(current)

            visit(name)
            return result

        selected: list[str] = []
        projected_sizes = {
            name: len(name) + len(skill.description) + 40
            for name, skill in skills.items()
        }

        def fits(chain: list[str]) -> bool:
            additions = [item for item in chain if item not in selected]
            return (
                len(selected) + len(additions) <= limit
                and sum(projected_sizes[item] for item in additions)
                + sum(projected_sizes[item] for item in selected)
                <= max_chars
            )

        # Preserve the full transitive dependency closure while respecting the
        # hard size bound. A high-level seed is not useful when its prerequisite
        # chain is silently truncated to the first edge.
        for name in ordered:
            chain = closure(name)
            if not fits(chain):
                continue
            for item in chain:
                if item not in selected and len(selected) < limit:
                    selected.append(item)
            if len(selected) >= limit:
                break

        if not selected:
            # A budget failure must never turn into an unbounded fallback.
            # Pick the smallest complete closure that can fit; otherwise the
            # caller receives an explicit empty bundle.
            for name in sorted(skills, key=lambda item: (len(closure(item)), item)):
                chain = closure(name)
                if (
                    len(chain) <= limit
                    and sum(projected_sizes[item] for item in chain) <= max_chars
                ):
                    selected = chain
                    break
        return {name: skills[name] for name in selected}

    def record_retrieval(self, scope: str, run_id: str, query: str,
                         selected: dict[str, Skill]) -> dict[str, Any]:
        for name in selected:
            node = self.store.get("skill_node", name, scope)
            if node:
                self._put("skill_node", name, dict(node, retrievals=int(node.get("retrievals") or 0) + 1,
                                                  last_retrieved=time.time()), scope)
        existing = self.store.get("skill_activity", run_id, scope)
        if existing and existing.get("status") == "running":
            return self._put("skill_activity", run_id, {
                **existing,
                "query": str(query or "")[:500],
                "retrieved": sorted(
                    set(existing.get("retrieved", [])) | set(selected)
                ),
                "retrieval_count": int(existing.get("retrieval_count") or 1) + 1,
                "updated_at": time.time(),
            }, scope)
        return self._put("skill_activity", run_id, {
            "run_id": run_id,
            "query": str(query or "")[:500],
            "retrieved": sorted(selected),
            "used": [],
            "retrieval_count": 1,
            "status": "running",
            "created_at": time.time(),
        }, scope)

    def record_view(self, scope: str, run_id: str, skill_name: str) -> None:
        if not run_id or not skill_name:
            return
        activity = self.store.get("skill_activity", run_id, scope)
        if not activity:
            return
        used = sorted(set(activity.get("used", [])) | {skill_name})
        self._put("skill_activity", run_id, dict(activity, used=used,
                                                 last_viewed_at=time.time()), scope)
        node = self.store.get("skill_node", skill_name, scope)
        if node:
            self._put("skill_node", skill_name, dict(node, views=int(node.get("views") or 0) + 1,
                                                     last_viewed=time.time()), scope)

    def finish_run(self, scope: str, run_id: str, success: bool, summary: str = "") -> None:
        if not run_id:
            return
        activity = self.store.get("skill_activity", run_id, scope)
        if not activity or activity.get("status") != "running":
            return
        used = [name for name in activity.get("used", []) if self.store.get("skill_node", name, scope)]
        now = time.time()
        for name in used:
            node = self.store.get("skill_node", name, scope)
            if node:
                self._put("skill_node", name, dict(
                    node,
                    uses=int(node.get("uses") or 0) + 1,
                    successes=int(node.get("successes") or 0) + (1 if success else 0),
                    failures=int(node.get("failures") or 0) + (0 if success else 1),
                    last_used=now,
                ), scope)
        if success and len(used) > 1:
            for left_index, left in enumerate(used):
                for right in used[left_index + 1:]:
                    for source, target in ((left, right), (right, left)):
                        edge_key = _edge_id(source, target, "cooccurrence")
                        edge = self.store.get("skill_edge", edge_key, scope) or {
                            "source": source,
                            "target": target,
                            "kind": "cooccurrence",
                            "weight": 0.4,
                            "evidence": 0,
                            "created_at": now,
                        }
                        evidence = int(edge.get("evidence") or 0) + 1
                        self._put("skill_edge", edge_key, dict(
                            edge,
                            evidence=evidence,
                            weight=min(1.0, 0.4 + math.log1p(evidence) * 0.18),
                            updated_at=now,
                        ), scope)
        self._put("skill_activity", run_id, dict(
            activity,
            status="succeeded" if success else "failed",
            used=used,
            summary=str(summary or "")[:600],
            finished_at=now,
        ), scope)

    def status(self, scope: str, active_skills: int = 0) -> dict[str, Any]:
        nodes = self.store.list("skill_node", scope, limit=1000)
        edges = self.store.list("skill_edge", scope, limit=5000)
        return {
            "active_skills": active_skills,
            "nodes": len([node for node in nodes if node.get("active")]),
            "edges": len(edges),
            "dependency_edges": sum(1 for edge in edges if edge.get("kind") == "dependency"),
            "learned_edges": sum(1 for edge in edges if edge.get("kind") == "cooccurrence"),
            "used_skills": sorted(
                (
                    {
                        "name": node["id"],
                        "uses": int(node.get("uses") or 0),
                        "successes": int(node.get("successes") or 0),
                        "failures": int(node.get("failures") or 0),
                    }
                    for node in nodes if int(node.get("uses") or 0)
                ),
                key=lambda item: (item["successes"], item["uses"]),
                reverse=True,
            )[:8],
        }
