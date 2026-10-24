# -*- coding: utf-8 -*-
"""Patch 6: fold Lead's final T2 correction (duplicate P1 resolved, error surface fixed pending visual)."""
import csv, io, os

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)

def rd(p): return io.open(p, encoding="utf-8").read()
def wr(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("wrote", p, len(s))

REPORT = "desktop/release/smoke/ui-streaming-20261024-192807-final.json"

# ---- master R130 -> PASS ----
p = "docs/requirements/master-requirements.csv"
rows = list(csv.DictReader(io.open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
for r in rows:
    if r["Requirement ID"] == "R130":
        r["Status"] = "IMPLEMENTED_PASS"
        r["Evidence"] = (
            "T2 final: auto-reconnect after daemon SIGKILL PASS 3/3 runs (offline surfaced 72-520 ms, "
            "auto-restored 702-779 ms, 0 page reloads; real #reconnect 49-57 ms); interrupted task -> "
            "waiting_approval reconciliation, retry recovered exact text; cancel: e2e-rpc 42/0 + chaos "
            "12/12; duplicate-assistant P1 fixed (conversations.ts merge by taskId+role) + "
            "conversations.test.ts 4 tests; Lead re-run persist case: assistants=1 taskAssistants=1, "
            "0 findings (" + REPORT + ")."
        )
        r["Test ID"] = "streaming-ui-e2e.mjs (T2, live host); conversations.test.ts (4); e2e-rpc.mjs --live; chaos-smoke.mjs"
        r["Blocker"] = ("T2 final report exists; T2 is re-running persist+kill + error-state verification "
                        "and updating its docs; all fixture results deterministic local OpenAI-SSE (no vendor APIs).")
with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n"); w.writeheader(); w.writerows(rows)
from collections import Counter
mc = Counter(r["Status"] for r in rows)
print("master:", len(rows), dict(mc))

# ---- parity cancel/reconnect row -> PASS ----
p = "docs/migration/feature-parity-matrix.csv"
rows = list(csv.DictReader(io.open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
n = 0
for r in rows:
    if r["capability"] == "Cancel/timeout/reconnect real E2E":
        r["vnext_status"] = "IMPLEMENTED_PASS"
        r["test_id"] = "streaming-ui-e2e.mjs T2 final (auto-reconnect 3/3); e2e-rpc 42/0; chaos 12/12"
        r["gaps"] = "T2 final report present; T2 re-running persist+kill + error-state verification; fixture-only provider"
        n += 1
with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n"); w.writeheader(); w.writerows(rows)
pc = Counter(r["vnext_status"] for r in rows)
print("parity:", len(rows), dict(pc), "rows updated", n)

# ---- defect register D-017 / D-020 ----
p = "docs/verification/defect-register.csv"
rows = list(csv.DictReader(io.open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
for r in rows:
    if r["Bug ID"] == "D-017":
        r["Severity"] = "P1"
        r["Reproduction"] = ("T2 post-fix SIGKILL/recovery: duplicate persisted assistant messages after "
                             "reconnect (daemon id a-<operationId> vs renderer uid())")
        r["Expected"] = "Exactly one persisted assistant turn per task after recovery"
        r["Actual"] = ("Pre-fix duplicated; post-fix Lead re-run of the T2 persist case: "
                       "persistence assistants=1 taskAssistants=1, 0 findings")
        r["Root Cause"] = "Two different message ids written by the daemon and renderer recovery paths"
        r["Fix Commit"] = ("worktree: desktop/src/conversations.ts merges assistant turns by "
                           "(taskId, role='assistant') in addition to message-id idempotency")
        r["Regression Test"] = "desktop/test/conversations.test.ts (4 tests)"
        r["Evidence"] = ("node scripts/streaming-ui-e2e.mjs --mode=final --only=persist --runs=1 -> "
                         "assistants=1 taskAssistants=1, 0 findings; report " + REPORT +
                         "; auto-reconnect PASS 3/3 runs, offline 72-520 ms, restored 702-779 ms, 0 reloads")
        r["Status"] = "RESOLVED"
    if r["Bug ID"] == "D-020":
        r["Reproduction"] = ("Provider HTTP 500 task ends failed; pre-fix chat-error state showed no visible "
                             "error surface in the chat workspace")
        r["Expected"] = "Failed turn visible (inline notice/error banner)"
        r["Actual"] = ("Fixed after the T2 report: desktop/ui/app.js shows #chat-notice with localized "
                       "chatTaskFailed for the failed step, cleared on next send")
        r["Root Cause"] = "UI/T1 error-surface product decision"
        r["Fix Commit"] = "worktree: desktop/ui/app.js failed-turn #chat-notice surface"
        r["Regression Test"] = "node --check desktop/ui/app.js; node scripts/ui-dom-qa.mjs (19/0/12)"
        r["Evidence"] = ("Lead fix after T2 visual audit; static QA passes; T2 visual confirmation pending "
                         "(screenshots/round3/chat-error_light_zh_1920x1080_dsf1x.png was the pre-fix finding)")
        r["Status"] = "FIXED_PENDING_VISUAL_CONFIRMATION"
with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n"); w.writeheader(); w.writerows(rows)
print("defects rows:", len(rows))

# ---- counts: master 80->81 / unv 13->12 ; parity 66->67 / unv 7->6 ----
def count_patch(path):
    t = rd(path)
    orig = t
    t = t.replace("80 IMPLEMENTED_PASS / 13 UNVERIFIED", "81 IMPLEMENTED_PASS / 12 UNVERIFIED")
    t = t.replace("80 IMPLEMENTED_PASS / 13 UNVERIFIED / 4 NOT_STARTED", "81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED")
    t = t.replace("IMPLEMENTED_PASS 66 / UNVERIFIED 7", "IMPLEMENTED_PASS 67 / UNVERIFIED 6")
    t = t.replace("(66/7/9/1/1/1)", "(67/6/9/1/1/1)")
    t = t.replace("| IMPLEMENTED_PASS | 66 | 78% |", "| IMPLEMENTED_PASS | 67 | 79% |")
    t = t.replace("| UNVERIFIED | 7 | 8% |", "| UNVERIFIED | 6 | 7% |")
    if t != orig:
        wr(path, t)
for p in ["docs/release/release-gates.md", "docs/release/final-acceptance-report.md",
          "docs/progress.md", "docs/requirements/traceability.md",
          "docs/migration/feature-parity-matrix.md", "docs/requirements/conflicts.md"]:
    count_patch(p)

# ---- release-gates G3 + summary rows ----
p = "docs/release/release-gates.md"
t = rd(p)
t = t.replace("**PASS_WITH_LIMITS** | `docs/verification/ui-e2e.md` + `artifacts/ui-e2e-summary.json`",
              "**PASS_WITH_LIMITS** | `docs/verification/ui-e2e.md` + `artifacts/ui-e2e-summary.json`; T2 final re-runs: auto-reconnect after daemon SIGKILL **PASS 3/3** (offline 72-520 ms, restored 702-779 ms, 0 reloads), duplicate-assistant P1 **RESOLVED** (conversations.ts taskId+role merge, conversations.test.ts 4 tests, Lead persist re-run 0 findings), failed-turn error surface fixed pending T2 visual confirmation")
t = t.replace("PASS_WITH_LIMITS:** G3 (T2 post-fix SIGKILL/reconnect re-run pending), G6",
              "PASS_WITH_LIMITS:** G3 (pre-T1 poll-only baseline not run; fixture-only provider; T2 error-state visual check pending), G6")
t = t.replace("T2 post-fix SIGKILL/reconnect re-run not published; v",
              "T2 final re-runs: auto-reconnect PASS, duplicate P1 resolved, error-state visual check pending; v")
wr(p, t)

# ---- final acceptance ----
p = "docs/release/final-acceptance-report.md"
t = rd(p)
t = t.replace("duplicate persisted assistant messages after recovery (P1, ui-e2e.md)",
              "duplicate persisted assistant messages after recovery — **RESOLVED** after Lead fix: conversations.ts merges assistant turns by (taskId, role='assistant'); conversations.test.ts 4 tests; Lead re-run `streaming-ui-e2e.mjs --mode=final --only=persist` -> assistants=1 taskAssistants=1, 0 findings (" + REPORT + ")")
if "T2 final re-run" not in t:
    t += """

## Final T2 correction (2026-10-25, Lead-measured, applied after the initial final report)

- **P1 duplicate persisted assistant messages — RESOLVED.** Root cause: daemon id `a-<operationId>` vs
  renderer `uid()` from `maybeAppendAssistant`. Fix: `desktop/src/conversations.ts` merges assistant
  turns by `(taskId, role='assistant')` in addition to message-id idempotency; regression test
  `desktop/test/conversations.test.ts` (4 tests). Lead re-ran the T2 harness
  `node scripts/streaming-ui-e2e.mjs --mode=final --only=persist --runs=1`: `assistants=1
  taskAssistants=1`, 0 findings (report `%s`). T2 is re-running persist+kill and error-state checks.
- **Auto-reconnect after daemon SIGKILL — PASS 3/3 runs:** offline surfaced 72-520 ms, auto-restored
  702-779 ms without page reload, settings `#reconnect` 49-57 ms, 0 reloads; interrupted task lands in
  the designed `waiting_approval` reconciliation and retry recovered the exact text.
- **P2 failed-turn error surface — fixed pending visual confirmation:** `desktop/ui/app.js` shows
  `#chat-notice` with localized `chatTaskFailed` and clears it on next send; `node --check` exit 0 and
  DOM QA 19/0/12 pass; T2 is verifying visually.
- Render/visual facts: composer bbox max deviation 0 px; 100/1,000/10,000-delta text integrity via
  exact DOM sha256 (lag P50 32-43 ms, P95 54-89 ms; 10k wall 152 s arrival-bound); scroll 10k PASS
  (followGap 0); 120-message conversation opens in 249 ms; layouts 6/6 PASS; dark theme implemented;
  180 PNGs visual audit, 0 layout findings, 0 page/console errors; pre-T1 poll-only baseline NOT_RUN
  (only a 217-char probe); all fixture results deterministic local OpenAI-SSE, no vendor APIs.
""" % REPORT
wr(p, t)

# ---- progress final T2 correction ----
p = "docs/progress.md"
t = rd(p)
if "Final T2 correction" not in t:
    t += """

### Final T2 correction (Lead-measured, 2026-10-25)

- Duplicate persisted assistant messages (P1) — **RESOLVED**: `desktop/src/conversations.ts` merges
  assistant turns by `(taskId, role='assistant')`; regression `desktop/test/conversations.test.ts`
  (4 tests); Lead re-ran the T2 persist case -> `assistants=1 taskAssistants=1`, 0 findings
  (`desktop/release/smoke/ui-streaming-20261024-192807-final.json`). R130 (cancel/timeout/reconnect)
  is now IMPLEMENTED_PASS on this evidence.
- Auto-reconnect after daemon SIGKILL PASS 3/3 (offline 72-520 ms, restored 702-779 ms, 0 reloads).
- P2 failed-turn chat error surface fixed in `desktop/ui/app.js` (`#chat-notice` + localized
  `chatTaskFailed`); static QA passes; T2 visual confirmation pending (D-020).
- Master counts now **81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL**
  (98 rows); parity 85 rows = **67 PASS / 6 UNVERIFIED / 9 NOT_STARTED / 1 N/A_PORT / 1 REPLACED /
  1 BLOCKED_EXTERNAL**.
"""
    wr(p, t)

# ---- ui-e2e / ui-streaming docs: supersession note ----
for p, marker, note in [
    ("docs/verification/ui-e2e.md", "## Superseded interim failures (post-fix evidence)",
     "The reconnect/duplicate FAIL results in this interim report are superseded by the Lead's post-fix "
     "T2 re-runs: auto-reconnect PASS 3/3 (offline 72-520 ms, restored 702-779 ms, 0 reloads) and "
     "duplicate persisted assistant messages RESOLVED (conversations.ts taskId+role merge; "
     "conversations.test.ts 4 tests; Lead persist re-run assistants=1 taskAssistants=1, 0 findings; "
     "report `" + REPORT + "`). T2 is re-running persist+kill and error-state verification."),
    ("docs/verification/ui-streaming-stability.md", "## Post-fix T2 re-runs (supersede interim failures)",
     "Interim reconnect/duplicate failures are superseded: auto-reconnect after daemon SIGKILL PASS 3/3; "
     "duplicate assistant persistence RESOLVED (taskId+role merge + 4 regression tests; Lead persist "
     "re-run 0 findings, `" + REPORT + "`); failed-turn error surface fixed pending T2 visual confirmation."),
]:
    t = rd(p)
    if note not in t:
        t += "\n\n" + marker + "\n\n" + note + "\n"
        wr(p, t)

# ---- verify script expectations ----
p = "docs/research/repro/round3/verify-final-320.py"
t = rd(p)
t = t.replace('mc.get("IMPLEMENTED_PASS") == 80', 'mc.get("IMPLEMENTED_PASS") == 81')
t = t.replace('mc.get("UNVERIFIED") == 13', 'mc.get("UNVERIFIED") == 12')
t = t.replace('mb["R130"]["Status"] == "UNVERIFIED"', 'mb["R130"]["Status"] == "IMPLEMENTED_PASS"')
t = t.replace('pc.get("IMPLEMENTED_PASS") == 66', 'pc.get("IMPLEMENTED_PASS") == 67')
t = t.replace('pc.get("UNVERIFIED") == 7', 'pc.get("UNVERIFIED") == 6')
t = t.replace('check("80 IMPLEMENTED_PASS" in prog', 'check("81 IMPLEMENTED_PASS" in prog')
t = t.replace('"R130 must stay UNVERIFIED"', '"R130 should now be PASS (T2 final re-run)"')
t = t.replace('PASS: master 98 rows (80/13/4/1), parity 85 (66/7/9/1/1/1)',
              'PASS: master 98 rows (81/12/4/1), parity 85 (67/6/9/1/1/1)')
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("verify script updated")
print("patch6 done")
