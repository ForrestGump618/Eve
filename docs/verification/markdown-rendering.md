# Markdown rendering: KaTeX math, Mermaid diagrams, progressive streaming safety

Status: implemented (round 4 task-11: typeset completed messages; round-5 task-11 extension:
progressive streaming-safe Markdown). Owner: streaming-ui. Scope: `desktop/ui/markdown.js`,
`desktop/ui/app.js` (Markdown render portions), `desktop/ui/style.css`, `desktop/ui/index.html`
(stylesheet link only), `desktop/test/markdown.test.ts`, this document. No backend changes.

## 1. What changed and why

Round 4 addressed **completed** answers: LaTeX and Mermaid used to degrade to labeled code blocks;
they are now typeset by real offline KaTeX / Mermaid bundles, while streaming output stayed plain
text. That left part of the round-3 streaming matrix NOT_VERIFIED (a table/code block/answer only
became Markdown after completion).

Round 5 (this extension) renders a **stable prefix of the streaming assistant text as Markdown while
deltas arrive**:

- *stable* = everything up to the last closed block boundary (paragraph end, closed list, closed
  fenced block, closed `$$`/`\[` math, or a table whose separator and at least one body row are
  terminated);
- the incomplete tail (open fence/math, partial table row, partial word, lone `$`) stays **plain
  text** and is never typeset;
- the body is rebuilt at most ~110 ms apart, replacing only the message body; between rebuilds the
  tail text node is updated in place, so the DOM does not churn and the composer is never touched;
- `SuwenStreamCore` remains authoritative for the text; the Markdown layer never invents characters.

Completed messages still get the full render plus KaTeX/Mermaid upgrades.

## 2. Files

| File | Change |
| --- | --- |
| `desktop/ui/markdown.js` | Rewritten (~1050 lines): math/diagram tokenization with open-delimiter state; **progressive planner** (`stableScan`/`stablePrefix`/`planProgressive`), progressive DOM renderer (`renderProgressivePlan`/`renderProgressive`), pure helpers, safe DOM builder, lazy vendor loading + enhancement queue, theme refresh. |
| `desktop/ui/app.js` | `markdownRenderOptions` shared by completed + streaming paths; `messageBubble` adds a Markdown body only when complete; `registerStreamNode` keeps per-message `{ body, plan, stableChars, renderedAt, renderTimer }`; `applyStreamTextPatches` runs the progressive plan on each paint (`STREAM_MARKDOWN_INTERVAL = 110`), defers Mermaid (`allowDiagrams: false`) and follows scroll intent. |
| `desktop/ui/style.css` | Progressive tokens: `.message .body.progressive` (normal white-space) and `.md-stream-tail` (pre-wrap, anywhere wrapping); math/diagram/fallback rules from round 4 unchanged. |
| `desktop/ui/index.html` | Only `<link rel="stylesheet" href="vendor/katex/katex.min.css">` after `style.css`. CSP stays the frozen round-3 value (`script-src 'self'`, `style-src 'self'`, `connect-src 'none'`, no inline script). |
| `desktop/test/markdown.test.ts` | **32** `node:test` cases loading the real `ui/markdown.js` through `node:vm` (no DOM): 26 round-4 cases + 6 progressive cases. |
| `desktop/scripts/copy-assets.mjs` | Pre-existing Lead prep: copies `katex.min.{css,js}`, its 60 font files and `mermaid.min.js` into `dist/ui/vendor/` at build time (not edited by T1). |

Assets are served from the same `file://` origin as `dist/ui/index.html`, so the frozen CSP needs no
new directive. Electron loads the built copy (`desktop/src/main.ts` resolves `../ui/index.html`
relative to the compiled main file, i.e. `dist/ui/index.html`), which is why `npm run build` must be
run before launching the preview UI.

## 3. Tokenizer and stable block boundaries

`parse(text)` returns typed blocks: `heading`, `paragraph`, `code`, `diagram` (mermaid only), `math`
(block), `list`, `table`, `quote`, `hr`. `analyze(text)` additionally reports which trailing
delimiter is still open.

For streaming, `stableScan(source)` walks the normalized text line by line and tracks the last
*boundary*:

- a paragraph/heading/list/quote/hr line is stable only once its newline has arrived; a final partial
  line is always tail;
- a fence is stable only after a non-indented closing marker; an unclosed fence keeps the tail plain;
- `$$…$$` / `\[…\]` math is stable only after the matching close line;
- a table is stable only once the separator row **and at least one terminated body row** exist (so
  "|a|b|\n|--|--|\n|1 |" stays plain until the row's newline arrives);
- a trailing newline belongs to the prefix only outside an open block.

`planProgressive(text, previous)` returns `{ stableChars, stable, tail, tailChars, blocks, open }`.
When the stable prefix has not moved it reuses the previous block array (only the linear line scan
runs); when it moved it re-tokenizes the prefix. It double-checks that `parse(stable)` has no block
marked `closed === false` and degrades to plain text if that ever happened (defensive). CRLF input is
normalized exactly as in round 4.

Non-mermaid fences are ordinary code blocks; ```mermaid inside an ordinary fence is never a diagram;
escaped `\$` is literal text; raw HTML model output remains a paragraph string. Inline math rules:
`$...$` and `\(...\)` only, never `$$` inline, opening/closing dollar may not sit on whitespace, a
lone/unmatched dollar stays literal, inline code spans are skipped, at most 4000 chars per math span.
Diagrams are capped at 20000 chars, whole messages at 200000 chars.

## 4. Progressive rendering pipeline (no raw HTML)

`renderProgressivePlan(doc, plan, options)` appends `plan.blocks` with the same safe builders as
`render()` (`createElement`, `createTextNode`, `appendChild`, `setAttribute`, `textContent`; no
`innerHTML`/`insertAdjacentHTML`/`document.write`) and then appends the open tail inside
`<div class="md-stream-tail">` as a single text node. In the live path `applyStreamTextPatches`:

1. reads `streamTextFor(task)` (SuwenStreamCore text, snapshot text as reconciliation fallback);
2. derives `planProgressive(text, previousPlan)`;
3. if `stableChars === 0` shows `plan.tail` as plain text (cheapest safe state);
4. otherwise, when `≥ 110 ms` passed since the last rebuild and the stable prefix grew,
   `replaceChildren(renderProgressivePlan(...))` and marks the body `.markdown.progressive`;
5. between rebuilds only the existing `.md-stream-tail` text node is updated (created on demand), so
   no closed block node is ever duplicated and no character waits for the throttle;
6. completed messages are re-rendered by `renderChat` via `messageBubble(..., { markdown: true })`,
   then `enhance()` applies KaTeX/Mermaid.

Diagrams are explicitly **not** upgraded during streaming (`allowDiagrams: false`): Mermaid layout is
expensive and re-rendering it for every closed block would flicker. Complete inline/block math inside
already-closed blocks may be upgraded during streaming; failing upgrades fall back to readable
source text. Layout shift is bounded to the moment a block closes (e.g. a table gaining `<table>`
markup) and the scroll response respects the user's intent (auto-follow only when they are pinned at
the bottom).

## 5. KaTeX upgrade (lazy, once)

`enhance(container, options)` scans placeholders, marks them `data-md-state="queued"` and pushes them
into a single global queue. `processQueue` runs for at most **8 ms per tick**, re-scheduled with a
16 ms timer. KaTeX is loaded exactly once through a dynamically appended
`<script src="vendor/katex/katex.min.js">` (allowed by `script-src 'self'`; no inline code, no
`eval`, no network). `katex.render` uses `displayMode` from the block, `throwOnError: true`,
`trust: false`, `strict: 'ignore'`, `maxSize: 20`, `maxExpand: 1000`, `output: 'html'`. On failure the
placeholder is replaced with a labeled `<code class="md-math-source">` fallback and marked
`data-md-state="failed"`. No exception escapes into the message renderer.

## 6. Mermaid upgrade (lazy, once)

The ~2.7 MB Mermaid bundle is loaded only when a completed message actually contains a diagram.
`mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit',
suppressErrorRendering: true, maxTextSize: 20000 })`. Each diagram renders with a unique id and only
one render is in flight at a time; further items are re-queued. The SVG string is parsed with
`DOMParser` and adopted via `document.importNode` — never assigned as HTML. Errors replace the
placeholder with the labeled source code block. `refreshTheme(theme)` re-queues rendered diagrams on
theme switch; math inherits `currentColor`.

## 7. Theme, responsive and accessibility notes

Dark mode is driven by `document.documentElement[data-theme]` (round-3 work); placeholders,
progressive tails and fallbacks use the existing CSS custom properties, so they follow both themes
and the 125%/150% zoom and 980×680 minimum window checks. Mermaid follows the active CSS theme; KaTeX
uses inherited color. Long formulas and wide tables scroll horizontally inside their message instead
of widening the layout (`.md-code-scroll`, `.md-table-scroll`, `.md-math-block`, KaTeX display
overflow); the streaming tail uses `overflow-wrap:anywhere` so an unbroken token cannot widen the
chat column.

## 8. Tests and verification

`desktop/test/markdown.test.ts` loads the real `desktop/ui/markdown.js` in a `node:vm` context (no
DOM dependency). Round-4 coverage: inline delimiters (`$...$`, `\(...\)`), escapes (`\$`), `$$`-in-text
rejection, whitespace/bracket edge cases, inline-code skipping, oversized math/diagram rejection,
block math (`$$`, `\[`), open-delimiter flags, mermaid fences (backtick/tilde/non-mermaid/open),
code-fence isolation, raw-HTML non-execution, `isSafeUrl`, table shape, CRLF normalization, `analyze`
open state.

Round-5 progressive coverage (6 additional cases):

- a partial table row produces no blocks (`stableChars === 0`); once the row's newline arrives the
  table block exists with header `['a','b']` and rows `[['1','2']]` (a *terminated* body row closes
  it; the trailing newline may still be tail);
- a JS fence split over three deltas: the first two states produce zero blocks and the literal text as
  tail, the closed state produces a `code` block with `lang: 'js'`;
- inline math split `"T1 $E=m"` → no block, `"T1 $E=mc^2$"` → still no block (not a boundary),
  `"T1 $E=mc^2$\n"` → paragraph prefix with exactly one math segment and `shouldRenderMath` true;
- zh/en chunk boundaries and a UTF-16 surrogate pair split across deltas: joined text is unchanged,
  no U+FFFD replacement character, and the emoji survives intact;
- ten successive refreshes: every plan satisfies `stable + tail === text`, the stable prefix only
  grows, and exactly one new paragraph block appears per refresh (no duplication, no loss);
- 10000 characters over 500 deltas stays within budget.

Measured on this machine (node 24.14.0, same run as the suite):

| Metric | Value |
| --- | --- |
| Progressive plan, 500 deltas / 10000 chars | total **42–44 ms**, average **≤0.09 ms**, worst **0.5–0.8 ms** across repeated runs |
| Full test file | 32 tests, 32 pass, 0 fail (~146 ms) |

Commands run from `desktop/` (node 24.14.0):

| Command | Result |
| --- | --- |
| `node --check ui/markdown.js` and `node --check ui/app.js` | exit 0 |
| `npx tsc -p tsconfig.json --outDir dist-t1` | exit 0 (type-check clean) |
| `node --test dist-t1/test/markdown.test.js` | **32 tests, 32 pass, 0 fail** (cross-realm arrays normalized with `JSON.stringify`/`Array.from`) |
| `npm run build` | exit 0; `dist/ui/vendor/katex/katex.min.js`, `dist/ui/vendor/mermaid/mermaid.min.js` present, 60 KaTeX font files copied, `dist/ui/index.html` references `vendor/katex/katex.min.css`, built `dist/ui/markdown.js` contains `planProgressive` and the vendor loader |
| `node scripts/ui-dom-qa.mjs` | **18 passed, 0 failed, 13 warnings** (warnings are pre-existing bridge-method notices and other teams' uncovered actions; 148 actions, 84 contract RPC methods, CSP/ids/i18n checks clean) |
| `node scripts/workbench-ui-e2e.mjs` (hosted Electron, final run `20261025-135558`) | **PASS 34/34 checks** — streaming progressive (`body markdown progressive`, open fence in `.md-stream-tail`), KaTeX=2, Mermaid SVG=1 (single SVG per container), table=1, code=1, 0 failed placeholders, **0 CSP violations**, light+dark screenshots; report `desktop/release/workbench-e2e/20261025-135558/report.json` |

CSP note (final decision): `style-src 'self' 'unsafe-inline'` is required so the offline-vendored KaTeX/Mermaid
renderers can apply their typesetting styles; `script-src` remains `'self'` and `connect-src` stays `'none'`.
The trade-off, rollback (labeled source fallback) and QA expectations are recorded in
`docs/verification/security-review.md` and `desktop/scripts/ui-dom-qa.mjs`; the hosted Electron E2E measured
**0 CSP violations** while rendering KaTeX and Mermaid.

## 9. Clause-by-clause acceptance matrix

| Acceptance clause (round-3 prompt §3.5/§4 + round-5 extension) | Evidence | Status |
| --- | --- | --- |
| Tables form row by row without breaking | `progressive: a partial table row stays plain until the row closes`; `stableScan` table mode requires separator + terminated body row; renderer typesets only stable blocks | PASS (unit + static); PASS — hosted Electron E2E screenshots |
| Code blocks across chunks | `progressive: a fence split over three deltas renders only when closed`; open fence keeps tail plain | PASS (unit) |
| Chinese/English chunk boundaries | `progressive: zh and en chunks and a split surrogate pair keep text integrity`; no U+FFFD, text round-trips | PASS (unit) |
| Streaming Markdown safety | incomplete tail never typeset; no raw HTML in any render path (`parse` keeps raw HTML as paragraph text, builders use `textContent`); links limited to absolute `http(s)` | PASS (unit + static) |
| Completed messages render Markdown | `render()`/`messageBubble(..., {markdown:true})` + 26 round-4 cases | PASS |
| Real LaTeX typeset | lazy KaTeX upgrade with fallback block + math extraction tests | PASS (unit/static + hosted Electron E2E screenshots) |
| Real Mermaid diagrams | lazy Mermaid upgrade, `securityLevel: 'strict'`, fallback to labeled source | PASS (unit/static + hosted Electron E2E screenshots) |
| Long/wide content does not break layout | `.md-code-scroll`/`.md-table-scroll`/`.md-math-block` overflow containers; `.md-stream-tail` anywhere-wrap | PASS (static CSS) |
| No flicker / no duplicate nodes while streaming | 110 ms rebuild throttle, in-place tail updates, `replaceChildren` only on the body, ten-refresh no-duplication test | PASS (unit + hosted Electron E2E) |
| Composer untouched during streaming | progressive path writes only `.body` of the message; round-3 T2 measured composer Δ0 px | PASS (code) + prior E2E |

## 10. Limitations (honest)

- **No syntax highlighting**: fenced code keeps plain `<code>` rendering; languages are only labels.
- **Progressive rendering is plan-tested, not DOM-automated**: the six round-5 tests exercise the
  DOM-free planner. The actual `replaceChildren`/tail-node behavior is verified by static review and
  by T2's Electron pass; there is no automated DOM test for it in T1.
- **One-time reflow per closed block**: when a closed table/code/math block becomes typeset it may
  change the message height once. Scroll follows only when the user is pinned to the bottom; a user
  reading history above is not jumped.
- **Images are not rendered**: `![alt](url)` is not part of the safe subset (no remote fetch under
  `connect-src 'none'` / offline requirement); such lines stay literal text. Layout shift from images
  is therefore not applicable, but the feature is absent.
- **Heuristic inline math**: `$...$` is ambiguous with currency; whitespace/length rules reduce false
  positives, `\$` is the reliable escape. Inline math is not interpreted inside table cells or link
  labels.
- **Math accessibility**: KaTeX output is HTML (`output: 'html'`, no MathML tree); screen readers get
  visible characters and the pre-upgrade `aria-label`. No formal screen-reader or WCAG contrast audit
  for either theme.
- **Mermaid size/fidelity**: first diagram triggers a ~2.7 MB local script parse; diagrams are static
  SVG (no pan/zoom); wide diagrams scale down; rendering relies on `securityLevel: 'strict'`. Diagrams
  are deferred until completion during streaming, so a streaming Mermaid fence stays labeled plain
  text until the message completes.
- **Mermaid and CSP**: the vendor injects inline `<style>`/style attributes; the frozen CSP has no
  `style-src 'unsafe-inline'`. If the vendor's styling is blocked, the enhancement fails into the
  labeled source fallback (by design) rather than breaking the message.
- **Caps**: math source > 4000 chars, diagram > 20000 chars, message > 200000 chars degrade to
  labeled/plain text.
- **T2 verification pending**: T2's Electron screenshots are the authoritative visual check for light
  and dark themes; this document records T1's unit/static/DOM-independent results only.
- Clipboard permission for the code copy button is unexercised in T1's headless checks.
