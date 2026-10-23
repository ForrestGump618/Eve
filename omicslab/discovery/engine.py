"""RSI (Recursive Self-Improvement) discovery engine.

The engine runs a closed research loop per project and records everything in the
ledger, so every conclusion is traceable to evidence and a pre-registered test:

1. **Observe** – summarise objective, data hints, prior insights and strategy
   statistics.
2. **Hypothesize** – ask the LLM for 2–4 falsifiable hypotheses (heuristic
   fallback when no LLM is configured or the reply is not JSON).
3. **Prioritize** – score hypotheses (novelty/feasibility/impact/strategy prior)
   and pick a strategy with UCB1 exploration over the mutation-capable bank.
4. **Pre-register** – persist the plan, prediction and success criteria *before*
   execution to prevent p-hacking.
5. **Execute** – run the plan in a real kernel through the normal agent loop
   (tools, approvals, figures all apply), capturing code/results/figures.
6. **Evaluate** – statistical heuristics + LLM critic produce a reward, evidence
   strength and a Bayesian-ish confidence update.
7. **Reflect** – derive lessons, update strategy statistics and mutate the
   strategy bank (the "self-improvement" step); finally write a report with a
   reproducibility manifest and explicit limitations.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import platform
import re
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..agent.context import build_system_prompt
from ..agent.providers import ProviderConfig, make_provider
from ..agent.types import AgentEvent, Conversation, new_id
from ..config import Settings
from .evidence import AnalysisResult, EvidenceEvaluator
from .ledger import ProjectNotFound, ProjectStore
from .types import (
    DiscoveryRound,
    Evidence,
    Hypothesis,
    Insight,
    Project,
    Strategy,
    iso_now,
)

logger = logging.getLogger("omicslab.discovery.engine")

Emit = Callable[[AgentEvent], Awaitable[None]]

# Default time budget for the optional explicit re-run verification.
_DEFAULT_RERUN_TIMEOUT_S = 120.0

RSI_SYSTEM = """你是 RSI（递归自我改进）科研发现引擎中的严谨生物医学研究代理。
你必须遵守：
- 只基于真实数据与可执行分析，禁止虚构数据、p 值或结论。
- 假设必须可证伪，并给出明确预测与成功判据。
- 统计必须报告效应量、样本量与多重检验校正；相关性不等于因果。
- 所有统计结论必须通过 discovery_record_analysis_result 提交结构化数值；
  自由文本（“支持/不显著/显著/p=…”）不参与证据判定。
- 输出严格 JSON（除非明确要求自然语言），不要 Markdown 代码围栏以外的解释。"""

DEFAULT_STRATEGIES: list[dict[str, str]] = [
    {
        "name": "差异表达与功能富集",
        "description": "分组比较 → 差异特征 → 通路/功能富集 → 效应量排序。",
        "prompt_hint": "优先做分组描述统计、差异检验（含多重检验校正）、效应量与富集分析；在结论中区分探索性与验证性结果。",
    },
    {
        "name": "关联与多变量建模",
        "description": "特征-表型关联 → 混杂控制 → 多变量模型/交互项。",
        "prompt_hint": "先检查缺失与分布，再做相关/回归，必须控制潜在混杂并报告模型假设检验；避免把相关当因果。",
    },
    {
        "name": "通路与调控网络",
        "description": "从差异信号到通路/网络层面的机制解释。",
        "prompt_hint": "在差异结果基础上做通路/网络分析（如 GSEA/PPI/共表达），标注来源数据库与显著性校正方式。",
    },
    {
        "name": "临床/表型分层",
        "description": "按临床或表型变量分层，检验稳健性与异质性。",
        "prompt_hint": "按关键分层变量做亚组分析，报告各层样本量、效应方向一致性与交互检验；样本过小的层标注为探索性。",
    },
    {
        "name": "统计严谨性审查",
        "description": "先审计数据质量与统计假设，再决定分析路径。",
        "prompt_hint": "先做数据质量审计（缺失/异常值/批次/样本量/分布），明确检验前提；不满足前提时改用稳健方法（如置换检验）。",
    },
]


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return low


# Pre-registered direction hints. Only the *pre-registration* text is inspected
# here (never the result narrative) to know whether the prediction is one-sided.
_POSITIVE_DIRECTION_HINTS = (
    "升高", "上调", "增加", "高于", "正相关", "正向", "positive", "increase", "higher",
)
_NEGATIVE_DIRECTION_HINTS = (
    "降低", "下调", "减少", "低于", "负相关", "负向", "negative", "decrease", "lower",
)


def _expected_direction(hypothesis: Hypothesis) -> int | str:
    """Infer the pre-registered effect direction from prediction/criteria text."""
    text = f"{hypothesis.prediction} {hypothesis.success_criteria}".lower()
    positive = sum(1 for token in _POSITIVE_DIRECTION_HINTS if token in text)
    negative = sum(1 for token in _NEGATIVE_DIRECTION_HINTS if token in text)
    if positive > negative:
        return 1
    if negative > positive:
        return -1
    return "two-sided"


def _evidence_summary(
    result: AnalysisResult | None,
    verdict: str,
    strength: str,
    reproducibility: str,
    reasons: list[str],
) -> str:
    """Render the structured numbers (or the explicit reason they are missing)."""
    if result is None:
        return "不可判定（inconclusive，证据不足）：" + "；".join(reasons[:3])
    q_text = "null" if result.q_value_or_none is None else f"{float(result.q_value_or_none):.4g}"
    if verdict == "inconclusive":
        head = f"不可判定（inconclusive，{strength}，可复现性={reproducibility}）"
    else:
        head = f"{verdict}（{strength}，可复现性={reproducibility}）"
    summary = (
        f"{head}："
        f"{result.test}；effect_size={result.effect_size:.4g}；"
        f"CI=[{result.ci_low:.4g}, {result.ci_high:.4g}]；p={result.p_value:.4g}；q={q_text}；"
        f"校正={result.correction or '未报告'}；执行状态={result.execution_status}"
    )
    if verdict == "inconclusive":
        summary += "；原因：" + "；".join(reasons[-2:])
    return summary


def _tokens(text: str) -> set[str]:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", " ", (text or "").lower())
    return {token for token in cleaned.split() if len(token) >= 2}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / max(1, len(left | right))


def _extract_json(text: str) -> Any:
    """Best-effort JSON extraction from an LLM reply (handles code fences)."""
    if not text:
        return None
    candidates: list[str] = []
    fenced = re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL)
    candidates.extend(fenced)
    candidates.append(text)
    decoder = json.JSONDecoder()
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        for index, char in enumerate(candidate):
            if char not in "[{":
                continue
            try:
                value, _ = decoder.raw_decode(candidate[index:])
            except ValueError:
                continue
            if isinstance(value, (dict, list)):
                return value
    return None


class DiscoveryEngine:
    """Run the RSI loop for one discovery project."""

    def __init__(
        self,
        settings: Settings,
        kernel: Any,
        registry: Any,
        store: ProjectStore,
        agents: dict[str, Any] | None = None,
        skills: dict[str, Any] | None = None,
        loop: Any = None,
        conversation_store: Any = None,
        rerun_verification: bool | None = None,
    ) -> None:
        self.settings = settings
        self.kernel = kernel
        self.registry = registry
        self.store = store
        self.agents = agents or {}
        self.skills = skills or {}
        self.loop = loop
        self.conversation_store = conversation_store
        # Optional explicit re-run verification (off by default). When enabled,
        # a supported/refuted verdict triggers one extra bounded execution whose
        # data/script hashes must match the first run before reproducibility is
        # upgraded from ``code_recorded`` to ``rerun_verified``.
        if rerun_verification is None:
            rerun_verification = bool(
                getattr(settings, "discovery_rerun_verification", False)
            )
        self.rerun_verification = bool(rerun_verification)
        self.rerun_timeout_s = max(
            0.01,
            float(getattr(settings, "discovery_rerun_timeout_s", _DEFAULT_RERUN_TIMEOUT_S)),
        )

    # ------------------------------------------------------------------ llm
    def _llm_available(self) -> bool:
        try:
            target = self.settings.resolve_llm()
        except Exception:
            return False
        return target.family != "mock" and bool(target.api_key)

    async def _complete(
        self,
        prompt: str,
        *,
        system: str = RSI_SYSTEM,
        max_tokens: int = 1600,
        temperature: float = 0.4,
        timeout_s: float = 120.0,
    ) -> str:
        target = self.settings.resolve_llm()
        provider = make_provider(target)
        config = ProviderConfig(
            temperature=temperature, max_tokens=max_tokens, timeout_s=timeout_s
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        parts: list[str] = []
        async for event in provider.stream_chat(messages, [], config):
            if event.get("type") == "text":
                parts.append(str(event.get("delta") or ""))
        return "".join(parts).strip()

    async def _complete_json(
        self,
        prompt: str,
        *,
        system: str = RSI_SYSTEM,
        max_tokens: int = 1600,
        temperature: float = 0.4,
    ) -> Any:
        try:
            text = await self._complete(
                prompt,
                system=system,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        except Exception as exc:
            logger.warning("发现引擎 LLM 调用失败：%s", exc)
            return None
        return _extract_json(text)

    # --------------------------------------------------------------- public
    async def seed_strategies(self, project: Project) -> list[Strategy]:
        existing = self.store.list_strategies(project.id)
        if existing:
            return existing
        strategies = [
            Strategy(
                project_id=project.id,
                name=item["name"],
                description=item["description"],
                prompt_hint=item["prompt_hint"],
            )
            for item in DEFAULT_STRATEGIES
        ]
        self.store.save_strategies(project.id, strategies)
        return strategies

    async def run(
        self,
        project_id: str,
        *,
        emit: Emit | None = None,
        cancel_event: asyncio.Event | None = None,
        approver: Any = None,
    ) -> dict[str, Any]:
        project = self.store.get(project_id)
        if project.status == "running":
            raise RuntimeError("该项目正在运行中，请先停止或等待完成。")
        emit = emit or _null_emit
        project.status = "running"
        project.current_round = int(project.rounds_count)
        self.store.save(project)
        await self._emit(emit, project.id, "project", {"project": project.to_dict(), "phase": "start"})
        await self.seed_strategies(project)

        deadline = time.monotonic() + max(1, project.budget_minutes) * 60
        llm_ok = self._llm_available()
        if not llm_ok:
            try:
                target = self.settings.resolve_llm()
            except Exception:
                target = None
            if target is not None and getattr(target, "family", "") == "mock":
                detail = "当前为内置 mock 演示模型"
            elif target is not None:
                detail = f"当前模型 {target.provider}/{target.model} 缺少可用 API Key"
            else:
                detail = "当前模型配置不可用"
            await self._emit(
                emit,
                project.id,
                "status",
                {
                    "text": (
                        f"未配置真实 LLM（{detail}），发现引擎将以启发式模式运行"
                        "（结构化假设 + 真实 kernel 执行）；配置模型后假设生成/评审会自动升级。"
                    )
                },
            )

        status = "done"
        error = ""
        report_path: Path | None = None
        try:
            for round_index in range(1, project.max_rounds + 1):
                if cancel_event is not None and cancel_event.is_set():
                    raise asyncio.CancelledError
                if time.monotonic() >= deadline:
                    await self._emit(
                        emit, project.id, "status",
                        {"text": f"已达到时间预算（{project.budget_minutes} 分钟），停止继续迭代。"},
                    )
                    break
                current = self.store.get(project.id)
                current.current_round = round_index
                await self._run_round(current, round_index, emit, cancel_event, approver)
                refreshed = self.store.get(project.id)
                refreshed.rounds_count = round_index
                self.store.save(refreshed)
                if time.monotonic() >= deadline:
                    break
        except asyncio.CancelledError:
            status = "cancelled"
            error = "用户取消"
        except ProjectNotFound:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("发现引擎运行失败")
            status = "failed"
            error = str(exc)
            await self._emit(emit, project.id, "error", {"message": f"发现引擎运行失败：{exc}"})
        finally:
            project = self.store.get(project.id)
            rounds = self.store.list_rounds(project.id)
            project.status = status
            if error and status != "done":
                project.summary = error[:500]
            elif not project.summary:
                project.summary = self._summarize(rounds)
            self.store.save(project)
            report = self._build_report(project, rounds)
            try:
                report_path = self.store.write_report(project.id, report)
            except Exception:  # pragma: no cover - defensive
                report_path = None
            await self._emit(
                emit,
                project.id,
                "report",
                {
                    "project_id": project.id,
                    "status": status,
                    "report": report,
                    "report_path": str(report_path) if report_path else "",
                    "summary": project.summary,
                    "error": error,
                },
            )
            await self._emit(
                emit, project.id, "project",
                {"project": project.to_dict(), "phase": "done", "status": status},
            )
        return {
            "status": status,
            "rounds": self.store.get(project.id).rounds_count,
            "report_path": str(report_path) if report_path else "",
        }

    # ---------------------------------------------------------------- round
    async def _run_round(
        self,
        project: Project,
        round_index: int,
        emit: Emit,
        cancel_event: asyncio.Event | None,
        approver: Any,
    ) -> None:
        round_id = new_id("rt")
        context = self._observe(project)
        strategies = self.store.list_strategies(project.id)
        strategy = self._select_strategy(strategies)
        await self._emit(
            emit, project.id, "round",
            {
                "phase": "observe",
                "index": round_index,
                "round_id": round_id,
                "project_id": project.id,
                "strategy": strategy.to_dict() if strategy else None,
                "context": context,
            },
        )
        if cancel_event is not None and cancel_event.is_set():
            raise asyncio.CancelledError

        hypotheses = await self._hypothesize(project, round_index, context, emit)
        if not hypotheses:
            await self._emit(emit, project.id, "status", {"text": f"第 {round_index} 轮未产生新假设，提前结束。"})
            return
        chosen = max(hypotheses, key=lambda item: float(item.get("score") or 0.0))
        hypothesis = Hypothesis(
            project_id=project.id,
            statement=str(chosen.get("statement") or "").strip(),
            rationale=str(chosen.get("rationale") or "").strip(),
            prediction=str(chosen.get("prediction") or "").strip(),
            test_plan=str(chosen.get("test_plan") or "").strip(),
            success_criteria=str(chosen.get("success_criteria") or "").strip(),
            status="testing",
            confidence=_clamp(float(chosen.get("confidence") or 0.45), 0.05, 0.95),
            round=round_index,
            source=str(chosen.get("source") or "llm"),
        )
        self.store.append_hypothesis(hypothesis)
        await self._emit(
            emit, project.id, "hypothesis",
            {"phase": "prioritize", "round": round_index, "hypothesis": hypothesis.to_dict(),
             "score": round(float(chosen.get("score") or 0.0), 4)},
        )

        record = DiscoveryRound(
            id=round_id,
            project_id=project.id,
            index=round_index,
            strategy_id=strategy.id if strategy else "",
            hypothesis_id=hypothesis.id,
            plan=hypothesis.test_plan,
            prediction=hypothesis.prediction,
            success_criteria=hypothesis.success_criteria,
            started_at=iso_now(),
        )
        self.store.append_round(record)
        await self._emit(
            emit, project.id, "round",
            {"phase": "preregister", "index": round_index, "round_id": round_id,
             "plan": record.plan, "prediction": record.prediction,
             "success_criteria": record.success_criteria},
        )
        if cancel_event is not None and cancel_event.is_set():
            raise asyncio.CancelledError

        exit_info = await self._execute(project, hypothesis, strategy, emit, cancel_event, approver)
        evaluation = await self._evaluate(project, hypothesis, exit_info, emit)
        reward = float(evaluation["reward"])
        reflection = await self._reflect(project, hypothesis, exit_info, evaluation, strategy, emit)
        record.outcome = str(evaluation.get("outcome") or "")
        record.reward = reward
        record.reflection = str(reflection.get("reflection") or "")
        record.ended_at = iso_now()
        record.error = str(exit_info.get("error") or "")
        self.store.append_round(record)
        await self._emit(emit, project.id, "round", {"phase": "evaluate", "round": record.to_dict()})

    # -------------------------------------------------------------- observe
    def _observe(self, project: Project) -> str:
        prior_insights = self.store.list_insights(project.id)[-5:]
        prior_evidence = self.store.list_evidence(project.id)[-5:]
        strategies = self.store.list_strategies(project.id)
        lines = [
            f"研究目标：{project.objective}",
            f"领域：{project.domain}",
            f"数据提示：{', '.join(project.data_hints) if project.data_hints else '（未指定，需先检查工作区数据文件）'}",
            "历史洞察："
            + ("；".join(item.text for item in prior_insights) if prior_insights else "无"),
            "最近证据："
            + (
                "；".join(f"[{item.kind}/{item.strength}] {item.summary[:120]}" for item in prior_evidence)
                if prior_evidence
                else "无"
            ),
            "策略库表现："
            + (
                "；".join(
                    f"{item.name}(uses={item.uses},reward={item.reward:.2f})"
                    for item in strategies
                )
                if strategies
                else "无"
            ),
        ]
        return "\n".join(lines)

    def _select_strategy(self, strategies: list[Strategy]) -> Strategy | None:
        if not strategies:
            return None
        total = sum(max(1, item.uses) for item in strategies)
        best: tuple[float, Strategy] | None = None
        for strategy in strategies:
            uses = max(0, strategy.uses)
            mean = float(strategy.reward)
            exploration = math.sqrt(2.0 * math.log(total + 1) / (uses + 1))
            score = mean + 0.35 * exploration
            if best is None or score > best[0]:
                best = (score, strategy)
        return best[1] if best else None

    # ----------------------------------------------------------- hypothesize
    async def _hypothesize(
        self,
        project: Project,
        round_index: int,
        context: str,
        emit: Emit,
    ) -> list[dict[str, Any]]:
        existing = self.store.list_hypotheses(project.id)
        known = [_tokens(item.statement) for item in existing]
        prompt = (
            f"你是生物医学科研假设生成器。基于以下项目信息与历史，提出 2-4 个**全新、可证伪**的假设。\n\n"
            f"{context}\n\n"
            f"当前轮次：{round_index}\n\n"
            "只输出 JSON 数组，每项字段：\n"
            '- "statement": 假设一句话（明确变量与关系）\n'
            '- "rationale": 机制或文献/数据依据（不得编造具体文献）\n'
            '- "prediction": 可观测的预测\n'
            '- "test_plan": 用现有数据可执行的分析步骤（提到统计检验与可视化）\n'
            '- "success_criteria": 预先声明的支持/反驳判据（含效应量与显著性阈值）\n'
            '- "novelty": 0-1, "feasibility": 0-1, "impact": 0-1\n'
            "不要重复历史假设：" + ("；".join(item.statement[:80] for item in existing[-6:]) or "无")
        )
        payload = await self._complete_json(prompt, max_tokens=1800, temperature=0.6)
        raw_items: list[Any] = []
        if isinstance(payload, list):
            raw_items = payload
        elif isinstance(payload, dict):
            for key in ("hypotheses", "items", "data"):
                if isinstance(payload.get(key), list):
                    raw_items = payload[key]
                    break
        candidates: list[dict[str, Any]] = []
        strategy_prior = 0.5
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            statement = str(item.get("statement") or "").strip()
            if len(statement) < 8:
                continue
            tokens = _tokens(statement)
            if any(_jaccard(tokens, previous) > 0.6 for previous in known):
                continue
            novelty = _clamp(item.get("novelty", 0.6))
            feasibility = _clamp(item.get("feasibility", 0.6))
            impact = _clamp(item.get("impact", 0.5))
            score = 0.35 * novelty + 0.25 * feasibility + 0.20 * impact + 0.20 * strategy_prior
            candidates.append(
                {
                    "statement": statement,
                    "rationale": str(item.get("rationale") or "").strip(),
                    "prediction": str(item.get("prediction") or "").strip(),
                    "test_plan": str(item.get("test_plan") or "").strip(),
                    "success_criteria": str(item.get("success_criteria") or "").strip(),
                    "confidence": 0.5,
                    "score": score,
                    "source": "llm",
                }
            )
        if not candidates:
            candidates = self._heuristic_hypotheses(project, round_index)
            for candidate in candidates:
                tokens = _tokens(candidate["statement"])
                candidate["score"] = (
                    0.35 * _clamp(candidate.get("novelty", 0.5))
                    + 0.25 * _clamp(candidate.get("feasibility", 0.7))
                    + 0.20 * _clamp(candidate.get("impact", 0.5))
                    + 0.20 * strategy_prior
                )
        await self._emit(
            emit, project.id, "status",
            {"text": f"第 {round_index} 轮生成 {len(candidates)} 条候选假设（来源：{'LLM' if raw_items else '启发式'}）"},
        )
        return candidates

    def _heuristic_hypotheses(self, project: Project, round_index: int) -> list[dict[str, Any]]:
        objective = project.objective or project.title or "该研究问题"
        domain = project.domain or "生物医学"
        base = [
            {
                "statement": f"在 {objective} 中，关键分组变量与主要结局指标存在稳健差异，且在多重检验校正后仍显著。",
                "rationale": "组间差异是多数生物医学研究的首要可检验信号；需排除样本量不足与批次效应。",
                "prediction": "分组间主要指标差异的效应量 |d| ≥ 0.5 且 FDR < 0.1。",
                "test_plan": "检查数据质量与样本量 → 分组描述统计 → 正态性/方差齐性检验 → 选择 t 检验或 Wilcoxon 检验 → BH-FDR 校正 → 计算 Cohen's d 与置信区间 → 箱线图/小提琴图。",
                "success_criteria": "校正后 p < 0.1 且效应量方向在敏感性分析中一致。",
            },
            {
                "statement": f"在 {objective} 中，两个关键特征之间存在独立于主要混杂因素的关联。",
                "rationale": "关联分析可揭示候选机制；但必须控制混杂并报告模型假设。",
                "prediction": "控制混杂后关联方向不变，且置换检验 p < 0.05。",
                "test_plan": "缺失值处理 → 分布检查 → Spearman/ Pearson 相关 → 多变量线性/逻辑回归（含混杂变量）→ 残差诊断 → 置换检验 → 散点图与拟合线。",
                "success_criteria": "调整后效应方向一致且置换检验 p < 0.05；否则判为不确定。",
            },
            {
                "statement": f"在 {objective} 中，一组相关分析（如通路/功能模块）在特定条件下呈现一致变化。",
                "rationale": "通路层面的一致性比单个特征更稳健，但需控制多重比较。",
                "prediction": "至少一个通路在 FDR < 0.1 下显著且方向与差异分析一致。",
                "test_plan": "差异特征 → 富集分析（GSEA/超几何）→ FDR 校正 → 通路热图 → 敏感性分析（去批次/去离群样本）。",
                "success_criteria": "FDR < 0.1 且至少在一种敏感性分析中保持显著。",
            },
        ]
        offset = (max(1, round_index) - 1) % len(base)
        rotated = base[offset:] + base[:offset]
        derived: list[dict[str, Any]] = []
        for index, item in enumerate(rotated[:2], start=1):
            statement = item["statement"] if round_index <= 1 else f"（第 {round_index} 轮复检）{item['statement']}"
            derived.append(
                {
                    "statement": statement,
                    "rationale": f"领域={domain}；{item['rationale']}",
                    "prediction": item["prediction"],
                    "test_plan": item["test_plan"],
                    "success_criteria": item["success_criteria"],
                    "confidence": 0.45,
                    "novelty": 0.45 if round_index <= 1 else 0.35,
                    "feasibility": 0.7,
                    "impact": 0.5,
                    "source": "heuristic",
                }
            )
        return derived

    # --------------------------------------------------------------- execute
    def _execution_prompt(
        self, project: Project, hypothesis: Hypothesis, hint: str = ""
    ) -> str:
        """Build the experiment prompt shared by the first run and re-run verification."""
        return (
            f"【RSI 发现项目 · 第 {hypothesis.round} 轮实验执行】\n"
            f"项目目标：{project.objective}\n"
            f"当前假设：{hypothesis.statement}\n"
            f"依据：{hypothesis.rationale}\n"
            f"预测：{hypothesis.prediction}\n"
            f"预注册计划：{hypothesis.test_plan}\n"
            f"成功判据：{hypothesis.success_criteria}\n"
            f"策略提示：{hint}\n\n"
            "请实际执行上述计划：\n"
            "1) 先用 list_files / read_file 检查工作区数据，确认可用变量名与样本量；若无数据文件，请用数据提示或合理模拟数据前先说明这是模拟并在结论中标注。\n"
            "2) 用 run_python_code 逐步执行真实分析（导入包、数据处理、统计检验、效应量、多重检验校正、必要的置换检验）。\n"
            "3) 画 1-2 张关键图并保存到工作区 figures/（图片会自动收集）。\n"
            "4) 统计计算完成后，必须调用 discovery_record_analysis_result 提交结构化结果：data_sha256、script_sha256、"
            "seed、test、effect_size、ci_low、ci_high、p_value、q_value_or_none、correction、method、"
            "sample_definition、exclusions、execution_status、artifact_refs、environment。"
            "若分析失败，请把 execution_status 设为 failed 并说明原因；禁止用文本结论代替该工具调用。\n"
            "5) 最后输出 `结论:` 一行与统计量、样本量、局限，供人类阅读；但证据判定只由结构化结果与预注册判据决定，"
            "叙述中的“支持/不显著/显著/p=…”不参与判定。\n"
            "禁止编造数值；若无法完成分析，明确说明原因。"
        )

    async def _execute(
        self,
        project: Project,
        hypothesis: Hypothesis,
        strategy: Strategy | None,
        emit: Emit,
        cancel_event: asyncio.Event | None,
        approver: Any,
    ) -> dict[str, Any]:
        if self.loop is None:
            return {"ok": False, "error": "发现引擎缺少 agent loop，无法执行实验。", "tool_results": [], "figures": []}
        tool_calls: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []
        figures: list[str] = []
        analysis_payloads: list[dict[str, Any]] = []
        analysis_errors: list[str] = []

        async def capture(event: AgentEvent) -> None:
            if event.type == "tool_call":
                tool_calls.append(dict(event.data))
            elif event.type == "tool_result":
                item = dict(event.data)
                tool_results.append(item)
                if item.get("name") == "discovery_record_analysis_result":
                    data = item.get("data")
                    if isinstance(data, dict):
                        payload = data.get("analysis_result")
                        if isinstance(payload, dict):
                            analysis_payloads.append(dict(payload))
                        for error in data.get("errors") or []:
                            text = str(error).strip()
                            if text:
                                analysis_errors.append(text)
            elif event.type == "figure":
                name = str(event.data.get("name") or "")
                if name:
                    figures.append(name)
            try:
                await emit(event)
            except Exception:  # pragma: no cover - UI sink failure
                logger.debug("转发发现事件失败", exc_info=True)

        hint = strategy.prompt_hint if strategy else ""
        prompt = self._execution_prompt(project, hypothesis, hint)
        conversation = Conversation(
            id=new_id("cv"),
            title=f"RSI 实验 {project.id[:8]} R{hypothesis.round}",
            agent=project.agent or "lead",
            meta={"ephemeral": True, "discovery_project": project.id, "hypothesis_id": hypothesis.id},
        )
        started = time.perf_counter()
        error = ""
        finish_reason = ""
        try:
            result = await self.loop.run(
                conversation,
                prompt,
                emit=capture,
                cancel_event=cancel_event,
                approver=approver,
                agent_id=project.agent or "lead",
            )
            finish_reason = str(result.get("finish_reason") or "")
            if finish_reason in {"error", "cancelled"}:
                error = str(result.get("error") or finish_reason)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("RSI 实验执行失败")
            error = str(exc)
        finally:
            if self.conversation_store is not None:
                try:
                    self.conversation_store.delete(conversation.id)
                except Exception:
                    logger.debug("清理临时发现会话失败", exc_info=True)

        final_text = ""
        try:
            last_assistant = [m for m in conversation.messages if m.role == "assistant"]
            if last_assistant:
                final_text = last_assistant[-1].content or ""
        except Exception:
            final_text = ""

        code_samples: list[str] = []
        result_samples: list[str] = []
        for call in tool_calls:
            if call.get("name") in {"run_python_code", "run_shell"}:
                arguments = call.get("arguments")
                if isinstance(arguments, dict) and arguments.get("code"):
                    code_samples.append(str(arguments["code"])[:4000])
        for item in tool_results:
            preview = str(item.get("preview") or item.get("content") or "")
            if preview:
                result_samples.append(preview[:2000])
        return {
            "ok": not error,
            "error": error,
            "finish_reason": finish_reason,
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "final_text": final_text[:6000],
            "tool_calls": tool_calls[:40],
            "tool_results": tool_results[:60],
            "figures": figures[:12],
            "code": "\n\n# ---\n\n".join(code_samples)[:8000],
            "excerpt": "\n\n".join(result_samples)[:4000],
            # The last structured record wins; errors are kept for the audit trail.
            "analysis_result_payload": analysis_payloads[-1] if analysis_payloads else None,
            "analysis_errors": list(dict.fromkeys(analysis_errors)),
            "rerun_verified": None,
        }

    # ------------------------------------------------------- rerun verify
    def _rerun_timeout(self, project: Project) -> float:
        """Time budget for one re-run, capped by the project time budget."""
        timeout = float(getattr(self, "rerun_timeout_s", _DEFAULT_RERUN_TIMEOUT_S))
        try:
            budget_seconds = float(getattr(project, "budget_minutes", 0) or 0) * 60.0
        except (TypeError, ValueError):
            budget_seconds = 0.0
        if budget_seconds > 0:
            timeout = min(timeout, budget_seconds)
        return max(0.01, timeout)

    async def _verify_rerun(
        self,
        project: Project,
        hypothesis: Hypothesis,
        first: AnalysisResult,
        exit_info: dict[str, Any],
        *,
        timeout_s: float = _DEFAULT_RERUN_TIMEOUT_S,
        reasons: list[str] | None = None,
    ) -> bool:
        """Run one bounded re-execution and require identical data/script hashes.

        Returns ``True`` only when the second run completed and reported exactly
        the same ``data_sha256`` and ``script_sha256`` as the first run. Failures
        never raise: the concrete reason is appended to ``reasons`` so it reaches
        the evaluator audit trail and the report.
        """
        notes = reasons if reasons is not None else []
        if self.loop is None:
            notes.append("重跑复核未执行：引擎缺少 agent loop，可复现性保持 code_recorded。")
            return False

        payloads: list[dict[str, Any]] = []
        parse_errors: list[str] = []

        async def capture(event: AgentEvent) -> None:
            # Re-run events are intentionally NOT forwarded to the main conversation.
            if event.type != "tool_result":
                return
            item = dict(event.data)
            if item.get("name") != "discovery_record_analysis_result":
                return
            data = item.get("data")
            if not isinstance(data, dict):
                return
            payload = data.get("analysis_result")
            if isinstance(payload, dict):
                payloads.append(dict(payload))
            for error in data.get("errors") or []:
                text = str(error).strip()
                if text:
                    parse_errors.append(text)

        prompt = (
            self._execution_prompt(project, hypothesis)
            + "\n\n【重跑复核（可复现性验证）】\n"
            "上一次运行已提交结构化分析结果。现在请用完全相同的数据、相同的处理与统计脚本再执行一次，"
            f"并再次调用 discovery_record_analysis_result：data_sha256 应为 {first.data_sha256}，"
            f"script_sha256 应为 {first.script_sha256}。不要修改数据、脚本、随机种子或判据；"
            "若无法一致复现，请如实提交本次实际结果（execution_status=failed 或不同哈希）。"
        )
        conversation = Conversation(
            id=new_id("cv"),
            title=f"RSI 重跑复核 {project.id[:8]} H{hypothesis.round}",
            agent=project.agent or "lead",
            meta={
                "ephemeral": True,
                "discovery_project": project.id,
                "rerun_of": hypothesis.id,
            },
        )
        try:
            result = await asyncio.wait_for(
                self.loop.run(
                    conversation,
                    prompt,
                    emit=capture,
                    cancel_event=None,
                    approver=None,
                    agent_id=project.agent or "lead",
                ),
                timeout=max(0.01, float(timeout_s)),
            )
            finish_reason = str(result.get("finish_reason") or "")
            if finish_reason in {"error", "cancelled"}:
                notes.append(
                    f"重跑复核未完成（finish_reason={finish_reason}），可复现性保持 code_recorded。"
                )
                return False
        except asyncio.TimeoutError:
            notes.append(
                f"重跑复核超时（>{float(timeout_s):.1f}s），可复现性保持 code_recorded。"
            )
            return False
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("重跑复核异常：%s", exc)
            notes.append(f"重跑复核异常（{exc}），可复现性保持 code_recorded。")
            return False
        finally:
            if self.conversation_store is not None:
                try:
                    self.conversation_store.delete(conversation.id)
                except Exception:
                    logger.debug("清理重跑复核临时会话失败", exc_info=True)

        if not payloads:
            detail = f"（解析错误：{'；'.join(parse_errors[:3])}）" if parse_errors else ""
            notes.append(f"重跑复核未产生结构化结果{detail}，可复现性保持 code_recorded。")
            return False
        second, second_errors = AnalysisResult.from_payload(payloads[-1])
        if second is None:
            detail = "解析错误：" + "；".join(second_errors[:3]) if second_errors else ""
            notes.append(f"重跑复核的结构化结果不完整，可复现性保持 code_recorded。{detail}")
            return False
        if second.execution_status != "completed":
            notes.append(
                f"重跑执行状态为 {second.execution_status}，不是成功重跑，"
                "可复现性保持 code_recorded。"
            )
            return False
        mismatched = [
            key
            for key in ("data_sha256", "script_sha256")
            if str(getattr(first, key, "")).strip().lower()
            != str(getattr(second, key, "")).strip().lower()
        ]
        if mismatched:
            notes.append(
                "重跑结果哈希与首次不一致（"
                + "、".join(mismatched)
                + "）；可复现性保持 code_recorded。"
            )
            return False
        notes.append(
            "重跑复核通过：data_sha256 与 script_sha256 与首次一致，"
            "可复现性升级为 rerun_verified。"
        )
        return True

    # -------------------------------------------------------------- evaluate
    async def _evaluate(
        self,
        project: Project,
        hypothesis: Hypothesis,
        exit_info: dict[str, Any],
        emit: Emit,
    ) -> dict[str, Any]:
        preregistration: dict[str, Any] = {
            "statement": hypothesis.statement,
            "rationale": hypothesis.rationale,
            "prediction": hypothesis.prediction,
            "test_plan": hypothesis.test_plan,
            "success_criteria": hypothesis.success_criteria,
            "expected_direction": _expected_direction(hypothesis),
            "round": hypothesis.round,
        }
        payload = exit_info.get("analysis_result_payload")
        result: AnalysisResult | None = None
        parse_errors: list[str] = []
        if isinstance(payload, dict):
            result, parse_errors = AnalysisResult.from_payload(payload)
        prior_errors = [str(item) for item in (exit_info.get("analysis_errors") or []) if str(item).strip()]
        run_info: dict[str, Any] = {
            "code": str(exit_info.get("code") or ""),
            "tool_results": exit_info.get("tool_results") or [],
            "final_text": str(exit_info.get("final_text") or ""),
            "analysis_errors": list(dict.fromkeys([*prior_errors, *parse_errors])),
            "rerun_verified": exit_info.get("rerun_verified"),
        }
        # The evaluator is the only authority for verdict / strength / reproducibility.
        evaluator = EvidenceEvaluator()
        evaluated = evaluator.evaluate(preregistration, result, run_info)
        verdict = str(evaluated["verdict"])
        strength = str(evaluated["strength"])
        reproducibility = str(evaluated["reproducibility"])
        reasons = [str(item) for item in evaluated["reasons"]]

        # Optional explicit re-run verification: only numeric verdicts that could
        # be strengthened (supported/refuted) earn a second bounded execution.
        rerun_attempted = False
        rerun_verified = False
        rerun_notes: list[str] = []
        if (
            self.rerun_verification
            and result is not None
            and verdict in {"supported", "refuted"}
        ):
            rerun_attempted = True
            rerun_verified = await self._verify_rerun(
                project,
                hypothesis,
                result,
                exit_info,
                timeout_s=self._rerun_timeout(project),
                reasons=rerun_notes,
            )
            run_info["rerun_verified"] = rerun_verified
            evaluated = evaluator.evaluate(preregistration, result, run_info)
            verdict = str(evaluated["verdict"])
            strength = str(evaluated["strength"])
            reproducibility = str(evaluated["reproducibility"])
            reasons = [str(item) for item in evaluated["reasons"]]
            reasons.extend(rerun_notes)

        structured_summary = (
            f"{result.test}／{result.method}；effect_size={result.effect_size:.4g}；"
            f"CI=[{result.ci_low:.4g}, {result.ci_high:.4g}]；p={result.p_value:.4g}；"
            f"q={'null' if result.q_value_or_none is None else f'{float(result.q_value_or_none):.4g}'}；"
            f"执行状态={result.execution_status}"
            if result is not None
            else "（无结构化分析结果）"
        )
        critic_issues: list[str] = []
        critic_rationale = ""
        critic_payload = await self._complete_json(
            "你是科研设计评审专家。你只能评估实验设计、统计方法选择、样本量与解释是否合理；"
            "不得给出或覆盖是否支持假设的判定，也不得修改证据强度——"
            "判定由结构化数值与预注册判据自动完成，你的文字不参与证据判定。\n\n"
            f"假设：{hypothesis.statement}\n预测：{hypothesis.prediction}\n"
            f"预注册判据：{hypothesis.success_criteria}\n"
            f"结构化结果：{structured_summary}\n"
            f"执行摘要：{str(exit_info.get('excerpt') or '')[:2000]}\n"
            f"最终叙述：{str(exit_info.get('final_text') or '')[:2000]}\n\n"
            "输出 JSON：{\"issues\":[\"设计与解释问题\"],\"rationale\":\"评审意见（仅限设计与解释）\"}",
            max_tokens=600,
            temperature=0.2,
        )
        if isinstance(critic_payload, dict):
            critic_issues = [str(item) for item in (critic_payload.get("issues") or [])][:6]
            critic_rationale = str(critic_payload.get("rationale") or "").strip()
            ignored = sorted(
                key for key in ("verdict", "strength", "confidence") if key in critic_payload
            )
            if ignored:
                reasons.append(
                    "已忽略 LLM 评审返回的判定字段（" + "、".join(ignored) + "）；数值判定不受评审文本影响。"
                )

        prior = _clamp(hypothesis.confidence, 0.05, 0.95)
        completed = result is not None and result.execution_status == "completed"
        quality = 0.0
        quality += 0.5 if completed else 0.0
        quality += 0.15 if run_info["code"] else 0.0
        quality += 0.15 if exit_info.get("figures") else 0.0
        quality += 0.1 if (result is not None and result.q_value_or_none is not None) else 0.0
        quality += 0.1 if (result is not None and result.sample_size) else 0.0
        quality = _clamp(quality, 0.0, 1.0)
        verdict_score = {"supported": 1.0, "refuted": 0.5, "inconclusive": 0.3}[verdict]
        reward = _clamp(0.45 * verdict_score + 0.35 * quality + 0.20 * prior, 0.0, 1.0)

        summary = _evidence_summary(result, verdict, strength, reproducibility, reasons)
        if rerun_attempted and rerun_notes:
            summary = f"{summary}；重跑复核：{rerun_notes[-1]}"
        evidence = Evidence(
            project_id=project.id,
            hypothesis_id=hypothesis.id,
            kind="experiment" if completed else "critique",
            summary=summary,
            code=str(exit_info.get("code") or "")[:6000],
            result_excerpt=str(exit_info.get("excerpt") or exit_info.get("final_text") or "")[:3000],
            figures=[str(item) for item in exit_info.get("figures") or []],
            strength=strength,
            reproducibility=reproducibility,
            analysis_result=result.to_dict() if result is not None else None,
            round=hypothesis.round,
        )
        self.store.add_evidence(evidence)

        if verdict == "supported":
            updated = prior + (0.95 - prior) * 0.35
        elif verdict == "refuted":
            updated = prior - (prior - 0.05) * 0.35
        else:
            updated = prior * 0.9 + 0.5 * 0.1
        hypothesis.status = verdict
        hypothesis.confidence = _clamp(updated, 0.02, 0.98)
        hypothesis.evidence_ids.append(evidence.id)
        self.store.update_hypothesis(hypothesis)

        execution_state = result.execution_status if result is not None else "not_recorded"
        outcome = (
            f"判定={verdict}，强度={strength}，可复现性={reproducibility}，"
            f"置信度={hypothesis.confidence:.2f}，reward={reward:.2f}，"
            f"结构化结果={'已记录' if result is not None else '缺失'}，执行状态={execution_state}"
        )
        evaluation = {
            "verdict": verdict,
            "confidence": hypothesis.confidence,
            "strength": strength,
            "reproducibility": reproducibility,
            "rerun_verified": rerun_verified,
            "rerun_attempted": rerun_attempted,
            "reasons": reasons,
            "issues": critic_issues,
            "review": critic_rationale,
            "reward": reward,
            "outcome": outcome,
            "evidence": evidence.to_dict(),
        }
        await self._emit(emit, project.id, "evidence", {"round": hypothesis.round, "evidence": evidence.to_dict()})
        await self._emit(
            emit, project.id, "hypothesis",
            {"phase": "evaluate", "round": hypothesis.round, "hypothesis": hypothesis.to_dict()},
        )
        return evaluation

    # --------------------------------------------------------------- reflect
    async def _reflect(
        self,
        project: Project,
        hypothesis: Hypothesis,
        exit_info: dict[str, Any],
        evaluation: dict[str, Any],
        strategy: Strategy | None,
        emit: Emit,
    ) -> dict[str, Any]:
        strategies = self.store.list_strategies(project.id)
        payload = await self._complete_json(
            "你是科研策略优化器。根据本轮实验与评审结果，反思并改进研究策略（这是 RSI 的自我改进步骤）。\n\n"
            f"目标：{project.objective}\n假设：{hypothesis.statement}\n"
            f"判定：{evaluation['verdict']}（强度={evaluation.get('strength')}，"
            f"可复现性={evaluation.get('reproducibility')}，reward={evaluation['reward']:.2f}）\n"
            f"判定原因：{'；'.join(str(item) for item in (evaluation.get('reasons') or [])[-4:])[:900]}\n"
            f"执行摘要：{str(exit_info.get('excerpt') or '')[:1500]}\n"
            f"问题清单：{evaluation.get('issues')}\n"
            f"当前策略：{strategy.name if strategy else '无'}｜{strategy.prompt_hint if strategy else ''}\n\n"
            "输出 JSON：{\"reflection\":\"本轮经验（2-3 句）\",\"lessons\":[\"...\"],"
            "\"insight\":\"可复用的新洞察（一句话）\","
            "\"strategy_mutation\":{\"name\":\"新策略名\",\"description\":\"...\",\"prompt_hint\":\"...\"}}",
            max_tokens=900,
            temperature=0.4,
        )
        if not isinstance(payload, dict):
            payload = {}
        reflection_text = str(payload.get("reflection") or "").strip() or (
            f"本轮假设判定为 {evaluation['verdict']}，reward={evaluation['reward']:.2f}；"
            "下一轮应优先检查数据质量、样本量与统计假设，并复用表现更好的策略。"
        )
        lessons = [str(item) for item in (payload.get("lessons") or []) if str(item).strip()][:6]
        insight_text = str(payload.get("insight") or "").strip()
        if not insight_text:
            insight_text = (
                f"[{evaluation['verdict']}] {hypothesis.statement[:120]} → "
                f"{(evaluation.get('evidence') or {}).get('summary', '')[:120]}"
            )

        insight = Insight(
            project_id=project.id,
            text=insight_text,
            confidence=_clamp(evaluation.get("confidence", 0.5), 0.05, 0.95),
            evidence_ids=[str((evaluation.get("evidence") or {}).get("id") or "")],
            round=hypothesis.round,
        )
        self.store.add_insight(insight)
        await self._emit(emit, project.id, "insight", {"round": hypothesis.round, "insight": insight.to_dict()})

        reward = float(evaluation.get("reward") or 0.0)
        success = evaluation.get("verdict") == "supported"
        if strategy is not None:
            strategy.uses += 1
            strategy.successes += 1 if success else 0
            strategy.reward = _clamp(0.7 * strategy.reward + 0.3 * reward)
            strategy.updated_at = iso_now()
            self.store.upsert_strategy(strategy)
            await self._emit(emit, project.id, "strategy", {"strategy": strategy.to_dict(), "phase": "update"})

        mutation = payload.get("strategy_mutation")
        new_strategy: Strategy | None = None
        if isinstance(mutation, dict) and str(mutation.get("name") or "").strip():
            new_strategy = Strategy(
                project_id=project.id,
                name=str(mutation.get("name")).strip()[:60],
                description=str(mutation.get("description") or "").strip()[:400],
                prompt_hint=str(mutation.get("prompt_hint") or "").strip()[:1500],
                lineage=strategy.id if strategy else None,
                reward=0.5,
            )
            self.store.upsert_strategy(new_strategy)
            await self._emit(emit, project.id, "strategy", {"strategy": new_strategy.to_dict(), "phase": "mutate"})

        result = {
            "reflection": reflection_text,
            "lessons": lessons,
            "insight": insight.to_dict(),
            "new_strategy": new_strategy.to_dict() if new_strategy else None,
        }
        await self._emit(emit, project.id, "reflection", {"round": hypothesis.round, **result})
        return result

    # ---------------------------------------------------------------- report
    def _summarize(self, rounds: list[DiscoveryRound]) -> str:
        if not rounds:
            return "尚未完成任何轮次。"
        supported = sum(1 for item in rounds if "判定=supported" in (item.outcome or ""))
        refuted = sum(1 for item in rounds if "判定=refuted" in (item.outcome or ""))
        avg = sum(item.reward for item in rounds) / max(1, len(rounds))
        return (
            f"完成 {len(rounds)} 轮；支持 {supported}，反驳 {refuted}，"
            f"平均 reward {avg:.2f}。"
        )

    def _data_manifest(self, project: Project) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        workspace = Path(self.settings.workspace)
        for hint in project.data_hints[:20]:
            candidate = Path(str(hint))
            if not candidate.is_absolute():
                candidate = workspace / str(hint)
            try:
                candidate = candidate.expanduser().resolve()
                if not str(candidate).startswith(str(workspace.resolve())):
                    manifest.append({"hint": str(hint), "status": "outside_workspace"})
                    continue
                if not candidate.is_file():
                    manifest.append({"hint": str(hint), "status": "not_found"})
                    continue
                digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
                manifest.append(
                    {
                        "hint": str(hint),
                        "path": str(candidate.relative_to(workspace.resolve())),
                        "bytes": candidate.stat().st_size,
                        "sha256": digest,
                        "status": "ok",
                    }
                )
            except OSError:
                manifest.append({"hint": str(hint), "status": "unreadable"})
        return manifest

    def _build_report(self, project: Project, rounds: list[DiscoveryRound]) -> str:
        hypotheses = self.store.list_hypotheses(project.id)
        evidence = self.store.list_evidence(project.id)
        insights = self.store.list_insights(project.id)
        strategies = self.store.list_strategies(project.id)
        manifest = self._data_manifest(project)
        supported = [item for item in hypotheses if item.status == "supported"]
        refuted = [item for item in hypotheses if item.status == "refuted"]
        inconclusive = [item for item in hypotheses if item.status == "inconclusive"]

        lines: list[str] = []
        lines.append(f"# {project.title}")
        lines.append("")
        lines.append(f"- 项目 ID：`{project.id}`")
        lines.append(f"- 研究目标：{project.objective}")
        lines.append(f"- 领域：{project.domain}　状态：{project.status}　轮次：{project.rounds_count}/{project.max_rounds}")
        lines.append(f"- 生成时间：{iso_now()}")
        lines.append("")
        lines.append("## 方法（RSI 闭环）")
        lines.append("")
        lines.append(
            "每轮严格经过：观察 → 假设生成（可证伪）→ 优先级排序（新颖性/可行性/影响 + UCB1 策略选择）"
            "→ 预注册检验（先记录判据再执行）→ 真实 kernel 执行 → 结构化统计结果（AnalysisResult）"
            "→ 证据评估（仅按预注册判据与真实数值）→ 反思与策略进化。"
            "假设状态与证据均可追溯；自由文本叙述不参与证据判定，避免事后挑选与文本命中式提升。"
        )
        lines.append("")
        lines.append("## 假设结果")
        lines.append("")
        if hypotheses:
            lines.append("| 轮次 | 状态 | 置信度 | 假设 |")
            lines.append("| --- | --- | --- | --- |")
            for item in hypotheses:
                statement = item.statement.replace("|", "\\|")[:160]
                lines.append(
                    f"| {item.round} | {item.status} | {item.confidence:.2f} | {statement} |"
                )
        else:
            lines.append("（无假设记录）")
        lines.append("")
        lines.append(
            f"汇总：支持 {len(supported)}，反驳 {len(refuted)}，不确定 {len(inconclusive)}。"
        )
        lines.append("")
        lines.append("## 关键证据")
        lines.append("")
        if evidence:
            for item in evidence[-10:]:
                lines.append(
                    f"### {item.id}（{item.kind}/{item.strength}，"
                    f"可复现性={item.reproducibility}，第 {item.round} 轮）"
                )
                lines.append("")
                lines.append(item.summary or "（无摘要）")
                structured = item.analysis_result if isinstance(item.analysis_result, dict) else None
                if structured:
                    lines.append("")
                    lines.append("结构化统计：")
                    lines.append("")
                    q_text = structured.get("q_value_or_none")
                    lines.append(
                        f"- 检验 / 方法：{structured.get('test')} / {structured.get('method')}"
                    )
                    lines.append(
                        f"- 效应量 {structured.get('effect_size')}；"
                        f"CI [{structured.get('ci_low')}, {structured.get('ci_high')}]；"
                        f"p={structured.get('p_value')}；"
                        f"q={q_text if q_text is not None else 'null'}"
                        f"（校正：{structured.get('correction')}）"
                    )
                    lines.append(
                        f"- 执行状态：{structured.get('execution_status')}；"
                        f"seed={structured.get('seed')}；"
                        f"样本定义：{str(structured.get('sample_definition') or '')[:200]}"
                    )
                    exclusions = structured.get("exclusions") or []
                    lines.append(
                        "- 排除规则："
                        + ("；".join(str(entry) for entry in exclusions) if exclusions else "无")
                    )
                    lines.append(
                        f"- 数据 sha256：{str(structured.get('data_sha256') or '')[:16]}…；"
                        f"脚本 sha256：{str(structured.get('script_sha256') or '')[:16]}…"
                    )
                else:
                    lines.append("")
                    lines.append("- 不可判定：未记录结构化分析结果（证据不足）。")
                if item.result_excerpt:
                    lines.append("")
                    lines.append("```text")
                    lines.append(item.result_excerpt[:1800])
                    lines.append("```")
                if item.figures:
                    lines.append("")
                    lines.append("图表：")
                    for name in item.figures:
                        lines.append(f"- /api/figures/{name}")
                lines.append("")
        else:
            lines.append("（无证据记录）")
        lines.append("## 洞察与教训")
        lines.append("")
        if insights:
            for item in insights[-8:]:
                lines.append(f"- （置信度 {item.confidence:.2f}）{item.text}")
        else:
            lines.append("（无）")
        lines.append("")
        lines.append("## 策略库（自我改进）")
        lines.append("")
        if strategies:
            lines.append("| 策略 | uses | successes | reward | lineage |")
            lines.append("| --- | --- | --- | --- | --- |")
            for item in strategies:
                lines.append(
                    f"| {item.name.replace('|', '/')} | {item.uses} | {item.successes} | "
                    f"{item.reward:.2f} | {item.lineage or '-'} |"
                )
        else:
            lines.append("（无）")
        lines.append("")
        lines.append("## 可复现清单")
        lines.append("")
        lines.append(f"- Python：{sys.version.split()[0]}；平台：{platform.platform()}")
        try:
            interpreter = self.settings.resolve_kernel_python()
        except Exception:
            interpreter = "（未解析）"
        lines.append(f"- 内核解释器：{interpreter}")
        if manifest:
            for item in manifest:
                if item.get("status") == "ok":
                    lines.append(
                        f"- 数据：`{item['path']}`（{item['bytes']} bytes，sha256={item['sha256'][:16]}…）"
                    )
                else:
                    lines.append(f"- 数据提示 `{item.get('hint')}`：{item.get('status')}")
        else:
            lines.append("- 未提供数据提示，请补充数据路径以便复现。")
        lines.append("- 所有随机过程应设置显式随机种子；本轮代码片段见证据记录。")
        lines.append(
            "- 可复现性分级：code_recorded（仅代码留痕）< rerun_verified（显式重跑复核）；"
            "“执行成功”本身不等于可复现。"
        )
        rerun_verified_evidence = [
            item for item in evidence if item.reproducibility == "rerun_verified"
        ]
        code_recorded_evidence = [
            item for item in evidence if item.reproducibility == "code_recorded"
        ]
        lines.append(
            f"- 本报告证据可复现性：rerun_verified {len(rerun_verified_evidence)} 条"
            f"（显式重跑且 data/script sha256 与首次一致），"
            f"code_recorded {len(code_recorded_evidence)} 条（仅代码留痕）。"
        )
        if rerun_verified_evidence:
            lines.append(
                "- 升级原因：重跑复核得到的 data_sha256 与 script_sha256 与首次运行完全一致，"
                "属于显式重跑证据，而非“执行成功”推断。"
            )
        elif self.rerun_verification:
            lines.append(
                "- 重跑复核已开启，但本轮未获得哈希一致的重跑证据；相关证据保持 code_recorded。"
            )
        lines.append("")
        lines.append("## 局限声明")
        lines.append("")
        lines.append(
            "- 证据判定只由结构化 AnalysisResult 与预注册判据的数值核对决定；"
            "叙述中的“显著/不显著/p=…/FDR”等文字不参与判定。"
        )
        lines.append(
            "- 本报告由自动化 RSI 流程生成，结论需要领域专家复核后才能用于决策或发表。"
        )
        lines.append(
            "- 相关性不等于因果；观察性数据的关联可能受混杂、批次效应与选择偏倚影响。"
        )
        lines.append(
            "- 若使用模拟/示例数据，结论仅用于演示方法，不代表真实生物学发现。"
        )
        lines.append(
            "- 统计显著性不等于生物学重要性；请结合效应量、样本量与外部验证解读。"
        )
        lines.append("")
        return "\n".join(lines)

    # ----------------------------------------------------------------- emit
    async def _emit(
        self,
        emit: Emit,
        project_id: str,
        kind: str,
        data: dict[str, Any],
    ) -> None:
        payload = {"kind": kind, "project_id": project_id}
        payload.update(data)
        event = AgentEvent(type="discovery", data=payload)
        try:
            await emit(event)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - UI sink failure
            logger.debug("发送发现事件失败", exc_info=True)


async def _null_emit(event: AgentEvent) -> None:  # pragma: no cover - default sink
    return None


__all__ = ["DEFAULT_STRATEGIES", "DiscoveryEngine", "ProjectNotFound"]
