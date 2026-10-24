# -*- coding: utf-8 -*-
"""Inspect actions.json + app.js wiring + contract RPC list (read-only)."""
import json
import os
import re
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"

a = json.load(open(os.path.join(D, "desktop/ui/actions.json"), encoding="utf-8"))
print("actions type:", type(a).__name__, "count:", len(a))
for x in a[:3]:
    print(json.dumps(x, ensure_ascii=False, indent=1)[:800])
keys = Counter()
for x in a:
    for k in x.keys():
        keys[k] += 1
print("keys:", keys)
print("ids sample:", [x.get("id") for x in a][:20])
print("all ids:", [x.get("id") for x in a])

js = open(os.path.join(D, "desktop/ui/app.js"), encoding="utf-8").read()
print("\napp.js len:", len(js))
# window.suwen.call("x", ...)
calls = re.findall(r"call\(\s*['\"]([a-zA-Z][\w.]*)['\"]", js)
print("app.js RPC calls:", sorted(set(calls)), "raw count:", len(calls))
# data-action / data-control attributes and id references
print("data-action tokens:", sorted(set(re.findall(r"data-action=[\"']([^\"']+)", js + open(os.path.join(D, "desktop/ui/index.html"), encoding="utf-8").read()))))
print("html ids count sample:", )
html = open(os.path.join(D, "desktop/ui/index.html"), encoding="utf-8").read()
print("html bytes:", len(html), "data-action attrs in html:", len(re.findall(r"data-action=", html)))
c = open(os.path.join(D, "desktop/src/shared/contract.ts"), encoding="utf-8").read()
m = re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]", c, re.S)
names = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)) if m else []
print("\nRPC count:", len(names))
print(names)
