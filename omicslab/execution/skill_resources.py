"""Content-addressed skill resources shared by portable execution adapters."""


def prepare_resources(workspace_value, bundle, manager):
    import hashlib
    import json
    import os
    import pathlib
    import re
    import shutil
    import tempfile
    import time

    workspace = pathlib.Path(workspace_value).expanduser().resolve(strict=True)
    name, version = bundle["name"], bundle["version"]
    if not re.fullmatch(r"science-[a-z0-9-]{1,100}" if manager == "uv" else r"archify", name):
        raise ValueError("Invalid skill name")
    if not re.fullmatch(r"[a-zA-Z0-9.+-]{1,100}", version):
        raise ValueError("Invalid skill version")
    runtime, files = bundle["runtime"], bundle["files"]
    if runtime.get("manager") != manager or not isinstance(files, list) or not 1 <= len(files) <= (100 if manager == "uv" else 400):
        raise ValueError("Invalid skill bundle")
    checked, total = {}, 0
    for entry in files:
        path, content = entry["path"], entry["content"]
        if (not isinstance(path, str) or not isinstance(content, str)
                or not re.fullmatch(r"[a-zA-Z0-9_./-]+", path)
                or any(p in {"", ".", ".."} for p in path.split("/"))
                or pathlib.PurePosixPath(path).is_absolute() or path in checked):
            raise ValueError("Invalid or duplicate resource path")
        data = content.encode("utf-8")
        total += len(data)
        if len(data) > 2_000_000 or total > (4_000_000 if manager == "uv" else 24_000_000):
            raise ValueError("Skill bundle exceeds resource budget")
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Resource digest mismatch")
        checked[path] = data
    if "SKILL.md" not in checked or hashlib.sha256(checked["SKILL.md"]).hexdigest() != bundle["sha256"]:
        raise ValueError("Skill instruction digest mismatch")
    scripts = runtime.get("scripts", [])
    if not isinstance(scripts, list) or any(p not in checked or (
            (not p.startswith("scripts/") or not p.endswith(".py")) if manager == "uv" else p != "bin/archify.mjs")
            for p in scripts):
        raise ValueError("Invalid declared skill entry point")
    cache = workspace
    for component in (".eve", "skills", name):
        cache = cache / component
        if cache.is_symlink() or (cache.exists() and not cache.is_dir()):
            raise ValueError("Skill cache is not a real workspace directory")
        cache.mkdir(exist_ok=True)
    digest = hashlib.sha256(json.dumps(sorted((p, hashlib.sha256(b).hexdigest()) for p, b in checked.items()),
                                      separators=(",", ":")).encode()).hexdigest()
    target = cache / f"{version}-{digest[:12]}"
    if target.is_symlink():
        raise ValueError("Skill cache is a symlink")
    if not target.exists():
        staging = pathlib.Path(tempfile.mkdtemp(prefix=".prepare-", dir=cache))
        try:
            for path, data in checked.items():
                destination = staging / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            for attempt in range(5):
                try:
                    staging.rename(target)
                    break
                except OSError:
                    if target.is_dir() and not target.is_symlink():
                        break
                    if os.name != "nt" or attempt == 4:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    for path, data in checked.items():
        destination = target / path
        if (any(p.is_symlink() for p in [destination, *destination.parents] if p != workspace)
                or not destination.resolve().is_relative_to(target)
                or not destination.is_file() or destination.read_bytes() != data):
            raise ValueError("Prepared resource changed; refusing to overwrite or execute")
    return {"directory": str(target), "workspace": str(workspace), "resourceDigest": digest,
            "verifiedFiles": len(checked)}
