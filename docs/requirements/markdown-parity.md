# Markdown Prompt Parity Audit (round-3 §3.5 / §4 matrix → implementation)

**Task**: task-12 (round-4 docs audit) · **Date**: 2026-10-25 · **Repo**: `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
**Requirement source**: `docs/requirements/round-3-release-master-prompt.md` (Lead transcription, 21,460 B)
**Implementation inspected**: `desktop/ui/markdown.js`, `desktop/ui/app.js`, `desktop/ui/index.html`, `desktop/ui/style.css`,
`desktop/scripts/copy-assets.mjs`, `desktop/test/markdown.test.ts`, plus the now-published
`docs/verification/markdown-rendering.md` (T5 / round-4 task-11 report).

---

## 1. Exact prompt clauses that must be satisfied

Quoted from `docs/requirements/round-3-release-master-prompt.md`:

**§3.5 Markdown / complex content (lines 103-113)**

> Inputs: Markdown, LaTeX, code blocks, tables, Mermaid, quotes, JSON, multilingual, very long
> single lines, file/artifact refs, images/charts, structured research results. Requirements: (1)
> incomplete output must not flicker whole page; (2) avoid continuous expensive highlighting for
> unfinished code blocks; (3) large tables have controlled overflow; (4) code blocks scroll+copy
> independently; (5) LaTeX failure degrades locally, never crashes page; (6) Mermaid isolated +
> error handled; (7) images/async visuals avoid layout shift; (8) long content must not block main
> thread; (9) sanitize Markdown HTML against script injection; (10) unfinished output still
> readable. Suggested: lightweight incremental display during streaming; enhance stable segments;
> full normalized render when done. Never lose model content for visual stability.

**§4 stability test matrix (lines ~155-165)** — Markdown-related rows:

> … Markdown table forming line by line; code block across many deltas; zh/en/Unicode across chunk
> boundaries; … large code/table/chart; …

**§4 performance measurement list (line 239)**

> Measure: cold/warm start, first interactive, first token latency, Markdown render time, UI main …

**§16(?) acceptance gate mention (line 322)**

> … unified event protocol + stable state management → accept composer/scroll/complex Markdown/…

The requirement register maps this to **R127** (`Markdown/复杂内容渲染：表格、代码、公式、流程图、流式期间不整页闪烁`).

## 2. Implementation inventory (measured)

| Artifact | Size | SHA-256 (inspected snapshot) | Notes |
|---|---|---|---|
| `desktop/ui/markdown.js` | 35,583 B (~933 lines) | `9c82a0c1e474e6894721f8e033eb8fd1736e55102b1278449333503625aa86e9` | DOM-free tokenizer (`parse`, `scanInlineMath`, `analyze`) + safe DOM builder (`render`) + lazy vendor enhancement (`enhance`, `refreshTheme`); attaches `SuwenMarkdown`; `module.exports` for `node:vm` tests |
| `desktop/ui/app.js` | 215,394 B | `4a13523ef8e6d6caa94efa7d00d3852bfb48dbf692b9831a9387eeab986b8528` | `messageBubble` renders markdown for completed messages only (`markdown: role==='assistant' && !live`), `render` + `enhance` in `try/catch` with plain-text fallback; localized copy/fallback labels; theme refresh |
| `desktop/ui/index.html` | 25,380 B | `deee1b194f1c208e0f3adfcec75ee061589a60e016738a50d142de57eda6a49a` | `<link rel="stylesheet" href="vendor/katex/katex.min.css">`; classic scripts `stream-core.js` → `markdown.js` → `app.js`; CSP unchanged (`script-src 'self'`, `connect-src 'none'`, no inline script) |
| `desktop/ui/style.css` | 22,079 B (dist build) | — | math/diagram placeholder, failure and overflow styles (`.md-table-scroll`, `.md-code-scroll`), theme token colors |
| `desktop/scripts/copy-assets.mjs` | 873 B | `42514ac59f67632db69be221df3410973e10335bc92a9e07ad19f717dbb93430` | Builds `dist/ui/vendor/`: `katex.min.{css,js}` + 60 font files + `mermaid.min.js` (assets generated, not committed) |
| `desktop/test/markdown.test.ts` | 9,355 B | `05a570b908aff83936538291670e76bc70061b6cd09b784285396b0f1a8ac733` | 26 `node:test` cases loading the real `ui/markdown.js` through `node:vm` (no DOM) |
| `docs/verification/markdown-rendering.md` | 11,177 B | `97e98c33433f4b38fc3afd6887a2eb36c6c70692bef999c4d2b33ecb59d8ecbc` | Published round-4 task-11 report: pipeline, KaTeX/Mermaid upgrade, tests, honest limitations |
| `desktop/package.json` | 2,250 B | `5a6c591d7f06a8a86d8c9e297b2488f64ed9a01b1ced1fec88504fe57e3cd7ce` | version **3.3.0**; devDeps `katex ^0.16.21`, `mermaid ^11.12.0` (vendored at build time) |

Design facts (from `markdown-rendering.md` §3-§8 and code inspection):

- **Completed-only Markdown**: streaming deltas stay plain text; markdown rendering + math/diagram
  enhancement happen once, on the final body. This is the deliberate mechanism behind clauses (1), (2)
  and (10).
- Tokenizer reports open trailing delimiters (`analyze`) so half-open fences/`$$` blocks are never
  typeset; caps: **MAX_CHARS 200,000**, **MAX_MATH_CHARS 4,000**, **MAX_DIAGRAM_CHARS 20,000**
  (oversize degrades to labeled/plain text).
- No raw HTML: only `createElement`/`createTextNode`/`appendChild`/`setAttribute`/`textContent`; raw
  HTML in model text remains a literal paragraph; links only for absolute `http(s)` (`isSafeUrl`).
- KaTeX upgrade: lazy `<script src="vendor/katex/katex.min.js">` once, `throwOnError:true`,
  `trust:false`, `strict:'ignore'`, `maxSize:20`, `maxExpand:1000`, `output:'html'`; failure replaces
  the placeholder with a labeled source `<code>` and never throws into the renderer.
- Mermaid upgrade: ~2.7 MB bundle lazy-loaded only when a diagram exists; `securityLevel:'strict'`,
  `startOnLoad:false`, `suppressErrorRendering:true`, `maxTextSize:20000`; unique id, single render in
  flight, SVG parsed with `DOMParser`/`importNode` (never assigned as HTML); theme switch re-queues
  rendered diagrams.
- Enhancement queue: **≤8 ms per tick**, re-scheduled with a 16 ms timer, so a long formula-heavy
  answer cannot freeze the composer (clause 8 design).
- Tests: 26/26 pass (`node --test dist-t1/test/markdown.test.js`), `node --check` clean, `npm run
  build` copies vendor (KaTeX js/css + 60 fonts + Mermaid), `ui-dom-qa` report by owner:
  18 passed / 0 failed / 13 warnings (148 actions, 84 RPC methods).

## 3. Clause-by-clause verdict

Status vocabulary for this audit: `IMPLEMENTED` (code + evidence), `PARTIAL` (implemented but a named
aspect is untested/absent), `NOT_IMPLEMENTED`, `NOT_VERIFIED` (no evidence).

| # | Prompt clause (§3.5) | Implementation | Status | Evidence / gap |
|---|---|---|---|---|
| 1 | Incomplete output must not flicker whole page | Streaming = plain-text append-only buffers; markdown rendered once on completion; no per-delta re-typeset | `IMPLEMENTED` | `ui/stream-core.js` append-only buffers + `app.js` completed-only markdown; T2 delta matrix (100/1k/10k, exact text SHA) |
| 2 | Avoid continuous expensive highlighting for unfinished code blocks | No markdown/highlighting during stream; open fences flagged and deferred | `IMPLEMENTED` | `markdown.js` open-block logic; `markdown.test.ts` open-delimiter cases; no syntax highlighter at all (limitation, not a violation of "avoid") |
| 3 | Large tables have controlled overflow | `.md-table-scroll` wrapper, tables tokenized; long lines do not widen layout | `IMPLEMENTED` | `style.css` overflow rules; `markdown.test.ts` table shape case; UI visual audit matrix reports 0 internal horizontal overflow |
| 4 | Code blocks scroll + copy independently | `.md-code-scroll` overflow; copy button injected with localized label/callback | `PARTIAL` | Code + labels implemented; **clipboard copy unexercised** in T1 headless checks and T2 E2E (both reports say so) |
| 5 | LaTeX failure degrades locally, never crashes page | Placeholder keeps visible source; async KaTeX upgrade with fallback `<code>`; render+enhance wrapped in `try/catch` | `IMPLEMENTED` | `markdown-rendering.md` §5; `markdown.test.ts` math caps/brackets; no uncaught path found |
| 6 | Mermaid isolated + error handled | Separate container/id, one-at-a-time render, SVG parsed+imported, errors → labeled source; strict security level | `IMPLEMENTED` | `markdown-rendering.md` §6; `markdown.test.ts` mermaid fence cases; no pan/zoom (documented limitation) |
| 7 | Images / async visuals avoid layout shift | **Markdown does not render images or charts at all**; only links (absolute http(s)); no reserved-space/image logic | `NOT_IMPLEMENTED` | `markdown.js` tokenizer blocks are heading/paragraph/code/diagram/math/list/table/quote/hr; no `<img>`/figure handling; no layout-shift test. The prompt explicitly lists images/charts/file refs as inputs |
| 8 | Long content must not block main thread | Caps (200 k chars), DOM-free tokenizer, ≤8 ms enhancement ticks, one render per turn | `PARTIAL` | Design + caps implemented and unit-tested, but **Markdown render time is not measured** (the §4/§10 measurement list explicitly requires it); no long-document macrobenchmark, no FPS/frame-time artifact |
| 9 | Sanitize Markdown HTML against script injection | textContent-only builder; raw HTML shown as text; link scheme filter; no innerHTML/eval | `IMPLEMENTED` | `markdown.test.ts` raw-HTML + `<script>` literal + `javascript:` link rejection; CSP `script-src 'self'` unchanged |
| 10 | Unfinished output still readable | Streaming plain text; unclosed delimiters stay literal; waiting/fallback labels bilingual | `IMPLEMENTED` | `markdown-rendering.md` §3/§9; `app.js` renders live text without markdown |
| — | Suggested: lightweight incremental display during streaming | Plain-text incremental display (not incremental Markdown) | `IMPLEMENTED` (as plain text) | streaming path in `app.js`/`stream-core.js` |
| — | Suggested: enhance stable segments | Enhancement only after completion (not per stable segment during stream) | `PARTIAL` | `enhance()` called on final body only; acceptable variant but not the suggested granularity |
| — | Suggested: full normalized render when done | Completed body rendered fully, then async math/diagram upgrade | `IMPLEMENTED` | `render()` + `enhance()`; 26/26 tests |
| — | Never lose model content for visual stability | Buffers keep full text; DOM builder uses full strings; no truncation below caps | `IMPLEMENTED` | T2 delta text SHA equality; caps degrade visibly with truncation note |

Tally: **IMPLEMENTED 10** (incl. 2 suggested), **PARTIAL 3**, **NOT_IMPLEMENTED 1** (clause 7), **NOT_VERIFIED 0**.

## 4. §4 test-matrix markdown items

| Matrix item (prompt) | Status | Evidence / gap |
|---|---|---|
| Markdown table forming line by line | `NOT_VERIFIED` | Tables are only rendered on completed bodies; no test asserts a table forming across deltas (by design streaming is plain text, so this item is not satisfied literally) |
| Code block across many deltas | `NOT_VERIFIED` | Streaming text integrity is tested (T2 SHA), but code-fence rendering across deltas is not asserted |
| zh/en/Unicode across chunk boundaries | `NOT_VERIFIED` | T2 delta matrix asserts text integrity; no markdown-specific multilingual chunk-boundary case |
| Large code/table/chart | `PARTIAL` | Caps + overflow containers + oversize degradation implemented; no macro stress test/measurement |
| Markdown render time | `NOT_MEASURED` | Required by prompt §4/§10; no artifact records it (T2 measured stream render/paint separately, not markdown parse/KaTeX/Mermaid time) |
| Theme/language switch with rendered Markdown | `PARTIAL` | `refreshTheme` re-renders Mermaid; visual audit covered dark theme layout, but markdown/math rendering in both themes is not asserted by an automated test |

## 5. Is `docs/verification/markdown-rendering.md` present?

**Yes.** Published 2026-10-25 13:27 (11,177 B, sha `97e98c33…d8ecbc`), owner "streaming-ui", round-4 task-11.
It documents the KaTeX/Mermaid upgrade, the completed-only rendering decision, tests (26/26), build/vendor
copy, and an honest limitations section (no syntax highlighting, heuristic inline math, no MathML, Mermaid
first-load cost, caps, T2 verification pending, streaming not rendered, clipboard permission unexercised).

Consequences for this audit:

- The earlier gap "markdown-rendering.md missing" is **closed**.
- The earlier "LaTeX/Mermaid degrade only" state is **superseded**: real typesetting now exists and is
  unit-verified, subject to the stale packaged build (see §6).
- `R127` **stays `UNVERIFIED` in the master CSV** (no status inflation): the implementation report is
  published and tested at unit level, but the acceptance matrix items in §4, the render-time measurement,
  clause 7 (images/layout shift), clipboard copy, and T2 Electron verification are still missing, and the
  shipped installer was built before these UI files changed.

## 6. Packaging/artifact caveat (P0 for release claims)

`desktop/release/win-unpacked/resources/app/dist/ui/` was inspected and **predates** the current UI:

| File | Packaged artifact | Working tree / build copy |
|---|---|---|
| `markdown.js` | 14,232 B | 35,583 B source; `dist/ui/markdown.js` built version |
| `index.html` | 23,161 B | 25,380 B |
| `app.js` | 204,682 B | 215,394 B |
| `vendor/` (KaTeX/Mermaid) | **absent** | `desktop/dist/ui/vendor/` present (katex css/js/fonts + mermaid.min.js) |

So the round-4 installer cannot be used to claim LaTeX/Mermaid/streaming parity; it must be rebuilt from a
frozen working tree and the hash re-recorded (same class of issue as `docs/verification/legacy-web-parity.md`
Q5). Also note `desktop/package.json` now says **3.3.0** while the round-4 release evidence says 3.2.0.

## 7. R127 assessment and exact remaining gaps

Requirement: "Markdown/复杂内容渲染：表格、代码、公式、流程图、流式期间不整页闪烁" (R127).

- Implemented: completed-message Markdown, tables with controlled overflow, code blocks with scroll+copy
  label, KaTeX math with local degradation, Mermaid with isolation/error handling, textContent-only
  sanitization, streaming-safe completed-only rendering, caps and async queue.
- Still missing / unverified (why R127 remains `UNVERIFIED`):
  1. prompt §4 matrix markdown rows (table across deltas, code block across deltas, zh/en/Unicode chunk
     boundaries) are not asserted — streaming intentionally renders plain text, so a doc decision is needed
     (waive vs implement streaming-safe incremental markdown);
  2. Markdown render time (parse + KaTeX + Mermaid) is not measured; prompt §4/§10 requires it;
  3. clause 7 (images/charts/layout shift) is not implemented;
  4. clipboard copy is unexercised in any automated run;
  5. XSS/sanitization evidence is unit-level (script literal, unsafe scheme); no fuzz corpus;
  6. T2 Electron visual verification of math/diagrams pending (T2 screenshots are the authoritative check
     per `markdown-rendering.md` §9);
  7. the shipped installer predates the new renderer/vendor assets (§6), and version metadata drifted to
     3.3.0.

## 8. Cross-references

| Where | Relation |
|---|---|
| `docs/requirements/master-requirements.csv` R127 | status stays `UNVERIFIED`; evidence updated to cite `markdown-rendering.md` + `markdown.test.ts` (26/26) + phase 1/2 analysis |
| `docs/verification/ui-streaming-stability.md` §4 | T1 streaming/UI summary; Markdown subset is completed-only |
| `docs/verification/ui-e2e.md` | T2 limitations: "markdown rendering asserted only for final (non-streaming) bodies; clipboard copy not exercised" |
| `docs/verification/markdown-rendering.md` | owner report for the KaTeX/Mermaid upgrade |
| `docs/verification/legacy-web-parity.md` | hosted legacy workbench (the legacy UI has its own markdown rendering; this audit is about the native UI) |
| prompt lines 103-113 / ~155-165 / 239 / 322 | clauses audited above |
| `docs/requirements/conflicts.md` | add conflict: "Markdown streaming matrix item vs completed-only rendering decision" (see C-25 in that file) |

## 9. Reproduction commands

```powershell
# static checks + unit tests (no build needed for node --check)
node --check desktop/ui/markdown.js
node --check desktop/ui/app.js
cd desktop ; npx tsc -p tsconfig.json --outDir dist-t1 ; node --test dist-t1/test/markdown.test.js

# inspect the renderer contracts
Select-String -Path desktop/ui/markdown.js -Pattern 'MAX_CHARS|MAX_MATH_CHARS|MAX_DIAGRAM_CHARS|securityLevel|trust:|throwOnError'
Select-String -Path desktop/ui/app.js -Pattern "markdown: role==='assistant'" -Context 0,3

# confirm build-time vendor copy
npm run build ; Get-ChildItem desktop/dist/ui/vendor -Recurse -File | Select-Object -First 5
```

## 10. Statement

The Markdown/complex-content implementation is substantially present and unit-tested, but this audit does
**not** upgrade R127 to pass: the required quantitative render-time measurement, streaming-phase matrix
items, image/layout-shift clause, clipboard verification, and Electron visual verification are missing, and
the current installer predates the renderer. Those gaps are listed in §7 for the owning teammates.
