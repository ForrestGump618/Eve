"""Event-loop factory for the uvicorn server.

uvicorn's default ``auto`` factory forces ``ProactorEventLoop`` on Windows when
running without a subprocess.  The Proactor loop cannot provide ``add_reader``,
which the ZMQ kernel client relies on (it falls back to a slower tornado
selector thread and logs a warning).  OmicsLab always talks to a Jupyter kernel,
so the server prefers the selector loop on Windows.

A custom uvicorn ``--loop`` target is used verbatim as the loop factory passed to
``asyncio.Runner``, therefore this function returns a ready event loop instance.
"""

from __future__ import annotations

import asyncio
import sys


def selector_loop_factory(use_subprocess: bool = False) -> asyncio.AbstractEventLoop:
    """Return a new event loop compatible with the ZMQ kernel client."""

    if sys.platform == "win32" and not use_subprocess:
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


__all__ = ["selector_loop_factory"]
