# -*- coding: utf-8 -*-
"""Round-4 recon 3: legacy SPA nav/route map, view metadata JSON, markdown evidence, encoding check."""
import io, json, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
L = []
def p(*a): L.append(" ".join(str(x) for x in a))

# 1. store.js full
p("========== store.js ==========")
p(io.open("omicslab/web/js/store.js", encoding="utf-8").read())

# 2. app.js route map / nav / labels
app = io.open("omicslab/web/js/app.js", encoding="utf-8", errors="replace").read()
p("\n========== app.js: ROUTE/VIEW map ==========")
for key in ["ROUTE_IDS", "NAV", "NAV_ITEMS", "VIEW_LOADERS", "LABELS", "titles", "routeLabels", "ROUTE_META"]:
    for m in re.finditer(key + r"\s*[:=]", app):
        seg = app[m.start():m.start()+2600]
        p("---", key, "---")
        p(seg[:2600])
        break
p("\n== app.js tasks2/platform refs ==")
for m in re.finditer(r".{160}tasks2.{200}", app):
    p(re.sub(r"\s+", " ", m.group(0)))
    break
for m in re.finditer(r".{120}platform.{160}", app):
    p(re.sub(r"\s+", " ", m.group(0)))
p("\n== app.js nav label strings (authored) ==")
labels = sorted(set(re.findall(r"[""']([\u4e00-\u9fff]{2,10})[""']", app)))
p(" | ".join(labels[:120]))

# 3. platform.js structure
plat = io.open("omicslab/web/js/views/platform.js", encoding="utf-8", errors="replace").read()
p("\n========== platform.js route/page registry ==========")
for pat in [r"tasks2", r"knowledge", r"workflow", r"extensions", r"artifacts", r"diagnostics", r"research"]:
    hits = [(m.start()) for m in re.finditer(pat, plat)]
    p(pat, "hits", len(hits), "first ctx:", re.sub(r"\s+", " ", plat[max(0, hits[0]-160):hits[0]+160])[:320] if hits else "")

# 4. per-view metadata
views_dir = "omicslab/web/js/views"
meta = {}
for n in sorted(os.listdir(views_dir)):
    src = io.open(os.path.join(views_dir, n), encoding="utf-8", errors="replace").read()
    api_calls = sorted(set(re.findall(r"\bapi\.([A-Za-z0-9_]+)\s*\(", src)))
    paths = sorted(set(re.findall(r"['\"`](/api/[A-Za-z0-9_/${}\-.:]{1,90})", src)))
    exports = re.findall(r"export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)", src)
    headings = sorted(set(h.strip() for h in re.findall(r"<h[1-3][^>]*>([^<]{1,80})</h[1-3]>", src)))
    zh = sorted(set(re.findall(r"[""']([\u4e00-\u9fff][\u4e00-\u9fff A-Za-z0-9·:：/、（）()\-]{1,28})[""']", src)))
    meta[n] = {"bytes": len(src.encode("utf-8")), "lines": src.count("\n")+1, "exports": exports,
               "api_calls": api_calls, "api_paths": paths, "headings": headings[:20], "zh_hints": zh[:40]}
p("\n========== per-view metadata ==========")
p(json.dumps(meta, ensure_ascii=False, indent=1)[:16000])

# 5. desktop test + markdown evidence
p("\n========== desktop test dir ==========")
for n in sorted(os.listdir("desktop/test")):
    p(n, os.path.getsize(os.path.join("desktop/test", n)))

mk = io.open("desktop/ui/markdown.js", encoding="utf-8", errors="replace").read()
p("\n========== markdown.js: head 80 ==========")
p("\n".join(mk.splitlines()[:80]))
p("\nmarkdown.js api/exports tail:", "\n".join(mk.splitlines()[-30:]))
tests = [n for n in os.listdir("desktop/test") if re.search(r"markdown|md|stream", n, re.I)]
p("markdown-ish tests:", tests)

# 6. docs mentioning markdown-rendering / legacy web
p("\n========== docs matching markdown/legacy-web evidence ==========")
for base, _, files in os.walk("docs"):
    for f in files:
        if f.endswith(".md") and re.search(r"markdown|legacy", f, re.I):
            path = os.path.join(base, f)
            p(path, os.path.getsize(path), "mtime", os.path.getmtime(path))
p("\n-- refs to markdown-rendering.md --")
for base, _, files in os.walk("docs"):
    for f in files:
        if not f.endswith(".md"): continue
        path = os.path.join(base, f)
        src = io.open(path, encoding="utf-8", errors="replace").read()
        if "markdown-rendering" in src: p(path, src.count("markdown-rendering"))
p("\n-- refs to legacy-web-parity --")
for base, _, files in os.walk("docs"):
    for f in files:
        if not f.endswith((".md", ".csv")): continue
        path = os.path.join(base, f)
        src = io.open(path, encoding="utf-8", errors="replace").read()
        if "legacy-web-parity" in src: p(path, src.count("legacy-web-parity"))

# 7. encoding truth check for main.ts + workbench.ts
p("\n========== encoding check ==========")
for f in ["desktop/src/main.ts", "desktop/src/workbench.ts", "desktop/ui/app.js"]:
    raw = open(f, "rb").read()
    try:
        txt = raw.decode("utf-8")
        p(f, "valid utf-8, bytes", len(raw), "U+FFFD", txt.count("\ufffd"))
    except UnicodeDecodeError as e:
        p(f, "NOT valid utf-8:", e)
    txt = raw.decode("utf-8", errors="replace")
    # find any line containing replacement char or the '?' residue typical of mojibake
    bad = [(i+1, l.strip()[:120]) for i, l in enumerate(txt.splitlines()) if "\ufffd" in l]
    if bad:
        p("  lines with U+FFFD:", len(bad))
        for b in bad[:10]: p("   ", b[0], b[1])

io.open("docs/research/repro/round4/recon3.txt", "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\n".join(L[:400]))
