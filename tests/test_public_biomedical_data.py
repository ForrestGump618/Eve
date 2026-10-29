"""Offline safety and provenance tests for the public biomedical-data skill."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from urllib.request import Request

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "omicslab" / "skills" / "public-biomedical-data" / "scripts"
PIPELINE = SCRIPTS / "pipeline.py"
sys.path.insert(0, str(SCRIPTS))

import common as public_common  # noqa: E402


def plan(*, access="public", url="https://metadata-only.invalid/supplement.tsv"):
    return {
        "query": "matched human transcriptome",
        "candidates": [
            {
                "source": "GEO",
                "accession": "GSE000001",
                "title": "Synthetic metadata fixture",
                "species": "Homo sapiens",
                "tissue": "blood",
                "disease": "healthy",
                "platform": "Illumina",
                "data_level": "processed count matrix",
                "license": "CC-BY-4.0",
                "access": access,
                "sample_count": 20,
                "url": "https://example.org/accession/GSE000001",
                "files": [{"url": url, "kind": "supplementary", "original_note": "kept verbatim"}],
                "unknown_provider_field": {"batch": "not guessed"},
            }
        ],
    }


def run_pipeline(tmp_path, payload, *extra):
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(payload), encoding="utf-8")
    output = tmp_path / "out"
    result = subprocess.run(
        [sys.executable, str(PIPELINE), "--plan", str(plan_path), "--out", str(output), *extra],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result, output


def test_metadata_only_pipeline_is_offline_and_preserves_provenance(tmp_path):
    payload = plan()
    result, output = run_pipeline(tmp_path, payload)
    assert result.returncode == 0, result.stderr
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    candidates = json.loads((output / "candidates.json").read_text(encoding="utf-8"))
    curated = json.loads((output / "curated.json").read_text(encoding="utf-8"))
    provenance = json.loads((output / "provenance.json").read_text(encoding="utf-8"))
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()

    assert manifest["source_plan_sha256"] == hashlib.sha256(canonical).hexdigest()
    assert candidates["candidates"][0]["collector"]["network_used"] is False
    assert candidates["candidates"][0]["files"][0]["state"] == "metadata_only"
    assert curated["candidates"][0]["download_state"] == "metadata_only"
    assert curated["candidates"][0]["raw_record"]["unknown_provider_field"] == {
        "batch": "not guessed"
    }
    assert curated["candidates"][0]["files"][0]["original_note"] == "kept verbatim"
    assert provenance["source_plan_sha256"] == manifest["source_plan_sha256"]
    assert set(provenance["stage_sha256"]) == {"collect", "evaluate", "curate"}


def test_controlled_candidate_is_not_resolved_or_downloaded(tmp_path):
    result, output = run_pipeline(tmp_path, plan(access="controlled"), "--download")
    assert result.returncode == 0, result.stderr
    candidates = json.loads((output / "candidates.json").read_text(encoding="utf-8"))
    candidate = candidates["candidates"][0]
    assert candidate["access"] == "controlled"
    assert candidate["collector"]["network_used"] is False
    assert candidate["files"][0]["state"] == "blocked_non_public"
    assert not candidate["collector"]["errors"]
    assert not (output / "files").exists()


def test_download_budget_and_public_url_guards():
    with pytest.raises(ValueError, match="max_bytes"):
        public_common.normalize_max_bytes(10)
    with pytest.raises(ValueError, match="max_bytes"):
        public_common.normalize_max_bytes(True)
    with pytest.raises(ValueError, match="non-public"):
        public_common.validate_public_url("https://127.0.0.1/private")
    with pytest.raises(ValueError, match="credential-free"):
        public_common.validate_url_syntax("https://user:pass@example.org/file")


def test_redirect_handler_rejects_private_target_before_opening_it():
    handler = public_common.SafeRedirectHandler()
    request = Request("https://example.org/public")
    with pytest.raises(ValueError, match="non-public"):
        handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://127.0.0.1/internal",
        )
