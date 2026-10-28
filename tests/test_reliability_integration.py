"""Real HTTP discovery, Windows vault restart, scoped disk changes and restore."""
import asyncio
import json
import os
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from omicslab.config import Settings, LLMTarget
from omicslab.provider_models import discover_models
from omicslab.execution.local import LocalExecutionBackend
from omicslab.server.routes_harness import execute_backend
from omicslab.server.routes_platform import router
from omicslab.suwen.file_changes import restore
from omicslab.suwen.store import PlatformStore
from omicslab.workspace import Workspace


@pytest.mark.asyncio
async def test_real_provider_http_discovery_and_independent_restart(tmp_path):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            data = {"data": [{"id": "fast"}, {"id": "reasoning"}, {"id": "fast"}]}
            raw = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        discovered = await discover_models(LLMTarget("custom_openai", "any", "openai", base, "fixture-only", "fixture"))
        assert discovered["models"] == ["fast", "reasoning"]
        assert requests == [("/v1/models", "Bearer fixture-only")]
        settings = Settings(home=tmp_path)
        settings.save_provider_connection("custom_openai", "fast", base, discovered["models"])
        settings.save_provider_connection("openai", "gpt-4o", "https://api.openai.com/v1", ["gpt-4o", "gpt-4o-mini"])
        settings.set_keys({"CUSTOM_OPENAI_API_KEY": "fixture-only", "OPENAI_API_KEY": "fixture-other"})
        settings.update({"provider": "custom_openai", "model": "fast", "api_base": base})
        settings = Settings(home=tmp_path).reload()
        assert settings.resolve_llm("openai").model == "gpt-4o"
        assert settings.resolve_llm("openai").api_base == "https://api.openai.com/v1"
        settings.update({"provider": "openai"})
        assert settings.resolve_llm().model == "gpt-4o"
        settings.update({"provider": "custom_openai"})
        assert settings.resolve_llm().api_base == base
        assert settings.resolve_llm(model="reasoning").model == "reasoning"
        assert settings.provider_catalog_map()["custom_openai"]["models"] == ["fast", "reasoning"]
        # A discovery failure must not erase a saved model list.
        server.shutdown()
        with pytest.raises(Exception):
            await asyncio.wait_for(discover_models(LLMTarget("custom_openai", "any", "openai", base, "", "fixture")), 1)
        assert Settings(home=tmp_path).reload().provider_connections["custom_openai"]["models"] == ["fast", "reasoning"]
    finally:
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.skipif(os.name != "nt", reason="Requires actual Windows Credential Manager")
def test_windows_password_survives_separate_process_without_secret_files(tmp_path):
    from omicslab.ssh.credentials import CredentialStore
    name = "eve-test-" + uuid.uuid4().hex
    vault = CredentialStore()
    assert vault.backend == "windows-credential-manager"
    try:
        assert vault.save(name, "Synthetic测试密码", persist=True)["stored"]
        program = (
            "from omicslab.ssh.credentials import CredentialStore;"
            f"assert CredentialStore().load({name!r})=='Synthetic测试密码';"
            "print('VAULT_RESTART_OK')"
        )
        result = subprocess.run([sys.executable, "-X", "utf8", "-c", program],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        assert result.returncode == 0, result.stderr
        assert "VAULT_RESTART_OK" in result.stdout
        assert not list(tmp_path.iterdir())
    finally:
        assert vault.delete(name)["deleted"]
    assert CredentialStore().load(name) is None


@pytest.mark.asyncio
async def test_real_disk_diff_scoped_api_and_hash_guarded_restore(tmp_path):
    settings = Settings(home=tmp_path/"home", workspace=tmp_path/"workspace")
    settings.ensure_dirs()
    workspace = Workspace("ws_changes", "Changes", local_path=str(settings.workspace))
    backend = LocalExecutionBackend(settings, workspace, kernel=None)
    store = PlatformStore(settings.home)
    async def selected_backend(scope):
        assert scope == workspace.workspace_id
        return backend
    def require_workspace(scope):
        if scope != workspace.workspace_id:
            raise ValueError("Unknown workspace")
        return workspace
    platform = SimpleNamespace(store=store, backend=selected_backend, require_workspace=require_workspace)
    app = FastAPI()
    app.include_router(router)
    app.state.omicslab = SimpleNamespace(platform=platform)
    (workspace.root/"result.txt").write_bytes(b"old\n")
    saved = []
    def record(change):
        saved.append(store.put("file_change", str(len(saved)), {**change, "session_id": "chat-a"}, workspace.workspace_id))
    try:
        previous = await execute_backend(backend, "read_file", {"path": "result.txt"})
        result = await execute_backend(backend, "write_file",
            {"path": "result.txt", "content": "new\nextra\n", "expectedSha256": previous["sha256"]}, on_change=record)
        assert result["verified"] and result["change"]["added"] == 2
        assert saved[0]["before"] == "old\n"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/platform/file-changes?scope=ws_changes&session_id=chat-a")
            row = response.json()["items"][0]
            assert "before" not in row and "+new" in row["diff"] and row["verified"]
            assert (await client.get("/api/platform/file-changes?scope=ws_changes&session_id=chat-b")).json()["items"] == []
            (workspace.root/"result.txt").write_text("later work\n", encoding="utf-8")
            denied = await client.post("/api/platform/file-changes/0/restore?scope=ws_changes")
            assert denied.status_code == 409
            assert (workspace.root/"result.txt").read_text() == "later work\n"
            (workspace.root/"result.txt").write_bytes(b"new\nextra\n")
            response = await client.post("/api/platform/file-changes/0/restore?scope=ws_changes")
            assert response.json()["verified"]
            assert (workspace.root/"result.txt").read_text() == "old\n"
        assert store.get("file_change", "0", workspace.workspace_id)["reverted"]
        with pytest.raises(ValueError):
            await restore(platform, "ws_other", "0")
    finally:
        store.close()
