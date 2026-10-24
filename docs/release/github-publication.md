# GitHub MIT publication runbook — SuWen vNext

Status: **BLOCKED_EXTERNAL in this environment — never executed**. Nothing in this file is a claim
that publishing happened. The repository remote is readable, but the `gh` CLI is absent and no GitHub
token is present in the session, so no commit/tag/Release/asset upload was attempted.

## 1. Current state (measured 2026-10-25)

| Item | Value |
| --- | --- |
| Local workspace | `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext` |
| Local branch / HEAD | `suwen-vnext-durable` / `0024e73` ("SuWen 3.1.0: full desktop takeover, durable harness and Windows release") |
| Remote | `https://github.com/ForrestGump618/suwen.git` |
| Remote state | reachable; `main` = `8cabac3` (round-2 baseline commit) |
| Push state | round-2/round-3 work is **uncommitted** in the working tree (many untracked files: `desktop/`, `docs/`, `.github/workflows/suwen-windows.yml`, …) |
| `gh` CLI | not installed (`Get-Command gh` fails / absent) |
| GitHub auth | no `GITHUB_TOKEN` / `GH_TOKEN` in environment; git credential helper `manager` configured but no remote write performed |
| MIT licence | `LICENSE` (MIT, desktop), `desktop/LICENSE`, `NOTICE`, `desktop/third-party-licenses/`, SBOM; Python legacy keeps Apache-2.0 and is shipped as compatibility source |
| Secret scan | `desktop/scripts/security-scan.mjs` → **PASS**, 0 unresolved HIGH / 18 LOW / 10 documented test fixtures, 408 tracked files, 13 commits |
| CI workflow | `.github/workflows/suwen-windows.yml` authored; **never run** on GitHub |

## 2. Preconditions (all must be true before publishing)

1. All gates in `docs/release/release-gates.md` that are release-blocking are PASS or explicitly
   accepted by the release owner (G3/G4/G5/G6/G8 are currently open).
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

## 3. Procedure (run by whoever has credentials; none of this has been run)

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

- Repository remote is readable and writable via the user's existing SSH key over `ssh://git@ssh.github.com:443/ForrestGump618/suwen.git` (HTTPS push to `github.com:443` was blocked by the host network).
- Source publication **succeeded**: branch `suwen-vnext-durable` and annotated local tag `suwen-vnext-3.2.0` were pushed; final verified commit is `8741d47` (previous commit `8646fd7`).
- GitHub **Release asset upload was NOT performed**: no `gh` CLI and no `GITHUB_TOKEN`/`GH_TOKEN` in this environment, and the release decision is **HOLD** because G9 (publication readiness) and clean-VM/signing/endurance gates are not satisfied. The installer `SuWen-Setup-3.2.0-win-x64.exe` therefore exists only locally (path/hash above); it is not downloadable from a Release URL.
- Never claim a Release URL, uploaded asset, green CI, signed installer, or clean-VM-verified release.

## 4. If credentials remain unavailable

Publishing is genuinely blocked (no `gh`, no token). Required unblock conditions:

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
- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap` — 135,948 B — SHA-256 `283B27E1…1AC2`.
- `desktop/release/SHA256SUMS` — mirrored at `docs/release/SHA256SUMS.txt`.
- Publication status: **BLOCKED_EXTERNAL** (no `gh` CLI, no token); CI has **never executed**.
  Never claim a Release URL, a green CI run, a signed installer, or a clean-VM-verified release.
