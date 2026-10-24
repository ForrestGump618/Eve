"""Workspace file-system helpers with strict path containment."""

from __future__ import annotations

import mimetypes
import os
import shutil
from pathlib import Path
from typing import Any

from ..config import Settings, ConfigError
from ..utils import is_within, safe_join, truncate

TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".py", ".r", ".rmd", ".ipynb", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".csv", ".tsv", ".log", ".html", ".css", ".js", ".ts", ".svg",
    ".xml", ".sh", ".ps1", ".tex", ".bib", ".sql", ".fasta", ".fa", ".vcf", ".gmt", ".txt",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf", ".tif", ".tiff"}


class WorkspaceError(ValueError):
    """Raised when a requested path escapes the workspace."""


def _root_for(settings: Settings, root: Path | str | None) -> Path:
    return Path(root if root is not None else settings.workspace).resolve()


def resolve_path(settings: Settings, rel: str | None, *, root: Path | str | None = None) -> Path:
    """Resolve a workspace-relative path, rejecting traversal and absolute paths."""
    raw = (rel or ".").strip().replace("\\", "/") or "."
    if raw.startswith("/"):
        raise WorkspaceError(f"只接受工作区相对路径：{rel!r}")
    base = _root_for(settings, root)
    try:
        path = safe_join(base, raw)
    except (ConfigError, ValueError, OSError) as exc:
        raise WorkspaceError(f"非法路径：{exc}") from exc
    resolved = Path(path).resolve()
    if not is_within(base, resolved):
        raise WorkspaceError(f"路径越出工作区：{rel!r}")
    return resolved


def relative_to_workspace(settings: Settings, path: Path, *, root: Path | str | None = None) -> str:
    root = _root_for(settings, root)
    try:
        return Path(path).resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)


def guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTS:
        return True
    if path.suffix.lower() in IMAGE_EXTS:
        return False
    try:
        with path.open("rb") as handle:
            chunk = handle.read(4096)
        if b"\x00" in chunk:
            return False
        chunk.decode("utf-8")
        return True
    except Exception:
        return False


def list_dir(
    settings: Settings, rel: str | None, *, show_hidden: bool = False, root: Path | str | None = None
) -> dict[str, Any]:
    path = resolve_path(settings, rel, root=root)
    if not path.exists():
        raise WorkspaceError(f"路径不存在：{rel}")
    if not path.is_dir():
        raise WorkspaceError(f"不是目录：{rel}")
    entries: list[dict[str, Any]] = []
    try:
        children = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as exc:
        raise WorkspaceError(f"无法读取目录：{exc}") from exc
    for child in children:
        if not show_hidden and child.name.startswith("."):
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        entries.append(
            {
                "name": child.name,
                "path": relative_to_workspace(settings, child, root=root) if path != _root_for(settings, root) else child.name,
                "is_dir": child.is_dir(),
                "size": 0 if child.is_dir() else int(stat.st_size),
                "mtime": float(stat.st_mtime),
                "ext": "" if child.is_dir() else child.suffix.lower(),
            }
        )
    return {"path": relative_to_workspace(settings, path, root=root), "entries": entries}


def read_text(
    settings: Settings, rel: str, max_bytes: int = 200_000, *, root: Path | str | None = None
) -> dict[str, Any]:
    path = resolve_path(settings, rel, root=root)
    if not path.exists() or not path.is_file():
        raise WorkspaceError(f"文件不存在：{rel}")
    size = path.stat().st_size
    if not is_probably_text(path):
        return {
            "path": relative_to_workspace(settings, path, root=root),
            "text": "",
            "truncated": False,
            "binary": True,
            "mime": guess_mime(path),
            "size": size,
        }
    read_limit = max(1024, min(int(max_bytes or 200_000), 5_000_000))
    with path.open("rb") as handle:
        raw = handle.read(read_limit + 1)
    truncated = len(raw) > read_limit
    text = raw[:read_limit].decode("utf-8", "replace")
    return {
        "path": relative_to_workspace(settings, path, root=root),
        "text": text,
        "truncated": truncated,
        "binary": False,
        "mime": guess_mime(path),
        "size": size,
    }


def write_text(
    settings: Settings, rel: str, content: str, *, root: Path | str | None = None
) -> dict[str, Any]:
    path = resolve_path(settings, rel, root=root)
    if path.exists() and path.is_dir():
        raise WorkspaceError(f"目标是目录：{rel}")
    path.parent.mkdir(parents=True, exist_ok=True)
    from ..utils import atomic_write_text

    atomic_write_text(path, content if content is not None else "")
    return {"ok": True, "path": relative_to_workspace(settings, path, root=root), "size": path.stat().st_size}


def make_dir(settings: Settings, rel: str, *, root: Path | str | None = None) -> dict[str, Any]:
    path = resolve_path(settings, rel, root=root)
    path.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": relative_to_workspace(settings, path, root=root)}


def delete_path(settings: Settings, rel: str, *, root: Path | str | None = None) -> dict[str, Any]:
    path = resolve_path(settings, rel, root=root)
    if path == _root_for(settings, root):
        raise WorkspaceError("不能删除工作区根目录")
    if not path.exists():
        raise WorkspaceError(f"路径不存在：{rel}")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return {"ok": True, "path": rel}


def save_upload(
    settings: Settings,
    rel_dir: str | None,
    filename: str,
    data: bytes,
    *,
    root: Path | str | None = None,
) -> dict[str, Any]:
    safe_name = Path(filename or "upload.bin").name
    if not safe_name or safe_name in (".", ".."):
        raise WorkspaceError("非法文件名")
    directory = resolve_path(settings, rel_dir or ".", root=root)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / safe_name
    stem, suffix, index = target.stem, target.suffix, 1
    while target.exists():
        target = directory / f"{stem}_{index}{suffix}"
        index += 1
    from ..utils import atomic_write_bytes

    atomic_write_bytes(target, data)
    return {"path": relative_to_workspace(settings, target, root=root), "size": target.stat().st_size}


def preview_text(text: str, limit: int = 4000) -> str:
    return truncate(text or "", limit)
