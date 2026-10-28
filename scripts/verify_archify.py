"""Exercise pinned Archify through the real workspace kernel (no model account)."""
from __future__ import annotations

import argparse
import asyncio
import base64
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


def bundle():
    library = ROOT / "desktop/skill-library"
    index = json.loads((library / "index.json").read_text(encoding="utf-8"))
    pack = (library / "library.pack").read_bytes()
    assert hashlib.sha256(pack).hexdigest() == index["packSha256"]
    skill = next(s for s in index["skills"] if s["name"] == "archify")
    files = []
    for path, sha in skill["files"].items():
        ref = index["objects"][sha]
        data = gzip.decompress(pack[ref["offset"]:ref["offset"] + ref["length"]])
        assert hashlib.sha256(data).hexdigest() == sha
        files.append({"path": path, "sha256": sha, "content": data.decode("utf-8")})
    compressed = gzip.compress(json.dumps(files).encode())
    return {**{k: skill[k] for k in ["id", "name", "version", "sha256", "source", "runtime"]},
            "archive": base64.b64encode(compressed).decode(),
            "archiveSha256": hashlib.sha256(compressed).hexdigest()}, files


async def main(output):
    output.mkdir(parents=True, exist_ok=True)
    settings = Settings(home=output / "profile", workspace=output)
    settings.ensure_dirs()
    kernel = KernelService(settings, cwd=output)
    backend = LocalExecutionBackend(settings, Workspace("archify_acceptance", "Archify acceptance", local_path=str(output)), kernel)
    packed, files = bundle()
    report = {"kind": "pinned upstream examples through real local kernel, Node and browser; no model quality claim",
              "checks": [], "failures": []}
    await backend.start()
    try:
        for name, path in [("workflow", "examples/agent-tool-call.workflow.json"),
                           ("explainer", "examples/delivery.explainer.json")]:
            data = json.loads(next(f["content"] for f in files if f["path"] == path))
            relative = f".archify/{name}/index.html"
            # Explainer's authored meta.output is a portable filename; the CLI
            # owns the actual destination directory.
            data.setdefault("meta", {})["output"] = "index.html" if name == "explainer" else relative
            candidate = output / f"{name}.json"
            candidate.write_text(json.dumps(data), encoding="utf-8")
            started = time.perf_counter()
            try:
                result = await execute_backend(backend, "run_archify", {"bundle": packed, "input": {
                    "command": "finalize", "type": name, "candidate": candidate.name,
                    "output": relative, "outDir": f".archify/{name}/review-{time.time_ns()}",
                }})
                assert result.get("ok") is True, json.dumps(result, ensure_ascii=False)[-6000:]
                artifact = result["artifact"]
                assert hashlib.sha256((output / artifact["path"]).read_bytes()).hexdigest() == artifact["sha256"]
                report["checks"].append({"name": name, "passed": True,
                                         "durationMs": round((time.perf_counter()-started)*1000), "result": result})
                print("PASS", name, flush=True)
            except Exception as exc:
                report["failures"].append({"name": name, "error": str(exc)})
                print("FAIL", name, str(exc)[:2000], flush=True)
    finally:
        await kernel.stop()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return bool(report["failures"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.output.resolve())))
