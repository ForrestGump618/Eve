# 素问 / SuWen desktop 3.1.0

New Electron/TypeScript client plus an independent authenticated user-level daemon. The original
Python research workbench remains in the parent repository and can be opened as an optional,
isolated compatibility window. **This is an evidence-tested incremental release, not completion of
the full vNext acceptance matrix.**

## Build & verify (Windows, Node 24.14+, npm)

```powershell
npm ci
npx tsc -p tsconfig.json --noEmit     # typecheck
npm test                              # build + node --test dist/test/*.test.js
node scripts/e2e-rpc.mjs --dist dist --live
$env:SUWEN_SMOKE_PACKAGED=1; node scripts/electron-smoke.mjs
node scripts/ui-dom-qa.mjs
npm run dist:win                      # NSIS x64 installer into release/
```

Measured on this machine (2026-10-25, branch `suwen-vnext-durable`):

| Check | Result |
|---|---|
| `npm test` | **150 tests / 148 pass / 0 fail / 2 skipped**, 28.3 s, exit 0 |
| `e2e-rpc.mjs --live` (real detached daemon over authenticated pipe) | **42 passed / 0 failed**, ~7 s, incl. real Europe PMC + UniProt calls |
| packaged `electron-smoke.mjs` (final build) | **8/8 checks**, 106 s (30 s durable timer completes after UI exit; reopen attaches same daemon) |
| `ui-dom-qa.mjs` | **19 passed / 0 failed / 10 warnings** (main-process bridge methods) |
| installer | `release/SuWen-Setup-3.1.0-win-x64.exe`, 129,425,145 B, SHA-256 `e1a1062c…7ac4`, **UNSIGNED** |

Skip reasons: Windows symlink `EPERM` in one research-worker test; optional legacy Python workbench
dependencies missing on the build machine. Full results: `../docs/verification/integration-and-e2e.md`.

## What works without Python

- Five workspaces (chat / projects / tasks / tools / settings), zh/en labels, streamed chat,
  incremental timeline, evidence panel, import wizard, task DAG/events/checkpoints/costs.
- Configure your own OpenAI-compatible or Anthropic endpoint/key in Settings. Keys are encrypted by
  Electron `safeStorage`; no cleartext fallback. Provider protocols are verified against **local HTTP
  fixtures only** — no external paid-account success is claimed.
- Detached daemon with authenticated current-user named pipe; closing the UI keeps it alive;
  Settings can quit it safely. Login recovery is opt-in user-level startup; **no Windows Service**.
- SQLite WAL state: durable DAG, leases/fencing/heartbeat, durable timers, outbox/idempotency,
  checkpoints, budgets, cancel/pause/resume, unknown-side-effect reconciliation.
- Independent ContextManager/CompactionService: known-model tokenizer + conservative estimate,
  structured source-linked summaries, versions/manual compaction/rollback. Ten ~201k-token rounds
  reduced to ~2.0–2.8k; explicit constraints/evidence/user text retained 100% — **not a claim of
  semantic losslessness**.
- Read-only MCP registries and real public Europe PMC/PubMed + UniProt queries; research workflows
  (knowledge/hypothesis/debate/methods/analysis/discovery/autonomy), RSI loop, channels adapter
  (read-only default, safeStorage credential refs) as durable typed workflows.
- Optional Python research worker (`worker/research_worker.py` v2.0.0, pure stdlib): fixed numeric
  analyses plus a `runScript` sandbox with timeouts/output caps/env allowlist/file digests. It is
  **not** an OS sandbox and does not bundle scientific stacks.

## Legacy compatibility / data

New data lives in Electron's userData `SuWen/runtime` (shown in Settings), separate from the old
Python data (`%LOCALAPPDATA%/OmicsLab`, `~/.omicslab`). Legacy packages, env vars, storage keys and
data dirs are intentionally retained as compatibility identifiers (see
`../docs/research/branding-exceptions.md`). The importer is explicit and backup-first:
`import.inspect` is read-only, `import.apply` backs up then applies idempotently, `import.rollback`
is unit-tested. **Nothing is imported automatically.** The full legacy workbench can be opened from
Tools in an authenticated isolated window; it starts with a new home/mock provider and does not
copy desktop credentials.

## Not complete (explicit)

- Clean-Windows-VM install/upgrade/uninstall lifecycle: **not verified**. On this host the final
  artifact passed a 14/14 lifecycle probe (install, metadata, running app, authenticated daemon
  attach, daemon survives UI close, reinstall, uninstall, user data preserved) and the
  `3.0.0-preview.1 → 3.1.0` upgrade path passed 8/8 — but that is **not a clean machine**. Installer
  is **unsigned** (SmartScreen warning expected); `SHA256SUMS` not yet in `release/`; Windows CI
  workflow exists but was **not executed** here.
- No 8/24/72-hour endurance, reboot, sleep/hibernate, power-loss or disk-full tests.
- Real external model accounts, code signing and full OS-level sandbox/quotas: **not verified /
  blocked by environment**.
- Paper2Agent/Biomni/ERA/Robin/Kosmos integrations, the 23 legacy scientific skills inside the new
  registry, SSH/terminal/kernel/workspaces, trajectories UI, model routing — **not started**.
- 23 skills and other legacy workflows remain reachable only through the bundled legacy Python
  workbench, not as native new-desktop features.

See `../docs/progress.md`, `acceptance-matrix.md`, `../docs/migration/feature-parity-matrix.md` and
`../docs/requirements/master-requirements.csv` for row-level evidence. Do not describe 3.1.0 as a
production-ready or fully vNext-complete release.
