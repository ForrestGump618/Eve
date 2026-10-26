# 素问 / SuWen desktop 3.4.0

默认直接打开完整科研工作台。运行 `./启动素问.ps1`（或 `npm ci; npm run build; npm start`）；原生诊断控制台使用 `-NativeConsole` / `--native`。本版本包含工作目录文件访问、折叠工具过程、8 个基础技能及有限输出接续。

本清理目录重新通过 typecheck、243 项单元测试（1 项跳过）与 520 项 Python 测试；已验证的 3.4.0 安装包在交付文件夹中的 `Windows/`（与 Source/ 同级）。当前版本真实模型 22 项任务被供应商 HTTP 429 阻断，不能声明达到真实模型验收门槛。见 [3.4.0 原始交付报告](../docs/verification/product-340-20261026/README.md) 和 [清理记录](../CLEAN-RELEASE.md)。

以下为 **3.3.0 历史记录**，不能当作本轮最终代码的验收声明。

New Electron/TypeScript client plus an independent authenticated user-level daemon. The original
Python research workbench remains in the parent repository and can be opened as an optional,
isolated compatibility window. **This is an evidence-tested incremental release, not completion of
the full vNext acceptance matrix and not a published release.**

## Build & verify (Windows, Node 24.14+, npm)

```powershell
npm ci
npx tsc -p tsconfig.json --noEmit     # typecheck
npm test                              # build + node --test dist/test/*.test.js
node scripts/e2e-rpc.mjs --dist dist --live
$env:SUWEN_SMOKE_PACKAGED=1; node scripts/electron-smoke.mjs
node scripts/ui-dom-qa.mjs
node scripts/streaming-ui-e2e.mjs --mode=final
npm run dist:win                      # NSIS x64 installer into release/
```

Measured on this machine (final 3.3.0 build, 2026-10-25, branch `suwen-vnext-durable`):

| Check | Result |
|---|---|
| `npm test` | **222 tests / 220 pass / 0 fail / 2 skipped**, 86 s, exit 0 |
| `e2e-rpc.mjs --live` (real detached daemon over authenticated pipe) | **42 passed / 0 failed**, ~7 s, incl. real Europe PMC/PubMed (PMID 42878939) + UniProt (Q9Y2B4) calls |
| packaged `electron-smoke.mjs` (final build, hosted workbench deps) | **10/10 checks, passed**, incl. hosted legacy SPA window (12 nav items / 12 routes) |
| `ui-dom-qa.mjs` | **18 passed / 0 failed / 13 warnings** (main-process bridge methods); 148 actions, 84 RPC-contract entries + main bridge |
| hosted workbench E2E | **34/34 checks**, 12/12 legacy routes, 0 page/console errors, 0 CSP violations, 19 screenshots |
| runtime smoke / config injection | **27/27** / **13/13** (managed Python runtime, isolated bridge, model config handoff) |
| markdown unit tests | **32/32** (progressive streaming, KaTeX, Mermaid, tables, degradation) |
| chaos (short window) | 12/12 scenarios, 53.4 s (worker/daemon SIGKILL, idempotency, cancel, provider 429→500→200 with approvals) |
| installer | `release/SuWen-Setup-3.3.0-win-x64.exe`, **131,011,183 B**, SHA-256 `0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03`, **UNSIGNED**; host lifecycle 12/12 + upgrade from 3.0.0-preview.1 (clean VM NOT run) |

Skip reasons: Windows symlink `EPERM` in one research-worker test; optional legacy Python workbench
dependencies missing on the build machine. Full results: `../docs/verification/integration-and-e2e.md`,
`../docs/verification/e2e-results.md`, `../docs/verification/ui-e2e.md`,
`../docs/release/final-acceptance-report.md`.

## What works without Python

- Five workspaces (chat / projects / tasks / tools / settings), zh/en labels, typed streaming chat
  (`events.stream` protocol, incremental render, composer/scroll stability, connection banner and
  bounded auto-reconnect), evidence panel, import wizard, task DAG/events/checkpoints/costs.
- Configure your own OpenAI-compatible or Anthropic endpoint/key in Settings. Keys are encrypted by
  Electron `safeStorage`; no cleartext fallback. Provider protocols are verified against **local HTTP
  fixtures only** — no external paid-account success is claimed.
- Detached daemon with authenticated current-user named pipe; closing the UI keeps it alive;
  Settings can quit it safely. Login recovery is opt-in user-level startup; **no Windows Service**.
- SQLite WAL state: durable DAG, leases/fencing/heartbeat, durable timers, outbox/idempotency,
  checkpoints, budgets, cancel/pause/resume, unknown-side-effect reconciliation.
- Independent ContextManager/CompactionService: known-model tokenizer + conservative estimate,
  structured source-linked summaries, versions/manual compaction/rollback. Ten ~201k-token rounds
  reduced to ~2.0–2.8k; explicit constraints/evidence/user text retained 100% — **not a claim of
  semantic losslessness**.
- Read-only MCP registries and real public Europe PMC/PubMed + UniProt queries; research workflows
  (knowledge/hypothesis/debate/methods/analysis/discovery/autonomy), RSI loop, channels adapter
  (read-only default, safeStorage credential refs) as durable typed workflows.
- Optional Python research worker (`worker/research_worker.py` v2.0.0, pure stdlib): fixed numeric
  analyses plus a `runScript` sandbox with timeouts/output caps/env allowlist/file digests. It is
  **not** an OS sandbox and does not bundle scientific stacks.

## Legacy compatibility / data

New data lives in Electron's userData `SuWen/runtime` (shown in Settings), separate from the old
Python data (`%LOCALAPPDATA%/OmicsLab`, `~/.omicslab`). Legacy packages, env vars, storage keys and
data dirs are intentionally retained as compatibility identifiers (see
`../docs/research/branding-exceptions.md`). The importer is explicit and backup-first:
`import.inspect` is read-only, `import.apply` backs up then applies idempotently, `import.rollback`
is unit-tested. **Nothing is imported automatically.** The full legacy workbench can be opened from
Tools in an authenticated isolated window; on this host it is unavailable because the optional
Python environment lacks `fastapi` — that is reported, not claimed as a pass.

## Not complete (explicit)

- Clean-Windows-VM install/upgrade/uninstall lifecycle: **NOT RUN**. Host probe passed 12/12
  (install, version metadata, running app, authenticated daemon attach, daemon survives UI close,
  reinstall, uninstall, user data preserved) and the upgrade source `3.0.0-preview.1` installed
  successfully — but that is **not a clean machine**.
- Installer is **UNSIGNED** (SmartScreen warning expected); `SHA256SUMS` is present in
  `release/SHA256SUMS` (mirrored at `../docs/release/SHA256SUMS.txt`); Windows CI workflow exists but
  was **not executed**.
- No 8/24/72-hour endurance, reboot, sleep/hibernate, power-loss or disk-full tests.
- Real external model accounts, code signing and full OS-level sandbox/quotas: **not verified /
  blocked by environment**. No OS-level CPU/memory/disk quotas.
- Paper2Agent/Biomni/ERA/Robin/Kosmos integrations, the 23 legacy scientific skills inside the new
  registry, SSH/terminal/kernel/workspaces, trajectories UI, model routing, vision — **not started**.
- T2 post-fix SIGKILL/reconnect re-run and the visual acceptance matrix (`ui-visual-audit.md`) were
  not published; those requirement rows remain UNVERIFIED.
- GitHub MIT publication/Release assets: **BLOCKED_EXTERNAL** (`gh` absent, no token) — not performed.

See `../docs/progress.md`, `acceptance-matrix.md`, `../docs/migration/feature-parity-matrix.md`,
`../docs/release/release-gates.md` and `../docs/requirements/master-requirements.csv` for row-level
evidence. Do not describe 3.2.0 as a production-ready, clean-machine-verified or fully vNext-complete
release.
