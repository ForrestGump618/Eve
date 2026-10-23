"""Structured analysis results and evidence evaluation for the discovery engine.

The discovery engine used to promote a verdict/strength based on how many
statistical tokens appeared in free-form model output.  That is unsound (for
example the Chinese word "不显著" *contains* "显著") and it is now replaced by
this module:

* :class:`AnalysisResult` is the machine-readable record of one analysis:
  input/script hashes, seed, test name, effect size, confidence interval, raw
  p value, multiple-testing correction and q value, sample definition and
  exclusions, execution status, artifact references and environment.
* :class:`EvidenceEvaluator` is the only component allowed to decide
  ``supported`` / ``refuted`` / ``inconclusive``.  It reads structured numbers
  and the pre-registered criteria; narrative text is never part of the rule.

Design rules (see ``docs/CONTRACTS-3.md`` §10 T10):

1. Only a structurally complete result with ``execution_status == "completed"``
   and internally consistent numbers can yield ``supported`` or ``refuted``.
2. Anything missing, malformed or not executed is ``inconclusive``.
3. ``strength`` is derived from statistical evidence only (effect size,
   confidence interval, p/q values, sample size when provided).
4. ``reproducibility`` has two real levels: ``code_recorded`` only proves that
   code was captured; ``rerun_verified`` requires explicit re-run evidence.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass
from typing import Any

# -- public enums ----------------------------------------------------------
EXECUTION_STATUSES: tuple[str, ...] = ("completed", "failed", "not_run")
VERDICTS: tuple[str, ...] = ("supported", "refuted", "inconclusive")
STRENGTHS: tuple[str, ...] = ("strong", "moderate", "weak")
REPRODUCIBILITY_LEVELS: tuple[str, ...] = ("none", "code_recorded", "rerun_verified")

# Required keys, in contract order.  ``q_value_or_none`` may be ``None`` but the
# key itself must be present so a missing correction cannot silently look valid.
REQUIRED_FIELDS: tuple[str, ...] = (
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

_TEXT_FIELDS: tuple[str, ...] = (
    "test",
    "correction",
    "method",
    "sample_definition",
)

# Pre-registered thresholds can be given as explicit fields; when absent we
# fall back to a conservative default and (for alpha/q) to the explicit numeric
# thresholds written in the pre-registered ``success_criteria`` text.  Parsing
# *pre-registration* thresholds is legitimate; parsing *result narrative* is not.
_ALPHA_RE = re.compile(r"(?<![A-Za-z])(?:p|P)\s*(?:<|≤|<=)\s*(0?\.\d+|\d+(?:\.\d+)?)")
_Q_ALPHA_RE = re.compile(
    r"(?:fdr|q\s*(?:值)?|p\s*adj(?:usted)?|校正后(?:的)?\s*p)"
    r"[^0-9]{0,16}(?:<|≤|<=)\s*(0?\.\d+)",
    re.IGNORECASE,
)
_MIN_EFFECT_RE = re.compile(
    r"(?:效应量|effect(?:\s*size)?|\|\s*d\s*\||cohen'?s\s*d|差异)"
    r"[^0-9]{0,18}(?:≥|>=|>)\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)

_DEFAULT_ALPHA = 0.05
_STRONG_EFFECT = 0.8
_MODERATE_EFFECT = 0.2
_STRONG_MIN_SAMPLES = 30


# -- payload parsing helpers ----------------------------------------------
def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _as_float(value: Any) -> float | None:
    """Return a finite float or ``None``; booleans are never numbers here."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _as_seed(value: Any) -> int | str | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value) if float(value).is_integer() else value
    text = _as_text(value)
    return text or None


def _as_str_list(value: Any) -> list[str] | None:
    """Normalise a list-or-separated-string value into a list of strings."""
    if value is None:
        return None
    if isinstance(value, str):
        parts = re.split(r"[,;\n，；]", value)
        return [part.strip() for part in parts if part.strip()]
    if isinstance(value, (list, tuple, set)):
        items: list[str] = []
        for item in value:
            text = _as_text(item)
            if text:
                items.append(text)
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                items.append(str(item))
        return items
    return None


def _as_mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return dict(parsed) if isinstance(parsed, dict) else None
    return None


def _sha_hint(value: str) -> str:
    text = (value or "").strip()
    return f"{text[:16]}…" if len(text) > 16 else (text or "缺失")


def parse_alpha_from_criteria(criteria: str, default: float = _DEFAULT_ALPHA) -> float:
    """Extract the pre-registered p threshold from criteria text, if explicit."""
    match = _ALPHA_RE.search(criteria or "")
    if not match:
        return default
    value = _as_float(match.group(1))
    if value is None or not 0.0 < value < 1.0:
        return default
    return value


def parse_q_alpha_from_criteria(criteria: str, default: float = _DEFAULT_ALPHA) -> float:
    """Extract the pre-registered FDR/q threshold from criteria text, if explicit."""
    match = _Q_ALPHA_RE.search(criteria or "")
    if not match:
        return default
    value = _as_float(match.group(1))
    if value is None or not 0.0 < value < 1.0:
        return default
    return value


def parse_min_effect_from_criteria(criteria: str) -> float | None:
    """Extract an explicit minimum effect size from criteria text, if present."""
    match = _MIN_EFFECT_RE.search(criteria or "")
    if not match:
        return None
    value = _as_float(match.group(1))
    if value is None or value <= 0.0:
        return None
    return value


# -- structured analysis result -------------------------------------------
@dataclass
class AnalysisResult:
    """One analysed experiment, recorded as structured data.

    ``AnalysisResult`` deliberately has no free-text verdict field: the verdict
    is computed by :class:`EvidenceEvaluator` from the numbers below.
    """

    data_sha256: str
    script_sha256: str
    seed: int | str
    test: str
    effect_size: float
    ci_low: float
    ci_high: float
    p_value: float
    q_value_or_none: float | None
    correction: str
    method: str
    sample_definition: str
    exclusions: list[str]
    execution_status: str
    artifact_refs: list[str]
    environment: dict[str, Any]
    sample_size: int | None = None
    notes: str = ""

    # -- construction ------------------------------------------------------
    @classmethod
    def from_payload(
        cls, payload: Any
    ) -> tuple["AnalysisResult | None", list[str]]:
        """Build a result from a mapping; returns ``(None, errors)`` if invalid.

        Only structural/type validation happens here.  Range/consistency rules
        (for example ``0 <= p <= 1``) belong to :class:`EvidenceEvaluator` so a
        structurally complete but statistically invalid record still produces a
        specific inconclusive reason instead of disappearing.
        """
        errors: list[str] = []
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except ValueError:
                return None, ["结构化分析结果不是合法 JSON。"]
        if not isinstance(payload, dict):
            return None, ["结构化分析结果必须是 JSON 对象。"]

        data = dict(payload)
        # Friendly aliases; the canonical field names remain those in the contract.
        if "q_value_or_none" not in data and "q_value" in data:
            data["q_value_or_none"] = data.get("q_value")
        if "execution_status" not in data and "status" in data:
            data["execution_status"] = data.get("status")

        missing = [name for name in REQUIRED_FIELDS if name not in data]
        if missing:
            errors.append("缺少必需字段：" + "、".join(missing))

        hashes: dict[str, str] = {}
        for name in ("data_sha256", "script_sha256"):
            value = _as_text(data.get(name))
            if not value:
                errors.append(f"{name} 必须是非空字符串（SHA-256）。")
            hashes[name] = value

        seed = _as_seed(data.get("seed"))
        if seed is None:
            errors.append("seed 必须是整数或非空字符串。")

        texts: dict[str, str] = {}
        for name in _TEXT_FIELDS:
            value = _as_text(data.get(name))
            if not value:
                errors.append(f"{name} 必须是非空字符串。")
            texts[name] = value

        numbers: dict[str, float] = {}
        for name in ("effect_size", "ci_low", "ci_high", "p_value"):
            value = _as_float(data.get(name))
            if value is None:
                errors.append(f"{name} 必须是有限数值。")
            else:
                numbers[name] = value

        q_value: float | None = None
        raw_q = data.get("q_value_or_none")
        if raw_q is not None and not (isinstance(raw_q, str) and not raw_q.strip()):
            q_value = _as_float(raw_q)
            if q_value is None:
                errors.append("q_value_or_none 必须是有限数值或 null。")

        execution_status = _as_text(data.get("execution_status")).lower()
        if execution_status not in EXECUTION_STATUSES:
            errors.append(
                "execution_status 必须是 completed / failed / not_run 之一。"
            )

        exclusions = _as_str_list(data.get("exclusions"))
        if exclusions is None:
            errors.append("exclusions 必须是字符串数组或分隔字符串。")

        artifact_refs = _as_str_list(data.get("artifact_refs"))
        if artifact_refs is None:
            errors.append("artifact_refs 必须是字符串数组或分隔字符串。")

        environment = _as_mapping(data.get("environment"))
        if environment is None:
            errors.append("environment 必须是 JSON 对象（或对象字符串）。")

        sample_size: int | None = None
        if data.get("sample_size") is not None:
            raw_size = _as_float(data.get("sample_size"))
            if raw_size is None or raw_size < 1 or not float(raw_size).is_integer():
                errors.append("sample_size 必须是正整数。")
            else:
                sample_size = int(raw_size)

        if errors:
            # De-duplicate while preserving order (some fields fail twice).
            return None, list(dict.fromkeys(errors))

        return (
            cls(
                data_sha256=hashes["data_sha256"],
                script_sha256=hashes["script_sha256"],
                seed=seed if seed is not None else "",
                test=texts["test"],
                effect_size=numbers["effect_size"],
                ci_low=numbers["ci_low"],
                ci_high=numbers["ci_high"],
                p_value=numbers["p_value"],
                q_value_or_none=q_value,
                correction=texts["correction"],
                method=texts["method"],
                sample_definition=texts["sample_definition"],
                exclusions=exclusions or [],
                execution_status=execution_status,
                artifact_refs=artifact_refs or [],
                environment=environment or {},
                sample_size=sample_size,
                notes=_as_text(data.get("notes")),
            ),
            [],
        )

    # -- serialisation -----------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["exclusions"] = list(self.exclusions)
        payload["artifact_refs"] = list(self.artifact_refs)
        payload["environment"] = dict(self.environment)
        return payload

    @classmethod
    def from_dict(cls, payload: Any) -> "AnalysisResult | None":
        result, _ = cls.from_payload(payload)
        return result


# -- evaluator -------------------------------------------------------------
class EvidenceEvaluator:
    """Statistically grounded evidence evaluator (text is never an input)."""

    def __init__(
        self,
        default_alpha: float = _DEFAULT_ALPHA,
        default_q_alpha: float = _DEFAULT_ALPHA,
        strong_effect: float = _STRONG_EFFECT,
        moderate_effect: float = _MODERATE_EFFECT,
        strong_min_samples: int = _STRONG_MIN_SAMPLES,
    ) -> None:
        self.default_alpha = _clamp_unit(default_alpha, _DEFAULT_ALPHA)
        self.default_q_alpha = _clamp_unit(default_q_alpha, _DEFAULT_ALPHA)
        self.strong_effect = max(0.0, float(strong_effect))
        self.moderate_effect = max(0.0, float(moderate_effect))
        self.strong_min_samples = max(1, int(strong_min_samples))

    def evaluate(
        self,
        preregistration: dict[str, Any] | None,
        result: AnalysisResult | None,
        run_info: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return ``{verdict, strength, reproducibility, reasons}``.

        ``reasons`` is a human-readable audit trail in Chinese; it never feeds
        back into the decision.
        """
        prereg = dict(preregistration or {})
        info = dict(run_info or {})
        reasons: list[str] = []
        reproducibility = self._reproducibility(result, info)

        if result is None:
            reasons.append(
                "未提供结构化分析结果（AnalysisResult）；文本叙述（包括“显著/不显著/p=0.8/FDR”等）不参与证据判定。"
            )
            reasons.extend(self._payload_errors(info))
            reasons.append("判定 inconclusive：证据不足，无法按预注册判据做数值核对。")
            return {
                "verdict": "inconclusive",
                "strength": "weak",
                "reproducibility": reproducibility,
                "reasons": reasons,
            }

        reasons.append(
            f"结构化结果：检验={result.test}，方法={result.method}，执行状态={result.execution_status}。"
        )
        if result.execution_status != "completed":
            reasons.append(
                f"执行状态为 {result.execution_status}：未成功完成的分析不能支持或反驳假设。"
            )
            reasons.append("判定 inconclusive：执行未完成，数值不作为证据。")
            return {
                "verdict": "inconclusive",
                "strength": "weak",
                "reproducibility": reproducibility,
                "reasons": reasons,
            }

        invalid = self._validate_numbers(result)
        if invalid:
            reasons.extend(f"数值字段不合法：{item}" for item in invalid)
            reasons.append("判定 inconclusive：结构化结果不满足数值一致性要求。")
            return {
                "verdict": "inconclusive",
                "strength": "weak",
                "reproducibility": reproducibility,
                "reasons": reasons,
            }

        criteria = _as_text(prereg.get("success_criteria"))
        alpha = self._alpha(prereg, criteria)
        q_alpha = self._q_alpha(prereg, criteria)
        min_effect = self._min_effect(prereg, criteria)
        expected_direction = self._direction(prereg)

        p_value = float(result.p_value)
        q_value = result.q_value_or_none
        effect = float(result.effect_size)
        ci_low, ci_high = float(result.ci_low), float(result.ci_high)

        significant = p_value < alpha and (q_value is None or float(q_value) < q_alpha)
        ci_excludes_zero = ci_low > 0.0 or ci_high < 0.0
        ci_excludes_min_effect = self._ci_excludes_min_effect(
            ci_low, ci_high, effect, min_effect, expected_direction
        )
        direction = 1 if effect > 0 else (-1 if effect < 0 else 0)
        direction_ok = expected_direction == "two-sided" or direction == expected_direction

        reasons.append(
            f"统计量：effect_size={effect:.4g}，CI=[{ci_low:.4g}, {ci_high:.4g}]，"
            f"p={p_value:.4g}，q={('null' if q_value is None else f'{float(q_value):.4g}')}，"
            f"校正={result.correction or '未报告'}。"
        )
        reasons.append(
            f"预注册判据：{criteria or '（未提供）'}；阈值 α={alpha:g}"
            + (f"，q<{q_alpha:g}" if q_value is not None else "")
            + (f"，最小效应={min_effect:g}" if min_effect is not None else "")
            + f"，方向={expected_direction}。"
        )

        verdict = "inconclusive"
        if significant and direction_ok and ci_excludes_zero:
            verdict = "supported"
            reasons.append(
                "p（及 q）达到预注册阈值、效应方向符合预期且置信区间不含 0：判定 supported。"
            )
        elif significant and not direction_ok and ci_excludes_zero:
            verdict = "refuted"
            reasons.append(
                "统计显著但效应方向与预注册预期相反：判定 refuted。"
            )
        elif (not significant) and min_effect is not None and ci_excludes_min_effect:
            verdict = "refuted"
            reasons.append(
                f"置信区间排除预注册最小效应 {min_effect:g}（且未达显著性阈值）：判定 refuted。"
            )
        elif significant and not ci_excludes_zero:
            reasons.append(
                "p 值显著但置信区间包含 0（数值不一致），不提升为 supported/refuted。"
            )
        else:
            reasons.append(
                "未达到预注册显著性阈值，且没有足够窄的置信区间排除预注册最小效应。"
            )

        strength = self._strength(verdict, result)
        reasons.append(f"证据强度={strength}（仅由效应量/CI/样本量等统计证据决定）。")
        reasons.append(f"可复现性={reproducibility}（code_recorded 仅代表代码留痕）。")
        reasons.append(f"判定 {verdict}。")
        return {
            "verdict": verdict,
            "strength": strength,
            "reproducibility": reproducibility,
            "reasons": reasons,
        }

    # -- internal helpers --------------------------------------------------
    @staticmethod
    def _payload_errors(info: dict[str, Any]) -> list[str]:
        raw = info.get("analysis_errors") or []
        if isinstance(raw, str):
            raw = [raw]
        errors = [str(item) for item in raw if str(item).strip()]
        if not errors:
            return []
        return ["结构化结果解析错误：" + "；".join(errors)]

    def _alpha(self, prereg: dict[str, Any], criteria: str) -> float:
        explicit = _as_float(prereg.get("alpha"))
        if explicit is not None and 0.0 < explicit < 1.0:
            return explicit
        return parse_alpha_from_criteria(criteria, self.default_alpha)

    def _q_alpha(self, prereg: dict[str, Any], criteria: str) -> float:
        for key in ("q_alpha", "fdr_alpha", "q_threshold"):
            explicit = _as_float(prereg.get(key))
            if explicit is not None and 0.0 < explicit < 1.0:
                return explicit
        return parse_q_alpha_from_criteria(criteria, self.default_q_alpha)

    def _min_effect(self, prereg: dict[str, Any], criteria: str) -> float | None:
        for key in ("min_effect_size", "min_abs_effect_size", "effect_threshold"):
            explicit = _as_float(prereg.get(key))
            if explicit is not None and explicit > 0.0:
                return explicit
        return parse_min_effect_from_criteria(criteria)

    @staticmethod
    def _direction(prereg: dict[str, Any]) -> int | str:
        raw = _as_text(prereg.get("expected_direction") or prereg.get("direction")).lower()
        if raw in {"positive", "increase", "up", "正向", "正相关", "+"}:
            return 1
        if raw in {"negative", "decrease", "down", "负向", "负相关", "-"}:
            return -1
        return "two-sided"

    @staticmethod
    def _ci_excludes_min_effect(
        ci_low: float,
        ci_high: float,
        effect: float,
        min_effect: float | None,
        expected_direction: Any,
    ) -> bool:
        """True when the CI rules out an effect at least as large as expected."""
        if min_effect is None or min_effect <= 0.0:
            return False
        threshold = float(min_effect)
        if expected_direction == 1:
            return ci_high < threshold
        if expected_direction == -1:
            return ci_low > -threshold
        # Two-sided: the whole interval must sit inside (-threshold, threshold).
        return ci_low > -threshold and ci_high < threshold

    @staticmethod
    def _validate_numbers(result: AnalysisResult) -> list[str]:
        problems: list[str] = []
        for name, value in (
            ("effect_size", result.effect_size),
            ("ci_low", result.ci_low),
            ("ci_high", result.ci_high),
            ("p_value", result.p_value),
        ):
            if not math.isfinite(float(value)):
                problems.append(f"{name} 不是有限数值")
        if not 0.0 <= float(result.p_value) <= 1.0:
            problems.append(f"p_value={result.p_value!r} 超出 [0, 1]")
        if result.q_value_or_none is not None:
            q_value = float(result.q_value_or_none)
            if not math.isfinite(q_value) or not 0.0 <= q_value <= 1.0:
                problems.append(f"q_value_or_none={result.q_value_or_none!r} 超出 [0, 1]")
        if not float(result.ci_low) <= float(result.ci_high):
            problems.append("ci_low 大于 ci_high")
        if not float(result.ci_low) <= float(result.effect_size) <= float(result.ci_high):
            problems.append("effect_size 不在置信区间 [ci_low, ci_high] 内")
        if not result.test.strip():
            problems.append("test 为空")
        if not result.method.strip():
            problems.append("method 为空")
        if not result.data_sha256.strip() or not result.script_sha256.strip():
            problems.append("data_sha256 / script_sha256 缺失")
        if result.sample_size is not None and int(result.sample_size) < 1:
            problems.append("sample_size 小于 1")
        return problems

    def _strength(self, verdict: str, result: AnalysisResult) -> str:
        if verdict not in {"supported", "refuted"}:
            return "weak"
        effect = abs(float(result.effect_size))
        ci_width = max(0.0, float(result.ci_high) - float(result.ci_low))
        if verdict == "supported":
            enough_samples = result.sample_size is None or int(result.sample_size) >= self.strong_min_samples
            if effect >= self.strong_effect and enough_samples:
                return "strong"
            if effect >= self.moderate_effect:
                return "moderate"
            return "weak"
        # Refuted: narrow intervals are stronger evidence of absence than wide ones.
        if ci_width <= 0.4:
            return "strong"
        if ci_width <= 1.0:
            return "moderate"
        return "weak"

    @staticmethod
    def _reproducibility(
        result: AnalysisResult | None, info: dict[str, Any]
    ) -> str:
        """Derive the reproducibility level from explicit run metadata only."""
        rerun = info.get("rerun_verified")
        completed = result is not None and result.execution_status == "completed"
        if completed:
            if rerun is True:
                return "rerun_verified"
            if isinstance(rerun, dict):
                verified = bool(rerun.get("verified") or rerun.get("ok"))
                hashes_ok = True
                for key in ("data_sha256", "script_sha256"):
                    expected = _as_text(rerun.get(key))
                    if expected and expected.lower() != _as_text(getattr(result, key, "")).lower():
                        hashes_ok = False
                        break
                if verified and hashes_ok:
                    return "rerun_verified"
        code = _as_text(info.get("code"))
        script_sha = _as_text(info.get("script_sha256"))
        if code or script_sha or (result is not None and _as_text(result.script_sha256)):
            return "code_recorded"
        return "none"


def _clamp_unit(value: Any, default: float) -> float:
    number = _as_float(value)
    if number is None or not 0.0 < number < 1.0:
        return default
    return number


__all__ = [
    "AnalysisResult",
    "EXECUTION_STATUSES",
    "EvidenceEvaluator",
    "REPRODUCIBILITY_LEVELS",
    "REQUIRED_FIELDS",
    "STRENGTHS",
    "VERDICTS",
    "parse_alpha_from_criteria",
    "parse_min_effect_from_criteria",
    "parse_q_alpha_from_criteria",
]
