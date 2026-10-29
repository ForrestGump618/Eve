"""Agent tools for the workspace literature radar and ingestion pipeline."""
from __future__ import annotations

from typing import Any

from ..agent.tools import ToolError, ToolResult, ToolSpec


def _platform(ctx: Any):
    platform = getattr(ctx, "platform", None) or getattr(ctx.registry, "platform", None)
    if platform is None:
        raise ToolError("文献服务尚未就绪")
    return platform


def _scope(ctx: Any) -> str:
    explicit = str(getattr(ctx, "skill_scope", "") or "")
    if explicit:
        return explicit
    workspace = getattr(getattr(ctx, "backend", None), "workspace", None)
    return str(getattr(workspace, "workspace_id", "ws_main") or "ws_main")


def _text(value: Any, limit: int = 800) -> str:
    return " ".join(str(value or "").split())[:limit]


async def _search(ctx: Any, arguments: dict[str, Any]) -> ToolResult:
    platform = _platform(ctx)
    query = _text(arguments.get("query"), 1_000)
    if not query:
        raise ToolError("缺少检索主题")
    sources = arguments.get("sources")
    if sources is not None and not isinstance(sources, list):
        raise ToolError("sources 需要来源名称数组")
    result = await platform.literature.search(
        _scope(ctx),
        query,
        sources=[str(item) for item in sources] if sources else None,
        date_from=str(arguments.get("date_from") or ""),
        date_to=str(arguments.get("date_to") or ""),
        limit=min(12, max(1, int(arguments.get("limit") or 8))),
        type_filter=str(arguments.get("type_filter") or "all"),
        min_interestingness=float(arguments.get("min_interestingness") or 0),
        ground_novelty=arguments.get("ground_novelty") is not False,
    )
    items = result.get("items") or []
    lines = [f"检索到 {len(items)} 篇候选文献，按当前工作区的兴趣度排序。"]
    for index, item in enumerate(items[:10], 1):
        scores = item.get("scores") or {}
        lines.append(
            f"{index}. {_text(item.get('title'), 260)}"
            f"\n   来源：{item.get('source_label') or item.get('source')}"
            f" · 类型：{item.get('publication_type')} · 领域：{item.get('domain')}"
            f" · 兴趣度 {scores.get('interestingness')}"
            f"\n   链接：{item.get('url') or item.get('doi') or '无'}"
            f"\n   新颖性：{item.get('novelty_status')}"
            + (
                f"（{item.get('novelty_grounded')}）"
                if item.get("novelty_grounded") is not None
                else ""
            )
        )
    warnings = result.get("warnings") or []
    if warnings:
        lines.append(
            "来源警告："
            + "；".join(_text(row.get("message"), 180) for row in warnings[:5])
        )
    compact = [
        {
            key: item.get(key)
            for key in (
                "id",
                "title",
                "authors",
                "source",
                "source_label",
                "doi",
                "url",
                "published",
                "venue",
                "publication_type",
                "domain",
                "scores",
                "novelty_status",
                "novelty_grounded",
                "prior_art",
            )
        }
        | {"abstract": _text(item.get("abstract"), 1_600)}
        for item in items[:10]
    ]
    return ToolResult(
        tool_call_id="",
        name="literature_search",
        ok=True,
        content="\n".join(lines),
        data={"items": compact, "warnings": warnings, "sources": result.get("sources")},
    )


async def _ingest(ctx: Any, arguments: dict[str, Any]) -> ToolResult:
    platform = _platform(ctx)
    path = str(arguments.get("path") or "").strip()
    if not path:
        raise ToolError("缺少工作区内的 PDF 路径")
    result = await platform.literature.ingest(
        _scope(ctx),
        path=path,
        name=str(arguments.get("name") or ""),
    )
    item = result.get("item") or {}
    if result.get("duplicate"):
        return ToolResult(
            tool_call_id="",
            name="literature_ingest",
            ok=True,
            content=f"这篇文献已经投喂过：{item.get('title') or item.get('id')}",
            data={"item": item, "duplicate": True},
        )
    reflection = result.get("reflection") or {}
    content = [
        f"已投喂：{item.get('title') or item.get('id')}",
        f"页数：{item.get('pages') or '未知'} · 反思：{_text(reflection.get('summary'), 600)}",
        f"待审技能候选：{len(result.get('candidate_ids') or [])} 条。",
    ]
    if result.get("model_error"):
        content.append(f"模型抽取未完成：{_text(result['model_error'], 300)}")
    return ToolResult(
        tool_call_id="",
        name="literature_ingest",
        ok=True,
        content="\n".join(content),
        data={
            "item": {key: item.get(key) for key in ("id", "title", "pages", "digest")},
            "reflection": {
                key: reflection.get(key)
                for key in (
                    "id",
                    "summary",
                    "method_steps",
                    "project_fits",
                    "experiment_ideas",
                    "new_questions",
                    "skill_candidate",
                )
            },
            "candidate_ids": result.get("candidate_ids") or [],
            "model_error": result.get("model_error") or "",
        },
    )


async def _status(ctx: Any, arguments: dict[str, Any]) -> ToolResult:
    platform = _platform(ctx)
    status = platform.literature.status(_scope(ctx))
    today = status.get("today") or {}
    proactive = status.get("proactive") or {}
    content = (
        f"文献雷达：{'开启' if status.get('enabled') else '关闭'}"
        f" · 今日精读 {today.get('deep_read', 0)} 篇"
        f" · 待反思 {status.get('reflections_pending', 0)} 条"
        f" · 待审技能 {status.get('skill_candidates_pending', 0)} 条"
        f" · 主动消息队列 {proactive.get('queued', 0)} 条"
    )
    warning = (status.get("last_run") or {}).get("warnings") or []
    if warning:
        content += "\n最近警告：" + "；".join(
            _text(row.get("message"), 160) for row in warning[:4]
        )
    return ToolResult(
        tool_call_id="",
        name="literature_status",
        ok=True,
        content=content,
        data=status,
    )


def register_literature_tools(registry, settings) -> None:
    specs = [
        ToolSpec(
            name="literature_search",
            description=(
                "检索当前工作区启用的 Europe PMC、OpenAlex、bioRxiv 与 arXiv。"
                "返回分类、兴趣度、接地新颖性与先验工作；新颖性仅在找到更早先验工作时评分。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "自然语言检索主题。"},
                    "sources": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["europe_pmc", "openalex", "biorxiv", "arxiv"],
                        },
                        "description": "可选来源；省略时使用设置中启用的来源。",
                    },
                    "date_from": {"type": "string", "description": "YYYY-MM-DD。"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD。"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 12},
                    "type_filter": {
                        "type": "string",
                        "enum": ["all", "research", "review", "method", "position"],
                    },
                    "min_interestingness": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "ground_novelty": {
                        "type": "boolean",
                        "description": "是否检索更早先验工作以计算接地新颖性。",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            toolset="research",
            handler=_search,
        ),
        ToolSpec(
            name="literature_ingest",
            description=(
                "把当前本地工作区内带文本层的 PDF 投喂到文献管线，生成待审核反思与技能候选。"
                "不会启用技能、创建课题或修改研究计划。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "工作区内 PDF 路径。"},
                    "name": {"type": "string", "description": "可选显示名称。"},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            toolset="research",
            handler=_ingest,
        ),
        ToolSpec(
            name="literature_status",
            description="查看当前工作区文献循环、待审反思、技能候选与主动消息队列状态。",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False,
            },
            toolset="research",
            handler=_status,
        ),
    ]
    for spec in specs:
        if not registry.has(spec.name):
            registry.register(spec)
