# UI visual audit — round 3 (streaming UI + theme)

Owner: T2 (ui-e2e), SuWen Desktop vNext round 3.
Every number below is measured against the **deterministic local fixture** (`desktop/scripts/visual-audit.mjs`): local HTTP OpenAI-compatible SSE server on `127.0.0.1`, no real vendor API, no external network. Screenshots are real Electron PNGs, not mocked.

## Environment

| Item | Value |
| --- | --- |
| Host OS | Windows 11 Home China 10.0.26200 (win32 10.0.26200) |
| CPU | Intel Core i7-14700HX, 20C/28T |
| RAM | 31.8 GiB |
| Host display | 2560×1600 class panel, host dpr 1.5, work area 1693×956 DIP |
| Host Node | v24.14.0 |
| Playwright | playwright-core 1.64.1 `_electron` |
| Electron | 45.0.0 (`desktop/node_modules/electron/dist/electron.exe`); app suwen-desktop 3.2.0 |
| UI build | `ui/app.js` sha256 `54DB16F7345ACA7CF5934065B111A38853488DA0B4442BD1B6FFE570B5595F53` (== `dist/ui/app.js`), `ui/index.html` sha256 `19A09EE7338561CE2B8EDA31AB3123AA3D3004871E6C9351370107170442B411`; dark theme + `#jump-latest` + `#stream-banner` present; dist rebuilt after Lead reconnect/persistence fixes |
| Launch | `_electron.launch({executablePath, args:[project,'--force-device-scale-factor=<dsf>'], env:{...process.env, SUWEN_TEST_HOME:<temp>}})` with inherited `ELECTRON_RUN_AS_NODE` deleted; window content size set explicitly via `BrowserWindow.setContentSize()` after first window |
| Isolation | one temp `SUWEN_TEST_HOME` profile per launch; fixture server closed; Electron killed in `finally` (bounded `app.close()` race + `taskkill /T /F`) |

## What was captured

Nine states per launch, each in **light and dark** and **zh and en**:

1. `chat-empty` — no conversation (welcome / empty state)
2. `workspace-projects` — project created
3. `workspace-tasks` — echo task created + task detail open
4. `workspace-tools` — MCP/skills/channels/RSI tabs
5. `workspace-settings` — model/diagnostics/defaults (includes `#defaults-theme`)
6. `chat-loading` — model task streaming, held open by fixture (SSE left open)
7. `chat-error` — provider HTTP 500 task
8. `evidence-panel` — `openEvidence()` with execution/context/evidence tabs
9. `chat-workspace` — conversation with completed assistant turn

Screenshot matrix (3 full audit runs + 5 targeted error-state re-captures, 180 unique stable PNGs; re-captures overwrite the same filenames):

| Run | Window content size | DSF values | Locales | Themes | Shots | Report |
| --- | --- | --- | --- | --- | ---: | --- |
| A | 1920×1080 and 1366×768 | 1, 1 | zh, en | light, dark | 72 | `desktop/release/smoke/ui-visual-audit-20261024-190507.json` |
| B | 1366×768 | 1.25, 1.5 | zh, en | light, dark | 72 | `desktop/release/smoke/ui-visual-audit-20261024-191042.json` |
| C | 980×680 | 1 | zh, en | light, dark | 36 | `desktop/release/smoke/ui-visual-audit-20261024-192156.json` |
| D (targeted) | 1366×768 | 1 | zh, en | light | 18 | `desktop/release/smoke/ui-visual-audit-20261024-193313.json` |
| E (targeted) | 1366×768 | 1 | zh | light | 9 | `desktop/release/smoke/ui-visual-audit-20261024-193545.json` |
| F (targeted, Lead `waiting_approval` notice fix) | 1366×768 | 1 | zh | light | 9 | `desktop/release/smoke/ui-visual-audit-20261024-194040.json` |
| G (targeted, instrumented DOM proof) | 1366×768 | 1 | zh | light | 9 | `desktop/release/smoke/ui-visual-audit-20261024-194220.json` |

Runs D/E were added after the Lead P2 fix to re-check the `chat-error` state with the rebuilt UI; they shorten the snapshot-poll wait (one 2,500 ms reconciliation cycle) and record the selected task status so a slow poll is not misreported as "notice missing". Run F repeats the same check on the rebuilt app after the Lead's second fix (explicit `waiting_approval` notice copy). Run G is instrumented: it records `S.chatNotice`, `S.reviewNoticeTask`, the waiting step `status/error`, `#chat-notice hidden/textContent length`, and a forced-`poll()` fallback, proving the notice state is computed but never painted. All targeted shots replace the same stable filenames for `1366×768@1×/light/zh|en`.

Files live in `docs/verification/screenshots/round3/` with stable names:
`<state>_<theme>_<locale>_<contentSize>_dsf<dsf>x.png`, e.g. `chat-empty_light_zh_1920x1080_dsf1x.png`, `workspace-settings_dark_en_1366x768_dsf1p5x.png`, `chat-error_light_zh_1366x768_dsf1p25x.png`.
At DSF≠1 the PNG is the physical-pixel capture: 1366×768 DIP at 1.25× → 1709×964 px; at 1.5× → 2051×1155 px. 1920×1080 at 1× is exactly 1920×1080 px.

## Programmatic checks (every screenshot)

For each capture the script evaluated, in-page, after the state was reached:

- viewport `innerWidth/innerHeight/devicePixelRatio`; `documentElement.lang`; `#language` locale state.
- theme: `html[data-theme]`, `html[data-theme-mode]`, computed `body` background/color, `#defaults-theme` value; dark run asserts `data-theme === "dark"` **before** capturing (theme control exercised through the real `#defaults-theme` select handler, not by injecting CSS).
- document/body horizontal overflow (`scrollWidth - clientWidth`, body scroll), vertical page overflow.
- bounding rects of rail, sidebar, main, header, timeline, composer, evidence aside, `#prompt`, `#send`, `#page-title`.
- elements outside viewport (`right > innerWidth + 1` / `bottom > innerHeight + 1` / negative x/y).
- pairwise overlap of rail↔sidebar↔main↔header↔timeline↔composer↔evidence.
- internal horizontal overflow of every element (`scrollWidth - clientWidth > 2`).
- state assertions: active page count, page title, message counts, assistant body length, streaming bubble presence, `#stream-banner` text/visibility, evidence open state/content length/tabs, error banner + `#chat-notice` visibility.
- page errors and console errors collected per launch.

Aggregate result across runs A, B, C (180 full-matrix shots) plus targeted re-captures D, E, F, G (63 shots):

- document/body horizontal overflow: **0**; vertical page overflow: **0**.
- elements outside viewport: **0**.
- overlap findings: **0**.
- internal horizontal overflow findings: **0**.
- `darkThemeImplemented`: `true`; all dark shots verified `html[data-theme=dark]`, dark `bodyBackground` (e.g. `rgb(18, 23, 26)`), `#defaults-theme=dark`.
- page errors: **0**; console errors: **0** (all runs).
- language/state assertions matched the requested locale in every shot.
- targeted runs D/E/F/G reproduce the same single P2 `chat-error` row and zero layout defects; they are part of the P2 evidence below, not new layout findings.

Representative key rects at 980×680 (run C, light zh, chat-empty; CSS px): rail `x=0 w=56`; sidebar `x=56 w=212`; main `x=268 w=712`; header `h=56`; timeline `y=56 h=511` bottom 567; composer `y=567 h=113` bottom 680; `#prompt` `x=288 w=597.5 h=56`; `#send` `x=895.5 w=64.5 h=40`, right 960. The rail/sidebar widths shrink from 64/244 to 56/212 at this breakpoint, and everything still fits inside 980 px with no page scroll. With the evidence panel open at 980×680 (run C, light zh): main `w=372`, evidence aside `x=640 w=340 right=980`, composer `h=147`, `#prompt`/`#send` still inside the timeline column — no overlap.

Representative composer geometry at 1920×1080 DSF1 (run A, chat-empty, light zh): composer `x=308 y=938 w=1612 h=117 bottom=1055`, fully inside the 1080 px viewport with 25 px bottom margin; `#prompt` `x=340 w=1473.5`, `#send` `x=1823.5 w=64.5 right=1888` inside `main` (right edge 1920). At 1366×768 with evidence open (run A, dark zh): main `w=658`, evidence `x=966 w=400 right=1366`, timeline bottom 626, composer `y=626 h=117` — no overlap or clipping.

## Findings

| Sev | Area | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| P2 | error state | `chat-error` state (deterministic provider HTTP 500): the selected chat task ends **`waiting_approval`, not `failed`** (`store.ts:321` routes non-definitive side-effect failures to approval before retry; all chat-originated step kinds are side-effecting). Lead added a `waiting_approval` branch to `syncChatFailureNotice()` that sets `S.chatNotice` + `S.reviewNoticeTask`; the first attempt computed the state but did not paint it (`#chat-notice hidden=true`, textLength 0 in runs F/G). Lead then added an immediate `renderChatNotice()` call in both notice branches plus a stale-review-notice lifecycle guard. Final verification: `#chat-notice` `hidden=false`, textLength **106** zh (starts 「需要人工核查：External result unknown: 模型 API HTTP 500…」) and **159** en (starts "Needs human review: External result unknown: 模型 API HTTP 500"), `selectedTask.status="waiting_approval"`, `#error` hidden; approval `retry` with a success fixture plan re-runs the interrupted model step → status `completed`, notice clears (`hidden=true`, `cleared=true`), no stale notice. | `docs/verification/screenshots/round3/chat-error_light_zh_1366x768_dsf1x.png` (updated 03:50), `chat-error_light_en_1366x768_dsf1x.png` (updated 03:48); reports `ui-visual-audit-20261024-194627.json` (zh), `…-194718.json` (zh+en), `…-194944.json` (zh + lifecycle guard); pre-fix proof `…-194040.json` / `…-194220.json`. | **FIXED** (verified, build `ui/app.js` `4D8E4AE2…`) |
| — | theme | Dark theme implemented and verified; pre-fix baseline UI had no dark theme (`NOT_IMPLEMENTED` in the earlier plan). | dark shots in all runs; `#defaults-theme` visible in `workspace-settings_dark_*.png` | DONE |
| — | layout | No P0/P1 layout defects found: no overflow/overlap/outside-viewport at 1920×1080@1×, 1366×768@1×/1.25×/1.5×, 980×680@1×, zh/en, light/dark. | run JSON `coverage` + per-shot `checks` | PASS |

Notes:

- The `chat-error` P2 is a **functional state-visibility** gap, not a layout failure; layout checks pass in that same capture. Lead's first notice fix correctly computed the review notice text and set the one-notice-per-task guard, but the paint call was missing on the polling path, so the user-visible outcome was unchanged (runs F/G, reports 194040/194220). Lead's follow-up added the immediate `renderChatNotice()` paint plus a stale-notice lifecycle guard: runs H/I/J now show the painted notice (`hidden=false`, textLength 106 zh / 159 en) and a retried interrupted task leaves `waiting_approval` → `completed` with the notice cleared (report 194944, `notice-guard pass=true status_after=completed hidden_after=true cleared=true`). P2 is FIXED at `ui/app.js` `4D8E4AE2…`, re-verified on the deterministic fixture.
- An earlier revision of this document said the fixture-500 task "ends `failed`"; targeted post-fix runs show its actual terminal status is `waiting_approval` (side-effect reconciliation design), verified by DOM sampling (`checks.error.selectedTask`, `selectedSteps`) rather than assumed.
- The duplicate-persisted assistant messages previously found by `streaming-ui-e2e.mjs` were fixed by the Lead's task-scoped single-writer merge and re-verified there (`ui-streaming-20261024-192946-final.json`, 1 assistant row); static visual-audit states do not assert transcript uniqueness.
- No contrast, color-blind, screen-reader, keyboard-tab-order, or accessibility-tree audit was performed here; do not cite this document for WCAG/contrast compliance. Colors are only reported as computed `bodyBackground`/`bodyColor` values in the JSON.

### Layout findings by resolution / DPI / locale

Each cell = screenshots captured for that combination (9 states); **0** layout findings (no overflow/overlap/outside-viewport/internal overflow) in every cell. The only finding in each launch was the same P2 `chat-error` state-visibility row (deduplicated in JSON), which is not a layout defect.

| Content size @ DSF | zh light | zh dark | en light | en dark | Layout findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1920×1080 @ 1× | 9 | 9 | 9 | 9 | 0 |
| 1366×768 @ 1× | 9 | 9 | 9 | 9 | 0 |
| 1366×768 @ 1.25× | 9 | 9 | 9 | 9 | 0 |
| 1366×768 @ 1.5× | 9 | 9 | 9 | 9 | 0 |
| 980×680 @ 1× | 9 | 9 | 9 | 9 | 0 |

## Limitations

- Deterministic local fixture only; states are produced by scripted bridge calls (`project.create`, task `create`, `openEvidence`, etc.) through the real UI controls where possible; no live provider, no network latency/rate-limit behavior.
- Window sizes are CSS content sizes; the OS clamps a window to the work area, so 1920×1080 at DSF>1 (≥2400 physical px needed) is not obtainable on this 2560×1600/150 % host — high-DPI coverage therefore uses 1366×768 (1.25×, 1.5×), 980×680 is captured at 1× only (its 1.25×/1.5× variants were not run), and 1920×1080 is covered at 1× plus the e2e layout scenario at host dpr 1.5 (clamped to 1693×956 DIP).
- Screenshots are captured window content only (no OS chrome/tray/notifications/multi-display); single GPU/driver; one host.
- DOM-geometry checks only — no OCR/pixel-diff baseline, no animation-mid-frame capture; `chat-loading` is captured while SSE is held open, so its exact text length is timing-dependent (recorded per shot).
- `chat-error` repro relies on fixture HTTP 500; other failure classes (auth 401, malformed stream, timeout) not screenshotted.
- Screenshot downscaling in review tools may blur small text; the PNGs on disk are full-resolution physical pixels (sizes listed in JSON `png.width/height`).

## Reproduction

```sh
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
# run A: exact 1920x1080 + 1366x768 at 1x, zh/en, light/dark
node scripts/visual-audit.mjs --sizes=1920x1080,1366x768 --dsf=1
# run B: 1366x768 at 1.25x and 1.5x
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1.25,1.5
# run C: 980x680 at 1x
node scripts/visual-audit.mjs --sizes=980x680 --dsf=1
# run D/E: targeted chat-error re-capture after the Lead P2 fix (zh+en, then zh)
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh,en --themes=light
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh --themes=light
# run F/G: rebuilt app after the Lead's waiting_approval notice fix; G records S.chatNotice/reviewNoticeTask/
# waiting-step error plus a forced poll() fallback (reports 194040/194220) — first attempt: state set but not painted
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh --themes=light
# run H/I: final PASS after the Lead's paint + lifecycle-guard fix (zh only; zh+en)
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh --themes=light
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh,en --themes=light
# run J: lifecycle guard (notice painted -> approval retry with success fixture plan -> notice cleared); report 194944
node scripts/visual-audit.mjs --sizes=1366x768 --dsf=1 --locales=zh --themes=light
```

Reports: `desktop/release/smoke/ui-visual-audit-<stamp>.json`; screenshots: `docs/verification/screenshots/round3/`.

Post-fix targeted evidence for the P2 row (final, PASS): `desktop/release/smoke/ui-visual-audit-20261024-194627.json` (zh) — `#chat-notice hidden=false textLen=106`, text starts 「需要人工核查：External result unknown: 模型 API HTTP 500…」, `selectedTask.status=waiting_approval`, 0 findings; `…-194718.json` (zh+en) — same zh values plus en `hidden=false textLen=159` ("Needs human review: External result unknown: 模型 API HTTP 500"), 0 findings; `…-194944.json` — lifecycle guard `notice-guard pass=true`, approval retry with success fixture plan → `status_after=completed`, `hidden_after=true`, `cleared=true`, 0 findings. Pre-fix instrumented proof remains in `…-194040.json` / `…-194220.json` (`S.chatNotice` set, `#chat-notice hidden=true textLen=0`). Stable screenshots: `chat-error_light_zh_1366x768_dsf1x.png` (03:50), `chat-error_light_en_1366x768_dsf1x.png` (03:48). Build under test: `ui/app.js` / `dist/ui/app.js` sha256 `4D8E4AE2B22B7B4142F0F6B256232B1269600D91E9CD76770DC9012E6681188D`.
