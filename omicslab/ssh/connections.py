"""进程内 SSH 连接服务（CONTRACTS-3 §6，修复 F10）。

HTTP 路由、Agent ``ssh_*`` 工具、``SSHExecutionBackend``、交互终端与工作区探测
全部通过这里的同一个 :class:`ConnectionService` 取得 :class:`SSHManager`，因此：

- 界面“测试连接”时输入的临时密码会写入同一份内存凭据，Agent 随后按
  ``profile_id`` 执行时可以直接复用（不再出现“UI 连通、Agent 不能用”）。
- 只有显式“记住密码”才会尝试写入系统凭据库；默认只保存在进程内存。
- 两端使用同一套中文诊断信息（同一个 ``SSHError`` 文本）。

服务按 ``settings.home`` 缓存为进程内单例；测试用 :func:`reset_for_tests` 清理。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from .manager import (
    DEFAULT_TIMEOUT_S,
    SSHError,
    SSHManager,
    SSHProfileNotFound,
    SSHValidationError,
    public_profile,
)

logger = logging.getLogger("omicslab.ssh.connections")

_SERVICES: dict[str, "ConnectionService"] = {}
_SERVICES_LOCK = threading.RLock()


def _service_key(settings: Any) -> str:
    home = getattr(settings, "home", None)
    if not home:
        raise TypeError("get_connection_service 需要带 home 的 Settings")
    try:
        return str(Path(home).expanduser().resolve())
    except Exception:
        return str(home)


class ConnectionService:
    """共享的 SSH 连接/凭据服务（同步方法，路由层用线程池调用）。"""

    def __init__(self, settings: Any, manager: SSHManager | None = None) -> None:
        self.settings = settings
        self._manager = manager if manager is not None else SSHManager(settings)

    @property
    def manager(self) -> SSHManager:
        return self._manager

    @property
    def home(self) -> Path:
        return Path(getattr(self.settings, "home", self._manager.home))

    def close(self) -> None:
        try:
            self._manager.close()
        except Exception:
            logger.exception("关闭 SSH 连接池失败")

    # -- profile CRUD ------------------------------------------------------
    def list_profiles(self) -> list[dict[str, Any]]:
        return self._manager.list_profiles()

    def get_profile(self, profile_id: str) -> dict[str, Any]:
        return self._manager.get_profile(profile_id)

    def add_profile(self, **fields: Any) -> dict[str, Any]:
        return self._manager.add_profile(**fields)

    def update_profile(self, profile_id: str, **fields: Any) -> dict[str, Any]:
        return self._manager.update_profile(profile_id, **fields)

    def remove_profile(self, profile_id: str) -> dict[str, Any]:
        return self._manager.remove_profile(profile_id)

    def remember_password(self, profile_id: str, password: str) -> dict[str, Any]:
        return self._manager.remember_password(profile_id, password)

    # -- connection testing ------------------------------------------------
    def test_connection(
        self,
        profile_id: str,
        password: str | None = None,
        *,
        remember: bool = False,
    ) -> dict[str, Any]:
        return self._manager.test_connection(profile_id, password, remember=remember)

    def test_profile(
        self,
        profile: dict[str, Any],
        *,
        password: str | None = None,
        remember: bool = False,
    ) -> dict[str, Any]:
        """测试已保存或未保存的档案。

        - 带 ``id`` 且能在本地档案库中找到 → 复用同一 manager 与内存凭据；
        - 否则用字段直接测试（不落盘），用于工作区向导。
        """
        pid = str(profile.get("id") or "").strip()
        if pid:
            try:
                self._manager.get_profile(pid)
            except SSHProfileNotFound:
                pid = ""
            except SSHValidationError:
                pid = ""
        if pid:
            result = self._manager.test_connection(pid, password, remember=remember)
            result.setdefault("profile_id", pid)
            return result
        fields = dict(profile)
        fields.pop("id", None)
        result = self._manager.test_connection_fields(fields, password, remember=remember)
        result.setdefault("profile_id", fields.get("profile_id") or "")
        return result

    # -- execution ---------------------------------------------------------
    def exec(
        self,
        profile_id: str,
        command: str,
        *,
        cwd: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        idempotent: bool = False,
    ) -> dict[str, Any]:
        return self._manager.exec(
            profile_id,
            command,
            timeout_s=timeout_s,
            cwd=cwd,
            idempotent=idempotent,
        )

    def put_file(
        self,
        profile_id: str,
        local_path: Path,
        remote_path: str,
        *,
        mkdir: bool = True,
        progress: Any = None,
    ) -> dict[str, Any]:
        return self._manager.put_file(
            profile_id,
            local_path,
            remote_path,
            mkdir=mkdir,
            progress=progress,
        )

    def get_file(
        self,
        profile_id: str,
        remote_path: str,
        local_path: Path,
        *,
        progress: Any = None,
    ) -> dict[str, Any]:
        return self._manager.get_file(profile_id, remote_path, local_path, progress=progress)

    def stat(self, profile_id: str, remote_path: str) -> dict[str, Any]:
        return self._manager.stat(profile_id, remote_path)

    def list_dir(self, profile_id: str, remote_path: str = ".") -> dict[str, Any]:
        return self._manager.list_dir(profile_id, remote_path)

    def remote_info(self, profile_id: str) -> dict[str, Any]:
        return self._manager.remote_info(profile_id)

    # -- interactive channels ---------------------------------------------
    def open_sftp(self, profile_id: str) -> Any:
        return self._manager.open_sftp(profile_id)

    def open_terminal(
        self,
        profile_id: str,
        *,
        cols: int = 100,
        rows: int = 30,
    ) -> Any:
        return self._manager.open_shell(profile_id, width=cols, height=rows)

    def open_shell(self, profile_id: str, *, cols: int = 100, rows: int = 30) -> Any:
        return self.open_terminal(profile_id, cols=cols, rows=rows)

    # -- workspace probe ---------------------------------------------------
    def probe(self, profile_id: str, path: str = "") -> dict[str, Any]:
        """检查远端路径（工作区校验/目录浏览用）。

        连接/档案错误抛出 ``SSHError`` 子类；路径不存在返回 ``ok=True, exists=False``。
        """
        manager = self._manager
        profile = manager.get_profile(profile_id)
        target = str(path or "").strip() or "."
        try:
            with manager.open_sftp(profile_id) as session:
                remote = session.normalize(target)
                info = manager._sftp_stat_dict(session, remote)  # noqa: SLF001 - 同包复用
        except (SSHProfileNotFound, SSHValidationError):
            raise
        except SSHError as exc:
            return {
                "ok": False,
                "backend": "ssh",
                "profile_id": profile_id,
                "path": target,
                "exists": False,
                "is_dir": False,
                "error": str(exc),
                "code": "remote_unavailable",
            }
        host = str(profile.get("host") or "")
        port = int(profile.get("port") or 22)
        result: dict[str, Any] = {
            "ok": True,
            "backend": "ssh",
            "profile_id": profile_id,
            "connection_id": profile_id,
            "path": (info or {}).get("path") or target,
            "exists": bool(info and info.get("exists")),
            "is_dir": bool(info and info.get("is_dir")),
            "size": int((info or {}).get("size") or 0),
            "fingerprint": manager.known_fingerprint(host, port),
            "host": host,
            "username": str(profile.get("username") or ""),
            "credential": {
                "stored": bool(profile.get("credential_stored")),
                "hint": profile.get("credential_hint") or "",
            },
        }
        if result["is_dir"]:
            try:
                listing = manager.list_dir(profile_id, result["path"])
                result["entries"] = listing.get("entries", [])
            except SSHError:
                result["entries"] = []
        return result

    # -- introspection -----------------------------------------------------
    def diagnostics(self) -> dict[str, Any]:
        try:
            data = self._manager.diagnostics()
        except Exception as exc:  # pragma: no cover - 防御
            data = {"error": f"{type(exc).__name__}: {exc}"}
        return {
            "backend": "ssh",
            "home": str(self.home),
            "profiles": data.get("profiles", 0),
            "pooled_connections": data.get("pooled_connections", 0),
            "known_hosts": data.get("known_hosts", 0),
            "credential": data.get("credentials", {}),
        }

    def credential_status(self) -> dict[str, Any]:
        return self._manager.credential_status()

    def recent_commands(self, limit: int = 20) -> list[dict[str, Any]]:
        return self._manager.recent_commands(limit)


def get_connection_service(settings: Any) -> ConnectionService:
    """返回按 ``settings.home`` 缓存的进程内单例。"""
    key = _service_key(settings)
    with _SERVICES_LOCK:
        service = _SERVICES.get(key)
        if service is None:
            service = ConnectionService(settings)
            _SERVICES[key] = service
        return service


def reset_for_tests(settings: Any = None) -> None:
    """关闭并清理缓存的服务（测试用；生产无需调用）。"""
    with _SERVICES_LOCK:
        keys = [_service_key(settings)] if settings is not None else list(_SERVICES)
        services = [_SERVICES.pop(key) for key in keys if key in _SERVICES]
    for service in services:
        service.close()


def reset_connection_services() -> None:
    """兼容别名：清理所有缓存服务。"""
    reset_for_tests()


__all__ = [
    "ConnectionService",
    "get_connection_service",
    "reset_connection_services",
    "reset_for_tests",
]
