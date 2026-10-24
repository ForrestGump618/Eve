# Python baseline → SuWen desktop feature parity matrix (final 3.2.0 evidence revision)

Updated 2026-10-25 after the Lead measured SuWen desktop **3.2.0** final evidence on this machine
(`C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`, branch `suwen-vnext-durable`).
Machine-readable rows: [`feature-parity-matrix.csv`](./feature-parity-matrix.csv) (85 rows).
The Python-old column is unchanged from the 3.0.0-preview.1 audit (see
[`python-feature-inventory.md`](./python-feature-inventory.md)); only the vNext column was upgraded
where the Lead's evidence proves it.

Status vocabulary: `IMPLEMENTED_PASS` (evidence proves the capability in the new desktop),
`UNVERIFIED` (code exists or evidence is partial/not from TARGET), `NOT_STARTED`, `N/A_PORT`,
`REPLACED` (old implementation intentionally superseded).

## 1. Current counts

| Status | Rows | Share |
|---|---:|---:|
| IMPLEMENTED_PASS | 67 | 79% |
| UNVERIFIED | 6 | 7% |
| NOT_STARTED | 9 | 11% |
| N/A_PORT | 1 | 1% |
| REPLACED | 1 | 1% |
| BLOCKED_EXTERNAL | 1 | 1% |
| **Total** | **85** | **100%** |

Upgrades since the 3.0.0-preview.1 audit (14 PASS / 42 UNVERIFIED / 9 NOT_STARTED / 1 N/A / 1 REPLACED, 67 rows): the 3.1.0 evidence round moved 42 rows to IMPLEMENTED_PASS and the final 3.2.0 round moved 10 round-3 rows to IMPLEMENTED_PASS, for **66 / 85** rows. Eighteen round-3 capability rows were appended (85 rows total) and one row (`23 preinstalled scientific skills`) is NOT_STARTED. Machine-readable: `docs/research/repro/round3/round3-data.py`.

## 2. What is now proven in the new desktop (PASS groups)

- **Shell/UI (6 rows):** five workspaces; streamed chat + markdown; incremental timeline rendering;
  zh/en labels; session/conversation persistence; project/discovery projects; files/figures/artifacts.
  Evidence: `npm test` 182/180 pass/0 fail/2 skips; `scripts/e2e-rpc.mjs --live` 42/0;
  packaged `electron-smoke.mjs` 8/8; `scripts/ui-dom-qa.mjs` 19/0/12 (12 warnings are the five
  main-process bridge methods); `desktop/ui/actions.json` 144 actions all bound.
- **Durability/runtime (10 rows):** SQLite v3 WAL/FULL/foreign keys/busy_timeout + pre-migration
  backup; persisted task DAG; lease/fencing/heartbeat/reclaim; durable timer and waiting_approval;
  outbox + idempotent operation ids; checkpoints + artifact SHA-256; token/cost/call budgets;
  observability/doctor (11 checks) + support export; raw event immutability + crash reconcile;
  approvals. Evidence: `npm test` durable/daemon suites; `scripts/chaos-smoke.mjs` short-window real
  fault injection: **12/12 scenarios passed, 52.2 s** (`docs/verification/chaos-results.json`,
  finished 2026-10-24T17:34:35.821Z) — worker SIGKILL retry, daemon SIGKILL lease recovery with the
  same operation id, committed steps not replayed, cancellation, provider 429/500 retries with
  approvals, billing-unknown reconciliation; packaged smoke 30 s timer after UI exit;
  8/24/72 h NOT run.
- **Context (7 rows):** independent ContextManager + token accounting; two-level compaction;
  structured/validated summaries; memory tiers + project facts + archive retrieval; tool-output
  artifactization; versions + manual compaction/rollback; 10-round ~201 k-token compaction test.
  Evidence: `npm test` context suites; `e2e-rpc` context history/restore/compact; not claimed
  semantically lossless.
- **Research/extensions (14 rows):** Python research worker v2.0.0 (`suwen-research-worker/2`, pure
  stdlib, sandboxed `runScript` returning file digests, real demo.fcs metrics); discovery engine;
  evidence ledger; hypothesis generation/selection; multi-agent debate; autonomy graph; six research
  capabilities as durable DAG workflows with typed records; RSI constrained loop; Biomni-style
  analysis sandbox; MCP registry; Skill registry (static scan + isolated test + atomic install);
  channels adapter framework; read-only remote channel policy.
  Evidence: worker 22 tests / 21 pass / 1 skip; `e2e-rpc` research rows + real PubMed/UniProt calls;
  unit tests for tools/channels/rsi/domain-research. External platforms (Biomni/Paper2Agent/ERA/
  Robin/Kosmos, real Telegram/Slack/Discord/WeChat accounts) are **not bundled/connected**.
- **Legacy/import/release (5 rows):** import-service read-only scan of the real legacy home (9
  item groups), backup-first/idempotent apply, rollback tests 5/5; NSIS x64 installer built from
  frozen final code (`release/SuWen-Setup-3.2.0-win-x64.exe`, 129,446,526 bytes, SHA-256
  `7b0dde7b9e12e403e620e16651d969cd21c874cf16598d409d6a7b2fa2199546`, UNSIGNED) and unpacked
  layout inspected; **final-artifact host lifecycle probe 12/12 steps passed**
  (`docs/verification/artifacts/installer-lifecycle.json`: install ~24 s, exe version 3.2.0, running
  app, authenticated daemon attach `mode user-background`, daemon survives UI close, reinstall 24 s,
  uninstall 11 s, user-data preservation) and **cross-version upgrade 3.0.0-preview.1 → 3.1.0
  8/8 passed** (`upgrade-path.json`); packaging metadata; brand cleanup; desktop unit/integration
  tests. clean-VM lifecycle and code signing remain pending; `SHA256SUMS` is present.

## 3. Remaining non-PASS rows (14)

| Row | Status | Gap |
|---|---|---|
| Windows login recovery / background mode | UNVERIFIED | detached daemon + close-UI survival proven in packaged smoke; login-item recovery and reboot not exercised |
| CI for desktop + installer | UNVERIFIED | `.github/workflows/suwen-windows.yml` exists; no GitHub Actions run was observed in this session |
| Model routing / auto config / fallback | NOT_STARTED | single configured provider per task; no automatic routing/fallback |
| Vision verification loop | NOT_STARTED | legacy Python vision tools preserved in compatibility mode only |
| Workspaces (local roots) | NOT_STARTED | project workspaces exist, but arbitrary local root folders/bindings are not implemented |
| SSH remote workspaces/exec | NOT_STARTED | legacy Python SSH stack preserved, not bridged to new desktop |
| Trajectories/audit trail | NOT_STARTED | durable records exist; no user-facing trajectory browser |
| Jupyter kernel manager | NOT_STARTED | legacy kernel manager preserved in compatibility mode only |
| Terminal/shell | NOT_STARTED | no integrated terminal in new desktop |
| Paper2Agent pipeline | NOT_STARTED | external Paper2Agent installation/construction not bundled or exercised |
| 23 preinstalled scientific skills | NOT_STARTED | no builtin catalog in `desktop/src/domain/tools.ts`; 23 SKILL.md dirs live only in bundled `resources/legacy` |
| Clean-VM install/upgrade/uninstall | UNVERIFIED | host lifecycle **12/12** on the final 3.2.0 artifact, including installing 3.0.0-preview.1 and upgrading (`installer-lifecycle.json`); clean-VM install/start/upgrade/uninstall still PENDING_LEAD; `SHA256SUMS` is now present (`desktop/release/SHA256SUMS`, `docs/release/SHA256SUMS.txt`) |
| CLI entrypoints (18 subcommands) | N/A_PORT | Python CLI is intentionally preserved; the new desktop is GUI/RPC-only |
| In-memory jobs + threads | REPLACED | replaced by durable DAG engine; not ported |

`docs/requirements/master-requirements.csv` is the requirement-level view of the same evidence
(81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL over 98 requirement rows)

## 4. Reuse strategy (unchanged)

Mature Python engines were **wrapped, not ported**: discovery engine (66 KB), evidence ledger
(25.8 KB), SSH manager (83.8 KB), runtime event log (40.9 KB), MCP manager, knowledge/memory,
23 skills, 13 agent role prompts. They stay reachable through the optional authenticated legacy
Python workbench (separate process, isolated home, new mock provider, no credential copying).
The new desktop re-implements durability, context/compaction, UI shell and security as MIT code,
because the Python baseline lacks leases/fencing/outbox/durable timers and has UI-coupled state.

## 5. Data migration / compatibility

- New desktop state: `<Electron userData>/SuWen/runtime/harness.sqlite` (v3).
- Legacy data stays in `%LOCALAPPDATA%/OmicsLab` / `~/.omicslab` (read-only for import inspect);
  identifiers/data dirs/API names in the Python package are intentionally retained
  (LEGACY-BRAND-COMPAT, see `docs/research/branding-exceptions.md`).
- Explicit backup-first import (`import.inspect/apply/jobs/rollback`); no automatic migration and
  no silent overwrite; the user's real legacy home was not modified by this audit.
- 23 legacy skills, agent prompts and web UI remain in `resources/legacy` for the optional
  compatibility window, not in the new registry.

## 6. Test / evidence cross-reference

| Evidence | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | tests 182, pass 180, fail 0, skipped 2, 33.4 s, exit 0 |
| `node scripts/e2e-rpc.mjs --dist dist --live` | 42 passed / 0 failed, ~7 s; real Europe PMC PMID 42878939 + UniProt Q9Y2B4, artifacts with sha256 |
| `SUWEN_SMOKE_PACKAGED=1 node scripts/electron-smoke.mjs` | 8/8 checks, exit 0, 106 s on the final build; artifacts `release/smoke/work/electron-e2e-result.json`, two screenshots |
| `node scripts/ui-dom-qa.mjs` | 19 passed / 0 failed / 12 warnings |
| `node --check desktop/ui/app.js` | exit 0 |
| Python research worker tests | 22 tests / 21 pass / 1 skip (Windows symlink EPERM) |
| Installer | `SuWen-Setup-3.2.0-win-x64.exe` 129,446,526 B, SHA-256 `7b0dde7b…9546`, blockmap 135,974 B, UNSIGNED; `SHA256SUMS` present |
| Installer host lifecycle (final 3.2.0 artifact) | 12/12 steps passed (`docs/verification/artifacts/installer-lifecycle.json`), incl. installing 3.0.0-preview.1 and upgrading to 3.2.0 — host probe only |
| Cross-version upgrade | 3.0.0-preview.1 → 3.2.0 pass recorded in the lifecycle report — host probe only |

Skipped/unproven: 2 unit skips (Windows symlink EPERM; optional legacy Python workbench deps),
legacy workbench unavailable in packaged smoke (Python lacks fastapi), live MCP gated behind
`SUWEN_SMOKE_LIVE=1` (covered by item 3 e2e instead), clean-VM lifecycle, 8/24/72 h
endurance, real external model accounts, code signing.

## 7. Known gaps and priorities

- **P0:** clean-VM installer lifecycle (`SHA256SUMS`; host lifecycle 12/12 already passed on the final 3.2.0 artifact); Windows CI execution; real external model accounts;
  wire every main-process bridge method into UI QA coverage (currently 5 intentional warnings).
- **P1:** 8/24/72 h + reboot/power-loss/disk-full endurance; legacy skill migration into the new
  registry; OS-level sandbox/quotas; code signing.
- **P2:** Paper2Agent/Biomni/ERA/Robin/Kosmos integrations; SSH/terminal/kernel/workspaces in the new
  desktop; trajectories UI; model routing.
- **P3:** marketplace/update channel for skills, remote/Temporal workers.

## 8. Related documents

- [`master-requirements.csv`](../requirements/master-requirements.csv) — requirement-level status.
- [`integration-and-e2e.md`](../verification/integration-and-e2e.md) — commands/results/artifacts.
- [`windows-installer-verification.md`](../release/windows-installer-verification.md) — installer facts.
- [`durability-chaos-tests.md`](../verification/durability-chaos-tests.md) — short-window fault injection.
- [`ui-action-coverage.csv`](../verification/ui-action-coverage.csv) — 144 UI actions with RPC bridge
  classification.
- [`python-feature-inventory.md`](./python-feature-inventory.md) — Python baseline inventory.

## 9. Final round-3 evidence (3.2.0 build, 2026-10-25)

Round-3 rows were appended for the P0/P1 targets in `docs/requirements/round-3-release-master-prompt.md`.
The CSV is now **85 rows**: **IMPLEMENTED_PASS 67 / UNVERIFIED 6 / NOT_STARTED 9 / N/A_PORT 1 /
REPLACED 1 / BLOCKED_EXTERNAL 1**.

| Round-3 capability | vNext status | Evidence / gap |
| --- | --- | --- |
| Typed streaming event protocol (`events.stream`, `StreamEnvelope` v1) | IMPLEMENTED_PASS | `desktop/src/stream-events.ts`, `shared/contract.ts`, `test/stream-events.test.ts`; daemon dispatch `daemon.ts:194`; T1 `ui-streaming-stability.md` |
| Incremental render / batched updates | IMPLEMENTED_PASS | `ui/app.js`, `ui/stream-core.js`; T2 100/1k/10k exact sha256 (`ui-e2e-summary.json`) |
| Composer stability | IMPLEMENTED_PASS | T2 composer deviation 0 px; draft preserved |
| Scroll intent / anchor preservation | IMPLEMENTED_PASS | T2 forced drift 0 px after T1 fix (pre-fix 14,556 px gap) |
| Markdown/complex content streaming safety | UNVERIFIED | Safe subset + `textContent` rendering (`ui/markdown.js`); no streaming complex-content matrix |
| Reasoning/tool/answer separation | UNVERIFIED | Not separately asserted in T2 beyond tool-trace rendering |
| Run state machine (single source of truth) | IMPLEMENTED_PASS | `stream-core.test.ts` 23/23; T1 state walk |
| Cancel/timeout/reconnect real E2E | UNVERIFIED | Cancel: e2e-rpc 42/0 + chaos 12/12; auto-reconnect fix + unit tests; T2 post-fix SIGKILL re-run not published (D-017) |
| Renderer error isolation | UNVERIFIED | Async rejections surfaced (`#error`); no crash-injection test |
| Quantitative streaming matrix (100/1k/10k) | IMPLEMENTED_PASS | `ui-e2e-summary.json`: exact sha256, lag p95, 10k render 152 s, paint ~5 ms |
| Visual auto-acceptance matrix | IMPLEMENTED_PASS | `ui-visual-audit.md`: 180 PNGs / 144-shot matrix, 0 layout defects, dark theme verified; P2 chat-error surface open |
| Known-defect fixes (T2 stream/recovery set) | IMPLEMENTED_PASS | `defect-register.csv` D-013..D-017; `desktop/test/conversations.test.ts` |
| Durable re-verification after UI/streaming changes | IMPLEMENTED_PASS | chaos 12/12 in 51.4 s on the final tree; 8/24/72 h **not run** (R050) |
| Full UI action runtime coverage | IMPLEMENTED_PASS | 144 actions mapped (0 unknown), DOM QA 19/0/12; no per-action click-through matrix |
| Clean-Windows-VM install/upgrade/uninstall | UNVERIFIED | Host lifecycle 12/12 on the final 3.2.0 artifact; no clean VM |
| GitHub MIT publication + Release upload | BLOCKED_EXTERNAL | Remote readable; `gh` CLI/token absent |
| Six research capabilities real E2E + debate rules | IMPLEMENTED_PASS | T3 `e2e-results.md`: deterministic 19 PASS / 0 FAIL / 3 SKIP; live 21/21; debate case 7 |
| MCP / skills / providers / channels / RSI checks | IMPLEMENTED_PASS | T3 cases; provider protocols local fixtures only; external accounts not used |
| Performance baseline | IMPLEMENTED_PASS | `performance-baseline.md` + JSON |
| Security review + automated scan | IMPLEMENTED_PASS | `security-review.md`; scan PASS 0 HIGH; no OS sandbox |
| OS-level sandbox / quotas | NOT_STARTED | Electron sandbox only |
| Diagnostics centre | IMPLEMENTED_PASS | `doctor.run` 11 checks; T3 boot case |
| Mandatory machine-readable reports | IMPLEMENTED_PASS | CSV/parity/UI coverage/verification docs |
| Release gates + defect register | IMPLEMENTED_PASS | `release-gates.md`, `defect-register.csv` (20 defects) |
| 3.2.0 release docs (CHANGELOG/notes/publication runbook) | IMPLEMENTED_PASS | All present; installer measured; publication blocked |

Final measured facts: installer `SuWen-Setup-3.2.0-win-x64.exe` 129,446,526 B SHA-256
`7B0DDE7B…2199546` (unsigned), blockmap 135,974 B `BCD62E14…`, unpacked 249,801,728 B `8F7EAF76…`,
`SHA256SUMS` present in both locations; tests 182/180/2 (33.4 s); e2e-rpc 42/0 live; packaged smoke
8/8; UI DOM QA 19/0/12; chaos 12/12 (51.4 s); host lifecycle 12/12 + upgrade from 3.0.0-preview.1.
Stable release remains unauthorized (`docs/release/release-gates.md`); clean VM, signing, endurance and
publication stay open.
