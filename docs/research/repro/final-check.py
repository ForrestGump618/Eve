# -*- coding: utf-8 -*-
"""Final verification of task-3 deliverables (sizes, hashes, row counts)."""
import csv
import hashlib
import os
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def sha(rel):
    h = hashlib.sha256()
    with open(os.path.join(D, rel), "rb") as f:
        for c in iter(lambda: f.read(1048576), b""):
            h.update(c)
    return h.hexdigest()


files = [
    "docs/migration/source-inventory.md", "docs/migration/copy-verification.md",
    "docs/migration/python-feature-inventory.md", "docs/migration/feature-parity-matrix.csv",
    "docs/migration/feature-parity-matrix.md", "docs/requirements/master-requirements.csv",
    "docs/requirements/traceability.md", "docs/requirements/conflicts.md",
    "docs/verification/third-party-dependencies.md", "docs/verification/ui-action-coverage.csv",
    "docs/verification/integration-and-e2e.md", "docs/verification/durability-chaos-tests.md",
    "docs/release/windows-installer-verification.md", "docs/research/branding-exceptions.md",
    "docs/research/branding-scan.csv", "docs/research/branding-scan-summary.json",
    ".github/workflows/suwen-windows.yml",
]
for rel in files:
    p = os.path.join(D, rel)
    print("{:62s} {:>8d} {}".format(rel, os.path.getsize(p), sha(rel)[:20]))

m = list(csv.DictReader(open(os.path.join(D, "docs/requirements/master-requirements.csv"), encoding="utf-8")))
print("master rows", len(m), Counter(x["status"] for x in m))
p = list(csv.DictReader(open(os.path.join(D, "docs/migration/feature-parity-matrix.csv"), encoding="utf-8")))
print("parity rows", len(p), Counter(x["vnext_status"] for x in p))
u = list(csv.DictReader(open(os.path.join(D, "docs/verification/ui-action-coverage.csv"), encoding="utf-8")))
print("ui rows", len(u), Counter(x["status"] for x in u))
tr = open(os.path.join(D, "docs/requirements/traceability.md"), encoding="utf-8").read()
print("traceability chars", len(tr), "doc-mapping rows", tr.count("| `docs/"))
print("third-party bytes", os.path.getsize(os.path.join(D, "docs/verification/third-party-dependencies.md")),
      "has upstream section:", "## 7. 上游项目 / 参考系统清单" in open(os.path.join(D, "docs/verification/third-party-dependencies.md"), encoding="utf-8").read())
print("progress hash", sha("docs/progress.md"))
print("brand doc bytes", os.path.getsize(os.path.join(D, "docs/research/branding-exceptions.md")))
