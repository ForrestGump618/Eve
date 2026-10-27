"""Append a pinned science bundle to the shared pack without executing its code."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("skill_builder", Path(__file__).with_name("build-skill-library.py"))
builder = module_from_spec(spec)
spec.loader.exec_module(builder)

REVISION = "4de6786171f1479026da5d3a00f110703c8ba35e"
REPOSITORY = "google-deepmind/science-skills"
REQUIRED = {
    "alphagenome-single-variant-analysis": ["ALPHAGENOME_API_KEY"],
    "alphagenome-variant-impact-score": ["ALPHAGENOME_API_KEY"],
    "protein-sequence-msa": ["USER_EMAIL"],
}
OPTIONAL = {
    "clinvar-database": ["NCBI_API_KEY"], "dbsnp-database": ["NCBI_API_KEY"],
    "ncbi-sequence-fetch": ["NCBI_API_KEY", "USER_EMAIL"],
    "pubmed-database": ["NCBI_API_KEY", "USER_EMAIL"],
    "literature-search-openalex": ["OPENALEX_API_KEY"], "openfda-database": ["FDA_API_KEY"],
    "protein-sequence-similarity-search": ["USER_EMAIL"],
}
ALIASES = {
    "alphagenome": "基因调控 非编码变异 致病性 组织表达",
    "alphafold": "蛋白结构 置信度",
    "clinvar": "临床变异 遗传变异",
    "gnomad": "人群频率 基因约束 遗传变异",
    "gtex": "组织表达 表达数量性状 eQTL",
    "ensembl": "基因注释 基因组 序列",
    "pubmed": "文献检索 论文 摘要",
    "europepmc": "文献检索 全文 论文",
    "biorxiv": "预印本 文献检索",
    "openalex": "文献检索 引用 学者",
    "chembl": "药物发现 活性 化合物 靶点",
    "pubchem": "化合物 药物发现 分子",
    "opentargets": "药物靶点 疾病关联",
    "uniprot": "蛋白 序列 功能",
    "pdb": "蛋白结构 晶体结构",
    "foldseek": "结构搜索 蛋白同源 结构比较",
    "pymol": "结构可视化 蛋白绘图",
}


def import_bundle(checkout: Path, output: Path, revision: str = REVISION) -> dict:
    actual = subprocess.check_output(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    if actual != revision:
        raise ValueError("Science checkout must match the pinned revision")
    index = json.loads((output / "index.json").read_text(encoding="utf-8"))
    pack = bytearray((output / "library.pack").read_bytes())
    if hashlib.sha256(pack).hexdigest() != index["packSha256"]:
        raise ValueError("Existing library pack hash mismatch")
    # Read immutable Git objects, not possibly modified working-tree files.
    def read(path: str) -> bytes:
        return subprocess.check_output(["git", "-C", str(checkout), "show", f"{revision}:{path}"])

    paths = subprocess.check_output(
        ["git", "-C", str(checkout), "ls-tree", "-r", "--name-only", revision], text=True).splitlines()
    plugin = json.loads(read("plugin.json"))
    notices = {
        "EVE-UPSTREAM-LICENSE.txt": read("LICENSE"),
        "EVE-DATA-SOURCE-TERMS.md": read("SKILL_LICENSES.md"),
        "EVE-MATERIALS-LICENSE.txt": (
            "Copyright 2026 Google LLC\n\n"
            "Software: Apache License 2.0 (see EVE-UPSTREAM-LICENSE.txt).\n"
            "Other materials: Creative Commons Attribution 4.0 International (CC-BY-4.0).\n"
            "https://creativecommons.org/licenses/by/4.0/legalcode\n\n"
            f"Source: https://github.com/{REPOSITORY}/tree/{revision}\n"
            "This is not an official Google product.\n"
        ).encode(),
    }
    imported, omitted = [], []
    for entry in sorted(p for p in paths if p.startswith("skills/") and p.endswith("/SKILL.md")):
        root = str(PurePosixPath(entry).parent) + "/"
        instruction = read(entry)
        meta = builder.metadata(instruction.decode("utf-8"))
        canonical = str(meta["name"])
        files, skipped = {}, []
        for path in [p for p in paths if p.startswith(root)]:
            rel = path[len(root):]
            data = read(path)
            if PurePosixPath(path).suffix.lower() not in builder.TEXT_EXT | {".tsv"} or len(data) > 2_000_000:
                skipped.append(rel)
                continue
            data.decode("utf-8", errors="strict")
            files[rel] = builder.add_object(index["objects"], pack, data)
        for path, data in notices.items():
            files[path] = builder.add_object(index["objects"], pack, data)
        digest = hashlib.sha256(instruction).hexdigest()
        scripts = sorted(p for p in files if p.startswith("scripts/") and p.endswith(".py"))
        aliases = " ".join(v for k, v in ALIASES.items() if k in canonical)
        imported.append({
            "id": f"builtin:science-{canonical}:{digest[:12]}",
            "name": f"science-{canonical}", "description": str(meta["description"]).strip(),
            "keywords": aliases, "bundle": "science", "version": f"{plugin['version']}+{revision[:12]}",
            "source": f"https://github.com/{REPOSITORY}/tree/{revision}/{root.rstrip('/')}",
            "origin": {"repository": REPOSITORY, "commit": revision, "path": entry},
            "license": "Apache-2.0 AND CC-BY-4.0", "sha256": digest, "files": files,
            "omittedResources": skipped,
            "runtime": {"manager": "uv", "scripts": scripts, "project": "pyproject.toml" in files,
                        "requiredCredentials": REQUIRED.get(canonical, []),
                        "optionalCredentials": OPTIONAL.get(canonical, [])},
        })
        omitted.extend(f"{canonical}/{p}" for p in skipped)
    index["skills"] = [s for s in index["skills"] if s.get("bundle") != "science"] + imported
    index["sources"] = [s for s in index["sources"] if s["repository"] != REPOSITORY] + [
        {"repository": REPOSITORY, "commit": revision, "version": plugin["version"],
         "license": "Apache-2.0 AND CC-BY-4.0"}]
    index["packSha256"] = hashlib.sha256(pack).hexdigest()
    (output / "library.pack").write_bytes(pack)
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"bundle": "science", "version": plugin["version"], "commit": revision,
              "skills": len(imported), "scripts": sum(len(s["runtime"]["scripts"]) for s in imported),
              "resources": sum(len(s["files"]) for s in imported), "omitted": omitted,
              "packSha256": index["packSha256"], "packBytes": len(pack)}
    (output / "science-import-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "skill-library")
    args = parser.parse_args()
    print(json.dumps(import_bundle(args.checkout, args.output)))
