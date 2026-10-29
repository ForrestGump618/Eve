"""Literature radar regressions: isolation, provenance, ingestion and delivery."""
from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from omicslab.agent.templates import load_agents
from omicslab.agent.tools import build_registry
from omicslab.config import Settings
from omicslab.server.routes_literature import router as literature_router
from omicslab.suwen import literature as literature_module
from omicslab.suwen.service import Platform
from omicslab.workspace.service import WorkspaceService


@pytest.fixture
def platform(tmp_path):
    settings = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    settings.ensure_dirs()
    workspaces = WorkspaceService(settings)
    state = SimpleNamespace(
        settings=settings,
        workspaces=workspaces,
        registry=build_registry(settings),
        agents=load_agents(settings),
        loop=SimpleNamespace(),
        llm_info=lambda: {
            "provider": "mock",
            "model": "mock-model",
            "configured": True,
        },
        vision_info=lambda: {
            "enabled": False,
            "configured": False,
            "model": "",
            "base_url": "",
            "has_key": False,
        },
        rebuild_approver=lambda: None,
    )
    store = __import__(
        "omicslab.session.store",
        fromlist=["ConversationStore"],
    ).ConversationStore(settings)
    state.store = store
    service = Platform(state)
    state.platform = service
    yield service
    service.store.close()


def raw_paper(
    title: str,
    *,
    doi: str = "",
    published: str = "2026-10-20",
    abstract: str = "A biomedical method and validation result.",
) -> dict:
    return {
        "title": title,
        "doi": doi,
        "published": published,
        "abstract": abstract,
        "authors": "A. Author",
        "venue": "Journal",
        "url": f"https://example.test/{abs(hash(title))}",
        "external_id": title,
        "peer_reviewed": True,
        "metadata_type": "article",
        "citation_count": 1,
    }


def support_records(platform: Platform, suffix: str = "x") -> tuple[dict, dict]:
    paper = platform.store.put(
        "literature",
        f"paper_{suffix}",
        {
            "id": f"paper_{suffix}",
            "title": "A grounded paper",
            "abstract": "Abstract",
            "source": "europe_pmc",
            "scores": {"interestingness": 0.6},
            "created_at": time.time(),
        },
        "ws_main",
    )
    reflection = platform.store.put(
        "literature_reflection",
        f"reflection_{suffix}",
        {
            "id": f"reflection_{suffix}",
            "paper_title": paper["title"],
            "literature_id": paper["id"],
            "summary": "Summary",
            "status": "pending",
            "created_at": time.time(),
        },
        "ws_main",
    )
    return paper, reflection


@pytest.mark.asyncio
async def test_search_isolates_source_failure_and_deduplicates_doi(platform, monkeypatch):
    platform.config.update(
        "literature",
        {"min_interestingness": 0, "deep_read_limit": 0},
        "ws_main",
    )
    calls = []

    async def source_search(source, query, start, end, limit, timeout_s=20):
        calls.append(source)
        if source == "europe_pmc":
            raise RuntimeError("provider offline")
        return [
            raw_paper(
                "Shared DOI result",
                doi="https://doi.org/10.1000/SAME",
            )
        ]

    monkeypatch.setattr(platform.literature, "_source_search", source_search)
    result = await platform.literature.search(
        "ws_main",
        "biomedical",
        sources=["europe_pmc", "openalex"],
        ground_novelty=False,
        min_interestingness=0,
    )
    assert calls == ["europe_pmc", "openalex"]
    assert [item["title"] for item in result["items"]] == ["Shared DOI result"]
    assert result["warnings"][0]["source"] == "europe_pmc"
    assert "provider offline" in result["warnings"][0]["message"]


@pytest.mark.asyncio
async def test_search_deduplicates_title_when_doi_is_missing(platform, monkeypatch):
    platform.config.update(
        "literature",
        {"min_interestingness": 0, "deep_read_limit": 0},
        "ws_main",
    )

    async def source_search(source, query, start, end, limit, timeout_s=20):
        if source == "europe_pmc":
            return [raw_paper("Same title, no DOI")]
        return [raw_paper("Same title, no DOI")]

    monkeypatch.setattr(platform.literature, "_source_search", source_search)
    result = await platform.literature.search(
        "ws_main",
        "biomedical",
        sources=["europe_pmc", "openalex"],
        ground_novelty=False,
        min_interestingness=0,
    )
    assert len(result["items"]) == 1


@pytest.mark.asyncio
async def test_literature_routes_reject_unknown_workspace(platform):
    app = FastAPI()
    app.state.omicslab = platform.state
    app.include_router(literature_router)

    @app.exception_handler(PermissionError)
    async def permission_error(request: Request, exc: PermissionError):
        return JSONResponse({"error": str(exc)}, status_code=403)

    @app.exception_handler(ValueError)
    async def value_error(request: Request, exc: ValueError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        for method, path in (
            ("GET", "/api/literature/status?scope=missing"),
            ("GET", "/api/literature/feed?scope=missing"),
            ("GET", "/api/literature/proactive?scope=missing"),
            ("POST", "/api/literature/run?scope=missing"),
            ("POST", "/api/literature/proactive/message-id/dismiss?scope=missing"),
        ):
            response = await client.request(method, path, json={})
            assert response.status_code == 400, (method, path, response.text)
        invalid_source = await client.post(
            "/api/literature/search?scope=ws_main",
            json={"query": "microbiome", "sources": ["unknown"]},
        )
        assert invalid_source.status_code == 422
        invalid_rating = await client.post(
            "/api/literature/feedback?scope=ws_main",
            json={"paper_id": "missing", "rating": "high"},
        )
        assert invalid_rating.status_code == 422


@pytest.mark.asyncio
async def test_prior_art_is_strictly_earlier_than_focus_paper(platform, monkeypatch):
    focus = platform.literature._normalize(
        "openalex",
        raw_paper("Focus paper", published="2024-06-01"),
        "focus",
    )
    assert focus is not None

    async def source_search(source, query, start, end, limit, timeout_s=20):
        return [
            raw_paper("Older work", published="2024-05-31"),
            raw_paper("Same day work", published="2024-06-01"),
            raw_paper("Later work", published="2024-07-01"),
        ]

    monkeypatch.setattr(platform.literature, "_source_search", source_search)
    rows, error = await platform.literature._prior_art(focus, 5)
    assert error == ""
    assert [row["title"] for row in rows] == ["Older work"]
    assert rows[0]["published"] < focus["published"]


@pytest.mark.asyncio
async def test_missing_prior_art_never_fabricates_novelty(platform, monkeypatch):
    focus = platform.literature._normalize(
        "openalex",
        raw_paper("Focus paper", published="2024-06-01"),
        "focus",
    )
    assert focus is not None

    async def no_prior(item, limit, timeout_s=20):
        return [], ""

    monkeypatch.setattr(platform.literature, "_prior_art", no_prior)
    platform.literature._score(
        "ws_main",
        focus,
        "focus",
        platform.literature.settings("ws_main"),
    )
    await platform.literature._ground_novelty(
        focus,
        platform.literature.settings("ws_main"),
    )
    assert focus["novelty_grounded"] is None
    assert focus["novelty_status"] == "no_prior_art"
    assert focus["scores"]["grounded_novelty"] is None


@pytest.mark.asyncio
async def test_year_only_focus_paper_never_receives_grounded_novelty(
    platform,
    monkeypatch,
):
    focus = platform.literature._normalize(
        "openalex",
        raw_paper("Year-only focus paper", published="2024"),
        "focus",
    )
    assert focus is not None
    platform.literature._score(
        "ws_main",
        focus,
        "focus",
        platform.literature.settings("ws_main"),
    )

    async def should_not_run(*args, **kwargs):
        raise AssertionError("prior-art search must not run without a precise date")

    monkeypatch.setattr(platform.literature, "_source_search", should_not_run)
    await platform.literature._ground_novelty(
        focus,
        platform.literature.settings("ws_main"),
    )
    assert focus["novelty_grounded"] is None
    assert focus["novelty_status"] == "unavailable"
    assert "年份或月份" in focus["novelty_note"]


def test_pdf_path_cannot_escape_workspace(platform, tmp_path):
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-outside")
    with pytest.raises(ValueError, match="越过当前工作区"):
        platform.literature._workspace_file("ws_main", "../outside.pdf")


def test_pdf_path_rejects_symlink(platform, tmp_path):
    root = platform.require_workspace("ws_main").root
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-outside")
    link = root / "linked.pdf"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")
    with pytest.raises(ValueError, match="符号链接|目录联接"):
        platform.literature._workspace_file("ws_main", "linked.pdf")


def test_pdf_path_rejects_windows_junction(platform, tmp_path):
    if os.name != "nt":
        pytest.skip("Windows junction contract")
    root = platform.require_workspace("ws_main").root
    outside = tmp_path / "outside-directory"
    outside.mkdir()
    (outside / "outside.pdf").write_bytes(b"%PDF-outside")
    junction = root / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"junction creation unavailable: {result.stderr}")
    try:
        with pytest.raises(ValueError, match="符号链接|目录联接"):
            platform.literature._workspace_file("ws_main", "junction/outside.pdf")
    finally:
        junction.rmdir()


@pytest.mark.asyncio
async def test_pdf_ingest_rejects_oversize_corrupt_and_duplicate(platform, monkeypatch):
    platform.config.update("literature", {"max_upload_mb": 1}, "ws_main")
    with pytest.raises(ValueError, match="大小限制"):
        await platform.literature.ingest(
            "ws_main",
            name="large.pdf",
            data=b"x" * 1_000_001,
        )

    def corrupt(name, data):
        raise ValueError("invalid pdf")

    monkeypatch.setattr(literature_module, "parse_document", corrupt)
    with pytest.raises(ValueError, match="文献解析失败"):
        await platform.literature.ingest(
            "ws_main",
            name="broken.pdf",
            data=b"%PDF-broken",
        )

    payload = b"duplicate-payload"
    digest = hashlib.sha256(payload).hexdigest()
    platform.store.put(
        "literature",
        "paper_duplicate",
        {
            "id": "paper_duplicate",
            "title": "Existing paper",
            "digest": digest,
        },
        "ws_main",
    )
    duplicate = await platform.literature.ingest(
        "ws_main",
        name="duplicate.pdf",
        data=payload,
    )
    assert duplicate["duplicate"] is True
    assert duplicate["item"]["id"] == "paper_duplicate"
    assert duplicate["candidate_ids"] == []
    assert duplicate["model_error"] == ""


def test_proactive_cooldown_defers_instead_of_destroying_message(platform):
    paper, reflection = support_records(platform)
    now = time.time()
    platform.store.put(
        "literature_message",
        "sent_message",
        {
            "status": "sent",
            "sent_at": now,
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "project_ids": [],
            "expires_at": now + 3600,
        },
        "ws_main",
    )
    platform.store.put(
        "literature_message",
        "queued_message",
        {
            "status": "queued",
            "created_at": now,
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "project_ids": [],
            "expires_at": now + 3600,
        },
        "ws_main",
    )
    result = platform.literature.proactive("ws_main")
    assert result["items"] == []
    assert result["deferred"] == 1
    assert (
        platform.store.get("literature_message", "queued_message", "ws_main")["status"]
        == "queued"
    )
    with pytest.raises(ValueError, match="冷却期"):
        platform.literature.send_proactive("ws_main", "queued_message")
    assert (
        platform.store.get("literature_message", "queued_message", "ws_main")["status"]
        == "queued"
    )


def test_proactive_daily_quota_defers_and_expiry_invalidates(platform):
    paper, reflection = support_records(platform)
    now = time.time()
    platform.config.update(
        "literature",
        {
            "proactive_cooldown_minutes": 0,
            "proactive_daily_limit": 1,
        },
        "ws_main",
    )
    platform.store.put(
        "literature_message",
        "sent_today",
        {
            "status": "sent",
            "sent_at": now,
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "project_ids": [],
            "expires_at": now + 3600,
        },
        "ws_main",
    )
    platform.store.put(
        "literature_message",
        "deferred_quota",
        {
            "status": "queued",
            "created_at": now,
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "project_ids": [],
            "expires_at": now + 3600,
        },
        "ws_main",
    )
    platform.store.put(
        "literature_message",
        "expired_message",
        {
            "status": "queued",
            "created_at": now - 7200,
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "project_ids": [],
            "expires_at": now - 1,
        },
        "ws_main",
    )
    result = platform.literature.proactive("ws_main")
    assert result["items"] == []
    assert result["deferred"] == 1
    assert (
        platform.store.get("literature_message", "deferred_quota", "ws_main")["status"]
        == "queued"
    )
    expired = platform.store.get("literature_message", "expired_message", "ws_main")
    assert expired["status"] == "stale"
    assert expired["stale_reason"] == "消息已过期"


@pytest.mark.asyncio
async def test_disabled_literature_coordinator_does_not_run_and_closes_cleanly(
    platform,
    monkeypatch,
):
    platform.config.update(
        "literature",
        {
            "enabled": False,
            "daily_enabled": False,
            "startup_delay_seconds": 0,
            "check_interval_seconds": 60,
        },
        "ws_main",
    )
    called = []

    async def run(*args, **kwargs):
        called.append((args, kwargs))
        return {"status": "completed"}

    monkeypatch.setattr(platform.literature, "run", run)
    coordinator = platform.literature_coordinator
    await coordinator.start()
    await asyncio.sleep(0.02)
    await coordinator.close()

    assert called == []
    assert coordinator.task is None
    status = platform.literature.status("ws_main")
    assert status["enabled"] is False
    assert status["daily_enabled"] is False
