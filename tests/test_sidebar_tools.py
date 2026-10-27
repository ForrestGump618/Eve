"""Real filesystem/Git/shell tests; no model or SSH success is implied."""
import subprocess
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from omicslab.execution.local import LocalExecutionBackend
from omicslab.server.routes_sidebar import router
from test_suwen_platform import p


async def test_sidebar_editor_conflicts_search_and_git_use_bound_workspace(p):
    workspace=p.require_workspace("ws_main")
    backend=LocalExecutionBackend(p.settings,workspace,None)
    async def get_backend(scope):
        assert scope == "ws_main"
        return backend
    p.backend=get_backend
    app=FastAPI()
    app.state.omicslab=p.state
    app.include_router(router)
    target=workspace.root/"研究.md"
    target.write_text("Observed evidence, not proof.",encoding="utf8")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url="http://test") as client:
        base="/api/workspaces/ws_main/sidebar"
        data=(await client.get(base+"/editor",params={"path":"研究.md"})).json()
        saved=await client.post(base+"/editor",json={"path":"研究.md","content":"Updated evidence.","expectedSha256":data["sha256"]})
        assert saved.status_code == 200 and saved.json()["verified"] is True
        stale=await client.post(base+"/editor",json={"path":"研究.md","content":"must not overwrite","expectedSha256":data["sha256"]})
        assert stale.status_code == 409 and target.read_text(encoding="utf8") == "Updated evidence."
        matches=(await client.get(base+"/files",params={"query":"Updated evidence"})).json()
        assert len(matches["matches"]) == 1
        escaped=await client.get(base+"/editor",params={"path":"../outside.txt"})
        assert escaped.status_code == 409
        subprocess.run(["git","init",str(workspace.root)],capture_output=True,check=True)
        subprocess.run(["git","-C",str(workspace.root),"add","研究.md"],capture_output=True,check=True)
        subprocess.run(["git","-C",str(workspace.root),"-c","user.name=Eve Test","-c","user.email=test@example.invalid","commit","-m","EVE_SIDEBAR_GIT"],capture_output=True,check=True)
        git=(await client.get(base+"/git")).json()
        assert git["read_only"] is True and "EVE_SIDEBAR_GIT" in git["graph"]
        assert (await client.get(base+"/git",params={"commit":"HEAD & whoami"})).status_code == 422


async def test_local_shell_capture_is_bounded_and_not_reported_success(p):
    backend=LocalExecutionBackend(p.settings,p.require_workspace("ws_main"),None)
    code="import sys; sys.stdout.write('x'*1600000); sys.stderr.write('y'*1600000)"
    command=subprocess.list2cmdline([sys.executable,"-c",code]) if sys.platform=="win32" else __import__("shlex").join([sys.executable,"-c",code])
    result=await backend.shell(command,timeout_s=15)
    assert result["exit_code"] == 0
    assert result["ok"] is False and result["truncated"] is True
    assert len(result["stdout"])+len(result["stderr"]) <= 1_000_000
