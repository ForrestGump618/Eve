"""Tests for structured analysis results and the T10 evidence evaluator.

The acceptance rule under test: free-form text such as "不显著", "p=0.8" or
"FDR" must never raise (or lower) the evidence level; only a structurally
complete :class:`AnalysisResult` with a completed execution can yield
``supported`` / ``refuted``.
"""

from __future__ import annotations

import json

import pytest

from omicslab.discovery.evidence import (
    EXECUTION_STATUSES,
    REQUIRED_FIELDS,
    AnalysisResult,
    EvidenceEvaluator,
    parse_alpha_from_criteria,
    parse_min_effect_from_criteria,
    parse_q_alpha_from_criteria,
)


def payload(**overrides) -> dict:
    """Build a structurally valid analysis result payload."""
    data = {
        "data_sha256": "a" * 64,
        "script_sha256": "b" * 64,
        "seed": 42,
        "test": "Welch t-test",
        "effect_size": 0.9,
        "ci_low": 0.5,
        "ci_high": 1.3,
        "p_value": 0.001,
        "q_value_or_none": 0.004,
        "correction": "BH-FDR",
        "method": "two-sided",
        "sample_definition": "两组各 20 个样本",
        "exclusions": ["排除缺失值样本"],
        "execution_status": "completed",
        "artifact_refs": ["results/table.csv"],
        "environment": {"python": "3.11.9", "numpy": "2.1.0"},
        "sample_size": 40,
    }
    data.update(overrides)
    return data


PREREG = {
    "success_criteria": "校正后 p < 0.1 且 CI 不含 0",
    "expected_direction": "two-sided",
}


def evaluate(result_payload: dict | None, prereg: dict | None = None, run_info: dict | None = None) -> dict:
    result, errors = (None, [])
    if result_payload is not None:
        result, errors = AnalysisResult.from_payload(result_payload)
    info = dict(run_info or {})
    if errors:
        info["analysis_errors"] = [*info.get("analysis_errors", []), *errors]
    return EvidenceEvaluator().evaluate(prereg or PREREG, result, info)


# -- from_payload ----------------------------------------------------------
def test_valid_payload_roundtrip() -> None:
    result, errors = AnalysisResult.from_payload(payload())
    assert errors == []
    assert isinstance(result, AnalysisResult)
    assert result.test == "Welch t-test"
    assert result.q_value_or_none == pytest.approx(0.004)
    assert result.sample_size == 40
    dumped = result.to_dict()
    for name in REQUIRED_FIELDS:
        assert name in dumped
    assert dumped["exclusions"] == ["排除缺失值样本"]


def test_payload_requires_every_contract_field() -> None:
    broken = payload()
    for name in ("data_sha256", "script_sha256", "test", "method", "execution_status"):
        broken.pop(name)
    result, errors = AnalysisResult.from_payload(broken)
    assert result is None
    joined = "；".join(errors)
    for name in ("data_sha256", "script_sha256", "test", "method", "execution_status"):
        assert name in joined


def test_payload_accepts_json_string_and_q_value_alias() -> None:
    raw = payload()
    raw.pop("q_value_or_none")
    raw["q_value"] = 0.02
    result, errors = AnalysisResult.from_payload(json.dumps(raw))
    assert errors == [] and result is not None
    assert result.q_value_or_none == pytest.approx(0.02)


def test_payload_rejects_unknown_execution_status() -> None:
    result, errors = AnalysisResult.from_payload(payload(execution_status="maybe"))
    assert result is None
    assert any("execution_status" in item for item in errors)
    assert EXECUTION_STATUSES == ("completed", "failed", "not_run")


@pytest.mark.parametrize(
    "field,value",
    [
        ("effect_size", "not-a-number"),
        ("ci_low", None),
        ("exclusions", 12),
        ("environment", "not json"),
    ],
)
def test_payload_structural_errors(field: str, value) -> None:
    result, errors = AnalysisResult.from_payload(payload(**{field: value}))
    assert result is None and errors


# -- text never decides ----------------------------------------------------
def test_text_only_narrative_is_inconclusive() -> None:
    evaluated = evaluate(
        None,
        run_info={
            "final_text": "结果不显著，p=0.8，FDR 校正后显著，significant，支持假设。",
            "analysis_errors": ["未提交结构化结果"],
        },
    )
    assert evaluated["verdict"] == "inconclusive"
    assert evaluated["strength"] == "weak"
    assert evaluated["reproducibility"] == "none"
    assert any("文本叙述" in item for item in evaluated["reasons"])


def test_text_cannot_upgrade_non_significant_numbers() -> None:
    weak = payload(effect_size=0.05, ci_low=-0.2, ci_high=0.3, p_value=0.8, q_value_or_none=0.9)
    evaluated = evaluate(
        weak,
        run_info={
            "final_text": "显著！p=0.001，支持假设，effect size 0.9，FDR 显著。",
            "code": "print('p=0.8')",
        },
    )
    assert evaluated["verdict"] == "inconclusive"
    assert evaluated["strength"] == "weak"


def test_narrative_cannot_override_structured_support() -> None:
    evaluated = evaluate(
        payload(),
        run_info={"final_text": "结果不显著，p=0.8，证据不足，不能支持该假设。"},
    )
    assert evaluated["verdict"] == "supported"


# -- verdict rules ---------------------------------------------------------
def test_significant_completed_result_is_supported_and_strong() -> None:
    evaluated = evaluate(payload())
    assert evaluated["verdict"] == "supported"
    assert evaluated["strength"] == "strong"
    assert evaluated["reproducibility"] == "code_recorded"
    assert set(evaluated) == {"verdict", "strength", "reproducibility", "reasons"}


def test_opposite_direction_is_refuted() -> None:
    evaluated = evaluate(
        payload(effect_size=-0.9, ci_low=-1.3, ci_high=-0.5),
        prereg={**PREREG, "expected_direction": "positive"},
    )
    assert evaluated["verdict"] == "refuted"
    assert evaluated["strength"] == "moderate"


def test_ci_excluding_preregistered_min_effect_is_refuted() -> None:
    evaluated = evaluate(
        payload(effect_size=0.05, ci_low=-0.4, ci_high=0.1, p_value=0.8, q_value_or_none=0.9),
        prereg={"success_criteria": "p < 0.1", "expected_direction": "two-sided", "min_effect_size": 0.5},
    )
    assert evaluated["verdict"] == "refuted"


def test_non_significant_result_without_evidence_is_inconclusive() -> None:
    evaluated = evaluate(
        payload(effect_size=0.05, ci_low=-0.2, ci_high=0.3, p_value=0.8, q_value_or_none=0.9)
    )
    assert evaluated["verdict"] == "inconclusive"


# -- invalid / failed executions ------------------------------------------
def test_failed_execution_is_inconclusive() -> None:
    evaluated = evaluate(payload(execution_status="failed"))
    assert evaluated["verdict"] == "inconclusive"
    assert evaluated["strength"] == "weak"
    assert any("执行状态" in item for item in evaluated["reasons"])


def test_not_run_execution_is_inconclusive() -> None:
    evaluated = evaluate(payload(execution_status="not_run"))
    assert evaluated["verdict"] == "inconclusive"


@pytest.mark.parametrize(
    "overrides",
    [
        {"p_value": 1.5},
        {"q_value_or_none": 1.2},
        {"ci_low": 1.0, "ci_high": 0.2},
        {"effect_size": 2.0, "ci_low": 0.5, "ci_high": 1.3},
    ],
)
def test_inconsistent_numbers_are_inconclusive(overrides: dict) -> None:
    evaluated = evaluate(payload(**overrides))
    assert evaluated["verdict"] == "inconclusive"


def test_missing_hashes_never_reach_supported() -> None:
    evaluated = evaluate(payload(data_sha256="", script_sha256="   "))
    assert evaluated["verdict"] == "inconclusive"
    assert evaluated["strength"] == "weak"


# -- thresholds ------------------------------------------------------------
def test_alpha_is_read_from_preregistered_criteria() -> None:
    assert parse_alpha_from_criteria("校正后 p < 0.1 且 CI 不含 0") == pytest.approx(0.1)
    supported = evaluate(payload(p_value=0.08, q_value_or_none=0.02))
    assert supported["verdict"] == "supported"
    stricter = evaluate(
        payload(p_value=0.08, q_value_or_none=0.02),
        prereg={"success_criteria": "p < 0.05", "expected_direction": "two-sided"},
    )
    assert stricter["verdict"] == "inconclusive"


def test_q_threshold_blocks_support() -> None:
    evaluated = evaluate(payload(p_value=0.01, q_value_or_none=0.2))
    assert evaluated["verdict"] == "inconclusive"


def test_preregistered_helpers() -> None:
    assert parse_q_alpha_from_criteria("FDR < 0.1 且 p < 0.05") == pytest.approx(0.1)
    assert parse_q_alpha_from_criteria("p < 0.05") == pytest.approx(0.05)
    assert parse_min_effect_from_criteria("效应量 |d| ≥ 0.5") == pytest.approx(0.5)
    assert parse_min_effect_from_criteria("p < 0.05") is None


# -- reproducibility / strength -------------------------------------------
def test_reproducibility_levels() -> None:
    evaluator = EvidenceEvaluator()
    completed, _ = AnalysisResult.from_payload(payload())
    assert completed is not None

    assert evaluator.evaluate(PREREG, None, {})["reproducibility"] == "none"
    assert evaluator.evaluate(PREREG, completed, {})["reproducibility"] == "code_recorded"
    assert (
        evaluator.evaluate(PREREG, completed, {"rerun_verified": True})["reproducibility"]
        == "rerun_verified"
    )
    matching = {
        "verified": True,
        "data_sha256": "a" * 64,
        "script_sha256": "b" * 64,
    }
    assert (
        evaluator.evaluate(PREREG, completed, {"rerun_verified": matching})["reproducibility"]
        == "rerun_verified"
    )
    mismatching = {"verified": True, "data_sha256": "c" * 64}
    assert (
        evaluator.evaluate(PREREG, completed, {"code": "x=1", "rerun_verified": mismatching})[
            "reproducibility"
        ]
        == "code_recorded"
    )


def test_strength_is_driven_by_statistics_only() -> None:
    moderate, _ = AnalysisResult.from_payload(
        payload(effect_size=0.5, ci_low=0.2, ci_high=0.8, p_value=0.01, sample_size=None)
    )
    assert EvidenceEvaluator().evaluate(PREREG, moderate, {})["strength"] == "moderate"

    weak, _ = AnalysisResult.from_payload(
        payload(effect_size=0.1, ci_low=0.05, ci_high=0.15, p_value=0.001, sample_size=None)
    )
    assert EvidenceEvaluator().evaluate(PREREG, weak, {})["strength"] == "weak"
