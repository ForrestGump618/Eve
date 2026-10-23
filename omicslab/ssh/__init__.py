"""SSH 子系统：远程主机档案、命令执行、文件传输、共享连接服务与 Agent 工具。

对外暴露：

* :class:`SSHManager` —— 一期同步 SSH 管理器（凭据/known_hosts/命令/SFTP）；
* :class:`ConnectionService` / :func:`get_connection_service` —— 进程内单例，
  HTTP 路由、Agent 工具、SSHBackend、终端与 workspace 探测共用（F10）；
* :func:`register_ssh_tools` —— 注册 Agent 工具；
* 异常类型 :class:`SSHError` 及其子类。

契约见 ``docs/CONTRACTS-2.md`` §6 与 ``docs/CONTRACTS-3.md`` §6。
"""

from __future__ import annotations

from omicslab.ssh.connections import (
    ConnectionService,
    get_connection_service,
    reset_connection_services,
    reset_for_tests,
)
from omicslab.ssh.credentials import CredentialStore
from omicslab.ssh.manager import (
    AUTH_KEY,
    AUTH_METHODS,
    AUTH_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_S,
    SSHCommandUnknown,
    SSHError,
    SSHManager,
    SSHProfileNotFound,
    SSHValidationError,
    public_profile,
)
from omicslab.ssh.tools import register_ssh_tools

__all__ = [
    "AUTH_KEY",
    "AUTH_METHODS",
    "AUTH_PASSWORD",
    "ConnectionService",
    "CredentialStore",
    "DEFAULT_PORT",
    "DEFAULT_TIMEOUT_S",
    "SSHCommandUnknown",
    "SSHError",
    "SSHManager",
    "SSHProfileNotFound",
    "SSHValidationError",
    "get_connection_service",
    "public_profile",
    "register_ssh_tools",
    "reset_connection_services",
    "reset_for_tests",
]
