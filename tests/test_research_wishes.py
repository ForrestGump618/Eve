"""Wish-driven research projects persist real workspace evidence without a new scheduler."""
import hashlib
from types import SimpleNamespace

import httpx
import pytest

from test_suwen_platform import client_app, p  # shared real platform fixture
from omicslab import __version__


WISH = "找出公开数据中与耐药相关的细胞状态，并设计能独立验证它的实验。"


async def start(platform):
    return await platform.wishes.start("ws_main", {"wish": WISH})


def artifact(platform, path, text=None):
    target = platform.settings.workspace / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text or f"evidence for {path}", encoding="utf-8")
    return path


async def complete_charter(platform, wish):
    return await platform.wishes.update("ws_main", wish["id"], {
        "wish": WISH,
        "success_criteria": ["找到可复现的候选细胞状态", "给出可独立验证的实验方案"],
        "boundaries": ["只使用当前工作区与公开数据", "外部副作用需用户确认"],
        "unknowns": ["耐药标签是否可靠", "候选状态能否在独立队列复现"],
        "assumptions": ["现有数据具有可用的样本元数据"],
        "stop_conditions": ["缺少关键数据且无可核验替代", "证据只支持描述性结论"],
    })


@pytest.mark.asyncio
async def test_one_sentence_wish_creates_durable_project_files(p):
    wish = await start(p)
    assert wish["status"] == "active"
    assert wish["phase"] == "charter"
    assert wish["next_actions"][0]["stage"] == "charter"
    base = p.settings.workspace / wish["workspace"]["base"]
    for relative in (
        "README.md", "charter.md", "evidence/ledger.md", "reports/progress.md",
        "data", "evidence", "analysis", "experiments", "figures", "reports", "provenance",
    ):
        assert (base / relative).exists(), relative
    assert WISH in (base / "README.md").read_text(encoding="utf-8")
    assert p.wishes.get("ws_main", wish["id"])["scientific_status"] == "unverified"


@pytest.mark.asyncio
async def test_charter_is_hash_recorded_and_unlocks_scouting(p):
    wish = await complete_charter(p, await start(p))
    charter = next(stage for stage in wish["stages"] if stage["id"] == "charter")
    assert charter["status"] == "recorded"
    assert charter["evidence"][0]["sha256"] == hashlib.sha256(
        (p.settings.workspace / wish["workspace"]["charter"]).read_bytes()
    ).hexdigest()
    assert wish["next_actions"][0]["stage"] == "scouting"
    ledger = (p.settings.workspace / wish["workspace"]["ledger"]).read_text(encoding="utf-8")
    assert "愿望章程" in ledger
    assert charter["evidence"][0]["sha256"] in ledger
    prompt = p.wishes.prompt("ws_main", wish["id"], "scouting", advance=True)
    assert "连续许愿推进" in prompt


@pytest.mark.asyncio
async def test_dependencies_and_real_artifacts_are_enforced(p):
    wish = await start(p)
    path = artifact(p, f"{wish['workspace']['base']}/evidence/scouting.md", "# scouting")
    with pytest.raises(ValueError, match="前序"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "scouting", "artifacts": [path], "summary": "Checked available public data and tools.",
        })
    wish = await complete_charter(p, wish)
    with pytest.raises(ValueError, match="不存在"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "scouting", "artifacts": [f"{wish['workspace']['base']}/evidence/missing.md"],
            "summary": "This file does not exist.",
        })
    wish = await p.wishes.record("ws_main", wish["id"], {
        "stage": "scouting", "artifacts": [path], "summary": "Checked available public data and tools.",
    })
    assert next(stage for stage in wish["stages"] if stage["id"] == "scouting")["status"] == "recorded"
    assert wish["next_actions"][0]["stage"] == "evidence_matrix"


@pytest.mark.asyncio
async def test_full_wish_loop_requires_chart_and_human_review(p):
    wish = await complete_charter(p, await start(p))
    base = wish["workspace"]["base"]
    plan = {
        "scouting": ("evidence/scouting.md", "Inspected workspace data, public resources and runtime capabilities."),
        "evidence_matrix": ("evidence/evidence-matrix.md", "Separated supporting evidence, counterevidence, gaps and source provenance."),
        "hypotheses": ("analysis/hypotheses.md", "Stated competing hypotheses and the observations that would falsify each one."),
        "preregistration": ("experiments/preregistration.md", "Locked primary endpoint, controls, statistics and stopping rules before results."),
        "analysis": ("analysis/results.md", "Executed the preregistered analysis and retained code, environment, logs and null results."),
    }
    for stage, (path, summary) in plan.items():
        wish = await p.wishes.record("ws_main", wish["id"], {
            "stage": stage,
            "artifacts": [artifact(p, f"{base}/{path}", f"# {stage}\n\n{summary}")],
            "summary": summary,
        })
    wish = await p.wishes.record("ws_main", wish["id"], {
        "stage": "experiment_design",
        "artifacts": [artifact(p, f"{base}/experiments/not-applicable.md", "# No wet-lab step\n\nThis computational audit cannot establish causality.")],
        "summary": "No wet-lab experiment is available from the current permissions; an independent cohort is required.",
        "decision": "not_applicable",
    })
    with pytest.raises(ValueError, match="图表"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "figures",
            "artifacts": [artifact(p, f"{base}/figures/figure-plan.md", "# Figure 1")],
            "summary": "Planned the figure sequence but did not provide a real rendered chart artifact.",
        })
    wish = await p.wishes.record("ws_main", wish["id"], {
        "stage": "figures",
        "artifacts": [artifact(p, f"{base}/figures/figure-1.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>")],
        "summary": "Rendered Figure 1 from the registered analysis result and retained its source data path.",
    })
    assert wish["status"] == "awaiting_review"
    assert wish["next_actions"][0]["owner"] == "user"
    with pytest.raises(ValueError, match="人工"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "review", "artifacts": ["review.md"], "summary": "The model tried to close the project itself.",
        })
    with pytest.raises(ValueError, match="明确确认"):
        await p.wishes.review("ws_main", wish["id"], {"reviewer": "User", "notes": "Reviewed all evidence and limitations in detail."})
    wish = await p.wishes.review("ws_main", wish["id"], {
        "confirmed": True, "reviewer": "User",
        "notes": "Reviewed source provenance, analysis outputs, null findings and stated limitations.",
    })
    assert wish["status"] == "completed"
    assert wish["stages"][-1]["evidence"][0]["path"].endswith("reports/review.md")
    assert wish["human_reviewed_at"]


@pytest.mark.asyncio
async def test_blockers_are_explainable_and_scope_is_isolated(p):
    wish = await start(p)
    blocked = await p.wishes.block("ws_main", wish["id"], {
        "reason": "The requested cohort contains identifiable clinical records.",
        "needed": "User must provide de-identified data or approve a lawful public substitute.",
    })
    assert blocked["status"] == "blocked"
    assert blocked["next_actions"] == []
    blocker = blocked["blockers"][0]
    resolved = await p.wishes.block("ws_main", wish["id"], {
        "resolved": True, "blocker_id": blocker["id"],
        "resolution": "User supplied a de-identified public cohort and confirmed its reuse licence.",
    })
    assert resolved["status"] == "active"
    other = p.state.workspaces.create("other")
    with pytest.raises(ValueError, match="不属于"):
        p.wishes.get(other.workspace_id, wish["id"])


@pytest.mark.asyncio
async def test_running_and_blocked_stages_cannot_be_launched_or_recorded(p):
    wish = await complete_charter(p, await start(p))
    raw = p.store.get("research_wish", wish["id"], "ws_main")
    next(stage for stage in raw["stages"] if stage["id"] == "scouting").update(
        status="running", run_id="run-in-flight"
    )
    p.store.put("research_wish", wish["id"], raw, "ws_main", expected=raw["revision"])

    with pytest.raises(ValueError, match="正在执行"):
        p.wishes.launch_target("ws_main", wish["id"], "scouting")
    with pytest.raises(ValueError, match="正在执行"):
        p.wishes.prompt("ws_main", wish["id"], "scouting")

    path = artifact(p, f"{wish['workspace']['base']}/evidence/scouting.md", "# scouting")
    blocked = await p.wishes.block("ws_main", wish["id"], {
        "reason": "A required controlled-access cohort is not available.",
        "needed": "Provide a lawful de-identified substitute or confirm a public cohort.",
    })
    blocker = blocked["blockers"][0]
    with pytest.raises(ValueError, match="阻塞"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "scouting", "artifacts": [path], "summary": "This must not be registered while blocked.",
        })
    resolved = await p.wishes.block("ws_main", wish["id"], {
        "resolved": True, "blocker_id": blocker["id"],
        "resolution": "The public cohort was confirmed and its reuse terms were recorded.",
    })
    assert resolved["status"] == "active"


@pytest.mark.asyncio
async def test_artifacts_are_bound_to_the_wish_and_stage_directories(p):
    wish = await complete_charter(p, await start(p))
    base = wish["workspace"]["base"]
    outside = artifact(p, "research-wishes/not-this-wish/evidence/scouting.md", "# wrong project")
    wrong_stage = artifact(p, f"{base}/data/scouting.md", "# wrong stage")
    valid = artifact(p, f"{base}/evidence/scouting.md", "# real scouting")

    with pytest.raises(ValueError, match="当前愿望工作区"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "scouting", "artifacts": [outside], "summary": "A file from another project must not count.",
        })
    with pytest.raises(ValueError, match="evidence"):
        await p.wishes.record("ws_main", wish["id"], {
            "stage": "scouting", "artifacts": [wrong_stage], "summary": "A file in the wrong stage directory must not count.",
        })
    saved = await p.wishes.record("ws_main", wish["id"], {
        "stage": "scouting", "artifacts": [valid], "summary": "Inspected the public data and retained the real scouting notes.",
    })
    assert next(stage for stage in saved["stages"] if stage["id"] == "scouting")["status"] == "recorded"


@pytest.mark.asyncio
async def test_http_surface_exposes_wish_project_not_raw_state(client_app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app), base_url="http://test") as client:
        created = await client.post("/api/platform/wishes", json={"wish": WISH})
        assert created.status_code == 200
        wish = created.json()
        listed = await client.get("/api/platform/wishes")
        assert listed.status_code == 200
        assert listed.json()["items"][0]["id"] == wish["id"]
        updated = await client.put(f"/api/platform/wishes/{wish['id']}", json={
            "success_criteria": ["A reproducible result"],
            "unknowns": ["Whether the sample is representative"],
            "stop_conditions": ["No lawful data source"],
        })
        assert updated.status_code == 200
        assert updated.json()["phase"] == "scouting"
        invalid_stage = await client.post(f"/api/platform/wishes/{wish['id']}/launch", json={"stage": "not-a-stage"})
        assert invalid_stage.status_code == 422


@pytest.mark.asyncio
async def test_failed_stage_can_be_retried_without_treating_the_old_run_as_active(client_app, p):
    wish = await complete_charter(p, await start(p))
    raw = p.store.get("research_wish", wish["id"], "ws_main")
    next(stage for stage in raw["stages"] if stage["id"] == "scouting").update(
        status="running", run_id="run-old-failed", session_id="session-old"
    )
    p.store.put("research_wish", wish["id"], raw, "ws_main", expected=raw["revision"])

    submitted = []

    async def submit(**kwargs):
        submitted.append(kwargs)
        return {"run": {"run_id": "run-retry", "status": "preparing"}}

    def create_conversation(**_):
        return SimpleNamespace(id="session-retry", meta={}, messages=[], agent="lead")

    p.state.store = SimpleNamespace(
        create=create_conversation,
        save=lambda conversation: conversation,
    )
    p.state.default_agent_info = lambda: {"agent_id": "lead"}
    p.state.events = SimpleNamespace(
        get_run=lambda run_id: {"run_id": run_id, "status": "failed"} if run_id == "run-old-failed" else None
    )
    p.state.runs = SimpleNamespace(submit=submit)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app), base_url="http://test") as client:
        retried = await client.post(f"/api/platform/wishes/{wish['id']}/launch", json={
            "stage": "scouting", "advance": False,
        })

    assert retried.status_code == 200
    assert retried.json()["run"]["run_id"] == "run-retry"
    assert len(submitted) == 1
    saved = p.store.get("research_wish", wish["id"], "ws_main")
    scouting = next(stage for stage in saved["stages"] if stage["id"] == "scouting")
    assert scouting["status"] == "running"
    assert scouting["run_id"] == "run-retry"


@pytest.mark.asyncio
async def test_launch_removes_conversation_when_run_submission_fails(client_app, p):
    wish = await complete_charter(p, await start(p))
    deleted = []

    def create_conversation(**_):
        return SimpleNamespace(id="session-submit-failed", meta={}, messages=[], agent="lead")

    def delete_conversation(session_id):
        deleted.append(session_id)
        return True

    async def submit(**_):
        raise RuntimeError("run engine unavailable")

    p.state.store = SimpleNamespace(
        create=create_conversation,
        save=lambda conversation: conversation,
        delete=delete_conversation,
    )
    p.state.default_agent_info = lambda: {"agent_id": "lead"}
    p.state.runs = SimpleNamespace(submit=submit)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client_app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(f"/api/platform/wishes/{wish['id']}/launch", json={
            "stage": "scouting", "advance": False,
        })

    assert response.status_code == 503
    assert deleted == ["session-submit-failed"]
    saved = p.store.get("research_wish", wish["id"], "ws_main")
    scouting = next(stage for stage in saved["stages"] if stage["id"] == "scouting")
    assert scouting["status"] == "pending"


@pytest.mark.asyncio
async def test_quest_launch_removes_placeholder_when_submission_fails(client_app, p):
    quest = p.research.create("ws_main", {
        "title": "Submission failure regression",
        "question": "Can the launch path avoid orphan conversations?",
        "dataset": "fixture",
        "protocol": "deterministic",
        "metrics": [{"name": "score", "direction": "max"}],
    })
    deleted = []

    def create_conversation(**_):
        return SimpleNamespace(id="quest-submit-failed", meta={}, messages=[], agent="lead")

    async def submit(**_):
        raise RuntimeError("run engine unavailable")

    p.state.store = SimpleNamespace(
        create=create_conversation,
        save=lambda conversation: conversation,
        delete=lambda session_id: deleted.append(session_id),
    )
    p.state.default_agent_info = lambda: {"agent_id": "lead"}
    p.state.runs = SimpleNamespace(submit=submit)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client_app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(
            f"/api/platform/quests/{quest['id']}/launch?scope=ws_main",
            json={"stage": "scout"},
        )

    assert response.status_code == 503
    assert deleted == ["quest-submit-failed"]
    saved = p.store.get("research_quest", quest["id"], "ws_main")
    assert next(stage for stage in saved["stages"] if stage["id"] == "scout")["status"] == "pending"


@pytest.mark.asyncio
async def test_bootstrap_reports_the_running_package_version(client_app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client_app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/platform/bootstrap")
    assert response.status_code == 200
    assert response.json()["version"] == __version__
