"""Real storage/files and API evidence gates; no model success inferred."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from test_suwen_platform import p, client_app  # shared real platform fixture
from omicslab.suwen.research import ResearchQuests, STAGES


def create(p):
    return p.research.create("ws_main", {
        "title": "Held-out comparison", "question": "Does the candidate improve accuracy?",
        "dataset": "demo-v1", "protocol": "heldout-v1",
        "metrics": [{"name": "accuracy", "direction": "max"}],
    })


def artifact(p, name="evidence.md", content="Observed result"):
    (p.settings.workspace / name).write_text(content, encoding="utf-8")
    return name


async def record(p, q, stage, **data):
    return await p.research.record("ws_main", q["id"], {
        "stage": stage, "artifacts": [artifact(p)], "summary": "Observed evidence", **data,
    })


@pytest.mark.asyncio
async def test_all_stages_real_artifacts_comparison_and_human_gate(p):
    q = create(p)
    for stage in STAGES:
        data = {}
        if stage in {"baseline", "experiment"}:
            data["metrics_path"] = artifact(p, stage+".json", json.dumps({
                "dataset": q["dataset"], "protocol": q["protocol"],
                "metrics": {"accuracy": .7 if stage == "baseline" else .8}}))
        if stage == "finalize":
            with pytest.raises(ValueError, match="用户"):
                await record(p, q, stage)
            data["human_approved"] = True
        q = await record(p, q, stage, **data)
        assert q["stages"][STAGES.index(stage)]["evidence"][0]["sha256"]
    assert q["status"] == "completed"
    assert q["scientific_status"] == "unverified"
    assert q["stages"][3]["comparison"]["accuracy"]["delta"] == pytest.approx(.1)
    assert ResearchQuests(p).get("ws_main", q["id"])["human_reviewed_at"]


@pytest.mark.asyncio
async def test_cannot_skip_or_overwrite_evidence(p):
    q = create(p)
    with pytest.raises(ValueError, match="前序"):
        await record(p, q, "baseline")
    await record(p, q, "scout")
    with pytest.raises(ValueError, match="不能覆盖"):
        await record(p, q, "scout")


@pytest.mark.asyncio
@pytest.mark.parametrize("metrics", [{"accuracy": True}, {"accuracy": float("nan")},
    {"accuracy": float("inf")}, {}, ["bad"]])
async def test_invalid_measured_metrics_never_recorded(p, metrics):
    q = create(p); await record(p, q, "scout")
    path = artifact(p, "metrics.json", json.dumps({
        "dataset": q["dataset"], "protocol": q["protocol"], "metrics": metrics}))
    with pytest.raises(ValueError):
        await record(p, q, "baseline", metrics_path=path)
    assert p.research.get("ws_main", q["id"])["stages"][1]["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["dataset", "protocol"])
async def test_comparators_must_follow_same_contract(p, key):
    q = create(p); await record(p, q, "scout")
    payload = {"dataset": q["dataset"], "protocol": q["protocol"], "metrics": {"accuracy": .8}}
    payload[key] = "different"
    path = artifact(p, "metrics.json", json.dumps(payload))
    with pytest.raises(ValueError, match="不一致"):
        await record(p, q, "baseline", metrics_path=path)


@pytest.mark.asyncio
@pytest.mark.parametrize("name,content", [("empty.md", ""), ("large.md", "x"*220000)], ids=["empty", "truncated"])
async def test_empty_or_truncated_artifacts_fail(p, name, content):
    q = create(p)
    with pytest.raises(ValueError):
        await record(p, q, "scout", artifacts=[artifact(p, name, content)])


@pytest.mark.asyncio
async def test_artifact_path_cannot_escape_workspace(p, tmp_path):
    q = create(p)
    outside = tmp_path/"private.txt"; outside.write_text("outside")
    with pytest.raises((ValueError, PermissionError)):
        await record(p, q, "scout", artifacts=[str(outside)])
    other = p.state.workspaces.create("other")
    with pytest.raises(ValueError):
        p.research.get(other.workspace_id, q["id"])


def test_stage_prompt_limits_execution_and_requires_record_then_finish(p):
    q = create(p)
    prompt = p.research.prompt("ws_main", q["id"], "scout")
    assert "本次任务仅执行 scout" in prompt
    assert "stage=scout" in prompt
    assert "登记成功后直接总结" in prompt
    assert "仅 baseline 和 experiment" in prompt


@pytest.mark.asyncio
async def test_agent_projection_bounds_repeated_findings_but_ui_keeps_full_record(p):
    q = create(p)
    summary = "Measured evidence. " * 200
    await record(p, q, "scout", summary=summary)
    full = p.research.get("ws_main", q["id"])
    view = p.research.agent_list("ws_main")[0]
    assert full["stages"][0]["summary"] == summary.strip()
    assert "summary" not in view["stages"][0]
    assert len(view["recent_findings"][0]["summary"]) == 500
    assert view["stages"][0]["evidence"] == full["stages"][0]["evidence"]


@pytest.mark.asyncio
async def test_concurrent_records_serialize_without_overwriting(p):
    q = create(p)
    results = await asyncio.gather(record(p, q, "scout"), record(p, q, "scout"), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    assert len(p.research.get("ws_main", q["id"])["findings"]) == 1


@pytest.mark.parametrize("status,expected", [("completed", "needs_evidence"),
    ("failed", "failed"), ("interrupted", "interrupted"), ("cancelled", "cancelled")])
def test_run_terminal_state_is_not_scientific_success(p, status, expected):
    q = create(p);q["stages"][0].update(status="running", run_id="r1")
    p.store.put("research_quest", q["id"], q, "ws_main", expected=q["revision"])
    p.state.events = SimpleNamespace(get_run=lambda _: {"status": status})
    assert p.research.get("ws_main", q["id"])["stages"][0]["status"] == expected


@pytest.mark.asyncio
async def test_quest_api_and_skill_catalog_pagination(p, client_app):
    q = create(p)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app), base_url="http://test") as c:
        response = await c.get("/api/platform/quests")
        assert response.json()["items"][0]["id"] == q["id"]
        response = await c.post(f"/api/platform/quests/{q['id']}/record",
            json={"stage":"scout", "artifacts":[], "summary":"pretend"})
        assert response.status_code == 422
        all_skills = (await c.get("/api/platform/registry/skill")).json()
        page = (await c.get("/api/platform/registry/skill?limit=2&offset=1")).json()
        assert page["items"] == all_skills["items"][1:3]
        assert page["total"] == len(all_skills["items"])


@pytest.mark.asyncio
async def test_agent_cannot_finalize_or_select_another_workspace(p, client_app):
    from omicslab.server.routes_harness import router as harness_router
    q = create(p)
    handle = SimpleNamespace(workspace=p.require_workspace("ws_main"), backend=object(),
        cancel_event=asyncio.Event(), permission_mode="full", status="running")
    async def emit(*args): pass
    p.state.runs = SimpleNamespace(_handles={"r1":handle}, _emit=emit)
    client_app.include_router(harness_router); client_app.state.harness_token="test-only"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app), base_url="http://test") as c:
        async def call(args):
            return await c.post("/api/harness/runs/r1/tool", headers={"authorization":"Bearer test-only"},
                json={"operation":"research_record","arguments":args})
        for args in [{"id":q["id"],"stage":"finalize"}, {"id":q["id"],"stage":"scout","human_approved":True}]:
            assert (await call(args)).status_code == 422
        other = p.state.workspaces.create("other")
        foreign = p.research.create(other.workspace_id, {
            "title":"Foreign","question":"Cannot cross scopes","dataset":"a","protocol":"a",
            "metrics":[{"name":"x","direction":"max"}]})
        assert (await call({"id":foreign["id"],"stage":"scout","scope":other.workspace_id})).status_code == 422
