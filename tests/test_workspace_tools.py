"""Real persistence/queue contracts; model fixtures are not live model acceptance."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from omicslab.agent.types import ChatMessage
from omicslab.config import Settings
from omicslab.session.store import ConversationStore
from omicslab.server.routes import router as conversation_router
from omicslab.server.routes_workspace_tools import router
from omicslab.suwen.teams import create_team, team_snapshot, approve_team, send_message, team_mailbox, assign_member, member_team
from test_suwen_platform import p


def test_archive_survives_inflight_stale_save(tmp_path):
    settings = Settings(home=tmp_path/"home", workspace=tmp_path/"work")
    settings.ensure_dirs()
    store = ConversationStore(settings)
    original = store.create(title="Active")
    original.messages.append(ChatMessage(role="user", content="keep this evidence"))
    store.save(original)
    old_time = original.updated_at
    store.update_metadata(original.id, {"archived": True, "pinned": True})
    assert store.get(original.id).updated_at == old_time
    original.messages.append(ChatMessage(role="assistant", content="real result"))
    store.save(original)
    persisted = store.get(original.id)
    assert persisted.meta["archived"] is True and persisted.meta["pinned"] is True
    assert len(persisted.messages) == 2
    restarted = ConversationStore(settings)
    assert restarted.list()[0]["archived"] is True
    restarted.update_metadata(original.id, {"archived": False})
    assert restarted.list()[0]["archived"] is False


def test_summary_cache_invalidates_external_writes(tmp_path, monkeypatch):
    settings = Settings(home=tmp_path/"home", workspace=tmp_path/"work")
    settings.ensure_dirs()
    store = ConversationStore(settings)
    conv = store.create()
    first = store.list()
    # Second list must not parse an unchanged full transcript.
    original = json.loads
    calls = []
    monkeypatch.setattr(json, "loads", lambda *args, **kwargs: (calls.append(1), original(*args, **kwargs))[1])
    assert store.list() == first and calls == []
    path = settings.conversations_dir/f"{conv.id}.json"
    data = original(path.read_text(encoding="utf-8"))
    data["title"] = "Changed externally"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert store.list()[0]["title"] == "Changed externally"
    assert len(calls) == 1


async def test_archive_api_and_context_ownership(tmp_path):
    settings = Settings(home=tmp_path/"home", workspace=tmp_path/"work")
    settings.ensure_dirs()
    store = ConversationStore(settings)
    conv = store.create(title="Archive me")
    conv.messages.append(ChatMessage(role="user", content="file /remote/研究.csv failed"))
    store.save(conv)
    events = SimpleNamespace(list_runs=lambda **_: [{"meta":{"harness_task_id":"owned"}}])
    active = store.get(conv.id)
    state = SimpleNamespace(store=store, events=events, runs=SimpleNamespace(_handles={
        "running": SimpleNamespace(session_id=conv.id, conversation=active)}),
        loop=SimpleNamespace(desktop_harness=None))
    app = FastAPI()
    app.state.omicslab = state
    app.include_router(conversation_router)
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.patch(f"/api/conversations/{conv.id}", json={"archived": True})
        assert response.status_code == 200
        assert active.meta["archived"] is True
        assert (await client.get("/api/conversations")).json()["conversations"][0]["archived"] is True
        assert (await client.patch(f"/api/conversations/{conv.id}", json={"pinned":"true"})).status_code == 400
        result = (await client.get(f"/api/conversations/{conv.id}/context", params={"query":"研究.csv"})).json()
        assert result["matches"][0]["text"] == conv.messages[0].content
        assert result["estimated"] is True
        denied = await client.post(f"/api/conversations/{conv.id}/context/source",
                                  json={"task_id":"someone-else","source":{}})
        assert denied.status_code == 404


def test_teams_validate_before_creating_any_tasks(p):
    with pytest.raises(ValueError, match="循环"):
        create_team(p, "ws_main", {"members":[
            {"id":"a","goal":"one","depends_on":["b"]},
            {"id":"b","goal":"two","depends_on":["a"]}]})
    assert p.store.list("task", "ws_main") == []
    with pytest.raises(ValueError):
        create_team(p, "ws_main", {"members":[{"id":"a","goal":"one","permission_mode":"admin"}]})
    with pytest.raises(ValueError):
        create_team(p, "missing", {"members":[{"id":"a","goal":"one"}]})
    assert p.store.list("team", "ws_main") == []


def test_team_dependency_mapping_and_restart(p):
    team = create_team(p, "ws_main", {"title":"Team", "members":[
        {"id":"review","name":"Reviewer","goal":"review evidence","depends_on":["source"]},
        {"id":"source","goal":"collect evidence","permission_mode":"review"},
    ]})
    members = {m["id"]:m for m in team["members"]}
    assert members["review"]["task"]["dependencies"] == [members["source"]["task_id"]]
    assert members["source"]["task"]["workflow"]["nodes"][0]["permission_mode"] == "review"
    p.tasks.patch(members["source"]["task_id"], "ws_main", status="succeeded", result="pmid:16904174")
    persisted = p.store.get("team", team["id"], "ws_main")
    assert team_snapshot(p, "ws_main", persisted)["status"] == "queued"
    p.tasks.patch(members["review"]["task_id"], "ws_main", status="failed", error="network")
    assert team_snapshot(p, "ws_main", persisted)["status"] == "failed"


async def test_team_handoff_uses_independent_sessions_and_committed_evidence(p):
    # Real queue, stores, graph, permission propagation. Only the model-facing run
    # service is a fixture, so this test doesn't count as live-model acceptance.
    p.state.store = ConversationStore(p.settings)
    records, submitted = {}, []
    async def submit(**kwargs):
        run_id = f"run-{len(submitted)}"
        submitted.append(kwargs)
        records[run_id] = {"status":"succeeded","result_text":"source-proof" if len(submitted)==1 else "reviewed"}
        return {"run":{"run_id":run_id}}
    p.state.runs = SimpleNamespace(submit=submit, cancel=lambda *_:None)
    p.state.events = SimpleNamespace(get_run=lambda run_id:records[run_id])
    team = create_team(p, "ws_main", {"members":[
        {"id":"a","goal":"source task","permission_mode":"review"},
        {"id":"b","goal":"review task","depends_on":["a"]}]})
    for member in team["members"]:
        p.tasks.cancels[member["task_id"]] = asyncio.Event()
        p.tasks.patch(member["task_id"], "ws_main", status="running")
        await p.tasks._workflow(member["task_id"], "ws_main")
    assert len(submitted) == 2
    assert submitted[0]["session_id"] != submitted[1]["session_id"]
    assert submitted[0]["workspace_id"] == submitted[1]["workspace_id"] == "ws_main"
    assert submitted[0]["permission_mode"] == "review"
    assert "source-proof" in submitted[1]["message"]
    assert "source task" not in submitted[1]["message"]
    assert p.state.store.get(submitted[0]["session_id"]).meta["workspace_id"] == "ws_main"


def test_team_draft_requires_approval_and_snapshots_model_routes(p):
    team = create_team(p, "ws_main", {"draft":True, "captain_session":"captain1",
        "members":[{"id":"a","goal":"source task"}]})
    assert team["status"] == "draft"
    assert p.store.list("task","ws_main") == []
    approved = approve_team(p,"ws_main",team["id"])
    assert approved["status"] == "queued"
    assert approved["members"][0]["model"]
    with pytest.raises(ValueError):
        approve_team(p,"ws_main",team["id"])
    assert len(p.store.list("task","ws_main")) == 1
    assert member_team(p,"ws_main","captain1",team["id"])[1] == "captain"
    with pytest.raises(ValueError):
        member_team(p,"ws_main","someone-else",team["id"])


async def test_team_mailbox_followup_preserves_session_model_and_stops_stale_takeover(p):
    team = create_team(p,"ws_main",{"members":[{"id":"a","goal":"one"},{"id":"b","goal":"two"}]})
    a,b=team["members"]
    p.tasks.node_patch(a["task_id"],"ws_main","work",session_id="durable-a")
    p.tasks.patch(a["task_id"],"ws_main",status="succeeded")
    message=await send_message(p,"ws_main",team["id"],"user","a","Review one more result",wake=True)
    assert message["deliveries"][0]["status"] == "followup_queued"
    newer=p.store.get("team",team["id"],"ws_main")["members"][0]
    task=p.store.get("task",newer["task_id"],"ws_main")
    assert newer["task_id"] != a["task_id"]
    assert task["nodes"]["work"]["session_id"] == "durable-a"
    assert task["workflow"]["nodes"][0]["model"] == a["model"]
    assert len(team_mailbox(p,"ws_main",team["id"],"a")) == 1
    assert team_mailbox(p,"ws_main",team["id"],"b") == []
    with pytest.raises(ValueError,match="核对"):
        await assign_member(p,"ws_main",team["id"],"b","do not replace unknown work")
    assert p.store.get("team",team["id"],"ws_main")["members"][1]["task_id"] == b["task_id"]
