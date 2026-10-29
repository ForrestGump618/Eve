"""Real filesystem/process checks for scientific runtime preparation and execution."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from omicslab.execution.science_skills import execute_bundle, runtime_source
from omicslab.server.routes_harness import backend_stdout, execute_backend


def test_local_kernel_stdout_normalization_preserves_order_and_excludes_stderr():
    assert backend_stdout({"outputs": [
        {"type": "stream", "name": "stdout", "text": '{"result":'},
        {"type": "stream", "name": "stderr", "text": "warning"},
        {"type": "stream", "name": "stdout", "text": "42}"},
    ]}) == '{"result":42}'
    assert backend_stdout({"stdout": "ssh"}) == "ssh"


def bundle(script=None, required=None):
    content = script or (
        '# /// script\n# requires-python = ">=3.10"\n# dependencies = []\n# ///\n'
        'import json,pathlib,sys\n'
        'pathlib.Path("science-result.json").write_text(json.dumps({"value":42}))\n'
        'print(json.dumps({"value":42,"cwd":str(pathlib.Path.cwd()),"args":sys.argv[1:]}))\n')
    files = {"SKILL.md": "# Scientific fixture\nRun a bounded local analysis.", "scripts/analyze.py": content}
    return {"id": "fixture-science", "name": "science-fixture", "version": "1.0.0",
            "sha256": hashlib.sha256(files["SKILL.md"].encode()).hexdigest(), "source": "fixture",
            "runtime": {"manager": "uv", "scripts": ["scripts/analyze.py"], "project": False,
                        "requiredCredentials": required or [], "optionalCredentials": ["NCBI_API_KEY"]},
            "files": [{"path": p, "content": c, "sha256": hashlib.sha256(c.encode()).hexdigest()} for p, c in files.items()]}


def payload(root, data=None, run=False, **input_data):
    return {"workspace": str(root), "bundle": data or bundle(), "operation": "run" if run else "prepare", "input": input_data}


def test_prepare_is_verified_idempotent_and_refuses_user_changes(tmp_path):
    prepared = execute_bundle(payload(tmp_path))
    assert prepared["status"] == "prepared" and prepared["executed"] is False
    assert prepared["verifiedFiles"] == 2
    assert execute_bundle(payload(tmp_path))["directory"] == prepared["directory"]
    entry = Path(prepared["directory"]) / "scripts/analyze.py"
    entry.write_text("raise RuntimeError('unreviewed edit')", encoding="utf-8")
    with pytest.raises(ValueError, match="changed"):
        execute_bundle(payload(tmp_path))
    assert entry.read_text().startswith("raise")


@pytest.mark.parametrize("path", ["../outside.py", "/absolute.py", "scripts/../../outside.py", "C:/escape.py", "scripts\\bad.py"])
def test_preparation_rejects_path_escapes_before_writing(tmp_path, path):
    data = bundle()
    data["files"][1]["path"] = path
    with pytest.raises(ValueError, match="path"):
        execute_bundle(payload(tmp_path, data))
    assert not (tmp_path / ".eve").exists()


def test_preparation_rejects_hash_mismatch_and_undeclared_script(tmp_path):
    data = bundle()
    data["files"][1]["content"] += "\n# tampered"
    with pytest.raises(ValueError, match="digest"):
        execute_bundle(payload(tmp_path, data))
    with pytest.raises(ValueError, match="declared"):
        execute_bundle(payload(tmp_path, run=True, script="other.py"))


def test_credentials_never_enter_observations_and_optional_keys_do_not_block(tmp_path, monkeypatch):
    monkeypatch.delenv("ALPHAGENOME_API_KEY", raising=False)
    monkeypatch.delenv("NCBI_API_KEY", raising=False)
    # Isolate the process home so the test never reads real user credentials.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    (tmp_path / ".env").write_text('ALPHAGENOME_API_KEY="SECRET_ONLY_IN_PROCESS"\n', encoding="utf-8")
    prepared = execute_bundle(payload(tmp_path, bundle(required=["ALPHAGENOME_API_KEY"])))
    assert prepared["runtime"]["credentialPresence"] == {"ALPHAGENOME_API_KEY": True, "NCBI_API_KEY": False}
    assert "SECRET_ONLY_IN_PROCESS" not in json.dumps(prepared)


def test_missing_required_credential_blocks_execution(tmp_path, monkeypatch):
    monkeypatch.delenv("ALPHAGENOME_API_KEY", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    result = execute_bundle(payload(tmp_path, bundle(required=["ALPHAGENOME_API_KEY"]),
                                    run=True, script="scripts/analyze.py"))
    assert result["status"] == "blocked" and not result["executed"]
    assert result["missingCredentials"] == ["ALPHAGENOME_API_KEY"]
    assert not (tmp_path / "science-result.json").exists()


def test_real_uv_execution_is_offline_and_output_uses_workspace(tmp_path):
    result = execute_bundle(payload(tmp_path, run=True, script="scripts/analyze.py", args=["literal; not shell"]))
    assert result.get("ok") is True, result
    assert result["dependencyNetworkAllowed"] is False
    stdout = json.loads(result["stdout"])
    assert stdout["args"] == ["literal; not shell"] and Path(stdout["cwd"]) == tmp_path
    assert json.loads((tmp_path / "science-result.json").read_text()) == {"value": 42}


def test_silent_script_requires_fresh_verified_output_artifact(tmp_path):
    script = ('# /// script\n# dependencies = []\n# ///\n'
              'import pathlib,sys\npathlib.Path(sys.argv[2]).write_text(\'{"gene":"TNF"}\')\n')
    result = execute_bundle(payload(tmp_path, bundle(script), run=True,
                                    script='scripts/analyze.py', args=['--output', 'result.json']))
    assert result['ok'] is True, result
    assert result['artifactEvidence'][0]['sha256'] == hashlib.sha256(b'{"gene":"TNF"}').hexdigest()
    assert json.loads(result['stdout'])['output'] == {'gene': 'TNF'}
    silent = '# /// script\n# dependencies = []\n# ///\npass\n'
    stale = execute_bundle(payload(tmp_path, bundle(silent), run=True,
                                   script='scripts/analyze.py', args=['--output', 'result.json']))
    assert stale['ok'] is False


def test_artifact_output_cannot_escape_workspace(tmp_path):
    with pytest.raises(ValueError, match='output'):
        execute_bundle(payload(tmp_path, run=True, script='scripts/analyze.py', args=['--output', '../escape.json']))


def test_silent_artifact_with_scientific_error_cannot_pass(tmp_path):
    script = ('# /// script\n# dependencies = []\n# ///\n'
              'import pathlib\npathlib.Path("failed.json").write_text(\'{"error":"query failed"}\')\n')
    result = execute_bundle(payload(tmp_path, bundle(script), run=True,
                                    script='scripts/analyze.py', args=['--output', 'failed.json']))
    assert result['ok'] is False


@pytest.mark.parametrize("script, expected", [
    ('raise SystemExit(7)', "exit"),
    ('print("x"*60000)', "truncated"),
    ('import time; time.sleep(10)', "timeout"),
])
def test_nonzero_truncation_and_timeout_are_not_success(tmp_path, script, expected):
    script = '# /// script\n# dependencies = []\n# ///\n' + script
    result = execute_bundle(payload(tmp_path, bundle(script), run=True,
                                    script="scripts/analyze.py", timeoutSeconds=1 if expected == "timeout" else 30))
    assert result["ok"] is False and result["status"] == "failed", result
    if expected == "truncated":
        assert result["truncated"]
    elif expected == "timeout":
        assert result["timedOut"]
    else:
        assert result["exitCode"] == 7


@pytest.mark.asyncio
async def test_adapter_prepares_and_executes_on_bound_backend_without_local_fallback(tmp_path):
    calls = []
    class Backend:
        root = tmp_path
        async def execute_python(self, source, timeout_s):
            calls.append(source)
            proc = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=timeout_s)
            return {"ok": proc.returncode == 0, "stdout": proc.stdout, "stderr": proc.stderr}
    result = await execute_backend(Backend(), "prepare_science_skill", {"bundle": bundle()})
    assert result["workspace"] == str(tmp_path)
    result = await execute_backend(Backend(), "run_science_skill", {"bundle": bundle(), "input": {"script": "scripts/analyze.py"}})
    assert result["ok"] and len(calls) == 2
    class Disconnected(Backend):
        async def execute_python(self, source, timeout_s):
            raise RuntimeError("SSH disconnected")
    with pytest.raises(RuntimeError, match="disconnected"):
        await execute_backend(Disconnected(), "run_science_skill", {"bundle": bundle(), "input": {"script": "scripts/analyze.py"}})


def test_portable_runtime_source_is_self_contained(tmp_path):
    proc = subprocess.run([sys.executable, "-c", runtime_source(bundle(), str(tmp_path))],
                          capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "prepared"
