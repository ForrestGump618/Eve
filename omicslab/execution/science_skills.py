"""Portable scientific skill adapter, executed only by the bound backend."""
from __future__ import annotations

import inspect
import json
from .skill_resources import prepare_resources
from .science_policy import OUTPUT_POLICY


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
    output_policy = payload.get('outputPolicy') or OUTPUT_POLICY
    bundle = payload["bundle"]
    name, version = bundle["name"], bundle["version"]
    runtime = bundle["runtime"]
    scripts = runtime.get("scripts", [])
    input_data = payload.get("input") or {}
    if not isinstance(input_data, dict) or set(input_data) - {"script", "args", "stdin", "allowDependencyInstall", "timeoutSeconds"}:
        raise ValueError("Invalid scientific skill input")
    stdin_data = input_data.get("stdin")
    if stdin_data is not None and (not isinstance(stdin_data, dict) or len(json.dumps(stdin_data)) > 28000):
        raise ValueError("Scientific stdin must be a bounded JSON object")
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
        "externalRequirements": runtime.get("externalRequirements", []),
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
    script_dependencies = runtime.get("scriptDependencies", {}).get(script)
    if script_dependencies is not None:
        if (not isinstance(script_dependencies, list) or len(script_dependencies) > 20
                or any(not isinstance(p, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:==[A-Za-z0-9_.+-]+)?", p) for p in script_dependencies)):
            raise ValueError("Invalid declared script dependencies")
        command += ["--no-project"]
        for dependency in script_dependencies:
            command += ["--with", dependency]
        command += ["--script"]
    elif runtime.get("project"):
        command += ["--project", str(target)]
    else:
        command += ["--no-project", "--script"]
    command += [str(target / script), *args]
    output_paths = []
    for index, argument in enumerate(args):
        value = None
        if argument in output_policy['output_flags']:
            if index + 1 >= len(args):
                raise ValueError('Scientific output flag requires a path')
            value = args[index + 1]
        elif any(argument.startswith(flag + '=') for flag in output_policy['output_flags']):
            value = argument.split('=', 1)[1]
        if value:
            path = (workspace / value).resolve()
            if (not path.is_relative_to(workspace) or path == workspace or path.is_relative_to(workspace / '.eve')
                    or path.is_symlink()):
                raise ValueError('Scientific output path must stay inside the workspace')
            before = path.stat() if path.is_file() else None
            stamp = (before.st_mtime_ns, before.st_ctime_ns, before.st_size) if before else None
            output_paths.append((path, stamp))
    # Output paths remain relative to the selected workspace; resources are immutable.
    env["UV_NO_PROGRESS"] = "1"
    timed_out = False
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err, tempfile.TemporaryFile() as inp:
        if stdin_data is not None:
            inp.write(json.dumps(stdin_data).encode("utf-8"))
            inp.seek(0)
        proc = subprocess.Popen(command, cwd=workspace, env=env, stdout=out, stderr=err,
                                stdin=inp if stdin_data is not None else subprocess.DEVNULL, start_new_session=os.name != "nt")
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
    artifact_evidence = []
    if proc.returncode == 0 and not timed_out and not clipped and not stdout.strip():
        for path, before in output_paths:
            # Stale pre-existing files cannot turn a silent no-op into success.
            if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(workspace):
                continue
            stat = path.stat()
            stamp = (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
            if stamp == before or not 0 < stat.st_size <= output_policy['artifact_bytes']:
                continue
            data = path.read_bytes()
            artifact_evidence.append({'path': path.relative_to(workspace).as_posix(),
                                      'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'fresh': True})
            observed = {'artifactEvidence': artifact_evidence}
            try:
                observed['output'] = json.loads(data.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                pass
            encoded = json.dumps(observed).encode('utf-8')
            if len(encoded) <= output_policy['stdout_bytes']:
                stdout = encoded
            else:
                stdout = json.dumps({'artifactEvidence': artifact_evidence}).encode('utf-8')
            break
    ok = proc.returncode == 0 and not timed_out and not clipped and bool(stdout.strip())
    structured = None
    if not clipped:
        try:
            structured = json.loads(stdout.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            pass
    if isinstance(structured, dict) and (
            structured.get("ok") is False or structured.get("error")
            or structured.get("status") in {"failed", "error", "blocked"}):
        ok = False
    artifact_output = structured.get('output') if isinstance(structured, dict) else None
    if isinstance(artifact_output, dict) and (
            artifact_output.get('ok') is False or artifact_output.get('error')
            or artifact_output.get('status') in {'failed', 'error', 'blocked'}):
        ok = False
    return {**result, "status": "executed" if ok else "failed", "executed": True, "ok": ok,
            "error": "No scientific output was returned; artifact verification is required" if not stdout.strip() and proc.returncode == 0 else None,
            "exitCode": proc.returncode, "timedOut": timed_out, "truncated": clipped,
            "stdout": redact(stdout), "stderr": redact(stderr),
            "artifactEvidence": artifact_evidence,
            "durationMs": round((time.monotonic() - started) * 1000),
            "dependencyNetworkAllowed": allow_install}


def runtime_source(bundle: dict, workspace: str, *, input_data: dict | None = None, run: bool = False) -> str:
    payload = {"bundle": bundle, "workspace": workspace, "input": input_data, "outputPolicy": OUTPUT_POLICY,
               "operation": "run" if run else "prepare"}
    return (inspect.getsource(prepare_resources) + "\n" + inspect.getsource(execute_bundle)
            + "\nprint(__import__('json').dumps(execute_bundle(__import__('json').loads("
            + repr(json.dumps(payload)) + "))))\n")
