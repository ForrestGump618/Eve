"""Coalesce provider deltas before persistence, and settle runaway streams."""
from __future__ import annotations

import asyncio
import re
import time


class DegenerationDetector:
    def __init__(self):
        self.tail = ""

    def feed(self, delta: str) -> bool:
        # Character-level periodicity works even when every provider chunk is one token.
        self.tail = (self.tail + delta)[-4096:]
        compact = re.sub(r"\s+", " ", self.tail.lower())
        for width in range(1, min(160, len(compact) // 6) + 1):
            pattern = compact[-width:]
            if len(pattern * 6) >= 96 and compact.endswith(pattern * 6):
                return True
        return False


def split_block(buffer):
    """Keep a tail so a final token cannot become a separate timeline event."""
    cut = len(buffer)-16
    boundaries = list(re.finditer(r"[.!?。！？\n](?:\s|$)", buffer[:cut]))
    if boundaries and boundaries[-1].end() >= 16:
        cut = boundaries[-1].end()
    else:
        space = buffer.rfind(' ', 15, cut)
        if space >= 15:
            cut = space+1
    return buffer[:cut], buffer[cut:]


async def merged_stream(source, *, window: float = .12, idle: float = 30,
                        duration: float = 120, max_chars: int = 64_000,
                        cancel_event: asyncio.Event | None = None):
    """One outstanding anext; timer flushes never cancel the provider iterator.

    Bound idle time, total time and output independently of provider cooperation.
    All buffered tails flush at channel switches, metadata, errors and EOF.
    """
    iterator = source.__aiter__()
    pending = None
    cancellation = asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
    kind, buffer = "", ""
    started = last_input = last_flush = time.monotonic()
    detector = DegenerationDetector()
    chars = 0
    try:
        while True:
            now = time.monotonic()
            if cancellation is not None and cancellation.done():
                from .types import AgentCancelled
                raise AgentCancelled()
            stop = "stream_deadline" if now - started >= duration else "stream_idle" if now - last_input >= idle else ""
            if stop:
                if buffer:
                    yield {"type": kind, "delta": buffer}
                    buffer = ""
                yield {"type": "stream_stop", "reason": stop}
                return
            if pending is None:
                pending = asyncio.ensure_future(anext(iterator))
            waiters = {pending} | ({cancellation} if cancellation is not None else set())
            timeout = min(window, idle - (now-last_input), duration - (now-started))
            done, _ = await asyncio.wait(waiters, timeout=max(.001, timeout))
            if pending not in done:
                # A short single token waits for the next input rather than becoming its own event.
                if len(buffer.strip()) >= 32 and time.monotonic()-last_flush >= window:
                    block, buffer = split_block(buffer)
                    yield {"type": kind, "delta": block}
                    last_flush = time.monotonic()
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                pending = None
                break
            pending = None
            last_input = time.monotonic()
            etype = event.get("type")
            if etype not in {"text", "reasoning"}:
                if buffer:
                    yield {"type": kind, "delta": buffer}
                    buffer = ""
                yield event
                if etype == "done":
                    return  # Do not wait on a provider that keeps sending after done.
                continue
            delta = str(event.get("delta") or "")
            if not delta:
                continue
            chars += len(delta)
            if (etype == "reasoning" and detector.feed(delta)) or chars > max_chars:
                if buffer:
                    yield {"type": kind, "delta": buffer}
                    buffer = ""
                yield {"type": "stream_stop", "reason": "stream_degenerated" if chars <= max_chars else "stream_output_limit"}
                return
            if buffer and kind != etype:
                yield {"type": kind, "delta": buffer}
                buffer = ""
            kind = etype
            buffer += delta
            if len(buffer) >= 512 or (len(buffer.strip()) >= 32 and
                    (re.search(r"[.!?。！？\n](?:\s|$)", buffer) or last_input-last_flush >= window)):
                block, buffer = split_block(buffer)
                yield {"type": kind, "delta": block}
                last_flush = time.monotonic()
        if buffer:
            yield {"type": kind, "delta": buffer}
            buffer = ""
    except Exception:
        if buffer:
            yield {"type": kind, "delta": buffer}
            buffer = ""
        raise
    finally:
        # No unbounded await during cleanup, even for a misbehaving provider.
        tasks = [t for t in (pending, cancellation) if t is not None]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=.2)
            for task in tasks:
                if task.done() and not task.cancelled():
                    task.exception()
        close = getattr(iterator, "aclose", None)
        if close is not None and (pending is None or pending.done()):
            closing = asyncio.ensure_future(close())
            await asyncio.wait({closing}, timeout=.2)
            if not closing.done():
                closing.cancel()
            elif not closing.cancelled():
                closing.exception()
