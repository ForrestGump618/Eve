"""OmicsLab 远端 Python worker（JSON-lines over stdin/stdout）。

由 :class:`omicslab.execution.ssh_backend.SSHExecutionBackend` 上传到远端工作区并
以 ``python -u worker.py`` 启动。它**不监听任何端口**，只通过 stdin/stdout 与 SSH
通道通信（CONTRACTS-3 §6 / 任务书 T06）。

请求（每行一个 JSON）::

    {"id": "1", "op": "execute_python", "code": "print(1)", "timeout_s": 30}
    {"id": "2", "op": "list_vars"}
    {"id": "3", "op": "var_detail", "name": "df"}
    {"id": "4", "op": "interrupt"}
    {"id": "5", "op": "shutdown"}

响应::

    {"id": "1", "ok": true, "status": "ok", "stdout": "1\n", "stderr": "",
     "result_repr": null, "images": [], "duration_ms": 12}

启动时先输出一行 ``{"type": "ready", "pid": ..., "python": ...}``。
命名空间在同一个 worker 进程内持久；``execute_python`` 的 stdout/stderr 与
matplotlib 图像都会被捕获并随响应返回（base64），避免污染协议流。
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import traceback
import types
from typing import Any

MAX_STDOUT_CHARS = 400_000
MAX_STDERR_CHARS = 120_000
MAX_IMAGES = 8
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_LIST_VARS = 300
MAX_REPR_CHARS = 800
WORKER_VERSION = "1.0"

_OUT = sys.stdout  # 保存原始 stdout；执行代码时 sys.stdout 会被临时替换
try:  # 远端 locale 可能不是 UTF-8，协议统一用 UTF-8 输出
    _OUT.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001 - 老版本/特殊流不支持 reconfigure
    pass
_SEND_LOCK = threading.Lock()
_NAMESPACE: dict[str, Any] = {"__name__": "__main__", "__builtins__": __builtins__}
_EXEC_LOCK = threading.RLock()
_CURRENT_CAPTURE: "_Capture | None" = None
_INTERRUPT = threading.Event()
_BUSY = threading.Event()


class WorkerError(RuntimeError):
    """可预期的请求错误（返回 ok=false 而不是崩溃）。"""


def _send(payload: dict[str, Any]) -> None:
    # ensure_ascii=True 让协议字节不依赖远端 locale（中文/表情均以 \uXXXX 传输）。
    text = json.dumps(payload, ensure_ascii=True, default=str)
    with _SEND_LOCK:
        _OUT.write(text + "\n")
        _OUT.flush()


def _truncate(text: str, limit: int) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    removed = len(text) - limit
    head = text[: limit // 2]
    tail = text[-limit // 2 :]
    return f"{head}\n...[已截断 {removed} 字符]...\n{tail}"


class _Capture(io.TextIOBase):
    """捕获执行期 stdout/stderr；写入只进内存，绝不污染协议流。"""

    def __init__(self, limit: int) -> None:
        self._parts: list[str] = []
        self._size = 0
        self._limit = limit
        self._lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, text: Any) -> int:  # type: ignore[override]
        data = str(text)
        with self._lock:
            if self._size < self._limit:
                self._parts.append(data)
                self._size += len(data)
        return len(data)

    def flush(self) -> None:
        return None

    def getvalue(self) -> str:
        with self._lock:
            return "".join(self._parts)


def _collect_images() -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    plt = None
    try:
        import matplotlib

        matplotlib.use("Agg", force=False)
        import matplotlib.pyplot as plt  # type: ignore[no-redef]
    except Exception:
        return images
    try:
        for index, number in enumerate(list(plt.get_fignums())[:MAX_IMAGES], 1):
            figure = plt.figure(number)
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", bbox_inches="tight", dpi=110)
            data = buffer.getvalue()
            if len(data) > MAX_IMAGE_BYTES:
                plt.close(figure)
                continue
            images.append(
                {
                    "name": f"figure_{index}.png",
                    "mime": "image/png",
                    "bytes": len(data),
                    "data_base64": base64.b64encode(data).decode("ascii"),
                }
            )
            plt.close(figure)
    except Exception:
        pass
    return images


def _run_code(code: str) -> dict[str, Any]:
    stdout_capture = _Capture(MAX_STDOUT_CHARS)
    stderr_capture = _Capture(MAX_STDERR_CHARS)
    state: dict[str, Any] = {"done": False, "error": "", "result": None}
    started = time.monotonic()
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout_capture, stderr_capture
    global _CURRENT_CAPTURE
    _CURRENT_CAPTURE = stdout_capture

    def _runner() -> None:
        try:
            if not isinstance(code, str) or not code.strip():
                raise WorkerError("code 不能为空")
            compiled = compile(code, "<omicslab-remote>", "exec")
            exec(compiled, _NAMESPACE)  # noqa: S102 - 远端 worker 的既定职责
            state["result"] = _NAMESPACE.get("_omicslab_result")
        except BaseException:  # noqa: BLE001 - 执行用户代码必须兜底
            state["error"] = traceback.format_exc()
        finally:
            state["done"] = True

    thread = threading.Thread(target=_runner, name="omicslab-worker-exec", daemon=True)
    thread.start()
    timeout = getattr(_run_code, "_timeout", None)
    thread.join(timeout)
    duration_ms = int((time.monotonic() - started) * 1000)
    timed_out = thread.is_alive()
    if not timed_out:
        sys.stdout, sys.stderr = old_stdout, old_stderr
        _CURRENT_CAPTURE = None
    images = _collect_images()
    result: dict[str, Any] = {
        "status": "timeout" if timed_out else ("error" if state["error"] else "ok"),
        "stdout": _truncate(stdout_capture.getvalue(), MAX_STDOUT_CHARS),
        "stderr": _truncate(stderr_capture.getvalue(), MAX_STDERR_CHARS),
        "duration_ms": duration_ms,
        "images": images,
        "error": _truncate(state["error"], MAX_STDERR_CHARS) if state["error"] else "",
        "interrupted": bool(_INTERRUPT.is_set()),
    }
    value = state.get("result")
    if value is not None:
        try:
            result["result_repr"] = _truncate(repr(value), MAX_REPR_CHARS)
        except Exception:
            result["result_repr"] = "<无法显示结果>"
    if timed_out:
        result["error"] = (
            f"执行超时：超过 {timeout:.0f} 秒仍未完成。远端代码可能仍在运行；"
            "请检查远端进程或使用中断/取消操作。"
        )
    return result


def _describe_value(name: str, value: Any) -> dict[str, Any]:
    try:
        text = _truncate(repr(value), MAX_REPR_CHARS)
    except Exception:
        text = "<无法显示>"
    info: dict[str, Any] = {
        "name": name,
        "type": type(value).__name__,
        "repr": text,
    }
    shape = getattr(value, "shape", None)
    if shape is not None:
        try:
            info["shape"] = [int(part) for part in shape]
        except Exception:
            pass
    try:
        info["length"] = len(value)
    except Exception:
        pass
    module = getattr(type(value), "__module__", "")
    if module:
        info["module"] = str(module)
    return info


def _list_vars() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for name, value in list(_NAMESPACE.items()):
        if name.startswith("_") or isinstance(value, types.ModuleType):
            continue
        items.append(_describe_value(name, value))
        if len(items) >= MAX_LIST_VARS:
            break
    return items


def _handle(op: str, request: dict[str, Any]) -> dict[str, Any]:
    if op in ("init", "ping", "hello"):
        return {
            "worker_version": WORKER_VERSION,
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "namespace_size": len(_NAMESPACE),
        }
    if op in ("execute_python", "execute"):
        code = request.get("code") or ""
        raw_timeout = request.get("timeout_s")
        try:
            timeout = float(raw_timeout) if raw_timeout not in (None, "") else None
        except (TypeError, ValueError):
            raise WorkerError("timeout_s 必须是数字") from None
        if timeout is not None and (timeout <= 0 or timeout > 3600):
            raise WorkerError("timeout_s 必须在 0 到 3600 秒之间")
        if _EXEC_LOCK.acquire(blocking=False) is False:
            raise WorkerError("worker 正在执行上一段代码，请稍后再试")
        try:
            _BUSY.set()
            _INTERRUPT.clear()
            _run_code._timeout = timeout  # type: ignore[attr-defined]
            return _run_code(code)
        finally:
            _BUSY.clear()
            _EXEC_LOCK.release()
    if op in ("list_vars", "list_variables"):
        return {"variables": _list_vars()}
    if op == "var_detail":
        name = str(request.get("name") or "").strip()
        if not name:
            raise WorkerError("缺少变量名 name")
        if name not in _NAMESPACE:
            raise WorkerError(f"变量不存在：{name}")
        return {"variable": _describe_value(name, _NAMESPACE[name])}
    if op == "interrupt":
        _INTERRUPT.set()
        if _BUSY.is_set():
            return {
                "interrupted": True,
                "note": "已请求中断；Python 线程无法强制终止，仍在运行的代码可能需要结束当前进程。",
            }
        return {"interrupted": True, "note": "当前没有正在执行的代码。"}
    if op == "shutdown":
        return {"shutdown": True}
    raise WorkerError(f"未知操作：{op}")


def main() -> int:
    _send(
        {
            "type": "ready",
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "worker_version": WORKER_VERSION,
        }
    )
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        try:
            request = json.loads(text)
        except (TypeError, ValueError):
            _send({"id": None, "ok": False, "error": "请求不是合法 JSON", "error_type": "ProtocolError"})
            continue
        if not isinstance(request, dict):
            _send({"id": None, "ok": False, "error": "请求必须是 JSON 对象", "error_type": "ProtocolError"})
            continue
        request_id = request.get("id")
        op = str(request.get("op") or "").strip()
        try:
            payload = _handle(op, request)
            response: dict[str, Any] = {"id": request_id, "ok": True}
            response.update(payload)
        except WorkerError as exc:
            response = {"id": request_id, "ok": False, "error": str(exc), "error_type": "WorkerError"}
        except BaseException as exc:  # noqa: BLE001 - 协议循环不能退出
            response = {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "error_type": "InternalError",
            }
        _send(response)
        if op == "shutdown":
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
