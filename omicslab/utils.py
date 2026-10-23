"""Shared low-level helpers used across OmicsLab modules.

This module intentionally depends on the standard library only (PyYAML is
imported lazily and degrades to a tiny built-in parser when unavailable):

- atomic text/bytes writes (temp file + ``os.replace``, with Windows retries);
- workspace sandbox path joining;
- formatting helpers (human sizes, truncation, ANSI stripping, slugs, time);
- YAML frontmatter parsing for agent templates / skills / memories.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
import re
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("omicslab.utils")

# ---------------------------------------------------------------------------
# Atomic file IO
# ---------------------------------------------------------------------------


def _unlink_quiet(path: Path) -> None:
    """Best-effort removal of a temporary file."""
    try:
        path.unlink()
    except OSError:
        pass


def atomic_write_bytes(path: str | Path, data: bytes) -> Path:
    """Write ``data`` to ``path`` atomically (temp file + ``os.replace``)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            try:
                fh.flush()
                os.fsync(fh.fileno())
            except OSError:
                # Some filesystems (or hardened Windows ACLs) deny fsync; the
                # write itself already succeeded, so keep going.
                pass
    except BaseException:
        _unlink_quiet(tmp)
        raise

    last_error: OSError | None = None
    for attempt in range(5):
        try:
            os.replace(tmp, target)
            return target
        except OSError as exc:  # e.g. Windows: target briefly locked
            last_error = exc
            if attempt < 4:
                time.sleep(0.02 * (attempt + 1))
    _unlink_quiet(tmp)
    if last_error is not None:
        raise last_error
    return target


def atomic_write_text(path: str | Path, text: str, encoding: str = "utf-8") -> Path:
    """Write text atomically; parent directories are created when missing."""
    if text is None:
        text = ""
    if not isinstance(text, str):
        text = str(text)
    return atomic_write_bytes(path, text.encode(encoding, errors="replace"))


def read_text_best_effort(path: str | Path, limit: int | None = None, encoding: str = "utf-8") -> str:
    """Read a text file, tolerating decode errors and (optionally) truncating."""
    target = Path(path)
    with open(target, "rb") as fh:
        raw = fh.read(limit) if limit is not None and limit > 0 else fh.read()
    return raw.decode(encoding, errors="replace")


# ---------------------------------------------------------------------------
# Workspace sandbox
# ---------------------------------------------------------------------------


def safe_join(root: str | Path, *parts: str | Path) -> Path:
    """Join ``parts`` onto ``root`` while refusing to escape ``root``.

    Raises:
        ValueError: with a Chinese, user-facing message when the candidate
            path is absolute, on another drive, or resolves outside the root
            (including through symlinks).
    """
    root_path = Path(root).expanduser()
    try:
        root_resolved = root_path.resolve()
    except (OSError, RuntimeError):
        root_resolved = root_path.absolute()

    if not parts:
        return root_resolved

    raw_parts: list[str] = []
    for part in parts:
        candidate = Path(str(part))
        if candidate.is_absolute():
            raise ValueError(f"路径越界：不允许绝对路径 '{candidate}'，请使用相对于工作区的路径。")
        if candidate.drive and path_drive(root_resolved) and candidate.drive.lower() != path_drive(root_resolved).lower():
            raise ValueError(f"路径越界：'{candidate}' 位于其他磁盘。")
        raw_parts.append(str(candidate))

    candidate = root_resolved.joinpath(*raw_parts)
    try:
        resolved = candidate.resolve()
    except (OSError, RuntimeError):
        resolved = candidate.absolute()

    if resolved != root_resolved and not resolved.is_relative_to(root_resolved):
        raise ValueError(f"路径越界：'{candidate}' 不在工作区 '{root_resolved}' 内。")
    return resolved


def path_drive(path: Path) -> str:
    """Return the drive part of a path (``''`` on POSIX)."""
    try:
        return path.drive
    except (AttributeError, ValueError):  # defensive: unusual path objects
        return ""


def is_within(root: str | Path, candidate: str | Path) -> bool:
    """Return True when ``candidate`` resolves inside ``root``."""
    try:
        root_path = Path(root).expanduser().resolve()
        candidate_path = Path(candidate).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    return candidate_path == root_path or candidate_path.is_relative_to(root_path)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

_SIZE_UNITS = ("B", "KB", "MB", "GB", "TB", "PB")


def human_size(size: int | float | None) -> str:
    """Render a byte count as a compact human readable string."""
    if size is None:
        return "未知"
    try:
        value = float(size)
    except (TypeError, ValueError):
        return str(size)
    sign = "-" if value < 0 else ""
    value = abs(value)
    unit = _SIZE_UNITS[0]
    for unit in _SIZE_UNITS:
        if value < 1024 or unit == _SIZE_UNITS[-1]:
            break
        value /= 1024.0
    if unit == "B":
        return f"{sign}{int(value)} B"
    return f"{sign}{value:.1f} {unit}"


def truncate(text: str | None, max_chars: int, marker: str = "\n...[已截断 {removed} 字符]...\n") -> str:
    """Truncate text in the middle, keeping the head and the end.

    Keeping a tail is important for tool output because stack traces and error
    messages usually live at the end.
    """
    value = "" if text is None else str(text)
    if max_chars <= 0:
        return ""
    if len(value) <= max_chars:
        return value
    if max_chars <= 60:
        return value[:max_chars]
    budget = max_chars - 40
    head_len = int(budget * 0.75)
    tail_len = budget - head_len
    removed = len(value) - head_len - tail_len
    head = value[:head_len]
    tail = value[-tail_len:] if tail_len > 0 else ""
    return f"{head}{marker.format(removed=removed)}{tail}"


_ANSI_ESCAPE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(text: str | None) -> str:
    """Remove ANSI escape sequences (colors, cursor movement) from text."""
    return _ANSI_ESCAPE.sub("", "" if text is None else str(text))


def slugify(text: str | None, default: str = "item", max_length: int = 48) -> str:
    """Convert arbitrary text into a filesystem-safe ASCII slug."""
    value = unicodedata.normalize("NFKD", "" if text is None else str(text))
    value = value.encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-").lower()
    value = re.sub(r"-{2,}", "-", value)
    if len(value) > max_length:
        value = value[:max_length].strip("-")
    return value or default


def iso_now() -> str:
    """Current local time as an ISO-8601 string with timezone offset."""
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def iso_from_ts(ts: float | int | None) -> str:
    """Convert a UNIX timestamp to a local ISO-8601 string (best effort)."""
    try:
        return _dt.datetime.fromtimestamp(float(ts or 0.0)).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


# ---------------------------------------------------------------------------
# YAML frontmatter
# ---------------------------------------------------------------------------


class FrontmatterError(ValueError):
    """Raised when a file declares frontmatter that cannot be parsed."""


_FM_DELIMITER = re.compile(r"^---\s*$")


def _fallback_scalar(raw: str) -> Any:
    """Parse a single scalar as a tiny subset of YAML (no PyYAML fallback)."""
    value = raw.strip()
    if value == "":
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if lowered in {"null", "~", "none"}:
        return None
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_fallback_scalar(item) for item in inner.split(",")]
    try:
        if re.fullmatch(r"[-+]?\d+", value):
            return int(value)
        if re.fullmatch(r"[-+]?\d*\.\d+(?:[eE][-+]?\d+)?", value):
            return float(value)
    except ValueError:  # pragma: no cover - regex already guards
        pass
    return value


def _fallback_yaml_load(raw: str) -> dict[str, Any]:
    """Very small YAML subset parser used only when PyYAML is missing."""
    data: dict[str, Any] = {}
    current_key: str | None = None
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- "):
            if current_key is not None:
                bucket = data.get(current_key)
                if not isinstance(bucket, list):
                    bucket = []
                    data[current_key] = bucket
                bucket.append(_fallback_scalar(stripped[2:]))
            continue
        if ":" in line and not line[:1].isspace():
            key, _, rest = line.partition(":")
            current_key = key.strip()
            value = rest.strip()
            if value:
                data[current_key] = _fallback_scalar(value)
            else:
                data[current_key] = []
            continue
    return data


def _yaml_load(raw: str) -> dict[str, Any]:
    """Load a YAML mapping, using PyYAML when available."""
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        logger.debug("PyYAML 未安装，使用内置 frontmatter 解析器")
        return _fallback_yaml_load(raw)
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise FrontmatterError(f"YAML 解析失败: {exc}") from exc
    return data if isinstance(data, dict) else {}


def split_frontmatter(text: str | None) -> tuple[dict[str, Any], str]:
    """Split ``---`` delimited YAML frontmatter from a Markdown document.

    Returns ``(metadata, body)``. Documents without frontmatter return
    ``({}, original_text)``.

    Raises:
        FrontmatterError: the delimiters exist but the YAML is invalid, or the
            closing delimiter is missing.
    """
    raw = ("" if text is None else str(text)).lstrip("\ufeff")
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, raw

    end_index: int | None = None
    for index in range(1, len(lines)):
        if _FM_DELIMITER.match(lines[index]):
            end_index = index
            break
    if end_index is None:
        raise FrontmatterError("frontmatter 缺少结束分隔符 '---'")

    meta = _yaml_load("\n".join(lines[1:end_index]))
    body = "\n".join(lines[end_index + 1 :])
    return meta, body
