"""Build a pinned, deduplicated library without executing upstream code."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import yaml

SOURCES = [
    ("scientific-source", "K-Dense-AI/scientific-agent-skills", "skills/", "LICENSE.md"),
    ("superpowers", "obra/superpowers", "skills/", "LICENSE"),
    ("deepscientist-source", "ResearAI/DeepScientist", "src/skills/", "LICENSE"),
    ("community", "ComposioHQ/awesome-codex-skills", "", None),
    ("medical-source", "FreedomIntelligence/OpenClaw-Medical-Skills", "skills/", None),
    ("mineru-source", "opendatalab/MinerU", "skills/", "LICENSE.md"),
]
SKIP = {".git", "node_modules", "__pycache__", ".venv", "repo", "data", "datasets", "tests"}
TEXT_EXT = {".md", ".txt", ".py", ".js", ".mjs", ".ts", ".json", ".yaml", ".yml",
            ".toml", ".csv", ".r", ".sh", ".svg", ".tex", ".bib", ".sty", ".mplstyle", ".xml"}


def metadata(text: str) -> dict:
    match = re.search(r"(?:^|\n)---\s*\n(.*?)\n---", text, re.S)
    if match:
        try:
            value = yaml.safe_load(match.group(1))
            if isinstance(value, dict):
                return value
        except yaml.YAMLError:
            pass
    return {}


def add_object(objects: dict, pack: bytearray, data: bytes) -> str:
    sha = hashlib.sha256(data).hexdigest()
    if sha not in objects:
        compressed = gzip.compress(data, compresslevel=9, mtime=0)
        objects[sha] = {"offset": len(pack), "length": len(compressed), "bytes": len(data)}
        pack.extend(compressed)
    return sha


def import_sparse_skill(cache: Path, folder: str, repo: str, entry: str, license_path: str) -> tuple[dict, list[dict]]:
    """Read an exact commit without asking a partial clone to fetch every blob.

    A `blob:none` cache may have only the selected tree entries. `git show`
    fetches just the requested blobs, while `git archive` can request unrelated
    historical blobs and fail behind restrictive networks.
    """
    root = cache / folder
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    skill_text = subprocess.check_output(
        ["git", "-C", str(root), "show", f"{commit}:{entry}"],
        env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"},
    )
    license_text = subprocess.check_output(
        ["git", "-C", str(root), "show", f"{commit}:{license_path}"],
        env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"},
    )
    text = skill_text.decode("utf-8", errors="strict")
    meta = metadata(text)
    name = str(meta.get("name") or PurePosixPath(entry).parent.name)
    normalized = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    declared = str(meta.get("license") or "")
    root_id = "Apache-2.0" if re.search(
        r"Apache License(?:\s+Version)?\s+2\.0",
        license_text.decode("utf-8", "replace"),
        re.I,
    ) else None
    return (
        {"name": name, "normalized": normalized, "text": text, "meta": meta,
         "declared": declared, "root_id": root_id, "skill_text": skill_text,
         "license_text": license_text, "commit": commit, "repo": repo,
         "skill_root": str(PurePosixPath(entry).parent)},
        [{"repository": repo, "commit": commit, "license": root_id}],
    )


def build(cache: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    objects, skills, decisions, sources = {}, [], [], []
    seen, content_seen = {}, {}
    pack = bytearray()
    raw_bytes = 0
    for folder, repo, prefix, license_path in SOURCES:
        root = cache / folder
        commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        if folder == "mineru-source":
            imported, source_records = import_sparse_skill(cache, folder, repo, "skills/mineru/SKILL.md", license_path or "LICENSE.md")
            sources.extend(source_records)
            entry = "skills/mineru/SKILL.md"
            skill_root = imported["skill_root"]
            text = imported["text"]
            meta = imported["meta"]
            name = imported["name"]
            normalized = imported["normalized"]
            digest = hashlib.sha256(text.encode()).hexdigest()
            files = {"SKILL.md": add_object(objects, pack, imported["skill_text"]),
                     "EVE-UPSTREAM-LICENSE.txt": add_object(objects, pack, imported["license_text"])}
            description = str(meta.get("description") or name)[:1600]
            skills.append({"id": f"builtin:{normalized[:80]}:{digest[:12]}", "name": name,
                           "description": description, "version": f"git-{commit[:12]}",
                           "source": f"https://github.com/{repo}/tree/{commit}/{skill_root}",
                           "license": imported["root_id"], "sha256": digest, "files": files,
                           "omittedResources": [],
                           "origin": {"repository": repo, "commit": commit, "path": entry}})
            seen[normalized] = skills[-1]["id"]
            content_seen[digest] = skills[-1]["id"]
            raw_bytes += len(imported["skill_text"]) + len(imported["license_text"])
            continue
        with tempfile.TemporaryDirectory(prefix="eve-skill-import-") as staging:
            archive = Path(staging) / "source.zip"
            subprocess.run(["git", "-C", str(root), "archive", "--format=zip", "-o", str(archive), commit],
                           env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}, check=True)
            with zipfile.ZipFile(archive) as z:
                names = set(z.namelist())
                root_license = z.read(license_path).decode("utf-8") if license_path else None
                root_id = ("Apache-2.0" if re.search(r"Apache License(?:\s+Version)?\s+2\.0", root_license or "", re.I)
                           else "MIT" if root_license and "Permission is hereby granted, free of charge" in root_license
                           else "BSD-3-Clause" if root_license and re.search(r"BSD 3-Clause", root_license, re.I)
                           else None)
                sources.append({"repository": repo, "commit": commit, "license": root_id})
                entries = sorted(n for n in names if n.startswith(prefix) and n.endswith("/SKILL.md")
                                 and not any(p in SKIP or p.startswith(".") for p in PurePosixPath(n).parts))
                for entry in entries:
                    skill_root = entry[:-8]
                    text = z.read(entry).decode("utf-8", errors="replace")
                    meta = metadata(text)
                    name = str(meta.get("name") or PurePosixPath(skill_root).name)
                    normalized = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                    digest = hashlib.sha256(text.encode()).hexdigest()
                    origin = {"repository": repo, "commit": commit, "path": entry}
                    if normalized in seen or digest in content_seen:
                        decisions.append({**origin, "name": name, "decision": "duplicate",
                                          "selected": seen.get(normalized) or content_seen[digest]})
                        continue
                    # Respect explicit third-party notices instead of assuming the
                    # aggregator homepage grants rights over every copied skill.
                    own_license = [n for n in names if n.startswith(skill_root)
                                   and PurePosixPath(n).name.lower() in {"license", "license.txt", "license.md"}]
                    license_text = "\n".join(z.read(n).decode("utf-8", errors="replace") for n in own_license)
                    declared = str(meta.get("license") or "")
                    # Mentions of confidential *user data* or a third-party
                    # product are not copyright notices for this skill.
                    restricted = re.search(
                        r"(?:proprietary\s*(?:&|and)\s*confidential|"
                        r"unauthorized copying|this (?:skill|software|material).{0,80}(?:proprietary|confidential)|"
                        r"license\s*:\s*(?:proprietary|.*non.?commercial))",
                        text[:2500] + "\nlicense: " + declared, re.I)
                    detected = ("Apache-2.0" if re.search(r"Apache License(?:\s+Version)?\s+2\.0", license_text, re.I)
                                else "MIT" if "Permission is hereby granted, free of charge" in license_text
                                else "")
                    if not re.search(r"\bMIT\b|\bApache[- ]2\.0\b|\bBSD\b", declared + license_text + detected, re.I):
                        restricted = restricted or re.search(r"non.?commercial|all rights reserved", license_text, re.I)
                    permissive = re.search(r"\bMIT\b|\bApache[- ]2\.0\b|\bCC0[- ]1\.0\b|\bBSD[- ]3[- ]Clause\b",
                                           declared + license_text + detected, re.I)
                    if restricted or (not root_license and not permissive):
                        decisions.append({**origin, "name": name, "decision": "not-redistributed",
                                          "reason": "restricted notice" if restricted else "no explicit redistribution license"})
                        continue
                    files, omitted = {}, []
                    for path in sorted(n for n in names if n.startswith(skill_root) and not n.endswith("/")):
                        rel = path[len(skill_root):]
                        if any(p in SKIP or p.startswith(".") for p in PurePosixPath(rel).parts):
                            continue
                        data = z.read(path)
                        if PurePosixPath(path).suffix.lower() not in TEXT_EXT or len(data) > 2_000_000 or data.startswith(b"version https://git-lfs"):
                            omitted.append(rel)
                            continue
                        try:
                            data.decode("utf-8")
                        except UnicodeDecodeError:
                            omitted.append(rel)
                            continue
                        sha = hashlib.sha256(data).hexdigest()
                        raw_bytes += len(data)
                        if sha not in objects:
                            compressed = gzip.compress(data, compresslevel=9, mtime=0)
                            objects[sha] = {"offset": len(pack), "length": len(compressed), "bytes": len(data)}
                            pack.extend(compressed)
                        files[rel] = sha
                    if root_license and "EVE-UPSTREAM-LICENSE.txt" not in files:
                        data = root_license.encode()
                        sha = hashlib.sha256(data).hexdigest()
                        if sha not in objects:
                            compressed = gzip.compress(data, compresslevel=9, mtime=0)
                            objects[sha] = {"offset": len(pack), "length": len(compressed), "bytes": len(data)}
                            pack.extend(compressed)
                        files["EVE-UPSTREAM-LICENSE.txt"] = sha
                    if "SKILL.md" not in files:
                        raise ValueError(f"Missing packed entry: {entry}")
                    skill_id = f"builtin:{normalized[:80]}:{digest[:12]}"
                    seen[normalized] = skill_id
                    content_seen[digest] = skill_id
                    description = str(meta.get("description") or name)[:1600]
                    skills.append({"id": skill_id, "name": name, "description": description,
                                   "version": f"git-{commit[:12]}", "source": f"https://github.com/{repo}/tree/{commit}/{skill_root.rstrip('/')}",
                                   "license": detected or declared or root_id, "sha256": digest, "files": files,
                                   "omittedResources": omitted, "origin": origin})
    index = {"version": 1, "sources": sources, "skills": skills, "objects": objects,
             "packSha256": hashlib.sha256(pack).hexdigest()}
    (output / "library.pack").write_bytes(pack)
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    summary = {"skills": len(skills), "uniqueFiles": len(objects), "rawBytes": raw_bytes,
               "packBytes": len(pack), "sources": sources, "decisions": decisions}
    (output / "import-report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "decisions"}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "skill-library")
    args = parser.parse_args()
    build(args.cache, args.output)
    science = args.cache / "science-skills-source"
    if science.is_dir():
        subprocess.run([sys.executable, str(Path(__file__).with_name("import-science-skills.py")),
                        "--checkout", str(science), "--output", str(args.output)], check=True)
