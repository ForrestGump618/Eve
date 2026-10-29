"""Offline catalog and evidence checks; never execute skills or contact services.

Evidence must come from trusted, paired tool calls and adapter observations.
These checks establish trace consistency and retrieved identifier presence, not
remote existence, scientific validity, or authenticity of an uploaded trace.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import unquote, urlsplit


DOMAIN_SKILLS = {
    "AlphaGenome": ("science-alphagenome-single-variant-analysis", "science-alphagenome-variant-impact-score", "science-alphagenome-atlas-website-links"),
    "ClinVar": ("science-clinvar-database",),
    "gnomAD": ("science-gnomad-database",),
    "GTEx": ("science-gtex-database",),
    "Ensembl": ("science-ensembl-database",),
    "AFDB": ("science-alphafold-database-fetch-and-analyze",),
    "UniProt": ("science-uniprot-database",),
    "PDB": ("science-pdb-database",),
    "Foldseek": ("science-foldseek-structural-search",),
    "PyMOL": ("science-pymol",),
    "ChEMBL": ("science-chembl-database",),
    "PubChem": ("science-pubchem-database",),
    "Open Targets": ("science-opentargets-database",),
    "PubMed": ("science-pubmed-database",),
    "bioRxiv": ("science-literature-search-biorxiv",),
    "Europe PMC": ("science-literature-search-europepmc",),
    "OpenAlex": ("science-literature-search-openalex",),
}
LITERATURE = frozenset(DOMAIN_SKILLS[x][0] for x in ("PubMed", "bioRxiv", "Europe PMC", "OpenAlex"))
SCENARIOS = {
    "literature_reproduction": {
        "skills": (*sorted(LITERATURE), "literature-review", "citation-management"),
        "existing": "Retrieval scripts, DOI registration checker resources, reproduction plan, ordered research stages, artifact hashes, metric contract, human finalization.",
        "missing": "Plans and saved artifacts do not prove citation identity, claim support, full-text review, or a reproduced numerical result. Generic review scripts have no declared scientific runtime entry.",
        "supplement": "Use this audit on paired execution observations and citations; fetch titled metadata. Preserve source, data/code versions, environment, comparison tolerances and human review separately.",
    },
    "primers_cloning": {
        "skills": ("primer-design", "science-ncbi-sequence-fetch", "experimental-design"),
        "existing": "Imported Primer3 resources and sequence retrieval, plus new optional standalone primer_check.py and validate_construct.py workspace CLIs with focused executed fixtures.",
        "missing": "Local wrappers are available as lazy catalog entries science-primer-reference-check and science-construct-validation. Exact single-reference primer products do not establish assay specificity; vector reference/junction/CDS checks do not establish wet-lab assembly success.",
        "supplement": "Implemented: real optional Primer3 design/Tm/hairpin/dimer calculations with explicit missing-dependency failure; both-strand exact amplicon coordinates and tails; tiled reference matching, circular junctions, strand/phase/CDS translation checks. Preserve source provenance and complete broader specificity/wet-lab validation separately.",
    },
    "omics_deterministic_scripts": {
        "skills": ("scanpy", "pydeseq2", "anndata", "science-bio-nextflow-development", "science-bio-single-cell-rna-qc", "science-bio-scvi-tools"),
        "existing": "Bounded deterministic FASTQ/count intake; Scanpy/PyDESeq2 script resources; declared Nextflow helper and scvi entries; QC library resources; artifact and metric contracts.",
        "missing": "An imported script or seed is not a deterministic pipeline. Scanpy/PyDESeq2 lack declared scientific entries; single-cell QC entries are empty. No matched repeat-run dataset/environment/output comparison is established by this audit.",
        "supplement": "Reuse existing science_workbench.inspect_scientific(kind='counts') for deterministic matrix QC; --run-fixtures executes repeat-run and invalid-matrix checks without duplicating QC logic. Full analysis still needs pinned inputs/environment/design and scientific output comparisons.",
    },
}


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def resource_digest(skill: dict) -> str:
    """Match prepare_resources without reading or expanding any resource bodies."""
    return _digest(json.dumps(sorted(skill["files"].items()), separators=(",", ":")).encode())


class ScienceCatalog:
    """Metadata-only discovery with explicit, bounded reads for selected resources."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        path = self.directory / "index.json"
        if path.stat().st_size > 16_000_000:
            raise ValueError("Catalog exceeds audit budget")
        raw = path.read_bytes()
        self.index = json.loads(raw.decode("utf-8"))
        if self.index.get("version") != 1 or not isinstance(self.index.get("skills"), list):
            raise ValueError("Unsupported science catalog")
        self.index_sha256 = _digest(raw)
        self.by_name = {s["name"]: s for s in self.index["skills"]}
        self.by_id = {s["id"]: s for s in self.index["skills"]}
        if len(self.by_id) != len(self.index["skills"]) or len(self.by_name) != len(self.by_id):
            raise ValueError("Duplicate catalog identity")
        self.resource_reads = 0

    def verify_pack(self) -> str:
        path = self.directory / "library.pack"
        if path.stat().st_size > 256_000_000:
            raise ValueError("Pack exceeds audit budget")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1_000_000), b""):
                digest.update(block)
        if digest.hexdigest() != self.index["packSha256"]:
            raise ValueError("Pack digest mismatch")
        return digest.hexdigest()

    def read_resource(self, name: str, path: str) -> str:
        sha = self.by_name[name]["files"][path]
        ref = self.index["objects"][sha]
        offset, length, size = (ref[k] for k in ("offset", "length", "bytes"))
        if (any(type(x) is not int for x in (offset, length, size)) or offset < 0
                or not 1 <= length <= 2_100_000 or not 0 <= size <= 2_000_000):
            raise ValueError("Invalid resource bounds")
        with (self.directory / "library.pack").open("rb") as stream:
            stream.seek(offset)
            compressed = stream.read(length)
        if len(compressed) != length:
            raise ValueError("Truncated resource")
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
            data = stream.read(2_000_001)
        if len(data) != size or _digest(data) != sha:
            raise ValueError("Resource digest mismatch")
        self.resource_reads += 1
        return data.decode("utf-8")


def capability_report(catalog: ScienceCatalog, *, verify_resources: bool = False) -> dict:
    def describe(name):
        skill = catalog.by_name.get(name)
        if skill is None:
            return {"name": name, "status": "missing"}
        runtime = skill.get("runtime") or {}
        scripts = runtime.get("scripts", [])
        return {"name": name, "id": skill["id"], "originLayer": "original_packed_catalog", "status": "declared_scripts" if scripts else "instructions_and_resources",
                "source": skill["source"], "version": skill["version"], "instructionSha256": skill["sha256"],
                "resourceDigest": resource_digest(skill), "scripts": scripts,
                "scriptResources": sorted(p for p in skill["files"] if p.startswith("scripts/") and p.endswith(".py")),
                "requiredCredentials": runtime.get("requiredCredentials", []),
                "optionalCredentials": runtime.get("optionalCredentials", []),
                "externalRequirements": runtime.get("externalRequirements", []),
                "liveVerifiedThisAudit": False}

    domains = []
    for domain, names in DOMAIN_SKILLS.items():
        missing = "Live API behavior and scientific correctness were not exercised."
        supplement = "Validate a bounded reference query on the bound backend and read back its identifiers and output."
        if domain == "AlphaGenome":
            missing = "Prediction credentials/service execution unverified; atlas links alone are not model predictions."
            supplement = "Use explicit assembly/alleles/tissue and API terms; verify prediction with valid credentials and preserve raw outputs."
        elif domain == "PyMOL":
            missing = "Instructions only: no declared Python entry; PyMOL/OSMesa and actual rendering unverified."
            supplement = "Review a workspace rendering script and validate atom count, PNG and PSE read-back on the bound host."
        elif domain == "Foldseek":
            supplement = "Supply a real coordinate file; verify returned structural hits and search status, not a protein name alone."
        elif domain == "Europe PMC":
            supplement = "Record that this imported search appends OPEN_ACCESS:y; it is not unrestricted PubMed coverage."
        if domain in {"Europe PMC", "PubChem", "ChEMBL", "GTEx", "UniProt"}:
            missing = "Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query."
        domains.append({"domain": domain, "existing": [describe(n) for n in names], "missing": missing, "supplement": supplement})
    scenarios = [{"id": key, **{k: v for k, v in item.items() if k != "skills"},
                  "catalog": [describe(n) for n in item["skills"]]} for key, item in SCENARIOS.items()]
    checked = 0
    pack_status = "not_requested"
    if verify_resources:
        catalog.verify_pack()
        pack_status = "sha256_matched"
        selected = {n for names in DOMAIN_SKILLS.values() for n in names}
        selected.update(n for item in SCENARIOS.values() for n in item["skills"])
        for name in sorted(selected & catalog.by_name.keys()):
            skill = catalog.by_name[name]
            if skill["files"].get("SKILL.md") != skill["sha256"]:
                raise ValueError("Instruction digest declaration mismatch")
            if any(p not in skill["files"] for p in (skill.get("runtime") or {}).get("scripts", [])):
                raise ValueError("Declared script resource missing")
            for path in sorted(skill["files"]):
                catalog.read_resource(name, path)
                checked += 1
    return {"schemaVersion": 1, "kind": "offline source/catalog audit", "liveVerifiedThisAudit": False,
            "indexSha256": catalog.index_sha256, "packSha256": catalog.index["packSha256"],
            "sources": catalog.index.get("sources", []),
            "verification": {"pack": pack_status, "selectedResourceHashesChecked": checked,
                             "resourceBodyReads": catalog.resource_reads, "scriptsExecuted": 0},
            "runtimeEvidence": ["omicslab/execution/science_skills.py", "omicslab/execution/skill_resources.py",
                                "tests/test_science_skill_runtime.py", "tests/test_science_workbench.py"],
            "workflowEvidence": ["desktop/src/agent-tools.ts", "desktop/src/harness/agent-loop.ts",
                                 "omicslab/suwen/research.py", "tests/test_research_quests.py"],
            "historicalEvidence": {"path": "docs/verification/science-skills/results.json",
                                   "scope": "Prior recorded preparation of 40 skills and five public queries; not rerun here and not verification of all requested domains."},
            "parentReportedLiveValidation": {"source": "Parent/user report in this chat after main runtime fixes",
                                             "passed": 45, "total": 45, "preparations": 40, "liveQueries": 5,
                                             "services": ["Europe PMC", "PubChem", "ChEMBL", "GTEx", "UniProt"],
                                             "rerunByThisAudit": False},
            "domains": domains, "scenarios": scenarios,
            "supplementImplemented": ["Paired call/result execution gate against catalog identity and resource digest.",
                                      "Citation identifier membership in titled records from successful declared literature script output.",
                                      "Offline CLI with failing exit status for invalid supplied evidence.",
                                      "Optional standalone primer CLI with real Primer3 design/thermodynamics and bounded local exact products.",
                                      "Standalone vector reference tiling, junction, circular-coordinate and CDS frame/protein checks.",
                                      "Executed fixture option reuses existing matrix QC; does not implement a second matrix analyzer."],
            "localSupplements": {
                "originLayer": "new_optional_workspace_scripts",
                "primer": "omicslab/skills/primer-design/scripts/primer_check.py",
                "vector": "omicslab/skills/vector-design/scripts/validate_construct.py",
                "matrixQC": "omicslab.execution.science_workbench.inspect_scientific",
                "desktopPackaging": "Source execution verified by fixtures; the separate release report covers the compressed catalog and packaged runtime.",
                "dispatch": "Lazy compressed resource entries dispatched by the bound scientific adapter."},
            "limitations": ["Standalone audit only; no new live agent-loop or research-stage enforcement.",
                            "Trace authenticity is a caller trust boundary; forged observations are not detectable.",
                            "Identifier membership is not remote existence, DOI registration, title identity review, retraction screening or claim entailment.",
                            "Citation checks accept JSON stdout or the adapter's fresh declared-output read-back wrapper; bare file logs, XML and truncated records are not accepted.",
                            "No model acceptance, wet-lab validation, scientific reproduction or cross-platform execution claimed."]}


def check_execution(observation: dict, skill: dict, workspace: str) -> dict:
    """Check an unmodified adapter result paired with its original call arguments."""
    reasons = []
    if not isinstance(observation, dict):
        return {"passed": False, "reasons": ["Invalid observation"]}
    call_id = observation.get("callId")
    if not isinstance(call_id, str) or not 1 <= len(call_id) <= 200:
        reasons.append("Missing bounded callId")
    if observation.get("operation") not in {"skill_run", "run_science_skill"}:
        reasons.append("Preparation/planning is not execution")
    arguments = observation.get("arguments")
    arguments = arguments if isinstance(arguments, dict) else {}
    inputs = arguments.get("input")
    inputs = inputs if isinstance(inputs, dict) else {}
    runtime = skill.get("runtime") or {}
    if arguments.get("id") != skill["id"] or inputs.get("script") not in runtime.get("scripts", []):
        reasons.append("Call must select this catalog skill and a declared script")
    args = inputs.get("args", [])
    if (not isinstance(args, list) or len(args) > 60
            or any(not isinstance(a, str) or len(a) > 4000 or any(c in a for c in "\0\r\n") for a in args)):
        reasons.append("Invalid bounded arguments")
    elif any(a in {"--help", "-h", "--version"} for a in args):
        reasons.append("Help/version is not scientific execution evidence")
    result = observation.get("result")
    result = result if isinstance(result, dict) else {}
    for key, expected in (("skillId", skill["id"]), ("sha256", skill["sha256"]),
                          ("version", skill["version"]), ("source", skill["source"]),
                          ("resourceDigest", resource_digest(skill)), ("workspace", workspace)):
        if result.get(key) != expected:
            reasons.append("Mismatched " + key)
    if (result.get("executed") is not True or result.get("ok") is not True or result.get("status") != "executed"
            or type(result.get("exitCode")) is not int or result.get("exitCode") != 0
            or result.get("timedOut") is not False or result.get("truncated") is not False or result.get("error")):
        reasons.append("No complete successful adapter execution")
    stdout = result.get("stdout")
    if not isinstance(stdout, str) or not stdout.strip() or len(stdout.encode("utf-8")) > 28000:
        reasons.append("Missing or over-budget stdout")
    else:
        try:
            data = json.loads(stdout)
        except (ValueError, RecursionError):
            data = None
        if isinstance(data, dict) and "artifactEvidence" in data:
            artifacts = data["artifactEvidence"]
            declared_outputs = []
            if isinstance(args, list) and all(isinstance(a, str) for a in args):
                for i, arg in enumerate(args):
                    if arg in ("--output", "-o") and i + 1 < len(args):
                        declared_outputs.append(args[i + 1])
                    elif arg.startswith(("--output=", "-o=")):
                        declared_outputs.append(arg.split("=", 1)[1])
            path_type = PureWindowsPath if re.match(r"^[A-Za-z]:|^\\\\", workspace) else PurePosixPath
            def relative_output(value):
                path = path_type(value)
                if path.is_absolute():
                    path = path.relative_to(path_type(workspace))
                if path.drive or ".." in path.parts or not path.parts:
                    raise ValueError("Output path outside expected workspace")
                return path
            try:
                outputs = [relative_output(p) for p in declared_outputs]
                if (not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 20
                        or artifacts != result.get("artifactEvidence")
                        or any(not isinstance(a, dict) or a.get("fresh") is not True
                               or not isinstance(a.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", a["sha256"])
                               or type(a.get("bytes")) is not int or not 0 < a["bytes"] <= 2_000_000
                               or not isinstance(a.get("path"), str) or relative_output(a["path"]) not in outputs
                               for a in artifacts)):
                    reasons.append("Invalid fresh declared output artifact evidence")
            except (ValueError, TypeError):
                reasons.append("Invalid declared output path")
            data = data.get("output")
        if isinstance(data, dict) and (data.get("error") or data.get("ok") is False
                                      or data.get("status") in ("failed", "error", "blocked")):
            reasons.append("Structured scientific error")
    return {"callId": call_id, "skillId": skill["id"], "script": inputs.get("script"),
            "passed": not reasons, "reasons": reasons}


def normalize_citation(value: str) -> str:
    """Normalize explicit identifiers, retaining legal DOI suffix punctuation."""
    if not isinstance(value, str) or not 1 <= len(value) <= 1000:
        raise ValueError("A bounded citation identifier is required")
    value = value.strip()
    if value.lower().startswith(("https://", "http://")):
        url = urlsplit(value)
        if url.username or url.password or url.port or url.query or url.fragment:
            raise ValueError("Use a canonical identifier URL")
        host, path = url.hostname, unquote(url.path)
        if host in {"doi.org", "dx.doi.org"}:
            value = path[1:]
        elif host == "pubmed.ncbi.nlm.nih.gov":
            value = "PMID:" + path.strip("/")
        elif host == "pmc.ncbi.nlm.nih.gov" and path.startswith("/articles/"):
            value = path[len("/articles/"):].strip("/")
        elif host == "openalex.org":
            value = "OPENALEX:" + path.strip("/")
        else:
            raise ValueError("Unsupported citation URL")
    value = re.sub(r"^doi:\s*", "", value, flags=re.I)
    if re.fullmatch(r"10\.\d{4,9}/[^\s<>\x00-\x1f]+", value):
        return "doi:" + value.lower()
    if re.fullmatch(r"PMID:[1-9]\d{0,9}", value, re.I):
        return value.upper()
    if re.fullmatch(r"PMC[1-9]\d{0,9}", value, re.I):
        return value.upper()
    if re.fullmatch(r"OPENALEX:W[1-9]\d{0,19}", value, re.I):
        return value.upper()
    raise ValueError("Unsupported or malformed citation identifier")


def _retrieved_identifiers(stdout: str) -> set[str]:
    try:
        data = json.loads(stdout)
    except (ValueError, RecursionError):
        return set()
    if isinstance(data, dict) and "artifactEvidence" in data:
        # check_execution already validated the adapter's fresh read-back marker.
        data = data.get("output")
    found = set()

    def add(value):
        try:
            found.add(normalize_citation(value))
        except ValueError:
            pass

    def visit(value, depth=0):
        if depth > 8:
            raise ValueError("Citation record nesting exceeds audit budget")
        if isinstance(value, list):
            if len(value) > 1000:
                raise ValueError("Too many citation records")
            for item in value:
                visit(item, depth + 1)
        elif isinstance(value, dict):
            if value.get("error") or value.get("ok") is False or value.get("status") in ("failed", "error", "blocked"):
                return
            title = value.get("title") or value.get("display_name")
            if isinstance(title, str) and title.strip():
                add(value.get("doi"))
                pmid = value.get("pmid")
                if isinstance(pmid, (str, int)) and type(pmid) is not bool:
                    add("PMID:" + str(pmid))
                add(value.get("pmcid"))
                identifier = value.get("id")
                if value.get("source") == "MED" and isinstance(identifier, str):
                    add("PMID:" + identifier)
                elif value.get("source") == "PMC":
                    add(identifier)
                elif isinstance(identifier, str) and identifier.startswith("https://openalex.org/W"):
                    add(identifier)
                ids = value.get("ids")
                if isinstance(ids, dict):
                    for key in ("doi", "pmid", "pmcid", "openalex"):
                        add(ids.get(key))
            for key in ("results", "resultList", "result", "collection", "articles"):
                if key in value:
                    visit(value[key], depth + 1)
    visit(data)
    return found


def audit_evidence(evidence: dict, skills: dict[str, dict]) -> dict:
    """Reject incomplete evidence; a pass is deliberately narrower than task completion."""
    if not isinstance(evidence, dict):
        raise ValueError("Evidence must be an object")
    workspace, required = evidence.get("workspace"), evidence.get("requiredSkillIds")
    observations, citations = evidence.get("observations"), evidence.get("citations")
    if (not isinstance(workspace, str) or not 1 <= len(workspace) <= 2000
            or not isinstance(required, list) or not 1 <= len(required) <= 100
            or any(not isinstance(k, str) or k not in skills for k in required)
            or len(set(required)) != len(required)):
        raise ValueError("Specify workspace and unique known requiredSkillIds")
    if (not isinstance(observations, list) or len(observations) > 100
            or not isinstance(citations, list) or len(citations) > 100):
        raise ValueError("Observations and citations must be bounded lists")
    checks, seen, completed, identifiers, reasons = [], set(), set(), set(), []
    for observation in observations:
        args = observation.get("arguments") if isinstance(observation, dict) else None
        skill_id = args.get("id") if isinstance(args, dict) else None
        if not isinstance(skill_id, str) or skill_id not in required:
            reasons.append("Observation does not belong to a required skill")
            continue
        check = check_execution(observation, skills[skill_id], workspace)
        call_id = check.get("callId")
        if isinstance(call_id, str):
            if call_id in seen:
                check["reasons"].append("Duplicate callId")
                check["passed"] = False
            seen.add(call_id)
        checks.append(check)
        if check["passed"]:
            completed.add(skill_id)
            if skills[skill_id]["name"] in LITERATURE:
                identifiers.update(_retrieved_identifiers(observation["result"]["stdout"]))
    missing = sorted(set(required) - completed)
    if missing:
        reasons.append("Missing successful required skill executions")
    if any(not c["passed"] for c in checks):
        reasons.append("Execution trace checks failed")
    if not citations and any(skills[k]["name"] in LITERATURE for k in required):
        reasons.append("Literature evidence requires cited retrieved identifiers")
    citation_checks = []
    for citation in citations:
        try:
            normalized = normalize_citation(citation)
            passed = normalized in identifiers
        except ValueError:
            normalized, passed = None, False
        citation_checks.append({"citation": citation, "normalized": normalized, "presentInRetrievedRecords": passed})
    if any(not c["presentInRetrievedRecords"] for c in citation_checks):
        reasons.append("Citation absent from successful titled retrieval records")
    return {"passed": not reasons, "scientificStatus": "unverified", "liveVerified": False,
            "scope": "Trusted trace consistency and retrieved identifier presence only",
            "executions": checks, "missingSkillIds": missing, "citations": citation_checks, "reasons": reasons}
