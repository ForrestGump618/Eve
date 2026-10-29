"""Burst, stalled-consumer, and lifecycle contracts for terminal transports."""
from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from types import SimpleNamespace

import pytest

from omicslab.config import Settings
from omicslab.server import terminal
from omicslab.server.terminal_policy import POLICY, TerminalOutput, utf16_units


class Socket:
    def __init__(self, flow=True):
        self.query_params = {"flow": "ack-v1"} if flow else {}
        self.frames = []
        self.incoming = asyncio.Queue()
        self.auto_ack = False
        self.closed = False
        self.peak_outstanding = 0
        self.output = None

    async def accept(self):
        pass

    async def send_json(self, frame):
        self.frames.append(frame)
        if "seq" in frame:
            if self.output:
                self.peak_outstanding = max(self.peak_outstanding, frame["seq"] - self.output.acked)
            if self.auto_ack:
                asyncio.get_running_loop().call_later(0.001, self.ack, frame["seq"])

    def ack(self, seq):
        if self.output:
            self.output.acknowledge({"seq": seq})
        else:
            self.incoming.put_nowait({"type": "ack", "seq": seq})

    async def receive_json(self):
        return await self.incoming.get()

    async def close(self):
        self.closed = True


async def until(predicate):
    async def wait():
        while not predicate():
            await asyncio.sleep(0.001)
    await asyncio.wait_for(wait(), 3)


@pytest.fixture
def burst():
    # Multi-megabyte output, ANSI fragments, BMP and astral Unicode; no real SSH.
    fragment = "\x1b[32mresearch \u7814\u7a76 \U0001f9ec\x1b[0m\r\n"
    return [fragment * (1 + i % 61) for i in range(5000)]


@pytest.mark.parametrize("flow", [True, False])
async def test_multimegabyte_burst_is_lossless_and_bounded(burst, flow):
    socket = Socket(flow)
    stop = threading.Event()
    output = socket.output = TerminalOutput(socket, stop)
    socket.auto_ack = True
    peak_queue = 0

    def produce():
        nonlocal peak_queue
        for text in burst:
            assert output.push({"type": "output", "data": text})
            peak_queue = max(peak_queue, output.queue.qsize())
        assert output.push({"type": "exit", "code": 0})

    producer = asyncio.create_task(asyncio.to_thread(produce))
    try:
        await asyncio.wait_for(output.pump(), 15)
        await producer
        frames = [frame for frame in socket.frames if frame["type"] == "output"]
        assert "".join(frame["data"] for frame in frames) == "".join(burst)
        assert len(frames) < len(burst) // 3
        assert peak_queue <= POLICY.queue_chunks
        assert all(utf16_units(frame["data"]) <= POLICY.chunk_chars * 2 for frame in frames)
        if flow:
            assert socket.peak_outstanding <= POLICY.window_units
            assert output.sent == output.acked == utf16_units("".join(burst))
        else:
            assert not output.ready_fields()
            assert all("seq" not in frame for frame in frames)
        assert socket.frames[-1] == {"type": "exit", "code": 0}
    finally:
        stop.set()
        await producer
        output.clear()


async def test_withheld_ack_pauses_producer_and_disposal_unblocks_it():
    policy = replace(POLICY, queue_chunks=2, chunk_chars=8, window_units=32,
                     coalesce_seconds=0, producer_poll_seconds=0.01)
    socket = Socket()
    stop = threading.Event()
    output = socket.output = TerminalOutput(socket, stop, policy)
    completed = 0

    def produce():
        nonlocal completed
        for _ in range(10000):
            if not output.push({"type": "output", "data": "abcdefgh"}):
                break
            completed += 1

    producer = asyncio.create_task(asyncio.to_thread(produce))
    pump = asyncio.create_task(output.pump())
    try:
        await until(lambda: output.sent == policy.window_units and output.queue.full())
        await asyncio.sleep(0.04)
        checkpoint = completed
        await asyncio.sleep(0.04)
        assert completed == checkpoint < 10
        assert output.sent - output.acked == policy.window_units
        # Bogus, future, duplicate and regressing ACKs cannot create credit.
        for seq in (-1, True, "32", 32.0, 33, None):
            output.acknowledge({"seq": seq})
        assert output.acked == 0
        output.acknowledge({"seq": 16})
        await until(lambda: output.sent == 48)
        output.acknowledge({"seq": 16})
        output.acknowledge({"seq": 8})
        assert output.acked == 16
    finally:
        stop.set()
        pump.cancel()
        await asyncio.gather(pump, return_exceptions=True)
        await asyncio.wait_for(producer, 1)
        output.clear()
    await asyncio.sleep(0)
    assert output.queue.empty()


async def test_ack_timeout_reports_failure_and_exit_waits_for_tail():
    policy = replace(POLICY, ack_timeout=0.03, coalesce_seconds=0)
    socket = Socket()
    output = TerminalOutput(socket, threading.Event(), policy)
    output.queue.put_nowait({"type": "output", "data": "tail\U0001f9ec"})
    output.queue.put_nowait({"type": "exit", "code": 0})
    pump = asyncio.create_task(output.pump())
    await until(lambda: output.sent > 0)
    assert not any(frame["type"] == "exit" for frame in socket.frames)
    await asyncio.wait_for(pump, 1)
    assert socket.frames[-2]["code"] == "terminal_flow_timeout"
    assert socket.frames[-1] == {"type": "exit", "code": -1}
    assert output.sent == 6


async def test_slow_websocket_send_has_bounded_timeout():
    socket = Socket(False)

    async def stalled(frame):
        await asyncio.Future()

    socket.send_json = stalled
    output = TerminalOutput(socket, threading.Event(), replace(POLICY, send_timeout=0.01))
    with pytest.raises(asyncio.TimeoutError):
        await output.send({"type": "ready"})


@pytest.mark.parametrize("remote", [False, True])
async def test_local_and_ssh_wiring_negotiate_ack_and_release_resources(tmp_path, monkeypatch, remote):
    socket = Socket()
    socket.auto_ack = True
    if remote:
        socket.query_params["profile_id"] = "remote-host"
    chunks = [b"\xe7\xa0", b"\x94\xe7\xa9\xb6\xf0\x9f\xa7\xac", b"\xe4"] if remote else ["local\U0001f9ec"]

    class Shell:
        label = "fixture PTY"
        pid = 123
        diagnostic = ""
        closed = False

        def read(self):
            return chunks.pop(0) if chunks else ""

        def recv(self, size):
            return chunks.pop(0) if chunks else b""

        def is_active(self):
            return False

        def close(self):
            self.closed = True

    shell = Shell()
    monkeypatch.setattr("omicslab.server.terminal_process.ShellProcess", lambda *args: shell)
    monkeypatch.setattr("omicslab.ssh.connections.get_connection_service",
                        lambda _: SimpleNamespace(open_terminal=lambda *args, **kwargs: shell))
    settings = Settings(workspace=tmp_path, home=tmp_path)
    await asyncio.wait_for(terminal.run_terminal(socket, settings), 3)
    ready = socket.frames[0]
    assert ready["flow_control"] == {"protocol": "ack-v1", "unit": "utf16",
                                     "window": POLICY.window_units, "frame": POLICY.chunk_chars * 2}
    outputs = [frame for frame in socket.frames if frame["type"] == "output"]
    text = "".join(frame["data"] for frame in outputs)
    assert ("\u7814\u7a76\U0001f9ec\ufffd" if remote else "local\U0001f9ec") in text
    assert outputs[-1]["seq"] == utf16_units(text)
    assert socket.frames[-1] == {"type": "exit", "code": None}
    assert socket.closed and shell.closed
    assert not any(thread.name in {"eve-pty", "omicslab-ssh-terminal-reader"} for thread in threading.enumerate())


@pytest.mark.parametrize("remote", [False, True])
async def test_ready_send_failure_still_closes_shell(tmp_path, monkeypatch, remote):
    socket = Socket()
    if remote:
        socket.query_params["profile_id"] = "host"
    closed = []
    shell = SimpleNamespace(label="fixture", pid=1, close=lambda: closed.append(True))
    monkeypatch.setattr("omicslab.server.terminal_process.ShellProcess", lambda *args: shell)
    monkeypatch.setattr("omicslab.ssh.connections.get_connection_service",
                        lambda _: SimpleNamespace(open_terminal=lambda *args, **kwargs: shell))

    async def fail(frame):
        raise RuntimeError("socket gone")

    socket.send_json = fail
    with pytest.raises(RuntimeError, match="socket gone"):
        await terminal.run_terminal(socket, Settings(workspace=tmp_path, home=tmp_path))
    assert closed == [True]
    assert socket.closed
