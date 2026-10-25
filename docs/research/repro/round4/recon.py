# -*- coding: utf-8 -*-
"""Round-4 recon: legacy web SPA inventory + markdown clauses + CSV rows + mojibake probe."""
import csv, io, os, re, sys

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
out = []
def p(*args):
    out.append(" ".join(str(a) for a in args))

# ---------- 1. legacy web shell routes ----------
store = io.open("omicslab/web/js/store.js", encoding="utf-8").read()
appjs = io.open("omicslab/web/js/app.js", encoding="utf-8", errors="replace").read()
idx = io.open("omicslab/web/index.html", encoding="utf-8", errors="replace").read()
p("== store.js route/nav hints ==")
for m in re.finditer(r"(?:NAV|nav|ROUTES|routes|VIEWS|views)\s*[:=]\s*\[(.{0,1200}?)\]", store, re.S):
    p(m.group(1)[:1200].replace("\n", " "))
    p("---")
p("== store.js route-like string arrays ==")
for m in re.finditer(r"\[\s*(?:\"[a-z0-9-]+\"\s*,\s*){2,}\"[a-z0-9-]+\"\s*,?\s*\]", store):
    p(m.group(0)[:600])
p("== app.js view/route mapping ==")
for m in re.finditer(r"(?:views|VIEWS|routes|ROUTES)\s*[:=]\s*\{(.{0,2500}?)\}", appjs, re.S):
    p(m.group(1)[:2500].replace("\n", " "))
    p("---")
p("== app.js route constants ==")
for m in re.finditer(r"['\"]([a-z0-9-]+)['\"]\s*:\s*(?:render|mount|show|load)", appjs):
    p(m.group(0))

# ---------- 2. view files inventory ----------
p("\n== view files ==")
views_dir = "omicslab/web/js/views"
names = sorted(os.listdir(views_dir))
p("count", len(names))
for n in names:
    path = os.path.join(views_dir, n)
    src = io.open(path, encoding="utf-8", errors="replace").read()
    lines = src.count("\n") + 1
    # exported functions / route names
    fns = re.findall(r"export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)", src)
    routes = sorted(set(re.findall(r"#/([a-z0-9-]+)", src)))
    api = sorted(set(re.findall(r"/api/[A-Za-z0-9_/$\-{}.]+", src)))
    p("%-22s %6d lines %6d B  fns=%s routes=%s" % (n, lines, len(src.encode('utf-8')), ",".join(fns[:6]), ",".join(routes[:8])))
    if api:
        p("   api:", ", ".join(api[:14]))

# ---------- 3. api.js functions/endpoints ----------
api_js = io.open("omicslab/web/js/api.js", encoding="utf-8", errors="replace").read()
p("\n== api.js: %d lines, %d B ==" % (api_js.count("\n")+1, len(api_js.encode('utf-8'))))
fns = re.findall(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)", api_js)
p("functions(%d): %s" % (len(fns), ", ".join(fns)))
consts = re.findall(r"export\s+const\s+([A-Za-z0-9_$]+)", api_js)
p("consts(%d): %s" % (len(consts), ", ".join(consts)))
paths = sorted(set(re.findall(r"['\"`](/api/[^'\"`$]{1,80})", api_js)))
p("literal api paths(%d): %s" % (len(paths), ", ".join(paths[:120])))

# ---------- 4. index.html nav items ----------
p("\n== index.html nav hints ==")
for m in re.finditer(r"data-(?:route|view|page)=['\"]([a-z0-9-]+)['\"]", idx):
    p("data-attr:", m.group(1))
for m in re.finditer(r"<a[^>]+href=['\"]#/([a-z0-9-]+)['\"]", idx):
    p("link:", m.group(1))
navs = re.findall(r"nav[^>]*>(.{0,2500}?)</nav>", idx, re.S)
if navs:
    p("nav block:", re.sub(r"\s+", " ", navs[0])[:2000])

# ---------- 5. markdown clauses from round-3 prompt ----------
p("\n== round-3 prompt 3.5 / 5 markdown clauses ==")
prompt = io.open("docs/requirements/round-3-release-master-prompt.md", encoding="utf-8").read().splitlines()
for i, line in enumerate(prompt, 1):
    if re.search(r"markdown|Markdown|代码块|表格|sanit|转义|渲染", line):
        p("%4d %s" % (i, line.strip()[:220]))

# ---------- 6. master CSV R127 + legacy rows ----------
p("\n== master CSV R127 + legacy/workbench rows ==")
with io.open("docs/requirements/master-requirements.csv", encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))
p("master rows:", len(rows), "fields:", len(rows[0].keys()))
for r in rows:
    blob = " ".join(str(v) for v in r.values())
    if r.get("Requirement ID") == "R127" or re.search(r"legacy|workbench|web", blob, re.I):
        p("ROW", r.get("Requirement ID"), "|", (r.get("Feature") or "")[:60], "|", r.get("Status"), "|", (r.get("Blocker") or "")[:80])

# ---------- 7. parity CSV tail rows ----------
p("\n== parity CSV tail ==")
with io.open("docs/migration/feature-parity-matrix.csv", encoding="utf-8-sig", newline="") as f:
    prow = list(csv.DictReader(f))
p("parity rows:", len(prow), "fields:", list(prow[0].keys()))
for r in prow[-6:]:
    p("P:", r.get("capability") or r.get("Capability"), "|", r.get("vnext_status") or r.get("vnext_status"), "|", (r.get("category") or "")[:40])

# ---------- 8. progress tail ----------
p("\n== progress.md tail ==")
prog = io.open("docs/progress.md", encoding="utf-8").read().splitlines()
p("lines:", len(prog))
for line in prog[-40:]:
    p(line[:200])

# ---------- 9. mojibake probe in changed desktop files ----------
p("\n== mojibake probe ==")
def reverse_mojibake(s):
    try:
        b = s.encode("gbk")
    except UnicodeEncodeError:
        return None
    try:
        t = b.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if t == s:
        return None
    return t
targets = ["desktop/src/main.ts", "desktop/src/workbench.ts", "desktop/src/daemon.ts", "desktop/src/preload.cts",
           "desktop/src/legacy-worker.ts", "desktop/ui/app.js", "desktop/ui/index.html", "desktop/src/shared/contract.ts"]
for t in targets:
    src = io.open(t, encoding="utf-8", errors="replace").read().splitlines()
    hits = []
    for ln, line in enumerate(src, 1):
        for tok in re.findall(r"[\u4e00-\u9fff]{2,}", line):
            if len(tok) >= 2 and re.match(r"^[\u4e00-\u9fff]{2,30}$", tok):
                rev = reverse_mojibake(tok)
                if rev and re.search(r"[\u4e00-\u9fff]", rev) and len(hits) < 14:
                    hits.append((ln, tok, rev))
    if hits:
        p(t, "candidate mojibake tokens:", len(hits))
        for h in hits[:10]:
            p("   line", h[0], h[1], "->", h[2][:40])

io.open("docs/research/repro/round4/recon.txt", "w", encoding="utf-8").write("\n".join(out) + "\n")
print("\n".join(out))
