# -*- coding: utf-8 -*-
"""Refresh traceability section-6 document hash table to current bytes/hashes."""
import hashlib
import os
import re

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def p(rel):
    return os.path.join(D, rel.replace("/", os.sep))


def sha(rel):
    b = open(p(rel), "rb").read()
    return hashlib.sha256(b).hexdigest().upper(), len(b)


REL = [
    "docs/requirements/master-requirements-source.md",
    "docs/requirements/master-requirements.csv",
    "docs/requirements/conflicts.md",
    "docs/migration/python-feature-inventory.md",
    "docs/migration/feature-parity-matrix.csv",
    "docs/migration/source-inventory.md",
    "docs/migration/copy-verification.md",
    "docs/verification/third-party-dependencies.md",
    "docs/verification/integration-and-e2e.md",
    "docs/verification/durability-chaos-tests.md",
    "docs/verification/ui-action-coverage.csv",
    "docs/verification/artifacts/installer-lifecycle.json",
    "docs/verification/artifacts/upgrade-path.json",
    "docs/verification/chaos-results.json",
    "docs/release/windows-installer-verification.md",
    "docs/research/branding-exceptions.md",
    "docs/research/branding-scan.csv",
    "desktop/acceptance-matrix.md",
    "docs/progress.md",
    "desktop/README.md",
    "docs/migration/feature-parity-matrix.md",
]

tp = p("docs/requirements/traceability.md")
t = open(tp, encoding="utf-8").read()
updated = 0
for rel in REL:
    h, n = sha(rel)
    # locate the table row for this path and replace bytes/hash part
    pat = re.compile(r"(\| `" + re.escape(rel) + r"` \| )\d+( \| `)[0-9a-f]+(` \|)")
    t2, cnt = pat.subn(lambda m: f"{m.group(1)}{n}{m.group(2)}{h}{m.group(3)}", t)
    if cnt:
        updated += 1
        t = t2
open(tp, "w", encoding="utf-8", newline="").write(t)
print("traceability hash rows refreshed:", updated, "| bytes:", len(t))

# also append a timestamp banner line to section 6 if absent
if "哈希为本文件生成时" not in t:
    t = t.replace(
        "## 6. 历史/当前文档哈希（可抽查追溯）",
        "## 6. 历史/当前文档哈希（可抽查追溯）\n\n哈希为本文件生成时（2026-10-25 01:52 +08）的当前值，供冻结后抽查。",
    )
    open(tp, "w", encoding="utf-8", newline="").write(t)
    print("added hash banner")

