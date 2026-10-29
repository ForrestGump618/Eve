"""Import Eve's public biomedical-data Collector/Evaluator/Curator skill."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from pathlib import PurePosixPath


ROOT = Path(__file__).resolve().parents[2]
BUNDLE = "eve-public-data"
SKILL_NAME = "science-public-biomedical-data"
SOURCE = ROOT / "omicslab" / "skills" / "public-biomedical-data"

spec = importlib.util.spec_from_file_location(
    "builder", Path(__file__).with_name("build-skill-library.py")
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def build(output: Path) -> dict:
    index_path, pack_path = output / "index.json", output / "library.pack"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    pack = bytearray(pack_path.read_bytes())
    if hashlib.sha256(pack).hexdigest() != index["packSha256"]:
        raise ValueError("Existing skill pack is corrupt")

    resources: dict[str, bytes] = {}
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(SOURCE).as_posix()
        if PurePosixPath(relative).suffix.lower() not in builder.TEXT_EXT and relative != "SKILL.md":
            raise ValueError(f"Unexpected non-text public-data resource: {relative}")
        resources[relative] = path.read_bytes()
    if "SKILL.md" not in resources:
        raise ValueError("Public-data skill has no SKILL.md")

    scripts = sorted(
        path
        for path in resources
        if path.startswith("scripts/")
        and path.endswith(".py")
        and b"if __name__" in resources[path]
    )
    if not scripts:
        raise ValueError("Public-data skill has no runnable entry point")

    files = {
        path: builder.add_object(index["objects"], pack, data)
        for path, data in sorted(resources.items())
    }
    digest = hashlib.sha256(resources["SKILL.md"]).hexdigest()
    imported = {
        "id": f"builtin:{SKILL_NAME}:{digest[:12]}",
        "name": SKILL_NAME,
        "description": (
            "Collector-Evaluator-Curator pipeline for public biomedical metadata: "
            "evidence-first search, explainable quality scoring, normalized fields, "
            "provenance and optional bounded downloads."
        ),
        "keywords": (
            "公共 生物医学 多组学 数据 GEO SRA EGA dbGaP PRIDE ProteomeXchange "
            "MetaboLights CELLxGENE GTEx TCGA GDC LINCS metadata provenance download"
        ),
        "bundle": BUNDLE,
        "version": "1.1.0",
        "source": "eve-local:omicslab/skills/public-biomedical-data",
        "license": "Apache-2.0",
        "sha256": digest,
        "files": files,
        "omittedResources": [],
        "runtime": {
            "manager": "uv",
            "scripts": scripts,
            "project": False,
            "requiredCredentials": [],
            "optionalCredentials": [],
            "scriptDependencies": {path: [] for path in scripts},
            "externalRequirements": [
                "Metadata-only mode requires no network.",
                "Downloads require explicit --download, public HTTPS sources and available disk.",
                "Controlled-access data require the source's authorization process.",
            ],
        },
    }
    index["skills"] = [
        skill
        for skill in index["skills"]
        if skill.get("bundle") != BUNDLE and skill.get("name") != SKILL_NAME
    ] + [imported]
    index["packSha256"] = hashlib.sha256(pack).hexdigest()
    pack_path.write_bytes(pack)
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    report = {
        "bundle": BUNDLE,
        "name": SKILL_NAME,
        "version": imported["version"],
        "resources": len(files),
        "scripts": scripts,
        "packSha256": index["packSha256"],
        "packBytes": len(pack),
        "mainJavascriptBytesAdded": 0,
    }
    (output / "public-data-import-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "skill-library",
    )
    print(json.dumps(build(parser.parse_args().output)))
