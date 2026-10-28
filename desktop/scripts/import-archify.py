"""Import an immutable, executable visualization package into Eve's shared pack."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-skill-library.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
REVISION = "208acba8d412335185b2056fedf54b3405df43fb"
REPOSITORY = "tt-a1i/archify"


def import_bundle(checkout: Path, output: Path) -> dict:
    def git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args])
    if git("rev-parse", "HEAD").decode().strip() != REVISION:
        raise ValueError("Archify checkout differs from the pinned release")
    index = json.loads((output / "index.json").read_text(encoding="utf-8"))
    pack = bytearray((output / "library.pack").read_bytes())
    if hashlib.sha256(pack).hexdigest() != index["packSha256"]:
        raise ValueError("Existing skill pack is corrupt")
    files, omitted = {}, []
    for path in git("ls-tree", "-r", "--name-only", REVISION, "archify").decode().splitlines():
        relative = path.removeprefix("archify/")
        # Generated gallery outputs duplicate the shipped renderer; authoring
        # examples, schemas, templates and all runtime modules remain available.
        if relative.startswith("examples/") and relative.endswith(".html"):
            omitted.append(relative)
            continue
        data = git("show", f"{REVISION}:{path}")
        data.decode("utf-8")  # Never silently replace bytes in executable assets.
        files[relative] = builder.add_object(index["objects"], pack, data)
    license_text = git("show", f"{REVISION}:LICENSE")
    files["EVE-UPSTREAM-LICENSE.txt"] = builder.add_object(index["objects"], pack, license_text)
    package = json.loads(git("show", f"{REVISION}:archify/package.json"))
    sha = files["SKILL.md"]
    skill = {
        "id": f"builtin:archify:{sha[:12]}", "name": "archify",
        "description": "Create validated interactive HTML diagrams and one-page explainers for architecture, workflows, sequences, data flows, states, schemas, trees, timelines and timings.",
        "keywords": "架构图 流程图 数据流 时序图 实验设计 工作流 模块关系 可交互页面 一页说明 研究结果对比 可视化",
        "bundle": "archify", "version": package["version"] + "+" + REVISION[:12],
        "source": f"https://github.com/{REPOSITORY}/tree/{REVISION}/archify",
        "license": "MIT", "sha256": sha, "files": files, "omittedResources": omitted,
        "origin": {"repository": REPOSITORY, "commit": REVISION, "path": "archify/SKILL.md"},
        "runtime": {"manager": "node", "scripts": ["bin/archify.mjs"], "project": False,
                    "requiredCredentials": [], "optionalCredentials": []},
    }
    index["skills"] = [s for s in index["skills"] if s["name"] != "archify"] + [skill]
    index["sources"] = [s for s in index["sources"] if s["repository"] != REPOSITORY] + [
        {"repository": REPOSITORY, "commit": REVISION, "version": package["version"], "license": "MIT"}]
    index["packSha256"] = hashlib.sha256(pack).hexdigest()
    (output / "library.pack").write_bytes(pack)
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"version": package["version"], "commit": REVISION, "files": len(files),
              "omitted": omitted, "packSha256": index["packSha256"], "packBytes": len(pack)}
    (output / "archify-import-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "skill-library")
    args = parser.parse_args()
    print(json.dumps(import_bundle(args.checkout, args.output)))
