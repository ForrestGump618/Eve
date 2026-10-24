# -*- coding: utf-8 -*-
"""Final consistency check for the 3.1.0 docs update (read-only)."""
import csv
import os
import subprocess
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"

def counts(path, status_col):
    rows = list(csv.DictReader(open(os.path.join(D, path), encoding="utf-8-sig", newline="")))
    return len(rows), Counter(r[status_col] for r in rows)

print("master:", counts(r"docs\requirements\master-requirements.csv", "status"))
rows = list(csv.DictReader(open(os.path.join(D, r"docs\requirements\master-requirements.csv"), encoding="utf-8-sig", newline="")))
for rid in ("R013", "R050", "R053", "R061", "R100", "R101", "R113", "R119", "R120", "R121", "R090"):
    r = next(x for x in rows if x["id"] == rid)
    print(f"  {rid}: {r['status']:16s} scope={r['evidence_scope']:12s} gap={r['remaining_gap'][:70]}")
print("parity:", counts(r"docs\migration\feature-parity-matrix.csv", "vnext_status"))
print("ui: rows", len(list(csv.DictReader(open(os.path.join(D, r"docs\verification\ui-action-coverage.csv"), encoding="utf-8-sig", newline="")))))

# required files exist and sizes
files = [
    r"docs\migration\source-inventory.md", r"docs\migration\copy-verification.md",
    r"docs\migration\python-feature-inventory.md", r"docs\migration\feature-parity-matrix.csv",
    r"docs\migration\feature-parity-matrix.md", r"docs\requirements\master-requirements.csv",
    r"docs\requirements\traceability.md", r"docs\requirements\conflicts.md",
    r"docs\verification\third-party-dependencies.md", r"docs\verification\ui-action-coverage.csv",
    r"docs\verification\integration-and-e2e.md", r"docs\verification\durability-chaos-tests.md",
    r"docs\verification\chaos-results.json", r"docs\verification\artifacts\installer-lifecycle.json",
    r"docs\release\windows-installer-verification.md", r"docs\research\branding-exceptions.md",
    r"docs\research\branding-scan.csv", r"docs\research\branding-scan-summary.json",
    r".github\workflows\suwen-windows.yml", r"docs\progress.md",
    r"desktop\README.md", r"desktop\acceptance-matrix.md",
]
for f in files:
    p = os.path.join(D, f)
    print(f"{'OK ' if os.path.exists(p) else 'MISSING':4s} {os.path.getsize(p) if os.path.exists(p) else 0:7d}  {f}")

# git porcelain (who changed what; only D-owned paths should be new/modified by this task)
out = subprocess.run(["git", "-C", D, "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True).stdout.splitlines()
print(f"git porcelain entries: {len(out)}")
owned = [l for l in out if "docs/" in l or "desktop/README.md" in l or "desktop/acceptance-matrix.md" in l]
foreign = [l for l in out if l not in owned]
print("owned-ish:", len(owned))
for l in foreign[:30]:
    print("  other:", l)
