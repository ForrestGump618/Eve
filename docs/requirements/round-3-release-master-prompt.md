# Round 3 requirement source — Release Master Prompt v3.0 (transcribed 2026-10-25)

Status: active requirements for the current round (supersedes round-2 completion claims).
Origin: user message "SuWen vNext — Release Master Prompt v3.0" (2026-10-25).
This file is the authoritative checklist for round 3; do not weaken or delete items.

## 0. Mission and permissions

Final engineering convergence and release execution for SuWen Desktop vNext — not consulting,
not a plan, not scaffolding. Must directly modify code, fix, test, verify, build, publish.
When the environment allows, automatically complete every step that needs no extra
authorization; only mark `BLOCKED_EXTERNAL` for genuinely unavailable credentials/platform
permissions/inaccessible environments. Never fabricate results, pass rates, installers, GitHub
links, or model API successes.

Goals: (1) implement+verify all existing requirements; (2) Python legacy functions not lost;
(3) every page/button/setting/tool has a real call chain; (4) UI stable during model streaming
(no layout jitter, render errors, message mixing, or dead interactions); (5) durable harness,
long tasks, compaction, DB and worker recovery reliable; (6) research agents, MCP, Skills,
multi-model debate and analysis really usable; (7) Windows install/upgrade/uninstall/failure
recovery verified; (8) security scan, license audit, MIT open-source readiness; (9) after all
release gates pass, upload to GitHub, create Release, upload Windows installer; (10) verifiable
repo/version/installer/full acceptance evidence.

Architecture stays: Electron + TS desktop, renderer/preload/main, independent Node harness
daemon, SQLite WAL, Python research worker, MCP/Skill registry, LLM adapters, durable task DAG,
context compaction/memory, research agents, multi-agent debate, channels, constrained RSI.
Do not restructure again without code evidence that it is unmaintainable.

## 1. Workspace protection

Sole dev directory: `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`. Source
Python/Desktop dirs are read-only reference. Before work inspect cwd, git root, branch, remote,
HEAD, uncommitted changes, build tools, package.json/lock, tests, CI, DB schema/migrations,
existing requirement/test matrices, Windows build capability, GitHub CLI auth. Do not assume the
previous round finished everything. Preserve valid uncommitted work; create recoverable git
commits/backups before major changes.

## 2. Requirement truth source

Maintain `docs/requirements/master-requirements.csv` with at least: Requirement ID, Feature,
Priority, Source, Implementation Module, UI Entry, IPC/RPC, Backend Handler, Persistence,
Test ID, Evidence, Status, Blocker. Allowed statuses: IMPLEMENTED_PASS / FAIL /
BLOCKED_EXTERNAL / NOT_STARTED / UNVERIFIED. Only real functional verification may be marked
IMPLEMENTED_PASS; code existing, renderable component, declared interface, mock-based tests or
generated docs do NOT count.

Parity audit must cover: model/provider config; sessions/history; projects/workspaces;
Agent/sub-agents; multi-model discussion; files/attachments; research retrieval/analysis;
Memory/Embedding; context compaction; MCP; Skills; Workflow; message channels; RSI; security
approvals; diagnostics/logs; data import/export. No silent deletion, degradation or empty
replacement of existing functions; record explicit differences + verifiable alternatives.

## 3. P0 streaming UI stability (highest priority)

Goal: UI remains stable, operable and data-consistent whenever the model streams, regardless of
length, tool calls, structured content or phase changes. Audit streaming protocol, state
management, message model, render strategy, scroll control, lifecycle and backend transport —
not just CSS.

### 3.1 Typed event protocol

Suggested types: run.started, message.started, message.delta, message.completed,
reasoning.started/delta/completed, tool.started/progress/completed/failed, artifact.created,
context.compaction.started/completed, run.paused/resumed/cancelled/failed/completed,
connection.reconnecting/restored. Every event: run_id, conversation_id, message_id, event_id,
sequence, timestamp, event_type, payload, schema_version. Events must locate their run/message.
Multiple runs in one conversation must be isolated. Never append raw tokens to a global chat
string.

Consistency: (1) verifiable event order per message; (2) duplicate events must not duplicate
text; (3) stale events must not overwrite newer conversation content; (4) after switching
conversations old runs keep their own conversation; (5) late events after cancellation must not
modify the terminal message; (6) tool call/tool result linkage correct; (7) a run completion
event only terminates its own run; (8) reconnect restores via checkpoint/event replay; (9)
reconnect uses cursor/sequence to avoid gaps/duplicates; (10) event schema changes need
compatibility policy. Explicitly define out-of-order/duplicate/lost/replay behavior.

### 3.2 Stable streaming render

No whole-page rebuild per token. Incremental state updates + batched rendering: stream buffer,
rAF or equivalent frame scheduling, load-based coalescing, exact update by message_id, stable
keys, isolated subscriptions, memoization as needed. Typical 16–50 ms batch window, adapt under
high load, never drop characters, flush remaining buffer when done, no fixed sleep to hide
races. Parameters measurable/adjustable.

### 3.3 Absolutely stable composer

During output: no vertical jumping; height unchanged by unrelated message renders; caret not
reset; draft preserved; IME Chinese input uninterrupted; Enter/Shift+Enter consistent;
per-conversation draft saved on switch; send button state correct; copy/scroll/select history
works; don't disable the whole UI unnecessarily. Use a stable composer container independent of
the message stream, responsive layout not frequent re-measure of absolute positions.

### 3.4 Smart scrolling

Distinguish reading history vs following latest. (1) near bottom auto-follow; (2) user scroll up
stops auto-scroll; (3) new content never force-jumps to bottom; (4) "back to latest" restores
follow; (5) conversation switch keeps reasonable position; (6) async code/table/image loads
don't move reading position; (7) long-message virtualization preserves selection/copy; (8) tool
panel expand/collapse must not jump. Use anchor preservation or equivalent.

### 3.5 Markdown / complex content

Inputs: Markdown, LaTeX, code blocks, tables, Mermaid, quotes, JSON, multilingual, very long
single lines, file/artifact refs, images/charts, structured research results. Requirements: (1)
incomplete output must not flicker whole page; (2) avoid continuous expensive highlighting for
unfinished code blocks; (3) large tables have controlled overflow; (4) code blocks scroll+copy
independently; (5) LaTeX failure degrades locally, never crashes page; (6) Mermaid isolated +
error handled; (7) images/async visuals avoid layout shift; (8) long content must not block main
thread; (9) sanitize Markdown HTML against script injection; (10) unfinished output still
readable. Suggested: lightweight incremental display during streaming; enhance stable segments;
full normalized render when done. Never lose model content for visual stability.

### 3.6 Reasoning / tool / answer separation

Clearly separate run status, displayable thinking/progress summaries, tool calls, tool results,
final answer, files/artifacts. Never assume every model exposes showable internal reasoning;
normalize via adapter into allowed status/summary. Tool calls collapsed by default, expandable
to params/process/results. Growing tool logs must not push composer or shake the page. Final
answer and tool trace use different visual hierarchy.

### 3.7 Run state machine

States: idle, connecting, preparing, streaming, tool_running, waiting_approval, compacting,
reconnecting, paused, cancelling, completed, failed, cancelled. For each: available actions,
buttons, allowed transitions, copy text, cancel, recovery. No multiple booleans producing
contradictions (e.g. generating + completed + cancelled simultaneously).

### 3.8 Cancel, timeout, reconnect

Really verify: stop during generation; cancel during tool execution; cancel during Python
worker; provider network timeout; streaming interruption; 429/5xx; close UI while running;
restart UI and recover streaming; reconnect; regenerate after cancel; rapid send/stop clicks;
switch model then continue conversation. Cancellation must propagate to harness according to
permissions/execution semantics, not merely stop display. External side effects must keep audit
records.

### 3.9 Error isolation

A single message parse/render/tool-output failure must never white-screen the app. Implement
error boundary, local message degradation, tool panel isolation, recoverable error hints,
structured error tracking, unhandled promise rejection monitoring, Electron renderer crash
diagnostics. Never only log to console without user feedback.

## 4. Quantitative streaming acceptance

Targets: stream text integrity 100% (no lost/dup/reordered chars); message attribution 100%
(no cross-conversation/run mixing); draft preservation 100% in key scenarios; key user paths
100%; uncaught frontend exceptions 0; composer layout displacement 0 unexpected during steady
streaming; auto-follow respects scroll intent; typical frame rate near 60 FPS; one bad content
must not crash chat; late events after cancel 0 wrong writes; reconnect content integrity 100%
with dedupe/recovery; long-session resource use no sustained unrecoverable growth. Record
average/P95/extremes/environment; no single-sample claim of long-term stability.

Test matrix (Playwright Electron or equivalent): 100/1,000/10,000 incremental events; short
tokens + very long chunks mixed; high-frequency bursts; real model long answer; Markdown table
forming line by line; code block across many deltas; zh/en/Unicode across chunk boundaries;
multiple tool calls interleaved; model resumes after tool; user scrolls history during output;
user edits composer during output; user switches projects during output; repeated cancel and
resend; two independent runs in parallel; daemon disconnect+recovery; duplicate/out-of-order/
replayed events; malformed model JSON; large code/table/chart; 100+ message session; window
resize, theme and language switch. Use deterministic event replay tests AND real provider live
tests; label results separately.

## 5. P0 fix known failures

Reproduce previous known issues: `Unknown rsi run`; RPC E2E failures; possible Activity Handler
registration inconsistency; UI/backend state sync; Python Worker ↔ Harness bridge. Flow:
reproduce → root cause → minimal safe fix → regression case → integration → E2E → update matrix.
Never hide errors, skip assertions, delete failing tests, or use mocks to mask real failures.
Full regression after fixes.

## 6. P0 durable harness, DB, runtime

Keep Electron UI / independent daemon separation; task state persisted. Check Event Log, SQLite
WAL, atomic transactions, task DAG, lease, fencing token, heartbeat, checkpoint, retry,
cancellation, outbox, idempotency, recovery, budget enforcement. Verify: (1) closed window →
task continues or enters declared wait state; (2) Electron restart loses no task; (3) daemon crash
recovery; (4) Python worker crash recovery; (5) Windows reboot recovery; (6) network interruption
handled; (7) no duplicate dangerous side effects; (8) no duplicate already-confirmed artifacts;
(9) long approval wait does not depend on model connection; (10) compaction does not break task
recovery. Check SQLite migration/backup/recovery and legacy import. Actual 8/24/72h endurance not
run => must not be marked passed.

## 7. P0 all UI real, complete, friendly

Auto-scan all screens: chat, research projects, task execution, tools/skills, model management,
settings/diagnostics, multi-model debate, context memory, channels, RSI, file management,
logs/run status. Maintain `docs/verification/ui-action-coverage.csv`; for every interactive
element verify UI → IPC → RPC → Harness → Worker/MCP/DB → UI echo. Every switch/button/setting
must have real business effect; no "saved but unused" config.

Design: professional, simple, modern scientific desktop style; clear hierarchy, consistent
navigation, prominent primary actions, less unnecessary explanatory text, clear long-task status,
layered research results vs execution logs, sensible defaults, normal users need not understand
the harness, reuse design system, no feature-breaking or meaningless large refactor.

Visual auto-acceptance: actually start Electron and screenshot; check text occlusion, truncation,
overlapping controls, scrolling issues, input jitter, layout breakage, icon/font inconsistency,
dialogs off-screen, theme color anomalies, blank pages, error hint position, loading, empty
states, long-list performance. Cover 1920×1080, 1366×768, normal window, small window, Windows
125%/150% scaling, dark/light, zh/en. Vision models may help but judgments must be confirmed by
reproducible checks or human review; no subjective auto-pass.

Interaction quality: shortcuts, Chinese IME, text select/copy, drafts, resize stability, real-time
task status, actionable errors, explicit high-risk approval, avoid unnecessary dialogs, all
loading/empty/success/error states reasonable, long tasks don't block app.

## 8. P1 research six capabilities real E2E

- Knowledge: real literature/scientific database queries, sources/citations/time traceable.
- Hypothesis: generation, critique, reflection, revision, ranking, consensus fully runs.
- Methods: Paper2Agent-like conversion of license-compatible papers/code into testable skill.
- Analysis: Python worker on public sample data, real analysis preserving code/env/params/results/
  evidence.
- Discovery: hypothesis → experiment design → approval → data import → feedback revision loop.
- Autonomy: long research task with DAG, checkpoints, budget, failure recovery, human approval.
Multi-model debate: models challenge each other; referee cannot unconditionally terminate;
models can rebut referee; evidence-based conclusion; preserve disagreement/uncertainty; records
recoverable/traceable. No static-page demo substitutes real calls.

## 9. P1 MCP, skills, models, channels, RSI

MCP: install/config/discovery/schema/auth/call/timeout/fault diagnosis/reconnect/disable/uninstall.
Skills: SKILL.md parse, source, version, deps, permissions, sandbox execution, health, update,
uninstall; never execute arbitrary external repo scripts without permission review.
Providers: at least two real usable integration methods; verify streaming, tool calling,
structured output, timeout, rate limit, cancel, context budget, token usage, provider errors,
model auto-routing, parameter effects; no silent switch to an unapproved data recipient.
Channels: test implemented Telegram/Slack/Discord/Webhook or other legal channels; unauthorized
remote messages must not get local shell or sensitive research directory access.
RSI: verify constrained loop Observe → Diagnose → Propose → Test → Benchmark → Review →
Promote/Rollback; high-risk source changes need independent review and explicit authorization; no
unlimited runtime self-modification.

## 10. P1 performance, memory, security, diagnostics

Measure: cold/warm start, first interactive, first token latency, Markdown render time, UI main
thread long tasks, long-session memory, virtualization efficiency, multi-agent concurrency,
Python worker CPU/memory, daemon long-run resources, SQLite WAL growth. Record hardware/test
data/P50/P95/anomalies; no average-only fluency claim.

Security checks: Electron IPC, contextIsolation, nodeIntegration, CSP, shell injection, path
traversal, prompt injection, MCP tool output injection, SSRF, API key leak, log sensitive data,
Python worker permissions, skill supply chain, downloaded code execution, DB access permissions,
file overwrite approval.

Diagnostics center shows Electron/daemon/worker/provider/MCP status, current tasks, recent errors,
recent checkpoints, tokens/cost, CPU/memory, DB status, current version; export redacted bundle.

## 11. Windows release real acceptance

Build → real x64 installer → clean Windows user env install → first start → model config → one
real conversation → one real tool call → one public-sample research task → exit/reopen →
recover history/tasks → upgrade install → data migration+backup → uninstall + retention policy →
SHA256. Never claim an unsigned installer is signed; build success ≠ installable.

## 12. GitHub MIT open-source publication (mandatory final phase)

Pre-release repo review: git remote, GitHub CLI and auth status; prefer verified existing SuWen
repo; create repo only if permitted; never use another project's remote. Standard MIT license for
original code; check copyright year/owner, LICENSE, README, NOTICE, third-party licenses, SBOM,
actual third-party distribution conditions. Never relicense non-MIT third-party code as MIT.
Secret scan code/artifacts/git history: API keys, tokens, passwords, SSH creds, .env, user DBs,
private research data, patient/clinical data, logs, access creds, private configs/paths. Fix
before publishing; rotate exposed credentials and clean history if needed.

CI: typecheck, lint, unit, integration, RPC E2E, UI smoke, security scan, license scan, Windows
build, artifact hash. Protect main; prefer PR review + required status checks.

Publish only after all release gates pass: bump version → CHANGELOG → release notes → commit →
push → tag → GitHub Release → upload Windows NSIS installer → upload SHA256SUMS → verify online
repo/tag/release/assets. Verify uploaded installer matches tested commit. Do not publish stable
if gates fail or licensing/privacy risk is not resolved.

## 13. Automated release gates

`docs/release/release-gates.md`: Gate 1 Build Integrity; Gate 2 Runtime Integrity; Gate 3
Streaming UI Stability; Gate 4 Functional Completeness; Gate 5 Research Workflow; Gate 6
Durability; Gate 7 Security & Compliance; Gate 8 Windows Installer; Gate 9 GitHub Publication.
Never skip earlier gates to publish. Record external blockers; uncompleted ≠ passed.

## 14. Defect governance

`docs/verification/defect-register.csv`: Bug ID, Severity, Reproduction, Expected, Actual, Root
Cause, Fix Commit, Regression Test, Evidence, Status. P0/P1 must be fixed before release; P2
kept only if it doesn't affect core paths/security/data integrity and is documented in release
notes. Forbidden: claiming success by skipping tests; lowering assertions; deleting features;
fake mocks; hiding errors; unsubstantiated "no bugs"; unsubstantiated full third-party support;
writing unrun long endurance tests as passed; claiming GitHub upload without checking. After each
batch: implement → build → test → fix → regress → git commit → update matrices/progress. Resume
from progress/git/test records after interruption, don't recreate projects.

## 15. Mandatory files

`docs/requirements/master-requirements.csv`, `docs/migration/feature-parity-matrix.csv`,
`docs/verification/ui-action-coverage.csv`, `docs/verification/ui-streaming-stability.md`,
`docs/verification/ui-visual-audit.md`, `docs/verification/e2e-results.md`,
`docs/verification/durability-chaos-tests.md`, `docs/verification/security-review.md`,
`docs/verification/performance-baseline.md`, `docs/verification/defect-register.csv`,
`docs/release/release-gates.md`, `docs/release/windows-installer-verification.md`,
`docs/release/final-acceptance-report.md`, `docs/progress.md`. Each report must contain real
content + evidence.

## 16. Final answer format

A. Project & GitHub: repo URL, branch, commit SHA, release tag, MIT status, CI status.
B. Windows installer: actual path, download URL, version, size, SHA256, install/upgrade/uninstall
results. C. UI/UX: interaction coverage, streaming stability results, composer stability, scroll
and long-session tests, visual issue fix list, screenshots/evidence. D. Functions: core feature
coverage, Python legacy parity, research agent real results, MCP/Skills real results, multi-model
debate results. E. Stability & security: daemon recovery, Python worker recovery, DB/context
recovery, real endurance test duration, security audit results. F. Open items: problem,
severity, cause, impact, unblock condition, whether release-blocking.

Only when all mandatory release gates pass may Stable Release be declared complete.

## 17. Immediate execution order

Audit target dir → reproduce leftover defects → fix streaming UI stability first → complete
unified event protocol + stable state management → accept composer/scroll/complex Markdown/
concurrency → fix RSI/RPC/backend integration → inspect all pages/actions → verify Python legacy
parity → verify research workflows → verify durable harness/compaction/failure recovery →
security/performance/visual automated tests → Windows build + real acceptance → MIT compliance
and GitHub pre-publish checks → after gates pass, auto upload GitHub + create Release → verify
online artifacts and output full report. Most important acceptance principle: a model answering
correctly does not mean the software is usable; must prove UI/state/interactions/persistence/
failure recovery are stable throughout the entire model lifecycle.
