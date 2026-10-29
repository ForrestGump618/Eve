"""Skill graph retrieval and execution-feedback regressions."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from omicslab.agent.skills import Skill
from omicslab.agent.templates import load_agents
from omicslab.agent.tools import build_registry
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
        llm_info=lambda: {
            "provider": "mock",
            "model": "mock-model",
            "configured": True,
        },
        vision_info=lambda: {
            "enabled": False,
            "configured": False,
            "model": "",
            "base_url": "",
            "has_key": False,
        },
        rebuild_approver=lambda: None,
    )
    store = __import__(
        "omicslab.session.store",
        fromlist=["ConversationStore"],
    ).ConversationStore(settings)
    state.store = store
    service = Platform(state)
    state.platform = service
    yield service
    service.store.close()


def skill(name: str, dependencies: list[str] | None = None, body: str = "") -> Skill:
    return Skill(
        name=name,
        description=f"{name} workflow",
        when_to_use=f"Use {name} for this scientific method.",
        body=body,
        path=Path(f"/skills/{name}"),
        dependencies=list(dependencies or []),
    )


def test_select_returns_full_transitive_dependency_closure(platform):
    skills = {
        "alpha": skill("alpha", ["beta"]),
        "beta": skill("beta", ["gamma"]),
        "gamma": skill("gamma"),
        "unrelated": skill("unrelated"),
    }
    selected = platform.skill_graph.select(
        "ws_main",
        "alpha scientific workflow",
        skills,
        max_skills=8,
        max_chars=10_000,
    )
    assert {"alpha", "beta", "gamma"} <= set(selected)


def test_select_handles_dependency_cycles_without_recursion(platform):
    skills = {
        "alpha": skill("alpha", ["beta"]),
        "beta": skill("beta", ["alpha"]),
    }
    selected = platform.skill_graph.select(
        "ws_main",
        "alpha workflow",
        skills,
        max_skills=4,
        max_chars=10_000,
    )
    assert set(selected) == {"alpha", "beta"}


def test_select_never_returns_partial_chain_when_character_budget_is_too_small(platform):
    skills = {
        "alpha": skill("alpha", ["beta"]),
        "beta": skill("beta", ["gamma"]),
        "gamma": skill("gamma"),
    }
    selected = platform.skill_graph.select(
        "ws_main",
        "alpha scientific workflow",
        skills,
        max_skills=8,
        max_chars=1,
    )
    assert selected == {}


def test_unchanged_skill_graph_sync_does_not_rewrite_nodes(platform):
    skills = {
        "alpha": skill("alpha", ["beta"]),
        "beta": skill("beta"),
    }
    platform.skill_graph.sync("ws_main", skills)
    before = {
        name: platform.store.get("skill_node", name, "ws_main")["revision"]
        for name in skills
    }
    platform.skill_graph.sync("ws_main", skills)
    after = {
        name: platform.store.get("skill_node", name, "ws_main")["revision"]
        for name in skills
    }
    assert after == before


def test_failed_run_updates_failures_without_learning_cooccurrence(platform):
    skills = {
        "alpha": skill("alpha"),
        "beta": skill("beta"),
    }
    platform.skill_graph.sync("ws_main", skills)
    platform.skill_graph.record_retrieval("ws_main", "run-failed", "alpha", skills)
    platform.skill_graph.record_view("ws_main", "run-failed", "alpha")
    platform.skill_graph.record_view("ws_main", "run-failed", "beta")
    platform.skill_graph.finish_run("ws_main", "run-failed", False, "validation failed")
    assert not [
        edge
        for edge in platform.store.list("skill_edge", "ws_main")
        if edge.get("kind") == "cooccurrence"
    ]
    for name in skills:
        node = platform.store.get("skill_node", name, "ws_main")
        assert node["failures"] == 1
        assert node["successes"] == 0


def test_success_feedback_strengthens_cooccurrence_and_surfaces_usage(platform):
    skills = {
        "alpha": skill("alpha"),
        "beta": skill("beta"),
    }
    platform.skill_graph.sync("ws_main", skills)
    platform.skill_graph.record_retrieval("ws_main", "run-success", "alpha", skills)
    platform.skill_graph.record_view("ws_main", "run-success", "alpha")
    platform.skill_graph.record_view("ws_main", "run-success", "beta")
    platform.skill_graph.finish_run("ws_main", "run-success", True, "validated")
    edges = [
        edge
        for edge in platform.store.list("skill_edge", "ws_main")
        if edge.get("kind") == "cooccurrence"
    ]
    assert edges and all(edge["evidence"] == 1 for edge in edges)
    status = platform.skill_graph.status("ws_main", len(skills))
    assert status["learned_edges"] == 2
    assert {row["name"] for row in status["used_skills"]} == {"alpha", "beta"}
