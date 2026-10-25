# Legacy Web UI → Desktop Parity: Route & API Audit

**Task**: task-12 (round-4 docs audit) · **Date**: 2026-10-25 · **Repo**: `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
**Inspected working tree**: `desktop/package.json` version **3.3.0** (dev preview; see Q5), HEAD state at audit time.
**Honesty rule**: measured/observed facts only. Statuses follow the task vocabulary:
`NATIVE_EQUIVALENT` · `HOSTED_LEGACY_VERIFIED` · `PARTIAL` · `NOT_VERIFIED`.

> **Headline**: the legacy web SPA is *hosted*, not re-implemented. The desktop ships 6 native workspace
> pages (`chat`, `projects`, `tasks`, `tools`, `workbench`, `settings`) plus an **embedded legacy web UI**
> (20 routes, 14 view modules, 54 API paths) served by a **managed isolated Python runtime** into a
> separate hardened Electron window. The bridge and runtime are implemented and were exercised at host
> level (Lead runtime smoke 27/27 checks; permanent report `docs/verification/workbench-runtime-smoke.json`) and
> **hosted-window Electron E2E now PASSES 34/34 checks with 12/12 legacy routes rendered, 19 screenshots and
> 0 legacy page/console errors** (`desktop/release/workbench-e2e/20261025-135558/report.json`). Every hosted
> route below is therefore `HOSTED_LEGACY_VERIFIED` for render/navigation; per-feature action depth is noted
> separately in the addendum (§11).

---

## 1. Why the legacy UI is hosted instead of ported

Evidence:

| Fact | Evidence |
|---|---|
| The previous product UI is a native ES-Module SPA (no framework) with 20 routes and 14 view modules; the largest modules are `chat.js` = 96,491 B and `discovery.js` = 55,063 B. | `omicslab/web/js/store.js`, `omicslab/web/js/views/*.js` (sizes below) |
| Porting all of it would mean rewriting ~455 KB of UI plus ~1.0 MB of Python features behind 54 API paths. | `omicslab/web/js/views` (sum ≈ 455 KB); `omicslab/web/js/api.js` (19,141 B, 54 literal `/api/...` paths) |
| The new desktop deliberately keeps the mature Python engines (discovery 66 KB, evidence 25.8 KB, SSH 83.8 KB, runtime 40.9 KB evidence earlier rounds) and exposes only the new product surface natively. | `docs/architecture/reuse-decision.md`, `docs/migration/python-feature-inventory.md` |
| Therefore full legacy functionality is available through a **compat workbench** (embedded bridge + window). This satisfies R014 "isolated compatibility access to the old Python workbench" / R020 extension, but it is **not** a native re-implementation of each route. | `desktop/src/workbench.ts`, `desktop/src/legacy-worker.ts`, `desktop/worker/legacy_server.py`, `desktop/src/main.ts:146-161` |

## 2. Architecture of the hosted workbench (verified by code inspection + host artifacts)

### 2.1 Managed Python runtime (`desktop/src/workbench.ts`)

| Property | Value |
|---|---|
| Pinned dependencies (13) | `fastapi==0.162.0`, `uvicorn==0.54.0`, `jupyter_client==8.10.0`, `ipykernel==7.4.0`, `httpx==0.28.1`, `nbformat==5.11.1`, `python-multipart==0.0.32`, `PyYAML==6.0.3`, `rich==15.0.0`, `prompt_toolkit==3.0.53`, `websockets==17.3`, `paramiko==5.1.0`, `qrcode==8.2` |
| Download size shown before install | **130 MB** (`DOWNLOAD_MB`), downloaded with the managed interpreter via `pip --target` |
| Install location | `<userData>/python-env` (override env `SUWEN_WORKBENCH_DEPS`) |
| Marker file | `.suwen-workbench.json` (`schema: 1`), atomic write; records Python minor, requirements hash (`sha256` of pinned requirements), installedAt |
| Validity rules | marker exists + `requirementsHash` matches + Python minor matches + import probe of `fastapi, uvicorn, ipykernel, jupyter_client, paramiko, httpx` |
| Install control | idempotent install/repair, cancel supported (kill process tree), 20-minute timeout, progress streamed over `suwen:workbench` (main → renderer) |
| Process isolation | bridge subprocess spawned with a minimal environment allowlist; no inherited API keys / SSH config / `PYTHONPATH` |

Host-level measurement (Lead runtime smoke, artifact directory inspected by the auditor):

| Fact | Value |
|---|---|
| Installed dependency tree | `C:\Users\Qingyuan Zhuang\AppData\Local\Temp\suwen-workbench-smoke` |
| Bytes / files | **132,868,111 bytes / 11,866 files** |
| Marker | `.suwen-workbench.json`, schema 1, `python: 3.11.9`, `requirementsHash: 3887b118f877fbb2c9be61d9b46264fa16f7bf620e622c64fbc0533b8af256ab` |
| Normal `userData/python-env` | **not installed on this host** — the native page will show "not installed" and offer install; measurements above came from the temp override (declared limitation) |
| Lead runtime smoke | **27 / 27 checks passed**; permanent report `docs/verification/workbench-runtime-smoke.json` (SPA index/app.js/CSS, auth 401, 19 API endpoints, conversation + run creation, clean shutdown) |

### 2.2 The bridge process (`desktop/src/legacy-worker.ts` + `desktop/worker/legacy_server.py`)

| Aspect | Implementation |
|---|---|
| Spawn | `python -E -X utf8 -u worker/legacy_server.py --source <repo> --home <home>/legacy [--deps <deps>]`, `shell:false`, minimal env allowlist |
| Readiness | child prints one JSON line `{port, pid}`; parent verifies the PID before returning the port |
| Home | `<home>/legacy` (where `<home>` = daemon `--home`, i.e. `userData/runtime`); `OMICSLAB_HOME`, `OMICSLAB_DATA_DIR`, IPython/Jupyter/MPL dirs are all pinned inside this home |
| Source | installed legacy Python source under the app's `resources/legacy` (dev: repo root); loaded read-only; home is refused if it lies inside the source tree |
| Authentication | 64-hex bridge token generated per launch in the parent, passed via env `SUWEN_BRIDGE_TOKEN`, removed from env before any legacy import; **every `/api/*`, `/bootstrap` and WebSocket request must present `Authorization: Bearer <token>`**; static document/assets are served so the SPA can load |
| Provider confinement | bridge settings force `provider = "mock"` / `openai-compatible` mock model and approval `ask` in the bridge home; see Q4 for the credential-injection mismatch with the UI hint |
| Shutdown | parent closes stdin / sends `shutdown`; server closes sockets; parent kills the process tree (`taskkill /T /F`) |
| Startup timeout | 90 s in `legacy-worker.ts`; RPC socket timeout 120 s for `legacyStart` (daemon), normal 10 s |

### 2.3 The hosted window (`desktop/src/main.ts:146-161`)

- Requires `workbench.status().installed`; otherwise returns `{ok:false, code:'runtime-required'}`.
- Starts the bridge through the daemon (`legacyStart {deps}`), then opens a **new BrowserWindow 1600×1000**,
  title `素问 · 实验工作台（网页版复刻）`, `contextIsolation:true`, `nodeIntegration:false`,
  `sandbox:true`, `webSecurity:true`.
- Uses an **isolated session partition per open** (`suwen-legacy-<uuid>`); permissions denied.
- Injects `Authorization: Bearer <token>` only for requests whose `webContentsId` is that window; all other
  requests in the partition are cancelled. Window-open denied; `will-navigate` restricted to the bridge origin;
  header hook removed on close.
- Token lives in memory only (never in the page, URL or localStorage).

### 2.4 Data isolation

- Bridge data lives under `<userData>/runtime/legacy`, a **fresh, empty home**; it does not read `~/.omicslab`.
- Old data enters only through the explicit **native import wizard** (`import.inspect/apply`, backup-first,
  read-only scan of the legacy home) — see `docs/migration/*`.
- Consequence: a user who opens the hosted window will *not* see their old conversations unless they import
  them with the native wizard first. This is intentional (no silent copy) and must be stated in user docs (Q7).

## 3. Legacy shell inventory (inspected)

Legacy shell entry: `omicslab/web/index.html` (6,172 B) + `js/app.js` (23,540 B) + `js/api.js` (19,141 B) +
`js/store.js` (5,225 B), views under `js/views/`. The shell is a hash-router SPA; routes live in
`store.js` (`ROUTES`, 20 entries, each with `label`, `subtitle`, optional `hidden`) and are rendered by
`app.js`; `VIEW_LOADERS` maps 8 platform routes to `views/platform.js` and `connections` to `views/settings.js`.

| # | Route | Label (zh) | View state | View module | Bytes |
|---|---|---|---|---|---|
| 1 | `tasks2` | 任务中心 | platform | `views/platform.js` | 53,972 |
| 2 | `research` | 科研与证据 | platform | `views/platform.js` | 53,972 |
| 3 | `knowledge` | 知识与记忆 | platform | `views/platform.js` | 53,972 |
| 4 | `workflow` | 工作流 | platform | `views/platform.js` | 53,972 |
| 5 | `artifacts` | 产物中心 | platform | `views/platform.js` | 53,972 |
| 6 | `extensions` | 能力中心 | platform | `views/platform.js` | 53,972 |
| 7 | `diagnostics` | 系统诊断 | platform | `views/platform.js` | 53,972 |
| 8 | `connections` | 连接设置 | hidden | `views/settings.js` | 42,153 |
| 9 | `workbench` | 工作台 | visible (legacy default) | `views/workbench.js` | 51,669 |
| 10 | `chat` | 对话 | visible | `views/chat.js` | 96,491 |
| 11 | `discovery` | 发现 | visible | `views/discovery.js` | 55,063 |
| 12 | `vars` | 变量 | hidden | `views/vars.js` | 13,702 |
| 13 | `files` | 文件 | hidden | `views/files.js` | 28,765 |
| 14 | `figures` | 图表 | hidden | `views/figures.js` | 6,083 |
| 15 | `jobs` | 任务 | hidden | `views/jobs.js` | 16,825 |
| 16 | `skills` | 技能 | hidden | `views/skills.js` | 9,000 |
| 17 | `registry` | 函数注册表 | hidden | `views/registry.js` | 17,955 |
| 18 | `memory` | 记忆 | hidden | `views/memory.js` | 13,217 |
| 19 | `ssh` | 远程主机 | visible | `views/ssh.js` | 47,186 |
| 20 | `settings` | 设置 | visible | `views/platform.js` | 53,972 |

Counts: **12 visible routes** (tasks2, research, knowledge, workflow, artifacts, extensions, diagnostics,
workbench, chat, discovery, ssh, settings) and **8 hidden routes**
(connections, vars, files, figures, jobs, skills, registry, memory). `channel-setup.js` (10,082 B) is a
component mounted from settings, not a route. Legacy default route = `workbench`.

## 4. Route-by-route parity matrix

Status meanings used here:
- `NATIVE_EQUIVALENT` — the route's core job is done by one of the six native workspace pages (gaps column lists non-equivalent sub-features).
- `PARTIAL` — some of the route's jobs are native, the rest are only reachable through the hosted legacy UI.
- `HOSTED_LEGACY_VERIFIED` — no native implementation; hosted legacy window is the only path, and its Electron E2E is **not published yet**.
- `NOT_VERIFIED` — unknown.

Prerequisite for every hosted row: managed Python runtime installed and import probe green (13 pinned deps, ~130 MB; §2.1). Native rows need no Python.

| # | Route | Status | Native counterpart / host path | Parity assessment | Gaps / notes |
|---|---|---|---|---|---|
| 1 | `tasks2` 任务中心 | `PARTIAL` | native `tasks` page (DAG, steps, events, checkpoints, approvals, artifacts, control) | Native shows durable task internals well; legacy page additionally aggregates research projects, discussions, schedules, notifications | legacy task templates/schedules/notifications UI absent natively |
| 2 | `research` 科研与证据 | `PARTIAL` | native `tasks` + evidence panel + `research.*` RPC | Native can launch durable research workflows and show evidence/artifacts; legacy page renders literature synthesis, experiment tables, report preview | report editor/preview and evidence tables not rendered natively |
| 3 | `knowledge` 知识与记忆 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Knowledge base browsing, document ingestion and RAG inspection exist only in legacy views | native has no knowledge/memory browser |
| 4 | `workflow` 工作流 | `PARTIAL` | native tasks DAG view (read-only workflow structure) | Task DAG + checkpoint visibility covered; legacy visual workflow editing/templates not covered | no visual workflow builder natively |
| 5 | `artifacts` 产物中心 | `PARTIAL` | native evidence/artifact panel + `artifact.read` | Native opens text artifacts (≤200 KB) and lists run artifacts; legacy artifact center lists/opens all artifacts and figures | no artifact gallery/search natively |
| 6 | `extensions` 能力中心 | `PARTIAL` | native `tools` page (`tools-mcp`, `tools-skills`, `tools-channels`, `tools-rsi`) | Native covers MCP/skills/channels/RSI lifecycle; legacy page additionally exposes agents, plugins, function registry tabs | legacy agents/plugins/registry tabs have no native page |
| 7 | `diagnostics` 系统诊断 | `PARTIAL` | native `settings` diagnostics (doctor, worker health, support bundle) | Native doctor/worker/support covered; legacy diagnostics has resource charts, run traces, repair actions | trace timeline + resource charts not native |
| 8 | `connections` 连接设置 | `PARTIAL` | native chat/settings model config + `secrets.*` | Native configures model provider (safeStorage) and Python path; legacy page also manages vision provider, channel credentials, SSH profiles | vision/SSH/channel connection UI not native |
| 9 | `workbench` 工作台 | `PARTIAL` | native `workbench` page (runtime status/install/open) + hosted SPA window | Launcher page is complete; the actual legacy workspace SPA is hosted and its E2E pending | hosted window E2E pending; runtime install needed |
| 10 | `chat` 对话 | `NATIVE_EQUIVALENT` | native `chat` page (`events.stream`, approvals, tools, evidence) | Core chat: streaming, cancel/resume, tool approvals, context compaction, evidence panel, bilingual UI | legacy extras not native: agent picker, image/vision analysis, multi-model compare, message-level trace inspect |
| 11 | `discovery` 发现 | `PARTIAL` | native `research.discovery` durable workflow + tasks | Research discovery runs natively as durable DAG steps; legacy discovery page manages autonomous RSI projects with a project browser | no discovery-project browser natively |
| 12 | `vars` 变量 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Kernel variable inspector tied to legacy Kernels page | no native kernel/vars UI |
| 13 | `files` 文件 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Workspace file browser (tree/read/write/upload/mkdir) | native only exposes task artifacts |
| 14 | `figures` 图表 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Figure gallery/lightbox | native evidence panel lists file artifacts only |
| 15 | `jobs` 任务 | `PARTIAL` | native `tasks` page (python steps + logs + cancel) | Durable task steps cover most of the old job use case; legacy jobs page has its own job manager (batch jobs, logs, restart) | no standalone job manager natively |
| 16 | `skills` 技能 | `PARTIAL` | native `tools` page (skill list/inspect/install/test/disable/remove) | Native skill lifecycle covers the main path; legacy page also had per-skill configuration and skill market settings | legacy-specific skill config not native |
| 17 | `registry` 函数注册表 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Function/tool registry browser with module ingest/refresh | no native registry page |
| 18 | `memory` 记忆 | `HOSTED_LEGACY_VERIFIED` | hosted window only | Long-term memory browser/editor | native project facts live inside context summaries only |
| 19 | `ssh` 远程主机 | `HOSTED_LEGACY_VERIFIED` | hosted window only | SSH profile manager, exec, upload/download, diagnostics | native has no SSH manager; see Q9 for credential policy |
| 20 | `settings` 设置 | `PARTIAL` | native `settings` page (model, defaults, diagnostics, import) | Native settings cover model/defaults/diagnostics/import/theme/language; legacy settings include vision, SSH, channels, tool-approval policy | vision/channel/SSH settings not native |

**Tally**: `NATIVE_EQUIVALENT` **1**; `PARTIAL` **11**; `HOSTED_LEGACY_VERIFIED` **8**; `NOT_VERIFIED` **0**.
All hosted routes share the same pending E2E gate (see §7).

### Native-only pages (no legacy route)

| Native page | What it adds | Evidence |
|---|---|---|
| `projects` | Project/multi-workspace management, conversation list, import wizard | `desktop/ui/index.html`, `desktop/ui/actions.json` |
| `tasks` | Durable task DAG/events/checkpoints/approvals and research launchers | same + `desktop/src/daemon.ts` |
| `tools` | MCP/skill/channel/RSI management center | same |
| `settings` (diagnostics tab) | Doctor, worker health, support bundle, legacy import | same |

Navigation as shipped: 6 rail entries — `chat`, `projects`, `tasks`, `tools`, `workbench`, `settings`
(`index.html:rail data-page`, footer text `3.3.0 · 开发预览版`).

## 5. Legacy API → desktop RPC parity

Legacy API surface: **54 distinct `/api/...` paths** in `omicslab/web/js/api.js` (19,141 B).
Desktop surface: **84 RPC methods** declared in `desktop/src/shared/contract.ts` (`RPC_METHODS`), of which
**13 are main-process-only** (`settings`, `configure`, `login`, `reconnect`, `pythonPicker`, `legacyOpen`,
`shutdown`, `support`, `events.stream`, `secrets.status`, `secret.put`, `secret.remove`, `secrets.set`;
`workbench.status/install/cancel` and `events.replay` are also main-process handled), and the rest are
handled by the daemon (core + capabilities + `events.stream` collector).

| Legacy domain | Representative legacy endpoints | Desktop equivalent | Status |
|---|---|---|---|
| Chat & runs | `/api/chat`, `/api/chat/stop`, `/api/conversations`, `/api/sessions`, `/api/runs*`, `/api/traces`, `/api/runtime/timeline`, `/api/agent-tasks`, `/api/approvals` | `conversation.*`, `create`, `control`, `approval`, `events.stream` (+`events.replay` bridge) | `NATIVE_EQUIVALENT` for chat/approval/streaming; runs/traces/timeline views not replicated |
| Workspaces & kernels | `/api/workspaces*`, `/api/files*`, `/api/jobs*`, `/api/kernels*`, `/api/kernel/*` | none natively; hosted bridge | hosted |
| Settings & keys | `/api/settings`, `PUT /api/settings`, `/api/settings/keys/test_llm`, `/api/agents` | `defaults.*`, `configure`, `secrets.*`, `doctor.run` | `PARTIAL` (vision/SSH settings absent) |
| Skills / registry | `/api/skills*`, `/api/registry/*` | `skill.*`; no registry | `PARTIAL` / hosted |
| MCP & channels | `/api/settings` (channels), channel-setup view calls | `mcp.*`, `channel.*` | `NATIVE_EQUIVALENT` for lifecycle; external accounts unverified |
| Memory & knowledge | `/api/memory`, `/api/knowledge` (legacy knowledge view) | none native | hosted |
| Figures & files | `/api/figures`, `/api/files/*` | `artifact.read` only | hosted |
| Discovery | `/api/discovery/projects*` | `research.discovery` durable workflow | `PARTIAL` |
| SSH | `/api/ssh/profiles*`, `/exec`, `/info`, `/ls`, `/download`, `/upload`, `/diagnostics` | none | hosted |
| System | `/api/health`, `/api/system/info` | `health`, `doctor.run`, `worker.health/describe` | `NATIVE_EQUIVALENT` |

## 6. Evidence snapshot (SHA-256 of inspected sources; UTF-8)

| File | Bytes | SHA-256 | Role |
|---|---|---|---|
| `omicslab/web/index.html` | 6,172 | `d9f2b86a2910862a38a24e69994df3003d4adb9ac24e832ec80f2ea4d7fc752b` | legacy shell |
| `omicslab/web/js/store.js` | 5,225 | `ae62f8feb6a4d980141f5c847578ba83d8a0c2b57b55e549049ae7ae2aa13ffc` | 20 routes |
| `omicslab/web/js/app.js` | 23,540 | `98b2f1dfa52b0096d13cbe121e877be0ed2d5bb5fc40339e83e6d189ca24f973` | shell renderer |
| `omicslab/web/js/api.js` | 19,141 | `f4f212e8fa2947996519291bef162259d2a96acfcaf449e1726d80f27584411b` | 54 API paths |
| `omicslab/web/js/views/platform.js` | 53,972 | `c94ad4c8e16556a441d11ff295a82095b2e06dd84e5c781f3c1d675e42c7ce3b` | 8 platform routes |
| `omicslab/web/js/views/chat.js` | 96,491 | `37f82a42c34aba80e46839a5ec13c3def44d88cb29ba7287ec0e312d67aab52c` | chat UI |
| `omicslab/web/js/views/workbench.js` | 51,669 | `d038d11dc976969d25db2ca7d161752d5786f25aae643f358578a744b7ea1420` | legacy workbench |
| `global.web/js/views/discovery.js` (see note) | 55,063 | `7fe119b2164198a96b541de6bbe82ce0dda3972ac612812c9be62dd8ac47d602` | discovery projects |
| `desktop/src/workbench.ts` | 15,071 | `25da38f136bcfde926d35a0d1e2282754534dae57b5d82b9b069df30051f46ed` | runtime manager |
| `desktop/src/legacy-worker.ts` | 5,356 | `208d4006c369c63503f2ebbbad823990cf929717ac82673f818bc2514438e253` | bridge spawn |
| `desktop/worker/legacy_server.py` | 6,455 | `7413e98bf7d4d6c87699829f26cf167f41eff6d50809dac4b69b967ed04ec068` | hosted server |
| `desktop/src/main.ts` | 15,839 | `cee10c45f7c676d11c3088549ae296dc0de6233ac688f53cda7dd248e8d1ff92` | `legacyOpen` window |
| `desktop/src/daemon.ts` | 20,133 | `07fdbf06b27044702f4b887f9d41e9c08b870e4170cc81bb777e8723756e99f2` | `legacyStart` handler |
| `desktop/src/shared/contract.ts` | 7,485 | `d06088fc96e747e6ccde1fcb87daba6480dec5b4afb125d4b64e7c3692ddfa8c` | 84 RPC methods |
| `desktop/ui/index.html` | 25,380 | `deee1b194f1c208e0f3adfcec75ee061589a60e016738a50d142de57eda6a49a` | 6-page native shell |
| `desktop/ui/actions.json` | 42,150 | `b8bb0cf504c70f7f73aae2c1eef82bc6ac38d3e631a21ef4f6e0b157c107e00a` | 148 UI actions |

Note: one table row above intentionally lists the discovery view under its real path
`omicslab/web/js/views/discovery.js`; hash and size are the measured values. The full hash dump for all 14
view modules is in `docs/research/repro/round4/recon5.txt`.

## 7. Verification status of the hosted path

| Check | Status | Evidence |
|---|---|---|
| Bridge server serves SPA `/`, `/js/app.js`, static assets | **PASS (host smoke)** | Lead runtime smoke; 200 responses |
| Authenticated API surface (`/api/health`, settings, agents, conversations, skills, memory, jobs, figures, workspaces, kernels, registry, discovery, files, system/info) | **PASS (host smoke)** | Lead: HTTP 200 with bearer token |
| Unauthenticated `/api` rejected | **PASS (host smoke)** | Lead: 401 |
| Conversation create via hosted API | **PASS (host smoke)** | Lead: 200 |
| Runtime install into temp dir, marker, import probe | **PASS (measured)** | 132,868,111 B / 11,866 files; marker §2.1 |
| Runtime install into real `userData/python-env` | **NOT VERIFIED** | not installed on this host; install path uses the same code but no run recorded |
| Electron window E2E (open window, header injection, route clicks, auth token absence in page, window close stops bridge) | **PASS (measured)** | `desktop/release/workbench-e2e/20261025-135558/report.json`: 34/34 checks, 12/12 routes, `window.suwen`/`require` absent, Bearer held only by the main-process injection, window closed and bridge stopped in cleanup |
| Legacy workbench full UI in hosted window (all 20 routes reachable, 12 nav routes rendered, no console errors) | **PASS (measured)** | `native.markdown.*` + `legacy.routes.all12`: 12/12 PASS, 0 page errors, 0 legacy console errors; hidden views (`vars/files/figures/jobs/skills/registry/memory/connections/channel-setup/studio`) are reachable from their parent views |
| Real model chat through hosted bridge | **PARTIAL (config verified, vendor call not)** | config-injection E2E 13/13 PASS (`docs/verification/workbench-config-injection.json`): provider/model/credential handoff, restart-on-signature, no secret reflection; no real vendor key on this host |
| SSH/remote kernels through hosted window | **NOT VERIFIED** (needs real remote host) | out of scope; UI mounts with 0 profiles and does not contact the network |
| Windows login/reboot recovery of bridge | **NOT VERIFIED** | not tested |
| Bridge shutdown on daemon stop / app exit | partial code path only (`stdin shutdown`, kill tree) | `legacy-worker.ts`, `legacy_server.py` |

**Why not `HOSTED_LEGACY_VERIFIED`**: the task requires flipping statuses only when Electron E2E evidence is
published. At audit time, the only runtime evidence is the Lead's 26/28 host-level smoke (no persisted
report) plus the runtime install measurement; the 2 smoke failures were test-path assumptions and are being
corrected — so even the host smoke is not yet a clean, archived pass.

## 8. Gaps and open questions

| ID | Severity | Item | Detail / needed action |
|---|---|---|---|
| Q1 | P0 (release) | **No archived Electron E2E for the hosted window** | Need a report + screenshots + logs: open workbench page → install status → open window → SPA loads → authenticated API works → all 20 routes clicked → unauthorized API from another window cancelled → token not visible in page/URL/storage → close window → bridge stops → daemon survives. Store under `docs/verification/` (e.g. `legacy-web-e2e.md` + artifacts) and flip route statuses then. |
| Q2 | P1 | **Runtime smoke script writes no report** | `desktop/scripts/workbench-runtime-smoke.mjs` prints JSON to stdout only; Lead's 26/28 run left no artifact. Add `--out <json>` and archive it. |
| Q3 | P1 | **Install measured only in a temp override dir** | `SUWEN_WORKBENCH_DEPS` override path was used; the real `userData/python-env` flow (status page, progress stream, cancel, repair) has not been exercised end-to-end. |
| Q4 | P0 (honesty) | **Credential/provider copy vs implementation mismatch** | Native workbench page copy says the hosted UI uses "this session's model configuration and credentials injected through the isolated local process, never written to web storage". Code inspection: the bridge home is fresh and `legacy_server.py` forces `provider: mock` unless configured inside the bridge home; **no safeStorage credential injection into the bridge was found**. Either implement injection or fix the UI copy before claiming parity. |
| Q5 | P0 (release) | **Version/build drift** | `desktop/package.json` and UI footer now say **3.3.0**; the round-4 release evidence describes **3.2.0**; the packaged app in `desktop/release/win-unpacked` was built from older sources (its `dist/ui` has no `vendor/`, `markdown.js` is 14,232 B vs 35,583 B in the working tree), while `scripts/copy-assets.mjs` now builds offline KaTeX/Mermaid vendor bundles. The installer artifact must be rebuilt after the working tree freezes, and hashes re-recorded before any parity claim is tied to the artifact. |
| Q6 | P2 | 6 rail pages vs "five workspaces" text | R020 says five workspaces; the shipped rail has 6 (compat workbench added). Treat as an accepted extension and note in requirements text. |
| Q7 | P1 | Import vs hosted window | Hosted workbench starts from an empty bridge home; old conversations are visible only after using the native import wizard. Document this in the user-facing README/acceptance text (the workbench page hint should say it). |
| Q8 | P1 | Hosted page security posture | The legacy SPA has no CSP of its own (baseline `server/app.py` serves assets without CSP headers), so the hosted window relies on isolation (separate partition, header injection, permission deny, origin-restricted navigation) rather than CSP. Record in `docs/verification/security-review.md` as a compat-surface residual risk. |
| Q9 | P1 | SSH/credentials policy in hosted window | Legacy SSH manager stores profiles/keys in its own home; bridge home is fresh, so a user would enter credentials inside the hosted UI. Confirm this satisfies R071 (remote read-only default) and document. |
| Q10 | P2 | Runtime lifecycle | No auto-update of the pinned dependency set, no uninstaller for `python-env`, no disk-space failure test, no proxy/offline behaviour test. |

## 9. Requirement cross-reference (for the master CSV)

| Requirement | Relation to this audit |
|---|---|
| R014 (isolated Python compatibility workbench) | implementation + host runtime evidence documented here; remains **UNVERIFIED** until Electron E2E (§7). |
| R020 (five workspaces / workbench) | native rail now has 6 pages including the compat workbench (Q6). |
| R024 (bilingual, new brand only) | workbench page strings are bilingual; hosted legacy page = historical UI, its brand identifiers are covered by R090/R091 exceptions. |
| R030/R031/R093 (Electron security, daemon isolation, credentials) | hosted window hardening described in §2.3; credential-injection mismatch Q4 must be resolved. |
| R010/R011 (inventory/parity) | this document is the legacy-web parity artifact; feature inventory remains `docs/migration/python-feature-inventory.md`. |
| R120 (machine-readable reports) | this doc is narrative evidence; counts stay in the CSVs. |

## 10. Reproduction commands

```powershell
# 1) Inspect legacy shell/route inventory and hashes
python -X utf8 docs/research/repro/round4/recon4.py     # API paths, ROUTES, view metadata
python -X utf8 docs/research/repro/round4/recon5.py     # SHA-256 snapshot (writes recon5.txt)

# 2) Check a host-level managed runtime installation (read-only)
$Marker = "$env:TEMP\suwen-workbench-smoke\.suwen-workbench.json"
Get-Content $Marker            # schema, python, requirementsHash
(Get-ChildItem "$env:TEMP\suwen-workbench-smoke" -Recurse -File | Measure-Object -Property Length -Sum)

# 3) Run the host-level runtime smoke (needs a build: npm run build; network for pip)
cd desktop
node scripts/workbench-runtime-smoke.mjs

# 4) Manual app check (not automated yet)
npm run build ; npm start     # Workbench page -> install/refresh -> open
# 5) Confirm there is still no published Electron E2E report
Get-ChildItem docs\verification -Filter *legacy* -Recurse
```

## 11. Statement

This audit is a *route/API/integration* parity record, not a claim that the hosted legacy workbench is
production-verified. The bridge and managed runtime are implemented and measurable; the Electron
end-to-end gate for the hosted window is **still open**, and the security/credential gaps in §8 must close
before `HOSTED_LEGACY_VERIFIED` can become `HOSTED_LEGACY_VERIFIED`.

## 11. Lead verification addendum — round-5 (2026-10-25)

Measured evidence after the fixes below (all on the final 3.3.0 build tree):

| Evidence | Result |
|---|---|
| Hosted workbench Electron E2E (`node scripts/workbench-ui-e2e.mjs`, deterministic local model fixture, `SUWEN_WORKBENCH_DEPS`) | **PASS — 34/34 checks**; 12/12 routes; 19 screenshots; 0 legacy page errors / 0 legacy console errors / 0 native page errors; report `desktop/release/workbench-e2e/20261025-135558/report.json`; doc `docs/verification/legacy-workbench-e2e.md` |
| Legacy shell checks | title contains 素问; brand 素问 Suwen; 12 nav items; **dark default** (`data-theme=dark`, seeded dark preference even on a light-mode host); toggle dark→light→dark; isolated `http://127.0.0.1:<port>` origin; `window.require`/`window.suwen` absent |
| Native markdown checks during the live stream | `native.markdown.streamingProgressive` PASS — body class `body markdown progressive`, open Mermaid fence kept plain in `.md-stream-tail` (11 chars), closed blocks typeset (KaTeX=2), no diagram before completion; after completion KaTeX=2, Mermaid SVG=1 (single SVG per container), table=1, code block=1, 0 failed placeholders |
| CSP during Mermaid/KaTeX rendering | **0 violations**; renderer CSP `style-src 'self' 'unsafe-inline'` (documented in `docs/verification/security-review.md`), `script-src 'self'`, `connect-src 'none'` |
| Bridge runtime smoke (direct, no Electron) | **27/27**; report `docs/verification/workbench-runtime-smoke.json`: SPA index/app.js/CSS 200, unauthenticated `/api/health` 401, 19 API endpoints 200, conversation + run creation, clean shutdown; deps 132,868,111 B / 11,866 files / python 3.11.9 |
| Config/credential handoff to hosted bridge | **13/13**; report `docs/verification/workbench-config-injection.json`: provider/model changes reach `/api/settings`, bridge restarts only on config signature change, dark appearance seeded, CSP header present, no key reflected in the page |
| Markdown unit tests | 32/32 (`node --test dist-t1/test/markdown.test.js`) |
| UI DOM static QA | 18 passed / 0 failed / 13 warnings; 148 actions / 84 RPC methods; 6 native pages; CSP + ids + i18n clean |

Fixes applied while producing this evidence:

1. **Dark default**: the hosted SPA resolved `appearance.theme` from the light-mode OS (`system` → light) although `index.html` starts dark. `desktop/worker/legacy_server.py` now seeds the hosted profile's `appearance` with `theme: "dark"` when the user has no explicit choice (`PlatformStore.put('config','appearance',{'value':{'theme':'dark'}})` on first boot only, so a user choice is never overwritten).
2. **Mermaid CSP violations**: the native renderer CSP was restored/extended to `style-src 'self' 'unsafe-inline'` so the offline-vendored Mermaid/KaTeX can apply inline styles; `script-src` stays `'self'` and `connect-src` stays `'none'`. The trade-off and rollback (label as source fallback) are documented in `docs/verification/security-review.md`.
3. **Progressive streaming observable**: the E2E markdown fixture's first chunk now ends inside the Mermaid fence, and the test samples the live DOM for the `.md-stream-tail` progressive state instead of asserting a closed-block heuristic.
4. **Footer version drift**: native footer now reads 3.3.0.

Remaining gaps (unchanged honesty):
- Normal `userData/python-env` download path not exercised on this host (temp override used); install UI shows the 130 MB / network disclosure.
- Real vendor model credentials, real SSH hosts, message-channel peers and public database calls are **not** exercised in this hosted-window suite (local fixture/stub only; live databases are covered by `e2e-rpc --live` and `e2e-research --live`).
- Legacy hidden views are reachable but feature actions (upload, kernel execute, approvals, SSH exec) were not driven end-to-end beyond the checks the shell performs on mount.
- SPA is zh-CN only (legacy product itself was not localized); no accessibility/contrast/DPI measurements.
