# Scientific capability audit

This is an offline source/catalog audit. No live service, scientific reproduction, model, SSH host or wet-lab outcome was verified in this run.

## Reproduce

Run from the repository root:

```powershell
python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade
python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade --check
python -m pytest -q tests/test_science_capability_audit.py tests/test_science_skill_runtime.py tests/test_science_workbench.py tests/test_research_quests.py
```

The first command generates this file and science-capabilities.json. --check compares both files without writing them. Without --verify-resources, discovery reads only index metadata; no skill bodies are expanded. Explicit resource verification streams the pack hash and checks only mapped resources. It never imports their Python modules. --run-fixtures additionally executes bounded local synthetic sequence CLIs and reuses the existing matrix QC.

## Snapshot

- Index SHA-256: `f9fc77936b4b7e8f3040ba27569c0ec1e6c5f7b286d67e9c89bc90b2d229159c`.
- Pack SHA-256: `ea3f4b674af682c32ea06e2b4c308a57926b08226040030782df783b00851c2c`; check: `sha256_matched`.
- Selected resource hashes checked: 351; scripts executed by the audit: 0.
- Imported Google DeepMind bundle: 1.3.1, commit `4de6786171f1479026da5d3a00f110703c8ba35e` (40 skills, 65 declared scripts in the inspected import report).
- Historical acceptance: docs/verification/science-skills/results.json records preparation of 40 skills and five public queries (Europe PMC, PubChem, ChEMBL, GTEx, UniProt). These are prior observations, not rerun results. That earlier pack digest predates additional catalog imports.

- Current parent-reported main validation: 45/45 (40 preparations plus five live upstream queries: Europe PMC, PubChem, ChEMBL, GTEx, UniProt). This is attributed to the parent's report and was not independently rerun by this audit.

## Existing, missing and supplement

Declared scripts are dispatchable catalog entries, not proof that dependencies, credentials, endpoints, outputs or scientific interpretation work. Instructions/resources remain useful through explicit skill loading and authorized workspace execution, but do not imply a skill_run entry.

| Domain | Existing catalog entries (declared scripts) | Missing verification/capability | Supplement |
| --- | --- | --- | --- |
| AlphaGenome | `science-alphagenome-single-variant-analysis` (7; declared_scripts); `science-alphagenome-variant-impact-score` (1; declared_scripts); `science-alphagenome-atlas-website-links` (1; declared_scripts) | Prediction credentials/service execution unverified; atlas links alone are not model predictions. | Use explicit assembly/alleles/tissue and API terms; verify prediction with valid credentials and preserve raw outputs. |
| ClinVar | `science-clinvar-database` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| gnomAD | `science-gnomad-database` (3; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| GTEx | `science-gtex-database` (1; declared_scripts) | Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| Ensembl | `science-ensembl-database` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| AFDB | `science-alphafold-database-fetch-and-analyze` (3; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| UniProt | `science-uniprot-database` (1; declared_scripts) | Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| PDB | `science-pdb-database` (4; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| Foldseek | `science-foldseek-structural-search` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Supply a real coordinate file; verify returned structural hits and search status, not a protein name alone. |
| PyMOL | `science-pymol` (0; instructions_and_resources) | Instructions only: no declared Python entry; PyMOL/OSMesa and actual rendering unverified. | Review a workspace rendering script and validate atom count, PNG and PSE read-back on the bound host. |
| ChEMBL | `science-chembl-database` (1; declared_scripts) | Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| PubChem | `science-pubchem-database` (1; declared_scripts) | Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| Open Targets | `science-opentargets-database` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| PubMed | `science-pubmed-database` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| bioRxiv | `science-literature-search-biorxiv` (2; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |
| Europe PMC | `science-literature-search-europepmc` (1; declared_scripts) | Parent reports a bounded live upstream query passed; broader domain behavior and scientific correctness remain unverified. This audit did not rerun the query. | Record that this imported search appends OPEN_ACCESS:y; it is not unrestricted PubMed coverage. |
| OpenAlex | `science-literature-search-openalex` (1; declared_scripts) | Live API behavior and scientific correctness were not exercised. | Validate a bounded reference query on the bound backend and read back its identifiers and output. |

## Original source versus runnable supplements

The primer/vector CLIs are also declared lazy execution entries: science-primer-reference-check and science-construct-validation. Their compressed resources are generated by desktop/scripts/import-eve-supplements.py and executed through the existing bound scientific adapter. The original upstream primer-design entry remains intact.

Measured against tracked source HEAD `3f630ec973a895a1f08fd7e4cb8ec91f49cc158b`: 373 total catalog skills; 40 Google DeepMind science skills and 65 declared scripts. External resource pack unchanged: False; external resource growth: 15241 bytes.

| Main asset | Original bytes | Current bytes | Growth bytes | SHA-256 identical |
| --- | ---: | ---: | ---: | --- |
| index.json | 1210386 | 1213218 | 2832 | False |
| library.pack | 12232630 | 12245039 | 12409 | False |

External resource growth is reported independently of the main JavaScript bundle. tests/test_science_supplement_runtime.py executes the compressed primer entry through the native adapter. Installed-package validation is recorded separately in the release report.

Dependency status: the exact-reference primer checker, vector validator and existing matrix QC use the standard library. Primer design and thermodynamics require optional primer3-py. Primer3 is an optional dependency; the fixtureExecution.primer3 field records whether the current audit actually exercised it.


## Three scenarios

### literature_reproduction

Existing: Retrieval scripts, DOI registration checker resources, reproduction plan, ordered research stages, artifact hashes, metric contract, human finalization.

Missing: Plans and saved artifacts do not prove citation identity, claim support, full-text review, or a reproduced numerical result. Generic review scripts have no declared scientific runtime entry.

Supplement: Use this audit on paired execution observations and citations; fetch titled metadata. Preserve source, data/code versions, environment, comparison tolerances and human review separately.

Catalog evidence: `science-literature-search-biorxiv` (declared_scripts); `science-literature-search-europepmc` (declared_scripts); `science-literature-search-openalex` (declared_scripts); `science-pubmed-database` (declared_scripts); `literature-review` (instructions_and_resources); `citation-management` (instructions_and_resources).

### primers_cloning

Existing: Imported Primer3 resources and sequence retrieval, plus new optional standalone primer_check.py and validate_construct.py workspace CLIs with focused executed fixtures.

Missing: Local wrappers are available as lazy catalog entries science-primer-reference-check and science-construct-validation. Exact single-reference primer products do not establish assay specificity; vector reference/junction/CDS checks do not establish wet-lab assembly success.

Supplement: Implemented: real optional Primer3 design/Tm/hairpin/dimer calculations with explicit missing-dependency failure; both-strand exact amplicon coordinates and tails; tiled reference matching, circular junctions, strand/phase/CDS translation checks. Preserve source provenance and complete broader specificity/wet-lab validation separately.

Catalog evidence: `primer-design` (instructions_and_resources); `science-ncbi-sequence-fetch` (declared_scripts); `experimental-design` (instructions_and_resources).

### omics_deterministic_scripts

Existing: Bounded deterministic FASTQ/count intake; Scanpy/PyDESeq2 script resources; declared Nextflow helper and scvi entries; QC library resources; artifact and metric contracts.

Missing: An imported script or seed is not a deterministic pipeline. Scanpy/PyDESeq2 lack declared scientific entries; single-cell QC entries are empty. No matched repeat-run dataset/environment/output comparison is established by this audit.

Supplement: Reuse existing science_workbench.inspect_scientific(kind='counts') for deterministic matrix QC; --run-fixtures executes repeat-run and invalid-matrix checks without duplicating QC logic. Full analysis still needs pinned inputs/environment/design and scientific output comparisons.

Catalog evidence: `scanpy` (instructions_and_resources); `pydeseq2` (instructions_and_resources); `anndata` (instructions_and_resources); `science-bio-nextflow-development` (declared_scripts); `science-bio-single-cell-rna-qc` (instructions_and_resources); `science-bio-scvi-tools` (declared_scripts).

## Runnable local supplements

- Primer: `python omicslab/skills/primer-design/scripts/primer_check.py check --reference target.fa --config assay.json`; use `design` or `--thermodynamics` for real optional Primer3 calculations.
- Vector: `python omicslab/skills/vector-design/scripts/validate_construct.py --construct construct.fa --config construct.json`; validates reference tiling, all declared junctions including circular closure, and CDS strand/phase/start/stop/protein.
- Matrix QC: `omicslab.execution.science_workbench.inspect_scientific({workspace, kind: 'counts', path})`; existing implementation is reused, not duplicated.
- Each sequence CLI hashes script/config/reference inputs, emits deterministic JSON and exits 2 on failed checks. Optional output files must be new. Input contracts and calculation limits are in the two local SKILL.md files. No automatic JS catalog entry or dependency installation was added.

Execute fixtures without adding optional dependencies: `python scripts/audit_science_capabilities.py --run-fixtures --verify-resources --output docs/verification/platform-upgrade`.

To include real Primer3 2.3.1 execution in an explicitly isolated optional environment:

```powershell
uv run --no-config --no-project --with primer3-py==2.3.1 python scripts/audit_science_capabilities.py --run-fixtures --verify-resources --output docs/verification/platform-upgrade
```

Use the same fixture flag and optional environment with --check to reproduce the JSON snapshot. Dependency resolution belongs to the explicit uv command; the audit and wrappers never install packages or query services themselves.

## Callable gate API for parent integration

`check_execution(observation, skill_metadata, workspace) -> {passed, reasons, callId, skillId, script}` checks a paired run/result against metadata and resource digests. `audit_evidence({workspace, requiredSkillIds, observations, citations}, skills_by_id) -> {passed, executions, citations, missingSkillIds, reasons, scientificStatus, liveVerified}` combines required executions and citation membership. These functions are in omicslab.execution.science_audit; neither loads skill bodies nor executes tools. Invalid top-level contracts raise ValueError; failed evidence returns passed=false. Parent integration must supply trusted observations, enforce this result in its gate and retain human/scientific review separately.

## Bounded correctness gates

The new omicslab/execution/science_audit.py is a standalone audit module used by this command. It does not alter the adapter, lazy loading, scheduler, agent loop or research state machine. Its checks are not automatically enforced on ordinary chat answers or research_record.

An evidence file contains the expected workspace, required catalog skill IDs, original paired tool calls/results, and explicit DOI/PMID/PMCID/OpenAlex citations. Use trusted, unmodified observations from the bound backend. The call arguments retain the model-facing id/input shape for both operation names; a raw backend bundle must be normalized to its id by the trusted exporter.

```json
{"workspace":"<exact adapter workspace>","requiredSkillIds":["<catalog id>"],"observations":[{"callId":"<original call id>","operation":"skill_run","arguments":{"id":"<catalog id>","input":{"script":"scripts/pubmed_api.py","args":["<actual arguments>"]}},"result":{"<paste the complete adapter result>":""}}],"citations":["PMID:12345678"]}
```

This shape is illustrative and intentionally fails until populated with actual catalog identity, command arguments and the complete adapter result. The command exits nonzero for malformed evidence or failed gates:

```powershell
python scripts/audit_science_capabilities.py --evidence paired-tool-evidence.json
```

The execution gate requires every requested skill to have a successful declared script call, paired call ID, exact catalog identity/version/source/instruction and resource digests, expected workspace, executed=true, ok=true, exit code zero, complete stdout, no timeout/truncation and no structured top-level error. Preparation, planning, help/version calls, unrelated skills, duplicate calls, missing flags and failed observations are rejected.

The citation gate parses bounded JSON stdout or the adapter's verified JSON artifact read-back from successful declared PubMed/bioRxiv/Europe PMC/OpenAlex calls. It checks explicit identifier fields in titled records and supported result collections, including Europe PMC MED/PMC IDs and OpenAlex ids. A bare PMID search list, plausible prose URL, identifier echoed in an abstract, empty results, or an error record is insufficient. DOI case and canonical identifier URLs normalize; legal DOI punctuation is retained. Literature checks require at least one cited identifier.

For synthesized read-back stdout, artifactEvidence must match the adapter result, name a declared --output/-o path in the expected workspace, have a fresh flag, bounded nonempty byte count and SHA-256 identity. Only its output field supplies citation records; nested scientific errors are rejected. The adapter is the trusted source of the raw-file hash; this offline audit cannot recompute raw bytes from parsed JSON. Unmarked file-only logs, XML and recovered truncated output remain incomplete. Do not manually substitute file contents for an original trace.

Passing means trace consistency and identifier presence in retrieved metadata. It does not independently resolve DOI registration/existence, establish title identity, full-text access, claim support, corrections/retractions, reproduction success, assay specificity or determinism. The existing literature-review/scripts/verify_citations.py resource performs bounded DOI handle checks and Crossref metadata retrieval, but lacks a declared scientific runtime entry. Its existence checks and a manual source/claim comparison remain separate.

## Source and test anchors

- desktop/src/skill-library.ts and desktop/test/science-skills.test.ts: metadata discovery, explicit body reads, load-before-run and bound-backend routing.
- omicslab/execution/skill_resources.py and science_skills.py: resource verification, credential presence, bounded argv/process execution, offline dependency default and output error handling. Dependency offline mode does not block a script's own network requests.
- desktop/src/agent-tools.ts: literature_reproduction_plan, experimental_design_plan and multiomics_inventory remain plans/intake with scientific_status=unverified.
- desktop/src/harness/agent-loop.ts: existing generic URL provenance checks do not decode scientific JSON stdout into citation identity proof.
- omicslab/suwen/research.py and tests/test_research_quests.py: ordered artifact/metric contracts and human finalization; recorded evidence remains scientific_status=unverified.
- tests/test_science_capability_audit.py: local regressions for catalog laziness/integrity, actual fixture adapter execution, forged/stale identities, incomplete/error/help traces, malformed budgets and cited record membership. No live API fixture is passed off as a database result.

Exact source and test file hashes for this snapshot are recorded in the JSON companion. Test commands must be rerun to establish current results; this generated document does not infer test success from test-file presence.
