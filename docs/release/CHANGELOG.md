# Changelog — SuWen Desktop (vNext)

This file tracks the Electron/TypeScript desktop (`desktop/`) releases. The preserved Python platform
has its own project history in the repository-root `CHANGELOG.md`; it is not part of desktop semantic
versioning.

## [3.3.0] - 2026-10-25

### Added
- Sixth native workspace page **实验工作台 / Workbench** hosting the existing SuWen web SPA in an
  isolated Electron window with a managed on-demand Python runtime (13 pinned deps, marker+probe
  validation, cancelable ~130 MB install, per-window bearer auth, request-time CSP, config injection).
- Progressive streaming markdown with offline KaTeX + Mermaid, closed-block typesetting and a plain
  `.md-stream-tail` for open constructs.
- Requirement rows R149-R152 (hosted parity, managed runtime, config injection, 3.3.0 docs).

### Changed
- Version 3.3.0 (package.json/lock, native footer).
- Native shell CSP `style-src` now allows inline styles required by the vendored math/diagram
  renderers; `script-src` remains `self`, `connect-src` remains `none` (documented trade-off in
  `docs/verification/security-review.md`).

### Verified
- Full suite 222/220/0/2; RPC E2E live 42/42; hosted workbench E2E 34/34; runtime smoke 27/27;
  config injection 13/13; markdown unit 32/32; chaos 12/12; packaged smoke passed; lifecycle 12/12
  incl. 3.0.0-preview.1 upgrade; installer 0B55D5BDFBA86C6C... (UNSIGNED).

## [Unreleased] — post-3.2.0 hardening (2026-10-25)

### CI / repository
- **GitHub Actions now executes for real.** The tracked workflow `.github/workflows/suwen-windows.yml`
  runs on pushes to `suwen-vnext-durable`: Python baseline pytest (Windows), then Node typecheck, full
  `npm test`, RPC E2E against a real detached daemon with live public databases, UI DOM QA, secret
  scan, NSIS installer build, CycloneDX SBOM, SHA256SUMS and artifact upload.
  Run history and fixes:
  - run 1 (`8646fd7`) failed in unit tests: `desktop/test/research-worker.test.ts` expected string
    `health.deps.numpy`, but the GitHub runner has no numpy and the worker reports `null`;
    fixed by accepting `null | string` for optional `numpy`/`scipy` deps (`9132ec1`).
  - run 2 (`8741d47`) passed steps 1–8 (typecheck, tests, live RPC E2E, UI DOM QA) and failed the
    secret scan: two deterministic E2E fixture literals in `desktop/scripts/e2e-research.mjs`
    (`sk-legacy-e2e-sentinel-…`, `fixture-key-not-a-real-credential`) were classified HIGH.
    Fixed by extending the documented test-fixture allowlist to `desktop/scripts/e2e-*.mjs` plus
    `sentinel|not-a-real|e2e-` fixture tokens (narrowly scoped; findings stay printed and listed).
  - **run 40145676187 (`9041901`, 2026-10-25): SUCCESS** — both jobs green (Desktop Node job and
    Python baseline). This is the first verified green CI run for the vNext desktop; see
    `docs/verification/integration-and-e2e.md` §12.
- Added `desktop/scripts/verify-doc-hashes.mjs` and a CI step: every current artifact hash must be
  quoted in the release evidence, no stale full hash may remain, and
  `docs/release/SHA256SUMS.txt` must mirror `desktop/release/SHA256SUMS`. Local run: PASS.
- Local re-run of the scanner after the fix: **PASS — 0 HIGH / 192 LOW / 20 documented test fixtures**
  (`docs/verification/artifacts/security-scan.json`).

### Added
- `desktop/scripts/durability-soak.mjs`: real fault-injection soak harness (actual daemon over the
  authenticated named pipe; repeated durable tasks; `python-worker-kill`, `daemon-kill` and `cancel`
  faults every N cycles; recovery assertions; JSON evidence at
  `docs/verification/durability-soak.json`). **Executed run (2026-10-25): 25 min / 1500 s,
  64 cycles / 64 tasks completed, 12 faults / 12 recovered, 0 errors, `result: passed`.**
  This is an **accelerated soak**, not the 8/24/72 h endurance run, and is labelled as such.

### Fixed
- Optional Python dependency assertions in `desktop/test/research-worker.test.ts` no longer assume
  numpy/scipy are installed (CI and minimal hosts report `null`).
- Secret scanner fixture allowlist no longer flags deterministic E2E fixture credentials; the
  findings remain visible under `acceptedTestFixtureFindings` and are documented in
  `docs/verification/security-review.md`.

## [3.2.0] — 2026-10-25 (built and host-verified; NOT published — release gates HOLD)

Final build measured in the TARGET workspace; evidence under `docs/verification/` and `docs/release/`.

### Artifacts (unsigned)
- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — 129,447,101 B, SHA256
  `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`.
- `desktop/release/win-unpacked/SuWen.exe` — 249,801,728 B, SHA256
  `8F7EAF76FEB66A61E51D5F8B9B67EEFA375FEDD0018A5566D64C27F0570A22E1`.
- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap` — 135,948 B, SHA256
  `283B27E19D2A943DD940B8E83F748CEB2627950A87CAD509069EFAE4230CBB72`.
- `desktop/release/SHA256SUMS` == `docs/release/SHA256SUMS.txt` (3 lines).

### Added
- Typed streaming event protocol: `events.stream` RPC, `StreamEnvelope` v1
  (eventId/sequence/taskId/stepId/type/sourceType/at/payload), main-process 100 ms pump, preload
  `onEvent`/`onConnection`, gap replay via main bridge `events.replay`, 2.5 s snapshot fallback.
- Renderer streaming: DOM-free reducer `ui/stream-core.js` (global sequence, 10k LRU event-id dedupe,
  bounded replay, UTF-16 suffix-safe append, terminal immutability, run state machine), safe markdown
  subset `ui/markdown.js` (raw HTML inert, LaTeX/Mermaid labelled code fallback), theme system,
  connection banner, per-conversation drafts, `#jump-latest`, copy-code.
- Round-3 governance docs: `release-gates.md`, `final-acceptance-report.md`, `defect-register.csv`,
  `security-review.md`, `performance-baseline.md`, `ui-streaming-stability.md`, `ui-e2e.md`,
  `ui-visual-audit.md`, `e2e-results.md`, 13-field `master-requirements.csv` (R001–R148), 85-row
  feature-parity matrix, 144-action UI coverage, GitHub publication runbook.

### Fixed
- Duplicate persisted assistant turns after daemon recovery (different ids from daemon
  `a-<operationId>` and renderer `uid()`): `conversations.ts` is now idempotent by message id and
  merges assistant turns by `(taskId, role='assistant')`; `conversations.test.ts` covers both;
  in-Electron re-run `assistants=1 taskAssistants=1`, 0 findings.
- Failed/interrupted chat turns now surface `#chat-notice` (localized `chatTaskFailed`), cleared on
  next send; covers failed-step notice and `waiting_approval` reconciliation notice.
- Auto-reconnect after daemon SIGKILL: `pumpEvents` clears the stale connection and schedules bounded
  backoff (300 ms…12 s), re-pushes model config and encrypted credential refs, emits
  `onConnection reconnecting|restored`; T2 Electron runs PASS 3/3 (offline 72–520 ms, restored
  702–779 ms, 0 reloads).
- Follow-loop scroll jumping, provider prompt delivery, stream duplication, RPC/daemon shape drift,
  RSI run path, D1–D7 research/tool defects, Chinese mojibake in an RPC string.

### Verified (host)
- `npx tsc --noEmit` 0; `npm run build` 0; full `npm test` 183 tests / 181 pass / 0 fail / 2 skipped
  (skips: Windows symlink EPERM, optional legacy Python deps) 29.6 s.
- RPC E2E against real detached daemon: 42/42 incl. live Europe PMC/PubMed and UniProt release 2026_03;
  six research capabilities deterministic 22 cases (19 PASS/0 FAIL/3 live-gated skips) and live 21/21.
- Packaged Electron smoke 8/8 (106 s); streaming UI matrix 100/1,000/10,000 deltas; visual audit 180
  PNGs / 9 states × zh-en × light-dark × 5 size/DSF combos, 0 layout findings.
- Chaos 12/12 (51.7 s, single Windows session); accelerated durability soak (see Unreleased).
- Host installer lifecycle 12/12 on the final installer (silent install, registry, version metadata,
  daemon survives UI close, reinstall, uninstall, user data preserved) + upgrade from 3.0.0-preview.1.

### Known limitations (do not claim otherwise)
- Installer **UNSIGNED** (no certificate; SmartScreen warning expected).
- Clean-Windows-VM lifecycle **NOT run**; 8/24/72 h endurance, sleep/hibernate, power loss, OS reboot
  and disk-full **NOT run** (accelerated soak only, single host/session).
- Real vendor model accounts unavailable (deterministic local OpenAI-compatible fixture used instead).
- GitHub Release publication **not performed**: gates HOLD and `gh` CLI/token absent; source branch +
  tag `suwen-vnext-3.2.0` are pushed and CI runs (see Unreleased).
- No OS-level CPU/memory/disk quotas; no penetration test; legacy Python workbench unavailable on the
  build host (missing fastapi) so its UI is documented as unavailable, not verified.
- External Paper2Agent/Biomni/ERA/Robin/Kosmos stacks are not bundled; their capability patterns are
  implemented natively.

## [3.1.0] — 2026-10-24

- Full desktop takeover: Electron + TypeScript desktop with independent harness daemon, SQLite WAL
  durable store, typed RPC, five workspaces, bilingual UI, detached background execution and
  named-pipe authentication.
- Durable harness: task DAG, leases/fencing/heartbeat, checkpoints, outbox/idempotency, retry and
  cancellation; short-window chaos 12/12 checks in 52.2 s.
- Context manager: independent compaction service, raw-log hash chain, structured summaries with
  source/artifact refs, version rollback; 10-round compaction test passed.
- Research/extension surface: six research capability DAG builders, MCP/Skill/Channel/RSI registries,
  Python research worker protocol `suwen-research-worker/2`.
- Packaging: unsigned Windows x64 NSIS installer `SuWen-Setup-3.1.0-win-x64.exe`
  (129,425,145 B, SHA256 `E1A1062C…`), host lifecycle 14/14, upgrade 8/8, checksums generated.
- Verification: `npm test` 150 tests / 148 pass / 2 skipped / 0 fail; RPC E2E 42/0 incl. real
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
