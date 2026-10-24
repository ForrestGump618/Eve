# Final acceptance report — SuWen Desktop vNext 3.2.0 (final evidence round)

Status: **FINAL EVIDENCE ROUND — NOT PUBLISHED**. All values below are measured on disk in TARGET
`C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext` (branch `suwen-vnext-durable`,
2026-10-25) unless marked `NOT RUN` / `UNVERIFIED` / `BLOCKED_EXTERNAL`. This report does **not**
authorise a stable/public release: see `release-gates.md` (decision: HOLD — not published).

Repository: `desktop-vnext` · branch `suwen-vnext-durable` · HEAD `0024e73` ("SuWen 3.1.0: full
desktop takeover, durable harness and Windows release") · remote
`https://github.com/ForrestGump618/suwen.git` (readable; `gh` CLI absent).

## A. Project & GitHub

| Item | Value |
| --- | --- |
| Local repo / branch / commit | `desktop-vnext` / `suwen-vnext-durable` / `0024e73` |
| Upstream state | remote reachable (`git ls-remote` OK); push of this worktree not performed |
| MIT status | `desktop/LICENSE` MIT (self-authored desktop); `NOTICE`; third-party licenses + CycloneDX SBOM; Python baseline preserved Apache-2.0 with original NOTICE |
| CI status | `.github/workflows/suwen-windows.yml` authored (typecheck/build/tests/e2e-rpc/ui-dom-qa/security-scan/SBOM/NSIS+SHA256SUMS); **never executed** |
| Release tag | **not created** — tag `suwen-vnext-3.2.0` documented in `github-publication.md`, not pushed |
| Repo / Release URL | none published — G9 **BLOCKED_EXTERNAL** (`gh` absent / no token) |
| Publication scan | `security-scan.mjs` PASS (0 HIGH / 18 LOW / 10 documented test fixtures); no real secret found in tracked tree/history |

## B. Windows installer

| Item | Value |
| --- | --- |
| Installer (delivered) | `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — **129,447,101 B** — SHA256 **`4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`** — built 2026-10-24T19:16:10Z — **UNSIGNED** (no certificate; SmartScreen warning expected) |
| Blockmap | `SuWen-Setup-3.2.0-win-x64.exe.blockmap` — 135,948 B — SHA256 `283B27E19D2A943DD940B8E83F748CEB2627950A87CAD509069EFAE4230CBB72` |
| Unpacked app | `release/win-unpacked/SuWen.exe` — 249,801,728 B — SHA256 `8F7EAF76FEB66A61E51D5F8B9B67EEFA375FEDD0018A5566D64C27F0570A22E1` |
| Checksums | `desktop/release/SHA256SUMS` + committed mirror `docs/release/SHA256SUMS.txt` (3 lines, identical) |
| Package version | 3.2.0 (`desktop/package.json`, package-lock root) |
| Package layout | `resources/app/{dist,node_modules,package.json,LICENSE,NOTICE,third-party-licenses}`, `resources/worker/research_worker.py`, `resources/legacy/**` (Apache-2.0 sources, optional compatibility mode), `elevate.exe` |
| Install / lifecycle | **12/12 host steps PASS** on the final artifact (`docs/verification/artifacts/installer-lifecycle.json`): silent install exit 0 (~24 s), installed exe + FileVersion/ProductVersion 3.2.0, HKCU `SuWen 3.2.0`, app running after 12 s, authenticated named-pipe daemon health version 3.2.0 mode `user-background`, daemon survives closing the installed UI, same-version reinstall, silent uninstall exit 0, install dir removed, user data preserved, registry removed; upgrade source installed 3.0.0-preview.1 PASS |
| Clean Windows VM | **NOT RUN** — host probe only; no VM/snapshot available |
| Endurance | **NOT RUN** — no 8/24/72 h, sleep/hibernate, power-loss, reboot, disk-full |
| Signing / SmartScreen | honest disclosure: unsigned, no certificate, warning expected; no signing claim |
| Python runtime | installer does **not** ship Python; basic chat/MCP works without it, optional worker needs a user-selected interpreter (R101 NOT_STARTED) |

## C. UI/UX

| Item | Evidence |
| --- | --- |
| Five workspaces / interactions | `desktop/ui/actions.json` **144 actions**; `docs/verification/ui-action-coverage.csv` 144 rows — 91 WIRED_DAEMON_RPC / 10 WIRED_MAIN_PROCESS / 43 WIRED_UI_ONLY / **0 unknown methods** |
| UI DOM QA | `node scripts/ui-dom-qa.mjs`: **19 passed / 0 failed / 12 warnings** (warnings = intentional main-process bridge methods); `node --check desktop/ui/app.js` exit 0 |
| Streaming UI stability (T2) | `docs/verification/ui-e2e.md`: deterministic local-fixture suite **22 cases — 19 pass / 0 fail / 3 skip**, 10.8 s; 100 / 1,000 / 10,000-delta text integrity via exact DOM sha256; composer deviation **0 px**; scroll forced drift **0 px** (follow re-armed only by user intent); two concurrent runs no cross-contamination; 120-message conversation render 249 ms; layouts 1920×1080 (host-clamped), 1366×768, 980×680 × zh/en × five workspaces; dark theme implemented |
| Streaming defects | D-006 duplicate append and D-007 no-auto-reconnect were found in the T2 interim report and **fixed afterwards** in `desktop/src/main.ts` (bounded backoff 300 ms-12 s) and `desktop/src/conversations.ts` (idempotent append), with `conversations.test.ts`; T2's post-fix SIGKILL/reconnect in-UI re-run is **not yet published** (D-017) -> R130 stays UNVERIFIED |
| Visual acceptance | **PASS (host, deterministic fixture)** - `docs/verification/ui-visual-audit.md` (2026-10-25): 3 audit runs / 180 PNGs; aggregate 144-shot matrix (1920x1080@1x, 1366x768@1x/1.25x/1.5x, 980x680@1x; zh/en; light/dark) -> 0 horizontal/vertical overflow, 0 elements outside viewport, 0 overlaps, 0 page/console errors, dark theme + #defaults-theme verified; layout PASS; one P2 finding (chat-error has no visible error surface) FIXED and T2-verified after the finding (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…)) -> R136 IMPLEMENTED_PASS; P2 chat-error surface tracked as D-020 |
| i18n / brand | zh/en labels via DOM QA; brand scan 983 hits / 143 files, **0 requiring text change** (all retained identifiers documented LEGACY-BRAND-COMPAT) |

## D. Functions / parity

| Area | Status |
| --- | --- |
| Requirements | `docs/requirements/master-requirements.csv` **98 rows** (13-field schema, R001-R148): **81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL** |
| Parity | `docs/migration/feature-parity-matrix.csv` **85 rows**: 66 IMPLEMENTED_PASS / 7 UNVERIFIED / 9 NOT_STARTED / 1 N/A_PORT / 1 REPLACED / 1 BLOCKED_EXTERNAL; Python engines wrapped not ported (discovery/SSH/evidence/MCP/knowledge/23 skills/13 agents preserved in resources/legacy). |
| Typed streaming protocol | Implemented (`desktop/src/stream-events.ts`, `events.stream` merged into daemon dispatch), unit-tested `stream-events.test.ts` + `stream-core.test.ts` 23/23, renderer gap replay via main bridge `events.replay`; documented in `docs/architecture/streaming-protocol.md` |
| Functional RPC E2E | `e2e-rpc.mjs --dist dist --live`: **42 passed / 0 failed**, ~7 s, real detached daemon, authenticated named pipe; T3 deterministic 22 cases (19 pass / 0 fail / 3 skip) |
| Six research capabilities | **Real E2E PASS** — T3 live suite **21/21**, 13.7 s: knowledge → hypothesis → debate → methods → analysis → discovery → autonomy with durable records/artifacts; deterministic cases 11–13. External Biomni/ERA/Robin/Kosmos/Paper2Agent integrations not bundled |
| Debate rules | T3 deterministic case 7 + live debate: role order, round count, no-network rules asserted |
| MCP / Skills / Providers / Channels / RSI | Unit + E2E at registry/lifecycle level PASS; real Telegram/Slack/Discord/WeChat accounts BLOCKED_EXTERNAL; live GitHub skill install not exercised; 23 legacy scientific skills not migrated into the new registry (NOT_STARTED) |
| Public research DBs | **Real calls PASS** — Europe PMC/PubMed `CRISPR base editing` PMID **42878939**; UniProt TP53 **Q9Y2B4** (T53G5_HUMAN, release 2026_03); responses stored as durable artifacts with sha256 |
| Managed Python worker | v2.0.0 pure-stdlib worker, 22 tests / 21 pass / 1 skip; real `demo.fcs` (FCS 3.1, 5 channels, 6,000 events): mean FSC-A 50357.318211, SSC-A 30390.826209, FL1-A 734.915157, FL2-A 363.630725, FL3-A 788.096841; Otsu gates 3199/1979/1612/653/1279; `runScript` sandbox with timeouts/output caps/env allowlist/file digests |
| Legacy data import | backup-first explicit import; `import.inspect` read-only on a real legacy home, `import.apply` idempotent, `import.rollback` unit-tested (`import-service.test.ts` 5/5); nothing automatic; user data untouched |
| Optional legacy Python workbench | **unavailable on this host** (Python lacks `fastapi`) — source preserved under `resources/legacy`, not exercised at runtime |

## E. Stability & security

| Item | Evidence |
| --- | --- |
| Chaos (short window) | `docs/verification/chaos-results.json`: **12/12 scenarios, 51.7 s** — worker SIGKILL retry (attempts 2), daemon SIGKILL mid-step recovered from durable lease (same operation id, 1 artifact), committed step not replayed, cancel → 0 artifacts, provider 429→500→200 with 2 human approvals + reconciliation events |
| Endurance 8/24/72 h, reboot, power-loss, disk-full | **NOT RUN** — must stay NOT_VERIFIED (R050/R116) |
| DB/context recovery | durable tests + 10-round ~201k-token compaction (round-2 evidence), versions/manual compaction/rollback; semantic losslessness not claimed |
| Security audit | `docs/verification/security-review.md` + `scripts/security-scan.mjs`: **PASS — 0 HIGH / 18 LOW / 10 documented test fixtures**; `npm audit --omit=dev` 0 vulnerabilities; contextIsolation + sandbox renderer, CSP `connect-src 'none'`, sender/frame-checked IPC, path-confinement guards, safeStorage credentials, named-pipe random token. No OS-level CPU/memory/disk quotas (R144 NOT_STARTED) |
| Performance | `docs/verification/performance-baseline.md` (daemon ready p50 391 ms, create p50 0.82 ms, events.stream p50 1.49 ms, worker flowSummary 20.9 ms); UI/markdown first-token and endurance not measured |
| Installer host lifecycle | 12/12 PASS on the final artifact — see §B |

## F. Open items (release-blocking for a "verified public release" claim)

1. **Clean-Windows-VM lifecycle** install → start → upgrade → uninstall: NOT RUN (host probe only).
2. **Code signing / SmartScreen trust**: BLOCKED_EXTERNAL — no certificate; installer UNSIGNED.
3. **8/24/72 h endurance, reboot, power-loss, disk-full**: NOT RUN (short-window chaos only).
4. **GitHub MIT publication + Release asset upload**: BLOCKED_EXTERNAL — `gh` absent, no token;
   tag `suwen-vnext-3.2.0`/commands documented but not executed.
5. **T2 post-fix SIGKILL/reconnect in-UI re-run** (`ui-visual-audit.md` was published 2026-10-25 with the visual matrix PASS; the SIGKILL/reconnect re-run is still missing) -> R130 remains UNVERIFIED; R136 is now IMPLEMENTED_PASS.

6. **Real external vendor accounts** (model providers, Telegram/Slack/Discord/WeChat): not available;
   local protocol fixtures and blocked-external notes only.
7. **Legacy Python workbench runtime**: unavailable on this host (missing `fastapi`); 2 unit tests
   skipped (Windows symlink privilege; optional legacy deps).
8. **Not migrated / not started**: 23 legacy scientific skills in the new registry, Paper2Agent,
   Biomni/ERA/Robin/Kosmos external integrations, SSH/terminal/kernel/workspaces/trajectories/model
   routing/vision, OS-level sandbox quotas.
9. **CI never executed** — workflow authored, no GitHub Actions run log; do not claim "CI green".
10. Hygiene: uncommitted worktree and `desktop/dist-lead` leftover (conflict C-11).

## Signature block (measured values; nothing signed)

- Final test numbers: **150 tests / 148 pass / 0 fail / 2 skipped, 29.5 s, exit 0** (final 3.2.0 build)
- RPC / smoke / UI: **42/0 ~7 s; 8/8 68 s; 19/0/12**
- Final installer: **129,447,101 B**, SHA256 `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`
  (+ blockmap 135,948 B `283B27E1…`, unpacked 249,801,728 B `8F7EAF76…`; `SHA256SUMS` present)
- CI run link/status: **NOT RUN**
- GitHub Release URL/tag: **NOT CREATED** (blocked)
- Clean-VM machine + steps: **NOT AVAILABLE**
- Endurance run duration/results: **NOT RUN**


## Final T2 correction (2026-10-25, Lead-measured, applied after the initial final report)

- **P1 duplicate persisted assistant messages — RESOLVED.** Root cause: daemon id `a-<operationId>` vs
  renderer `uid()` from `maybeAppendAssistant`. Fix: `desktop/src/conversations.ts` merges assistant
  turns by `(taskId, role='assistant')` in addition to message-id idempotency; regression test
  `desktop/test/conversations.test.ts` (4 tests). Lead re-ran the T2 harness
  `node scripts/streaming-ui-e2e.mjs --mode=final --only=persist --runs=1`: `assistants=1
  taskAssistants=1`, 0 findings (report `desktop/release/smoke/ui-streaming-20261024-192807-final.json`). T2 is re-running persist+kill and error-state checks.
- **Auto-reconnect after daemon SIGKILL — PASS 3/3 runs:** offline surfaced 72-520 ms, auto-restored
  702-779 ms without page reload, settings `#reconnect` 49-57 ms, 0 reloads; interrupted task lands in
  the designed `waiting_approval` reconciliation and retry recovered the exact text.
- **P2 failed-turn error surface — FIXED and T2-verified:** `desktop/ui/app.js` shows `#chat-notice` for the waiting_approval reconciliation path (localized `chatTaskNeedsReview`) and for failed steps (`chatTaskFailed`), and clears a stale review notice after a successful retry. T2 visual re-verification PASS on the deterministic provider-HTTP-500 fixture: `#chat-notice` visible, zh len 106 / en len 159, `selectedTask.status=waiting_approval`; lifecycle guard clears after approval-retry success; reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…).
- Render/visual facts: composer bbox max deviation 0 px; 100/1,000/10,000-delta text integrity via
  exact DOM sha256 (lag P50 32-43 ms, P95 54-89 ms; 10k wall 152 s arrival-bound); scroll 10k PASS
  (followGap 0); 120-message conversation opens in 249 ms; layouts 6/6 PASS; dark theme implemented;
  180 PNGs visual audit, 0 layout findings, 0 page/console errors; pre-T1 poll-only baseline NOT_RUN
  (only a 217-char probe); all fixture results deterministic local OpenAI-SSE, no vendor APIs.
