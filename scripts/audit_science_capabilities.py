"""Reproduce the offline capability map and optionally gate trusted evidence.

python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade
python scripts/audit_science_capabilities.py --evidence paired-tool-evidence.json

No network, dependency installation or credential access occurs. Execution is
limited to synthetic local fixtures when --run-fixtures is explicitly selected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from omicslab.execution.science_audit import ScienceCatalog, audit_evidence, capability_report


def source_bundle_comparison(catalog: ScienceCatalog) -> dict:
    """Compare packed assets with tracked source HEAD, separately from local CLIs."""
    files = {}
    try:
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10).strip()
        for name in ("index.json", "library.pack"):
            original = subprocess.check_output(["git", "show", f"{revision}:desktop/skill-library/{name}"],
                                               cwd=ROOT, stderr=subprocess.PIPE, timeout=20)
            actual = (catalog.directory / name).read_bytes()
            files[name] = {"originalBytes": len(original), "currentBytes": len(actual), "growthBytes": len(actual) - len(original),
                           "originalSha256": hashlib.sha256(original).hexdigest(), "currentSha256": hashlib.sha256(actual).hexdigest(),
                           "identicalToOriginalSource": actual == original}
        return {"baseline": "Tracked source HEAD", "revision": revision, "files": files,
                "catalogSkills": len(catalog.by_id),
                "scienceSkills": sum(s.get("bundle") == "science" for s in catalog.by_id.values()),
                "scienceDeclaredScripts": sum(len((s.get("runtime") or {}).get("scripts", [])) for s in catalog.by_id.values() if s.get("bundle") == "science"),
                "mainBundleGrowthBytes": sum(v["growthBytes"] for v in files.values()),
                "mainBundleUnchanged": all(v["identicalToOriginalSource"] for v in files.values())}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"baseline": "Tracked source HEAD unavailable", "status": "unverified", "error": type(exc).__name__}


def run_supplement_fixtures() -> dict:
    """Execute tiny synthetic cases. Never query databases or install packages."""
    from omicslab.execution.science_workbench import inspect_scientific
    primer = ROOT / "omicslab/skills/primer-design/scripts/primer_check.py"
    vector = ROOT / "omicslab/skills/vector-design/scripts/validate_construct.py"
    processes = []
    with tempfile.TemporaryDirectory(prefix="eve-sequence-fixtures-") as directory:
        root = Path(directory)
        def write(name, content):
            (root / name).write_text(content, encoding="utf-8", newline="\n")
            return root / name
        def execute(name, script, arguments, expected_exit=0):
            proc = subprocess.run([sys.executable, str(script), *arguments], cwd=root,
                                  capture_output=True, text=True, timeout=30)
            data = json.loads(proc.stdout)
            if proc.returncode != expected_exit or (expected_exit == 0 and data.get("ok") is not True):
                raise ValueError(f"Fixture {name} failed: {proc.stdout[:1500]} {proc.stderr[:500]}")
            processes.append({"name": name, "exitCode": proc.returncode,
                              "resultSha256": hashlib.sha256(proc.stdout.encode()).hexdigest(),
                              "synthetic": True, "liveService": False})
            return data
        target = write("target.fa", ">synthetic\nACGTCAGTGGAACCTCCGATGA\n")
        assay = {"reference": {"accession": "SYNTHETIC.1", "source": "synthetic audit fixture"},
                 "minProduct": 22, "maxProduct": 22,
                 "pairs": [{"id": "fixture", "forward": "ACGTCAGT", "reverse": "TCATCGGA",
                            "expected": {"start": 0, "end": 22, "strand": "+"}}]}
        assay_path = write("assay.json", json.dumps(assay, sort_keys=True))
        checked = execute("primer exact coordinates", primer, ["check", "--reference", str(target), "--config", str(assay_path)])
        if checked["pairs"][0]["products"][0]["templateLength"] != 22 or checked["pairs"][0]["forward"]["tmCelsius"] is not None:
            raise ValueError("Exact primer fixture coordinates/Tm mismatch")
        construct = write("construct.fa", ">synthetic\nATGAAAGGCTAA\n")
        write("backbone.fa", ">synthetic\nATGACTAA\n")
        write("insert.fa", ">synthetic\nAAGG\n")
        config = {"topology": "circular", "references": [
            {"id": "backbone", "path": "backbone.fa", "accession": "SYNTHETIC_BACKBONE.1", "source": "synthetic audit fixture"},
            {"id": "insert", "path": "insert.fa", "accession": "SYNTHETIC_INSERT.1", "source": "synthetic audit fixture"}],
            "segments": [{"id": "left", "reference": "backbone", "sourceStart": 0, "sourceEnd": 4, "strand": "+", "start": 0, "end": 4},
                         {"id": "cargo", "reference": "insert", "sourceStart": 0, "sourceEnd": 4, "strand": "+", "start": 4, "end": 8},
                         {"id": "right", "reference": "backbone", "sourceStart": 4, "sourceEnd": 8, "strand": "+", "start": 8, "end": 12}],
            "junctions": [{"left": "left", "right": "cargo", "flank": 2, "sequence": "GAAA"},
                          {"left": "cargo", "right": "right", "flank": 2, "sequence": "GGCT"},
                          {"left": "right", "right": "left", "flank": 2, "sequence": "AAAT"}],
            "features": [{"id": "cds", "type": "CDS", "start": 0, "end": 12, "strand": "+", "phase": 0,
                          "geneticCode": 1, "requireStart": True, "requireStop": True, "expectedProtein": "MKG*"}]}
        config_path = write("construct.json", json.dumps(config, sort_keys=True))
        validated = execute("vector references junctions CDS", vector, ["--construct", str(construct), "--config", str(config_path)])
        if validated["features"][0]["protein"] != "MKG*" or not all(j["matched"] for j in validated["junctions"]):
            raise ValueError("Vector fixture translation/junction mismatch")
        config["junctions"][0]["sequence"] = "CCCC"
        bad_config = write("invalid-construct.json", json.dumps(config, sort_keys=True))
        rejected = execute("invalid vector junction rejected", vector, ["--construct", str(construct), "--config", str(bad_config)], 2)
        if rejected.get("ok") is not False or not rejected.get("issues"):
            raise ValueError("Invalid vector fixture was not rejected")
        primer3_available = importlib.util.find_spec("primer3") is not None
        optional = {"status": "dependency_absence_checked", "primer3Version": None}
        if primer3_available:
            template = "".join("ACGT"[x % 4] for i in range(12) for x in hashlib.sha256(f"synthetic-{i}".encode()).digest())
            target = write("design.fa", ">synthetic Primer3 design template\n" + template + "\n")
            assay.update(minProduct=100, maxProduct=180, numReturn=2,
                         chemistry={"mv_conc": 50, "dv_conc": 1.5, "dntp_conc": 0.6, "dna_conc": 50, "temp_c": 37})
            assay_path = write("design.json", json.dumps(assay, sort_keys=True))
            designed = execute("real optional Primer3 design thermodynamics", primer,
                               ["design", "--reference", str(target), "--config", str(assay_path)])
            if not designed["pairs"] or not all(isinstance(p["forward"]["tmCelsius"], (int, float)) for p in designed["pairs"]):
                raise ValueError("Primer3 fixture did not compute real Tm")
            optional = {"status": "real_library_executed", "primer3Version": designed["primer3Version"],
                        "candidatePairs": len(designed["pairs"]), "forwardTmCelsius": designed["pairs"][0]["forward"]["tmCelsius"]}
        else:
            absent = execute("absent optional Primer3 rejected", primer,
                             ["design", "--reference", str(target), "--config", str(assay_path)], 2)
            if "No Tm was calculated" not in absent.get("error", ""):
                raise ValueError("Missing Primer3 did not fail explicitly")
        matrix = write("counts.tsv", "gene\ta\tb\nG1\t1\t0\nG2\t2\t3\n")
        first = inspect_scientific({"workspace": str(root), "kind": "counts", "path": matrix.name})
        second = inspect_scientific({"workspace": str(root), "kind": "counts", "path": matrix.name})
        if first != second or first["librarySizes"] != [3, 3] or first["zeroFraction"] != 0.25:
            raise ValueError("Existing matrix QC repeat-run mismatch")
        write("invalid-counts.tsv", "gene\ta\tb\nG1\t-1\t0\n")
        try:
            inspect_scientific({"workspace": str(root), "kind": "counts", "path": "invalid-counts.tsv"})
        except ValueError:
            invalid_matrix_rejected = True
        else:
            raise ValueError("Existing matrix QC accepted a negative raw count")
    return {"kind": "executed synthetic local fixtures", "liveVerified": False, "processExecutions": len(processes),
            "processes": processes, "primer": {"templateLength": 22, "exactProducts": 1, "specificity": "not_established"},
            "primer3": optional, "vector": {"referencesMatched": 3, "junctionsMatched": 3, "protein": "MKG*", "invalidJunctionRejected": True},
            "matrixQC": {"implementation": "science_workbench.inspect_scientific", "identicalRepeat": True,
                         "librarySizes": [3, 3], "zeroFraction": 0.25, "invalidRawCountRejected": invalid_matrix_rejected}}


def render_markdown(report: dict) -> str:
    verification = report["verification"]
    lines = [
        "# Scientific capability audit", "",
        "This is an offline source/catalog audit. No live service, scientific reproduction, model, SSH host or wet-lab outcome was verified in this run.", "",
        "## Reproduce", "", "Run from the repository root:", "", "```powershell",
        "python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade",
        "python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade --check",
        "python -m pytest -q tests/test_science_capability_audit.py tests/test_science_skill_runtime.py tests/test_science_workbench.py tests/test_research_quests.py",
        "```", "",
        "The first command generates this file and science-capabilities.json. --check compares both files without writing them. Without --verify-resources, discovery reads only index metadata; no skill bodies are expanded. Explicit resource verification streams the pack hash and checks only mapped resources. It never imports their Python modules. --run-fixtures additionally executes bounded local synthetic sequence CLIs and reuses the existing matrix QC.", "",
        "## Snapshot", "",
        f"- Index SHA-256: `{report['indexSha256']}`.",
        f"- Pack SHA-256: `{report['packSha256']}`; check: `{verification['pack']}`.",
        f"- Selected resource hashes checked: {verification['selectedResourceHashesChecked']}; scripts executed by the audit: {verification['scriptsExecuted']}.",
        "- Imported Google DeepMind bundle: 1.3.1, commit `4de6786171f1479026da5d3a00f110703c8ba35e` (40 skills, 65 declared scripts in the inspected import report).",
        "- Historical acceptance: docs/verification/science-skills/results.json records preparation of 40 skills and five public queries (Europe PMC, PubChem, ChEMBL, GTEx, UniProt). These are prior observations, not rerun results. That earlier pack digest predates additional catalog imports.", "",
        "- Current parent-reported main validation: 45/45 (40 preparations plus five live upstream queries: Europe PMC, PubChem, ChEMBL, GTEx, UniProt). This is attributed to the parent's report and was not independently rerun by this audit.", "",
        "## Existing, missing and supplement", "",
        "Declared scripts are dispatchable catalog entries, not proof that dependencies, credentials, endpoints, outputs or scientific interpretation work. Instructions/resources remain useful through explicit skill loading and authorized workspace execution, but do not imply a skill_run entry.", "",
        "| Domain | Existing catalog entries (declared scripts) | Missing verification/capability | Supplement |",
        "| --- | --- | --- | --- |",
    ]
    for row in report["domains"]:
        entries = "; ".join(f"`{s['name']}` ({len(s.get('scripts', []))}; {s['status']})" for s in row["existing"])
        lines.append(f"| {row['domain']} | {entries} | {row['missing']} | {row['supplement']} |")
    comparison = report.get("sourceBundleComparison", {})
    lines += ["", "## Original source versus runnable supplements", "",
              "The primer/vector CLIs are also declared lazy execution entries: science-primer-reference-check and science-construct-validation. Their compressed resources are generated by desktop/scripts/import-eve-supplements.py and executed through the existing bound scientific adapter. The original upstream primer-design entry remains intact.", ""]
    if comparison.get("files"):
        lines += [f"Measured against tracked source HEAD `{comparison['revision']}`: {comparison['catalogSkills']} total catalog skills; {comparison['scienceSkills']} Google DeepMind science skills and {comparison['scienceDeclaredScripts']} declared scripts. External resource pack unchanged: {comparison['mainBundleUnchanged']}; external resource growth: {comparison['mainBundleGrowthBytes']} bytes.", "",
                  "| Main asset | Original bytes | Current bytes | Growth bytes | SHA-256 identical |", "| --- | ---: | ---: | ---: | --- |"]
        for name, value in comparison["files"].items():
            lines.append(f"| {name} | {value['originalBytes']} | {value['currentBytes']} | {value['growthBytes']} | {value['identicalToOriginalSource']} |")
        lines.append("")
    else:
        lines += ["Source HEAD comparison unavailable; no bundle-growth conclusion is inferred.", ""]
    lines += ["External resource growth is reported independently of the main JavaScript bundle. tests/test_science_supplement_runtime.py executes the compressed primer entry through the native adapter. Installed-package validation is recorded separately in the release report.", "",
              "Dependency status: the exact-reference primer checker, vector validator and existing matrix QC use the standard library. Primer design and thermodynamics require optional primer3-py. Primer3 is an optional dependency; the fixtureExecution.primer3 field records whether the current audit actually exercised it.", ""]
    lines += ["", "## Three scenarios", ""]
    for row in report["scenarios"]:
        lines += [f"### {row['id']}", "", f"Existing: {row['existing']}", "",
                  f"Missing: {row['missing']}", "", f"Supplement: {row['supplement']}", "",
                  "Catalog evidence: " + "; ".join(f"`{s['name']}` ({s['status']})" for s in row["catalog"]) + ".", ""]
    lines += ["## Runnable local supplements", "",
              "- Primer: `python omicslab/skills/primer-design/scripts/primer_check.py check --reference target.fa --config assay.json`; use `design` or `--thermodynamics` for real optional Primer3 calculations.",
              "- Vector: `python omicslab/skills/vector-design/scripts/validate_construct.py --construct construct.fa --config construct.json`; validates reference tiling, all declared junctions including circular closure, and CDS strand/phase/start/stop/protein.",
              "- Matrix QC: `omicslab.execution.science_workbench.inspect_scientific({workspace, kind: 'counts', path})`; existing implementation is reused, not duplicated.",
              "- Each sequence CLI hashes script/config/reference inputs, emits deterministic JSON and exits 2 on failed checks. Optional output files must be new. Input contracts and calculation limits are in the two local SKILL.md files. No automatic JS catalog entry or dependency installation was added.", "",
              "Execute fixtures without adding optional dependencies: `python scripts/audit_science_capabilities.py --run-fixtures --verify-resources --output docs/verification/platform-upgrade`.", "",
              "To include real Primer3 2.3.1 execution in an explicitly isolated optional environment:", "", "```powershell",
              "uv run --no-config --no-project --with primer3-py==2.3.1 python scripts/audit_science_capabilities.py --run-fixtures --verify-resources --output docs/verification/platform-upgrade",
              "```", "",
              "Use the same fixture flag and optional environment with --check to reproduce the JSON snapshot. Dependency resolution belongs to the explicit uv command; the audit and wrappers never install packages or query services themselves.", ""]
    if report.get("fixtureExecution"):
        fixture = report["fixtureExecution"]
        lines += [f"Executed coverage: {fixture['processExecutions']} CLI processes; primer exact product 0..22, vector three reference segments/three circular junctions and CDS MKG*, invalid junction rejection, identical repeated matrix QC and invalid-count rejection.", "",
                  "Optional Primer3 execution: `" + json.dumps(fixture["primer3"], sort_keys=True) + "`. Results are synthetic local calculations, not real assay specificity or wet-lab validation.", ""]
    lines += ["## Callable gate API for parent integration", "",
              "`check_execution(observation, skill_metadata, workspace) -> {passed, reasons, callId, skillId, script}` checks a paired run/result against metadata and resource digests. `audit_evidence({workspace, requiredSkillIds, observations, citations}, skills_by_id) -> {passed, executions, citations, missingSkillIds, reasons, scientificStatus, liveVerified}` combines required executions and citation membership. These functions are in omicslab.execution.science_audit; neither loads skill bodies nor executes tools. Invalid top-level contracts raise ValueError; failed evidence returns passed=false. Parent integration must supply trusted observations, enforce this result in its gate and retain human/scientific review separately.", ""]
    lines += [
        "## Bounded correctness gates", "",
        "The new omicslab/execution/science_audit.py is a standalone audit module used by this command. It does not alter the adapter, lazy loading, scheduler, agent loop or research state machine. Its checks are not automatically enforced on ordinary chat answers or research_record.", "",
        "An evidence file contains the expected workspace, required catalog skill IDs, original paired tool calls/results, and explicit DOI/PMID/PMCID/OpenAlex citations. Use trusted, unmodified observations from the bound backend. The call arguments retain the model-facing id/input shape for both operation names; a raw backend bundle must be normalized to its id by the trusted exporter.", "",
        "```json",
        '{"workspace":"<exact adapter workspace>","requiredSkillIds":["<catalog id>"],"observations":[{"callId":"<original call id>","operation":"skill_run","arguments":{"id":"<catalog id>","input":{"script":"scripts/pubmed_api.py","args":["<actual arguments>"]}},"result":{"<paste the complete adapter result>":""}}],"citations":["PMID:12345678"]}',
        "```", "",
        "This shape is illustrative and intentionally fails until populated with actual catalog identity, command arguments and the complete adapter result. The command exits nonzero for malformed evidence or failed gates:", "",
        "```powershell", "python scripts/audit_science_capabilities.py --evidence paired-tool-evidence.json", "```", "",
        "The execution gate requires every requested skill to have a successful declared script call, paired call ID, exact catalog identity/version/source/instruction and resource digests, expected workspace, executed=true, ok=true, exit code zero, complete stdout, no timeout/truncation and no structured top-level error. Preparation, planning, help/version calls, unrelated skills, duplicate calls, missing flags and failed observations are rejected.", "",
        "The citation gate parses bounded JSON stdout or the adapter's verified JSON artifact read-back from successful declared PubMed/bioRxiv/Europe PMC/OpenAlex calls. It checks explicit identifier fields in titled records and supported result collections, including Europe PMC MED/PMC IDs and OpenAlex ids. A bare PMID search list, plausible prose URL, identifier echoed in an abstract, empty results, or an error record is insufficient. DOI case and canonical identifier URLs normalize; legal DOI punctuation is retained. Literature checks require at least one cited identifier.", "",
        "For synthesized read-back stdout, artifactEvidence must match the adapter result, name a declared --output/-o path in the expected workspace, have a fresh flag, bounded nonempty byte count and SHA-256 identity. Only its output field supplies citation records; nested scientific errors are rejected. The adapter is the trusted source of the raw-file hash; this offline audit cannot recompute raw bytes from parsed JSON. Unmarked file-only logs, XML and recovered truncated output remain incomplete. Do not manually substitute file contents for an original trace.", "",
        "Passing means trace consistency and identifier presence in retrieved metadata. It does not independently resolve DOI registration/existence, establish title identity, full-text access, claim support, corrections/retractions, reproduction success, assay specificity or determinism. The existing literature-review/scripts/verify_citations.py resource performs bounded DOI handle checks and Crossref metadata retrieval, but lacks a declared scientific runtime entry. Its existence checks and a manual source/claim comparison remain separate.", "",
        "## Source and test anchors", "",
        "- desktop/src/skill-library.ts and desktop/test/science-skills.test.ts: metadata discovery, explicit body reads, load-before-run and bound-backend routing.",
        "- omicslab/execution/skill_resources.py and science_skills.py: resource verification, credential presence, bounded argv/process execution, offline dependency default and output error handling. Dependency offline mode does not block a script's own network requests.",
        "- desktop/src/agent-tools.ts: literature_reproduction_plan, experimental_design_plan and multiomics_inventory remain plans/intake with scientific_status=unverified.",
        "- desktop/src/harness/agent-loop.ts: existing generic URL provenance checks do not decode scientific JSON stdout into citation identity proof.",
        "- omicslab/suwen/research.py and tests/test_research_quests.py: ordered artifact/metric contracts and human finalization; recorded evidence remains scientific_status=unverified.",
        "- tests/test_science_capability_audit.py: local regressions for catalog laziness/integrity, actual fixture adapter execution, forged/stale identities, incomplete/error/help traces, malformed budgets and cited record membership. No live API fixture is passed off as a database result.", "",
        "Exact source and test file hashes for this snapshot are recorded in the JSON companion. Test commands must be rerun to establish current results; this generated document does not infer test success from test-file presence.", "",
    ]
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=ROOT / "desktop/skill-library")
    parser.add_argument("--output", type=Path, help="Write science-capabilities.md/json in this directory")
    parser.add_argument("--verify-resources", action="store_true")
    parser.add_argument("--run-fixtures", action="store_true", help="Execute bounded synthetic primer/vector and existing matrix-QC fixtures")
    parser.add_argument("--evidence", type=Path, help="Validate trusted paired calls and adapter results (JSON, <=4 MB)")
    parser.add_argument("--check", action="store_true", help="Check generated documents match --output without writing")
    args = parser.parse_args(argv)
    if args.check and (not args.output or args.evidence):
        parser.error("--check requires --output and cannot be combined with --evidence")
    try:
        catalog = ScienceCatalog(args.library)
        report = capability_report(catalog, verify_resources=args.verify_resources)
        report["sourceBundleComparison"] = source_bundle_comparison(catalog)
        if args.run_fixtures:
            report["fixtureExecution"] = run_supplement_fixtures()
            report["verification"]["scriptsExecuted"] = report["fixtureExecution"]["processExecutions"]
        anchors = [*report["runtimeEvidence"], *report["workflowEvidence"],
                   "desktop/src/skill-library.ts", "desktop/test/science-skills.test.ts",
                   "desktop/skill-library/science-import-report.json", report["historicalEvidence"]["path"],
                   "omicslab/execution/science_audit.py", "scripts/audit_science_capabilities.py",
                   "tests/test_science_capability_audit.py", "tests/test_research_quests.py",
                   "omicslab/execution/science_workbench.py", "omicslab/skills/primer-design/SKILL.md",
                   "omicslab/skills/primer-design/scripts/primer_check.py", "omicslab/skills/vector-design/SKILL.md",
                   "omicslab/skills/vector-design/scripts/validate_construct.py"]
        report["sourceHashes"] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(anchors))}
        if args.evidence:
            if args.evidence.stat().st_size > 4_000_000:
                raise ValueError("Evidence exceeds 4 MB budget")
            evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
            report["evidenceAudit"] = audit_evidence(evidence, catalog.by_id)
        if args.output:
            documents = {"science-capabilities.json": json.dumps(report, ensure_ascii=True, indent=2) + "\n",
                         "science-capabilities.md": render_markdown(report)}
            if args.check:
                if any(not (args.output / p).is_file() or (args.output / p).read_text(encoding="utf-8") != content
                       for p, content in documents.items()):
                    print("Scientific capability audit documents are stale", file=sys.stderr)
                    return 1
            else:
                args.output.mkdir(parents=True, exist_ok=True)
                for path, content in documents.items():
                    (args.output / path).write_text(content, encoding="utf-8", newline="\n")
        print(json.dumps(report.get("evidenceAudit") or {
            "kind": report["kind"], "domains": len(report["domains"]), "scenarios": len(report["scenarios"]),
            "verification": report["verification"], "liveVerifiedThisAudit": False}, ensure_ascii=True))
        return 0 if report.get("evidenceAudit", {}).get("passed", True) else 1
    except (OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
        print(f"Scientific capability audit failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
