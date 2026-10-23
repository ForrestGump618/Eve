"""Function-registry tools exposed to agents."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..agent.types import ToolResult
from ..config import Settings
from .index import RegistryIndex, RegistryError

logger = logging.getLogger("omicslab.registry.tools")

TOOL_NAME = "registry_lookup"

_DESCRIPTION = (
    "查询本地科学计算函数库索引（numpy/pandas/scipy/sklearn/statsmodels/scanpy/anndata/"
    "omicverse/lifelines/gseapy/pydeseq2/flowio/flowkit/rdkit/squidpy 等）。"
    "当你需要一个具体函数名、签名或不确定某个分析该用哪个 API 时优先调用本工具，"
    "而不是凭记忆猜函数名。支持按功能描述搜索，例如 “差异表达”“multiple testing correction”。"
)

_PARAMETERS = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "功能或函数名关键词（中英文均可，例如 “BH 校正”“read_10x_mtx”“生存分析”）",
        },
        "limit": {"type": "integer", "description": "返回条数，默认 8，最大 30"},
    },
    "required": ["query"],
}


def _index(ctx) -> RegistryIndex:
    index = getattr(getattr(ctx, "registry", None), "function_registry", None)
    if isinstance(index, RegistryIndex):
        return index
    settings = getattr(ctx, "settings", None)
    return RegistryIndex(settings)


def _format_hit(hit: dict[str, Any]) -> str:
    signature = str(hit.get("signature") or "").strip()
    call = f"{hit.get('name')}{signature}" if signature else str(hit.get("name"))
    summary = str(hit.get("summary") or "").strip()
    version = str(hit.get("package_version") or "").strip()
    package = str(hit.get("package") or "").strip()
    suffix = ""
    if package:
        suffix = f"  ·  {package}{('/' + version) if version else ''}"
    kind = "类" if hit.get("kind") == "class" else "函数"
    line = f"- `{call}`（{kind}，{hit.get('module')}）{suffix}"
    if summary:
        line += f"\n  {summary}"
    return line


async def _tool_registry_lookup(ctx, args: dict[str, Any]) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        return ToolResult(tool_call_id="", name=TOOL_NAME, ok=False, content="缺少 query（要搜索的功能或函数名）")
    try:
        limit = max(1, min(int(args.get("limit") or 8), 30))
    except (TypeError, ValueError):
        limit = 8
    index = _index(ctx)
    try:
        if not index.exists():
            await asyncio.to_thread(index.refresh)
        hits = index.search(query, limit=limit)
    except RegistryError as exc:
        return ToolResult(tool_call_id="", name=TOOL_NAME, ok=False, content=f"函数索引不可用：{exc}")
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("函数索引查询失败")
        return ToolResult(tool_call_id="", name=TOOL_NAME, ok=False, content=f"函数索引查询失败：{exc}")
    if not hits:
        stats = index.stats()
        content = (
            f"未在本地函数索引中找到与 “{query}” 匹配的条目。\n"
            f"索引包含 {stats.get('items', 0)} 项 / {stats.get('modules', 0)} 个模块"
            + (f"（未安装：{', '.join(stats.get('missing_packages') or [])}）" if stats.get("missing_packages") else "")
            + "\n可以用更宽的关键词重试，或直接查看模块列表。"
        )
        return ToolResult(tool_call_id="", name=TOOL_NAME, ok=True, content=content, data={"query": query, "hits": []})
    header = f"函数索引命中 {len(hits)} 条（query={query}）："
    body = "\n".join(_format_hit(hit) for hit in hits)
    return ToolResult(
        tool_call_id="",
        name=TOOL_NAME,
        ok=True,
        content=f"{header}\n{body}",
        data={"query": query, "hits": hits},
    )


def register_registry_tools(registry, settings: Settings) -> None:
    """Register the function-registry tool on ``registry``."""
    if registry.has(TOOL_NAME):
        return
    index = RegistryIndex(settings)
    # Expose the index to ToolContext consumers without rebuilding it per call.
    try:
        registry.function_registry = index  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - registry is a plain object
        pass
    registry.register(
        _spec(TOOL_NAME, _DESCRIPTION, _PARAMETERS, _tool_registry_lookup, toolset="registry")
    )


def _spec(name: str, description: str, parameters: dict[str, Any], handler, toolset: str):
    from ..agent.tools import ToolSpec

    return ToolSpec(
        name=name,
        description=description,
        parameters=parameters,
        handler=handler,
        toolset=toolset,
    )
