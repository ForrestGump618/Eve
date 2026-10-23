"""Validate bundled skill and agent definition files.

Skills live in ``omicslab/skills/<name>/SKILL.md`` and agents in
``omicslab/agents/<id>.md``. Both are Markdown files with a YAML frontmatter
block delimited by ``---`` lines.

Skill and agent content is authored separately from this test suite, so when
the files are not present yet every test skips with an explicit reason instead
of failing the whole run. Re-run once the content lands:

    pytest tests/test_skills.py -q
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

yaml = pytest.importorskip(
    "yaml",
    reason="PyYAML is required to parse skill/agent frontmatter (pip install -e .)",
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = PROJECT_ROOT / "omicslab" / "skills"
AGENTS_DIR = PROJECT_ROOT / "omicslab" / "agents"

SKILLS_REL = "omicslab/skills"
AGENTS_REL = "omicslab/agents"

REQUIRED_SKILL_FIELDS = ("name", "description", "when_to_use")
REQUIRED_AGENT_FIELDS = ("id", "name", "description", "toolsets")

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

SKILL_FILES: list[Path] = sorted(SKILLS_DIR.glob("*/SKILL.md")) if SKILLS_DIR.is_dir() else []
AGENT_FILES: list[Path] = (
    sorted(
        p
        for p in AGENTS_DIR.glob("*.md")
        if p.name.lower() != "readme.md" and not p.name.startswith("_")
    )
    if AGENTS_DIR.is_dir()
    else []
)


def _rel(path: Path) -> str:
    """Return a repository-relative POSIX path for readable failure messages."""
    try:
        return path.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:  # pragma: no cover - defensive
        return path.as_posix()


def _parse_frontmatter(path: Path) -> dict[str, Any]:
    """Parse the YAML frontmatter of *path* or fail with a readable message."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        pytest.fail(f"{_rel(path)}: file must start with a '---' YAML frontmatter block")

    closing = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if closing is None:
        pytest.fail(f"{_rel(path)}: frontmatter is not closed with a '---' line")

    raw = "\n".join(lines[1:closing])
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        pytest.fail(f"{_rel(path)}: invalid YAML frontmatter: {exc}")

    if not isinstance(data, dict):
        pytest.fail(
            f"{_rel(path)}: frontmatter must be a YAML mapping, got {type(data).__name__}"
        )
    return data


def _body(path: Path) -> str:
    """Return the Markdown body after the frontmatter."""
    lines = path.read_text(encoding="utf-8").splitlines()
    closing = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if closing is None:
        return ""
    return "\n".join(lines[closing + 1 :]).strip()


def _require_available(files: list[Path], directory: Path, rel: str, what: str) -> None:
    if not directory.is_dir():
        pytest.skip(
            f"{rel}/ does not exist yet; {what} are authored separately and will be "
            f"validated once they land. Re-run: pytest tests/test_skills.py -q"
        )
    if not files:
        pytest.skip(
            f"no {what} found under {rel}/ yet; re-run once the content lands. "
            f"(pytest tests/test_skills.py -q)"
        )


def _missing_params(files: list[Path]) -> list[Path | None]:
    """Return ``files``, or ``[None]`` so tests can skip with a clear reason."""
    return list(files) if files else [None]


def _skip_if_missing(path: Path | None, directory: Path, rel: str, what: str) -> Path:
    if path is None:
        _require_available([], directory, rel, what)  # always skips
        raise AssertionError("unreachable")  # pragma: no cover
    return path


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "path",
    _missing_params(SKILL_FILES),
    ids=[p.parent.name for p in SKILL_FILES] or ["skills-missing"],
)
def test_skill_frontmatter_parses(path: Path | None) -> None:
    """Every SKILL.md has a well-formed YAML frontmatter mapping."""
    skill_file = _skip_if_missing(path, SKILLS_DIR, SKILLS_REL, "SKILL.md files")
    meta = _parse_frontmatter(skill_file)
    assert meta, f"{_rel(skill_file)}: frontmatter is empty"


@pytest.mark.parametrize(
    "path",
    _missing_params(SKILL_FILES),
    ids=[p.parent.name for p in SKILL_FILES] or ["skills-missing"],
)
def test_skill_required_fields(path: Path | None) -> None:
    """SKILL.md frontmatter declares name/description/when_to_use as non-empty strings."""
    skill_file = _skip_if_missing(path, SKILLS_DIR, SKILLS_REL, "SKILL.md files")
    meta = _parse_frontmatter(skill_file)

    for field in REQUIRED_SKILL_FIELDS:
        assert field in meta, f"{_rel(skill_file)}: missing required frontmatter field '{field}'"
        value = meta[field]
        assert isinstance(value, str), (
            f"{_rel(skill_file)}: frontmatter field '{field}' must be a string, "
            f"got {type(value).__name__}"
        )
        assert value.strip(), f"{_rel(skill_file)}: frontmatter field '{field}' must not be empty"


@pytest.mark.parametrize(
    "path",
    _missing_params(SKILL_FILES),
    ids=[p.parent.name for p in SKILL_FILES] or ["skills-missing"],
)
def test_skill_name_matches_directory(path: Path | None) -> None:
    """A skill's frontmatter ``name`` matches its directory name and is a slug."""
    skill_file = _skip_if_missing(path, SKILLS_DIR, SKILLS_REL, "SKILL.md files")
    meta = _parse_frontmatter(skill_file)

    name = meta.get("name")
    assert isinstance(name, str) and name.strip(), (
        f"{_rel(skill_file)}: missing non-empty 'name' in frontmatter"
    )
    assert name == skill_file.parent.name, (
        f"{_rel(skill_file)}: frontmatter name '{name}' does not match directory "
        f"'{skill_file.parent.name}'"
    )
    assert SLUG_RE.match(name), (
        f"{_rel(skill_file)}: skill name '{name}' must be a lowercase slug "
        f"([a-z0-9-], starting alphanumeric)"
    )


@pytest.mark.parametrize(
    "path",
    _missing_params(SKILL_FILES),
    ids=[p.parent.name for p in SKILL_FILES] or ["skills-missing"],
)
def test_skill_has_body(path: Path | None) -> None:
    """SKILL.md contains instructions after the frontmatter (not just metadata)."""
    skill_file = _skip_if_missing(path, SKILLS_DIR, SKILLS_REL, "SKILL.md files")
    _parse_frontmatter(skill_file)  # fails early on malformed frontmatter
    assert _body(skill_file), f"{_rel(skill_file)}: body after frontmatter is empty"


def test_skill_names_are_unique() -> None:
    """No two skill directories declare the same frontmatter name."""
    _require_available(SKILL_FILES, SKILLS_DIR, SKILLS_REL, "SKILL.md files")

    seen: dict[str, str] = {}
    for skill_file in SKILL_FILES:
        name = _parse_frontmatter(skill_file).get("name")
        if not isinstance(name, str):
            continue  # covered by test_skill_required_fields
        assert name not in seen, (
            f"duplicate skill name '{name}' in {_rel(skill_file)} and {seen[name]}"
        )
        seen[name] = _rel(skill_file)


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "path",
    _missing_params(AGENT_FILES),
    ids=[p.stem for p in AGENT_FILES] or ["agents-missing"],
)
def test_agent_frontmatter_parses(path: Path | None) -> None:
    """Every agent Markdown file has a well-formed YAML frontmatter mapping."""
    agent_file = _skip_if_missing(path, AGENTS_DIR, AGENTS_REL, "agent files")
    meta = _parse_frontmatter(agent_file)
    assert meta, f"{_rel(agent_file)}: frontmatter is empty"


@pytest.mark.parametrize(
    "path",
    _missing_params(AGENT_FILES),
    ids=[p.stem for p in AGENT_FILES] or ["agents-missing"],
)
def test_agent_required_fields(path: Path | None) -> None:
    """Agent frontmatter declares id/name/description/toolsets."""
    agent_file = _skip_if_missing(path, AGENTS_DIR, AGENTS_REL, "agent files")
    meta = _parse_frontmatter(agent_file)

    for field in REQUIRED_AGENT_FIELDS:
        assert field in meta, f"{_rel(agent_file)}: missing required frontmatter field '{field}'"

    for field in ("id", "name", "description"):
        value = meta[field]
        assert isinstance(value, str), (
            f"{_rel(agent_file)}: frontmatter field '{field}' must be a string, "
            f"got {type(value).__name__}"
        )
        assert value.strip(), f"{_rel(agent_file)}: frontmatter field '{field}' must not be empty"

    toolsets = meta["toolsets"]
    assert isinstance(toolsets, list), (
        f"{_rel(agent_file)}: 'toolsets' must be a list, got {type(toolsets).__name__}"
    )
    for item in toolsets:
        assert isinstance(item, str) and item.strip(), (
            f"{_rel(agent_file)}: every 'toolsets' entry must be a non-empty string, "
            f"got {item!r}"
        )


@pytest.mark.parametrize(
    "path",
    _missing_params(AGENT_FILES),
    ids=[p.stem for p in AGENT_FILES] or ["agents-missing"],
)
def test_agent_id_matches_filename(path: Path | None) -> None:
    """An agent's frontmatter ``id`` matches its file stem and is a slug."""
    agent_file = _skip_if_missing(path, AGENTS_DIR, AGENTS_REL, "agent files")
    meta = _parse_frontmatter(agent_file)

    agent_id = meta.get("id")
    assert isinstance(agent_id, str) and agent_id.strip(), (
        f"{_rel(agent_file)}: missing non-empty 'id' in frontmatter"
    )
    assert agent_id == agent_file.stem, (
        f"{_rel(agent_file)}: frontmatter id '{agent_id}' does not match file name "
        f"'{agent_file.stem}'"
    )
    assert SLUG_RE.match(agent_id), (
        f"{_rel(agent_file)}: agent id '{agent_id}' must be a lowercase slug "
        f"([a-z0-9-], starting alphanumeric)"
    )


@pytest.mark.parametrize(
    "path",
    _missing_params(AGENT_FILES),
    ids=[p.stem for p in AGENT_FILES] or ["agents-missing"],
)
def test_agent_has_body(path: Path | None) -> None:
    """Agent files contain the system instructions after the frontmatter."""
    agent_file = _skip_if_missing(path, AGENTS_DIR, AGENTS_REL, "agent files")
    _parse_frontmatter(agent_file)  # fails early on malformed frontmatter
    assert _body(agent_file), f"{_rel(agent_file)}: body after frontmatter is empty"


def test_agent_ids_are_unique() -> None:
    """No two agent files declare the same frontmatter id."""
    _require_available(AGENT_FILES, AGENTS_DIR, AGENTS_REL, "agent files")

    seen: dict[str, str] = {}
    for agent_file in AGENT_FILES:
        agent_id = _parse_frontmatter(agent_file).get("id")
        if not isinstance(agent_id, str):
            continue  # covered by test_agent_required_fields
        assert agent_id not in seen, (
            f"duplicate agent id '{agent_id}' in {_rel(agent_file)} and {seen[agent_id]}"
        )
        seen[agent_id] = _rel(agent_file)
