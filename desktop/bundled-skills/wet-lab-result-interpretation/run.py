#!/usr/bin/env python3
"""Deterministic wet-lab calculations with explicit evidence boundaries."""
from __future__ import annotations

import json
import math
import statistics
import sys
from typing import Any


SCHEMA_VERSION = "1.0"
MAX_INPUT_CHARS = 2_000_000
MISSING_CT = {"", "na", "n/a", "none", "undetermined", "not determined"}


def _fail(message: str) -> None:
    raise ValueError(message)


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(f"{label} must be finite")
    return result


def _values(value: Any, label: str, *, allow_missing: bool = False) -> list[float]:
    if not isinstance(value, list) or not value:
        _fail(f"{label} must be a nonempty array")
    result: list[float] = []
    for index, item in enumerate(value):
        if allow_missing and (item is None or (isinstance(item, str) and item.strip().lower() in MISSING_CT)):
            continue
        result.append(_number(item, f"{label}[{index}]"))
    if not result:
        _fail(f"{label} has no usable finite values")
    return result


def _mean(values: list[float]) -> float:
    return statistics.fmean(values)


def _sd(values: list[float]) -> float | None:
    return statistics.stdev(values) if len(values) > 1 else None


def _cv(values: list[float]) -> float | None:
    sd = _sd(values)
    mean = _mean(values)
    return abs(sd / mean) * 100 if sd is not None and mean != 0 else None


def _round(value: Any, digits: int = 8) -> Any:
    if isinstance(value, float):
        return round(value, digits)
    return value


def _sample_rows(raw: Any, group: str) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        _fail(f"groups.{group} must be a nonempty array")
    if all(not isinstance(item, dict) for item in raw):
        return [{"sample_id": f"{group}-1", "values": raw, "implicit_single_sample": True}]
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            _fail(f"groups.{group}[{index}] must be an object when any row is an object")
        raw_sample_id = item.get("sample_id")
        if raw_sample_id is None:
            sample_id = f"{group}-{index + 1}"
        elif not isinstance(raw_sample_id, str) or not raw_sample_id.strip():
            _fail(f"groups.{group}[{index}].sample_id must be a nonempty string")
        else:
            sample_id = raw_sample_id.strip()
        if sample_id in seen:
            _fail(f"groups.{group} has a duplicate sample_id")
        seen.add(sample_id)
        rows.append({**item, "sample_id": sample_id})
    return rows


def _groups(raw: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(raw, dict) or not raw:
        _fail("groups must be a nonempty object")
    result: dict[str, list[dict[str, Any]]] = {}
    for name, rows in raw.items():
        if not isinstance(name, str) or not name.strip():
            _fail("group names must be nonempty strings")
        result[name] = _sample_rows(rows, name)
    return result


def _require_control(groups: dict[str, Any], control: Any) -> str:
    if not isinstance(control, str) or control not in groups:
        _fail("control must name an existing group")
    return control


def _threshold(value: Any, label: str) -> float | None:
    if value is None:
        return None
    result = _number(value, label)
    if result < 0:
        _fail(f"{label} must be nonnegative")
    return result


def _technical_qc(cv: float | None, threshold: float | None, *, threshold_name: str) -> dict[str, Any]:
    if threshold is None:
        return {"status": "not_assessed", "reason": f"{threshold_name} not provided"}
    if cv is None:
        return {
            "status": "not_assessed",
            "reason": "at least two technical replicates are required to assess precision",
            threshold_name: threshold,
        }
    return {
        "status": "failed" if cv > threshold else "passed",
        threshold_name: threshold,
        "technical_cv_percent": _round(cv),
    }


def _measurements(row: dict[str, Any], label: str) -> list[float]:
    value = row.get("replicates", row.get("signal"))
    return _values(value if isinstance(value, list) else [value], label)


def _ct_values(value: Any, label: str) -> list[float]:
    values = _values(value, label, allow_missing=True)
    if any(item <= 0 for item in values):
        _fail(f"{label} Ct values must be positive")
    return values


def _summaries(samples: list[dict[str, Any]], value_key: str = "value") -> dict[str, Any]:
    vals = [float(item[value_key]) for item in samples]
    return {
        "biological_n": len(vals),
        "mean": _round(_mean(vals)),
        "sd": _round(_sd(vals)),
        "cv_percent": _round(_cv(vals)),
        "values": [_round(value) for value in vals],
    }


def _replicate_warning(group: str, n: int) -> list[str]:
    return [f"group {group} has {n} biological sample(s); inferential replication is not established"] if n < 2 else []


def _group_qc(samples: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = [item.get("qc", {}).get("status", "not_assessed") for item in samples]
    status = "failed" if "failed" in statuses else "not_assessed" if "not_assessed" in statuses else "passed"
    return {
        "status": status,
        "failed_samples": [item["sample_id"] for item, item_status in zip(samples, statuses) if item_status == "failed"],
        "not_assessed_samples": [item["sample_id"] for item, item_status in zip(samples, statuses) if item_status == "not_assessed"],
    }


def _cell_viability(data: dict[str, Any]) -> dict[str, Any]:
    groups = _groups(data.get("groups"))
    control = _require_control(groups, data.get("control"))
    threshold = _threshold(data.get("cv_limit_percent"), "cv_limit_percent")
    warnings: list[str] = []
    computed: dict[str, Any] = {}
    sample_means: dict[str, list[float]] = {}

    for group, rows in groups.items():
        samples: list[dict[str, Any]] = []
        for row in rows:
            values = _values(row.get("values"), f"groups.{group}.{row['sample_id']}.values")
            mean = _mean(values)
            cv = _cv(values)
            if row.get("implicit_single_sample"):
                warnings.append(f"group {group} was given as a flat array; treated as one biological sample")
            sample_qc = _technical_qc(cv, threshold, threshold_name="threshold_percent")
            samples.append({"sample_id": row["sample_id"], "technical_n": len(values), "technical_mean": _round(mean),
                            "technical_sd": _round(_sd(values)), "technical_cv_percent": _round(cv),
                            "value": mean, "qc": sample_qc})
        sample_means[group] = [item["value"] for item in samples]
        computed[group] = {"samples": samples}
        warnings.extend(_replicate_warning(group, len(samples)))
        computed[group]["qc"] = _group_qc(samples)
        if threshold is not None:
            computed[group]["qc"]["threshold_percent"] = threshold
        else:
            computed[group]["qc"]["reason"] = "cv_limit_percent not provided"

    control_mean = _mean(sample_means[control])
    if control_mean == 0:
        _fail("control mean is zero; relative viability is undefined")
    for group, samples in computed.items():
        for item in samples["samples"]:
            item["relative_to_control_percent"] = _round(item["value"] / control_mean * 100)
        samples["summary"] = _summaries(samples["samples"], "relative_to_control_percent")
        samples["control_mean_raw"] = _round(control_mean)

    return {"assay": "cell_viability", "control": control, "groups": computed,
            "warnings": warnings, "evidence_boundary": "Relative viability is descriptive; it does not by itself establish proliferation, death, or a mechanism."}


def _qpcr(data: dict[str, Any]) -> dict[str, Any]:
    groups = _groups(data.get("groups"))
    control = _require_control(groups, data.get("control"))
    efficiency = _number(data.get("efficiency", 2.0), "efficiency")
    if efficiency <= 0 or efficiency > 10:
        _fail("efficiency must be a positive base no greater than 10")
    warning = ["efficiency not supplied; 2.0 was assumed"] if "efficiency" not in data else []
    sd_limit = _threshold(data.get("technical_sd_limit_ct"), "technical_sd_limit_ct")
    computed: dict[str, Any] = {}
    control_dct: list[float] = []

    for group, rows in groups.items():
        samples: list[dict[str, Any]] = []
        for row in rows:
            target = _ct_values(row.get("target_ct"), f"groups.{group}.{row['sample_id']}.target_ct")
            reference = _ct_values(row.get("reference_ct"), f"groups.{group}.{row['sample_id']}.reference_ct")
            target_mean, reference_mean = _mean(target), _mean(reference)
            dct = target_mean - reference_mean
            target_sd, reference_sd = _sd(target), _sd(reference)
            qc = _technical_qc(
                max((value for value in (target_sd, reference_sd) if value is not None), default=None),
                sd_limit,
                threshold_name="threshold_ct",
            )
            if sd_limit is not None:
                qc["target_technical_sd"] = _round(target_sd)
                qc["reference_technical_sd"] = _round(reference_sd)
            omitted = sum(1 for key in ("target_ct", "reference_ct") if isinstance(row.get(key), list)
                          and len(row[key]) != len(_values(row[key], key, allow_missing=True)))
            if omitted:
                warning.append(f"{group}/{row['sample_id']} contains missing Ct values; they were excluded without imputation")
            if isinstance(row.get("target_ct"), list) and isinstance(row.get("reference_ct"), list):
                if len(row["target_ct"]) != len(row["reference_ct"]):
                    warning.append(
                        f"{group}/{row['sample_id']} has different target/reference technical replicate counts"
                    )
            samples.append({"sample_id": row["sample_id"], "target_ct_mean": _round(target_mean), "reference_ct_mean": _round(reference_mean),
                            "target_technical_n": len(target), "reference_technical_n": len(reference), "delta_ct": _round(dct), "qc": qc})
            if group == control:
                control_dct.append(dct)
        computed[group] = {"samples": samples}
        warning.extend(_replicate_warning(group, len(samples)))
        computed[group]["qc"] = _group_qc(samples)

    control_mean_dct = _mean(control_dct)
    for group, samples in computed.items():
        for item in samples["samples"]:
            ddct = item["delta_ct"] - control_mean_dct
            item["delta_delta_ct"] = _round(ddct)
            item["relative_expression"] = _round(efficiency ** (-ddct))
        samples["summary"] = _summaries(samples["samples"], "relative_expression")
        samples["summary"]["mean_delta_ct"] = _round(_mean([item["delta_ct"] for item in samples["samples"]]))
    return {"assay": "qpcr_ddct", "control": control, "target_gene": data.get("target_gene"),
            "reference_gene": data.get("reference_gene"), "efficiency": efficiency,
            "groups": computed, "warnings": warning,
            "evidence_boundary": "Delta-delta Ct assumes a validated efficiency model and independent biological samples; it is not a test of significance."}


def _western(data: dict[str, Any]) -> dict[str, Any]:
    groups = _groups(data.get("groups"))
    control = _require_control(groups, data.get("control"))
    threshold = _threshold(data.get("cv_limit_percent"), "cv_limit_percent")
    computed: dict[str, Any] = {}
    control_ratios: list[float] = []
    warnings: list[str] = []

    for group, rows in groups.items():
        samples: list[dict[str, Any]] = []
        for row in rows:
            target = _values(row.get("target"), f"groups.{group}.{row['sample_id']}.target")
            loading = _values(row.get("loading"), f"groups.{group}.{row['sample_id']}.loading")
            if len(target) != len(loading):
                _fail(f"groups.{group}.{row['sample_id']}: target and loading must have the same replicate count")
            ratios = []
            for target_signal, loading_signal in zip(target, loading):
                if loading_signal == 0:
                    _fail(f"groups.{group}.{row['sample_id']}: loading signal cannot be zero")
                ratios.append(target_signal / loading_signal)
            cv = _cv(ratios)
            qc = _technical_qc(cv, threshold, threshold_name="threshold_percent")
            samples.append({"sample_id": row["sample_id"], "technical_n": len(ratios), "target_loading_ratio": _round(_mean(ratios)),
                            "technical_sd": _round(_sd(ratios)), "technical_cv_percent": _round(cv), "qc": qc})
            if group == control:
                control_ratios.append(_mean(ratios))
        computed[group] = {"samples": samples}
        warnings.extend(_replicate_warning(group, len(samples)))
        computed[group]["qc"] = _group_qc(samples)

    control_mean = _mean(control_ratios)
    if control_mean == 0:
        _fail("control target/loading mean is zero; normalization is undefined")
    for group, samples in computed.items():
        for item in samples["samples"]:
            item["relative_to_control"] = _round(item["target_loading_ratio"] / control_mean)
        samples["summary"] = _summaries(samples["samples"], "relative_to_control")
        samples["control_mean_ratio"] = _round(control_mean)
    return {"assay": "western_blot", "control": control, "groups": computed, "warnings": warnings,
            "evidence_boundary": "Normalized band ratios require unsaturated, traceable images and independent biological samples; they are not absolute protein quantities."}


def _linear_fit(xs: list[float], ys: list[float]) -> tuple[float, float, float | None, float | None]:
    if len(set(xs)) < 2:
        _fail("standards must contain at least two distinct concentrations")
    mean_x, mean_y = _mean(xs), _mean(ys)
    sxx = sum((x - mean_x) ** 2 for x in xs)
    if sxx == 0:
        _fail("standard concentrations have zero variance")
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / sxx
    intercept = mean_y - slope * mean_x
    if slope == 0:
        _fail("standard curve slope is zero")
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    r2 = None if ss_tot == 0 else 1 - ss_res / ss_tot
    residual_sd = None if len(xs) <= 2 else math.sqrt(ss_res / (len(xs) - 2))
    return slope, intercept, r2, residual_sd


def _elisa(data: dict[str, Any]) -> dict[str, Any]:
    standards = data.get("standards")
    samples = data.get("samples")
    if not isinstance(standards, list) or len(standards) < 2:
        _fail("standards must contain at least two concentrations")
    if not isinstance(samples, list) or not samples:
        _fail("samples must be a nonempty array")
    model = data.get("model", "linear")
    if model not in {"linear", "log_linear"}:
        _fail("model must be linear or log_linear")
    blank_subtract = data.get("blank_subtract", False)
    if not isinstance(blank_subtract, bool):
        _fail("blank_subtract must be boolean")
    standard_rows: list[dict[str, Any]] = []
    standard_concentrations: set[float] = set()
    for index, row in enumerate(standards):
        if not isinstance(row, dict):
            _fail(f"standards[{index}] must be an object")
        concentration = _number(row.get("concentration"), f"standards[{index}].concentration")
        if concentration < 0:
            _fail(f"standards[{index}].concentration must be nonnegative")
        if concentration in standard_concentrations:
            _fail(f"standards[{index}].concentration is duplicated")
        standard_concentrations.add(concentration)
        signal = _measurements(row, f"standards[{index}].signal")
        standard_rows.append({"concentration": concentration, "signal": _mean(signal), "replicates": signal})
    blank = next((row["signal"] for row in standard_rows if row["concentration"] == 0), None)
    if blank_subtract and blank is None:
        _fail("blank_subtract requires a zero-concentration standard")
    xs: list[float] = []
    ys: list[float] = []
    for row in standard_rows:
        concentration = row["concentration"]
        signal = row["signal"] - blank if blank_subtract else row["signal"]
        if model == "log_linear":
            if concentration <= 0:
                continue
            xs.append(math.log(concentration))
        else:
            xs.append(concentration)
        ys.append(signal)
    if len(xs) < 2:
        _fail("the selected model has fewer than two usable standards")
    slope, intercept, r2, residual_sd = _linear_fit(xs, ys)
    min_x, max_x = min(xs), max(xs)
    result_samples: list[dict[str, Any]] = []
    warnings: list[str] = []
    min_r2 = _threshold(data.get("r2_min"), "r2_min")
    if min_r2 is not None and min_r2 > 1:
        _fail("r2_min must be no greater than 1")
    seen_samples: set[str] = set()
    for index, row in enumerate(samples):
        if not isinstance(row, dict):
            _fail(f"samples[{index}] must be an object")
        raw_sample_id = row.get("sample_id")
        if raw_sample_id is None:
            sample_id = f"sample-{index + 1}"
        elif not isinstance(raw_sample_id, str) or not raw_sample_id.strip():
            _fail(f"samples[{index}].sample_id must be a nonempty string")
        else:
            sample_id = raw_sample_id.strip()
        if sample_id in seen_samples:
            _fail(f"samples[{index}].sample_id is duplicated")
        seen_samples.add(sample_id)
        signal = _measurements(row, f"samples[{index}].signal")
        mean_signal = _mean(signal) - (blank if blank_subtract else 0.0)
        x_value = (mean_signal - intercept) / slope
        out_of_range = x_value < min_x or x_value > max_x
        concentration = math.exp(x_value) if model == "log_linear" else x_value
        dilution = _number(row.get("dilution_factor", 1.0), f"samples[{index}].dilution_factor")
        if dilution <= 0:
            _fail(f"samples[{index}].dilution_factor must be positive")
        result_samples.append({"sample_id": sample_id, "signal_mean": _round(mean_signal),
                               "concentration": None if out_of_range else _round(concentration),
                               "dilution_factor": dilution,
                               "reported_concentration": None if out_of_range else _round(concentration * dilution),
                               "in_standard_range": not out_of_range})
        if out_of_range:
            warnings.append(f"{sample_id} is outside the standard range; no extrapolated result should be reported")
    if min_r2 is None:
        qc = {"status": "not_assessed", "reason": "r2_min not provided"}
    elif len(xs) < 3:
        qc = {"status": "not_assessed", "reason": "at least three usable standards are required to assess R squared", "r2_min": min_r2}
    elif r2 is None:
        qc = {"status": "not_assessed", "reason": "R squared is undefined because the standard signals have no variance", "r2_min": min_r2}
    else:
        qc = {"status": "failed" if r2 < min_r2 else "passed", "r2_min": min_r2}
    return {"assay": "elisa_standard_curve", "model": model, "blank_subtract": blank_subtract,
            "standards": [{"concentration": _round(row["concentration"]), "signal_mean": _round(row["signal"] - (blank if blank_subtract else 0.0)), "replicates": [_round(x) for x in row["replicates"]]} for row in standard_rows],
            "fit": {"slope": _round(slope), "intercept": _round(intercept), "r2": _round(r2), "residual_sd": _round(residual_sd),
                    "x_min": _round(min_x), "x_max": _round(max_x)}, "qc": qc,
            "samples": result_samples, "warnings": warnings,
            "evidence_boundary": "The fit is a calibration calculation only; a linear/log-linear curve cannot replace a validated 4PL/5PL model, dilution linearity, recovery, or independent QC."}


def interpret(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        _fail("input must be a JSON object")
    assay = data.get("assay")
    if assay == "cell_viability":
        return _cell_viability(data)
    if assay == "qpcr_ddct":
        return _qpcr(data)
    if assay == "western_blot":
        return _western(data)
    if assay == "elisa_standard_curve":
        return _elisa(data)
    _fail("unsupported assay; use cell_viability, qpcr_ddct, western_blot, or elisa_standard_curve")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": "pass exactly one JSON object argument"}, ensure_ascii=False))
        return 2
    if len(argv[1]) > MAX_INPUT_CHARS:
        print(json.dumps({"ok": False, "error": "input exceeds the bounded size limit"}, ensure_ascii=False))
        return 2
    try:
        data = json.loads(argv[1])
        result = interpret(data)
        result["schema_version"] = SCHEMA_VERSION
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except (ArithmeticError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
