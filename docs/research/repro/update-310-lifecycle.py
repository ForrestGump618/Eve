# -*- coding: utf-8 -*-
"""Reflect the final host lifecycle probe in master-requirements.csv evidence text."""
import csv
import os
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
P = os.path.join(D, "docs/requirements/master-requirements.csv")
raw = open(P, "rb").read()
bom = raw.startswith(b"\xef\xbb\xbf")
rows = list(csv.DictReader(open(P, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
UPD = {
    "R100": dict(
        test_or_log="desktop/release/SuWen-Setup-3.1.0-win-x64.exe 129,424,645 B sha256 82779b90...; win-unpacked layout; docs/verification/artifacts/installer-lifecycle.json (host probe 14/14 steps passed incl install/reinstall/uninstall/daemon attach)",
        remaining_gap="clean-Windows-VM lifecycle + cross-version upgrade + SHA256SUMS artefact still PENDING_LEAD; host probe is not a clean machine",
    ),
    "R119": dict(
        test_or_log="host probe 14/14 steps passed (docs/verification/artifacts/installer-lifecycle.json, 2026-10-24T17:40:28Z): install/start/reinstall/uninstall/daemon-attach/user-data; no clean-VM run",
        remaining_gap="clean Windows VM install/start/upgrade/uninstall NOT RUN (PENDING_LEAD); SHA256SUMS and code-signing pending",
    ),
    "R121": dict(
        test_or_log="installer + hashes + integration/installer/parity/UI/requirements docs present; host lifecycle probe 14/14",
        remaining_gap="clean-VM lifecycle, SHA256SUMS, code signing and real external-account rows NOT complete (PENDING_LEAD)",
    ),
    "R050": dict(
        remaining_gap="8/24/72 h, reboot, sleep/hibernate, power-loss, disk-full NOT performed; current chaos artifact is short-window only (12/12 scenarios, 52.2 s, fixture-injected faults)",
    ),
}
for r in rows:
    if r["id"] in UPD:
        r.update(UPD[r["id"]])
w = csv.DictWriter(open(P, "w", encoding="utf-8-sig" if bom else "utf-8", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
print("updated", sorted(UPD), "| rows", len(rows), dict(Counter(r["status"] for r in rows)))
