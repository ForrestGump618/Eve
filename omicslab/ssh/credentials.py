"""SSH 凭据存储。

设计原则（对应 F15 / CONTRACTS-3 §6）：

- 密码默认只保存在进程内存里，不写入 ``ssh.json``。
- 只有在用户显式选择“记住密码”时才尝试写入系统凭据库（keyring）。
- 当前环境没有可用的系统凭据库时，降级为“仅内存”，并通过
  ``credential_stored=false`` / ``credential_backend="memory"`` 对 UI 明示；
  绝不退回明文或 Base64 混淆的文件存储。
- 历史遗留的 ``"b64:..."`` 密码值由 ``SSHManager`` 在加载时迁移：解码后写入
  内存（或系统凭据库），并从档案文件中删除；迁移前保留 ``ssh.json.bak`` 备份。
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger("omicslab.ssh.credentials")

SERVICE_NAME = "omicslab-ssh"

_FAIL_BACKENDS = {
    "failkeyring",
    "nullkeyring",
    "chainerbackend",
    "keyring.backends.fail.Keyring",
    "keyring.backends.null.Keyring",
}


class CredentialStore:
    """优先 keyring、不可用时降级内存的凭据存储。

    所有方法都是同步的；调用方（SSHManager）已用锁保护，内部再加一把可重入锁
    以支持直接从其他线程使用。
    """

    def __init__(self, home: Any = None) -> None:
        self.home = home
        self._lock = threading.RLock()
        self._memory: dict[str, str] = {}
        self._backend = "memory"
        self._keyring: Any = None
        self._message = ""
        self._init_backend()

    # -- backend detection -------------------------------------------------
    def _init_backend(self) -> None:
        if os.name == "nt":
            try:
                from .windows_credentials import WindowsCredentials
                self._keyring = WindowsCredentials()
                self._backend = "windows-credential-manager"
                self._message = "密码保存在 Windows 系统凭据库，重启后可复用"
                return
            except Exception:
                pass
        try:
            import keyring  # type: ignore[import-not-found]
        except Exception as exc:  # keyring 未安装：最常见的情况
            self._backend = "memory"
            self._keyring = None
            self._message = (
                "未安装系统凭据库（keyring），密码只保存在当前进程内存中；"
                f"重启服务后需要重新输入。原因：{type(exc).__name__}"
            )
            return
        try:
            backend = keyring.get_keyring()
            name = type(backend).__name__
            module = type(backend).__module__ or ""
            if name in ("FailKeyring", "NullKeyring", "ChainerBackend") or (
                module.startswith("keyring.backends.") and "fail" in module.lower()
            ):
                raise RuntimeError(f"keyring 后端不可用：{module}.{name}")
            self._keyring = keyring
            self._backend = "keyring"
            self._message = f"使用系统凭据库：{module}.{name}"
        except Exception as exc:
            self._backend = "memory"
            self._keyring = None
            self._message = (
                "系统凭据库不可用，密码只保存在当前进程内存中；"
                f"重启服务后需要重新输入。原因：{type(exc).__name__}: {exc}"
            )

    # -- introspection -----------------------------------------------------
    @property
    def backend(self) -> str:
        return self._backend

    @property
    def persistent(self) -> bool:
        return self._backend in {"keyring", "windows-credential-manager"}

    def status(self) -> dict[str, Any]:
        return {
            "backend": self._backend,
            "persistent": self.persistent,
            "message": self._message,
            "memory_entries": len(self._memory),
        }

    # -- memory ------------------------------------------------------------
    def remember(self, credential_id: str, secret: str) -> None:
        """只写入进程内存（本次会话可用）。"""
        if not credential_id or secret is None:
            return
        with self._lock:
            self._memory[str(credential_id)] = str(secret)

    def has_memory(self, credential_id: str) -> bool:
        with self._lock:
            return str(credential_id) in self._memory

    def forget_memory(self, credential_id: str) -> None:
        with self._lock:
            self._memory.pop(str(credential_id), None)

    # -- persistence -------------------------------------------------------
    def save(self, credential_id: str, secret: str, *, persist: bool = True) -> dict[str, Any]:
        """写入内存；``persist=True`` 时再尝试系统凭据库。

        返回 ``{"stored": bool, "backend": str, "error": str}``；``stored`` 只表示
        是否成功持久化，内存写入总是成功。
        """
        credential_id = str(credential_id or "")
        if not credential_id:
            return {"stored": False, "backend": self._backend, "error": "credential_id 为空"}
        if secret is None:
            return {"stored": False, "backend": self._backend, "error": "密码为空"}
        self.remember(credential_id, secret)
        if not persist:
            return {"stored": False, "backend": self._backend, "error": ""}
        if not self.persistent or self._keyring is None:
            return {
                "stored": False,
                "backend": self._backend,
                "error": "当前环境没有可用的系统凭据库，密码仅保存在内存中",
            }
        try:
            self._keyring.set_password(SERVICE_NAME, credential_id, secret)
            return {"stored": True, "backend": self._backend, "error": ""}
        except Exception as exc:
            logger.warning("写入系统凭据库失败，降级为仅内存：%s", exc)
            return {
                "stored": False,
                "backend": self._backend,
                "error": f"写入系统凭据库失败：{type(exc).__name__}: {exc}",
            }

    def load(self, credential_id: str) -> str | None:
        """先查内存，再查系统凭据库；都没有返回 None。"""
        credential_id = str(credential_id or "")
        if not credential_id:
            return None
        with self._lock:
            secret = self._memory.get(credential_id)
        if secret is not None:
            return secret
        if not self.persistent or self._keyring is None:
            return None
        try:
            secret = self._keyring.get_password(SERVICE_NAME, credential_id)
            if secret is None and self._backend == "windows-credential-manager":
                # Adopt credentials written by a previously installed optional
                # keyring backend without changing their references.
                try:
                    import keyring
                    secret = keyring.get_password(SERVICE_NAME, credential_id)
                    if secret:
                        self._keyring.set_password(SERVICE_NAME, credential_id, secret)
                except Exception:
                    pass
        except Exception as exc:
            logger.warning("读取系统凭据库失败：%s", exc)
            return None
        if secret:
            with self._lock:
                self._memory[credential_id] = str(secret)
            return str(secret)
        return None

    def delete(self, credential_id: str) -> dict[str, Any]:
        credential_id = str(credential_id or "")
        if not credential_id:
            return {"deleted": False, "backend": self._backend, "error": ""}
        self.forget_memory(credential_id)
        if not self.persistent or self._keyring is None:
            return {"deleted": True, "backend": self._backend, "error": ""}
        try:
            self._keyring.delete_password(SERVICE_NAME, credential_id)
            return {"deleted": True, "backend": self._backend, "error": ""}
        except Exception as exc:  # 凭据不存在视为成功
            name = type(exc).__name__
            if "PasswordDeleteError" in name:
                return {"deleted": True, "backend": self._backend, "error": ""}
            return {"deleted": False, "backend": self._backend, "error": str(exc)}


__all__ = ["CredentialStore", "SERVICE_NAME"]
