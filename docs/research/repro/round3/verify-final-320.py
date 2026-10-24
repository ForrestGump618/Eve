# -*- coding: utf-8 -*-
"""Patch release-notes header/status and verify final round-3 docs coherence."""
import csv, glob, hashlib, os, re, sys

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)

INST_SHA = "7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546"
BLK_SHA = "BCD62E14C146F7B9E03E35A373FA7804DAD2AA38C8E5706C63EF0C108CDD1AC2"
UNP_SHA = "8F7EAF76FEB66A61E51D5F8B9B67EEFA375FEDD0018A5566D64C27F0570A22E1"

# ---- release notes header/status patch ----
p = "docs/release/release-notes-v3.2.0.md"
t = open(p, encoding="utf-8").read()
t = t.replace(
    "# SuWen Desktop v3.2.0 — release notes (DRAFT, release candidate)",
    "# SuWen Desktop v3.2.0 — release notes (final evidence round; NOT published)")
old_status = re.search(r"\*\*Status: release candidate — NOT published\..*?measured results\.\n", t, re.S)
new_status = (
    "**Status: final 3.2.0 build measured — NOT published.** The final installer is\n"
    "`desktop/release/SuWen-Setup-3.2.0-win-x64.exe` (**129,446,526 B**, SHA256\n"
    "`7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546`, **UNSIGNED**); all measured\n"
    "numbers are in the \"Final release evidence\" section at the end of this file. Clean-Windows-VM\n"
    "lifecycle, code signing, endurance (8/24/72 h, reboot, power-loss) and GitHub publication are\n"
    "**NOT done** — see `docs/release/final-acceptance-report.md` and `docs/release/release-gates.md`.\n")
if old_status:
    t = t.replace(old_status.group(0), new_status)
else:
    print("WARN release-notes status paragraph not matched")
t = t.replace("installer numbers below are `PENDING_LEAD`", "installer numbers below are measured (see final section)")
t = t.replace("installer rebuild still PENDING_LEAD", "installer rebuild measured (see final section)")
# any remaining standalone PENDING_LEAD placeholders in this notes file are superseded
t = t.replace("PENDING_LEAD", "not verified (see final-acceptance-report)")
open(p, "w", encoding="utf-8", newline="\n").write(t)
print("release notes patched")

# ---- verification checks ----
errors = []
def check(cond, msg):
    if not cond:
        errors.append(msg)

master = list(csv.DictReader(open("docs/requirements/master-requirements.csv", encoding="utf-8-sig", newline="")))
from collections import Counter
mc = Counter(r["Status"] for r in master)
check(len(master) == 98, "master rows=%d" % len(master))
check(mc.get("IMPLEMENTED_PASS") == 81, "master PASS=%s" % mc.get("IMPLEMENTED_PASS"))
check(mc.get("UNVERIFIED") == 12 and mc.get("NOT_STARTED") == 4 and mc.get("BLOCKED_EXTERNAL") == 1,
      "master other statuses=%s" % dict(mc))
mb = {r["Requirement ID"]: r for r in master}
check(mb["R119"]["Status"] == "UNVERIFIED", "R119 not UNVERIFIED")
check(mb["R121"]["Status"] == "IMPLEMENTED_PASS", "R121 not PASS")
check(mb["R138"]["Status"] == "BLOCKED_EXTERNAL", "R138 not BLOCKED")
check(INST_SHA in mb["R100"]["Evidence"] and "129,446,526" in mb["R100"]["Evidence"], "R100 evidence missing final installer")
check(mb["R136"]["Status"] == "IMPLEMENTED_PASS", "R136 should be PASS after ui-visual-audit")
check(mb["R130"]["Status"] == "IMPLEMENTED_PASS", "R130 should now be PASS (T2 final re-run)")
check(mb["R139"]["Status"] == "IMPLEMENTED_PASS", "R139 not PASS")

parity = list(csv.DictReader(open("docs/migration/feature-parity-matrix.csv", encoding="utf-8-sig", newline="")))
pc = Counter(r["vnext_status"] for r in parity)
check(len(parity) == 85, "parity rows=%d" % len(parity))
check(pc.get("IMPLEMENTED_PASS") == 67, "parity PASS=%s" % pc.get("IMPLEMENTED_PASS"))
check(pc.get("UNVERIFIED") == 6 and pc.get("NOT_STARTED") == 9 and pc.get("BLOCKED_EXTERNAL") == 1,
      "parity other statuses=%s" % dict(pc))

ui = list(csv.DictReader(open("docs/verification/ui-action-coverage.csv", encoding="utf-8-sig", newline="")))
uc = Counter(r["wired_status"] for r in ui)
check(len(ui) == 144, "ui coverage rows=%d" % len(ui))
check(uc.get("UNKNOWN_METHOD", 0) == 0, "ui unknown methods=%s" % uc.get("UNKNOWN_METHOD"))
check(sum(uc.values()) == 144, "ui status sum=%d" % sum(uc.values()))

defects = list(csv.DictReader(open("docs/verification/defect-register.csv", encoding="utf-8-sig", newline="")))
check(len(defects) == 20, "defects rows=%d" % len(defects))

# required deliverables present
need = [
    "docs/release/release-gates.md", "docs/release/final-acceptance-report.md",
    "docs/release/CHANGELOG.md", "docs/release/release-notes-v3.2.0.md",
    "docs/release/github-publication.md", "docs/release/windows-installer-verification.md",
    "docs/release/SHA256SUMS.txt", "docs/verification/security-review.md",
    "docs/verification/performance-baseline.md", "docs/verification/defect-register.csv",
    "docs/verification/ui-action-coverage.csv", "docs/verification/ui-e2e.md",
    "docs/verification/e2e-results.md", "docs/verification/ui-streaming-stability.md",
]
for n in need:
    check(os.path.exists(n), "missing " + n)

# docs we rewrote must carry correct 3.2.0 values and no unsuperseded pre-final hashes
fresh = ["docs/release/release-gates.md", "docs/release/final-acceptance-report.md",
         "docs/release/windows-installer-verification.md", "docs/release/release-notes-v3.2.0.md",
         "docs/progress.md", "desktop/README.md", "desktop/acceptance-matrix.md"]
for f in fresh:
    t = open(f, encoding="utf-8-sig").read()
    check(INST_SHA in t, f + ": missing final installer hash")
    check("3.2.0" in t, f + ": missing 3.2.0")
    for bad in ("129,425,145", "E1A1062C"):
        if bad in t:
            check("superseded" in t.lower() or "historical" in t.lower(), f + ": pre-final value " + bad + " without supersession label")
    check("82779B90" not in t, f + ": leak of pre-final 3.1.0 hash")
# checksums mirror
sums = open("docs/release/SHA256SUMS.txt", encoding="utf-8").read()
for s in (INST_SHA, UNP_SHA, BLK_SHA):
    check(s in sums, "SHA256SUMS.txt missing " + s)
# installer bytes/hash on disk
exe = "desktop/release/SuWen-Setup-3.2.0-win-x64.exe"
check(os.path.getsize(exe) == 129446526, "installer bytes mismatch")
h = hashlib.sha256(open(exe, "rb").read()).hexdigest().upper()
check(h == INST_SHA, "installer hash mismatch %s" % h)
blk = "desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap"
check(os.path.getsize(blk) == 135974, "blockmap bytes mismatch")
check(hashlib.sha256(open(blk, "rb").read()).hexdigest().upper() == BLK_SHA, "blockmap hash mismatch")
check(hashlib.sha256(open("desktop/release/win-unpacked/SuWen.exe", "rb").read()).hexdigest().upper() == UNP_SHA,
      "unpacked exe hash mismatch")

# artifacts
import json
life = json.load(open("docs/verification/artifacts/installer-lifecycle.json", encoding="utf-8"))
check(life.get("installerSha256", "").upper() == INST_SHA, "lifecycle installerSha256 mismatch")
check(life.get("installerBytes") == 129446526, "lifecycle installerBytes mismatch")
check(life.get("ok") is True and life.get("passed") == 12 and life.get("failed") == 0, "lifecycle summary mismatch")
chaos = json.load(open("docs/verification/chaos-results.json", encoding="utf-8"))
check(chaos.get("result") == "passed" and len(chaos.get("scenarios", [])) == 12, "chaos summary mismatch")
check(chaos.get("durationMs") == 51434, "chaos duration")
smoke = json.load(open("desktop/release/smoke/work/electron-e2e-result.json", encoding="utf-8"))
check(smoke.get("result") == "passed", "smoke result")

# progress final section present
prog = open("docs/progress.md", encoding="utf-8").read()
check("Round 3 final evidence (SuWen desktop 3.2.0" in prog, "progress final section missing")
check("81 IMPLEMENTED_PASS" in prog, "progress counts missing")
# parity md / traceability / conflicts appended
for f, marker in [("docs/migration/feature-parity-matrix.md", "## 9. Final round-3 evidence"),
                  ("docs/requirements/traceability.md", "## 9. Final round-3 update"),
                  ("docs/requirements/conflicts.md", "## C-17"),
                  ("docs/release/github-publication.md", "suwen-vnext-3.2.0")]:
    check(marker in open(f, encoding="utf-8").read(), f + ": missing marker " + marker)

if errors:
    print("FAIL (%d):" % len(errors))
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("PASS: master 98 rows (81/12/4/1), parity 85 (67/6/9/1/1/1), UI 144 (0 unknown), defects 20, deliverables present, hashes match artifacts")
print("UI statuses:", dict(uc))
