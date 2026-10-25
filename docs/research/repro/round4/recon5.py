# -*- coding: utf-8 -*-
"""Round-4 recon 5: evidence snapshot hashes + package/vendor/markdown/workbench details."""
import hashlib, io, json, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
L = []
def p(*a): L.append(" ".join(str(x) for x in a))
def snap(rel):
    raw = open(rel, "rb").read()
    return {"path": rel, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

files = [
 "omicslab/web/index.html", "omicslab/web/js/store.js", "omicslab/web/js/app.js", "omicslab/web/js/api.js",
 "desktop/src/workbench.ts", "desktop/src/legacy-worker.ts", "desktop/src/main.ts", "desktop/src/daemon.ts",
 "desktop/src/shared/contract.ts", "desktop/worker/legacy_server.py", "desktop/ui/markdown.js",
 "desktop/ui/app.js", "desktop/ui/index.html", "desktop/ui/actions.json", "desktop/test/markdown.test.ts",
 "desktop/test/workbench.test.ts", "desktop/scripts/workbench-runtime-smoke.mjs", "desktop/package.json",
 "desktop/scripts/copy-assets.mjs",
] + ["omicslab/web/js/views/%s" % n for n in sorted(os.listdir("omicslab/web/js/views"))]
p("== snapshot ==")
for f in files:
    if os.path.exists(f):
        s = snap(f); s["mtime"] = os.path.getmtime(f)
        p("%8d %s %s %s" % (s["bytes"], s["sha256"], int(s["mtime"]), f))

p("\n== package.json deps/devDeps ==")
pkg = json.loads(open("desktop/package.json", encoding="utf-8").read())
p("version", pkg.get("version"), "deps", json.dumps(pkg.get("dependencies"), ensure_ascii=False), "dev", json.dumps(pkg.get("devDependencies"), ensure_ascii=False))
p("scripts", json.dumps(pkg.get("scripts"), ensure_ascii=False))
p("\n== copy-assets.mjs ==")
p(open("desktop/scripts/copy-assets.mjs", encoding="utf-8").read())
p("\n== vendor dirs ==")
for cand in ["desktop/ui/vendor", "desktop/node_modules/katex", "desktop/node_modules/mermaid"]:
    p(cand, "exists", os.path.isdir(cand), (sorted(os.listdir(cand))[:12] if os.path.isdir(cand) else ""))
p("\n== packaged ui files ==")
for base, _, fs in os.walk("desktop/release/win-unpacked/resources/app/dist/ui"):
    for f in fs[:40]: p(os.path.join(base, f), os.path.getsize(os.path.join(base, f)))

p("\n== markdown.js image / vendor refs ==")
mk = io.open("desktop/ui/markdown.js", encoding="utf-8").read()
for i, line in enumerate(mk.splitlines(), 1):
    if re.search(r"vendor|katex|mermaid|IMG|img|image|script|innerHTML", line, re.I):
        p("%4d %s" % (i, line.strip()[:170]))
p("\n== app.js markdownOptions ==")
app = io.open("desktop/ui/app.js", encoding="utf-8").read().splitlines()
for i in range(1210, 1245):
    if i < len(app): p("%5d %s" % (i+1, app[i][:190]))

p("\n== contract methods count ==")
c = io.open("desktop/src/shared/contract.ts", encoding="utf-8").read()
m = re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]\s*as const", c, re.S) or re.search(r"RPC_METHODS\s*=\s*\[(.*?)\]", c, re.S)
if m:
    names = re.findall(r"'([^']+)'", m.group(1))
    p("count", len(names)); p(names)
p("\n== actions json summary ==")
acts = json.loads(open("desktop/ui/actions.json", encoding="utf-8").read())
from collections import Counter
p("total", len(acts), "pages", Counter(a.get("page") for a in acts))
p("workbench actions", [a for a in acts if a.get("page") == "workbench" or str(a.get("id", "")).startswith("wb-") or a.get("id") == "nav-workbench"])
p("\n== index nav data-page + version ==")
idx = io.open("desktop/ui/index.html", encoding="utf-8").read()
p("rail pages", re.findall(r'data-page="([a-z]+)"', idx))
p("version footer", re.findall(r'data-i18n="version">([^<]+)<', idx))
p("workbench section ids", re.findall(r'id="(wb-[a-z-]+)"', idx))
p("\n== daemon workbench.* dispatch? ==")
d = io.open("desktop/src/daemon.ts", encoding="utf-8").read()
p("workbench refs", [l.strip()[:140] for l in d.splitlines() if "workbench" in l.lower()][:20])
p("\n== main.ts legacyOpen exact lines 146-161 ==")
mt = io.open("desktop/src/main.ts", encoding="utf-8").read().splitlines()
for i in range(145, 162):
    if i < len(mt): p("%4d %s" % (i+1, mt[i]))

io.open("docs/research/repro/round4/recon5.txt", "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\n".join(L))
