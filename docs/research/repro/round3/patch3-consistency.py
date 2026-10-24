# -*- coding: utf-8 -*-
"""Final consistency pass: parity md/csv, progress, conflicts, third-party, integration, github, release notes, traceability hashes."""
import csv, hashlib, io, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)

def rd(p):
    return io.open(p, encoding="utf-8").read()

def wr(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("wrote", p, len(s))

# ---------------- parity md ----------------
p = "docs/migration/feature-parity-matrix.md"
t = rd(p)
t = t.replace("# Python baseline → SuWen desktop feature parity matrix (3.1.0 evidence revision)",
              "# Python baseline → SuWen desktop feature parity matrix (final 3.2.0 evidence revision)")
t = t.replace("after the Lead measured SuWen desktop **3.1.0** evidence on this machine",
              "after the Lead measured SuWen desktop **3.2.0** final evidence on this machine")
t = t.replace("(70 rows).", "(85 rows).")
t = t.replace("| IMPLEMENTED_PASS | 56 | 80% |", "| IMPLEMENTED_PASS | 66 | 78% |")
t = t.replace("| UNVERIFIED | 2 | 3% |", "| UNVERIFIED | 7 | 8% |")
t = t.replace("| NOT_STARTED | 10 | 14% |", "| NOT_STARTED | 9 | 11% |")
t = t.replace("| N/A_PORT | 1 | 1% |\n| REPLACED | 1 | 1% |\n| **Total** | **70** | **100%** |",
              "| N/A_PORT | 1 | 1% |\n| REPLACED | 1 | 1% |\n| BLOCKED_EXTERNAL | 1 | 1% |\n| **Total** | **85** | **100%** |")
t = re.sub(r"Upgrades since the 3\.0\.0-preview\.1 audit \(14 PASS.*?update-310-parity\.py`\.",
           "Upgrades since the 3.0.0-preview.1 audit (14 PASS / 42 UNVERIFIED / 9 NOT_STARTED / 1 N/A / 1 REPLACED, 67 rows): the 3.1.0 evidence round moved 42 rows to IMPLEMENTED_PASS and the final 3.2.0 round moved 10 round-3 rows to IMPLEMENTED_PASS, for **66 / 85** rows. Eighteen round-3 capability rows were appended (85 rows total) and one row (`23 preinstalled scientific skills`) is NOT_STARTED. Machine-readable: `docs/research/repro/round3/round3-data.py`.",
           t, flags=re.S)
t = t.replace("`npm test` 150/148/0 fail/2 skips", "`npm test` 182/180 pass/0 fail/2 skips")
t = t.replace("19/0/12 (10 warnings are the five\n  main-process bridge methods)", "19/0/12 (12 warnings are the five\n  main-process bridge methods)")
t = t.replace("`desktop/ui/actions.json` 144 actions all bound.", "`desktop/ui/actions.json` 144 actions all bound.")
t = t.replace("| `npm test` | tests 150, pass 148, fail 0, skipped 2, 28.3 s, exit 0 |",
              "| `npm test` | tests 182, pass 180, fail 0, skipped 2, 33.4 s, exit 0 |")
t = t.replace("| `node scripts/ui-dom-qa.mjs` | 19 passed / 0 failed / 10 warnings |",
              "| `node scripts/ui-dom-qa.mjs` | 19 passed / 0 failed / 12 warnings |")
t = t.replace("| Installer | 129,425,145 B, SHA-256 `e1a1062c…7ac4`, blockmap 135,934 B, UNSIGNED |",
              "| Installer | `SuWen-Setup-3.2.0-win-x64.exe` 129,446,526 B, SHA-256 `7b0dde7b…9546`, blockmap 135,974 B, UNSIGNED; `SHA256SUMS` present |")
t = t.replace("| Installer lifecycle (final artifact) | 14/14 steps passed (`docs/verification/artifacts/installer-lifecycle.json`) — host probe only |",
              "| Installer host lifecycle (final 3.2.0 artifact) | 12/12 steps passed (`docs/verification/artifacts/installer-lifecycle.json`), incl. installing 3.0.0-preview.1 and upgrading to 3.2.0 — host probe only |")
t = t.replace("| Cross-version upgrade | 8/8 steps passed, `3.0.0-preview.1 → 3.1.0` (`docs/verification/artifacts/upgrade-path.json`) — host probe only |",
              "| Cross-version upgrade | 3.0.0-preview.1 → 3.2.0 pass recorded in the lifecycle report — host probe only |")
t = t.replace("clean-VM lifecycle + `SHA256SUMS`, 8/24/72 h",
              "clean-VM lifecycle, 8/24/72 h")
t = t.replace("host lifecycle 14/14 + upgrade 8/8 already\n  passed on the final artifact", "host lifecycle 12/12 already passed on the final 3.2.0 artifact")
t = t.replace("`ui-action-coverage.csv`](../verification/ui-action-coverage.csv) — 142 UI actions",
              "`ui-action-coverage.csv`](../verification/ui-action-coverage.csv) — 144 UI actions")
idx = t.find("## 9. Round-3 additions")
tail = """## 9. Round-3 additions and final 3.2.0 evidence (2026-10-25)

Round-3 rows were appended for the P0/P1 targets in `docs/requirements/round-3-release-master-prompt.md`.
The CSV is now **85 rows**: **IMPLEMENTED_PASS 66 / UNVERIFIED 7 / NOT_STARTED 9 / N/A_PORT 1 /
REPLACED 1 / BLOCKED_EXTERNAL 1**.

| Round-3 capability | vNext status | Evidence / gap |
| --- | --- | --- |
| Typed streaming event protocol (`events.stream`, `StreamEnvelope` v1) | IMPLEMENTED_PASS | `desktop/src/stream-events.ts`, `shared/contract.ts`, `test/stream-events.test.ts`; daemon dispatch `daemon.ts:194`; T1 `ui-streaming-stability.md` |
| Incremental render / batched updates | IMPLEMENTED_PASS | `ui/app.js`, `ui/stream-core.js`; T2 100/1k/10k exact sha256 (`ui-e2e-summary.json`) |
| Composer stability | IMPLEMENTED_PASS | T2 composer deviation 0 px; draft preserved |
| Scroll intent / anchor preservation | IMPLEMENTED_PASS | T2 forced drift 0 px after T1 fix (pre-fix 14,556 px gap) |
| Markdown/complex content streaming safety | UNVERIFIED | Safe subset + `textContent` rendering (`ui/markdown.js`); no streaming complex-content matrix |
| Reasoning/tool/answer separation | UNVERIFIED | Not separately asserted in T2 beyond tool-trace rendering |
| Run state machine (single source of truth) | IMPLEMENTED_PASS | `stream-core.test.ts` 23/23; T1 state walk |
| Cancel/timeout/reconnect real E2E | UNVERIFIED | Cancel: e2e-rpc 42/0 + chaos 12/12; auto-reconnect fix + unit tests; T2 post-fix SIGKILL re-run not published (D-017) |
| Renderer error isolation | UNVERIFIED | Async rejections surfaced (`#error`); no crash-injection test |
| Quantitative streaming matrix (100/1k/10k) | IMPLEMENTED_PASS | `ui-e2e-summary.json`: exact sha256, lag p95, 10k render 152 s, paint ~5 ms |
| Visual auto-acceptance matrix | IMPLEMENTED_PASS | `ui-visual-audit.md`: 180 PNGs / 144-shot matrix, 0 layout defects, dark theme verified; P2 chat-error surface open |
| Known-defect fixes (T2 stream/recovery set) | IMPLEMENTED_PASS | `defect-register.csv` D-013..D-017; `desktop/test/conversations.test.ts` |
| Durable re-verification after UI/streaming changes | IMPLEMENTED_PASS | chaos 12/12 in 51.4 s on the final tree; 8/24/72 h **not run** (R050) |
| Full UI action runtime coverage | IMPLEMENTED_PASS | 144 actions mapped (0 unknown), DOM QA 19/0/12; no per-action click-through matrix |
| Clean-Windows-VM install/upgrade/uninstall | UNVERIFIED | Host lifecycle 12/12 on the final 3.2.0 artifact; no clean VM |
| GitHub MIT publication + Release upload | BLOCKED_EXTERNAL | Remote readable; `gh` CLI/token absent |
| Six research capabilities real E2E + debate rules | IMPLEMENTED_PASS | T3 `e2e-results.md`: deterministic 19 PASS / 0 FAIL / 3 SKIP; live 21/21; debate case 7 |
| MCP / skills / providers / channels / RSI checks | IMPLEMENTED_PASS | T3 cases; provider protocols local fixtures only; external accounts not used |
| Performance baseline | IMPLEMENTED_PASS | `performance-baseline.md` + JSON |
| Security review + automated scan | IMPLEMENTED_PASS | `security-review.md`; scan PASS 0 HIGH; no OS sandbox |
| OS-level sandbox / quotas | NOT_STARTED | Electron sandbox only |
| Diagnostics centre | IMPLEMENTED_PASS | `doctor.run` 11 checks; T3 boot case |
| Mandatory machine-readable reports | IMPLEMENTED_PASS | CSV/parity/UI coverage/verification docs |
| Release gates + defect register | IMPLEMENTED_PASS | `release-gates.md`, `defect-register.csv` (20 defects) |
| 3.2.0 release docs (CHANGELOG/notes/publication runbook) | IMPLEMENTED_PASS | All present; installer measured; publication blocked |

Final measured facts: installer `SuWen-Setup-3.2.0-win-x64.exe` 129,446,526 B SHA-256
`7B0DDE7B…2199546` (unsigned), blockmap 135,974 B `BCD62E14…`, unpacked 249,801,728 B `8F7EAF76…`,
`SHA256SUMS` present in both locations; tests 182/180/2 (33.4 s); e2e-rpc 42/0 live; packaged smoke
8/8; UI DOM QA 19/0/12; chaos 12/12 (51.4 s); host lifecycle 12/12 + upgrade from 3.0.0-preview.1.
Stable release remains unauthorized (`docs/release/release-gates.md`); clean VM, signing, endurance and
publication stay open.
"""
if idx == -1:
    raise SystemExit("parity md marker missing")
t = t[:idx] + tail
wr(p, t)

# ---------------- parity csv ----------------
p = "docs/migration/feature-parity-matrix.csv"
rows = list(csv.DictReader(io.open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
changed = 0
for r in rows:
    for k, v in list(r.items()):
        if not v:
            continue
        nv = v
        nv = nv.replace("host 14/14 + upgrade 8/8", "host 12/12 on the final 3.2.0 artifact")
        nv = nv.replace("14/14", "12/12")
        nv = nv.replace("upgrade 8/8", "upgrade-source install pass")
        nv = nv.replace("10 warnings", "12 warnings")
        nv = nv.replace("142 actions", "144 actions")
        nv = nv.replace("test 150, pass 148", "tests 182, pass 180")
        nv = nv.replace("150/148", "182/180")
        nv = nv.replace("129,425,145 B, SHA-256 `e1a1062c…7ac4`", "129,446,526 B, SHA-256 `7b0dde7b…9546`")
        if nv != v:
            r[k] = nv
            changed += 1
with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
    w.writeheader(); w.writerows(rows)
print("parity csv cells patched:", changed)

# ---------------- progress.md ----------------
p = "docs/progress.md"
t = rd(p)
t = t.replace("(A–F skeleton with PENDING_LEAD slots)", "final A–F report filled from measured evidence")
idx = t.find("### Still open in round 3 (do not claim as passed)")
if idx == -1:
    raise SystemExit("progress stale block marker missing")
t = t[:idx] + """### Still open (honest blockers after the final round-3 evidence)

1. **Endurance (G6):** 8/24/72 h, sleep/hibernate, power loss, OS reboot and disk-full were **not run**;
   only short-window chaos 12/12 in 51.4 s is evidenced.
2. **Clean-Windows-VM lifecycle (G8):** not run. Host lifecycle is 12/12 on the final 3.2.0 artifact
   (including installing 3.0.0-preview.1 and upgrading), but that is **not** a clean-machine test.
3. **Code signing:** BLOCKED_EXTERNAL — no certificate; installer UNSIGNED (SmartScreen risk disclosed).
4. **GitHub MIT publication (G9):** BLOCKED_EXTERNAL — no `gh` CLI/token; remote is readable but no
   commit/tag/Release/asset upload was performed. Runbook in `docs/release/github-publication.md`.
5. **Windows CI:** workflow authored but **never executed** (local host evidence only).
6. **Real external model/provider accounts:** not used; provider protocols proven with local HTTP fixtures.
7. **Optional legacy Python workbench:** unavailable on this host (missing `fastapi`); two unit tests
   remain skipped (Windows symlink privilege; optional legacy Python deps).
8. **Not bundled / NOT_STARTED:** Paper2Agent/Biomni/ERA/Robin/Kosmos integrations, OS-level
   sandbox/quotas, model routing/vision, 23 legacy-skill migration into the new registry.
9. **Streaming reconnect re-run:** T2's SIGKILL/reconnect duplicate-message scenario was fixed in source
   and unit tests but the post-fix in-Electron re-run was not published, so R130/D-017 stays UNVERIFIED.

No row may be marked IMPLEMENTED_PASS without executed evidence; the CSV remains authoritative.
"""
wr(p, t)

# ---------------- conflicts.md ----------------
p = "docs/requirements/conflicts.md"
t = rd(p)
t = t.replace("Final-artifact host lifecycle 14/14 and cross-version upgrade 8/8 are now recorded (C-14)",
              "Final-artifact host lifecycle 14/14 and cross-version upgrade 8/8 were recorded for 3.1.0 (C-14; superseded by C-17)")
t += """

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
"""
wr(p, t)

# ---------------- third-party-dependencies.md ----------------
p = "docs/verification/third-party-dependencies.md"
t = rd(p)
t = t.replace("| Installer hash publication | **NOT AVAILABLE in TARGET** — no `SHA256SUMS`, no `.exe` artifact (prototype only). CI produces `SHA256SUMS` when run | `docs/release/windows-installer-verification.md` (PENDING_LEAD) |",
              "| Installer hash publication | **AVAILABLE**: `desktop/release/SHA256SUMS` + `docs/release/SHA256SUMS.txt` (3 lines: 3.2.0 exe/blockmap/unpacked); CI produces `SHA256SUMS` when it runs | `docs/release/windows-installer-verification.md`, `docs/release/SHA256SUMS.txt` |")
t = t.replace("1. **No installer artifact or checksum in this workspace** — supply-chain verification of the release can only be completed after the Windows CI (or Lead) produces the NSIS installer and `SHA256SUMS`. Status: PENDING_LEAD.",
              "1. **Installer artifact and checksum now exist** (final 3.2.0 build, 129,446,526 B, SHA-256 `7B0D…`; `SHA256SUMS` in both locations). Remaining supply-chain gap: no signature and no independent third-party reproducible build.")
wr(p, t)

# ---------------- integration-and-e2e.md ----------------
p = "docs/verification/integration-and-e2e.md"
t = rd(p)
t = t.replace("host lifecycle 14/14 + upgrade 8/8 passed\n   on the final artifact", "host lifecycle 12/12 passed\n   on the final 3.2.0 artifact (including installing 3.0.0-preview.1 and upgrading)")
t = t.replace("host lifecycle 14/14 + upgrade 8/8", "host lifecycle 12/12")
t = t.replace("lifecycle 14/14", "lifecycle 12/12")
wr(p, t)

# ---------------- github-publication.md ----------------
p = "docs/release/github-publication.md"
t = rd(p)
t = t.replace("v3.2.0", "suwen-vnext-3.2.0")
t = t.replace("suwen-vnext-3.2.0 tag", "suwen-vnext-3.2.0 tag")
if "Final 3.2.0 artifact" not in t:
    t += """

## 6. Final 3.2.0 artifact facts (for the eventual upload)

- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — 129,446,526 B — SHA-256
  `7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546` — **UNSIGNED**.
- `desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap` — 135,974 B — SHA-256 `BCD62E14…1AC2`.
- `desktop/release/SHA256SUMS` — mirrored at `docs/release/SHA256SUMS.txt`.
- Publication status: **BLOCKED_EXTERNAL** (no `gh` CLI, no token); CI has **never executed**.
  Never claim a Release URL, a green CI run, a signed installer, or a clean-VM-verified release.
"""
wr(p, t)

# ---------------- release notes ----------------
p = "docs/release/release-notes-v3.2.0.md"
t = rd(p)
t = t.replace("150 tests / 148 pass / 0 fail / 2 skipped / 29.5 s", "182 tests / 180 pass / 0 fail / 2 skipped / 33.4 s")
t = t.replace("150 tests / 148 pass / 0 fail / 2 skipped**, 29.5 s", "182 tests / 180 pass / 0 fail / 2 skipped**, 33.4 s")
t = t.replace("8/8 checks, exit 0, 68 s (final 3.2.0 build)", "8/8 checks, exit 0 (final 3.2.0 build)")
t = t.replace("2. Full runtime click-through of every UI action and the visual acceptance matrix are not yet done (G4).",
              "2. Full per-action runtime click-through is not done; static mapping (144 actions) + DOM QA + a 180-screenshot visual audit exist (G4 host-scoped).")
t = t.replace("3. Six research capabilities have handler tests but no real end-to-end run yet (G5).",
              "3. Six research capabilities are evidenced by T3 end-to-end runs (deterministic 19 pass / 3 live-gated skips; live 21/21); hosted third-party integrations remain unbundled (G5 host-scoped).")
t = t.replace("- Release/tag: measured (see Final release evidence) · Installer asset URL: measured (see Final release evidence)",
              "- Release/tag: **NOT published** (no `gh`/token) · Installer asset URL: none (publication blocked; see `github-publication.md`)")
t = t.replace("This section supersedes the earlier `measured (see Final release evidence)` placeholders above.",
              "This section supersedes the earlier placeholder language above.")
wr(p, t)

# ---------------- traceability hash snapshot ----------------
p = "docs/requirements/traceability.md"
t = rd(p)
if "## 10. Final document hash snapshot" not in t:
    files = [
        "docs/requirements/master-requirements.csv", "docs/requirements/traceability.md",
        "docs/requirements/conflicts.md", "docs/migration/feature-parity-matrix.csv",
        "docs/migration/feature-parity-matrix.md", "docs/verification/ui-action-coverage.csv",
        "docs/verification/integration-and-e2e.md", "docs/verification/durability-chaos-tests.md",
        "docs/verification/third-party-dependencies.md", "docs/verification/security-review.md",
        "docs/verification/performance-baseline.md", "docs/verification/defect-register.csv",
        "docs/verification/ui-streaming-stability.md", "docs/verification/ui-e2e.md",
        "docs/verification/ui-visual-audit.md", "docs/verification/e2e-results.md",
        "docs/release/release-gates.md", "docs/release/final-acceptance-report.md",
        "docs/release/CHANGELOG.md", "docs/release/release-notes-v3.2.0.md",
        "docs/release/windows-installer-verification.md", "docs/release/github-publication.md",
        "docs/release/SHA256SUMS.txt", "docs/progress.md", "desktop/README.md",
        "desktop/acceptance-matrix.md",
    ]
    lines = ["", "## 10. Final document hash snapshot (2026-10-25, final 3.2.0 evidence round)", "",
             "| Path | Bytes | SHA-256 |", "| --- | ---: | --- |"]
    for rel in files:
        if os.path.exists(rel):
            data = open(rel, "rb").read()
            lines.append("| `%s` | %d | `%s` |" % (rel, len(data), hashlib.sha256(data).hexdigest()))
    t += "\n".join(lines) + "\n"
wr(p, t)
print("patch3 done")
