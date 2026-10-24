# vNext acceptance status — desktop 3.1.0 (2026-10-25)

Measured evidence and full caveats: `../docs/verification/integration-and-e2e.md`,
`../docs/release/windows-installer-verification.md`, `../docs/requirements/master-requirements.csv`
(59 IMPLEMENTED_PASS / 7 UNVERIFIED / 5 NOT_STARTED of 71 rows) and
`../docs/migration/feature-parity-matrix.md`.

| Requirement | Actual status |
|---|---|
| Typecheck / build / unit+integration suite | **Pass** — `tsc --noEmit` exit 0; `npm test` 150 tests / 148 pass / 0 fail / 2 skipped (28.3 s, exit 0) |
| RPC E2E on real detached daemon | **Pass** — `e2e-rpc.mjs --live` 42/0, ~7 s, over authenticated named pipe |
| Packaged Electron E2E (final build) | **Pass** — 8/8 checks, 106 s: detached daemon, context isolation, safeStorage config, streamed chat, UI exit keeps daemon, 30 s timer completes with `attempts=1`, same-daemon reopen, sandboxed Python worker |
| UI DOM QA / actions wiring | **Pass with warnings** — 19/0/10 (warnings = 5 main-process bridge methods); 142 actions, 79 RPC methods |
| Real public research DB calls | **Pass** — Europe PMC/PubMed `CRISPR base editing` PMID **42878939**; UniProt TP53 **Q9Y2B4** (release 2026_03), artifacts with sha256 |
| Python research worker | **Pass for implemented scope** — v2.0.0 stdlib worker, 22/21 tests (1 Windows symlink skip), real demo.fcs metrics + sandboxed `runScript`; no scientific stacks/OS sandbox |
| SQLite/durable state machine/lease/outbox/timers/checkpoints/budgets | **Implemented + short-window chaos tested** — 12/12 scenarios passed in 52.2 s (incl. billing-unknown reconciliation); 8/24/72 h NOT run |
| Context compaction / versions | **Pass for implemented behavior** — ten-round ~201k-token compaction, versions/manual compaction/rollback; semantic losslessness NOT claimed |
| Two provider adapters | **Local HTTP protocol fixtures pass** — real external model accounts UNVERIFIED/BLOCKED_EXTERNAL |
| MCP / Skill registries | **Pass at registry/scan/install/test level** — no live third-party repo install exercise; 23 legacy scientific skills NOT migrated into new registry |
| Channels adapter | **Pass for framework + local fixtures** — real Telegram/Slack/Discord/WeChat accounts BLOCKED_EXTERNAL; read-only default |
| Research workflows (knowledge/hypothesis/debate/methods/analysis/discovery/autonomy) + RSI | **Pass as durable typed DAG workflows** — external Biomni/ERA/Robin/Kosmos/Paper2Agent integrations NOT bundled; scientific validity externally unvalidated |
| Legacy data import | **Pass (backup-first, explicit)** — real legacy home read-only scan = 9 item groups; apply idempotent, rollback 5/5 unit tests; user data untouched; no automatic migration |
| Branding | **Pass** — 983 raw hits / 143 files, 0 requiring change; all retained hits documented legacy-compat paths/fields |
| Build / installer artifacts | **Pass** — NSIS x64 installer 129,425,145 B, SHA-256 `e1a1062c…7ac4`, unpacked exe hash verified; **UNSIGNED** |
| Install/upgrade/uninstall lifecycle | **Host probe PASS** — final-artifact lifecycle 14/14 (install, version metadata, running app, authenticated daemon attach, daemon survives UI close, reinstall, uninstall, user-data preservation) and cross-version upgrade `3.0.0-preview.1 → 3.1.0` 8/8; **clean-VM lifecycle NOT verified** |
| `SHA256SUMS` / Windows CI execution | **Pending** — workflow file exists and was never executed here; no `SHA256SUMS` in `release/` |
| Security | **Pass for implemented layer** — contextIsolation/sandbox renderer, CSP, schema IPC/sender checks, path guards, safeStorage, timing-safe token; full OS sandbox/quotas NOT implemented |
| 8/24/72 h / reboot / power-loss / disk-full durability | **Not performed** — no endurance claim |
| Code signing / SmartScreen | **BLOCKED_EXTERNAL** — unsigned; SmartScreen warning expected |
| Paper2Agent/Biomni/ERA/Robin/Kosmos, 23 legacy skills in new desktop, SSH/terminal/kernel/workspaces/trajectories/model routing | **NOT_STARTED** — preserved only in bundled legacy Python workbench where applicable |

Rule: only rows backed by TARGET evidence count as passed. Do not promote
UNVERIFIED/NOT_STARTED rows, and do not describe 3.1.0 as a fully accepted vNext release.
