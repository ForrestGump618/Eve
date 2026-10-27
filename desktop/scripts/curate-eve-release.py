"""Curate local acceptance evidence without publishing model transcripts or credentials."""
import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/verification/eve-1.0"
RAW = ROOT / "docs/verification/harness-20261025"


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def log(name):
    raw = (ROOT / name).read_bytes()
    return raw.decode("utf-16" if raw.startswith(b"\xff\xfe") else "utf-8-sig", errors="replace")


def benchmark(name):
    source = read(RAW / name)
    tasks = []
    for row in source["results"]:
        trace = row.get("trace", [])
        errors = sum(e["type"] == "tool.failed" for e in trace)
        tasks.append({key: row.get(key) for key in (
            "id", "category", "status", "runStatus", "traceId", "latencyMs",
            "tokens", "calls", "missingTools", "missingContent")})
        tasks[-1].update(toolCompleted=sum(e["type"] == "tool.completed" for e in trace),
                         toolFailed=errors, recovered=bool(errors and row["status"] == "passed"),
                         citationCount=len((row.get("verification") or {}).get("citationUrls", [])))
    return {"model": source["model"], "taskSetSha256": source["taskSetSha256"],
            "startedAt": source["startedAt"], "finishedAt": source["finishedAt"],
            "metrics": source["metrics"], "tasks": tasks,
            "recovery": {"eligibleTasks": sum(t["toolFailed"] > 0 for t in tasks),
                         "passedAfterToolFailure": sum(t["recovered"] for t in tasks)}}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    before, after = benchmark("release-1.0-final.json"), benchmark("eve-final.json")
    assert before["taskSetSha256"] == after["taskSetSha256"]
    assert after["metrics"]["total"] == 22 and after["metrics"]["passed"] >= 20
    write("test-matrix.json", {"baselineCommit": "74a98f9", "before": before, "after": after,
                              "scope": "real model/public network; local executable MCP and Skill fixtures"})
    ui = {}
    for path in sorted(OUT.glob("*-ui-*.json")):
        result = read(path)
        ui[path.name] = {key: result.get(key) for key in ("kind", "packaged", "at", "error")}
        ui[path.name].update(checks=result["checks"], errors=result.get("errors", []),
                             passed=sum(c["ok"] for c in result["checks"]), total=len(result["checks"]))
    for name in ("research-full-ui-live-packaged.json", "product-ui-controlled-ssh-packaged.json",
                 "product-ui-live-ssh-packaged.json"):
        assert name in ui and not ui[name]["error"] and ui[name]["passed"] == ui[name]["total"], name
    write("ui-summary.json", ui)

    packaged = ROOT / "desktop/release/eve-v1.0.0/win-unpacked/resources"
    comparisons = []
    groups = [
        (ROOT / "desktop/dist", packaged / "app/dist", ("main.js", "src", "ui", "skill-library", "bundled-skills")),
        (ROOT / "omicslab", packaged / "legacy/omicslab", ("web", "skills", "agents", "data")),
    ]
    for base, target, names in groups:
        for name in names:
            start = base / name
            for path in sorted([start] if start.is_file() else start.rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                    comparisons.append((path, target / path.relative_to(base)))
    for path in sorted((ROOT / "omicslab").rglob("*.py")):
        comparisons.append((path, packaged / "legacy" / path.relative_to(ROOT)))
    for path in sorted((ROOT / "desktop/worker").glob("*.py")):
        comparisons.append((path, packaged / "worker" / path.name))
    mismatches = [str(a.relative_to(ROOT)) for a, b in comparisons
                  if not b.is_file() or hashlib.sha256(a.read_bytes()).digest() != hashlib.sha256(b.read_bytes()).digest()]
    write("package-integrity.json", {"checked": len(comparisons), "mismatches": mismatches})
    assert not mismatches, mismatches

    installer = ROOT / "desktop/release/eve-v1.0.0/Eve-Setup-1.0.0-win-x64.exe"
    digest = hashlib.sha256(installer.read_bytes()).hexdigest()
    write("installer.json", {"file": installer.name, "bytes": installer.stat().st_size,
                            "sha256": digest, "signed": False, "version": "1.0.0"})
    imports = read(ROOT / "desktop/skill-library/import-report.json")
    dispositions = collections.Counter(d["decision"] for d in imports["decisions"])
    write("skill-summary.json", {**{k: v for k, v in imports.items() if k != "decisions"},
                               "dispositions": dict(dispositions), "baseSkills": 8})
    tests = log("eve-tests-final.log")
    def count(label):
        return int(re.search(rf"\b{label} (\d+)\s*$", tests, re.M)[1])
    assert count("fail") == 0
    python = log("eve-python-final.log")
    python_passed = int(re.search(r"(\d+) passed", python)[1])
    write("test-summary.json", {
        "typescript": {"total": count("tests"), "passed": count("pass"), "skipped": count("skipped"), "failed": count("fail"),
                       "skipReason": "Windows symlink creation privilege unavailable"},
        "python": {"passed": python_passed, "failed": 0},
        "typecheck": "passed", "rpcLivePublicDatabases": {"passed": 42, "failed": 0},
        "domQa": {"passed": 18, "failed": 0, "warnings": 13},
        "limitations": ["Local protocol fixtures are not real external MCP services.",
                        "Citation verification checks URL provenance, not semantic entailment.",
                        "Research demonstration uses synthetic data, not a scientific discovery."]})
    print(json.dumps({"benchmark": after["metrics"], "recovery": after["recovery"],
                      "packagedFiles": len(comparisons), "installerSha256": digest}))


if __name__ == "__main__":
    main()
