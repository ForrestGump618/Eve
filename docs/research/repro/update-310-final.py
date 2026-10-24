# -*- coding: utf-8 -*-
"""Final 3.1.0 evidence updates: parity skill row + regenerated ui-action-coverage.csv."""
import csv
import json
import os
import re
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
T = os.path.join(D, "desktop")

# ---------- 1. parity row: 23 preinstalled skills ----------
P = os.path.join(D, "docs/migration/feature-parity-matrix.csv")
raw = open(P, "rb").read()
bom = raw.startswith(b"\xef\xbb\xbf")
rows = list(csv.DictReader(open(P, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
for r in rows:
    if r["capability"] == "23 preinstalled scientific skills":
        r["vnext_status"] = "NOT_STARTED"
        r["vnext_code"] = "no builtin skill catalog in desktop/src/domain/tools.ts (registry is user-install only); 23 SKILL.md dirs preserved inside resources/legacy for the optional Python workbench"
        r["test_id"] = "e2e-rpc skill.list returns [] (no builtin); legacy workbench not exercised in packaged smoke"
        r["gaps"] = "23 Python-baseline skills are NOT migrated/ported into the new desktop registry; they remain available only via the bundled legacy Python workbench; marketplace/update channel absent"
w = csv.DictWriter(open(P, "w", encoding="utf-8-sig" if bom else "utf-8", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
print("parity:", len(rows), dict(Counter(r["vnext_status"] for r in rows)))

# ---------- 2. regenerate ui-action-coverage.csv ----------
actions = json.load(open(os.path.join(T, "ui/actions.json"), encoding="utf-8"))
contract = open(os.path.join(T, "src/shared/contract.ts"), encoding="utf-8").read()
m = re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]", contract, re.S)
declared = set(re.findall(r"'([A-Za-z0-9._-]+)'", m.group(1)))
MAIN_BRIDGE = {"settings", "login", "reconnect", "pythonPicker", "support"}
EVID = "node scripts/ui-dom-qa.mjs -> 19 passed / 0 failed / 10 warnings (main-bridge methods only); node --check desktop/ui/app.js exit 0 (Lead-measured 2026-10-25)"

out = os.path.join(D, "docs/verification/ui-action-coverage.csv")
new_rows = []
for a in actions:
    meth = a.get("method")
    if meth is None:
        kind, status = "ui-only", "WIRED_UI_ONLY"
        decl = ""
    elif meth in MAIN_BRIDGE:
        kind, status = "main-process-bridge", "WIRED_MAIN_BRIDGE"
        decl = ""
    elif meth in declared:
        kind, status = "daemon-rpc", "WIRED_DAEMON_RPC"
        decl = "yes"
    else:
        kind, status = "unknown", "MISMATCH_NO_CONTRACT"
        decl = "NO"
    new_rows.append(dict(action_id=a["id"], page=a.get("page", ""), selector=a.get("selector", ""),
                         method=meth or "", method_kind=kind, contract_declared=decl,
                         wired_status=status, evidence=EVID, notes=(a.get("notes") or "").replace("\n", " ")))
ufields = ["action_id", "page", "selector", "method", "method_kind", "contract_declared", "wired_status", "evidence", "notes"]
with open(out, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=ufields, lineterminator="\n")
    w.writeheader()
    for r in new_rows:
        w.writerow(r)
print("ui:", len(new_rows), dict(Counter(r["wired_status"] for r in new_rows)))
print("ui methods not declared anywhere:", [r for r in new_rows if r["wired_status"] == "MISMATCH_NO_CONTRACT"])
