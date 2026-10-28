"""Real Node, filesystem and API boundary checks; upstream finalization has its own acceptance run."""
import base64
import gzip
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from omicslab.config import Settings
from omicslab.execution.archify import execute_archify, runtime_source
from omicslab.server.routes_harness import execute_backend
from omicslab.server.routes_workspaces import router
from omicslab.workspace.service import WorkspaceService


def bundle(script='console.log(JSON.stringify({ok:true}));'):
    files = [{"path": p, "content": c, "sha256": hashlib.sha256(c.encode()).hexdigest()}
             for p, c in {"SKILL.md": "# Archify fixture", "bin/archify.mjs": script}.items()]
    compressed = gzip.compress(json.dumps(files).encode())
    return {"id": "archify-fixture", "name": "archify", "version": "1.0.0",
            "sha256": files[0]["sha256"], "source": "fixture",
            "runtime": {"manager": "node", "scripts": ["bin/archify.mjs"]},
            "archive": base64.b64encode(compressed).decode(), "archiveSha256": hashlib.sha256(compressed).hexdigest()}


def payload(tmp_path, script=None, **args):
    return {"workspace": str(tmp_path), "bundle": bundle() if script is None else bundle(script),
            "operation": "run" if args else "prepare", "input": args}


def test_portable_source_prepares_and_detects_mutated_cache(tmp_path):
    packed = bundle()
    proc = subprocess.run([sys.executable, "-c", runtime_source(packed, str(tmp_path))],
                          capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    prepared = json.loads(proc.stdout)
    assert prepared["status"] == "prepared" and prepared["executed"] is False
    assert prepared["verifiedFiles"] == 2
    assert execute_archify(payload(tmp_path))["directory"] == prepared["directory"]
    (Path(prepared["directory"]) / "bin/archify.mjs").write_text("changed")
    with pytest.raises(ValueError, match="changed"):
        execute_archify(payload(tmp_path))


def test_archive_corruption_fails_before_execution(tmp_path):
    data = payload(tmp_path)
    data["bundle"]["archiveSha256"] = "0" * 64
    with pytest.raises(ValueError, match="digest"):
        execute_archify(data)
    assert not (tmp_path / ".eve").exists()


@pytest.mark.parametrize("path", ["../escape.html", "/escape.html", "C:/escape.html", ".eve/escape.html"])
def test_output_path_escape_rejected(tmp_path, path):
    (tmp_path / "candidate.json").write_text("{}")
    with pytest.raises(ValueError, match="workspace|resources"):
        execute_archify(payload(tmp_path, command="finalize", type="workflow", candidate="candidate.json", output=path))


@pytest.mark.parametrize("script,flag", [
    ('console.log(JSON.stringify({ok:true}));process.exit(7);', "exitCode"),
    ('console.log("x".repeat(60000));', "truncated"),
    ('setTimeout(()=>{},10000);', "timedOut"),
    ('console.log(JSON.stringify({ok:false}));', "ok"),
])
def test_failure_timeout_and_truncation_are_never_success(tmp_path, script, flag):
    (tmp_path / "candidate.json").write_text("{}")
    result = execute_archify(payload(tmp_path, script, command="validate", type="workflow",
                                    candidate="candidate.json", timeoutSeconds=1 if flag == "timedOut" else 20))
    assert result["status"] == "failed" and result["ok"] is False and result["artifact"] is None
    if flag != "ok":
        assert result[flag]


def test_finalize_requires_actual_nonempty_file_and_checksummed_receipt(tmp_path):
    (tmp_path / "candidate.json").write_text("{}")
    # A zero exit and positive receipt alone cannot establish delivery.
    result = execute_archify(payload(tmp_path, command="finalize", type="workflow",
                                    candidate="candidate.json", output="out.html"))
    assert not result["ok"] and result["artifact"] is None
    script = ('import fs from "node:fs";fs.writeFileSync(process.argv[5],"<html>42</html>");'
              'console.log(JSON.stringify({ok:true,browserCheck:{ran:true},gates:{validate:"pass",deliver:"pass",check:"pass","browser-check":"pass"}}));')
    result = execute_archify(payload(tmp_path, script, command="finalize", type="workflow",
                                    candidate="candidate.json", output="out.html"))
    assert result["ok"] and result["artifact"]["path"] == "out.html"
    assert result["artifact"]["sha256"] == hashlib.sha256((tmp_path / "out.html").read_bytes()).hexdigest()
    # Even a real HTML file and positive exit cannot bypass a skipped browser gate.
    result = execute_archify(payload(tmp_path, 'console.log(JSON.stringify({ok:true}));',
                                    command="finalize", type="workflow", candidate="candidate.json", output="out.html"))
    assert not result["ok"] and result["artifact"] is None


@pytest.mark.asyncio
async def test_disconnected_backend_never_falls_back(tmp_path):
    backend = SimpleNamespace(root=tmp_path, execute_python=AsyncMock(side_effect=RuntimeError("SSH offline")))
    with pytest.raises(RuntimeError, match="SSH offline"):
        await execute_backend(backend, "run_archify", {"bundle": bundle(), "input": {}})


@pytest.fixture
def artifact_app(tmp_path):
    settings = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    settings.ensure_dirs()
    service = WorkspaceService(settings)
    local = service.create("local", local_path=str(settings.workspace))
    remote = service.create("remote", backend="ssh", remote={"profile_id": "fixture", "root": "/analysis"})
    app = FastAPI()
    app.include_router(router)
    app.state.omicslab = SimpleNamespace(settings=settings, workspaces=service)
    return app, settings.workspace, local.workspace_id, remote.workspace_id


@pytest.mark.asyncio
async def test_html_api_is_inert_bounded_and_workspace_contained(artifact_app, tmp_path):
    app, root, local, _ = artifact_app
    (root / "test.html").write_text("<script>parent.secret()</script>", encoding="utf-8")
    (tmp_path / "outside.html").write_text("outside")
    (root / "large.html").write_bytes(b"x" * 2_000_001)
    (root / "empty.html").write_text("")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        url = f"/api/workspaces/{local}/artifacts/html"
        result = await client.get(url, params={"path": "test.html"})
        assert result.status_code == 200 and result.headers["content-type"].startswith("application/json")
        assert result.json()["content"] == "<script>parent.secret()</script>"
        for path in ["../outside.html", "large.html", "missing.html", "empty.html", "test.py"]:
            assert (await client.get(url, params={"path": path})).status_code == 400, path


@pytest.mark.asyncio
async def test_html_api_uses_remote_reader_and_reports_connection_failure(artifact_app, monkeypatch):
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    from omicslab.execution.base import BackendUnavailable
    app, root, _, remote = artifact_app
    (root / "test.html").write_text("LOCAL MUST NOT BE READ")
    monkeypatch.setattr(SSHExecutionBackend, "start", AsyncMock())
    monkeypatch.setattr(SSHExecutionBackend, "close", AsyncMock())
    read = AsyncMock(return_value={"content": "<html>remote</html>"})
    monkeypatch.setattr(SSHExecutionBackend, "read_text", read)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        url = f"/api/workspaces/{remote}/artifacts/html"
        result = await client.get(url, params={"path": "test.html"})
        assert result.json()["content"] == "<html>remote</html>"
        read.assert_awaited_once_with("test.html", max_bytes=2_000_000)
        read.return_value = {"content": "truncated", "truncated": True}
        assert (await client.get(url, params={"path": "test.html"})).status_code == 400
        monkeypatch.setattr(SSHExecutionBackend, "start", AsyncMock(side_effect=BackendUnavailable("offline")))
        assert (await client.get(url, params={"path": "test.html"})).status_code == 503
