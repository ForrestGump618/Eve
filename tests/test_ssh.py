"""SSH 子系统测试。

全部使用内存中的 Fake paramiko 对象，不依赖真实 SSH 服务器、不联网。
覆盖：档案/凭据（F15）、known_hosts、exec（cwd/F09、无盲重试/F13、unknown 对账）、
SFTP 文件操作、remote_info、PTY、ConnectionService 共享（F10）、Agent 工具与 REST 路由。
真实 SSH 集成行为在此环境中无法验证。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import paramiko
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omicslab.agent.tools import ToolContext, ToolRegistry
from omicslab.config import Settings
from omicslab.server import routes_ssh as routes_module
from omicslab.ssh import connections as connections_module
from omicslab.ssh import manager as manager_module
from omicslab.ssh import tools as tools_module
from omicslab.ssh.manager import (
    SSHError,
    SSHManager,
    SSHProfileNotFound,
    SSHValidationError,
)
from omicslab.ssh.tools import register_ssh_tools

HOME_DIR = "/home/alice"
FINGERPRINT_A = "SHA256:FAKEFINGERPRINTAAAA"
FINGERPRINT_B = "SHA256:CHANGEDFINGERPRINTBB"


# ---------------------------------------------------------------------------
# Fake paramiko 对象
# ---------------------------------------------------------------------------


class FakePKey:
    def __init__(self, fingerprint: str = FINGERPRINT_A) -> None:
        self._fingerprint = fingerprint

    def get_fingerprint(self) -> bytes:
        return self._fingerprint.encode()

    def get_name(self) -> str:
        return "ssh-ed25519"

    def asbytes(self) -> bytes:
        return b"fake-public-key"


class FakeKey:
    def __init__(self, path: str | Path = "/tmp/fake_key") -> None:
        self.path = str(path)


class FakeAttr:
    def __init__(
        self,
        filename: str = "",
        mode: int = 0o100644,
        size: int = 0,
        mtime: int = 1700000000,
    ) -> None:
        self.filename = filename
        self.st_mode = mode
        self.st_size = size
        self.st_mtime = mtime
        self.st_atime = mtime - 30
        self.st_uid = 1000
        self.st_gid = 1000


class _ReadHandle:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self, size: int | None = None) -> bytes:
        if size is None:
            data, self._data = self._data, b""
            return data
        chunk, self._data = self._data[:size], self._data[size:]
        return chunk

    def close(self) -> None:
        return None

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class _WriteHandle:
    def __init__(self, parent: "FakeSFTP", path: str) -> None:
        self.parent = parent
        self.path = path
        self.buffer = bytearray()

    def write(self, data: bytes) -> int:
        self.buffer.extend(data)
        return len(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self.parent.files[self.path] = bytes(self.buffer)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class FakeSFTP:
    files: dict[str, bytes] = {}
    dirs: set[str] = set()
    fail_puts = 0

    @classmethod
    def reset(cls) -> None:
        cls.files = {}
        cls.dirs = {
            "/",
            "/home",
            HOME_DIR,
            f"{HOME_DIR}/project",
            f"{HOME_DIR}/project/sub",
            f"{HOME_DIR}/data",
        }
        cls.fail_puts = 0

    def normalize(self, path: str) -> str:
        return path

    def stat(self, path: str) -> FakeAttr:
        if path in self.dirs:
            return FakeAttr(filename=path.rsplit("/", 1)[-1] or "/", mode=0o040755, size=4096)
        if path in self.files:
            return FakeAttr(filename=path.rsplit("/", 1)[-1], size=len(self.files[path]))
        raise FileNotFoundError(path)

    def listdir_attr(self, path: str) -> list[FakeAttr]:
        if path not in self.dirs:
            raise IOError(path)
        prefix = path.rstrip("/") + "/"
        out: list[FakeAttr] = []
        for directory in sorted(self.dirs):
            if directory.startswith(prefix) and "/" not in directory[len(prefix) :]:
                out.append(FakeAttr(filename=directory[len(prefix) :], mode=0o040755, size=4096))
        for name, data in sorted(self.files.items()):
            if name.startswith(prefix) and "/" not in name[len(prefix) :]:
                out.append(FakeAttr(filename=name[len(prefix) :], size=len(data)))
        return out

    def mkdir(self, path: str) -> None:
        if path in self.dirs:
            raise IOError(path)
        self.dirs.add(path)

    def remove(self, path: str) -> None:
        if path not in self.files:
            raise FileNotFoundError(path)
        del self.files[path]

    def rmdir(self, path: str) -> None:
        if path not in self.dirs:
            raise FileNotFoundError(path)
        self.dirs.discard(path)

    def rename(self, source: str, target: str) -> None:
        if source in self.files:
            self.files[target] = self.files.pop(source)
        elif source in self.dirs:
            self.dirs.discard(source)
            self.dirs.add(target)
        else:
            raise FileNotFoundError(source)

    def posix_rename(self, source: str, target: str) -> None:
        self.rename(source, target)

    def put(self, local: str, remote: str, callback=None, confirm: bool = True) -> None:
        if FakeSFTP.fail_puts > 0:
            FakeSFTP.fail_puts -= 1
            raise OSError("put failed")
        data = Path(local).read_bytes()
        self.files[remote] = data
        if callback is not None:
            callback(len(data), len(data))

    def get(self, remote: str, local: str, callback=None) -> None:
        if remote not in self.files:
            raise FileNotFoundError(remote)
        data = self.files[remote]
        Path(local).write_bytes(data)
        if callback is not None:
            callback(len(data), len(data))

    def open(self, path: str, mode: str = "rb"):
        if "r" in mode:
            if path not in self.files:
                raise FileNotFoundError(path)
            return _ReadHandle(self.files[path])
        return _WriteHandle(self, path)

    def close(self) -> None:
        return None


class FakeChannel:
    def __init__(
        self,
        stdout: bytes = b"",
        stderr: bytes = b"",
        exit_code: int = 0,
        commands: list[str] | None = None,
        timeout_exec: bool = False,
        fail_on_recv: bool = False,
    ) -> None:
        self._stdout = stdout
        self._stderr = stderr
        self.exit_code = exit_code
        self.commands = commands
        self.timeout_exec = timeout_exec
        self.fail_on_recv = fail_on_recv
        self.command = ""
        self.sent: list[bytes] = []
        self.resizes: list[tuple[int, int]] = []
        self.closed = False

    def exec_command(self, command: str) -> None:
        self.command = command
        if self.commands is not None:
            self.commands.append(command)

    def shutdown_write(self) -> None:
        return None

    def settimeout(self, timeout) -> None:
        return None

    def recv_ready(self) -> bool:
        return self.fail_on_recv or bool(self._stdout)

    def recv(self, size: int) -> bytes:
        if self.fail_on_recv:
            raise RuntimeError("channel read exploded")
        chunk, self._stdout = self._stdout[:size], self._stdout[size:]
        return chunk

    def recv_stderr_ready(self) -> bool:
        return bool(self._stderr)

    def recv_stderr(self, size: int) -> bytes:
        chunk, self._stderr = self._stderr[:size], self._stderr[size:]
        return chunk

    def exit_status_ready(self) -> bool:
        if self.timeout_exec or self.fail_on_recv:
            return False
        return not self._stdout and not self._stderr

    def recv_exit_status(self) -> int:
        return self.exit_code

    def get_pty(self, *args, **kwargs) -> None:
        return None

    def resize_pty(self, width: int = 80, height: int = 24) -> None:
        self.resizes.append((int(width), int(height)))

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def is_active(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True


class FakeTransport:
    def __init__(self, client: "FakeSSHClient") -> None:
        self.client = client
        self.active = False
        self.remote_key = FakePKey()
        self.remote_version = "SSH-2.0-FakeServer"

    def is_active(self) -> bool:
        return self.active

    def get_remote_server_key(self) -> FakePKey:
        return self.remote_key

    def set_keepalive(self, interval: int) -> None:
        self.keepalive = interval

    def open_session(self, timeout=None):
        return self.client.next_channel()


class FakeSSHClient:
    instances: list["FakeSSHClient"] = []
    connect_plan: list[BaseException | None] = []
    fingerprint = FINGERPRINT_A
    channel_factory = None

    def __init__(self) -> None:
        self.connect_kwargs: dict = {}
        self.policy = None
        self.closed = False
        self.connected = False
        self.invoke_calls: list[dict] = []
        self.transport = FakeTransport(self)
        self.channels: list[FakeChannel] = []
        FakeSSHClient.instances.append(self)

    def set_missing_host_key_policy(self, policy) -> None:
        self.policy = policy

    def load_system_host_keys(self, filename=None) -> None:
        return None

    def connect(self, hostname: str, port: int = 22, username: str | None = None, **kwargs) -> None:
        if FakeSSHClient.connect_plan:
            item = FakeSSHClient.connect_plan.pop(0)
            if item is not None:
                raise item
        self.connect_kwargs = {"hostname": hostname, "port": port, "username": username, **kwargs}
        self.connected = True
        self.transport.active = True
        self.transport.remote_key = FakePKey(FakeSSHClient.fingerprint)
        self.transport.remote_version = "SSH-2.0-FakeServer"

    def get_transport(self) -> FakeTransport | None:
        return self.transport if self.connected else None

    def open_sftp(self) -> FakeSFTP:
        return FakeSFTP()

    def next_channel(self) -> FakeChannel:
        factory = FakeSSHClient.channel_factory
        channel = factory(self) if callable(factory) else FakeChannel()
        self.channels.append(channel)
        return channel

    def invoke_shell(self, term: str = "xterm", width: int = 80, height: int = 24) -> FakeChannel:
        self.invoke_calls.append({"term": term, "width": width, "height": height})
        channel = FakeChannel()
        self.channels.append(channel)
        return channel

    def close(self) -> None:
        self.closed = True
        self.transport.active = False


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_connection_service():
    connections_module.reset_for_tests()
    yield
    connections_module.reset_for_tests()


@pytest.fixture()
def fake_ssh(monkeypatch) -> type[FakeSSHClient]:
    FakeSSHClient.instances = []
    FakeSSHClient.connect_plan = []
    FakeSSHClient.fingerprint = FINGERPRINT_A
    FakeSSHClient.channel_factory = lambda client: FakeChannel()
    FakeSFTP.reset()
    monkeypatch.setattr(manager_module.paramiko, "SSHClient", FakeSSHClient)
    monkeypatch.setattr(manager_module.paramiko, "AutoAddPolicy", lambda: SimpleNamespace())
    return FakeSSHClient


@pytest.fixture()
def settings(tmp_path) -> Settings:
    st = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    st.ensure_dirs()
    return st


@pytest.fixture()
def manager(settings) -> SSHManager:
    return SSHManager(settings)


def _add_profile(manager: SSHManager, **overrides) -> dict:
    payload = {
        "name": "bio01",
        "host": "cluster.example.org",
        "port": 22,
        "username": "alice",
        "auth": "password",
        "tags": ["gpu"],
    }
    payload.update(overrides)
    return manager.add_profile(**payload)


def _service(settings) -> "connections_module.ConnectionService":
    return connections_module.get_connection_service(settings)


def _add_service_profile(service, **overrides) -> dict:
    payload = {
        "name": "bio01",
        "host": "cluster.example.org",
        "port": 22,
        "username": "alice",
        "auth": "password",
        "tags": [],
    }
    payload.update(overrides)
    return service.add_profile(**payload)


# ---------------------------------------------------------------------------
# 档案与凭据（F15）
# ---------------------------------------------------------------------------


def test_profile_crud_lifecycle(manager, settings):
    created = _add_profile(manager)
    assert created["id"].startswith("prof_")
    assert created["name"] == "bio01"
    assert created["password_saved"] is False
    assert "password" not in created

    updated = manager.update_profile(created["id"], name="bio01-renamed")
    assert updated["name"] == "bio01-renamed"

    assert [item["id"] for item in manager.list_profiles()] == [created["id"]]
    removed = manager.remove_profile(created["id"])
    assert removed["ok"] is True
    assert manager.list_profiles() == []
    with pytest.raises(SSHProfileNotFound):
        manager.get_profile(created["id"])


def test_add_profile_requires_core_fields(manager):
    with pytest.raises(SSHValidationError):
        manager.add_profile(name="x", host="", username="alice", auth="password")
    with pytest.raises(SSHValidationError):
        manager.add_profile(name="x", host="h", username="", auth="password")
    with pytest.raises(SSHValidationError):
        manager.add_profile(name="x", host="h", username="u", auth="key")


def test_password_defaults_to_memory_only(manager, settings):
    created = _add_profile(manager, password="p@ssw0rd")
    assert created["password_saved"] is False
    assert created["has_password_saved"] is True  # 仅当前进程内存可用

    raw = json.loads(Path(manager.profiles_path).read_text(encoding="utf-8"))
    lowered = json.dumps(raw, ensure_ascii=False)
    assert "p@ssw0rd" not in lowered
    assert "b64:" not in lowered
    stored = raw["profiles"][0]
    assert stored["password_saved"] is False
    assert stored["credential_id"].startswith("cred")

    # 新进程（新 manager）无法解出仅内存密码。
    fresh = SSHManager(settings)
    with pytest.raises(SSHValidationError):
        fresh._resolve_password(fresh._get_profile_raw(created["id"]))


def test_remember_password_uses_credential_reference(manager):
    created = _add_profile(manager, password="pw-remember", remember_password=True)
    raw = json.loads(Path(manager.profiles_path).read_text(encoding="utf-8"))
    stored = raw["profiles"][0]
    assert "password" not in stored
    assert stored["credential_id"].startswith("cred")
    assert stored["password_saved"] is False  # 无系统凭据库时降级为仅内存
    assert manager._resolve_password(manager._get_profile_raw(created["id"])) == "pw-remember"


def test_legacy_b64_password_is_migrated(manager, settings):
    legacy = {
        "profiles": [
            {
                "id": "prof_legacy00001",
                "name": "legacy",
                "host": "old.example.org",
                "port": 22,
                "username": "bob",
                "auth": "password",
                "password_saved": True,
                "password": "b64:" + base64.b64encode(b"legacy-secret").decode("ascii"),
                "tags": [],
            }
        ]
    }
    Path(manager.profiles_path).write_text(json.dumps(legacy), encoding="utf-8")

    reloaded = SSHManager(settings)
    profile = reloaded.get_profile("prof_legacy00001")
    assert profile["name"] == "legacy"
    assert "legacy-secret" not in json.dumps(profile, ensure_ascii=False)
    assert reloaded._resolve_password(reloaded._get_profile_raw("prof_legacy00001")) == "legacy-secret"

    text = Path(reloaded.profiles_path).read_text(encoding="utf-8")
    assert "b64:" not in text
    assert "legacy-secret" not in text


def test_known_hosts_fingerprint_change_is_rejected(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    first = manager.test_connection(created["id"])
    assert first["ok"] is True
    assert first["fingerprint"] == manager_module._fingerprint_of(FakePKey(FINGERPRINT_A))

    FakeSSHClient.fingerprint = FINGERPRINT_B
    manager._drop(created["id"])
    second = manager.test_connection(created["id"])
    assert second["ok"] is False
    assert "指纹" in second["error"]
    assert manager.known_fingerprint("cluster.example.org") == first["fingerprint"]


def test_test_connection_auth_failure_returns_error(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.connect_plan.append(paramiko.AuthenticationException("bad password"))
    result = manager.test_connection(created["id"])
    assert result["ok"] is False
    assert "认证失败" in result["error"]


def test_test_connection_does_not_raise_on_error(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.connect_plan.append(OSError("connection refused"))
    result = manager.test_connection(created["id"])
    assert result["ok"] is False
    assert result["error"]


# ---------------------------------------------------------------------------
# exec：cwd（F09）、无盲重试与 unknown（F13）
# ---------------------------------------------------------------------------


def test_exec_success(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.channel_factory = lambda client: FakeChannel(stdout=b"hello\n")
    result = manager.exec(created["id"], "echo hello")
    assert result["ok"] is True
    assert result["status"] == "ok"
    assert result["exit_code"] == 0
    assert result["stdout"] == "hello\n"
    assert result["command_id"].startswith("cmd_")


def test_exec_cwd_is_quoted_prefix(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    commands: list[str] = []
    FakeSSHClient.channel_factory = lambda client: FakeChannel(stdout=b"ok\n", commands=commands)
    manager.exec(created["id"], "ls -la", cwd="/data/my project")
    assert commands == ["cd '/data/my project' && ls -la"]


def test_exec_nonzero_exit(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.channel_factory = lambda client: FakeChannel(stderr=b"boom\n", exit_code=2)
    result = manager.exec(created["id"], "false")
    assert result["ok"] is False
    assert result["status"] == "nonzero"
    assert result["exit_code"] == 2
    assert result["stderr"] == "boom\n"


def test_exec_timeout(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.channel_factory = lambda client: FakeChannel(timeout_exec=True)
    result = manager.exec(created["id"], "sleep 100", timeout_s=1)
    assert result["ok"] is False
    assert result["status"] == "timeout"
    assert result["exit_code"] is None
    assert "超时" in result["stderr"]


def test_exec_retries_once_for_transient_connect_error(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.connect_plan = [OSError("connection refused"), None]
    result = manager.exec(created["id"], "echo hi")
    assert result["ok"] is True
    assert result["retried"] is True
    assert len(FakeSSHClient.instances) == 2


def test_exec_auth_failure_is_not_retried(manager, fake_ssh):
    created = _add_profile(manager, password="wrong")
    FakeSSHClient.connect_plan = [paramiko.AuthenticationException("bad password")]
    with pytest.raises(SSHError) as info:
        manager.exec(created["id"], "echo hi")
    assert "认证失败" in str(info.value)
    assert len(FakeSSHClient.instances) == 1


def test_exec_unknown_after_submit_is_not_retried(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.channel_factory = lambda client: FakeChannel(fail_on_recv=True)
    result = manager.exec(created["id"], "touch /tmp/side-effect")
    assert result["ok"] is False
    assert result["status"] == "unknown"
    assert result["exit_code"] is None
    assert len(FakeSSHClient.instances) == 1  # 未重跑
    reconciliation = result["reconciliation"]
    assert "没有自动重试" in reconciliation["message"]
    assert reconciliation["command_sha256"]
    assert result["command_id"]


def test_exec_idempotent_can_retry_unknown(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    plan = [
        lambda client: FakeChannel(fail_on_recv=True),
        lambda client: FakeChannel(stdout=b"done\n"),
    ]

    def factory(client):
        return plan.pop(0)(client)

    FakeSSHClient.channel_factory = factory
    result = manager.exec(created["id"], "cat data.txt", idempotent=True)
    assert result["ok"] is True
    assert result["retried"] is True
    assert result["stdout"] == "done\n"
    assert len(FakeSSHClient.instances) == 2


def test_command_log_does_not_store_plaintext(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSSHClient.channel_factory = lambda client: FakeChannel(stdout=b"ok\n")
    manager.exec(created["id"], "export TOKEN=PLAINTEXT-SECRET")

    text = Path(manager.command_log_path).read_text(encoding="utf-8")
    assert "PLAINTEXT-SECRET" not in text
    records = manager.recent_commands(5)
    assert records
    assert records[-1]["command_sha256"]
    assert "command" not in records[-1]


def test_exec_key_auth_uses_private_key(manager, fake_ssh, monkeypatch):
    created = _add_profile(manager, auth="key", key_path="/tmp/id_ed25519")
    pkey = FakeKey("/tmp/id_ed25519")
    monkeypatch.setattr(manager, "_load_private_key", lambda key_path: pkey)
    FakeSSHClient.channel_factory = lambda client: FakeChannel(stdout=b"key-ok\n")
    result = manager.exec(created["id"], "whoami")
    assert result["ok"] is True
    kwargs = FakeSSHClient.instances[0].connect_kwargs
    assert kwargs["pkey"] is pkey
    assert "password" not in kwargs


# ---------------------------------------------------------------------------
# SFTP
# ---------------------------------------------------------------------------


def test_sftp_put_file(manager, fake_ssh, tmp_path):
    created = _add_profile(manager, password="pw")
    source = tmp_path / "sample.txt"
    source.write_bytes(b"hello sftp!!")
    result = manager.put_file(created["id"], source, f"{HOME_DIR}/data/sample.txt")
    assert result["ok"] is True
    assert result["bytes"] == 12
    assert FakeSFTP.files[f"{HOME_DIR}/data/sample.txt"] == b"hello sftp!!"


def test_sftp_put_file_retries_once(manager, fake_ssh, tmp_path):
    created = _add_profile(manager, password="pw")
    source = tmp_path / "retry.txt"
    source.write_bytes(b"retry")
    FakeSFTP.fail_puts = 1
    result = manager.put_file(created["id"], source, f"{HOME_DIR}/data/retry.txt")
    assert result["ok"] is True
    assert result["retried"] is True
    assert FakeSFTP.files[f"{HOME_DIR}/data/retry.txt"] == b"retry"


def test_sftp_get_file(manager, fake_ssh, tmp_path):
    created = _add_profile(manager, password="pw")
    FakeSFTP.files[f"{HOME_DIR}/data/readme.txt"] = b"content"
    target = tmp_path / "out" / "readme.txt"
    result = manager.get_file(created["id"], f"{HOME_DIR}/data/readme.txt", target)
    assert result["ok"] is True
    assert result["bytes"] == 7
    assert target.read_bytes() == b"content"


def test_sftp_get_file_missing_raises(manager, fake_ssh, tmp_path):
    created = _add_profile(manager, password="pw")
    with pytest.raises(SSHError) as info:
        manager.get_file(created["id"], f"{HOME_DIR}/missing.txt", tmp_path / "x.txt")
    assert "下载失败" in str(info.value)


def test_sftp_list_dir_sorted_and_attributed(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    FakeSFTP.files[f"{HOME_DIR}/project/a.txt"] = b"abc"
    listed = manager.list_dir(created["id"], f"{HOME_DIR}/project")
    names = [entry["name"] for entry in listed["entries"]]
    assert names[0] == "sub"  # 目录优先
    assert "a.txt" in names
    file_entry = next(item for item in listed["entries"] if item["name"] == "a.txt")
    assert file_entry["attributes"]["uid"] == 1000


def test_sftp_stat_read_write_delete(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    written = manager.write_bytes(created["id"], f"{HOME_DIR}/data/new.txt", b"payload")
    assert written["bytes"] == 7
    info = manager.stat(created["id"], f"{HOME_DIR}/data/new.txt")
    assert info["exists"] is True
    assert info["size"] == 7
    assert manager.read_bytes(created["id"], f"{HOME_DIR}/data/new.txt") == b"payload"
    with pytest.raises(SSHError):
        manager.read_bytes(created["id"], f"{HOME_DIR}/data/new.txt", max_bytes=2)
    removed = manager.delete(created["id"], f"{HOME_DIR}/data/new.txt")
    assert removed["deleted"] == 1
    assert manager.stat(created["id"], f"{HOME_DIR}/data/new.txt")["exists"] is False


def test_mkdir_and_recursive_delete(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    directory = f"{HOME_DIR}/newdir"
    manager.mkdir(created["id"], directory)
    manager.write_bytes(created["id"], f"{directory}/inside.txt", b"x")
    removed = manager.delete(created["id"], directory, recursive=True)
    assert removed["deleted"] >= 2
    assert manager.stat(created["id"], directory)["exists"] is False


# ---------------------------------------------------------------------------
# remote_info 与 PTY
# ---------------------------------------------------------------------------


def test_remote_info_parses_probes(manager, fake_ssh, monkeypatch):
    created = _add_profile(manager, password="pw")

    def fake_probe(profile_id, command, timeout_s=20):
        table = {
            "meminfo": "MemTotal:       32768000 kB",
            "python3 --version": "Python 3.11.9",
            "nproc": "8",
            "nvidia-smi": "NVIDIA A100-SXM4-40GB",
            "df -Pk": "overlay 100 60 40000000 60% /",
            "uname": "Linux 5.15.0 x86_64",
        }
        for key, value in table.items():
            if key in command:
                return value
        return None

    monkeypatch.setattr(manager, "_probe", fake_probe)
    info = manager.remote_info(created["id"])
    assert info["uname"] == "Linux 5.15.0 x86_64"
    assert info["python"] == "Python 3.11.9"
    assert info["cpu_count"] == 8
    assert info["mem_total_mb"] == 32000
    assert info["gpu"] == "NVIDIA A100-SXM4-40GB"
    assert info["disk_free_gb"] == 38.15


def test_remote_info_missing_fields_are_none(manager, fake_ssh, monkeypatch):
    created = _add_profile(manager, password="pw")
    monkeypatch.setattr(manager, "_probe", lambda *args, **kwargs: None)
    info = manager.remote_info(created["id"])
    assert info == {
        "uname": None,
        "python": None,
        "cpu_count": None,
        "mem_total_mb": None,
        "gpu": None,
        "disk_free_gb": None,
    }


def test_open_shell_uses_pty(manager, fake_ssh):
    created = _add_profile(manager, password="pw")
    terminal = manager.open_shell(created["id"], width=120, height=40)
    client = FakeSSHClient.instances[-1]
    assert client.invoke_calls == [{"term": "xterm-256color", "width": 120, "height": 40}]
    assert terminal.is_active() is True
    terminal.send(b"pwd\n")
    terminal.resize(100, 30)
    channel = client.channels[-1]
    assert channel.sent == [b"pwd\n"]
    assert channel.resizes == [(100, 30)]
    terminal.close()


# ---------------------------------------------------------------------------
# ConnectionService：单例与 F10 共享凭据
# ---------------------------------------------------------------------------


def test_connection_service_is_singleton(settings, fake_ssh):
    first = connections_module.get_connection_service(settings)
    second = connections_module.get_connection_service(settings)
    assert first is second
    connections_module.reset_for_tests()
    third = connections_module.get_connection_service(settings)
    assert third is not first


def test_ui_test_password_is_reused_by_agent_exec(settings, fake_ssh):
    service = _service(settings)
    profile = _add_service_profile(service)
    tested = service.test_connection(profile["id"], password="ui-only-password")
    assert tested["ok"] is True

    FakeSSHClient.channel_factory = lambda client: FakeChannel(stdout=b"agent-ok\n")
    agent_service = tools_module._service_for(settings)
    assert agent_service is service
    result = service.exec(profile["id"], "echo agent")
    assert result["ok"] is True
    assert len(FakeSSHClient.instances) == 1  # 复用了 UI 测试建立的连接


def test_connection_service_probe(settings, fake_ssh):
    service = _service(settings)
    profile = _add_service_profile(service)
    service.test_connection(profile["id"], password="pw")
    probed = service.probe(profile["id"], f"{HOME_DIR}/project")
    assert probed["ok"] is True
    assert probed["exists"] is True
    assert probed["is_dir"] is True
    assert isinstance(probed["entries"], list)


# ---------------------------------------------------------------------------
# Agent 工具
# ---------------------------------------------------------------------------


class FakeService:
    def __init__(self) -> None:
        self.exec_calls: list[tuple] = []
        self.put_calls: list[tuple] = []
        self.get_calls: list[tuple] = []
        self.exec_result = {
            "ok": True,
            "status": "ok",
            "exit_code": 0,
            "stdout": "out\n",
            "stderr": "",
            "duration_ms": 5,
            "command_id": "cmd_1",
        }
        self.profiles = [
            {
                "id": "p1",
                "name": "bio01",
                "host": "h",
                "port": 22,
                "username": "u",
                "auth": "password",
                "has_password_saved": False,
                "password_saved": False,
                "last_ok": "",
                "last_error": "",
            }
        ]

    def list_profiles(self):
        return list(self.profiles)

    def exec(self, profile_id, command, **kwargs):
        self.exec_calls.append((profile_id, command, kwargs))
        if isinstance(self.exec_result, Exception):
            raise self.exec_result
        return dict(self.exec_result)

    def put_file(self, profile_id, local_path, remote_path):
        self.put_calls.append((profile_id, local_path, remote_path))
        return {"ok": True, "bytes": 3, "remote_path": remote_path}

    def get_file(self, profile_id, remote_path, local_path):
        self.get_calls.append((profile_id, remote_path, local_path))
        return {"ok": True, "bytes": 3, "local_path": str(local_path)}

    def remote_info(self, profile_id):
        return {
            "uname": "Linux",
            "python": "Python 3.11",
            "cpu_count": 8,
            "mem_total_mb": 4000,
            "gpu": None,
            "disk_free_gb": 10.5,
        }


class FakeApprover:
    def __init__(self, approve: bool = True) -> None:
        self.approve = approve
        self.requests: list[tuple] = []

    async def request(self, ctx, tool_name, arguments, reason=""):
        self.requests.append((tool_name, arguments))
        return self.approve


def _tool_registry(settings) -> ToolRegistry:
    registry = ToolRegistry([])
    register_ssh_tools(registry, settings)
    return registry


def test_register_ssh_tools(settings):
    registry = _tool_registry(settings)
    names = set(registry.names())
    assert {"ssh_list_profiles", "ssh_exec", "ssh_upload", "ssh_download", "ssh_remote_info"} <= names
    assert registry.get("ssh_exec").requires_approval is True
    assert registry.get("ssh_upload").requires_approval is True
    assert registry.get("ssh_list_profiles").requires_approval is False
    # 幂等：重复注册不报错。
    register_ssh_tools(registry, settings)


async def test_tool_exec_requires_approval(settings, fake_ssh, monkeypatch):
    service = FakeService()
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    registry = _tool_registry(settings)
    ctx = ToolContext(settings=settings)
    approver = FakeApprover(True)
    ctx.approver = approver
    result = await registry.execute(ctx, "ssh_exec", {"profile_id": "p1", "command": "ls", "cwd": "/data"})
    assert result.ok is True
    assert service.exec_calls == [("p1", "ls", {"cwd": "/data", "timeout_s": 120})]
    assert approver.requests


async def test_tool_exec_denied_by_approver(settings, fake_ssh, monkeypatch):
    service = FakeService()
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    registry = _tool_registry(settings)
    ctx = ToolContext(settings=settings)
    ctx.approver = FakeApprover(False)
    result = await registry.execute(ctx, "ssh_exec", {"profile_id": "p1", "command": "rm -rf /"})
    assert result.ok is False
    assert service.exec_calls == []


async def test_tool_exec_unknown_status(settings, fake_ssh, monkeypatch):
    service = FakeService()
    service.exec_result = {
        "ok": False,
        "status": "unknown",
        "exit_code": None,
        "stdout": "",
        "stderr": "",
        "duration_ms": 12,
        "command_id": "cmd_9",
        "reconciliation": {"message": "系统没有自动重试，请人工核对。"},
    }
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    ctx = ToolContext(settings=settings)
    result = await tools_module._tool_ssh_exec(ctx, {"profile_id": "p1", "command": "submit job"})
    assert result.ok is False
    assert "执行结果未知" in result.content
    assert "系统没有自动重试" in result.content
    assert "cmd_9" in result.content


async def test_tool_exec_failure_returns_error(settings, fake_ssh, monkeypatch):
    service = FakeService()
    service.exec_result = SSHError("boom")
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    ctx = ToolContext(settings=settings)
    result = await tools_module._tool_ssh_exec(ctx, {"profile_id": "p1", "command": "ls"})
    assert result.ok is False
    assert "boom" in result.content


async def test_tool_exec_missing_arguments(settings, fake_ssh, monkeypatch):
    service = FakeService()
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    ctx = ToolContext(settings=settings)
    result = await tools_module._tool_ssh_exec(ctx, {"profile_id": "p1"})
    assert result.ok is False
    assert "command" in result.content


async def test_tool_upload_download_and_info(settings, fake_ssh, monkeypatch, tmp_path):
    service = FakeService()
    monkeypatch.setattr(tools_module, "_service_for", lambda st: service)
    ctx = ToolContext(settings=settings)

    uploaded = await tools_module._tool_ssh_upload(
        ctx,
        {"profile_id": "p1", "local_path": str(tmp_path / "data.csv"), "remote_path": "/data/data.csv"},
    )
    assert uploaded.ok is True
    assert service.put_calls == [("p1", tmp_path / "data.csv", "/data/data.csv")]

    downloaded = await tools_module._tool_ssh_download(
        ctx,
        {"profile_id": "p1", "remote_path": "/data/out.csv", "local_path": str(tmp_path / "out.csv")},
    )
    assert downloaded.ok is True

    listed = await tools_module._tool_ssh_list_profiles(ctx, {})
    assert listed.ok is True
    assert "bio01" in listed.content

    info = await tools_module._tool_ssh_remote_info(ctx, {"profile_id": "p1"})
    assert info.ok is True
    assert "Linux" in info.content


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------


@pytest.fixture()
def api_client(settings, fake_ssh) -> TestClient:
    app = FastAPI()

    @app.exception_handler(HTTPException)
    async def _http_error(request, exc):
        detail = exc.detail
        if isinstance(detail, dict):
            payload = {
                "error": {
                    "message": detail.get("message", ""),
                    "code": detail.get("code", "error"),
                    "detail": detail.get("detail", ""),
                }
            }
        else:
            payload = {"error": {"message": str(detail), "code": "error", "detail": ""}}
        return JSONResponse(status_code=exc.status_code, content=payload)

    app.include_router(routes_module.router)
    app.state.omicslab = SimpleNamespace(settings=settings)
    return TestClient(app)


def _api_profile_payload(**overrides) -> dict:
    payload = {
        "name": "bio01",
        "host": "cluster.example.org",
        "port": 22,
        "username": "alice",
        "auth": "password",
        "tags": ["gpu"],
        "password": "api-secret",
        "remember_password": False,
    }
    payload.update(overrides)
    return payload


def test_api_profiles_crud(api_client):
    created = api_client.post("/api/ssh/profiles", json=_api_profile_payload())
    assert created.status_code == 200
    profile = created.json()["profile"]
    assert profile["name"] == "bio01"
    assert profile["password_saved"] is False
    assert "password" not in profile
    assert "api-secret" not in created.text

    listed = api_client.get("/api/ssh/profiles")
    assert listed.status_code == 200
    assert len(listed.json()["profiles"]) == 1
    assert "api-secret" not in listed.text

    patched = api_client.patch(f"/api/ssh/profiles/{profile['id']}", json={"name": "renamed"})
    assert patched.status_code == 200
    assert patched.json()["profile"]["name"] == "renamed"

    removed = api_client.delete(f"/api/ssh/profiles/{profile['id']}")
    assert removed.status_code == 200
    assert removed.json()["ok"] is True


def test_api_validation_errors(api_client):
    missing = api_client.post("/api/ssh/profiles", json={"name": "x"})
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "bad_request"

    empty_patch = api_client.patch("/api/ssh/profiles/prof_x", json={})
    assert empty_patch.status_code == 400

    no_profile = api_client.get("/api/ssh/ls")
    assert no_profile.status_code == 400

    exec_missing = api_client.post("/api/ssh/exec", json={})
    assert exec_missing.status_code == 400


def test_api_test_connection_endpoint(api_client, fake_ssh):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    fake_ssh.channel_factory = lambda client: FakeChannel()
    tested = api_client.post(f"/api/ssh/profiles/{profile['id']}/test", json={})
    assert tested.status_code == 200
    body = tested.json()
    assert body["ok"] is True
    assert body["fingerprint"] == manager_module._fingerprint_of(FakePKey(FINGERPRINT_A))


def test_api_exec_nonzero_still_200(api_client, fake_ssh):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    fake_ssh.channel_factory = lambda client: FakeChannel(stderr=b"bad\n", exit_code=1)
    response = api_client.post(
        "/api/ssh/exec",
        json={"profile_id": profile["id"], "command": "false"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["status"] == "nonzero"
    assert body["exit_code"] == 1


def test_api_exec_connection_error_is_502(api_client, fake_ssh):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    fake_ssh.connect_plan.append(paramiko.AuthenticationException("bad password"))
    response = api_client.post(
        "/api/ssh/exec",
        json={"profile_id": profile["id"], "command": "ls"},
    )
    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "ssh_error"
    assert "认证失败" in error["message"] or "SSH 连接失败" in error["message"]


def test_api_ls_info_diagnostics(api_client, fake_ssh):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    pid = profile["id"]
    FakeSFTP.files[f"{HOME_DIR}/project/a.txt"] = b"x"

    listed = api_client.get("/api/ssh/ls", params={"profile_id": pid, "path": f"{HOME_DIR}/project"})
    assert listed.status_code == 200
    assert any(entry["name"] == "a.txt" for entry in listed.json()["entries"])

    info = api_client.get("/api/ssh/info", params={"profile_id": pid})
    assert info.status_code == 200
    assert set(info.json()) == {"uname", "python", "cpu_count", "mem_total_mb", "gpu", "disk_free_gb"}

    diagnostics = api_client.get("/api/ssh/diagnostics")
    assert diagnostics.status_code == 200
    assert "recent_commands" in diagnostics.json()


def test_api_upload_and_download(api_client, fake_ssh, tmp_path):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    pid = profile["id"]
    remote_path = f"{HOME_DIR}/project/api.txt"

    uploaded = api_client.post(
        "/api/ssh/upload",
        data={"profile_id": pid, "remote_path": remote_path},
        files={"file": ("api.txt", b"hello api", "text/plain")},
    )
    assert uploaded.status_code == 200
    assert uploaded.json()["bytes"] == 9

    downloaded = api_client.get("/api/ssh/download", params={"profile_id": pid, "remote_path": remote_path})
    assert downloaded.status_code == 200
    assert downloaded.content == b"hello api"
    assert "api.txt" in downloaded.headers.get("content-disposition", "")


def test_api_upload_rejects_empty_and_too_large(api_client, fake_ssh, monkeypatch):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    pid = profile["id"]

    empty = api_client.post(
        "/api/ssh/upload",
        data={"profile_id": pid, "remote_path": f"{HOME_DIR}/data/empty.txt"},
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert empty.status_code == 400

    monkeypatch.setattr(routes_module, "MAX_TRANSFER_BYTES", 10)
    too_large = api_client.post(
        "/api/ssh/upload",
        data={"profile_id": pid, "remote_path": f"{HOME_DIR}/data/big.bin"},
        files={"file": ("big.bin", b"x" * 20, "application/octet-stream")},
    )
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "too_large"


def test_api_download_errors(api_client, fake_ssh, monkeypatch):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    pid = profile["id"]

    unknown = api_client.get("/api/ssh/download", params={"profile_id": "prof_missing", "remote_path": "/x"})
    assert unknown.status_code == 404

    missing = api_client.get(
        "/api/ssh/download", params={"profile_id": pid, "remote_path": f"{HOME_DIR}/missing.txt"}
    )
    assert missing.status_code == 404

    FakeSFTP.files[f"{HOME_DIR}/big.bin"] = b"0123456789"
    monkeypatch.setattr(routes_module, "MAX_TRANSFER_BYTES", 5)
    too_large = api_client.get(
        "/api/ssh/download", params={"profile_id": pid, "remote_path": f"{HOME_DIR}/big.bin"}
    )
    assert too_large.status_code == 413


def test_api_temp_files_cleaned_after_transfer(api_client, fake_ssh):
    profile = api_client.post("/api/ssh/profiles", json=_api_profile_payload()).json()["profile"]
    pid = profile["id"]
    remote_path = f"{HOME_DIR}/project/temp.txt"
    api_client.post(
        "/api/ssh/upload",
        data={"profile_id": pid, "remote_path": remote_path},
        files={"file": ("temp.txt", b"tmp-data", "text/plain")},
    )
    api_client.get("/api/ssh/download", params={"profile_id": pid, "remote_path": remote_path})
    tmp_dir = Path(api_client.app.state.omicslab.settings.home) / "tmp"
    assert list(tmp_dir.iterdir()) == []


def test_concurrent_acquisition_does_not_close_another_call_connection(manager, fake_ssh, monkeypatch):
    import concurrent.futures
    import threading
    import time
    profile = _add_profile(manager, password="fixture-password")
    raw = manager._get_profile_raw(profile["id"])
    connect = manager._connect
    barrier = threading.Barrier(2)
    def slow_connect(*args, **kwargs):
        time.sleep(.1)
        return connect(*args, **kwargs)
    monkeypatch.setattr(manager, "_connect", slow_connect)
    def acquire():
        barrier.wait(timeout=3)
        return manager._get_client(raw)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(lambda _: acquire(), range(2)))
    assert first is second
    assert not first.closed
    assert first.transport.keepalive == 15


def test_system_agent_authentication_needs_no_password_or_private_key_path(manager, fake_ssh):
    profile = _add_profile(manager, auth="agent")
    client = manager._get_client(manager._get_profile_raw(profile["id"]))
    assert client.connect_kwargs["allow_agent"] is True
    assert "password" not in client.connect_kwargs
    assert client.transport.keepalive == 15
