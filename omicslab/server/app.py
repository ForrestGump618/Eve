"""FastAPI application factory: lifespan, routers, static UI, error envelope."""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import __app_name__, __version__
from ..config import Settings, load_settings
from .chat import router as chat_router
from .routes import router as api_router
from .routes_discovery import router as discovery_router
from .routes_registry import router as registry_router
from .routes_trajectories import router as trajectories_router
from .routes_runtime import router as runtime_router
from .routes_workspaces import router as workspaces_router
from .state import AppState
from .routes_platform import router as platform_router
from .routes_harness import router as harness_router
from .terminal import run_terminal
from .routes_workspace_tools import router as workspace_tools_router
from .routes_sidebar import router as sidebar_router
from .routes_evolution import router as evolution_router

logger = logging.getLogger("omicslab.server")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def _load_optional_routers() -> list[Any]:
    """Import stage-2 routers that live in optional modules.

    A missing or broken optional module must never prevent the core server from
    starting (SSH support needs ``paramiko``; discovery is always present).
    """
    import importlib

    routers: list[Any] = []
    for module_name, attr in (
        ("omicslab.server.routes_ssh", "router"),
    ):
        try:
            module = importlib.import_module(module_name)
            candidate = getattr(module, attr)
        except ImportError:
            logger.info("可选路由未安装：%s", module_name)
            continue
        except Exception:  # pragma: no cover - optional module must not break core
            logger.exception("加载可选路由失败：%s", module_name)
            continue
        routers.append(candidate)
    return routers


# ---------------------------------------------------------------------------
# error envelope
# ---------------------------------------------------------------------------
def _error_payload(message: str, code: str = "error", detail: str = "") -> dict[str, Any]:
    return {"error": {"message": message, "code": code, "detail": detail}}


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the 素问 Suwen web application.

    The application state is built inside the lifespan handler so that
    ``uvicorn`` starts the kernel lazily and shuts everything down cleanly.
    """

    settings = settings or load_settings()
    try:
        settings.ensure_dirs()
    except OSError as exc:  # pragma: no cover - disk/permission issue
        logger.warning("无法创建数据目录：%s", exc)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        state = await AppState.create(settings)
        app.state.omicslab = state
        if state.startup_error:
            logger.warning(state.startup_error)
        else:
            logger.info("内核已就绪：%s", state.kernel.status().get("python") or "python")
        logger.info("素问 Suwen %s 服务已启动 | 工作区：%s", __version__, settings.workspace)
        try:
            yield
        finally:
            evolution = getattr(state, 'evolution', None)
            if evolution is not None:
                await evolution.close()
            await state.shutdown()
            logger.info("素问 Suwen 已关闭")

    app = FastAPI(
        title=__app_name__,
        version=__version__,
        description="本地优先的生物医学数据分析智能体工作台",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    origins = [
        f"http://127.0.0.1:{settings.port}",
        f"http://localhost:{settings.port}",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware('http')
    async def protect_local_gateway(request: Request, call_next):
        origin = request.headers.get('origin')
        if request.url.path.startswith('/api/') and origin and origin not in origins:
            return JSONResponse(_error_payload('来自未授权网页的请求已拒绝', 'origin_denied'), status_code=403)
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        if not request.url.path.startswith('/api/') and (request.url.path=='/' or request.url.path.endswith(('.js','.css','.html','.svg'))):
            response.headers['Cache-Control']='no-cache, must-revalidate'
        return response

    app.include_router(api_router)
    app.include_router(chat_router)
    app.include_router(discovery_router)
    app.include_router(registry_router)
    app.include_router(trajectories_router)
    app.include_router(runtime_router)
    app.include_router(workspaces_router)
    app.include_router(platform_router)
    app.include_router(harness_router)
    app.include_router(workspace_tools_router)
    app.include_router(sidebar_router)
    app.include_router(evolution_router)
    for optional_router in _load_optional_routers():
        app.include_router(optional_router)

    @app.websocket("/ws/terminal")
    async def websocket_terminal(websocket: WebSocket) -> None:
        origin = websocket.headers.get('origin')
        if origin and origin not in origins:
            await websocket.close(code=1008)
            return
        await run_terminal(websocket, settings, app.state.omicslab.workspaces)

    # ---------------------------------------------------------------- errors
    @app.exception_handler(HTTPException)
    async def handle_http_error(request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail
        # Routes may raise either the flat contract {"message","code","detail"} or the
        # already-wrapped {"error": {...}} form. Normalise both so callers never see
        # the generic "请求失败"/"error" placeholder by accident.
        if isinstance(detail, dict) and isinstance(detail.get("error"), dict):
            detail = detail["error"]
        if isinstance(detail, dict):
            message = str(detail.get("message") or "请求失败")
            code = str(detail.get("code") or "error")
            extra = str(detail.get("detail") or "")
        else:
            message = str(detail or "请求失败")
            code = "error"
            extra = ""
        headers = getattr(exc, "headers", None)
        return JSONResponse(_error_payload(message, code, extra), status_code=exc.status_code, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        messages = []
        for err in exc.errors()[:5]:
            location = ".".join(str(part) for part in err.get("loc", ()))
            messages.append(f"{location}: {err.get('msg', '参数不合法')}" if location else str(err.get("msg", "")))
        return JSONResponse(_error_payload("请求参数不合法", "validation_error", "; ".join(messages)), status_code=422)

    @app.exception_handler(ValueError)
    async def handle_value_error(request: Request, exc: ValueError) -> JSONResponse:
        from ..suwen.store import redact
        return JSONResponse(_error_payload(redact(str(exc)), "invalid_operation"), status_code=400)

    @app.exception_handler(PermissionError)
    async def handle_permission_error(request: Request, exc: PermissionError) -> JSONResponse:
        return JSONResponse(_error_payload(str(exc), "permission_denied"), status_code=403)

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        from ..suwen.store import redact
        if request.url.path.startswith("/api/platform"):
            logger.error("平台操作失败：%s", redact(str(exc)))
            return JSONResponse(_error_payload(redact(str(exc)), "platform_error"), status_code=500)
        logger.exception("未处理的异常：%s %s", request.method, request.url.path)
        return JSONResponse(_error_payload(f"服务内部错误：{exc}", "internal_error"), status_code=500)

    # ------------------------------------------------------------------- UI
    index = WEB_DIR / "index.html"
    if index.exists():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
    else:  # pragma: no cover - only during source bootstrap
        logger.warning("未找到前端静态文件：%s", WEB_DIR)

        @app.get("/")
        async def placeholder() -> JSONResponse:
            return JSONResponse(
                {"message": "素问 Suwen 后端运行中，但前端静态文件缺失。", "web_dir": str(WEB_DIR)}
            )

    return app


__all__ = ["create_app", "WEB_DIR"]
