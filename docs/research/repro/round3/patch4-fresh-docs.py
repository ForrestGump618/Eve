# -*- coding: utf-8 -*-
"""Patch 4: make fresh docs carry the exact final 3.2.0 hash and markers; finish stale parity-lifecycle text."""
import io, os, re

ROOT = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
os.chdir(ROOT)
INST = "7B0DDE7B9E12E403E620E16651D969CD21C874CF16598D409D6A7B2FA2199546"

def rd(p): return io.open(p, encoding="utf-8").read()
def wr(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("wrote", p, len(s))

# 1) installer doc: uppercase final hash, drop pre-final hash mention
p = "docs/release/windows-installer-verification.md"
t = rd(p)
t = t.replace("7b0dde7b9e12e403e620e16651d969cd21c874cf16598d409d6a7b2fa2199546", INST)
t = t.replace("(`SuWen-Setup-3.1.0-win-x64.exe`, 129,425,145 B, SHA256 `E1A1062C…`, and the earlier\n> `82779B90…` pre-final hash). Those values are historical only.",
              "(`SuWen-Setup-3.1.0-win-x64.exe`, 129,425,145 B, SHA256 `E1A1062C…` for the earlier 3.1.0 build). Those values are historical and superseded.")
t = t.replace("`82779B90…`", "the pre-final 3.1.0 build")
wr(p, t)

# 2) parity md: marker + stale release/lifecycle paragraph + clean-VM row
p = "docs/migration/feature-parity-matrix.md"
t = rd(p)
t = t.replace("## 9. Round-3 additions and final 3.2.0 evidence (2026-10-25)",
              "## 9. Final round-3 evidence (3.2.0 build, 2026-10-25)")
t = t.replace("`release/SuWen-Setup-3.1.0-win-x64.exe`, 129,425,145 bytes, SHA-256\n  `e1a1062cbacaf978f6b60f2a825d2e2e769c231048a65983113e8e434ba07ac4`, UNSIGNED",
              "`release/SuWen-Setup-3.2.0-win-x64.exe`, 129,446,526 bytes, SHA-256\n  `7b0dde7b9e12e403e620e16651d969cd21c874cf16598d409d6a7b2fa2199546`, UNSIGNED")
t = t.replace("**final-artifact host lifecycle probe 14/14 steps passed**\n  (`docs/verification/artifacts/installer-lifecycle.json`: install 18 s, exe version 3.1.0, running",
              "**final-artifact host lifecycle probe 12/12 steps passed**\n  (`docs/verification/artifacts/installer-lifecycle.json`: install ~24 s, exe version 3.2.0, running")
t = t.replace("SHA256SUMS` , clean-VM lifecycle and code signing remain pending.", "clean-VM lifecycle and code signing remain pending; `SHA256SUMS` is present.")
t = t.replace("`SHA256SUMS`, clean-VM lifecycle and code signing remain pending.", "clean-VM lifecycle and code signing remain pending; `SHA256SUMS` is present.")
t = t.replace("| Clean-VM install/upgrade/uninstall | NOT_STARTED | final-artifact **host lifecycle 14/14 + cross-version upgrade 8/8 passed** (`installer-lifecycle.json`, `upgrade-path.json`); clean-VM install/start/upgrade/uninstall still PEND",
              "| Clean-VM install/upgrade/uninstall | UNVERIFIED | host lifecycle **12/12** on the final 3.2.0 artifact, including installing 3.0.0-preview.1 and upgrading (`installer-lifecycle.json`); clean-VM install/start/upgrade/uninstall still PEND")
wr(p, t)

# 3) desktop README: uppercase full final hash
p = "desktop/README.md"
t = rd(p)
t = t.replace("7b0dde7b…9546", INST)
wr(p, t)

# 4) acceptance matrix: full correct hash
p = "desktop/acceptance-matrix.md"
t = rd(p)
t = t.replace("7B0DDE7B…A07AC4", INST)
t = t.replace("79 IMPLEMENTED_PASS / 14 UNVERIFIED / 4 NOT_STARTED", "80 IMPLEMENTED_PASS / 13 UNVERIFIED / 4 NOT_STARTED")
wr(p, t)

# 5) progress.md: append final-evidence block with required marker/hash/counts
p = "docs/progress.md"
t = rd(p)
block = """

## Round 3 final evidence (SuWen desktop 3.2.0, 2026-10-25, Lead-measured)

All numbers below were measured on the final 3.2.0 build in the TARGET workspace
(`C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\SuWen\\desktop-vnext`).

- Final installer: `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` — **129,446,526 bytes** — SHA-256
  `%s` — **UNSIGNED**. Blockmap 135,974 B; unpacked `win-unpacked/SuWen.exe` 249,801,728 B;
  `SHA256SUMS` written to `desktop/release/SHA256SUMS` and mirrored at `docs/release/SHA256SUMS.txt`.
- Final tests: `npm test` 182 tests / 180 pass / 0 fail / 2 skipped / 33.4 s / exit 0;
  `e2e-rpc --live` 42/0 (real Europe PMC PMID 42878939 + UniProt Q9Y2B4); packaged smoke 8/8;
  UI DOM QA 19/0/12; T1 stream-core 23/23; T2 visual audit 144-shot matrix / 0 layout defects;
  T3 deterministic 19 PASS / 0 FAIL / 3 live-gated SKIP + live 21/21; chaos 12/12 in 51.4 s;
  host installer lifecycle 12/12 including installing 3.0.0-preview.1 and upgrading to 3.2.0.
- Machine-readable state: `master-requirements.csv` 98 rows — **80 IMPLEMENTED_PASS / 13 UNVERIFIED /
  4 NOT_STARTED / 1 BLOCKED_EXTERNAL**; `feature-parity-matrix.csv` 85 rows (66/7/9/1/1/1);
  `ui-action-coverage.csv` 144 actions / 0 unknown; `defect-register.csv` 20 rows.
- Historical 3.1.0 numbers recorded earlier in this file (129,425,145 B / E1A1062C…) are superseded by
  the final 3.2.0 artifact above. Clean-Windows-VM lifecycle, code signing, endurance (8/24/72 h,
  reboot, power loss), real external accounts and GitHub publication remain open/blocked.
""" % INST
if "Round 3 final evidence (SuWen desktop 3.2.0" not in t:
    t += block
wr(p, t)
print("patch4 done")
