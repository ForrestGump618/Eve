# Source Inventory — Python baseline → vNext workspace

Date: 2026-10-25 (Asia/Shanghai)
Owner: docs-audit (task-3, D)
Status vocabulary: IMPLEMENTED_PASS | BLOCKED_EXTERNAL | FAIL | NOT_STARTED | UNVERIFIED (only PASS counts as complete)

## 1. Definitions

| Role | Path |
|---|---|
| SOURCE_ROOT (read-only legacy project) | `C:\Users\Qingyuan Zhuang\Documents\Codex\2026-10-23\c-users-qingyuan-zhuang-documents-deepseek-2\outputs\omicslab` |
| TARGET_ROOT (vNext only workspace) | `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext` |
| Branch (both) | `suwen-vnext-durable` |
| HEAD (both) | `8cabac35771fde9378b7345d591dfac2a3e368c4` ("fix: enforce turn guards and merge streams; add guided Weixin QR setup") |
| Rollback tag | `suwen-vnext-baseline-20261024` @ `8cabac3` |
| Remote | `https://github.com/ForrestGump618/suwen.git` (origin) |

## 2. How the copy was made

- Mechanism: `robocopy /E` per Lead's delivery record, excluding `desktop\node_modules`, `desktop\release`, `desktop\dist`, `dist`, `build`, `omicslab.egg-info`, `.pytest_cache`, `.omicslab`.
- Lead-recorded totals: 329 directories / 1,084 files / 13.69 MB.
- `desktop/node_modules` was restored in TARGET from local cache afterwards (npm install, ~502 MB, build dependency — not part of the copy).
- Copy was then verified independently by this audit with a SHA-256 hash map (see [copy-verification.md](copy-verification.md)).

## 3. Verified tree totals

Measured with `Get-ChildItem -Recurse -File` on 2026-10-25 (includes `.git`; SOURCE numbers include excluded build dirs, TARGET has none of them).

| Tree | Files | Bytes | Notes |
|---|---:|---:|---|
| SOURCE_ROOT total | 9,812 | 1,151.39 MB | includes node_modules, release, dist, build, caches |
| `.git` (SOURCE = TARGET) | 654 | 4.14 MB | all 654 blobs identical (see copy-verification) |
| TARGET_ROOT total | 9,262 | — | no `.omicslab`, `.pytest_cache`, `build`, `dist`, `omicslab.egg-info` |

### Top-level comparison (verified counts)

| Area | SOURCE files | SOURCE bytes | TARGET files | TARGET bytes |
|---|---:|---:|---:|---:|
| `.github` | 7 | ~ | 7 | — |
| `docs` | 71 | 4.03 MB | 76 | 4.13 MB |
| `omicslab` (Python) | 248 | 3.71 MB | 248 | 3.71 MB |
| `tests` (Python) | 34 | 1.23 MB | 34 | 1.23 MB |
| `scripts` | 10 | 0.08 MB | 10 | 0.08 MB |
| `desktop` (new Electron app) | 8,557 | 1,008.15 MB (node_modules+release+dist) | 8,218 | 502.88 MB (node_modules; no release) |
| `.git` | 654 | 4.14 MB | 654 | 4.14 MB |
| root files | 15 | — | 15 | — |

SOURCE build/release-only dirs excluded by design: `build` (163 files / 2.19 MB), `dist` (7 files / 126.34 MB), `omicslab.egg-info` (6), `.pytest_cache` (5), `.omicslab` user state (35 files / 1.32 MB, not copied intentionally).

## 4. Content differing between SOURCE and TARGET (verified)

Hash comparison over the 327 non-excluded SOURCE files / 362 non-excluded TARGET files:

| Class | Count | Detail |
|---|---:|---|
| Hash-identical shared files | 326 | includes all 654 `.git` files (all identical) |
| Differing shared file | 1 | `desktop/src/harness/store.ts` — SOURCE `B912E6D8…D03A` vs TARGET `8870945D…981F` (modified in TARGET after the copy by the Lead; schema v3 records layer) |
| Only in SOURCE | 0 | nothing was lost by the copy |
| Only in TARGET | 35 | 29 compiled `desktop/dist-lead/*.js`, plus `desktop/src/import-service.ts`, `desktop/src/shared/contract.ts`, `desktop/test/import-service.test.ts`, `docs/architecture/vnext-contract.md`, `docs/requirements/master-requirements-source.md`, `docs/research/repro/copy-verify.ps1` |

Reconciliation of the Lead's 1,084 files / 13.69 MB figure: 430 non-`.git` files (incl. 103 `__pycache__` files) + 654 `.git` files = 1,084; 9.55 MB + 4.14 MB = 13.69 MB. The copied directory count enumerated here is 328 (Lead recorded 329; difference is a counting convention for the root/one late directory — not a missing tree, as no SOURCE-only files exist).

## 5. Git verification (R001/R003)

Read-only `git status --porcelain` / `git log` / `git rev-parse` were run in BOTH trees on 2026-10-25:

- TARGET: branch `suwen-vnext-durable`, HEAD `8cabac3…`, **32 porcelain entries** = 25 modified tracked files + 7 untracked paths (`.github/workflows/suwen-windows.yml`, `desktop/`, `docs/architecture/`, `docs/progress.md`, `docs/release-notes-vnext.md`, `docs/requirements/`, `docs/research/`).
- SOURCE: same branch, same HEAD, same commit log, **31 porcelain entries** — identical 25 modified tracked files; untracked list is the same except `docs/requirements/` (created only in TARGET by the Lead).
- The 25 tracked modifications are a pre-existing uncommitted brand-rename/bugfix batch (OmicsLab→SuWen display name; `omicslab/__init__.py` `__app_name__ = '素问 SuWen'`; pyproject author; README/docs; `session/jobs.py` race fix; `tests/test_session.py`). They are byte-identical in SOURCE and TARGET, so the vNext work did **not** modify SOURCE tracked files.
- `.git` directory: 654/654 files identical → history is provably the same checkout, and SOURCE has not received commits from the vNext branch.

Conclusion: **SOURCE untouched by this work (IMPLEMENTED_PASS)**; evidence = `docs/migration/copy-verification.md`, `docs/research/evidence/audit-source-hashes.csv`, `docs/research/evidence/audit-target-hashes.csv`, `docs/research/repro/copy-verify.ps1`.

## 6. TARGET additions that are expected (vNext, not copy defects)

- `desktop/` — new Electron/TypeScript app (prototype + Lead vNext modules; see parity matrix).
- `docs/architecture/` — Lead contract/plan/decision docs.
- `docs/requirements/master-requirements-source.md` — Lead requirement register.
- `docs/research/` — audit evidence corpus (prototype logs) + this audit's scan/repro outputs.
- `docs/progress.md`, `docs/release-notes-vnext.md`.
- `.github/workflows/suwen-windows.yml` (draft → replaced by this audit with a real Windows CI job).
- `docs/migration/`, `docs/verification/`, `docs/release/` — audit deliverables (this work).

## 7. Reproduce

```powershell
pwsh docs/research/repro/copy-verify.ps1 `
  -Source 'C:\Users\Qingyuan Zhuang\Documents\Codex\2026-10-23\c-users-qingyuan-zhuang-documents-deepseek-2\outputs\omicslab' `
  -Target 'C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext' `
  -OutDir (Join-Path (Get-Location) 'docs\research\evidence')
```

The script writes `audit-source-hashes.csv` and `audit-target-hashes.csv` (relative path + SHA-256 + length) and prints the identical/differing/only-source/only-target summary used above. It performs only reads in SOURCE.
