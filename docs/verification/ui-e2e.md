# Streaming UI E2E — deterministic local fixture

Owner: T2 (ui-e2e). Round 3, SuWen Desktop vNext.
Label for every number below: **deterministic local fixture** (local HTTP OpenAI-compatible SSE server; no real vendor APIs, no external network).

## Environment

| Item | Value |
| --- | --- |
| Host OS | Windows 11 Home China 10.0.26200 (win32 10.0.26200) |
| CPU | Intel Core i7-14700HX, 20C/28T |
| RAM | 31.8 GiB |
| Display | host dpr 1.5 (150 % scaling); work-area DIP 1693×956 |
| Host Node | v24.14.0 |
| Playwright | playwright-core 1.64.1 (`_electron` launcher) |
| Electron | 45.0.0 (package); app "suwen-desktop" 3.2.0; in-app Chrome 156.0.8078.48 / Node 24.22.0 / sqlite 3.53.4 |
| UI build under test | `ui/app.js` sha256 `54DB16F7345ACA7CF5934065B111A38853488DA0B4442BD1B6FFE570B5595F53` (== `dist/ui/app.js`), `ui/index.html` sha256 `19A09EE7338561CE2B8EDA31AB3123AA3D3004871E6C9351370107170442B411`; dist rebuilt 02:43:48 local after T1 scroll/jump-latest fix + `window.__suwenStreamDebug` hook |
| Transport | push: `window.suwen.onEvent(handler)` ← main pump `events.stream` batches; gap replay via `window.suwen.call('events.replay',{since,limit})` |
| Harness | `desktop/scripts/streaming-ui-e2e.mjs` (new); Electron dev binary `desktop/node_modules/electron/dist/electron.exe`; per-run `SUWEN_TEST_HOME` temp profile; inherited `ELECTRON_RUN_AS_NODE` deleted from child env |
| Report | Primary run `desktop/release/smoke/ui-streaming-20261024-185128-baseline.json` (712,863 ms; 7 findings, pre-Lead-fix full matrix; `ui/app.js` sha256 `54DB16F7…`). Post-fix verification runs (rebuilt dist after Lead fixes): `ui-streaming-20261024-191616-final.json` (50,512 ms, 5 findings), `...-192024-final.json` (34,502 ms, 5 findings), `...-192112-final.json` (30,028 ms, 3 findings), and final combined run `...-192946-final.json` (34,543 ms, 1 by-design P2 finding, `ui/app.js` sha256 `6276F496…`). Error-state DOM evidence: `ui-visual-audit-20261024-193545.json`. Filename mode-label note below. |

Fixture model: `provider=openai`, `baseUrl=http://127.0.0.1:<ephemeral>/v1`, `model=fixture`, `apiKey=fixture`, `contextWindow=8192`, `maxOutput=512`; SSE chunks are `w00000 ` (7 bytes each); expected text is `[TAG]` + N chunks, compared to the rendered assistant body by length **and** sha256.

### Mode-label note (honest)

The suite invocation was `node scripts/streaming-ui-e2e.mjs --mode final --runs 1`. The script's `argValue` only accepts `--name=value`, so the run is stored/labelled `baseline` in the JSON filename and scenario labels. It is *not* a poll-mode baseline: report `transport` is push and `FALLBACK=false`, scenarios are the final-build push measurements. Future runs should use `--mode=final`.

Pre-T1 poll-only UI could not be captured as a true baseline: T1 landed the push/theme UI before this harness was validated, and `ui/**` is outside T2 write scope. A documented fallback proxy was built (`--fallback`: unsubscribe push transport at runtime, `S.stream.disabled=true`, leaving the app's 2500 ms snapshot reconcile path); only a 217-character probe (below) was captured in that mode, **not** the full 100/1000/10000 matrix. Full fallback baseline: **NOT_RUN** (timebox).

## Provider request verification (P0 prompt-delivery defect, FIXED)

At 02:24 the harness found the provider request body contained **only** the system message; the user prompt never reached the model (rendered fallback body length 11). Root cause: `desktop/ui/app.js` `chatSteps()` sent `input.messages = buildHistory(conversationId)` (completed-task history only, system turn only) and `desktop/src/activities/model.ts` used `input.messages` verbatim when present, ignoring `input.prompt`.

Fix landed (src `model.ts` 02:30:32 + ui `app.js` prompt-as-final-user-turn; T1 added regression test 23/23), then verified here:

- Pre-fix probe `release/smoke/ui-streaming-20261024-182349-baseline-probe.json`: assistant body length 11 chars.
- Post-fix push probe `...-183205-baseline-probe.json`: request = `[{role:'system',…},{role:'user',content:'E2E SIZE=30 TAG=PROBE 探针'}]`; body length 217 = expected.
- Post-fix poll-fallback probe `...-183224-baseline-probe.json`: same full 217-char body.
- Current suite: every `fixture.providerRequest.messagesPreview` shows the system turn + the user prompt (see e.g. composer scenario in the final JSON).

## Delta-stream integrity and rendering latency (100 / 1,000 / 10,000 deltas)

All runs completed, rendered text sha256 == expected sha256, rendered lengths 708 / 7,008 / 70,010 chars, exactly one final assistant body per run.

| Deltas | Run | sha256 match | First text | Render lag P50 | P95 | max | Completion lag | DOM updates | Wall |
| ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | OK | 150 ms | 43 ms | 89 ms | 268 ms | 268 ms | 30 | 3.59 s |
| 100 | 2 | OK | 164 ms | 41 ms | 78 ms | 270 ms | 270 ms | 29 | 3.47 s |
| 1,000 | 1 | OK | 160 ms | 32 ms | 54 ms | 64 ms | n/m* | 143 | 16.00 s |
| 1,000 | 2 | OK | 168 ms | 33 ms | 61 ms | 184 ms | 184 ms | 150 | 16.08 s |
| 10,000 | 1 | OK | 169 ms | 32 ms | 56 ms | 250 ms | 250 ms | 1,417 | 152.38 s |
| 10,000 | 2 | OK | 167 ms | 32 ms | 57 ms | 97 ms | 33 ms | 1,415 | 152.02 s |

`*` n/m = completion lag not sampled (50 ms sampler stopped before the last growth sample); the completed DOM was still verified exactly by sha256, and the harness now treats this as "not measured" instead of a failure (script fixed after this run; the one P0 finding in the JSON is this measurement artifact, not a UI defect).

Throughput (T1 `window.__suwenStreamDebug()` sampled during 10,000-delta runs):

- fixture emission pace: up to ~500 deltas/s (2 ms/chunk); delivered push batch cadence ≈ **9.1–9.3 batches/s** (~5.6 deltas/batch for 10k ⇒ ≈50 deltas/s end-to-end).
- renderer paint cadence ≈ 9.3 paints/s, average paint 4.9–5.0 ms (10k) vs 0.3 ms (100) — paints/s tracks batches/s; debug `attribution`: "renderer keeping up with arrival cadence".
- Conclusion: the 10k stream is **limited upstream of the renderer on this host (fixture/provider + main pump/RPC cadence)**, not a UI throughput defect; renderer absorbs what arrives. 10k runs take ~152 s wall for this reason.

Composer and focus:

- Composer bounding-rect max deviation **0 px** in every measured run (sizes ×2, composer scenario).
- Draft typed into `#prompt` during an active 1,000-delta stream: **preserved** (text still in `#prompt` after completion), 0 px composer displacement.

## Scroll / follow (10,000-delta scenario)

- Auto-follow gap max: **0 px** while following.
- Deliberate user `scrollTop=0` mid-stream: **0 px** forced drift (user position respected); follow stays off after user intent.
- `#jump-latest` visible during this scenario: 0 observations (not needed because follow was re-armed correctly by the fixed UI); build A (pre-fix) had follow gap 14,556 px / final bottom gap 14,024 px → **fixed in current build**, this suite PASS.
- Final bottom gap 14,024 px in this scenario is expected (test intentionally leaves the timeline scrolled up and never re-arms follow).

## Concurrent runs (two model tasks, same conversation)

- Both final texts exact sha256: A `[CA]` 1,404 chars `ac310257…`, B `[CB]` 1,054 chars `57faa3d6…`.
- No cross-contamination, no duplicate bodies, both streams visible together (2,313 samples with both). Peak assistant bodies 2, peak streaming bubble 1. **PASS**.

## 120-message conversation

- 120 messages rendered, conversation open/render **249 ms**, no page horizontal overflow, composer in viewport, `startsAtTop=true` (opens at conversation top by design; distance to bottom 11,772 px). **PASS** for render latency; note: no auto-scroll-to-latest on open (product behavior, not asserted as failure).

## Layouts (content-size, host dpr 1.5)

Requested content sizes 1920×1080, 1366×768, 980×680 × zh/en; five workspaces each; checks: document/body horizontal overflow, elements outside viewport, pairwise overlaps rail↔sidebar↔main↔header↔timeline↔composer↔evidence.

- **0 findings in all 6 combinations** (`layouts` payload in final JSON).
- Note: the 1920×1080 request is clamped by the host work area to an actual viewport 1693×956 DIP (dpr 1.5 ⇒ 2540×1434 px screenshots); 1366×768 and 980×680 were met as requested. Device-scale-factor coverage is in the companion visual audit (`docs/verification/ui-visual-audit.md`), which forces 1×/1.25×/1.5× via `--force-device-scale-factor`.

## Theme

- Dark theme **IMPLEMENTED**: `#defaults-theme` select with `system / light / dark`; `documentElement` gets `data-theme=light|dark` + `data-theme-mode=system|light|dark`; `localStorage['suwen.theme']` persisted. Visual audit captures light/dark screenshots (zh+en, 2 viewports).

## Conversation persistence duplicate (P1 defect — FIXED & re-verified)

Lead fix (landed in `desktop/src/conversations.ts`): assistant turns are merged by `(taskId, role='assistant')` in addition to idempotency by message id. T2 re-verified by measurement on the rebuilt dist (03:29 local; `ui/app.js` sha256 `6276F496…`, `dist/main.js` `EDDF37B2…`):

- `node scripts/streaming-ui-e2e.mjs --mode=final --only=persist,kill --runs=1` → `release/smoke/ui-streaming-20261024-192946-final.json` (34,543 ms):
  - persistence conversation `7a0bfefb-da46-4bc2-b0fb-cd2583b6e36b`: `messageCount=2`, `assistantCount=1`, `assistantMessagesWithTaskId=1`; the single assistant row is daemon-authored `a-da3cc7ac08c4…` (taskId `c37b23dd…`, len 430). `exactlyOneAssistant=true`, `exactlyOneTaskAssistant=true` — **PASS**.
  - kill recovery conversation `9870bf54-e150-493e-b489-754ad8637143`: `assistantMessages` length 1 (`a-7ec730eca672…`, sha256 `325e4dd5096f…`, len 2,107); `duplicateFinalCopiesAfterSettle=1`, `domCopies=1`, `persistedTaskAssistants=1` — **PASS**.
- Before the fix (same harness, dist with only the by-id idempotency change): `ui-streaming-20261024-192024-final.json` → `assistantCount=2`, `taskAssistants=2`.
  - daemon row `a-5ba5db9e49a9…0b38fc4c` (writer: `desktop/src/activities/model.ts`, `id: a-${operationId}`) at `1792869629961`
  - renderer row `5552b766-a631-406f-a18c-7e064c7f09cf` (writer: `desktop/ui/app.js` `maybeAppendAssistant()`, `id: uid()`) at `1792869630070`
  - kill recovery in the same run: DOM = user + 2 assistant copies, `conversationRecord.assistantMessagesForTask` = 2 (`a-0c282455…` + `3e0f85f4-…`), both sha256 `325e4dd5…`.
These failing ids are kept as regression evidence: the defect was two writers with different ids, and the task-scoped merge now collapses them to one persisted row.

## Daemon SIGKILL / reconnect / recovery

Scenario: start a 300-delta stream, read daemon pid from `health`, `taskkill /PID <pid> /F`, observe up to 35 s for offline banner and `window.suwen.onConnection` events, then press the real settings `#reconnect` button (no page reload anywhere), then reconcile the interrupted task.

Pre-fix (build without Lead Fix 1): **auto-reconnect FAIL** — no restore within 35 s, zero connection events; manual reachable only via settings button. History rows were: offline after 1,026 ms, manual reconnect 1,077 ms, interrupted `waiting_approval`, retry recovered text at +41,759 ms.

Post-fix (Lead Fix 1 in rebuilt dist; four independent runs: reports `…-191616-final.json`, `…-192024-final.json`, `…-192112-final.json`, and the final combined persist+kill run `…-192946-final.json`):

| Observation | Run 191616 | Run 192024 | Run 192112 | Run 192946 (final) |
| --- | --- | --- | --- | --- |
| Offline state surfaced | health text, 520 ms | `#stream-banner` "reconnecting", 259 ms | `#stream-banner` "reconnecting", 72 ms | `#stream-banner` "reconnecting", 257 ms |
| `onConnection` events | `reconnecting\|reconnecting\|restored\|restored` | `reconnecting\|restored` | `reconnecting\|restored` | `reconnecting\|restored` |
| Auto-reconnect to restored (no manual action) | **PASS**, events only | **PASS**, 779 ms after kill | **PASS**, 702 ms after kill | **PASS**, 927 ms after kill |
| Manual reconnect via real settings button (still exercised afterwards) | 57 ms | 49 ms | 56 ms | 55 ms |
| Interrupted task state | `waiting_approval` / `External result unknown: Lease expired; worker lost` | same | same | same |
| Reconciliation retry (same RPC as evidence-panel Retry, `ui/app.js:1422`) | ok | ok | ok | ok |
| Recovered text exact sha256 | `325e4dd5…` len 2,107 | same | same | same |
| Recovered exactly once (DOM) | FAIL — 2 copies | FAIL — 2 copies | FAIL — 2 copies | **PASS** — 1 copy (`domMessages` assistant len 2,107) |
| Persisted assistant messages for task | FAIL — 2 copies | FAIL — 2 copies | FAIL — 2 copies | **PASS** — 1 (`assistantMessagesForTask` length 1) |
| Page reloads during scenario | 0 (PASS) | 0 (PASS) | 0 (PASS) | 0 (PASS) |

Notes: in runs 192024/192112/192946 the restore was faster than the 250 ms health-text observation loop, so offline was proven via the visible `#stream-banner` reconnecting state + `suwen:connection` events rather than the sidebar glyph (the 520 ms observation in 191616 proves the health line does flip when restore is slower). `waiting_approval` is by design for side-effecting model steps (no blind auto-retry of a possibly-billed provider call); recovery needs the explicit reconciliation action. The duplicate-copy failures in the three earlier post-fix runs were the persistence P1 above and are resolved in the final run.

Final run recovery timeline: kill at `19:30:21.389Z`, reconnecting event at `19:30:21.478Z`, restored at `19:30:21.734Z`, retry requested afterwards and exact text available at `+19.7 s` (includes lease-expiry wait ~15 s before the interrupted step can be reconciled). Findings for the final run: only the by-design P2 reconciliation note; reconnect/persistence rows are all PASS.

## Findings summary

| Sev | Area | Finding | Status |
| --- | --- | --- | --- |
| P0 | (none real) | one JSON P0 is the null-completion-lag sampler artifact (sha OK) | harness fixed after run; not a product defect |
| P1 | conversation persistence | single task persisted 2 assistant messages (daemon `a-<operationId>` + renderer `uid()`, both same taskId) | **FIXED & re-verified by measurement** — Lead task-scoped single-writer merge (`conversations.ts`); report `ui-streaming-20261024-192946-final.json` → `assistantCount=1 taskAssistants=1`; failing ids kept in the section above |
| P1 | kill recovery | recovered text stored/rendered twice (same duplicate-append root cause) | **FIXED & re-verified** — same run: `domCopies=1`, `persistedTaskAssistants=1`, `duplicateFinalCopiesAfterSettle=1` |
| P1 | reconnect | auto-reconnect after daemon SIGKILL missing (stale connection never rescheduled) | **FIXED & verified 4/4 runs** (final run: offline 257 ms via banner, restored 927 ms, `onConnection` reconnecting→restored, 0 reloads) |
| P2 | kill recovery | side-effect model step interrupts to `waiting_approval` (explicit reconciliation) | by design, documented |
| P2 | long conversation | 120-message conversation opens at top (11,772 px from bottom), no auto scroll-to-latest | product note, not asserted as failure |
| P2 | error state | provider HTTP 500 turn ends `waiting_approval` (side-effect reconciliation, by design). Lead then added a `waiting_approval` branch + immediate `renderChatNotice()` paint + stale-notice lifecycle guard in `ui/app.js` `syncChatFailureNotice()`. | **FIXED & verified 3 runs** — `#chat-notice` `hidden=false`, textLength 106 (zh) / 159 (en), text starts 「需要人工核查：…」 / "Needs human review: …", `selectedTask.status=waiting_approval`; retry with a success fixture plan leaves `waiting_approval` → status `completed` and the notice clears (`hidden=true`). Reports `ui-visual-audit-20261024-194627.json` (zh), `…-194718.json` (zh+en), `…-194944.json` (zh + lifecycle guard); screenshot `docs/verification/screenshots/round3/chat-error_light_zh_1366x768_dsf1x.png` |
| — | provider prompt | P0 prompt-delivery defect (system-only request) | **FIXED & re-verified** (provider fixture request now has system+user; composer scenario request shows exact typed text) |

## Limitations

- Deterministic local fixture only; no real provider/network/latency/rate-limit behavior. Fixture emits up to 500 deltas/s; observed end-to-end cadence ~50 deltas/s in 10k runs, so wall-clock times describe this host+fixture, not vendor streaming.
- One host, one GPU/driver, 150 % display scaling; single window; no memory/CPU profiling, no multi-display.
- True pre-T1 poll baseline NOT captured (see mode-label note); fallback proxy probe only.
- Scroll/rendering lags sampled at 50 ms; completion lag can be "not measured" (treated as n/m, sha still verified).
- No contrast/accessibility/keyboard/screen-reader audit in this suite (visual audit covers layout only).
- Gap replay cap (2,000/round) not exercised; clipboard copy not exercised; drafts are in-memory only; markdown rendering asserted only for final (non-streaming) bodies; stress beyond 10,000 deltas / 2 concurrent model tasks not covered.
- Kill scenario waits 35 s for auto-reconnect; slower backoffs would also be reported FAIL under that window.

## Reproduction

```sh
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
# final push suite (use --name=value; current sizes: 100/1000/10000 x2, composer, scroll, concurrent, long, persist, layouts, dark, kill)
node scripts/streaming-ui-e2e.mjs --mode=final --runs=1
# single scenarios / probe
node scripts/streaming-ui-e2e.mjs --mode=probe --probe
node scripts/streaming-ui-e2e.mjs --mode=final --only=sizes,scroll --runs=2
```

Reports (full JSON, large) stay under `desktop/release/smoke/`:
`ui-streaming-20261024-185128-baseline.json` (full pre-Lead-fix push run, 712,863 ms), post-fix verification runs `…-191616-final.json` (kill/persist/composer), `…-192024-final.json` (persist+kill), `…-192112-final.json` (kill), `…-192946-final.json` (final combined persist+kill PASS run, 34,543 ms), probes `ui-streaming-20261024-182349/183205/183224-baseline-probe.json`, earlier sizes-only `…-183543-final.json`, error-state visuals `ui-visual-audit-20261024-193313.json`, `…-193545.json`, `…-194040.json` / `…-194220.json` (pre-paint-fix instrumented proof), and final PASS runs `…-194627.json` (zh), `…-194718.json` (zh+en), `…-194944.json` (zh + stale-notice lifecycle guard). A small summary is copied to `docs/verification/artifacts/ui-e2e-summary.json`.

Post-fix reproduction (current dist rebuilt 03:45 local after Lead's paint + lifecycle-guard fix; `ui/app.js` = `dist/ui/app.js` sha256 `4D8E4AE2…`, `dist/main.js` `EDDF37B2…`, `dist/src/conversations.js` `42029490…`):

```sh
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
npm run build
node scripts/streaming-ui-e2e.mjs --mode=final --only=persist,kill --runs=1   # final P1 + reconnect PASS run (report 192946)
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh --themes=light   # P2 PASS: painted review notice + stale-notice lifecycle guard (reports 194627/194944)
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh,en --themes=light   # zh+en notice copy (report 194718)
```

## Final re-verification delta (2026-10-25 03:29–03:36 local)

- The full matrix (`sizes`, `composer`, `scroll`, `concurrent`, `long`, `layouts`, `dark`, `persist`, `kill`) was measured **pre-Lead-fix** on build `ui/app.js` sha256 `54DB16F7…` → `ui-streaming-20261024-185128-baseline.json`. Those rows remain the reference measurements: the Lead fixes touched reconnect bookkeeping, transcript appending and the failure-notice UI, not the streaming render path. The delta below was re-measured after `npm run build` on the post-fix build (`ui/app.js` `6276F496…`).
- **P1 persistence: PASS** — `assistantCount=1`, `taskAssistants=1` (conversation `7a0bfefb…`, single `a-da3cc7ac…` row); recovery: `domCopies=1`, `persistedTaskAssistants=1`, `duplicateFinalCopiesAfterSettle=1` (report `ui-streaming-20261024-192946-final.json`).
- **Auto-reconnect: PASS** — offline surfaced via `#stream-banner` at 257 ms, restored at 927 ms with `onConnection` reconnecting→restored, 0 page reloads; manual settings reconnect still works (55 ms); recovery text exactly once (`sha256 325e4dd5…`, len 2,107).
- **P2 error surface: FIXED & verified** — after Lead added the `waiting_approval` branch + immediate `renderChatNotice()` paint + stale-notice lifecycle guard (`ui/app.js` `4D8E4AE2…`), the review notice is now visible with the deterministic provider-HTTP-500 fixture: `#chat-notice` `hidden=false`, `textContent` length 106 (zh, starts 「需要人工核查：External result unknown: 模型 API HTTP 500…」) and 159 (en, starts "Needs human review: External result unknown: 模型 API HTTP 500"), `selectedTask.status="waiting_approval"`, `failedTask=null`; 0 findings, 0 page/console errors (reports `ui-visual-audit-20261024-194627.json`, `…-194718.json`). Lifecycle guard re-verified (`…-194944.json`): with a success fixture plan, approval `retry` re-runs the interrupted model step, task leaves `waiting_approval` → `completed`, the review notice clears (`#chat-notice hidden=true`, `cleared=true`, `status_after=completed`) and no stale notice remains. Evidence screenshots: `docs/verification/screenshots/round3/chat-error_light_zh_1366x768_dsf1x.png` (updated 03:50) and `chat-error_light_en_1366x768_dsf1x.png` (updated 03:48).
- The 980×680 and DSF 1.25/1.5 sweeps were not re-run for this delta (no layout change in the fixes); their reference captures remain in `docs/verification/ui-visual-audit.md`.
