# Python Feature Inventory — old product audit (R010 baseline for parity)

Date: 2026-10-25 (Asia/Shanghai) · Auditor: docs-audit (D)
Scope: the pre-existing Python/FastAPI + native-ES-modules product at SOURCE_ROOT (`omicslab/`, `tests/`, `web/`, `docs/`), and the same files copied into TARGET_ROOT. This is the "Python baseline" column of [feature-parity-matrix.csv](feature-parity-matrix.csv).
Evidence types: (a) source code paths/line refs from the Lead's `docs/architecture/current.md` audit, (b) module/route/test counts measured in this audit, (c) the repository evidence log `docs/research/evidence/python-full-test.log` (482 passed, 1 warning, 36.52 s, exit 0, `OMICSLAB_PROVIDER=mock`, isolated home) and `docs/research/evidence/desktop-test.log` where the baseline is exercised through the compatibility workbench. Claims not covered by these are marked "not independently re-run".

## 1. Product shape and entrypoints

| Capability | Code evidence | Status / limits |
|---|---|---|
| HTTP server (FastAPI + Uvicorn) serving API + static SPA | `omicslab/server/app.py:66-145` (app composition, static hosting, CORS/origin checks, **no CSP**) | Implemented; browser SPA, no Electron. |
| CLI `suwen`/`omicslab` console script with 18 subcommands: agents, cli, config, create, delete, discovery, doctor, env, keys, list, report, run, serve, set, set-key, show, skills, status | `omicslab/cli.py` (46 KB) | Implemented; `python -m omicslab` also works. |
| Packaging: `pyproject.toml` name `omicslab` version 2.1.1, Python >=3.10, Apache-2.0, deps fastapi/uvicorn/jupyter_client/ipykernel/httpx/nbformat/python-multipart/pyyaml/rich/prompt_toolkit/websockets/paramiko/qrcode; optional bio numpy/pandas/matplotlib/scanpy/anndata; dev pytest/pytest-asyncio; scripts `suwen` + `omicslab` -> `omicslab.cli:main` | `pyproject.toml:5-15,46-78` | Implemented; no dependency lockfile, wheel/sdist only (`scripts/check_dist.py:93-108`, `scripts/publish.ps1:1-5,77-92`). |
| Config & paths | `omicslab/config.py` (36 KB): `APP_SLUG='omicslab'`, data candidates `OMICSLAB_HOME`, `OMICSLAB_DATA_DIR`, `%LOCALAPPDATA%/OmicsLab`, `~/.omicslab`, XDG; API keys via `OMICSLAB_*`; schema/migration logic | Implemented; legacy identifiers intentionally retained for compatibility. |
| Provider-aware model config | `omicslab/config.py`, `suwen/models.py`, `suwen/configuration.py`, `agent/providers/*` | Implemented. |
| Diagnostics | `omicslab/server/routes.py` diagnostics endpoints, `scripts/acceptance.py` | Implemented (Python-level). |
| Install/upgrade scripts | `scripts/bootstrap.ps1`, `scripts/publish.ps1`, `docs/INSTALL.md`, `docs/UPGRADE-1.3.md`, `docs/UPGRADE-2.1.md` | Implemented for Python app (pip/venv/wheel); no NSIS installer in baseline. |

## 2. HTTP API surface (measured)

- Total ~110 route handlers across `omicslab/server/`:
  - `routes.py` ~30: conversations CRUD, figures, files (tree/read/raw/upload/write/mkdir/download), jobs, kernel (status/vars/var_detail/execute/interrupt/restart), memory, settings, skills, system/info, health, keys/test_llm/test_vision/vision, agents, settings PUT/PATCH.
  - `routes_platform.py` (26 KB) platform routes; `routes_workspaces.py` ~19 (workspaces CRUD, files, jobs+cancel, kernels start/stop/restart/execute/vars, probe); `routes_ssh.py` ~13 (profiles CRUD/remember/test, exec, info, ls, download, upload, diagnostics, test); `routes_discovery.py` ~7 (discovery projects CRUD/run/stop/report); `routes_runtime.py` ~8 (agents/default, runtime agent-tasks, config GET/PUT, diagnostics, runs, children, timeline); `routes_registry.py` ~4 (function/modules/search/refresh); `routes_trajectories.py` ~3; `chat.py` ~17 (agent tasks/runs/approvals/events/stream/cancel/children, sessions, messages, traces, POST /api/chat + stop).
- Event streaming over SSE: replayable run events (`runtime/runs.py:197-280,475-500,554-619`), `web/js/sse.js:93-137` avoids replay on retry.
- No CSP headers on the baseline HTTP server (new Electron app adds a strict CSP meta — see parity matrix).

## 3. Web UI (native ES modules SPA, no build step)

- `omicslab/web/index.html`, 6 CSS files, 14 JS modules (`api/app/approvals/bus/icon/markdown/runview/sse/store/suwen/ui/util`), **16 view modules**: channel-setup, chat (96 KB), discovery (55 KB), figures, files, jobs, memory, platform (54 KB), registry, settings (42 KB), skills, ssh (47 KB), vars, workbench (52 KB), plus app shell.
- Capabilities: streaming chat with markdown, approvals UI, run views, discovery workbench, registry/skills/MCP console, SSH terminal/workspace, kernel variables, figures/files, memory, settings (incl. keys, model test, vision test), channel setup with WeChat QR.
- Known weakness: full-history rerender without virtualization (`web/js/views/chat.js:557-571,788-810`); SSE retry avoids replay; no Electron-level security boundary.
- Bilingual: Chinese-first UI; English docs; runtime language switch (see ui i18n in `web/js/ui.js`; the vNext desktop reuses the idea, not the files).

## 4. Agent loop, prompts, agents, tools

| Capability | Code evidence | Status |
|---|---|---|
| Main agent loop (chat, tool calls, streaming, approvals, vision loop) | `omicslab/agent/loop.py` (37 KB), `agent/streaming.py`, `agent/types.py`, `agent/templates.py`, `agent/context.py` | Implemented; char-bound trimming (`agent/loop.py:209-226`). |
| Prompt assembly / templates | `agent/templates.py` (9.8 KB), `agent/__init__.py` prompt text | Implemented. |
| Built-in tool suite (~large) | `omicslab/agent/tools.py` (79 KB, 19 legacy-brand hits) — files, shell, Python/kernel, jobs, SSH, figures, memory, knowledge, vision, MCP tool bridge, skills, discovery; explicit `ask` decision path (`agent/tools.py:325-329`) | Implemented; host-permission shell by default. |
| Multi-agent roles (13 markdown agent roles: lead, discovery-lead, hypothesis-smith, evidence-critic, data-critic, experiment-designer, figure-designer, flow-cytometrist, remote-compute-engineer, report-writer, research-strategist, single-cell-analyst, spatial-analyst) | `omicslab/agents/*.md` | Implemented as prompt roles; no true multi-model scheduler. |
| Governance/turn controls, approvals | `agent/governance.py` (9.3 KB), `agent/approvals.py` (14 KB), `docs/TURN-GOVERNANCE.md` | Implemented (repo evidence: `tests/test_turn_governance.py`). |
| Memory (workspace digests, provenance, expiry, dedupe, lexical + optional API embedding search) | `agent/memory.py` (8.9 KB), `suwen/knowledge.py:83-150` | Partial: no local neural embedding, no learned re-ranker (see V2 checklist item 2). |
| Vision (separate connection, figure review loop with max corrections) | `agent/vision.py` (12 KB), `agent/vision_tools.py`, `suwen/models.py`, `tests/test_vision.py` (7 tests) | Partial / external-limited: real vision model not validated. |
| Remote agent tools | `agent/remote_tools.py` (4.7 KB) | Implemented for workspace/SSH tooling. |

## 5. Sessions, messages, projects, workspaces, files, artifacts, trajectories

| Capability | Code evidence | Status / limits |
|---|---|---|
| Sessions/conversations persistence | `session/store.py:119-132` (atomic JSON conversation saves), `sessions/*.json` user data | Implemented but JSON-based, not the vNext SQLite record store. |
| Session jobs (in-memory jobs + daemon threads) | `session/jobs.py:68-75,122-129,189-202`; race fixed (`done` before `_finish`) — verified by tests | Implemented; jobs die on shutdown. Not durable. |
| Runtime event log / runs | `runtime/events.py:184-201,342-368` (SQLite v3, WAL, FK, sync=NORMAL, crash reconcile `interrupted`); `runtime/runs.py` (41 KB) | Implemented: submit-id dedupe, persist-before-broadcast, replayable SSE, cancellation, child runs. No leases/fencing/outbox/timers. |
| Task DAG persistence + in-memory asyncio dispatch | `suwen/tasks.py:40-49,107-125,143-240` (persisted DAG, restart -> interrupted, completed nodes skipped) | Partial durable: no lease/fencing/reclaim, no durable timer. |
| Second record store with revisions + optimistic version | `suwen/store.py:37-57,73-90` | Implemented at Python level; no lease/fencing/outbox/durable timer (baseline duplication with runtime event store). |
| Projects/discovery projects | `routes_discovery.py`, `discovery/engine.py` (66 KB), `discovery/types.py` | Implemented Python-level discovery workflow. |
| Workspaces (local/SSH roots; kernels/files/jobs/memory/knowledge/layout partitions) | `omicslab/workspace/service.py`, `server/routes_workspaces.py`, `suwen/configuration.py` | Implemented; single-machine single-user, no team roles. |
| Files/figures/artifacts | `server/files.py`, `routes.py` file endpoints, `server/terminal.py`, figures view | Implemented; no automatic per-file snapshot of arbitrary shell writes (snapshot only for agent write_file). |
| Trajectories | `omicslab/trajectories.py` (8.2 KB), `server/routes_trajectories.py` | Implemented; not a durable evidence chain. |
| Import/export of workspaces/projects | `routes_workspaces.py`, `DATA-MIGRATION-V2.json`, `docs/UPGRADE-*` | Implemented Python-level; no vNext backup-first importer. |

## 6. Execution: jobs, kernel, terminal, SSH remote compute

| Capability | Code evidence | Status / limits |
|---|---|---|
| Jupyter kernel manager | `omicslab/kernel/manager.py` (28.7 KB): kernel name `omicslab`, `OMICSLAB_WORKSPACE`, kernelspec display_name `素问 Suwen`, PID marker `__OMICSLAB_PID__` | Implemented; kernel/runtime identity intentionally legacy for compat. |
| Terminal/shell | `server/terminal.py` (13.4 KB) | Implemented. |
| Execution backends | `execution/base.py`, `execution/local.py`, `execution/remote_kernel.py`, `execution/ssh_backend.py` (46 KB) | Implemented. |
| SSH manager (83.8 KB), connections, credentials, worker, tools | `ssh/manager.py` (83.8 KB), `ssh/connections.py`, `ssh/credentials.py`, `ssh/worker.py`, `ssh/tools.py` | Implemented and heavily tested (42 tests in `test_ssh.py`, 7 in `test_execution_ssh.py`); credentials in user config, optional DPAPI vault. |
| Python analysis sandbox | `suwen/sandbox.py` (3.5 KB, `DockerSandbox`: network off, read-only root, CPU/mem/time limits) | Partial: Docker path implemented, **not validated on this host**; regular local Python/shell still host-permission. |
| Fixed sample Python worker | `desktop/worker/research_worker.py` (fixed stdlib statistics sample, reproducible JSON) — vNext addition, not baseline | New; not a research worker service. |

## 7. Planning, durable execution, recovery (baseline gaps that vNext must close)

- No lease/fencing/heartbeat/reclaim/durable-timer in the Python record store (audited in `docs/architecture/current.md`; `suwen/store.py` lacks them, `session/jobs.py` in-memory).
- Restart marks runs `interrupted`; completed nodes skipped; no automatic reclaim/retry of interrupted steps.
- No outbox/idempotent `operation_id`; side-effect dedupe only via submit-id dedupe for runs.
- No checkpoint/restore of a task DAG + context reference bundle.
- Compaction is char-size based and discards history (`suwen/models.py:22-52`), not token-budget/structured-summary based.
- Result: baseline task execution is "durable-ish" (SQLite persisted events/DAG) but not the vNext durable engine; parity matrix records this precisely.

## 8. MCP and Skills

| Capability | Code evidence | Status / limits |
|---|---|---|
| MCP manager (stdio + Streamable HTTP, discovery, tools/resources/prompts, timeouts, encrypted env/header refs, approval) | `suwen/mcp.py` (11.6 KB, `MCPConnection`, `MCPManager`), `routes.py` MCP endpoints, settings UI | Implemented Python-level; tests via mock transports + real stdio subprocess in platform tests. OAuth/sampling/elicitation incomplete. |
| Skill registry (SKILL.md, local/HTTPS git install, static checks, default disabled, version summary, enable/disable, rollback, soft uninstall) | `suwen/extensions.py` (12.3 KB, `SkillRegistry`), `agent/skills.py` (9.9 KB), `server/routes.py` skill endpoints, `skills/` 23 skill dirs | Implemented; no dependency auto-install, no marketplace/signature trust chain. |
| Function registry | `omicslab/registry/index.py` (11.8 KB), `registry/tools.py`, `server/routes_registry.py`, `skills/function-registry` | Implemented. |
| Preinstalled scientific skills (23): biomedical-discovery, bulk-transcriptomics, cadd-cheminformatics, causal-inference, co-scientist, empirical-research, experimental-design, figure-style, flow-cytometry, function-registry, geo-public-data, hypothesis-generation, notebook-ops, paper2agent, remote-compute-ssh, report-writing, robin, rsi-discovery-loop, single-cell-downstream, single-cell-upstream, spatial-transcriptomics, statistical-rigor, vision-interpretation | `omicslab/skills/*/SKILL.md` | Implemented as prompt/procedure skills; several are upstream-inspired adaptations, not full upstream installs (documented in V2 checklist items 8). |

## 9. Research: discovery, evidence, hypothesis, debate, methods, analysis, autonomy

| Capability | Code evidence | Status / limits |
|---|---|---|
| Discovery engine (projects, runs, reports, evidence ledger) | `discovery/engine.py` (66.6 KB), `discovery/evidence.py` (25.8 KB), `discovery/ledger.py` (11.6 KB), `discovery/tools.py` (21.8 KB), `discovery/types.py` (13.3 KB), `server/routes_discovery.py`, `web/js/views/discovery.js` (55 KB) | Implemented Python-level; heuristic scientific recognition; no full dependency lock/data version graph. Tests: `test_discovery.py` (11), `test_evidence.py` (21). |
| Evidence/claims/provenance, DOI/PMID/URL capture, retraction flags, gate | `discovery/evidence.py`, `suwen/biomedical.py` | Partial: metadata does not verify citation-support relation; human review supported. |
| Hypothesis generation/roles/evolution | `agents/hypothesis-smith.md`, `skills/hypothesis-generation`, discovery engine | Partial (prompt-level, heuristic). |
| Multi-agent debate (proposal/critique/revision/summary) | `suwen/orchestration.py` (4.5 KB), `workers`/agents roles, `web/js/views/platform.js` | Partial: serialized same-provider proposal/critique/revision; no independent consensus parser. |
| Methods: Paper2Agent/Co-Scientist/Robin/ERA/Biomni-style | `skills/paper2agent`, `skills/co-scientist`, `skills/robin`, `skills/empirical-research`, `skills/biomedical-discovery` | Partial: documented as adapted/incomplete; no automatic paper->MCP pipeline. |
| Analysis (Biomni-style candidates -> sandbox -> score -> revise; env/seed/data version) | `suwen/sandbox.py`, `suwen/experiments.py` (3.6 KB), `suwen/tasks.py`, `web/js/views/workbench.js` | Partial: Docker sandbox code exists but unvalidated on host; experiment comparison/verification exists. |
| Autonomy/research graph | `runtime/runs.py`, `runtime/events.py`, `suwen/tasks.py` (baseline DAG only) | Not implemented as recoverable research graph/world model. |
| RSI loop | `skills/rsi-discovery-loop/SKILL.md` (prompt only) | Not implemented as runtime. |

## 10. Knowledge, memory, embeddings, retrieval

- `suwen/knowledge.py` (7.1 KB): document ingestion (Markdown/text/code/CSV/Word, optional PDF), incremental summaries, dedupe, versioning, original-location, workspace search, source filter API.
- `agent/memory.py`: workspace digests with provenance, expiry, dedupe; lexical search; optional API embedding search (not local neural).
- Known gaps: no authorization-aware external platforms, no web/full-repo crawling, no OCR/multimodal parsing, no fine-grained source ACL or per-task knowledge-base UI (V2 checklist #20).

## 11. Context management and compaction (baseline)

- `suwen/models.py:22-52`: char-size compaction that discards history and shortens the system prompt.
- `agent/loop.py:209-226`: char-bound trimming of tool/context history.
- No token budget accounting, no structured summary coverage/hash validation, no versioned summary restore, no artifactization of tool output.
- Baseline strength: raw conversation JSON is persisted atomically (`session/store.py:119-132`) and runtime events are append-only in SQLite with crash reconciliation.
- vNext desktop context engine (`desktop/src/context.ts`) is a new implementation; evidence: `desktop-test.log` compaction tests (10 rounds, 200k-token-class history, restart retention). Baseline and vNext compaction are not code-shared.

## 12. Channels / WeChat / remote messaging

- `suwen/extensions.py` `Channels` + `suwen/wechat.py` (11.9 KB: trusted base URL, QR image, iLink QR login polling, private-chat text polling, optional reply) + `server/routes*.py` channel endpoints + `web/js/views/channel-setup.js` + `docs/CHANNELS.md`.
- Implemented: WebChat, Telegram adapter, WeChat iLink QR login/private text polling (QR retrieval tested by Lead; phone confirmation/real session pending user acceptance).
- Missing: WeCom/Feishu/QQ/OpenClaw native plugin, groups, attachments, full reconnect/backoff, unified ChannelAdapter lifecycle, remote read-only enforcement per channel.
- Credentials: channel secrets in config; vNext contract requires `secretRef` (safeStorage) and no plaintext secrets in JSON.

## 13. Security, approvals, credentials

- Per-tool/per-workspace policy with `allow/ask/deny/read_only`, remote read-only default (`suwen/service.py:80-100`); explicit ask cannot be bypassed by old auto (`agent/tools.py:325-329`).
- Windows DPAPI vault for credentials (`suwen/vault.py:14-47`).
- Origin checks/CORS on HTTP server (`server/app.py`); no CSP.
- Sandbox: Docker Python tool with network off, read-only root, limits; local Python/shell still host-level. Not a defense against prompt injection (documented).
- Tests: `test_suwen_platform.py` (17), `test_tools.py` (14), `test_turn_governance.py` (1), plus `test_ssh.py` (42) covering policy surface.

## 14. Import/export, configuration migration, install/upgrade

- `DATA-MIGRATION-V2.json`, `docs/UPGRADE-1.3.md`, `docs/UPGRADE-2.1.md`, `docs/INSTALL.md`, `docs/FAQ.md` (Q15 explains why `omicslab` package name/data dir are kept).
- Config schema V2 + history/rollback + pre-start backup + platform SQLite online backup + redacted export; import validates before apply (`suwen/configuration.py`, `suwen/store.py`, V2 checklist #21).
- No non-destructive vNext importer (vNext adds `desktop/src/import-service.ts`; unverified/unwired — see parity matrix).

## 15. Diagnostics, acceptance scripts, tests

- `scripts/acceptance.py` (33.8 KB) real-environment acceptance driver; `scripts/smoke.py` (22 KB); `scripts/check_dist.py`.
- Tests: 17 files, **184 test functions**; repo evidence run: **482 passed, 1 warning, 36.52 s, exit 0** (`docs/research/evidence/python-full-test.log`, interpreter `C:\ProgramData\miniconda3\python.exe`, `OMICSLAB_PROVIDER=mock`, isolated home, credentials stripped, no pytest cache writes).
- Test distribution: test_ssh 42, test_session 26, test_evidence 21, test_suwen_platform 17, test_tools 14, test_discovery 11, test_skills 10, test_execution_ssh 7, test_vision 7, test_cli 6, test_runtime 6, test_runtime_compat 4, test_trajectories 4, test_registry 3, test_terminal 3, test_remote_workspace 2, test_turn_governance 1.
- CI baseline: `.github/workflows/ci.yml:22-34,48-55` runs Python 3.10/3.11/3.12 on Ubuntu plus Windows 3.12 pytest. No Node/Electron job in baseline.

## 16. Documented baseline limitations (from repo's own audit/checklist)

1. Baseline is Python/FastAPI + SPA; no Electron/TypeScript/NSIS.
2. No token-budget/structured compaction; char-size trimming loses history.
3. No lease/fencing/outbox/durable timer/checkpoint restore; in-memory jobs die on shutdown.
4. MCP OAuth/sampling/elicitation and many server interop cases incomplete.
5. Skill registry lacks dependency auto-install, signature trust chain, marketplace.
6. Discovery/evidence heuristics cannot guarantee semantic claim-support; metadata does not verify citations.
7. Docker sandbox not validated on host; local shell/Python host-privileged.
8. WeChat real-session/other channels incomplete; remote read-only policy exists only at Python layer.
9. RSI, Paper2Agent pipeline, Biomni/ERA/Robin full environments not implemented.
10. No 8/24/72 h endurance, no reboot recovery, no signed installer, no clean-VM lifecycle evidence.
11. No dependency lockfile; wheel/sdist-only distribution; npm/Electron supply chain belongs to the new desktop app.
12. `omicslab` package/data/env identifiers deliberately retained (compatibility) -> brand scan exceptions.

## 17. Parity implications (summary)

The Python baseline is a *feature-rich but non-durable, browser-based* product. The vNext desktop must re-provide the durable/UI/security/compaction/release layers (new code), wrap Python research capabilities as managed workers (not yet), and keep legacy data readable (importer unverified). The parity matrix records each capability in three columns with honest status; any baseline capability not present in desktop is marked NOT_STARTED rather than "done".
