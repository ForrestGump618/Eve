"""Import pinned staged research skills; unlicensed upstreams stay user-local.

First install SKILL directories with the skill-installer helper. This importer
checks every staged byte against the upstream Git tree and also retains shared
plugin scripts that cannot live inside individual skill directories.
"""
from __future__ import annotations

import argparse
import ast
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import urllib.request

spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-skill-library.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
SOURCES = {
    "bio": ("anthropics/knowledge-work-plugins", "2574e29377c7173d0cecffef29a6ecbd7f8ccb5d"),
    "personal": ("openai/plugins", "0722921d5542fc593105c27bd52630babd8b8c2a"),
    "bionemo": ("NVIDIA-BioNeMo/bionemo-agent-toolkit", "f9bb5bb3aacc881c89eb15e93fd119e91915eea8"),
}
DEPS = {
    "instrument-data-to-allotrope": ["allotropy", "pandas"],
    "nextflow-development": ["pyyaml", "requests"],
    "scvi-tools": ["scvi-tools", "scanpy", "leidenalg"],
    "single-cell-rna-qc": ["scanpy", "numpy", "pandas", "matplotlib", "scipy"],
}
ALIASES = {
    "ngs": "测序 质控 样本表", "fastq": "原始读数 质量",
    "rna": "转录组 表达", "scvi": "单细胞 批次整合 潜变量",
    "single-cell": "单细胞 质量控制", "allotrope": "仪器 数据转换 标准格式",
    "nextflow": "计算流程 基因组", "problem": "选题 假设 实验设计",
    "research-router": "科研 证据 综合检索", "pdb": "蛋白结构",
    "alphafold": "蛋白结构 预测", "uniprot": "蛋白 序列",
    "gwas": "全基因组 关联", "clinvar": "变异 致病性",
    "gnomad": "变异 人群频率", "gtex": "组织 表达",
    "chembl": "药物 活性", "pubchem": "化合物",
    "binding": "分子 结合", "boltz": "设计 分子 预测",
    "clinical": "临床 试验", "proteom": "蛋白组", "metabol": "代谢组",
}


def import_skills(family: str, staging: Path, tree_path: Path, output: Path, cache: Path):
    repository, revision = SOURCES[family]
    tree = json.loads(tree_path.read_bytes())
    if tree["sha"] != revision or tree.get("truncated"):
        raise ValueError("Require the complete pinned upstream tree")
    if family == "personal" and output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError("Personal research resources must stay outside the distributable repository")
    prefixes = (["bio-research/"] if family == "bio" else
        ["nim-skills/", "library-skills/", "open-models-skills/", "workflows/"] if family == "bionemo" else
        ["plugins/life-science-research/", "plugins/ngs-analysis/", "plugins/boltz-api-cli/"])
    blobs = {x["path"]: x for x in tree["tree"] if x["type"] == "blob"
             and (any(x["path"].startswith(p) for p in prefixes)
                  or family == "bionemo" and x["path"] in {"LICENSE","LICENSE-APACHE-2.0","LICENSE-CC-BY-4.0"})}
    cache.mkdir(parents=True, exist_ok=True)
    skill_roots = sorted((str(PurePosixPath(p).parent) + "/" for p in blobs if p.endswith("/SKILL.md")),
                         key=len, reverse=True)

    def read(path):
        entry = blobs[path]
        cached = cache / entry["sha"]
        staged = next((staging / PurePosixPath(root.rstrip("/")).name / path[len(root):]
                       for root in skill_roots if path.startswith(root)), None)
        if staged is not None and staged.is_file():
            data = staged.read_bytes()
        elif cached.is_file():
            data = cached.read_bytes()
        else:
            request = urllib.request.Request(
                f"https://raw.githubusercontent.com/{repository}/{revision}/{path}",
                headers={"User-Agent": "Eve-research-import"})
            with urllib.request.urlopen(request, timeout=40) as response:
                data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError("Upstream resource too large")
        if hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() != entry["sha"]:
            raise ValueError(f"Upstream Git blob mismatch: {path}")
        data.decode("utf-8")
        if not cached.exists():
            cached.write_bytes(data)
        return data

    # Keep only text resources; binaries/weights are not skills and are never
    # eagerly downloaded. Shared NGS scripts and config retain their layout.
    selected = [p for p in blobs if blobs[p].get("mode") != "120000" and (
                PurePosixPath(p).suffix.lower() in builder.TEXT_EXT | {".smk", ".nf", ".config", ".cif", ".pdb"}
                or PurePosixPath(p).name.startswith(("LICENSE", "NOTICE")))]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        resources = dict(zip(selected, pool.map(read, selected)))
    output.mkdir(parents=True, exist_ok=True)
    if (output / "index.json").exists():
        index = json.loads((output / "index.json").read_bytes())
        pack = bytearray((output / "library.pack").read_bytes())
        if hashlib.sha256(pack).hexdigest() != index["packSha256"]:
            raise ValueError("Existing pack digest mismatch")
    else:
        index = {"version": 1, "sources": [], "skills": [], "objects": {}}
        pack = bytearray()
    imported = []
    for entry in sorted(p for p in resources if p.endswith("/SKILL.md")):
        root = str(PurePosixPath(entry).parent) + "/"
        plugin = next(p for p in prefixes if root.startswith(p))
        canonical = PurePosixPath(root.rstrip("/")).name
        # Verify helper-installed files; do not execute downloaded code here.
        for path, data in resources.items():
            if path.startswith(root):
                local = staging / canonical / path[len(root):]
                if not local.is_file() or local.read_bytes() != data:
                    raise ValueError(f"Staged skill differs from pinned source: {path}")
        files = {p[len(root):]: data for p, data in resources.items() if p.startswith(root)}
        for path, data in resources.items():
            relative = path[len(plugin):]
            if family != "bionemo" and path.startswith(plugin) and not relative.startswith(("skills/", ".codex-plugin/")):
                files["plugin/" + relative] = data
                if relative.startswith(("scripts/", "references/", "config/", "workflows/")):
                    files[relative] = data
        if family == "bio":
            files["EVE-UPSTREAM-LICENSE.txt"] = resources["bio-research/LICENSE"]
        elif family == "bionemo":
            for license_file in ["LICENSE","LICENSE-APACHE-2.0","LICENSE-CC-BY-4.0"]:
                files["EVE-UPSTREAM-" + license_file + ".txt"] = resources[license_file]
        license_id = "Apache-2.0" if family == "bio" else (
            "Apache-2.0 AND CC-BY-4.0 AND BSD-3-Clause" if family == "bionemo" else
            "MIT" if plugin == "plugins/boltz-api-cli/" else "LicenseRef-Upstream-Unspecified")
        metadata = builder.metadata(files["SKILL.md"].decode())
        dependencies = DEPS.get(canonical)
        if family == "personal" and plugin == "plugins/life-science-research/":
            dependencies = ["requests", "pandas"]
        if dependencies:
            files["pyproject.toml"] = (
                '[project]\nname = "eve-scientific-runtime"\nversion = "1.0.0"\n'
                'requires-python = ">=3.10"\ndependencies = '
                + json.dumps(dependencies) + "\n").encode()
        scripts = sorted(p for p in files if p.startswith("scripts/") and p.endswith(".py")
                         and b"__main__" in files[p] and not p.endswith("__init__.py"))
        script_dependencies = ({"scripts/flatten_asm.py": ["pandas"], "scripts/validate_asm.py": []}
                               if canonical == "instrument-data-to-allotrope" else {})
        external_entries = []
        if family == "bionemo":
            packages = {"requests": "requests", "numpy": "numpy", "pandas": "pandas", "scipy": "scipy",
                        "matplotlib": "matplotlib", "yaml": "pyyaml", "fire": "fire", "biotite": "biotite"}
            for script in scripts[:]:
                tree_ast = ast.parse(files[script].decode())
                imports = {(n.module or "").split(".")[0] for n in ast.walk(tree_ast) if isinstance(n, ast.ImportFrom)}
                imports |= {a.name.split(".")[0] for n in ast.walk(tree_ast) if isinstance(n, ast.Import) for a in n.names}
                if imports & {"atomworks", "rfproteina"}:
                    external_entries.append(script)
                    scripts.remove(script)  # Needs the separately installed model checkout.
                else:
                    script_dependencies[script] = sorted(packages[m] for m in imports if m in packages)
        name = f"science-{'bio' if family == 'bio' else 'bionemo' if family == 'bionemo' else 'lab'}-{canonical}"
        digest = hashlib.sha256(files["SKILL.md"]).hexdigest()
        files["EVE-ADAPTER.md"] = (
            "Eve adapter: original resources are pinned and unchanged. Shared plugin resources "
            "are mirrored at scripts/, references/, config/ and retained under plugin/. "
            "Use skill_prepare and its actual directory; never assume original host paths. "
            "Use skill_run only for a declared Python entry. " +
            ("Model-checkout entries require separate setup through reviewed workspace tools: "
             + ", ".join(external_entries) + ". " if external_entries else "") +
            "Scripts without standalone CLIs "
            "are library resources: inspect and call their APIs through authorized workspace Python. "
            "No automatic package, container, HPC job submission, credential lookup, or data upload. "
            "A workflow is not complete until outputs and scientific checks have been verified.\n"
        ).encode()
        imported.append({
            "id": f"builtin:{name}:{digest[:12]}", "name": name,
            "description": str(metadata.get("description") or canonical).strip(),
            "keywords": " ".join(v for k, v in ALIASES.items() if k in canonical),
            "bundle": "bio-research" if family == "bio" else "bionemo" if family == "bionemo" else "personal-research",
            "version": "git-" + revision[:12], "license": license_id,
            "source": f"https://github.com/{repository}/tree/{revision}/{root.rstrip('/')}",
            "origin": {"repository": repository, "commit": revision, "path": entry},
            "sha256": digest,
            "files": {p: builder.add_object(index["objects"], pack, data) for p, data in files.items()},
            "omittedResources": [p[len(root):] for p in blobs if p.startswith(root) and p not in resources],
            "runtime": {"manager": "uv", "scripts": scripts, "project": "pyproject.toml" in files,
                        **({"scriptDependencies": script_dependencies} if script_dependencies else {}),
                        **({"externalRequirements": ["Separate model checkout and its environment: " + ", ".join(external_entries)]}
                           if external_entries else {}),
                        "requiredCredentials": [], "optionalCredentials": ["NVIDIA_API_KEY","NGC_API_KEY"] if family == "bionemo" else []},
        })
    bundle_name = "bio-research" if family == "bio" else "bionemo" if family == "bionemo" else "personal-research"
    index["skills"] = [s for s in index["skills"] if s.get("bundle") != bundle_name] + imported
    index["sources"] = [s for s in index["sources"] if s["repository"] != repository] + [
        {"repository": repository, "commit": revision,
         "license": "Apache-2.0" if family == "bio" else "Apache-2.0 AND CC-BY-4.0 AND BSD-3-Clause" if family == "bionemo" else "Mixed; personal installation only"}]
    index["packSha256"] = hashlib.sha256(pack).hexdigest()
    (output / "library.pack").write_bytes(pack)
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"skills": len(imported), "resources": sum(len(s["files"]) for s in imported),
              "scripts": sum(len(s["runtime"]["scripts"]) for s in imported),
              "repository": repository, "commit": revision, "packBytes": len(pack),
              "personalOnly": family == "personal"}
    (output / "research-import-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", choices=SOURCES, required=True)
    for option in ["staging", "tree", "output", "cache"]:
        parser.add_argument("--" + option, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(import_skills(args.family, args.staging, args.tree, args.output, args.cache)))
