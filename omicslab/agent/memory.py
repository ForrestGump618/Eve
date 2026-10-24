"""Persistent long-term memory for agents.

Memories are Markdown files stored under ``<home>/memory/<slug>.md`` with a
small YAML frontmatter block::

    ---
    title: "项目约定"
    created_at: 1712345678.0
    updated_at: 1712345678.0
    ---
    Markdown body...

The store is deliberately synchronous (small files) and safe for concurrent
callers: writes are atomic and guarded by a re-entrant lock.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from omicslab.config import Settings
from omicslab.utils import FrontmatterError, atomic_write_text, human_size, iso_from_ts, split_frontmatter, truncate

logger = logging.getLogger("omicslab.agent.memory")

SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BODY_BYTES = 64 * 1024
MAX_TITLE_CHARS = 200


class MemoryError(ValueError):
    """Raised for invalid memory operations (bad slug, oversized body...)."""


def ensure_slug(slug: str) -> str:
    """Validate and normalise a memory slug."""
    value = str(slug or "").strip()
    if not value:
        raise MemoryError("记忆标识（slug）不能为空。")
    if not SLUG_RE.match(value):
        raise MemoryError(
            f"非法的记忆标识 '{value}'：只允许字母、数字、下划线和短横线，长度 1-64。"
        )
    return value


class MemoryStore:
    """Read/write access to the user's Markdown memory directory."""

    def __init__(self, settings: Settings, workspace_id: str | None = None, agent_id: str | None = None) -> None:
        self.settings = settings
        self.workspace_id = workspace_id
        self.agent_id = agent_id
        self._lock = threading.RLock()

    # -- paths -------------------------------------------------------------
    @property
    def root(self) -> Path:
        if self.agent_id:
            workspace = ensure_slug(self.workspace_id or 'ws_main')
            return self.settings.memory_dir / 'workspaces' / workspace / 'agents' / ensure_slug(self.agent_id)
        if self.workspace_id and self.workspace_id != "ws_main":
            key = ensure_slug(self.workspace_id)
            return self.settings.memory_dir / "workspaces" / key
        return self.settings.memory_dir

    def path_for(self, slug: str) -> Path:
        return self.root / f"{ensure_slug(slug)}.md"

    def _ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    # -- parsing -----------------------------------------------------------
    def _parse_file(self, path: Path, slug: str) -> dict[str, Any]:
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            meta, body = split_frontmatter(text)
        except FrontmatterError:
            # A damaged memory file must not break the whole listing.
            logger.warning("记忆文件 frontmatter 解析失败，按纯文本处理: %s", path)
            meta, body = {}, text
        title = str(meta.get("title") or slug).strip() or slug
        updated_at = _as_float(meta.get("updated_at"), path.stat().st_mtime)
        created_at = _as_float(meta.get("created_at"), updated_at)
        return {
            "slug": slug,
            "title": title,
            "body": body.rstrip("\n"),
            "created_at": created_at,
            "updated_at": updated_at,
            "size": path.stat().st_size,
        }

    # -- public API --------------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        """Return lightweight memory summaries sorted by ``updated_at`` desc."""
        self._ensure_root()
        items: list[dict[str, Any]] = []
        try:
            paths = sorted(self.root.glob("*.md"))
        except OSError as exc:  # pragma: no cover - unusual fs failure
            logger.warning("无法列出记忆目录 %s: %s", self.root, exc)
            return items
        for path in paths:
            slug = path.stem
            if not SLUG_RE.match(slug):
                logger.warning("跳过非法记忆文件名: %s", path)
                continue
            try:
                item = self._parse_file(path, slug)
            except OSError as exc:
                logger.warning("跳过无法读取的记忆文件 %s: %s", path, exc)
                continue
            items.append(
                {
                    "slug": item["slug"],
                    "title": item["title"],
                    "updated_at": item["updated_at"],
                    "size": item["size"],
                }
            )
        items.sort(key=lambda entry: entry["updated_at"], reverse=True)
        return items

    def get(self, slug: str) -> dict[str, Any]:
        """Load one memory; raises ``KeyError`` when it does not exist."""
        key = ensure_slug(slug)
        path = self.path_for(key)
        if not path.is_file():
            raise KeyError(key)
        with self._lock:
            item = self._parse_file(path, key)
        return item

    def put(self, slug: str, title: str, body: str) -> dict[str, Any]:
        """Create or replace a memory file atomically."""
        key = ensure_slug(slug)
        title_text = str(title or key).strip() or key
        if len(title_text) > MAX_TITLE_CHARS:
            title_text = title_text[:MAX_TITLE_CHARS]
        body_text = "" if body is None else str(body)
        encoded = body_text.encode("utf-8")
        if len(encoded) > MAX_BODY_BYTES:
            raise MemoryError(
                f"记忆正文过大（{human_size(len(encoded))}），上限为 {human_size(MAX_BODY_BYTES)}。"
            )

        now = time.time()
        created_at = now
        existing = self.path_for(key)
        if existing.is_file():
            try:
                created_at = _as_float(self.get(key).get("created_at"), now)
            except (KeyError, OSError, ValueError):
                created_at = now

        # JSON string literals are valid YAML scalars, so no YAML writer is
        # needed here (keeps the dependency surface minimal).
        title_literal = _json_string(title_text)
        frontmatter = (
            "---\n"
            f"title: {title_literal}\n"
            f"created_at: {created_at!r}\n"
            f"updated_at: {now!r}\n"
            "---\n"
        )
        content = frontmatter + (body_text if body_text.endswith("\n") else body_text + "\n")
        with self._lock:
            self._ensure_root()
            atomic_write_text(existing, content)
        logger.info("已写入记忆 %s（%s）", key, human_size(len(encoded)))
        return self.get(key)

    def delete(self, slug: str) -> bool:
        """Delete a memory file; returns False when it did not exist."""
        key = ensure_slug(slug)
        path = self.path_for(key)
        with self._lock:
            try:
                path.unlink()
                return True
            except FileNotFoundError:
                return False
            except OSError as exc:
                raise MemoryError(f"删除记忆失败: {exc}") from exc

    def index_text(self, max_chars: int = 3000) -> str:
        """Render a compact index used in the system prompt."""
        items = self.list()
        if not items:
            return "（暂无长期记忆）"
        lines = ["## 长期记忆索引"]
        for item in items:
            lines.append(
                f"- {item['slug']}: {item['title']}"
                f"（更新于 {iso_from_ts(item['updated_at']) or '未知'}，{human_size(item['size'])}）"
            )
        return truncate("\n".join(lines), max_chars)

    # -- extras ------------------------------------------------------------
    def search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """Naive full-text search over memory bodies (small N, no index)."""
        needle = str(query or "").strip().lower()
        if not needle:
            return []
        matches: list[dict[str, Any]] = []
        for summary in self.list():
            try:
                item = self.get(summary["slug"])
            except (KeyError, OSError):
                continue
            haystack = f"{item['title']}\n{item['body']}".lower()
            if needle in haystack:
                matches.append(
                    {
                        "slug": item["slug"],
                        "title": item["title"],
                        "updated_at": item["updated_at"],
                        "excerpt": truncate(item["body"], 240),
                    }
                )
            if len(matches) >= limit:
                break
        return matches


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _json_string(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)
