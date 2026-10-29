"""Wet-lab skills, K-Dense provenance and deterministic result calculations."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from omicslab.agent.skills import load_skills
from omicslab.config import Settings
from omicslab.suwen.science_workbench import WORKFLOWS


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "omicslab" / "skills"
BUNDLED = ROOT / "desktop" / "bundled-skills"
KDENSE_COMMIT = "5f2bc0341354fd5590aef76a533ada1e1e5b4e62"


def _run(payload):
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    proc = subprocess.run(
        [sys.executable, str(SKILLS / "wet-lab-result-interpretation" / "run.py"), encoded],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
    )
    return proc, json.loads(proc.stdout)


def test_kdense_library_is_pinned_complete_and_restricted_items_are_absent():
    index = json.loads(
        (ROOT / "desktop" / "skill-library" / "index.json").read_text(encoding="utf-8")
    )
    source = next(
        entry for entry in index["sources"]
        if entry["repository"] == "K-Dense-AI/scientific-agent-skills"
    )
    assert source["commit"] == KDENSE_COMMIT
    assert source["license"] == "MIT"
    kdense = [
        skill for skill in index["skills"]
        if "K-Dense-AI/scientific-agent-skills" in skill["source"]
    ]
    assert len(kdense) == 175
    names = {skill["name"] for skill in kdense}
    assert {
        "experimental-design",
        "statistical-power",
        "scientific-critical-thinking",
        "primer-design",
        "flowio",
        "flowkit",
        "cellprofiler",
        "pylabrobot",
        "protocolsio-integration",
        "analytical-method-validation",
    } <= names
    assert not {"deepspot-m", "rowan"} & names


def test_wet_lab_skills_load_with_dependency_closure(tmp_path):
    settings = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    settings.ensure_dirs()
    skills = load_skills(settings)
    assert "wet-lab-experiment-design" in skills
    assert "classic-cell-and-molecular-assays" in skills
    assert "wet-lab-result-interpretation" in skills
    assert set(skills["wet-lab-experiment-design"].dependencies) == {
        "experimental-design", "statistical-rigor",
    }
    assert "wet-lab-experiment-design" in skills["classic-cell-and-molecular-assays"].dependencies
    assert set(skills["wet-lab-result-interpretation"].dependencies) >= {
        "wet-lab-experiment-design", "classic-cell-and-molecular-assays", "statistical-rigor",
    }


def test_desktop_and_workbench_skill_copies_do_not_drift():
    for name in (
        "wet-lab-experiment-design",
        "classic-cell-and-molecular-assays",
        "wet-lab-result-interpretation",
    ):
        workbench = SKILLS / name / "SKILL.md"
        desktop = BUNDLED / name / "SKILL.md"
        assert workbench.read_bytes() == desktop.read_bytes()
        manifest = json.loads((BUNDLED / name / "skill.json").read_text(encoding="utf-8"))
        assert manifest["name"] == name
        assert manifest["permissions"] == []
    interpretation = BUNDLED / "wet-lab-result-interpretation"
    assert (interpretation / "run.py").read_bytes() == (
        SKILLS / "wet-lab-result-interpretation" / "run.py"
    ).read_bytes()
    manifest = json.loads((interpretation / "skill.json").read_text(encoding="utf-8"))
    assert manifest["run"] == {
        "language": "python", "script": "run.py", "timeoutMs": 30000,
    }


def test_wet_lab_skills_expose_primary_reporting_standards():
    expected = {
        "ARRIVE 2.0": "https://arriveguidelines.org/arrive-guidelines",
        "MIQE 2.0": "10.1093/clinchem/hvaf043",
        "MIFlowCyt 2.0": "https://isac-net.org/miflowcyt-2/",
        "CLSI EP05": "https://clsi.org/shop/standards/ep05-plus/",
        "CLSI EP06": "https://clsi.org/shop/standards/ep06/",
        "Cellosaurus": "https://www.cellosaurus.org/faq",
        "RRID": "https://www.rrids.org/rrid-system",
    }
    for name in (
        "wet-lab-experiment-design",
        "classic-cell-and-molecular-assays",
        "wet-lab-result-interpretation",
    ):
        text = (BUNDLED / name / "SKILL.md").read_text(encoding="utf-8")
        for label, source in expected.items():
            assert label in text, (name, label)
            assert source in text, (name, source)
        assert "待核对" in text


def test_workbench_experiment_lane_exposes_the_full_wet_lab_chain():
    experiment = next(flow for flow in WORKFLOWS if flow["id"] == "experiment")
    assert {
        "wet-lab-experiment-design",
        "classic-cell-and-molecular-assays",
        "wet-lab-result-interpretation",
    } <= set(experiment["skills"])
    assert any("QC" in item for item in experiment["deliverables"])


def test_cell_viability_uses_biological_sample_means():
    proc, body = _run({
        "assay": "cell_viability", "control": "vehicle", "cv_limit_percent": 15,
        "groups": {
            "vehicle": [
                {"sample_id": "V1", "values": [1.01, 0.98, 1.02]},
                {"sample_id": "V2", "values": [0.97, 1.00, 1.01]},
            ],
            "drug": [
                {"sample_id": "D1", "values": [0.61, 0.58, 0.60]},
                {"sample_id": "D2", "values": [0.66, 0.63, 0.65]},
            ],
        },
    })
    assert proc.returncode == 0 and body["ok"]
    result = body["result"]
    assert result["groups"]["vehicle"]["qc"]["status"] == "passed"
    assert result["groups"]["drug"]["summary"]["biological_n"] == 2
    assert 59 < result["groups"]["drug"]["summary"]["mean"] < 65
    assert result["groups"]["vehicle"]["samples"][0]["technical_n"] == 3


def test_qpcr_preserves_raw_ct_and_marks_missing_values_without_imputation():
    proc, body = _run({
        "assay": "qpcr_ddct", "control": "control", "efficiency": 2.0,
        "target_gene": "IL6", "reference_gene": "GAPDH",
        "technical_sd_limit_ct": 0.5,
        "groups": {
            "control": [
                {"sample_id": "C1", "target_ct": [24.1, 24.3], "reference_ct": [18.2, 18.1]},
                {"sample_id": "C2", "target_ct": [24.0, 24.2], "reference_ct": [18.3, 18.2]},
            ],
            "treated": [
                {"sample_id": "T1", "target_ct": [22.0, None], "reference_ct": [18.0, 18.1]},
                {"sample_id": "T2", "target_ct": [21.8, 22.0], "reference_ct": [18.1, 18.0]},
            ],
        },
    })
    assert proc.returncode == 0 and body["ok"]
    result = body["result"]
    treated = result["groups"]["treated"]["samples"][0]
    assert treated["target_technical_n"] == 1
    assert treated["relative_expression"] > 1
    assert any("missing Ct" in warning for warning in result["warnings"])
    assert result["evidence_boundary"].startswith("Delta-delta Ct")


def test_western_normalizes_to_loading_control_and_elisa_marks_extrapolation():
    proc, body = _run({
        "assay": "western_blot", "control": "control", "cv_limit_percent": 15,
        "groups": {
            "control": [
                {"sample_id": "C1", "target": [1200, 1180], "loading": [900, 910]},
                {"sample_id": "C2", "target": [1220, 1210], "loading": [905, 915]},
            ],
            "treated": [
                {"sample_id": "T1", "target": [2100, 2050], "loading": [890, 900]},
                {"sample_id": "T2", "target": [2020, 1980], "loading": [895, 905]},
            ],
        },
    })
    assert proc.returncode == 0 and body["ok"]
    assert body["result"]["groups"]["treated"]["samples"][0]["relative_to_control"] > 1
    assert body["result"]["groups"]["treated"]["qc"]["status"] == "passed"

    proc, body = _run({
        "assay": "elisa_standard_curve", "model": "linear", "blank_subtract": True,
        "r2_min": 0.98,
        "standards": [
            {"concentration": 0, "signal": 0.05},
            {"concentration": 10, "signal": 0.32},
            {"concentration": 20, "signal": 0.61},
            {"concentration": 40, "signal": 1.18},
        ],
        "samples": [
            {"sample_id": "S1", "signal": [0.44, 0.45], "dilution_factor": 2},
            {"sample_id": "S-high", "signal": 2.0},
        ],
    })
    assert proc.returncode == 0 and body["ok"]
    result = body["result"]
    assert result["qc"]["status"] == "passed"
    assert result["samples"][0]["in_standard_range"] is True
    assert result["samples"][0]["reported_concentration"] is not None
    assert result["samples"][1]["in_standard_range"] is False
    assert result["samples"][1]["concentration"] is None
    assert result["samples"][1]["reported_concentration"] is None
    assert result["warnings"]


def test_qc_thresholds_do_not_pass_without_technical_replicates_or_r_squared():
    proc, body = _run({
        "assay": "cell_viability", "control": "control", "cv_limit_percent": 15,
        "groups": {
            "control": [{"sample_id": "C1", "values": [1.0]}, {"sample_id": "C2", "values": [0.98]}],
            "treated": [{"sample_id": "T1", "values": [0.62]}, {"sample_id": "T2", "values": [0.64]}],
        },
    })
    assert proc.returncode == 0 and body["ok"]
    assert body["result"]["groups"]["treated"]["qc"]["status"] == "not_assessed"
    assert "technical replicates" in body["result"]["groups"]["treated"]["samples"][0]["qc"]["reason"]

    proc, body = _run({
        "assay": "elisa_standard_curve", "model": "linear", "r2_min": 0.98,
        "standards": [
            {"concentration": 0, "signal": 0.05},
            {"concentration": 10, "signal": 0.32},
        ],
        "samples": [{"sample_id": "S1", "signal": 0.25}],
    })
    assert proc.returncode == 0 and body["ok"]
    assert body["result"]["qc"]["status"] == "not_assessed"
    assert "standards" in body["result"]["qc"]["reason"]


@pytest.mark.parametrize("payload", [
    {
        "assay": "qpcr_ddct", "control": "control",
        "groups": {"control": [{"sample_id": "C1", "target_ct": [0, 24], "reference_ct": [18, 18]}]},
    },
    {
        "assay": "elisa_standard_curve",
        "standards": [
            {"concentration": 0, "signal": 0.05},
            {"concentration": 0, "signal": 0.08},
            {"concentration": 10, "signal": 0.32},
        ],
        "samples": [{"sample_id": "S1", "signal": 0.2}],
    },
    {
        "assay": "elisa_standard_curve",
        "standards": [
            {"concentration": 0, "signal": 0.05},
            {"concentration": 10, "signal": 0.32},
        ],
        "samples": [
            {"sample_id": "S1", "signal": 0.2},
            {"sample_id": "S1", "signal": 0.3},
        ],
    },
    {
        "assay": "cell_viability",
        "control": "control",
        "groups": {"control": [{"sample_id": "", "values": [1.0, 1.1]}]},
    },
    {
        "assay": "qpcr_ddct",
        "control": "control",
        "groups": {
            "control": [{"sample_id": "C1", "target_ct": [1, 1], "reference_ct": [1, 1]}],
            "treated": [{"sample_id": "T1", "target_ct": [1, 1], "reference_ct": [1e308, 1e308]}],
        },
    },
])
def test_wet_lab_hardening_rejects_invalid_qpcr_and_elisa_inputs(payload):
    proc, body = _run(payload)
    assert proc.returncode == 1
    assert body["ok"] is False and body["error"]


@pytest.mark.parametrize("payload", [
    {"assay": "cell_viability", "control": "missing", "groups": {"a": [1, 2]}},
    {"assay": "cell_viability", "control": "a", "groups": {"a": [1, "bad"]}},
    {"assay": "qpcr_ddct", "control": "a", "groups": {"a": [{"sample_id": "x"}]}},
    {"assay": "elisa_standard_curve", "standards": [{"concentration": 0, "signal": 1}], "samples": []},
    {"assay": "not-supported"},
])
def test_invalid_wet_lab_inputs_fail_explicitly(payload):
    proc, body = _run(payload)
    assert proc.returncode == 1
    assert body["ok"] is False and body["error"]


def test_skill_resource_hashes_are_stable_for_distribution():
    for name in (
        "wet-lab-experiment-design",
        "classic-cell-and-molecular-assays",
        "wet-lab-result-interpretation",
    ):
        content = (BUNDLED / name / "SKILL.md").read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        assert len(digest) == 64
