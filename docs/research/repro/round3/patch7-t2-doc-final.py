# -*- coding: utf-8 -*-
"""Patch 7: fold T2 final-correction facts into traceability/release notes/CHANGELOG and refresh hash snapshot."""
import csv, hashlib, io, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
REPORT = "desktop/release/smoke/ui-streaming-20261024-192807-final.json"

def rd(p): return io.open(p, encoding="utf-8").read()
def wr(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("wrote", p, len(s))

# traceability: R130 row text + replace hash snapshot
p = "docs/requirements/traceability.md"
t = rd(p)
t = t.replace("| R130 | Cancel/timeout/reconnect real E2E canceled/timed out/reconnect | UNVERIFIED |",
              "| R130 | Cancel/timeout/reconnect real E2E canceled/timed out/reconnect | IMPLEMENTED_PASS |")
t = t.replace("R127/R128/R130/R131 remain UNVERIFIED", "R127/R128/R131 remain UNVERIFIED (R130 is PASS after the T2 final re-run)")
idx = t.find("## 10. Final document hash snapshot")
files = [
    "docs/requirements/master-requirements.csv", "docs/requirements/traceability.md",
    "docs/requirements/conflicts.md", "docs/migration/feature-parity-matrix.csv",
    "docs/migration/feature-parity-matrix.md", "docs/verification/ui-action-coverage.csv",
    "docs/verification/integration-and-e2e.md", "docs/verification/durability-chaos-tests.md",
    "docs/verification/third-party-dependencies.md", "docs/verification/security-review.md",
    "docs/verification/performance-baseline.md", "docs/verification/defect-register.csv",
    "docs/verification/ui-streaming-stability.md", "docs/verification/ui-e2e.md",
    "docs/verification/ui-visual-audit.md", "docs/verification/e2e-results.md",
    "docs/release/release-gates.md", "docs/release/final-acceptance-report.md",
    "docs/release/CHANGELOG.md", "docs/release/release-notes-v3.2.0.md",
    "docs/release/windows-installer-verification.md", "docs/release/github-publication.md",
    "docs/release/SHA256SUMS.txt", "docs/progress.md", "desktop/README.md",
    "desktop/acceptance-matrix.md",
]
lines = ["## 10. Final document hash snapshot (2026-10-25, updated after the T2 final correction)", "",
         "| Path | Bytes | SHA-256 |", "| --- | ---: | --- |"]
for rel in files:
    if os.path.exists(rel):
        data = open(rel, "rb").read()
        lines.append("| `%s` | %d | `%s` |" % (rel, len(data), hashlib.sha256(data).hexdigest()))
new = "\n".join(lines) + "\n"
if idx == -1:
    t += "\n" + new
else:
    t = t[:idx] + new
wr(p, t)

# release notes: post-final T2 corrections paragraph
p = "docs/release/release-notes-v3.2.0.md"
t = rd(p)
marker = "## Post-final T2 corrections (2026-10-25)"
if marker not in t:
    t += "\n\n" + marker + """

Applied after the initial final evidence report (Lead-measured; T2 final report):

- **P1 duplicate persisted assistant messages after recovery — RESOLVED.** The daemon id
  `a-<operationId>` and the renderer recovery id could both persist an assistant turn;
  `desktop/src/conversations.ts` now merges assistant turns by `(taskId, role='assistant')` in
  addition to message-id idempotency (`desktop/test/conversations.test.ts`, 4 tests). Lead re-ran the
  T2 harness `node scripts/streaming-ui-e2e.mjs --mode=final --only=persist --runs=1` ->
  `assistants=1 taskAssistants=1`, 0 findings (`%s`).
- **Auto-reconnect after daemon SIGKILL — PASS 3/3 runs:** offline surfaced 72-520 ms, auto-restored
  702-779 ms without page reload, settings `#reconnect` 49-57 ms, 0 page reloads; interrupted tasks land
  in the designed `waiting_approval` reconciliation and retry recovered the exact text.
- **P2 failed-turn chat error surface — fixed pending T2 visual confirmation:** `desktop/ui/app.js`
  shows `#chat-notice` with localized `chatTaskFailed`, cleared on next send; `node --check` exit 0 and
  DOM QA 19/0/12 pass.
- Fixture-only provider (deterministic local OpenAI-SSE): no real vendor APIs are claimed.
""" % REPORT
wr(p, t)

# CHANGELOG: add post-final fixes under the final evidence section
p = "docs/release/CHANGELOG.md"
t = rd(p)
anchor = "### Fixed (verified in this build)"
addition = ("- Duplicate persisted assistant messages after recovery: daemon `a-<operationId>` and renderer "
            "`uid()` merged via `conversations.ts` `(taskId, role='assistant')`; `conversations.test.ts` 4 tests; "
            "Lead persist re-run `assistants=1 taskAssistants=1`, 0 findings (" + REPORT + ").\n"
            "- Failed-turn chat error surface: `#chat-notice` with localized `chatTaskFailed`, cleared on next send "
            "(static QA pass; T2 visual confirmation pending).\n"
            "- Auto-reconnect after daemon SIGKILL PASS 3/3 runs (offline 72-520 ms, restored 702-779 ms, 0 reloads).\n")
if "Duplicate persisted assistant messages after recovery: daemon" not in t and anchor in t:
    t = t.replace(anchor, anchor + "\n" + addition, 1)
wr(p, t)
print("patch7 done")
