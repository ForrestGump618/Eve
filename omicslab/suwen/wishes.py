"""Wish-driven research projects over the existing durable run engine.

A wish is intentionally small at the entry point but becomes a persistent,
evidence-gated project. This module owns project state and workspace
projection only; model and tool execution remain in RunService.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import weakref
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .store import uid


STAGES = (
    {
        "id": "charter",
        "label": "愿望章程",
        "depends_on": (),
        "output": "charter.md",
        "purpose": "把一句愿望变成目标、边界、成功判据、未知项与停止条件。",
    },
    {
        "id": "scouting",
        "label": "资源侦察",
        "depends_on": ("charter",),
        "output": "evidence/scouting.md",
        "purpose": "盘点工作区数据、公开资源、文献、工具和可执行环境。",
    },
    {
        "id": "evidence_matrix",
        "label": "证据矩阵",
        "depends_on": ("scouting",),
        "output": "evidence/evidence-matrix.md",
        "purpose": "把主张、支持证据、反证、来源和缺口放到同一张可检索表中。",
    },
    {
        "id": "hypotheses",
        "label": "可证伪假设",
        "depends_on": ("evidence_matrix",),
        "output": "analysis/hypotheses.md",
        "purpose": "提出相互竞争、能够被数据或实验否定的假设，并写出判别证据。",
    },
    {
        "id": "preregistration",
        "label": "预注册方案",
        "depends_on": ("hypotheses",),
        "output": "experiments/preregistration.md",
        "purpose": "在查看结果前锁定主要终点、对照、统计方法、失败条件和停止规则。",
    },
    {
        "id": "analysis",
        "label": "数据分析",
        "depends_on": ("preregistration",),
        "output": "analysis/",
        "purpose": "执行真实、可复现的数据处理与分析，并保存代码、环境、日志和结果。",
    },
    {
        "id": "experiment_design",
        "label": "实验与独立验证",
        "depends_on": ("preregistration",),
        "output": "experiments/",
        "purpose": "设计湿实验、外部队列或独立复现；纯计算课题也需写明不适用的理由。",
    },
    {
        "id": "figures",
        "label": "图表与证据整合",
        "depends_on": ("analysis", "experiment_design"),
        "output": "figures/",
        "purpose": "先规划 Figure 1..N 的证据递进，再基于真实结果生成可追溯图表。",
    },
    {
        "id": "review",
        "label": "用户复核",
        "depends_on": ("figures",),
        "output": "reports/review.md",
        "purpose": "用户核对证据、阴性结果、局限、引用和未完成项后人工结题。",
        "human_only": True,
    },
)
STAGE_BY_ID = {stage["id"]: stage for stage in STAGES}
STAGE_INDEX = {stage["id"]: index for index, stage in enumerate(STAGES)}
STAGE_IDS = tuple(stage["id"] for stage in STAGES)
IDEATION_STAGES = frozenset({"scouting", "evidence_matrix", "hypotheses"})
CHECKPOINT_STAGES = frozenset({"preregistration", "analysis", "experiment_design", "figures"})
MAX_ARTIFACTS = 24
MAX_ARTIFACT_BYTES = 20_000_000
MAX_TEXT_FIELD = 20_000
MAX_LIST_ITEMS = 40
DEFAULT_BUDGET = {
    "max_steps": 8,
    "max_model_calls": 80,
    "max_wall_minutes": 240,
}
STATUS_LABELS = {
    "pending": "未开始",
    "running": "执行中",
    "needs_evidence": "待真实产物",
    "recorded": "证据已登记",
    "failed": "失败待恢复",
    "blocked": "等待条件",
    "needs_review": "等待用户复核",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stage_skills(stage_id: str) -> list[str]:
    if stage_id in IDEATION_STAGES:
        return ["agent4sci-research-ideation"]
    if stage_id in CHECKPOINT_STAGES:
        return ["agent4sci-research-checkpoint"]
    return []


def _research_skill_guidance(stage_id: str, *, advance: bool) -> str:
    guidance: list[str] = []
    if stage_id in IDEATION_STAGES:
        guidance.append(
            "科研构思：先用 skill_search 检索 agent4sci-research-ideation，读取返回 id 后调用 "
            "skill_load。按领域科学方法与计算/AI 方法两条线核对真实文献，区分 Tier 1 "
            "高风险机制方案与 Tier 2 文献支持方案；每个候选写机制、预测、主要指标、"
            "证伪条件、竞争解释和资源预算。不得把调参、换调度器或简单集成写成创新。"
        )
    if stage_id in CHECKPOINT_STAGES or advance:
        guidance.append(
            "研究检查点：先用 skill_search 检索 agent4sci-research-checkpoint，读取返回 id 后调用 "
            "skill_load。登记当前节点前检查研究漂移、真实 CPU/GPU/内存/墙钟、日志、产物、"
            "失败原因、子智能体实现、剩余预算和停止规则；把行动项与简短结论写入当前阶段"
            "主产物的 Research checkpoint 小节，完成可立即执行的纠偏后再登记。连续推进时，"
            "进入下一节点前重新检查，不得沿用旧结论。若转向改变预注册判据，保留旧版本并"
            "新增带时间和理由的修订版，禁止覆盖后假装原本如此。"
        )
    return "\n".join(guidance)


def _text(value: Any, label: str, *, minimum: int = 1, maximum: int = MAX_TEXT_FIELD) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label}需要文本")
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise ValueError(f"{label}需要 {minimum}—{maximum} 个字符")
    return value


def _text_list(value: Any, label: str, *, default: list[str] | None = None) -> list[str]:
    if value is None and default is not None:
        return list(default)
    if not isinstance(value, list) or len(value) > MAX_LIST_ITEMS:
        raise ValueError(f"{label}需要不超过 {MAX_LIST_ITEMS} 项的列表")
    result: list[str] = []
    for item in value:
        text = _text(item, label, maximum=2_000)
        if text not in result:
            result.append(text)
    return result


def _safe_relative(path: Any) -> str:
    raw = _text(path, "产物路径", maximum=1_000).replace("\\", "/")
    pure = PurePosixPath(raw)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError("产物必须是工作区内的相对路径")
    if pure.parts and ":" in pure.parts[0]:
        raise ValueError("产物必须是工作区内的相对路径")
    normalized = str(pure)
    if normalized.startswith("/") or normalized.startswith("~"):
        raise ValueError("产物必须是工作区内的相对路径")
    return normalized


def _project_path(wish: dict[str, Any], path: Any) -> str:
    """Keep every registered artifact inside its own wish workspace."""
    relative = _safe_relative(path)
    base = str(wish["workspace"]["base"]).rstrip("/")
    if relative != base and not relative.startswith(f"{base}/"):
        raise ValueError("产物必须位于当前愿望工作区内")
    return relative


def _public_stage(stage: dict[str, Any]) -> dict[str, Any]:
    return {key: stage.get(key) for key in (
        "id", "label", "status", "depends_on", "output", "purpose",
        "summary", "evidence", "run_id", "run_status", "skipped",
    ) if key in stage}


class ResearchWishes:
    """Persistent wish projects; no second scheduler or hidden result store."""

    def __init__(self, platform):
        self.platform = platform
        self.store = platform.store
        self.locks: weakref.WeakValueDictionary[tuple[str, str], asyncio.Lock] = weakref.WeakValueDictionary()

    def lock(self, scope: str, wish_id: str) -> asyncio.Lock:
        return self.locks.setdefault((scope, wish_id), asyncio.Lock())

    def _base(self, wish_id: str) -> str:
        return f"research-wishes/{wish_id}"

    def _workspace_files(self, wish_id: str) -> dict[str, str]:
        base = self._base(wish_id)
        return {
            "readme": f"{base}/README.md",
            "charter": f"{base}/charter.md",
            "progress": f"{base}/reports/progress.md",
            "ledger": f"{base}/evidence/ledger.md",
            "review": f"{base}/reports/review.md",
        }

    def _reconcile(self, wish: dict[str, Any]) -> dict[str, Any]:
        """Project run terminal states without inferring scientific success."""
        value = json.loads(json.dumps(wish, ensure_ascii=False))
        for stage in value["stages"]:
            run_id = stage.get("run_id")
            if not run_id:
                continue
            try:
                run = self.platform.state.events.get_run(run_id)
            except (AttributeError, KeyError, TypeError):
                run = None
            if not run:
                continue
            status = run.get("status")
            stage["run_status"] = status
            if stage["status"] == "running" and status in {"failed", "cancelled", "interrupted"}:
                stage["status"] = "failed"
            elif stage["status"] == "running" and status in {"succeeded", "completed"}:
                stage["status"] = "needs_evidence"
        value["next_actions"] = self._next_actions(value)
        value["phase"] = self._phase(value)
        if any(blocker.get("resolved") is not True for blocker in value.get("blockers", [])):
            value["status"] = "blocked"
        elif self._all_recorded(value):
            value["status"] = "completed"
        elif self._review_ready(value):
            value["status"] = "awaiting_review"
        elif value.get("status") != "completed":
            value["status"] = "active"
        return value

    def get(self, scope: str, wish_id: str) -> dict[str, Any]:
        self.platform.require_workspace(scope)
        value = self.store.get("research_wish", wish_id, scope)
        if not value:
            raise ValueError("科研愿望不存在或不属于当前工作区")
        return self._reconcile(value)

    def list(self, scope: str) -> list[dict[str, Any]]:
        self.platform.require_workspace(scope)
        return [self._reconcile(row) for row in self.store.list("research_wish", scope)]

    def agent_list(self, scope: str) -> list[dict[str, Any]]:
        """Bounded projection for model context; the UI keeps full progress."""
        result = []
        for wish in self.list(scope):
            result.append({
                "id": wish["id"],
                "title": wish["title"],
                "wish": wish["wish"][:2_000],
                "status": wish["status"],
                "phase": wish["phase"],
                "success_criteria": wish["charter"]["success_criteria"],
                "next_actions": wish["next_actions"],
                "blockers": [b for b in wish.get("blockers", []) if not b.get("resolved")][:10],
                "artifacts": sum(len(stage.get("evidence", [])) for stage in wish["stages"]),
                "workspace": wish.get("workspace", {}),
            })
        return result

    def _next_actions(self, wish: dict[str, Any]) -> list[dict[str, Any]]:
        stages = {stage["id"]: stage for stage in wish["stages"]}
        blocked = self._has_unresolved_blockers(wish)
        if blocked:
            return []
        actions = []
        for stage in STAGES:
            current = stages[stage["id"]]
            if current["status"] == "recorded":
                continue
            dependencies = [stages[dependency] for dependency in stage["depends_on"]]
            if any(dependency["status"] != "recorded" for dependency in dependencies):
                continue
            if current["status"] == "running":
                continue
            actions.append({
                "stage": stage["id"],
                "label": stage["label"],
                "owner": "user" if stage.get("human_only") else "agent",
                "skills": _stage_skills(stage["id"]),
                "output": f"{wish['workspace']['base']}/{stage['output'].rstrip('/')}",
                "reason": stage["purpose"],
            })
        return actions

    @staticmethod
    def _has_unresolved_blockers(wish: dict[str, Any]) -> bool:
        return any(blocker.get("resolved") is not True for blocker in wish.get("blockers", []))

    @staticmethod
    def _review_ready(wish: dict[str, Any]) -> bool:
        stages = {stage["id"]: stage for stage in wish["stages"]}
        return all(
            stages[stage["id"]]["status"] == "recorded"
            for stage in STAGES
            if stage["id"] != "review"
        ) and stages["review"]["status"] != "recorded"

    @staticmethod
    def _all_recorded(wish: dict[str, Any]) -> bool:
        return all(stage["status"] == "recorded" for stage in wish["stages"])

    @staticmethod
    def _phase(wish: dict[str, Any]) -> str:
        for stage in wish["stages"]:
            if stage["status"] != "recorded":
                return stage["id"]
        return "completed"

    def _projection(self, wish: dict[str, Any]) -> dict[str, Any]:
        base = wish["workspace"]["base"]
        value = self._reconcile(dict(wish))
        value["stages"] = [_public_stage(stage) for stage in value["stages"]]
        value["workspace"].update({
            "directories": [
                f"{base}/data",
                f"{base}/evidence",
                f"{base}/analysis",
                f"{base}/experiments",
                f"{base}/figures",
                f"{base}/reports",
                f"{base}/provenance",
            ],
            "instructions": "所有真实输入、脚本、结果、图表、来源和失败记录都保存在此项目目录；平台记录只保存状态与哈希。",
        })
        return value

    async def start(self, scope: str, data: dict[str, Any]) -> dict[str, Any]:
        self.platform.require_workspace(scope)
        wish_text = _text(data.get("wish") or data.get("goal"), "愿望", minimum=3, maximum=8_000)
        title = str(data.get("title") or wish_text.splitlines()[0]).strip()
        title = title[:80].rstrip("。.!?！？；;，,") or "未命名科研愿望"
        boundaries = _text_list(data.get("boundaries"), "边界", default=[
            "只使用当前工作区、可核验的公开资源和当前权限。",
            "不可逆外部操作、付费计算和发送敏感数据必须先获得用户确认。",
            "计划、模拟和模型推断不能登记为已执行结果。",
        ])
        success = _text_list(data.get("success_criteria"), "成功判据", default=[
            "形成一个有来源、有产物哈希、可复核的证据链。",
            "明确哪些结论被支持、被否定、仍未知，以及下一步需要什么证据。",
            "留下可复现的分析代码、环境信息、图表和失败记录。",
        ])
        unknowns = _text_list(data.get("unknowns"), "未知项", default=[
            "关键数据是否真实可得，样本、元数据和许可是否允许当前分析。",
            "现有公开证据是否存在冲突、撤稿、批次或人群适用性限制。",
            "计算证据是否足以回答问题，还是必须补充独立实验或外部队列。",
        ])
        assumptions = _text_list(data.get("assumptions") or [], "假设")
        stop_conditions = _text_list(data.get("stop_conditions"), "停止条件", default=[
            "关键数据或授权缺失，且没有可核验的替代来源。",
            "预算、时间或执行环境耗尽，继续运行只会重复失败。",
            "证据只能支持描述性结果，科学问题需要用户决定是否进入实验验证。",
        ])
        budget = self._budget(data.get("budget"))
        wish_id = uid("wish")
        base = self._base(wish_id)
        files = self._workspace_files(wish_id)
        value: dict[str, Any] = {
            "title": title,
            "wish": wish_text,
            "status": "active",
            "scientific_status": "unverified",
            "charter": {
                "goal": wish_text,
                "boundaries": boundaries,
                "success_criteria": success,
                "unknowns": unknowns,
                "assumptions": assumptions,
                "stop_conditions": stop_conditions,
                "budget": budget,
                "updated_at": _now(),
            },
            "stages": [
                {
                    "id": stage["id"],
                    "label": stage["label"],
                    "status": "needs_review" if stage.get("human_only") else (
                        "needs_evidence" if stage["id"] == "charter" else "pending"
                    ),
                    "depends_on": list(stage["depends_on"]),
                    "output": stage["output"],
                    "purpose": stage["purpose"],
                    "evidence": [],
                }
                for stage in STAGES
            ],
            "blockers": [],
            "activity": [],
            "workspace": {"base": base, **files},
            "created_at": _now(),
        }
        record = self.store.put("research_wish", wish_id, value, scope, expected=0)
        try:
            await self._scaffold(scope, record)
        except Exception:
            self.store.delete("research_wish", wish_id, scope)
            raise
        self.store.audit("research_wish.start", {"id": wish_id, "title": title}, scope)
        return self._projection(record)

    def _budget(self, value: Any) -> dict[str, int]:
        if value is None:
            return dict(DEFAULT_BUDGET)
        if not isinstance(value, dict):
            raise ValueError("预算必须是对象")
        result = dict(DEFAULT_BUDGET)
        for key, minimum, maximum in (
            ("max_steps", 1, 64),
            ("max_model_calls", 1, 2_000),
            ("max_wall_minutes", 1, 10_080),
        ):
            if key not in value:
                continue
            item = value[key]
            if type(item) is not int or not minimum <= item <= maximum:
                raise ValueError(f"预算 {key} 需要 {minimum}—{maximum} 的整数")
            result[key] = item
        return result

    async def _scaffold(self, scope: str, wish: dict[str, Any]) -> None:
        backend = await self.platform.backend(scope)
        base = wish["workspace"]["base"]
        for directory in ("data", "evidence", "analysis", "experiments", "figures", "reports", "provenance"):
            await backend.make_dir(f"{base}/{directory}")
        for path, content in (
            (wish["workspace"]["readme"], self._readme(wish)),
            (wish["workspace"]["charter"], self._charter_markdown(wish)),
            (wish["workspace"]["ledger"], "# 证据账本\n\n每个节点完成后追加真实产物路径、SHA-256、结论和运行标识。\n"),
            (wish["workspace"]["progress"], self._progress_markdown(wish)),
        ):
            await backend.write_text(path, content)

    def _readme(self, wish: dict[str, Any]) -> str:
        base = wish["workspace"]["base"]
        return "\n".join((
            f"# {wish['title']}",
            "",
            "## 愿望",
            "",
            wish["wish"],
            "",
            "## 工作区",
            "",
            f"- `{base}/data`：输入数据与只读快照",
            f"- `{base}/evidence`：证据矩阵与账本",
            f"- `{base}/analysis`：可复现分析代码、结果与说明",
            f"- `{base}/experiments`：预注册、实验设计和外部验证",
            f"- `{base}/figures`：图表规划与真实图表文件",
            f"- `{base}/reports`：进度、报告和人工复核",
            f"- `{base}/provenance`：环境、命令、来源和版本信息",
            "",
            "平台只登记真实存在的文件哈希。计划、模拟和未执行分析不能作为研究结论。",
            "",
        ))

    def _charter_markdown(self, wish: dict[str, Any]) -> str:
        charter = wish["charter"]
        rows = []
        for title, key in (
            ("边界", "boundaries"),
            ("成功判据", "success_criteria"),
            ("未知项", "unknowns"),
            ("工作假设", "assumptions"),
            ("停止条件", "stop_conditions"),
        ):
            rows.extend((f"## {title}", ""))
            rows.extend(f"- {item}" for item in charter[key])
            if not charter[key]:
                rows.append("- 暂无")
            rows.append("")
        budget = charter["budget"]
        rows.extend((
            "## 预算",
            "",
            f"- 最大节点：{budget['max_steps']}",
            f"- 最大模型调用：{budget['max_model_calls']}",
            f"- 最大墙钟时间：{budget['max_wall_minutes']} 分钟",
            "",
            f"更新时间：{charter['updated_at']}",
            "",
        ))
        return f"# {wish['title']} · 愿望章程\n\n## 目标\n\n{charter['goal']}\n\n" + "\n".join(rows)

    def _progress_markdown(self, wish: dict[str, Any]) -> str:
        lines = [f"# {wish['title']} · 研究进度", "", f"当前阶段：{self._phase(wish)}", ""]
        for stage in wish["stages"]:
            lines.extend((
                f"## {stage['label']}",
                "",
                f"状态：{STATUS_LABELS.get(stage['status'], stage['status'])}",
                "",
                stage.get("summary") or stage["purpose"],
                "",
            ))
            for artifact in stage.get("evidence", []):
                lines.append(f"- `{artifact['path']}` · `{artifact['sha256']}`")
            if stage.get("evidence"):
                lines.append("")
        return "\n".join(lines)

    async def _artifact(self, scope: str, path: str, wish: dict[str, Any]) -> dict[str, Any]:
        relative = _project_path(wish, path)
        backend = await self.platform.backend(scope)
        try:
            data, name, mime = await backend.read_bytes(relative)
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"产物不存在或不可读取：{relative}") from exc
        if not data:
            raise ValueError(f"产物为空：{relative}")
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError(f"产物超过 {MAX_ARTIFACT_BYTES // 1_000_000}MB：{relative}")
        return {
            "path": relative,
            "name": name,
            "mime": mime,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }

    async def _append_ledger(
        self,
        scope: str,
        wish: dict[str, Any],
        stage: dict[str, Any],
        evidence: list[dict[str, Any]],
        summary: str,
        run_id: str | None,
        decision: str,
    ) -> None:
        backend = await self.platform.backend(scope)
        ledger = wish["workspace"]["ledger"]
        current = await backend.read_text(ledger, max_bytes=2_000_000)
        existing = str(current.get("content", current.get("text", "")) or "")
        lines = [
            "",
            f"## {stage['label']} · {_now()}",
            "",
            f"- 结论或缺口：{summary}",
            f"- 登记方式：{decision}",
        ]
        if run_id:
            lines.append(f"- 运行：{run_id}")
        for artifact in evidence:
            lines.append(f"- 产物：`{artifact['path']}` · `{artifact['sha256']}` · {artifact['bytes']} bytes")
        lines.extend(("", ""))
        await backend.write_text(ledger, (existing + "\n".join(lines))[:2_000_000])

    async def _write_progress(self, scope: str, wish: dict[str, Any]) -> None:
        backend = await self.platform.backend(scope)
        await backend.write_text(wish["workspace"]["progress"], self._progress_markdown(wish))

    async def update(self, scope: str, wish_id: str, data: dict[str, Any]) -> dict[str, Any]:
        async with self.lock(scope, wish_id):
            current = self.store.get("research_wish", wish_id, scope)
            if not current:
                raise ValueError("科研愿望不存在或不属于当前工作区")
            if current.get("status") == "completed":
                raise ValueError("愿望已人工结题；如需改变问题请新建愿望")
            recorded_later = [
                stage["id"] for stage in current["stages"]
                if stage["id"] != "charter" and stage["status"] == "recorded"
            ]
            if recorded_later and any(key in data for key in ("wish", "goal", "success_criteria", "boundaries")):
                raise ValueError("后续阶段已登记证据；改变目标或成功判据会使证据失效，请新建修订版愿望")
            charter = dict(current["charter"])
            if "wish" in data or "goal" in data:
                charter["goal"] = _text(data.get("wish") or data.get("goal"), "目标", minimum=3, maximum=8_000)
                current["wish"] = charter["goal"]
            if "title" in data:
                title = _text(data["title"], "标题", maximum=80)
                current["title"] = title
            for key, label in (
                ("boundaries", "边界"),
                ("success_criteria", "成功判据"),
                ("unknowns", "未知项"),
                ("assumptions", "工作假设"),
                ("stop_conditions", "停止条件"),
            ):
                if key in data:
                    charter[key] = _text_list(data[key], label)
            if "budget" in data:
                charter["budget"] = self._budget(data["budget"])
            if not charter["success_criteria"]:
                raise ValueError("愿望章程至少需要一条成功判据")
            if not charter["unknowns"]:
                raise ValueError("愿望章程至少需要一个未知项")
            if not charter["stop_conditions"]:
                raise ValueError("愿望章程至少需要一条停止条件")
            charter["updated_at"] = _now()
            current["charter"] = charter
            backend = await self.platform.backend(scope)
            await backend.write_text(current["workspace"]["charter"], self._charter_markdown(current))
            charter_artifact = await self._artifact(scope, current["workspace"]["charter"], current)
            charter_stage = next(stage for stage in current["stages"] if stage["id"] == "charter")
            charter_stage.update(
                status="recorded",
                summary="已形成可验证的目标、边界、成功判据、未知项、停止条件和预算。",
                evidence=[charter_artifact],
                recorded_at=_now(),
                evidence_kind="generated_charter",
            )
            current["activity"].append({"stage": "charter", "action": "updated", "at": _now()})
            current["activity"] = current["activity"][-200:]
            saved = self.store.put("research_wish", wish_id, current, scope, expected=current["revision"])
            await self._append_ledger(
                scope, saved, charter_stage, [charter_artifact],
                charter_stage["summary"], None, "agent_authored_charter",
            )
            await self._write_progress(scope, saved)
            self.store.audit("research_wish.charter", {"id": wish_id}, scope)
            return self._projection(saved)

    def _require_stage_runnable(
        self,
        wish: dict[str, Any],
        stage_id: str,
        *,
        allow_running: bool = False,
    ) -> dict[str, Any]:
        stage_def = STAGE_BY_ID.get(stage_id)
        if not stage_def:
            raise ValueError("未知科研阶段")
        if stage_def.get("human_only"):
            raise ValueError("人工结题只能由用户在界面复核")
        if self._has_unresolved_blockers(wish):
            raise ValueError("愿望存在未解决阻塞项；补齐或解除阻塞后才能继续")
        stages = {stage["id"]: stage for stage in wish["stages"]}
        if stages[stage_id]["status"] == "recorded":
            raise ValueError("此阶段已登记；不得覆盖后续证据依赖")
        if stages[stage_id]["status"] == "running" and not allow_running:
            raise ValueError("此阶段正在执行，请等待完成或先停止当前任务")
        missing = [dependency for dependency in stage_def["depends_on"] if stages[dependency]["status"] != "recorded"]
        if missing:
            labels = "、".join(STAGE_BY_ID[item]["label"] for item in missing)
            raise ValueError(f"前序节点尚未完成：{labels}")
        return stages[stage_id]

    def launch_target(
        self,
        scope: str,
        wish_id: str,
        stage_id: str | None = None,
    ) -> tuple[dict[str, Any], str]:
        """Validate a launch before creating a conversation or submitting a run."""
        wish = self.get(scope, wish_id)
        if stage_id is None:
            action = next((item for item in wish["next_actions"] if item["owner"] == "agent"), None)
            if not action:
                raise ValueError("当前没有可由智能体推进的节点")
            stage_id = action["stage"]
        stage_id = str(stage_id).strip()
        stage_def = STAGE_BY_ID.get(stage_id)
        if not stage_def:
            raise ValueError("未知科研阶段")
        if stage_def.get("human_only"):
            raise ValueError("人工结题只能由用户在界面复核")
        self._require_stage_runnable(wish, stage_id)
        return wish, stage_id

    async def record(
        self,
        scope: str,
        wish_id: str,
        data: dict[str, Any],
        run_id: str | None = None,
    ) -> dict[str, Any]:
        async with self.lock(scope, wish_id):
            current = self.store.get("research_wish", wish_id, scope)
            if not current:
                raise ValueError("科研愿望不存在或不属于当前工作区")
            if current.get("status") == "completed":
                raise ValueError("愿望已结题")
            stage_id = str(data.get("stage") or "")
            stage = self._require_stage_runnable(current, stage_id, allow_running=True)
            artifacts = data.get("artifacts")
            if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= MAX_ARTIFACTS:
                raise ValueError(f"每个节点需要 1—{MAX_ARTIFACTS} 个真实产物")
            evidence = []
            seen = set()
            for path in artifacts:
                item = await self._artifact(scope, path, current)
                if item["path"] not in seen:
                    evidence.append(item)
                    seen.add(item["path"])
            summary = _text(data.get("summary"), "阶段结论或缺口", minimum=10, maximum=5_000)
            decision = str(data.get("decision") or "completed")
            if decision not in {"completed", "not_applicable"}:
                raise ValueError("登记方式只能是 completed 或 not_applicable")
            if decision == "not_applicable" and stage_id not in {"experiment_design"}:
                raise ValueError("只有实验与独立验证节点可以标记不适用")
            if decision == "not_applicable" and len(summary) < 20:
                raise ValueError("标记不适用需要说明为什么不需要该节点")
            if stage_id == "figures":
                chart_extensions = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf", ".html"}
                if not any(
                    str(item["mime"]).startswith("image/")
                    or Path(item["path"]).suffix.lower() in chart_extensions
                    for item in evidence
                ):
                    raise ValueError("图表节点至少需要一张真实图片、SVG、PDF 或 HTML 图表")
            if stage_id == "experiment_design" and decision == "completed":
                if not any(item["path"].startswith(f"{current['workspace']['base']}/experiments/") for item in evidence):
                    raise ValueError("实验设计产物需要放在项目 experiments 目录")
            base = str(current["workspace"]["base"]).rstrip("/")
            stage_def = STAGE_BY_ID[stage_id]
            output = str(stage_def["output"]).rstrip("/")
            if stage_id == "charter":
                expected = f"{base}/charter.md"
                if any(item["path"] != expected for item in evidence):
                    raise ValueError("章程产物必须使用当前愿望的 charter.md")
            else:
                if str(stage_def["output"]).endswith("/"):
                    expected_dir = f"{base}/{output}"
                else:
                    expected_dir = f"{base}/{PurePosixPath(output).parent.as_posix()}"
                if any(not item["path"].startswith(f"{expected_dir}/") for item in evidence):
                    raise ValueError(f"{stage['label']}产物需要放在项目 {stage_def['output'].rstrip('/')} 目录")
            stage.update(
                status="recorded",
                summary=summary,
                evidence=evidence,
                run_id=run_id or stage.get("run_id"),
                recorded_at=_now(),
                evidence_kind="imported_artifacts",
                scientific_status="unverified",
                skipped=decision == "not_applicable",
            )
            current["activity"].append({
                "stage": stage_id, "action": "recorded",
                "artifacts": len(evidence), "at": _now(),
            })
            current["activity"] = current["activity"][-200:]
            saved = self.store.put("research_wish", wish_id, current, scope, expected=current["revision"])
            await self._append_ledger(scope, saved, stage, evidence, summary, run_id, decision)
            await self._write_progress(scope, saved)
            self.store.audit("research_wish.record", {
                "id": wish_id, "stage": stage_id, "artifacts": [item["sha256"] for item in evidence],
            }, scope)
            return self._projection(saved)

    async def block(self, scope: str, wish_id: str, data: dict[str, Any]) -> dict[str, Any]:
        async with self.lock(scope, wish_id):
            current = self.store.get("research_wish", wish_id, scope)
            if not current:
                raise ValueError("科研愿望不存在或不属于当前工作区")
            if current.get("status") == "completed":
                raise ValueError("愿望已人工结题；不能再修改阻塞项")
            if "resolved" in data and not isinstance(data["resolved"], bool):
                raise ValueError("resolved 必须是明确的布尔值")
            blocker_id = str(data.get("blocker_id") or "")
            if data.get("resolved") is True:
                if not blocker_id:
                    raise ValueError("解决阻塞需要 blocker_id")
                found = next((item for item in current["blockers"] if item["id"] == blocker_id), None)
                if not found:
                    raise ValueError("阻塞项不存在")
                found.update(resolved=True, resolved_at=_now(), resolution=_text(
                    data.get("resolution") or "用户已补充所需条件", "解除说明", maximum=2_000,
                ))
            else:
                reason = _text(data.get("reason"), "阻塞原因", minimum=5, maximum=2_000)
                needed = _text(data.get("needed") or "需要用户补充数据、授权或决定", "所需条件", maximum=2_000)
                current["blockers"].append({
                    "id": uid("blocker"),
                    "reason": reason,
                    "needed": needed,
                    "created_at": _now(),
                    "resolved": False,
                })
            current["blockers"] = current["blockers"][-100:]
            saved = self.store.put("research_wish", wish_id, current, scope, expected=current["revision"])
            return self._projection(saved)

    async def review(self, scope: str, wish_id: str, data: dict[str, Any]) -> dict[str, Any]:
        async with self.lock(scope, wish_id):
            current = self.store.get("research_wish", wish_id, scope)
            if not current:
                raise ValueError("科研愿望不存在或不属于当前工作区")
            if data.get("confirmed") is not True:
                raise ValueError("人工结题需要明确确认")
            reviewer = _text(data.get("reviewer"), "复核人", minimum=2, maximum=120)
            notes = _text(data.get("notes"), "复核说明", minimum=20, maximum=5_000)
            unresolved = [item for item in current["blockers"] if not item.get("resolved")]
            if unresolved:
                raise ValueError("仍有未解决的阻塞项，不能结题")
            stages = {stage["id"]: stage for stage in current["stages"]}
            missing = [stage["label"] for stage in STAGES if stage["id"] != "review" and stages[stage["id"]]["status"] != "recorded"]
            if missing:
                raise ValueError("以下节点尚无真实证据：" + "、".join(missing))
            review_stage = stages["review"]
            if review_stage["status"] == "recorded":
                raise ValueError("此愿望已经人工结题")
            backend = await self.platform.backend(scope)
            body = "\n".join((
                f"# {current['title']} · 人工复核",
                "",
                f"- 复核人：{reviewer}",
                f"- 时间：{_now()}",
                "- 范围：当前工作区中的全部已登记证据、真实产物哈希、阴性结果和未完成项。",
                "",
                "## 复核说明",
                "",
                notes,
                "",
                "## 结论边界",
                "",
                "人工复核确认的是证据链与交付完整性，不等同于外部科学共同体已经接受该结论。",
                "",
            ))
            await backend.write_text(current["workspace"]["review"], body)
            artifact = await self._artifact(scope, current["workspace"]["review"], current)
            review_stage.update(
                status="recorded",
                summary=f"用户 {reviewer} 已完成证据与交付复核。",
                evidence=[artifact],
                reviewer=reviewer,
                review_notes=notes,
                recorded_at=_now(),
                evidence_kind="human_review",
            )
            current["status"] = "completed"
            current["human_reviewed_at"] = _now()
            current["activity"].append({"stage": "review", "action": "human_approved", "at": _now()})
            saved = self.store.put("research_wish", wish_id, current, scope, expected=current["revision"])
            await self._append_ledger(scope, saved, review_stage, [artifact], review_stage["summary"], None, "human_review")
            await self._write_progress(scope, saved)
            self.store.audit("research_wish.review", {"id": wish_id, "reviewer": reviewer}, scope)
            return self._projection(saved)

    def prompt(
        self,
        scope: str,
        wish_id: str,
        stage_id: str | None = None,
        *,
        advance: bool = False,
    ) -> str:
        wish = self.get(scope, wish_id)
        stages = {stage["id"]: stage for stage in wish["stages"]}
        if stage_id is None:
            action = next((item for item in wish["next_actions"] if item["owner"] == "agent"), None)
            if not action:
                raise ValueError("当前没有可由智能体推进的节点")
            stage_id = action["stage"]
        stage_def = STAGE_BY_ID.get(stage_id)
        if not stage_def or stage_def.get("human_only"):
            raise ValueError("请选择可由智能体推进的科研节点")
        current = stages[stage_id]
        self._require_stage_runnable(wish, stage_id)
        dependencies = [
            f"{STAGE_BY_ID[item]['label']}={stages[item]['status']}"
            for item in stage_def["depends_on"]
        ]
        outputs = f"{wish['workspace']['base']}/{stage_def['output']}"
        success = "\n".join(f"- {item}" for item in wish["charter"]["success_criteria"])
        boundaries = "\n".join(f"- {item}" for item in wish["charter"]["boundaries"])
        stop = "\n".join(f"- {item}" for item in wish["charter"]["stop_conditions"])
        continuation = (
            "这是连续许愿推进，不是只做一步。登记当前节点后立即调用 wish_status；"
            "只要 next_actions 中还有 owner=agent 的节点，就按依赖继续执行并登记，"
            "每次进入新节点先按 next_actions.skills 检索并加载对应技能；资源侦察、证据矩阵和假设"
            "使用 agent4sci-research-ideation，预注册、分析、实验设计和图表使用 "
            "agent4sci-research-checkpoint。技能不可用时报告缺口，不得声称已加载。"
            "不要等待用户逐节点点击。遇到 wish_block、需要人工复核、预算耗尽或不可逆外部操作时才停止，"
            "并在最后汇总已完成节点、真实产物、失败和仍未知的事项。"
            if advance else
            "本次只完成当前节点；登记或阻塞后停止，让用户决定下一步。"
        )
        skill_guidance = _research_skill_guidance(stage_id, advance=advance)
        skill_block = f"{skill_guidance}\n" if skill_guidance else ""
        if stage_id == "charter":
            return (
                f"推进许愿式科研课题 {wish_id} 的愿望章程阶段。\n"
                f"用户愿望：{wish['wish']}\n"
                "先把愿望改写成可验证、可停止、可追踪的研究章程。主动做出可逆的合理假设，"
                "不要仅因信息不完整就停在提问。只有关键数据、不可推断的授权或不可逆外部操作才向用户请求决定。\n"
                f"必须保留或补全成功判据、边界、未知项和停止条件。完成后调用 wish_update，"
                f"id={wish_id}，提交结构化章程。平台会把章程写入 {wish['workspace']['charter']}。\n"
                "不要声称已经完成任何数据分析或科学验证。\n"
                f"{skill_block}"
                f"推进方式：{continuation}"
            )
        scouting_guidance = ""
        if stage_id == "scouting":
            scouting_guidance = (
                "公共组学数据按 Collector → Evaluator → Curator 处理：优先搜索并加载 "
                "science-public-biomedical-data；默认只登记 accession、许可、样本和文件元数据，"
                "不要把“找到元数据”写成“已获得数据”。只有公开可下载且当前任务明确允许时才使用 "
                "--download。保留 raw_record、评分理由、冲突字段和 SHA-256，并把 "
                "data/public/manifest.json 作为证据矩阵与预注册的数据入口。受控访问、DUA、"
                "登录或含个体信息的数据只登记申请路径，不得绕过授权。\n"
            )
        return (
            f"推进许愿式科研课题 {wish_id}，本次只执行 {stage_def['label']} 节点。\n"
            f"愿望：{wish['wish']}\n"
            f"节点目的：{stage_def['purpose']}\n"
            f"依赖状态：{'；'.join(dependencies) or '无'}\n"
            f"成功判据：\n{success}\n边界：\n{boundaries}\n停止条件：\n{stop}\n"
            "工作方法：先用 wish_status 和 research_list 恢复状态；按需 skill_search/skill_load 只加载必要技能；"
            "实际读取数据、运行脚本或查询数据库。把输入、代码、环境、日志、结果和图表写入项目工作区，"
            "保留失败、阴性和不支持假设的结果。不要输出未执行的伪结果。\n"
            f"{scouting_guidance}"
            f"{skill_block}"
            f"建议交付位置：{outputs}\n"
            f"完成后调用 wish_record，id={wish_id}，stage={stage_id}，artifacts 传入真实存在的相对路径，"
            "summary 写明支持什么、反对什么、仍不知道什么。不要重复登记已记录节点。"
            "如果缺少无法推断的关键条件，调用 wish_block 说明原因和所需条件，不要伪造完成。\n"
            f"推进方式：{continuation}"
        )
