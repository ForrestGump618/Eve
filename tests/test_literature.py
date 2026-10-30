"""Literature radar regressions: isolation, provenance, ingestion and delivery."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import subprocess
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

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


@pytest.mark.asyncio
async def test_pubmed_efetch_parses_review_metadata_and_abstract(platform, monkeypatch):
    calls = []
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <PubmedArticleSet>
      <PubmedArticle>
        <MedlineCitation>
          <PMID>12345678</PMID>
          <Article>
            <ArticleTitle>Topological analysis in cancer imaging</ArticleTitle>
            <Abstract>
              <AbstractText Label="RESULTS">Persistence features stratified tissue regions.</AbstractText>
            </Abstract>
            <AuthorList>
              <Author><ForeName>Ada</ForeName><LastName>Lovelace</LastName></Author>
            </AuthorList>
            <Journal>
              <Title>Nature Methods</Title>
              <JournalIssue>
                <PubDate><Year>2026</Year><Month>Oct</Month><Day>3</Day></PubDate>
              </JournalIssue>
            </Journal>
            <PublicationTypeList><PublicationType>Review</PublicationType></PublicationTypeList>
          </Article>
        </MedlineCitation>
        <PubmedData>
          <ArticleIdList><ArticleId IdType="doi">10.1000/pubmed-test</ArticleId></ArticleIdList>
        </PubmedData>
      </PubmedArticle>
    </PubmedArticleSet>"""

    async def http_json(url, params, timeout_s=20):
        calls.append((url, params))
        return {"esearchresult": {"idlist": ["12345678"]}}

    async def http_text(url, params, timeout_s=20):
        calls.append((url, params))
        return xml

    monkeypatch.setattr(platform.literature, "_http_json", http_json)
    monkeypatch.setattr(platform.literature, "_http_text", http_text)
    rows = await platform.literature._pubmed(
        "topology imaging",
        literature_module.date(2026, 9, 1),
        literature_module.date(2026, 10, 30),
        5,
    )

    assert calls[0][1]["db"] == "pubmed"
    assert "2026/09/01:2026/10/30[dp]" in calls[0][1]["term"]
    assert calls[1][1]["id"] == "12345678"
    assert rows[0]["external_id"] == "12345678"
    assert rows[0]["doi"] == "10.1000/pubmed-test"
    assert rows[0]["published"] == "2026-10-03"
    assert rows[0]["authors"] == "Ada Lovelace"
    assert "RESULTS: Persistence features" in rows[0]["abstract"]
    normalized = platform.literature._normalize("pubmed", rows[0], "topology")
    assert normalized["publication_type"] == "review"


@pytest.mark.asyncio
async def test_medrxiv_uses_server_specific_endpoint_and_provenance(platform, monkeypatch):
    calls = []

    async def http_json(url, params, timeout_s=20):
        calls.append(url)
        return {
            "collection": [
                {
                    "doi": "10.1101/2026.10.01.123456",
                    "title": "Brain imaging cohort methods",
                    "abstract": "Brain imaging methods for a clinical cohort.",
                    "authors": "A. Author",
                    "date": "2026-10-02",
                    "version": "1",
                }
            ]
        }

    monkeypatch.setattr(platform.literature, "_http_json", http_json)
    rows = await platform.literature._medrxiv(
        "brain imaging",
        literature_module.date(2026, 10, 1),
        literature_module.date(2026, 10, 30),
        5,
    )

    assert "api.biorxiv.org/details/medrxiv/" in calls[0]
    assert rows[0]["source"] == "medrxiv"
    assert rows[0]["venue"] == "medRxiv"
    assert rows[0]["url"].startswith("https://www.medrxiv.org/content/")


@pytest.mark.asyncio
async def test_reference_ingest_resolves_doi_and_rejects_unknown_url(platform, monkeypatch):
    async def openalex(query, start, end, limit, timeout_s=20):
        return [
            raw_paper(
                "Reference resolved by DOI",
                doi="https://doi.org/10.1000/resolved",
            )
        ]

    monkeypatch.setattr(platform.literature, "_openalex", openalex)
    item = await platform.literature._resolve_reference(
        "ws_main",
        "https://doi.org/10.1000/resolved",
    )
    assert item["doi"] == "10.1000/resolved"
    assert item["resolved_by"] == "DOI"
    assert item["user_fed"] is True

    with pytest.raises(ValueError, match="只支持"):
        await platform.literature._resolve_reference(
            "ws_main",
            "https://example.org/not-an-academic-source",
        )


@pytest.mark.asyncio
async def test_reference_ingest_detects_existing_paper(platform, monkeypatch):
    async def resolved(scope, reference):
        return {
            "id": "paper_existing_reference",
            "title": "Existing reference",
            "source": "pubmed",
        }

    platform.store.put(
        "literature",
        "paper_existing_reference",
        {"title": "Existing reference"},
        "ws_main",
    )
    monkeypatch.setattr(platform.literature, "_resolve_reference", resolved)
    result = await platform.literature.ingest_reference(
        "ws_main",
        "PMID: 12345678",
    )
    assert result["duplicate"] is True
    assert result["item"]["id"] == "paper_existing_reference"
    assert result["reflection"] is None


def _interaction_fixture(platform):
    paper, reflection = support_records(platform, "interaction")
    feed = platform.store.put(
        "literature_feed",
        "feed_interaction",
        {
            "id": "feed_interaction",
            "literature_id": paper["id"],
            "title": paper["title"],
            "note": "A method note",
            "source": "pubmed",
            "created_at": time.time(),
        },
        "ws_main",
    )
    message = platform.store.put(
        "literature_message",
        "message_interaction",
        {
            "id": "message_interaction",
            "literature_id": paper["id"],
            "reflection_id": reflection["id"],
            "title": paper["title"],
            "body": "Consider the conflicting evidence.",
            "status": "queued",
            "created_at": time.time(),
            "expires_at": time.time() + 3600,
        },
        "ws_main",
    )
    return paper, reflection, feed, message


@pytest.mark.asyncio
async def test_feed_comment_creates_visible_agent_reply_and_pending_correction(
    platform,
    monkeypatch,
):
    paper, _, _, _ = _interaction_fixture(platform)

    async def response(scope, *, context, text, mode):
        assert context["paper"]["id"] if "id" in context["paper"] else context["paper"]["title"]
        return {
            "reply": "证据只支持特定组织类型，不能直接外推。",
            "stance": "disagree",
            "adjustment": "把外推范围限制在具有相同成像协议的数据集。",
            "confidence": 0.82,
            "model": "reflection-model",
            "model_error": "",
        }

    monkeypatch.setattr(platform.literature, "_interaction_response", response)
    result = await platform.literature.comment(
        "ws_main",
        "feed_interaction",
        "这个结论能外推到所有队列吗？",
    )

    assert result["comment"]["author"] == "user"
    assert result["agent_comment"]["author"] == "agent"
    assert result["agent_comment"]["stance"] == "disagree"
    assert result["adjustment_candidate"]["kind"] == "correction"
    refs = result["adjustment_candidate"]["evidence_refs"]
    assert f"literature:{paper['id']}" in refs
    assert f"comment:{result['comment']['id']}" in refs
    comments = platform.literature.feed("ws_main", 10)["items"][0]["comments"]
    assert [row["author"] for row in comments] == ["user", "agent"]


@pytest.mark.asyncio
async def test_feed_comment_keeps_user_text_when_model_is_unavailable(
    platform,
    monkeypatch,
):
    _interaction_fixture(platform)

    async def unavailable(*args, **kwargs):
        raise RuntimeError("model offline")

    monkeypatch.setattr(platform.literature, "_model_json", unavailable)
    result = await platform.literature.comment(
        "ws_main",
        "feed_interaction",
        "补充一条相反证据。",
    )

    assert result["comment"]["text"] == "补充一条相反证据。"
    assert result["agent_comment"]["model_error"]
    assert "已保存" in result["agent_comment"]["text"]
    assert result["adjustment_candidate"] is None


@pytest.mark.asyncio
async def test_proactive_share_reply_uses_same_reviewable_dialogue_contract(
    platform,
    monkeypatch,
):
    paper, _, _, _ = _interaction_fixture(platform)

    async def response(scope, *, context, text, mode):
        return {
            "reply": "我会缩小结论，并把验证条件写入下一步。",
            "stance": "adjust",
            "adjustment": "在复现前增加独立队列校准。",
            "confidence": 0.74,
            "model": "reflection-model",
            "model_error": "",
        }

    monkeypatch.setattr(platform.literature, "_interaction_response", response)
    result = await platform.literature.reply_proactive(
        "ws_main",
        "message_interaction",
        "现有数据不足以支持这个外推。",
    )

    assert result["reply"]["author"] == "user"
    assert result["agent_reply"]["author"] == "agent"
    assert result["adjustment_candidate"]["kind"] == "correction"
    assert f"literature:{paper['id']}" in result["adjustment_candidate"]["evidence_refs"]
    assert f"reply:{result['reply']['id']}" in result["adjustment_candidate"]["evidence_refs"]
    assert "现有数据不足" in result["chat_prompt"]


@pytest.mark.asyncio
async def test_feishu_and_dingtalk_webhooks_validate_domains_and_sign(platform, monkeypatch):
    import omicslab.suwen.extensions as extensions

    assert platform.channels.capabilities("feishu")["outbound"] is True
    assert platform.channels.capabilities("feishu")["inbound"] is False
    assert platform.channels.capabilities("dingtalk")["outbound"] is True
    assert platform.channels.capabilities("dingtalk")["inbound"] is False
    with pytest.raises(ValueError, match="官方 HTTPS"):
        platform.channels._webhook_url(
            "feishu",
            "https://example.org/open-apis/bot/v2/hook/token",
        )
    with pytest.raises(ValueError, match="官方 HTTPS"):
        platform.channels._webhook_url(
            "dingtalk",
            "http://oapi.dingtalk.com/robot/send?access_token=token",
        )

    captured = []

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"code": 0, "errcode": 0}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, target, json):
            captured.append((target, json))
            return FakeResponse()

    monkeypatch.setattr(extensions.httpx, "AsyncClient", FakeClient)
    platform.vault.put(
        "feishu_hook",
        "https://open.feishu.cn/open-apis/bot/v2/hook/token",
        persist=False,
    )
    platform.vault.put("feishu_sign", "feishu-secret", persist=False)
    platform.store.put(
        "channel",
        "channel_feishu",
        {
            "name": "Feishu",
            "adapter": "feishu",
            "workspace": "ws_main",
            "enabled": True,
            "allow_send": True,
            "webhook_ref": "feishu_hook",
            "credential_ref": "feishu_sign",
            "capabilities": platform.channels.capabilities("feishu"),
        },
    )
    await platform.channels.send("channel_feishu", "", "hello", approved=True)
    feishu_payload = captured[-1][1]
    expected_feishu = base64.b64encode(
        hmac.new(
            f"{feishu_payload['timestamp']}\nfeishu-secret".encode(),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode()
    assert feishu_payload["sign"] == expected_feishu

    platform.vault.put(
        "dingtalk_hook",
        "https://oapi.dingtalk.com/robot/send?access_token=token",
        persist=False,
    )
    platform.vault.put("dingtalk_sign", "dingtalk-secret", persist=False)
    platform.store.put(
        "channel",
        "channel_dingtalk",
        {
            "name": "DingTalk",
            "adapter": "dingtalk",
            "workspace": "ws_main",
            "enabled": True,
            "allow_send": True,
            "webhook_ref": "dingtalk_hook",
            "credential_ref": "dingtalk_sign",
            "capabilities": platform.channels.capabilities("dingtalk"),
        },
    )
    await platform.channels.send("channel_dingtalk", "", "hello", approved=True)
    dingtalk_target, dingtalk_payload = captured[-1]
    query = parse_qs(urlsplit(dingtalk_target).query)
    timestamp = query["timestamp"][0]
    expected_dingtalk = base64.b64encode(
        hmac.new(
            b"dingtalk-secret",
            f"{timestamp}\ndingtalk-secret".encode(),
            hashlib.sha256,
        ).digest()
    ).decode()
    assert query["sign"][0] == expected_dingtalk
    assert dingtalk_payload["msgtype"] == "text"


@pytest.mark.asyncio
async def test_real_pdf_upload_parser_and_password_error(platform, monkeypatch):
    import io
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer=PdfWriter()
    page=writer.add_blank_page(width=400,height=400)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream=DecodedStreamObject();stream.set_data(b'BT /F1 12 Tf 20 300 Td (A reproducible biological experiment) Tj ET')
    page[NameObject('/Contents')]=writer._add_object(stream)
    data=io.BytesIO();writer.write(data)
    from omicslab.suwen.knowledge import parse_document
    assert 'biological experiment' in parse_document('paper.pdf',data.getvalue())[0][1]
    # Real multipart upload through the production route, without an LLM call.
    async def finish(scope,item,settings,**kwargs):return {'item':item,'reflection':None,'candidate_ids':[],'model_error':''}
    monkeypatch.setattr(platform.literature,'_finish_ingest',finish)
    app=FastAPI();app.state.omicslab=platform.state;app.include_router(literature_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://test') as client:
        response=await client.post('/api/literature/ingest?scope=ws_main',files={'file':('paper.pdf',data.getvalue(),'application/pdf')})
    assert response.status_code==200,response.text
    writer.encrypt('secret');encrypted=io.BytesIO();writer.write(encrypted)
    with pytest.raises(ValueError,match='密码'):
        parse_document('private.pdf',encrypted.getvalue())


@pytest.mark.asyncio
async def test_background_search_survives_request_end_and_is_workspace_scoped(platform,monkeypatch):
    release=asyncio.Event();started=asyncio.Event();queries=[]
    async def source(source,query,*args):
        queries.append(query);started.set();await release.wait();return [raw_paper('Autonomous result')]
    monkeypatch.setattr(platform.literature,'_source_search',source)
    app=FastAPI();app.state.omicslab=platform.state;app.include_router(literature_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://test') as client:
        result=await client.post('/api/literature/search',json={'background':True,'query':'','sources':['pubmed'],'ground_novelty':False})
        assert result.status_code==200,result.text
        assert result.json()['status']=='running'
        await asyncio.wait_for(started.wait(),1)
        # A second view/request attaches to the same job instead of dispatching twice.
        second=await client.post('/api/literature/search',json={'background':True,'query':'','sources':['pubmed']})
        assert second.json()['job_id']==result.json()['job_id']
        assert platform.literature.job_status('other','search') is None
        release.set();await asyncio.gather(*platform.literature.jobs.values())
        status=(await client.get('/api/literature/status')).json()
        assert status['jobs']['search']['status']=='completed'
        assert status['jobs']['search']['result']['items'][0]['title']=='Autonomous result'
        assert queries and ' OR ' in queries[0]


@pytest.mark.asyncio
async def test_background_shutdown_is_interrupted_not_stuck_running(platform):
    async def wait():await asyncio.Event().wait()
    platform.literature.dispatch('ws_main','search',wait)
    await asyncio.sleep(0)
    await platform.literature.close()
    assert platform.literature.job_status('ws_main','search')['status']=='interrupted'


@pytest.mark.asyncio
async def test_retrieval_retries_and_coalesces_identical_calls(platform):
    calls=[]
    async def handler(request):
        calls.append(request)
        return httpx.Response(503 if len(calls)==1 else 200,json={'result':'real fixture'})
    platform.literature._client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        results=await asyncio.gather(*(platform.literature._http_json('https://example.invalid/search',{'q':'same'}) for _ in range(4)))
        assert len(calls)==2
        assert all(item=={'result':'real fixture'} for item in results)
    finally:
        await platform.literature.close()


@pytest.mark.asyncio
async def test_all_sources_unavailable_is_failure_not_success(platform,monkeypatch):
    async def broken(*args):raise httpx.ConnectError('offline')
    monkeypatch.setattr(platform.literature,'_source_search',broken)
    result=await platform.literature.search('ws_main','',sources=['pubmed'],ground_novelty=False)
    assert result['status']=='failed'
    assert result['source_status']['pubmed']['status']=='unavailable'
