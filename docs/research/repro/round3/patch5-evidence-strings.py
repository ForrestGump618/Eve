# -*- coding: utf-8 -*-
"""Patch 5: align every current-status evidence string with final 3.2.0 numbers."""
import csv, io, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)

def rd(p): return io.open(p, encoding="utf-8").read()
def wr(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("wrote", p, len(s))

REPL = [
    ("150 tests / 148 pass / 0 fail / 2 skipped", "182 tests / 180 pass / 0 fail / 2 skipped"),
    ("150 tests / 148 pass / 0 fail / 2 skipped", "182 tests / 180 pass / 0 fail / 2 skipped"),
    ("150 tests / 148 pass", "182 tests / 180 pass"),
    ("150/148", "182/180"),
    ("tests 150", "tests 182"),
    ("150 tests", "182 tests"),
    ("28.3 s", "33.4 s"),
    ("29.5 s", "33.4 s"),
    ("10 warnings", "12 warnings"),
    ("106 s on the final build", "on the final 3.2.0 build"),
    ("106 s on `release/win-unpacked/SuWen.exe`", "on `release/win-unpacked/SuWen.exe`"),
    ("checks, exit 0, 106 s", "checks, exit 0, final build"),
    ("12/12 checks in 52.2 s", "12/12 checks in 51.4 s"),
    ("12/12 scenarios passed, 52.2 s", "12/12 scenarios passed, 51.4 s"),
    ("host lifecycle 14/14 + upgrade 8/8", "host lifecycle 12/12 on the final 3.2.0 artifact"),
    ("host lifecycle 14/14", "host lifecycle 12/12"),
    ("host probe 14/14 + upgrade 8/8", "host probe 12/12 on the final 3.2.0 artifact"),
    ("host-probe 14/14", "host-probe 12/12"),
    ("**14/14**", "**12/12**"),
    ("lifecycle 14/14", "lifecycle 12/12"),
    ("14/14 steps passed", "12/12 steps passed"),
    ("14/14 PASS", "12/12 PASS"),
    ("upgrade 8/8", "upgrade from 3.0.0-preview.1"),
    ("**upgrade 8/8**", "**upgrade from 3.0.0-preview.1**"),
    ("129,425,145 B, SHA-256 `e1a1062c…7ac4`", "129,446,526 B, SHA-256 `7B0DDE7B…2199546`"),
]

def patch(path, cols=None):
    t = rd(path)
    orig = t
    if cols is None:
        for a, b in REPL:
            t = t.replace(a, b)
    else:
        rows = list(csv.DictReader(io.open(path, encoding="utf-8-sig", newline="")))
        fields = list(rows[0].keys())
        n = 0
        for r in rows:
            for c in cols:
                if c in r and r[c]:
                    v = r[c]
                    for a, b in REPL:
                        v = v.replace(a, b)
                    if v != r[c]:
                        r[c] = v
                        n += 1
        with io.open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
            w.writeheader(); w.writerows(rows)
        print("patched cells", path, n)
        return
    if t != orig:
        wr(path, t)
    else:
        print("unchanged", path)

# CSVs first (targeted columns)
patch("docs/requirements/master-requirements.csv", ["Test ID", "Evidence", "Blocker"])
patch("docs/migration/feature-parity-matrix.csv", ["test_id", "prototype_evidence", "gaps"])
patch("docs/verification/ui-action-coverage.csv", ["evidence", "notes"])

# Markdown / other docs
for p in [
    "docs/migration/feature-parity-matrix.md",
    "docs/release/release-gates.md",
    "docs/release/final-acceptance-report.md",
    "docs/release/CHANGELOG.md",
    "docs/release/release-notes-v3.2.0.md",
    "docs/verification/integration-and-e2e.md",
    "docs/verification/ui-streaming-stability.md",
    "docs/requirements/traceability.md",
    "desktop/README.md",
    "desktop/acceptance-matrix.md",
]:
    patch(p)

# CHANGELOG heading + 3.2.0 known limitation wording
p = "docs/release/CHANGELOG.md"
t = rd(p)
t = t.replace("## [Unreleased] — 3.2.0 (release candidate, NOT yet built/published)",
              "## [3.2.0] — 2026-10-25 (first round; see final-evidence section below)")
t = t.replace("## [3.2.0] - 2026-10-25 (final evidence)", "## [3.2.0] — 2026-10-25 (final evidence, built and measured; NOT published)")
t = t.replace("- Clean-Windows-VM install/upgrade/uninstall — host probe 14/14 + upgrade 8/8 only.",
              "- Clean-Windows-VM install/upgrade/uninstall — host probe 12/12 on the final 3.2.0 artifact only.")
wr(p, t)

# progress: historical 3.1.0 section gains explicit label (fresh docs carry final hash/counts)
p = "docs/progress.md"
t = rd(p)
t = t.replace("## 3.1.0 evidence update", "## 3.1.0 evidence update (historical; superseded by the final 3.2.0 section below)", 1)
if "3.1.0 evidence update (historical" not in t:
    # fall back: label the first 3.1.0 section heading present
    t = t.replace("## SuWen desktop 3.1.0", "## SuWen desktop 3.1.0 (historical; superseded below)", 1)
wr(p, t)

print("patch5 done")
