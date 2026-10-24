"""SSH 执行后端（CONTRACTS-3 §5/§6，任务书 T05/T06）。

- 所有远端能力都通过 :class:`omicslab.ssh.connections.ConnectionService` 复用同一
  连接与凭据（F10），绝不回退到本机执行。
- Python 执行使用远端轻量 worker（``ssh/worker.py``，JSON-lines over stdio），
  命名空间在 worker 进程内持久；worker 与 SSH 通道生命周期解耦，通道断开不会
  自动重放已提交的代码。
- 命令执行复用 manager 的无盲重试语义（F13）：只在“确定未提交”时重试一次，
  已提交后失联返回 unknown/对账信息。
- 长任务使用 ``nohup setsid`` 启动并记录 PID/PGID，取消时先 TERM 进程组、确认
  退出后才升级 KILL（T06）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import posixpath
import re
import shlex
import threading
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

from ..ssh.connections import ConnectionService, get_connection_service
from ..ssh.manager import (
    DEFAULT_TIMEOUT_S,
    MAX_TIMEOUT_S,
    SSHError,
    SSHManager,
    SSHProfileNotFound,
    SSHValidationError,
)
from ..workspace import WorkspaceContext
from .base import (
    BackendError,
    BackendUnavailable,
    BackendUnsupported,
    ExecutionBackend,
)

logger = logging.getLogger("omicslab.execution.ssh")

WORKER_DIR = ".omicslab"
WORKER_FILENAME = "worker.py"
JOBS_DIR = ".omicslab/jobs"
WORKER_START_TIMEOUT_S = 25.0
WORKER_REQUEST_TIMEOUT_S = 900.0
MAX_LOG_BYTES = 400_000
MAX_READ_TEXT_BYTES = 2_000_000
_REMOTE_MARKER = "__OMICSLAB_PID__"


def _truncate(text: str | None, limit: int) -> str:
    value = text or ""
    if len(value) <= limit:
        return value
    removed = len(value) - limit
    return f"{value[: limit // 2]}\n...[已截断 {removed} 字符]...\n{value[-limit // 2 :]}"


# ---------------------------------------------------------------------------
# 远端 worker 通道
# ---------------------------------------------------------------------------
class WorkerChannelError(RuntimeError):
    """worker 通道错误（起点/协议/超时）。"""


class WorkerChannelTimeout(WorkerChannelError):
    """等待 worker 响应超时。"""


class _WorkerClient:
    """把 paramiko Channel 包装成同步 JSON-lines 请求/响应客户端。

    所有方法都是阻塞的，调用方通过 ``asyncio.to_thread`` 使用。
    """

    def __init__(self, channel: Any, *, label: str = "") -> None:
        self.channel = channel
        self.label = label
        self.ready_payload: dict[str, Any] = {}
        self._lock = threading.Condition(threading.RLock())
        self._responses: dict[str, dict[str, Any]] = {}
        self._ready = threading.Event()
        self._closed = False
        self._error = ""
        self._stderr = bytearray()
        self._next_id = 0
        self._thread = threading.Thread(
            target=self._read_loop,
            name="omicslab-ssh-worker-reader",
            daemon=True,
        )
        self._thread.start()

    # -- 状态 ---------------------------------------------------------
    @property
    def alive(self) -> bool:
        return not self._closed

    def _fail(self, message: str) -> None:
        self._closed = True
        self._error = message
        self._ready.set()
        with self._lock:
            self._lock.notify_all()

    def wait_ready(self, timeout_s: float = WORKER_START_TIMEOUT_S) -> dict[str, Any]:
        if not self._ready.wait(timeout_s):
            raise WorkerChannelTimeout(
                f"远端 worker 在 {timeout_s:.0f} 秒内没有就绪；请检查远端 Python 是否可用"
            )
        if self._closed and self._error:
            raise WorkerChannelError(self._error)
        if not self.ready_payload:
            raise WorkerChannelError("远端 worker 未发送就绪消息")
        return self.ready_payload

    # -- 读取线程 -----------------------------------------------------
    def _read_loop(self) -> None:
        buffer = bytearray()
        try:
            while not self._closed:
                got = False
                try:
                    while self.channel.recv_ready():
                        chunk = self.channel.recv(65536)
                        if not chunk:
                            break
                        got = True
                        buffer.extend(chunk)
                except Exception as exc:  # noqa: BLE001 - 读循环必须兜底
                    self._fail(f"读取远端 worker 输出失败：{type(exc).__name__}: {exc}")
                    return
                if buffer:
                    while b"\n" in buffer:
                        line, _, rest = buffer.partition(b"\n")
                        buffer = bytearray(rest)
                        self._handle_line(line)
                try:
                    if self.channel.recv_stderr_ready():
                        self._stderr.extend(self.channel.recv_stderr(8192))
                except Exception:
                    pass
                try:
                    exit_ready = bool(self.channel.exit_status_ready())
                except Exception:
                    exit_ready = False
                if exit_ready and not got:
                    self._fail("远端 worker 进程已退出（SSH 通道关闭）")
                    return
                if not got:
                    time.sleep(0.01)
        except Exception as exc:  # noqa: BLE001 - 线程入口
            self._fail(f"远端 worker 读取线程异常：{type(exc).__name__}: {exc}")
        finally:
            if not self._ready.is_set():
                self._ready.set()
            with self._lock:
                self._lock.notify_all()

    def _handle_line(self, raw: bytes) -> None:
        text = bytes(raw).decode("utf-8", "replace").strip()
        if not text:
            return
        try:
            message = json.loads(text)
        except (TypeError, ValueError):
            # 远端 shell 的 banner / 噪声：忽略，不污染协议
            return
        if not isinstance(message, dict):
            return
        if message.get("type") == "ready":
            self.ready_payload = message
            self._ready.set()
            with self._lock:
                self._lock.notify_all()
            return
        request_id = message.get("id")
        if request_id is None:
            return
        with self._lock:
            self._responses[str(request_id)] = message
            self._lock.notify_all()

    # -- 请求 ---------------------------------------------------------
    def request(self, payload: dict[str, Any], *, timeout_s: float = WORKER_REQUEST_TIMEOUT_S) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                raise WorkerChannelError(self._error or "远端 worker 已关闭")
            self._next_id += 1
            request_id = str(self._next_id)
            body = dict(payload)
            body["id"] = request_id
            try:
                self.channel.sendall((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
            except Exception as exc:  # noqa: BLE001 - 通道可能已断
                self._closed = True
                raise WorkerChannelError(f"写入远端 worker 失败：{type(exc).__name__}: {exc}") from exc
            deadline = time.monotonic() + max(1.0, float(timeout_s))
            while request_id not in self._responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WorkerChannelTimeout(
                        f"等待远端 worker 响应超时（>{timeout_s:.0f} 秒），执行结果未知；"
                        "可尝试中断或重新连接后再确认远端状态"
                    )
                if self._closed and request_id not in self._responses:
                    raise WorkerChannelError(self._error or "远端 worker 连接已关闭，执行结果未知")
                self._lock.wait(min(remaining, 0.5))
            return self._responses.pop(request_id)

    def interrupt(self) -> None:
        try:
            with self._lock:
                if self._closed:
                    return
                self._next_id += 1
                body = {"id": str(self._next_id), "op": "interrupt"}
                self.channel.sendall((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception:  # noqa: BLE001 - 尽力而为
            pass

    def close(self) -> None:
        try:
            with self._lock:
                if self._closed:
                    return
                self._next_id += 1
                body = {"id": str(self._next_id), "op": "shutdown"}
                self.channel.sendall((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception:
            pass
        self._closed = True
        try:
            self.channel.close()
        except Exception:
            pass
        with self._lock:
            self._lock.notify_all()


# ---------------------------------------------------------------------------
# SSH 执行后端
# ---------------------------------------------------------------------------
class SSHExecutionBackend(ExecutionBackend):
    """把远端 SSH 工作区实现为 ExecutionBackend（禁止本地回退）。"""

    kind = "ssh"

    def __init__(
        self,
        workspace: WorkspaceContext,
        settings: Settings | None = None,
        connections: Any = None,
    ) -> None:
        super().__init__(workspace)
        self.settings = settings
        self._connections = connections
        remote = dict(getattr(workspace, "remote", None) or {})
        self.profile_id = str(remote.get("profile_id") or "").strip()
        self._remote_root = str(remote.get("root") or "~").strip() or "~"
        self._remote_cwd = str(remote.get("cwd") or "").strip()
        self._resolved_root = ""
        self._started = False
        self._python = ""
        self._worker: _WorkerClient | None = None
        self._env_cache: dict[str, Any] = {}
        self._last_error = ""
        self._history: list[dict[str, Any]] = []
        self._start_lock = asyncio.Lock()
        self._worker_lock = asyncio.Lock()

    # -- 基础辅助 -----------------------------------------------------
    @property
    def context(self) -> Any:
        return self.workspace

    @property
    def root(self) -> str:
        return self._resolved_root or self._remote_root

    @property
    def cwd(self) -> str:
        return self._remote_cwd or self._resolved_root or self._remote_root

    def _service(self) -> Any:
        if self._connections is not None:
            if isinstance(self._connections, ConnectionService):
                return self._connections
            if isinstance(self._connections, SSHManager):
                self._connections = ConnectionService(self.settings, manager=self._connections)
                return self._connections
            return self._connections
        if self.settings is None:
            raise BackendUnavailable("SSH 执行后端缺少 Settings，无法取得连接服务")
        self._connections = get_connection_service(self.settings)
        return self._connections

    def _manager(self) -> SSHManager:
        service = self._service()
        manager = getattr(service, "manager", None)
        if manager is None:
            raise BackendUnavailable("SSH 连接服务未提供 SSHManager，无法访问远端文件")
        return manager

    async def _call(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        except BackendError:
            raise
        except SSHProfileNotFound as exc:
            raise BackendUnavailable(f"SSH 档案不存在或已被删除：{exc}") from exc
        except SSHValidationError as exc:
            raise BackendError(f"SSH 档案配置无效：{exc}") from exc
        except SSHError as exc:
            raise BackendUnavailable(f"远端不可用：{exc}") from exc

    # -- 生命周期 -----------------------------------------------------
    async def start(self) -> None:
        if self._started:
            return
        async with self._start_lock:
            if self._started:
                return
            await self._call(self._ensure_environment)
            self._started = True

    def _ensure_environment(self) -> None:
        if not self.profile_id:
            raise BackendUnavailable(
                "SSH 工作区缺少 connection/profile_id，请先在“工作区”中重新选择 SSH 连接"
            )
        service = self._service()
        try:
            probe = service.probe(self.profile_id, self._remote_root)
        except SSHProfileNotFound as exc:
            raise BackendUnavailable(f"SSH 档案不存在或已被删除：{exc}") from exc
        except SSHValidationError as exc:
            raise BackendError(f"SSH 档案配置无效：{exc}") from exc
        except SSHError as exc:
            raise BackendUnavailable(f"远端不可用：{exc}") from exc
        if not isinstance(probe, dict):
            raise BackendUnavailable("SSH 工作区探测返回了无效结果")
        if not probe.get("ok", False):
            error = str(probe.get("error") or "无法连接远端")
            raise BackendUnavailable(f"远端不可用：{error}")
        if not probe.get("exists"):
            raise BackendUnavailable(f"远端工作目录不存在：{self._remote_root}")
        if not probe.get("is_dir"):
            raise BackendUnavailable(f"远端工作区路径不是目录：{self._remote_root}")
        resolved = str(probe.get("path") or "").strip()
        if not resolved:
            raise BackendUnavailable("无法解析远端工作目录的绝对路径")
        self._resolved_root = resolved

    async def close(self) -> None:
        worker = self._worker
        self._worker = None
        self._started = False
        if worker is not None:
            try:
                await asyncio.to_thread(worker.close)
            except Exception:  # noqa: BLE001 - 关闭阶段兜底
                logger.warning("关闭远端 worker 失败", exc_info=True)

    async def interrupt(self) -> None:
        worker = self._worker
        if worker is None:
            return
        try:
            await asyncio.to_thread(worker.interrupt)
        except Exception:  # noqa: BLE001 - 中断是尽力而为
            logger.warning("中断远端 Python 执行失败", exc_info=True)

    async def status(self) -> dict[str, Any]:
        return {
            "backend": self.kind,
            "workspace_id": getattr(self.workspace, "workspace_id", None),
            "profile_id": self.profile_id,
            "connection_id": self.profile_id,
            "root": self.root,
            "cwd": self.cwd,
            "started": self._started,
            "worker": bool(self._worker is not None and self._worker.alive),
            "python": self._python or None,
            "last_error": self._last_error or None,
        }

    def describe(self) -> dict[str, Any]:
        data = super().describe()
        data.update(
            {
                "kind": self.kind,
                "root": self.root,
                "cwd": self.cwd,
                "profile_id": self.profile_id,
                "connection_id": self.profile_id,
                "remote": True,
            }
        )
        return data

    # -- 路径解析 -----------------------------------------------------
    @staticmethod
    def _normalize_rel(rel: Any) -> str:
        text = str(rel if rel is not None else "").strip().replace("\\", "/")
        return text or "."

    def _resolve_path(self, rel: Any) -> str:
        if not self._resolved_root:
            raise BackendUnavailable("SSH 工作区尚未就绪，请稍后重试")
        text = self._normalize_rel(rel)
        root = posixpath.normpath(self._resolved_root)
        if text == ".":
            return root
        if text.startswith("~"):
            # 工作区根通常就是远端 home；`~/data` 视作相对工作区根的路径。
            text = text[1:].lstrip("/")
            if not text:
                return root
        if text.startswith("/"):
            candidate = posixpath.normpath(text)
        else:
            candidate = posixpath.normpath(posixpath.join(root, text))
        if candidate != root and not candidate.startswith(root.rstrip("/") + "/"):
            raise BackendError(f"路径超出 SSH 工作区范围：{rel}")
        return candidate

    def _relative_of(self, remote: str) -> str:
        root = posixpath.normpath(self._resolved_root or "/")
        remote_path = posixpath.normpath(remote)
        if remote_path == root:
            return "."
        prefix = root.rstrip("/") + "/"
        if remote_path.startswith(prefix):
            return remote_path[len(prefix) :]
        return remote_path

    # -- 环境探测 -----------------------------------------------------
    async def probe_environment(self) -> dict[str, Any]:
        await self.start()
        manager = self._manager()
        try:
            info = await self._call(manager.remote_info, self.profile_id)
        except BackendError:
            raise
        except SSHError as exc:
            raise BackendUnavailable(f"远端不可用：{exc}") from exc
        profile: dict[str, Any] = {}
        try:
            profile = await self._call(manager.get_profile, self.profile_id)
        except Exception:  # noqa: BLE001 - 诊断信息缺失不影响主流程
            profile = {}
        hostname = await self._probe_text(manager, "hostname 2>/dev/null || uname -n 2>/dev/null")
        python_path = await self._probe_text(manager, "python3 -c 'import sys;print(sys.executable)' 2>/dev/null")
        conda = await self._probe_text(manager, "command -v conda 2>/dev/null && conda info --base 2>/dev/null")
        environment = {
            "kind": self.kind,
            "backend": "ssh",
            "hostname": hostname,
            "uname": info.get("uname"),
            "python": info.get("python"),
            "python_path": python_path,
            "python_command": self._python or None,
            "cpu_count": info.get("cpu_count"),
            "mem_total_mb": info.get("mem_total_mb"),
            "gpu": info.get("gpu"),
            "disk_free_gb": info.get("disk_free_gb"),
            "conda": conda,
            "root": self._resolved_root,
            "cwd": self.cwd,
            "profile_id": self.profile_id,
            "host": profile.get("host"),
            "username": profile.get("username"),
        }
        self._env_cache = environment
        return environment

    async def _probe_text(self, manager: SSHManager, command: str) -> str | None:
        try:
            result = await asyncio.to_thread(
                manager.exec,
                self.profile_id,
                command,
                timeout_s=20,
                idempotent=True,
                record=False,
            )
        except Exception:  # noqa: BLE001 - 探测失败返回 None
            return None
        if not isinstance(result, dict) or result.get("status") != "ok":
            return None
        text = str(result.get("stdout") or "").strip()
        return text or None

    # -- Python 执行（远端 worker） -----------------------------------
    def _detect_python(self) -> str:
        if self._python:
            return self._python
        service = self._service()
        try:
            result = service.exec(
                self.profile_id,
                "command -v python3 2>/dev/null || command -v python 2>/dev/null",
                timeout_s=20,
            )
        except (SSHError, AttributeError) as exc:
            raise BackendUnavailable(f"无法检测远端 Python：{exc}") from exc
        stdout = str((result or {}).get("stdout") or "").strip()
        first = stdout.splitlines()[0] if stdout else ""
        if not first:
            raise BackendUnavailable(
                "远端未找到 Python（python3/python）。请在远端安装 Python 3.9+："
                "例如 `sudo apt install python3` 或使用 conda 环境，然后重试。"
            )
        self._python = "python3" if "python3" in first else "python"
        return self._python

    def _open_worker_channel(self) -> _WorkerClient:
        manager = self._manager()
        worker_remote = posixpath.join(self._resolved_root, WORKER_DIR, WORKER_FILENAME)
        payload = (Path(__file__).with_name(WORKER_FILENAME)).read_bytes()
        manager.mkdir(self.profile_id, posixpath.dirname(worker_remote), parents=True)
        manager.write_bytes(self.profile_id, worker_remote, payload, mkdir=True)
        python = self._detect_python()
        profile = manager._get_profile_raw(self.profile_id)  # noqa: SLF001 - 同包复用连接池
        client = manager._get_client(profile)  # noqa: SLF001
        transport = client.get_transport() if client is not None else None
        if transport is None or not getattr(transport, "is_active", lambda: False)():
            raise BackendUnavailable("SSH 连接已断开，无法启动远端 Python worker")
        try:
            channel = transport.open_session()
        except Exception as exc:  # noqa: BLE001 - 连接类错误
            raise BackendUnavailable(f"打开远端 worker 通道失败：{type(exc).__name__}: {exc}") from exc
        command = (
            f"cd {shlex.quote(self._resolved_root)} && "
            f"{python} -u {shlex.quote(worker_remote)}"
        )
        try:
            channel.exec_command(command)
        except Exception as exc:  # noqa: BLE001
            try:
                channel.close()
            except Exception:
                pass
            raise BackendUnavailable(f"启动远端 Python worker 失败：{type(exc).__name__}: {exc}") from exc
        worker = _WorkerClient(channel, label=self.profile_id)
        try:
            worker.wait_ready(WORKER_START_TIMEOUT_S)
        except WorkerChannelError as exc:
            stderr = ""
            try:
                if channel.recv_stderr_ready():
                    stderr = channel.recv_stderr(8192).decode("utf-8", "replace")
            except Exception:
                pass
            try:
                worker.close()
            except Exception:
                pass
            detail = f"；远端错误输出：{stderr.strip()}" if stderr.strip() else ""
            raise BackendUnavailable(
                f"远端 Python worker 启动失败：{exc}{detail}。"
                "请确认远端已安装 Python 3.9+（python3 --version），且工作目录可写。"
            ) from exc
        return worker

    async def _worker_client(self) -> _WorkerClient:
        await self.start()
        async with self._worker_lock:
            if self._worker is not None and self._worker.alive:
                return self._worker
            try:
                self._worker = await asyncio.to_thread(self._open_worker_channel)
            except BackendError:
                raise
            except WorkerChannelError as exc:
                raise BackendUnavailable(f"远端 Python worker 不可用：{exc}") from exc
            return self._worker

    def _drop_worker(self) -> None:
        worker = self._worker
        self._worker = None
        if worker is not None:
            try:
                worker.close()
            except Exception:  # noqa: BLE001 - 清理阶段
                pass

    @staticmethod
    def _coerce_timeout(timeout_s: Any) -> float | None:
        if timeout_s is None or timeout_s == "":
            return None
        try:
            value = float(timeout_s)
        except (TypeError, ValueError):
            raise BackendError("timeout_s 必须是数字") from None
        if value <= 0:
            raise BackendError("timeout_s 必须大于 0")
        return min(value, float(MAX_TIMEOUT_S))

    async def execute_python(self, code: str, timeout_s: float | None = None) -> dict[str, Any]:
        if not isinstance(code, str) or not code.strip():
            raise BackendError("远端执行代码不能为空")
        timeout = self._coerce_timeout(timeout_s)
        worker = await self._worker_client()
        request_timeout = (timeout or 300.0) + 60.0
        try:
            response = await asyncio.to_thread(
                worker.request,
                {"op": "execute_python", "code": code, "timeout_s": timeout},
                timeout_s=request_timeout,
            )
        except WorkerChannelTimeout as exc:
            self._last_error = str(exc)
            self._drop_worker()
            raise BackendUnavailable(str(exc)) from exc
        except WorkerChannelError as exc:
            self._last_error = str(exc)
            self._drop_worker()
            raise BackendUnavailable(f"远端 Python worker 不可用：{exc}") from exc
        if not response.get("ok", False):
            error = str(response.get("error") or "未知错误")
            raise BackendError(f"远端执行失败：{error}")
        self._history.append({"type": "code", "source": code})
        status = str(response.get("status") or "ok")
        return {
            "ok": status == "ok",
            "status": status,
            "exit_code": 0 if status == "ok" else (None if status == "timeout" else 1),
            "stdout": str(response.get("stdout") or ""),
            "stderr": str(response.get("stderr") or ""),
            "result_repr": response.get("result_repr"),
            "images": list(response.get("images") or []),
            "duration_ms": int(response.get("duration_ms") or 0),
            "error": str(response.get("error") or ""),
            "interrupted": bool(response.get("interrupted")),
            "backend": self.kind,
            "execution_target": {
                "kind": "ssh",
                "root": self._resolved_root,
                "cwd": self.cwd,
                "connection_id": self.profile_id,
            },
        }

    async def list_vars(self) -> list[dict[str, Any]]:
        worker = await self._worker_client()
        try:
            response = await asyncio.to_thread(
                worker.request, {"op": "list_vars"}, timeout_s=120.0
            )
        except WorkerChannelError as exc:
            self._drop_worker()
            raise BackendUnavailable(f"无法读取远端变量：{exc}") from exc
        if not response.get("ok", False):
            raise BackendError(f"读取远端变量失败：{response.get('error')}")
        return list(response.get("variables") or [])

    async def list_variables(self) -> list[dict[str, Any]]:
        return await self.list_vars()

    async def var_detail(self, name: str) -> dict[str, Any]:
        variable = str(name or "").strip()
        if not variable:
            raise BackendError("变量名不能为空")
        worker = await self._worker_client()
        try:
            response = await asyncio.to_thread(
                worker.request,
                {"op": "var_detail", "name": variable},
                timeout_s=120.0,
            )
        except WorkerChannelError as exc:
            self._drop_worker()
            raise BackendUnavailable(f"无法读取远端变量详情：{exc}") from exc
        if not response.get("ok", False):
            raise BackendError(f"读取远端变量详情失败：{response.get('error')}")
        return dict(response.get("variable") or {})

    # -- Shell --------------------------------------------------------
    async def shell(
        self,
        command: str,
        *,
        cwd: str = "",
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        command_text = str(command or "")
        if not command_text.strip():
            raise BackendError("远端命令不能为空")
        await self.start()
        manager = self._manager()
        target = self._resolve_path(cwd) if cwd else self._resolved_root
        timeout = DEFAULT_TIMEOUT_S if timeout_s is None else self._coerce_timeout(timeout_s) or DEFAULT_TIMEOUT_S
        try:
            result = await self._call(
                manager.exec,
                self.profile_id,
                command_text,
                timeout_s=timeout,
                cwd=target,
            )
        except BackendError:
            raise
        status = str(result.get("status") or "error")
        return {
            "ok": bool(result.get("ok") and status == "ok"),
            "status": status,
            "exit_code": result.get("exit_code"),
            "stdout": str(result.get("stdout") or ""),
            "stderr": str(result.get("stderr") or ""),
            "timed_out": status == "timeout",
            "duration_ms": int(result.get("duration_ms") or 0),
            "retried": bool(result.get("retried")),
            "command_id": result.get("command_id"),
            "reconciliation": result.get("reconciliation"),
            "backend": self.kind,
            "execution_target": {
                "kind": "ssh",
                "root": self._resolved_root,
                "cwd": target,
                "connection_id": self.profile_id,
            },
        }

    # -- 文件 ---------------------------------------------------------
    async def stat(self, rel: str) -> dict[str, Any]:
        await self.start()
        target = self._resolve_path(rel)
        result = await self._call(self._manager().stat, self.profile_id, target)
        if isinstance(result, dict):
            result = dict(result)
            result.setdefault("path", target)
            result["rel"] = self._relative_of(target)
        return result

    async def list_dir(self, rel: str = ".", *, show_hidden: bool = False) -> dict[str, Any]:
        await self.start()
        manager = self._manager()
        target = self._resolve_path(rel)
        try:
            listing = await self._call(manager.list_dir, self.profile_id, target)
        except BackendError:
            raise
        relative = self._normalize_rel(rel)
        entries: list[dict[str, Any]] = []
        for entry in (listing or {}).get("entries", []):
            name = str(entry.get("name") or "")
            if not name or (not show_hidden and name.startswith(".")):
                continue
            child_rel = posixpath.normpath(posixpath.join(relative, name)) if relative != "." else name
            entries.append(
                {
                    "name": name,
                    "path": child_rel.replace("\\", "/"),
                    "is_dir": bool(entry.get("is_dir")),
                    "size": int(entry.get("size") or 0),
                    "mtime": int(entry.get("mtime") or 0),
                    "ext": PurePosixPath(name).suffix.lower(),
                    "attributes": entry.get("attributes") or {},
                }
            )
        entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))
        return {
            "path": relative,
            "entries": entries,
            "backend": self.kind,
            "root": self._resolved_root,
        }

    async def read_text(self, rel: str, max_bytes: int = 200_000) -> dict[str, Any]:
        await self.start()
        manager = self._manager()
        target = self._resolve_path(rel)
        limit = max(1, min(int(max_bytes or 0), MAX_READ_TEXT_BYTES))
        info = await self._call(manager.stat, self.profile_id, target)
        if not info.get("exists"):
            raise BackendError(f"远端文件不存在：{rel}")
        if info.get("is_dir"):
            raise BackendError(f"目标是目录，无法按文本读取：{rel}")
        if int(info.get("size") or 0) > limit:
            raise BackendError(f"远端文件超过 {limit} 字节读取上限：{rel}")
        data = await self._call(manager.read_bytes, self.profile_id, target, limit)
        text = bytes(data).decode("utf-8", "replace")
        return {
            "path": self._normalize_rel(rel),
            "content": text,
            "size": len(data),
            "truncated": False,
            "encoding": "utf-8",
            "backend": self.kind,
        }

    async def write_text(self, rel: str, content: str) -> dict[str, Any]:
        await self.start()
        target = self._resolve_path(rel)
        data = str(content if content is not None else "").encode("utf-8")
        await self._call(self._manager().write_bytes, self.profile_id, target, data)
        return {"ok": True, "path": self._normalize_rel(rel), "bytes": len(data), "backend": self.kind}

    async def make_dir(self, rel: str) -> dict[str, Any]:
        await self.start()
        target = self._resolve_path(rel)
        await self._call(self._manager().mkdir, self.profile_id, target, parents=True)
        return {"ok": True, "path": self._normalize_rel(rel), "backend": self.kind}

    async def delete_path(self, rel: str) -> dict[str, Any]:
        await self.start()
        manager = self._manager()
        target = self._resolve_path(rel)
        if target == self._resolved_root:
            raise BackendError("不能删除工作区根目录")
        info = await self._call(manager.stat, self.profile_id, target)
        result = await self._call(
            manager.delete,
            self.profile_id,
            target,
            recursive=bool(info.get("is_dir")),
        )
        return {"ok": True, "path": self._normalize_rel(rel), "deleted": result.get("deleted", 0), "backend": self.kind}

    async def save_upload(self, rel_dir: str, filename: str, data: bytes) -> dict[str, Any]:
        await self.start()
        safe = PurePosixPath(str(filename or "").replace("\\", "/")).name.strip()
        if not safe or safe in (".", ".."):
            raise BackendError("上传文件名无效")
        parent = self._resolve_path(rel_dir)
        target = self._resolve_path(posixpath.join(self._normalize_rel(rel_dir), safe))
        payload = bytes(data or b"")
        await self._call(self._manager().mkdir, self.profile_id, parent, parents=True)
        await self._call(self._manager().write_bytes, self.profile_id, target, payload)
        return {
            "ok": True,
            "path": self._relative_of(target),
            "bytes": len(payload),
            "backend": self.kind,
        }

    async def read_bytes(self, rel: str) -> tuple[bytes, str, str]:
        await self.start()
        target = self._resolve_path(rel)
        data = await self._call(self._manager().read_bytes, self.profile_id, target)
        name = PurePosixPath(target).name or "download"
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return bytes(data), name, mime

    async def download(self, rel: str) -> tuple[bytes, str, str]:
        return await self.read_bytes(rel)

    async def upload_dir(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        raise BackendUnsupported("SSH 后端暂不支持整目录上传，请逐个文件上传")

    # -- 长任务 -------------------------------------------------------
    async def spawn_process(
        self,
        command: str,
        *,
        cwd: str = "",
        name: str = "",
        log_path: str = "",
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        await self.start()
        manager = self._manager()
        command_text = str(command or "")
        if not command_text.strip():
            raise BackendError("远端命令不能为空")
        job_id = f"job_{uuid.uuid4().hex[:10]}"
        target_cwd = self._resolve_path(cwd) if cwd else self._resolved_root
        jobs_dir = posixpath.join(self._resolved_root, JOBS_DIR)
        log_remote = (
            self._resolve_path(log_path)
            if log_path
            else posixpath.join(jobs_dir, f"{job_id}.log")
        )
        await self._call(manager.mkdir, self.profile_id, jobs_dir, parents=True)
        exports = ""
        if env:
            parts = []
            for key, value in env.items():
                key_text = str(key).strip()
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_text):
                    continue
                parts.append(f"export {key_text}={shlex.quote(str(value))}")
            if parts:
                exports = "; ".join(parts) + "; "
        inner = f"cd {shlex.quote(target_cwd)} && {exports}bash -lc {shlex.quote(command_text)}"
        wrapper = (
            "if command -v setsid >/dev/null 2>&1; then "
            f"nohup setsid bash -lc {shlex.quote(inner)} > {shlex.quote(log_remote)} 2>&1 < /dev/null & "
            "else "
            f"nohup bash -lc {shlex.quote(inner)} > {shlex.quote(log_remote)} 2>&1 < /dev/null & "
            "fi; "
            f"echo \"{_REMOTE_MARKER}$!\""
        )
        result = await self._call(
            manager.exec,
            self.profile_id,
            wrapper,
            timeout_s=30,
            cwd=self._resolved_root,
        )
        stdout = str(result.get("stdout") or "")
        stderr = str(result.get("stderr") or "")
        match = re.search(re.escape(_REMOTE_MARKER) + r"(\d+)", stdout)
        if not match:
            raise BackendError(f"启动远端进程失败：{stderr.strip() or stdout.strip() or '未返回 PID'}")
        pid = int(match.group(1))
        pgid = pid
        pgid_text = await self._probe_text(manager, f"ps -o pgid= -p {pid} 2>/dev/null")
        if pgid_text:
            try:
                pgid = int(pgid_text.split()[0])
            except (ValueError, IndexError):
                pgid = pid
        record = {
            "job_id": job_id,
            "name": str(name or "").strip() or job_id,
            "command": command_text,
            "cwd": target_cwd,
            "log_path": log_remote,
            "pid": pid,
            "pgid": pgid,
            "status": "running",
            "profile_id": self.profile_id,
            "root": self._resolved_root,
            "started_at": _now(),
            "updated_at": _now(),
        }
        await self._save_job(record)
        return dict(record, ok=True)

    def _job_remote_path(self, job_id: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "", str(job_id or ""))
        if not safe:
            raise BackendError("job_id 无效")
        return posixpath.join(self._resolved_root, JOBS_DIR, f"{safe}.json")

    async def _save_job(self, record: dict[str, Any]) -> None:
        manager = self._manager()
        payload = json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")
        await self._call(manager.write_bytes, self.profile_id, self._job_remote_path(record["job_id"]), payload)

    async def _load_job(self, job_id: str) -> dict[str, Any]:
        manager = self._manager()
        target = self._job_remote_path(job_id)
        try:
            data = await self._call(manager.read_bytes, self.profile_id, target)
        except BackendError as exc:
            raise BackendError(f"远端作业不存在或无法读取：{job_id}") from exc
        try:
            record = json.loads(bytes(data).decode("utf-8", "replace"))
        except (TypeError, ValueError) as exc:
            raise BackendError(f"远端作业记录损坏：{job_id}") from exc
        if not isinstance(record, dict):
            raise BackendError(f"远端作业记录无效：{job_id}")
        return record

    async def process_log(self, job_id: str, *, max_bytes: int = MAX_LOG_BYTES) -> dict[str, Any]:
        await self.start()
        record = await self._load_job(job_id)
        log_path = str(record.get("log_path") or "")
        if not log_path:
            raise BackendError(f"远端作业没有日志文件：{job_id}")
        manager = self._manager()
        limit = max(1, int(max_bytes or MAX_LOG_BYTES))
        info = await self._call(manager.stat, self.profile_id, log_path)
        size = int((info or {}).get("size") or 0)
        truncated = size > limit
        if truncated:
            tail_command = f"tail -c {limit} -- {shlex.quote(log_path)} 2>/dev/null"
            result = await self._call(
                manager.exec,
                self.profile_id,
                tail_command,
                timeout_s=30,
                idempotent=True,
                record=False,
            )
            content = str(result.get("stdout") or "")
        else:
            data = await self._call(manager.read_bytes, self.profile_id, log_path, limit + 1)
            content = bytes(data).decode("utf-8", "replace")
        return {
            "job_id": str(job_id),
            "log": content,
            "size": size,
            "truncated": truncated,
            "status": record.get("status"),
            "backend": self.kind,
        }

    async def process_cancel(self, job_id: str) -> dict[str, Any]:
        await self.start()
        record = await self._load_job(job_id)
        manager = self._manager()
        try:
            pgid = int(record.get("pgid") or record.get("pid") or 0)
        except (TypeError, ValueError):
            pgid = 0
        if pgid <= 0:
            raise BackendError(f"远端作业缺少有效 PID/PGID：{job_id}")
        script = (
            f"kill -TERM -{pgid} 2>/dev/null; sleep 0.5; "
            f"if kill -0 -{pgid} 2>/dev/null; then sleep 2; kill -KILL -{pgid} 2>/dev/null; sleep 0.3; fi; "
            f"if kill -0 -{pgid} 2>/dev/null; then echo ALIVE; else echo STOPPED; fi"
        )
        result = await self._call(
            manager.exec,
            self.profile_id,
            script,
            timeout_s=30,
            record=False,
        )
        stdout = str(result.get("stdout") or "")
        alive = "ALIVE" in stdout
        status = "unknown" if alive else "cancelled"
        record["status"] = status
        record["updated_at"] = _now()
        record["cancel_output"] = _truncate(stdout, 2000)
        try:
            await self._save_job(record)
        except BackendError:
            logger.warning("更新远端作业状态失败：%s", job_id, exc_info=True)
        return {
            "ok": not alive,
            "job_id": str(job_id),
            "pid": record.get("pid"),
            "pgid": pgid,
            "status": status,
            "diagnostics": stdout.strip(),
            "backend": self.kind,
        }

    async def process_list(self) -> list[dict[str, Any]]:
        await self.start()
        manager = self._manager()
        jobs_dir = posixpath.join(self._resolved_root, JOBS_DIR)
        try:
            listing = await self._call(manager.list_dir, self.profile_id, jobs_dir)
        except BackendError:
            return []
        records: list[dict[str, Any]] = []
        for entry in (listing or {}).get("entries", []):
            name = str(entry.get("name") or "")
            if not name.endswith(".json"):
                continue
            try:
                record = await self._load_job(name[: -len(".json")])
            except BackendError:
                continue
            records.append(record)
        records.sort(key=lambda item: str(item.get("started_at") or ""), reverse=True)
        return records

    # -- Notebook -----------------------------------------------------
    async def build_notebook(
        self,
        cells: list[dict[str, Any]] | None = None,
        *,
        title: str = "素问 Suwen 分析",
        path: str = "",
    ) -> dict[str, Any]:
        notebook_cells: list[dict[str, Any]] = []
        for cell in (cells if cells is not None else self._history):
            if not isinstance(cell, dict):
                continue
            source = str(cell.get("source") or cell.get("code") or "")
            if cell.get("type") == "markdown":
                notebook_cells.append(
                    {
                        "cell_type": "markdown",
                        "id": uuid.uuid4().hex[:12],
                        "metadata": {},
                        "source": source.splitlines(True),
                    }
                )
            else:
                notebook_cells.append(
                    {
                        "cell_type": "code",
                        "execution_count": None,
                        "id": uuid.uuid4().hex[:12],
                        "metadata": {},
                        "outputs": [],
                        "source": source.splitlines(True),
                    }
                )
        notebook = {
            "cells": notebook_cells,
            "metadata": {
                "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                "language_info": {
                    "name": "python",
                    "version": str(self._env_cache.get("python") or "3"),
                },
                "omicslab": {"title": title, "backend": self.kind, "profile_id": self.profile_id},
            },
            "nbformat": 4,
            "nbformat_minor": 5,
        }
        result: dict[str, Any] = {"ok": True, "notebook": notebook, "backend": self.kind}
        if path:
            payload = json.dumps(notebook, ensure_ascii=False, indent=1)
            await self.write_text(path, payload)
            result["path"] = self._normalize_rel(path)
        return result


def _now() -> str:
    from ..utils import iso_now

    return iso_now()


# 兼容 execution/__init__.py 的动态类名探测与外部导入
SSHBackend = SSHExecutionBackend
RemoteExecutionBackend = SSHExecutionBackend


__all__ = [
    "JOBS_DIR",
    "SSHBackend",
    "SSHExecutionBackend",
    "RemoteExecutionBackend",
    "WORKER_DIR",
    "WORKER_FILENAME",
]
