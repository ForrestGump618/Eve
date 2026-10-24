# -*- coding: utf-8 -*-
"""Survey parity/UI/actions/RPC state (read-only), part 2."""
import csv
import json
import os
import re
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def rows(rel):
    with open(os.path.join(D, rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


p = rows("docs/migration/feature-parity-matrix.csv")
print("PARITY status:", Counter(r["vnext_status"] for r in p))
for r in p:
    print(r["capability"][:70], "|", r["vnext_status"], "|", r["priority"], "|", r.get("vnext_code", "")[:70])

u = rows("docs/verification/ui-action-coverage.csv")
print("\nUI columns:", list(u[0].keys()))
print("UI status:", Counter(r["status"] for r in u))
print("UI non-wired rows (first 60):")
n = 0
for r in u:
    if r["status"] not in ("WIRED", "WIRED_DELEGATED", "WIRED_VIA_FORM"):
        print(" ", r.get("ui_id"), "|", r["status"], "|", r.get("rpc_method", ""), "|", r.get("notes", "")[:80])
        n += 1
print("non-wired total:", n)

a = json.load(open(os.path.join(D, "desktop/ui/actions.json"), encoding="utf-8"))
print("\nACTIONS top keys:", list(a.keys()))
acts = a.get("actions", [])
print("ACTIONS count:", len(acts))
print("sample:", json.dumps(acts[0], ensure_ascii=False)[:400])
print("action ids:", [x.get("id") for x in acts])

c = open(os.path.join(D, "desktop/src/shared/contract.ts"), encoding="utf-8").read()
mm = re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]", c, re.S)
names = re.findall(r"['\"]([^'\"]+)['\"]", mm.group(1)) if mm else []
print("\nRPC_METHODS count:", len(names))
print(names)
