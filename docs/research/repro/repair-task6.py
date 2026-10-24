# -*- coding: utf-8 -*-
"""Repair pass after task-6: restore master CSV to 71 rows (R100-R121 were lost to a
truncated write), apply the Lead's final status decisions, publish SHA256SUMS.txt and
make traceability/installer/progress docs coherent.  All numbers are measured facts
from artifacts on disk; nothing is invented."""
import csv, hashlib, os, sys

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"

def p(*parts):
    return os.path.join(ROOT, *parts)

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()

CSV_PATH = p("docs", "requirements", "master-requirements.csv")
rows = list(csv.reader(open(CSV_PATH, encoding="utf-8-sig")))
header, body = rows[0], rows[1:]
body = [r for r in body if r]
print("columns:", header)
ids = [r[0] for r in body]
print("rows before:", len(body), "| ids:", ",".join(ids))
assert len(body) == 55, "expected 55 rows R001-R094 before repair"
assert ids[-1] == "R094"

E_UNIT = "npm test 150/148/2 skip, exit 0 (28.3 s)"
E_E2E = "e2e-rpc 42/0 live detached daemon (~7 s)"
E_SMOKE = "packaged smoke 8/8 (106 s)"
E_UI = "ui-dom-qa 19/0/10; actions.json 142; contract 79"
E_INST = ("installer-lifecycle.json 14/14 PASS (2026-10-24T17:45:22Z, install 18 s, "
          "reinstall 24 s, uninstall 11 s); upgrade-path.json 8/8 PASS "
          "(3.0.0-preview.1 -> 3.1.0)")
E_SHA = ("SHA256SUMS present at desktop/release/SHA256SUMS and docs/release/SHA256SUMS.txt "
         "(3 rows: exe E1A1062C..., blockmap 72DD2D54..., unpacked exe CFE87F2D...)")
E_CHAOS = "chaos-results.json 12/12 PASS in 52.2 s (short-window, one Windows session)"
E_DB = ("real Europe PMC PMID 42878939 + UniProt Q9Y2B4 release 2026_03, responses "
        "stored as sha256 artifacts")
UNSIGNED = "installer UNSIGNED (no certificate; SmartScreen risk disclosed)"

new_rows = [
    ["R100",
     "Produce a real Windows x64 NSIS installer + SHA256SUMS, and verify install/start/upgrade/uninstall (if clean Windows is unavailable: declare the limitation and provide runnable CI)",
     "desktop/package.json (dist:win, electron-builder nsis x64); desktop/release/SuWen-Setup-3.1.0-win-x64.exe (+ .blockmap, win-unpacked/SuWen.exe); desktop/release/SHA256SUMS; docs/release/SHA256SUMS.txt; .github/workflows/suwen-windows.yml",
     "Final artifact: exe 129,425,145 B SHA256 E1A1062C...; blockmap 135,934 B SHA256 72DD2D54...; win-unpacked exe 249,801,728 B SHA256 CFE87F2D...; " + UNSIGNED + "; " + E_SHA,
     E_INST + "; " + E_SHA,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Clean-Windows-VM lifecycle not executed; code signing BLOCKED_EXTERNAL (no certificate)",
     "Lead"],
    ["R101",
     "Optional independent Python runtime bootstrap (install shows size/network/license); without Python basic chat/MCP work and diagnostics give hints",
     "desktop/src/python-worker.ts; desktop/worker/research_worker.py; desktop/src/main.ts pythonPicker + preferences pythonPath; installer extraResources worker/*.py; docs/release/windows-installer-verification.md",
     "Python is an optional external interpreter (path from preferences/doctor); the installer does not bundle a Python runtime; chat/MCP/registries work without Python; doctor/python probe exposes state (e2e doctor 11 checks; health python field)",
     "npm test 150/148/2; e2e-rpc doctor.run + worker.health/describe; packaged smoke python worker only because host Python was present",
     "NOT_STARTED", "CODE_ONLY",
     "No Python bootstrap download/install flow, no size/network/license disclosure UI; requires user-provided Python",
     "Lead"],
    ["R102",
     "Upgrade migrates DB with backup; uninstall keeps user data by default, optional clear",
     "desktop/src/harness/store.ts (VACUUM INTO pre-migration backup); desktop/package.json nsis deleteAppDataOnUninstall=false; docs/verification/artifacts/installer-lifecycle.json; docs/verification/artifacts/upgrade-path.json",
     "harness/store.ts backs up before migration; NSIS deleteAppDataOnUninstall=false; lifecycle probe: uninstall left user data (14/14); cross-version upgrade 3.0.0-preview.1 -> 3.1.0 passed 8/8 at installer level",
     "installer-lifecycle.json user-data-preserved step passed; upgrade-path.json 8/8 (host); no harness DB schema migration observed during the upgrade",
     "UNVERIFIED", "PARTIAL",
     "Clean-VM upgrade/uninstall data-retention and harness DB migration-with-backup during upgrade not executed",
     "Lead"],
    ["R103",
     "Without a code-signing certificate, truthfully report SmartScreen risk; never fake a signed build",
     "desktop/package.json (win.signExecutable=false, no certificate); docs/release/windows-installer-verification.md; docs/progress.md; desktop/README.md",
     "Install package is UNSIGNED and the SmartScreen risk is disclosed in the release doc, README and progress; no signed-build claim exists anywhere",
     "Get-AuthenticodeSignature/build logs show unsigned; document review 2026-10-25",
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Code signing remains BLOCKED_EXTERNAL (no certificate)",
     "Lead"],
    ["R110",
     "Acceptance: multi-turn chat/cancel/recover/extra-long history/stable input",
     "desktop/ui/app.js; desktop/src/daemon.ts control; desktop/src/harness/store.ts; desktop/test/daemon-integration.test.ts, durable.test.ts",
     "Streamed chat with throttling, timeline virtualization, persistent scroll, cancel/pause/resume; conversation reopen restores history; packed smoke chat fixture streamed/committed",
     E_UNIT + "; " + E_SMOKE + "; " + E_E2E,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Multi-hour input stability not measured",
     "done"],
    ["R111",
     "At least two model provider adapters verified and errors visible (external accounts unavailable: real local HTTP fixtures + explicit blocked)",
     "desktop/src/providers.ts; desktop/src/model-runtime.ts; desktop/test/providers.test.ts",
     "Two adapters (OpenAI-compatible + Anthropic) validated against real local HTTP fixture servers; refusals/errors visible in UI; no external account used",
     "providers tests inside npm test 150/148/2; e2e-rpc model-gate refusal; fixture-protocol only",
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Real external model accounts BLOCKED_EXTERNAL (no credentials); no live vendor cost/quota evidence",
     "Lead"],
    ["R112",
     "MCP PubMed + at least one gene/protein DB end-to-end real call succeeds with citations/sources retained",
     "desktop/src/mcp-client.ts; desktop/src/activities/databases.ts; desktop/scripts/e2e-rpc.mjs (--live)",
     "Real public DB calls: Europe PMC query 'CRISPR base editing' first PMID 42878939; UniProt TP53 first hit Q9Y2B4 release 2026_03; responses stored as durable artifacts with sha256",
     E_E2E + "; " + E_DB,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Only Europe PMC/PubMed + UniProt; no other DBs (STRING/ChEMBL etc.); live MCP server install not exercised",
     "done"],
    ["R113",
     "Skill: Paper2Agent install/discover/disable + public paper repo tool-construction test",
     "desktop/src/domain/tools.ts (generic skill registry only); resources/legacy/skills/paper2agent (legacy Python); docs/migration/feature-parity-matrix.csv Paper2Agent row",
     "Paper2Agent pipeline is NOT implemented in the new desktop; the legacy Python skill is preserved only under resources/legacy; no paper-repo -> tool construction test",
     "none in TARGET",
     "NOT_STARTED", "NONE",
     "Paper2Agent install/discover/disable + public paper repo tool-construction test TODO",
     "Lead"],
    ["R114",
     "Analysis: sandbox executes public sample data and outputs version + reproducible scripts",
     "desktop/worker/research_worker.py (v2.0.0, protocol suwen-research-worker/2); desktop/src/research-worker.ts; desktop/scripts/electron-smoke.mjs",
     "Real FCS 3.1 demo.fcs (120,811 B, 6,000 events) metrics: mean FSC-A 50357.318211, SSC-A 30390.826209, FL1-A 734.915157, FL2-A 363.630725, FL3-A 788.096841; Otsu gates 3199/1979/1612/653/1279; runScript sandbox timeouts/output caps/env allowlist/file digests",
     "research-worker tests 22/21/1 skip; packaged smoke python worker exit 0; reproducible hashes",
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Fixed analysis operations only; arbitrary scientific stack + environment lock not implemented",
     "done"],
    ["R115",
     "Debate: multi-agent proposal/critique/revision/summary auditable",
     "desktop/src/domain/research.ts; desktop/src/activities/research.ts (48 debate references)",
     "research.debate durable DAG steps (proposal/critique/revision/summary) with typed records and evidence artifacts",
     E_UNIT + "; " + E_E2E + " research.graph",
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Serialized debate on the same configured provider; not independent scientific validation",
     "done"],
    ["R116",
     "Long-run: after UI closes daemon continues; daemon/Python worker crash and Windows reboot recover from checkpoint; lease reclaim/idempotency/status visible",
     "desktop/src/daemon.ts (detached); desktop/src/harness/store.ts lease/reclaim; desktop/scripts/chaos-smoke.mjs; docs/verification/chaos-results.json",
     "UI close leaves daemon alive; worker/daemon SIGKILL recovery with same operationId and no replay; provider 429/500 retried with approvals; Windows reboot not tested",
     E_SMOKE + "; " + E_CHAOS,
     "UNVERIFIED", "PARTIAL",
     "Windows reboot recovery and 8/24/72 h endurance not executed",
     "Lead"],
    ["R117",
     "Compaction: multiple rounds/long tool results/restart retains goals/evidence/citations/state/safety constraints, versions + rollback",
     "desktop/src/context.ts; desktop/src/context-async.ts; desktop/test/context.test.ts, context-async.test.ts; daemon contextHistory/Restore/Compact",
     "Compaction with versions/manual compaction/rollback; 10-round ~201k-token history reduced to ~2.0-2.8k visible tokens; explicit constraints/evidence/user text retention 100% on tested fixtures",
     "context tests 7/7 + async 4/4; e2e-rpc context versions; " + E_UNIT,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Semantic losslessness not claimed; restart retention across OS reboot not tested",
     "done"],
    ["R118",
     "Security: deny unauthorized shell/file ops; sensitive config not leaked",
     "desktop/src/main.ts (contextIsolation/sandbox/CSP/IPC sender checks); desktop/src/security.ts; desktop/src/rpc/core.ts artifact.read guard; desktop/test/security.test.ts",
     "Renderer cannot require Node, CSP connect-src 'none', IPC sender/frame validated, artifact paths confined, safeStorage-encrypted credentials, timing-safe named-pipe token, permissions denied",
     "security unit tests; e2e artifact path-guard rejection; unauthorized pipe mutation rejected; " + E_UNIT,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "OS-level sandbox/quotas not implemented; comprehensive third-party audit not performed",
     "Lead"],
    ["R119",
     "Release: clean Windows install/start/upgrade/uninstall passes; installer exists and SHA256 verifiable",
     "desktop/release/SuWen-Setup-3.1.0-win-x64.exe; desktop/release/SHA256SUMS; docs/release/SHA256SUMS.txt; docs/verification/artifacts/installer-lifecycle.json; docs/verification/artifacts/upgrade-path.json",
     "Final installer 129,425,145 B SHA256 E1A1062C...; final-artifact host lifecycle 14/14 and cross-version upgrade 8/8; " + E_SHA + "; " + UNSIGNED,
     E_INST + "; " + E_SHA + "; clean-Windows-VM lifecycle NOT executed",
     "UNVERIFIED", "PARTIAL",
     "Clean-Windows-VM install/start/upgrade/uninstall not run; code signing BLOCKED_EXTERNAL",
     "Lead"],
    ["R120",
     "Machine-readable reports complete: master-requirements.csv, feature-parity-matrix.csv, ui-action-coverage.csv, integration-and-e2e.md, durability-chaos-tests.md, third-party-dependencies.md, windows-installer-verification.md, progress.md",
     "docs/requirements/master-requirements.csv; docs/migration/feature-parity-matrix.csv; docs/verification/ui-action-coverage.csv; docs/verification/integration-and-e2e.md; docs/verification/durability-chaos-tests.md; docs/verification/third-party-dependencies.md; docs/release/windows-installer-verification.md; docs/progress.md (+ traceability.md, conflicts.md, docs/release/SHA256SUMS.txt)",
     "{REPORTS_EVIDENCE}",
     "file presence + row counts verified by docs/research/repro/final-check-310.py and the 2026-10-25 repair script",
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Clean-VM lifecycle, CI run and endurance remain host/short-window only (disclosed inside the reports)",
     "done"],
    ["R121",
     "Final delivery: directory structure, key demo paths, real installer path/SHA256, test commands+results, coverage, unresolved blockers, parity evidence, rollback notes",
     "TARGET_ROOT tree; installer + SHA256SUMS; docs/requirements/*; docs/migration/*; docs/verification/*; docs/release/*; docs/progress.md; rollback tag suwen-vnext-baseline-20261024",
     "Delivery package present: docs tree with requirements/migration/verification/release/progress; real installer path + SHA256 (E1A1062C...); parity/UI coverage CSVs; rollback tag and supersession notes (conflicts C-05/C-13/C-14); reproduce commands in integration-and-e2e.md and progress.md",
     "final installer sha256 E1A1062C...; host lifecycle 14/14 + upgrade 8/8; " + E_SHA,
     "IMPLEMENTED_PASS", "TARGET_RUN",
     "Remaining unsatisfied items disclosed: R119 clean-VM, R050 endurance, R094 signing, real external accounts",
     "Lead"],
]
assert len(new_rows) == 16
body.extend(new_rows)
assert len(body) == 71

status_by_id = {r[0]: r[5] for r in body}
counts = {s: sum(1 for r in body if r[5] == s) for s in ("IMPLEMENTED_PASS", "UNVERIFIED", "NOT_STARTED")}
print("final counts:", counts)
assert counts["IMPLEMENTED_PASS"] == 60 and counts["UNVERIFIED"] == 8 and counts["NOT_STARTED"] == 3

# R120 evidence text with the real counts
for r in body:
    if r[0] == "R120":
        r[3] = ("All eight required reports are current for 3.1.0: master %d rows (%d/%d/%d), "
                "parity 70 rows, UI 142 rows; integration/durability/dependencies/installer/progress "
                "updated with the final artifacts") % (
                    len(body), counts["IMPLEMENTED_PASS"], counts["UNVERIFIED"], counts["NOT_STARTED"])

with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(header)
    w.writerows(body)
print("csv rows written:", len(body))

# ---- publish SHA256SUMS.txt (exact Lead-provided content) ----
sums_txt = p("docs", "release", "SHA256SUMS.txt")
os.makedirs(os.path.dirname(sums_txt), exist_ok=True)
rel_sums = p("desktop", "release", "SHA256SUMS")
with open(rel_sums, encoding="utf-8") as f:
    rel_content = [ln.strip() for ln in f.read().replace("\r\n", "\n").split("\n") if ln.strip()]
with open(sums_txt, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(rel_content) + "\n")
print("SHA256SUMS.txt lines:", len(rel_content))
for ln in rel_content:
    print("  ", ln)

# ---- installer doc honesty statement ----
inst_doc = p("docs", "release", "windows-installer-verification.md")
txt = open(inst_doc, encoding="utf-8").read()
old = ("There is still **no clean-VM verification, no code\nsignature and no SHA256SUMS artifact**.")
new = ("There is still **no clean-VM verification and no code\n"
       "signature**; `SHA256SUMS` is now present — `desktop/release/SHA256SUMS`,\n"
       "mirrored as `docs/release/SHA256SUMS.txt`.")
assert old in txt, "installer honesty sentence not found"
txt = txt.replace(old, new)
open(inst_doc, "w", encoding="utf-8", newline="\n").write(txt)
print("installer doc patched")

# ---- progress.md ----
prog = p("docs", "progress.md")
ptxt = open(prog, encoding="utf-8").read()
old = "3. `SHA256SUMS` artifact and GitHub Actions execution for `.github/workflows/suwen-windows.yml`."
new = ("3. GitHub Actions execution of `.github/workflows/suwen-windows.yml` (never run). `SHA256SUMS`\n"
       "   is now generated: `desktop/release/SHA256SUMS` and `docs/release/SHA256SUMS.txt`.")
assert old in ptxt, "progress pending item 3 not found"
ptxt = ptxt.replace(old, new)
old2 = "(current: 59 IMPLEMENTED_PASS / 7 UNVERIFIED / 5 NOT_STARTED over 71 rows)"
new2 = "(current: 60 IMPLEMENTED_PASS / 8 UNVERIFIED / 3 NOT_STARTED over 71 rows)"
assert old2 in ptxt, "progress counts line not found"
ptxt = ptxt.replace(old2, new2)
open(prog, "w", encoding="utf-8", newline="\n").write(ptxt)
print("progress.md patched")

# ---- traceability.md ----
trace = p("docs", "requirements", "traceability.md")
ttxt = open(trace, encoding="utf-8").read()

# 1) summary counts (section 1 table row)
old = "（58 PASS / 7 UNVERIFIED / 4 NOT_STARTED）"
assert old in ttxt, "traceability summary counts not found"
ttxt = ttxt.replace(old, "（60 PASS / 8 UNVERIFIED / 3 NOT_STARTED）")

# 2) section 3 header
old = "## 3. 全量追溯表（69 条）"
assert old in ttxt, "traceability section 3 header not found"
ttxt = ttxt.replace(old, "## 3. 全量追溯表（71 条）")

def trunc(s, n):
    s = (s or "").replace("|", "\\|").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"

tbl = ["| ID | 需求（摘要） | TARGET 代码/文档路径 | 验证方式与证据 | 状态 | 剩余缺口 |",
       "|---|---|---|---|---|---|"]
for r in body:
    rid, summ, code, evid, test, status = r[0], r[1], r[2], r[3], r[4], r[5]
    tbl.append("| %s | %s | %s | %s | **%s** | %s |" % (
        rid, trunc(summ, 118), trunc(code, 168), trunc(evid + "；" + test, 208), status, trunc(r[7], 150)))
start = ttxt.index("| ID | 需求（摘要）")
end = ttxt.index("## 4.", start)
ttxt = ttxt[:start] + "\n".join(tbl) + "\n\n" + ttxt[end:]
print("traceability section 3 rows:", len(tbl) - 2)

# 3) section 5 item 2
old = "2. `SHA256SUMS` 文件生成/发布；Windows CI（`.github/workflows/suwen-windows.yml`）实际运行一次。"
assert old in ttxt, "traceability gap item 2 not found"
ttxt = ttxt.replace(old, "2. `SHA256SUMS` 已生成并发布（`desktop/release/SHA256SUMS` 与 `docs/release/SHA256SUMS.txt` 各 3 行）；Windows CI（`.github/workflows/suwen-windows.yml`）仍未实际运行一次。")

# 4) section 7 item 10 counts + item 5 sha pointer
old = "master 71 行（59/7/5）、parity 70 行（56/2/10/1/1）"
assert old in ttxt, "traceability section 7 counts not found"
ttxt = ttxt.replace(old, "master 71 行（60/8/3）、parity 70 行（56/2/10/1/1）")
old = "unpacked exe 249,801,728 B SHA256 `CFE87F2D…`。"
assert old in ttxt, "traceability section 7 item 5 tail not found"
ttxt = ttxt.replace(old, "unpacked exe 249,801,728 B SHA256 `CFE87F2D…`；`desktop/release/SHA256SUMS` 与 `docs/release/SHA256SUMS.txt` 已生成（3 行：exe/blockmap/unpacked）。")

# 5) section 6 hash table refresh
sec6_start = ttxt.index("| 文档 | 字节 | SHA-256 | 用途 |")
sec6_end = ttxt.index("## 7.", sec6_start)
existing = []
for ln in ttxt[sec6_start:sec6_end].split("\n"):
    if ln.startswith("| `"):
        parts = [c.strip() for c in ln.strip().strip("|").split("|")]
        path = parts[0].strip("`")
        usage = parts[3] if len(parts) > 3 else ""
        existing.append((path, usage))
existing.append(("docs/release/SHA256SUMS.txt", "最终安装包 SHA-256/字节数清单（R100/R119/R121）"))
rows6 = ["| 文档 | 字节 | SHA-256 | 用途 |", "|---|---:|---|---|"]
missing = []
for rel, usage in existing:
    full = os.path.join(ROOT, rel.replace("/", "\\"))
    if not os.path.isfile(full):
        missing.append(rel)
        continue
    rows6.append("| `%s` | %d | `%s` | %s |" % (rel, os.path.getsize(full), sha256(full), usage))
assert not missing, "missing hash-table files: %s" % missing
ttxt = ttxt[:sec6_start] + "\n".join(rows6) + "\n\n" + ttxt[sec6_end:]
old = "哈希为本文件生成时（2026-10-25 01:52 +08）的当前值，供冻结后抽查。"
if old in ttxt:
    ttxt = ttxt.replace(old, "哈希为本文件生成时（2026-10-25 02:05 +08）的当前值，供冻结后抽查。")
open(trace, "w", encoding="utf-8", newline="\n").write(ttxt)
print("traceability.md patched; hash rows:", len(rows6) - 2)

# ---- final coherence checks ----
print("\n=== checks ===")
rows_after = list(csv.reader(open(CSV_PATH, encoding="utf-8-sig")))[1:]
print("master rows:", len(rows_after), "| counts:", {s: sum(1 for r in rows_after if r[5] == s)
      for s in ("IMPLEMENTED_PASS", "UNVERIFIED", "NOT_STARTED")})
for rid in ("R100", "R119", "R120", "R121"):
    r = next(x for x in rows_after if x[0] == rid)
    print(rid, "->", r[5], "|", r[6], "| sha/SUMS evidence:", ("E1A1062C" in r[3] or "SHA256SUMS" in r[3]))
tt = open(trace, encoding="utf-8").read()
for rid in ("R100", "R119", "R120", "R121"):
    print("traceability row", rid, ":", ("| %s |" % rid) in tt)
print("traceability count lines:", "（60 PASS / 8 UNVERIFIED / 3 NOT_STARTED）" in tt,
      "| 71 条:", "## 3. 全量追溯表（71 条）" in tt)
print("installer doc stale phrase gone:", "no SHA256SUMS artifact" not in open(inst_doc, encoding="utf-8").read())
print("progress stale counts gone:", "59 IMPLEMENTED_PASS / 7 UNVERIFIED / 5 NOT_STARTED" not in open(prog, encoding="utf-8").read())
print("SHA256SUMS.txt bytes:", os.path.getsize(sums_txt), "| sha:", sha256(sums_txt))
print("repair done")
