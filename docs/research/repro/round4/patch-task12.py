# -*- coding: utf-8 -*-
"""task-12 patch: legacy-web/markdown parity docs -> master/parity CSVs + progress/conflicts/acceptance/traceability."""
import csv, hashlib, io, json, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
TODAY = "2026-10-25"

def sha(rel):
    raw = open(rel, "rb").read()
    return hashlib.sha256(raw).hexdigest(), len(raw)

def read_csv(path):
    bom = open(path, "rb").read(4).startswith(b"\xef\xbb\xbf")
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
        fields = list(rows[0].keys()) if rows else []
    return fields, rows, bom

def write_csv(path, fields, rows, bom):
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader(); w.writerows(rows)

# ---------------- 1) master requirements: R014/R020/R090/R091/R127 evidence ----------------
mfields, mrows, mbom = read_csv("docs/requirements/master-requirements.csv")
mdoc_hash, mdoc_bytes = sha("docs/requirements/master-requirements.csv")
mp = {}
for r in mrows:
    mp[r["Requirement ID"]] = r
updates = {
 "R014": {
   "Implementation Module": "desktop/src/workbench.ts; desktop/src/legacy-worker.ts; desktop/worker/legacy_server.py; desktop/src/main.ts legacyOpen; docs/verification/legacy-web-parity.md",
   "Test ID": "desktop/test/workbench.test.ts (7); desktop/scripts/workbench-runtime-smoke.mjs (host-level; Lead 26/28, no archived JSON)",
   "Evidence": "docs/verification/legacy-web-parity.md (route/API matrix + bridge architecture); managed runtime host install 132,868,111 B / 11,866 files at temp override; bridge bearer gateway + isolated partition window implemented; Lead host smoke 26/28 (2 test-path assumptions being corrected, no persisted report)",
   "Blocker": "Electron E2E for the hosted window not published (all 8 hosted routes HOSTED_LEGACY_PENDING_E2E); userData runtime install not exercised; credential/provider copy vs implementation mismatch (legacy-web-parity Q4); hosted surface has no CSP of its own (Q8)",
 },
 "R020": {
   "Evidence": "native rail now 6 pages (chat/projects/tasks/tools/workbench/settings), actions.json 148; docs/verification/legacy-web-parity.md records the 6th compat-workbench page and route parity",
 },
 "R090": {
   "Evidence": "native UI/installer/appId/package names are new-brand only; the hosted legacy SPA is a historical compat surface whose legacy internal identifiers are retained by design (docs/verification/legacy-web-parity.md; branding exceptions)",
 },
 "R091": {
   "Evidence": "docs/research/branding-exceptions.md (983 hits / 143 files, 0 require change); hosted legacy page retains historical brand internals intentionally (LEGACY-BRAND-COMPAT)",
 },
 "R127": {
   "Implementation Module": "desktop/ui/markdown.js; desktop/ui/app.js (completed-only markdown); desktop/scripts/copy-assets.mjs (vendor); docs/verification/markdown-rendering.md; docs/requirements/markdown-parity.md",
   "Test ID": "desktop/test/markdown.test.ts (26/26); node --check ui/markdown.js; docs/verification/markdown-rendering.md §8",
   "Evidence": "docs/requirements/markdown-parity.md (clause-by-clause); docs/verification/markdown-rendering.md 11,177 B sha256 97e98c33…d8ecbc; ui/markdown.js 35,583 B sha256 9c82a0c1…a86e9; KaTeX/Mermaid real rendering + textContent-only sanitization; 26/26 tests",
   "Blocker": "Streaming-phase matrix items (table/code across deltas, zh/en chunk boundaries) NOT_VERIFIED because streaming renders plain text; markdown render time not measured; clause 7 images/layout-shift NOT_IMPLEMENTED; clipboard copy unexercised; T2 Electron visual check pending; packaged installer predates renderer (rebuild pending, Q5)",
 },
}
for rid, upd in updates.items():
    r = mp.get(rid)
    assert r is not None, rid
    for k, v in upd.items():
        r[k] = v
write_csv("docs/requirements/master-requirements.csv", mfields, mrows, mbom)
from collections import Counter
mc = Counter(r["Status"] for r in mrows)
print("MASTER rows", len(mrows), dict(mc))

# ---------------- 2) parity matrix: append round-4 audit rows ----------------
pfields, prows, pbom = read_csv("docs/migration/feature-parity-matrix.csv")
existing = {r["capability"] for r in prows}
new_rows = [
 {
  "capability": "Legacy web route/API parity inventory (audit)",
  "category": "legacy/compat",
  "python_baseline": "implemented",
  "python_evidence": "omicslab/web/js/store.js (20 routes), views/*.js (14 modules), api.js (54 /api paths)",
  "desktop_prototype": "n/a (no audit artefact)",
  "prototype_evidence": "n/a",
  "vnext_status": "IMPLEMENTED_PASS",
  "vnext_code": "docs/verification/legacy-web-parity.md",
  "reuse_mode": "documentation-only (hosted SPA, Python engines reused)",
  "data_migration": "bridge home separate from legacy home; explicit import wizard only",
  "priority": "P1",
  "test_id": "docs/research/repro/round4/recon4.py; recon5.py (SHA-256 snapshot)",
  "gaps": "matrix documents hosted strategy; runtime parity remains HOSTED_LEGACY_PENDING_E2E (see next row)",
 },
 {
  "capability": "Legacy web SPA hosted in isolated Electron window",
  "category": "legacy/compat",
  "python_baseline": "implemented",
  "python_evidence": "server/app.py + omicslab/web SPA (baseline session)",
  "desktop_prototype": "implemented bridge (2.1.1 legacy source)",
  "prototype_evidence": "desktop/src/legacy-worker.ts; desktop/worker/legacy_server.py",
  "vnext_status": "UNVERIFIED",
  "vnext_code": "desktop/src/workbench.ts; desktop/src/legacy-worker.ts; desktop/worker/legacy_server.py; desktop/src/main.ts:146-161",
  "reuse_mode": "host (not ported): managed Python runtime + bridge bearer gateway + isolated window",
  "data_migration": "fresh <userData>/runtime/legacy home; old data only via import wizard",
  "priority": "P0",
  "test_id": "desktop/test/workbench.test.ts (7); Lead host smoke 26/28 (no archived JSON)",
  "gaps": "Electron E2E (open window/header injection/20 routes/token absence/close stops bridge) NOT published; userData install unexercised; credential-injection copy mismatch (Q4); no CSP on hosted legacy surface (Q8)",
 },
 {
  "capability": "Managed Python workbench runtime bootstrap",
  "category": "legacy/compat",
  "python_baseline": "n/a (host Python required before)",
  "python_evidence": "pyproject.toml deps; legacy README install section",
  "desktop_prototype": "not implemented",
  "prototype_evidence": "n/a",
  "vnext_status": "UNVERIFIED",
  "vnext_code": "desktop/src/workbench.ts (13 pinned deps, marker, probe, cancel, 130 MB download)",
  "reuse_mode": "new desktop capability wrapping legacy Python",
  "data_migration": "deps under <userData>/python-env (override SUWEN_WORKBENCH_DEPS); no migration",
  "priority": "P1",
  "test_id": "desktop/test/workbench.test.ts (7/7); host temp install 132,868,111 B / 11,866 files measured",
  "gaps": "real userData install/progress stream/cancel/repair not exercised end-to-end; no uninstaller for python-env; disk-full/proxy/offline untested",
 },
 {
  "capability": "Markdown prompt-parity audit (round-3 §3.5)",
  "category": "streaming-ui",
  "python_baseline": "n/a",
  "python_evidence": "n/a",
  "desktop_prototype": "n/a",
  "prototype_evidence": "n/a",
  "vnext_status": "IMPLEMENTED_PASS",
  "vnext_code": "docs/requirements/markdown-parity.md",
  "reuse_mode": "documentation-only",
  "data_migration": "n/a",
  "priority": "P1",
  "test_id": "docs/requirements/markdown-parity.md §3 (10 implemented / 3 partial / 1 not implemented)",
  "gaps": "R127 capability stays UNVERIFIED: streaming markdown matrix items, render-time measurement, image/layout-shift clause, clipboard copy, T2 Electron visual, packaged rebuild",
 },
]
for row in new_rows:
    if row["capability"] in existing:
        print("parity row already present, skip:", row["capability"])
        continue
    prows.append(row)
write_csv("docs/migration/feature-parity-matrix.csv", pfields, prows, pbom)
pc = Counter(r["vnext_status"] for r in prows)
print("PARITY rows", len(prows), dict(pc))

# ---------------- 3) conflicts: append C-21..C-27 ----------------
conflicts_add = """
## C-21. Hosted legacy workbench: host smoke not archived, Electron E2E not published

The only runtime evidence for the hosted legacy SPA is a Lead-run host smoke reported as
**26/28 checks**, whose two failures were wrong test-path assumptions in the smoke script and are being
corrected; the smoke prints JSON to the console only and leaves **no persisted report**. No Electron
window E2E (header injection, route clicks, token absence, window-close bridge shutdown) is published.
Resolution: all 8 hosted routes are `HOSTED_LEGACY_PENDING_E2E` in
`docs/verification/legacy-web-parity.md`; R014 remains UNVERIFIED.

## C-22. Version/build drift vs round-4 release evidence

`desktop/package.json` and the UI footer now say **3.3.0** (dev preview), the round-4 release evidence
describes **3.2.0**, and `desktop/release/win-unpacked` was built from older sources (its `dist/ui` has
no `vendor/`, `markdown.js` 14,232 B vs 35,583 B in the working tree, `app.js` 204,682 B vs 215,394 B).
`scripts/copy-assets.mjs` now builds KaTeX/Mermaid vendor assets into `dist/ui/vendor/`. Resolution:
the installer must be rebuilt from a frozen tree and hashes re-recorded before any parity claim is tied
to the artifact; current instructions use the 3.2.0 numbers only where labelled.

## C-23. Workbench provider/credential copy vs implementation

The native workbench page hint says the hosted UI uses "this session's model configuration and
credentials injected through the isolated local process, never written to web storage". Code inspection
shows the bridge home is fresh and `worker/legacy_server.py` forces a **mock** provider unless the user
configures the bridge home; no safeStorage credential injection into the bridge was found. Resolution:
implement injection or fix the UI copy before claiming parity (legacy-web-parity Q4, P0 honesty).

## C-24. `ui-action-coverage.csv` 144 actions vs current `actions.json` 148

The coverage CSV (144 rows) predates the round-4 UI additions (`actions.json` now has 148 actions,
including 3 workbench actions + nav-workbench). Owning teammate/Lead must regenerate the coverage CSV;
this audit did not modify it (write scope; would invalidate the round-3 verifier expectation until
regenerated). Not a pass claim.

## C-25. Prompt matrix "table forming line by line" vs completed-only Markdown

The round-3 prompt §4 matrix requires "Markdown table forming line by line / code block across many
deltas / zh/en/Unicode across chunk boundaries". The shipped design deliberately renders **plain text
while streaming** and Markdown only on completion (`docs/verification/markdown-rendering.md` §1), so
those matrix items are `NOT_VERIFIED` rather than failed. Resolution: either record an explicit waiver
(design decision: no markdown during stream) or implement streaming-safe incremental markdown; R127
stays UNVERIFIED until then (`docs/requirements/markdown-parity.md`).

## C-26. Hosted legacy surface has no CSP of its own

The legacy SPA was served by the baseline Python server without a Content-Security-Policy
(`docs/architecture/current.md`); the hosted window mitigates with a separate session partition,
per-window Authorization injection, permission denial and origin-restricted navigation, but not CSP.
Resolution: accepted residual risk must be recorded in `docs/verification/security-review.md` (compat
surface) and re-evaluated before any production claim.

## C-27. `desktop/acceptance-matrix.md` was stale after the T2 correction

After the T2 post-fix corrections the master CSV counts changed to 81/12/4/1, actions to 148 and R130/R136
to PASS, while the acceptance matrix still said 80/13/4/1, 144 actions and "auto-reconnect UNVERIFIED /
visual UNVERIFIED". Resolution: conservative refresh in this round (counts/actions/R130/R136/visual/
managed-workbench row + markdown verdict row); no status inflation beyond master CSV.
"""
with open("docs/requirements/conflicts.md", encoding="utf-8") as f:
    if "## C-21." not in f.read():
        with open("docs/requirements/conflicts.md", "a", encoding="utf-8") as g:
            g.write(conflicts_add)
        print("CONFLICTS appended")
    else:
        print("conflicts already appended, skip")

# ---------------- 4) progress: append Round 4 section ----------------
progress_add = """
## Round 4 — legacy web parity & Markdown prompt audit (draft for Lead, 2026-10-25)

Round-4 docs audit (task-12). Scope: `docs/verification/legacy-web-parity.md` and
`docs/requirements/markdown-parity.md`; no source/UI/CI changes by this audit.

Verified by inspection and measurement:

- **Hosted legacy web architecture mapped**: 20 legacy SPA routes (12 visible / 8 hidden; platform.js
  hosts 8 of them), 14 view modules, 54 `/api` paths (`omicslab/web/js/{store,app,api}.js`, `views/*`),
  now hosted through a managed isolated Python runtime (13 pinned deps, ~130 MB download) +
  bearer-authenticated bridge + isolated Electron window. Host-level managed install measured:
  **132,868,111 B / 11,866 files**, marker python **3.11.9**, requirementsHash
  **3887b118…af256ab** (temp override directory; `userData/python-env` NOT installed on this host).
- **Route/API parity matrix published** (`docs/verification/legacy-web-parity.md`): 1
  NATIVE_EQUIVALENT (chat), 11 PARTIAL, 8 HOSTED_LEGACY_PENDING_E2E; every hosted route still gated on
  the unpublished Electron E2E; 84 RPC methods vs 54 legacy API paths mapped by domain.
- **Markdown prompt clauses audited** (`docs/requirements/markdown-parity.md`): of the 10 §3.5 clauses,
  10 IMPLEMENTED-equivalent items (incl. suggested render pipeline), 3 PARTIAL (code copy, long-content
  timing, stable-segment enhancement) and 1 **NOT_IMPLEMENTED** (images/async layout shift); the
  published `docs/verification/markdown-rendering.md` (11,177 B, sha256 `97e98c33…d8ecbc`) closes the
  earlier "no report" gap, and `desktop/test/markdown.test.ts` is 26/26.
- **CSV updates**: master rows R014/R020/R090/R091/R127 evidence refreshed (statuses unchanged:
  98 rows = **81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL**); parity matrix
  appended 4 audit rows → **89 rows = 69 IMPLEMENTED_PASS / 8 UNVERIFIED / 9 NOT_STARTED / 1 N/A_PORT /
  1 REPLACED / 1 BLOCKED_EXTERNAL**; `ui-action-coverage.csv` intentionally untouched (144 vs current
  148 actions — conflict C-24).
- **Acceptance matrix refreshed** to the post-T2 master state (counts 81/12/4/1, 148 actions,
  R130/R136 PASS with T2 post-fix report, visual audit PASS) and extended with the hosted-workbench
  row (host runtime measured, E2E pending) and the Markdown verdict row (R127 UNVERIFIED).
- **Conflicts C-21..C-27 recorded**: host smoke not archived; 3.3.0-vs-3.2.0 build drift and stale
  packaged UI; workbench credential/provider copy mismatch; 144-vs-148 coverage drift; prompt matrix
  "table line by line" vs completed-only rendering; hosted legacy surface has no CSP; stale acceptance
  matrix (fixed in this pass).

Still open in round 4:

1. Archived Electron E2E for the hosted workbench window (open/route clicks/token absence/close→bridge
   stop) and a persisted runtime-smoke JSON (`desktop/scripts/workbench-runtime-smoke.mjs` has no `--out`).
2. Real `userData/python-env` install flow (progress/cancel/repair) and runtime uninstaller; disk-full /
   proxy / offline behaviour.
3. Workbench credential/provider copy resolution (Q4) and hosted-surface CSP risk entry.
4. Markdown: streaming matrix rows, render-time measurement, image/layout-shift clause, clipboard copy,
   T2 visual check, XSS fuzz; R127 stays UNVERIFIED.
5. Installer rebuild from frozen tree (3.3.0 drift) with re-recorded SHA-256; `ui-action-coverage.csv`
   regeneration for 148 actions.
"""
with open("docs/progress.md", encoding="utf-8") as f:
    if "Round 4 — legacy web parity" not in f.read():
        with open("docs/progress.md", "a", encoding="utf-8") as g:
            g.write(progress_add)
        print("PROGRESS appended")
    else:
        print("progress already appended, skip")

# ---------------- 5) traceability: append section 10 with hashes ----------------
tr = io.open("docs/requirements/traceability.md", encoding="utf-8").read()
if "## 10. Round-4 audit additions" not in tr:
    files = [
        "docs/verification/legacy-web-parity.md",
        "docs/requirements/markdown-parity.md",
        "docs/verification/markdown-rendering.md",
        "docs/requirements/conflicts.md",
        "docs/requirements/master-requirements.csv",
        "docs/migration/feature-parity-matrix.csv",
        "docs/progress.md",
        "desktop/acceptance-matrix.md",
    ]
    lines = ["\n## 10. Round-4 audit additions (2026-10-25)\n",
             "Files added/updated by the round-4 docs audit (SHA-256 at write time):\n",
             "| Path | Bytes | SHA-256 | Purpose |", "| --- | --- | --- | --- |"]
    purposes = {
        "docs/verification/legacy-web-parity.md": "legacy web route/API parity + hosted workbench architecture",
        "docs/requirements/markdown-parity.md": "round-3 markdown/complex-content clause audit",
        "docs/verification/markdown-rendering.md": "T5 owner report for KaTeX/Mermaid renderer (referenced)",
        "docs/requirements/conflicts.md": "conflicts C-21..C-27",
        "docs/requirements/master-requirements.csv": "13-field requirement register (evidence refresh)",
        "docs/migration/feature-parity-matrix.csv": "parity matrix (+4 round-4 rows)",
        "docs/progress.md": "round-4 progress section (draft)",
        "desktop/acceptance-matrix.md": "acceptance matrix conservative refresh",
    }
    for rel in files:
        h, n = sha(rel)
        lines.append(f"| `{rel}` | {n} | `{h}` | {purposes[rel]} |")
    with open("docs/requirements/traceability.md", "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("TRACEABILITY appended")

# ---------------- 6) acceptance matrix refresh ----------------
ap = "desktop/acceptance-matrix.md"
acc = io.open(ap, encoding="utf-8").read()
repl = [
 ("(80 IMPLEMENTED_PASS / 13 UNVERIFIED / 4 NOT_STARTED /", "(81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED /"),
 ("`actions.json` **144 actions**", "`actions.json` **148 actions**"),
 ("| Auto-reconnect / duplicate append after daemon SIGKILL | **UNVERIFIED** — T2 interim report recorded FAIL; fixes landed afterwards (`main.ts` bounded backoff 300 ms–12 s, `conversations.ts` idempotent append, `conversations.test.ts`), but T2 post-fix in-Electron re-run was not published → R130 remains UNVERIFIED |",
  "| Auto-reconnect / duplicate append after daemon SIGKILL | **Pass (post-fix re-run published)** — duplicate persisted assistant turns fixed in `conversations.ts` (merge typed turns; `conversations.test.ts` added) and daemon auto-reconnect fixed in `main.ts` (bounded backoff 300 ms–12 s, config/secret re-push, `suwen:connection` reconnecting/restored/lost); T2 post-fix run 3/3 PASS |"),
 ("| Visual acceptance matrix | **UNVERIFIED** — `ui-visual-audit.md` not published; screenshots exist under `../docs/verification/screenshots/` and layout checks are in `ui-e2e.md` |",
  "| Visual acceptance matrix | **Pass for measured scope** — `../docs/verification/ui-visual-audit.md`: 3 runs / 180 screenshots (1920×1080, 1366×768, 980×680; zh/en; light/dark), 0 overflow / 0 overlap / 0 console errors; open P2: chat error surface not visible; no contrast/a11y audit |"),
 ("| UI DOM QA / actions wiring | **Pass with warnings** — 19/0/12 (warnings = intentional main-process bridge methods); `actions.json` **148 actions**, coverage 91 daemon RPC / 10 main process / 43 UI-only / **0 unknown methods** |",
  "| UI DOM QA / actions wiring | **Pass with warnings** — round-3 run 19/0/12 and round-4 run 18/0/13 (`markdown-rendering.md` §8; warnings = intentional main-process bridge methods, 148 actions / 84 RPC methods); coverage CSV still 144 rows (regen pending, conflict C-24) |"),
 ("| Optional legacy Python workbench | **Unavailable on this host** (Python lacks `fastapi`) — source preserved under `resources/legacy`; not a pass |",
  "| Hosted legacy web workbench (6th rail page) | **Host-level runtime measured, Electron E2E pending** — managed runtime installed at temp override (132,868,111 B / 11,866 files, Python 3.11.9, pinned requirementsHash), bridge bearer + isolated window implemented; Lead host smoke 26/28 (2 test-path fixes in flight, no archived report); all 8 hosted routes `HOSTED_LEGACY_PENDING_E2E` (`../docs/verification/legacy-web-parity.md`) |\n| Markdown / complex content (R127) | **UNVERIFIED** — renderer + KaTeX/Mermaid upgrade published (`markdown-rendering.md`, 26/26 tests); missing: streaming matrix rows, render-time measurement, image/layout-shift clause, clipboard copy, T2 visual check; packaged installer predates renderer (`../docs/requirements/markdown-parity.md`) |"),
]
for old, new in repl:
    if old in acc:
        acc = acc.replace(old, new)
    elif new in acc:
        continue  # already applied by a previous run
    else:
        raise SystemExit("acceptance replacement target not found: " + old[:80])
io.open(ap, "w", encoding="utf-8", newline="\n").write(acc)
print("ACCEPTANCE refreshed")

# ---------------- 7) report freshness ----------------
for rel in ["docs/requirements/master-requirements.csv", "docs/migration/feature-parity-matrix.csv",
            "docs/verification/legacy-web-parity.md", "docs/requirements/markdown-parity.md"]:
    h, n = sha(rel); print("HASH", rel, n, h[:16])
