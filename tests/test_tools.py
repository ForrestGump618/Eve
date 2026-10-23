"""Tests for the agent tools, approvals, templates, skills and memory modules.

Everything here is offline: the Jupyter kernel is replaced by small fakes and
no LLM provider is contacted. Run with the project virtualenv::

    .venv\\Scripts\\python.exe -m pytest tests/test_tools.py -q
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from omicslab.agent.approvals import Approver
from omicslab.agent.memory import (
    MAX_BODY_BYTES as MEMORY_MAX_BODY_BYTES,
    MemoryError as MemoryStoreError,
    MemoryStore,
)
from omicslab.agent.skills import catalog_text as skills_catalog_text
from omicslab.agent.skills import find_skill, load_skills
from omicslab.agent.templates import BUILTIN_LEAD, get_agent, load_agents
from omicslab.agent.tools import (
    MAX_TOOL_CONTENT,
    ToolContext,
    ToolRegistry,
    ToolSpec,
    build_registry,
)
from omicslab.agent.types import AgentEvent, ToolResult
from omicslab.config import ConfigError, Settings
from omicslab.session.jobs import JobManager
from omicslab.utils import (
    FrontmatterError,
    atomic_write_text,
    human_size,
    iso_now,
    safe_join,
    slugify,
    split_frontmatter,
    strip_ansi,
    truncate,
)

# ---------------------------------------------------------------------------
# Fixtures and fakes
# ---------------------------------------------------------------------------


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    """Isolated Settings rooted in the pytest tmp directory."""
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    result = Settings(workspace=workspace, home=home)
    result.kernel_python = sys.executable
    result.ensure_dirs()
    return result


class FakeKernel:
    """Minimal stand-in for ``omicslab.kernel.KernelService``."""

    def __init__(self, result: dict[str, Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.history: list[dict[str, Any]] = []
        self.info: dict[str, Any] = {"status": "ready", "pid": 4242}
        self.result = result

    async def execute(
        self,
        code: str,
        timeout_s: float | None = None,
        emit: Any = None,
    ) -> dict[str, Any]:
        self.calls.append({"code": code, "timeout_s": timeout_s})
        if self.result is not None:
            payload = dict(self.result)
        else:
            payload = {
                "ok": True,
                "outputs": [
                    {"type": "stream", "name": "stdout", "text": "hello\n"},
                    {"type": "result", "text": "42"},
                ],
                "figures": [
                    {
                        "name": "figure_1.png",
                        "url": "/figures/figure_1.png",
                        "mime": "image/png",
                        "size": 1234,
                    }
                ],
                "duration_ms": 7,
                "error": None,
                "execution_count": 1,
                "interrupted": False,
            }
        self.history.append(
            {
                "code": code,
                "outputs": payload.get("outputs") or [],
                "figures": payload.get("figures") or [],
                "duration_ms": payload.get("duration_ms") or 0,
                "ok": bool(payload.get("ok")),
                "ts": time.time(),
            }
        )
        return payload


class CollectOnlyKernel:
    """Kernel exposing only the ``run_code_collect`` compatibility method."""

    def run_code_collect(self, code: str) -> str:
        return f"collected: {code}"


class BuilderKernel(FakeKernel):
    """Kernel that supplies a ready-made notebook document."""

    def build_notebook(self) -> dict[str, Any]:
        return {
            "cells": [
                {
                    "cell_type": "markdown",
                    "id": "cell-1",
                    "metadata": {},
                    "source": ["# 导出测试"],
                }
            ],
            "metadata": {"kernelspec": {"name": "python3", "language": "python"}},
            "nbformat": 4,
            "nbformat_minor": 5,
        }


def make_ctx(
    settings: Settings,
    *,
    kernel: Any = None,
    registry: ToolRegistry | None = None,
    **overrides: Any,
) -> ToolContext:
    """Build a ToolContext with harmless defaults."""
    ctx = ToolContext(
        settings=settings,
        kernel=FakeKernel() if kernel is None else kernel,
        registry=registry,
        conversation_id="c_test",
        agent_id="lead",
    )
    for key, value in overrides.items():
        setattr(ctx, key, value)
    return ctx


def make_registry(settings: Settings) -> ToolRegistry:
    return build_registry(settings)


async def wait_job(jobs: JobManager, job_id: str, timeout: float = 15.0) -> dict[str, Any]:
    """Poll a job snapshot until it stops running."""
    deadline = time.monotonic() + timeout
    snapshot = jobs.get(job_id)
    while time.monotonic() < deadline:
        snapshot = jobs.get(job_id)
        if snapshot["status"] != "running":
            return snapshot
        await asyncio.sleep(0.05)
    raise AssertionError(f"job {job_id} 未在 {timeout}s 内结束: {snapshot}")


# ---------------------------------------------------------------------------
# Registry surface
# ---------------------------------------------------------------------------


EXPECTED_TOOLS = {
    "run_python_code",
    "run_shell",
    "list_files",
    "read_file",
    "write_file",
    "skill_list",
    "skill_view",
    "memory_list",
    "memory_view",
    "memory_create",
    "memory_edit",
    "agent_list",
    "delegate_agent",
    "submit_background_job",
    "job_status",
    "get_system_info",
    "export_notebook",
}


STAGE2_TOOLSETS = {
    "discovery_create_project",
    "discovery_list_projects",
    "discovery_status",
    "discovery_run",
    "discovery_record_evidence",
    "discovery_report",
    "analyze_image",
    "registry_lookup",
}


def test_registry_exposes_expected_tools(settings: Settings) -> None:
    registry = make_registry(settings)
    names = set(registry.names())
    # Stage-2 tool packs extend the core surface; the core tools must all exist.
    assert EXPECTED_TOOLS <= names
    assert STAGE2_TOOLSETS <= names
    import importlib.util

    if importlib.util.find_spec("paramiko") is not None:
        assert {"ssh_list_profiles", "ssh_exec"} <= names
    assert registry.has("run_python_code")
    assert not registry.has("no_such_tool")
    with pytest.raises(KeyError):
        registry.get("no_such_tool")


def test_tool_schemas_are_openai_compatible(settings: Settings) -> None:
    registry = make_registry(settings)
    declarations = registry.list_specs()
    assert len(declarations) == len(registry.specs())
    for declaration in declarations:
        assert declaration["type"] == "function"
        function = declaration["function"]
        assert isinstance(function["name"], str) and function["name"]
        assert isinstance(function["description"], str) and function["description"]
        parameters = function["parameters"]
        assert parameters["type"] == "object"
        assert isinstance(parameters["properties"], dict)
        assert isinstance(parameters["required"], list)
        # Every required key must be declared as a property.
        assert set(parameters["required"]) <= set(parameters["properties"])


def test_list_specs_filters_by_toolset(settings: Settings) -> None:
    registry = make_registry(settings)
    file_tools = {item["function"]["name"] for item in registry.list_specs(["files"])}
    assert file_tools == {"list_files", "read_file", "write_file"}
    shell_tools = {item["function"]["name"] for item in registry.list_specs(["shell"])}
    assert shell_tools == {"run_shell"}
    assert registry.list_specs([]) == []


def test_dangerous_tools_require_approval(settings: Settings) -> None:
    registry = make_registry(settings)
    assert registry.get("run_shell").requires_approval is True
    assert registry.get("write_file").requires_approval is True
    assert registry.get("run_python_code").requires_approval is False
    assert registry.get("read_file").requires_approval is False


def test_unknown_tool_returns_error_result(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)

    async def run() -> ToolResult:
        return await registry.execute(ctx, "not_a_tool", {})

    result = asyncio.run(run())
    assert isinstance(result, ToolResult)
    assert result.ok is False
    assert result.error
    assert "未知工具" in result.content


def test_invalid_json_arguments_return_error(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)

    async def run() -> ToolResult:
        return await registry.execute(ctx, "run_python_code", "{not valid json")

    result = asyncio.run(run())
    assert result.ok is False
    assert "JSON" in result.content


def test_tool_registry_rejects_duplicates(settings: Settings) -> None:
    async def handler(ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
        return ToolResult(tool_call_id="", name="x", ok=True, content="x")

    spec = ToolSpec(name="x", description="x", parameters={"type": "object"}, toolset="t", handler=handler)
    with pytest.raises(ValueError):
        ToolRegistry([spec, spec])


# ---------------------------------------------------------------------------
# run_python_code
# ---------------------------------------------------------------------------


async def test_run_python_code_success(settings: Settings) -> None:
    registry = make_registry(settings)
    kernel = FakeKernel()
    ctx = make_ctx(settings, kernel=kernel, registry=registry)
    result = await registry.execute(ctx, "run_python_code", {"code": "print('hi')"})
    assert result.ok is True
    assert "hello" in result.content
    assert "42" in result.content
    assert "figure_1.png" in result.content
    assert "执行成功" in result.content
    assert kernel.calls[0]["code"] == "print('hi')"
    assert result.data["execution_count"] == 1
    assert result.data["figures"][0]["name"] == "figure_1.png"
    assert result.duration_ms >= 0


async def test_run_python_code_timeout_argument_forwarded(settings: Settings) -> None:
    registry = make_registry(settings)
    kernel = FakeKernel()
    ctx = make_ctx(settings, kernel=kernel, registry=registry)
    result = await registry.execute(
        ctx, "run_python_code", {"code": "1 + 1", "timeout_s": 12}
    )
    assert result.ok is True
    assert kernel.calls[0]["timeout_s"] == 12


async def test_run_python_code_failure_is_reported(settings: Settings) -> None:
    failure = {
        "ok": False,
        "outputs": [
            {
                "type": "error",
                "ename": "ZeroDivisionError",
                "evalue": "division by zero",
                "traceback": "Traceback...",
            }
        ],
        "figures": [],
        "duration_ms": 3,
        "error": "ZeroDivisionError: division by zero",
        "execution_count": 2,
        "interrupted": False,
    }
    registry = make_registry(settings)
    ctx = make_ctx(settings, kernel=FakeKernel(failure), registry=registry)
    result = await registry.execute(ctx, "run_python_code", {"code": "1 / 0"})
    assert result.ok is False
    assert result.error and "ZeroDivisionError" in result.error
    assert "执行失败" in result.content
    assert "ZeroDivisionError" in result.content


async def test_run_python_code_without_kernel(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    ctx.kernel = None
    result = await registry.execute(ctx, "run_python_code", {"code": "1"})
    assert result.ok is False
    assert "内核" in result.content


async def test_run_python_code_requires_code(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "run_python_code", {})
    assert result.ok is False
    assert "code" in result.content


async def test_run_python_code_truncates_large_output(settings: Settings) -> None:
    big = {
        "ok": True,
        "outputs": [{"type": "stream", "name": "stdout", "text": "x" * 60_000}],
        "figures": [],
        "duration_ms": 1,
        "error": None,
        "execution_count": 1,
        "interrupted": False,
    }
    registry = make_registry(settings)
    ctx = make_ctx(settings, kernel=FakeKernel(big), registry=registry)
    result = await registry.execute(ctx, "run_python_code", {"code": "print('x')"})
    assert result.ok is True
    assert len(result.content) <= MAX_TOOL_CONTENT
    assert "已截断" in result.content


async def test_run_python_code_collect_fallback(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, kernel=CollectOnlyKernel(), registry=registry)
    result = await registry.execute(ctx, "run_python_code", {"code": "print(1)"})
    assert result.ok is True
    assert "collected: print(1)" in result.content


async def test_cancelled_context_blocks_tools(settings: Settings) -> None:
    registry = make_registry(settings)
    cancel_event = asyncio.Event()
    cancel_event.set()
    ctx = make_ctx(settings, registry=registry, cancel_event=cancel_event)
    result = await registry.execute(ctx, "run_python_code", {"code": "1"})
    assert result.ok is False
    assert "取消" in result.content


# ---------------------------------------------------------------------------
# run_shell
# ---------------------------------------------------------------------------


async def test_run_shell_success(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "run_shell", {"command": "echo hello-shell"})
    assert result.ok is True
    assert "hello-shell" in result.content
    assert "退出码 0" in result.content or "[退出码 0]" in result.content
    assert result.data["exit_code"] == 0
    assert Path(result.data["cwd"]).resolve() == settings.workspace.resolve()


async def test_run_shell_rejects_path_escape(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(
        ctx, "run_shell", {"command": "echo nope", "cwd": "../outside"}
    )
    assert result.ok is False
    assert "越界" in result.content


async def test_run_shell_disabled_by_settings(settings: Settings) -> None:
    settings.allow_shell = False
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "run_shell", {"command": "echo nope"})
    assert result.ok is False
    assert "禁用" in result.content


async def test_run_shell_nonzero_exit(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "run_shell", {"command": "exit 3"})
    assert result.ok is False
    assert result.data["exit_code"] != 0


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


async def test_file_roundtrip(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)

    write = await registry.execute(
        ctx, "write_file", {"path": "notes/hello.txt", "content": "你好 OmicsLab"}
    )
    assert write.ok is True
    assert write.data["created"] is True
    assert (settings.workspace / "notes" / "hello.txt").read_text(encoding="utf-8") == "你好 OmicsLab"

    read = await registry.execute(ctx, "read_file", {"path": "notes/hello.txt"})
    assert read.ok is True
    assert "你好 OmicsLab" in read.content
    assert read.data["truncated"] is False

    listing = await registry.execute(ctx, "list_files", {"path": ".", "depth": 2})
    assert listing.ok is True
    paths = {entry["path"] for entry in listing.data["entries"]}
    assert "notes" in paths
    assert any(path.endswith("notes/hello.txt") for path in paths)


async def test_read_file_truncates_by_max_bytes(settings: Settings) -> None:
    (settings.workspace / "big.txt").write_text("a" * 500, encoding="utf-8")
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    read = await registry.execute(ctx, "read_file", {"path": "big.txt", "max_bytes": 100})
    assert read.ok is True
    assert read.data["truncated"] is True
    assert "仅显示前 100 字节" in read.content


async def test_read_file_missing_and_binary(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    missing = await registry.execute(ctx, "read_file", {"path": "nope.txt"})
    assert missing.ok is False
    assert "不存在" in missing.content

    (settings.workspace / "blob.bin").write_bytes(b"\x00\x01\x02binary")
    binary = await registry.execute(ctx, "read_file", {"path": "blob.bin"})
    assert binary.ok is True
    assert "二进制" in binary.content


async def test_file_tools_reject_path_traversal(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    escaped = settings.workspace.parent / "escaped.txt"
    for tool, arguments in (
        ("write_file", {"path": "../escaped.txt", "content": "bad"}),
        ("read_file", {"path": "../escaped.txt"}),
        ("list_files", {"path": "../"}),
        ("write_file", {"path": str(escaped), "content": "bad"}),
    ):
        result = await registry.execute(ctx, tool, arguments)
        assert result.ok is False, tool
        assert "越界" in result.content, tool
    assert not escaped.exists()


async def test_write_file_disabled_by_settings(settings: Settings) -> None:
    settings.allow_file_write = False
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "write_file", {"path": "x.txt", "content": "x"})
    assert result.ok is False
    assert "禁用" in result.content


async def test_write_file_requires_approval_denied(settings: Settings) -> None:
    registry = make_registry(settings)
    approver = Approver(policy="ask", timeout_s=0.1)
    ctx = make_ctx(settings, registry=registry, approver=approver)
    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)

    ctx.emit = emit
    result = await registry.execute(ctx, "write_file", {"path": "denied.txt", "content": "x"})
    assert result.ok is False
    assert "拒绝" in result.content
    assert not (settings.workspace / "denied.txt").exists()
    assert len(events) == 1
    assert events[0].type == "approval_request"
    payload = events[0].data
    # Superset match: the approval center may attach routing/expiry metadata.
    assert {"id", "tool", "arguments", "reason"} <= set(payload)
    assert isinstance(payload["id"], str) and payload["id"].startswith("ap_")
    assert payload["tool"] == "write_file"
    assert isinstance(payload["arguments"], dict)
    assert isinstance(payload["reason"], str) and payload["reason"]
    for key in ("run_id", "conversation_id", "agent_task_id"):
        assert key in payload
        assert isinstance(payload[key], str)
    assert "target" in payload
    assert isinstance(payload["target"], dict)
    assert "expires_at" in payload
    assert isinstance(payload["expires_at"], (int, float))


async def test_write_file_requires_approval_granted(settings: Settings) -> None:
    registry = make_registry(settings)
    approver = Approver(policy="ask", timeout_s=2.0)
    ctx = make_ctx(settings, registry=registry, approver=approver)
    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)
        if event.type == "approval_request":
            assert event.data["id"]
            assert approver.resolve(event.data["id"], True) is True

    ctx.emit = emit
    result = await registry.execute(ctx, "write_file", {"path": "allowed.txt", "content": "ok"})
    assert result.ok is True
    assert (settings.workspace / "allowed.txt").read_text(encoding="utf-8") == "ok"
    assert [event.type for event in events] == ["approval_request"]
    assert approver.pending() == []


async def test_auto_policy_does_not_emit_events(settings: Settings) -> None:
    registry = make_registry(settings)
    approver = Approver(policy="auto", timeout_s=1.0)
    ctx = make_ctx(settings, registry=registry, approver=approver)
    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)

    ctx.emit = emit
    result = await registry.execute(ctx, "write_file", {"path": "auto.txt", "content": "ok"})
    assert result.ok is True
    assert events == []


# ---------------------------------------------------------------------------
# Skills / memory / agents
# ---------------------------------------------------------------------------


def write_skill(root: Path, dirname: str, name: str, body: str) -> Path:
    skill_dir = root / dirname
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: demo 技能\n"
        "when_to_use: 当需要演示工具时\n"
        "---\n"
        f"{body}\n",
        encoding="utf-8",
    )
    return skill_dir


async def test_skill_list_and_view(settings: Settings) -> None:
    write_skill(settings.workspace / "skills", "demo-skill", "demo-skill", "# 演示\n\n这是技能正文。")
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)

    listing = await registry.execute(ctx, "skill_list", {})
    assert listing.ok is True
    names = {item["name"] for item in listing.data["skills"]}
    assert "demo-skill" in names

    view = await registry.execute(ctx, "skill_view", {"name": "demo-skill"})
    assert view.ok is True
    assert "这是技能正文" in view.content
    assert view.data["name"] == "demo-skill"


async def test_skill_view_unknown(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "skill_view", {"name": "missing-skill"})
    assert result.ok is False
    assert "未找到技能" in result.content


def test_skills_skip_broken_skill(settings: Settings) -> None:
    skills_root = settings.workspace / "skills"
    write_skill(skills_root, "good", "good-skill", "正文")
    bad_dir = skills_root / "bad"
    bad_dir.mkdir(parents=True)
    (bad_dir / "SKILL.md").write_text("---\nname: [broken\n---\nbody", encoding="utf-8")
    empty_dir = skills_root / "empty"
    empty_dir.mkdir(parents=True)
    (empty_dir / "SKILL.md").write_text("---\nname: empty\n---\n", encoding="utf-8")

    skills = load_skills(settings)
    assert "good-skill" in skills
    assert "bad" not in skills
    assert "empty" not in skills
    assert find_skill(settings, "good-skill").name == "good-skill"
    with pytest.raises(KeyError):
        find_skill(settings, "nope")
    text = skills_catalog_text(skills)
    assert "good-skill" in text
    assert len(skills_catalog_text(skills, max_chars=20)) <= 20


async def test_memory_tools_crud(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)

    created = await registry.execute(
        ctx,
        "memory_create",
        {"slug": "project_notes", "title": "项目约定", "body": "使用 Python 3.11。"},
    )
    assert created.ok is True
    assert created.data["slug"] == "project_notes"

    duplicate = await registry.execute(
        ctx, "memory_create", {"slug": "project_notes", "title": "t", "body": "b"}
    )
    assert duplicate.ok is False
    assert "已存在" in duplicate.content

    listing = await registry.execute(ctx, "memory_list", {})
    assert listing.ok is True
    assert [item["slug"] for item in listing.data["memories"]] == ["project_notes"]

    view = await registry.execute(ctx, "memory_view", {"slug": "project_notes"})
    assert view.ok is True
    assert "Python 3.11" in view.content

    edited = await registry.execute(
        ctx, "memory_edit", {"slug": "project_notes", "body": "使用 Python 3.12。"}
    )
    assert edited.ok is True
    view_again = await registry.execute(ctx, "memory_view", {"slug": "project_notes"})
    assert "Python 3.12" in view_again.content
    assert "项目约定" in view_again.content

    bad_slug = await registry.execute(
        ctx, "memory_create", {"slug": "bad slug!", "title": "t", "body": "b"}
    )
    assert bad_slug.ok is False


async def test_memory_tools_errors(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    missing = await registry.execute(ctx, "memory_view", {"slug": "nope"})
    assert missing.ok is False
    assert "不存在" in missing.content
    edit_missing = await registry.execute(ctx, "memory_edit", {"slug": "nope", "title": "x"})
    assert edit_missing.ok is False
    assert "不存在" in edit_missing.content


def write_agent(root: Path, filename: str, meta: str, body: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / filename
    path.write_text(f"---\n{meta}---\n{body}\n", encoding="utf-8")
    return path


async def test_agent_list_and_catalog(settings: Settings) -> None:
    write_agent(
        settings.workspace / "agents",
        "reviewer.md",
        "id: reviewer\nname: 复核员\ndescription: 复核分析结论\ntoolsets: [python, files]\n"
        "category: review\nexample_prompts: [帮我复核这个结论]\ntier: open\n",
        "你是一名严谨的复核员。",
    )
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "agent_list", {})
    assert result.ok is True
    agents = {item["id"]: item for item in result.data["agents"]}
    assert "reviewer" in agents
    assert agents["reviewer"]["name"] == "复核员"
    assert agents["reviewer"]["toolsets"] == ["python", "files"]
    assert agents["reviewer"]["example_prompts"] == ["帮我复核这个结论"]

    agents_all = load_agents(settings)
    assert "reviewer" in agents_all
    assert get_agent(settings, "reviewer").description == "复核分析结论"
    assert get_agent(settings, "unknown-agent").id in agents_all


def test_templates_skip_broken_files(settings: Settings) -> None:
    agents_dir = settings.workspace / "agents"
    write_agent(agents_dir, "good.md", "id: good\nname: Good\n", "好智能体")
    (agents_dir / "bad.md").write_text("---\nid: [oops\n---\nbody", encoding="utf-8")
    (agents_dir / "illegal id.md").write_text("---\nid: bad id\n---\nbody", encoding="utf-8")

    agents = load_agents(settings)
    assert "good" in agents
    assert all("bad id" not in key for key in agents)
    assert BUILTIN_LEAD.id == "lead"


async def test_delegate_agent_uses_run_sub(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    calls: list[tuple[str, str | None]] = []

    async def run_sub(prompt: str, agent_id: str | None = None) -> str:
        calls.append((prompt, agent_id))
        return f"子智能体结论：{prompt}"

    ctx.run_sub = run_sub  # type: ignore[attr-defined]
    result = await registry.execute(ctx, "delegate_agent", {"prompt": "检查数据质量"})
    assert result.ok is True
    assert "子智能体结论" in result.content
    assert result.data["mode"] == "subagent"
    assert calls == [("检查数据质量", None)]


async def test_delegate_agent_unknown_agent(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(
        ctx, "delegate_agent", {"prompt": "hi", "agent_id": "no-such-agent"}
    )
    assert result.ok is False
    assert "未知智能体" in result.content


# ---------------------------------------------------------------------------
# System info / notebook / jobs
# ---------------------------------------------------------------------------


async def test_get_system_info(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "get_system_info", {})
    assert result.ok is True
    assert result.data["workspace"] == str(settings.workspace)
    assert result.data["home"] == str(settings.home)
    assert result.data["kernel"]["status"] == "ready"
    assert result.data["skills_count"] is not None
    assert result.data["agents_count"] is not None
    assert "系统信息" in result.content


async def test_export_notebook_from_history(settings: Settings) -> None:
    registry = make_registry(settings)
    kernel = FakeKernel()
    ctx = make_ctx(settings, kernel=kernel, registry=registry)
    await registry.execute(ctx, "run_python_code", {"code": "x = 1"})
    result = await registry.execute(ctx, "export_notebook", {"path": "out/report.ipynb"})
    assert result.ok is True
    assert result.data["cells"] == 1
    payload = json.loads((settings.workspace / "out" / "report.ipynb").read_text(encoding="utf-8"))
    assert payload["nbformat"] == 4
    assert payload["nbformat_minor"] == 5
    assert len(payload["cells"]) == 1
    assert "".join(payload["cells"][0]["source"]) == "x = 1"
    assert payload["cells"][0]["outputs"]


async def test_export_notebook_uses_kernel_builder(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, kernel=BuilderKernel(), registry=registry)
    result = await registry.execute(ctx, "export_notebook", {})
    assert result.ok is True
    assert result.data["cells"] == 1
    exported = settings.workspace / result.data["path"]
    payload = json.loads(exported.read_text(encoding="utf-8"))
    assert payload["cells"][0]["cell_type"] == "markdown"


async def test_export_notebook_rejects_escape(settings: Settings) -> None:
    registry = make_registry(settings)
    ctx = make_ctx(settings, registry=registry)
    result = await registry.execute(ctx, "export_notebook", {"path": "../escape.ipynb"})
    assert result.ok is False
    assert "越界" in result.content


async def test_background_job_tools(settings: Settings) -> None:
    registry = make_registry(settings)
    jobs = JobManager(settings)
    ctx = make_ctx(settings, registry=registry, jobs=jobs)
    try:
        submit = await registry.execute(
            ctx,
            "submit_background_job",
            {"kind": "python", "code": "print('job-ok')", "name": "测试任务"},
        )
        assert submit.ok is True
        job_id = submit.data["job"]["id"]
        assert re.fullmatch(r"j_[0-9a-f]{8}", job_id)

        snapshot = await wait_job(jobs, job_id)
        assert snapshot["status"] == "done"
        assert snapshot["exit_code"] == 0

        status = await registry.execute(ctx, "job_status", {"job_id": job_id, "tail": 4000})
        assert status.ok is True
        assert "job-ok" in (status.data["log"]["text"] or "")
        assert status.data["job"]["status"] == "done"

        listed = await registry.execute(ctx, "job_status", {})
        assert listed.ok is True
        assert any(item["id"] == job_id for item in listed.data["jobs"])

        unknown = await registry.execute(ctx, "job_status", {"job_id": "j_00000000"})
        assert unknown.ok is False
        assert "不存在" in unknown.content
    finally:
        jobs.shutdown()


async def test_submit_background_job_validates_kind(settings: Settings) -> None:
    registry = make_registry(settings)
    jobs = JobManager(settings)
    ctx = make_ctx(settings, registry=registry, jobs=jobs)
    try:
        result = await registry.execute(ctx, "submit_background_job", {"kind": "ruby", "code": "1"})
        assert result.ok is False
        assert "kind" in result.content
        empty = await registry.execute(ctx, "submit_background_job", {"kind": "python", "code": ""})
        assert empty.ok is False
    finally:
        jobs.shutdown()


async def test_background_shell_job(settings: Settings) -> None:
    registry = make_registry(settings)
    jobs = JobManager(settings)
    ctx = make_ctx(settings, registry=registry, jobs=jobs)
    try:
        submit = await registry.execute(
            ctx, "submit_background_job", {"kind": "shell", "code": "echo shell-job-ok"}
        )
        assert submit.ok is True
        job_id = submit.data["job"]["id"]
        snapshot = await wait_job(jobs, job_id)
        assert snapshot["status"] == "done"
        payload = jobs.log(job_id, 0)
        assert "shell-job-ok" in payload["text"]
    finally:
        jobs.shutdown()


# ---------------------------------------------------------------------------
# Approver
# ---------------------------------------------------------------------------


async def test_approver_auto_policy(settings: Settings) -> None:
    approver = Approver(policy="auto", timeout_s=1.0)
    ctx = ToolContext(settings=settings, approver=approver)
    assert await approver.request(ctx, "run_shell", {"command": "x"}, "reason") is True
    assert approver.pending() == []


def test_approver_normalises_policy(settings: Settings) -> None:
    approver = Approver(policy="bogus", timeout_s=1.0)
    assert approver.policy == "auto"
    assert Approver(policy="ask", timeout_s=0).timeout_s == pytest.approx(0.01)


async def test_approver_resolve_flow() -> None:
    settings = None  # the approver does not read settings, keep the test light
    approver = Approver(policy="ask", timeout_s=2.0)
    ctx = ToolContext(settings=settings)  # type: ignore[arg-type]
    events: list[AgentEvent] = []

    async def emit(event: AgentEvent) -> None:
        events.append(event)

    ctx.emit = emit
    task = asyncio.create_task(approver.request(ctx, "write_file", {"path": "a"}, "需要批准"))
    while not events:
        await asyncio.sleep(0.01)
    event = events[0]
    assert event.type == "approval_request"
    assert event.data["tool"] == "write_file"
    assert event.data["reason"] == "需要批准"
    pending = approver.pending()
    assert len(pending) == 1
    assert pending[0]["id"] == event.data["id"]
    assert approver.resolve(event.data["id"], True) is True
    assert await task is True
    assert approver.pending() == []


async def test_approver_timeout_denies(settings: Settings) -> None:
    approver = Approver(policy="ask", timeout_s=0.05)
    ctx = ToolContext(settings=settings, approver=approver)

    async def emit(event: AgentEvent) -> None:
        return None

    ctx.emit = emit
    started = time.monotonic()
    result = await approver.request(ctx, "run_shell", {"command": "x"}, "reason")
    assert result is False
    assert time.monotonic() - started < 2.0
    assert approver.pending() == []


async def test_approver_cancelled_context(settings: Settings) -> None:
    approver = Approver(policy="ask", timeout_s=5.0)
    cancel_event = asyncio.Event()
    cancel_event.set()
    ctx = ToolContext(settings=settings, approver=approver, cancel_event=cancel_event)
    assert await approver.request(ctx, "write_file", {}, "reason") is False


def test_approver_resolve_unknown(settings: Settings) -> None:
    approver = Approver(policy="ask", timeout_s=1.0)
    assert approver.resolve("appr_missing", True) is False
    assert approver.cancel_all("test") == 0


# ---------------------------------------------------------------------------
# Memory store and utility helpers
# ---------------------------------------------------------------------------


def test_memory_store_direct(settings: Settings) -> None:
    store = MemoryStore(settings)
    assert store.list() == []
    assert store.index_text() == "（暂无长期记忆）"

    item = store.put("slug_1", "标题一", "正文一")
    assert item["body"] == "正文一"
    assert (settings.memory_dir / "slug_1.md").is_file()

    assert [entry["slug"] for entry in store.list()] == ["slug_1"]
    assert store.search("正文一")[0]["slug"] == "slug_1"
    assert store.search("不存在的关键词") == []
    assert store.delete("slug_1") is True
    assert store.delete("slug_1") is False
    with pytest.raises(KeyError):
        store.get("slug_1")

    with pytest.raises(MemoryStoreError):
        store.put("bad slug", "t", "b")
    with pytest.raises(MemoryStoreError):
        store.put("too_big", "t", "x" * (MEMORY_MAX_BODY_BYTES + 1))


def test_utils_helpers(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    target = safe_join(root, "a", "b.txt")
    assert target == (root / "a" / "b.txt").resolve()
    with pytest.raises(ValueError):
        safe_join(root, "../escape.txt")

    written = atomic_write_text(root / "nested" / "file.txt", "内容")
    assert written.read_text(encoding="utf-8") == "内容"

    assert human_size(0) == "0 B"
    assert human_size(1536) == "1.5 KB"
    assert truncate("abcdef", 3) == "abc"
    assert "已截断" in truncate("a" * 200, 80)
    assert strip_ansi("\x1b[31mred\x1b[0m") == "red"
    assert slugify("Hello 世界!") == "hello"
    assert slugify("!!!", default="x") == "x"
    assert iso_now()

    meta, body = split_frontmatter("---\nname: demo\ntags: [a, b]\n---\n正文")
    assert meta["name"] == "demo"
    assert meta["tags"] == ["a", "b"]
    assert body == "正文"
    with pytest.raises(FrontmatterError):
        split_frontmatter("---\nname: [broken\n---\nbody")
    assert split_frontmatter("无 frontmatter") == ({}, "无 frontmatter")


def test_settings_fixture_sandbox(settings: Settings) -> None:
    assert settings.home.is_dir()
    assert settings.workspace.is_dir()
    assert settings.conversations_dir.is_dir()
    assert settings.memory_dir.is_dir()
    assert settings.jobs_dir.is_dir()
