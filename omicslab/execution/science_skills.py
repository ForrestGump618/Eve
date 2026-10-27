"""Portable scientific skill adapter, executed only by the bound backend."""
from __future__ import annotations

import inspect
import json


def execute_bundle(payload: dict) -> dict:
    import hashlib
    import importlib.util
    import json
    import os
    import pathlib
    import re
    import shutil
    import signal
    import subprocess
    import sys
    import tempfile
    import time

    started = time.monotonic()
    workspace = pathlib.Path(payload["workspace"]).expanduser().resolve(strict=True)
    bundle = payload["bundle"]
    name, version = bundle["name"], bundle["version"]
    if not re.fullmatch(r"science-[a-z0-9-]{1,100}", name):
        raise ValueError("Invalid scientific skill name")
    if not re.fullmatch(r"[a-zA-Z0-9.+-]{1,100}", version):
        raise ValueError("Invalid scientific skill version")
    runtime, files = bundle["runtime"], bundle["files"]
    if runtime.get("manager") != "uv" or not isinstance(files, list) or not 1 <= len(files) <= 100:
        raise ValueError("Invalid scientific skill bundle")
    checked, total = {}, 0
    for entry in files:
        path, content = entry["path"], entry["content"]
        if (not isinstance(path, str) or not isinstance(content, str)
                or not re.fullmatch(r"[a-zA-Z0-9_./-]+", path)
                or any(p in {"", ".", ".."} for p in path.split("/"))
                or pathlib.PurePosixPath(path).is_absolute() or path in checked):
            raise ValueError("Invalid or duplicate scientific resource path")
        data = content.encode("utf-8")
        total += len(data)
        if len(data) > 2_000_000 or total > 4_000_000:
            raise ValueError("Scientific bundle exceeds resource budget")
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Scientific resource digest mismatch")
        checked[path] = data
    if "SKILL.md" not in checked or hashlib.sha256(checked["SKILL.md"]).hexdigest() != bundle["sha256"]:
        raise ValueError("Scientific skill instruction digest mismatch")
    scripts = runtime.get("scripts", [])
    if not isinstance(scripts, list) or any(p not in checked or not p.startswith("scripts/") or not p.endswith(".py") for p in scripts):
        raise ValueError("Invalid declared scientific entry point")
    input_data = payload.get("input") or {}
    if not isinstance(input_data, dict) or set(input_data) - {"script", "args", "allowDependencyInstall", "timeoutSeconds"}:
        raise ValueError("Invalid scientific skill input")
    script, args = input_data.get("script"), input_data.get("args", [])
    execute = payload.get("operation") == "run"
    if execute and (script not in scripts or not isinstance(args, list) or len(args) > 60
                    or any(not isinstance(a, str) or len(a) > 4000 or any(c in a for c in "\0\r\n") for a in args)):
        raise ValueError("Select a declared scientific script and bounded string arguments")
    allow_install = input_data.get("allowDependencyInstall", False)
    timeout = input_data.get("timeoutSeconds", 90)
    if type(allow_install) is not bool or type(timeout) not in (int, float) or not 1 <= timeout <= 120:
        raise ValueError("Invalid scientific execution policy")
    # Never follow an existing cache link out of the selected workspace.
    cache = workspace
    for component in (".eve", "skills", name):
        cache = cache / component
        if cache.is_symlink() or (cache.exists() and not cache.is_dir()):
            raise ValueError("Scientific cache is not a real workspace directory")
        cache.mkdir(exist_ok=True)
    resource_digest = hashlib.sha256(json.dumps(
        sorted((p, hashlib.sha256(b).hexdigest()) for p, b in checked.items()),
        separators=(",", ":")).encode()).hexdigest()
    target = cache / f"{version}-{resource_digest[:12]}"
    if target.is_symlink():
        raise ValueError("Scientific cache is a symlink")
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
                    # Windows scanners can briefly hold a newly written script open.
                    time.sleep(0.05 * (attempt + 1))
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    for path, data in checked.items():
        destination = target / path
        if (any(p.is_symlink() for p in [destination, *destination.parents] if p != workspace)
                or not destination.resolve().is_relative_to(target)
                or not destination.is_file() or destination.read_bytes() != data):
            raise ValueError("Prepared scientific resource changed; refusing to overwrite or execute")
    uv = shutil.which("uv")
    if not uv:
        candidate = pathlib.Path.home() / ".local" / "bin" / ("uv.exe" if os.name == "nt" else "uv")
        if candidate.is_file():
            uv = str(candidate)
    if not uv and os.name == "nt" and os.environ.get("APPDATA"):
        # A desktop-launched interpreter can disable user-site imports and omit
        # the pip Scripts directory from PATH; the native uv binary still works.
        candidates = sorted((pathlib.Path(os.environ["APPDATA"]) / "Python").glob("Python*/Scripts/uv.exe"))
        uv = next((str(p) for p in reversed(candidates) if p.is_file()), None)
    uv_command = [uv] if uv else ([sys.executable, "-m", "uv"] if importlib.util.find_spec("uv") else [])
    # Read credentials into the process only. Return presence flags, never values.
    required, optional = runtime.get("requiredCredentials", []), runtime.get("optionalCredentials", [])
    if any(not re.fullmatch(r"[A-Z][A-Z0-9_]{0,80}", k) for k in [*required, *optional]):
        raise ValueError("Invalid scientific credential declaration")
    env = os.environ.copy()
    for env_file in (pathlib.Path.home() / ".env", workspace / ".env"):
        if env_file.is_file() and env_file.stat().st_size <= 1_000_000:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                match = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
                if match and match[1] in [*required, *optional] and not env.get(match[1]):
                    env[match[1]] = match[2].strip("\"'")
    credentials = {k: bool(env.get(k)) for k in [*required, *optional]}
    result = {
        "skillId": bundle["id"], "version": version, "sha256": bundle["sha256"],
        "source": bundle["source"], "resourceDigest": resource_digest,
        "status": "prepared", "executed": False, "directory": str(target),
        "workspace": str(workspace), "scripts": scripts, "verifiedFiles": len(checked),
        "runtime": {"uvAvailable": bool(uv_command), "installHint": None if uv_command else "python -m pip install --user uv==0.13.6",
                    "requiredCredentials": required,
                    "optionalCredentials": optional, "credentialPresence": credentials},
    }
    if not execute:
        return result
    missing = [k for k in required if not credentials[k]]
    if not uv_command or missing:
        return {**result, "status": "blocked", "error": "Missing uv runtime" if not uv_command else "Missing required credentials",
                "missingCredentials": missing}
    command = uv_command + ["run", "--no-config", "--no-env-file"]
    if not allow_install:
        command += ["--offline"]
    if runtime.get("project"):
        command += ["--project", str(target)]
    else:
        command += ["--no-project", "--script"]
    command += [str(target / script), *args]
    # Output paths remain relative to the selected workspace; resources are immutable.
    env["UV_NO_PROGRESS"] = "1"
    timed_out = False
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(command, cwd=workspace, env=env, stdout=out, stderr=err,
                                stdin=subprocess.DEVNULL, start_new_session=os.name != "nt")
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            if proc.poll() is None:
                if os.name != "nt":
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
                    if proc.poll() is None:
                        proc.kill()
                proc.wait(timeout=5)
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(28001), err.read(28001)
    clipped = len(stdout) > 28000 or len(stderr) > 28000
    def redact(data):
        text = data[:28000].decode("utf-8", "replace")
        for key in credentials:
            if env.get(key):
                text = text.replace(env[key], "[REDACTED]")
        return text
    ok = proc.returncode == 0 and not timed_out and not clipped
    return {**result, "status": "executed" if ok else "failed", "executed": True, "ok": ok,
            "exitCode": proc.returncode, "timedOut": timed_out, "truncated": clipped,
            "stdout": redact(stdout), "stderr": redact(stderr),
            "durationMs": round((time.monotonic() - started) * 1000),
            "dependencyNetworkAllowed": allow_install}


def runtime_source(bundle: dict, workspace: str, *, input_data: dict | None = None, run: bool = False) -> str:
    payload = {"bundle": bundle, "workspace": workspace, "input": input_data,
               "operation": "run" if run else "prepare"}
    return (inspect.getsource(execute_bundle)
            + "\nprint(__import__('json').dumps(execute_bundle(__import__('json').loads("
            + repr(json.dumps(payload)) + "))))\n")
