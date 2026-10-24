#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Second final pass: fix stale durations/counts and fold the T2 visual audit into
release/requirements docs (counts are recomputed from the CSVs, never asserted).

Also refreshes the traceability hash table for the files touched by this session.
"""
import csv
import hashlib
import io
import os
import re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)

MASTER = "docs/requirements/master-requirements.csv"
PARITY = "docs/migration/feature-parity-matrix.csv"
PARITY_MD = "docs/migration/feature-parity-matrix.md"
GATES = "docs/release/release-gates.md"
ACCEPT = "docs/release/final-acceptance-report.md"
DEFECT = "docs/verification/defect-register.csv"
UI = "docs/verification/ui-action-coverage.csv"
PROGRESS = "docs/progress.md"
TRACE = "docs/requirements/traceability.md"
INSTALLER = "docs/release/windows-installer-verification.md"
NOTES = "docs/release/release-notes-v3.2.0.md"
CHANGELOG = "docs/release/CHANGELOG.md"
INTEGRATION = "docs/verification/integration-and-e2e.md"
README = "desktop/README.md"
MATRIX = "desktop/acceptance-matrix.md"

DUR_TEST = "29.5 s"
DUR_SMOKE = "68 s"


def read(p):
    return io.open(p, encoding="utf-8").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def csvrows(p):
    with io.open(p, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        return list(r)


def counts(rows, key):
    c = {}
    for r in rows:
        c[r[key]] = c.get(r[key], 0) + 1
    return c


mc = counts(csvrows(MASTER), "Status")
pc = counts(csvrows(PARITY), "vnext_status")
mc_line = "%d IMPLEMENTED_PASS / %d UNVERIFIED / %d NOT_STARTED / %d BLOCKED_EXTERNAL" % (
    mc.get("IMPLEMENTED_PASS", 0), mc.get("UNVERIFIED", 0), mc.get("NOT_STARTED", 0), mc.get("BLOCKED_EXTERNAL", 0))
pc_line = "%d IMPLEMENTED_PASS / %d UNVERIFIED / %d NOT_STARTED / %d N/A_PORT / %d REPLACED / %d BLOCKED_EXTERNAL" % (
    pc.get("IMPLEMENTED_PASS", 0), pc.get("UNVERIFIED", 0), pc.get("NOT_STARTED", 0), pc.get("N/A_PORT", 0),
    pc.get("REPLACED", 0), pc.get("BLOCKED_EXTERNAL", 0))
print("counts:", mc_line, "|", pc_line)


def sub(p, pairs):
    s = read(p)
    o = s
    for a, b in pairs:
        s = s.replace(a, b)
    if s != o:
        write(p, s)
        print("patched", p)
    else:
        print("NO CHANGE", p)


# ---------------------------------------------------------------- gates
sub(GATES, [
    ("(98 rows — 79 IMPLEMENTED_PASS / 14 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL)",
     "(98 rows — %s)" % mc_line),
    ("`npm test`: **150 tests / 148 pass / 0 fail / 2 skipped**, 37.5 s",
     "`npm test`: **150 tests / 148 pass / 0 fail / 2 skipped**, %s" % DUR_TEST),
    ("8/8**, exit 0, 82 s on the final build", "8/8**, exit 0, %s on the final build" % DUR_SMOKE),
    ("`docs/verification/chaos-results.json`: **12/12 scenarios, 51.4 s**", "`docs/verification/chaos-results.json`: **12/12 scenarios, 51.4 s**"),
])

# ---------------------------------------------------------------- acceptance
sub(ACCEPT, [
    ("**85 rows**: **85 rows**:", "**85 rows**:"),
    ("   not published → R130 and R136 remain UNVERIFIED.", ""),
    ("Final test numbers: **150 tests / 148 pass / 0 fail / 2 skipped, 37.5 s, exit 0**",
     "Final test numbers: **150 tests / 148 pass / 0 fail / 2 skipped, %s, exit 0**" % DUR_TEST),
    ("RPC / smoke / UI: **42/0 ~7 s; 8/8 82 s; 19/0/12**",
     "RPC / smoke / UI: **42/0 ~7 s; 8/8 %s; 19/0/12**" % DUR_SMOKE),
    ("(visual acceptance matrix pending in T2; R136)", "(visual acceptance PASS from T2 ui-visual-audit; R136)"),
])

# ---------------------------------------------------------------- progress
sub(PROGRESS, [
    ("`npm test`: 150 tests / 148 pass / 0 fail / 2 skipped, 37.5 s, exit 0.",
     "`npm test`: 150 tests / 148 pass / 0 fail / 2 skipped, %s, exit 0." % DUR_TEST),
    ("8/8 checks, exit 0, 82 s", "8/8 checks, exit 0, %s" % DUR_SMOKE),
    ("workspaces; dark theme implemented. Interim report marked auto-reconnect + duplicate-append FAIL/OPEN;\n"
     "source fixes landed afterwards with `conversations.test.ts` but T2 post-fix re-run and\n"
     "`ui-visual-audit.md` were not published -> R130/R136 UNVERIFIED.",
     "workspaces; dark theme implemented. Interim report marked auto-reconnect + duplicate-append FAIL/OPEN;\n"
     "source fixes landed afterwards with `conversations.test.ts`. T2's `ui-visual-audit.md` was later published\n"
     "(layout/theme/locale matrix PASS, P2 chat-error finding) -> R136 IMPLEMENTED_PASS; the post-fix\n"
     "SIGKILL/reconnect in-UI re-run is still missing -> R130 stays UNVERIFIED."),
    ("2 skipped unit tests; T2 post-fix SIGKILL/reconnect re-run + visual acceptance matrix (R130/R136",
     "2 skipped unit tests; T2 post-fix SIGKILL/reconnect in-UI re-run (R130; R136 now PASS via ui-visual-audit)"),
])

# ---------------------------------------------------------------- release notes
sub(NOTES, [
    ("| Unit/integration tests | 150 tests / 148 pass / 0 fail / 2 skipped / 28.3 s (Lead) |",
     "| Unit/integration tests | 150 tests / 148 pass / 0 fail / 2 skipped / %s (Lead, final build) |" % DUR_TEST),
    ("| Packaged Electron smoke | 8/8 checks (3.1.0 final build; 3.2.0 rebuild pending) |",
     "| Packaged Electron smoke | 8/8 checks, exit 0, %s (final 3.2.0 build) |" % DUR_SMOKE),
    ("| UI DOM QA | 19 passed / 0 failed / 10 warnings (main-process bridge methods) |",
     "| UI DOM QA | 19 passed / 0 failed / 12 warnings (main-process bridge methods) |"),
    ("| Short-window chaos | 12/12 checks in 52.2 s |", "| Short-window chaos | 12/12 checks in 51.4 s |"),
    ("| Installer host lifecycle | host 14/14 + upgrade 8/8 (3.1.0 artefact) |",
     "| Installer host lifecycle | host 12/12 PASS on the final 3.2.0 artifact + upgrade source 3.0.0-preview.1 installed (clean VM NOT RUN) |"),
    ("| Full test suite | **150 tests / 148 pass / 0 fail / 2 skipped**, 37.5 s, exit 0",
     "| Full test suite | **150 tests / 148 pass / 0 fail / 2 skipped**, %s, exit 0" % DUR_TEST),
    ("| Packaged Electron smoke | **8/8 checks**, exit 0, 82 s on the final build |",
     "| Packaged Electron smoke | **8/8 checks**, exit 0, %s on the final build |" % DUR_SMOKE),
    ("| Path | measured (see Final release evidence) (`desktop/release/SuWen-Setup-3.2.0-win-x64.exe` when rebuilt) |",
     "| Path | `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` (built 2026-10-24T19:16:10Z) |"),
    ("| Version | 3.2.0 — confirmed in `desktop/package.json:3` and the package-lock root (bumped by the Lead); the rebuilt installer is still pending |",
     "| Version | 3.2.0 — confirmed in `desktop/package.json:3`, package-lock root and the built installer metadata |"),
    ("| Size / SHA256 | measured (see Final release evidence) |",
     "| Size / SHA256 | 129,446,526 B / `7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546` |"),
    ("| Checksums | regenerate `desktop/release/SHA256SUMS` and mirror in `docs/release/SHA256SUMS.txt` |",
     "| Checksums | `desktop/release/SHA256SUMS` mirrored in `docs/release/SHA256SUMS.txt` (3 lines, same values) |"),
])

# ---------------------------------------------------------------- installer doc sha suffix
sub(INSTALLER, [
    ("`installerSha256=7B0DDE7B…A07AC4`", "`installerSha256=7B0DDE7B…2199546`"),
])

# ---------------------------------------------------------------- traceability §7/§8 + counts
t = read(TRACE)
t = t.replace("The CSV is authoritative: **98 requirement rows — IMPLEMENTED_PASS 79 / UNVERIFIED 14 / NOT_STARTED 4 / BLOCKED_EXTERNAL 1**.",
              "The CSV is authoritative: **98 requirement rows — %s**." % mc_line)
t = t.replace("R141 R145 R148; R119 updated", "R141 R145 R148; R136 updated to IMPLEMENTED_PASS after T2's visual audit; R119 updated")
t = t.replace("R050 R102 R116 R119 R127 R128 R130 R131 R136 R137 (UNVERIFIED - endurance, reboot, legacy",
              "R050 R102 R116 R119 R127 R128 R130 R131 R137 (UNVERIFIED - endurance, reboot, legacy")
t = t.replace("boundary, visual audit).", "boundary; R136 visual acceptance is IMPLEMENTED_PASS per ui-visual-audit.md with the P2 chat-error finding D-020).")
t = t.replace("UNVERIFIED until T1/T2 runtime evidence lands; **R129–R131** streaming matrix rows stay unchanged.",
              "T1/T2 runtime evidence landed (see §9): R122–R126/R129/R132/R136 are IMPLEMENTED_PASS; R127/R128/R130/R131 remain UNVERIFIED.")
t = t.replace("G3 in `docs/release/release-gates.md` references the same facts and remains **UNVERIFIED**.",
              "G3 in `docs/release/release-gates.md` is now **PASS_WITH_LIMITS** (T2 suite + visual audit; post-fix SIGKILL/reconnect re-run still missing -> R130).")
t = t.replace("Package version confirmed as **3.2.0** (`desktop/package.json:3`, package-lock root); installer\nrebuild and SHA256 remain `PENDING_LEAD`.",
              "Package version confirmed as **3.2.0**; final installer built 2026-10-24T19:16:10Z — 129,446,526 B SHA256 `7B0DDE7B…2199546`, `SHA256SUMS` present.")
t = t.replace("1. **干净 Windows VM** install → start → upgrade → uninstall（R119/R121）。主机生命周期 14/14 与升级 8/8 已过，但不是干净机。",
              "1. **干净 Windows VM** install → start → upgrade → uninstall（R119/R121）。最终 3.2.0 主机生命周期 12/12 通过（升级源 3.0.0-preview.1 已安装），但不是干净机。")
write(TRACE, t)
print("patched", TRACE)

# ---------------------------------------------------------------- refresh hash table rows in traceability
hash_rows = {}
for m in re.finditer(r"\| `([^`]+)` \| (\d+) \| `([0-9A-F]{64})` \| ([^|]*)\|", read(TRACE)):
    hash_rows[m.group(1)] = (m.group(2), m.group(3), m.group(4))
targets = [MASTER, PARITY, PARITY_MD, GATES, ACCEPT, DEFECT, UI, PROGRESS, TRACE, INSTALLER, NOTES,
           "docs/verification/ui-visual-audit.md", "docs/verification/ui-e2e.md",
           "docs/verification/e2e-results.md", "docs/verification/ui-streaming-stability.md",
           "docs/verification/performance-baseline.md", "docs/verification/security-review.md",
           "docs/verification/chaos-results.json", "docs/release/SHA256SUMS.txt",
           "docs/requirements/conflicts.md", "docs/verification/integration-and-e2e.md",
           "desktop/README.md", "desktop/acceptance-matrix.md"]
t = read(TRACE)
changed = 0
for path in targets:
    if not os.path.exists(path):
        print("skip missing", path)
        continue
    size = os.path.getsize(path)
    hv = sha(path)
    pat = re.compile(r"\| `" + re.escape(path) + r"` \| \d+ \| `[0-9A-F]{64}` \|")
    if pat.search(t):
        t2 = pat.sub("| `%s` | %d | `%s` |" % (path, size, hv), t)
        if t2 != t:
            changed += 1
        t = t2
    else:
        # append into the hash-table section (after the last existing hash row)
        print("hash row absent:", path)
write(TRACE, t)
print("hash rows refreshed:", changed)

# ---------------------------------------------------------------- integration / readme / matrix durations
for p in (INTEGRATION, README, MATRIX, CHANGELOG):
    if not os.path.exists(p):
        continue
    s = read(p)
    o = s
    s = s.replace("37.5 s", DUR_TEST).replace("82 s", DUR_SMOKE).replace("28.3 s", DUR_TEST).replace("106 s", DUR_SMOKE)
    s = s.replace("10 warnings", "12 warnings").replace("19/0/10", "19/0/12")
    if s != o:
        write(p, s)
        print("duration patched", p)

print("DONE2")
