# -*- coding: utf-8 -*-
"""Fold the Lead's final 3.1.0 numbers into the task-6 deliverables.

Final build (authoritative, from Lead message 2026-10-25):
  desktop/release/SuWen-Setup-3.1.0-win-x64.exe  129,425,145 B
  SHA-256 E1A1062CBACAF978F6B60F2A825D2E2E769C231048A65983113E8E434BA07AC4
  built 2026-10-24T17:41:52Z, UNSIGNED
  win-unpacked/SuWen.exe SHA-256 CFE87F2DE046E0AB8D58F4DDB4C9898407F67129EF353BDAFCEF35376A3BB397
The pre-final build (82779B90..., 129,424,645 B) must NOT appear as the delivered artifact.
"""
import csv
import os
import re

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
OLD_B = "129,424,645"
NEW_B = "129,425,145"
OLD_H = "82779b90c3a0a792c2b1879d4df184579697c6db698bb3bb1d153b671326b70f"
NEW_H = "e1a1062cbacaf978f6b60f2a825d2e2e769c231048a65983113e8e434ba07ac4"
OLD_HU = OLD_H.upper()
NEW_HU = NEW_H.upper()
OLD_SHORT = "82779b90\u202626b70f"
NEW_SHORT = "e1a1062c\u20267ac4"
OLD_BLOCKMAP = "fab134795f8c089dc1547f64599251d7ae2e0b477b416a6c87c9fc7238bf932c"

NARRATIVE = [
    r"docs/migration/feature-parity-matrix.md",
    r"docs/verification/integration-and-e2e.md",
    r"docs/progress.md",
    r"docs/release/windows-installer-verification.md",
    r"docs/requirements/conflicts.md",
    r"desktop/README.md",
    r"desktop/acceptance-matrix.md",
]

for rel in NARRATIVE:
    p = os.path.join(D, rel.replace("/", os.sep))
    t = open(p, encoding="utf-8").read()
    before = t
    t = t.replace(OLD_B, NEW_B).replace("129424645", NEW_B.replace(",", ""))
    t = t.replace(OLD_H, NEW_H).replace(OLD_HU, NEW_HU).replace(OLD_SHORT, NEW_SHORT)
    t = t.replace(OLD_BLOCKMAP, "PENDING_LEAD (re-hash after final rebuild)")
    if t != before:
        open(p, "w", encoding="utf-8", newline="").write(t)
        print("updated", rel, "chars", len(before), "->", len(t))

# ---------------------------------------------------------------- master CSV
p = os.path.join(D, r"docs\requirements\master-requirements.csv")
rows = list(csv.DictReader(open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
FINAL = "desktop/release/SuWen-Setup-3.1.0-win-x64.exe 129,425,145 B sha256 e1a1062cbacaf978f6b60f2a825d2e2e769c231048a65983113e8e434ba07ac4 (built 2026-10-24T17:41:52Z, UNSIGNED)"
UPD = {
    "R100": dict(
        vnext_evidence=FINAL + "; release/win-unpacked/SuWen.exe sha256 cfe87f2de046e0ab8d58f4ddb4c9898407f67129ef353bdacfef35376a3bb397; NSIS x64 per-user unsigned",
        test_or_log="installer bytes/hashes measured in TARGET; packaged smoke 8/8 on final build; docs/verification/artifacts/installer-lifecycle.json (final-artifact probe PENDING_LEAD); docs/release/windows-installer-verification.md",
        evidence_scope="TARGET_RUN",
        remaining_gap="SHA256SUMS artefact, final-artifact host lifecycle probe and cross-version upgrade 3.0.0-preview.1 -> 3.1.0 are PENDING_LEAD; clean-VM lifecycle and code signing pending",
    ),
    "R050": dict(
        test_or_log="docs/verification/chaos-results.json: 12/12 checks passed, 52.2 s, finished 2026-10-24T17:34:35.821Z (short-window fault injection only)",
        remaining_gap="8/24/72 h soak, reboot, sleep/hibernate, power-loss, disk-full NOT performed; provider faults injected by local HTTP fixture, not a real vendor account",
    ),
    "R116": dict(
        test_or_log="packaged smoke 8/8 (final build) incl 30 s timer after UI exit; chaos-results.json 12/12 (daemon+worker SIGKILL recovery, same operation id, no replay); e2e-rpc --live 42/0",
        remaining_gap="Windows reboot/logoff recovery not executed; no 8/24/72 h claim (short-session artifact only)",
    ),
    "R119": dict(
        test_or_log="final installer sha256 e1a1062c...; final-artifact host lifecycle probe + cross-version upgrade 3.0.0-preview.1 -> 3.1.0 PENDING_LEAD; no clean-VM run; no SHA256SUMS",
        evidence_scope="PENDING_LEAD",
        remaining_gap="clean Windows VM install/start/upgrade/uninstall NOT RUN; SHA256SUMS and code signing pending; host probe is not a clean machine",
    ),
    "R120": dict(
        test_or_log="all eight reports present and current to 3.1.0 (master CSV 71 rows/59 PASS, parity 70 rows/56 PASS, UI coverage 142 actions, integration/durability/installer/third-party/traceability), CI workflow authored never run",
        remaining_gap="host lifecycle/upgrade and clean-VM sections remain PENDING_LEAD; CI not executed; durability section short-window only",
    ),
    "R121": dict(
        test_or_log="installer final sha256 e1a1062c...; docs/progress.md, feature-parity-matrix.md, windows-installer-verification.md current; host lifecycle/upgrade PENDING_LEAD",
        evidence_scope="PENDING_LEAD",
        remaining_gap="clean-VM lifecycle, SHA256SUMS, code signing and real external-account rows NOT complete (PENDING_LEAD)",
    ),
}
for r in rows:
    if r["id"] in UPD:
        r.update(UPD[r["id"]])
w = csv.DictWriter(open(p, "w", encoding="utf-8-sig", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
from collections import Counter

print("master", len(rows), dict(Counter(r["status"] for r in rows)))

# ---------------------------------------------------------------- parity CSV
p = os.path.join(D, r"docs\migration\feature-parity-matrix.csv")
rows = list(csv.DictReader(open(p, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
for r in rows:
    cap = r["capability"]
    if cap.startswith("Windows NSIS installer"):
        r["vnext_code"] = (
            "desktop/package.json build block; release/SuWen-Setup-3.1.0-win-x64.exe 129,425,145 B "
            "sha256 e1a1062cbacaf978f6b60f2a825d2e2e769c231048a65983113e8e434ba07ac4 (built 17:41:52Z, UNSIGNED); "
            "win-unpacked/SuWen.exe sha256 cfe87f2d..."
        )
        r["gaps"] = (
            "SHA256SUMS not generated; final-artifact host lifecycle probe + cross-version upgrade PENDING_LEAD; "
            "clean-VM install/upgrade/uninstall and code signing pending"
        )
    elif cap == "Clean-VM install/upgrade/uninstall":
        r["gaps"] = (
            "final-artifact host lifecycle probe and cross-version upgrade 3.0.0-preview.1 -> 3.1.0 are PENDING_LEAD; "
            "requires clean Windows VM; pre-final host probe (14/14) is not a clean-machine result"
        )
    elif cap == "Windows app packaging metadata":
        r["gaps"] = "installer lifecycle/upgrade pending; SHA256SUMS and code signing pending"
w = csv.DictWriter(open(p, "w", encoding="utf-8-sig", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
print("parity", len(rows))

# ---------------------------------------------------------------- conflicts.md
p = os.path.join(D, r"docs\requirements\conflicts.md")
t = open(p, encoding="utf-8").read()


def replace_section(text, prefix, new_body):
    start = text.find("## " + prefix)
    if start < 0:
        raise SystemExit("section not found: " + prefix)
    nxt = text.find("\n## ", start + 3)
    end = len(text) if nxt < 0 else nxt + 1
    return text[:start] + new_body.rstrip() + "\n\n" + text[end:]


c08 = """## C-08 Encoding corruption in new `desktop/src/rpc/core.ts`

- Where: `desktop/src/rpc/core.ts` (created 2026-10-25 00:41) contained mojibake Chinese string
  literals (UTF-8 file holding GBK-decoded text), e.g. the conversation default title and doctor
  messages around lines 129 and 312-332. The exact corrupted glyphs are not reproduced here because
  copying them corrupts this document too.
- Conflict: product strings are user-visible and were corrupted.
- Resolution: flagged **FIX_REQUIRED - Lead**, not a brand exception and not edited by this audit
  (outside D write scope). Rows that depend on those strings stay `UNVERIFIED` until the literals are
  fixed and the module is re-tested. This is an encoding defect, not evidence of a broken feature."""
c04 = """## C-04 Desktop suite "48 passed" (progress.md) vs current TARGET sources

- Where: the old prototype log records 48 tests; the Lead re-ran the suite on TARGET 3.1.0:
  `npm test` 150 tests / 148 pass / 0 fail / 2 skipped, 28.3 s, exit 0 (skips: Windows symlink
  capability in a research-worker test; optional legacy Python deps). Packaged smoke 8/8 on the final
  build.
- Resolution: **superseded by TARGET evidence** - the 3.1.0 test log is the current suite result;
  the prototype log is no longer the only basis. Two skips remain explicit and are not counted as
  passes."""
c05 = """## C-05 Installer: prototype artifact vs TARGET final build

- Where: `docs/release-notes-vnext.md` and `build-environment.json` describe a prototype installer
  (129,363,809 B, sha256 `f263af7b...`); a mid-audit 3.1.0 build measured
  82779B90.../129,424,645 B; the Lead then rebuilt from frozen final code:
  **129,425,145 B, sha256 E1A1062CBACAF978F6B60F2A825D2E2E769C231048A65983113E8E434BA07AC4**
  (built 2026-10-24T17:41:52Z, UNSIGNED).
- Conflict: earlier hashes are not the delivered artifact and must not be presented as such.
- Resolution: `windows-installer-verification.md` and all CSVs now carry the final hash only;
  the pre-final hash is documented as superseded. R100 = PASS (artifact exists, hashes measured);
  R119 stays NOT_STARTED until the final-artifact host lifecycle probe and clean-VM
  install/upgrade/uninstall are supplied by the Lead; `SHA256SUMS` still absent."""
c06 = """## C-06 Durability claims vs executed tests

- Where: requirement R050 asks for 8/24/72 h + reboot/sleep/disk-full; the current TARGET chaos
  artifact (`docs/verification/chaos-results.json`, finished 2026-10-24T17:34:35.821Z) records
  **12/12 checks passed in 52.2 s**: python-worker SIGKILL retried (attempts 2, 15,173 ms, 1
  artifact); daemon SIGKILL mid-python restored (attempts 2, same operationId, 1 artifact, 26,508 ms);
  committed steps not replayed; cancel produced 0 artifacts; provider 429->500->200 with 3 requests,
  2 human approvals, completed.
- Conflict: short-window fixture-injected faults are not endurance evidence.
- Resolution: R050 stays `UNVERIFIED`/not passed; the artifact's own limits (single Windows session,
  short duration, no 8/24/72 h, no sleep/power-loss/reboot/disk-full, provider faults injected by a
  local HTTP fixture, not a real vendor account) are recorded verbatim in
  `durability-chaos-tests.md`. No endurance number is stated as passed anywhere."""
c08_old = t[t.find("## C-08"):t.find("## C-09")]
c13 = """## C-13 Chaos artifact was superseded mid-audit

- Where: an earlier `docs/verification/chaos-results.json` (10/11 scenarios recovered, 1 failed
  waiting_approval 429) was observed before this audit block; the current artifact
  (`finishedAt 2026-10-24T17:34:35.821Z`) records **12/12 checks passed in 52.2 s**
  (`result: passed`), including python-worker and daemon SIGKILL recovery, same operation id, no
  replay of committed steps, cancellation with 0 artifacts, and a 429->500->200 provider sequence
  with 2 human approvals.
- Risk: stale numbers in docs. Resolution: all docs updated to the current artifact; no
  endurance/long-run claim is made. Limits (single Windows session, short duration, no 8/24/72 h,
  no sleep/power-loss/reboot/disk-full, fixture-injected provider faults) are copied into
  `durability-chaos-tests.md`."""
c14 = """## C-14 Installer lifecycle: pre-final host probe vs final artifact

- Where: a host lifecycle probe against the **pre-final** build
  (`docs/verification/artifacts/installer-lifecycle.json`, `2026-10-24T17:40:28Z`,
  installer sha256 82779B90...) passed 14/14 steps, including an authenticated daemon attach after UI
  close. The Lead rebuilt the installer from frozen final code at `2026-10-24T17:41:52Z`
  (sha256 E1A1062C...) and the final-artifact lifecycle probe plus cross-version upgrade
  3.0.0-preview.1 -> 3.1.0 are being measured now (PENDING_LEAD). The environment caveat is
  documented: the developer shell inherits `ELECTRON_RUN_AS_NODE=1`, so tests remove it from the
  launching shell only; this is a test-environment caveat, not a product defect, and the shipped app
  is not modified.
- Conflict: R119 requires a clean Windows install/start/upgrade/uninstall pass; a host probe is not a
  clean environment and the final artifact has not yet been probed.
- Resolution: R119 stays **NOT_STARTED/PENDING_LEAD**; R100 = PASS for artifact presence/hash.
  Lead will write `docs/verification/artifacts/installer-lifecycle.json` (final) and
  `upgrade-path.json`; until then docs carry explicit placeholders and the pre-final probe is marked
  superseded."""

t = replace_section(t, "C-04", c04)
t = replace_section(t, "C-05", c05)
t = replace_section(t, "C-06", c06)
t = replace_section(t, "C-08", c08)
t = replace_section(t, "C-13", c13)
t = replace_section(t, "C-14", c14)
t = t.replace(
    "- **Action 4 (installer): partial.** Real installer + verified SHA-256 exist; host lifecycle probe\n"
    "  passed install/reinstall/uninstall but failed two app-attach steps; `SHA256SUMS` still absent and\n"
    "  clean-VM lifecycle + code signing remain pending (C-14 below).",
    "- **Action 4 (installer): artifact resolved, lifecycle PENDING_LEAD.** Final installer\n"
    "  (129,425,145 B, sha256 E1A1062C...) exists and was rebuilt from frozen final code at\n"
    "  `2026-10-24T17:41:52Z`; the final-artifact host lifecycle probe and cross-version upgrade are\n"
    "  running now (C-14). `SHA256SUMS`, clean-VM lifecycle and code signing remain pending.",
)
t += (
    "\n\n## 2026-10-25 final-build supersession (Lead-measured numbers)\n\n"
    "The Lead rebuilt the installer after the Python-artifact commit change and supplied the final\n"
    "numbers: `desktop/release/SuWen-Setup-3.1.0-win-x64.exe`, **129,425,145 bytes**, SHA-256\n"
    "`E1A1062CBACAF978F6B60F2A825D2E2E769C231048A65983113E8E434BA07AC4`, built\n"
    "`2026-10-24T17:41:52Z`, UNSIGNED; `release/win-unpacked/SuWen.exe` SHA-256\n"
    "`CFE87F2DE046E0AB8D58F4DDB4C9898407F67129EF353BDAFCEF35376A3BB397`. The earlier 3.1.0 build\n"
    "(`82779B90...`, 129,424,645 B) is **superseded and must not appear as the delivered artifact** in\n"
    "any report. Final `npm test`: 150 tests / 148 pass / 0 fail / 2 skipped / 28.3 s / exit 0;\n"
    "packaged smoke 8/8 on the final build; `e2e-rpc --live` 42/0 (real Europe PMC + UniProt calls).\n"
    "Still unverified and left explicit: final-artifact lifecycle probe and cross-version upgrade\n"
    "(PENDING_LEAD), `SHA256SUMS`, clean-VM lifecycle, code signing, 8/24/72 h endurance, real\n"
    "external model accounts, and the legacy Python workbench runtime on this machine (its optional\n"
    "Python env lacks fastapi).\n"
)
open(p, "w", encoding="utf-8", newline="").write(t)
print("conflicts updated", len(t))
