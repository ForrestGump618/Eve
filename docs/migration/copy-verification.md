# Copy Verification — SOURCE → TARGET (R001 / R002 / R003)

Date: 2026-10-25 (Asia/Shanghai)
Verifier: docs-audit (D), read-only on SOURCE
Status: **IMPLEMENTED_PASS** for the copy itself; TARGET is the confirmed sole vNext development workspace.

## 1. Method

1. Enumerated both trees with `Get-ChildItem -Recurse -File` and SHA-256 hashed every file (`Get-FileHash -Algorithm SHA256`).
2. Excluded non-deliverable/generated paths on both sides:
   `.git` (verified separately), `.pytest_cache`, `.omicslab`, `build`, `dist`, `omicslab.egg-info`, `desktop\node_modules`, `desktop\release`, `desktop\dist`, `__pycache__`.
3. Compared by normalized relative path; produced four classes: identical, differing, only-in-SOURCE, only-in-TARGET.
4. Verified `.git` separately by hashing all 654 files in both trees.
5. Re-ran `git status`, `git branch --show-current`, `git rev-parse HEAD`, `git log --oneline` in both trees.
6. Reconcile with Lead's recorded copy totals (329 dirs / 1,084 files / 13.69 MB).

Machine output: [../research/evidence/audit-source-hashes.csv](../research/evidence/audit-source-hashes.csv), [../research/evidence/audit-target-hashes.csv](../research/evidence/audit-target-hashes.csv); script: [../research/repro/copy-verify.ps1](../research/repro/copy-verify.ps1).

## 2. Results

| Metric | SOURCE (after exclusions) | TARGET (after exclusions) |
|---|---:|---:|
| Files | 327 | 362 |
| Total bytes | 7,394,632 | 7,690,221 |

| Class | Count | Verdict |
|---|---:|---|
| Hash-identical files | 326 | Expected |
| Differing shared files | 1 | Expected (post-copy Lead edit, see §3) |
| Only in SOURCE | 0 | PASS — nothing lost |
| Only in TARGET | 35 | Expected vNext additions (see §4) |

`.git`: 654 files in SOURCE, 654 in TARGET, **654 identical, 0 differing, 0 only-in-one-side** → same repository history is present in both trees.

Lead-record reconciliation: 430 non-git files (incl. 103 `__pycache__` files excluded above) + 654 `.git` files = **1,084 files**; 9.55 MB + 4.14 MB = **13.69 MB**. This matches the Lead's recorded copy figures exactly. The directory tally here is 328 vs the Lead's 329; the one-directory delta is a root/rounding counting convention, and is not a missing tree because there are **zero** SOURCE-only files.

## 3. The single differing file (expected, not drift)

`desktop/src/harness/store.ts`

- SOURCE: `B912E6D8122AD9434009C8424FCE29BBD344B202EF7A18C7E455C42BF386D03A` (prototype version)
- TARGET: `8870945DDC4DABC7F002261591A0C97754C55DCCD4258B1E1675F0B05E40981F` (vNext schema v3: `records` table, outbox, checkpoints, lease/fence, durable timers; written by Lead after the copy at 2026-10-25 00:37)
- Therefore: SOURCE is the untouched baseline; TARGET contains the vNext evolution. This is the expected direction of change.

## 4. The 35 files only in TARGET (expected vNext additions)

| Group | Files |
|---|---|
| Lead vNext desktop code (28) | `desktop/dist-lead/*.js` compiled output plus `desktop/src/import-service.ts`, `desktop/src/shared/contract.ts`, `desktop/test/import-service.test.ts` |
| Lead contracts/requirements | `docs/architecture/vnext-contract.md`, `docs/requirements/master-requirements-source.md` |
| This audit's reproducibility | `docs/research/repro/copy-verify.ps1` |

(`desktop/dist-lead` is build output of Lead modules written before the shared `tsc` pipeline was re-run; it is not hand-written source and is not used by `npm test`, which compiles to `dist/`.)

## 5. Git/commit verification

| Check | SOURCE | TARGET | Verdict |
|---|---|---|---|
| Branch | `suwen-vnext-durable` | `suwen-vnext-durable` | same |
| HEAD | `8cabac35771fde9378b7345d591dfac2a3e368c4` | same | same |
| Log (top 4) | 8cabac3 / 4c25b17 / 061e6c4 / 55ce901 | same | same |
| Porcelain entries | 31 | 32 | TARGET +`docs/requirements/` untracked only |
| `.git` object files | 654 | 654 | 654 identical |

The 25 tracked modifications in both trees are the pre-existing uncommitted brand-rename batch (display name 素问 SuWen while keeping `omicslab` package/data/env identifiers for compatibility) plus a `session/jobs.py` race fix and its test. They exist identically in SOURCE, i.e. they predate the copy and are not edits made by the vNext work.

## 6. Verdict

- R001 copy audit + non-destructive copy: **IMPLEMENTED_PASS** (copy done; SOURCE zero-file loss; SOURCE history unmodified).
- R002 TARGET marked as vNext sole workspace: **IMPLEMENTED_PASS** — `README.md` line 3 carries the vNext preview banner pointing to `desktop/` and `docs/progress.md`; branch/rollback tag recorded in `docs/progress.md` / `docs/architecture/migration-plan.md`.
- R003 manifest/hash sampling + git/commit cross-check + before/after consistency: **IMPLEMENTED_PASS** (this document + CSV evidence; SOURCE re-hashed and unchanged against TARGET copies).

## 7. Residual caveats (honest)

- Hash comparison covers tracked text/binary source, not `node_modules` (third-party, not copied) nor the un-copied user-state dirs (`.omicslab`, `.pytest_cache`, `build`, `dist`, `omicslab.egg-info`) which are deliberately excluded. Their absence in TARGET is by design, not data loss of source.
- SOURCE has no pre-copy hash snapshot in the repo; non-modification is evidenced by (a) all 326 shared files still hash-identical, (b) identical `.git` (654/654), and (c) unchanged git status/log. A hostile third party could in theory have made and reverted an edit, which this method cannot exclude — no such edit is observed.
