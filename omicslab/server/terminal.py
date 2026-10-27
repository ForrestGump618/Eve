"""WebSocket 终端桥：本地工作区 shell 与远端 SSH PTY 终端。

本地使用 ConPTY / POSIX PTY，远端使用 SSH PTY。阻塞读写在线程中进行。
工作区 ID 决定执行位置；SSH 连接失败禁止回退本地。

``/ws/terminal?profile_id=<id>`` 分支通过 :class:`ConnectionService` 打开
``paramiko`` 的 ``invoke_shell()`` 真 PTY：支持 resize、Ctrl+C、持续 cwd 与
交互 stdin。PTY 不可用时 manager 会回退为 ``exec_command(..., get_pty=True)``，
本模块把该回退以 ``diagnostic`` 帧告知前端。消息格式见 CONTRACTS-3 §6。
"""

from __future__ import annotations

import asyncio
import codecs
import shlex
import threading
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from ..config import Settings

_READ_CHUNK = 4096
_SSH_READ_CHUNK = 65536
_QUEUE_MAX = 1024
_SSH_POLL_INTERVAL = 0.02


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


async def run_terminal(websocket: WebSocket, settings: Settings, workspaces: Any = None) -> None:
    """Bridge a WebSocket to either a local shell or a remote SSH PTY."""
    await websocket.accept()
    profile_id = str(websocket.query_params.get("profile_id") or "").strip()
    cwd = str(websocket.query_params.get("cwd") or "").strip()
    workspace_id = str(websocket.query_params.get("workspace_id") or "").strip()
    if workspace_id:
        ws = workspaces.get(workspace_id) if workspaces is not None else None
        if ws is None:
            await _send_diagnostic(websocket, "workspace_missing", "工作区不存在，终端未启动")
            await _close_quietly(websocket)
            return
        if ws.backend == "ssh":
            profile_id = str(ws.remote.get("profile_id") or "")
            cwd = str(ws.remote.get("root") or "")
            if not profile_id:
                await _send_diagnostic(websocket, "remote_profile_missing", "SSH 工作区未绑定主机，禁止使用本地终端")
                await _close_quietly(websocket)
                return
        else:
            from dataclasses import replace
            settings = replace(settings, workspace=ws.root)
            profile_id = ""
    if profile_id:
        await _run_ssh_terminal(websocket, settings, profile_id, cwd)
    else:
        await _run_local_terminal(websocket, settings)


# ---------------------------------------------------------------------------
# 本地终端（行为保持不变）
# ---------------------------------------------------------------------------
async def _run_local_terminal(websocket: WebSocket, settings: Settings) -> None:
    from .terminal_process import ShellProcess
    try:
        cols = _query_int(websocket, "cols", 100, 20, 500)
        rows = _query_int(websocket, "rows", 30, 5, 200)
        shell = await asyncio.to_thread(ShellProcess, str(settings.workspace), cols, rows)
    except Exception as exc:
        await _send_diagnostic(websocket, "terminal_start_failed", f"终端启动失败：{exc}")
        await websocket.send_json({"type": "exit", "code": -1})
        await _close_quietly(websocket)
        return
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=64)
    stop = threading.Event()

    def push(item):
        future = asyncio.run_coroutine_threadsafe(queue.put(item), loop)
        try:
            future.result(timeout=5)
        except Exception:
            future.cancel()
            stop.set()

    def reader():
        try:
            while not stop.is_set():
                text = shell.read()
                if not text:
                    break
                push({"type": "output", "data": text})
        except EOFError:
            pass
        except Exception as exc:
            if not stop.is_set():
                push({"type": "diagnostic", "code": "pty_read_failed", "message": str(exc)})
        finally:
            if not stop.is_set():
                push({"type": "exit", "code": None})

    thread = threading.Thread(target=reader, name="eve-pty", daemon=True)
    thread.start()
    await websocket.send_json({"type": "ready", "shell": shell.label, "pty": True,
                               "cwd": str(settings.workspace), "pid": shell.pid})

    async def output():
        while True:
            item = await queue.get()
            await websocket.send_json(item)
            if item["type"] == "exit":
                return

    async def input_():
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "input":
                data = str(message.get("data") or "")
                if len(data) > 65536:
                    raise ValueError("终端输入超过 64KB")
                await asyncio.to_thread(shell.write, data)
            elif message.get("type") == "resize":
                cols, rows = _resize_value(message)
                if cols and rows:
                    await asyncio.to_thread(shell.resize, cols, rows)
            elif message.get("type") in {"close", "exit"}:
                return

    tasks = {asyncio.create_task(output()), asyncio.create_task(input_())}
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await asyncio.to_thread(shell.close)
        finally:
            await asyncio.to_thread(thread.join, 2)
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

    await websocket.send_json({"type": "ready", "shell": "SSH", "pty": not bool(getattr(channel, "diagnostic", "")), "cwd": cwd})
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_MAX)
    stop = threading.Event()

    def _push(item: Any) -> None:
        future = asyncio.run_coroutine_threadsafe(queue.put(item), loop)
        try:
            future.result(timeout=5)
        except Exception:
            future.cancel()
            stop.set()

    diagnostic = str(getattr(channel, "diagnostic", "") or "")
    if diagnostic:
        await _send_diagnostic(websocket, "pty_fallback", diagnostic)

    if cwd:
        try:
            await asyncio.to_thread(channel.send, f"cd -- {shlex.quote(cwd)}\r")
        except Exception as exc:  # pragma: no cover - channel may reject
            await _send_diagnostic(websocket, "cwd_failed", f"切换远端目录失败：{exc}")

    header = f"Eve SSH · 档案 {profile_id}\r\n"
    if cwd:
        header += f"远端工作目录：{cwd}\r\n"
    header += "提示：Ctrl+C 可用；输入 exit 退出。\r\n"
    await websocket.send_json({"type": "output", "data": header})

    def _reader() -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while not stop.is_set():
                data = channel.recv(_SSH_READ_CHUNK)
                if data:
                    # paramiko 返回 bytes；JSON 帧必须是 str（中文按 UTF-8 解码）。
                    text = decoder.decode(data) if isinstance(data, bytes) else str(data)
                    _push({"type": "output", "data": text})
                    continue
                if not channel.is_active():
                    break
                time.sleep(_SSH_POLL_INTERVAL)
        except Exception as exc:  # pragma: no cover - transport race
            _push({"type": "diagnostic", "code": "channel_error", "message": f"远端终端中断：{exc}"})
        finally:
            _push({"type": "exit", "code": None})
            _push(None)

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
