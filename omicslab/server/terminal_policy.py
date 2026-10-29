"""Terminal transport limits and opt-in renderer-consumption flow control.

ack-v1 counts UTF-16 code units (JavaScript string.length), not UTF-8 bytes.
Only clients requesting the protocol receive sequence numbers or wait for ACKs.
"""
from __future__ import annotations

import asyncio
import queue
import threading
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class TerminalPolicy:
    cols: int = 100
    rows: int = 30
    min_cols: int = 20
    min_rows: int = 5
    max_cols: int = 500
    max_rows: int = 200
    queue_chunks: int = 64
    chunk_chars: int = 8192
    window_units: int = 131072
    # Exceeds Windows' coarse monotonic tick, so bursts can actually coalesce.
    coalesce_seconds: float = 0.016
    ack_timeout: float = 30.0
    send_timeout: float = 10.0
    producer_poll_seconds: float = 0.1
    thread_join_timeout: float = 2.0
    ssh_poll_seconds: float = 0.02
    input_chars: int = 65536


POLICY = TerminalPolicy()
FLOW_PROTOCOL = "ack-v1"


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


class TerminalOutput:
    """One bounded producer queue, one sender, and one cumulative ACK window."""

    def __init__(self, websocket: Any, stop: threading.Event, policy: TerminalPolicy = POLICY):
        self.websocket = websocket
        self.stop = stop
        self.policy = policy
        self.loop = asyncio.get_running_loop()
        self.queue: queue.Queue[dict[str, Any]] = queue.Queue(policy.queue_chunks)
        self.available = asyncio.Event()
        self.waiting = False
        self.enabled = websocket.query_params.get("flow") == FLOW_PROTOCOL
        self.sent = 0
        self.acked = 0
        self.credit = asyncio.Event()

    def ready_fields(self) -> dict[str, Any]:
        if not self.enabled:
            return {}
        return {"flow_control": {"protocol": FLOW_PROTOCOL, "unit": "utf16",
                                 "window": self.policy.window_units,
                                 "frame": self.policy.chunk_chars * 2}}

    def acknowledge(self, message: dict[str, Any]) -> None:
        seq = message.get("seq")
        if self.enabled and type(seq) is int and self.acked < seq <= self.sent:
            self.acked = seq
            self.credit.set()

    def push(self, item: dict[str, Any]) -> bool:
        """Block only the reader thread; a slow renderer must not drop PTY data."""
        if item["type"] == "output":
            text = item["data"]
            chunks = ({"type": "output", "data": text[i:i + self.policy.chunk_chars]}
                      for i in range(0, len(text), self.policy.chunk_chars))
        else:
            chunks = (item,)
        for chunk in chunks:
            if self.stop.is_set():
                return False
            while not self.stop.is_set():
                try:
                    self.queue.put(chunk, timeout=self.policy.producer_poll_seconds)
                    if self.waiting:
                        self.loop.call_soon_threadsafe(self.available.set)
                    break
                except queue.Full:
                    continue
            else:
                return False
        return not self.stop.is_set()

    async def _next(self) -> dict[str, Any]:
        self.waiting = True
        try:
            while True:
                self.available.clear()
                try:
                    return self.queue.get_nowait()
                except queue.Empty:
                    await self.available.wait()
        finally:
            self.waiting = False

    async def send(self, item: dict[str, Any]) -> None:
        await asyncio.wait_for(self.websocket.send_json(item), self.policy.send_timeout)

    async def _wait_credit(self, units: int = 0) -> None:
        limit = self.policy.window_units if units else 0
        if not self.enabled or self.sent - self.acked + units <= limit:
            return

        async def wait() -> None:
            while self.sent - self.acked + units > limit:
                self.credit.clear()
                await self.credit.wait()
        await asyncio.wait_for(wait(), self.policy.ack_timeout)

    async def _send_output(self, text: str) -> None:
        units = utf16_units(text)
        await self._wait_credit(units)
        frame: dict[str, Any] = {"type": "output", "data": text}
        if self.enabled:
            self.sent += units
            frame["seq"] = self.sent
        await self.send(frame)

    async def pump(self) -> None:
        pending = None
        try:
            while True:
                item = pending if pending is not None else await self._next()
                pending = None
                if item["type"] == "output":
                    parts = [item["data"]]
                    chars = len(parts[0])
                    deadline = self.loop.time() + self.policy.coalesce_seconds
                    while chars < self.policy.chunk_chars:
                        try:
                            item = self.queue.get_nowait()
                        except queue.Empty:
                            remaining = deadline - self.loop.time()
                            if remaining <= 0:
                                break
                            try:
                                item = await asyncio.wait_for(self._next(), remaining)
                            except asyncio.TimeoutError:
                                break
                        if item["type"] != "output" or chars + len(item["data"]) > self.policy.chunk_chars:
                            pending = item
                            break
                        parts.append(item["data"])
                        chars += len(item["data"])
                    await self._send_output("".join(parts))
                else:
                    if item["type"] == "exit":
                        await self._wait_credit()
                    await self.send(item)
                    if item["type"] == "exit":
                        return
        except asyncio.TimeoutError:
            await self.send({"type": "diagnostic", "code": "terminal_flow_timeout",
                             "message": "Terminal output stalled; reconnect to start a new session."})
            await self.send({"type": "exit", "code": -1})

    def clear(self) -> None:
        self.stop.set()
        while not self.queue.empty():
            self.queue.get_nowait()
