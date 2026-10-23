"""Discovery (RSI) tools exposed to agents.

These tools let any chat agent drive the recursive self-improvement research
loop: create a project, inspect the ledger, run rounds (hypothesis →
pre-registered test → real kernel execution → evidence → reflection) and read the
final report.  Progress is streamed as ``discovery`` SSE events by the engine.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..agent.types import ToolResult
from ..config import Settings
from .evidence import AnalysisResult
from .ledger import ProjectNotFound, ProjectStore
from .types import Evidence

logger = logging.getLogger("omicslab.discovery.tools")

# Contract fields of an AnalysisResult (see docs/CONTRACTS-3.md §10 T10).
_ANALYSIS_FIELDS: tuple[str, ...] = (
    "data_sha256",
    "script_sha256",
    "seed",
    "test",
    "effect_size",
    "ci_low",
    "ci_high",
    "p_value",
    "q_value_or_none",
    "correction",
    "method",
    "sample_definition",
    "exclusions",
    "execution_status",
    "artifact_refs",
    "environment",
)


def _store(ctx) -> ProjectStore:
    store = getattr(getattr(ctx, "registry", None), "discovery_store", None)
    if store is not None:
        return store
    return ProjectStore(ctx.settings)


def _engine(ctx):
    engine = getattr(getattr(ctx, "registry", None), "discovery_engine", None)
    if engine is None:
        return None
    # Rebind live collaborators so tools work even if state rebuilt them.
    if getattr(engine, "loop", None) is None:
        engine.loop = getattr(getattr(ctx, "registry", None), "agent_loop", None)
    return engine


def _project_text(project) -> str:
    return (
        f"项目 {project.id}｜{project.title}\n"
        f"目标：{project.objective}\n"
        f"领域：{project.domain}　状态：{project.status}　轮次：{project.rounds_count}/{project.max_rounds}\n"
        f"预算：{project.budget_minutes} 分钟　智能体：{project.agent}\n"
        f"摘要：{project.summary or '（暂无）'}"
    )


async def _tool_create_project(ctx, args: dict[str, Any]) -> ToolResult:
    objective = str(args.get("objective") or "").strip()
    if not objective:
        return ToolResult(tool_call_id="", name="discovery_create_project", ok=False, content="缺少 objective（研究目标）")
    title = str(args.get("title") or "").strip()
    hints_raw = args.get("data_hints") or ""
    if isinstance(hints_raw, str):
        hints = [item.strip() for item in hints_raw.replace("\n", ",").split(",") if item.strip()]
    elif isinstance(hints_raw, list):
        hints = [str(item).strip() for item in hints_raw if str(item).strip()]
    else:
        hints = []
    try:
        project = _store(ctx).create(
            title=title,
            objective=objective,
            domain=str(args.get("domain") or "biomedicine"),
            agent=str(args.get("agent") or ctx.agent_id or "lead"),
            data_hints=hints,
            max_rounds=int(args.get("max_rounds") or 3),
            budget_minutes=int(args.get("budget_minutes") or 30),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("创建发现项目失败")
        return ToolResult(tool_call_id="", name="discovery_create_project", ok=False, content=f"创建发现项目失败：{exc}")
    return ToolResult(
        tool_call_id="",
        name="discovery_create_project",
        ok=True,
        content=(
            f"已创建 RSI 发现项目：\n{_project_text(project)}\n\n"
            f"下一步：运行 `discovery_run`（project_id={project.id}）开始“假设→预注册→真实执行→证据→反思”迭代。"
        ),
        data={"project": project.to_dict()},
    )


async def _tool_list_projects(ctx, args: dict[str, Any]) -> ToolResult:
    limit = max(1, min(int(args.get("limit") or 20), 100))
    projects = _store(ctx).list_projects()[:limit]
    if not projects:
        return ToolResult(tool_call_id="", name="discovery_list_projects", ok=True, content="尚无发现项目。")
    lines = [f"共 {len(projects)} 个发现项目："]
    for project in projects:
        lines.append(f"- {project.id}｜{project.title}｜{project.status}｜{project.rounds_count}/{project.max_rounds} 轮")
    return ToolResult(
        tool_call_id="",
        name="discovery_list_projects",
        ok=True,
        content="\n".join(lines),
        data={"projects": [item.to_dict() for item in projects]},
    )


async def _tool_status(ctx, args: dict[str, Any]) -> ToolResult:
    project_id = str(args.get("project_id") or "").strip()
    if not project_id:
        return ToolResult(tool_call_id="", name="discovery_status", ok=False, content="缺少 project_id")
    try:
        store = _store(ctx)
        snapshot = store.snapshot(project_id)
    except ProjectNotFound:
        return ToolResult(tool_call_id="", name="discovery_status", ok=False, content=f"项目不存在：{project_id}")
    project = snapshot["project"]
    hypotheses = snapshot["hypotheses"]
    evidence = snapshot["evidence"]
    insights = snapshot["insights"]
    lines = [_project_text(type("P", (), project))]  # lightweight view for formatting
    lines.append(f"\n假设 {len(hypotheses)} 条：")
    for item in hypotheses[-12:]:
        lines.append(
            f"- [{item['round']}] {item['status']}（置信度 {item['confidence']:.2f}）{item['statement'][:160]}"
        )
    lines.append(f"\n证据 {len(evidence)} 条，洞察 {len(insights)} 条。")
    for item in insights[-5:]:
        lines.append(f"- 洞察：{item['text'][:200]}")
    return ToolResult(
        tool_call_id="",
        name="discovery_status",
        ok=True,
        content="\n".join(lines),
        data=snapshot,
    )


async def _tool_run(ctx, args: dict[str, Any]) -> ToolResult:
    project_id = str(args.get("project_id") or "").strip()
    if not project_id:
        return ToolResult(tool_call_id="", name="discovery_run", ok=False, content="缺少 project_id")
    engine = _engine(ctx)
    if engine is None:
        return ToolResult(
            tool_call_id="",
            name="discovery_run",
            ok=False,
            content="发现引擎未初始化（请通过 素问 Suwen 服务端或 CLI discovery 命令运行）。",
        )
    store = _store(ctx)
    try:
        project = store.get(project_id)
    except ProjectNotFound:
        return ToolResult(tool_call_id="", name="discovery_run", ok=False, content=f"项目不存在：{project_id}")
    requested = args.get("max_rounds")
    if requested:
        try:
            project.max_rounds = max(1, min(int(requested), 12))
            store.save(project)
        except (TypeError, ValueError):
            pass
    try:
        result = await engine.run(
            project_id,
            emit=ctx.emit,
            cancel_event=ctx.cancel_event,
            approver=ctx.ensure_approver() if ctx.approver is None else ctx.approver,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("发现引擎运行失败")
        return ToolResult(tool_call_id="", name="discovery_run", ok=False, content=f"发现引擎运行失败：{exc}")
    final = store.get(project_id)
    return ToolResult(
        tool_call_id="",
        name="discovery_run",
        ok=result.get("status") in {"done", "cancelled"},
        content=(
            f"RSI 发现循环结束：状态={result.get('status')}，轮次={result.get('rounds')}。\n"
            f"{_project_text(final)}\n报告：{result.get('report_path') or '（未生成）'}"
        ),
        data=result,
    )


async def _tool_report(ctx, args: dict[str, Any]) -> ToolResult:
    project_id = str(args.get("project_id") or "").strip()
    if not project_id:
        return ToolResult(tool_call_id="", name="discovery_report", ok=False, content="缺少 project_id")
    try:
        markdown = _store(ctx).read_report(project_id)
    except ProjectNotFound:
        return ToolResult(tool_call_id="", name="discovery_report", ok=False, content=f"项目不存在：{project_id}")
    if not markdown:
        return ToolResult(tool_call_id="", name="discovery_report", ok=True, content="该项目尚未生成报告，请先 discovery_run。")
    return ToolResult(
        tool_call_id="",
        name="discovery_report",
        ok=True,
        content=markdown[:20000],
        data={"chars": len(markdown), "project_id": project_id},
    )


async def _tool_record_analysis_result(ctx, args: dict[str, Any]) -> ToolResult:
    """Accept a structured AnalysisResult; the evaluator uses it as sole numeric input."""
    nested = args.get("payload") or args.get("analysis_result")
    payload: Any
    if isinstance(nested, (dict, str)):
        payload = nested
    else:
        payload = {name: args.get(name) for name in _ANALYSIS_FIELDS if name in args}
        for name in ("sample_size", "notes"):
            if name in args:
                payload[name] = args.get(name)
    result, errors = AnalysisResult.from_payload(payload)
    if result is None:
        return ToolResult(
            tool_call_id="",
            name="discovery_record_analysis_result",
            ok=False,
            content=(
                "结构化分析结果不完整，未记录（不会被用来提升证据等级）：\n- "
                + "\n- ".join(errors)
            ),
            data={"analysis_result": None, "errors": errors},
        )
    q_text = "null" if result.q_value_or_none is None else f"{result.q_value_or_none:g}"
    content = "\n".join(
        [
            "已记录结构化分析结果（之后由 EvidenceEvaluator 按预注册判据核对数值）：",
            f"- 执行状态：{result.execution_status}",
            f"- 检验 / 方法：{result.test} / {result.method}",
            f"- 效应量：{result.effect_size:g}；CI [{result.ci_low:g}, {result.ci_high:g}]",
            f"- p={result.p_value:g}，q={q_text}（校正：{result.correction}）",
            f"- 样本定义：{result.sample_definition[:200]}",
            f"- 排除规则：{'；'.join(result.exclusions) if result.exclusions else '无'}",
            f"- 数据 sha256：{result.data_sha256[:16]}…；脚本 sha256：{result.script_sha256[:16]}…",
            "注意：自由文本中的“支持/不显著/显著/p=…”等叙述不参与证据判定。",
        ]
    )
    return ToolResult(
        tool_call_id="",
        name="discovery_record_analysis_result",
        ok=True,
        content=content,
        data={"analysis_result": result.to_dict(), "errors": []},
    )


async def _tool_record_evidence(ctx, args: dict[str, Any]) -> ToolResult:
    project_id = str(args.get("project_id") or "").strip()
    hypothesis_id = str(args.get("hypothesis_id") or "").strip()
    summary = str(args.get("summary") or "").strip()
    if not project_id or not summary:
        return ToolResult(tool_call_id="", name="discovery_record_evidence", ok=False, content="缺少 project_id 或 summary")
    store = _store(ctx)
    try:
        project = store.get(project_id)
    except ProjectNotFound:
        return ToolResult(tool_call_id="", name="discovery_record_evidence", ok=False, content=f"项目不存在：{project_id}")
    strength = str(args.get("strength") or "moderate").strip().lower()
    if strength not in {"strong", "moderate", "weak"}:
        strength = "moderate"
    reproducibility = str(args.get("reproducibility") or "").strip().lower()
    if reproducibility not in {"none", "code_recorded", "rerun_verified"}:
        # Legacy boolean argument: True only proves that code was captured.
        reproducibility = "code_recorded" if bool(args.get("reproducible", False)) else "none"
    evidence = Evidence(
        project_id=project.id,
        hypothesis_id=hypothesis_id,
        kind=str(args.get("kind") or "data"),
        summary=summary,
        code=str(args.get("code") or "")[:6000],
        result_excerpt=str(args.get("result_excerpt") or "")[:3000],
        strength=strength,
        reproducibility=reproducibility,
        round=int(args.get("round") or project.current_round or 0),
    )
    store.add_evidence(evidence)
    return ToolResult(
        tool_call_id="",
        name="discovery_record_evidence",
        ok=True,
        content=f"已记录证据 {evidence.id}（{evidence.kind}/{evidence.strength}）。",
        data={"evidence": evidence.to_dict()},
    )


def register_discovery_tools(registry, settings: Settings) -> None:
    """Register discovery tools on ``registry`` (idempotent)."""
    from ..agent.tools import ToolSpec

    specs = [
        ToolSpec(
            name="discovery_create_project",
            description=(
                "创建一个 RSI 科研发现项目（记录研究目标、数据提示、轮次预算）。"
                "创建后用 discovery_run 启动闭环迭代。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "objective": {"type": "string", "description": "可检验的研究目标/科学问题。"},
                    "title": {"type": "string", "description": "项目标题，可省略。"},
                    "domain": {"type": "string", "description": "领域，例如 single-cell / spatial / flow / clinical。"},
                    "data_hints": {
                        "type": "string",
                        "description": "工作区数据文件路径，逗号或换行分隔，可省略。",
                    },
                    "max_rounds": {"type": "integer", "description": "最多迭代轮次，默认 3。"},
                    "budget_minutes": {"type": "integer", "description": "时间预算（分钟），默认 30。"},
                    "agent": {"type": "string", "description": "执行实验的智能体 id，默认 lead。"},
                },
                "required": ["objective"],
            },
            toolset="discovery",
            handler=_tool_create_project,
        ),
        ToolSpec(
            name="discovery_list_projects",
            description="列出已有的 RSI 发现项目及其状态。",
            parameters={
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "最多返回数量，默认 20。"}},
                "required": [],
            },
            toolset="discovery",
            handler=_tool_list_projects,
        ),
        ToolSpec(
            name="discovery_status",
            description="查看一个发现项目的完整台账（假设、证据、洞察、策略、轮次）。",
            parameters={
                "type": "object",
                "properties": {"project_id": {"type": "string", "description": "发现项目 ID。"}},
                "required": ["project_id"],
            },
            toolset="discovery",
            handler=_tool_status,
        ),
        ToolSpec(
            name="discovery_run",
            description=(
                "运行 RSI 发现循环：自动生成可证伪假设、预注册检验、在真实内核中执行分析、"
                "评审证据、反思并进化策略。进度以 discovery 事件流式推送，可能耗时数分钟。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "发现项目 ID。"},
                    "max_rounds": {"type": "integer", "description": "本次最多轮次，可省略（用项目配置）。"},
                },
                "required": ["project_id"],
            },
            toolset="discovery",
            handler=_tool_run,
        ),
        ToolSpec(
            name="discovery_report",
            description="读取发现项目的最终/当前 Markdown 报告（含假设结果、证据、策略进化、可复现清单与局限）。",
            parameters={
                "type": "object",
                "properties": {"project_id": {"type": "string", "description": "发现项目 ID。"}},
                "required": ["project_id"],
            },
            toolset="discovery",
            handler=_tool_report,
        ),
        ToolSpec(
            name="discovery_record_analysis_result",
            description=(
                "记录一次分析的**结构化结果**（AnalysisResult）。这是发现引擎判定证据的唯一数值来源："
                "必须提交数据/脚本 SHA-256、随机种子、检验名、效应量、置信区间、原始 p、校正方法与 q、"
                "样本定义与排除规则、执行状态、产物引用与环境。自由文本结论不参与判定；"
                "execution_status 非 completed 或字段缺失/数值不一致时证据将被判为 inconclusive。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "data_sha256": {"type": "string", "description": "输入数据文件的 SHA-256（十六进制）。"},
                    "script_sha256": {"type": "string", "description": "实际执行的分析脚本/代码的 SHA-256。"},
                    "seed": {"type": ["integer", "string"], "description": "随机种子（整数或字符串）。"},
                    "test": {"type": "string", "description": "统计检验名称，例如 Welch t-test / Wilcoxon / 置换检验。"},
                    "effect_size": {"type": "number", "description": "效应量数值（与 CI 同一尺度）。"},
                    "ci_low": {"type": "number", "description": "置信区间下界。"},
                    "ci_high": {"type": "number", "description": "置信区间上界。"},
                    "p_value": {"type": "number", "description": "未校正的原始 p 值，必须在 [0, 1]。"},
                    "q_value_or_none": {
                        "type": ["number", "null"],
                        "description": "多重检验校正后的 q/FDR；没有校正时传 null。",
                    },
                    "correction": {"type": "string", "description": "多重检验校正方法，例如 BH-FDR / Bonferroni / none。"},
                    "method": {"type": "string", "description": "分析方法/模型（例如 Welch's t-test, two-sided）。"},
                    "sample_definition": {"type": "string", "description": "样本定义与每组样本量。"},
                    "exclusions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "预注册的排除规则及实际排除数量。",
                    },
                    "execution_status": {
                        "type": "string",
                        "enum": ["completed", "failed", "not_run"],
                        "description": "执行状态：只有 completed 才可能支持/反驳假设。",
                    },
                    "artifact_refs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "产物引用（结果表、图、日志的相对路径或 URL）。",
                    },
                    "environment": {
                        "type": "object",
                        "description": "环境信息，例如 {python, packages: {numpy: ...}, platform}。",
                    },
                    "sample_size": {"type": "integer", "description": "总样本量（可选，用于强度评估）。"},
                    "notes": {"type": "string", "description": "补充说明（可选）。"},
                    "project_id": {"type": "string", "description": "发现项目 ID（可选，便于审计）。"},
                    "hypothesis_id": {"type": "string", "description": "假设 ID（可选，便于审计）。"},
                },
                "required": list(_ANALYSIS_FIELDS),
            },
            toolset="discovery",
            handler=_tool_record_analysis_result,
        ),
        ToolSpec(
            name="discovery_record_evidence",
            description="向发现项目台账手动记录一条证据（数据/统计/实验/评审批次）。",
            parameters={
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "hypothesis_id": {"type": "string"},
                    "summary": {"type": "string", "description": "证据摘要。"},
                    "kind": {"type": "string", "description": "data/statistics/literature/experiment/critique。"},
                    "strength": {"type": "string", "description": "strong/moderate/weak。"},
                    "code": {"type": "string", "description": "可复现代码，可省略。"},
                    "result_excerpt": {"type": "string", "description": "结果摘录，可省略。"},
                    "reproducibility": {
                        "type": "string",
                        "enum": ["none", "code_recorded", "rerun_verified"],
                        "description": "复现等级：仅代码留痕用 code_recorded；显式重跑复核才用 rerun_verified。",
                    },
                },
                "required": ["project_id", "summary"],
            },
            toolset="discovery",
            handler=_tool_record_evidence,
        ),
    ]
    for spec in specs:
        if registry.has(spec.name):
            continue
        registry.register(spec)
    logger.debug("已注册 %d 个发现工具", len(specs))
