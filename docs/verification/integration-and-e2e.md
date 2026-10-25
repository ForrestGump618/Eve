# Integration and end-to-end verification — SuWen desktop 3.2.0

Measured by the Lead on 2026-10-25 in
`C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
(branch `suwen-vnext-durable`, product version **3.2.0**, packaged runtime Node 24.22.0 /
Electron 45.0.0 / SQLite 3.53.4, build Node 24.14.0, Windows 11 10.0.26200).

This document records only commands that were actually executed in TARGET and their real results.
Anything not executed is listed as **NOT RUN** and must not be counted as passed.

## 1. Result summary

| # | Command | Result | Time | Exit |
|---|---|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | typecheck clean | — | 0 |
| 2 | `npm run build` (`tsc` + `scripts/copy-assets.mjs`) | build clean | — | 0 |
| 3 | `npm test` (build + `node --test dist/test/*.test.js`) | **tests 183, pass 181, fail 0, skipped 2** | 28.6 s | 0 |
| 4 | `node scripts/e2e-rpc.mjs --dist dist --live` | **42 passed / 0 failed**, real detached daemon over authenticated named pipe | ~7 s | 0 |
| 5 | `SUWEN_SMOKE_PACKAGED=1 node scripts/electron-smoke.mjs` | **8/8 checks**, exit 0, final packaged `release/win-unpacked/SuWen.exe` | 68 s | 0 |
| 6 | `node scripts/ui-dom-qa.mjs` | **19 passed / 0 failed / 12 warnings** | — | 0 |
| 7 | `node --check desktop/ui/app.js` | syntax OK | — | 0 |
| 8 | Python research-worker tests (`node --test` research-worker suite) | **22 tests / 21 pass / 1 skip** | — | 0 |
| 9 | `node scripts/chaos-smoke.mjs` (short-window real fault injection) | **12/12 scenarios passed** (`result: passed`), incl. injected provider 429/500 retried with human approvals and billing-unknown reconciliation | 51.4 s | 0 |
| 10 | Installer lifecycle on the FINAL artifact (`docs/verification/artifacts/installer-lifecycle.json`) | **12/12 steps passed** (install ~24 s, exe 3.2.0, running app, authenticated daemon attach `mode user-background`, daemon survives UI close, reinstall, uninstall, data preserved) | — | 0 (host probe) |
| 11 | Cross-version upgrade `3.0.0-preview.1 → 3.2.0` (`installer-lifecycle.json`: `upgrade_install_old`, `upgrade_old_exe` then final install; `upgrade-path.json` is superseded 3.1.0 evidence) | **PASS**: old 3.0.0-preview.1 install + display version, then final 3.2.0 install/start/daemon health/uninstall | — | 0 (host probe) |
| 12 | GitHub Actions `SuWen Windows CI` (real run) | **run 40144915574 SUCCESS on `0e94843`**: Desktop job (typecheck, tests, live RPC E2E, UI DOM QA, security scan, NSIS build, SBOM, checksums, upload) + Python baseline pytest | — | 0 |

## 2. Typecheck / build / unit+integration suite

Command: `npx tsc -p tsconfig.json --noEmit` → exit 0; `npm run build` → exit 0.

`npm test` runs the compiled test suite from `dist/test/`:

- 183 tests total, 181 passed, 0 failed, **2 skipped**, wall time **28.6 s**, exit 0.
- Skip 1: Windows symlink creation `EPERM` in one research-worker test (`fs.symlink` on Windows
  without developer mode).
- Skip 2: optional legacy Python workbench dependencies are not installed on this machine.
- Covered suites: `context`, `context-async`, `daemon-integration`, `durable`, `import-service`,
  `legacy-worker`, `mcp`, `providers`, `security`, `research-worker`, `research-activity`,
  `domain-research`, `tools`, `channels`, `rsi`.

**Do not count skipped tests as passed.** No 8/24/72-hour durability test is part of `npm test`.

## 3. RPC end-to-end (`e2e-rpc.mjs --live`)

`node scripts/e2e-rpc.mjs --dist dist --live` starts the built daemon as a real detached process,
connects over its authenticated current-user named pipe, and drives **42 checks / 0 failed** (~7 s):

- `health` / `doctor` (**11 checks**) / `defaults` / project + conversation / `import.inspect` /
  `evidence` / `artifact.read` path-guard rejection / skill, MCP, channel, RSI registries /
  `research.graph` / model-gate refusal with a user-facing message / `echo` / `delay` / `cancel` /
  Python sandbox / `worker.health` / `worker.describe` / `snapshot` / clean `shutdown` exit.
- **Real public database calls** (not fixtures):
  - PubMed/Europe PMC query `CRISPR base editing` → first hit **PMID 42878939**,
    title *In-vivo CRISPR/Base-Editing "One-Shot" Therapies Targeting PCSK9.*
  - UniProt query `TP53` → first hit **Q9Y2B4 / T53G5_HUMAN**, release **2026_03**.
  Both responses are stored as durable artifacts with `sha256` inside the E2E temporary home
  (artifact payloads are not copied into the repository).

## 4. Packaged Electron smoke (real installer-unpacked app)

Command: `$env:SUWEN_SMOKE_PACKAGED=1; node scripts/electron-smoke.mjs` against
`release/win-unpacked/SuWen.exe` → exit 0, **8/8 checks**, **68 s** on the final build:

1. Electron main process spawns the detached `ELECTRON_RUN_AS_NODE` daemon and the authenticated
   named pipe becomes ready.
2. Renderer has no Node `require` (`contextIsolation` intact).
3. Model configuration is encrypted via `safeStorage`.
4. Fixture chat is streamed and committed.
5. Closing the UI keeps the daemon alive.
6. **30 s durable timer completes after UI exit**, with the start step executed once
   (`attempts=1`).
7. Reopening attaches the **same daemon** and restores task history.
8. Packaged Python research worker executes stdlib code in its sandbox (exit 0).

Artifacts (in TARGET, inspectable):

| Artifact | Size | Notes |
|---|---:|---|
| `desktop/release/smoke/work/electron-e2e-result.json` | 1,176 B | full check list, daemon pid, timer task id, runtime versions |
| `desktop/release/smoke/outputs/SuWen-preview.png` | 184,187 B | screenshot |
| `desktop/release/smoke/outputs/SuWen-tools.png` | 88,758 B | screenshot |
| `desktop/release/smoke/work/electron-e2e-profile/runtime/contexts/…/active.json` | 19 B | context pointer left by smoke run |

Explicit non-passes recorded by the smoke run:

- **Legacy Python workbench: `unavailable on this machine`** — the installed Python lacks
  `fastapi`; this is **not** a pass.
- **Live MCP step was skipped** in the packaged smoke because it is gated behind
  `SUWEN_SMOKE_LIVE=1`; live public-database coverage is provided by §3 instead.

## 5. UI QA

- `node scripts/ui-dom-qa.mjs` → **19 passed / 0 failed / 12 warnings**. Warnings are exactly the
  5 main-process bridge methods (`settings`, `login`, `reconnect`, `pythonPicker`, `support`) that
  are intentionally **not** daemon RPC methods.
- `node --check desktop/ui/app.js` → exit 0.
- `desktop/ui/actions.json` declares **144 user-visible actions**; `desktop/src/shared/contract.ts`
  declares **80 RPC methods**.
- Coverage classification (`docs/verification/ui-action-coverage.csv`): **91** actions call declared
  daemon RPC methods, **10** main-process bridge, **43** UI-only; five workspaces
  (chat/projects/tasks/tools/settings), zh/en labels, evidence panel, incremental timeline,
  stream-failure retry, import wizard, task DAG view, 7 research launchers, MCP/Skill/Channel/RSI
  panels and safeStorage credential entry for channels are present.

## 6. Python research worker (real)

- `desktop/worker/research_worker.py` **v2.0.0**, protocol `suwen-research-worker/2`, pure stdlib.
- Tests: 22 / 21 pass / 1 skip (Windows symlink `EPERM`).
- Real measurements on `omicslab/data/demo.fcs` (120,811 B, FCS 3.1, `$PAR=5`, 6,000 events,
  channels FSC-A/SSC-A/FL1-A/FL2-A/FL3-A):
  - means FSC-A **50357.318211**, SSC-A **30390.826209**, FL1-A **734.915157**,
    FL2-A **363.630725**, FL3-A **788.096841**
  - Otsu gate counts **3199 / 1979 / 1612 / 653 / 1279**
- `runScript` executes Python inside a per-run sandbox with timeouts, output caps, environment
  allowlist and returned file digests; sandbox files are committed as durable artifacts.

## 7. Installer / lifecycle (see release doc for full detail)

- Final build measured in TARGET: `desktop/release/SuWen-Setup-3.2.0-win-x64.exe`,
  **129,447,101 bytes**, SHA-256
  `4590b7f3c38041985eb31f56047e4c35fcf0b2286fe6e989f55f736cb230b897`, built
  `2026-10-24T19:16:10Z` from frozen final code, **UNSIGNED** (no code-signing certificate;
  SmartScreen warning expected). Earlier preview/3.1.0 builds are superseded and are not reported as
  the delivered artifact.
- Unpacked `release/win-unpacked/SuWen.exe` **249,801,728 bytes**, SHA-256
  `8f7eaf76feb66a61e51d5f8b9b67eefa375fedd0018a5566d64c27f0570a22e1`.
- **Final-artifact host lifecycle probe PASSED (12/12)** — artifact
  `docs/verification/artifacts/installer-lifecycle.json` (installer sha256
  `4590B7F3…`): silent install exit 0, installed exe 249,801,728 B, uninstaller present,
  HKCU uninstall `SuWen 3.2.0`, FileVersion 3.2.0 / ProductVersion 3.2.0.0 / ProductName SuWen,
  installed app running after 12 s, authenticated named-pipe daemon health version 3.2.0
  mode `user-background`, daemon survives closing the UI, same-version reinstall exit 0, silent
  uninstall exit 0, install dir removed, user data preserved, registry entry removed.
- **Cross-version upgrade `3.0.0-preview.1 → 3.2.0` PASSED** — artifact
  `docs/verification/artifacts/installer-lifecycle.json`: upgrade source 3.0.0-preview.1 installs
  (registry + FileVersion 3.0.0-preview.1), then final 3.2.0 install/start/daemon health/uninstall
  PASS; `upgrade-path.json` (`2026-10-24T17:46:42Z`, 3.1.0) is historical/superseded.
  Only that upgrade path was tested (no other release line exists).
- Environment caveat (not a product defect): the developer shell inherits `ELECTRON_RUN_AS_NODE=1`
  from the DSH parent process, making Electron executables exit as Node; probes remove it from the
  launching shell only and the shipped app is not modified.
- **Clean-VM install/upgrade/uninstall is NOT RUN** and remains PENDING_LEAD; the host has Node,
  Python, prior SuWen data and dev installs, so no result here is a clean-machine verification.

## 8. Chaos (pointer)

Short-window real fault injection is recorded separately in
[`durability-chaos-tests.md`](./durability-chaos-tests.md) and
`docs/verification/chaos-results.json` (final artifact from the Lead, finished
`2026-10-24T17:34:35.821Z`: **12/12 checks passed, `result: passed`, 51.4 s** — s1 python-worker
SIGKILL retry (attempts 2, 15,173 ms, 1 artifact); s2 daemon SIGKILL mid-python restored (attempts 2,
same operationId, 1 artifact, 26,508 ms); s3 committed steps not replayed; s4 cancel → 0 artifacts;
s5 provider 429→500→200, 3 requests, 2 human approvals, completed). Limits recorded in that artifact
and in `durability-chaos-tests.md`: short-window single Windows session; **no 8h/24h/72h soak, no
sleep/hibernate, power loss, OS reboot or disk-full test**; provider faults are injected by a local
HTTP fixture, not a real vendor account. No endurance claim is made. An **accelerated multi-hour
soak** (`scripts/durability-soak.mjs`, repeated kill/recover cycles in one Windows session) is
recorded separately in `durability-soak.json` and does **not** substitute for the 8/24/72 h runs.

## 9. NOT RUN / unproven (must remain explicit)

1. 8 / 24 / 72-hour endurance, reboot, sleep/hibernate, power loss, disk-full.
2. Clean-Windows-VM install/upgrade/uninstall lifecycle: host lifecycle 12/12 passed
   on the final 3.2.0 artifact (including installing 3.0.0-preview.1 and upgrading), but **no clean-VM run** exists (PENDING_LEAD).
3. Real external model accounts (OpenAI-compatible/Anthropic protocols proven against local HTTP
   fixtures only; no paid vendor account success claimed).
4. Code signing / SmartScreen trust (installer unsigned).
5. GitHub Actions Windows CI: **now executed** — run 40144915574 SUCCESS on `0e94843`; the CI-built
   installer is not downloaded back to this host for a second lifecycle run.
6. Live MCP inside packaged smoke (`SUWEN_SMOKE_LIVE` unset) — covered by §3 live RPC instead.
7. macOS/Linux desktop builds, remote workers/Temporal, OS-level CPU/memory/disk quotas.
8. 23 legacy scientific skills inside the new desktop registry (preserved only in bundled
   `resources/legacy`).
9. Two unit tests skipped (Windows symlink EPERM; optional legacy Python deps missing).
10. Clean-Windows-VM lifecycle, code signing, 8/24/72 h endurance and real vendor model accounts
    remain open (see `docs/release/release-gates.md`).

## 10. Reproduction

```powershell
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
npx tsc -p tsconfig.json --noEmit
npm run build
npm test
node scripts/e2e-rpc.mjs --dist dist --live
$env:SUWEN_SMOKE_PACKAGED=1; node scripts/electron-smoke.mjs
node scripts/ui-dom-qa.mjs
node --check ui/app.js
node scripts/verify-doc-hashes.mjs
npm run dist:win
Get-FileHash release\SuWen-Setup-3.2.0-win-x64.exe -Algorithm SHA256
```

## 12. GitHub Actions (real execution)

The committed workflow `.github/workflows/suwen-windows.yml` runs on GitHub-hosted Windows runners:

- **run 40144915574** (commit `0e94843`, 2026-10-25): **SUCCESS** — both jobs green.
- Desktop job: `npx tsc --noEmit`, `npm test`, live `e2e-rpc --live`, `ui-dom-qa`,
  `verify-doc-hashes`, security scan (0 unresolved HIGH), NSIS build (unsigned), CycloneDX SBOM,
  SHA256SUMS, artifact upload.
- Python baseline job: installs `pyproject.toml` + dev deps and runs the legacy pytest suite
  (offline, mock provider, isolated home).
- Earlier real failures were **fixed, not hidden**: (1) worker health test assumed numpy/scipy are
  strings on a runner without them → now tolerates `null`/`string`; (2) the secret scanner flagged
  scoped e2e fixture tokens → scanner now accepts the documented fixture allowlist.
- A CI build is **not** claimed to be install-verified; the host lifecycle probe in §7 used the local
  final artifact with the same commit.

## 11. Requirement mapping

| Requirement | Evidence in this document |
|---|---|
| R110 long chat/cancel/recover/history | §2 unit/integration; §4 packaged streamed chat + reopen restore |
| R111 two provider adapters | §2 providers suite (local HTTP fixtures); external accounts NOT RUN |
| R112 PubMed + gene/protein DB real calls | §3 Europe PMC PMID 42878939 + UniProt Q9Y2B4 (release 2026_03) |
| R113 Paper2Agent | **NOT RUN** — external pipeline not bundled |
| R114 analysis sandbox reproducible | §6 worker sandbox + demo.fcs metrics |
| R115 debate auditable | §3 research rows + typed debate records |
| R116 long-run background/recovery | §4 30 s timer after UI exit, same-daemon reopen; crash SIGKILL in chaos doc; reboot NOT RUN |
| R117 compaction restart retention | §2 context suites; ten-round compaction evidence |
| R118 security denials | §3 artifact path-guard rejection + §5 IPC/CSP checks; full OS sandbox NOT implemented |
| R119 clean Windows install/start/upgrade/uninstall | **host lifecycle probe partial (§7); clean-VM NOT RUN** |
| R120 machine-readable reports | this file + master CSV, parity matrix, UI coverage, chaos, dependencies, installer docs |
| R121 final delivery package | installer + hashes + test commands present; clean-VM lifecycle and signing pending |
