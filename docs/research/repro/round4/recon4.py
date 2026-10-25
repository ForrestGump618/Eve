# -*- coding: utf-8 -*-
"""Round-4 recon 4: verification expectations, markdown/vendor integration, workbench UI, CSV state."""
import io, json, os, re, csv

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
L = []
def p(*a): L.append(" ".join(str(x) for x in a))

# 1. verifier expectations around counts/deliverables
v = io.open("docs/research/repro/round3/verify-final-320.py", encoding="utf-8").read()
p("== verifier relevant lines ==")
for i, line in enumerate(v.splitlines(), 1):
    if re.search(r"85|98 |master|parity|ui-action|144|deliverab|legacy|workbench", line):
        p("%4d %s" % (i, line.strip()[:190]))

# 2. markdown test coverage summary
mt = io.open("desktop/test/markdown.test.ts", encoding="utf-8").read()
p("\n== markdown.test.ts ==")
p("bytes", len(mt.encode('utf-8')), "lines", mt.count("\n")+1, "tests", len(re.findall(r"^test\(", mt, re.M)))
for m in re.finditer(r"test\(['\"]([^'\"]{5,140})", mt):
    p("  -", m.group(1))
for m in re.finditer(r"(?i)(xss|script|innerHTML|sanit|javascript:|onerror)", mt):
    ln = mt[:m.start()].count("\n")+1
    p("  safety ref line", ln, mt.splitlines()[ln-1].strip()[:150])
    break

# 3. vendor assets + app.js markdown integration
p("\n== desktop/ui listing ==")
for n in sorted(os.listdir("desktop/ui")):
    fp = os.path.join("desktop/ui", n)
    if os.path.isdir(fp):
        b = sum(os.path.getsize(os.path.join(fp, f)) for f in os.listdir(fp) if os.path.isfile(os.path.join(fp, f)))
        p("DIR", n, b, sorted(os.listdir(fp))[:14])
    else:
        p("FILE", n, os.path.getsize(fp))
app = io.open("desktop/ui/app.js", encoding="utf-8").read()
p("\n== app.js markdown integration ==")
for i, line in enumerate(app.splitlines(), 1):
    if re.search(r"SuwenMarkdown|markdown|md-", line):
        p("%5d %s" % (i, line.strip()[:180]))

# 4. workbench UI page markup/actions
idx = io.open("desktop/ui/index.html", encoding="utf-8").read()
i = idx.find('id="page-workbench"')
p("\n== index.html workbench page ==")
if i < 0:
    i = idx.find('data-page="workbench"')
p(re.sub(r"\s+", " ", idx[max(0, i-200):i+4000])[:4000])
p("\n== app.js workbench functions ==")
for i, line in enumerate(app.splitlines(), 1):
    if re.search(r"Workbench|workbench|wb-", line):
        p("%5d %s" % (i, line.strip()[:190]))

# 5. master counts + legacy rows
with io.open("docs/requirements/master-requirements.csv", encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))
from collections import Counter
p("\n== master counts ==", Counter(r["Status"] for r in rows), "rows", len(rows))
p("== rows mentioning legacy/workbench (not webhook) ==")
for r in rows:
    blob = (r["Feature"] + " " + r["Implementation Module"] + " " + r["Evidence"]).lower()
    if re.search(r"legacy|workbench", blob):
        p(r["Requirement ID"], "|", r["Status"], "|", r["Feature"][:90])

# 6. parity CSV status vocabulary + row count
with io.open("docs/migration/feature-parity-matrix.csv", encoding="utf-8-sig", newline="") as f:
    prows = list(csv.DictReader(f))
p("\n== parity ==", Counter(r["vnext_status"] for r in prows), "rows", len(prows))

# 7. acceptance-matrix mtime
p("\nacceptance-matrix mtime", os.path.getmtime("desktop/acceptance-matrix.md"), "size", os.path.getsize("desktop/acceptance-matrix.md"))

# 8. workbench runtime smoke script + evidence paths
sm = io.open("desktop/scripts/workbench-runtime-smoke.mjs", encoding="utf-8").read()
p("\n== workbench-runtime-smoke.mjs ==")
p("bytes", len(sm.encode('utf-8')), "lines", sm.count("\n")+1)
for i, line in enumerate(sm.splitlines(), 1):
    if re.search(r"out|write|report|checks|passed|failed|JSON|path|WORKBENCH", line):
        p("%4d %s" % (i, line.strip()[:170]))
p("\n== release/smoke dir (all) ==")
for base, _, files in os.walk("desktop/release/smoke"):
    for f in files:
        fp = os.path.join(base, f)
        if "screenshot" in fp or f.endswith(".png"): continue
        if re.search(r"workbench|legacy|runtime", f, re.I) or os.path.getmtime(fp) > 1792900000:
            p(fp, os.path.getsize(fp), "mtime", os.path.getmtime(fp))

# 9. daemon legacyStart deps support
d = io.open("desktop/src/daemon.ts", encoding="utf-8").read()
p("\n== daemon legacyStart/deps lines ==")
for i, line in enumerate(d.splitlines(), 1):
    if re.search(r"legacyStart|legacyStart|deps|legacy-worker|launchLegacy", line):
        p("%4d %s" % (i, line.strip()[:180]))

# 10. legacy_server bearer/static behavior confirmation
ls = io.open("desktop/worker/legacy_server.py", encoding="utf-8").read()
p("\n== legacy_server key lines ==")
for i, line in enumerate(ls.splitlines(), 1):
    if re.search(r"needs_auth|Bearer|bootstrap|401|websocket|static", line):
        p("%4d %s" % (i, line.strip()[:170]))

io.open("docs/research/repro/round4/recon4.txt", "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\n".join(L))
