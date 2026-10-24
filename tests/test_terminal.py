"""WebSocket 终端桥测试：本地分支保持不变，SSH 分支使用真 PTY 通道的契约。

用 FakeWebSocket + Fake ConnectionService 验证：
- SSE 风格出站帧 ``output`` / ``exit`` / ``diagnostic``；
- 入站 ``input`` / ``resize`` / ``close``，resize 兼容两种 payload；
- PTY 不可用时下发 ``pty_fallback`` 诊断而不是静默失败；
- 连接失败下发 ``terminal_connect_failed`` 并退出；
- 无 profile_id 时仍走本地 shell 分支。
真实 SSH 服务器上的交互行为未验证。
"""

from __future__ import annotations

import asyncio
import threading

import pytest
from fastapi import WebSocketDisconnect

from omicslab.config import Settings
from omicslab.server import terminal as terminal_module


class FakeWebSocket:
    def __init__(self, query: dict[str, str] | None = None, messages: list[dict | BaseException] | None = None) -> None:
        self.query_params = dict(query or {})
        self._messages = list(messages or [])
        self.sent: list[dict] = []
        self.accepted = False
        self.closed = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def receive_json(self) -> dict:
        if not self._messages:
            await asyncio.sleep(0.05)
            raise WebSocketDisconnect(code=1000)
        item = self._messages.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    async def close(self) -> None:
        self.closed = True

    def frames(self, kind: str) -> list[dict]:
        return [item for item in self.sent if item.get("type") == kind]


class FakeSSHChannel:
    def __init__(self, chunks: list[bytes] | None = None, diagnostic: str = "") -> None:
        self.chunks = list(chunks or [])
        self.diagnostic = diagnostic
        self.sent: list[str] = []
        self.resizes: list[tuple[int, int]] = []
        self.closed = False
        self._active = True
        self._release = threading.Event()

    def recv(self, size: int) -> bytes:
        if self.chunks:
            return self.chunks.pop(0)
        self._release.wait(1.0)
        self._active = False
        return b""

    def is_active(self) -> bool:
        return self._active

    def send(self, data: str) -> None:
        self.sent.append(data)

    def resize(self, cols: int, rows: int) -> None:
        self.resizes.append((cols, rows))

    def close(self) -> None:
        self.closed = True
        self._release.set()

    def release(self) -> None:
        self._release.set()


class FakeConnectionService:
    def __init__(self, channel: FakeSSHChannel | None = None, error: BaseException | None = None) -> None:
        self.channel = channel
        self.error = error
        self.calls: list[dict] = []

    def open_terminal(self, profile_id: str, *, cols: int = 100, rows: int = 30) -> FakeSSHChannel:
        self.calls.append({"profile_id": profile_id, "cols": cols, "rows": rows})
        if self.error is not None:
            raise self.error
        assert self.channel is not None
        return self.channel


@pytest.fixture()
def settings(tmp_path) -> Settings:
    result = Settings(workspace=tmp_path / "workspace", home=tmp_path / "home")
    result.ensure_dirs()
    return result


def _install(monkeypatch: pytest.MonkeyPatch, service: FakeConnectionService) -> None:
    monkeypatch.setattr("omicslab.ssh.connections.get_connection_service", lambda settings: service)


async def _run_with_release(
    websocket: FakeWebSocket,
    channel: FakeSSHChannel,
    settings: Settings,
    *,
    until=None,
    delay: float = 0.08,
) -> None:
    task = asyncio.create_task(terminal_module.run_terminal(websocket, settings))
    if until is not None:
        for _ in range(300):
            if until():
                break
            await asyncio.sleep(0.01)
    else:
        await asyncio.sleep(delay)
    channel.release()
    await asyncio.wait_for(task, timeout=5.0)


async def test_ssh_terminal_streams_output_and_input(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = FakeSSHChannel(chunks=[b"alice@node:~/project$ "])
    service = FakeConnectionService(channel=channel)
    _install(monkeypatch, service)
    websocket = FakeWebSocket(
        {"profile_id": "prof_1", "cwd": "/home/alice/project", "cols": "120", "rows": "40"},
        messages=[
            {"type": "input", "data": "pwd\n"},
            {"type": "resize", "cols": 100, "rows": 30},
        ],
    )
    await _run_with_release(
        websocket,
        channel,
        settings,
        until=lambda: "pwd\n" in channel.sent and channel.resizes == [(100, 30)],
    )

    assert websocket.accepted is True
    assert service.calls == [{"profile_id": "prof_1", "cols": 120, "rows": 40}]
    assert channel.sent[0] == "cd -- '/home/alice/project'\r"
    assert "pwd\n" in channel.sent
    assert channel.resizes == [(100, 30)]
    outputs = "".join(frame["data"] for frame in websocket.frames("output"))
    assert "素问 Suwen SSH 终端" in outputs
    assert "alice@node" in outputs
    exits = websocket.frames("exit")
    assert exits and exits[-1]["code"] == -1
    assert channel.closed is True
    assert websocket.closed is True


async def test_ssh_terminal_resize_nested_payload(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = FakeSSHChannel()
    _install(monkeypatch, FakeConnectionService(channel=channel))
    websocket = FakeWebSocket(
        {"profile_id": "prof_1"},
        messages=[
            {"type": "resize", "data": {"cols": 90, "rows": 22}},
            {"type": "close"},
        ],
    )
    await _run_with_release(websocket, channel, settings)
    assert channel.resizes == [(90, 22)]


async def test_ssh_terminal_emits_pty_fallback_diagnostic(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel = FakeSSHChannel(diagnostic="PTY 不可用，已回退到 exec_command(get_pty=True)")
    _install(monkeypatch, FakeConnectionService(channel=channel))
    websocket = FakeWebSocket({"profile_id": "prof_1"}, messages=[{"type": "close"}])
    await _run_with_release(websocket, channel, settings)
    diagnostics = websocket.frames("diagnostic")
    assert diagnostics
    assert diagnostics[0]["code"] == "pty_fallback"
    assert "PTY 不可用" in diagnostics[0]["message"]


async def test_ssh_terminal_connect_failure_is_diagnostic(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install(monkeypatch, FakeConnectionService(error=RuntimeError("SSH 认证失败：密码不正确")))
    websocket = FakeWebSocket({"profile_id": "prof_1"})
    await asyncio.wait_for(terminal_module.run_terminal(websocket, settings), timeout=5.0)
    diagnostics = websocket.frames("diagnostic")
    assert diagnostics and diagnostics[0]["code"] == "terminal_connect_failed"
    assert "认证失败" in diagnostics[0]["message"]
    exits = websocket.frames("exit")
    assert exits and exits[-1]["code"] == -1
    assert websocket.closed is True


async def test_terminal_dispatch_without_profile_uses_local(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_local(websocket, settings):  # type: ignore[no-untyped-def]
        calls.append(("local", "", ""))

    async def fake_ssh(websocket, settings, profile_id, cwd):  # type: ignore[no-untyped-def]
        calls.append(("ssh", profile_id, cwd))

    monkeypatch.setattr(terminal_module, "_run_local_terminal", fake_local)
    monkeypatch.setattr(terminal_module, "_run_ssh_terminal", fake_ssh)

    await terminal_module.run_terminal(FakeWebSocket({}), settings)
    await terminal_module.run_terminal(
        FakeWebSocket({"profile_id": "prof_2", "cwd": "/data"}),
        settings,
    )
    assert calls == [("local", "", ""), ("ssh", "prof_2", "/data")]


def test_resize_value_parsing() -> None:
    assert terminal_module._resize_value({"type": "resize", "cols": 80, "rows": 24}) == (80, 24)
    assert terminal_module._resize_value({"type": "resize", "data": {"cols": 90, "rows": 30}}) == (90, 30)
    assert terminal_module._resize_value({"type": "resize"}) == (None, None)
    assert terminal_module._resize_value({"type": "resize", "cols": 0, "rows": 10}) == (None, None)
    assert terminal_module._resize_value({"type": "resize", "cols": 9999, "rows": 9999}) == (500, 200)


def test_query_int_clamps(settings: Settings) -> None:
    websocket = FakeWebSocket({"cols": "9999", "rows": "bad"})
    assert terminal_module._query_int(websocket, "cols", 100, 20, 500) == 500
    assert terminal_module._query_int(websocket, "rows", 30, 5, 200) == 30


def test_shell_command_is_available(settings: Settings) -> None:
    executable, args, label = terminal_module._shell_command()
    assert executable
    assert isinstance(args, list)
    assert label
