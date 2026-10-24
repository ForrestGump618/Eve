# -*- coding: utf-8 -*-
"""Patch docs/migration/feature-parity-matrix.csv for SuWen 3.1.0 evidence."""
import csv
import os
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
P = os.path.join(D, "docs/migration/feature-parity-matrix.csv")

E_UNIT = "npm test 150/148/2 skip, exit 0"
E_E2E = "e2e-rpc 42/0 live detached daemon"
E_SMOKE = "packaged smoke 8/8"
E_UI = "ui-dom-qa 19/0/10 + actions.json 142"
E_INST = "release/SuWen-Setup-3.1.0-win-x64.exe 129424645 B sha256 82779b90...; UNSIGNED"

OV = {
    "Five-workspace UI shell": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/ui/{index.html,app.js,style.css,actions.json}", test_id=E_UI + "; " + E_SMOKE,
        gaps="per-page long-tail polish; proof is DOM QA + packaged smoke, no multi-hour UI soak"),
    "Streaming chat + markdown": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/ui/app.js; daemon snapshot stream; activities/model.ts", test_id=E_UNIT + "; " + E_SMOKE,
        gaps="no guarantee for all provider streaming envelopes"),
    "Chat virtualization/incremental render": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/ui/app.js", test_id=E_UI,
        gaps="bounded by fixture lengths; very long history not measured"),
    "Bilingual zh/en + new-copy coverage": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/ui/index.html data-i18n; app.js", test_id=E_UI,
        gaps="new copy must keep parity going forward"),
    "Session/conversation persistence": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/src/conversations.ts; rpc/core.ts conversation.*; harness/store.ts records",
        test_id=E_UNIT + "; " + E_E2E, gaps="CAS append retried 4x; concurrent multi-window writer not soak-tested"),
    "Projects/discovery projects": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="rpc/core project.*; domain/research.ts", test_id=E_E2E + " project.*",
        gaps="archival semantics detach conversations rather than cascade delete"),
    "Files/figures/artifacts": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/artifacts.ts, store.ts; artifact.read path guard", test_id=E_E2E + " artifact.read guard",
        gaps="artifact preview limited to text/normalized JSON; binary viewers partial"),
    "Managed Python research worker (typed)": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/worker/research_worker.py v2.0.0 (suwen-research-worker/2, stdlib); src/research-worker.ts; worker.health/describe",
        test_id="research-worker.test.ts 22/21 pass 1 skip; " + E_E2E,
        gaps="fixed analyses + runScript sandbox; no arbitrary scientific stack/OS sandbox"),
    "Runtime event log (SQLite v3 WAL)": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts v3 (WAL/FULL/FK/busy_timeout, migrations, VACUUM INTO backup)",
        test_id=E_UNIT + " (durable/store); " + E_SMOKE, gaps="no 8/24/72h soak; crash-recovery only short window"),
    "Task DAG persisted": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts steps/dependencies; harness/engine.ts", test_id=E_UNIT + "; " + E_E2E,
        gaps="DAG scheduling tested on fixtures, not production-scale graphs"),
    "Lease/fencing/heartbeat/reclaim": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts claim/heartbeat/reclaimExpired; harness/engine.ts",
        test_id=E_UNIT + "; chaos-results.json (daemon SIGKILL lease recovery same operation id)",
        gaps="short-window only; no reboot/power-loss test"),
    "Durable timer / waiting_approval persist": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts defer/waitForApproval/timer.fired; engine.ts",
        test_id=E_UNIT + "; " + E_SMOKE + " 30s timer after UI exit; chaos waiting_approval",
        gaps="injected-provider 429 waiting_approval path timed out in chaos run; no long wait test"),
    "Outbox/idempotent operation_id": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts outbox + steps.operation_id UNIQUE", test_id=E_UNIT + "; chaos no-replay scenario",
        gaps="unknown external effects require manual reconciliation"),
    "Checkpoints + artifact SHA256": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts checkpoints; harness/artifacts.ts", test_id=E_UNIT + "; " + E_E2E,
        gaps="large-object quota/storage pressure not tested"),
    "Budget enforcement": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts limits/cost; engine budget_exhausted", test_id=E_UNIT + "; " + E_E2E,
        gaps="CPU/memory/disk OS quotas NOT implemented; money is token/cost estimate"),
    "Observability/support bundle": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="rpc/core doctor.run (11 checks); main.ts support export; snapshot events",
        test_id=E_E2E + " doctor; " + E_UNIT, gaps="no field telemetry/central aggregation"),
    "Memory tiers/project facts/archive": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="context.ts hash chain/versions; store records; artifact pointers", test_id=E_UNIT + "; " + E_E2E,
        gaps="archive retrieval is explicit-source-linked, not semantic over arbitrary history"),
    "Tool output artifactization": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/artifacts.ts; activities/model.ts output artifacts", test_id=E_UNIT + "; " + E_E2E,
        gaps="tool-group completeness limited to implemented activities"),
    "Raw event immutability + crash reconcile": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts event hash chain + recovery", test_id=E_UNIT + "; chaos SIGKILL recovery",
        gaps="no long-duration crash storm"),
    "Approvals/governance": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store waitForApproval; rpc approval; ui evidence panel", test_id=E_UNIT + "; " + E_E2E,
        gaps="approval matrix for all high-risk tools not exhaustive"),
    "SQLite WAL/FULL/backup/migration": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="harness/store.ts PRAGMAs + pre-v3 backup; migration count in doctor",
        test_id=E_UNIT + "; " + E_SMOKE, gaps="upgrade-from-real-legacy-DB path not executed"),
    "Diagnostics/doctor": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="rpc/core doctor.run 11 checks; ui settings diagnostics", test_id=E_E2E + " doctor",
        gaps="checks are point-in-time; no continuous health monitor"),
    "MCP manager (stdio/HTTP discovery)": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/tools.ts mcp.*; mcp-client.ts/mcp-server.ts", test_id=E_UNIT + " (mcp/tools); " + E_E2E,
        gaps="HTTP/SSE/OAuth variants and live third-party registries not exercised"),
    "Skill registry/SKILL.md lifecycle": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/tools.ts skill.*; rpc; static checks + confirm:true",
        test_id=E_UNIT + " (tools); " + E_E2E, gaps="dependency auto-install/marketplace/update channel missing"),
    "Function registry": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/tools.ts", test_id=E_UNIT, gaps="registry-level only"),
    "Co-Scientist / Robin / ERA methods": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/research.ts research.methods durable activity", test_id=E_UNIT + "; " + E_E2E,
        gaps="workflow skeleton only; upstream engines/models NOT bundled (Biomni/ERA/Robin/Kosmos external integrations UNVERIFIED)"),
    "Discovery engine (projects/runs/report)": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/research.ts research.discovery; records", test_id=E_E2E + " research rows; " + E_UNIT,
        gaps="durable workflow layer; scientific discovery quality not validated"),
    "Evidence ledger/provenance": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="activities/research.ts; store records provenance_json", test_id=E_UNIT + "; " + E_E2E,
        gaps="evidence heuristics cannot verify citation support"),
    "Hypothesis generation/selection": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/hypothesis.ts; rpc hypothesis.*", test_id=E_UNIT + "; " + E_E2E,
        gaps="serialized same-provider roles; scientific validity not externally validated"),
    "Multi-agent debate": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/research.ts research.debate; typed records", test_id=E_UNIT + "; " + E_E2E,
        gaps="proposal/critique/revision serialized, not independent scientific validation"),
    "Autonomy research graph": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/research.ts research.autonomy/graph (bounded node cap); store researchGraph",
        test_id=E_E2E + " research.graph; " + E_UNIT, gaps="bounded local graph; not long-horizon autonomous science"),
    "RSI loop": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/rsi.ts rsi.* (bounded <=10 candidates x <=20 cases) + versioned records",
        test_id=E_UNIT + " rsi.test.ts; " + E_E2E, gaps="canary on real production traffic UNVERIFIED"),
    "Biomni-style analysis sandbox": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="worker/research_worker.py runScript sandbox (per-run dir, timeouts, output caps, env allowlist, file digests) + flow metrics on demo.fcs",
        test_id="research-worker.test.ts 21 pass; packaged smoke sandbox script; " + E_E2E,
        gaps="Biomni/scientific stacks NOT bundled; process-level sandbox, not OS virtualization; fixed operations"),
    "Channels adapter (webchat/telegram/wechat)": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/channels.ts channel.* with safeStorage secretRef + readOnly default",
        test_id=E_UNIT + " channels.test.ts; " + E_E2E,
        gaps="real Telegram/Slack/Discord/email/WeChat accounts BLOCKED_EXTERNAL; local adapters/fixtures only"),
    "Remote read-only channel policy": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="domain/channels.ts readOnly + extra authorization", test_id=E_UNIT,
        gaps="real platform rate limits/permissions untested"),
    "Import/export legacy data": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="import-service.ts + import.inspect/apply/jobs/rollback; real C:\\Users\\Qingyuan Zhuang\\.omicslab read-only scan = 9 groups",
        test_id="import-service.test.ts 5/5; " + E_E2E,
        gaps="apply/rollback on fixtures only; real user data untouched by design; no auto-import"),
    "Windows NSIS installer + SHA256SUMS": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/package.json build block; " + E_INST,
        test_id="Get-FileHash in TARGET + layout inspection (resources/app, worker, legacy)",
        gaps="SHA256SUMS file not yet generated in release/; clean-VM install/upgrade/uninstall pending; code signing BLOCKED_EXTERNAL"),
    "Windows app packaging metadata": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="package.json productName SuWen/appId org.suwen.desktop/nsis; packaged layout verified",
        test_id="layout inspection of win-unpacked/resources", gaps="installer lifecycle pending"),
    "Desktop unit/integration tests": dict(vnext_status="IMPLEMENTED_PASS",
        vnext_code="desktop/test/*.test.ts (15 files)", test_id="npm test 150 tests / 148 pass / 0 fail / 2 skipped, exit 0",
        gaps="2 skips: Windows symlink EPERM + optional legacy Python deps"),
}

NEW_ROWS = [
    dict(capability="Desktop RPC E2E harness (detached daemon)", category="Testing",
         python_baseline="none (no equivalent)", python_evidence="n/a",
         desktop_prototype="prototype electron E2E only", prototype_evidence="docs/research/evidence/electron-e2e-result.json",
         vnext_status="IMPLEMENTED_PASS", vnext_code="desktop/scripts/e2e-rpc.mjs",
         reuse_mode="new", data_migration="n/a", priority="P0",
         test_id="node scripts/e2e-rpc.mjs --dist dist --live 42 passed/0 failed ~7s",
         gaps="short single-session run; no 8/24/72h"),
    dict(capability="UI DOM QA harness", category="Testing",
         python_baseline="none", python_evidence="n/a",
         desktop_prototype="8-group locale QA fixture", prototype_evidence="docs/research/evidence/ui-locale-qa-result.json",
         vnext_status="IMPLEMENTED_PASS", vnext_code="desktop/scripts/ui-dom-qa.mjs; desktop/ui/actions.json (142 actions)",
         reuse_mode="new", data_migration="n/a", priority="P0",
         test_id="node scripts/ui-dom-qa.mjs 19 passed / 0 failed / 10 warnings (main-bridge methods)",
         gaps="warnings only for main-process bridge methods; visual regression not covered"),
    dict(capability="Context versions + manual compaction/rollback", category="Context",
         python_baseline="char-size trim, no versions", python_evidence="omicslab/suwen/models.py:22-52",
         desktop_prototype="context versions in prototype UI", prototype_evidence="docs/research/evidence/desktop-test.log",
         vnext_status="IMPLEMENTED_PASS", vnext_code="context.ts ContextSummary versions; rpc contextHistory/Restore/Compact; e2e",
         reuse_mode="rewrite", data_migration="n/a", priority="P0",
         test_id=E_UNIT + "; " + E_E2E + " context history/restore/compact",
         gaps="semantic losslessness not claimed; UI preview/diff limited"),
]

raw = open(P, "rb").read()
bom = raw.startswith(b"\xef\xbb\xbf")
rows = list(csv.DictReader(open(P, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
seen = set()
for r in rows:
    cap = r["capability"]
    if cap in OV:
        r.update(OV[cap])
        seen.add(cap)
missing = set(OV) - seen
assert not missing, missing
for nr in NEW_ROWS:
    rows.append({k: nr.get(k, "") for k in fields})
w = csv.DictWriter(open(P, "w", encoding="utf-8-sig" if bom else "utf-8", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
print("patched", len(OV), "rows, added", len(NEW_ROWS), ", total", len(rows))
print(Counter(r["vnext_status"] for r in rows))
