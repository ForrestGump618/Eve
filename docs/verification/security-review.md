# Security review — SuWen Desktop vNext (round 3)

Status: **reviewed + automated scan PASS (with explicit limitations)**.
Date: 2026-10-25 (Asia/Shanghai). Auditor: docs-audit (D, read-only source review).
Scope: `desktop/src/**`, `desktop/ui/**`, `desktop/worker/**`, `desktop/scripts/**`, repository
history and tracked files. Not scope: Windows OS internals, third-party binary audit, penetration
test, and a clean-VM runtime.

Artefacts:
- static secret/credential scan: `docs/verification/artifacts/security-scan.json`
- measurement run: `node desktop/scripts/security-scan.mjs --out docs/verification/artifacts/security-scan.json`
- dependency inventory: `docs/verification/third-party-dependencies.md`
- release gates: `docs/release/release-gates.md` (Gate 7)

## 1. Automated scan result (measured 2026-10-25)

| Metric | Value |
| --- | --- |
| verdict | **PASS** (0 unresolved HIGH) |
| tracked files scanned (paths) | 638 |
| text files scanned | 420 |
| git history commits scanned | 17 |
| HIGH findings | 0 |
| LOW findings (documentation/test-adjacent) | 48 |
| accepted test fixtures (documented below) | 14 |
| tracked forbidden files (`.env`, private keys, SSH material) | 0 |
| `.gitignore` covers `.env` | true |
| `.gitignore` covers `*.pem`/`*.key`/`id_rsa` | true |
| `npm audit --omit=dev` | 0 vulnerabilities (0 low/moderate/high/critical) |

The scan covers both the working tree and every added line in the 17 scanned commits. Findings are
printed, never suppressed: accepted fixtures are listed in the JSON report under
`acceptedTestFixtureFindings` and summarised here.

### Accepted test fixtures (credential-shaped, not real secrets)

| Rule | File:line | Value (fixture) |
| --- | --- | --- |
| api-key-assignment | `desktop/test/providers.test.ts:27` | `fixture-enterprise-credential` (local HTTP protocol fixture) |
| bearer-token-literal | `desktop/test/providers.test.ts:34` | `Bearer fixture-enterprise-credential` |
| password-assignment | `tests/test_ssh.py:471` | `p@ssw0rd` (dummy SSH profile) |
| password-assignment | `tests/test_ssh.py:490` | `pw-remember` (dummy) |
| password-assignment | `tests/test_ssh.py:833` | `ui-only-password` (dummy) |
| password-assignment | `tests/test_suwen_platform.py:421` | `private-pass` (dummy settings fixture) |
| openai-style-key | `desktop/scripts/e2e-research.mjs:654` | `sk-legacy-e2e-sentinel-…` (deterministic E2E sentinel; tests assert it never leaks into views/logs) |
| api-key-assignment | `desktop/scripts/e2e-research.mjs:818` | `fixture-key-not-a-real-credential` (local OpenAI-compatible fixture configuration) |
| (history copies) | same files in git history | same fixture strings |

These values are wired only into local fixtures/tests; they are not account credentials, not used by
the shipped app, and the tests assert they are never echoed into user-facing errors
(`providers.test.ts` asserts error messages do not contain the fixture key).

## 2. Electron trust boundaries (code review)

| Control | Evidence |
| --- | --- |
| Renderer sandboxing | `desktop/src/main.ts:108` — `contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true` |
| Window-open / navigation | `desktop/src/main.ts:110` — `will-navigate` allows only the local `ui/index.html` file URL; `window.open` denied |
| Permission requests | `desktop/src/main.ts:111` — every permission request denied by default |
| IPC sender validation | `desktop/src/main.ts:112-113` — `suwen:call` accepts only the main window's webContents + mainFrame + exact `file://` UI URL, otherwise `Untrusted sender` |
| Main-only methods | `desktop/src/main.ts:102` — `MAIN_ONLY` set (`settings,configure,login,reconnect,pythonPicker,legacyOpen,shutdown,support,secrets.*,events.stream`) so the renderer cannot call daemon internals directly |
| Preload surface | `desktop/src/preload.cts:1-18` — frozen `window.suwen` with `call`, `onEvent`, `onConnection` only; no Node APIs exposed |
| CSP | `desktop/ui/index.html` meta: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` — `style-src` allows inline styles **only** so the offline-vendored KaTeX (0.16.21) and Mermaid (11.12.0) renderers can typeset formulas and diagram styles; `script-src` stays `'self'`, `connect-src` stays `'none'`, no remote origins are allowed. Documented trade-off: inline CSS is not a script-execution vector here, but a stricter deployment could keep `style-src 'self'` and accept labeled Mermaid source fallback (see `docs/verification/markdown-rendering.md`). |
| Legacy Python window isolation | `desktop/src/main.ts:129-136` — separate session partition, `contextIsolation`, no Node, own permission handler, same-origin navigation check; bearer token injected only for its own webContents |
| Credential storage | `desktop/src/main.ts:89-99` — Electron `safeStorage` encryption; refuses to write plaintext when encryption unavailable; files written `0600` via temp+rename |
| Named-pipe authentication | `desktop/src/security.ts` — per-run random pipe suffix + 32-byte token, constant-time `secretEqual` (`timingSafeEqual` with length check), atomic `connection.json` (0600), stale-lock protection |
| Path traversal in legacy import | `desktop/src/import-service.ts:48-49` — rejects absolute/`..`/drive-letter relative paths; symlinks skipped; read-only source |
| Artifact read confinement | `desktop/src/rpc/core.ts` — `artifact.read` resolves under `<home>/artifacts`, text capped 200 KB, binary 4 MB, truncation flagged |
| Secret redaction | `docs/requirements/master-requirements.csv` R093 + `src/security.ts` `safeError` redaction of token/password/secret shapes |
| Shell execution | No `shell:true`; spawn sites use explicit argv and `-E`/`-I` isolated Python flags (`legacy-worker.ts:19`, `python-worker.ts:6`, `mcp-client.ts:113`, `research-worker.ts:463`); `taskkill` via `execFile` |
| Dependency/supply chain | pinned Electron 45 / Node 24 runtime, `package-lock.json`, SBOM (`npm sbom --omit=dev`, CycloneDX 1.5), license inventory (`desktop/third-party-licenses/`) |

Known local test-environment caveat: the developer shell inherits `ELECTRON_RUN_AS_NODE=1` from DSH,
so Electron executables launch as Node. Installer/lifecycle smoke scripts remove that variable for
the launched process only; the shipped application is unmodified. This is a test-harness caveat, not
a product defect.

## 3. Gap register (explicit)

1. **No OS-level sandbox/quotas** for the Python worker beyond a per-run temporary home, timeout,
   output cap and env allowlist. R144 is `NOT_STARTED`.
2. **No penetration test / no CVE resolution beyond `npm audit`**. Static review only.
3. **Prompt-injection handling** is a model-prompt instruction (external content treated as data) and
   was not dynamically tested with adversarial MCP/tool output.
4. **SSRF** surface is limited to configured provider base URLs/embedding endpoints and MCP HTTP
   URLs; URL validation exists but was not fuzzed.
5. **No code signing** (no certificate): SmartScreen warning expected; release honesty requires
   saying this (see `docs/release/windows-installer-verification.md`).
6. `LICENSE`/`NOTICE`/SBOM are present, but a comprehensive legal review of every transitive
   Chromium/Electron notice was not performed (SBOM covers runtime JS dependencies; Electron ships
   its own Chromium license file).

## 4. Verdict

- No live credential, token, private key or tracked secret was found in the working tree or history
  (0 HIGH; 14 documented test fixtures).
- The Electron trust boundary uses the required controls (sandboxed renderer, contextIsolation,
  frozen preload, sender-validated IPC, CSP, safeStorage, authenticated named pipe).
- **Residual risk remains** in the gaps above; this review is not a certification. Gate 7 is PASS for
  scan/licence/compliance checks with the listed limitations, and R144 stays `NOT_STARTED`.
