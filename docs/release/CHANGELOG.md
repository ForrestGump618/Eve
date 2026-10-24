# Changelog — SuWen Desktop (vNext)

This file tracks the Electron/TS desktop (`desktop/`) releases. The preserved Python platform has its
own project history in the repository-root `CHANGELOG.md`; it is not part of the desktop semantic
versioning.

## [Unreleased] — 3.2.0 (release candidate, NOT yet built/published)

Round-3 convergence work. Every entry names the evidence; anything not verified is marked.

### Added

- Typed streaming event pipeline: `desktop/src/stream-events.ts` maps persisted durable events to the
  versioned wire protocol (`StreamEnvelope` v1: eventId/sequence/taskId/stepId/type/sourceType/at/payload),
  exposed as the `events.stream` RPC (cursor/reset/tasks/streams). Contract in
  `desktop/src/shared/contract.ts`; daemon dispatch at `desktop/src/daemon.ts:194`; unit test
  `desktop/test/stream-events.test.ts`.
- Main-process event bridge: `desktop/src/main.ts` polls `events.stream` with a cursor and forwards
  incremental batches to the renderer; preload exposes frozen `onEvent`/`onConnection` subscriptions
- Renderer recovery bridge: `events.stream` stays main-process-only; gap replay is the main bridge
  `window.suwen.call('events.replay', {since, limit})`; daemon auto-reconnect uses bounded backoff
  (300 ms…12 s), re-pushes the encrypted model config + safeStorage credential refs, and reports
  `onConnection` states `reconnecting|restored|lost`.
  (`desktop/src/preload.cts`).
- Round-3 verification tooling (docs-audit, uncommitted): `desktop/scripts/security-scan.mjs`
  (working-tree + 13-commit history scan, documented fixture allowlist) and
  `desktop/scripts/performance-baseline.mjs` (daemon/RPC/worker baseline, `--out` JSON).
- Release documentation set: `docs/release/release-gates.md`, `docs/release/final-acceptance-report.md`,
  `docs/release/github-publication.md`, `docs/release/release-notes-v3.2.0.md`,
  `docs/verification/security-review.md`, `docs/verification/performance-baseline.md`,
  `docs/verification/defect-register.csv`; 13-field `docs/requirements/master-requirements.csv`
  (R001–R148); regenerated `docs/verification/ui-action-coverage.csv` (144 actions) and extended
  `docs/migration/feature-parity-matrix.csv` (85 rows).

### Changed

- `desktop/src/rpc/capabilities.ts`: six research capabilities build validated durable task DAGs;
  model-requiring templates are rejected before persistence when no model is configured.
- `desktop/src/shared/contract.ts`: RPC surface is 81 methods including `events.stream`, `secrets.*`;
  task step kinds 19.
- `desktop/ui/actions.json`: 142 audited actions across five workspaces.

### Security

- Secret/credential scan **PASS** — 0 unresolved HIGH, 18 LOW, 10 documented test fixtures
  (`docs/verification/artifacts/security-scan.json`); `.gitignore` covers `.env` and private keys;
  `npm audit --omit=dev` 0 vulnerabilities.
- Documented trust boundaries (sandboxed renderer, sender-validated IPC, CSP, safeStorage,
  authenticated named pipe, path guards) in `docs/verification/security-review.md`.

### Known limitations / not verified (do not claim otherwise)

- Streaming UI quantitative acceptance matrix (100/1,000/10,000 events, composer/scroll/markdown
  stability) — T2 work in progress; UI stability gate open.
- Full runtime click-through of all 142 UI actions; visual acceptance at 1920×1080/1366×768,
  scaling, themes, locales — pending.
- Six research capabilities real end-to-end run — pending; external Paper2Agent/Biomni/ERA/Robin/
  Kosmos integrations not bundled.
- 8/24/72 h endurance, sleep/hibernate, power loss, OS reboot, disk-full — **not run**.
- Clean-Windows-VM install/upgrade/uninstall — host probe 14/14 + upgrade 8/8 only.
- Code signing — no certificate; unsigned build, SmartScreen warning expected.
- GitHub publication — blocked (`gh` CLI/token unavailable in this environment).
- 3.2.0 installer rebuild + SHA256 — pending; the 3.1.0 artefact numbers are superseded once rebuilt.

## [3.1.0] — 2026-10-24

- Full desktop takeover: Electron + TypeScript desktop with independent harness daemon, SQLite WAL
  durable store, typed RPC, five workspaces, bilingual UI, detached background execution and named-pipe
  authentication.
- Durable harness: task DAG, leases/fencing/heartbeat, checkpoints, outbox/idempotency, retry and
  cancellation; short-window chaos 12/12 checks in 52.2 s.
- Context manager: independent compaction service, raw-log hash chain, structured summaries with
  source/artifact refs, version rollback; 10-round compaction test passed.
- Research/extension surface: six research capability DAG builders, MCP/Skill/Channel/RSI registries,
  Python research worker protocol `suwen-research-worker/2`.
- Packaging: unsigned Windows x64 NSIS installer `SuWen-Setup-3.1.0-win-x64.exe`
  (129,425,145 B, SHA256 `E1A1062C…`), host lifecycle 14/14, upgrade 8/8, checksums generated.
- Verification: `npm test` 150 tests / 148 pass / 2 skipped / 0 fail (29.5 s); RPC E2E 42/0 incl. real
  Europe PMC/UniProt calls; packaged Electron smoke 8/8; UI DOM QA 19/0/12.

## [3.0.0-preview.1] — 2026-10-24

- First installable preview: five workspaces, streaming chat, task records, model settings/
  diagnostics, detached daemon with named-pipe auth, SQLite WAL, DAG/lease/checkpoint, artifact
  hashes, cancel/pause/resume, context compaction P0, bilingual UI.
- Verified scope was a P0 slice (48 desktop tests, 10 packaged E2E checks, local HTTP provider
  fixtures, real public-DB MCP calls); no endurance, no clean-VM install, unsigned installer.

## [2.1.1] — preserved Python platform

- Legacy Python/FastAPI platform (Apache-2.0) is preserved read-only for compatibility and import.
  See repository-root `CHANGELOG.md` and `docs/SUWEN-V2-GUIDE.md`; it is not rebuilt as part of the
  desktop release except as the bundled compatibility source.


## [3.2.0] - 2026-10-25 (final evidence)

Final build measured in the TARGET workspace (evidence: `docs/verification/`, `docs/release/`).

### Added
- Typed streaming event protocol (`events.stream`, `StreamEnvelope` v1), pure-DOM reducer, safe markdown
  subset, theme system, connection banner and bounded reconnect.
- Round-3 release governance: `release-gates.md`, `final-acceptance-report.md`, `defect-register.csv`,
  security review, performance baseline, this changelog and release notes.

### Fixed (verified in this build)
- Duplicate persisted assistant messages after recovery: daemon `a-<operationId>` and renderer `uid()` merged via `conversations.ts` `(taskId, role='assistant')`; `conversations.test.ts` 4 tests; Lead persist re-run `assistants=1 taskAssistants=1`, 0 findings (desktop/release/smoke/ui-streaming-20261024-192807-final.json).
- Failed-turn chat error surface: `#chat-notice` with localized `chatTaskFailed`, cleared on next send (waiting_approval reconciliation notice + failed-step notice; static QA pass, then T2 visual re-verification PASS — reports ui-visual-audit-20261024-194627/194718/194944.json, zh len 106/en len 159).
- Auto-reconnect after daemon SIGKILL PASS 3/3 runs (offline 72-520 ms, restored 702-779 ms, 0 reloads).

- RPC E2E harness, missing activity-handler registration, UI↔backend RPC method sync, worker-bridge timing,
  provider prompt delivery, stream text/render duplication, follow-loop scroll jump, RSI run error path,
  Chinese mojibake in RPC strings.
- Duplicate conversation append on reconnect + missing auto-reconnect after daemon SIGKILL: source fixes
  landed with `conversations.test.ts` coverage; T2 in-Electron re-run pending (tracked in defect register).

### Verified
- `npx tsc --noEmit` exit 0; `npm run build` exit 0; full suite 150 tests / 148 pass / 0 fail / 2 skipped,
  29.5 s; RPC E2E 42/0 (~7 s); packaged smoke 8/8 (68 s); UI DOM QA 19/0/12; chaos 12/12 (51.7 s);
  installer 129,447,101 B SHA256 `4590B7F3…`; host installer lifecycle 12/12 + upgrade source pass.

### Known limitations
- Installer UNSIGNED; clean-Windows-VM lifecycle NOT run; 8/24/72 h endurance, reboot and power-loss NOT run;
  real vendor accounts unavailable; GitHub publication blocked (`gh`/token absent); no OS sandbox quotas;
  external research integrations (Paper2Agent/Biomni/ERA/Robin/Kosmos) not bundled.
