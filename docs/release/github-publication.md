# GitHub MIT publication runbook — SuWen vNext

Status: **SOURCE PUBLISHED; RELEASE ASSETS NOT PUBLISHED (BLOCKED_EXTERNAL)**. The repository remote
is writable via the user's existing SSH key; branch `suwen-vnext-durable` and annotated tag
`suwen-vnext-3.2.0` were pushed (measured 2026-10-25). The two-job Windows CI workflow executes on
GitHub and is green (run `40142902006`). No GitHub Release, Release asset, branch-protection change
or repository-settings change was performed: the release decision is **HOLD** (clean-VM lifecycle,
signing and endurance gates remain unverified; `gh`/token absent). Never read this file as a claim
that a Release exists.

## 1. Current state (measured 2026-10-25, round 4)

| Item | Value |
| --- | --- |
| Local workspace | `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext` |
| Local branch / HEAD | `suwen-vnext-durable` / `5ac5bd4` + round-4 working tree (see §3b) |
| Remote | `https://github.com/ForrestGump618/suwen.git` (public) |
| Remote state | source branch + tag `suwen-vnext-3.2.0` pushed (SSH over port 443; HTTPS push blocked by host network) |
| CI | `.github/workflows/suwen-windows.yml` executes: **run 40142902006 SUCCESS on `5ac5bd4`** (Desktop Node job + Python baseline job). Earlier real failures were fixed, not hidden (worker optional-numpy assertion; scoped e2e fixture tokens in the secret scan). |
| `gh` CLI | not installed (`Get-Command gh` fails / absent) |
| GitHub auth | no `GITHUB_TOKEN`/`GH_TOKEN` in the environment; git credential helper `manager` holds a usable GitHub credential (used through git only; never printed) |
| MIT licence | `LICENSE` (MIT at repo root for vNext), `desktop/LICENSE`, `NOTICE`, `desktop/third-party-licenses/`, SBOM; legacy Python keeps Apache-2.0 and is shipped as compatibility source |
| Secret scan | `desktop/scripts/security-scan.mjs` → **PASS**, 0 unresolved HIGH / 48 LOW / 14 documented test fixtures |
| Release assets | local only: installer 129,447,101 B SHA-256 `4590B7F3…B230B897` (**UNSIGNED**), blockmap, `win-unpacked/SuWen.exe`; mirrored in `docs/release/SHA256SUMS.txt` |
| Documented-hash check | `node scripts/verify-doc-hashes.mjs` → PASS; wired into CI |

## 2. Preconditions (all must be true before publishing)

1. All gates in `docs/release/release-gates.md` that are release-blocking are PASS or explicitly
   accepted by the release owner (G6/G8 currently PASS_WITH_LIMITS; clean-VM/signing/endurance open).
2. Final evidence round completed and `docs/release/final-acceptance-report.md` signature block filled
   (final test numbers, installer path/bytes/SHA256, CI link, clean-VM result).
3. `security-scan.mjs` PASS on the **final committed tree** (history scan included).
4. `npm audit --omit=dev` 0 vulnerabilities; SBOM regenerated from the final lockfile.
5. Clean-Windows-VM lifecycle result recorded (or the release explicitly labelled as not clean-VM
   verified, with the limitation in the release notes).
6. 3.2.0 version bump **already applied** (`desktop/package.json:3`, package-lock root) — rebuild the
   installer, checksum it and re-hash independently; `docs/release/CHANGELOG.md` entry present.
7. Working tree review: no secrets, no patient/clinical data, no private research data, no local user
   DBs or logs, no `.env`, no `.omicslab` user data, no `dist-*`/`release/` artifacts committed
   unless intentionally attached to the Release.
8. `.gitignore` covers build outputs (`dist*/`, `release/`, `node_modules/`, `*.log`, user state).

## 3. Procedure (source steps §3a were executed; Release steps 4–5 were NOT executed)

```powershell
# 0) from the workspace root
git status --short            # review every path; stage intentionally, not -A blindly
git diff --check              # whitespace errors

# 1) final verification on the exact tree to publish
cd desktop
npx tsc -p tsconfig.json --noEmit
npm run build
npm test
node scripts/e2e-rpc.mjs --dist dist --live
node scripts/security-scan.mjs --out ../docs/verification/artifacts/security-scan.json
npm run dist:win

# 2) 3.2.0 version bump already applied by the Lead (package.json + package-lock root); rebuild now,
#    record new exe path/bytes/SHA256 and regenerate SHA256SUMS

# 3) commit + tag (short history; do not rewrite published commits)
git add <explicit paths>
git commit -m "release: SuWen 3.2.0"
git tag -a suwen-vnext-3.2.0 -m "SuWen Desktop 3.2.0"
git push origin suwen-vnext-durable
git push origin suwen-vnext-3.2.0            # or merge into main per repository policy

# 4) GitHub Release (requires gh auth or the web UI)
gh release create suwen-vnext-3.2.0 `
  "desktop/release/SuWen-Setup-3.2.0-win-x64.exe" `
  "desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap" `
  "desktop/release/SHA256SUMS" `
  --title "SuWen Desktop 3.2.0" --notes-file docs/release/release-notes-suwen-vnext-3.2.0.md

# 5) verify online
gh release view suwen-vnext-3.2.0 --json url,tagName,assets
(Invoke-WebRequest https://github.com/ForrestGump618/suwen/releases/download/suwen-vnext-3.2.0/SuWen-Setup-3.2.0-win-x64.exe -Method Head).Headers
```

Verify the uploaded installer hash equals the locally tested hash before announcing. If a mistake is
published, delete the Release/tag, rotate any exposed credential, and clean history only if a real
secret was committed (never publish first and scan later).

## 3b. What was actually published (2026-10-25)

- Source publication **succeeded**: branch `suwen-vnext-durable` and annotated tag `suwen-vnext-3.2.0`
  were pushed over SSH (`ssh://git@ssh.github.com:443/ForrestGump618/suwen.git`); HTTPS push to
  `github.com:443` is blocked by this host network.
- GitHub Actions executes the committed workflow: **run 40142902006 on `5ac5bd4` is green** (Desktop
  Node job: typecheck, full unit/integration suite, live RPC E2E, UI DOM QA, security scan, NSIS
  build, SBOM, checksums, artifact upload; Python baseline job: pytest).
- GitHub **Release asset upload was NOT performed**: `gh` CLI and `GITHUB_TOKEN`/`GH_TOKEN` are
  absent, and the release decision is **HOLD** because clean-VM lifecycle, signing and endurance
  gates remain unverified. The installer therefore exists only locally (path/hash in §6); it is not
  downloadable from a Release URL.
- Never claim a Release URL, uploaded asset, signed installer, or clean-VM-verified release. A green
  CI run is a real, verifiable claim (`actions/runs/40142902006`).

## 4. If credentials remain unavailable

Release-asset publication is genuinely blocked (no `gh`, no token in the environment). Required
unblock conditions:

- `gh` CLI installed and authenticated (`gh auth status`) with write access to
  `ForrestGump618/suwen`, **or** a HTTPS token with `repo` scope; and
- permission to push the release branch/tag; and
- a machine with the Windows build (or a successful CI run) to produce the final installer.

Until then the only truthful statements are: repository remote readable, artefacts built locally,
scan clean, publication **not performed**.

## 5. What must never be claimed

- A GitHub Release URL/tag that does not exist.
- CI "green" when the workflow has never executed.
- A signed installer (no certificate exists).
- A clean-VM verified release when only a host probe ran.


## 6. Final 3.2.0 artifact facts (for the eventual upload)

- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — 129,447,101 B — SHA-256
  `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897` — **UNSIGNED**.
- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap` — 135,948 B — SHA-256 `283B27E19D2A943DD940B8E83F748CEB2627950A87CAD509069EFAE4230CBB72`.
- `desktop/release/SHA256SUMS` — mirrored at `docs/release/SHA256SUMS.txt` (checked by `scripts/verify-doc-hashes.mjs`).
- Publication status: source branch/tag pushed; CI green (`40142902006`); **Release assets
  BLOCKED_EXTERNAL** (no `gh`/token) and **HOLD** (clean-VM/signing/endurance unverified).
  Never claim a Release URL, a signed installer, or a clean-VM-verified release.
