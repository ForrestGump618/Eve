"""Portable scientific skill adapter, executed only by the bound backend."""
from __future__ import annotations

import inspect
import json
from .skill_resources import prepare_resources


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
    bundle = payload["bundle"]
    name, version = bundle["name"], bundle["version"]
    runtime = bundle["runtime"]
    scripts = runtime.get("scripts", [])
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
    prepared = prepare_resources(payload["workspace"], bundle, "uv")
    workspace, target = pathlib.Path(prepared["workspace"]), pathlib.Path(prepared["directory"])
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
        "source": bundle["source"], "resourceDigest": prepared["resourceDigest"],
        "status": "prepared", "executed": False, "directory": str(target),
        "workspace": str(workspace), "scripts": scripts, "verifiedFiles": prepared["verifiedFiles"],
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
    return (inspect.getsource(prepare_resources) + "\n" + inspect.getsource(execute_bundle)
            + "\nprint(__import__('json').dumps(execute_bundle(__import__('json').loads("
            + repr(json.dumps(payload)) + "))))\n")
