"""Real temporary repositories through the bound backend's Python transport."""
import os
import subprocess
import sys

import httpx
import pytest
from fastapi import FastAPI

from omicslab.execution.local import LocalExecutionBackend
from omicslab.execution.ssh_backend import SSHExecutionBackend
from omicslab.server import routes_sidebar
from test_suwen_platform import p


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=True).stdout


class ProcessKernel:
    async def execute(self, code, timeout_s=None):
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=timeout_s,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        return {"ok": result.returncode == 0, "outputs": [
            {"type": "stream", "name": "stdout", "text": result.stdout.decode("utf-8")},
            {"type": "stream", "name": "stderr", "text": result.stderr.decode("utf-8")}]}


@pytest.fixture
async def repo(p):
    ws = p.require_workspace("ws_main")
    root = ws.root
    git(root, "init")
    git(root, "config", "user.name", "Sidebar Test")
    git(root, "config", "user.email", "sidebar@example.invalid")
    git(root, "config", "core.autocrlf", "false")
    backend = LocalExecutionBackend(p.settings, ws, ProcessKernel())

    async def selected(scope):
        assert scope == ws.workspace_id
        return backend

    p.backend = selected
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(routes_sidebar.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        yield root, client, p, ws


BASE = "/api/workspaces/ws_main/sidebar/git"


async def review(client):
    response = await client.get(BASE + "/review")
    assert response.status_code == 200, response.text
    return response.json()


async def change(client, action, snapshot, **kwargs):
    return await client.post(BASE + "/" + action, json={
        "digest": snapshot["digest"], "index_digest": snapshot["index_digest"],
        "confirmed": True, **kwargs})


async def test_real_stage_unstage_initial_and_reviewed_commit_unicode(repo):
    root, client, _, _ = repo
    path = "研究 notes [1].txt"
    (root / path).write_bytes("evidence 一\n".encode("utf-8"))
    (root / "unrelated.txt").write_text("leave untracked", encoding="utf-8")
    initial = await review(client)
    staged = await change(client, "stage", initial, path=path)
    assert staged.status_code == 200, staged.text
    snapshot = staged.json()
    assert snapshot["verified"] and snapshot["staged_paths"] == [path]
    assert "evidence 一" in snapshot["staged_diff"]
    removed = await change(client, "unstage", snapshot, path=path)
    assert removed.status_code == 200, removed.text
    assert removed.json()["staged_paths"] == []
    assert git(root, "ls-files", "-z") == b""
    staged = await change(client, "stage", removed.json(), path=path)
    message = "审核 commit 中文 & $(touch SHOULD_NOT_EXIST) `whoami`\n\nReviewed staged only."
    committed = await change(client, "commit", staged.json(), message=message)
    assert committed.status_code == 200, committed.text
    data = committed.json()
    assert data["verified"] and data["committed_paths"] == [path] and data["staged_paths"] == []
    assert git(root, "rev-parse", "HEAD").decode().strip() == data["commit"]
    assert git(root, "log", "-1", "--format=%B").decode("utf-8").rstrip() == message
    assert git(root, "ls-tree", "-r", "--name-only", "-z", "HEAD").decode("utf-8").split("\0") == [path, ""]
    assert not (root / "SHOULD_NOT_EXIST").exists()
    # Existing read-only endpoint and commit detail remain compatible.
    history = await client.get(BASE)
    assert history.status_code == 200 and history.json()["read_only"] is True
    assert (await client.get(BASE, params={"commit": data["commit"]})).status_code == 200
    (root / path).write_bytes("second revision\n".encode("utf-8"))
    modified = await change(client, "stage", await review(client), path=path)
    removed = await change(client, "unstage", modified.json(), path=path)
    assert removed.status_code == 200 and removed.json()["staged_paths"] == []
    assert git(root, "show", ":" + path).decode("utf-8") == "evidence 一\n"
    assert (root / path).read_text(encoding="utf-8") == "second revision\n"


async def test_stale_same_status_index_content_rejected_and_confirmation(repo):
    root, client, _, _ = repo
    (root / "file.txt").write_text("one\n", encoding="utf-8")
    staged = (await change(client, "stage", await review(client), path="file.txt")).json()
    status = git(root, "status", "--porcelain")
    (root / "file.txt").write_text("two\n", encoding="utf-8")
    git(root, "add", "--", "file.txt")
    assert git(root, "status", "--porcelain") == status
    response = await change(client, "commit", staged, message="must reject")
    assert response.status_code == 409 and "changed" in response.text
    current = await review(client)
    assert current["index_digest"] != staged["index_digest"]
    assert (await change(client, "commit", current, message="no", confirmed=False)).status_code == 422
    assert (await client.post(BASE + "/commit", json={"message": "no", "confirmed": True})).status_code == 422
    assert subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True).returncode != 0
    assert (await change(client, "commit", current, message="two reviewed")).status_code == 200


async def test_path_literal_deletion_permissions_and_secrets(repo):
    root, client, p, _ = repo
    for path in ["literal[abc].txt", "literala.txt", "-option name.txt"]:
        (root / path).write_text("safe\n", encoding="utf-8")
    data = await review(client)
    for path in ["../outside", ".", ".git/config", ".env", "/absolute", "C:/outside", ""]:
        result = await change(client, "stage", data, path=path)
        assert result.status_code == 409, (path, result.text)
    data = (await change(client, "stage", data, path="literal[abc].txt")).json()
    assert data["staged_paths"] == ["literal[abc].txt"]
    data = (await change(client, "stage", data, path="-option name.txt")).json()
    assert set(data["staged_paths"]) == {"literal[abc].txt", "-option name.txt"}
    committed = await change(client, "commit", data, message="selected files")
    assert committed.status_code == 200, committed.text
    (root / "literal[abc].txt").unlink()
    deleted = await change(client, "stage", await review(client), path="literal[abc].txt")
    assert deleted.status_code == 200 and "deleted file" in deleted.json()["staged_diff"]
    restored = await change(client, "unstage", deleted.json(), path="literal[abc].txt")
    assert restored.status_code == 200 and not (root / "literal[abc].txt").exists()
    (root / ".env").write_text("DO_NOT_DISCLOSE_SECRET\n", encoding="utf-8")
    git(root, "add", "--", ".env")
    data = await review(client)
    assert not data["reviewable"] and "DO_NOT_DISCLOSE_SECRET" not in str(data)
    assert (await change(client, "commit", data, message="forbidden")).status_code == 409
    for category in ["files", "shell"]:
        p.config.update("permissions", {category: "read_only"}, "ws_main")
        response = await change(client, "stage", data, path="literala.txt")
        assert response.status_code == 403
        p.config.update("permissions", {category: "allow"}, "ws_main")
    p.config.update("permissions", {"shell": "deny"}, "ws_main")
    assert (await client.get(BASE + "/review")).status_code == 403


async def test_bound_ssh_missing_and_mismatch_never_runs_local(repo, monkeypatch):
    root, client, p, ws = repo
    (root / "local-only.txt").write_text("local", encoding="utf-8")
    data = await review(client)
    # A selected SSH workspace must never accept a local backend, even if supplied.
    ws.backend = "ssh"
    assert (await client.get(BASE + "/review")).status_code == 409
    ws.remote = {"root": "/missing-sidebar-workspace"}
    ssh = SSHExecutionBackend(ws, p.settings)

    async def selected(scope):
        assert scope == "ws_main"
        return ssh

    p.backend = selected

    async def no_local(*args, **kwargs):
        pytest.fail("SSH request fell back to local execution")

    monkeypatch.setattr(LocalExecutionBackend, "execute_python", no_local)
    for action in ["review", "stage", "unstage", "commit"]:
        result = await client.get(BASE + "/review") if action == "review" else await change(
            client, action, data, path="local-only.txt", message="no local commit")
        assert result.status_code == 409, result.text
    assert git(root, "ls-files", "-z") == b""


async def test_index_lock_output_limit_and_no_hooks(repo, monkeypatch):
    root, client, _, _ = repo
    (root / "file.txt").write_text("reviewed\n", encoding="utf-8")
    data = await review(client)
    lock = root / ".git" / "index.lock"
    lock.write_text("owned by another process", encoding="utf-8")
    assert (await change(client, "stage", data, path="file.txt")).status_code == 409
    assert lock.read_text(encoding="utf-8") == "owned by another process"
    lock.unlink()
    data = (await change(client, "stage", data, path="file.txt")).json()
    policy = routes_sidebar.git_policy()
    monkeypatch.setattr(routes_sidebar, "git_policy", lambda: {**policy, "diff_bytes": 5})
    assert (await client.get(BASE + "/review")).status_code == 409
    assert (await change(client, "commit", data, message="too large")).status_code == 409
    monkeypatch.setattr(routes_sidebar, "git_policy", lambda: policy)
    hook = root / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)
    result = await change(client, "commit", data, message="reviewed without hooks")
    assert result.status_code == 200, result.text
    assert not lock.exists()
