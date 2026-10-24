#!/usr/bin/env python
"""Round-3 data migration: master CSV -> 13-field schema (+R122..), parity append,
UI action coverage from desktop/ui/actions.json.

Run from repo root:  python docs/research/repro/round3/round3-data.py
Writes only under docs/.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DOCS = ROOT / "docs"

# ----------------------------------------------------------------------------- master
MASTER = DOCS / "requirements" / "master-requirements.csv"
PARITY = DOCS / "migration" / "feature-parity-matrix.csv"
UI_COV = DOCS / "verification" / "ui-action-coverage.csv"
ACTIONS = ROOT / "desktop" / "ui" / "actions.json"
CONTRACT = ROOT / "desktop" / "src" / "shared" / "contract.ts"
MAIN = ROOT / "desktop" / "src" / "main.ts"

R3_SOURCE = "round-3 prompt docs/requirements/round-3-release-master-prompt.md"
R2_SOURCE = "round-2 register docs/requirements/master-requirements-source.md"

# Per-row overrides for the 71 round-2 rows (only the fields that need precision).
OVR: dict[str, dict[str, str]] = {
    "R001": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/migration/*.md (audit)", "persistence": "n/a"},
    "R002": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/progress.md + desktop/README.md", "persistence": "n/a"},
    "R003": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/migration/copy-verification.md", "persistence": "n/a"},
    "R010": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/migration/python-feature-inventory.md", "persistence": "n/a"},
    "R011": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/migration/feature-parity-matrix.*", "persistence": "n/a"},
    "R012": {"priority": "P1", "ui": "settings import wizard", "ipc": "import.inspect/apply/jobs/rollback", "handler": "src/import-service.ts + src/rpc/core.ts", "persistence": "HARNESS store records + migration backups"},
    "R013": {"priority": "P1", "ui": "research pages", "ipc": "worker.health/describe + research.*", "handler": "src/research-worker.ts + worker/research_worker.py", "persistence": "artifacts + store records"},
    "R014": {"priority": "P1", "ui": "legacy workbench window", "ipc": "legacyStart", "handler": "src/legacy-worker.ts + worker/legacy_server.py", "persistence": "legacy home read-only"},
    "R020": {"priority": "P0", "ui": "five pages chat/projects/tasks/tools/settings", "ipc": "snapshot + events.stream", "handler": "ui/app.js + main.ts"},
    "R021": {"priority": "P0", "ui": "chat timeline/composer", "ipc": "events.stream + conversation.append", "handler": "ui/app.js streaming render", "persistence": "events + conversations"},
    "R022": {"priority": "P0", "ui": "#mode-radios", "ipc": "create (mode-dependent steps)", "handler": "src/rpc/core.ts create + activities/*"},
    "R023": {"priority": "P0", "ui": "tool cards / approval dialog", "ipc": "approval + snapshot", "handler": "src/activities/tools.ts + store approvals"},
    "R024": {"priority": "P1", "ui": "#language toggle", "ipc": "defaults.get/set", "handler": "ui/app.js i18n", "persistence": "preferences.json"},
    "R025": {"priority": "P0", "ui": "tasks page", "ipc": "snapshot/control", "handler": "harness engine/store", "persistence": "tasks/steps/events/checkpoints"},
    "R026": {"priority": "P0", "ui": "evidence panel", "ipc": "evidence.list/artifact.read", "handler": "src/rpc/core.ts + harness/artifacts.ts"},
    "R030": {"priority": "P0", "ui": "main window", "ipc": "suwen:call only", "handler": "src/main.ts + src/preload.cts", "persistence": "n/a"},
    "R031": {"priority": "P0", "ui": "n/a", "ipc": "named-pipe JSON RPC", "handler": "src/daemon.ts + src/security.ts", "persistence": "daemon.lock + connection.json"},
    "R032": {"priority": "P0", "ui": "settings launchAtLogin", "ipc": "login", "handler": "src/main.ts app.setLoginItemSettings", "persistence": "HKCU Run"},
    "R033": {"priority": "P0", "ui": "diagnostics", "ipc": "doctor.run + snapshot", "handler": "harness/store.ts migration", "persistence": "harness.sqlite (WAL, schema v3)"},
    "R034": {"priority": "P0", "ui": "tasks page", "ipc": "control/approval", "handler": "harness/store.ts + engine.ts", "persistence": "tasks/steps/leases/fencing/checkpoints"},
    "R035": {"priority": "P0", "ui": "tasks page", "ipc": "create/control", "handler": "harness/store.ts outbox", "persistence": "outbox + operation_id"},
    "R036": {"priority": "P0", "ui": "evidence + context history", "ipc": "contextHistory/Restore/Compact", "handler": "src/context.ts + harness/artifacts.ts"},
    "R037": {"priority": "P0", "ui": "settings budgets", "ipc": "defaults.set + create limits", "handler": "harness engine budget enforcement", "persistence": "task limits persisted"},
    "R038": {"priority": "P0", "ui": "diagnostics + support bundle", "ipc": "doctor.run + support", "handler": "src/main.ts support + store events"},
    "R039": {"priority": "P0", "ui": "n/a", "ipc": "n/a", "handler": "harness/engine.ts durable workflow interface", "persistence": "SQLite-backed local engine"},
    "R040": {"priority": "P0", "ui": "context panel", "ipc": "contextCompact/contextHistory", "handler": "src/context.ts CompactionService"},
    "R041": {"priority": "P0", "ui": "settings compaction thresholds", "ipc": "defaults.get/set", "handler": "src/context.ts thresholds 0.70/0.82"},
    "R042": {"priority": "P0", "ui": "context history", "ipc": "contextHistory/contextRestore", "handler": "src/context.ts raw log + windows + summary"},
    "R043": {"priority": "P0", "ui": "context panel", "ipc": "contextHistory", "handler": "src/context.ts summary schema"},
    "R044": {"priority": "P0", "ui": "context panel", "ipc": "contextRestore", "handler": "src/context.ts validate"},
    "R045": {"priority": "P0", "ui": "artifacts/evidence panel", "ipc": "artifact.read + evidence.list", "handler": "harness/artifacts.ts + activities/model.ts"},
    "R046": {"priority": "P0", "ui": "settings context preview/restore", "ipc": "contextHistory/Restore/Compact", "handler": "src/context.ts"},
    "R047": {"priority": "P0", "ui": "context panel", "ipc": "contextCompact", "handler": "src/context.ts + test/context.test.ts"},
    "R050": {"priority": "P0", "ui": "n/a", "ipc": "n/a", "handler": "docs/verification/durability-chaos-tests.md + docs/verification/artifacts/chaos-results.json", "persistence": "chaos home temp"},
    "R051": {"priority": "P1", "ui": "research launch-knowledge", "ipc": "research.knowledge + research.graph", "handler": "src/domain/research.ts + activities/research.ts"},
    "R052": {"priority": "P1", "ui": "research launch-hypothesis", "ipc": "research.hypothesis + hypothesis.*", "handler": "src/domain/hypothesis.ts"},
    "R053": {"priority": "P1", "ui": "research launch-methods", "ipc": "research.methods", "handler": "src/domain/research.ts buildMethodsTask"},
    "R054": {"priority": "P1", "ui": "research launch-analysis", "ipc": "research.analysis", "handler": "src/domain/research.ts + worker research_worker.py"},
    "R055": {"priority": "P1", "ui": "research launch-discovery", "ipc": "research.discovery", "handler": "src/domain/research.ts"},
    "R056": {"priority": "P1", "ui": "research launch-autonomy", "ipc": "research.autonomy", "handler": "src/domain/research.ts"},
    "R057": {"priority": "P1", "ui": "evidence panel", "ipc": "research.graph + evidence.list", "handler": "src/domain/research.ts graph/evidence records"},
    "R060": {"priority": "P1", "ui": "tools>MCP", "ipc": "mcp.*", "handler": "src/activities/tools.ts + mcp-client.ts"},
    "R061": {"priority": "P1", "ui": "tools>Skills", "ipc": "skill.*", "handler": "src/activities/tools.ts skill registry"},
    "R062": {"priority": "P1", "ui": "tools>Skills install", "ipc": "skill.install", "handler": "src/activities/tools.ts static checks + isolated test"},
    "R063": {"priority": "P1", "ui": "research launch-knowledge", "ipc": "research.knowledge + real MCP DB calls", "handler": "src/activities/databases.ts (Europe PMC / UniProt)", "persistence": "evidence records + artifacts"},
    "R064": {"priority": "P1", "ui": "tools>RSI", "ipc": "rsi.*", "handler": "src/domain/rsi.ts"},
    "R070": {"priority": "P1", "ui": "tools>Channels", "ipc": "channel.*", "handler": "src/domain/channels.ts"},
    "R071": {"priority": "P1", "ui": "tools>Channels readOnly", "ipc": "channel.save + channel.send", "handler": "src/domain/channels.ts policy"},
    "R080": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/research/deepseek-harness-audit.md + docs/architecture/reuse-decision.md", "persistence": "n/a"},
    "R081": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/research/kongming-*.md", "persistence": "n/a"},
    "R090": {"priority": "P1", "ui": "app name/title/installer", "ipc": "n/a", "handler": "package.json appId/productName + installer NSIS", "persistence": "legacy compat read paths"},
    "R091": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/research/branding-exceptions.md + branding-scan.csv", "persistence": "n/a"},
    "R092": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "LICENSE/NOTICE/third-party-licenses + SBOM", "persistence": "n/a"},
    "R093": {"priority": "P0", "ui": "settings credentials", "ipc": "configure + secrets.*", "handler": "src/main.ts safeStorage + src/security.ts", "persistence": "encrypted model-config.enc / secrets.enc"},
    "R094": {"priority": "P1", "ui": "n/a", "ipc": "n/a", "handler": "docs/verification/third-party-dependencies.md + security-scan.mjs", "persistence": "n/a"},
    "R100": {"priority": "P0", "ui": "installer", "ipc": "n/a", "handler": "electron-builder nsis + SHA256SUMS", "persistence": "install dir + HKCU registry"},
    "R101": {"priority": "P1", "ui": "python picker/settings", "ipc": "python + worker.health", "handler": "src/main.ts pythonPicker + daemon probe", "persistence": "preferences.json"},
    "R102": {"priority": "P1", "ui": "installer upgrade", "ipc": "n/a", "handler": "upgrade-path artifacts + store migration backup", "persistence": "harness.sqlite backup + legacy import"},
    "R103": {"priority": "P1", "ui": "installer disclosure", "ipc": "n/a", "handler": "docs/release/windows-installer-verification.md SmartScreen section", "persistence": "n/a"},
    "R110": {"priority": "P0", "ui": "chat composer/timeline", "ipc": "create/control/events.stream", "handler": "ui/app.js + daemon", "persistence": "conversations/events/tasks"},
    "R111": {"priority": "P0", "ui": "settings providers", "ipc": "configure", "handler": "src/providers.ts adapters", "persistence": "safeStorage config"},
    "R112": {"priority": "P0", "ui": "research knowledge", "ipc": "research.knowledge", "handler": "activities/databases.ts real queries", "persistence": "evidence records + artifacts"},
    "R113": {"priority": "P1", "ui": "tools>Skills", "ipc": "skill.install/test", "handler": "activities/tools.ts", "persistence": "skill records"},
    "R114": {"priority": "P1", "ui": "research analysis", "ipc": "research.analysis", "handler": "worker/research_worker.py + activities/research.ts"},
    "R115": {"priority": "P1", "ui": "research debate", "ipc": "research.debate", "handler": "domain/hypothesis.ts buildDebateTask"},
    "R116": {"priority": "P0", "ui": "tasks/diagnostics", "ipc": "snapshot/control/doctor.run", "handler": "harness engine + daemon", "persistence": "tasks/events/checkpoints"},
    "R117": {"priority": "P0", "ui": "context panel", "ipc": "contextCompact/History/Restore", "handler": "src/context.ts", "persistence": "contexts/* hash versions"},
    "R118": {"priority": "P0", "ui": "approval dialog", "ipc": "approval + path guards", "handler": "main.ts/security.ts + activities/tools.ts", "persistence": "approvals in store"},
    "R119": {"priority": "P0", "ui": "installer", "ipc": "n/a", "handler": "installer lifecycle artifacts", "persistence": "install dir + data retention"},
    "R120": {"priority": "P0", "ui": "docs", "ipc": "n/a", "handler": "mandatory reports under docs/", "persistence": "n/a"},
    "R121": {"priority": "P0", "ui": "docs", "ipc": "n/a", "handler": "final acceptance report", "persistence": "n/a"},
}

NEW_ROWS = [
    # id, feature, priority, module, ui, ipc, handler, persistence, test, evidence, status, blocker
    ("R122", "Typed streaming event protocol: versioned StreamEnvelope (eventId/sequence/taskId/stepId/type/sourceType/at/payload) and events.stream batch with cursor/reset/tasks/streams; persisted store events mapped to protocol types", "P0", "desktop/src/stream-events.ts; desktop/src/shared/contract.ts (STREAM_EVENT_SCHEMA_VERSION=1); daemon.ts events.stream", "chat timeline", "events.stream", "stream-events.ts collectStreamEvents + daemon dispatch", "harness.sqlite events + live model buffers", "test/stream-events.test.ts (unit)", "Lead: protocol implemented; unit test file exists; npm test 150/148/2 exit0 (2026-10-25 final build)", "UNVERIFIED", "Streaming UI matrix (T2) and final acceptance run not yet reported; no runtime UI verification recorded by D."),
    ("R123", "Event ordering, duplicate suppression, cursor/replay and reconnect semantics; stale events never overwrite newer content; late events after cancel ignored", "P0", "desktop/src/stream-events.ts; desktop/src/main.ts (events.stream poll + onEvent)", "chat timeline", "events.stream", "main.ts poll loop since=cursor; ui/app.js dedupe", "events table sequence ordering", "test/stream-events.test.ts; e2e-rpc.mjs (42 pass)", "Lead: e2e-rpc 42/0 ~7 s; unit tests 150/148/2", "UNVERIFIED", "Runtime dedupe/replay matrix on T2 list; no replay E2E with daemon disconnect recorded by D."),
    ("R124", "Incremental streaming render (no whole-page rebuild): stream buffer, batched/rAF updates, exact message_id updates, stable keys, memoized sections", "P0", "desktop/ui/app.js", "chat timeline", "events.stream + snapshot", "app.js render pipeline", "n/a", "ui-dom-qa.mjs (19 pass/0 fail/10 warn)", "Lead: ui-dom-qa 19/0/10; app.js rewritten (167,838 B earlier / current T1/T2 edit)", "UNVERIFIED", "T2 stream render implementation in progress; quantitative matrix pending."),
    ("R125", "Composer stability: no jump, height unchanged by message renders, caret/draft/IME preserved, Enter/Shift+Enter consistent, per-conversation drafts", "P0", "desktop/ui/app.js; index.html #composer", "chat #composer", "events.stream + conversation.append", "app.js composer state", "localStorage draft per conversation", "ui-dom-qa.mjs", "Lead: ui-dom-qa 19/0/10", "UNVERIFIED", "No composer displacement measurement artifact yet (T2)."),
    ("R126", "Smart scrolling: follow-latest vs reading-history intent, no force jumps, back-to-latest, anchor preservation, virtualization keeps selection", "P0", "desktop/ui/app.js", "chat #timeline", "events.stream", "app.js scroll controller", "n/a", "ui-dom-qa.mjs", "Lead: ui-dom-qa 19/0/10", "UNVERIFIED", "Scroll-intent matrix not recorded; T2 evidence pending."),
    ("R127", "Markdown/complex content streaming safety: incremental display, local degradation for LaTeX/Mermaid, no main-thread block, sanitized HTML", "P0", "desktop/ui/app.js", "chat messages", "events.stream", "app.js markdown renderer", "n/a", "ui-dom-qa.mjs", "Lead: ui-dom-qa 19/0/10", "UNVERIFIED", "Complex-content matrix and sanitizer audit not reported by T2."),
    ("R128", "Reasoning/tool/answer separation: run status, thinking summaries, tool calls collapsed/expandable, results and final answer hierarchy", "P1", "desktop/ui/app.js", "chat tool cards", "events.stream + snapshot", "app.js + store events", "events + task steps", "ui-dom-qa.mjs", "Lead: ui-dom-qa 19/0/10", "UNVERIFIED", "Visual hierarchy audit pending (T2)."),
    ("R129", "Single run state machine (idle/connecting/preparing/streaming/tool_running/waiting_approval/compacting/reconnecting/paused/cancelling/completed/failed/cancelled) with consistent actions", "P0", "desktop/src/shared/contract.ts; desktop/ui/app.js", "chat status row", "events.stream + control", "main.ts event mapping; app.js state", "task status in store", "test/stream-events.test.ts", "Lead: e2e-rpc 42/0; npm test 150/148/2", "UNVERIFIED", "UI state-machine conformance matrix not recorded."),
    ("R130", "Cancel/timeout/reconnect really verified (streaming, tool, python worker, provider 429/5xx, UI close/reopen, rapid clicks)", "P0", "desktop/src/main.ts; daemon control; worker", "chat stop button", "control + events.stream", "daemon control + engine cancel", "task cancellation events", "e2e-rpc.mjs; chaos-smoke.mjs", "Lead: e2e-rpc 42/0; chaos 12/12 incl cancel; no UI-click matrix", "UNVERIFIED", "UI-driven cancel/reconnect scenarios not measured."),
    ("R131", "Renderer error isolation: per-message error boundary, unhandled rejection monitoring, renderer crash diagnostics with user feedback", "P0", "desktop/ui/app.js; desktop/src/main.ts", "chat/global", "n/a (renderer-local)", "app.js error boundary", "diagnostics log", "ui-dom-qa.mjs", "Lead: ui-dom-qa 19/0/10", "UNVERIFIED", "Crash/white-screen injection test not recorded."),
    ("R132", "Quantitative streaming acceptance matrix: 100/1,000/10,000 events, long chunks, tables, code across deltas, zh/en Unicode, two parallel runs, duplicate/out-of-order replay, malformed JSON", "P0", "desktop/ui + scripts", "chat", "events.stream", "T2 streaming test harness", "n/a", "TBD (T2)", "No matrix artifact yet", "NOT_STARTED", "T2 streaming/visual audit not complete; deterministic replay harness missing."),
    ("R133", "Reproduce and fix known failures: Unknown RSI run, RPC E2E failures, activity-handler registration inconsistency, UI/backend sync, Python worker ↔ harness bridge", "P0", "desktop/src/domain/rsi.ts; daemon.ts handler merge; activities/*", "RSI/tools/tasks", "rsi.*/research.*", "rsi.ts validation + daemon handlers core+capabilities merged", "store records", "e2e-rpc.mjs (42/0); npm test", "Lead: e2e-rpc 42/0; daemon merges { ...core, ...capabilities } (daemon.ts:180)", "UNVERIFIED", "Per-defect regression entries not yet itemized with reproductions; see defect-register.csv."),
    ("R134", "Durable runtime re-verification: daemon/Python worker crash recovery, reboot recovery, lease reclaim, idempotency, checkpoint; real 8/24/72h endurance", "P0", "desktop/src/harness/*; daemon.ts", "tasks/diagnostics", "snapshot/control", "engine/store recovery", "harness.sqlite", "chaos-smoke.mjs; dur tests 150/148/2", "Lead: chaos 12/12 in 52.2 s (short window); 8/24/72h NOT run; reboot NOT run", "UNVERIFIED", "No 8/24/72h, no sleep/hibernate/power-loss/reboot/disk-full run."),
    ("R135", "Every interactive UI element has a real call chain UI → IPC/RPC → harness/worker/DB → UI echo; no saved-but-unused config", "P0", "desktop/ui/*; desktop/ui/actions.json (142 actions)", "all five pages", "actions.json method map", "app.js handlers", "preferences/store", "ui-dom-qa.mjs (19 checks)", "Lead: actions.json 142; ui-dom-qa 19/0/10; D regenerates coverage CSV", "UNVERIFIED", "Runtime click-through of all 142 actions not performed/recorded."),
    ("R136", "Visual auto-acceptance screenshots: 1920×1080/1366×768, normal/small window, 125%/150% scaling, dark/light, zh/en; occlusion/overlap/blank/error-hint checks", "P1", "desktop/ui; scripts", "all pages", "n/a", "T2 visual audit harness", "n/a", "TBD (T2)", "No visual audit artifact yet", "NOT_STARTED", "T2 visual audit pending."),
    ("R137", "Clean Windows user environment install → first start → configure → conversation → tool call → research task → exit/reopen → upgrade → uninstall retention, on a clean machine", "P0", "installer; docs/release/windows-installer-verification.md", "installer", "n/a", "NSIS + lifecycle harness", "install dir + HKCU + user data", "installer-lifecycle.json (14/14 host); upgrade-path.json (8/8)", "Host probes passed on final artifact; clean VM NOT available/run", "UNVERIFIED", "Clean Windows VM lifecycle not run (host-only evidence)."),
    ("R138", "MIT open-source publication to GitHub: repo review, secret scan/history, LICENSE/NOTICE/SBOM, commit/tag/Release asset upload and online verification", "P0", "docs/release/github-publication.md; .github/workflows", "n/a", "n/a", "git remote/git CLI", "git repo", "security-scan.mjs (PASS)", "Remote https://github.com/ForrestGump618/suwen.git reachable main=8cabac3; gh CLI absent; no GitHub token in session", "BLOCKED_EXTERNAL", "GitHub CLI/auth unavailable; publication not attempted."),
    ("R139", "Six research capabilities real E2E: knowledge, hypothesis, methods, analysis, discovery, autonomy — real data and durable DAG, thesis with citations", "P1", "desktop/src/domain/research.ts; activities/research.ts; worker research_worker.py", "7 research launchers", "research.*", "capabilities.ts submitTask + domain builders", "researchGraph/evidence records + artifacts", "domain tests (research-activity/domain-research); e2e-rpc 42/0", "Lead: handler tests in npm test; real E2E run pending final evidence", "UNVERIFIED", "Round-3 real E2E evidence not yet supplied; external integrations (Biomni/Paper2Agent/ERA/Robin/Kosmos) not bundled."),
    ("R140", "Multi-model debate rules: challenge/referee non-unilateral/rebuttal/evidence conclusion/disagreement preserved/records traceable", "P1", "desktop/src/domain/hypothesis.ts", "research launch-debate", "research.debate + research.graph", "buildDebateTask", "evidence + debate records", "domain-research tests", "Lead: unit/domain tests pass; real multi-model run not supplied", "UNVERIFIED", "No real multi-model account run; rules implemented but not runtime-verified."),
    ("R141", "MCP/Skill/provider/channel/RSI real checks: install→discover→call→disable, skill parse/permissions/test, ≥2 providers streaming/tool/error, channel test with unauthorized-access denial, RSI promote/rollback", "P1", "src/activities/tools.ts; src/domain/channels.ts; src/domain/rsi.ts; providers.ts", "tools pages", "mcp.*/skill.*/channel.*/rsi.*", "tools/channels/rsi handlers", "records + secret refs", "channels.test.ts/rsi.test.ts/tools.test.ts (npm test)", "Lead: npm test 150/148/2; e2e-rpc 42/0 includes registries", "UNVERIFIED", "Real external accounts/Telegram/Slack absent (BLOCKED_EXTERNAL); live GitHub skill install not exercised."),
    ("R142", "Performance baseline: daemon cold/warm start, RPC burst latency, events.stream payload/latency, SQLite/WAL growth, daemon RSS, Python worker health/flowSummary", "P1", "desktop/scripts/performance-baseline.mjs; docs/verification/performance-baseline.md", "n/a", "events.stream/create/health", "performance-baseline.mjs (real compiled daemon + Python worker)", "docs/verification/artifacts/performance-baseline.json", "performance-baseline.mjs --out docs/verification/artifacts/performance-baseline.json", "D ran 2026-10-24T18:09Z: cold p50 391ms (n=3), warm p50 374ms (n=2), create p50 0.82ms, events.stream p50 1.49ms/90 events/26,467B, WAL 3.27MB, daemon RSS 79,872KB, worker flowSummary 20.9ms/6000 events", "IMPLEMENTED_PASS", "Electron UI launch, markdown CPU, first-token via real provider, 8/24/72h not measured."),
    ("R143", "Security review: Electron IPC/contextIsolation/CSP/shell injection/path traversal/prompt-MCP output injection/SSRF/API-key leak/log secrets/DB permissions/file overwrite approval; automated secret scan", "P0", "docs/verification/security-review.md; desktop/scripts/security-scan.mjs", "n/a", "suwen:call validation", "main.ts/security.ts/import-service.ts guards", "n/a", "security-scan.mjs --out artifacts/security-scan.json", "D ran 2026-10-25T02:13+08: security-scan PASS 0 HIGH / 48 LOW / 14 accepted test fixtures; tracked 638; 17 commits; npm audit --omit=dev 0 vulnerabilities", "IMPLEMENTED_PASS", "No OS-level sandbox/quotas; no pentest; template/HTML sanitizer and prompt-injection behavior not dynamically tested."),
    ("R144", "OS-level sandbox/CPU/memory/disk quotas for Python worker and remote/Temporal workers", "P1", "desktop/worker/research_worker.py; src/research-worker.ts", "n/a", "python/worker.*", "sandbox per run (temp home, timeouts, output caps, env allowlist)", "sandbox dirs", "research-worker.test.ts (22/21/1 skip)", "Lead: worker tests 22/21/1; sandbox limits in protocol", "NOT_STARTED", "OS-level quotas/remote workers not implemented (documented gap)."),
    ("R145", "Diagnostics center: Electron/daemon/worker/provider/MCP status, tasks, errors, checkpoints, tokens/cost, CPU/memory, DB, version, redacted support bundle", "P1", "desktop/ui/app.js settings>diagnostics; src/main.ts support", "settings page", "doctor.run/support/worker.health", "core.ts doctor + main.ts support bundle", "diagnostics JSON", "ui-dom-qa.mjs; doctor tests", "Lead: doctor 11 checks in e2e-rpc; ui-dom-qa 19/0/10", "UNVERIFIED", "CPU/memory and token/cost live display not verified; bundle content reviewed only statically."),
    ("R146", "Mandatory round-3 reports: requirements 13-field CSV, parity matrix, ui-action-coverage, ui-streaming-stability, ui-visual-audit, e2e-results, durability-chaos, security-review, performance-baseline, defect-register, release-gates, installer verification, final acceptance, progress", "P0", "docs/** deliverable set", "docs", "n/a", "D-authored reports", "docs files", "file presence + content checks", "D created/updated: master CSV 13-field + R122-R148, feature-parity CSVs, ui-action-coverage.csv, security-review.md, performance-baseline.md, defect-register.csv, release-gates.md, final-acceptance-report.md, github-publication.md, CHANGELOG.md, release-notes-v3.2.0.md, progress.md; T2-owned ui-streaming-stability/ui-visual-audit/e2e-results pending", "IMPLEMENTED_PASS", "T2/T3-owned reports (ui-streaming-stability.md, ui-visual-audit.md, e2e-results.md) not yet written; final acceptance awaits Lead numbers."),
    ("R147", "Release gates G1-G9 with PASS/FAIL/BLOCKED/UNVERIFIED and evidence links; defect register governance", "P0", "docs/release/release-gates.md; docs/verification/defect-register.csv", "docs", "n/a", "D-authored gates", "docs files", "file presence + content", "D created release-gates.md (9 gates) and defect-register.csv; statuses evidence-based", "IMPLEMENTED_PASS", "Gates 3/4/5/6/8/9 remain open/blocked as documented."),
    ("R148", "Version 3.2.0 release documentation: CHANGELOG, release notes, installer hash after rebuild", "P0", "docs/release/CHANGELOG.md; docs/release/release-notes-v3.2.0.md", "docs", "n/a", "D-authored", "docs files", "n/a", "D wrote CHANGELOG/release notes for 3.2.0; current installer artifact is 3.1.0 (129,425,145 B, E1A1062C...) — 3.2.0 rebuild PENDING_LEAD", "UNVERIFIED", "3.2.0 installer not yet built; hash PENDING_LEAD."),
]

PRIORITY_R2 = {
    **{f"R0{i}": "P0" for i in ("20", "21", "22", "23", "24", "25", "26", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47")},
    **{f"R0{i}": "P1" for i in ("01", "02", "03", "10", "11", "12", "13", "14", "50", "51", "52", "53", "54", "55", "56", "57", "60", "61", "62", "63", "64", "70", "71", "80", "81", "90", "91", "92", "93", "94", "00")},
    **{f"R1{i}": "P0" for i in ("00", "01", "03", "10", "11", "12", "16", "17", "18", "19", "20", "21")},
    **{f"R1{i}": "P1" for i in ("02", "13", "14", "15")},
}


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def feature_of(summary: str) -> str:
    text = " ".join(summary.split())
    return text[:340]


def master_13(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    out = []
    for row in rows:
        rid = row["id"].strip()
        ov = OVR.get(rid, {})
        out.append({
            "Requirement ID": rid,
            "Feature": feature_of(row.get("requirement_summary", "")),
            "Priority": ov.get("priority") or PRIORITY_R2.get(rid, "P1"),
            "Source": R2_SOURCE,
            "Implementation Module": row.get("code_paths", ""),
            "UI Entry": ov.get("ui", "n/a"),
            "IPC/RPC": ov.get("ipc", "n/a"),
            "Backend Handler": ov.get("handler", ""),
            "Persistence": ov.get("persistence", "n/a"),
            "Test ID": row.get("test_or_log", ""),
            "Evidence": row.get("vnext_evidence", ""),
            "Status": row.get("status", "UNVERIFIED"),
            "Blocker": row.get("remaining_gap", ""),
        })
    for rid, feature, priority, module, ui, ipc, handler, persistence, test, evidence, status, blocker in NEW_ROWS:
        out.append({
            "Requirement ID": rid, "Feature": feature, "Priority": priority, "Source": R3_SOURCE,
            "Implementation Module": module, "UI Entry": ui, "IPC/RPC": ipc, "Backend Handler": handler,
            "Persistence": persistence, "Test ID": test, "Evidence": evidence, "Status": status, "Blocker": blocker,
        })
    return out


PARITY_NEW = [
    ("Typed streaming event protocol (events.stream + StreamEnvelope v1)", "streaming",
     "SSE events with replay, no typed envelope schema", "runtime/events.py, web/js/sse.js",
     "prototype had append-only stream text, no event envelope", "ui/app.js pre-round-3",
     "UNVERIFIED", "desktop/src/stream-events.ts; contract.ts", "rewritten", "n/a",
     "P0", "test/stream-events.test.ts", "Runtime UI matrix pending; unit test file exists"),
    ("Incremental streaming render (no whole-page rebuild)", "streaming",
     "SSE incremental append per event (not typed)", "web/js/views/chat.js",
     "full-history rerender in prototype", "chat.js prototype",
     "UNVERIFIED", "desktop/ui/app.js", "rewritten", "n/a",
     "P0", "ui-dom-qa.mjs", "T2 implementation in progress; quantitative matrix pending"),
    ("Composer stability (no jump/caret reset/draft loss, IME)", "streaming",
     "basic composer", "web/js/views/chat.js",
     "prototype input jitter risk documented", "docs/architecture/current.md",
     "UNVERIFIED", "desktop/ui/app.js + index.html", "rewritten", "n/a",
     "P0", "ui-dom-qa.mjs", "Displacement measurement pending"),
    ("Scroll intent / follow-latest / anchor preservation", "streaming",
     "basic scroll", "web/js/views/chat.js",
     "prototype no virtualization", "current.md",
     "UNVERIFIED", "desktop/ui/app.js", "rewritten", "n/a",
     "P0", "ui-dom-qa.mjs", "Scroll matrix pending"),
    ("Markdown/complex content streaming safety", "streaming",
     "markdown render with live patches", "web/js/markdown.js",
     "prototype full rerender", "chat.js",
     "UNVERIFIED", "desktop/ui/app.js", "rewritten", "n/a",
     "P0", "ui-dom-qa.mjs", "Sanitizer/complex matrix pending"),
    ("Run state machine single source of truth", "streaming",
     "multiple booleans in prototype UI", "web/js/views/chat.js",
     "prototype booleans", "chat.js",
     "UNVERIFIED", "desktop/src/shared/contract.ts + app.js", "rewritten", "n/a",
     "P0", "test/stream-events.test.ts", "Conformance matrix pending"),
    ("Cancel/timeout/reconnect real E2E", "streaming",
     "real cancel via FastAPI runs", "runtime/runs.py; web/js/sse.js",
     "prototype SSE reconnect", "sse.js",
     "UNVERIFIED", "desktop control/events.stream", "rewritten", "n/a",
     "P0", "e2e-rpc.mjs; chaos results", "UI-driven matrix pending"),
    ("Renderer error isolation", "streaming",
     "no renderer (browser only)", "n/a",
     "n/a", "n/a",
     "UNVERIFIED", "desktop/ui/app.js", "new", "n/a",
     "P0", "ui-dom-qa.mjs", "Crash injection not tested"),
    ("Quantitative streaming acceptance matrix", "streaming",
     "n/a", "n/a", "n/a", "n/a",
     "NOT_STARTED", "T2 harness", "new", "n/a",
     "P0", "TBD", "100/1k/10k matrix not run"),
    ("Visual auto-acceptance screenshot matrix", "streaming",
     "n/a", "n/a", "n/a", "n/a",
     "NOT_STARTED", "T2 harness", "new", "n/a",
     "P1", "TBD", "T2 visual audit pending"),
    ("Clean-Windows-VM install/upgrade/uninstall lifecycle", "release",
     "Python wheel/sdist install (no desktop installer)", "scripts/publish.ps1; pyproject.toml",
     "host lifecycle 14/14 + upgrade 8/8 on 3.1.0 final artifact", "docs/verification/artifacts/installer-lifecycle.json",
     "UNVERIFIED", "installer NSIS + upgrade artifacts", "rewritten", "legacy data import",
     "P0", "installer-lifecycle.json", "Clean VM not run"),
    ("GitHub MIT publication + Release asset upload", "release",
     "repo public with Python project", "git remote",
     "remote reachable main=8cabac3; gh CLI absent", "git ls-remote",
     "BLOCKED_EXTERNAL", "docs/release/github-publication.md", "new", "n/a",
     "P0", "git ls-remote", "gh CLI/token absent"),
    ("Security review + automated secret/credential scan", "security",
     "DPAPI vault, origin checks, no CSP", "suwen/vault.py; server/app.py",
     "CSP + contextIsolation + IPC sender checks + safeStorage + path guards; scan PASS", "desktop/scripts/security-scan.mjs",
     "IMPLEMENTED_PASS", "docs/verification/security-review.md", "new", "n/a",
     "P0", "security-scan.mjs", "No OS sandbox/quotas; no pentest"),
    ("Performance baseline measurement", "performance",
     "none recorded", "n/a",
     "daemon/RPC/worker baseline measured", "docs/verification/artifacts/performance-baseline.json",
     "IMPLEMENTED_PASS", "desktop/scripts/performance-baseline.mjs", "new", "n/a",
     "P1", "performance-baseline.mjs", "UI launch/markdown CPU/first-token not measured"),
    ("Defect register + release gates governance", "release",
     "none", "n/a",
     "gates + defect register authored", "docs/release/release-gates.md",
     "IMPLEMENTED_PASS", "docs/verification/defect-register.csv", "new", "n/a",
     "P0", "file presence", "Open gates documented; not all closed"),
]


def parity_append(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    header = list(rows[0].keys())
    out = list(rows)
    for item in PARITY_NEW:
        (capability, category, py_base, py_ev, proto, proto_ev, status, code, reuse, data, prio, test, gaps) = item
        rec = {k: "" for k in header}
        rec.update({
            "capability": capability, "category": category, "python_baseline": py_base,
            "python_evidence": py_ev, "desktop_prototype": proto, "prototype_evidence": proto_ev,
            "vnext_status": status, "vnext_code": code, "reuse_mode": reuse,
            "data_migration": data, "priority": prio, "test_id": test, "gaps": gaps,
        })
        out.append(rec)
    return out


def ui_coverage() -> tuple[list[dict[str, str]], dict[str, int]]:
    actions = json.loads(ACTIONS.read_text(encoding="utf-8"))
    contract_text = CONTRACT.read_text(encoding="utf-8")
    m = re.search(r"RPC_METHODS = \[(.*?)\] as const;", contract_text, re.S)
    rpc = set(re.findall(r"'([^']+)'", m.group(1))) if m else set()
    main_text = MAIN.read_text(encoding="utf-8")
    mm = re.search(r"MAIN_ONLY=new Set\(\[(.*?)\]\)", main_text)
    main_only = set(re.findall(r"'([^']+)'", mm.group(1))) if mm else set()
    rows = []
    counts = {"daemon_rpc": 0, "main_process": 0, "ui_only": 0, "unknown_method": 0}
    for action in actions:
        method = action.get("method") or ""
        if not method:
            kind, status = "ui_only", "WIRED_UI_ONLY"
            contract = "n/a"
            counts["ui_only"] += 1
        elif method in main_only:
            kind, status = "main_process", "WIRED_MAIN_PROCESS"
            contract = "main.ts MAIN_ONLY"
            counts["main_process"] += 1
        elif method in rpc:
            kind, status = "daemon_rpc", "WIRED_DAEMON_RPC"
            contract = "contract.ts RPC_METHODS"
            counts["daemon_rpc"] += 1
        else:
            kind, status = "unknown", "UNKNOWN_METHOD"
            contract = "not declared"
            counts["unknown_method"] += 1
        rows.append({
            "action_id": action.get("id", ""),
            "page": action.get("page", ""),
            "selector": action.get("selector", ""),
            "method": method,
            "method_kind": kind,
            "contract_declared": contract,
            "wired_status": status,
            "evidence": "desktop/ui/actions.json (142 actions) + contract.ts RPC_METHODS + ui-dom-qa.mjs 19 passed/0 failed/10 warnings (Lead run 2026-10-25)",
            "notes": " ".join(str(action.get("notes") or "").split())[:200],
            "runtime_verified": "not individually recorded in a click-through matrix (see docs/verification/ui-streaming-stability.md / e2e-results.md)",
        })
    return rows, counts


def write_csv(path: Path, rows: list[dict[str, str]], header: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    master_rows = read_rows(MASTER)
    new_master = master_13(master_rows)
    header = ["Requirement ID", "Feature", "Priority", "Source", "Implementation Module", "UI Entry",
              "IPC/RPC", "Backend Handler", "Persistence", "Test ID", "Evidence", "Status", "Blocker"]
    write_csv(MASTER, new_master, header)

    parity_rows = read_rows(PARITY)
    new_parity = parity_append(parity_rows)
    write_csv(PARITY, new_parity, list(parity_rows[0].keys()))

    cov_rows, counts = ui_coverage()
    write_csv(UI_COV, cov_rows, list(cov_rows[0].keys()))

    from collections import Counter
    status = Counter(r["Status"] for r in new_master)
    pstatus = Counter(r.get("vnext_status", "") for r in new_parity)
    print(f"master rows={len(new_master)} status={dict(status)}")
    print(f"parity rows={len(new_parity)} status={dict(pstatus)}")
    print(f"ui coverage rows={len(cov_rows)} counts={counts}")


if __name__ == "__main__":
    main()
