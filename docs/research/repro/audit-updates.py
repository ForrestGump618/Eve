#!/usr/bin/env python3
"""Regenerate audit CSVs for task-3 (docs-audit). Run from repo root.

- repairs/writes docs/migration/feature-parity-matrix.csv from an explicit row model
  (statuses re-inspected 2026-10-25 00:47 after teammate modules appeared)
- updates selected rows of docs/requirements/master-requirements.csv
- writes docs/verification/ui-action-coverage.csv from desktop/ui/index.html + app.js
  (desktop/ui/actions.json does not exist => static inventory, NOT_WIRED where unbound)
Read-only except these three output files. No network. No build.
"""
import csv
import re
from pathlib import Path

ROOT = Path(r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext")

# ---------------------------------------------------------------- parity rows
PARITY = [
 ("HTTP/API server and SPA hosting","platform","implemented","server/app.py:66-145 (FastAPI, static, CORS, no CSP)","implemented (Electron replaces HTTP)","desktop-test.log","IMPLEMENTED_PASS","desktop/src/main.ts,daemon.ts,preload.cts","rewrite","not needed","P3","desktop-test security/daemon","legacy HTTP/SPA remains only in the Python workbench"),
 ("CLI entrypoints (18 subcommands)","platform","implemented","omicslab/cli.py; pyproject scripts suwen/omicslab","n/a (desktop shell)","n/a","N/A_PORT","omicslab/cli.py","preserve","keep old CLI/venv","P3","python-full-test 482 pass","old CLI remains in legacy workbench; not bridged to daemon"),
 ("Five-workspace UI shell","ui","implemented (SPA)","web/js/views/*,web/index.html","prototype shell","desktop-test.log","UNVERIFIED","desktop/ui/index.html,desktop/ui/app.js,desktop/ui/style.css","rewrite","not needed","P0","none in TARGET","shell+JS rewritten 2026-10-25 00:41-00:49; ui/actions.json absent; no TARGET run"),
 ("Streaming chat + markdown","ui","implemented","web/js/sse.js,web/js/views/chat.js","fixture streamed chat","electron-e2e-result.json","UNVERIFIED","desktop/ui/app.js; daemon snapshot stream","rewrite","not needed","P0","none in TARGET","new UI chat not executed; throttling/recovery unverified"),
 ("Chat virtualization/incremental render","ui","partial (full rerender)","web/js/views/chat.js:557-571,788-810","not implemented","desktop-test.log (no claim)","UNVERIFIED","desktop/ui/app.js","rewrite","not needed","P1","none","incremental render present in new app.js? not measured; no long-history UI test"),
 ("Bilingual zh/en + new-copy coverage","i18n","partial","web js i18n dicts","prototype DOM QA 8 checks (old DOM)","ui-locale-qa-result.json","UNVERIFIED","desktop/ui/index.html data-i18n; app.js","rewrite","not needed","P0","none","new copy not re-QA'd; mojibake strings in rpc/core.ts FIX_REQUIRED"),
 ("Model routing / auto config / fallback","providers","partial","omicslab/suwen/models.py","not implemented","none","NOT_STARTED","none in desktop/src","new","not needed","P1","none","no router/fallback implementation found"),
 ("OpenAI-compatible provider","providers","implemented","agent/providers/openai_compat.py","local HTTP fixture passed","desktop-test.log","IMPLEMENTED_PASS","desktop/src/providers.ts","port","not needed","P0","desktop-test providers","external paid account BLOCKED_EXTERNAL"),
 ("Anthropic provider","providers","implemented","agent/providers/anthropic.py","local HTTP fixture passed","desktop-test.log","IMPLEMENTED_PASS","desktop/src/providers.ts","port","not needed","P0","desktop-test providers","external paid account BLOCKED_EXTERNAL"),
 ("Mock provider (offline)","providers","implemented","agent/providers/mock.py","fixture tests","desktop-test.log","IMPLEMENTED_PASS","desktop/src/providers.ts","port","not needed","P1","desktop-test providers","n/a"),
 ("Vision verification loop","research","implemented","agent/vision.py,vision_tools.py","not implemented","none","NOT_STARTED","none in desktop/src","new","not needed","P2","none","absent from vNext desktop"),
 ("Session/conversation persistence","data","implemented","session/store.py:119-132","records in prototype store","desktop-test.log","UNVERIFIED","desktop/src/conversations.ts,desktop/src/rpc/core.ts","rewrite","importer (unverified)","P0","import-service.test.ts (never run)","core.ts handlers not dispatched by daemon"),
 ("Projects/discovery projects","data","implemented","suwen/discovery/*,server/routes_discovery.py","prototype records","desktop-test.log","UNVERIFIED","desktop/src/rpc/core.ts,desktop/src/domain/research.ts","wrap as worker","importer (unverified)","P0","none","not dispatched; no TARGET run"),
 ("Workspaces (local roots)","data","implemented","server/routes_workspaces.py,workspace/service.py","not implemented","none","NOT_STARTED","none in desktop/src","wrap as worker","importer (unverified)","P1","none","no workspace manager in vNext"),
 ("SSH remote workspaces/exec","data","implemented","omicslab/ssh/* (84 KB manager)","not implemented","none","NOT_STARTED","none in desktop/src","wrap as worker","not needed","P2","none","legacy Python only"),
 ("Files/figures/artifacts","data","implemented","server/files.py,suwen/store.py","artifact records in prototype","desktop-test.log","UNVERIFIED","desktop/src/harness/artifacts.ts,store.ts,rpc/core.ts","rewrite","importer (unverified)","P0","none","not dispatched; artifact.read unexecuted"),
 ("Trajectories/audit trail","data","implemented","omicslab/trajectories.py","not implemented","none","NOT_STARTED","none in desktop/src","preserve","not needed","P2","none","legacy only"),
 ("Jupyter kernel manager","execution","implemented","omicslab/kernel/manager.py:1-700","not implemented","none","NOT_STARTED","none (worker has runScript only)","wrap as worker","not needed","P2","none","no kernel manager in vNext"),
 ("Terminal/shell","execution","implemented","server/terminal.py","not implemented","none","NOT_STARTED","none in desktop/src","wrap as worker","not needed","P2","none","not exposed in vNext"),
 ("In-memory jobs + threads","execution","implemented","session/jobs.py:68-75,122-129,189-202","replaced by durable steps","desktop-test.log durable tests","REPLACED","desktop/src/harness/engine.ts","rewrite","not needed","P0","desktop-test durable","deliberate redesign per R034-R037; no in-process job store"),
 ("Managed Python research worker (typed)","execution","implemented (in-process)","agent/tools.py,suwen/sandbox.py","not implemented","none","UNVERIFIED","desktop/src/research-worker.ts,desktop/worker/research_worker.py","wrap as worker","not needed","P0","none in TARGET","typed long-lived stdio JSON-RPC worker (protocol suwen-research-worker/2) exists; not registered in daemon; no TARGET run"),
 ("Runtime event log (SQLite v3 WAL)","durability","implemented","runtime/events.py:184-201,342-368","prototype WAL event log","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts","rewrite","not needed","P0","none","schema v3/records layer added after prototype log; TARGET suite not run"),
 ("Task DAG persisted","durability","partial (persisted DAG, in-memory dispatch)","suwen/tasks.py:40-49,107-125,143-240","prototype DAG","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts,engine.ts","rewrite","not needed","P0","none","v3 DAG unverified"),
 ("Lease/fencing/heartbeat/reclaim","durability","not implemented","none","short SIGKILL/restart fault injection (7,873 ms)","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts,engine.ts","new","not needed","P0","none","no endurance/reboot evidence"),
 ("Durable timer / waiting_approval persist","durability","not implemented","none","30 s persisted timer ran after UI exit","electron-e2e-result.json","UNVERIFIED","desktop/src/harness/store.ts,engine.ts","new","not needed","P0","none","v3 timer path unverified in TARGET"),
 ("Outbox/idempotent operation_id","durability","not implemented","none","unknown-outcome reconciliation tested","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts (outbox table)","new","not needed","P0","none","v3 outbox unverified"),
 ("Checkpoints + artifact SHA256","durability","not implemented","none","checkpoints/artifacts in prototype","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts,artifacts.ts","new","not needed","P0","none","v3 checkpoints unverified"),
 ("Budget enforcement","durability","partial (calls/time)","suwen/models.py,agent/loop.py","budgets enforced in prototype","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts limits","rewrite","not needed","P1","none","no TARGET execution"),
 ("Observability/support bundle","diagnostics","partial","server/routes_runtime.py","support JSON prototype","electron-e2e-result.json","UNVERIFIED","desktop/src/main.ts support,rpc/core.ts doctor","rewrite","not needed","P1","none","new doctor/health not dispatched"),
 ("Context token budget (independent)","context","not implemented","none","context.ts + tests (7/7)","docs/architecture/current.md audit","IMPLEMENTED_PASS","desktop/src/context.ts,context-async.ts","new","not needed","P0","desktop-test context","known-model tokenizer required; unknown model fails closed (documented)"),
 ("Two-level compaction thresholds","context","char-bound trim","suwen/models.py:22-52;agent/loop.py:209-226","70%/82% thresholds + manual compact","desktop-test.log","IMPLEMENTED_PASS","desktop/src/context.ts","new","not needed","P0","desktop-test compaction","settings/preview/history UI not verified"),
 ("Structured summary coverage validation","context","not implemented","none","schema+coverage+provenance validation","desktop-test.log","IMPLEMENTED_PASS","desktop/src/context.ts","new","not needed","P0","desktop-test context","validated; no TARGET re-run"),
 ("Memory tiers/project facts/archive","memory","partial (workspace digest)","suwen/knowledge.py:83-150","records kinds exist in prototype","none","UNVERIFIED","desktop/src/harness/store.ts records","rewrite","importer (unverified)","P1","none","retrieval tiers not implemented"),
 ("Tool output artifactization","context","partial (files)","agent/tools.py artifact handling","artifactization prototype","desktop-test.log","UNVERIFIED","desktop/src/harness/artifacts.ts,activities/model.ts","rewrite","not needed","P1","none","pointer retrieval/locator not verified"),
 ("Raw event immutability + crash reconcile","durability","partial","runtime/events.py crash reconcile","prototype WAL reconcile","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts","rewrite","not needed","P0","none","v3 unverified"),
 ("Approvals/governance","security","implemented","agent/governance.py,approvals.py","approval step in prototype","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts approval,main.ts,ui","port","not needed","P0","none","daemon step kind exists; UI/approval flow unexecuted in TARGET"),
 ("Electron process security","security","n/a","none","10 packaged E2E checks incl contextIsolation/sandbox/nav deny","electron-e2e-result.json","IMPLEMENTED_PASS","desktop/src/main.ts,preload.cts,security.ts","new","not needed","P0","desktop-test security","files unchanged since prototype log"),
 ("Detached harness daemon + named pipe","platform","n/a","none","detached daemon, pipe auth, UI exit keeps running","electron-e2e-result.json","IMPLEMENTED_PASS","desktop/src/daemon.ts,main.ts,security.ts","new","not needed","P0","desktop-test daemon","daemon.ts unchanged since prototype log"),
 ("Windows login recovery / background mode","platform","n/a","none","UI-close background + 30 s timer","electron-e2e-result.json","UNVERIFIED","desktop/src/main.ts (login items/reconnect)","new","not needed","P1","none","only 30 s evidence; reboot/login recovery untested"),
 ("SQLite WAL/FULL/backup/migration","durability","partial (WAL)","runtime/events.py,suwen/store.py","prototype WAL","desktop-test.log","UNVERIFIED","desktop/src/harness/store.ts (v3 VACUUM INTO backup)","rewrite","not needed","P0","none","v3 migration/backup unverified"),
 ("Credential storage","security","Windows DPAPI","suwen/vault.py:14-47","safeStorage encrypted model config","desktop-test.log","IMPLEMENTED_PASS","desktop/src/main.ts (safeStorage)","port","not needed","P0","desktop-test security","new implementation equivalent; no secret in logs"),
 ("Import/export legacy data","migration","partial (JSON stores)","session/store.py,suwen/store.py","not implemented","none","UNVERIFIED","desktop/src/import-service.ts,desktop/test/import-service.test.ts","new","importer (unverified)","P0","import-service.test.ts (never run)","backup-first non-destructive importer authored 2026-10-25; not wired, secrets excluded"),
 ("Diagnostics/doctor","diagnostics","implemented","server/routes_runtime.py","prototype health/support","desktop-test.log","UNVERIFIED","desktop/src/rpc/core.ts doctor.run","rewrite","not needed","P1","none","core.ts not dispatched; no TARGET run"),
 ("MCP manager (stdio/HTTP discovery)","mcp","implemented","suwen/mcp.py,agent/remote_tools.py","2 real readonly scientific DB searches","live-mcp-results.json","UNVERIFIED","desktop/src/domain/tools.ts,mcp-client.ts,mcp-server.ts","wrap as worker","registry import planned","P1","none","registry code present (19 MCP refs) but not wired/dispatched"),
 ("MCP real scientific DB calls","mcp","implemented","suwen/biomedical.py,suwen/mcp.py","Europe PMC + UniProt real calls passed","live-mcp-results.json","IMPLEMENTED_PASS","desktop/src/mcp-client.ts,suwen/biomedical.py","port","not needed","P0","live-mcp-results.json","prototype network call; unchanged client; rerun at release"),
 ("Skill registry/SKILL.md lifecycle","skills","implemented (files)","agent/skills.py,skills/23 dirs","not implemented","none","UNVERIFIED","desktop/src/domain/tools.ts (skill.* services)","wrap","registry import planned","P1","none","registry/static-check code present (105 skill refs); not wired"),
 ("Function registry","skills","implemented","registry/index.py,registry/tools.py","not implemented","none","UNVERIFIED","desktop/src/domain/tools.ts","port","not needed","P2","none","code present; unverified"),
 ("23 preinstalled scientific skills","skills","implemented","skills/*/SKILL.md","not imported","none","UNVERIFIED","preserve content; registry planned","preserve","copy with license","P1","none","content preserved in repo; vNext access unverified"),
 ("Paper2Agent pipeline","research","partial (skill only)","skills/paper2agent","not implemented","none","NOT_STARTED","none (0 paper2agent refs in desktop/src)","wrap as worker","not needed","P2","none","absent from vNext desktop"),
 ("Co-Scientist / Robin / ERA methods","research","partial prompts","skills/co-scientist,robin,empirical-research","not implemented","none","UNVERIFIED","desktop/src/domain/research.ts,activities/research.ts","wrap","not needed","P2","none","domain/activity code exists; prompt skills not bridged"),
 ("Discovery engine (projects/runs/report)","research","implemented","omicslab/discovery/engine.py (66 KB)","not implemented","none","UNVERIFIED","desktop/src/domain/research.ts,activities/research.ts,worker research_worker.py discoveryScan","wrap as worker","importer (unverified)","P1","none","code present; no TARGET discovery run"),
 ("Evidence ledger/provenance","research","implemented","discovery/evidence.py,discovery/ledger.py","evidence records prototype","desktop-test.log","UNVERIFIED","desktop/src/activities/research.ts,store records","wrap as worker","importer (unverified)","P1","none","not dispatched; provenance unverified end-to-end"),
 ("Hypothesis generation/selection","research","implemented","skills/hypothesis-generation,agent/templates.py","prototype hypothesis records","desktop-test.log","UNVERIFIED","desktop/src/domain/hypothesis.ts,activities/research.ts","wrap as worker","importer (unverified)","P1","none","not dispatched"),
 ("Multi-agent debate","research","partial (serialized)","skills/co-scientist,agent/templates.py","serialized proposal/critique/revision","desktop/acceptance-matrix.md","UNVERIFIED","desktop/src/domain/research.ts,activities/research.ts (48 debate refs)","wrap as worker","not needed","P1","none","single-provider serialization limitation; not run in TARGET"),
 ("Autonomy research graph","research","partial","suwen/orchestration.py","not implemented","none","UNVERIFIED","desktop/src/domain/research.ts (node cap 8),store researchGraph","new","not needed","P2","none","bounded model exists; recovery unverified"),
 ("RSI loop","research","partial","skills/rsi-discovery-loop","not implemented","none","UNVERIFIED","desktop/src/domain/rsi.ts","new","not needed","P2","none","constrained config-only RSI code; no TARGET run"),
 ("Biomni-style analysis sandbox","research","partial (docker sandbox + skills)","suwen/sandbox.py,skills/robin","fixed statistics sample only","python-sample.json","UNVERIFIED","desktop/worker/research_worker.py runScript/flowSummary/datasetProfile","wrap as worker","not needed","P2","none","stdlib-only worker, explicitly NOT an OS sandbox; candidate loop absent"),
 ("Channels adapter (webchat/telegram/wechat)","channels","implemented","suwen/wechat.py,suwen/extensions.py","not bridged","none","UNVERIFIED","desktop/src/domain/channels.ts","wrap","config import planned","P2","none","6 adapters + health/test present; not wired"),
 ("Remote read-only channel policy","security","implemented","suwen/service.py:80-100","not implemented","none","UNVERIFIED","desktop/src/domain/channels.ts readOnly","wrap","not needed","P1","none","policy code present; enforcement not executed"),
 ("Windows NSIS installer + SHA256SUMS","release","n/a","none","prototype installer produced unsigned","windows-build.log,build-environment.json","UNVERIFIED","desktop/package.json build block (electron-builder 26.18.0)","new","not needed","P0","CI workflow authored (not run)","no .exe/SHA256SUMS in TARGET; clean rebuild gates release"),
 ("Clean-VM install/upgrade/uninstall","release","n/a","none","not performed","build-environment.json (not performed)","NOT_STARTED","none","new","not needed","P0","none","requires clean Windows VM"),
 ("CI for desktop + installer","release","python-only CI","github/workflows/ci.yml:22-55","none","none","UNVERIFIED",".github/workflows/suwen-windows.yml","new","not needed","P0","workflow authored; no GitHub run log","static validity only; first run must be watched"),
 ("Windows app packaging metadata","brand","n/a","none","icon/appId/productName metadata in prototype","windows-build.log","UNVERIFIED","desktop/package.json productName/appId/nsis","new","not needed","P1","none","no TARGET installer to inspect metadata"),
 ("Brand cleanup/legacy exceptions","brand","legacy identifiers","full scan 787 hits/131 files","desktop UI clean","branding-scan.csv","IMPLEMENTED_PASS","docs/research/branding-exceptions.md,docs/research/branding-scan.csv","preserve","not needed","P0","scan executed 2026-10-25","compatibility identifiers documented; active docs API mentions remain (Lead policy decision)"),
 ("License/NOTICE/SBOM/audit","release","Apache-2.0","LICENSE,pyproject.toml","prototype SBOM + npm audit 0 vulns","runtime-sbom.cdx.json,runtime-npm-audit.json","IMPLEMENTED_PASS","desktop/LICENSE,NOTICE,third-party-licenses/*","port","not needed","P0","evidence files","unsigned build disclosed; Python SBOM absent (documented gap)"),
 ("Python baseline tests (regression)","quality","482 passed","tests/ (17 files,184 functions)","same suite","python-full-test.log","IMPLEMENTED_PASS","omicslab/**","preserve","not needed","P0","python-full-test.log","SOURCE-log evidence; unchanged code; rerun recommended"),
 ("Desktop unit/integration tests","quality","n/a","none","48 passed prototype","desktop-test.log","UNVERIFIED","desktop/test/* (10 files)","new","not needed","P0","none","TARGET suite not run; new modules untested"),
]

# ------------------------------------------------------- master row updates
MASTER_UPDATES = {
 "R013": dict(status="UNVERIFIED",
   code_paths="desktop/src/research-worker.ts; desktop/worker/research_worker.py",
   vnext_evidence="typed long-lived stdio JSON-RPC worker client (protocol suwen-research-worker/2) with health/describe/flowSummary/datasetProfile/discoveryScan/runScript; stdlib-only Python worker",
   test_or_log="code+protocol inspection 2026-10-25; no TARGET worker execution",
   evidence_scope="CODE_ONLY",
   remaining_gap="worker client not registered in daemon activity handlers; no TARGET run; worker explicitly not an OS sandbox"),
 "R020": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html; desktop/ui/app.js; desktop/ui/style.css",
   vnext_evidence="five-page shell chat/projects/tasks/tools/settings with diagnostics, narrow nav/list/timeline/right panel; app.js rewritten 173,830 B 00:49",
   test_or_log="DOM/file inspection only; desktop/ui/actions.json absent; no TARGET UI run",
   evidence_scope="CODE_ONLY",
   remaining_gap="actions.json missing (contract requires it as sole action source); no executed UI test"),
 "R021": dict(status="UNVERIFIED",
   code_paths="desktop/ui/app.js; desktop/src/daemon.ts stream path",
   vnext_evidence="streaming render code in new app.js; daemon snapshot/stream unchanged",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="throttling, virtualization, persisted scroll, error recovery, long-conversation stability not verified"),
 "R022": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html (mode radios); desktop/src/domain/research.ts",
   vnext_evidence="auto/chat/research/debate/autonomy mode radios; research task templates",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="auto routing/override/stop/pause/resume not executed"),
 "R023": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html; desktop/src/harness/store.ts approval step",
   vnext_evidence="collapsible log markup; durable approval step kind",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="step approval UI+daemon flow not executed in TARGET"),
 "R024": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html (data-i18n); desktop/ui/app.js",
   vnext_evidence="bilingual markup + new SuWen/素问 copy",
   test_or_log="none in TARGET; prototype DOM QA applies to old DOM only",
   evidence_scope="CODE_ONLY",
   remaining_gap="new-copy zh/en coverage not audited; mojibake in desktop/src/rpc/core.ts is FIX_REQUIRED"),
 "R025": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html task panel; desktop/src/rpc/core.ts",
   vnext_evidence="task/DAG detail markup; core task APIs in rpc/core.ts",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="rpc/core.ts handlers not dispatched by daemon; no UI execution"),
 "R026": dict(status="UNVERIFIED",
   code_paths="desktop/ui/index.html evidence panel; desktop/src/rpc/core.ts evidence.list",
   vnext_evidence="right evidence/artifact/task-progress panel markup",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="panel not wired to live data; not executed"),
 "R051": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/research.ts; desktop/src/activities/research.ts",
   vnext_evidence="knowledge/research activities with evidence persistence, provenance, defensive model JSON repair",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="not registered in daemon; Edison adapter absent; no broad literature synthesis test"),
 "R052": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/hypothesis.ts; desktop/src/activities/research.ts",
   vnext_evidence="hypothesis schema/selection + activity handlers with record persistence",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="dedupe/termination/evolution not executed; not dispatched"),
 "R054": dict(status="UNVERIFIED",
   code_paths="desktop/worker/research_worker.py; desktop/src/research-worker.ts",
   vnext_evidence="stdlib-only sandboxed runScript plus flowSummary/datasetProfile/discoveryScan with deterministic outputs",
   test_or_log="python-sample.json prototype fixed statistics sample only",
   evidence_scope="CODE_ONLY",
   remaining_gap="not an OS sandbox; Biomni candidate-generation->metric loop absent; no TARGET run"),
 "R055": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/research.ts; desktop/src/activities/research.ts",
   vnext_evidence="discoveryScan + experiment/approval/result contract implementations",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="no end-to-end hypothesis->experiment->approval->real import run; simulated flag exists"),
 "R056": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/research.ts (RESEARCH_GRAPH_NODE_CAP=8); store researchGraph",
   vnext_evidence="bounded autonomy graph record/milestones with persisted transitions",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="recovery/failure states/budget escalation not verified"),
 "R057": dict(status="UNVERIFIED",
   code_paths="desktop/src/activities/research.ts evidence records; store provenance_json",
   vnext_evidence="knowledge/hypothesis/debate outputs persisted with task provenance",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="auditable evidence chain not end-to-end tested; not dispatched"),
 "R060": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/tools.ts; desktop/src/mcp-client.ts",
   vnext_evidence="MCP registry add/remove/health/tools + env whitelist + secretRef",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="handlers not dispatched; no TARGET live MCP call"),
 "R061": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/tools.ts (skill services)",
   vnext_evidence="skill inspect/install static checks/enable/disable/test/remove code (105 skill refs)",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="registry not wired; vNext does not import the 23 legacy skills yet"),
 "R062": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/tools.ts (GitHub URL/static checks)",
   vnext_evidence="GitHub URL handling + static-check logic (9 github refs)",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="requires user confirmation and isolated test; not executed"),
 "R064": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/rsi.ts",
   vnext_evidence="constrained RSI cycle (config-only candidates, persisted transitions, no source edits)",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="no TARGET run/promote/rollback test"),
 "R070": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/channels.ts",
   vnext_evidence="six channel types (telegram/slack/discord/email/webhook/wechat-official), secretRef, inbound/outbound, health/test",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="adapters not wired; WeChat official QR/OpenClaw bridging absent from desktop"),
 "R071": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/channels.ts (readOnly policy)",
   vnext_evidence="read-only remote default in channel config",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="policy enforcement not executed"),
 "R114": dict(status="UNVERIFIED",
   code_paths="desktop/worker/research_worker.py (runScript); desktop/src/research-worker.ts",
   vnext_evidence="sandboxed script execution with working-directory/env isolation and no shell",
   test_or_log="python-sample.json prototype fixed sample only",
   evidence_scope="CODE_ONLY",
   remaining_gap="public sample reproducibility/scripts/version capture not tested in TARGET; explicitly not an OS sandbox"),
 "R115": dict(status="UNVERIFIED",
   code_paths="desktop/src/domain/research.ts; desktop/src/activities/research.ts (48 debate refs)",
   vnext_evidence="proposal/critique/revision debate activity handlers with persisted evidence",
   test_or_log="none in TARGET",
   evidence_scope="CODE_ONLY",
   remaining_gap="single-provider serialization limitation; not executed"),
}

# ------------------------------------------------------------------- main
def write_parity():
    path = ROOT / "docs/migration/feature-parity-matrix.csv"
    header = ["capability","category","python_baseline","python_evidence","desktop_prototype",
              "prototype_evidence","vnext_status","vnext_code","reuse_mode","data_migration",
              "priority","test_id","gaps"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(header)
        w.writerows(PARITY)
    from collections import Counter
    c = Counter(r[6] for r in PARITY)
    print("parity rows:", len(PARITY), dict(c))

def update_master():
    path = ROOT / "docs/requirements/master-requirements.csv"
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
        fields = rows[0].keys()
    changed = 0
    for r in rows:
        up = MASTER_UPDATES.get(r["id"])
        if up:
            r.update(up)
            changed += 1
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(fields), quoting=csv.QUOTE_ALL)
        w.writeheader(); w.writerows(rows)
    from collections import Counter
    print("master rows:", len(rows), "updated:", changed, dict(Counter(r["status"] for r in rows)))

UI_ID_RE = re.compile(r'<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>')
RPC_CALL_RE = re.compile(r"""\bcall\(\s*['"]([a-zA-Z][\w.]*)['"]""")
# element ids containing controls/inputs
def control_wiring(ident, tag, js):
    pats = [
        r"""getElementById\(\s*['"]""" + re.escape(ident) + r"""['"]\s*\)""",
        r"""\$\(\s*['"]""" + re.escape(ident) + r"""['"]\s*\)""",
        r"""querySelector\(\s*['"]#""" + re.escape(ident) + r"""['"]\s*\)""",
        r"""\bon\(\s*['"]""" + re.escape(ident) + r"""['"]""",
        r"""['"]#""" + re.escape(ident) + r"""['"]""",
    ]
    total = sum(len(re.findall(pat, js)) for pat in pats)
    if total:
        return total, 'WIRED'
    if ident in ('chat', 'projects', 'tasks', 'tools', 'settings') and '.rail button[data-page]' in js:
        return 1, 'WIRED_DELEGATED'
    if ident == 'mode-radios' and '#mode-radios [data-mode]' in js:
        return 1, 'WIRED_DELEGATED'
    if ident.startswith('launch-') and 'const id = launch-' in js:
        return 1, 'WIRED_DELEGATED'
    if ident.startswith('tools-') and 'data-tooltab' in js:
        return 1, 'WIRED_DELEGATED'
    if ident == 'rsi-run' and "on('rsi-form'" in js:
        return 1, 'WIRED_VIA_FORM'
    if tag in ('div', 'section', 'h1', 'h2', 'h3', 'header', 'aside', 'nav', 'main', 'form', 'label', 'span', 'p'):
        return 0, 'STATIC_MARKUP'
    return 0, 'NOT_WIRED'

def scan_ui():
    html_path = ROOT / "desktop/ui/index.html"
    js_path = ROOT / "desktop/ui/app.js"
    cpath = ROOT / "desktop/src/shared/contract.ts"
    html = html_path.read_text(encoding="utf-8", errors="replace")
    js = js_path.read_text(encoding="utf-8", errors="replace")
    contract = cpath.read_text(encoding="utf-8", errors="replace")

    # page assignment: sections are <section id="chat|projects|tasks|tools|settings" class="page">
    sections = re.split(r'(?=<section\b)', html)
    page_of = {}
    current = "shell"
    for sec in sections:
        m = re.search(r'<section\b[^>]*\bid="([a-z]+)"', sec[:400])
        if m:
            current = m.group(1)
        for mm in UI_ID_RE.finditer(sec):
            if mm.group(2) in ("chat", "projects", "tasks", "tools", "settings"):
                current = mm.group(2)
                page_of[mm.group(2)] = "nav"
                continue
            page_of.setdefault(mm.group(2), current)

    rows = []
    ids = [(m.group(1).lower(), m.group(2)) for m in UI_ID_RE.finditer(html)]
    seen = set()
    wired = notwired = 0
    for tag, ident in ids:
        if ident in seen:
            continue
        seen.add(ident)
        # classify control type
        ctype = "button" if tag == "button" else ("input" if tag in ("input","select","textarea") else
                 ("nav" if tag in ("nav","aside") else "container"))
        # content-based classification fallback
        if ctype == "container" and re.search(r'-btn$|-button$|-toggle$|-run$|-refresh$|-apply$|-save$|-send$', ident):
            ctype = "button"
        if ctype == "container" and re.search(r'^(chk|cb)-', ident):
            ctype = "checkbox"
        refs, status = control_wiring(ident, tag, js)
        if status in ('WIRED', 'WIRED_DELEGATED', 'WIRED_VIA_FORM'):
            wired += 1
        else:
            notwired += 1
        rows.append({
            "page": page_of.get(ident, "shell"),
            "control_id": ident,
            "control_type": ctype,
            "source_file": "desktop/ui/index.html",
            "js_reference": "desktop/ui/app.js",
            "refs_in_app_js": refs,
            "status": status,
            "notes": ("" if refs else ("markup-only; no binding found (actions.json absent)" if status == "NOT_WIRED" else "layout/heading markup; no direct binding expected")),
        })
    # RPC surface rows: parse the RPC_METHODS array from contract.ts
    msec = re.search(r"RPC_METHODS[^=]*=\s*\[(.*?)\]\s*;", contract, re.S)
    body = msec.group(1) if msec else contract
    declared = sorted(set(re.findall(r"""['"]([a-zA-Z][\w.]*)['"]""", body)))
    called = sorted(set(RPC_CALL_RE.findall(js)))
    for m in called:
        rows.append({"page":"rpc","control_id":m,"control_type":"rpc-method-called","source_file":"desktop/ui/app.js",
                     "js_reference":"desktop/ui/app.js","refs_in_app_js":1,"status":"WIRED_UI",
                     "notes":"window.suwen.call invocation present; daemon dispatch not yet verified"})
    for m in declared:
        if m in called:
            continue
        rows.append({"page":"rpc","control_id":m,"control_type":"rpc-method-declared","source_file":"desktop/src/shared/contract.ts",
                     "js_reference":"desktop/ui/app.js","refs_in_app_js":0,"status":"NOT_CALLED",
                     "notes":"declared in RPC_METHODS; no UI call in current app.js"})
    out = ROOT / "docs/verification/ui-action-coverage.csv"
    fields = ["page","control_id","control_type","source_file","js_reference","refs_in_app_js","status","notes"]
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, quoting=csv.QUOTE_ALL)
        w.writeheader(); w.writerows(rows)
    print("ui controls:", wired+notwired, "WIRED:", wired, "NOT_WIRED:", notwired,
          "| rpc called:", len(called), "declared-unused:", len(declared)-len([m for m in declared if m in called]),
          "| total rows:", len(rows))

if __name__ == "__main__":
    write_parity()
    update_master()
    scan_ui()
