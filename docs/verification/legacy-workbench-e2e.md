# 工作台（Native Workbench）+ 托管 Legacy SPA Electron E2E

Round 4, task-13. Deterministic, local-only Electron E2E for the 6th native workspace `工作台` and the hosted legacy web SPA (`omicslab/web`, served by the managed Python runtime through the daemon bridge). No real vendor APIs, no pip installs, loopback traffic only.

- Date: 2026-10-25 (Asia/Shanghai), runs 13:33–13:36
- Owner: ui-e2e (T2)
- Build under test: `suwen-desktop@3.3.0`
- Runner: `desktop/scripts/workbench-ui-e2e.mjs` (new, self-contained)
- Reports: `desktop/release/workbench-e2e/20261025-133318/` (run 1), `…-133425/` (run 2), `…-133540/` (run 3, final)
- Verdict: **routes 12/12 PASS, native workbench PASS, 0 page errors, 0 legacy console errors; overall run status FAIL because 2 shell/feature checks fail** — legacy shell resolves to **light** instead of the required dark default, and Mermaid markdown rendering triggers **120 CSP inline-style violations** (P1, diagram visually degraded). Both are reported below; nothing was faked or suppressed.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 Home China, 10.0.26200, x64 |
| CPU / RAM | Intel Core i7-14700HX, 28 logical cores / 31.8 GiB |
| Host Node | v24.14.0 |
| Electron (dev binary) | `desktop/node_modules/electron/dist/electron.exe`, 45.0.0 |
| In-app runtime | Electron 45.0.0 / Chrome 156.0.8078.48 / Node 24.22.0 / V8 15.6.75.19-electron.0 |
| Playwright | `playwright-core` 1.64.1 (`_electron`) |
| App version | 3.3.0 (`package.json`), native window title `素问 · SuWen` |
| Python runtime | `python` on PATH = 3.11.9 (`D:\Develop\python\python.exe`) |
| Managed deps | `%TEMP%\suwen-workbench-smoke`, marker `.suwen-workbench.json` sha256 `ae126f4ce3717dbed5d9a9cf08e7ccd487af5e8160c88ad469769e146a1e0e52`, schema 1, requirementsHash `3887b118f877fbb2c9be61d9b46264fa16f7bf620e622c64fbc0533b8af256ab`, python 3.11.9, 132,868,111 B / 11,866 files |
| Build hashes | `ui/app.js` = `dist/ui/app.js` = `4A13523EF8E6D6CAA94EFA7D00D3852BFB48DBF692B9831A9387EEAB986B8528`; `ui/index.html` `DEEE1B194F1C208E0F3ADFCEC75EE061589A60E016738A50D142DE57EDA6A49A`; `ui/markdown.js` `9C82A0C1E474E6894721F8E033EB8FD1736E55102B1278449333503625AA86E9`; `dist/main.js` `EDDF37B2374797654288D5F811369002EEF444416D2D37CF2F8614E6A8CD2C07`; `dist/src/workbench.js` `7B2CA96EE0A8DD4DA7C5D895C446F8589A4A0F114C0EF1F86367C1BF7D82FA30`; vendored Mermaid `dist/ui/vendor/mermaid/mermaid.min.js` `07E37DFA97B337CCC85365D57EDDF99B9706F09DB3B59B260D0333B23B343C4B` |

The managed dependencies were reused as-is via `SUWEN_WORKBENCH_DEPS`; the test never runs `pip install` and never downloads anything.

## Command

```powershell
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
npm run build    # tsc + copy-assets; exit 0 (dist/ui must include vendor/katex + vendor/mermaid)
$env:SUWEN_WORKBENCH_DEPS = Join-Path $env:TEMP 'suwen-workbench-smoke'
node scripts/workbench-ui-e2e.mjs
```

The script itself sets `SUWEN_TEST_HOME` to a fresh `mkdtemp` profile per run, deletes the inherited `ELECTRON_RUN_AS_NODE` from the child env (this shell exports it globally), launches the dev Electron with `args=[desktop project root]`, opens the legacy SPA via the real native UI (click `工作台` → `#wb-open`), and cleans up the Electron app, native daemon, Python legacy server, profile dir, and its own loopback Markdown fixture in `finally` (12-minute hard stop).

## Results summary

| Run | Started | Duration | Checks | Routes | Legacy console errors | Page errors | Overall |
| --- | --- | ---: | --- | --- | ---: | ---: | --- |
| 1 (`20261025-133318`) | 13:33:18 | 59.5 s | 30 PASS / 1 FAIL | 12/12 PASS | 0 | 0 | FAIL (dark-default only) |
| 2 (`20261025-133425`) | 13:34:25 | 57.3 s | 30 PASS / 1 FAIL | 12/12 PASS | 0 | 0 | FAIL (dark-default only) |
| 3 (`20261025-133540`) | 13:35:40 | 57.5 s | 31 PASS / 2 FAIL | 12/12 PASS | 0 | 0 | FAIL (dark-default + Mermaid CSP) |

Run 3 adds the instrumentation that classifies native console errors; runs 1–2 already recorded the same 120 native console errors (see JSON), and their screenshots are identical in outcome. The failing checks are stable and reproducible, not flaky.

## Native workbench checks (all PASS)

| Check | Evidence |
| --- | --- |
| `native.rail.sixWorkspaces` | rail buttons = `chat,projects,tasks,tools,workbench,settings` |
| `native.rail.workbenchPresent` | `button[data-page="workbench"]` present |
| `native.workbench.stateReady` | `#wb-state`: `工作台运行时已就绪 · Python 3.11.9` |
| `native.workbench.openEnabled` | `#wb-open` enabled after status resolves |
| `native.workbench.installed` | `installed=true python=3.11.9 bytes=132868111` |
| `native.workbench.depsDir` | `C:\Users\QINGYU~1\AppData\Local\Temp\suwen-workbench-smoke` |
| `native.pages.noRegression` | after the legacy window opened, all six native workspaces still open: chat / projects / tasks / tools / settings / workbench, Electron `exitCode=null` |

Screenshot: `release/workbench-e2e/20261025-133540/screenshots/native-workbench.png`, post-legacy regression shot `native-after-legacy.png`.

## Legacy shell checks

| Check | Result | Detail |
| --- | --- | --- |
| `legacy.onboarding.visibleOnFirstBoot` | PASS | fresh isolated profile shows 「欢迎来到素问」 modal (body 137 chars, buttons `先看看` / `配置模型连接`) — see `legacy-first-boot.png` |
| `legacy.onboarding.dismissed` | PASS | dismissed via `先看看` before route checks |
| `legacy.window.event` | PASS | `app.waitForEvent('window')` → `http://127.0.0.1:<port>/` |
| `legacy.title.contains素问` | PASS | `工作台 · 素问 Suwen` |
| `legacy.shell.navItems>=12` | PASS | 12 nav items: `workbench,chat,tasks2,research,knowledge,workflow,artifacts,extensions,discovery,ssh,settings,diagnostics` |
| `legacy.shell.brand` | PASS | `素问 Suwen` |
| `legacy.theme.darkDefault` | **FAIL** | `documentElement.dataset.theme="light"`; stored appearance preference is `"system"` and the host OS is light (`prefers-color-scheme: light` → true). `omicslab/web/index.html` statically starts dark, but the platform bootstrap (`appearance.theme` default `system` in `omicslab/suwen/configuration.py:10`, applied by `omicslab/web/js/ui.js:577-592`) resolves to light. Requirement said dark by default. |
| `legacy.isolated.session` | PASS | isolated partition, dedicated `http://127.0.0.1` origin (Bearer token injected by main for this window only) |
| `legacy.renderer.noNode` / `noBridge` | PASS | `window.require === undefined`, `window.suwen === undefined` inside the hosted page |
| `legacy.theme.toggleWorks` | PASS | `#theme-toggle` click: light → dark → light (restored) |
| `legacy.routes.all12` | PASS | 12/12 route containers non-empty, no `.error-card`, correct titles |

## Per-route results (run 3; identical in runs 1–2)

Hash-router navigation (`window.location.hash = '#/<route>'`), route container `#view-root`, per-route settle + 500 ms, screenshot per route.

| # | Route | Title | View text len | Elapsed | Status | Screenshot |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | workbench | 工作台 · 素问 Suwen | 782 | 878 ms | PASS | `screenshots/route-01-workbench.png` |
| 2 | chat | 对话 · 素问 Suwen | 492 | 902 ms | PASS | `screenshots/route-02-chat.png` |
| 3 | tasks2 | 任务中心 · 素问 Suwen | 162 | 823 ms | PASS | `screenshots/route-03-tasks2.png` |
| 4 | research | 科研与证据 · 素问 Suwen | 273 | 880 ms | PASS | `screenshots/route-04-research.png` |
| 5 | knowledge | 知识与记忆 · 素问 Suwen | 178 | 766 ms | PASS | `screenshots/route-05-knowledge.png` |
| 6 | workflow | 工作流 · 素问 Suwen | 206 | 787 ms | PASS | `screenshots/route-06-workflow.png` |
| 7 | artifacts | 产物中心 · 素问 Suwen | 138 | 798 ms | PASS | `screenshots/route-07-artifacts.png` |
| 8 | extensions | 能力中心 · 素问 Suwen | 191 | 793 ms | PASS | `screenshots/route-08-extensions.png` |
| 9 | discovery | 发现 · 素问 Suwen | 179 | 816 ms | PASS | `screenshots/route-09-discovery.png` |
| 10 | ssh | SSH · 素问 Suwen | 209 | 825 ms | PASS | `screenshots/route-10-ssh.png` |
| 11 | settings | 设置 · 素问 Suwen | 398 | 870 ms | PASS | `screenshots/route-11-settings.png` |
| 12 | diagnostics | 系统诊断 · 素问 Suwen | 286 | 770 ms | PASS | `screenshots/route-12-diagnostics.png` |

No route reported a fatal error card, boot failure, `加载失败` placeholder, or uncaught page error. Views render their unconfigured/empty states because no real model/SSH/channel credentials exist (deterministic local run).

## Native chat Markdown audit (KaTeX + Mermaid)

A second deterministic loopback fixture (`http://127.0.0.1:<port>/v1/chat/completions`, OpenAI SSE) serves one fixed assistant message containing: inline `$E=mc^2$`, block `$$\int_0^1 x^2\,dx = \frac{1}{3}$$`, a Mermaid `graph TD; A-->B;` fence, a table, and a JS code fence. First chunk is sent immediately, the remainder after ~900 ms, then `finish_reason` + usage + `[DONE]`; the audit records the request (one POST: `stream:true`, `max_tokens:512`, `stream_options.include_usage:true`, `Authorization: Bearer fixture`, and the typed user prompt in `messages[1]`). This validates the native UI's Markdown/KaTeX/Mermaid path end to end at the DOM level; payload sha256 `93a49888764434bbb320e4acd4bf080693bbab2bee87e7eafe0cc14b0a5f1dfc`, length 235.

| Check | Result | Measured |
| --- | --- | --- |
| `native.markdown.streamingPlainText` | PASS | streaming bubble `body class="body"`, 0 KaTeX nodes (plain text while streaming, by design) |
| `native.markdown.katex` | PASS | rendered math placeholders 2, display math 1, `.katex` nodes 2 |
| `native.markdown.mermaidSvg` | PASS | 1 rendered diagram, 1 `<svg>`, 1 SVG per container (`[1]`) |
| `native.markdown.table` | PASS | 1 table, 1 `.md-table-scroll` wrapper |
| `native.markdown.codeBlock` | PASS | 1 `pre`, 1 `.md-code-block` |
| `native.markdown.noFailedPlaceholders` | PASS | `data-md-state="failed"` = 0, no "not rendered" fallback text |
| `native.markdown.screenshot.light` | PASS | resolved theme `light`, KaTeX 2, diagram SVG 1 → `screenshots/markdown-light.png` |
| `native.markdown.screenshot.dark` | PASS | resolved theme `dark`, KaTeX 2, diagram SVG 1 → `screenshots/markdown-dark.png` |
| `native.markdown.noDuplicateContainers` | PASS | after a page switch re-render: diagrams 1 → 1, SVG per container `[1]` → `[1]` |
| `native.markdown.noPageErrors` | PASS | 0 page errors, 1 fixture request |
| `native.markdown.noCspViolations` | **FAIL** | **120** CSP violations: `Applying inline style violates the following Content Security Policy directive 'style-src 'self''` — attributed to `dist/ui/vendor/mermaid/mermaid.min.js` (e.g. line 2770, 349) |
| `native.markdown.noUnexpectedConsoleErrors` | PASS | 0 non-CSP console errors |

Visual review of `markdown-light.png` / `markdown-dark.png`: KaTeX inline + block math renders correctly in both themes; the Mermaid SVG exists but is **visually degraded** — flowchart nodes appear as solid black/bare rectangles, connector styling is lost, because Mermaid bakes layout/theme into inline styles that the `style-src 'self'` CSP blocks. The DOM/SVG existence checks pass; the visual/CSP check does not. Also observed: inline math inside a Markdown table cell (`$E=mc^2$`) is left literal — table-cell inline math is not enhanced (P3 observation, may be intended).

## Findings

| Severity | Area | Finding | Evidence |
| --- | --- | --- | --- |
| **P1** | Native Markdown rendering (Mermaid vs CSP) | Mermaid diagrams are injected as SVG with inline styles, but `desktop/ui/index.html` enforces `style-src 'self'`; Chromium blocks 120 inline-style applications (`vendor/mermaid/mermaid.min.js`), leaving the diagram unstyled (black boxes, missing edge/theme styling) even though the SVG mounts. Owner: UI/CSP (round-4 markdown feature). Suggested direction: allow Mermaid-generated styles via a sanitized `<style>` with CSP nonce/hash, configure Mermaid `themeCSS`/`securityLevel` so its styling lives in an external stylesheet, or narrowly add `'unsafe-inline'` to `style-src` (weakens CSP — needs security review). Do **not** treat DOM/SVG presence as a pass. | run 3 `checks[] native.markdown.noCspViolations` + `native.markdown.console.cspSamples`; screenshots `release/workbench-e2e/20261025-133540/screenshots/markdown-light.png`, `…/markdown-dark.png` |
| **P2** | Hosted legacy SPA theme | `工作台` window opens the legacy SPA in **light** theme on this light-mode host. Requirement (task-13) expected dark by default. Cause: platform `appearance.theme` default is `system` (`omicslab/suwen/configuration.py:10`), resolved by `omicslab/web/js/ui.js:577-592` from `prefers-color-scheme`; the static `index.html data-theme="dark"` is overridden during bootstrap. Toggle works (`light → dark → light`). Owner: platform/integration — either seed dark for the desktop-hosted window (`main.ts` legacy window could set `nativeTheme.themeSource='dark'` for that window/partition, or pass a forced appearance) or confirm "system default" is acceptable and update the acceptance criterion. | run 3 `checks[] legacy.theme.darkDefault`; `legacy.shell.storedTheme`, `prefersLight`; screenshot `legacy-shell.png`; toggle evidence `legacy.themeToggle` |
| P3 | UI version label | Native footer still shows `3.2.0 · 开发预览版` although `package.json`/`app.getVersion()` = **3.3.0**. Hardcoded i18n string `desktop/ui/app.js:3792`. Cosmetic; owner UI. | `markdown-light.png` footer; report `environment.appVersion` = 3.3.0 |
| P3 | Legacy first-boot modal | Fresh hosted profile always shows the 「欢迎来到素问」 onboarding modal, covering the SPA; route checks dismiss it via `先看看`. Product may want the desktop-hosted window to seed `onboarded=true` or surface the modal deliberately. | `legacy.onboarding` + `legacy-first-boot.png` |
| P3 | Markdown coverage | Inline math inside a table cell stays literal (`$E=mc^2$` in the 说明 column). Not asserted as failure; recorded as observed coverage. | `markdown-light.png` table |

Non-findings / harness notes:

- `native.pages.noRegression` and `native.electron.alive` PASS: opening and closing the hosted window does not disturb the native app.
- 120 native console errors are **all** the CSP Mermaid class above (`native.markdown.noUnexpectedConsoleErrors` PASS); zero console errors in the legacy window and zero uncaught page errors in both windows.
- Cleanup: Electron exited, native daemon stopped (`shutdown` RPC), Python legacy server stopped, legacy port closed (`fetch` fails), temp profile deleted, local Markdown fixture closed. `app.close()` hit the 8 s harness timeout and was followed by `taskkill` (recorded as `cleanup.appCloseError` but `electronExited=true`). `cleanup.residualProcesses` contains only the harness's own `Get-CimInstance` PowerShell query process whose command line matches the search pattern — not a leaked app process.
- No `src/**`, `ui/**`, or `test/**` files were edited by this test task; only new files below.

## Screenshots

Directory: `desktop/release/workbench-e2e/<run>/screenshots/` (18 PNGs per full run):

- `legacy-first-boot.png` — fresh-profile onboarding modal
- `legacy-shell.png` — hosted shell, first route (`工作台`), light theme
- `route-01-workbench.png` … `route-12-diagnostics.png` — all 12 routes
- `native-after-legacy.png` — native window after hosted window closes
- `native-workbench.png` — native 工作台 page with runtime ready
- `markdown-light.png`, `markdown-dark.png` — native chat Markdown render (KaTeX + Mermaid + table + code), light/dark

Final run: `release/workbench-e2e/20261025-133540/` (report.json + screenshots). Earlier runs: `20261025-132524` (pre-run failed bootstrap: `status.padEnd` harness bug), `20261025-132609` (first green routes run, 15 shots), `20261025-133318`, `20261025-133425`.

## Limitations

- Deterministic local run: no real model/SSH/channel credentials; legacy views show unconfigured/empty states. The native Markdown render is verified against a loopback OpenAI-SSE fixture (fixed payload, ~900 ms streaming window), not a real provider.
- Only loopback traffic (Electron IPC, 127.0.0.1 Python bridge, in-page `/api`, local fixture) is exercised; external services, network error paths, and update flows are not.
- Route checks assert shell mount, non-fatal render, title, no fatal error card, and page-error absence; they do not exercise per-view feature actions (approvals, uploads, kernels, SSH sessions, file operations) beyond mount-time initialization.
- Legacy SPA is Chinese-only; theme audit covers its resolved default and the toggle, not full light/dark visual parity of every route.
- The managed Python deps directory is reused; install/cancel/repair flows (network + pip) are not tested.
- Screenshots are window-content captures of the isolated 1600×1000 window (2379×1407 px at host dpr 1.5); no OS DPI, accessibility-tree, contrast, or tab-order claims.
- Run duration ~57–60 s of which ~15 s is cleanup; any global timeout path writes a partial report and force-kills before exit code 3.
- The initial run failed on a harness bug (`status.padEnd` on a boolean check status), fixed before the recorded runs; it is not a product defect.

## Reproduction / artefacts

```powershell
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
$env:SUWEN_WORKBENCH_DEPS = Join-Path $env:TEMP 'suwen-workbench-smoke'
node scripts/workbench-ui-e2e.mjs
# → release/workbench-e2e/<timestamp>/report.json + screenshots/
```

Expected current result: routes 12/12 PASS, native workbench PASS, 0 page errors / 0 legacy console errors, `legacy.theme.darkDefault` FAIL (light OS resolves system → light) and `native.markdown.noCspViolations` FAIL (120 Mermaid inline-style CSP violations). After an owner fix for either defect, re-run and update this document.


## Lead re-run after fixes (round-5, final)

Fixes: dark appearance seeded into the hosted profile (daemon bridge), CSP `style-src 'self' 'unsafe-inline'`
for the offline KaTeX/Mermaid renderers, first fixture chunk ends inside the Mermaid fence, and the test samples
the live DOM for the progressive tail. The green run was executed with no concurrent Electron processes:

| Run | Started | Duration | Checks | Routes | Legacy console errors | Verdict |
|---|---|---|---|---|---|---|
| `20261025-135454` | 13:54:54 | 45 s | 21 PASS / 3 FAIL | 12/12 | 0 | FAIL — concurrent Electron run crashed the renderer mid-audit (test-infrastructure contention, not a product defect; repeated cleanly below) |
| **`20261025-135558`** | **13:55:58** | **46 s** | **34 / 34 PASS** | **12/12** | **0** | **PASS (canonical)** |

Canonical evidence: `desktop/release/workbench-e2e/20261025-135558/report.json` (34 checks, 19 screenshots,
`cspViolations: 0`, `katex: 2`, `diagrams: 1`, `tables: 1`, themes light+dark, `pageErrors: 0`).
Build hashes actually under test (sha256, uppercase):

| File | sha256 |
|---|---|
| `ui/app.js` = `dist/ui/app.js` | `F331F134E95559666EEBA837ABB60981581E68037EF8B31AA6429F64720117F0` |
| `ui/index.html` = `dist/ui/index.html` | `061934C0605BCA9BA2A7CE794476D5B53A42DE3C8179C7773CCF1EEACB320132` |
| `ui/markdown.js` = `dist/ui/markdown.js` | `7B8C753DBCBB9EC4FD249BB85B145F5FA8B06FCCD5A7980757C9A37ABE86A652` |
| `dist/main.js` | `EDDF37B2374797654288D5F811369002EEF444416D2D37CF2F8614E6A8CD2C07` |
| `dist/src/workbench.js` | `7B2CA96EE0A8DD4DA7C5D895C446F8589A4A0F114C0EF1F86367C1BF7D82FA30` |
| vendored Mermaid | `07E37DFA97B337CCC85365D57EDDF99B9706F09DB3B59B260D0333B23B343C4B` |

Reproduce (from `desktop/`): `$env:SUWEN_WORKBENCH_DEPS="$env:TEMP\suwen-workbench-smoke"; node scripts/workbench-ui-e2e.mjs`.
The earlier failing runs above remain in the report tree and are kept as history.

Files changed by this task (only):

- `desktop/scripts/workbench-ui-e2e.mjs` (new)
- `docs/verification/legacy-workbench-e2e.md` (this file, new)
- run artefacts under `desktop/release/workbench-e2e/**` (gitignored)
