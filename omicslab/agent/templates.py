"""Agent template loading (Markdown + YAML frontmatter).

Search order (later directories override earlier ones with the same ``id``):

1. bundled package directory ``omicslab/agents/*.md``;
2. ``<workspace>/agents/*.md``;
3. ``$OMICSLAB_TEMPLATES_DIR/*.md``.

A malformed template is skipped with a warning; it must never crash startup.
When no template file is available at all, a built-in ``lead`` agent is
returned so the product remains usable out of the box.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omicslab.config import Settings, load_settings
from omicslab.utils import FrontmatterError, split_frontmatter

logger = logging.getLogger("omicslab.agent.templates")

# Sensible default toolset list for an agent that does not declare one.
DEFAULT_TOOLSETS: list[str] = [
    "python",
    "files",
    "skills",
    "memory",
    "agents",
    "jobs",
    "system",
    "notebook",
    "shell",
    "mcp",
]

_LEAD_INSTRUCTIONS = """\
你是 素问 Suwen 的分析负责人（lead agent）。素问 Suwen 是一个本地优先的生物医学分析工作台。

工作方式：
1. 先规划：理解用户目标，列出 2-5 步计划，再开始执行。
2. 复用内核状态：Python 内核在会话内持久，变量（如 `adata`）会一直存在；不要重复读取已有变量。
3. 用工具而不是猜测：需要计算/读文件/查看技能时，调用相应工具获取真实结果。
4. 图表落盘：绘图后保存到 `figures/` 目录，并在回答中引用图名，便于前端展示。
5. 结论要有依据：报告关键数字、阈值与统计方法；不确定时明确说明。
6. 最终产出：简洁的中文总结 + 关键结果 + 下一步建议。

安全约定：写入文件和执行 shell 命令需要用户批准；不要尝试访问工作区之外的路径。
"""

@dataclass
class AgentTemplate:
    """One agent definition loaded from Markdown."""

    id: str
    name: str
    description: str
    instructions: str
    toolsets: list[str] = field(default_factory=lambda: list(DEFAULT_TOOLSETS))
    skills: list[str] = field(default_factory=list)
    category: str = "general"
    example_prompts: list[str] = field(default_factory=list)
    tier: str = "open"
    source: str = "builtin"
    path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialise for the REST API (``GET /api/agents``)."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "source": self.source,
            "toolsets": list(self.toolsets),
            "skills": list(self.skills),
            "example_prompts": list(self.example_prompts),
            "tier": self.tier,
            "path": self.path,
        }


# Built after the dataclass exists (kept near the top for readability).
BUILTIN_LEAD = AgentTemplate(
    id="lead",
    name="素问 Suwen 分析负责人",
    description="通用生物医学分析负责人：规划任务、调用工具、复用内核状态并产出结论。",
    instructions=_LEAD_INSTRUCTIONS,
    toolsets=list(DEFAULT_TOOLSETS),
    skills=[],
    category="general",
    example_prompts=[
        "读取 data/demo_counts.csv，做一次表达矩阵的质控并画图。",
        "用 scanpy 对这份 h5ad 做标准的单细胞上游分析，并解释每一步。",
        "检查当前 Python 内核里有哪些变量，总结它们的形状与类型。",
    ],
    tier="open",
    source="builtin",
    path=None,
)


# ---------------------------------------------------------------------------
# Directory discovery
# ---------------------------------------------------------------------------


def package_agents_dir() -> Path:
    """``omicslab/agents`` inside the installed package."""
    return Path(__file__).resolve().parent.parent / "agents"


def template_dirs(settings: Settings) -> list[tuple[Path, str]]:
    """Return ``(directory, source)`` pairs in load priority order."""
    dirs: list[tuple[Path, str]] = [(package_agents_dir(), "bundled")]
    workspace = getattr(settings, "workspace", None)
    if workspace is not None:
        dirs.append((Path(workspace) / "agents", "workspace"))
    env_dir = os.environ.get("OMICSLAB_TEMPLATES_DIR", "").strip()
    if env_dir:
        dirs.append((Path(env_dir).expanduser(), "external"))
    return dirs


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _as_str_list(value: Any) -> list[str]:
    """Coerce a frontmatter value into a list of non-empty strings."""
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if "\n" in text:
            parts = text.splitlines()
        elif "," in text:
            parts = text.split(",")
        else:
            parts = [text]
        return [part.strip() for part in parts if part.strip()]
    if isinstance(value, (list, tuple, set)):
        out: list[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                out.append(text)
        return out
    text = str(value).strip()
    return [text] if text else []


def _parse_agent_file(path: Path, source: str) -> AgentTemplate | None:
    """Parse one Markdown agent file; return None when it is unusable."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("跳过无法读取的智能体模板 %s: %s", path, exc)
        return None

    try:
        meta, body = split_frontmatter(text)
    except FrontmatterError as exc:
        logger.warning("跳过 frontmatter 损坏的智能体模板 %s: %s", path, exc)
        return None

    agent_id = str(meta.get("id") or path.stem).strip()
    if not agent_id:
        logger.warning("跳过缺少 id 的智能体模板: %s", path)
        return None
    # Ids are used in URLs and file lookups: keep them simple and safe.
    if any(ch in agent_id for ch in "/\\:*?\"<>| \t\r\n"):
        logger.warning("跳过 id 非法的智能体模板 %s（id=%r）", path, agent_id)
        return None

    instructions = body.strip()
    description = str(meta.get("description") or "").strip()
    name = str(meta.get("name") or agent_id).strip() or agent_id
    if not instructions:
        instructions = description or f"你是 {name}，请帮助用户完成生物医学分析任务。"
        logger.warning("智能体模板 %s 没有正文，使用占位 instructions", path)

    toolsets = _as_str_list(meta.get("toolsets")) or list(DEFAULT_TOOLSETS)
    return AgentTemplate(
        id=agent_id,
        name=name,
        description=description or name,
        instructions=instructions,
        toolsets=toolsets,
        skills=_as_str_list(meta.get("skills")),
        category=str(meta.get("category") or "general").strip() or "general",
        example_prompts=_as_str_list(meta.get("example_prompts")),
        tier=str(meta.get("tier") or "open").strip() or "open",
        source=source,
        path=str(path),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load_agents(settings: Settings | None = None) -> dict[str, AgentTemplate]:
    """Load every discoverable agent template, keyed by id.

    Later sources override earlier ones. Never raises for bad files. When
    ``settings`` is omitted the default configuration is loaded, so callers
    that only need the shipped catalogue can call ``load_agents()``.
    """
    settings = settings or load_settings()
    agents: dict[str, AgentTemplate] = {}
    for directory, source in template_dirs(settings):
        try:
            if not directory.is_dir():
                continue
            paths = sorted(directory.glob("*.md"))
        except OSError as exc:  # pragma: no cover - unusual fs failure
            logger.warning("无法扫描智能体目录 %s: %s", directory, exc)
            continue
        for path in paths:
            template = _parse_agent_file(path, source)
            if template is None:
                continue
            if template.id in agents:
                logger.debug("智能体 %s 被 %s 覆盖", template.id, path)
            agents[template.id] = template

    if not agents:
        logger.info("未发现任何智能体模板，使用内置 lead 智能体")
        agents["lead"] = BUILTIN_LEAD
    return agents


def get_agent(
    settings: Settings,
    agent_id: str,
    agents: dict[str, AgentTemplate] | None = None,
) -> AgentTemplate:
    """Resolve an agent by id, falling back to ``lead`` and finally built-in lead."""
    registry = agents if agents is not None else load_agents(settings)
    wanted = str(agent_id or "lead").strip() or "lead"
    template = registry.get(wanted)
    if template is not None:
        return template
    logger.warning("未知智能体 %r，回退到 lead", wanted)
    if "lead" in registry:
        return registry["lead"]
    return BUILTIN_LEAD


def catalog_text(agents: dict[str, AgentTemplate]) -> str:
    """Compact catalog used by the ``agent_list`` tool."""
    if not agents:
        return "（暂无可用智能体）"
    lines = [f"可用智能体（{len(agents)} 个）："]
    for template in agents.values():
        lines.append(f"- {template.id}（{template.name}）：{template.description}")
        if template.example_prompts:
            lines.append(f"  示例：{template.example_prompts[0]}")
    return "\n".join(lines)
