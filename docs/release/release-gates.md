# Release gates — SuWen desktop 3.2.0 (final evidence round)

## Round-5 (3.3.0) supersession - current delivered evidence (2026-10-25)

Gate status for the **3.3.0** artifact (round-5). Earlier 3.2.0 gate evidence below is historical.

| Gate | Status | Evidence |
|---|---|---|
| G1 Build | **PASS** | `npm test` 222/220/0/2 exit 0; `tsc --noEmit`/`npm run build` exit 0; CI green on release commit `3a5b582` (run 40168426610 attempt 2; attempt 1 hit a flaky legacy Python timing test and was re-run green) |
| G2 Runtime | **PASS** | RPC E2E `--live` **42/42**; packaged Electron smoke **passed** (incl. hosted SPA); daemon health 3.3.0 |
| G3 Streaming/UI stability | **PASS_WITH_LIMITS** | hosted workbench E2E 34/34; native streaming E2E (round-3) 16/16 case types with P1 fixes; markdown progressive unit 32/32; pre-T1 poll-only baseline NOT RUN |
| G4 Functional breadth | **PASS_WITH_LIMITS** | live RPC 42/42; web-parity view matrix 12/12 routes; hidden legacy views smoke-only |
| G5 Research capabilities | **PASS** | deterministic research E2E 19 PASS/3 SKIP; live 21/21 incl. real Europe PMC/UniProt evidence |
| G6 Durability | **PASS_WITH_LIMITS** | chaos 12/12 (53.4 s); accelerated soak 25 min/64 cycles/12 faults recovered; **8/24/72 h + reboot/sleep/power/disk-full NOT RUN** |
| G7 Security/compliance | **PASS_WITH_LIMITS** | scanner 0 HIGH / 192 LOW (20 fixtures); npm audit 0; hosted CSP measured 0 violations; no pen-test, unsigned |
    | G8 Windows installer | **PASS_WITH_LIMITS** | final 3.3.0 artifact built; host lifecycle 12/12 incl. upgrade; packaged smoke passed; clean-VM install NOT RUN; UNSIGNED |
| G9 GitHub publication | **BLOCKED_EXTERNAL** | source branch/tag pushable via SSH; CI executes; Release assets require `gh`/token (absent) and gates are HOLD |

**Release decision: HOLD (not published).**

---




Status: **NOT PUBLISHED / NOT A CLEAN-MACHINE SIGN-OFF**. Each gate has an enforced evidence link;
uncompleted gates are not passed. Machine-readable companion:
`docs/verification/defect-register.csv`; requirement matrix `docs/requirements/master-requirements.csv`
(102 rows — 87 IMPLEMENTED_PASS / 10 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL; round-5 rows R149-R152).

Evidence measured in TARGET `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
(branch `suwen-vnext-durable`, 2026-10-25) on the **final 3.2.0 build**. `PASS` is used only where a
runtime/test artifact in this workspace proves it; unexecuted items stay `UNVERIFIED` /
`NOT RUN` / `BLOCKED_EXTERNAL`. Full numbers: `final-acceptance-report.md`,
`docs/verification/integration-and-e2e.md`, `docs/verification/e2e-results.md`,
`docs/verification/ui-e2e.md`, `docs/verification/artifacts/*.json`.

| # | Gate | Status | Evidence | Blocker / limit |
|---|---|---|---|---|
| G1 | Build integrity (compile/typecheck/build) | **PASS** | `npx tsc -p tsconfig.json --noEmit` exit 0; `npm run build` (tsc + copy-assets) exit 0; final 3.3.0 installer built from this tree; **GitHub Actions `SuWen Windows CI` run 40168426610 attempt 2 (2026-10-25) SUCCESS** on `3a5b582` (attempt 1 failed only on a flaky legacy Python timeout test and was re-run) — both jobs green (Node: typecheck, full `npm test`, live RPC E2E, UI DOM QA, security scan, NSIS build, SBOM/checksums/artifacts; Python baseline pytest) | Two environment-limited test skips (Windows symlink privilege, optional legacy Python deps); earlier CI runs failed and were fixed (see CHANGELOG Unreleased) |
| G2 | Runtime integrity (tests, RPC E2E, packaged smoke) | **PASS** | `npm test`: **183 tests / 181 pass / 0 fail / 2 skipped**, 28.6 s (final full run), exit 0; `node scripts/e2e-rpc.mjs --dist dist --live`: **42 passed / 0 failed**, ~7 s over authenticated named pipe incl. real Europe PMC PMID 42878939 + UniProt Q9Y2B4 (release 2026_03) stored as sha256 artifacts; packaged Electron smoke **8/8**, exit 0 on the final build | Skips: Windows symlink privilege (research-worker), optional legacy Python bench deps; live DB calls need network |
| G3 | Streaming UI stability | **PASS_WITH_LIMITS** | `docs/verification/ui-e2e.md` + `artifacts/ui-e2e-summary.json`; T2 final re-runs: auto-reconnect after daemon SIGKILL **PASS 3/3** (offline 72-520 ms, restored 702-779 ms, 0 reloads), duplicate-assistant P1 **RESOLVED** (conversations.ts taskId+role merge, conversations.test.ts 4 tests, Lead persist re-run 0 findings), failed-turn error surface FIXED and T2-verified (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…)): deterministic local-fixture suite **22 cases - 19 pass / 0 fail / 3 skip**, 10.8 s; 100/1,000/10,000-delta text integrity via exact DOM sha256 (render lag p95 89/61/57 ms; paint avg ~5 ms @10k); composer deviation **0 px**; scroll forced drift **0 px**; layouts 1920x1080 (clamped), 1366x768, 980x680 x zh/en x five workspaces; typed protocol `events.stream` + stream-core.test.ts 23/23; `ui-visual-audit.md` published: 180 PNGs, 144-shot matrix, **0 overflow/overlap/outside-viewport, 0 page/console errors, dark theme verified** | **T2 post-fix SIGKILL/reconnect re-run NOT yet published -> R130 stays UNVERIFIED**; one P2 finding (chat-error surface) + no accessibility audit; frame-time/FPS not measured; markdown-during-stream not asserted |
| G4 | Functional completeness (UI actions -> real handlers) | **PASS** | `desktop/ui/actions.json` **144 actions**; `docs/verification/ui-action-coverage.csv` 144 rows - 91 WIRED_DAEMON_RPC / 10 WIRED_MAIN_PROCESS / 43 WIRED_UI_ONLY / **0 unknown methods**; `node scripts/ui-dom-qa.mjs` **19 passed / 0 failed / 12 warnings**; T3 deterministic E2E 19 pass / 0 fail / 3 skip; RPC E2E 42/0 | Per-action runtime click-through is not individually recorded for all 144 actions (static mapping + DOM QA + 22-case E2E); 12 UI QA warnings are intentional main-process bridge methods |
| G5 | Research workflow (six capabilities) real E2E | **PASS** | `docs/verification/e2e-results.md`: live suite **21/21**, 13.7 s, real daemon + real public databases; deterministic cases 11–13 + live flow cover knowledge → hypothesis → debate → methods → analysis → discovery → autonomy with durable typed records/artifacts (all seven are durable DAG activities) | External Biomni/ERA/Robin/Kosmos/Paper2Agent integrations not bundled; scientific validity externally unvalidated |
| G6 | Durability of implemented behavior + short-window chaos | **PASS_WITH_LIMITS** | `docs/verification/chaos-results.json`: **12/12 scenarios, 51.4 s** — worker SIGKILL retry (attempts 2), daemon SIGKILL mid-step recovered from durable lease (same operation id, 1 artifact), committed step not replayed, cancel → 0 artifacts, provider 429→500→200 with 2 human approvals and reconciliation events; accelerated soak `docs/verification/durability-soak.json`: **25 min / 64 cycles / 12 faults / 12 recovered / 0 errors** (real daemon, SIGKILL+cancel injection); packed-app daemon survives UI close (smoke 8/8) | **8 h / 24 h / 72 h, sleep/hibernate, power-loss, OS reboot, disk-full NOT RUN** (R050/R116 stay UNVERIFIED); accelerated soak is not a substitute; provider faults are a local fixture, one short Windows session |
| G7 | Security & compliance | **PASS_WITH_LIMITS** | `docs/verification/security-review.md` + `scripts/security-scan.mjs`: **PASS — 0 HIGH / 192 LOW / 20 documented test fixtures**; `npm audit --omit=dev` 0 vulnerabilities (prod tree); contextIsolation+sandbox renderer, CSP `connect-src 'none'`, sender/frame-checked IPC, named-pipe random token with timing-safe compare, path-confinement guards, safeStorage credentials; MIT LICENSE + NOTICE + third-party licenses + SBOM; Python baseline preserved Apache-2.0 | No OS-level CPU/memory/disk quotas (R144 NOT_STARTED); no penetration test; installer unsigned and disclosed |
| G8 | Windows build / installer / host lifecycle | **PASS_WITH_LIMITS** | `release/SuWen-Setup-3.3.0-win-x64.exe` **131,011,183 B** SHA256 `0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03` (UNSIGNED); blockmap 137,255 B `15EAB7E1C14D36514DC8FB2A8B7BEE655E253D117DFBBAC1F5179EB5BB662ADB`; `win-unpacked/SuWen.exe` 249,801,728 B `469D75AD64B449B98D5DB8F7D1C64C0F988F8D2F99F6B04CD213A4481A0FA991`; `SHA256SUMS` in `desktop/release/SHA256SUMS` + `docs/release/SHA256SUMS.txt`; `installer-lifecycle.json` **12/12 host steps PASS**, upgrade source 3.0.0-preview.1 installed PASS; packaged smoke on this build 10/10 (incl. hosted legacy web SPA check) | **Clean-Windows-VM install/start/upgrade/uninstall NOT RUN**; no code signature (BLOCKED_EXTERNAL, no certificate); CI builds an installer successfully (run 40168426610 attempt 2) but has not executed a clean-VM install |
| G9 | GitHub MIT publication + Release assets | **BLOCKED_EXTERNAL** | Remote `https://github.com/ForrestGump618/suwen.git` readable; **source branch + tag `suwen-vnext-3.3.0` (commit `3a5b582`) pushed**; **`main` branch protected with both CI jobs as required checks**; two-job Windows CI green (run 40168426610 attempt 2); MIT files present; secret scan PASS; publication runbook `docs/release/github-publication.md` | **GitHub Release NOT created** (gates HOLD; `gh` CLI/token absent → installer asset cannot be uploaded/verified). GitHub Release NOT created (gates HOLD); branch protection applied; no Release asset upload |

## Gate summary

- **PASS:** G1, G2, G4, G5
- **PASS_WITH_LIMITS:** G3 (poll-only baseline not run; fixture-only provider; no accessibility/FPS audit; error-state surface FIXED and T2-verified), G6 (no 8/24/72 h or reboot/power/disk-full; 25 min accelerated soak PASS, 64 cycles/12 faults recovered/0 errors), G7 (no OS quotas/signing), G8 (clean VM not run, unsigned)
- **UNVERIFIED / NOT RUN:** clean-Windows-VM lifecycle, 8/24/72 h + reboot/power-loss/disk-full, legacy Python workbench runtime, real vendor model accounts
- **BLOCKED_EXTERNAL:** G9 GitHub Release publication; code signing (no certificate)
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
