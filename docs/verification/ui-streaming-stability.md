# UI streaming stability and theming (round 3, desktop-vnext)

Status: verified on Windows, node 24.14.0, desktop 3.2.0. Owner: T1 (streaming-ui).
Protocol contract: `docs/architecture/streaming-events.md` (frozen v1) and
`desktop/src/stream-events.ts`. This document records what the renderer implements, how it was
verified, and what is deliberately not covered.

## 1. Files changed

| File | Change |
| --- | --- |
| `desktop/ui/stream-core.js` | New, ~518 lines. Pure DOM-free reducer for `StreamBatch` (dedupe, ordering, gap/replay, reset, stream buffers, run state machine, scroll-intent predicate). Classic script, attaches `SuwenStreamCore` (and the contract spelling `SuWenStreamCore`) to `globalThis`, also exports via `module.exports` for `node:vm` tests. |
| `desktop/ui/markdown.js` | New, ~390 lines. Safe markdown subset parser + DOM renderer (`SuwenMarkdown`), `textContent`-only, no raw HTML, optional copy button injected by the caller. |
| `desktop/ui/app.js` | Push streaming integration, incremental stream painting, connection banner, theme control, structural `chatSignature`, snapshot poll 800 ms -> 2500 ms, per-conversation composer draft preservation, IME-safe Enter, jump-to-latest affordance, display-only step activity, copy-code button, unhandled-rejection surface, and the chat request payload fix (each model step sends its current instruction as the final `user` turn inside `messages[]`). |
| `desktop/ui/index.html` | Adds `#stream-banner` (role=status, hidden by default), `#jump-latest` (UI-only), three-state `#defaults-theme` select, version 3.2.0, `<script src="stream-core.js">` + `<script src="markdown.js">` before `app.js`. All previous DOM ids and `data-i18n` attributes kept. CSP unchanged. |
| `desktop/ui/style.css` | Palette rewritten as CSS custom properties (light + `:root[data-theme="dark"]` + OS-following fallback), stream banner, markdown containers, responsive breakpoints (1200/1080/900/700 px and short-height), reduced-motion support. |
| `desktop/ui/actions.json` | `auto-stream-replay` (`events.replay` bridge call) and `theme-select` (`defaults.set` preference key `theme`); `auto-poll-snapshot` notes updated to the reconciliation poll. 144 actions total. |
| `desktop/scripts/ui-dom-qa.mjs` | `BRIDGE_METHODS` now includes `events.replay` (main-process bridge outside `RPC_METHODS`). Still static-only, no runtime claimed. |
| `desktop/test/stream-core.test.ts` | New `node:test` suite, 23 tests, loads `ui/stream-core.js` through `node:vm` in a DOM-free sandbox (plus one app-level payload regression that extracts `chatSteps`/`buildHistory` from `ui/app.js`). |
| `docs/verification/ui-streaming-stability.md` | This document. |

No `desktop/src/**` file was modified and no `desktop/package.json` change was needed.

## 2. Transport and ordering

* Primary transport is push. `preload` exposes `window.suwen.onEvent(handler)`; each batch
  (`{schemaVersion, cursor, reset?, tasks[], events[], streams[]}`) is handed to
  `SuwenStreamCore.applyBatch`. The renderer never calls `events.stream` (main-process-only).
* Gaps (an envelope `sequence` larger than `lastSequence + 1`) issue exactly one
  `window.suwen.call('events.replay', {since: lastSequence, limit: 2000})` through the main
  bridge, which forwards to the daemon `events.stream` with the same batch shape. Replays are
  capped at 3 consecutive attempts per connection (`maxReplayAttempts`); after that the slow
  snapshot reconciliation becomes the repair path and the UI shows a replay-failure notice.
* Ordering/duplicate rules live in the pure reducer: envelope sequence is daemon-global and
  strictly increasing, so tracking is global (per-task counters would false-positive whenever
  another run emits between two events of this run). Duplicate `eventId`s are dropped through a
  bounded LRU (10,000 ids, oldest evicted). Out-of-order envelopes are counted stale and never
  move state backwards. Events inside one batch are sorted by sequence before applying.
* Terminal runs are immutable: once a task reaches `completed`/`failed`/`cancelled`, later
  envelopes and stream snapshots produce zero writes. The sequence counter still advances so a
  late event for a finished run can never make a healthy run look like a gap.
* `reset: true` batches (daemon reconnect) bump the store epoch, clear seen ids and sequence
  state, rebuild from `tasks[]` + `streams[]`, and force the chat view to rebuild once. Drafts,
  scroll position and composer state are never touched by reset.
* Concurrent runs stay isolated by `taskId`; text can never move between conversations. A
  terminal run does not freeze the other one.
* Connection states from `window.suwen.onConnection`: `reconnecting` shows a non-blocking banner
  (composer and draft stay usable, nothing is cleared), `restored` clears the replay budget,
  refreshes one snapshot and toasts, `lost` shows a persistent error banner and disables send
  until the connection returns (Settings -> reconnect is the manual fallback).
* Reconciliation fallback: `snapshot` is polled every 2500 ms (>= 2000 ms requirement). It
  fills missing text after a reset, and fills text when the push bridge is unavailable. The
  push stream always wins when both have text; the longer text is displayed, never a shrink.

## 2a. Chat request payload (P0 found by T2, fixed in the UI)

T2's Electron provider fixture found that chat model steps sent only the system message to
`/v1/chat/completions`. Root cause: `src/activities/model.ts` treats `input.messages` as final
when it is an array (line 38-40) and only loads conversation history when `messages` is absent
(line 43); it then ignores `input.prompt`. The UI's `buildHistory()` compiled only completed-task
history and never included the current user turn, so first turns and isolated turns reached the
provider without the typed prompt (and mode-specific instructions such as the synthesis or
critique prompt were dropped too).

Fix (UI-only, `desktop/ui/app.js`): `chatSteps()` wraps every model step's actual instruction as
the final `{role:'user', content}` entry of `messages[]` (`turn()` helper); `buildHistory()` now
emits `{role, content}` pairs (what `model.ts` reads first), keeps the system turn pinned when
trimming to 16 entries, and clips transcript entries the same way the daemon does (6000 chars
with a truncation marker). Research/debate/autonomy steps carry their own transformed instruction
instead of the raw user prompt. Regression test added to `stream-core.test.ts` ("chat model steps
carry the current user turn and mode instruction inside messages[]"); T2 re-runs the provider
fixture end-to-end.

## 3. Streaming rendering

* Stream buffers are full current text. The reducer compares each new snapshot with the last
  known text for the same `taskId`/`stepId`: prefix -> one appended suffix (delta), otherwise a
  step change -> replace. No character is ever dropped by throttling.
* Painting is coalesced: batches mark the view dirty and one `requestAnimationFrame` callback
  paints at most once per frame. If there is an append delta, only a text node is appended to
  the existing `.body` (textContent-based DOM, no HTML parsing); the message article is not
  rebuilt. `chatSignature` deliberately excludes streamed text length, so token bursts do not
  re-create the timeline or move the composer.
* Scroll intent: user scrolling up sets intent `up` and streaming stops auto-following;
  scrolling back to the bottom (within 120 px) re-arms `down`. Programmatic scrolls land at the
  bottom and are therefore consistent with the intent heuristic. Measured in the reducer tests
  as a pure predicate. While a run is active and the reader is scrolled up, a `#jump-latest`
  button appears (UI-only, `method: null`); clicking it re-arms follow and scrolls to the end.
* Composer draft is preserved per conversation in memory (`S.drafts`), restored when switching
  conversations and never written by streaming/theme re-renders; Enter during IME composition
  (`event.isComposing` / keyCode 229) does not submit.
* Step activity is a display-only `<details>` projection of `status · kind · step id`; model or
  tool parameters are never copied into the chat transcript (they remain in the evidence panel).
* Async UI rejections (draft/theme/replay paths) are surfaced through the existing `#error`
  alert instead of becoming silent unhandled rejections.
* The composer (`#composer`, `#prompt`, `#send`) is outside the timeline and no streaming code
  path writes to it, so its bounding box is unaffected by a delta burst; drafts stay in the
  textarea. T2 (ui-e2e) owns the pixel-level composer-stability assertion.
* Streaming messages stay plain text. Markdown is only rendered for completed assistant
  messages (and never for user text), so partially streamed syntax never flickers.
* At most one banner state is visible: `preparing`, `tool_running`, `waiting_approval`,
  `compacting`, `paused`, `cancelling`, `reconnecting`, `lost`, or hidden. Terminal states are
  shown on the message itself.

## 4. Markdown subset (completed messages only)

Supported: headings (h1-h3), paragraphs, **bold**/*italic*, `` `inline code` ``,
fenced code blocks with a language label, flat ordered/unordered lists, pipe tables with a
header separator, blockquotes, horizontal rules, and `[text](https://...)` links. All text is
created with `document.createElement` + `textContent`; raw HTML is displayed as literal text,
never parsed. Code blocks and tables are wrapped in overflow containers
(`.md-code-scroll`, `.md-table-scroll`) so they scroll locally instead of widening the page.

Degradations (honest limitations):

* Raw HTML is inert (shown as text), by design.
* LaTeX (`$$...$$`, `\[...\]`, `\(...\)`) is not typeset; it degrades to a code block labelled
  `latex (not rendered)`.
* Mermaid fenced blocks are not rendered; they degrade to a code block labelled
  `mermaid (not rendered)`.
* Only `http(s)` URLs become anchors; other schemes stay visible text. Anchors render with the
  URL as text; actually opening an external browser depends on main-process navigation policy
  and was not verified here.
* The parser is an intentional subset, not CommonMark: no nested lists (depth > 1 is flattened),
  no reference links, no images, no strikethrough, no bare-URL autolinking, no language-specific
  syntax highlighting.

## 5. Theme (light / dark / system)

* Palette tokens (`--bg`, `--surface*`, `--text*`, `--border*`, `--accent*`, `--code-*`,
  `--notice-*`, `--danger/--ok/--warn`, `--banner-*`, shadows) are defined once in `:root`
  (light) and overridden by `:root[data-theme="dark"]`. A `@media (prefers-color-scheme: dark)`
  block covers the fallback where the `data-theme` attribute is absent.
* Settings -> Interface theme is a three-state select (`#defaults-theme`: system / light /
  dark), bilingual (`data-i18n`), persisted through the existing `defaults.set` preference key
  `theme` and mirrored to `localStorage('suwen.theme')` so `boot()` applies it synchronously
  before the first chat render. `system` follows `matchMedia('(prefers-color-scheme: dark)')`
  and listens for OS changes.
* `applyTheme` only sets `data-theme`/`data-theme-mode` attributes; no DOM rebuild, no layout
  shift, no animation. Electron renderer CSP is unchanged.
* Limitations: contrast ratios were tuned by hand (dark text on dark surfaces targets >= 4.5:1
  for body text) but no automated accessibility contrast audit was run; Windows forced-colors
  and high-contrast OS modes are not specially handled. Pixel verification in both themes is
  T2's screenshot pass.

## 6. Responsive layout

* Breakpoints: 1200 px (evidence panel 400 -> 340), 1080 px (narrow rail/header/composer
  padding), 900 px (stacked cards and detail panels), 700 px (compact composer), plus a
  short-height tweak so the composer stays visible. Long ids/labels use `overflow-wrap:anywhere`
  and `min-width:0` so no horizontal page scroll is introduced.
* Static verification only from T1: `ui-dom-qa.mjs` passes and the CSS has no fixed widths that
  exceed 980 px; device-scale-factor screenshots at 125%/150% zoom and 980x680 / 1366x768 /
  1920x1080 are T2's E2E responsibility. Composer is a grid child with `flex-shrink: 0` and the
  timeline is the only scrolling region.

## 7. Test evidence (commands and counts)

Run from `desktop/`:

```
npx tsc -p tsconfig.json --noEmit     # exit 0
npm run build                          # exit 0 (tsc + copy-assets)
node --check ui/app.js                 # OK (also ui/stream-core.js, ui/markdown.js)
node --test dist/test/stream-core.test.js
# tests 23, pass 23, fail 0
node scripts/ui-dom-qa.mjs
# 19 passed, 0 failed, 12 warnings; 144 actions, 80 RPC methods
```

`stream-core.test.ts` covers, loading `ui/stream-core.js` via `node:vm` with no DOM globals:

1. 100 / 1,000 / 10,000 single-character deltas reconstructed exactly (no loss, duplication or
   reordering; measured on the reducer, not on GPU paint).
2. UTF-16 surrogate pairs split across appended suffixes keep both code units and the final
   string length.
3. Duplicate `eventId`s and repeated unchanged stream snapshots write nothing twice.
4. Out-of-order envelopes are stale and never move state backwards.
5. Events in one batch are applied in ascending sequence order.
6. A gap requests exactly one replay; the gap resolves when the replay arrives; attempts are
   bounded (3) so a permanently missing event cannot loop.
7. `reset` drops per-run caches, advances the epoch and rebuilds from the batch.
8. Late events/deltas after a terminal run are ignored (0 writes); a terminal run cannot freeze
   the other concurrent run.
9. Two concurrent runs are isolated by `taskId`.
10. Scroll intent: only an explicitly pinned or near-bottom reader follows.
11. Run state machine walks queued -> tool -> streaming -> approval -> compacting -> paused and
    maps completed/failed/cancelled; transport `reconnecting` overrides active runs but never a
    terminal run.
12. Unknown protocol event types are observable but never corrupt status/text; an unknown
    schema version is reported while additive fields still apply.
13. Snapshot reconciliation can complete a live task but cannot shrink its text; a step change
    replaces text while the same step only ever appends.
14. Dedupe memory is bounded by `maxSeen`; invalid batches are rejected without throwing or
    mutating the store; stats expose the counters used above.
15. Chat request payload regression: the extracted `chatSteps`/`buildHistory` send the current
    user turn (chat), the synthesis instruction (research) and each debate instruction as the
    final `user` entry of `messages[]`, with `content` fields and a bounded 16-entry history.

`ui-dom-qa.mjs` additionally proves the frozen CSP, all 43 required ids, 168 `data-i18n`
attributes resolved against 670 bilingual keys, 271 `t()` references resolved, no dynamic
`innerHTML`, no eval/new Function, no legacy brand, and action-method coverage. The final run
reports `19 passed, 0 failed, 12 warnings; 144 actions, 80 contract RPC methods`; every warning
is a pre-existing main-process bridge method plus `events.replay`.

## 7a. T2 renderer measurements and follow-up fixes

T2 measured with the deterministic fixture (100/1000/10000 deltas): 100 deltas rendered in
~3.5 s, 1000 in ~16 s, 10000 in ~157 s, i.e. ~60-64 deltas/s largely independent of stream
size. Two observations followed:

* Auto-follow was lost on the 10000-delta run (final `scrollTop` 0, bottom gap ~14024 px).
  Cause: replacing timeline nodes clamps `scrollTop` to 0, and the scroll listener treated that
  clamp as a user scroll-up, which disabled follow for the rest of the run. Fixed: programmatic
  scrolls are tagged (`S.stream.programmaticUntil`, 400 ms window), `renderChat` captures follow
  intent and reading position before `replaceChildren` and restores it afterwards, and
  `#jump-latest` explicitly re-arms follow. Re-measurement is T2's pass.
* Throughput attribution: the UI has no per-delta playback queue - one rAF paint appends all
  accumulated text. Flat ~16 ms/delta at 100/1000/10000 deltas therefore indicates upstream
  event cadence (daemon persistence + IPC batch arrival), not frame rendering. The renderer
  exposes `window.__suwenStreamDebug()` (batch count/timestamps, paint count/total paint ms,
  painted chars per task) so T2 can compare batch cadence with painted growth without any
  behaviour change. A real provider below ~60 deltas/s stays well inside budget either way.

## 8. Remaining limitations / not covered here

* T1 did not launch Electron; UI E2E (kill daemon -> reconnect, composer bbox < 1 px during a
  500-delta stream, two-run isolation in the real renderer, both themes and zoom screenshots) is
  T2's acceptance pass.
* The chat payload fix is covered by a unit-level regression test that executes the real
  `chatSteps`/`buildHistory` from `ui/app.js`; provider-level end-to-end confirmation (fixture
  request body containing the typed prompt) is T2's re-run, not T1's.
* Performance was measured on the pure reducer and batch sizes, not frame times in Electron;
  the rAF coalescing is a design guarantee, not a benchmark.
* Composer drafts are in-memory only: they survive conversation switches, streaming and theme
  changes, but not a window reload/crash. No draft is written to disk by the renderer.
* `#jump-latest` only appears while a run is active and the reader has scrolled up; it is not a
  runtime-verified pixel result (T2's E2E pass owns that).
* The copy-code button uses `navigator.clipboard.writeText` with a legacy `execCommand('copy')`
  fallback; clipboard permission behavior inside the Electron renderer was not exercised by T1.
* Markdown copy labels are passed in by `app.js`; `markdown.js` renders no button by itself and
  stays free of network/clipboard dependencies.
* Replay limit is 2000 events per request (main-process clamp). A gap larger than that needs
  more than one replay round; beyond 3 failed rounds the UI falls back to the 2500 ms snapshot
  reconciliation and says so.
* A renderer without the preload bridge (`onEvent` missing) degrades to the snapshot-only path:
  text still appears (reconciliation fallback), but there is no live banner or replay.
* Markdown and theme limitations are listed in sections 4 and 5.
* The 10000-delta wall time quoted in 7a was measured before the scroll fix; re-measurement and
  the final throughput attribution (daemon/IPC cadence vs renderer) are T2's E2E pass.
  `window.__suwenStreamDebug()` is renderer-only debug introspection and adds no production
  behaviour.
* No backend change is required: `events.replay` is already in `main.ts` `UI_MAIN_METHODS`, the
  daemon `events.stream` handler already emits the batch shape, and the `theme` preference key is
  already supported by `defaults.get`/`defaults.set`.


## Post-fix T2 re-runs (supersede interim failures)

Interim reconnect/duplicate failures are superseded: auto-reconnect after daemon SIGKILL PASS 3/3; duplicate assistant persistence RESOLVED (taskId+role merge + 4 regression tests; Lead persist re-run 0 findings, `desktop/release/smoke/ui-streaming-20261024-192807-final.json`); failed-turn error surface FIXED and T2-verified (reports ui-visual-audit-20261024-194627/194718/194944.json (zh notice len 106, en len 159, hidden=false; stale-notice guard clears after retry; build ui/app.js 4D8E4AE2…)).
