# SuWen Desktop v3.2.0 — release notes (final evidence round; NOT published)

**Status: final 3.2.0 build measured — NOT published.** The final installer is
`desktop/release/SuWen-Setup-3.2.0-win-x64.exe` (**129,447,101 B**, SHA256
`4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`, **UNSIGNED**); all measured
numbers are in the "Final release evidence" section at the end of this file. Clean-Windows-VM
lifecycle, code signing, endurance (8/24/72 h, reboot, power-loss) and GitHub publication are
**NOT done** — see `docs/release/final-acceptance-report.md` and `docs/release/release-gates.md`.

## Highlights

- **Typed streaming pipeline (round-3 P0 groundwork):** durable events are exposed through
  `events.stream` (main-process-only) with a versioned envelope (`StreamEnvelope` v1) and
  cursor/replay semantics; renderer gap replay uses the main bridge
  `window.suwen.call('events.replay', {since, limit})`; the main process forwards incremental batches
  to a frozen preload API (`onEvent`, `onConnection`), auto-reconnects the daemon with bounded
  backoff (300 ms…12 s), re-pushes the encrypted model config + safeStorage credential refs, and emits
  `onConnection({state:'reconnecting'|'restored'|'lost'})`.
  Runtime UI acceptance for composer/scroll/markdown stability is still being completed by the
  streaming/UI owners — see gate G3.
- **Verification and release engineering:** automated secret/credential scan (PASS), performance
  baseline (daemon/RPC/Python worker), 13-field requirement matrix (R001–R148), regenerated UI action
  coverage (144 actions), 9 release gates, defect register, GitHub publication runbook.
- **Research/extension surface from 3.1.0 preserved:** six research capability DAGs, MCP/Skill/
  Channel/RSI registries, Python research worker `suwen-research-worker/2`, durable harness with
  recovery, context versioning, legacy non-destructive import.

## Verification summary (measured, host only)

| Check | Result |
| --- | --- |
| TypeScript typecheck / build | exit 0 (Lead, 2026-10-25) |
| Unit/integration tests | 182 tests / 180 pass / 0 fail / 2 skipped / 33.4 s (Lead, final build) |
| RPC E2E (real detached daemon, live public DBs) | 42 passed / 0 failed / ~7 s, incl. Europe PMC PMID 42878939 and UniProt Q9Y2B4 release 2026_03 |
| Packaged Electron smoke | 8/8 checks, exit 0 (final 3.2.0 build) |
| UI DOM QA | 19 passed / 0 failed / 12 warnings (main-process bridge methods) |
| Short-window chaos | 12/12 checks in 51.7 s |
| Installer host lifecycle | host 12/12 PASS on the final 3.2.0 artifact + upgrade source 3.0.0-preview.1 installed (clean VM NOT RUN) |
| Secret scan / npm audit | PASS (0 HIGH), 0 production vulnerabilities |
| Performance baseline | daemon ready p50 391 ms, create p50 0.82 ms, events.stream p50 1.49 ms, worker flowSummary 20.9 ms |

## Installer (measured (see Final release evidence))

| Field | Value |
| --- | --- |
| Path | `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` (built 2026-10-24T19:16:10Z) |
| Version | 3.2.0 — confirmed in `desktop/package.json:3`, package-lock root and the built installer metadata |
| Size / SHA256 | 129,447,101 B / `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897` |
| Signature | UNSIGNED — no code-signing certificate; SmartScreen warning expected. Never claim signed. |
| Checksums | `desktop/release/SHA256SUMS` mirrored in `docs/release/SHA256SUMS.txt` (3 lines, same values) |
| Upgrade path | from 3.1.0 (previous cross-version 3.0.0-preview.1→3.1.0 passed 8/8 on host; 3.2.0 path not yet run) |

## Known issues and limits (must be repeated in announcements)

1. Streaming UI stability has no quantitative matrix yet (G3 open).
2. Full per-action runtime click-through is not done; static mapping (144 actions) + DOM QA + a 180-screenshot visual audit exist (G4 host-scoped).
3. Six research capabilities are evidenced by T3 end-to-end runs (deterministic 19 pass / 3 live-gated skips; live 21/21); hosted third-party integrations remain unbundled (G5 host-scoped).
4. Long-run endurance (8/24/72 h, reboot, power loss) was **not** executed (G6).
5. Clean-Windows-VM install/upgrade/uninstall was **not** executed (G8); only a host probe.
6. The installer is unsigned and the GitHub Release is not published (G9 blocked: no `gh`/token).
7. Optional Python workbench is unavailable on this machine (missing `fastapi`); core chat/MCP work
   without Python.
8. External integrations (Paper2Agent, Biomni, ERA, Robin, Kosmos) are not bundled; 23 legacy skills
   are preserved under `resources/legacy` but not migrated into the new registry.
9. No OS-level sandbox/quotas; provider protocols verified against local HTTP fixtures only (no real
   vendor accounts).

## Upgrade notes

- Installs in place over a 3.1.0 installation (NSIS per-user, `allowToChangeInstallationDirectory`,
  user data preserved on uninstall unless explicitly cleared).
- Legacy `.omicslab` data is **read-only** for the app; migration is explicit (backup-first,
  idempotent, rollback supported) through the import wizard or `import.*` RPC.
- Keep the 3.1.0 installer + `SHA256SUMS` until the 3.2.0 artefact is independently verified.

## Links (fill after publication)

- Repository: `https://github.com/ForrestGump618/suwen.git`
- Release/tag: **NOT published** (no `gh`/token) · Installer asset URL: none (publication blocked; see `github-publication.md`)


## Final release evidence (3.2.0 build, 2026-10-25)

This section supersedes the earlier placeholder language above. All values below were measured
on the final 3.2.0 build in the TARGET workspace; where something was not run it is marked NOT RUN.

| Item | Measured value |
|---|---|
| Installer | `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — **129,447,101 B** — SHA256 `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897` — built 2026-10-24T19:16:10Z — **UNSIGNED** (no certificate; SmartScreen warning expected) |
| Blockmap | 135,948 B — SHA256 `283B27E19D2A943DD940B8E83F748CEB2627950A87CAD509069EFAE4230CBB72` |
| Unpacked app | `release/win-unpacked/SuWen.exe` — 249,801,728 B — SHA256 `8F7EAF76FEB66A61E51D5F8B9B67EEFA375FEDD0018A5566D64C27F0570A22E1` |
| Checksums | `desktop/release/SHA256SUMS` and `docs/release/SHA256SUMS.txt` (3 lines, same values) |
| Typecheck/build | `npx tsc -p tsconfig.json --noEmit` exit 0; `npm run build` exit 0 |
| Full test suite | **182 tests / 180 pass / 0 fail / 2 skipped**, 33.4 s, exit 0 (skips: Windows symlink privilege; optional legacy Python workbench deps) |
| RPC E2E | `node scripts/e2e-rpc.mjs --dist dist --live` — **42 passed / 0 failed**, ~7 s, real detached daemon over authenticated named pipe; live Europe PMC/PubMed (PMID 42878939) and UniProt (Q9Y2B4, release 2026_03) artifacts with sha256 |
| Packaged Electron smoke | **8/8 checks**, exit 0, 68 s on the final build |
| UI DOM QA | 19 passed / 0 failed / 12 warnings (warnings are the intended main-process bridge methods) |
| Streaming UI E2E | Deterministic local-fixture suite: 22 cases — 19 pass / 0 fail / 3 skip, 10.8 s; 100/1,000/10,000-delta integrity via exact DOM sha256; composer 0 px deviation; scroll 0 px forced drift |
| Functional/live E2E | Deterministic 19 pass / 0 fail / 3 skip; live 21/21, 13.7 s (real daemon + real public databases) |
| Chaos | 12/12 scenarios, 51.7 s (worker/daemon SIGKILL, idempotent operation id, committed step not replayed, cancel, provider 429→500→200 with human approvals) |
| Installer lifecycle | 12/12 host steps on the final artifact (silent install/reinstall/uninstall, installed app daemon, daemon survives UI close, data preserved, registry removed); upgrade source 3.0.0-preview.1 installed OK |
| Clean Windows VM | **NOT RUN** — host probe only |
| Endurance 8/24/72 h, reboot, power-loss | **NOT RUN** |
| GitHub publication | **BLOCKED_EXTERNAL** — `gh` absent, no token; release tag `suwen-vnext-3.2.0` commands documented, not executed |

Known limits: unsigned installer; no clean-VM lifecycle; no endurance/reboot/power-loss run;
real vendor model accounts unavailable (local HTTP fixtures); legacy Python workbench unavailable on
this host (missing `fastapi`); 2 skipped unit tests (environment); visual auto-acceptance report
(`ui-visual-audit.md`) and the T2 post-fix SIGKILL/reconnect re-run were not published before this
doc pass — those two items remain UNVERIFIED.


## Post-final T2 corrections (2026-10-25)

Applied after the initial final evidence report (Lead-measured; T2 final report):

- **P1 duplicate persisted assistant messages after recovery — RESOLVED.** The daemon id
  `a-<operationId>` and the renderer recovery id could both persist an assistant turn;
  `desktop/src/conversations.ts` now merges assistant turns by `(taskId, role='assistant')` in
  addition to message-id idempotency (`desktop/test/conversations.test.ts`, 4 tests). Lead re-ran the
  T2 harness `node scripts/streaming-ui-e2e.mjs --mode=final --only=persist --runs=1` ->
  `assistants=1 taskAssistants=1`, 0 findings (`desktop/release/smoke/ui-streaming-20261024-192807-final.json`).
- **Auto-reconnect after daemon SIGKILL — PASS 3/3 runs:** offline surfaced 72-520 ms, auto-restored
  702-779 ms without page reload, settings `#reconnect` 49-57 ms, 0 page reloads; interrupted tasks land
  in the designed `waiting_approval` reconciliation and retry recovered the exact text.
- **P2 failed-turn error surface — FIXED and T2-verified:** `desktop/ui/app.js` shows `#chat-notice` for the waiting_approval reconciliation path (localized `chatTaskNeedsReview`) and for failed steps (`chatTaskFailed`), and clears a stale review notice after a successful retry. T2 visual re-verification PASS on the deterministic provider-HTTP-500 fixture: `#chat-notice` visible, zh len 106 / en len 159, `selectedTask.status=waiting_approval`; lifecycle guard clears after approval-retry success; reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…).
- Fixture-only provider (deterministic local OpenAI-SSE): no real vendor APIs are claimed.
