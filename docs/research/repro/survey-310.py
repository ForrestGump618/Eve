# -*- coding: utf-8 -*-
"""Survey current CSV/docs state for the 3.1.0 evidence update (read-only)."""
import csv
import json
import os
import re
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def rows(rel):
    with open(os.path.join(D, rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


m = rows("docs/requirements/master-requirements.csv")
print("MASTER columns:", list(m[0].keys()))
print("MASTER status:", Counter(r["status"] for r in m))
for r in m:
    print(r["id"], "|", r["status"], "|", r.get("evidence_scope", ""), "|", r["requirement_summary"][:80].replace("\n", " "))

p = rows("docs/migration/feature-parity-matrix.csv")
print("\nPARITY columns:", list(p[0].keys()))
print("PARITY status:", Counter(r["vnext_status"] for r in p))
for r in p:
    print(r["feature_id"], "|", r["vnext_status"], "|", r["priority"], "|", r.get("vnext_code", "")[:60])

u = rows("docs/verification/ui-action-coverage.csv")
print("\nUI columns:", list(u[0].keys()))
print("UI status:", Counter(r["status"] for r in u))
print("UI non-wired rows:")
for r in u:
    if r["status"] not in ("WIRED", "WIRED_DELEGATED", "WIRED_VIA_FORM"):
        print(" ", r["ui_id"], "|", r["status"], "|", r.get("rpc_method", ""), "|", r.get("notes", "")[:70])

a = json.load(open(os.path.join(D, "desktop/ui/actions.json"), encoding="utf-8"))
print("\nACTIONS top keys:", list(a.keys()))
acts = a.get("actions", [])
print("ACTIONS count:", len(acts), "sample:", json.dumps(acts[0], ensure_ascii=False)[:300])
print("action ids:", [x.get("id") for x in acts])

c = open(os.path.join(D, "desktop/src/shared/contract.ts"), encoding="utf-8").read()
mm = re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]", c, re.S)
names = re.findall(r"['\"]([^'\"]+)['\"]", mm.group(1)) if mm else []
print("\nRPC_METHODS count:", len(names))
print(names)
