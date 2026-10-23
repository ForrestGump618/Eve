"""Skill discovery and loading.

A *skill* is a directory containing a ``SKILL.md`` file::

    my-skill/
      SKILL.md          # YAML frontmatter + Markdown operating guide
      scripts/qc.py     # optional helper assets

Root directories are scanned in priority order (first hit besides the name
wins):

1. ``$OMICSLAB_SKILL_ROOTS`` — ``;`` separated on Windows (also accepts the
   platform path separator);
2. the bundled package directory ``omicslab/skills``;
3. ``<workspace>/skills``.

Broken skills are skipped with a warning; loading must never crash the app.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omicslab.config import Settings, load_settings
from omicslab.utils import FrontmatterError, split_frontmatter, truncate

logger = logging.getLogger("omicslab.agent.skills")

MAX_FILES = 1000
SKILL_FILE = "SKILL.md"


@dataclass
class Skill:
    """One skill loaded from disk."""

    name: str
    description: str
    when_to_use: str
    body: str
    path: Path
    source: str = "bundled"
    files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialise for the REST API (``GET /api/skills``)."""
        return {
            "name": self.name,
            "description": self.description,
            "when_to_use": self.when_to_use,
            "source": self.source,
            "path": str(self.path),
            "files": list(self.files),
        }


# ---------------------------------------------------------------------------
# Root discovery
# ---------------------------------------------------------------------------


def package_skills_dir() -> Path:
    """``omicslab/skills`` inside the installed package."""
    return Path(__file__).resolve().parent.parent / "skills"


def _split_env_roots(raw: str) -> list[Path]:
    """Split ``$OMICSLAB_SKILL_ROOTS`` into paths.

    Handles Windows drive letters correctly by splitting on ``;`` first and
    only then on the platform separator when it differs.
    """
    value = (raw or "").strip()
    if not value:
        return []
    chunks: list[str] = []
    for chunk in value.split(";"):
        if os.pathsep and os.pathsep != ";" and os.pathsep in chunk:
            chunks.extend(chunk.split(os.pathsep))
        else:
            chunks.append(chunk)
    roots: list[Path] = []
    for chunk in chunks:
        text = chunk.strip().strip('"').strip("'")
        if text:
            roots.append(Path(text).expanduser())
    return roots


def skill_roots(settings: Settings) -> list[tuple[Path, str]]:
    """Return ``(directory, source)`` pairs in priority order (deduplicated)."""
    pairs: list[tuple[Path, str]] = []
    for root in _split_env_roots(os.environ.get("OMICSLAB_SKILL_ROOTS", "")):
        pairs.append((root, "env"))
    pairs.append((package_skills_dir(), "bundled"))
    workspace = getattr(settings, "workspace", None)
    if workspace is not None:
        pairs.append((Path(workspace) / "skills", "workspace"))

    seen: set[str] = set()
    unique: list[tuple[Path, str]] = []
    for directory, source in pairs:
        try:
            key = os.path.normcase(str(directory.resolve()))
        except (OSError, RuntimeError):
            key = os.path.normcase(str(directory))
        if key in seen:
            continue
        seen.add(key)
        unique.append((directory, source))
    return unique


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _safe_skill_name(name: str) -> bool:
    clean = name.strip()
    if not clean or len(clean) > 200:
        return False
    return not any(ch in clean for ch in "/\\:*?\"<>|\t\r\n")


def _list_files(skill_dir: Path) -> list[str]:
    """Return relative POSIX paths of auxiliary files (excluding SKILL.md)."""
    out: list[str] = []
    try:
        entries = sorted(skill_dir.rglob("*"))
    except OSError as exc:  # pragma: no cover - unusual fs failure
        logger.warning("无法列出技能目录 %s: %s", skill_dir, exc)
        return out
    for entry in entries:
        try:
            if not entry.is_file():
                continue
        except OSError:
            continue
        if entry.name == SKILL_FILE and entry.parent == skill_dir:
            continue
        try:
            rel = entry.relative_to(skill_dir).as_posix()
        except ValueError:  # pragma: no cover - rglob should stay inside
            continue
        out.append(rel)
        if len(out) >= MAX_FILES:
            logger.warning("技能 %s 的附带文件超过 %d 个，已截断", skill_dir.name, MAX_FILES)
            break
    return out


def _parse_skill_dir(skill_dir: Path, source: str) -> Skill | None:
    """Parse one skill directory; return None when it is unusable."""
    skill_file = skill_dir / SKILL_FILE
    if not skill_file.is_file():
        logger.warning("技能目录 %s 缺少 %s，已跳过", skill_dir, SKILL_FILE)
        return None
    try:
        text = skill_file.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("无法读取技能文件 %s: %s", skill_file, exc)
        return None

    try:
        meta, body = split_frontmatter(text)
    except FrontmatterError as exc:
        logger.warning("跳过 frontmatter 损坏的技能 %s: %s", skill_file, exc)
        return None

    name = str(meta.get("name") or skill_dir.name).strip()
    if not _safe_skill_name(name):
        logger.warning("跳过名称非法的技能 %s（name=%r）", skill_file, name)
        return None
    body_text = body.strip()
    description = str(meta.get("description") or "").strip()
    when_to_use = str(meta.get("when_to_use") or "").strip()
    if not description:
        description = _first_sentence(body_text) or name
    if not body_text:
        logger.warning("技能 %s 没有正文，已跳过", skill_file)
        return None

    return Skill(
        name=name,
        description=description,
        when_to_use=when_to_use,
        body=body_text,
        path=skill_file,
        source=source,
        files=_list_files(skill_dir),
    )


def _first_sentence(text: str, limit: int = 160) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return ""
    for separator in ("。", "！", "？", ". ", "\n"):
        index = clean.find(separator)
        if 0 < index < limit:
            return clean[: index + 1].strip()
    return clean[:limit].strip()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load_skills(settings: Settings | None = None) -> dict[str, Skill]:
    """Load every discoverable skill, keyed by name (first root wins).

    ``settings`` may be omitted to load the shipped catalogue with the default
    configuration (useful for tooling and tests).
    """
    settings = settings or load_settings()
    skills: dict[str, Skill] = {}
    for directory, source in skill_roots(settings):
        try:
            if not directory.is_dir():
                continue
            subdirs = sorted(
                (entry for entry in directory.iterdir() if entry.is_dir()),
                key=lambda entry: entry.name.lower(),
            )
        except OSError as exc:  # pragma: no cover - unusual fs failure
            logger.warning("无法扫描技能根目录 %s: %s", directory, exc)
            continue
        for skill_dir in subdirs:
            try:
                if not (skill_dir / SKILL_FILE).is_file():
                    continue
            except OSError:
                continue
            skill = _parse_skill_dir(skill_dir, source)
            if skill is None:
                continue
            if skill.name in skills:
                logger.debug("技能 %s 已被更高优先级目录覆盖，忽略 %s", skill.name, skill_dir)
                continue
            skills[skill.name] = skill
    logger.info("已加载 %d 个技能", len(skills))
    return skills


def find_skill(settings: Settings | None, name: str) -> Skill:
    """Return one skill by name; raises ``KeyError`` when it is missing."""
    wanted = str(name or "").strip()
    skills = load_skills(settings)
    if wanted in skills:
        return skills[wanted]
    # Accept the directory name as an alias when frontmatter renamed the skill.
    for skill in skills.values():
        if skill.path.parent.name == wanted:
            return skill
    raise KeyError(wanted)


def catalog_text(skills: dict[str, Skill], max_chars: int = 6000) -> str:
    """Render the skill catalogue injected into the agent system prompt."""
    if not skills:
        return "（当前没有可用技能。你可以直接用 Python 分析，或让用户添加技能目录。）"
    lines = [f"## 可用技能（{len(skills)} 个，按需用 skill_view 查看完整指南）"]
    for skill in skills.values():
        lines.append(f"- **{skill.name}**：{skill.description}")
        if skill.when_to_use:
            lines.append(f"  - 适用场景：{skill.when_to_use}")
    return truncate("\n".join(lines), max_chars)


def skill_detail_text(skill: Skill) -> str:
    """Render a full skill as Markdown for the ``skill_view`` tool."""
    lines = [f"# 技能：{skill.name}", ""]
    if skill.description:
        lines.extend([skill.description, ""])
    if skill.when_to_use:
        lines.extend([f"**适用场景**：{skill.when_to_use}", ""])
    lines.append(skill.body)
    if skill.files:
        lines.extend(["", "## 附带文件", ""])
        lines.extend(f"- {item}" for item in skill.files[:200])
    return "\n".join(lines)
