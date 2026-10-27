"""REST API routes (conversations, kernel, files, agents, skills, memory, jobs, figures, settings)."""

from __future__ import annotations

import logging
import os
import platform
import re
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File, Form
from fastapi.responses import FileResponse

from ..agent.providers import ProviderConfig, make_provider
from ..config import ConfigError
from ..server import files as fileops
from ..server.state import figures_dir, public_settings
from ..utils import truncate

logger = logging.getLogger("omicslab.server.routes")
router = APIRouter()


def _state(request: Request):
    return request.app.state.omicslab


def _error(message: str, code: str = "bad_request", status: int = 400, detail: str = "") -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code, "detail": detail})


# ---------------------------------------------------------------- conversations
@router.get("/api/conversations")
async def list_conversations(request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        items = state.store.list()
    except Exception as exc:
        raise _error(f"读取会话列表失败：{exc}", "store_error", 500) from exc
    return {"conversations": items}


@router.post("/api/conversations")
async def create_conversation(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    agent = str(payload.get("agent") or state.settings.default_agent or "lead")
    title = str(payload.get("title") or "新会话")
    try:
        conv = state.store.create(agent=agent, title=title)
    except Exception as exc:
        raise _error(f"创建会话失败：{exc}", "store_error", 500) from exc
    from .chat import _workspace_binding
    _workspace_binding(state, conv, str(payload.get("workspace_id") or "").strip() or None)
    return conv.to_dict()


@router.get("/api/conversations/{cid}")
async def get_conversation(cid: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        conv = state.store.get(cid)
    except Exception as exc:
        raise _error(f"会话不存在：{cid}", "not_found", 404, str(exc)) from exc
    return conv.to_dict()


@router.patch("/api/conversations/{cid}")
async def rename_conversation(cid: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    patch = {key: payload[key] for key in ("title", "archived", "pinned") if key in payload}
    if not patch or ("title" in patch and not str(patch["title"] or "").strip()):
        raise _error("需要非空标题或归档 / 置顶状态")
    try:
        conv = state.store.update_metadata(cid, patch)
        if state.runs is not None:
            for handle in state.runs._handles.values():
                if handle.session_id == cid:
                    handle.conversation.title = conv.title
                    for key in ("archived", "pinned"):
                        if key in conv.meta:
                            handle.conversation.meta[key] = conv.meta[key]
    except ValueError as exc:
        raise _error(str(exc)) from exc
    except KeyError as exc:
        raise _error("会话不存在", "not_found", 404) from exc
    return conv.to_dict()


@router.patch("/api/conversations/{cid}/execution")
async def conversation_execution(cid: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    conv = state.store.get(cid)
    runs = getattr(state, "runs", None)
    if runs is not None:
        handle = next((h for h in runs._handles.values() if h.session_id == cid), None)
        if handle is not None:
            conv = handle.conversation
    payload = await _json(request)
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    from ..agent.permissions import validate_mode
    try:
        mode = validate_mode(payload.get("permission_mode", "ask"))
        if len(model) > 160 or any(ord(c) < 32 for c in model):
            raise ValueError("模型名称无效")
        if provider or model:
            state.settings.resolve_llm(provider or None, model or None)
    except (ValueError, ConfigError) as exc:
        raise _error(str(exc), "invalid_execution", 400)
    conv.meta["execution"] = {"provider": provider, "model": model, "permission_mode": mode}
    state.store.save(conv)
    return conv.to_dict()


@router.delete("/api/conversations/{cid}")
async def delete_conversation(cid: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    state.stop_run(cid)
    try:
        ok = state.store.delete(cid)
    except Exception as exc:
        raise _error(f"删除失败：{exc}", "store_error", 500) from exc
    return {"ok": ok}


# ---------------------------------------------------------------------- kernel
@router.get("/api/kernel/status")
async def kernel_status(request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.kernel.status()
    except Exception as exc:
        return {"running": False, "python": "", "pid": None, "started_at": None,
                "kernel_name": "omicslab", "error": str(exc)}


@router.post("/api/kernel/execute")
async def kernel_execute(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    code = str(payload.get("code") or "")
    if not code.strip():
        raise _error("code 不能为空")
    timeout = payload.get("timeout_s")
    try:
        result = await state.kernel.execute(code, timeout_s=_safe_float(timeout, state.settings.kernel_timeout_s))
    except Exception as exc:
        raise _error(f"内核执行失败：{exc}", "kernel_error", 500) from exc
    return result


@router.post("/api/kernel/restart")
async def kernel_restart(request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        await state.kernel.restart()
    except Exception as exc:
        raise _error(f"内核重启失败：{exc}", "kernel_error", 500) from exc
    return state.kernel.status()


@router.post("/api/kernel/interrupt")
async def kernel_interrupt(request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        await state.kernel.interrupt()
        return {"ok": True}
    except Exception as exc:
        raise _error(f"中断失败：{exc}", "kernel_error", 500) from exc


@router.get("/api/kernel/vars")
async def kernel_vars(request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        items = await state.kernel.list_vars()
    except Exception as exc:
        return {"vars": [], "running": bool(state.kernel.running), "error": str(exc)}
    return {"vars": items, "running": bool(state.kernel.running)}


@router.get("/api/kernel/var_detail")
async def kernel_var_detail(request: Request, name: str = Query(..., min_length=1)) -> dict[str, Any]:
    state = _state(request)
    try:
        return await state.kernel.var_detail(name)
    except Exception as exc:
        raise _error(f"读取变量失败：{exc}", "kernel_error", 400) from exc


# ----------------------------------------------------------------------- files
@router.get("/api/files/tree")
async def files_tree(request: Request, path: str = ".") -> dict[str, Any]:
    state = _state(request)
    try:
        return fileops.list_dir(state.settings, path)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


@router.get("/api/files/read")
async def files_read(request: Request, path: str = Query(...), max_bytes: int = 200_000) -> dict[str, Any]:
    state = _state(request)
    try:
        return fileops.read_text(state.settings, path, max_bytes=max_bytes)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


@router.get("/api/files/raw")
async def files_raw(request: Request, path: str = Query(...)):
    state = _state(request)
    try:
        target = fileops.resolve_path(state.settings, path)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc
    if not target.exists() or not target.is_file():
        raise _error(f"文件不存在：{path}", "not_found", 404)
    return FileResponse(str(target), media_type=fileops.guess_mime(target), filename=target.name)


@router.post("/api/files/upload")
async def files_upload(
    request: Request,
    file: UploadFile = File(...),
    dir: str = Form("."),
) -> dict[str, Any]:
    state = _state(request)
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise _error("文件超过 200MB 限制", "too_large", 413)
    try:
        return fileops.save_upload(state.settings, dir, file.filename or "upload.bin", data)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


@router.post("/api/files/write")
async def files_write(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    path = str(payload.get("path") or "").strip()
    if not path:
        raise _error("path 不能为空")
    try:
        return fileops.write_text(state.settings, path, str(payload.get("content") or ""))
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


@router.post("/api/files/mkdir")
async def files_mkdir(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    path = str(payload.get("path") or "").strip()
    if not path:
        raise _error("path 不能为空")
    try:
        return fileops.make_dir(state.settings, path)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


@router.delete("/api/files")
async def files_delete(request: Request, path: str = Query(...)) -> dict[str, Any]:
    state = _state(request)
    try:
        return fileops.delete_path(state.settings, path)
    except fileops.WorkspaceError as exc:
        raise _error(str(exc), "path_error") from exc


# ------------------------------------------------------- agents / skills / memory
@router.get("/api/agents")
async def list_agents(request: Request) -> dict[str, Any]:
    state = _state(request)
    state.refresh_agents()
    return {"agents": [agent.to_dict() for agent in state.agents.values()]}


@router.get("/api/skills")
async def list_skills(request: Request) -> dict[str, Any]:
    state = _state(request)
    state.refresh_skills()
    items = []
    for skill in state.skills.values():
        items.append(
            {
                "name": skill.name,
                "description": skill.description,
                "when_to_use": skill.when_to_use,
                "source": skill.source,
                "path": str(skill.path),
            }
        )
    adapter = getattr(state.loop, "desktop_harness", None)
    if adapter:
        native = await adapter.rpc("skill.list")
        for skill in native.get("skills", []):
            items = [item for item in items if item["name"] != skill["name"]]
            items.append({**skill, "runtime":"desktop", "when_to_use":"由统一 Harness 按需加载"})
    return {"skills": items}


@router.get("/api/skills/{name}")
async def skill_detail(name: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    adapter = getattr(state.loop, "desktop_harness", None)
    if adapter:
        native = await adapter.rpc("skill.list")
        record = next((item for item in native.get("skills", []) if item["name"] == name), None)
        if record:
            loaded = await adapter.rpc("skill.load", id=record["id"])
            return {**record,"runtime":"desktop","body":loaded["instructions"],"files":[],"when_to_use":"可执行脚本" if loaded.get("run") else "按需加载的工作流指引"}
    skill = state.skills.get(name)
    if skill is None:
        state.refresh_skills()
        skill = state.skills.get(name)
    if skill is None:
        raise _error(f"技能不存在：{name}", "not_found", 404)
    return {
        "name": skill.name,
        "description": skill.description,
        "when_to_use": skill.when_to_use,
        "body": skill.body,
        "files": skill.files,
        "path": str(skill.path),
        "source": skill.source,
    }


@router.get("/api/memory")
async def memory_list(request: Request) -> dict[str, Any]:
    state = _state(request)
    return {"items": state.memory.list()}


@router.get("/api/memory/{slug}")
async def memory_get(slug: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.memory.get(slug)
    except Exception as exc:
        raise _error(f"记忆不存在：{slug}", "not_found", 404, str(exc)) from exc


@router.put("/api/memory/{slug}")
async def memory_put(slug: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    title = str(payload.get("title") or slug)
    body = str(payload.get("body") or "")
    try:
        return state.memory.put(slug, title, body)
    except Exception as exc:
        raise _error(f"保存记忆失败：{exc}", "memory_error") from exc


@router.delete("/api/memory/{slug}")
async def memory_delete(slug: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        return {"ok": state.memory.delete(slug)}
    except Exception as exc:
        raise _error(f"删除记忆失败：{exc}", "memory_error") from exc


# ------------------------------------------------------------------------ jobs
@router.post("/api/jobs")
async def job_submit(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    kind = str(payload.get("kind") or "python")
    if kind not in ("python", "shell"):
        raise _error("kind 必须是 python 或 shell")
    code = str(payload.get("code") or "")
    if not code.strip():
        raise _error("code 不能为空")
    try:
        return state.jobs.submit(kind=kind, code=code, name=str(payload.get("name") or ""))
    except Exception as exc:
        raise _error(f"提交任务失败：{exc}", "job_error", 500) from exc


@router.get("/api/jobs")
async def job_list(request: Request) -> dict[str, Any]:
    state = _state(request)
    return {"jobs": state.jobs.list()}


@router.get("/api/jobs/{jid}/log")
async def job_log(jid: str, request: Request, offset: int = 0) -> dict[str, Any]:
    state = _state(request)
    try:
        return state.jobs.log(jid, offset=max(0, int(offset)))
    except KeyError as exc:
        raise _error(f"任务不存在：{jid}", "not_found", 404) from exc


@router.post("/api/jobs/{jid}/cancel")
async def job_cancel(jid: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    try:
        return {"ok": state.jobs.cancel(jid)}
    except KeyError as exc:
        raise _error(f"任务不存在：{jid}", "not_found", 404) from exc


# --------------------------------------------------------------------- figures
_FIGURE_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")


def _figure_path(request: Request, name: str) -> Path:
    state = _state(request)
    if not _FIGURE_RE.match(name or ""):
        raise _error("非法图片名", "path_error")
    path = figures_dir(state.settings) / name
    if not path.exists() or not path.is_file():
        raise _error(f"图片不存在：{name}", "not_found", 404)
    return path


@router.get("/api/figures")
async def figure_list(request: Request) -> dict[str, Any]:
    state = _state(request)
    directory = figures_dir(state.settings)
    items = []
    try:
        for path in sorted(directory.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
            if not path.is_file() or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"):
                continue
            stat = path.stat()
            items.append(
                {
                    "name": path.name,
                    "url": f"/api/figures/{path.name}",
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
    except OSError as exc:
        raise _error(f"读取图表目录失败：{exc}", "io_error", 500) from exc
    return {"figures": items}


@router.get("/api/figures/{name}")
async def figure_get(name: str, request: Request):
    path = _figure_path(request, name)
    return FileResponse(str(path), media_type=fileops.guess_mime(path), filename=path.name)


@router.delete("/api/figures/{name}")
async def figure_delete(name: str, request: Request) -> dict[str, Any]:
    path = _figure_path(request, name)
    try:
        path.unlink()
    except OSError as exc:
        raise _error(f"删除失败：{exc}", "io_error", 500) from exc
    return {"ok": True}


@router.post("/api/figures/{name}/annotations")
async def figure_annotations(name: str, request: Request) -> dict[str, Any]:
    """Persist human markup as task guidance; it never overwrites the source figure."""
    path = _figure_path(request, name)
    body = await _json(request)
    strokes = body.get("strokes") if isinstance(body.get("strokes"), list) else []
    note = str(body.get("note") or "").strip()
    if len(strokes) > 500 or len(note) > 5000:
        raise _error("批注过长", "annotation_limit")
    clean = []
    for stroke in strokes:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("points"), list):
            continue
        points = [{"x": max(0, min(1, float(p.get("x", 0)))), "y": max(0, min(1, float(p.get("y", 0))))}
                  for p in stroke["points"] if isinstance(p, dict)]
        if points:
            clean.append({"color": str(stroke.get("color") or "#d92d20")[:20], "width": max(1, min(24, float(stroke.get("width", 3)))), "points": points[:500]})
    state = _state(request)
    record = state.platform.store.put("figure_annotation", f"figure:{name}", {"name": name, "strokes": clean, "note": note}, "global")
    state.platform.store.audit("figure.annotation", {"name": name, "stroke_count": len(clean), "note_chars": len(note)})
    return {"ok": True, "annotation": record, "source": str(path.name)}


@router.get("/api/figures/{name}/annotations")
async def figure_annotation_get(name: str, request: Request) -> dict[str, Any]:
    _figure_path(request, name)
    state = _state(request)
    return {"annotation": state.platform.store.get("figure_annotation", f"figure:{name}", "global")}


# -------------------------------------------------------------------- settings
def _settings_payload(state) -> dict[str, Any]:
    """Everything the settings page needs, in one round trip.

    This payload is intentionally resilient: a half-configured provider shows up
    as ``llm.configured == false`` plus an actionable ``llm.error`` instead of a
    500 response that would blank the whole page.
    """
    return {
        "settings": public_settings(state.settings),
        "llm": state.llm_info(),
        "vision": state.vision_info(),
        "providers": state.settings.provider_catalog_map(),
    }


@router.get("/api/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    return _settings_payload(_state(request))


@router.put("/api/settings")
async def put_settings(request: Request) -> dict[str, Any]:
    state = _state(request)
    payload = await _json(request)
    patch = payload.get("patch") if isinstance(payload.get("patch"), dict) else payload
    if not isinstance(patch, dict):
        raise _error("patch 必须是对象")
    try:
        state.settings.update(patch)
        state.settings.save()
    except ConfigError as exc:
        raise _error(str(exc), "settings_invalid") from exc
    except Exception as exc:
        raise _error(f"保存设置失败：{exc}", "settings_error") from exc
    state.rebuild_approver()
    return _settings_payload(state)


@router.post("/api/settings/keys")
async def set_keys(request: Request) -> dict[str, Any]:
    """Atomically save API keys *and* the provider/model/base they belong to.

    This is the endpoint the settings page uses for "保存并测试": previously the
    UI only stored a key while provider/model/api_base stayed untouched, so the
    backend silently fell back to mock and users saw "配置了 API 但没有生效".
    """
    state = _state(request)
    payload = await _json(request)
    settings = state.settings
    raw_keys: dict[str, Any] = {}
    if isinstance(payload.get("keys"), dict):
        raw_keys.update(payload["keys"])
    provider = str(payload.get("provider") or "").strip()
    if payload.get("key"):
        provider = provider or str(settings.provider or "").strip()
        meta = settings.provider_meta(provider) if provider else {}
        env_key = str(meta.get("env_key") or "API_KEY")
        raw_keys.setdefault(env_key, payload.get("key"))
    if payload.get("vision_api_key"):
        raw_keys["VISION_API_KEY"] = payload.get("vision_api_key")
    keys: dict[str, str] = {}
    for name, value in raw_keys.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if value is None:
            continue
        keys[name.strip()] = str(value).strip()
    patch: dict[str, Any] = {}
    activate = payload.get("activate", True) is not False
    if provider and activate:
        patch["provider"] = provider
    for field in ("model", "api_base"):
        if not activate:
            continue
        if isinstance(payload.get(field), str) and str(payload.get(field) or "").strip():
            patch[field] = str(payload[field]).strip()
    if not keys and not patch:
        raise _error("没有可保存的 Key 或配置")
    try:
        if keys:
            settings.set_keys(keys)
        if patch:
            settings.update(patch)
        settings.save()
    except ConfigError as exc:
        raise _error(str(exc), "settings_invalid") from exc
    except Exception as exc:
        raise _error(f"写入配置失败：{exc}", "settings_error") from exc
    state.rebuild_approver()
    return {
        "ok": True,
        "saved_keys": sorted(keys.keys()),
        "settings": public_settings(settings),
        "llm": state.llm_info(),
        "vision": state.vision_info(),
        "providers": settings.provider_catalog_map(),
    }


def _test_llm_target(state, payload: dict[str, Any]):
    """Build the target to test, honouring values typed but not yet saved."""
    settings = state.settings
    from ..config import LLMTarget, PROVIDERS

    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    api_base = str(payload.get("api_base") or "").strip()
    api_key = str(payload.get("api_key") or "").strip()
    if not any((provider, model, api_base, api_key)):
        return settings.resolve_llm()
    effective_provider = provider or str(settings.provider or "").strip() or "auto"
    meta = PROVIDERS.get(effective_provider) or {}
    # A test of the *currently selected* provider must use the stored endpoint/model
    # too, otherwise "测试连接" would silently test a different base URL (the classic
    # "配置了 API 后依然无效" symptom).
    same_as_saved = bool(effective_provider) and effective_provider == str(settings.provider or "")
    if not api_key:
        stored = settings.auth()
        env_key = str(meta.get("env_key") or "")
        api_key = str(stored.get(env_key, "")) or str(
            stored.get(str(meta.get("fallback_env_key") or ""), "")
        )
    if not api_base:
        saved_base = str(settings.api_base or "").strip() if same_as_saved else ""
        api_base = saved_base or str(meta.get("api_base") or "")
    api_base = api_base.rstrip("/")
    family = str(meta.get("family") or "")
    if not family:
        family = "anthropic" if "anthropic" in api_base.lower() else "openai"
    if family == "anthropic" and api_base.endswith("/v1"):
        api_base = api_base[: -len("/v1")]
    if not model:
        saved_model = str(settings.model or "").strip() if same_as_saved else ""
        if saved_model in {"", "auto"}:
            saved_model = ""
        model = saved_model or str(meta.get("default_model") or "") or "default"
    if not api_key and family != "mock":
        raise ConfigError(
            f"provider '{effective_provider or 'custom'}' 缺少 API Key：请填写后重试。"
        )
    if not api_base and family != "mock":
        raise ConfigError("缺少 API 地址：请填写 API Base（如 https://api.openai.com/v1）。")
    return LLMTarget(
        provider=effective_provider or "custom",
        model=model,
        family=family,
        api_base=api_base,
        api_key=api_key,
        label=str(meta.get("label") or effective_provider or "custom"),
    )


@router.post("/api/settings/test_llm")
async def test_llm(request: Request) -> dict[str, Any]:
    """Send one tiny chat completion and report the real round-trip result."""
    state = _state(request)
    payload = await _json(request)
    started = time.perf_counter()
    provider_hint = str(payload.get("provider") or state.settings.provider or "")
    model_hint = str(payload.get("model") or state.settings.model or "")
    try:
        target = _test_llm_target(state, payload)
        provider_hint = target.provider or provider_hint
        model_hint = target.model or model_hint
        llm = make_provider(target)
        chunks: list[str] = []
        cfg = ProviderConfig(temperature=0.0, max_tokens=24, timeout_s=45.0)
        async for event in llm.stream_chat(
            [{"role": "user", "content": "Reply with exactly: pong"}], [], cfg
        ):
            if event.get("type") == "text":
                chunks.append(str(event.get("delta") or ""))
            if event.get("type") == "tool_calls":
                break
        reply = "".join(chunks).strip()
        return {
            "ok": True,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "reply": reply or "(空响应，但连接成功)",
            "error": None,
            "provider": provider_hint,
            "model": model_hint,
        }
    except Exception as exc:
        return {
            "ok": False,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "reply": "",
            "error": str(exc),
            "provider": provider_hint,
            "model": model_hint,
        }


@router.post("/api/settings/vision")
async def set_vision(request: Request) -> dict[str, Any]:
    """Persist vision-model settings (model/base/enabled + optional API key)."""
    state = _state(request)
    payload = await _json(request)
    settings = state.settings
    patch: dict[str, Any] = {}
    if "enabled" in payload:
        patch["vision_enabled"] = bool(payload.get("enabled"))
    for field, key in (("model", "vision_model"), ("base_url", "vision_base_url")):
        if isinstance(payload.get(field), str):
            patch[key] = str(payload[field]).strip()
    api_key = str(payload.get("api_key") or "").strip()
    try:
        if api_key:
            settings.set_keys({"VISION_API_KEY": api_key})
            patch["vision_api_key"] = ""
        if patch:
            settings.update(patch)
        settings.save()
    except ConfigError as exc:
        raise _error(str(exc), "settings_invalid") from exc
    except Exception as exc:
        raise _error(f"保存视觉配置失败：{exc}", "settings_error") from exc
    return {"ok": True, "vision": state.vision_info()}


@router.post("/api/settings/test_vision")
async def test_vision(request: Request) -> dict[str, Any]:
    """Send one tiny image to the vision model and report latency/reply."""
    state = _state(request)
    payload = await _json(request)
    from ..agent.vision import VisionClient

    client = VisionClient(state.settings)
    try:
        result = await client.test(
            model=str(payload.get("model") or ""),
            base_url=str(payload.get("base_url") or ""),
            api_key=str(payload.get("api_key") or ""),
            timeout_s=60,
        )
    except Exception as exc:  # defensive: never 500 the settings page
        result = {"ok": False, "latency_ms": 0, "reply": "", "error": str(exc)}
    return result


# ----------------------------------------------------------------- health/system
@router.get("/api/health")
async def health(request: Request) -> dict[str, Any]:
    return _state(request).health()


@router.get("/api/system/info")
async def system_info(request: Request) -> dict[str, Any]:
    state = _state(request)
    return {
        "platform": platform.system(),
        "platform_release": platform.release(),
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "cwd": os.getcwd(),
        "workspace": str(state.settings.workspace),
        "home": str(state.settings.home),
        "cpu_count": os.cpu_count(),
        "version": state.health().get("version"),
        "kernel_python": state.settings.resolve_kernel_python(),
        "uptime_s": round(time.time() - state.started_at, 1),
    }


# -------------------------------------------------------------------- utilities
async def _json(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)
