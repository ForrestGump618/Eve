"""HTTP/WebSocket server package for OmicsLab.

The public entry point is :func:`create_app`.  Importing this package stays
light so submodules (``omicslab.server.state`` etc.) can be imported directly in
tests without building the whole application.
"""

from __future__ import annotations

from typing import Any

__all__ = ["create_app"]


def create_app(settings: Any = None) -> Any:
    """Build the FastAPI application (lazy import to keep package import cheap)."""

    from .app import create_app as _create_app

    return _create_app(settings)
