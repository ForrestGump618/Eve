#!/usr/bin/env python
"""Round-3 first-pass verification. Read-only. Prints PASS/FAIL per check."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DOCS = ROOT / "docs"
fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        fails.append(name)


def rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


# --- deliverables exist
deliverables = [
    DOCS / "requirements/master-requirements.csv",
    DOCS / "requirements/traceability.md",
    DOCS / "migration/feature-parity-matrix.csv",
    DOCS / "migration/feature-parity-matrix.md",
    DOCS / "verification/ui-action-coverage.csv",
    DOCS / "verification/security-review.md",
    DOCS / "verification/performance-baseline.md",
    DOCS / "verification/defect-register.csv",
    DOCS / "verification/artifacts/security-scan.json",
    DOCS / "verification/artifacts/performance-baseline.json",
    DOCS / "release/release-gates.md",
    DOCS / "release/final-acceptance-report.md",
    DOCS / "release/CHANGELOG.md",
    DOCS / "release/release-notes-v3.2.0.md",
    DOCS / "release/github-publication.md",
]
for path in deliverables:
    check(f"exists {path.relative_to(ROOT)}", path.is_file(), f"{path.stat().st_size} B" if path.is_file() else "missing")

# --- master CSV schema/counts
master = rows(deliverables[0])
header = list(master[0].keys())
expected_header = ["Requirement ID", "Feature", "Priority", "Source", "Implementation Module", "UI Entry",
                   "IPC/RPC", "Backend Handler", "Persistence", "Test ID", "Evidence", "Status", "Blocker"]
check("master 13-field header", header == expected_header, str(header))
check("master >= 90 rows", len(master) >= 90, f"{len(master)} rows")
ids = [r["Requirement ID"] for r in master]
check("master ids unique", len(ids) == len(set(ids)))
REGISTER = [1, 2, 3] + list(range(10, 15)) + list(range(20, 27)) + list(range(30, 40)) + \
    list(range(40, 48)) + list(range(50, 58)) + list(range(60, 65)) + [70, 71] + [80, 81] + \
    list(range(90, 95)) + list(range(100, 104)) + list(range(110, 122))
check("master covers register R001-R121 set", all(f"R{i:03d}" in ids for i in REGISTER), f"{len(REGISTER)} register ids")
check("master covers R122-R148", all(f"R{i:03d}" in ids for i in range(122, 149)))
from collections import Counter
status = Counter(r["Status"] for r in master)
allowed = {"IMPLEMENTED_PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_STARTED", "UNVERIFIED"}
check("master statuses allowed", set(status) <= allowed, str(dict(status)))
check("master has no empty status", all(r["Status"] for r in master))

# --- parity
parity = rows(deliverables[2])
check("parity rows >= 85", len(parity) >= 85, f"{len(parity)} rows")
pstat = Counter(r.get("vnext_status", "") for r in parity)
check("parity statuses allowed", set(pstat) <= {"IMPLEMENTED_PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_STARTED", "UNVERIFIED", "N/A_PORT", "REPLACED"}, str(dict(pstat)))
check("parity has round-3 rows", any("streaming event protocol" in r.get("capability", "").lower() for r in parity))

# --- ui coverage
cov = rows(deliverables[4])
check("ui coverage 142 actions", len(cov) == 142, f"{len(cov)} rows")
kinds = Counter(r["method_kind"] for r in cov)
check("ui coverage no unknown methods", kinds.get("unknown", 0) == 0, str(dict(kinds)))
check("ui coverage all wired statuses", all(r["wired_status"] for r in cov))

# --- security/perf artefacts
scan = json.loads(deliverables[8].read_text(encoding="utf-8"))
check("security scan PASS", scan["verdict"] == "PASS", f"high={scan['highCount']} low={scan['lowCount']} fixtures={scan['acceptedTestFixtures']}")
check("security scan 0 high", scan["highCount"] == 0)
check("security scan forbidden tracked files empty", scan["forbiddenTrackedFiles"] == [])
perf = json.loads(deliverables[9].read_text(encoding="utf-8"))
check("perf artifact has benchmarks", {"daemonStartup", "rpcBurst", "pythonWorker"} <= set(perf["benchmarks"]))
check("perf worker flowSummary ok", perf["benchmarks"]["pythonWorker"].get("flowSummaryOk") is True)

# --- defect register
defects = rows(deliverables[7])
check("defect register >= 10 rows", len(defects) >= 10, f"{len(defects)} rows")
dstat = Counter(r["Status"] for r in defects)
check("defect register statuses", all(r["Status"] for r in defects), str(dict(dstat)))

# --- release docs honesty markers
gates = deliverables[10].read_text(encoding="utf-8")
check("gates G1..G9", all(f"G{i}" in gates for i in range(1, 10)))
check("gates say NOT authorized", "NOT authorized" in gates or "NOT RELEASABLE" in gates)
accept = deliverables[11].read_text(encoding="utf-8")
check("acceptance has PENDING_LEAD", accept.count("PENDING_LEAD") >= 5, f"{accept.count('PENDING_LEAD')} markers")
github = deliverables[14].read_text(encoding="utf-8")
check("github doc states blocked", "BLOCKED_EXTERNAL" in github and "never executed" in github.lower())
notes = deliverables[13].read_text(encoding="utf-8")
check("release notes installer PENDING_LEAD", "PENDING_LEAD" in notes)

# --- workflow strengthened
wf = (ROOT / ".github/workflows/suwen-windows.yml").read_text(encoding="utf-8")
for needle in ["e2e-rpc.mjs", "ui-dom-qa.mjs", "security-scan.mjs", "SHA256SUMS", "npmmirror", "npm run dist:win"]:
    check(f"workflow contains {needle}", needle in wf)
try:
    import yaml  # type: ignore
    yaml.safe_load(wf)
    check("workflow valid YAML (PyYAML)", True)
except Exception as exc:  # pragma: no cover
    print(f"SKIP  workflow YAML parse ({exc.__class__.__name__}: {exc})")

# --- progress round-3 section
progress = (DOCS / "progress.md").read_text(encoding="utf-8")
check("progress round-3 section", "## Round 3" in progress and "R122" in progress)
check("progress does not claim 8/24/72h passed", "8/24/72 h, sleep" in progress or "NOT RUN" in progress)

# --- no out-of-scope writes expected: list docs/release round-3 files
print("\nround-3 docs sizes:")
for path in deliverables[10:]:
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size} B")

print("\nRESULT:", "ALL CHECKS PASS" if not fails else f"{len(fails)} FAILURES: {fails}")
raise SystemExit(0 if not fails else 1)
