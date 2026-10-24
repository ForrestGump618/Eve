# vNext acceptance status — desktop 3.2.0 (2026-10-25, final evidence round)

Measured evidence and full caveats: `../docs/release/final-acceptance-report.md`,
`../docs/release/release-gates.md`, `../docs/verification/integration-and-e2e.md`,
`../docs/release/windows-installer-verification.md`,
`../docs/requirements/master-requirements.csv` (80 IMPLEMENTED_PASS / 13 UNVERIFIED / 4 NOT_STARTED /
1 BLOCKED_EXTERNAL of 98 rows) and `../docs/migration/feature-parity-matrix.md`.

| Requirement | Actual status |
|---|---|
| Typecheck / build / unit+integration suite | **Pass** — `tsc --noEmit` exit 0; `npm run build` exit 0; `npm test` 150 tests / 148 pass / 0 fail / 2 skipped (29.5 s, exit 0) |
| RPC E2E on real detached daemon | **Pass** — `e2e-rpc.mjs --live` 42/0, ~7 s, authenticated named pipe; live Europe PMC/PubMed + UniProt artifacts with sha256 |
| Packaged Electron E2E (final 3.2.0 build) | **Pass** — 8/8 checks, exit 0, 68 s: detached daemon, context isolation, safeStorage config, streamed chat, UI exit keeps daemon, 30 s timer completes with `attempts=1`, same-daemon reopen, sandboxed Python worker |
| Functional / live E2E (T3) | **Pass** — deterministic 22 cases 19 pass / 0 fail / 3 skip (10.8 s); live suite **21/21** (13.7 s): six research capabilities, debate rules, MCP/skill/channel/RSI checks against real daemon + real public DBs |
| Typed streaming protocol | **Pass** — `events.stream` + `StreamEnvelope` v1 merged into daemon dispatch, unit tests `stream-events.test.ts` + `stream-core.test.ts` 23/23, documented in `../docs/architecture/streaming-protocol.md` |
| Streaming UI stability / delta matrix (T2) | **Pass for measured scope** — deterministic fixture suite 22 cases 19/0/3; 100/1k/10k-delta text integrity via exact DOM sha256; composer deviation 0 px; scroll forced drift 0 px; layouts 1920×1080/1366×768/980×680 × zh/en × five workspaces; dark theme implemented. **Limits:** frame/FPS paint not measured; markdown-during-stream not asserted |
| Auto-reconnect / duplicate append after daemon SIGKILL | **UNVERIFIED** — T2 interim report recorded FAIL; fixes landed afterwards (`main.ts` bounded backoff 300 ms–12 s, `conversations.ts` idempotent append, `conversations.test.ts`), but T2 post-fix in-Electron re-run was not published → R130 remains UNVERIFIED |
| Visual acceptance matrix | **UNVERIFIED** — `ui-visual-audit.md` not published; screenshots exist under `../docs/verification/screenshots/` and layout checks are in `ui-e2e.md` |
| UI DOM QA / actions wiring | **Pass with warnings** — 19/0/12 (warnings = intentional main-process bridge methods); `actions.json` **144 actions**, coverage 91 daemon RPC / 10 main process / 43 UI-only / **0 unknown methods** |
| Real public research DB calls | **Pass** — Europe PMC/PubMed `CRISPR base editing` PMID **42878939**; UniProt TP53 **Q9Y2B4** (release 2026_03), artifacts with sha256 |
| Python research worker | **Pass for implemented scope** — v2.0.0 stdlib worker, 22/21 tests (1 Windows symlink skip), real demo.fcs metrics + sandboxed `runScript`; no scientific stacks/OS sandbox |
| SQLite/durable state machine/lease/outbox/timers/checkpoints/budgets | **Implemented + short-window chaos tested** — 12/12 scenarios passed in 51.7 s (worker/daemon SIGKILL, idempotency, cancel, billing-unknown reconciliation); **8/24/72 h NOT run** |
| Context compaction / versions | **Pass for implemented behavior** — ten-round ~201k-token compaction, versions/manual compaction/rollback; semantic losslessness NOT claimed |
| Two provider adapters | **Local HTTP protocol fixtures pass** — real external model accounts UNVERIFIED/BLOCKED_EXTERNAL |
| MCP / Skill registries | **Pass at registry/scan/install/test level** — no live third-party repo install exercise; 23 legacy scientific skills NOT migrated into the new registry |
| Channels adapter | **Pass for framework + local fixtures** — real Telegram/Slack/Discord/WeChat accounts BLOCKED_EXTERNAL; read-only default |
| Research workflows (knowledge/hypothesis/debate/methods/analysis/discovery/autonomy) + RSI | **Pass as durable typed DAG workflows** — external Biomni/ERA/Robin/Kosmos/Paper2Agent integrations NOT bundled; scientific validity externally unvalidated |
| Legacy data import | **Pass (backup-first, explicit)** — real legacy home read-only scan; apply idempotent, rollback 5/5 unit tests; user data untouched; no automatic migration |
| Optional legacy Python workbench | **Unavailable on this host** (Python lacks `fastapi`) — source preserved under `resources/legacy`; not a pass |
| Branding | **Pass** — 983 raw hits / 143 files, 0 requiring change; all retained hits documented legacy-compat paths/fields |
| Build / installer artifacts | **Pass** — NSIS x64 installer `release/SuWen-Setup-3.2.0-win-x64.exe`, **129,447,101 B**, SHA-256 `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`, blockmap 135,948 B, unpacked exe hash verified; **UNSIGNED** |
| Install/upgrade/uninstall lifecycle | **Host probe PASS** — final-artifact lifecycle **12/12** (install, version metadata, running app, authenticated daemon attach, daemon survives UI close, reinstall, uninstall, user-data preservation) and upgrade source `3.0.0-preview.1` installed PASS; **clean-VM lifecycle NOT verified** |
| `SHA256SUMS` / Windows CI execution | **`SHA256SUMS` present** (`release/SHA256SUMS`, mirrored `docs/release/SHA256SUMS.txt`); Windows CI workflow exists but was **never executed** |
| Security | **Pass for implemented layer** — contextIsolation/sandbox renderer, CSP, schema IPC/sender checks, path guards, safeStorage, timing-safe token; scan PASS 0 HIGH/18 LOW/10 test fixtures; npm audit 0; full OS sandbox/quotas NOT implemented |
| Performance | **Baseline measured** — daemon ready p50 391 ms, create p50 0.82 ms, events.stream p50 1.49 ms, worker flowSummary 20.9 ms; UI/markdown first-token and endurance not measured |
| 8/24/72 h / reboot / power-loss / disk-full durability | **Not performed** — no endurance claim |
| Code signing / SmartScreen | **BLOCKED_EXTERNAL** — unsigned; SmartScreen warning expected |
| GitHub MIT publication / Release assets | **BLOCKED_EXTERNAL** — remote readable, `gh` absent/no token; commands documented, not executed |
| Paper2Agent/Biomni/ERA/Robin/Kosmos, 23 legacy skills in new desktop, SSH/terminal/kernel/workspaces/trajectories/model routing/vision | **NOT_STARTED** — preserved only in bundled legacy Python workbench where applicable |

Rule: only rows backed by TARGET evidence count as passed. Do not promote
UNVERIFIED/NOT_STARTED rows, and do not describe 3.2.0 as a fully accepted, clean-machine-verified or
published vNext release.
