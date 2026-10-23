"""SSH 执行后端（SSHExecutionBackend）与远端 Python worker 协议测试。

本文件不依赖真实 SSH 服务器：
- worker 协议用本机 Python 子进程运行 ``omicslab/ssh/worker.py`` 验证；
- ``SSHExecutionBackend`` 用 Fake ConnectionService/SSHManager 验证文件、shell、
  变量、进程与错误映射；真实 SSH 端到端行为标注为“未验证”。
"""

from __future__ import annotations

import json
import posixpath
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from omicslab.execution.base import BackendError, BackendUnavailable, BackendUnsupported
from omicslab.execution.ssh_backend import JOBS_DIR, SSHExecutionBackend
from omicslab.workspace import Workspace

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "omicslab" / "ssh" / "worker.py"
PYTHON = sys.executable
REMOTE_ROOT = "/home/alice/project"
MARKER = "__OMICSLAB_PID__"


# ---------------------------------------------------------------------------
# 本机子进程 worker 客户端
# ---------------------------------------------------------------------------
class LocalWorker:
    def __init__(self, timeout: float = 30.0) -> None:
        self.timeout = timeout
        self._counter = 0
        self._lines: "queue.Queue[Any]" = queue.Queue()
        self.proc = subprocess.Popen(
            [PYTHON, "-u", str(WORKER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=str(ROOT),
        )
        assert self.proc.stdout is not None and self.proc.stdin is not None
        self._reader = threading.Thread(target=self._pump, name="worker-test-reader", daemon=True)
        self._reader.start()
        self.ready = self.recv()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            text = line.strip()
            if not text:
                continue
            try:
                self._lines.put(json.loads(text))
            except ValueError:
                self._lines.put({"raw": text})
        self._lines.put(None)

    def send(self, op: str, **fields: Any) -> dict[str, Any]:
        self._counter += 1
        payload = {"id": f"req-{self._counter}", "op": op, **fields}
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        response = self.recv()
        assert response.get("id") == payload["id"], response
        return response

    def recv(self) -> dict[str, Any]:
        try:
            item = self._lines.get(timeout=self.timeout)
        except queue.Empty:  # pragma: no cover - 仅失败时触发
            raise AssertionError("worker 未在期限内响应") from None
        assert item is not None, "worker 进程提前退出"
        return item

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                try:
                    self.send("shutdown")
                except Exception:
                    pass
        finally:
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
                self.proc.wait(timeout=10)


@pytest.fixture()
def worker() -> "LocalWorker":
    client = LocalWorker()
    try:
        yield client
    finally:
        client.close()


def test_worker_ready_line(worker: LocalWorker) -> None:
    assert worker.ready["type"] == "ready"
    assert worker.ready["pid"] > 0
    assert worker.ready["worker_version"]
    assert worker.ready["python"].startswith("3.")


def test_worker_execute_captures_stdout_and_result(worker: LocalWorker) -> None:
    response = worker.send("execute_python", code="print('hello worker')\n_omicslab_result = 40 + 2", timeout_s=10)
    assert response["ok"] is True
    assert response["status"] == "ok"
    assert "hello worker" in response["stdout"]
    assert response["result_repr"] == "42"


def test_worker_namespace_persists_between_requests(worker: LocalWorker) -> None:
    worker.send("execute_python", code="counter = 41", timeout_s=10)
    response = worker.send("execute_python", code="counter += 1\nprint(counter)", timeout_s=10)
    assert response["status"] == "ok"
    assert "42" in response["stdout"]


def test_worker_error_reports_traceback(worker: LocalWorker) -> None:
    response = worker.send("execute_python", code="1 / 0", timeout_s=10)
    assert response["ok"] is True
    assert response["status"] == "error"
    assert "ZeroDivisionError" in response["error"]


def test_worker_timeout_returns_timeout_status(worker: LocalWorker) -> None:
    started = time.monotonic()
    response = worker.send("execute_python", code="import time\ntime.sleep(1.5)", timeout_s=0.2)
    assert response["status"] == "timeout"
    assert "执行超时" in response["error"]
    assert time.monotonic() - started < 5


def test_worker_list_vars_and_var_detail(worker: LocalWorker) -> None:
    worker.send("execute_python", code="df = 7\nname = 'omicslab'", timeout_s=10)
    listed = worker.send("list_vars")
    assert listed["ok"] is True
    names = {item["name"] for item in listed["variables"]}
    assert {"df", "name"} <= names
    detail = worker.send("var_detail", name="df")
    assert detail["ok"] is True
    assert detail["variable"]["name"] == "df"
    assert "7" in detail["variable"]["repr"]
    missing = worker.send("var_detail", name="not_here")
    assert missing["ok"] is False


def test_worker_interrupt_unknown_op_and_shutdown(worker: LocalWorker) -> None:
    interrupted = worker.send("interrupt")
    assert interrupted["ok"] is True
    assert interrupted["interrupted"] is True
    unknown = worker.send("not_an_operation")
    assert unknown["ok"] is False
    assert "未知操作" in unknown["error"]
    shutdown = worker.send("shutdown")
    assert shutdown["ok"] is True
    assert worker.proc.wait(timeout=10) == 0


# ---------------------------------------------------------------------------
# Fake SSH 连接服务
# ---------------------------------------------------------------------------
class FakeManager:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.dirs: set[str] = {REMOTE_ROOT, posixpath.join(REMOTE_ROOT, JOBS_DIR)}
        self.exec_calls: list[tuple[str, dict[str, Any]]] = []
        self.entries: dict[str, list[dict[str, Any]]] = {
            REMOTE_ROOT: [
                {"name": "notes.txt", "is_dir": False, "size": 5, "mtime": 100, "attributes": {"mode": 0o100644}},
                {"name": "data", "is_dir": True, "size": 0, "mtime": 50, "attributes": {"mode": 0o040755}},
                {"name": ".hidden", "is_dir": False, "size": 1, "mtime": 1, "attributes": {}},
            ]
        }

    def remote_info(self, profile_id: str) -> dict[str, Any]:
        return {
            "uname": "Linux node01 5.15.0",
            "python": "Python 3.11.9",
            "cpu_count": 8,
            "mem_total_mb": 32768,
            "gpu": "NVIDIA A100",
            "disk_free_gb": 120.5,
        }

    def get_profile(self, profile_id: str) -> dict[str, Any]:
        return {"id": profile_id, "host": "10.0.0.5", "username": "alice"}

    def exec(self, profile_id: str, command: str, **kwargs: Any) -> dict[str, Any]:
        self.exec_calls.append((command, dict(kwargs)))
        if "ps -o pgid" in command:
            stdout = "12345\n"
        elif "nohup" in command:
            stdout = f"{MARKER}12345\n"
        elif "kill -TERM" in command:
            stdout = "STOPPED\n"
        elif "hostname" in command:
            stdout = "node01\n"
        elif "sys.executable" in command:
            stdout = "/usr/bin/python3\n"
        elif "conda" in command:
            stdout = ""
        elif command.startswith("tail -c"):
            stdout = "tail-content\n"
        else:
            stdout = "pwd: /home/alice/project\n"
        return {
            "ok": True,
            "status": "ok",
            "exit_code": 0,
            "stdout": stdout,
            "stderr": "",
            "duration_ms": 3,
            "retried": False,
            "command_id": "cmd_fake",
        }

    def stat(self, profile_id: str, remote_path: str) -> dict[str, Any]:
        if remote_path in self.dirs:
            return {"path": remote_path, "exists": True, "is_dir": True, "size": 0}
        if remote_path in self.files:
            return {
                "path": remote_path,
                "exists": True,
                "is_dir": False,
                "size": len(self.files[remote_path]),
            }
        return {"path": remote_path, "exists": False, "is_dir": False, "size": 0}

    def list_dir(self, profile_id: str, remote_path: str) -> dict[str, Any]:
        jobs_dir = posixpath.join(REMOTE_ROOT, JOBS_DIR)
        if posixpath.normpath(remote_path) == jobs_dir:
            entries = [
                {
                    "name": posixpath.basename(path),
                    "is_dir": False,
                    "size": len(data),
                    "mtime": 1,
                    "attributes": {},
                }
                for path, data in self.files.items()
                if posixpath.dirname(path) == jobs_dir and path.endswith(".json")
            ]
            return {"path": jobs_dir, "entries": entries}
        return {"path": remote_path, "entries": list(self.entries.get(remote_path, []))}

    def read_bytes(self, profile_id: str, remote_path: str, max_bytes: int | None = None) -> bytes:
        data = self.files.get(remote_path, b"")
        if max_bytes is not None and len(data) > max_bytes:
            raise BackendError(f"远端文件超过大小限制（>{max_bytes} 字节）")
        return data

    def write_bytes(
        self,
        profile_id: str,
        remote_path: str,
        data: bytes,
        *,
        mkdir: bool = True,
    ) -> dict[str, Any]:
        self.files[remote_path] = bytes(data)
        self.dirs.add(posixpath.dirname(remote_path))
        return {"ok": True, "path": remote_path, "bytes": len(data)}

    def mkdir(self, profile_id: str, remote_path: str, parents: bool = True) -> dict[str, Any]:
        self.dirs.add(remote_path)
        return {"ok": True, "path": remote_path}

    def delete(self, profile_id: str, remote_path: str, recursive: bool = False) -> dict[str, Any]:
        removed = 0
        for path in list(self.files):
            if path == remote_path or path.startswith(remote_path.rstrip("/") + "/"):
                self.files.pop(path, None)
                removed += 1
        self.dirs.discard(remote_path)
        return {"ok": True, "path": remote_path, "deleted": removed + 1}


class FakeConnections:
    def __init__(self) -> None:
        self.manager = FakeManager()
        self.probe_result: dict[str, Any] = {
            "ok": True,
            "exists": True,
            "is_dir": True,
            "path": REMOTE_ROOT,
        }
        self.probe_calls: list[tuple[str, str]] = []

    def probe(self, profile_id: str, path: str = "") -> dict[str, Any]:
        self.probe_calls.append((profile_id, path))
        return dict(self.probe_result)

    def exec(self, profile_id: str, command: str, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "status": "ok", "exit_code": 0, "stdout": "/usr/bin/python3\n"}


class FakeWorker:
    def __init__(self) -> None:
        self.alive = True
        self.requests: list[dict[str, Any]] = []
        self.interrupted = False
        self.closed = False
        self.responses: dict[str, dict[str, Any]] = {}

    def request(self, payload: dict[str, Any], *, timeout_s: float = 0) -> dict[str, Any]:
        self.requests.append(dict(payload))
        default = {
            "ok": True,
            "status": "ok",
            "stdout": "42\n",
            "stderr": "",
            "duration_ms": 5,
            "images": [],
            "error": "",
            "interrupted": False,
            "result_repr": "42",
        }
        return dict(self.responses.get(str(payload.get("op")), default), id=payload.get("id"))

    def interrupt(self) -> None:
        self.interrupted = True

    def close(self) -> None:
        self.closed = True
        self.alive = False


@pytest.fixture()
def workspace() -> Workspace:
    return Workspace(
        workspace_id="ws_remote",
        name="远端工作区",
        backend="ssh",
        remote={"profile_id": "prof_test", "root": REMOTE_ROOT},
    )


@pytest.fixture()
def backend(workspace: Workspace) -> tuple[SSHExecutionBackend, FakeConnections]:
    connections = FakeConnections()
    return SSHExecutionBackend(workspace, connections=connections), connections


def _ready_backend(
    backend: SSHExecutionBackend,
    connections: FakeConnections,
) -> tuple[SSHExecutionBackend, FakeWorker]:
    backend._started = True
    backend._resolved_root = REMOTE_ROOT
    worker = FakeWorker()
    backend._worker = worker
    return backend, worker


# ---------------------------------------------------------------------------
# 生命周期与探测
# ---------------------------------------------------------------------------
async def test_start_requires_profile_id() -> None:
    workspace = Workspace(workspace_id="ws_empty", name="空", backend="ssh", remote={})
    backend = SSHExecutionBackend(workspace, connections=FakeConnections())
    with pytest.raises(BackendUnavailable, match="profile_id"):
        await backend.start()


async def test_start_maps_probe_failure_to_remote_unavailable(
    backend: tuple[SSHExecutionBackend, FakeConnections],
) -> None:
    instance, connections = backend
    connections.probe_result = {"ok": False, "error": "连接被拒绝"}
    with pytest.raises(BackendUnavailable, match="远端不可用：连接被拒绝"):
        await instance.start()


async def test_start_requires_existing_directory(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    connections.probe_result = {"ok": True, "exists": False, "is_dir": False, "path": REMOTE_ROOT}
    with pytest.raises(BackendUnavailable, match="远端工作目录不存在"):
        await instance.start()


async def test_start_and_status(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    await instance.start()
    assert connections.probe_calls == [("prof_test", REMOTE_ROOT)]
    assert instance.root == REMOTE_ROOT
    status = await instance.status()
    assert status["backend"] == "ssh"
    assert status["root"] == REMOTE_ROOT
    assert status["started"] is True
    described = instance.describe()
    assert described["kind"] == "ssh"
    assert described["remote"] is True
    assert described["profile_id"] == "prof_test"


async def test_probe_environment_collects_remote_facts(
    backend: tuple[SSHExecutionBackend, FakeConnections],
) -> None:
    instance, connections = backend
    environment = await instance.probe_environment()
    assert environment["backend"] == "ssh"
    assert environment["hostname"] == "node01"
    assert environment["uname"] == "Linux node01 5.15.0"
    assert environment["python"] == "Python 3.11.9"
    assert environment["python_path"] == "/usr/bin/python3"
    assert environment["cpu_count"] == 8
    assert environment["mem_total_mb"] == 32768
    assert environment["gpu"] == "NVIDIA A100"
    assert environment["disk_free_gb"] == 120.5
    assert environment["conda"] is None
    assert environment["root"] == REMOTE_ROOT
    assert environment["host"] == "10.0.0.5"
    assert environment["username"] == "alice"


# ---------------------------------------------------------------------------
# 远端 Python worker 调用
# ---------------------------------------------------------------------------
async def test_execute_python_uses_worker(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    instance, worker = _ready_backend(instance, connections)
    result = await instance.execute_python("print(42)")
    assert result["ok"] is True
    assert result["status"] == "ok"
    assert result["stdout"] == "42\n"
    assert worker.requests[0]["op"] == "execute_python"
    assert worker.requests[0]["code"] == "print(42)"
    assert result["execution_target"]["kind"] == "ssh"
    assert result["execution_target"]["connection_id"] == "prof_test"


async def test_execute_python_timeout_maps_to_none_exit_code(
    backend: tuple[SSHExecutionBackend, FakeConnections],
) -> None:
    instance, connections = backend
    instance, worker = _ready_backend(instance, connections)
    worker.responses["execute_python"] = {
        "ok": True,
        "status": "timeout",
        "stdout": "",
        "stderr": "",
        "error": "执行超时",
        "duration_ms": 200,
        "images": [],
        "interrupted": False,
    }
    result = await instance.execute_python("pass", timeout_s=0.2)
    assert result["ok"] is False
    assert result["status"] == "timeout"
    assert result["exit_code"] is None


async def test_list_vars_and_var_detail(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    instance, worker = _ready_backend(instance, connections)
    worker.responses["list_vars"] = {"ok": True, "variables": [{"name": "df", "type": "int"}]}
    worker.responses["var_detail"] = {"ok": True, "variable": {"name": "df", "type": "int", "repr": "7"}}
    variables = await instance.list_vars()
    assert variables == [{"name": "df", "type": "int"}]
    assert await instance.list_variables() == variables
    detail = await instance.var_detail("df")
    assert detail["repr"] == "7"
    with pytest.raises(BackendError, match="变量名不能为空"):
        await instance.var_detail("  ")


async def test_interrupt_and_close_worker(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    instance, worker = _ready_backend(instance, connections)
    await instance.interrupt()
    assert worker.interrupted is True
    await instance.close()
    assert worker.closed is True
    assert instance._started is False


async def test_execute_python_requires_worker_channel(
    backend: tuple[SSHExecutionBackend, FakeConnections],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instance, connections = backend
    instance._started = True
    instance._resolved_root = REMOTE_ROOT

    def _fail() -> None:
        raise BackendUnavailable("远端 Python worker 启动失败：未找到 Python")

    monkeypatch.setattr(instance, "_open_worker_channel", _fail)
    with pytest.raises(BackendUnavailable, match="未找到 Python"):
        await instance.execute_python("print(1)")


# ---------------------------------------------------------------------------
# Shell 与文件
# ---------------------------------------------------------------------------
async def test_shell_uses_relative_cwd(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    await instance.start()
    result = await instance.shell("pwd", cwd="data")
    command, kwargs = connections.manager.exec_calls[-1]
    assert command == "pwd"
    assert kwargs["cwd"] == posixpath.join(REMOTE_ROOT, "data")
    assert result["ok"] is True
    assert result["execution_target"]["cwd"] == posixpath.join(REMOTE_ROOT, "data")
    assert result["backend"] == "ssh"


async def test_shell_reports_unknown_status(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    await instance.start()

    def _unknown(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "status": "unknown",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 10,
            "retried": False,
            "command_id": "cmd_x",
            "reconciliation": {"message": "命令已经提交到远端，但连接中断，执行结果未知。"},
        }

    connections.manager.exec = _unknown  # type: ignore[method-assign]
    result = await instance.shell("touch out.txt")
    assert result["status"] == "unknown"
    assert result["ok"] is False
    assert result["reconciliation"]["message"].startswith("命令已经提交到远端")


async def test_file_operations(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    manager = connections.manager
    manager.files[posixpath.join(REMOTE_ROOT, "notes.txt")] = b"hello"
    await instance.start()

    listing = await instance.list_dir(".")
    names = [entry["name"] for entry in listing["entries"]]
    assert names == ["data", "notes.txt"]  # 隐藏文件被过滤，目录优先
    assert listing["entries"][0]["is_dir"] is True

    info = await instance.stat("notes.txt")
    assert info["exists"] is True
    assert info["rel"] == "notes.txt"

    text = await instance.read_text("notes.txt")
    assert text["content"] == "hello"
    assert text["size"] == 5

    written = await instance.write_text("out/new.txt", "数据")
    assert written["ok"] is True
    assert manager.files[posixpath.join(REMOTE_ROOT, "out/new.txt")] == "数据".encode("utf-8")

    made = await instance.make_dir("results")
    assert made["ok"] is True
    assert posixpath.join(REMOTE_ROOT, "results") in manager.dirs

    deleted = await instance.delete_path("results")
    assert deleted["ok"] is True
    assert deleted["deleted"] >= 1

    uploaded = await instance.save_upload("data", "sample.csv", b"a,b\n1,2\n")
    assert uploaded["path"] == "data/sample.csv"

    data, name, mime = await instance.read_bytes("notes.txt")
    assert data == b"hello"
    assert name == "notes.txt"
    assert mime.startswith("text/plain")

    with pytest.raises(BackendUnsupported, match="整目录上传"):
        await instance.upload_dir("data")


async def test_read_text_rejects_missing_and_oversized(
    backend: tuple[SSHExecutionBackend, FakeConnections],
) -> None:
    instance, connections = backend
    await instance.start()
    with pytest.raises(BackendError, match="远端文件不存在"):
        await instance.read_text("missing.txt")
    big = posixpath.join(REMOTE_ROOT, "big.txt")
    connections.manager.files[big] = b"x" * 20
    with pytest.raises(BackendError, match="读取上限"):
        await instance.read_text("big.txt", max_bytes=10)


async def test_path_escape_is_rejected(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, _connections = backend
    await instance.start()
    with pytest.raises(BackendError, match="路径超出 SSH 工作区范围"):
        await instance.stat("../../etc/passwd")


# ---------------------------------------------------------------------------
# 远端长任务（PID/PGID 与取消确认）
# ---------------------------------------------------------------------------
async def test_spawn_process_log_and_cancel(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    await instance.start()
    record = await instance.spawn_process("sleep 100", name="长任务")
    assert record["ok"] is True
    assert record["job_id"].startswith("job_")
    assert record["pid"] == 12345
    assert record["pgid"] == 12345
    assert record["name"] == "长任务"
    job_path = posixpath.join(REMOTE_ROOT, JOBS_DIR, f"{record['job_id']}.json")
    assert job_path in connections.manager.files

    connections.manager.files[record["log_path"]] = b"line1\nline2\n"
    log = await instance.process_log(record["job_id"])
    assert log["log"] == "line1\nline2\n"
    assert log["truncated"] is False

    cancelled = await instance.process_cancel(record["job_id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["ok"] is True
    assert cancelled["pgid"] == 12345

    jobs = await instance.process_list()
    assert [job["job_id"] for job in jobs] == [record["job_id"]]


async def test_process_cancel_alive_reports_unknown(
    backend: tuple[SSHExecutionBackend, FakeConnections],
) -> None:
    instance, connections = backend
    await instance.start()

    def _alive(*args: Any, **kwargs: Any) -> dict[str, Any]:
        command = str(args[1] if len(args) > 1 else "")
        if "nohup" in command:
            return {"ok": True, "status": "ok", "exit_code": 0, "stdout": f"{MARKER}12345\n", "stderr": ""}
        return {"ok": True, "status": "ok", "exit_code": 0, "stdout": "ALIVE\n", "stderr": ""}

    connections.manager.exec = _alive  # type: ignore[method-assign]
    record = await instance.spawn_process("sleep 100")
    cancelled = await instance.process_cancel(record["job_id"])
    assert cancelled["status"] == "unknown"
    assert cancelled["ok"] is False


# ---------------------------------------------------------------------------
# Notebook
# ---------------------------------------------------------------------------
async def test_build_notebook(backend: tuple[SSHExecutionBackend, FakeConnections]) -> None:
    instance, connections = backend
    await instance.start()
    result = await instance.build_notebook(
        [
            {"type": "markdown", "source": "# 标题"},
            {"type": "code", "source": "print(1)"},
        ],
        title="测试分析",
    )
    assert result["ok"] is True
    notebook = result["notebook"]
    assert notebook["nbformat"] == 4
    assert len(notebook["cells"]) == 2
    assert notebook["cells"][0]["cell_type"] == "markdown"
    assert notebook["metadata"]["omicslab"]["backend"] == "ssh"

    saved = await instance.build_notebook([{"type": "code", "source": "x=1"}], path="analysis.ipynb")
    assert saved["path"] == "analysis.ipynb"
    assert posixpath.join(REMOTE_ROOT, "analysis.ipynb") in connections.manager.files
    payload = json.loads(connections.manager.files[posixpath.join(REMOTE_ROOT, "analysis.ipynb")])
    assert payload["cells"][0]["source"] == ["x=1"]
