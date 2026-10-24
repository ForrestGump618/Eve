"""Authenticated optional bridge to the separately licensed legacy workbench.

Only a caller-selected trusted source tree is imported. Application data and
the workspace use the explicit bridge home. A fresh home starts with mock
models and interactive approvals; it does not import old user configuration.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import socket
import sys
import threading


class BearerGateway:
    """Authenticate all HTTP and WebSocket paths before entering legacy code."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = ("Bearer " + token).encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            values = [value for name, value in scope.get("headers", ()) if name.lower() == b"authorization"]
            authorized = len(values) == 1 and hmac.compare_digest(values[0], self.expected)
            if not authorized:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4401, "reason": "Unauthorized"})
                else:
                    body = b'{"error":"Unauthorized"}'
                    await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b"Bearer"), (b"content-length", str(len(body)).encode())]})
                    await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


async def run(source: Path, home: Path, token: str, wire) -> None:
    # Source is trusted application code, never downloaded or supplied by model output.
    if not (source / "omicslab" / "server" / "__init__.py").is_file() or not (source / "omicslab" / "config.py").is_file():
        raise RuntimeError("Trusted legacy source package is unavailable")
    if home == source or home.is_relative_to(source):
        raise RuntimeError("Bridge home must be separate from its source package")
    home.mkdir(parents=True, exist_ok=True)
    workspace = home / "workspace"
    workspace.mkdir(exist_ok=True)
    for name, directory in {
        "OMICSLAB_HOME": home,
        "OMICSLAB_DATA_DIR": home,
        "IPYTHONDIR": home / "ipython",
        "JUPYTER_CONFIG_DIR": home / "jupyter" / "config",
        "JUPYTER_DATA_DIR": home / "jupyter" / "data",
        "JUPYTER_RUNTIME_DIR": home / "jupyter" / "runtime",
        "MPLCONFIGDIR": home / "matplotlib",
    }.items():
        directory.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(directory)
    sys.path.insert(0, str(source))
    from omicslab.config import load_settings
    from omicslab.server import create_app
    import uvicorn

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    settings = load_settings(workspace=workspace, home=home)
    settings.host = "127.0.0.1"
    settings.port = port
    if settings.provider == "auto":
        settings.provider = "mock"
        settings.model = "mock-model"
    settings.approval_policy = "ask"
    # No inherited model credentials or old notebook configuration are used.
    app = BearerGateway(create_app(settings), token)

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                wire.write(json.dumps({"port": port, "pid": os.getpid()}) + "\n")
                wire.flush()

    server = ReadyServer(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False, timeout_graceful_shutdown=5))
    loop = asyncio.get_running_loop()

    def request_stop():
        try:
            # EOF also stops the bridge if its owning desktop process dies.
            for line in sys.stdin:
                if line.strip() == "shutdown":
                    break
        finally:
            try:
                loop.call_soon_threadsafe(setattr, server, "should_exit", True)
            except RuntimeError:
                pass  # The event loop has already completed shutdown.

    threading.Thread(target=request_stop, name="suwen-legacy-control", daemon=True).start()
    try:
        await server.serve(sockets=[sock])
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--home", required=True)
    args = parser.parse_args()
    # Remove before imports or notebook children can inherit it. Never log token.
    token = os.environ.pop("SUWEN_BRIDGE_TOKEN", "")
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        sys.stderr.write("Legacy bridge authentication is not configured\n")
        return 2
    wire = sys.stdout
    sys.stdout = sys.stderr
    try:
        asyncio.run(run(Path(args.source).resolve(strict=True), Path(args.home).resolve(), token, wire))
        return 0
    except Exception:
        # Do not print private source/home paths, headers or arbitrary dependency errors.
        sys.stderr.write("Legacy bridge could not start; check Python dependencies and the trusted source package\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
