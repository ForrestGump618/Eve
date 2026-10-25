# SuWen Desktop 3.3.0 - Legacy workbench in the app + markdown parity

Product version **3.3.0** (2026-10-25). This release is a functional parity release: the
existing SuWen web product is now available *inside* the desktop app, and the markdown
rendering gaps from the earlier prompt are closed.

## Hosted legacy workbench (new native workspace)
- New sixth workspace page **实验工作台 / Workbench** in the desktop shell: shows managed-runtime
  status, installs the pinned Python dependency set on demand (~130 MB, disclosed, cancelable),
  and opens the legacy SuWen web UI in an isolated hardened Electron window.
- The hosted window serves the real legacy SPA (same HTML/CSS/JS, 20 routes / 14 view modules) from
  a loopback bridge with per-window bearer auth, request-time CSP, and no Node/preload exposure to the
  page. Desktop model + credential config is injected into the bridge; nothing is persisted in the
  legacy storage or written to disk.
- On-demand runtime: 13 pinned top-level dependencies, `.suwen-workbench.json` marker bound to
  requirements hash + Python minor version + import probe, atomic marker write, cancel/retry.

## Markdown parity
- Progressive streaming markdown: closed blocks are typeset while the answer streams; an open
  fence/table/math region stays a plain `.md-stream-tail` until closed (never partial typesetting).
- Real offline KaTeX and Mermaid, vendored into the app (no CDN, CSP-compatible), lazy-loaded and
  time-sliced, security level `strict`, labeled fallback on parse failure. Tables, code blocks,
  inline math, diagrams and theme switching are covered by unit and hosted E2E checks.

## Evidence (all measured on this artifact)
- Hosted Electron E2E **34/34 checks**: 12/12 legacy routes navigable, 19 screenshots, dark+light,
  0 page/console errors, 0 CSP violations; report `desktop/release/workbench-e2e/20261025-135558/report.json`.
- Bridge runtime smoke **27/27** (`docs/verification/workbench-runtime-smoke.json`), config
  injection **13/13** (`docs/verification/workbench-config-injection.json`), markdown unit tests
  **32/32**.
- Desktop suite **222 tests / 220 pass / 0 fail / 2 skipped** (skips: Windows symlink EPERM and
  optional legacy Python deps); RPC E2E live **42/42**; chaos **12/12**; UI DOM QA
  **18 passed / 0 failed / 13 warnings** (148 actions, 84 contract RPC methods).
- Packaged Electron smoke **passed**, including the hosted legacy SPA (12 nav items, 12 routes).
- Windows lifecycle (final artifact): **12/12 PASS** incl. upgrade from 3.0.0-preview.1;
  `docs/verification/artifacts/installer-lifecycle.json`.

## Artifacts (delivered, UNSIGNED)
| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `desktop/release/SuWen-Setup-3.3.0-win-x64.exe` | **131,011,183** | `0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03` |
| `desktop/release/SuWen-Setup-3.3.0-win-x64.exe.blockmap` | 137,255 | `15EAB7E1C14D36514DC8FB2A8B7BEE655E253D117DFBBAC1F5179EB5BB662ADB` |
| `desktop/release/win-unpacked/SuWen.exe` | 249,801,728 | `469D75AD64B449B98D5DB8F7D1C64C0F988F8D2F99F6B04CD213A4481A0FA991` |

`SHA256SUMS` mirrors in `docs/release/SHA256SUMS.txt`.

## Known limitations (honest)
- Normal `userData/python-env` install flow was exercised via a temp-dir override, not the default
  path end-to-end.
- Real vendor model accounts, SSH hosts and channel peers were not configured, so live provider
  calls and legacy SSH/channel actions remain `BLOCKED_EXTERNAL` / unverified.
- Hidden legacy views' deep actions (files/jobs/registry/memory/ssh/figures) were smoke-verified but
  not exhaustively clicked through.
- SPA is zh-CN only; no accessibility/DPI audit for the hosted window.
- Installer is **UNSIGNED** (no certificate -> SmartScreen warning expected); clean-Windows-VM
  install and 8/24/72 h endurance/reboot/power-loss remain **NOT RUN**.
