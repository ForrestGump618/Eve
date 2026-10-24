# -*- coding: utf-8 -*-
import csv
import json

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
ch = json.load(open(D + r"\docs\verification\chaos-results.json", encoding="utf-8"))
print("chaos result", ch.get("result"), "durationMs", ch.get("durationMs"), "started", ch.get("startedAt"), "finished", ch.get("finishedAt"))
print("scenario keys", list(ch["scenarios"][0].keys()))
print("scenario1", ch["scenarios"][0])
print("scenario statuses", [s.get("status") for s in ch["scenarios"]])
print("limits", ch.get("limits"))
lc = json.load(open(D + r"\docs\verification\artifacts\installer-lifecycle.json", encoding="utf-8-sig"))
print("lifecycle keys", list(lc.keys()))
print("step1", lc["steps"][0], "statuses", [s.get("status") for s in lc["steps"]])
ui = list(csv.DictReader(open(D + r"\docs\verification\ui-action-coverage.csv", encoding="utf-8-sig")))
from collections import Counter
print("ui wired", Counter(r["wired_status"] for r in ui))
print("ui method_kind", Counter(r["method_kind"] for r in ui))
tr = open(D + r"\docs\requirements\traceability.md", encoding="utf-8").read()
print("trace len", len(tr), "tail---")
print(tr[-1500:])
