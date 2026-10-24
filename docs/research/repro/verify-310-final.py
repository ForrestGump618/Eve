# -*- coding: utf-8 -*-
"""Final task-6 consistency verification (read-only)."""
import glob
import hashlib
import json
import os
import re

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def p(rel):
    return os.path.join(D, rel.replace("/", os.sep))


def sha(rel):
    b = open(p(rel), "rb").read()
    return hashlib.sha256(b).hexdigest().upper(), len(b)


print("=== required reports (R120) ===")
reports = [
    "docs/requirements/master-requirements.csv",
    "docs/migration/feature-parity-matrix.csv",
    "docs/verification/ui-action-coverage.csv",
    "docs/verification/integration-and-e2e.md",
    "docs/verification/durability-chaos-tests.md",
    "docs/verification/third-party-dependencies.md",
    "docs/release/windows-installer-verification.md",
    "docs/progress.md",
    "docs/requirements/traceability.md",
    "docs/requirements/conflicts.md",
    "docs/migration/python-feature-inventory.md",
    "docs/migration/source-inventory.md",
    "docs/migration/copy-verification.md",
    "docs/migration/feature-parity-matrix.md",
    "desktop/README.md",
    "desktop/acceptance-matrix.md",
]
for r in reports:
    if os.path.exists(p(r)):
        h, n = sha(r)
        print(f"OK  {r}  {n}B  {h[:16]}")
    else:
        print("MISSING", r)

print("\n=== artifact hashes ===")
for r in [
    "docs/verification/artifacts/installer-lifecycle.json",
    "docs/verification/artifacts/upgrade-path.json",
    "docs/verification/chaos-results.json",
]:
    h, n = sha(r)
    print(f"{r}  {n}B  {h[:16]}")
    if r.endswith(".json"):
        d = json.load(open(p(r), encoding="utf-8-sig"))
        steps = d.get("steps") or d.get("scenarios") or []
        ok = [s for s in steps if s.get("ok") is True]
        print("   keys:", list(d.keys()), "| steps:", len(steps), "| ok:", len(ok), "| result:", d.get("result") or d.get("overall"))

print("\n=== installer hashes on disk ===")
for r in [
    "desktop/release/SuWen-Setup-3.1.0-win-x64.exe",
    "desktop/release/SuWen-Setup-3.1.0-win-x64.exe.blockmap",
    "desktop/release/win-unpacked/SuWen.exe",
]:
    if os.path.exists(p(r)):
        h, n = sha(r)
        print(f"{r}  {n}B  {h}")
    else:
        print("MISSING", r)

print("\n=== counts ===")
import csv

mf = list(csv.DictReader(open(p("docs/requirements/master-requirements.csv"), encoding="utf-8-sig", newline="")))
pf = list(csv.DictReader(open(p("docs/migration/feature-parity-matrix.csv"), encoding="utf-8-sig", newline="")))
uf = list(csv.DictReader(open(p("docs/verification/ui-action-coverage.csv"), encoding="utf-8-sig", newline="")))
from collections import Counter

print("master", len(mf), dict(Counter(r["status"] for r in mf)))
print("parity", len(pf), dict(Counter(r["vnext_status"] for r in pf)))
print("ui", len(uf), dict(Counter(r.get("wired_status") or r.get("status") for r in uf)))

print("\n=== stale-number scan in docs I own ===")
stale_pats = ["82779B90", "129,424,645", "129424645", "98 s", "~38 s", "PENDING_LEAD (being measured", "82779b90"]
for pat in stale_pats:
    hits = []
    for f in glob.glob(os.path.join(D, "docs", "**", "*.md"), recursive=True) + glob.glob(os.path.join(D, "desktop", "*.md")):
        if "node_modules" in f or "release" in f:
            continue
        txt = open(f, encoding="utf-8", errors="replace").read()
        c = txt.count(pat)
        if c:
            hits.append((os.path.relpath(f, D), c))
    print(f"{pat!r}: {hits if hits else 'none'}")

print("\n=== final-build consistency ===")
E = "E1A1062C"
for f in [
    "docs/progress.md",
    "docs/release/windows-installer-verification.md",
    "docs/verification/integration-and-e2e.md",
    "docs/requirements/master-requirements.csv",
    "docs/migration/feature-parity-matrix.csv",
    "docs/requirements/traceability.md",
    "desktop/README.md",
    "desktop/acceptance-matrix.md",
]:
    txt = open(p(f), encoding="utf-8", errors="replace").read()
    print(f, "has_final_sha:", E in txt.upper(), "| has_14/14:", "14/14" in txt, "| has_8/8:", "8/8" in txt)

print("\n=== mojibake probe (core.ts + ui/app.js) ===")
for f in ["desktop/src/rpc/core.ts", "desktop/ui/app.js"]:
    t = open(p(f), encoding="utf-8", errors="replace").read()
    bad = [s for s in ["鏂", "鏈厤", "璁块棶", "锛", "銆"] if s in t]
    print(f, "mojibake_markers:", bad if bad else "none")

print("\n=== SHA256SUMS ===")
print("exists:", os.path.exists(p("desktop/release/SHA256SUMS")), "|", glob.glob(os.path.join(D, "desktop", "release", "SHA256SUMS*")))
