"""Shared application state for the FastAPI server."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..agent.approvals import Approver
from ..agent.context import welcome_hint
from ..agent.loop import AgentLoop
from ..agent.memory import MemoryStore
from ..agent.skills import load_skills
from ..agent.templates import load_agents
from ..agent.tools import build_registry
from ..config import Settings
from ..discovery.engine import DiscoveryEngine
from ..discovery.ledger import ProjectStore
from ..execution import BackendUnavailable, LocalExecutionBackend, make_backend
from ..kernel.manager import KernelService
from ..registry.index import RegistryIndex
from ..runtime import EventStore, RunService
from ..session.jobs import JobManager
from ..session.store import ConversationStore
from ..workspace import WorkspaceService

logger = logging.getLogger("omicslab.server.state")

READY_TIMEOUT_S = 90


def public_settings(settings: Settings) -> dict[str, Any]:
    """Only expose fields that are safe to show in the browser."""
    return {
        "workspace": str(settings.workspace),
        "home": str(settings.home),
        "host": settings.host,
        "port": settings.port,
        "provider": settings.provider,
        "model": settings.model,
        "api_base": settings.api_base,
        "temperature": settings.temperature,
        "max_tokens": settings.max_tokens,
        "max_iterations": settings.max_iterations,
        "request_timeout_s": settings.request_timeout_s,
        "kernel_python": settings.kernel_python,
        "kernel_timeout_s": settings.kernel_timeout_s,
        "shell_timeout_s": settings.shell_timeout_s,
        "approval_policy": settings.approval_policy,
        "allow_shell": settings.allow_shell,
        "allow_file_write": settings.allow_file_write,
        "sandbox_root_only": settings.sandbox_root_only,
        "ui": getattr(settings, "ui", {}) or {},
        "default_agent": settings.default_agent,
        "language": settings.language,
        "vision_model": settings.vision_model,
        "vision_base_url": settings.vision_base_url,
        "vision_enabled": bool(getattr(settings, "vision_enabled", True)),
        "max_child_tasks": int(getattr(settings, "max_child_tasks", 4) or 4),
        "max_child_depth": int(getattr(settings, "max_child_depth", 2) or 2),
        "max_workspace_scopes": int(getattr(settings, "max_workspace_scopes", 4) or 4),
        "max_parallel_runs": int(getattr(settings, "max_parallel_runs", 8) or 8),
    }


@dataclass
class AppState:
    """Everything the HTTP layer needs, created once per process."""

    settings: Settings
    store: ConversationStore
    kernel: KernelService
    jobs: JobManager
    memory: MemoryStore
    agents: dict[str, Any]
    skills: dict[str, Any]
    registry: Any
    approver: Approver
    loop: AgentLoop
    discovery_store: ProjectStore
    discovery_engine: DiscoveryEngine
    registry_index: RegistryIndex
    platform: Any = None
    workspaces: WorkspaceService | None = None
    events: EventStore | None = None
    runs: RunService | None = None
    kernels: dict[str, KernelService] = field(default_factory=dict)
    kernel_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    loop_ref: dict[str, Any] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    running: dict[str, asyncio.Event] = field(default_factory=dict)
    kernel_lock: threading.Lock = field(default_factory=threading.Lock)
    startup_error: str = ""
    recovered_runs: list[dict[str, Any]] = field(default_factory=list)

    # -- lifecycle ---------------------------------------------------------
    @classmethod
    async def create(cls, settings: Settings) -> "AppState":
        settings.ensure_dirs()
        store = ConversationStore(settings)
        workspaces = WorkspaceService(settings)
        primary_workspace = workspaces.default()
        kernel = KernelService(settings, cwd=primary_workspace.root or settings.workspace)
        jobs = JobManager(settings)
        memory = MemoryStore(settings)
        agents = load_agents(settings)
        skills = load_skills(settings)
        registry = build_registry(settings)
        approver = Approver(policy=settings.approval_policy, timeout_s=120.0)
        loop = AgentLoop(settings, kernel, store, registry, memory, jobs, agents, skills)
        discovery_store = ProjectStore(settings)
        discovery_engine = DiscoveryEngine(
            settings,
            kernel,
            registry,
            discovery_store,
            agents=agents,
            skills=skills,
            loop=loop,
            conversation_store=store,
        )
        registry_index = RegistryIndex(settings)
        events = EventStore(Path(settings.home) / "runtime" / "events.db")
        state = cls(
            settings=settings,
            store=store,
            kernel=kernel,
            jobs=jobs,
            memory=memory,
            agents=agents,
            skills=skills,
            registry=registry,
            approver=approver,
            loop=loop,
            discovery_store=discovery_store,
            discovery_engine=discovery_engine,
            registry_index=registry_index,
            workspaces=workspaces,
            events=events,
            kernels={"main": kernel},
            loop_ref={"loop": loop},
        )
        state._wire_registry()
        state.install_run_service()
        try:
            state.recovered_runs = await asyncio.wait_for(state.runs.recover(), timeout=30) if state.runs else []
        except Exception:
            logger.exception("恢复未完成运行失败")
        try:
            await asyncio.wait_for(kernel.start(), timeout=READY_TIMEOUT_S)
        except Exception as exc:  # keep serving; user can restart from UI
            state.startup_error = f"内核启动失败：{exc}"
        from ..suwen.service import Platform
        state.platform = Platform(state)
        await state.platform.start()
        return state

    def _wire_registry(self) -> None:
        """Optional tool packs reach shared collaborators through the registry."""
        try:
            self.registry.discovery_store = self.discovery_store
            self.registry.discovery_engine = self.discovery_engine
            self.registry.agent_loop = self.loop
            self.registry.function_registry = self.registry_index
            self.registry.workspace_service = self.workspaces
            if self.platform is not None:
                self.registry.platform = self.platform
            self.registry.run_service = self.runs
        except Exception:  # pragma: no cover - registry is a mutable object
            pass

    def install_run_service(self) -> None:
        """(Re)build the run service against the current loop/kernel pool."""
        self.runs = RunService(
            self.settings,
            self.events,
            loop_provider=lambda: self.loop_ref.get("loop") or self.loop,
            store=self.store,
            workspace_service=self.workspaces,
            backend_factory=self.make_backend,
            approver=self.approver,
            max_parallel_runs=int(getattr(self.settings, "max_parallel_runs", 8) or 8),
        )
        try:
            self.registry.run_service = self.runs
        except Exception:  # pragma: no cover
            pass

    async def shutdown(self) -> None:
        if self.platform is not None:
            await self.platform.tasks.close()
        try:
            if self.runs is not None:
                await self.runs.cancel_all("服务关闭")
        except Exception:
            logger.exception("取消运行失败")
        try:
            self.approver.cancel_all("服务关闭")
        except Exception:
            pass
        for event in list(self.running.values()):
            try:
                event.set()
            except Exception:
                pass
        try:
            self.jobs.shutdown()
        except Exception:
            pass
        for scope, kernel in list(self.kernels.items()):
            try:
                await kernel.stop()
            except Exception:
                logger.exception("停止内核失败：%s", scope)
        try:
            if self.events is not None:
                self.events.close()
        except Exception:  # pragma: no cover
            pass

        if self.platform is not None:
            self.platform.store.close()

    # -- kernels (pooled per workspace scope) ------------------------------
    def workspace_for_scope(self, scope: str) -> Any:
        if self.workspaces is None or scope == "main":
            return self.workspaces.default() if self.workspaces else None
        ws_id = scope.split(":", 1)[1] if ":" in scope else scope
        return self.workspaces.get(ws_id)

    async def kernel_for(self, scope: str) -> KernelService:
        scope = str(scope or "main")
        existing = self.kernels.get(scope)
        if existing is not None and existing.running:
            return existing
        lock = self.kernel_locks.setdefault(scope, asyncio.Lock())
        async with lock:
            existing = self.kernels.get(scope)
            if existing is not None and existing.running:
                return existing
            workspace = self.workspace_for_scope(scope)
            if workspace is None:
                raise BackendUnavailable(f"工作区不存在：{scope}")
            if workspace.backend == "ssh":
                from ..execution.remote_kernel import RemoteKernel
                kernel = existing or RemoteKernel(self.settings, workspace)
                await asyncio.wait_for(kernel.start(), timeout=READY_TIMEOUT_S)
                self.kernels[scope] = kernel
                return kernel
            cwd = None
            if workspace is not None and getattr(workspace, "root", None) is not None:
                cwd = workspace.root
            kernel = existing or KernelService(self.settings, cwd=cwd or self.settings.workspace)
            self.kernels[scope] = kernel
            try:
                await asyncio.wait_for(kernel.start(), timeout=READY_TIMEOUT_S)
            except Exception as exc:
                raise BackendUnavailable(f"工作区内核启动失败（{scope}）：{exc}") from exc
            return kernel

    async def make_backend(self, workspace: Any, handle: Any) -> Any:
        if workspace.backend == "ssh":
            kernel = await self.kernel_for(workspace.scope)
            if self.workspaces is not None:
                self.workspaces.mark_in_use(workspace.workspace_id)
            return kernel.backend
        backend = await make_backend(
            self.settings,
            workspace,
            kernel_provider=self.kernel_for,
        )
        try:
            self.workspaces.mark_in_use(workspace.workspace_id)
        except Exception:
            pass
        return backend

    def kernel_status_all(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for scope, kernel in list(self.kernels.items()):
            try:
                out[scope] = kernel.status()
            except Exception:
                out[scope] = {"running": False}
        return out

    async def stop_kernel(self, scope: str = "main") -> bool:
        kernel = self.kernels.get(scope)
        if kernel is None:
            return False
        try:
            await kernel.stop()
        except Exception:
            logger.exception("停止内核失败：%s", scope)
        return True

    async def restart_kernel(self, scope: str = "main") -> KernelService:
        kernel = self.kernels.get(scope)
        if kernel is not None:
            try:
                await kernel.restart()
                return kernel
            except Exception:
                logger.exception("重启内核失败：%s", scope)
        self.kernels.pop(scope, None)
        return await self.kernel_for(scope)

    # -- reloads -----------------------------------------------------------
    def refresh_agents(self) -> dict[str, Any]:
        try:
            self.agents = load_agents(self.settings)
        except Exception:
            pass
        if self.platform is not None:
            self.platform.refresh_agents()
        return self.agents

    def refresh_skills(self) -> dict[str, Any]:
        try:
            self.skills = load_skills(self.settings)
        except Exception:
            pass
        return self.skills

    def rebuild_approver(self) -> None:
        # Keep the same instance: live runs and pending approvals must survive a
        # settings save (only the policy changes).
        self.approver.set_policy(self.settings.approval_policy)

    def rebuild_loop(self) -> None:
        self.loop.agents = self.agents
        self.loop.skills = self.skills
        self.loop.registry = self.registry
        self.loop.memory = self.memory
        self.loop_ref["loop"] = self.loop
        try:
            self.discovery_engine.loop = self.loop
            self.discovery_engine.agents = self.agents
            self.discovery_engine.skills = self.skills
            self.registry.discovery_engine = self.discovery_engine
            self.registry.agent_loop = self.loop
            self.registry.run_service = self.runs
        except Exception:  # pragma: no cover - defensive
            pass

    def default_agent_info(self) -> dict[str, Any]:
        """Effective default agent for new conversations (T07)."""
        builtin = "lead"
        if builtin not in self.agents and self.agents:
            builtin = next(iter(self.agents))
        configured = (self.settings.default_agent or "").strip()
        if configured and configured != "lead":
            if configured in self.agents:
                return {
                    "agent_id": configured,
                    "source": "settings",
                    "message": f"当前默认智能体为 {configured}（来自设置）。",
                }
            return {
                "agent_id": builtin,
                "source": "settings-invalid",
                "message": f"设置中的默认智能体 {configured} 不存在，已回退到 {builtin}。",
            }
        return {"agent_id": builtin, "source": "builtin", "message": ""}

    # -- legacy chat-run hooks (kept for routes/clients) --------------------
    def begin_run(self, conversation_id: str) -> asyncio.Event:
        event = asyncio.Event()
        self.running[conversation_id] = event
        return event

    def end_run(self, conversation_id: str) -> None:
        self.running.pop(conversation_id, None)

    def active_run_for(self, conversation_id: str) -> dict[str, Any] | None:
        if self.events is None:
            return None
        try:
            return self.events.active_run_for_session(conversation_id)
        except Exception:
            return None

    def stop_run(self, conversation_id: str) -> bool:
        """Scoped stop: only this conversation's run; never the shared kernel."""
        run = self.active_run_for(conversation_id)
        if run is None or self.runs is None:
            return False
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.runs.cancel(run["run_id"], "用户停止生成"))
        except RuntimeError:  # no running loop (tests) -> best effort
            return False
        return True

    # -- discovery runs ----------------------------------------------------
    @staticmethod
    def _discovery_key(project_id: str) -> str:
        return f"discovery:{project_id}"

    def begin_discovery(self, project_id: str) -> asyncio.Event:
        event = asyncio.Event()
        self.running[self._discovery_key(project_id)] = event
        return event

    def end_discovery(self, project_id: str) -> None:
        self.running.pop(self._discovery_key(project_id), None)

    def stop_discovery(self, project_id: str) -> bool:
        event = self.running.get(self._discovery_key(project_id))
        if event is None:
            return False
        event.set()
        return True

    def discovery_running(self, project_id: str) -> bool:
        event = self.running.get(self._discovery_key(project_id))
        return bool(event is not None and not event.is_set())

    # -- info --------------------------------------------------------------
    def llm_info(self) -> dict[str, Any]:
        """Never raises: the settings page must always render."""
        try:
            target = self.settings.resolve_llm()
        except Exception as exc:  # ConfigError or anything unexpected
            return {
                "configured": False,
                "provider": self.settings.provider,
                "model": self.settings.model,
                "family": None,
                "api_base": self.settings.api_base,
                "label": None,
                "has_key": False,
                "error": str(exc),
            }
        info = target.public()
        info["configured"] = bool(target.api_key) or target.family == "mock"
        info["error"] = None
        return info

    def vision_info(self) -> dict[str, Any]:
        try:
            return self.settings.vision_config()
        except Exception as exc:  # pragma: no cover - defensive
            return {
                "enabled": False,
                "model": "",
                "base_url": "",
                "has_key": False,
                "configured": False,
                "error": str(exc),
            }

    def workspaces_public(self) -> list[dict[str, Any]]:
        if self.workspaces is None:
            return []
        return [self.workspaces.public(ws) for ws in self.workspaces.list()]

    def health(self) -> dict[str, Any]:
        llm = self.llm_info()
        vision = self.vision_info()
        kernels = self.kernel_status_all()
        running_runs = 0
        if self.runs is not None:
            try:
                running_runs = len(self.runs.active_runs())
            except Exception:
                running_runs = 0
        return {
            "ok": True,
            "version": _version(),
            "kernel": kernels.get("main") or {"running": False},
            "kernels": kernels,
            "llm": {
                "configured": bool(llm.get("configured")),
                "provider": llm.get("provider"),
                "model": llm.get("model"),
                "error": llm.get("error"),
            },
            "vision": {
                "configured": bool(vision.get("configured")),
                "model": vision.get("model"),
            },
            "workspace": str(self.settings.workspace),
            "workspaces_count": len(self.workspaces_public()),
            "runs": {"active": running_runs, "recovered": len(self.recovered_runs)},
            "runtime": {
                "schema_version": self.events.schema_version if self.events else 0,
                "db": str(self.events.path) if self.events else "",
            },
            "startup_error": self.startup_error,
            "uptime_s": round(time.time() - self.started_at, 1),
        }

    def diagnostics(self, *, log_tail_chars: int = 8000) -> dict[str, Any]:
        tail = ""
        try:
            log_path = Path(self.settings.log_path)
            if log_path.is_file():
                data = log_path.read_bytes()[-max(1000, log_tail_chars) :]
                tail = data.decode("utf-8", "replace")
        except Exception:
            tail = ""
        return {
            "version": _version(),
            "pid": _pid(),
            "startup_error": self.startup_error,
            "recovered_runs": [
                {"run_id": run.get("run_id"), "session_id": run.get("session_id")}
                for run in self.recovered_runs[:20]
            ],
            "kernels": self.kernel_status_all(),
            "runtime": {
                "schema_version": self.events.schema_version if self.events else 0,
                "db": str(self.events.path) if self.events else "",
                "log_path": str(self.settings.log_path),
            },
            "workspaces": [
                {"workspace_id": item.get("workspace_id"), "backend": item.get("backend"), "status": item.get("status")}
                for item in self.workspaces_public()
            ],
            "log_tail": tail,
        }

    def welcome(self) -> str:
        return welcome_hint(self.settings)


def _pid() -> int:
    import os

    return os.getpid()


def _version() -> str:
    try:
        from .. import __version__

        return __version__
    except Exception:  # pragma: no cover
        return "1.2.0"


def figures_dir(settings: Settings) -> Path:
    path = settings.figures_dir
    path.mkdir(parents=True, exist_ok=True)
    return path
