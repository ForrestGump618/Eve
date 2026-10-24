# Conflicts, Contradictions and Decisions (requirement vs evidence)

Date: 2026-10-25 · Owner: docs-audit (D)
Purpose: list every contradiction found while building the requirement/parity/verification documents, with the resolution actually applied. Nothing here changes Lead-owned files; items needing Lead action are marked **Lead**.

## C-01 Status vocabulary: register allows 4, task allows 5

- Where: `docs/requirements/master-requirements-source.md` (only `IMPLEMENTED_PASS | BLOCKED_EXTERNAL | FAIL | NOT_STARTED`) vs task-3 instruction (adds `UNVERIFIED`).
- Conflict: code-only or prototype-log-only rows cannot be honestly called PASS, but register has no UNVERIFIED.
- Resolution applied: `master-requirements.csv` uses `UNVERIFIED` for "code exists / prototype evidence only / not executed on current revision", and documents it in the header (`evidence_scope` column distinguishes `TARGET_RUN`, `PROTOTYPE_LOG`, `CODE_ONLY`, `DOC`, `PENDING_LEAD`, `NONE`). Counts remain conservative: only `IMPLEMENTED_PASS` counts complete.
- Owner: Lead (accept the extra status or re-map rows).

## C-02 "Brand implemented" (V2 checklist #5) vs register R090

- Where: `docs/SUWEN-V2-CHECKLIST.md` row 5 `已实现` for the brand; `master-requirements.csv` R090 `UNVERIFIED`.
- Reason: V2 checklist means the *Python baseline package* display brand; R090 additionally demands installer file/app identity/auto-update/paths/logs only SuWen, and requires the new desktop installer which does not exist in TARGET. Also active docs/API text still contains `omicslab` identifiers as compatibility documentation.
- Resolution: R090 UNVERIFIED with explicit gap text; legacy identifiers classified as `LEGACY-BRAND-COMPAT` in `docs/research/branding-exceptions.md`. **Lead decision needed**: is "documented compatibility mentions in active API/architecture docs" acceptable under R090, or must they move to a legacy appendix?

## C-03 Prototype evidence provenance vs TARGET workspace

- Where: `docs/research/evidence/*.log|json` were produced in the prototype workspace `…\2026-10-23\outputs\omicslab` (SOURCE), while the vNext product is built in TARGET `…\SuWen\desktop-vnext`.
- Conflict: logs reference paths/daemon PIDs/artifacts of the prototype, not TARGET; claiming them as TARGET acceptance would be false.
- Resolution: all evidence rows carry `evidence_scope=PROTOTYPE_LOG`; accepted only where the code is hash-identical to the logged prototype (per copy-verification: 326/327 files, only `harness/store.ts` differs). Rows whose files changed after the log (`store.ts` v3, UI shell) are `UNVERIFIED`. **Lead**: re-run desktop suite + packaged E2E in TARGET before release and replace prototype-scoped rows.

## C-04 Desktop suite "48 passed" (progress.md) vs current TARGET sources

- Where: the old prototype log records 48 tests; the Lead re-ran the suite on TARGET 3.1.0:
  `npm test` 150 tests / 148 pass / 0 fail / 2 skipped, 28.3 s, exit 0 (skips: Windows symlink
  capability in a research-worker test; optional legacy Python deps). Packaged smoke 8/8 on the final
  build.
- Resolution: **superseded by TARGET evidence** - the 3.1.0 test log is the current suite result;
  the prototype log is no longer the only basis. Two skips remain explicit and are not counted as
  passes.

## C-05 Installer: prototype artifact vs TARGET final build

- Where: `docs/release-notes-vnext.md` and `build-environment.json` describe a prototype installer
  (129,363,809 B, sha256 `f263af7b...`); a mid-audit 3.1.0 build measured
  82779B90.../129,424,645 B; the Lead then rebuilt from frozen final code:
  **129,425,145 B, sha256 E1A1062CBACAF978F6B60F2A825D2E2E769C231048A65983113E8E434BA07AC4**
  (built 2026-10-24T17:41:52Z, UNSIGNED).
- Conflict: earlier hashes are not the delivered artifact and must not be presented as such.
- Resolution: `windows-installer-verification.md` and all CSVs now carry the final hash only;
  the pre-final hash is documented as superseded and never presented as the delivered artifact.
  R100 = PASS (artifact exists, hashes measured, host lifecycle 14/14 + upgrade 8/8); R119 is
  `UNVERIFIED` only for the clean-VM run and code signing (host probes are not a clean machine);
  `SHA256SUMS` is now generated (`desktop/release/SHA256SUMS`, `docs/release/SHA256SUMS.txt`). Final blockmap: 135,934 B sha256 `72DD2D54...`; unpacked exe 249,801,728 B sha256
  `CFE87F2D...`.

## C-06 Durability claims vs executed tests

- Where: requirement R050 asks for 8/24/72 h + reboot/sleep/disk-full; the current TARGET chaos
  artifact (`docs/verification/chaos-results.json`, finished 2026-10-24T17:34:35.821Z) records
  **12/12 checks passed in 52.2 s**: python-worker SIGKILL retried (attempts 2, 15,173 ms, 1
  artifact); daemon SIGKILL mid-python restored (attempts 2, same operationId, 1 artifact, 26,508 ms);
  committed steps not replayed; cancel produced 0 artifacts; provider 429->500->200 with 3 requests,
  2 human approvals, completed.
- Conflict: short-window fixture-injected faults are not endurance evidence.
- Resolution: R050 stays `UNVERIFIED`/not passed; the artifact's own limits (single Windows session,
  short duration, no 8/24/72 h, no sleep/power-loss/reboot/disk-full, provider faults injected by a
  local HTTP fixture, not a real vendor account) are recorded verbatim in
  `durability-chaos-tests.md`. No endurance number is stated as passed anywhere.

## C-07 Brand scan totals differ from the pre-existing exception doc

- Where: `docs/research/branding-exceptions.md` (before update) said "22 tracked files / 78 changed lines"; this audit's scan reports 787 hits / 131 text files.
- Reason: different scopes — the old number counted lines changed by a rename commit diff; the new scan counts all remaining occurrences of `omicslab|omiclab` case-insensitively in the working tree (including Python package namespace, tests, historical archive, API docs). Neither is wrong; they answer different questions.
- Resolution: rewritten `branding-exceptions.md` documents both the derivation and the classification; `branding-scan.csv` is the machine record. 0 `FIX_REQUIRED` brand-text hits in `desktop/ui`; remaining risks are compatibility identifiers and active-doc mentions (C-02).

## C-08 Encoding corruption in new `desktop/src/rpc/core.ts`

- Where: `desktop/src/rpc/core.ts` (created 2026-10-25 00:41) contained mojibake Chinese string
  literals (UTF-8 file holding GBK-decoded text), e.g. the conversation default title and doctor
  messages around lines 129 and 312-332. The exact corrupted glyphs are not reproduced here because
  copying them corrupts this document too.
- Conflict: product strings are user-visible and were corrupted.
- Resolution: **RESOLVED (2026-10-25 02:20).** The Lead fixed the corrupted UTF-8 literals and this audit
  re-verified them: scans of all 39 `desktop/src` + `desktop/ui` TS/JS/HTML files found **0 mojibake
  sequences and 0 U+FFFD replacement characters** (including `desktop/src/rpc/core.ts`). This was an
  encoding defect, not a broken feature; no `FIX_REQUIRED` remains for it.

## C-09 Five-workspace nav vs diagnostics placement

- Where: R020 requires "对话/科研项目/任务执行/工具技能/设置诊断"; `desktop/ui/index.html` nav has chat/projects/tasks/tools/settings, with diagnostics inside the settings page (`doctor-run`, `worker-health`, `import-wizard`).
- Conflict: none substantive (5 top-level entries + diagnostics as settings sub-page). Decision: accepted; R020 is now `IMPLEMENTED_PASS` (UI JS/actions.json landed and UI DOM QA passed), not because of nav count.

## C-10 "Suwen" vs "SuWen/素问" spelling in V2 baseline

- Where: `docs/SUWEN-V2-REQUIREMENTS.md` uses "素问/Suwen"; R024 mandates new brand only `SuWen/素问`.
- Resolution: new desktop surfaces use `SuWen`/`素问`; legacy doc spelling preserved as historical. No user-facing conflict in desktop code (verified `desktop/ui`, `package.json`, `desktop/LICENSE`, `NOTICE`).

## C-11 `desktop/dist-lead/` build output inside workspace

- Where: `desktop/dist-lead/**` 29 compiled JS files are untracked, not produced by `npm test` (which compiles to `dist/`), and not referenced by `package.json` files list.
- Conflict: build-artifact hygiene (two dist dirs) and possible confusion of "tested code". 
- Resolution: documented in `source-inventory.md` as expected post-copy addition; not used as evidence. **Lead**: remove or gitignore/label `dist-lead` before release to avoid shipping ambiguity.

## C-12 Acceptance matrix vs current importer existence

- Where: `desktop/acceptance-matrix.md` says "non-destructive import NOT implemented"; TARGET now has `desktop/src/import-service.ts` + `desktop/test/import-service.test.ts` (added after that matrix).
- Resolution: `acceptance-matrix.md` is a prototype artifact; this audit records importer as `UNVERIFIED` (code + test authored, not wired into daemon, not executed). No edit to acceptance matrix (Lead/out-of-scope file).

## Summary of Lead actions implied

1. Wire `rpc/core.ts` into `daemon.ts` dispatch and run `npm test` in TARGET; publish log.
2. Fix UTF-8 mojibake in `desktop/src/rpc/core.ts`.
3. Decide R090 docs-compat policy; keep `branding-exceptions.md` as the answer.
4. Run Windows CI (or local dist:win) to produce installer + SHA256SUMS; fill `windows-installer-verification.md`; VM for clean install/upgrade/uninstall and durability.
5. Re-run packaged Electron E2E in TARGET before reusing prototype evidence.
6. Choose UI actions implementation; then regenerate `ui-action-coverage.csv`.

## 2026-10-25 update — 3.1.0 evidence supersedes part of this list

The Lead measured desktop 3.1.0 evidence in TARGET (`docs/verification/integration-and-e2e.md`,
`docs/release/windows-installer-verification.md`, `docs/verification/chaos-results.json`).
Resolution status of the earlier conflicts/actions:

- **Actions 1/5 (wiring + E2E): resolved for evidence purposes.** `rpc/core.ts` + research/tool/
  channel/RSI modules are wired into the running desktop; `e2e-rpc.mjs --live` 42/0 against a real
  detached daemon, packaged smoke 8/8, `npm test` 150/148/0/2. Prototype evidence is no longer the
  only basis.
- **Action 2 (mojibake): resolved.** Encoding defect fixed and re-verified — 0 mojibake/U+FFFD markers
  across 39 `desktop/src` + `desktop/ui` files (see C-08); the UI QA / npm test evidence above is
  therefore unaffected by it.
- **Action 3 (R090 docs policy): still Lead decision.** 3.1.0 scan = 983 hits/143 files, 0 requiring
  change; active docs/API identifiers classified LEGACY-BRAND-COMPAT in
  `docs/research/branding-exceptions.md`.
- **Action 4 (installer): resolved for host scope.** Final installer (129,425,145 B, sha256
  E1A1062C...) exists and was rebuilt from frozen final code at `2026-10-24T17:41:52Z`;
  final-artifact host lifecycle **14/14** and cross-version upgrade **8/8** passed (C-14).
  `SHA256SUMS` is now generated; clean-VM lifecycle and code signing remain pending.
- **Action 6 / C-06 (UI actions): resolved.** `desktop/ui/actions.json` now exists with 144 actions;
  `docs/verification/ui-action-coverage.csv` regenerated (94 daemon-RPC, 5 main-process bridge,
  43 UI-only; `ui-dom-qa.mjs` 19/0/12).
- **C-12 (importer not implemented): resolved.** `import-service` is wired and tested (5/5);
  real legacy-home read-only scan found 9 item groups; rollback verified.

### New conflicts in the 3.1.0 evidence set

## C-13 Chaos artifact was superseded mid-audit

- Where: an earlier `docs/verification/chaos-results.json` (10/11 scenarios recovered, 1 failed
  waiting_approval 429) was observed before this audit block; the current artifact
  (`finishedAt 2026-10-24T17:34:35.821Z`) records **12/12 checks passed in 52.2 s**
  (`result: passed`), including python-worker and daemon SIGKILL recovery, same operation id, no
  replay of committed steps, cancellation with 0 artifacts, and a 429->500->200 provider sequence
  with 2 human approvals.
- Risk: stale numbers in docs. Resolution: all docs updated to the current artifact; no
  endurance/long-run claim is made. Limits (single Windows session, short duration, no 8/24/72 h,
  no sleep/power-loss/reboot/disk-full, fixture-injected provider faults) are copied into
  `durability-chaos-tests.md`.

## C-14 Installer lifecycle: final artifact passed on host; clean VM still absent

- Where: `docs/verification/artifacts/installer-lifecycle.json` (`2026-10-24T17:45:22Z`,
  `installerSha256` = E1A1062C...) records **14/14 steps passed on the delivered final installer**:
  install 18 s, exe 249,801,728 B, uninstaller, HKCU `SuWen 3.1.0`, FileVersion 3.1.0, installed app
  running, authenticated named-pipe daemon health version 3.1.0 mode `user-background`, daemon survives
  UI close (uptime 13.6 s), reinstall 24 s, uninstall 11 s, install dir removed, user data preserved,
  registry removed. `upgrade-path.json` (`2026-10-24T17:46:42Z`) records **8/8 steps passed** for
  `3.0.0-preview.1 -> 3.1.0`.
- Environment caveat: the developer shell inherits `ELECTRON_RUN_AS_NODE=1`; probes removed it from
  the launching shell only — a test-environment caveat, not a product defect; the shipped app is not
  modified.
- Conflict: R119 asks for a **clean Windows** lifecycle pass; both artifacts are host probes on a
  machine with Node/Python/prior SuWen data.
- Resolution: R100 = PASS (artifact + hashes + host lifecycle/upgrade measured, limits declared);
  R119 = `UNVERIFIED`/PARTIAL for the clean-VM run and code signing; R121 = `IMPLEMENTED_PASS`
  (delivery package/handover evidence present); `SHA256SUMS` is now generated. Host probes are
  not presented as clean-machine results.

## C-15 Legacy skills not migrated into the new registry

- Where: Python baseline ships 23 scientific skill dirs; `desktop/src/domain/tools.ts` has a skill
  registry (static scan/install/test/atomic copy) but **no builtin catalog**; the 23 dirs remain only
  inside `resources/legacy` for the optional workbench. `e2e-rpc` `skill.list` returns an empty
  registry.
- Conflict: parity row "23 preinstalled scientific skills" was previously UNVERIFIED; it is now
  **NOT_STARTED** (honest gap), while the registry capability itself is PASS.
- Resolution: documented in `feature-parity-matrix.md`; Lead decision needed on whether to port the
  23 SKILL.md into the new registry or declare them legacy-only.

## C-16 `desktop/dist-lead/` still present

- Where: earlier build-artifact hygiene conflict C-11 is **still open** — `desktop/dist-lead/`
  (29 compiled JS) remains untracked in the workspace; C-09's note that UI JS/actions are missing is
  obsolete (actions now exist).
- Resolution: keep flagging as release-hygiene item; not used as evidence. Lead: remove or
  gitignore/label `dist-lead` before release.


## 2026-10-25 final-build supersession (Lead-measured numbers)

The Lead rebuilt the installer after the Python-artifact commit change and supplied the final
numbers: `desktop/release/SuWen-Setup-3.1.0-win-x64.exe`, **129,425,145 bytes**, SHA-256
`E1A1062CBACAF978F6B60F2A825D2E2E769C231048A65983113E8E434BA07AC4`, built
`2026-10-24T17:41:52Z`, UNSIGNED; `release/win-unpacked/SuWen.exe` SHA-256
`CFE87F2DE046E0AB8D58F4DDB4C9898407F67129EF353BDAFCEF35376A3BB397`. The earlier 3.1.0 build
(`82779B90...`, 129,424,645 B) is **superseded and must not appear as the delivered artifact** in
any report. Final `npm test`: 150 tests / 148 pass / 0 fail / 2 skipped / 28.3 s / exit 0;
packaged smoke 8/8 on the final build; `e2e-rpc --live` 42/0 (real Europe PMC + UniProt calls).
Final-artifact host lifecycle 14/14 and cross-version upgrade 8/8 were recorded for 3.1.0 (C-14; superseded by C-17), and
`SHA256SUMS` is generated (`desktop/release/SHA256SUMS`, `docs/release/SHA256SUMS.txt`). Still
unverified and left explicit: clean-VM install/upgrade/uninstall, code signing, 8/24/72 h
endurance, real external model accounts, and the legacy Python workbench runtime on this machine
(its optional Python env lacks fastapi).


## C-17. 3.1.0 hashes in earlier sections are superseded by the final 3.2.0 build

Any earlier reference to `SuWen-Setup-3.1.0-win-x64.exe` 129,425,145 B SHA256 `E1A1062C…` (and any
`82779B90…` pre-final 3.1.0 hash) is historical only. The delivered artifact is
`SuWen-Setup-3.2.0-win-x64.exe` **129,446,526 B** SHA256
`7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546` (UNSIGNED), with blockmap
135,974 B SHA256 `BCD62E14…` and `win-unpacked/SuWen.exe` 249,801,728 B SHA256 `8F7EAF76…`;
`desktop/release/SHA256SUMS` + `docs/release/SHA256SUMS.txt`. Resolution: release notes, installer
report, acceptance report and progress were updated; 3.1.0 rows in historical sections are marked
superseded there.

## C-18. T2 post-fix SIGKILL/reconnect re-run and visual matrix are not published

T2's deterministic streaming report (`docs/verification/ui-e2e.md`, build before the auto-reconnect /
duplicate-append fix) records FAIL for auto-reconnect, kill-recovery duplication and marks the defects
OPEN. The fixes landed afterwards in `desktop/src/main.ts` and `desktop/src/conversations.ts` with
`conversations.test.ts` coverage, but T2's post-fix in-Electron re-run and
`docs/verification/ui-visual-audit.md` were not published before this documentation pass.
Resolution: R130 (cancel/timeout/reconnect) and R136 (visual acceptance) remain UNVERIFIED with this
conflict cited; release gates G3 is PASS on the deterministic fixture suite with this caveat and the
visual item is separate. Do not claim "reconnect verified in Electron" or "visual acceptance complete"
until T2 publishes the re-run/visual report.

## C-19. Installer lifecycle and upgrade evidence are host-level, not clean-VM

`installer-lifecycle.json` (12/12 host steps, version 3.2.0) and the upgrade-source step (installed
3.0.0-preview.1) were measured on the development host, which already has Node/Python and previous
SuWen data; the probe removed `ELECTRON_RUN_AS_NODE` from the launching shell only. Resolution: R119 and
release gate G8-clean-VM remain UNVERIFIED; only the host-level rows are PASS.

## C-20. Public GitHub publication is blocked

`gh` CLI is absent and no GitHub token exists in the session; the remote
`https://github.com/ForrestGump618/suwen.git` is readable (`git ls-remote` OK). Release tag
`suwen-vnext-3.2.0` and asset commands are documented in `docs/release/github-publication.md` but
**were not executed**. Resolution: R138 BLOCKED_EXTERNAL, release gate G9 BLOCKED; MIT licence/public
repo promise is not yet satisfied online.


## C-17 Final 3.2.0 evidence supersedes earlier lifecycle/hash numbers (2026-10-25)

The final 3.2.0 build is authoritative: `desktop/release/SuWen-Setup-3.2.0-win-x64.exe`
**129,446,526 B** SHA-256 `7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546`
(**UNSIGNED**); blockmap 135,974 B SHA-256 `BCD62E14…1AC2`; unpacked `win-unpacked/SuWen.exe`
249,801,728 B SHA-256 `8F7EAF76…22E1`; `SHA256SUMS` present in `desktop/release/` and mirrored at
`docs/release/SHA256SUMS.txt`. Host lifecycle **12/12** (including installing 3.0.0-preview.1 and
upgrading to 3.2.0) passed; final `npm test` 182 tests / 180 pass / 2 skipped / 33.4 s; packaged smoke
8/8; `e2e-rpc --live` 42/0; chaos 12/12 in 51.4 s. Earlier numbers for 3.1.0 (`E1A1062C…`,
129,425,145 B, 14/14 lifecycle, `82779B90…` pre-final) are historical and must never be reported as
the delivered 3.2.0 artifact. Not done: clean-Windows-VM lifecycle, code signing, 8/24/72 h endurance,
real external accounts, GitHub publication (`docs/release/final-acceptance-report.md`).
