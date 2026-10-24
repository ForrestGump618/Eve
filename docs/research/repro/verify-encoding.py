# -*- coding: utf-8 -*-
import csv
import glob
import os

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
m = list(csv.DictReader(open(D + r"\docs\requirements\master-requirements.csv", encoding="utf-8-sig")))
print("csv sample", m[0]["id"], "|", m[0]["requirement_summary"][:80])
print("csv contains CJK", any("\u4e00" <= ch <= "\u9fff" for ch in m[0]["requirement_summary"]))
bad_tokens = ["\ufffd", "锛", "鏂", "鏈", "閽", "鍦", "涓", "鐨", "锟"]
files = []
for pat in ("docs/migration/*.md", "docs/requirements/*.md", "docs/verification/*.md",
            "docs/release/*.md", "docs/research/*.md", "docs/progress.md",
            "desktop/README.md", "desktop/acceptance-matrix.md"):
    files += glob.glob(os.path.join(D, pat))
for f in sorted(files):
    try:
        t = open(f, encoding="utf-8").read()
    except Exception as e:
        print("READFAIL", f, e)
        continue
    hits = {b: t.count(b) for b in bad_tokens if b in t}
    if hits:
        print("MOJIBAKE", os.path.relpath(f, D), hits)
print("scan done", len(files), "files")
