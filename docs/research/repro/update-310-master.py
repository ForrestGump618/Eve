# -*- coding: utf-8 -*-
"""Patch docs/requirements/master-requirements.csv with verified 3.1.0 evidence.

Only rows whose status/evidence changed are touched; other columns preserved.
Evidence source: Lead-measured 2026-10-25 runs in TARGET_ROOT (tsc/build, npm test 150/148/2,
e2e-rpc 42/0, packaged smoke 8/8, ui-dom-qa 19/0/10, installer bytes+sha256, brand scan, legacy import
inspect) and docs/verification/chaos-results.json.
"""
import csv
import io
import os

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
P = os.path.join(D, "docs/requirements/master-requirements.csv")

E_UNIT = "npm test: 150 tests / 148 pass / 0 fail / 2 skipped, ~38 s, exit 0 (tsc build then node --test dist/test/*.test.js); 2 skips = Windows symlink EPERM in research-worker test + optional legacy Python workbench deps unavailable"
E_E2E = "node scripts/e2e-rpc.mjs --dist dist --live: 42 passed / 0 failed / ~7 s against real detached daemon over authenticated named pipe"
E_SMOKE = "SUWEN_SMOKE_PACKAGED=1 node scripts/electron-smoke.mjs: exit 0, 8/8 checks, 98 s; artifact desktop/release/smoke/work/electron-e2e-result.json; screenshots release/smoke/outputs/SuWen-{preview,tools}.png"
E_UI = "node scripts/ui-dom-qa.mjs: 19 passed / 0 failed / 10 warnings; node --check desktop/ui/app.js exit 0; ui/actions.json 142 actions; contract RPC_METHODS 79"
E_INST = ("real NSIS x64 `desktop/release/SuWen-Setup-3.1.0-win-x64.exe`, 129,424,645 bytes, "
          "SHA256 82779B90C3A0A792C2B1879D4DF184579697C6DB698BB3BB1D153B671326B70F (verified by Get-FileHash in TARGET); "
          "+ .blockmap 135,955 B; win-unpacked/SuWen.exe SHA256 CFE87F2DE046E0AB8D58F4DDB4C9898407F67129EF353BDAFCEF35376A3BB397; UNSIGNED")
E_CHAOS = "docs/verification/chaos-results.json (short-window fault injection): 10/11 scenarios ok (python-worker SIGKILL retry, daemon SIGKILL lease recovery same operation id, committed-step no replay, cancel propagates); overall run result=failed on injected-provider HTTP 429 waiting_approval timeout"
E_DB = ("TARGET daemon real calls: Europe PMC/PubMed query \"CRISPR base editing\" first hit PMID 42878939 "
        "(\"In-vivo CRISPR/Base-Editing \\\"One-Shot\\\" Therapies Targeting PCSK9.\"); UniProt TP53 first hit Q9Y2B4/T53G5_HUMAN release 2026_03; "
        "responses recorded as durable artifacts with sha256")

OV = {
    "R010": dict(
        test_or_log="docs/research/evidence/python-full-test.log: 482 passed / 1 deprecation warning / 36.52 s / EXIT_CODE=0 (mock provider, isolated home); python-feature-inventory.md 17 sections",
        evidence_scope="DOC"),
    "R011": dict(
        test_or_log="feature-parity-matrix.csv 69 rows (3.1.0 update) + .md counts; python baseline column unchanged",
        evidence_scope="DOC"),
    "R012": dict(
        status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
        vnext_evidence="desktop/src/import-service.ts (backup-first; SECRET patterns excluded; IMPORT_KINDS; 8 MB/file, 128 MB total, 200 KB text, 4000 msg caps) + rpc import.inspect/apply/jobs/rollback; real legacy home read-only scan `C:\\Users\\Qingyuan Zhuang\\.omicslab` => 9 importable item groups; user data untouched",
        test_or_log="desktop/test/import-service.test.ts 5/5 (apply/rollback/idempotent); e2e-rpc import.inspect; absolute paths never modified",
        remaining_gap="apply/rollback verified on fixtures + read-only real-home inspect; full real-data migration and post-import upgrade not executed; no automatic import"),
    "R013": dict(
        status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
        vnext_evidence="desktop/worker/research_worker.py v2.0.0 (protocol suwen-research-worker/2, pure stdlib, 83 KB) as managed worker; typed RPC worker.health/describe; no second main agent loop",
        test_or_log="research-worker.test.ts 22 tests / 21 pass / 1 skip (Windows symlink EPERM); e2e-rpc worker.health/describe/python sandbox",
        remaining_gap="fixed analyses + runScript in per-run sandbox only; no arbitrary scientific stack/OS-level sandbox"),
    "R014": dict(
        status="UNVERIFIED", evidence_scope="TARGET_RUN",
        vnext_evidence="isolated compatibility window implemented in main.ts/legacy-worker.ts (separate session partition, Bearer token, new home, mock default)",
        test_or_log="packaged smoke records legacyWorkbench = \"unavailable on this machine\" (python lacks fastapi) - NOT a pass; legacy-worker unit tests pass; prototype 10-check E2E previously passed",
        remaining_gap="TARGET packaged compatibility window not re-verified on a machine with fastapi; real legacy workflow unchanged"),
    "R020": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UI + "; " + E_SMOKE,
                 remaining_gap="UI shell proven by DOM QA + packaged smoke; per-page long-tail polish and all-model envelope coverage remain partial"),
    "R021": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + "; " + E_SMOKE + "; ui-dom-qa streaming/cancel/retry checks",
                 remaining_gap="long-history behavior measured only up to compaction fixtures; no hours-long soak"),
    "R023": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + "; " + E_E2E + " (approval/control paths)",
                 remaining_gap="approval UI proven for implemented tools; remote/high-risk tool set limited"),
    "R024": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UI + "; zh/en labels across 5 workspaces and 142 actions",
                 remaining_gap="new-copy coverage checked for implemented screens; future copy must keep parity"),
    "R025": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_E2E + " (snapshot/task/checkpoints) + " + E_UNIT,
                 remaining_gap="cost/token panels show recorded usage; exact prepaid money accounting not implemented"),
    "R026": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN", test_or_log=E_UI,
                 remaining_gap="artifact preview types limited (text/normalized); binary/plot viewers not complete"),
    "R030": dict(test_or_log=E_UNIT + " (security suite + daemon-integration); packaged smoke renderer-without-Node check; e2e-rpc unauthorized/guard rows",
                 evidence_scope="TARGET_RUN"),
    "R031": dict(test_or_log=E_UNIT + "; " + E_E2E + " detected detached daemon over named pipe; " + E_SMOKE,
                 evidence_scope="TARGET_RUN"),
    "R033": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (durable/store suite); " + E_CHAOS,
                 remaining_gap="no long-duration endurance; crash-recovery proven only in short window"),
    "R034": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (durable suite: lease/fencing/heartbeat/reclaim/timer/approval); " + E_CHAOS,
                 remaining_gap="8/24/72 h and reboot/sleep/power-loss NOT run; waiting_approval survives restart in fixtures but real vendor 429 path aborted chaos run"),
    "R035": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (outbox/operation_id tests); " + E_CHAOS,
                 remaining_gap="uncertain external effects still require reconciliation; no provider-side charge reconciliation"),
    "R036": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (checkpoints/artifacts sha256); " + E_E2E,
                 remaining_gap="large-object artifact storage not quota-tested"),
    "R037": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (budgets/cancel/retry); " + E_CHAOS + " cancel propagates to sandboxed worker step",
                 remaining_gap="CPU/memory/disk OS quotas and provider-side rate limiting NOT implemented; money limits are token/cost estimates"),
    "R038": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_E2E + " health/doctor 11 checks/support bundle + " + E_UNIT,
                 remaining_gap="support bundle redaction tested in unit suite; no field telemetry/aggregation"),
    "R042": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (context/records suites); " + E_E2E + " contextHistory/restore/compact",
                 remaining_gap="archive retrieval quality is explicit-source-linked, not semantic search over arbitrary history"),
    "R045": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (artifactization); " + E_E2E + " artifact.read path guard",
                 remaining_gap="sub-agent local memory model limited to worker sandbox + project facts"),
    "R046": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_UNIT + " (context versions/manual compaction); " + E_E2E + " context history/restore/compact",
                 remaining_gap="preview/diff UI limited; no claim that scientific conclusions are preserved semantically"),
    "R047": dict(test_or_log=E_UNIT + " (context tests incl. 10-round compaction) + " + E_SMOKE,
                 remaining_gap="restart-retention verified in unit fixtures; no 100k-token soak beyond fixture size"),
    "R050": dict(
        status="UNVERIFIED", evidence_scope="TARGET_RUN",
        vnext_evidence="harness retry/reconciliation + chaos harness scripts/chaos-smoke.mjs",
        test_or_log=E_CHAOS,
        remaining_gap="8/24/72 h, reboot, sleep/hibernate, power-loss, disk-full NOT performed; overall chaos run ended result=failed on injected provider 429 waiting_approval timeout -> cannot claim fault-tolerance complete"),
    "R051": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="durable research workflow research.knowledge (activity handlers in src/activities/research.ts) writing typed evidence records with provenance; graph view via research.graph",
                 test_or_log=E_UNIT + " (research-activity/domain-research suites); " + E_E2E + " research.graph",
                 remaining_gap="workflow layer only; external synthesis engines/Edison adapter not bundled; evidence quality heuristics"),
    "R052": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="research.hypothesis workflow + hypothesis records (roles/select) in src/domain/hypothesis.ts + rpc/core hypothesis.list/get/select",
                 test_or_log=E_E2E + "; " + E_UNIT,
                 remaining_gap="role orchestration is serialized same-provider; scientific validity not externally validated"),
    "R054": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="research.analysis durable activity; Python worker sandbox (per-run dir, timeouts, output caps, env allowlist, file digests) runScript; real demo.fcs metrics (FSC-A mean 50357.318211, SSC-A 30390.826209, FL1-A 734.915157, FL2-A 363.630725, FL3-A 788.096841; Otsu gates 3199/1979/1612/653/1279) committed as artifacts",
                 test_or_log="research-worker.test.ts 21 pass; " + E_E2E + " python sandbox",
                 remaining_gap="Biomni/scientific stacks and candidate-revision loop NOT bundled; sandbox is process-level, not OS-level virtualization"),
    "R055": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="research.discovery durable workflow: hypothesis -> experiment(create/approve/result) with simulated-vs-real flag, typed evidence records + human approval",
                 test_or_log=E_UNIT + "; " + E_E2E + " (research/experiment rows)",
                 remaining_gap="real scientific import from arbitrary instruments not implemented; simulated experiments cannot accept real results"),
    "R056": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="research.autonomy bounded research graph (node cap) persisted as records; durable DAG + budget checks",
                 test_or_log=E_E2E + " research.graph/autonomy; " + E_UNIT,
                 remaining_gap="bounded local graph, not long-horizon autonomous science; external world model absent"),
    "R057": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="typed records (provenance_json, source/time/model/config hashes) for knowledge/hypothesis/debate via store putRecord",
                 test_or_log=E_UNIT + " (record/provenance); " + E_E2E,
                 remaining_gap="full cryptographic evidence chain for conclusions not independently audited"),
    "R060": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="MCP registry handlers mcp.list/add/remove/health/tools/enable/disable in src/domain/tools.ts + rpc; stdio child-process server/client",
                 test_or_log=E_UNIT + " (mcp/tools suites) + " + E_E2E,
                 remaining_gap="HTTP/SSE/ OAuth transport variants and third-party registry import not exercised against live remote servers"),
    "R061": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="Skill registry skill.list/inspect/install/enable/disable/test/remove (SKILL.md parse, version/source/license/deps/tests checks, sandbox constraints) + rpc",
                 test_or_log=E_UNIT + " (tools suite) + " + E_E2E,
                 remaining_gap="dependency auto-install/marketplace/update channel missing; live third-party repo install not exercised"),
    "R062": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="skill.install requires explicit confirm:true + static checks; high-risk install sideEffect approval; no silent execution",
                 test_or_log=E_UNIT + " (tools/skill tests; confirm rejection); " + E_E2E,
                 remaining_gap="not exercised against a live GitHub repository (supply-chain scan on real remote repo UNVERIFIED); no signature verification"),
    "R063": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 test_or_log=E_DB,
                 remaining_gap="Europe PMC/PubMed + UniProt only; additional DBs (HGNC/Ensembl/STRING/BioGRID/Open Targets/ChEMBL/PubChem/ClinicalTrials) not wired; license review per source incomplete"),
    "R064": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="RSI constrained loop rsi.list/run/review/promote/rollback/active with benchmark fixtures + versioned records (src/domain/rsi.ts)",
                 test_or_log=E_UNIT + " (rsi.test.ts) + " + E_E2E,
                 remaining_gap="canary on real production traffic / regression rollback in field UNVERIFIED; source changes require human branch/PR"),
    "R070": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="channel adapter framework channel.list/save/test/send/inbox/remove with safeStorage secretRef, readOnly default, 10 s test timeout (src/domain/channels.ts)",
                 test_or_log=E_UNIT + " (channels.test.ts) + " + E_E2E,
                 remaining_gap="real Telegram/Slack/Discord/email/WeChat accounts BLOCKED_EXTERNAL; no platform E2E; only local adapters/fixtures"),
    "R071": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="readOnly channel policy + extra authorization for writes/shell in channels domain",
                 test_or_log=E_UNIT + " channels/tools suites",
                 remaining_gap="policy enforced only for implemented adapter paths; real platform rate limits untested"),
    "R080": dict(test_or_log="docs/research/deepseek-harness-audit.md + upstream-commits.md: pinned master 22ddee3792402c3e70ec5f86a63c3e3e895a2f60, tag dsh-v0.2.1-rc.3 1f81c047fc48fa190a683e469daa699857e9afe8, ZIP sha256 088b7edc…65d3; decision doc reuse-decision.md = III independent + future adapter (II); no upstream code bundled",
                 evidence_scope="DOC"),
    "R090": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="brand scan 983 raw hits / 143 text files with 0 requiring change; all retained hits documented legacy-compat paths/fields (docs/research/branding-scan.csv + branding-exceptions.md); UI titles/installer display name/appId org.suwen.desktop/package suwen-desktop/shortcuts use SuWen",
                 test_or_log="docs/research/branding-scan.csv + branding-scan-summary.json (scan 2026-10-25)",
                 remaining_gap="package namespace/env/storage/API identifiers intentionally kept for compatibility; active compatibility docs still mention legacy names"),
    "R093": dict(test_or_log=E_UNIT + " (main/security safeStorage tests); channel credential entry uses safeStorage secretRef; no cleartext fallback",
                 evidence_scope="TARGET_RUN"),
    "R094": dict(test_or_log="npm audit (prod) 0 advisories in prototype log; SBOM CycloneDX; lockfile pins; installer UNSIGNED",
                 remaining_gap="no code signing (BLOCKED_EXTERNAL: no certificate); no upstream binary signature/hash verification for optional research tools; no pip-audit"),
    "R100": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence=E_INST,
                 test_or_log="Get-FileHash in TARGET (bytes/hash independently re-measured) + package layout inspection: resources/app/{dist/main.js,dist/src/daemon.js,dist/ui/index.html,package.json,LICENSE,NOTICE,third-party-licenses}, resources/worker/research_worker.py, resources/legacy/**",
                 remaining_gap="clean Windows install/start/upgrade/uninstall lifecycle NOT run (R119 PENDING); SHA256SUMS file not yet generated in release/; electron-builder direct GitHub download timed out once (ETIMEDOUT 20.205.243.166:443) -> build used npmmirror mirrors"),
    "R102": dict(test_or_log="electron-builder config deleteAppDataOnUninstall:false; no executed upgrade/uninstall run in TARGET",
                 remaining_gap="upgrade DB migration/backup and uninstall data-retention NOT executed; needs clean VM"),
    "R110": dict(test_or_log=E_UNIT + "; " + E_SMOKE + "; " + E_E2E,
                 remaining_gap="multi-turn/cancel/recover proven; input-jitter over multi-hour sessions not measured"),
    "R111": dict(test_or_log=E_UNIT + " providers suite (OpenAI-compatible + Anthropic real local HTTP fixture servers, malformed/partial/UTF-8/cancel/usage) + " + E_E2E + " model-gate refusal",
                 remaining_gap="real vendor accounts/API behavior NOT verified (BLOCKED_EXTERNAL: user-supplied credentials); no provider cost reconciliation"),
    "R112": dict(test_or_log=E_DB,
                 remaining_gap="only PubMed/Europe PMC + UniProt; no MCP server installation E2E beyond local fixtures"),
    "R114": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="Python worker sandbox executed public `omicslab/data/demo.fcs` (120,811 B, FCS 3.1, $PAR=5, 6000 events, channels FSC-A/SSC-A/FL1-A/FL2-A/FL3-A) producing mean FSC-A 50357.318211, SSC-A 30390.826209, FL1-A 734.915157, FL2-A 363.630725, FL3-A 788.096841 and Otsu gate counts 3199/1979/1612/653/1279; sandbox runScript returns file digests and versioned protocol",
                 test_or_log="research-worker.test.ts 21 pass; packaged smoke sandboxed stdlib script exit 0 mean 5; artifacts retained under TARGET home",
                 remaining_gap="fixed analysis operations only; arbitrary analysis-script library/reproducible env lock not implemented"),
    "R115": dict(status="IMPLEMENTED_PASS", evidence_scope="TARGET_RUN",
                 vnext_evidence="research.debate durable activity with proposal/critique/revision steps persisted + typed records; auditable via snapshot/evidence",
                 test_or_log=E_UNIT + " (research suites); " + E_E2E + " research.debate",
                 remaining_gap="serialized same configured provider; not independent scientific validation"),
    "R116": dict(test_or_log=E_SMOKE + " (UI close keeps daemon; reopen same daemon); " + E_CHAOS,
                 remaining_gap="Windows reboot recovery NOT executed; only short SIGKILL/short-window recovery; 8/24/72 h endurance absent"),
    "R117": dict(test_or_log=E_UNIT + " context suite 10-round compaction; " + E_E2E + " context versions/restore",
                 remaining_gap="restart-retention of goals/evidence/citations proven on fixtures, not across OS reboot"),
    "R119": dict(status="NOT_STARTED", evidence_scope="PENDING_LEAD",
                 vnext_evidence="installer exists (see R100) but clean-machine lifecycle not executed",
                 test_or_log="no install/start/upgrade/uninstall run; clean VM unavailable",
                 remaining_gap="clean Windows install/start/upgrade/uninstall + SHA256SUMS verification must be run by Lead on VM; code signing BLOCKED_EXTERNAL"),
    "R120": dict(test_or_log="docs/migration/{source-inventory,copy-verification,python-feature-inventory,feature-parity-matrix.csv/.md}; docs/requirements/{master-requirements.csv,traceability,conflicts}; docs/verification/{third-party-dependencies,ui-action-coverage,integration-and-e2e,durability-chaos-tests}; docs/release/windows-installer-verification; docs/progress.md; .github/workflows/suwen-windows.yml",
                  remaining_gap="8 reports present; CI workflow authored but never executed; durability report retains explicit NOT_VERIFIED items"),
}

raw = open(P, "rb").read()
bom = raw.startswith(b"\xef\xbb\xbf")
with open(P, encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))
fields = list(rows[0].keys())
by_id = {r["id"]: r for r in rows}
missing = [k for k in OV if k not in by_id]
assert not missing, missing
for rid, ch in OV.items():
    by_id[rid].update(ch)
# preserve original column order: derive from header of file (DictReader fieldnames)
with open(P, "w", encoding="utf-8-sig" if bom else "utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in fields})
print("patched", len(OV), "rows; total", len(rows))
from collections import Counter
print(Counter(r["status"] for r in rows))
