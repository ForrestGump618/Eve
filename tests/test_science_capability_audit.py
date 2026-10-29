"""Offline audit regressions. Synthetic literature records are not live evidence."""
from __future__ import annotations

import copy
import gzip
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from omicslab.execution.science_audit import (
    ScienceCatalog, audit_evidence, capability_report, check_execution,
    normalize_citation, resource_digest,
)
from omicslab.execution.science_skills import execute_bundle

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/audit_science_capabilities.py"


def sha(value):
    return hashlib.sha256(value).hexdigest()


@pytest.fixture(scope="module")
def executed_fixture(tmp_path_factory):
    root = tmp_path_factory.mktemp("science-audit-process")
    records = {"results": [{"title": "Synthetic audit fixture, never a live lookup",
                            "pmid": "12345678", "doi": "10.1234/a(test)"}]}
    files = {"SKILL.md": "# Synthetic scientific audit fixture\n",
             "scripts/query.py": '# /// script\n# dependencies = []\n# ///\n'
             + "print(" + repr(json.dumps(records)) + ")\n"}
    skill = {"id": "fixture:literature", "name": "science-pubmed-database", "version": "fixture-1",
             "source": "local-test-fixture", "sha256": sha(files["SKILL.md"].encode()),
             "files": {p: sha(c.encode()) for p, c in files.items()},
             "runtime": {"manager": "uv", "project": False, "scripts": ["scripts/query.py"],
                         "requiredCredentials": [], "optionalCredentials": []}}
    bundle = {**skill, "files": [{"path": p, "content": c, "sha256": skill["files"][p]} for p, c in files.items()]}
    result = execute_bundle({"workspace": str(root), "bundle": bundle, "operation": "run",
                             "input": {"script": "scripts/query.py"}})
    assert result["ok"], result
    observation = {"callId": "fixture-call", "operation": "skill_run",
                   "arguments": {"id": skill["id"], "input": {"script": "scripts/query.py", "args": []}},
                   "result": result}
    return skill, observation, str(root)


@pytest.fixture
def evidence(executed_fixture):
    skill, observation, workspace = executed_fixture
    return {"workspace": workspace, "requiredSkillIds": [skill["id"]],
            "observations": [copy.deepcopy(observation)], "citations": ["PMID:12345678", "https://doi.org/10.1234/A(test)"]}


def run_audit(evidence, executed_fixture):
    skill = executed_fixture[0]
    return audit_evidence(evidence, {skill["id"]: skill})


def test_actual_offline_adapter_trace_matches_catalog_digest(evidence, executed_fixture):
    skill, observation, _ = executed_fixture
    assert resource_digest(skill) == observation["result"]["resourceDigest"]
    result = run_audit(evidence, executed_fixture)
    assert result["passed"] and result["scientificStatus"] == "unverified"
    assert result["liveVerified"] is False
    assert all(c["presentInRetrievedRecords"] for c in result["citations"])


@pytest.mark.parametrize("key,value", [
    ("status", "prepared"), ("executed", False), ("ok", False), ("ok", 1),
    ("exitCode", 3), ("exitCode", False), ("timedOut", True), ("truncated", True),
    ("timedOut", None), ("truncated", None), ("error", "upstream failure"),
    ("skillId", "unrelated"), ("version", "stale"), ("source", "other-source"),
    ("sha256", "0" * 64), ("resourceDigest", "0" * 64), ("workspace", "other-host"),
    ("stdout", ""), ("stdout", "x" * 28001),
    ("stdout", '{"ok":false}'), ("stdout", '{"error":"not found"}'),
])
def test_incomplete_or_stale_trace_never_satisfies_required_execution(evidence, executed_fixture, key, value):
    evidence["observations"][0]["result"][key] = value
    result = run_audit(evidence, executed_fixture)
    assert not result["passed"] and result["missingSkillIds"]


@pytest.mark.parametrize("operation,args", [
    ("skill_prepare", []), ("literature_reproduction_plan", []),
    ("skill_run", ["--help"]), ("skill_run", ["-h"]), ("skill_run", ["--version"]),
    ("skill_run", ["line\nbreak"]), ("skill_run", ["x"] * 61),
])
def test_preparation_planning_help_and_invalid_arguments_do_not_count(evidence, executed_fixture, operation, args):
    evidence["observations"][0]["operation"] = operation
    evidence["observations"][0]["arguments"]["input"]["args"] = args
    assert not run_audit(evidence, executed_fixture)["passed"]


def test_unknown_scripts_unrelated_skills_and_duplicate_calls_fail(evidence, executed_fixture):
    observation = evidence["observations"][0]
    observation["arguments"]["input"]["script"] = "scripts/invented.py"
    assert not run_audit(evidence, executed_fixture)["passed"]
    observation["arguments"]["input"]["script"] = "scripts/query.py"
    evidence["observations"].append(copy.deepcopy(observation))
    assert not run_audit(evidence, executed_fixture)["passed"]
    evidence["observations"] = [{"arguments": {"id": "some-other-skill"}}]
    assert not run_audit(evidence, executed_fixture)["passed"]


@pytest.mark.parametrize("stdout", [
    '[]', '["12345678"]', '{"results":[]}',
    '{"results":[{"title":"Paper","abstract":"PMID:12345678 doi:10.1234/a(test)"}]}',
    '{"results":[{"pmid":"12345678","doi":"10.1234/a(test)"}]}',
    '{"results":[{"title":"Paper","pmid":"12345678","error":"unavailable"}]}',
    'Success! Data written to: result.json',
    '<article><PMID>12345678</PMID></article>',
])
def test_citation_existence_is_not_inferred_from_prose_ids_errors_or_empty_results(evidence, executed_fixture, stdout):
    evidence["observations"][0]["result"]["stdout"] = stdout
    result = run_audit(evidence, executed_fixture)
    assert not result["passed"]
    assert not any(c["presentInRetrievedRecords"] for c in result["citations"])


@pytest.mark.parametrize("record,citation", [
    ({"title": "Synthetic", "pmid": "12345678"}, "https://pubmed.ncbi.nlm.nih.gov/12345678/"),
    ({"title": "Synthetic", "source": "MED", "id": "12345678"}, "PMID:12345678"),
    ({"title": "Synthetic", "source": "PMC", "id": "PMC12345"}, "https://pmc.ncbi.nlm.nih.gov/articles/PMC12345/"),
    ({"title": "Synthetic preprint", "doi": "10.1234/a(test)"}, "DOI:10.1234/A(test)"),
    ({"display_name": "Synthetic", "id": "https://openalex.org/W12345"}, "OPENALEX:W12345"),
    ({"display_name": "Synthetic", "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/12345678"}}, "PMID:12345678"),
])
def test_supported_record_identifiers(evidence, executed_fixture, record, citation):
    evidence["observations"][0]["result"]["stdout"] = json.dumps({"results": [record]})
    evidence["citations"] = [citation]
    assert run_audit(evidence, executed_fixture)["passed"]


def test_absent_and_unasked_citations_or_execution_fail(evidence, executed_fixture):
    evidence["citations"] = ["PMID:99999999"]
    assert not run_audit(evidence, executed_fixture)["passed"]
    evidence["citations"] = []
    assert not run_audit(evidence, executed_fixture)["passed"]
    evidence["observations"] = []
    assert not run_audit(evidence, executed_fixture)["passed"]


@pytest.mark.parametrize("citation", [
    "https://doi.org.attacker.test/10.1234/a", "https://doi.org@attacker.test/10.1234/a",
    "https://doi.org:443/10.1234/a", "https://doi.org/10.1234/a?claim=verified",
    "javascript:alert(1)", "PMID:0", "PMID:1234/text", "10.1234/a\ntext", None, [],
])
def test_unsafe_or_malformed_citation_normalization(citation):
    with pytest.raises(ValueError):
        normalize_citation(citation)


def test_legal_doi_punctuation_is_not_stripped():
    assert normalize_citation("https://doi.org/10.1234/A%28test%29") == "doi:10.1234/a(test)"
    assert normalize_citation("10.1234/a.") != normalize_citation("10.1234/a")


@pytest.mark.parametrize("key,value", [
    ("workspace", ""), ("requiredSkillIds", []), ("requiredSkillIds", ["unknown"]),
    ("requiredSkillIds", [{}]), ("observations", [{}] * 101), ("citations", ["x"] * 101),
])
def test_evidence_budgets_fail_closed(evidence, executed_fixture, key, value):
    evidence[key] = value
    with pytest.raises(ValueError):
        run_audit(evidence, executed_fixture)


def test_invalid_observations_fail_without_crashing(executed_fixture):
    skill, _, workspace = executed_fixture
    assert not check_execution([], skill, workspace)["passed"]
    result = check_execution({"callId": [], "arguments": {"input": []}, "result": []}, skill, workspace)
    assert not result["passed"]


def test_catalog_discovery_does_not_read_or_expand_pack(monkeypatch):
    original = Path.open

    def guarded(path, *args, **kwargs):
        assert path.name != "library.pack", "Discovery must preserve lazy body loading"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    catalog = ScienceCatalog(ROOT / "desktop/skill-library")
    report = capability_report(catalog)
    assert len(report["domains"]) == 17 and len(report["scenarios"]) == 3
    assert report["verification"]["resourceBodyReads"] == 0
    assert report["verification"]["scriptsExecuted"] == 0
    assert report["liveVerifiedThisAudit"] is False
    pymol = next(r for r in report["domains"] if r["domain"] == "PyMOL")
    assert pymol["existing"][0]["status"] == "instructions_and_resources"
    primers = next(r for r in report["scenarios"] if r["id"] == "primers_cloning")
    assert primers["catalog"][0]["scriptResources"] and not primers["catalog"][0]["scripts"]


def test_catalog_hash_verification_and_bounded_decompression(tmp_path):
    content = b"# fixture body\n"
    digest = sha(content)
    packed = gzip.compress(content)
    index = {"version": 1, "skills": [{"id": "fixture", "name": "fixture", "files": {"SKILL.md": digest}}],
             "objects": {digest: {"offset": 0, "length": len(packed), "bytes": len(content)}}, "packSha256": sha(packed)}
    (tmp_path / "index.json").write_text(json.dumps(index), encoding="utf-8")
    path = tmp_path / "library.pack"
    path.write_bytes(packed)
    catalog = ScienceCatalog(tmp_path)
    assert catalog.verify_pack() == sha(packed)
    assert catalog.read_resource("fixture", "SKILL.md") == content.decode()
    path.write_bytes(gzip.compress(b"# changed body\n"))
    with pytest.raises(ValueError, match="digest"):
        catalog.verify_pack()
    with pytest.raises(ValueError, match="digest"):
        catalog.read_resource("fixture", "SKILL.md")
    catalog.index["objects"][digest]["bytes"] = 2_000_001
    with pytest.raises(ValueError, match="bounds"):
        catalog.read_resource("fixture", "SKILL.md")


def test_cli_generates_reproducible_docs_and_returns_failure_for_bad_evidence(tmp_path):
    generated = subprocess.run([sys.executable, str(CLI), "--verify-resources", "--output", str(tmp_path)],
                               cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert generated.returncode == 0, generated.stderr
    report = json.loads((tmp_path / "science-capabilities.json").read_text(encoding="utf-8"))
    assert report["verification"]["pack"] == "sha256_matched"
    assert report["verification"]["selectedResourceHashesChecked"] > 300
    comparison = report["sourceBundleComparison"]
    assert comparison["mainBundleUnchanged"] == all(v["identicalToOriginalSource"] for v in comparison["files"].values())
    assert comparison["mainBundleGrowthBytes"] == sum(v["growthBytes"] for v in comparison["files"].values())
    assert comparison["files"]["library.pack"]["currentBytes"] == (ROOT / 'desktop/skill-library/library.pack').stat().st_size
    assert report["localSupplements"]["originLayer"] == "new_optional_workspace_scripts"
    checked = subprocess.run([sys.executable, str(CLI), "--verify-resources", "--output", str(tmp_path), "--check"],
                             cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert checked.returncode == 0, checked.stderr
    (tmp_path / "science-capabilities.md").write_text("stale", encoding="utf-8")
    stale = subprocess.run([sys.executable, str(CLI), "--verify-resources", "--output", str(tmp_path), "--check"],
                           cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert stale.returncode == 1
    evidence_path = tmp_path / "invalid-evidence.json"
    evidence_path.write_text(json.dumps({"citations": ["PMID:99999999"]}), encoding="utf-8")
    failed = subprocess.run([sys.executable, str(CLI), "--evidence", str(evidence_path)],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert failed.returncode == 1


def sequence_module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PRIMER_PATH = "omicslab/skills/primer-design/scripts/primer_check.py"
VECTOR_PATH = "omicslab/skills/vector-design/scripts/validate_construct.py"


@pytest.fixture
def primer_case(tmp_path):
    module = sequence_module("local_primer_check", PRIMER_PATH)
    path = tmp_path / "target.fa"
    path.write_text(">synthetic\nACGTCAGTGGAACCTCCGATGA\n", encoding="utf-8")
    config = {"reference": {"accession": "SYNTHETIC.1", "source": "synthetic test fixture"},
              "minProduct": 22, "maxProduct": 22,
              "pairs": [{"id": "test", "forward": "ACGTCAGT", "reverse": "TCATCGGA",
                         "forwardTail": "GCGC", "reverseTail": "TTAA",
                         "expected": {"start": 0, "end": 22, "strand": "+"}}]}
    return module, path, config


def test_primer_coordinates_tails_and_missing_tm_are_real(primer_case):
    module, path, config = primer_case
    first = module.analyze(path, config)
    assert first == module.analyze(path, config)
    pair = first["pairs"][0]
    assert first["ok"] and pair["localExactProductCount"] == 1
    assert pair["forward"]["tmCelsius"] is None and first["primer3Version"] is None
    assert pair["forward"]["gcPercent"] == 50
    product = pair["products"][0]
    assert product["leftBinding"] == [0, 8] and product["rightBinding"] == [14, 22]
    assert product["tailedProductLength"] == 30
    assert product["tailedProductSha256"] == sha(b"GCGCACGTCAGTGGAACCTCCGATGATTAA")
    assert first["specificity"]["status"] == "not_established"
    path.write_text(">reverse\n" + module.reverse_complement("ACGTCAGTGGAACCTCCGATGA") + "\n", encoding="utf-8")
    config["pairs"][0]["expected"]["strand"] = "-"
    reverse = module.analyze(path, config)
    assert reverse["ok"] and reverse["pairs"][0]["products"][0]["strand"] == "-"
    assert reverse["pairs"][0]["products"][0]["tailedProductSha256"] == product["tailedProductSha256"]


def test_primer_absent_dependency_fails_without_tm(primer_case, monkeypatch):
    module, path, config = primer_case
    def unavailable(_):
        raise ImportError("test: unavailable")
    monkeypatch.setattr(module.importlib, "import_module", unavailable)
    for mode, thermodynamics in (("design", False), ("check", True)):
        with pytest.raises(ValueError, match="No Tm was calculated"):
            module.analyze(path, config, mode, thermodynamics)


def test_primer_rejects_reference_errors_and_bounds(primer_case):
    module, path, config = primer_case
    config["reference"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="SHA-256"):
        module.analyze(path, config)
    del config["reference"]["sha256"]
    config["pairs"][0]["expected"]["start"] = 1
    assert not module.analyze(path, config)["ok"]
    config["pairs"][0]["forward"] = "NNNNNNNN"
    with pytest.raises(ValueError, match="unambiguous"):
        module.analyze(path, config)
    path.write_text(">repeat\n" + "A" * 250 + "\n", encoding="utf-8")
    config["pairs"][0]["forward"] = "AAAAAAAA"
    with pytest.raises(ValueError, match="Too many exact"):
        module.analyze(path, config)


@pytest.fixture
def vector_case(tmp_path):
    module = sequence_module("local_vector_check", VECTOR_PATH)
    construct = tmp_path / "construct.fa"
    construct.write_text(">synthetic construct\nATGAAAGGCTAA\n", encoding="utf-8")
    (tmp_path / "backbone.fa").write_text(">synthetic backbone\nATGACTAA\n", encoding="utf-8")
    (tmp_path / "insert.fa").write_text(">synthetic insert\nAAGG\n", encoding="utf-8")
    config = {"topology": "circular", "references": [
        {"id": "backbone", "path": "backbone.fa", "accession": "SYNTHETIC_BACKBONE.1", "source": "synthetic fixture"},
        {"id": "insert", "path": "insert.fa", "accession": "SYNTHETIC_INSERT.1", "source": "synthetic fixture"}],
        "segments": [
            {"id": "left", "reference": "backbone", "sourceStart": 0, "sourceEnd": 4, "strand": "+", "start": 0, "end": 4},
            {"id": "cargo", "reference": "insert", "sourceStart": 0, "sourceEnd": 4, "strand": "+", "start": 4, "end": 8},
            {"id": "right", "reference": "backbone", "sourceStart": 4, "sourceEnd": 8, "strand": "+", "start": 8, "end": 12}],
        "junctions": [{"left": "left", "right": "cargo", "flank": 2, "sequence": "GAAA"},
                      {"left": "cargo", "right": "right", "flank": 2, "sequence": "GGCT"},
                      {"left": "right", "right": "left", "flank": 2, "sequence": "AAAT"}],
        "features": [{"id": "cds", "type": "CDS", "start": 0, "end": 12, "strand": "+", "phase": 0,
                      "geneticCode": 1, "requireStart": True, "requireStop": True, "expectedProtein": "MKG*"}]}
    return module, construct, config, tmp_path


def test_vector_actual_reference_junction_and_split_codon_checks(vector_case):
    module, construct, config, root = vector_case
    result = module.validate(construct, config, root)
    assert result == module.validate(construct, config, root)
    assert result["ok"] and result["features"][0]["protein"] == "MKG*"
    assert all(s["referenceMatched"] for s in result["segments"])
    assert all(j["matched"] for j in result["junctions"])
    assert [j["codonOffset"] for j in result["features"][0]["junctionCrossings"]] == [1, 2]
    config["junctions"][0]["sequence"] = "CCCC"
    assert not module.validate(construct, config, root)["ok"]


@pytest.mark.parametrize("field,value", [("phase", 1), ("end", 11), ("strand", "-"), ("expectedProtein", "FAKE")])
def test_vector_cds_frame_strand_and_expected_protein_fail(vector_case, field, value):
    module, construct, config, root = vector_case
    config["features"][0][field] = value
    assert not module.validate(construct, config, root)["ok"]


def test_vector_source_coordinates_and_closure_are_required(vector_case):
    module, construct, config, root = vector_case
    config["segments"][1]["start"] = 5
    with pytest.raises(ValueError, match="tile"):
        module.validate(construct, config, root)
    config["segments"][1]["start"] = 4
    config["junctions"].pop()
    with pytest.raises(ValueError, match="every adjacent"):
        module.validate(construct, config, root)


def test_vector_reference_mutation_does_not_pass(vector_case):
    module, construct, config, root = vector_case
    (root / "insert.fa").write_text(">changed\nACGG\n", encoding="utf-8")
    result = module.validate(construct, config, root)
    assert not result["ok"] and "Reference sequence mismatch: cargo" in result["issues"]


def test_vector_internal_stops_report_real_base_coordinates(vector_case):
    module, construct, config, root = vector_case
    construct.write_text(">synthetic\nATGTGAGGCTAA\n", encoding="utf-8")
    (root / "backbone.fa").write_text(">synthetic\nATGTCTAA\n", encoding="utf-8")
    (root / "insert.fa").write_text(">synthetic\nGAGG\n", encoding="utf-8")
    config["junctions"][0]["sequence"] = "GTGA"
    result = module.validate(construct, config, root)
    assert not result["ok"]
    assert all(s["referenceMatched"] for s in result["segments"])
    assert result["features"][0]["internalStopCoordinates"] == [{"codonIndex": 1, "genomicBases": [3, 4, 5]}]


def test_vector_minus_reference_segments_match_actual_orientation(vector_case):
    module, construct, config, root = vector_case
    (root / "insert.fa").write_text(">reverse cargo\nCCTT\n", encoding="utf-8")
    config["segments"][1]["strand"] = "-"
    assert module.validate(construct, config, root)["ok"]


@pytest.mark.parametrize("sequence,strand,start,end", [("TTAGCCTTTCAT", "-", 0, 12), ("GGCTAAATGAAA", "+", 6, 18)])
def test_vector_reverse_cds_and_circular_origin(tmp_path, sequence, strand, start, end):
    module = sequence_module("circular_vector_check", VECTOR_PATH)
    path = tmp_path / "sequence.fa"
    path.write_text(">synthetic\n" + sequence + "\n", encoding="utf-8")
    config = {"topology": "circular", "references": [{"id": "r", "path": path.name, "accession": "FIXTURE.1", "source": "synthetic"}],
              "segments": [{"id": "whole", "reference": "r", "sourceStart": 0, "sourceEnd": 12, "strand": "+", "start": 0, "end": 12}],
              "junctions": [{"left": "whole", "right": "whole", "flank": 2, "sequence": sequence[-2:] + sequence[:2]}],
              "features": [{"id": "cds", "type": "CDS", "start": start, "end": end, "strand": strand, "phase": 0,
                            "geneticCode": 1, "requireStart": True, "requireStop": True, "expectedProtein": "MKG*"}]}
    result = module.validate(path, config, tmp_path)
    assert result["ok"] and result["features"][0]["protein"] == "MKG*"


def test_sequence_clis_execute_and_do_not_overwrite_inputs(primer_case, vector_case):
    primer, reference, assay = primer_case
    _, construct, config, root = vector_case
    for script, args, body in ((PRIMER_PATH, ["check", "--reference", str(reference)], assay),
                               (VECTOR_PATH, ["--construct", str(construct)], config)):
        path = root / (Path(script).stem + ".json")
        path.write_text(json.dumps(body), encoding="utf-8")
        command = [sys.executable, str(ROOT / script), *args, "--config", str(path)]
        proc = subprocess.run(command, capture_output=True, text=True, timeout=20)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        data = json.loads(proc.stdout)
        assert data["ok"] and data["scriptSha256"] and data["configSha256"]
        original = reference.read_bytes()
        blocked = subprocess.run([*command, "--output", str(reference)], capture_output=True, text=True, timeout=20)
        assert blocked.returncode == 2 and reference.read_bytes() == original


def test_actual_adapter_artifact_readback_supplies_citation_evidence(tmp_path):
    records = {"results": [{"title": "Synthetic file-only fixture", "pmid": "12345678"}]}
    files = {"SKILL.md": "# Synthetic file-only fixture\n", "scripts/query.py":
             '# /// script\n# dependencies = []\n# ///\nimport pathlib,sys\n'
             + "pathlib.Path(sys.argv[2]).write_text(" + repr(json.dumps(records)) + ", encoding='utf-8')\n"}
    skill = {"id": "fixture:file-literature", "name": "science-pubmed-database", "version": "fixture-1",
             "source": "synthetic-local-fixture", "sha256": sha(files["SKILL.md"].encode()),
             "files": {p: sha(c.encode()) for p, c in files.items()},
             "runtime": {"manager": "uv", "project": False, "scripts": ["scripts/query.py"],
                         "requiredCredentials": [], "optionalCredentials": []}}
    bundle = {**skill, "files": [{"path": p, "content": c, "sha256": skill["files"][p]} for p, c in files.items()]}
    inputs = {"script": "scripts/query.py", "args": ["--output", "metadata.json"]}
    result = execute_bundle({"workspace": str(tmp_path), "bundle": bundle, "operation": "run", "input": inputs})
    assert result["ok"] and result["artifactEvidence"][0]["fresh"]
    evidence = {"workspace": str(tmp_path), "requiredSkillIds": [skill["id"]], "citations": ["PMID:12345678"],
                "observations": [{"callId": "file-call", "operation": "skill_run", "arguments": {"id": skill["id"], "input": inputs}, "result": result}]}
    assert audit_evidence(evidence, {skill["id"]: skill})["passed"]
    for key, value in (("fresh", False), ("sha256", "invalid"), ("path", "undeclared.json"), ("bytes", 0)):
        changed = copy.deepcopy(evidence)
        observation = changed["observations"][0]
        observation["result"]["artifactEvidence"][0][key] = value
        wrapper = json.loads(observation["result"]["stdout"])
        wrapper["artifactEvidence"] = observation["result"]["artifactEvidence"]
        observation["result"]["stdout"] = json.dumps(wrapper)
        assert not audit_evidence(changed, {skill["id"]: skill})["passed"]
    wrapper = json.loads(result["stdout"])
    wrapper["output"] = {"ok": False, "error": "Synthetic upstream failure"}
    result["stdout"] = json.dumps(wrapper)
    assert not audit_evidence(evidence, {skill["id"]: skill})["passed"]


def test_fixture_runner_executes_sequence_clis_and_reuses_matrix_qc(tmp_path):
    proc = subprocess.run([sys.executable, str(CLI), "--run-fixtures", "--output", str(tmp_path)],
                          cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads((tmp_path / "science-capabilities.json").read_text(encoding="utf-8"))
    fixtures = report["fixtureExecution"]
    assert fixtures["processExecutions"] == 4 and fixtures["liveVerified"] is False
    assert fixtures["primer"]["specificity"] == "not_established"
    assert fixtures["vector"]["protein"] == "MKG*" and fixtures["vector"]["invalidJunctionRejected"]
    assert fixtures["matrixQC"]["identicalRepeat"] and fixtures["matrixQC"]["invalidRawCountRejected"]
