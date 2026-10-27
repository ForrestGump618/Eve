"""SSH 连接与档案管理（同步实现，供路由 / Agent 工具 / 执行后端 / 终端复用）。

本模块对应 CONTRACTS-3 §6 与任务书 F09/F10/F13/F15：

- 档案保存在 ``<home>/ssh.json``；密码默认只在内存，显式“记住密码”时才尝试
  写入系统凭据库（keyring）；``ssh.json`` 中只保留 ``credential_id`` 引用。
- 连接池复用；只有“确定未提交”的连接错误才重试一次。命令一旦真正提交，
  连接中断时返回 ``status="unknown"`` 与对账信息，绝不再执行第二次。
- ``exec`` 支持显式 cwd（``cd <cwd> && command``），不依赖上一条命令的目录。
- 交互终端使用 ``invoke_shell()`` 建立真实 PTY；PTY 不可用时才回退并记录诊断。
- 所有异常归一化为中文 ``SSHError`` 子类；密码/私钥内容不进日志、不进返回。
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import posixpath
import shlex
import socket
import stat as stat_module
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

try:  # paramiko 是运行期依赖；缺失时给出明确中文错误
    import paramiko
except Exception:  # pragma: no cover - 依赖缺失路径
    paramiko = None  # type: ignore[assignment]

from ..agent.types import new_id
from ..utils import atomic_write_text, iso_from_ts, iso_now
from .credentials import CredentialStore

logger = logging.getLogger("omicslab.ssh")

AUTH_PASSWORD = "password"
AUTH_KEY = "key"
AUTH_AGENT = "agent"
AUTH_METHODS = (AUTH_PASSWORD, AUTH_KEY, AUTH_AGENT)
DEFAULT_PORT = 22
DEFAULT_TIMEOUT_S = 120
MAX_TIMEOUT_S = 3600
CONNECT_TIMEOUT_S = 15
PROFILES_FILENAME = "ssh.json"
KNOWN_HOSTS_FILENAME = "ssh_known_hosts.json"
COMMAND_LOG_FILENAME = "ssh_commands.jsonl"
MAX_CAPTURE_CHARS = 400_000
PROGRESS_THRESHOLD_BYTES = 4 * 1024 * 1024
MAX_COMMAND_LOG_RECORDS = 400
_PASSWORD_PREFIX = "b64:"
_STORED_KEYS = (
    "id",
    "name",
    "host",
    "port",
    "username",
    "auth",
    "key_path",
    "tags",
    "password_saved",
    "credential_id",
    "credential_stored",
    "credential_backend",
    "created_at",
    "updated_at",
    "last_ok",
    "last_error",
)
_TRANSIENT_KEYS = ("password", "credential_notice")
_EDITABLE_FIELDS = (
    "name",
    "host",
    "port",
    "username",
    "auth",
    "key_path",
    "tags",
    "password",
    "remember_password",
)


class SSHError(RuntimeError):
    """SSH 操作失败（中文消息）。"""


class SSHProfileNotFound(SSHError):
    """档案不存在。"""


class SSHValidationError(SSHError):
    """参数或配置不合法。"""


class SSHCommandUnknown(SSHError):
    """命令已提交但结果未知（连接中断/超时）。"""

    def __init__(
        self,
        message: str,
        *,
        stdout: str = "",
        stderr: str = "",
        duration_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.duration_ms = duration_ms


class _CommandNotSubmitted(SSHError):
    """命令尚未提交到远端（可安全重试一次）。"""


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def _as_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _is_true(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return _as_text(value).lower() in {"1", "true", "yes", "on", "y", "t"}


def _coerce_port(value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise SSHValidationError(f"端口必须是整数：{value!r}") from exc
    if not 1 <= port <= 65535:
        raise SSHValidationError(f"端口超出范围（1-65535）：{port}")
    return port


def _coerce_timeout(value: Any, default: float = DEFAULT_TIMEOUT_S) -> float:
    if value is None or value == "":
        return float(default)
    try:
        timeout = float(value)
    except (TypeError, ValueError) as exc:
        raise SSHValidationError(f"超时时间必须是数字：{value!r}") from exc
    if timeout <= 0:
        raise SSHValidationError("超时时间必须大于 0")
    if timeout > MAX_TIMEOUT_S:
        raise SSHValidationError(f"超时时间不能超过 {MAX_TIMEOUT_S} 秒")
    return timeout


def _normalize_auth(value: Any) -> str:
    auth = _as_text(value, AUTH_PASSWORD).lower()
    if auth not in AUTH_METHODS:
        raise SSHValidationError("认证方式必须是 password、key 或 agent")
    return auth


def _normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = value.replace("，", ",").split(",")
    elif isinstance(value, (list, tuple, set)):
        parts = [str(item) for item in value]
    else:
        parts = [str(value)]
    tags: list[str] = []
    for item in parts:
        tag = item.strip()
        if tag and tag not in tags:
            tags.append(tag[:32])
    return tags[:20]


def _normalize_fingerprint(value: Any) -> str:
    return _as_text(value).replace(" ", "")


def _fingerprint_of(key: Any) -> str:
    """把 paramiko PKey 转成稳定字符串（SHA256:...）。"""
    try:
        raw = key.get_fingerprint()
    except Exception:
        return ""
    if isinstance(raw, str):
        return raw
    if not raw:
        return ""
    digest = hashlib.sha256(bytes(raw)).digest()
    encoded = base64.b64encode(digest).decode("ascii").rstrip("=")
    return f"SHA256:{encoded}"


def _host_key(host: str, port: int) -> str:
    return f"{host.strip().lower()}:{int(port)}"


def _encode_password(password: str) -> str:
    """仅用于兼容旧档案：新代码不再把密码写入 ssh.json。"""
    if not password:
        return ""
    return _PASSWORD_PREFIX + base64.b64encode(password.encode("utf-8")).decode("ascii")


def _decode_password(value: Any) -> str:
    text = _as_text(value)
    if not text:
        return ""
    if not text.startswith(_PASSWORD_PREFIX):
        return ""
    try:
        raw = text[len(_PASSWORD_PREFIX) :]
        return base64.b64decode(raw.encode("ascii")).decode("utf-8")
    except Exception:
        return ""


def _now() -> str:
    return iso_now()


def _truncate_capture(text: str) -> str:
    if len(text) <= MAX_CAPTURE_CHARS:
        return text
    removed = len(text) - MAX_CAPTURE_CHARS
    return text[:MAX_CAPTURE_CHARS] + f"\n...[SSH 输出已截断，省略 {removed} 字符]...\n"


def _clean_remote_path(path: Any) -> str:
    text = _as_text(path, ".") or "."
    return text.replace("\\", "/")


def _require_paramiko() -> Any:
    if paramiko is None:
        raise SSHError("SSH 不可用：未安装 paramiko，请先执行 pip install paramiko")
    return paramiko


def _profile_defaults() -> dict[str, Any]:
    return {
        "id": "",
        "name": "",
        "host": "",
        "port": DEFAULT_PORT,
        "username": "",
        "auth": AUTH_PASSWORD,
        "key_path": "",
        "tags": [],
        "password_saved": False,
        "credential_id": "",
        "credential_stored": False,
        "credential_backend": "",
        "created_at": "",
        "updated_at": "",
        "last_ok": "",
        "last_error": "",
        # 以下字段只在内存/本次响应中出现，不写入 ssh.json
        "password": "",
        "credential_notice": "",
    }


def public_profile(profile: dict[str, Any], *, session_password: bool = False) -> dict[str, Any]:
    """返回可安全暴露给 API / 日志的档案视图（永不含密码/私钥内容）。"""
    auth = profile.get("auth", AUTH_PASSWORD)
    stored = bool(profile.get("credential_stored"))
    saved = bool(profile.get("password_saved"))
    has_password = auth == AUTH_PASSWORD and bool(stored or session_password or saved)
    hint = _as_text(profile.get("credential_notice"))
    if not hint and auth == AUTH_PASSWORD:
        if stored:
            hint = "密码已保存在系统凭据库（credential 引用，不回显）"
        elif session_password:
            hint = "密码仅保存在当前进程内存中；服务重启后需要重新输入"
        elif saved:
            hint = "档案中保存过密码，但当前无法读取，请重新输入"
    data = {
        "id": _as_text(profile.get("id")),
        "name": _as_text(profile.get("name")),
        "host": _as_text(profile.get("host")),
        "port": int(profile.get("port") or DEFAULT_PORT),
        "username": _as_text(profile.get("username")),
        "auth": auth,
        "key_path": _as_text(profile.get("key_path")),
        "tags": list(profile.get("tags") or []),
        "password_saved": saved,
        "has_password_saved": has_password,
        "credential_stored": auth == AUTH_PASSWORD and stored,
        "credential_backend": _as_text(profile.get("credential_backend")) or "",
        "credential_hint": hint,
        "created_at": _as_text(profile.get("created_at")),
        "updated_at": _as_text(profile.get("updated_at")),
        "last_ok": _as_text(profile.get("last_ok")),
        "last_error": _as_text(profile.get("last_error")),
    }
    return data


# ---------------------------------------------------------------------------
# 连接对象
# ---------------------------------------------------------------------------


@dataclass
class _PooledConnection:
    profile_id: str
    client: Any
    host: str
    username: str
    fingerprint: str = ""
    server_version: str = ""
    warning: str = ""
    created_at: float = 0.0
    last_used: float = 0.0

    def is_alive(self) -> bool:
        try:
            transport = self.client.get_transport()
        except Exception:
            return False
        if transport is None:
            return False
        try:
            return bool(transport.is_active())
        except Exception:
            return False


class _SFTPSession:
    """一次 SFTP 会话（可关闭；不要跨线程并发使用同一个实例）。"""

    def __init__(self, manager: "SSHManager", profile_id: str, client: Any, sftp: Any) -> None:
        self.manager = manager
        self.profile_id = profile_id
        self.client = client
        self.sftp = sftp
        self._closed = False

    def normalize(self, path: str) -> str:
        remote = _clean_remote_path(path)
        if remote == "~" or remote.startswith("~/"):
            remote = posixpath.join(self.sftp.normalize("."), remote[2:] if remote.startswith("~/") else "")
        try:
            return self.sftp.normalize(remote)
        except Exception:
            if remote.startswith("~") or not remote.startswith("/"):
                return remote
            return remote

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.sftp.close()
        except Exception:
            pass

    def __enter__(self) -> "_SFTPSession":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()


@dataclass
class _TerminalChannel:
    """``invoke_shell()`` 打开的 PTY 通道（终端桥接层使用）。"""

    manager: "SSHManager"
    profile_id: str
    client: Any
    channel: Any
    diagnostic: str = ""
    closed: bool = False
    created_at: float = field(default_factory=time.time)

    def is_active(self) -> bool:
        if self.closed:
            return False
        try:
            if getattr(self.channel, "closed", False):
                return False
            return bool(self.channel.is_active() if hasattr(self.channel, "is_active") else True)
        except Exception:
            return False

    def send(self, data: str | bytes) -> int:
        payload = data.encode("utf-8") if isinstance(data, str) else data
        if not payload:
            return 0
        try:
            self.channel.sendall(payload)
            return len(payload)
        except Exception as exc:
            raise SSHError(f"SSH 终端写入失败：{type(exc).__name__}: {exc}") from exc

    def recv(self, max_bytes: int = 65536) -> str:
        try:
            if not self.channel.recv_ready():
                return ""
            data = self.channel.recv(max_bytes)
        except Exception as exc:
            raise SSHError(f"SSH 终端读取失败：{type(exc).__name__}: {exc}") from exc
        if not data:
            return ""
        return data.decode("utf-8", "replace") if isinstance(data, bytes) else str(data)

    def resize(self, cols: int, rows: int) -> bool:
        try:
            self.channel.resize_pty(width=int(cols), height=int(rows))
            return True
        except Exception:
            return False

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.channel.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# SSHManager
# ---------------------------------------------------------------------------


class SSHManager:
    """同步 SSH 连接管理器。

    线程安全：连接池、档案文件、命令记录分别加锁；同一个 SSHClient 的连接
    建立由 ``_lock`` 串行化。调用方（FastAPI/工具/后端）应放到线程池执行。
    """

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self.home = Path(getattr(settings, "home", Path.home()))
        self._lock = threading.RLock()
        self._store_lock = threading.RLock()
        self._pool: dict[str, _PooledConnection] = {}
        self._connect_locks: dict[str, threading.RLock] = {}
        self._session_passwords: dict[str, str] = {}
        self._credentials = CredentialStore(self.home)
        self._migration_notices: list[dict[str, Any]] = []
        self.home.mkdir(parents=True, exist_ok=True)

    # -- paths -------------------------------------------------------------
    @property
    def profiles_path(self) -> Path:
        return self.home / PROFILES_FILENAME

    @property
    def known_hosts_path(self) -> Path:
        return self.home / KNOWN_HOSTS_FILENAME

    @property
    def command_log_path(self) -> Path:
        return self.home / COMMAND_LOG_FILENAME

    # ------------------------------------------------------------------
    # 档案存储
    # ------------------------------------------------------------------
    def _read_store_raw(self) -> dict[str, Any]:
        path = self.profiles_path
        if not path.exists():
            return {"version": 1, "profiles": []}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("读取 SSH 档案失败，将重建：%s", exc)
            self._backup_broken()
            return {"version": 1, "profiles": []}
        if not isinstance(raw, dict):
            return {"version": 1, "profiles": []}
        return raw

    def _load_store(self) -> dict[str, Any]:
        with self._store_lock:
            raw = self._read_store_raw()
            items = raw.get("profiles")
            if not isinstance(items, list):
                items = []
            profiles = [self._normalize_stored_profile(item) for item in items if isinstance(item, dict)]
            if not profiles:
                return {"version": 1, "profiles": []}
            migrated = self._migrate_legacy_passwords(profiles)
            if migrated:
                self._write_store(profiles)
            return {"version": 1, "profiles": profiles}

    def _stored_view(self, profile: dict[str, Any]) -> dict[str, Any]:
        data = {key: profile.get(key) for key in _STORED_KEYS}
        data["port"] = int(data.get("port") or DEFAULT_PORT)
        data["tags"] = list(data.get("tags") or [])
        data["password_saved"] = bool(data.get("password_saved"))
        data["credential_stored"] = bool(data.get("credential_stored"))
        data["name"] = _as_text(data.get("name"))
        data["host"] = _as_text(data.get("host"))
        data["username"] = _as_text(data.get("username"))
        data["auth"] = data.get("auth") or AUTH_PASSWORD
        data["key_path"] = _as_text(data.get("key_path"))
        data["credential_id"] = _as_text(data.get("credential_id"))
        data["credential_backend"] = _as_text(data.get("credential_backend"))
        return data

    def _write_store(self, profiles: list[dict[str, Any]]) -> None:
        with self._store_lock:
            payload = {"version": 1, "profiles": [self._stored_view(item) for item in profiles]}
            atomic_write_text(self.profiles_path, json.dumps(payload, ensure_ascii=False, indent=2))
            logger.debug("已写入 %d 个 SSH 档案", len(profiles))

    def _save_store(self, profiles: list[dict[str, Any]]) -> None:
        self._write_store(profiles)

    def _backup_profiles(self, reason: str) -> Path | None:
        source = self.profiles_path
        if not source.exists():
            return None
        target = source.with_name(source.name + ".bak")
        try:
            target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            logger.info("已备份 SSH 档案（%s）：%s", reason, target)
            return target
        except Exception as exc:  # pragma: no cover - 磁盘异常
            logger.warning("备份 SSH 档案失败：%s", exc)
            return None

    def _backup_broken(self) -> Path | None:
        source = self.profiles_path
        if not source.exists():
            return None
        target = source.with_name(source.name + ".broken.json")
        try:
            target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            return target
        except Exception:
            return None

    def _migrate_legacy_passwords(self, profiles: list[dict[str, Any]]) -> bool:
        changed = False
        notices: list[dict[str, Any]] = []
        for profile in profiles:
            legacy = _as_text(profile.get("password"))
            if not legacy:
                continue
            pid = _as_text(profile.get("id"))
            plain = _decode_password(legacy)
            if plain:
                cid = _as_text(profile.get("credential_id")) or new_id("cred")
                result = self._credentials.save(cid, plain, persist=bool(profile.get("password_saved")))
                profile["credential_id"] = cid
                profile["credential_backend"] = self._credentials.backend
                profile["credential_stored"] = bool(result["stored"])
                profile["password_saved"] = bool(result["stored"])
                notice = (
                    "旧版保存的密码已迁移到系统凭据库。"
                    if result["stored"]
                    else "旧版保存的密码已迁移为内存凭据：当前环境没有可用系统凭据库，重启后需要重新输入。"
                )
                profile["credential_notice"] = notice
                self._session_passwords[pid] = plain
                notices.append({"profile_id": pid, "message": notice})
            else:
                profile["password_saved"] = False
                profile["credential_stored"] = False
                profile["credential_notice"] = "旧版保存的密码无法解码，已清除；请重新输入密码。"
                notices.append({"profile_id": pid, "message": profile["credential_notice"]})
            profile.pop("password", None)
            changed = True
        if changed:
            self._backup_profiles("legacy-password-migration")
            self._migration_notices = notices
            logger.info("完成 %d 个 SSH 档案的旧密码迁移", len(notices))
        return changed

    def _normalize_stored_profile(self, raw: dict[str, Any]) -> dict[str, Any]:
        profile = _profile_defaults()
        for key in ("id", "name", "host", "username", "auth", "key_path", "created_at", "updated_at", "last_ok", "last_error"):
            if key in raw and raw.get(key) is not None:
                profile[key] = _as_text(raw.get(key))
        try:
            profile["port"] = _coerce_port(raw.get("port", DEFAULT_PORT))
        except SSHValidationError:
            profile["port"] = DEFAULT_PORT
        try:
            profile["auth"] = _normalize_auth(raw.get("auth"))
        except SSHValidationError:
            profile["auth"] = AUTH_PASSWORD
        profile["tags"] = _normalize_tags(raw.get("tags"))
        profile["password_saved"] = _is_true(raw.get("password_saved"))
        profile["credential_id"] = _as_text(raw.get("credential_id"))
        profile["credential_stored"] = _is_true(raw.get("credential_stored")) and bool(profile["credential_id"])
        profile["credential_backend"] = _as_text(raw.get("credential_backend"))
        if not profile["id"]:
            profile["id"] = new_id("prof")
        if not profile["created_at"]:
            profile["created_at"] = _now()
        if not profile["updated_at"]:
            profile["updated_at"] = profile["created_at"]
        if raw.get("password"):
            profile["password"] = _as_text(raw.get("password"))
        if profile["credential_id"] and not profile["credential_backend"]:
            profile["credential_backend"] = self._credentials.backend
        return profile

    def _validate_required(self, fields: dict[str, Any]) -> dict[str, Any]:
        name = _as_text(fields.get("name"))
        host = _as_text(fields.get("host"))
        username = _as_text(fields.get("username"))
        if not name:
            raise SSHValidationError("档案名称不能为空")
        if not host:
            raise SSHValidationError("主机地址不能为空")
        if any(ch.isspace() for ch in host) or "/" in host or "\\" in host:
            raise SSHValidationError(f"主机地址不合法：{host}")
        if not username:
            raise SSHValidationError("用户名不能为空")
        auth = _normalize_auth(fields.get("auth"))
        key_path = _as_text(fields.get("key_path"))
        if auth == AUTH_KEY and not key_path:
            raise SSHValidationError("私钥认证必须填写私钥文件路径")
        return {
            "name": name,
            "host": host,
            "port": _coerce_port(fields.get("port", DEFAULT_PORT)),
            "username": username,
            "auth": auth,
            "key_path": key_path,
            "tags": _normalize_tags(fields.get("tags")),
        }

    # -- 凭据 -------------------------------------------------------------
    def _apply_password(
        self,
        profile: dict[str, Any],
        password: str,
        *,
        remember: bool,
    ) -> None:
        pid = _as_text(profile.get("id"))
        if not password:
            return
        cid = _as_text(profile.get("credential_id")) or new_id("cred")
        profile["credential_id"] = cid
        profile["credential_backend"] = self._credentials.backend
        self._session_passwords[pid] = password
        self._credentials.remember(cid, password)
        result = self._credentials.save(cid, password, persist=bool(remember))
        profile["credential_stored"] = bool(result["stored"])
        profile["password_saved"] = bool(result["stored"])
        if remember and not result["stored"]:
            profile["credential_notice"] = result["error"] or "密码仅保存在内存中（当前环境无系统凭据库）"
        elif remember:
            profile["credential_notice"] = "密码已保存到系统凭据库"
        else:
            profile["credential_notice"] = "密码仅保存在当前进程内存中；服务重启后需要重新输入"
        profile.pop("password", None)

    def _clear_credential(self, profile: dict[str, Any], *, drop_persisted: bool = True) -> None:
        pid = _as_text(profile.get("id"))
        cid = _as_text(profile.get("credential_id"))
        self._session_passwords.pop(pid, None)
        profile["credential_stored"] = False
        profile["password_saved"] = False
        profile["credential_notice"] = "已清除保存的密码" if drop_persisted else ""
        if cid:
            if drop_persisted:
                self._credentials.delete(cid)
            else:
                self._credentials.forget_memory(cid)
        profile.pop("password", None)

    def _promote_credential(self, profile: dict[str, Any]) -> dict[str, Any]:
        """尝试把内存中的密码持久化到系统凭据库。"""
        pid = _as_text(profile.get("id"))
        cid = _as_text(profile.get("credential_id"))
        secret = self._credentials.load(cid) if cid else self._session_passwords.get(pid)
        if not secret:
            profile["credential_notice"] = "没有可保存的密码，请先输入密码"
            return profile
        if not cid:
            cid = new_id("cred")
            profile["credential_id"] = cid
            self._credentials.remember(cid, secret)
        result = self._credentials.save(cid, secret, persist=True)
        profile["credential_backend"] = self._credentials.backend
        profile["credential_stored"] = bool(result["stored"])
        profile["password_saved"] = bool(result["stored"])
        profile["credential_notice"] = (
            "密码已保存到系统凭据库"
            if result["stored"]
            else (result["error"] or "密码仅保存在内存中（当前环境无系统凭据库）")
        )
        return profile

    def _has_session_password(self, profile: dict[str, Any]) -> bool:
        pid = _as_text(profile.get("id"))
        if pid in self._session_passwords:
            return True
        cid = _as_text(profile.get("credential_id"))
        return bool(cid and self._credentials.has_memory(cid))

    def _public(self, profile: dict[str, Any]) -> dict[str, Any]:
        return public_profile(profile, session_password=self._has_session_password(profile))

    def credential_status(self) -> dict[str, Any]:
        store_status = self._credentials.status()
        with self._store_lock:
            store = self._load_store()
        profiles = store.get("profiles") or []
        persisted = sum(1 for item in profiles if item.get("credential_stored"))
        return {
            **store_status,
            "profiles": len(profiles),
            "profiles_with_persisted_credential": persisted,
            "migrations": list(self._migration_notices),
        }

    # -- 档案 CRUD --------------------------------------------------------
    def list_profiles(self) -> list[dict[str, Any]]:
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
        return [self._public(item) for item in profiles]

    def _get_profile_raw(self, profile_id: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        if not pid:
            raise SSHValidationError("profile_id 不能为空")
        with self._store_lock:
            store = self._load_store()
            for item in store.get("profiles") or []:
                if item.get("id") == pid:
                    return item
        raise SSHProfileNotFound(f"SSH 档案不存在：{pid}")

    def get_profile(self, profile_id: str) -> dict[str, Any]:
        return self._public(self._get_profile_raw(profile_id))

    def add_profile(self, **fields: Any) -> dict[str, Any]:
        clean = self._validate_required(fields)
        profile = _profile_defaults()
        profile.update(clean)
        profile["id"] = new_id("prof")
        now = _now()
        profile["created_at"] = now
        profile["updated_at"] = now
        remember = _is_true(fields.get("remember_password"))
        password = _as_text(fields.get("password"))
        if clean["auth"] in (AUTH_KEY, AUTH_AGENT):
            profile["credential_notice"] = ""
        else:
            self._apply_password(profile, password, remember=remember)
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
            profiles.append(profile)
            self._write_store(profiles)
        return self._public(profile)

    def update_profile(self, profile_id: str, **fields: Any) -> dict[str, Any]:
        pid = _as_text(profile_id)
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
            index = next((i for i, item in enumerate(profiles) if item.get("id") == pid), -1)
            if index < 0:
                raise SSHProfileNotFound(f"SSH 档案不存在：{pid}")
            profile = profiles[index]
            merged = dict(profile)
            for key in _EDITABLE_FIELDS:
                if key in fields and fields.get(key) is not None:
                    merged[key] = fields.get(key)
            clean = self._validate_required(merged)
            connection_keys = ("host", "port", "username", "auth", "key_path")
            connection_changed = any(_as_text(profile.get(key)) != _as_text(clean.get(key)) for key in connection_keys)
            profile.update(clean)
            profile["updated_at"] = _now()
            password = fields.get("password")
            password_given = password is not None and _as_text(password) != ""
            remember_value = fields.get("remember_password")
            remember = _is_true(remember_value) if remember_value is not None else bool(profile.get("credential_stored"))
            if clean["auth"] in (AUTH_KEY, AUTH_AGENT):
                self._clear_credential(profile)
                profile["updated_at"] = _now()
            elif password_given:
                self._apply_password(profile, _as_text(password), remember=remember)
            elif remember_value is not None and _is_true(remember_value):
                self._promote_credential(profile)
            elif remember_value is not None and not _is_true(remember_value):
                profile["credential_stored"] = False
                profile["password_saved"] = False
                profile["credential_notice"] = "不保存密码：当前密码仅保留在本次进程内存中"
            profiles[index] = profile
            self._write_store(profiles)
        if connection_changed or password_given:
            self._drop(pid)
        return self._public(profile)

    def remove_profile(self, profile_id: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
            target = next((item for item in profiles if item.get("id") == pid), None)
            if target is None:
                raise SSHProfileNotFound(f"SSH 档案不存在：{pid}")
            profiles = [item for item in profiles if item.get("id") != pid]
            self._write_store(profiles)
        self._drop(pid)
        self._clear_credential(target)
        return {"ok": True, "id": pid}

    def remember_password(self, profile_id: str, password: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        if not _as_text(password):
            raise SSHValidationError("密码不能为空")
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
            index = next((i for i, item in enumerate(profiles) if item.get("id") == pid), -1)
            if index < 0:
                raise SSHProfileNotFound(f"SSH 档案不存在：{pid}")
            profile = profiles[index]
            self._apply_password(profile, _as_text(password), remember=True)
            profile["updated_at"] = _now()
            profiles[index] = profile
            self._write_store(profiles)
        return self._public(profile)

    def remember_session_password(self, profile_id: str, password: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        if not _as_text(password):
            raise SSHValidationError("密码不能为空")
        with self._store_lock:
            store = self._load_store()
            profiles = list(store.get("profiles") or [])
            index = next((i for i, item in enumerate(profiles) if item.get("id") == pid), -1)
            if index < 0:
                raise SSHProfileNotFound(f"SSH 档案不存在：{pid}")
            profile = profiles[index]
            self._apply_password(profile, _as_text(password), remember=False)
            profiles[index] = profile
            self._write_store(profiles)
        return self._public(profile)

    # -- 密码解析 ---------------------------------------------------------
    def _resolve_password(self, profile: dict[str, Any], password: str | None = None) -> str | None:
        if _as_text(profile.get("auth")) in (AUTH_KEY, AUTH_AGENT):
            return None
        explicit = _as_text(password)
        if explicit:
            return explicit
        pid = _as_text(profile.get("id"))
        if pid in self._session_passwords:
            return self._session_passwords[pid]
        cid = _as_text(profile.get("credential_id"))
        if cid:
            secret = self._credentials.load(cid)
            if secret:
                return secret
        legacy = _decode_password(profile.get("password"))
        if legacy:
            return legacy
        if cid and not profile.get("credential_stored"):
            raise SSHValidationError(
                "该档案的密码不在本进程内存中，且当前环境没有可用的系统凭据库；"
                "请先执行“测试连接”并输入密码（或编辑档案后重新输入）。"
            )
        raise SSHValidationError(
            "该档案未保存密码：请先执行“测试连接”并输入密码，或编辑档案后开始“记住密码”。"
        )

    # ------------------------------------------------------------------
    # known_hosts
    # ------------------------------------------------------------------
    def _load_known_hosts(self) -> dict[str, Any]:
        path = self.known_hosts_path
        if not path.exists():
            return {"version": 1, "hosts": {}}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"version": 1, "hosts": {}}
        if not isinstance(raw, dict):
            return {"version": 1, "hosts": {}}
        if not isinstance(raw.get("hosts"), dict):
            raw["hosts"] = {}
        return raw

    def _save_known_hosts(self, data: dict[str, Any]) -> None:
        try:
            atomic_write_text(self.known_hosts_path, json.dumps(data, ensure_ascii=False, indent=2))
        except Exception as exc:  # pragma: no cover - 磁盘异常
            logger.warning("写入 SSH known_hosts 记录失败：%s", exc)

    def known_fingerprint(self, host: str, port: int = DEFAULT_PORT) -> str:
        data = self._load_known_hosts()
        entry = data.get("hosts", {}).get(_host_key(host, port))
        if not entry:
            return ""
        fingerprint = entry.get("fingerprint") if isinstance(entry, dict) else entry
        return _normalize_fingerprint(fingerprint)

    def _remember_host(self, profile: dict[str, Any], fingerprint: str) -> str:
        host = _as_text(profile.get("host"))
        port = int(profile.get("port") or DEFAULT_PORT)
        key = _host_key(host, port)
        data = self._load_known_hosts()
        hosts = data.setdefault("hosts", {})
        warning = ""
        previous = hosts.get(key)
        if isinstance(previous, dict):
            previous_fingerprint = _normalize_fingerprint(previous.get("fingerprint"))
        else:
            previous_fingerprint = _normalize_fingerprint(previous)
        if previous_fingerprint and fingerprint and previous_fingerprint != fingerprint:
            raise SSHError(
                f"服务器指纹已变化：原 {previous_fingerprint}，现 {fingerprint}。"
                "已拒绝连接并保留原指纹；请核实服务器身份后更新受信任主机记录。"
            )
        elif not previous_fingerprint:
            hosts[key] = {
                "fingerprint": fingerprint,
                "first_seen": _now(),
                "host": host,
                "port": port,
            }
        else:
            hosts[key] = {**hosts.get(key, {}), "fingerprint": fingerprint, "updated_at": _now()}
        data["version"] = 1
        self._save_known_hosts(data)
        return warning

    # ------------------------------------------------------------------
    # 连接
    # ------------------------------------------------------------------
    def _connection_error(self, exc: Exception, *, transient: bool = True) -> SSHError:
        paramiko_mod = paramiko
        if isinstance(exc, SSHError):
            return exc
        if paramiko_mod is not None:
            auth_error = getattr(paramiko_mod, "AuthenticationException", None)
            if auth_error is not None and isinstance(exc, auth_error):
                return SSHError("SSH 认证失败：用户名、密码或私钥不正确（请检查认证方式与凭据）")
            bad_host = getattr(paramiko_mod, "BadHostKeyException", None)
            if bad_host is not None and isinstance(exc, bad_host):
                return SSHError(f"SSH 主机密钥校验失败：{exc}")
            ssh_exc = getattr(paramiko_mod, "SSHException", None)
            if ssh_exc is not None and isinstance(exc, ssh_exc):
                return SSHError(f"SSH 连接失败：{exc}")
        if isinstance(exc, socket.timeout):
            return SSHError(f"SSH 连接超时（超过 {CONNECT_TIMEOUT_S} 秒）：请检查主机、端口与网络")
        if isinstance(exc, OSError):
            error = SSHError(f"SSH 连接失败：{type(exc).__name__}: {exc}")
            setattr(error, "transient", bool(transient))
            return error
        error = SSHError(f"SSH 连接失败：{type(exc).__name__}: {exc}")
        setattr(error, "transient", bool(transient))
        return error

    def _load_private_key(self, key_path: str) -> Any:
        path = Path(key_path).expanduser()
        if not path.is_file():
            raise SSHValidationError(f"私钥文件不存在：{path}")
        paramiko_mod = _require_paramiko()
        loaders = [
            getattr(paramiko_mod, "Ed25519Key", None),
            getattr(paramiko_mod, "ECDSAKey", None),
            getattr(paramiko_mod, "RSAKey", None),
            getattr(paramiko_mod, "DSSKey", None),
        ]
        errors: list[str] = []
        for loader in loaders:
            if loader is None:
                continue
            try:
                return loader.from_private_key_file(str(path))
            except Exception as exc:
                errors.append(f"{getattr(loader, '__name__', loader)}: {exc}")
        detail = errors[0] if errors else "未知格式"
        raise SSHValidationError(f"无法加载私钥（{path}）：{detail}")

    def _connect(self, profile: dict[str, Any], password: str | None = None) -> _PooledConnection:
        paramiko_mod = _require_paramiko()
        host = _as_text(profile.get("host"))
        port = int(profile.get("port") or DEFAULT_PORT)
        username = _as_text(profile.get("username"))
        auth = _as_text(profile.get("auth")) or AUTH_PASSWORD
        client = paramiko_mod.SSHClient()
        try:
            try:
                client.load_system_host_keys()
            except Exception:
                pass
            expected = self.known_fingerprint(host, port)
            class PinnedHostPolicy(paramiko_mod.MissingHostKeyPolicy):
                def missing_host_key(policy, ssh_client, hostname, key):
                    if expected and _fingerprint_of(key) != expected:
                        raise SSHError("SSH 主机指纹与受信任记录不符，已在认证前拒绝连接")
            client.set_missing_host_key_policy(PinnedHostPolicy())
            kwargs: dict[str, Any] = {
                "hostname": host,
                "port": port,
                "username": username,
                "timeout": CONNECT_TIMEOUT_S,
                "banner_timeout": CONNECT_TIMEOUT_S,
                "auth_timeout": CONNECT_TIMEOUT_S,
                "allow_agent": False,
                "look_for_keys": False,
            }
            if auth == AUTH_KEY:
                key_path = _as_text(profile.get("key_path"))
                if not key_path:
                    raise SSHValidationError("私钥认证缺少 key_path")
                kwargs["pkey"] = self._load_private_key(key_path)
            elif auth == AUTH_AGENT:
                kwargs["allow_agent"] = True
            else:
                if not password:
                    raise SSHValidationError(
                        "该档案未保存密码：请先执行“测试连接”并输入密码，或编辑档案后开始“记住密码”。"
                    )
                kwargs["password"] = password
            client.connect(**kwargs)
            transport = client.get_transport()
            if transport is None or not transport.is_active():
                raise SSHError("SSH 连接建立失败：传输层未激活")
            transport.set_keepalive(15)
            server_key = transport.get_remote_server_key()
            fingerprint = _fingerprint_of(server_key)
            warning = self._remember_host(profile, fingerprint)
            pooled = _PooledConnection(
                profile_id=_as_text(profile.get("id")),
                client=client,
                host=host,
                username=username,
                fingerprint=fingerprint,
                server_version=str(getattr(transport, "remote_version", "") or ""),
                warning=warning,
                created_at=time.time(),
                last_used=time.time(),
            )
            return pooled
        except SSHError:
            self._close_client(client)
            raise
        except Exception as exc:
            self._close_client(client)
            raise self._connection_error(exc) from exc

    @staticmethod
    def _close_client(client: Any) -> None:
        try:
            client.close()
        except Exception:
            pass

    def _drop_locked(self, profile_id: str) -> None:
        pooled = self._pool.pop(profile_id, None)
        if pooled is not None:
            self._close_client(pooled.client)

    def _drop(self, profile_id: str) -> None:
        with self._lock:
            self._drop_locked(profile_id)

    def _get_client(self, profile: dict[str, Any]) -> Any:
        pid = _as_text(profile.get("id"))
        with self._lock:
            connection_lock = self._connect_locks.setdefault(pid, threading.RLock())
        # Single flight per profile. Network I/O must not hold the global lock:
        # a slow host must not block other hosts, and concurrent acquisitions
        # must never replace/close a transport already returned to another tool.
        with connection_lock:
            with self._lock:
                pooled = self._pool.get(pid)
                if pooled is not None and pooled.is_alive() and pooled.host == _as_text(profile.get("host")):
                    pooled.last_used = time.time()
                    return pooled.client
                self._drop_locked(pid)
            password = self._resolve_password(profile)
            pooled = self._connect(profile, password=password)
            with self._lock:
                self._pool[pid] = pooled
            return pooled.client

    def close(self) -> None:
        with self._lock:
            for pid in list(self._pool):
                self._drop_locked(pid)

    def pooled_count(self) -> int:
        with self._lock:
            return len(self._pool)

    # ------------------------------------------------------------------
    # 测试连接
    # ------------------------------------------------------------------
    def _test_profile(self, profile: dict[str, Any], password: str | None, remember: bool) -> dict[str, Any]:
        started = time.perf_counter()
        pid = _as_text(profile.get("id"))
        try:
            explicit = _as_text(password)
            effective = self._resolve_password(profile, explicit)
            # Test the supplied credential without destroying channels used by
            # active tools/terminals. Failed credentials must not replace the
            # last working session credential or trusted fingerprint.
            pooled = self._connect(profile, password=effective)
            with self._lock:
                existing = self._pool.get(pid)
                if existing is not None and existing.is_alive():
                    self._close_client(pooled.client)
                else:
                    self._drop_locked(pid)
                    self._pool[pid] = pooled
            if explicit:
                if remember:
                    self._apply_password(profile, explicit, remember=True)
                else:
                    cid = _as_text(profile.get("credential_id")) or new_id("cred")
                    profile["credential_id"] = cid
                    profile["credential_backend"] = self._credentials.backend
                    self._session_passwords[pid] = explicit
                    self._credentials.remember(cid, explicit)
            latency_ms = int((time.perf_counter() - started) * 1000)
            result = {
                "ok": True,
                "server_version": pooled.server_version,
                "fingerprint": pooled.fingerprint,
                "latency_ms": latency_ms,
                "error": "",
                "warning": pooled.warning,
                "credential_stored": bool(profile.get("credential_stored")),
                "credential_backend": self._credentials.backend,
                "credential_hint": profile.get("credential_notice") or "",
            }
            self._touch_profile(pid, ok=True)
            return result
        except Exception as exc:
            error = exc if isinstance(exc, SSHError) else self._connection_error(exc)
            latency_ms = int((time.perf_counter() - started) * 1000)
            self._touch_profile(pid, ok=False, error=str(error))
            return {
                "ok": False,
                "server_version": "",
                "fingerprint": "",
                "latency_ms": latency_ms,
                "error": str(error),
                "warning": "",
                "credential_stored": bool(profile.get("credential_stored")),
                "credential_backend": self._credentials.backend,
                "credential_hint": profile.get("credential_notice") or "",
            }

    def test_connection(self, profile_id: str, password: str | None = None, *, remember: bool = False) -> dict[str, Any]:
        profile = self._get_profile_raw(profile_id)
        result = self._test_profile(profile, password, remember)
        if _as_text(password) and result.get("ok"):
            self._persist_profile(profile)
        return result

    def test_connection_fields(
        self,
        fields: dict[str, Any],
        password: str | None = None,
        *,
        remember: bool = False,
    ) -> dict[str, Any]:
        """用尚未保存的档案字段测试连接（工作区探测/向导可用）。"""
        clean = self._validate_required(fields)
        profile = _profile_defaults()
        profile.update(clean)
        profile["id"] = new_id("probe")
        profile["created_at"] = _now()
        profile["updated_at"] = _now()
        if clean["auth"] == AUTH_PASSWORD:
            self._apply_password(profile, _as_text(password), remember=remember)
        result = self._test_profile(profile, password, remember)
        return result

    def _persist_profile(self, profile: dict[str, Any]) -> None:
        pid = _as_text(profile.get("id"))
        try:
            with self._store_lock:
                store = self._load_store()
                profiles = list(store.get("profiles") or [])
                for index, item in enumerate(profiles):
                    if item.get("id") == pid:
                        profiles[index] = profile
                        break
                else:
                    return
                self._write_store(profiles)
        except Exception as exc:  # pragma: no cover - 磁盘异常
            logger.warning("更新 SSH 档案状态失败：%s", exc)

    def _touch_profile(self, profile_id: str, *, ok: bool, error: str = "") -> None:
        if not profile_id:
            return
        try:
            with self._store_lock:
                store = self._load_store()
                profiles = list(store.get("profiles") or [])
                changed = False
                for profile in profiles:
                    if profile.get("id") != profile_id:
                        continue
                    if ok:
                        profile["last_ok"] = _now()
                        profile["last_error"] = ""
                    else:
                        profile["last_error"] = (error or "连接失败")[:500]
                    changed = True
                    break
                if changed:
                    self._write_store(profiles)
        except Exception as exc:  # pragma: no cover
            logger.warning("记录 SSH 档案连接状态失败：%s", exc)

    # ------------------------------------------------------------------
    # 命令执行
    # ------------------------------------------------------------------
    @staticmethod
    def _decode_output(data: bytes) -> str:
        return _truncate_capture(bytes(data).decode("utf-8", "replace"))

    def _exec_on(
        self,
        client: Any,
        command: str,
        timeout_s: float,
        cwd: str = "",
    ) -> dict[str, Any]:
        """在已建立的连接上执行一次命令。

        - 未提交（open_session / exec_command 失败）→ ``_CommandNotSubmitted``
        - 已提交但连接中断 → ``SSHCommandUnknown``
        - 正常/超时 → dict（status=ok/timeout）
        """
        transport = client.get_transport() if client is not None else None
        if transport is None or not getattr(transport, "is_active", lambda: False)():
            raise _CommandNotSubmitted("SSH 连接已断开（命令未提交）")
        try:
            channel = transport.open_session(timeout=max(1.0, min(10.0, timeout_s)))
        except Exception as exc:
            raise _CommandNotSubmitted(f"打开 SSH 命令通道失败（命令未提交）：{type(exc).__name__}: {exc}") from exc
        submitted = False
        started = time.perf_counter()
        stdout = bytearray()
        stderr = bytearray()
        output_limited = False
        def capture(target, chunk):
            nonlocal output_limited
            remaining = max(0, MAX_CAPTURE_CHARS * 2-len(stdout)-len(stderr))
            if len(chunk) > remaining:
                output_limited = True
            target.extend(chunk[:remaining])
        deadline = time.monotonic() + timeout_s
        try:
            payload = command
            if cwd:
                payload = f"cd {shlex.quote(cwd)} && {command}"
            try:
                channel.exec_command(payload)
                submitted = True
            except Exception as exc:
                raise _CommandNotSubmitted(f"提交 SSH 命令失败（未执行）：{type(exc).__name__}: {exc}") from exc
            try:
                channel.shutdown_write()
            except Exception:
                pass
            timed_out = False
            while True:
                if time.monotonic() > deadline:
                    timed_out = True
                    break
                got = False
                try:
                    if channel.recv_ready():
                        chunk = channel.recv(65536)
                        if chunk:
                            capture(stdout, chunk)
                            got = True
                except Exception as exc:
                    raise SSHCommandUnknown(
                        f"SSH 命令已提交，但读取输出时连接中断：{type(exc).__name__}: {exc}",
                        stdout=self._decode_output(stdout),
                        stderr=self._decode_output(stderr),
                        duration_ms=int((time.perf_counter() - started) * 1000),
                    ) from exc
                try:
                    if channel.recv_stderr_ready():
                        chunk = channel.recv_stderr(65536)
                        if chunk:
                            capture(stderr, chunk)
                            got = True
                except Exception as exc:
                    raise SSHCommandUnknown(
                        f"SSH 命令已提交，但读取错误输出时连接中断：{type(exc).__name__}: {exc}",
                        stdout=self._decode_output(stdout),
                        stderr=self._decode_output(stderr),
                        duration_ms=int((time.perf_counter() - started) * 1000),
                    ) from exc
                try:
                    exit_ready = bool(channel.exit_status_ready())
                except Exception:
                    exit_ready = True
                if exit_ready and not got:
                    break
                if not got:
                    time.sleep(0.02)
            duration_ms = int((time.perf_counter() - started) * 1000)
            if timed_out:
                return {
                    "status": "timeout",
                    "exit_code": None,
                    "stdout": self._decode_output(stdout),
                    "stderr": _truncate_capture(
                        (self._decode_output(stderr) or "")
                        + f"\n[SSH 命令执行超时：超过 {timeout_s:.0f} 秒，已停止等待；远端进程可能仍在运行]"
                    ),
                    "duration_ms": duration_ms,
                }
            try:
                exit_code = int(channel.recv_exit_status())
            except Exception:
                raise SSHCommandUnknown("SSH 命令退出码不可读，不能确认成功",
                    stdout=self._decode_output(stdout),stderr=self._decode_output(stderr),duration_ms=duration_ms)
            return {
                "status": "output_limited" if output_limited else "ok" if exit_code == 0 else "nonzero",
                "truncated": output_limited,
                "exit_code": exit_code,
                "stdout": self._decode_output(stdout),
                "stderr": self._decode_output(stderr),
                "duration_ms": duration_ms,
            }
        except SSHCommandUnknown:
            raise
        except _CommandNotSubmitted:
            raise
        except Exception as exc:
            if not submitted:
                raise _CommandNotSubmitted(f"SSH 命令未提交：{type(exc).__name__}: {exc}") from exc
            raise SSHCommandUnknown(
                f"SSH 命令已提交，但连接在执行过程中中断：{type(exc).__name__}: {exc}",
                stdout=self._decode_output(stdout),
                stderr=self._decode_output(stderr),
                duration_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        finally:
            try:
                channel.close()
            except Exception:
                pass

    def _record_command(
        self,
        *,
        command_id: str,
        profile_id: str,
        command: str,
        cwd: str,
        status: str,
        exit_code: int | None,
        started_at: str,
        duration_ms: int,
        retries: int,
        error: str = "",
    ) -> dict[str, Any]:
        record = {
            "id": command_id,
            "profile_id": profile_id,
            "status": status,
            "exit_code": exit_code,
            "cwd": cwd,
            "started_at": started_at,
            "finished_at": _now(),
            "duration_ms": int(duration_ms),
            "retries": int(retries),
            "command_sha256": hashlib.sha256(command.encode("utf-8")).hexdigest(),
            "command_length": len(command),
            "error": (error or "")[:300],
        }
        try:
            with self._lock:
                path = self.command_log_path
                path.parent.mkdir(parents=True, exist_ok=True)
                existing: list[str] = []
                if path.exists():
                    try:
                        existing = path.read_text(encoding="utf-8").splitlines()
                    except Exception:
                        existing = []
                existing = [line for line in existing if line.strip()]
                existing.append(json.dumps(record, ensure_ascii=False))
                if len(existing) > MAX_COMMAND_LOG_RECORDS:
                    existing = existing[-MAX_COMMAND_LOG_RECORDS:]
                atomic_write_text(path, "\n".join(existing) + "\n")
        except Exception as exc:  # pragma: no cover - 磁盘异常
            logger.warning("写入 SSH 命令记录失败：%s", exc)
        return record

    def recent_commands(self, limit: int = 20) -> list[dict[str, Any]]:
        try:
            lines = self.command_log_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
        records: list[dict[str, Any]] = []
        for line in lines[-max(1, int(limit)) :]:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if isinstance(record, dict):
                records.append(record)
        return records

    @staticmethod
    def _unknown_result(
        exc: SSHCommandUnknown,
        *,
        command_id: str,
        command: str,
        cwd: str,
        started_at: str,
        retries: int,
    ) -> dict[str, Any]:
        return {
            "ok": False,
            "status": "unknown",
            "exit_code": None,
            "stdout": exc.stdout,
            "stderr": exc.stderr,
            "duration_ms": int(exc.duration_ms),
            "retried": retries > 0,
            "command_id": command_id,
            "reconciliation": {
                "message": (
                    "命令已经提交到远端，但连接中断，执行结果未知。"
                    "为避免重复副作用，系统没有自动重试；请检查远端进程/日志（例如 ps、作业日志）后手动确认。"
                ),
                "command_id": command_id,
                "command_sha256": hashlib.sha256(command.encode("utf-8")).hexdigest(),
                "command_length": len(command),
                "cwd": cwd,
                "started_at": started_at,
                "recent_commands": [],
            },
        }

    def exec(
        self,
        profile_id: str,
        command: str,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        cwd: str | None = None,
        *,
        idempotent: bool = False,
        record: bool = True,
    ) -> dict[str, Any]:
        """执行一条远端命令。

        - 仅在“命令确定未提交”时自动重试一次（连接建立失败/通道打开失败）。
        - 已提交后失联：返回 ``status="unknown"`` 与对账信息，绝不自动执行第二次。
        - ``idempotent=True`` 表示调用方声明该命令只读、可安全重跑：此时未提交
          错误与 unknown 均允许重试一次。
        - 远端非零退出不是异常：``ok=False``、``status="nonzero"``。
        """
        pid = _as_text(profile_id)
        text = command if isinstance(command, str) else str(command or "")
        if not text.strip():
            raise SSHValidationError("命令不能为空")
        timeout = _coerce_timeout(timeout_s)
        cwd_text = _as_text(cwd)
        profile = self._get_profile_raw(pid)
        command_id = new_id("cmd")
        started_at = _now()
        last_error: SSHError | None = None
        retries = 0
        for attempt in (1, 2):
            try:
                client = self._get_client(profile)
            except SSHError as exc:
                last_error = exc
                transient = bool(getattr(exc, "transient", False))
                is_validation = isinstance(exc, SSHValidationError)
                if attempt == 1 and transient and not is_validation:
                    self._drop(pid)
                    retries += 1
                    continue
                if record:
                    self._record_command(
                        command_id=command_id,
                        profile_id=pid,
                        command=text,
                        cwd=cwd_text,
                        status="error",
                        exit_code=None,
                        started_at=started_at,
                        duration_ms=0,
                        retries=retries,
                        error=str(exc),
                    )
                self._touch_profile(pid, ok=False, error=str(exc))
                raise
            try:
                raw = self._exec_on(client, text, timeout, cwd_text)
            except _CommandNotSubmitted as exc:
                last_error = SSHError(str(exc))
                if attempt == 1:
                    self._drop(pid)
                    retries += 1
                    continue
                if record:
                    self._record_command(
                        command_id=command_id,
                        profile_id=pid,
                        command=text,
                        cwd=cwd_text,
                        status="error",
                        exit_code=None,
                        started_at=started_at,
                        duration_ms=0,
                        retries=retries,
                        error=str(exc),
                    )
                self._touch_profile(pid, ok=False, error=str(exc))
                raise last_error from exc
            except SSHCommandUnknown as exc:
                if idempotent and attempt == 1:
                    self._drop(pid)
                    retries += 1
                    continue
                if record:
                    self._record_command(
                        command_id=command_id,
                        profile_id=pid,
                        command=text,
                        cwd=cwd_text,
                        status="unknown",
                        exit_code=None,
                        started_at=started_at,
                        duration_ms=exc.duration_ms,
                        retries=retries,
                        error=str(exc),
                    )
                self._touch_profile(pid, ok=False, error=str(exc))
                result = self._unknown_result(
                    exc,
                    command_id=command_id,
                    command=text,
                    cwd=cwd_text,
                    started_at=started_at,
                    retries=retries,
                )
                result["reconciliation"]["recent_commands"] = self.recent_commands(5)
                return result
            except SSHError as exc:
                last_error = exc
                if record:
                    self._record_command(
                        command_id=command_id,
                        profile_id=pid,
                        command=text,
                        cwd=cwd_text,
                        status="error",
                        exit_code=None,
                        started_at=started_at,
                        duration_ms=0,
                        retries=retries,
                        error=str(exc),
                    )
                self._touch_profile(pid, ok=False, error=str(exc))
                raise
            status = raw["status"]
            if record:
                self._record_command(
                    command_id=command_id,
                    profile_id=pid,
                    command=text,
                    cwd=cwd_text,
                    status=status,
                    exit_code=raw.get("exit_code"),
                    started_at=started_at,
                    duration_ms=raw.get("duration_ms", 0),
                    retries=retries,
                    error="",
                )
            ok = bool(status == "ok" and raw.get("exit_code") == 0)
            self._touch_profile(pid, ok=ok, error="" if ok else f"最近命令状态：{status}")
            result = dict(raw)
            result.update({"ok": ok, "retried": retries > 0, "command_id": command_id})
            return result
        if last_error is not None:  # pragma: no cover - 循环必然 return/raise
            raise last_error
        raise SSHError("SSH 命令执行失败：未知原因")

    # ------------------------------------------------------------------
    # SFTP
    # ------------------------------------------------------------------
    def open_sftp(self, profile_id: str) -> _SFTPSession:
        pid = _as_text(profile_id)
        profile = self._get_profile_raw(pid)
        client = self._get_client(profile)
        try:
            sftp = client.open_sftp()
        except Exception as exc:
            self._drop(pid)
            raise self._connection_error(exc) from exc
        return _SFTPSession(self, pid, client, sftp)

    def _sftp_makedirs(self, session: _SFTPSession, directory: str) -> None:
        directory = _clean_remote_path(directory)
        if not directory or directory == ".":
            return
        parts = [part for part in directory.split("/") if part]
        current = "/" if directory.startswith("/") else ""
        for part in parts:
            current = f"{current}{part}" if current.endswith("/") else (f"{current}/{part}" if current else part)
            try:
                session.sftp.stat(current)
            except IOError:
                try:
                    session.sftp.mkdir(current)
                except IOError:
                    # 并发下可能已存在；再次 stat 确认
                    try:
                        session.sftp.stat(current)
                    except IOError as exc:
                        raise SSHError(f"无法创建远端目录：{current}") from exc

    def _replace_remote(self, session: _SFTPSession, source: str, target: str) -> None:
        try:
            posix_rename = getattr(session.sftp, "posix_rename", None)
            if callable(posix_rename):
                posix_rename(source, target)
                return
        except Exception:
            pass
        try:
            session.sftp.remove(target)
        except Exception:
            pass
        session.sftp.rename(source, target)

    def _transfer_error(self, action: str, exc: Exception, *, detail: str = "") -> SSHError:
        if isinstance(exc, SSHError):
            return exc
        if isinstance(exc, SSHProfileNotFound) or isinstance(exc, SSHValidationError):
            return exc
        suffix = f"（{detail}）" if detail else ""
        return SSHError(f"{action}失败：{type(exc).__name__}: {exc}{suffix}")

    def put_file(
        self,
        profile_id: str,
        local_path: str | Path,
        remote_path: str,
        mkdir: bool = True,
        progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        source = Path(local_path).expanduser()
        if not source.is_file():
            raise SSHValidationError(f"本地文件不存在：{source}")
        size = source.stat().st_size
        remote_requested = _clean_remote_path(remote_path)
        last_error: Exception | None = None
        for attempt in (1, 2):
            session: _SFTPSession | None = None
            temp = ""
            try:
                session = self.open_sftp(profile_id)
                remote = session.normalize(remote_requested)
                if mkdir:
                    parent = posixpath.dirname(remote)
                    if parent:
                        self._sftp_makedirs(session, parent)
                temp = remote + ".omicslab-upload-" + uuid.uuid4().hex[:8]
                transferred = 0

                def callback(done: int, total: int) -> None:
                    nonlocal transferred
                    transferred = int(done)
                    if progress is not None and (total <= 0 or done >= total or done - transferred < 0):
                        pass
                    if progress is not None and size >= PROGRESS_THRESHOLD_BYTES:
                        try:
                            progress(int(done), int(total or size))
                        except Exception:
                            pass

                session.sftp.put(str(source), temp, callback=callback)
                self._replace_remote(session, temp, remote)
                return {
                    "ok": True,
                    "bytes": int(size),
                    "remote_path": remote,
                    "retried": attempt > 1,
                }
            except SSHProfileNotFound:
                raise
            except SSHValidationError:
                raise
            except Exception as exc:
                last_error = exc
                if temp and session is not None:
                    try:
                        session.sftp.remove(temp)
                    except Exception:
                        pass
                if attempt == 1:
                    self._drop(_as_text(profile_id))
                    continue
            finally:
                if session is not None:
                    session.close()
        raise self._transfer_error("上传", last_error or SSHError("未知错误"))

    def get_file(
        self,
        profile_id: str,
        remote_path: str,
        local_path: str | Path,
        progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        destination = Path(local_path).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(destination.name + ".part")
        remote_requested = _clean_remote_path(remote_path)
        last_error: Exception | None = None
        for attempt in (1, 2):
            session: _SFTPSession | None = None
            try:
                session = self.open_sftp(profile_id)
                remote = session.normalize(remote_requested)

                def callback(done: int, total: int) -> None:
                    if progress is not None and (total <= 0 or int(done) >= int(total)):
                        try:
                            progress(int(done), int(total or 0))
                        except Exception:
                            pass

                session.sftp.get(remote, str(temp), callback=callback)
                os.replace(temp, destination)
                return {
                    "ok": True,
                    "bytes": int(destination.stat().st_size),
                    "local_path": str(destination),
                    "retried": attempt > 1,
                }
            except SSHProfileNotFound:
                raise
            except SSHValidationError:
                raise
            except Exception as exc:
                last_error = exc
                try:
                    temp.unlink(missing_ok=True)
                except Exception:
                    pass
                if attempt == 1:
                    self._drop(_as_text(profile_id))
                    continue
            finally:
                if session is not None:
                    session.close()
        raise self._transfer_error("下载", last_error or SSHError("未知错误"))

    def _sftp_stat_dict(self, session: _SFTPSession, path: str) -> dict[str, Any] | None:
        remote = session.normalize(_clean_remote_path(path))
        try:
            attributes = session.sftp.stat(remote)
        except IOError:
            return None
        except Exception as exc:
            raise self._transfer_error("读取远端文件状态", exc) from exc
        return {
            "path": remote,
            "exists": True,
            "is_dir": stat_module.S_ISDIR(getattr(attributes, "st_mode", 0)),
            "size": int(getattr(attributes, "st_size", 0) or 0),
            "mtime": int(getattr(attributes, "st_mtime", 0) or 0),
            "mode": int(getattr(attributes, "st_mode", 0) or 0),
            "uid": getattr(attributes, "st_uid", None),
            "gid": getattr(attributes, "st_gid", None),
        }

    def stat(self, profile_id: str, remote_path: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        with self.open_sftp(pid) as session:
            result = self._sftp_stat_dict(session, remote_path)
        if result is None:
            return {"path": _clean_remote_path(remote_path), "exists": False, "is_dir": False, "size": 0}
        return result

    def list_dir(self, profile_id: str, remote_path: str = ".") -> dict[str, Any]:
        pid = _as_text(profile_id)
        last_error: Exception | None = None
        for attempt in (1, 2):
            session: _SFTPSession | None = None
            try:
                session = self.open_sftp(pid)
                remote = session.normalize(_clean_remote_path(remote_path))
                entries: list[dict[str, Any]] = []
                for attributes in session.sftp.listdir_attr(remote):
                    name = str(getattr(attributes, "filename", "") or "")
                    if not name or name in (".", ".."):
                        continue
                    mode = int(getattr(attributes, "st_mode", 0) or 0)
                    entries.append(
                        {
                            "name": name,
                            "is_dir": stat_module.S_ISDIR(mode),
                            "size": int(getattr(attributes, "st_size", 0) or 0),
                            "mtime": int(getattr(attributes, "st_mtime", 0) or 0),
                            "attributes": {
                                "mode": mode,
                                "uid": getattr(attributes, "st_uid", None),
                                "gid": getattr(attributes, "st_gid", None),
                                "atime": getattr(attributes, "st_atime", None),
                            },
                        }
                    )
                entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))
                return {"path": remote, "entries": entries}
            except SSHProfileNotFound:
                raise
            except SSHValidationError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt == 1:
                    self._drop(pid)
                    continue
            finally:
                if session is not None:
                    session.close()
        raise self._transfer_error("列目录", last_error or SSHError("未知错误"))

    def mkdir(self, profile_id: str, remote_path: str, *, parents: bool = True) -> dict[str, Any]:
        pid = _as_text(profile_id)
        with self.open_sftp(pid) as session:
            remote = session.normalize(_clean_remote_path(remote_path))
            if parents:
                self._sftp_makedirs(session, remote)
            else:
                try:
                    session.sftp.mkdir(remote)
                except Exception as exc:
                    raise self._transfer_error("创建目录", exc) from exc
        return {"ok": True, "path": remote}

    def delete(self, profile_id: str, remote_path: str, *, recursive: bool = False) -> dict[str, Any]:
        pid = _as_text(profile_id)
        deleted = 0
        with self.open_sftp(pid) as session:
            remote = session.normalize(_clean_remote_path(remote_path))
            info = self._sftp_stat_dict(session, remote)
            if info is None:
                return {"ok": True, "path": remote, "deleted": 0}

            def remove_tree(path: str) -> None:
                nonlocal deleted
                for attributes in session.sftp.listdir_attr(path):
                    name = str(getattr(attributes, "filename", ""))
                    if not name or name in (".", ".."):
                        continue
                    child = posixpath.join(path, name)
                    if stat_module.S_ISDIR(int(getattr(attributes, "st_mode", 0) or 0)):
                        if not recursive:
                            raise SSHValidationError(f"远端目录非空且未开启递归删除：{path}")
                        remove_tree(child)
                    else:
                        session.sftp.remove(child)
                        deleted += 1
                session.sftp.rmdir(path)

            if info["is_dir"]:
                remove_tree(remote)
                deleted += 1
            else:
                session.sftp.remove(remote)
                deleted += 1
        return {"ok": True, "path": remote, "deleted": deleted}

    def read_bytes(self, profile_id: str, remote_path: str, max_bytes: int | None = None) -> bytes:
        pid = _as_text(profile_id)
        with self.open_sftp(pid) as session:
            remote = session.normalize(_clean_remote_path(remote_path))
            try:
                with session.sftp.open(remote, "rb") as handle:
                    data = handle.read() if max_bytes is None else handle.read(int(max_bytes) + 1)
            except Exception as exc:
                raise self._transfer_error("读取远端文件", exc) from exc
        if max_bytes is not None and len(data) > max_bytes:
            raise SSHError(f"远端文件超过大小限制（>{max_bytes} 字节）：{remote}")
        return data

    def write_bytes(
        self,
        profile_id: str,
        remote_path: str,
        data: bytes,
        *,
        mkdir: bool = True,
    ) -> dict[str, Any]:
        pid = _as_text(profile_id)
        payload = bytes(data)
        with self.open_sftp(pid) as session:
            remote = session.normalize(_clean_remote_path(remote_path))
            if mkdir:
                parent = posixpath.dirname(remote)
                if parent:
                    self._sftp_makedirs(session, parent)
            temp = remote + ".omicslab-write-" + uuid.uuid4().hex[:8]
            try:
                with session.sftp.open(temp, "wb") as handle:
                    handle.write(payload)
                self._replace_remote(session, temp, remote)
            except Exception as exc:
                try:
                    session.sftp.remove(temp)
                except Exception:
                    pass
                raise self._transfer_error("写入远端文件", exc) from exc
        return {"ok": True, "path": remote, "bytes": len(payload)}

    def rename(self, profile_id: str, source: str, target: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        with self.open_sftp(pid) as session:
            source_remote = session.normalize(_clean_remote_path(source))
            target_remote = session.normalize(_clean_remote_path(target))
            try:
                session.sftp.rename(source_remote, target_remote)
            except Exception as exc:
                raise self._transfer_error("重命名远端文件", exc) from exc
        return {"ok": True, "source": source_remote, "target": target_remote}

    # ------------------------------------------------------------------
    # 交互终端（PTY）
    # ------------------------------------------------------------------
    def open_shell(
        self,
        profile_id: str,
        *,
        width: int = 100,
        height: int = 30,
        term: str = "xterm-256color",
    ) -> _TerminalChannel:
        pid = _as_text(profile_id)
        profile = self._get_profile_raw(pid)
        client = self._get_client(profile)
        diagnostic = ""
        channel: Any = None
        try:
            channel = client.invoke_shell(term=term, width=int(width), height=int(height))
        except Exception as exc:
            diagnostic = (
                f"invoke_shell 建立 PTY 失败（{type(exc).__name__}: {exc}），"
                "已回退为 exec_command(get_pty=True) 交互 shell；部分终端功能可能不可用。"
            )
            logger.warning("SSH 档案 %s：%s", pid, diagnostic)
            try:
                command = "exec ${SHELL:-/bin/sh} -i"
                channel = client.exec_command(command, get_pty=True)[0]
            except Exception as exc2:
                raise SSHError(
                    f"无法打开 SSH 交互终端：{type(exc).__name__}: {exc}；回退失败：{type(exc2).__name__}: {exc2}"
                ) from exc2
        return _TerminalChannel(
            manager=self,
            profile_id=pid,
            client=client,
            channel=channel,
            diagnostic=diagnostic,
        )

    # ------------------------------------------------------------------
    # 远端信息
    # ------------------------------------------------------------------
    def _probe(self, profile_id: str, command: str, timeout_s: float = 20) -> str | None:
        try:
            result = self.exec(profile_id, command, timeout_s=timeout_s, idempotent=True, record=False)
        except SSHError:
            return None
        if result.get("status") != "ok":
            return None
        stdout = _as_text(result.get("stdout"))
        return stdout or None

    def remote_info(self, profile_id: str) -> dict[str, Any]:
        pid = _as_text(profile_id)
        profile = self._get_profile_raw(pid)
        self._get_client(profile)  # 连接失败直接抛出，路由映射 502
        uname = self._probe(pid, "uname -srm 2>/dev/null || uname -a 2>/dev/null")
        python = self._probe(pid, "python3 --version 2>&1 || python --version 2>&1")
        cpu_raw = self._probe(pid, "nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null")
        mem_raw = self._probe(pid, "head -n 3 /proc/meminfo 2>/dev/null")
        gpu = self._probe(
            pid,
            "nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1",
        )
        if not gpu:
            gpu = self._probe(
                pid,
                "lspci 2>/dev/null | grep -i -E 'vga|3d|display' | head -n 1 | sed 's/^[0-9a-f:.]* //'",
            )
        disk_raw = self._probe(pid, "df -Pk . 2>/dev/null | tail -n 1")
        cpu_count: int | None = None
        if cpu_raw:
            try:
                cpu_count = int(_as_text(cpu_raw).split()[0])
            except (ValueError, IndexError):
                cpu_count = None
        mem_total_mb: int | None = None
        if mem_raw:
            for line in mem_raw.splitlines():
                if "MemTotal" in line:
                    parts = line.split()
                    if len(parts) >= 2:
                        try:
                            mem_total_mb = int(int(parts[1]) / 1024)
                        except (ValueError, TypeError):
                            mem_total_mb = None
                    break
        disk_free_gb: float | None = None
        if disk_raw:
            fields = disk_raw.split()
            if len(fields) >= 4:
                try:
                    disk_free_gb = round(int(fields[3]) / (1024 * 1024), 2)
                except (ValueError, TypeError):
                    disk_free_gb = None
        return {
            "uname": uname,
            "python": python,
            "cpu_count": cpu_count,
            "mem_total_mb": mem_total_mb,
            "gpu": gpu,
            "disk_free_gb": disk_free_gb,
        }

    # ------------------------------------------------------------------
    # 诊断
    # ------------------------------------------------------------------
    def diagnostics(self) -> dict[str, Any]:
        try:
            profiles = self.list_profiles()
        except Exception:
            profiles = []
        return {
            "profiles": len(profiles),
            "pooled_connections": self.pooled_count(),
            "known_hosts": len((self._load_known_hosts().get("hosts") or {})),
            "command_log": str(self.command_log_path),
            "credentials": self.credential_status(),
        }


__all__ = [
    "AUTH_KEY",
    "AUTH_METHODS",
    "AUTH_PASSWORD",
    "COMMAND_LOG_FILENAME",
    "CONNECT_TIMEOUT_S",
    "DEFAULT_PORT",
    "DEFAULT_TIMEOUT_S",
    "MAX_TIMEOUT_S",
    "PROFILES_FILENAME",
    "SSHCommandUnknown",
    "SSHError",
    "SSHManager",
    "SSHProfileNotFound",
    "SSHValidationError",
    "public_profile",
]
