"""WebSocket 终端桥：本地工作区 shell 与远端 SSH PTY 终端。

本地分支使用 ``subprocess.Popen`` + 读线程（Windows selector 事件循环不能直接
``asyncio.create_subprocess_exec``，cmd.exe 也没有 POSIX PTY）。

``/ws/terminal?profile_id=<id>`` 分支通过 :class:`ConnectionService` 打开
``paramiko`` 的 ``invoke_shell()`` 真 PTY：支持 resize、Ctrl+C、持续 cwd 与
交互 stdin。PTY 不可用时 manager 会回退为 ``exec_command(..., get_pty=True)``，
本模块把该回退以 ``diagnostic`` 帧告知前端。消息格式见 CONTRACTS-3 §6。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import threading
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from ..config import Settings

_READ_CHUNK = 4096
_SSH_READ_CHUNK = 65536
_QUEUE_MAX = 1024
_SSH_POLL_INTERVAL = 0.02


def _shell_command() -> tuple[str, list[str], str]:
    """Return (executable, args, display name) for the platform."""
    if os.name == "nt":
        for candidate in ("pwsh.exe", "pwsh", "powershell.exe", "powershell"):
            found = shutil.which(candidate)
            if found:
                label = "PowerShell 7" if "pwsh" in os.path.basename(found).lower() else "Windows PowerShell"
                return found, ["-NoLogo", "-NoProfile", "-Command", "-"], label
        return os.environ.get("COMSPEC", "cmd.exe"), ["/Q"], "cmd.exe"
    shell = os.environ.get("SHELL") or "/bin/bash"
    return shell, ["-i"] if "bash" in shell else [], os.path.basename(shell)


def _spawn_shell(settings: Settings) -> tuple[subprocess.Popen[bytes], str]:
    executable, args, label = _shell_command()
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        [executable, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(settings.workspace),
        env=env,
        bufsize=0,
    )
    return process, label


def _query_int(websocket: WebSocket, name: str, default: int, low: int, high: int) -> int:
    raw = websocket.query_params.get(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


async def _send_diagnostic(websocket: WebSocket, code: str, message: str) -> None:
    try:
        await websocket.send_json({"type": "diagnostic", "code": code, "message": message})
    except Exception:  # pragma: no cover - client already gone
        pass


async def _close_quietly(websocket: WebSocket) -> None:
    try:
        await websocket.close()
    except Exception:
        pass


async def run_terminal(websocket: WebSocket, settings: Settings) -> None:
    """Bridge a WebSocket to either a local shell or a remote SSH PTY."""
    await websocket.accept()
    profile_id = str(websocket.query_params.get("profile_id") or "").strip()
    cwd = str(websocket.query_params.get("cwd") or "").strip()
    if profile_id:
        await _run_ssh_terminal(websocket, settings, profile_id, cwd)
    else:
        await _run_local_terminal(websocket, settings)


# ---------------------------------------------------------------------------
# 本地终端（行为保持不变）
# ---------------------------------------------------------------------------
async def _run_local_terminal(websocket: WebSocket, settings: Settings) -> None:
    try:
        process, label = _spawn_shell(settings)
    except Exception as exc:  # pragma: no cover - environment dependent
        await websocket.send_json({"type": "output", "data": f"无法启动终端：{exc}\r\n"})
        await websocket.send_json({"type": "exit", "code": -1})
        await _close_quietly(websocket)
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_MAX)

    def _push(item: Any) -> None:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:  # pragma: no cover - slow client
            pass

    def _reader() -> None:
        stream = process.stdout
        try:
            while True:
                chunk = stream.read(_READ_CHUNK) if stream is not None else b""
                if not chunk:
                    break
                loop.call_soon_threadsafe(_push, {"type": "output", "data": chunk.decode("utf-8", "replace")})
        except Exception:  # pragma: no cover - shutdown race
            pass
        finally:
            try:
                code: int | None = process.wait(timeout=5)
            except Exception:  # pragma: no cover
                code = None
            loop.call_soon_threadsafe(_push, {"type": "exit", "code": int(code or 0)})
            loop.call_soon_threadsafe(_push, None)

    thread = threading.Thread(target=_reader, name="omicslab-terminal-reader", daemon=True)
    thread.start()

    await websocket.send_json(
        {"type": "output", "data": f"素问 Suwen 终端 · {label}\r\n工作区：{settings.workspace}\r\n"}
    )

    async def pump_output() -> None:
        while True:
            item = await queue.get()
            if item is None:
                break
            try:
                await websocket.send_json(item)
            except Exception:
                break
            if item.get("type") == "exit":
                break

    async def pump_input() -> None:
        while True:
            try:
                message = await websocket.receive_json()
            except (WebSocketDisconnect, RuntimeError):
                break
            mtype = message.get("type")
            if mtype == "input":
                data = str(message.get("data") or "").encode("utf-8", "replace")

                def _write(payload: bytes = data) -> None:
                    stream = process.stdin
                    if stream is None or process.poll() is not None:
                        return
                    try:
                        stream.write(payload)
                        stream.flush()
                    except Exception:  # pragma: no cover - process gone
                        pass

                await asyncio.to_thread(_write)
            elif mtype == "resize":
                continue  # pipe-backed shell cannot resize; acked for UI symmetry
            elif mtype in ("close", "exit"):
                break

    out_task = asyncio.create_task(pump_output(), name="omicslab-terminal-out")
    in_task = asyncio.create_task(pump_input(), name="omicslab-terminal-in")
    try:
        await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (out_task, in_task):
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if process.poll() is None:
            try:
                process.terminate()
            except Exception:
                pass
            try:
                await asyncio.to_thread(process.wait, 3)
            except Exception:  # pragma: no cover
                try:
                    process.kill()
                except Exception:
                    pass
        try:
            await asyncio.to_thread(thread.join, 2)
        except Exception:  # pragma: no cover - defensive
            pass
        await _close_quietly(websocket)


# ---------------------------------------------------------------------------
# SSH PTY 终端（F09：远端交互会话，持续 cwd / resize / Ctrl+C）
# ---------------------------------------------------------------------------
def _resize_value(message: dict[str, Any]) -> tuple[int | None, int | None]:
    data = message.get("data")
    payload = data if isinstance(data, dict) else message
    try:
        cols = int(payload.get("cols"))
        rows = int(payload.get("rows"))
    except (TypeError, ValueError, AttributeError):
        return None, None
    if cols <= 0 or rows <= 0:
        return None, None
    return min(500, cols), min(200, rows)


async def _run_ssh_terminal(
    websocket: WebSocket,
    settings: Settings,
    profile_id: str,
    cwd: str,
) -> None:
    from ..ssh.connections import get_connection_service

    cols = _query_int(websocket, "cols", 100, 20, 500)
    rows = _query_int(websocket, "rows", 30, 5, 200)
    service = get_connection_service(settings)
    try:
        channel = await asyncio.to_thread(
            service.open_terminal,
            profile_id,
            cols=cols,
            rows=rows,
        )
    except Exception as exc:
        message = f"无法打开远端终端：{exc}"
        await websocket.send_json({"type": "output", "data": message + "\r\n"})
        await _send_diagnostic(websocket, "terminal_connect_failed", message)
        await websocket.send_json({"type": "exit", "code": -1})
        await _close_quietly(websocket)
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_MAX)
    stop = threading.Event()

    def _push(item: Any) -> None:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:  # pragma: no cover - slow client
            pass

    diagnostic = str(getattr(channel, "diagnostic", "") or "")
    if diagnostic:
        await _send_diagnostic(websocket, "pty_fallback", diagnostic)

    if cwd:
        try:
            await asyncio.to_thread(channel.send, f"cd -- {cwd!r}\r")
        except Exception as exc:  # pragma: no cover - channel may reject
            await _send_diagnostic(websocket, "cwd_failed", f"切换远端目录失败：{exc}")

    header = f"素问 Suwen SSH 终端 · 档案 {profile_id}\r\n"
    if cwd:
        header += f"远端工作目录：{cwd}\r\n"
    header += "提示：Ctrl+C 可用；输入 exit 退出。\r\n"
    await websocket.send_json({"type": "output", "data": header})

    def _reader() -> None:
        try:
            while not stop.is_set():
                data = channel.recv(_SSH_READ_CHUNK)
                if data:
                    # paramiko 返回 bytes；JSON 帧必须是 str（中文按 UTF-8 解码）。
                    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else str(data)
                    loop.call_soon_threadsafe(_push, {"type": "output", "data": text})
                    continue
                if not channel.is_active():
                    break
                time.sleep(_SSH_POLL_INTERVAL)
        except Exception as exc:  # pragma: no cover - transport race
            loop.call_soon_threadsafe(
                _push,
                {"type": "diagnostic", "code": "channel_error", "message": f"远端终端中断：{exc}"},
            )
        finally:
            loop.call_soon_threadsafe(_push, {"type": "exit", "code": -1})
            loop.call_soon_threadsafe(_push, None)

    thread = threading.Thread(target=_reader, name="omicslab-ssh-terminal-reader", daemon=True)
    thread.start()

    async def pump_output() -> None:
        while True:
            item = await queue.get()
            if item is None:
                break
            try:
                await websocket.send_json(item)
            except Exception:
                break
            if item.get("type") == "exit":
                break

    async def pump_input() -> None:
        while True:
            try:
                message = await websocket.receive_json()
            except (WebSocketDisconnect, RuntimeError):
                break
            mtype = message.get("type")
            if mtype == "input":
                data = str(message.get("data") or "")
                try:
                    await asyncio.to_thread(channel.send, data)
                except Exception as exc:  # pragma: no cover - channel gone
                    await _send_diagnostic(websocket, "channel_send_failed", f"远端终端写入失败：{exc}")
                    break
            elif mtype == "resize":
                c, r = _resize_value(message)
                if c is not None and r is not None:
                    try:
                        await asyncio.to_thread(channel.resize, c, r)
                    except Exception:  # pragma: no cover - PTY may be gone
                        pass
            elif mtype in ("close", "exit"):
                break

    out_task = asyncio.create_task(pump_output(), name="omicslab-ssh-terminal-out")
    in_task = asyncio.create_task(pump_input(), name="omicslab-ssh-terminal-in")
    try:
        await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        for task in (out_task, in_task):
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        try:
            await asyncio.to_thread(channel.close)
        except Exception:  # pragma: no cover - defensive
            pass
        try:
            await asyncio.to_thread(thread.join, 2)
        except Exception:  # pragma: no cover - defensive
            pass
        await _close_quietly(websocket)
