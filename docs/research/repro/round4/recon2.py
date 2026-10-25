# -*- coding: utf-8 -*-
"""Round-4 recon 2: shell nav, platform routes, markdown clauses/tests, UI page, acceptance matrix."""
import io, os, re, csv

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
lines = []
def p(*a): lines.append(" ".join(str(x) for x in a))

# 1. shell nav definitions
for f in ["omicslab/web/js/store.js", "omicslab/web/js/app.js", "omicslab/web/js/util.js"]:
    src = io.open(f, encoding="utf-8", errors="replace").read()
    p("==", f, len(src), "B ==")
    for m in re.finditer(r"(?is)(nav|route|view|page)[^\n]{0,120}", src):
        s = m.group(0)
        if re.search(r"workbench|tasks2|research|knowledge|workflow|artifacts|extensions|discovery|diagnostics|settings|ssh", s):
            p("  ", s.strip()[:180])
    if f.endswith("app.js"):
        i = src.find("workbench")
        p("  app.js workbench ctx:", re.sub(r"\s+", " ", src[max(0, i-300):i+300])[:600])
p("\n== index.html nav area ==")
idx = io.open("omicslab/web/index.html", encoding="utf-8", errors="replace").read()
p("size", len(idx))
for m in re.finditer(r"(?:data-page|data-route|data-view|href=\"#/)([a-z0-9-]+)", idx):
    p("  nav:", m.group(1), "|", m.group(0)[:80])
# any inline script config?
for m in re.finditer(r"(?is)<script[^>]*>(.{0,4000}?)</script>", idx):
    body = m.group(1)
    if re.search(r"workbench|tasks2|nav", body):
        p("  inline script:", re.sub(r"\s+", " ", body)[:1500])

# 2. platform.js hosted routes / page registry
plat = io.open("omicslab/web/js/views/platform.js", encoding="utf-8", errors="replace").read()
p("\n== platform.js ==")
p("lines", plat.count("\n")+1, "B", len(plat.encode("utf-8")))
routes = sorted(set(re.findall(r"#/([a-z0-9-]+)", plat)))
p("routes:", routes)
for m in re.finditer(r"(?is)(?:const|let|var)\s+(PAGES|PAGE|TABS|SECTIONS|VIEWS|ROUTES)\s*=\s*[\[{](.{0,3000}?)[\]}]", plat):
    p("const", m.group(1), "=", re.sub(r"\s+", " ", m.group(2))[:2500])
for m in re.finditer(r"['\"](tasks2|extensions|knowledge|workflow|research|artifacts|diagnostics|settings)['\"]", plat):
    pass
p("labels:", sorted(set(re.findall(r"['\"]([a-z0-9-]{3,20})['\"]\s*:", plat)))[:40])

# 3. round-3 prompt markdown region §3.5 + §5
prompt = io.open("docs/requirements/round-3-release-master-prompt.md", encoding="utf-8").read().splitlines()
p("\n== prompt lines 100-125 ==")
for i in range(99, 125):
    if i < len(prompt): p("%4d %s" % (i+1, prompt[i].rstrip()[:200]))
p("\n== prompt lines 150-175 ==")
for i in range(149, 175):
    if i < len(prompt): p("%4d %s" % (i+1, prompt[i].rstrip()[:200]))

# 4. markdown evidence in T2 docs + markdown.js
for f in ["desktop/ui/markdown.js", "docs/verification/ui-e2e.md", "docs/verification/ui-streaming-stability.md"]:
    src = io.open(f, encoding="utf-8", errors="replace").read()
    p("\n==", f, len(src.encode("utf-8")), "B ==")
    if f.endswith("markdown.js"):
        p("lines", src.count("\n")+1)
        p("exports:", re.findall(r"(?:(?:export\s+(?:default\s+)?(?:function|class|const)\s+[A-Za-z0-9_$]+)|globalThis\.[A-Za-z0-9_$]+|module\.exports\s*=\s*[^;]+)", src)[:12])
        p("features:", sorted(set(re.findall(r"(\bcode\b|\btable\b|blockquote|heading|list|link|inlineCode|fence|mermaid|latex|\\$\\$|copy)", src, re.I)))[:30])
    else:
        hits = [ (i+1,l.strip()[:190]) for i,l in enumerate(src.splitlines()) if re.search(r"markdown|Markdown|table|code fence|XSS|script", l) ]
        p("markdown hits:", len(hits))
        for h in hits[:22]: p("  ", h[0], h[1])

# 5. UI workbench page sections
appjs = io.open("desktop/ui/app.js", encoding="utf-8", errors="replace").read()
idx2 = io.open("desktop/ui/index.html", encoding="utf-8", errors="replace").read()
p("\n== desktop workbench page ==")
p("index workbench ids:", sorted(set(re.findall(r"id=\"(wb-[a-z-]+)\"", idx2)))[:30])
p("app.js workbench fns:", sorted(set(re.findall(r"(?:function\s+|const\s+)([A-Za-z0-9_$]*[Ww]orkbench[A-Za-z0-9_$]*)", appjs)))[:20])
p("app.js onWorkbench:", re.findall(r"onWorkbench[A-Za-z0-9_$]*", appjs)[:8])
p("actions page count:", re.findall(r"\"page\":\s*\"workbench\"", io.open("desktop/ui/actions.json", encoding="utf-8").read()).__len__())

# 6. R014/R020/R127 full rows
with io.open("docs/requirements/master-requirements.csv", encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))
p("\n== master rows of interest (full) ==")
for aid in ("R014", "R020", "R021", "R127"):
    for r in rows:
        if r["Requirement ID"] == aid:
            for k, v in r.items(): p("  ", aid, k, "=", str(v)[:260])
            p("  ---")

# 7. acceptance matrix + progress headings
p("\n== desktop/acceptance-matrix.md (full) ==")
am = io.open("desktop/acceptance-matrix.md", encoding="utf-8").read()
p("B", len(am.encode("utf-8")), "lines", am.count("\n")+1)
p(am)
p("\n== progress headings ==")
prog = io.open("docs/progress.md", encoding="utf-8").read().splitlines()
for i, l in enumerate(prog, 1):
    if re.match(r"#{1,4}\s", l): p("%4d %s" % (i, l[:150]))
p("total lines", len(prog))

io.open("docs/research/repro/round4/recon2.txt", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines))
