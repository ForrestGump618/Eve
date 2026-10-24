# -*- coding: utf-8 -*-
"""Replace stale timing strings and finalize conflicts C-05 wording."""
import os

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def p(rel):
    return os.path.join(D, rel.replace("/", os.sep))


# 1) timing string in master CSV + traceability (regenerated from CSV rows earlier)
for rel in ["docs/requirements/master-requirements.csv", "docs/requirements/traceability.md"]:
    path = p(rel)
    t = open(path, encoding="utf-8-sig" if rel.endswith(".csv") else "utf-8").read()
    n = t.count("~38 s")
    t = t.replace("~38 s", "28.3 s")
    open(path, "w", encoding="utf-8-sig" if rel.endswith(".csv") else "utf-8", newline="").write(t)
    print(rel, "replaced ~38 s ->", n)

# 2) conflicts C-05 resolution wording
cp = p("docs/requirements/conflicts.md")
t = open(cp, encoding="utf-8").read()
old = """- Resolution: `windows-installer-verification.md` and all CSVs now carry the final hash only;
  the pre-final hash is documented as superseded. R100 = PASS (artifact exists, hashes measured);
  R119 stays NOT_STARTED until the final-artifact host lifecycle probe and clean-VM
  install/upgrade/uninstall are supplied by the Lead; `SHA256SUMS` still absent."""
new = """- Resolution: `windows-installer-verification.md` and all CSVs now carry the final hash only;
  the pre-final hash is documented as superseded and never presented as the delivered artifact.
  R100 = PASS (artifact exists, hashes measured, host lifecycle 14/14 + upgrade 8/8); R119 stays
  NOT_STARTED only for the clean-VM run, `SHA256SUMS` and code signing (host probes are not a clean
  machine). Final blockmap: 135,934 B sha256 `72DD2D54...`; unpacked exe 249,801,728 B sha256
  `CFE87F2D...`."""
if old in t:
    t = t.replace(old, new)
    open(cp, "w", encoding="utf-8", newline="").write(t)
    print("conflicts C-05 updated")
else:
    print("C-05 anchor missing")
