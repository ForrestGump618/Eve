# Release gates — SuWen desktop 3.2.0 (final evidence round)

Status: **NOT PUBLISHED / NOT A CLEAN-MACHINE SIGN-OFF**. Each gate has an enforced evidence link;
uncompleted gates are not passed. Machine-readable companion:
`docs/verification/defect-register.csv`; requirement matrix `docs/requirements/master-requirements.csv`
(98 rows — 81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL).

Evidence measured in TARGET `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
(branch `suwen-vnext-durable`, 2026-10-25) on the **final 3.2.0 build**. `PASS` is used only where a
runtime/test artifact in this workspace proves it; unexecuted items stay `UNVERIFIED` /
`NOT RUN` / `BLOCKED_EXTERNAL`. Full numbers: `final-acceptance-report.md`,
`docs/verification/integration-and-e2e.md`, `docs/verification/e2e-results.md`,
`docs/verification/ui-e2e.md`, `docs/verification/artifacts/*.json`.

| # | Gate | Status | Evidence | Blocker / limit |
|---|---|---|---|---|
| G1 | Build integrity (compile/typecheck/build) | **PASS** | `npx tsc -p tsconfig.json --noEmit` exit 0; `npm run build` (tsc + copy-assets) exit 0; final installer built from this tree 2026-10-24T19:16:10Z | CI never executed; two environment-limited skips in tests |
| G2 | Runtime integrity (tests, RPC E2E, packaged smoke) | **PASS** | `npm test`: **183 tests / 181 pass / 0 fail / 2 skipped**, 28.6 s (final full run), exit 0; `node scripts/e2e-rpc.mjs --dist dist --live`: **42 passed / 0 failed**, ~7 s over authenticated named pipe incl. real Europe PMC PMID 42878939 + UniProt Q9Y2B4 (release 2026_03) stored as sha256 artifacts; packaged Electron smoke **8/8**, exit 0 on the final build | Skips: Windows symlink privilege (research-worker), optional legacy Python bench deps; live DB calls need network |
| G3 | Streaming UI stability | **PASS_WITH_LIMITS** | `docs/verification/ui-e2e.md` + `artifacts/ui-e2e-summary.json`; T2 final re-runs: auto-reconnect after daemon SIGKILL **PASS 3/3** (offline 72-520 ms, restored 702-779 ms, 0 reloads), duplicate-assistant P1 **RESOLVED** (conversations.ts taskId+role merge, conversations.test.ts 4 tests, Lead persist re-run 0 findings), failed-turn error surface FIXED and T2-verified (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…)): deterministic local-fixture suite **22 cases - 19 pass / 0 fail / 3 skip**, 10.8 s; 100/1,000/10,000-delta text integrity via exact DOM sha256 (render lag p95 89/61/57 ms; paint avg ~5 ms @10k); composer deviation **0 px**; scroll forced drift **0 px**; layouts 1920x1080 (clamped), 1366x768, 980x680 x zh/en x five workspaces; typed protocol `events.stream` + stream-core.test.ts 23/23; `ui-visual-audit.md` published: 180 PNGs, 144-shot matrix, **0 overflow/overlap/outside-viewport, 0 page/console errors, dark theme verified** | **T2 post-fix SIGKILL/reconnect re-run NOT yet published -> R130 stays UNVERIFIED**; one P2 finding (chat-error surface) + no accessibility audit; frame-time/FPS not measured; markdown-during-stream not asserted |
| G4 | Functional completeness (UI actions -> real handlers) | **PASS** | `desktop/ui/actions.json` **144 actions**; `docs/verification/ui-action-coverage.csv` 144 rows - 91 WIRED_DAEMON_RPC / 10 WIRED_MAIN_PROCESS / 43 WIRED_UI_ONLY / **0 unknown methods**; `node scripts/ui-dom-qa.mjs` **19 passed / 0 failed / 12 warnings**; T3 deterministic E2E 19 pass / 0 fail / 3 skip; RPC E2E 42/0 | Per-action runtime click-through is not individually recorded for all 144 actions (static mapping + DOM QA + 22-case E2E); 12 UI QA warnings are intentional main-process bridge methods |
| G5 | Research workflow (six capabilities) real E2E | **PASS** | `docs/verification/e2e-results.md`: live suite **21/21**, 13.7 s, real daemon + real public databases; deterministic cases 11–13 + live flow cover knowledge → hypothesis → debate → methods → analysis → discovery → autonomy with durable typed records/artifacts (all seven are durable DAG activities) | External Biomni/ERA/Robin/Kosmos/Paper2Agent integrations not bundled; scientific validity externally unvalidated |
| G6 | Durability of implemented behavior + short-window chaos | **PASS_WITH_LIMITS** | `docs/verification/chaos-results.json`: **12/12 scenarios, 51.7 s** — worker SIGKILL retry (attempts 2), daemon SIGKILL mid-step recovered from durable lease (same operation id, 1 artifact), committed step not replayed, cancel → 0 artifacts, provider 429→500→200 with 2 human approvals and reconciliation events; packed-app daemon survives UI close (smoke 8/8) | **8 h / 24 h / 72 h, sleep/hibernate, power-loss, OS reboot, disk-full NOT RUN** (R050/R116 stay UNVERIFIED); provider faults are a local fixture, one short Windows session |
| G7 | Security & compliance | **PASS_WITH_LIMITS** | `docs/verification/security-review.md` + `scripts/security-scan.mjs`: **PASS — 0 HIGH / 18 LOW / 10 documented test fixtures**; `npm audit --omit=dev` 0 vulnerabilities (prod tree); contextIsolation+sandbox renderer, CSP `connect-src 'none'`, sender/frame-checked IPC, named-pipe random token with timing-safe compare, path-confinement guards, safeStorage credentials; MIT LICENSE + NOTICE + third-party licenses + SBOM; Python baseline preserved Apache-2.0 | No OS-level CPU/memory/disk quotas (R144 NOT_STARTED); no penetration test; installer unsigned and disclosed |
| G8 | Windows build / installer / host lifecycle | **PASS_WITH_LIMITS** | `release/SuWen-Setup-3.2.0-win-x64.exe` **129,447,101 B** SHA256 `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897` (UNSIGNED); blockmap 135,948 B `283B27E19D2A943DD940B8E83F748CEB2627950A87CAD509069EFAE4230CBB72`; `win-unpacked/SuWen.exe` 249,801,728 B `8F7EAF76FEB66A61E51D5F8B9B67EEFA375FEDD0018A5566D64C27F0570A22E1`; `SHA256SUMS` in `desktop/release/SHA256SUMS` + `docs/release/SHA256SUMS.txt`; `installer-lifecycle.json` **12/12 host steps PASS**, upgrade source 3.0.0-preview.1 installed PASS; packaged smoke on this build 8/8 | **Clean-Windows-VM install/start/upgrade/uninstall NOT RUN**; no code signature (BLOCKED_EXTERNAL, no certificate); CI workflow never executed |
| G9 | GitHub MIT publication + Release assets | **BLOCKED_EXTERNAL** | Remote `https://github.com/ForrestGump618/suwen.git` readable (`git ls-remote`); MIT files present; local branch `suwen-vnext-durable` HEAD `0024e73`; scan clean | `gh` CLI absent, no GitHub token in session → cannot push tag/create Release/upload installer; commands in `docs/release/github-publication.md` (tag `suwen-vnext-3.2.0`), **not executed** |

## Gate summary

- **PASS:** G1, G2, G4, G5
- **PASS_WITH_LIMITS:** G3 (pre-T1 poll-only baseline not run; fixture-only provider; error-state surface FIXED and T2-verified (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…))), G6 (no endurance/reboot), G7 (no OS quotas/signing), G8 (clean VM not run, unsigned)
  G7 (no OS quotas/signing), G8 (clean VM not run, unsigned)
- **UNVERIFIED / NOT RUN:** clean-Windows-VM lifecycle, 8/24/72 h + reboot/power-loss/disk-full, T2 post-fix SIGKILL/reconnect re-run, legacy Python workbench runtime
  T2 post-fix SIGKILL/reconnect re-run, visual acceptance matrix, legacy Python workbench runtime
- **BLOCKED_EXTERNAL:** G9 GitHub publication; code signing (no certificate)
- **FAIL:** none on the final build

## Gate ordering rules (from the round-3 prompt)

1. Gates are ordered: do not publish if any earlier gate fails.
2. G1–G2 can be re-run on any host; G3–G5 depend on the T1/T2/T3 work; G6–G8 need long-run hardware
   or a clean VM; G9 needs credentials.
3. PASS requires real runtime evidence — code existing, a renderable component, a declared interface,
   mock-only tests, or generated docs do not count.
4. Every UNVERIFIED row above appears in `docs/release/final-acceptance-report.md` §F and in the
   `docs/progress.md` PENDING list.

## Release decision record

| Candidate | Date | Decision | Reason |
| --- | --- | --- | --- |
| 3.2.0 | 2026-10-25 (final evidence round) | **HOLD — not published** | Final 3.2.0 build passed host checks (G1/G2/G4/G5, G3/G6/G7/G8 with limits) but clean-VM lifecycle, code signing, endurance and GitHub publication are not done (G9 blocked); T2 final re-runs: auto-reconnect PASS, duplicate P1 resolved, error-state surface FIXED and T2-verified (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…)); visual audit published (P2 fixed) |
| 3.2.0 | 2026-10-25 (first pass) | HOLD | G3/G4/G5/G6/G8/G9 open or blocked; final numbers pending |
| 3.1.0 | 2026-10-24 | preview only | durable/UI/research/release gaps documented; no clean-VM lifecycle, no signing, no real vendor accounts |

Do not rewrite historical decisions; re-run the gates after any further evidence round.
