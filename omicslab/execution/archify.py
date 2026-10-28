"""Portable Node adapter; validation and rendering stay in the bound workspace."""
from __future__ import annotations

import inspect
import json
from .skill_resources import prepare_resources


def execute_archify(payload):
    import base64
    import gzip
    import hashlib
    import io
    import json
    import os
    import pathlib
    import re
    import shutil
    import signal
    import subprocess
    import tempfile
    import time

    started = time.monotonic()
    packed = payload["bundle"]
    encoded = packed["archive"]
    if not isinstance(encoded, str) or len(encoded) > 8_000_000:
        raise ValueError("Archify resource archive exceeds budget")
    compressed = base64.b64decode(encoded, validate=True)
    if hashlib.sha256(compressed).hexdigest() != packed["archiveSha256"]:
        raise ValueError("Archify archive digest mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as archive:
        raw = archive.read(24_000_001)
    if len(raw) > 24_000_000:
        raise ValueError("Archify expanded resources exceed budget")
    bundle = {**packed, "files": json.loads(raw)}
    prepared = prepare_resources(payload["workspace"], bundle, "node")
    workspace, directory = pathlib.Path(prepared["workspace"]), pathlib.Path(prepared["directory"])
    node = shutil.which("node")
    node_version = ""
    hidden_process = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    if node:
        try:
            node_version = subprocess.check_output([node, "--version"], timeout=5, text=True, **hidden_process).strip()
        except (OSError, subprocess.SubprocessError):
            node = None
    if node and (not re.fullmatch(r"v\d+\.\d+\.\d+", node_version) or int(node_version[1:].split(".")[0]) < 18):
        node = None
    result = {**prepared, "skillId": bundle["id"], "version": bundle["version"],
              "sha256": bundle["sha256"], "source": bundle["source"], "status": "prepared", "executed": False,
              "runtime": {"manager": "node", "nodeAvailable": bool(node), "nodeVersion": node_version,
                          "browserRequirement": "Chrome/Chromium or Edge on the execution host; required by finalize"},
              "entry": str(directory / "bin/archify.mjs")}
    if payload.get("operation") != "run":
        return result
    if not node:
        return {**result, "ok": False, "status": "blocked", "error": "Node.js >=18 is required on the execution host"}
    args = payload.get("input") or {}
    if not isinstance(args, dict) or set(args) - {"command", "type", "candidate", "output", "quality", "outDir", "repoRoot", "timeoutSeconds"}:
        raise ValueError("Invalid Archify input")
    command = args.get("command", "finalize")
    diagram_type = args.get("type")
    if command not in {"finalize", "validate", "check"}:
        raise ValueError("Use finalize, validate or check; shell arguments are not accepted")
    if command != "check" and diagram_type not in {
            "architecture", "workflow", "sequence", "dataflow", "lifecycle", "erd", "class", "tree", "timeline", "waterfall", "explainer"}:
        raise ValueError("Invalid Archify diagram type")
    quality = args.get("quality", "showcase")
    if quality not in {"showcase", "standard"}:
        raise ValueError("Invalid Archify quality")
    timeout = args.get("timeoutSeconds", 120)
    if type(timeout) not in (int, float) or not 1 <= timeout <= 120:
        raise ValueError("Invalid Archify timeout")

    def safe_path(value, *, output=False):
        if not isinstance(value, str) or not value or len(value) > 2000 or any(c in value for c in "\0\r\n"):
            raise ValueError("Invalid workspace path")
        normalized = value.replace("\\", "/")
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
            raise ValueError("Only workspace-relative paths are accepted")
        path = (workspace / normalized).resolve()
        if not path.is_relative_to(workspace) or output and path.is_relative_to(workspace / ".eve"):
            raise ValueError("Path escapes workspace or overwrites managed resources")
        return path

    output = safe_path(args.get("output"), output=True) if command in {"finalize", "check"} else None
    if output and output.suffix.lower() != ".html":
        raise ValueError("HTML output is required")
    argv = [node, str(directory / "bin/archify.mjs"), command]
    if command == "check":
        argv += [str(output), "--strict", "--json"]
    else:
        candidate = safe_path(args.get("candidate"))
        if not candidate.is_file() or candidate.stat().st_size > 2_000_000:
            raise ValueError("Candidate missing or exceeds budget")
        if candidate.suffix == ".json":
            candidate_data = json.loads(candidate.read_text(encoding="utf-8"))
            declared = candidate_data.get("meta", {}).get("output")
            if declared:
                safe_path(declared, output=True)
                if diagram_type == "explainer" and ("/" in declared or "\\" in declared):
                    raise ValueError("Explainer meta.output must be a filename; set the destination directory in input.output")
        argv += [diagram_type, str(candidate)]
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            argv.append(str(output))
        argv += ["--quality", quality, "--json"]
        if args.get("repoRoot"):
            argv += ["--repo-root", str(safe_path(args["repoRoot"]))]
        if command == "finalize" and args.get("outDir"):
            argv += ["--out-dir", str(safe_path(args["outDir"], output=True))]
        if command == "finalize":
            # Pure-text explainers skip browser checks by upstream default.
            # Eve delivers a clickable page, so verify its real reader too.
            argv += ["--browser-check"]
    env = os.environ.copy()
    env["ARCHIFY_UPDATE_CACHE_DIRECTORY"] = str(workspace / ".eve" / "archify-update-cache")
    timed_out = False
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        proc = subprocess.Popen(argv, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                                stdout=stdout_file, stderr=stderr_file, start_new_session=os.name != "nt", **hidden_process)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            if proc.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False, **hidden_process)
                    if proc.poll() is None:
                        proc.kill()
                else:
                    os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout, stderr = stdout_file.read(28001), stderr_file.read(28001)
    truncated = len(stdout) > 28000 or len(stderr) > 28000
    receipt = None
    try:
        receipt = json.loads(stdout)
    except (ValueError, UnicodeDecodeError):
        pass
    ok = proc.returncode == 0 and not timed_out and not truncated and isinstance(receipt, dict) and (
        receipt.get("ok") is True or receipt.get("status") in {"pass", "passed"})
    if ok and command == "finalize":
        ok = (receipt.get("browserCheck", {}).get("ran") is True
              and all(receipt.get("gates", {}).get(gate) == "pass"
                      for gate in ("validate", "deliver", "check", "browser-check")))
    artifact = None
    if ok and command in {"check", "finalize"}:
        if not output.is_file() or not 0 < output.stat().st_size <= 2_000_000 or not output.resolve().is_relative_to(workspace):
            ok = False
        else:
            data = output.read_bytes()
            relative = output.relative_to(workspace).as_posix()
            artifact = {"path": relative, "sha256": hashlib.sha256(data).hexdigest(),
                        "bytes": len(data), "link": "eve-artifact:" + __import__("urllib.parse", fromlist=["quote"]).quote(relative)}
    return {**result, "status": "passed" if ok else "failed", "ok": ok, "executed": True,
            "exitCode": proc.returncode, "timedOut": timed_out, "truncated": truncated,
            "receipt": receipt, "artifact": artifact, "durationMs": round((time.monotonic()-started)*1000),
            "stdout": stdout[:28000].decode("utf-8", "replace") if receipt is None else "",
            "stderr": stderr[:28000].decode("utf-8", "replace"),
            "visualReview": "not-performed"}


def runtime_source(bundle, workspace, *, input_data=None, run=False):
    payload = {"bundle": bundle, "workspace": workspace, "input": input_data, "operation": "run" if run else "prepare"}
    return (inspect.getsource(prepare_resources) + "\n" + inspect.getsource(execute_archify)
            + "\nprint(__import__('json').dumps(execute_archify(__import__('json').loads("
            + repr(json.dumps(payload)) + "))))\n")
