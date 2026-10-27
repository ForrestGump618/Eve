"""Verify shipped scientific scripts through the actual workspace kernel.

Run from the repository root:
python scripts/verify_science_skills.py --output <isolated-directory> [--live]
No model account is used. --live permits public queries and uv dependency downloads.
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from omicslab.config import Settings
from omicslab.execution.local import LocalExecutionBackend
from omicslab.kernel.manager import KernelService
from omicslab.server.routes_harness import execute_backend
from omicslab.workspace import Workspace


def bundles():
    directory = ROOT / "desktop/skill-library"
    index = json.loads((directory / "index.json").read_text(encoding="utf-8"))
    pack = (directory / "library.pack").read_bytes()
    assert hashlib.sha256(pack).hexdigest() == index["packSha256"]
    result = {}
    for skill in index["skills"]:
        if skill.get("bundle") != "science":
            continue
        files = []
        for path, sha in skill["files"].items():
            ref = index["objects"][sha]
            data = gzip.decompress(pack[ref["offset"]:ref["offset"] + ref["length"]])
            assert hashlib.sha256(data).hexdigest() == sha
            files.append({"path": path, "sha256": sha, "content": data.decode("utf-8")})
        result[skill["name"]] = {k: skill[k] for k in ["id", "name", "version", "sha256", "source", "runtime"]}
        result[skill["name"]]["files"] = files
    return result


async def main(output: Path, live: bool):
    output.mkdir(parents=True, exist_ok=True)
    settings = Settings(home=output / "profile", workspace=output)
    settings.ensure_dirs()
    kernel = KernelService(settings, cwd=output)
    backend = LocalExecutionBackend(settings, Workspace("science_acceptance", "Science acceptance", local_path=str(output)), kernel)
    report = {"kind": "real local Jupyter kernel and upstream scripts; no model acceptance",
              "live": live, "checks": [], "failures": [], "workspace": str(output)}
    items = bundles()
    async def check(name, operation, arguments, verify=None):
        start = time.perf_counter()
        try:
            result = await execute_backend(backend, operation, arguments)
            if verify:
                verify(result)
            report["checks"].append({"name": name, "passed": True, "durationMs": round((time.perf_counter() - start) * 1000), "result": result})
            print("PASS", name, flush=True)
        except Exception as exc:
            report["failures"].append({"name": name, "error": str(exc)})
            print("FAIL", name, str(exc)[:400], flush=True)
    await backend.start()
    try:
        for name, bundle in items.items():
            await check(name, "prepare_science_skill", {"bundle": bundle})
        if live:
            tasks = [
                ("literature", "science-literature-search-europepmc", "scripts/europepmc_api.py",
                 ["search", "TP53", "--max_results", "2", "--output", "europepmc.json"], "europepmc.json"),
                ("compound", "science-pubchem-database", "scripts/pubchem_api.py",
                 ["properties", "--cid", "2244", "--output", "pubchem.json"], "pubchem.json"),
                ("drug-activity", "science-chembl-database", "scripts/chembl_api.py",
                 ["molecule", "--id", "CHEMBL25", "--output", "chembl.json"], "chembl.json"),
                ("expression", "science-gtex-database", "scripts/gtex_cli.py",
                 ["resolve-gencode-id", "TNF", "--output", "gtex.json"], "gtex.json"),
                ("protein", "science-uniprot-database", "scripts/uniprot_tools.py",
                 ["search", "accession:P04637", "--limit", "1", "--fields", "accession,protein_name"], None),
            ]
            for label, name, script, args, artifact in tasks:
                def verify(result, artifact=artifact):
                    assert result.get("ok") is True
                    if artifact:
                        path = output / artifact
                        assert path.is_file() and path.stat().st_size > 2, "Missing nonempty result artifact"
                        value = json.loads(path.read_text(encoding="utf-8"))
                        assert value and not (isinstance(value, dict) and value.get("error")), "API returned empty/error data"
                    else:
                        assert "P04637" in result["stdout"]
                await check(label, "run_science_skill", {
                    "bundle": items[name],
                    "input": {"script": script, "args": args, "allowDependencyInstall": True, "timeoutSeconds": 120},
                }, verify)
    finally:
        await kernel.stop()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(report["checks"]), "failed": len(report["failures"]), "report": str(output / "report.json")}))
    return bool(report["failures"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.output.resolve(), args.live)))
