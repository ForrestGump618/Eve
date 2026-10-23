"""Async wrapper around a single Jupyter kernel.

Design notes
------------
* The kernel is serialized: all ``execute`` calls are guarded by an
  ``asyncio.Lock``.  ``interrupt`` and ``restart`` intentionally bypass the lock
  so the UI can stop a runaway cell.
* Every execute collects iopub messages until ``status: idle`` for the matching
  parent message id, so outputs cannot leak between calls.
* Matplotlib is configured with the inline backend during bootstrap; figures
  emitted as ``display_data`` are persisted into the workspace ``figures/``
  folder and returned as HTTP-visible URLs.
* Bootstrap code also installs two helper functions used by the variable
  inspector (``__omicslab_list_vars`` / ``__omicslab_var_detail``) so we never
  have to re-parse arbitrary user code with fragile string tricks.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import json
import logging
import os
import time
import uuid
from pathlib import Path
from queue import Empty
from typing import Any, Awaitable, Callable

from ..config import Settings

logger = logging.getLogger("omicslab.kernel")

EventSink = Callable[[dict[str, Any]], Awaitable[None]]

_MISSING = object()

_BOOTSTRAP_CODE = r"""
%matplotlib inline
import matplotlib_inline.backend_inline as _omicslab_inline
_omicslab_inline.InlineBackend.instance().figure_formats = {"png"}
_omicslab_inline.InlineBackend.instance().rc = {"figure.dpi": 130, "savefig.dpi": 200}
import warnings as _omicslab_warnings
_omicslab_warnings.filterwarnings("ignore")
import json as __omicslab_json

def __omicslab_var_info(_name, _val):
    import types as _t
    _info = {"name": _name, "type": type(_val).__name__}
    try:
        _info["repr"] = repr(_val)[:400]
    except Exception:
        _info["repr"] = "<unrepresentable>"
    try:
        _info["shape"] = [int(x) for x in _val.shape] if hasattr(_val, "shape") else None
    except Exception:
        _info["shape"] = None
    try:
        _info["size_bytes"] = int(_val.nbytes) if hasattr(_val, "nbytes") else None
    except Exception:
        _info["size_bytes"] = None
    _info["is_dataframe"] = bool(hasattr(_val, "columns") and hasattr(_val, "dtypes") and hasattr(_val, "head"))
    _info["is_anndata"] = bool(
        type(_val).__name__ == "AnnData"
        or (hasattr(_val, "obs") and hasattr(_val, "var") and hasattr(_val, "X"))
    )
    _info["is_array"] = bool(hasattr(_val, "shape") and hasattr(_val, "dtype"))
    return _info

def __omicslab_list_vars():
    import types as _t
    _skip = {"In", "Out", "get_ipython", "exit", "quit", "open", "display"}
    _items = []
    for _n in list(globals().keys()):
        if _n.startswith("__omicslab"):
            continue
        if _n.startswith("_") or _n in _skip:
            continue
        _v = globals().get(_n)
        if isinstance(_v, _t.ModuleType):
            continue
        try:
            _items.append(__omicslab_var_info(_n, _v))
        except Exception:
            continue
    _items.sort(key=lambda x: x["name"].lower())
    return __omicslab_json.dumps(_items, ensure_ascii=False, default=str)

def __omicslab_var_detail(_name):
    _g = globals()
    if _name not in _g:
        return __omicslab_json.dumps({"error": "变量不存在: " + str(_name)})
    _v = _g[_name]
    _d = __omicslab_var_info(_name, _v)
    try:
        _d["repr"] = repr(_v)[:4000]
    except Exception:
        _d["repr"] = "<unrepresentable>"
    try:
        if hasattr(_v, "dtypes"):
            _d["dtypes"] = {str(k): str(t) for k, t in list(_v.dtypes.items())[:80]}
    except Exception:
        pass
    try:
        if hasattr(_v, "columns"):
            _d["columns"] = [str(c) for c in list(_v.columns)[:80]]
    except Exception:
        pass
    try:
        if hasattr(_v, "head") and callable(getattr(_v, "head")):
            _d["head"] = __omicslab_json.loads(_v.head(12).to_json(orient="records", force_ascii=False))
    except Exception as _exc:
        _d["head_error"] = str(_exc)[:300]
    try:
        if hasattr(_v, "describe") and callable(getattr(_v, "describe")) and not _d.get("is_anndata"):
            _d["describe"] = __omicslab_json.loads(_v.describe(include="all").to_json(force_ascii=False))
    except Exception:
        pass
    try:
        if hasattr(_v, "obs") and hasattr(_v, "var"):
            _d["obs_columns"] = [str(c) for c in list(_v.obs.columns)[:80]]
            _d["var_columns"] = [str(c) for c in list(_v.var.columns)[:80]]
            _d["n_obs"] = int(_v.n_obs)
            _d["n_vars"] = int(_v.n_vars)
    except Exception:
        pass
    return __omicslab_json.dumps(_d, ensure_ascii=False, default=str)
"""


def _slug(text: str, limit: int = 40) -> str:
    keep = []
    for ch in text.lower():
        if ch.isalnum() or ch in "-_":
            keep.append(ch)
        elif ch in " .":
            keep.append("_")
    out = "".join(keep).strip("_")
    return (out[:limit] or "figure").strip("_")


class KernelService:
    """Owns one Jupyter kernel and exposes an awaitable execute API."""

    def __init__(self, settings: Settings, cwd: str | Path | None = None) -> None:
        self.settings = settings
        # Kernel working directory: one kernel per workspace scope shares the
        # workspace root so relative paths in cells hit the right files.
        self.cwd = Path(cwd).resolve() if cwd is not None else Path(settings.workspace).resolve()
        self._km: Any = None
        self._kc: Any = None
        self._lock = asyncio.Lock()
        self._start_lock = asyncio.Lock()
        self._running = False
        self._started_at: float | None = None
        self._pid: int | None = None
        self._python = str(settings.resolve_kernel_python())
        self._kernel_name = "omicslab"
        self._history: list[dict[str, Any]] = []
        self._counter = 0
        self._figure_counter = 0
        self._boot_error: str | None = None
        # executing context (set while a cell runs; used by interrupt)
        self._executing = False
        self._active_msg_id: str | None = None

    # ------------------------------------------------------------------ status

    @property
    def running(self) -> bool:
        return self._running

    @property
    def python(self) -> str:
        return self._python

    @property
    def history(self) -> list[dict[str, Any]]:
        return list(self._history)

    @property
    def boot_error(self) -> str | None:
        return self._boot_error

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "python": self._python,
            "pid": self._pid,
            "started_at": self._started_at,
            "kernel_name": self._kernel_name,
            "execution_count": self._counter,
            "boot_error": self._boot_error,
        }

    # ------------------------------------------------------------- lifecycle

    def _kernel_spec(self) -> Any:
        from jupyter_client.kernelspec import KernelSpec

        argv = [
            self._python,
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ]
        env = {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "OMICSLAB_WORKSPACE": str(self.cwd),
            "MPLBACKEND": "module://matplotlib_inline.backend_inline",
        }
        try:
            return KernelSpec(
                argv=argv,
                display_name="素问 Suwen Python",
                language="python",
                env=env,
            )
        except TypeError:  # pragma: no cover - very old jupyter_client
            return KernelSpec(argv, "素问 Suwen Python", "python", env)

    def _make_manager(self) -> Any:
        from jupyter_client.manager import AsyncKernelManager

        spec = self._kernel_spec()

        class _SpecKernelManager(AsyncKernelManager):
            def get_kernel_spec(self, kernel_name: str | None = None):  # noqa: D401
                return spec

        km = _SpecKernelManager(kernel_name=self._kernel_name)
        # ``AsyncKernelManager.start_kernel`` uses the cached ``_kernel_spec`` and
        # only falls back to the on-disk kernelspec manager (which does not know
        # our synthetic "omicslab" spec).  Pre-seeding it keeps startup offline.
        km._kernel_spec = spec
        return km

    async def start(self) -> None:
        async with self._start_lock:
            if self._running:
                return
            self.settings.ensure_dirs()
            self._km = self._make_manager()
            # Keep IPython/Jupyter/matplotlib state inside the 素问 Suwen data dir so
            # the kernel never needs to write the (possibly read-only) user profile.
            runtime_dirs = {
                "IPYTHONDIR": self.settings.home / "ipython",
                "JUPYTER_RUNTIME_DIR": self.settings.home / "jupyter" / "runtime",
                "JUPYTER_DATA_DIR": self.settings.home / "jupyter" / "data",
                "MPLCONFIGDIR": self.settings.home / "matplotlib",
            }
            for directory in runtime_dirs.values():
                try:
                    directory.mkdir(parents=True, exist_ok=True)
                except Exception:  # pragma: no cover - best effort
                    pass
            # Keep the kernel connection file inside the 素问 Suwen data dir.
            # ``KernelManager`` otherwise derives it from ``jupyter_runtime_dir()``,
            # which may resolve to the current working directory (that leaked
            # ``tmp*.json`` files into the user's workspace after kernel start).
            try:
                conn_dir = runtime_dirs["JUPYTER_RUNTIME_DIR"]
                self._km.connection_file = str(
                    conn_dir / f"kernel-{os.getpid()}-{uuid.uuid4().hex[:8]}.json"
                )
            except Exception:  # pragma: no cover - best effort
                pass
            # Merge with the inherited environment instead of replacing it: a bare
            # env breaks venv/user-site resolution (and therefore ipykernel import).
            env = dict(os.environ)
            env.update({key: str(value) for key, value in runtime_dirs.items()})
            env.update(
                {
                    "PYTHONIOENCODING": "utf-8",
                    "OMICSLAB_WORKSPACE": str(self.cwd),
                    "MPLBACKEND": "module://matplotlib_inline.backend_inline",
                }
            )
            logger.info("starting kernel %s with %s", self._kernel_name, self._python)
            try:
                self.cwd.mkdir(parents=True, exist_ok=True)
            except Exception:  # pragma: no cover - best effort
                pass
            await self._km.start_kernel(cwd=str(self.cwd), env=env)
            self._kc = self._km.client()
            start = getattr(self._kc, "start_channels", None)
            if start is not None:
                res = start()
                if inspect.isawaitable(res):
                    await res
            wait = getattr(self._kc, "wait_for_ready", None)
            if wait is not None:
                res = wait(timeout=60)
                if inspect.isawaitable(res):
                    await res
            self._running = True
            self._started_at = time.time()
            await self._bootstrap()
            logger.info("kernel started (pid=%s)", self._pid)

    async def _bootstrap(self) -> None:
        self._boot_error = None
        try:
            pid_res = await self.execute(
                "import os as _omicslab_os\nprint('__OMICSLAB_PID__', _omicslab_os.getpid())",
                timeout_s=30,
                silent=True,
            )
            for out in pid_res.get("outputs") or []:
                if out.get("type") == "stream":
                    for line in str(out.get("text", "")).splitlines():
                        if line.startswith("__OMICSLAB_PID__"):
                            try:
                                self._pid = int(line.split()[1])
                            except Exception:
                                pass
            res = await self.execute(_BOOTSTRAP_CODE, timeout_s=90, silent=True)
            if not res.get("ok"):
                self._boot_error = res.get("error") or "bootstrap failed"
                logger.warning("kernel bootstrap error: %s", self._boot_error)
        except Exception as exc:  # pragma: no cover - defensive
            self._boot_error = str(exc)
            logger.warning("kernel bootstrap failed: %s", exc)

    async def stop(self) -> None:
        self._running = False
        kc, km = self._kc, self._km
        self._kc = None
        self._km = None
        try:
            if kc is not None:
                stop = getattr(kc, "stop_channels", None)
                if stop is not None:
                    res = stop()
                    if inspect.isawaitable(res):
                        await res
        except Exception:
            pass
        try:
            if km is not None:
                await asyncio.wait_for(km.shutdown_kernel(now=True), timeout=10)
        except Exception:
            pass
        self._pid = None

    async def restart(self) -> dict[str, Any]:
        async with self._lock:
            await self.stop()
            await self.start()
            self._counter = 0
            self._history.clear()
        return self.status()

    async def interrupt(self) -> bool:
        """Ask the kernel to raise KeyboardInterrupt in the running cell."""
        kc = self._kc
        if kc is None:
            return False
        try:
            control = getattr(kc, "control_channel", None)
            session = getattr(kc, "session", None)
            if control is not None and session is not None:
                msg = session.msg("interrupt_request", content={})
                res = control.send(msg)
                if inspect.isawaitable(res):
                    await res
                return True
        except Exception:
            pass
        try:
            km = self._km
            if km is not None:
                fn = getattr(km, "interrupt_kernel", None)
                if fn is not None:
                    res = fn()
                    if inspect.isawaitable(res):
                        await res
                    return True
        except Exception:
            pass
        return False

    # --------------------------------------------------------------- execute

    async def _get_iopub(self, timeout: float) -> dict[str, Any] | None:
        fut = self._kc.get_iopub_msg(timeout=timeout)
        if inspect.isawaitable(fut):
            return await fut
        return fut

    async def _get_shell(self, timeout: float) -> dict[str, Any] | None:
        fut = self._kc.get_shell_msg(timeout=timeout)
        if inspect.isawaitable(fut):
            return await fut
        return fut

    def _save_image(self, data: dict[str, Any]) -> dict[str, Any] | None:
        for mime, ext in (("image/png", ".png"), ("image/jpeg", ".jpg"), ("image/svg+xml", ".svg")):
            payload = data.get(mime)
            if not payload:
                continue
            try:
                if mime == "image/svg+xml":
                    raw = str(payload).encode("utf-8")
                else:
                    raw = base64.b64decode(payload)
            except Exception:
                continue
            digits = hashlib.sha256(raw).hexdigest()[:8]
            self._figure_counter += 1
            name = f"fig_{time.strftime('%Y%m%d_%H%M%S')}_{self._figure_counter:03d}_{digits}{ext}"
            path = self.settings.figures_dir / name
            try:
                path.write_bytes(raw)
            except Exception as exc:  # pragma: no cover
                logger.warning("failed to save figure %s: %s", name, exc)
                continue
            return {"name": name, "url": f"/api/figures/{name}", "mime": mime, "size": len(raw)}
        return None

    async def execute(
        self,
        code: str,
        timeout_s: float | None = None,
        silent: bool = False,
        emit: EventSink | None = None,
    ) -> dict[str, Any]:
        """Execute ``code`` on the kernel and collect structured outputs."""
        if not self._running or self._kc is None:
            await self.start()
        timeout = float(timeout_s if timeout_s is not None else self.settings.kernel_timeout_s)
        started = time.time()
        async with self._lock:
            outputs: list[dict[str, Any]] = []
            figures: list[dict[str, Any]] = []
            error_text: str | None = None
            interrupted = False
            msg_id: str | None = None
            try:
                msg_id = self._kc.execute(code or "", silent=silent, store_history=not silent)
            except Exception as exc:
                return {
                    "ok": False,
                    "outputs": [],
                    "figures": [],
                    "duration_ms": 0,
                    "error": f"无法提交代码到内核: {exc}",
                    "execution_count": self._counter,
                }
            self._active_msg_id = msg_id
            self._executing = True
            deadline = started + timeout
            try:
                while True:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        interrupted = True
                        error_text = f"执行超时（>{int(timeout)}s），已尝试中断内核。"
                        await self.interrupt()
                        break
                    try:
                        msg = await self._get_iopub(min(remaining, 5.0))
                    except Exception as exc:
                        if isinstance(exc, (asyncio.TimeoutError, TimeoutError, Empty)):
                            km = self._km
                            alive = True
                            try:
                                probe = km.is_alive() if km is not None else False
                                if inspect.isawaitable(probe):
                                    probe = await probe
                                alive = bool(probe)
                            except Exception:
                                # AsyncKernelManager keeps the awaitable helper
                                # private; fall back to it instead of guessing.
                                try:
                                    alive = bool(await km._async_is_alive()) if km is not None else False
                                except Exception:
                                    alive = True
                            if km is not None and not alive:
                                error_text = "内核进程已退出，请重启内核后重试。"
                                self._running = False
                                break
                            continue
                        # transient queue errors should not kill the run
                        logger.debug("iopub recv error: %s", exc)
                        continue
                    if msg is None:
                        continue
                    parent = (msg.get("parent_header") or {}).get("msg_id")
                    if parent != msg_id:
                        continue
                    mtype = msg.get("msg_type")
                    content = msg.get("content") or {}
                    if mtype == "status":
                        if content.get("execution_state") == "idle":
                            break
                        continue
                    if mtype == "stream":
                        name = content.get("name", "stdout")
                        text = content.get("text", "")
                        if outputs and outputs[-1].get("type") == "stream" and outputs[-1].get("name") == name:
                            outputs[-1]["text"] += text
                        else:
                            outputs.append({"type": "stream", "name": name, "text": text})
                        if emit is not None:
                            try:
                                await emit({"type": "kernel_stream", "data": {"name": name, "text": text}})
                            except Exception:
                                pass
                        continue
                    if mtype in ("execute_result", "display_data"):
                        data = content.get("data") or {}
                        image = self._save_image(data)
                        if image is not None:
                            figures.append(image)
                            outputs.append({"type": "image", **image})
                            if emit is not None:
                                try:
                                    await emit({"type": "figure", "data": image})
                                except Exception:
                                    pass
                        text = data.get("text/plain")
                        if text:
                            out_type = "result" if mtype == "execute_result" else "display"
                            outputs.append({"type": out_type, "text": text})
                        elif data.get("text/html") and image is None:
                            outputs.append({"type": "display", "text": str(data.get("text/html"))[:2000]})
                        continue
                    if mtype == "error":
                        tb = content.get("traceback") or []
                        ename = content.get("ename", "Error")
                        evalue = content.get("evalue", "")
                        error_text = f"{ename}: {evalue}"
                        outputs.append({"type": "error", "ename": ename, "evalue": evalue, "traceback": tb})
                        continue
                    if mtype == "clear_output":
                        outputs.clear()
                        continue
            finally:
                self._executing = False
                self._active_msg_id = None
            # drain shell reply (execution_count / error status)
            try:
                shell_msg = await asyncio.wait_for(self._get_shell(5.0), timeout=6.0)
                if shell_msg and (shell_msg.get("parent_header") or {}).get("msg_id") == msg_id:
                    sc = shell_msg.get("content") or {}
                    if sc.get("status") == "error" and not error_text:
                        error_text = f"{sc.get('ename', 'Error')}: {sc.get('evalue', '')}"
                    if isinstance(sc.get("execution_count"), int):
                        self._counter = sc["execution_count"]
            except Exception:
                pass
            if self._counter == 0:
                self._counter = len(self._history) + 1
            duration_ms = int((time.time() - started) * 1000)
            if not silent:
                self._history.append(
                    {
                        "code": code,
                        "outputs": outputs,
                        "figures": figures,
                        "duration_ms": duration_ms,
                        "ok": error_text is None and not interrupted,
                        "ts": time.time(),
                    }
                )
            return {
                "ok": error_text is None and not interrupted,
                "outputs": outputs,
                "figures": figures,
                "duration_ms": duration_ms,
                "error": error_text,
                "execution_count": self._counter,
                "interrupted": interrupted,
            }

    # ------------------------------------------------------------- utilities

    async def run_code_collect(self, code: str, timeout_s: float | None = None) -> str:
        """Execute code and return a single readable text blob (tool helper)."""
        res = await self.execute(code, timeout_s=timeout_s)
        parts: list[str] = []
        for out in res.get("outputs") or []:
            if out.get("type") == "stream":
                parts.append(out.get("text", ""))
            elif out.get("type") in ("result", "display"):
                parts.append(str(out.get("text", "")))
            elif out.get("type") == "error":
                parts.append("Traceback:\n" + "\n".join(out.get("traceback") or [str(out)]))
            elif out.get("type") == "image":
                parts.append(f"[图像已保存: {out.get('name')}]")
        if res.get("error"):
            parts.append(f"\n[错误] {res['error']}")
        text = "\n".join(p for p in parts if p)
        return text[:60000]

    async def _exec_json(self, code: str, timeout_s: float = 30.0) -> Any:
        res = await self.execute(code, timeout_s=timeout_s, silent=True)
        blob = ""
        for out in res.get("outputs") or []:
            if out.get("type") == "stream":
                blob += out.get("text", "")
            elif out.get("type") in ("result", "display"):
                blob += str(out.get("text", ""))
        if res.get("error") and not blob:
            raise RuntimeError(res["error"])
        data = blob.strip()
        if not data:
            return None
        # take the last line that parses as JSON
        for line in reversed(data.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except Exception:
                continue
        try:
            return json.loads(data)
        except Exception:
            return None

    async def list_vars(self) -> list[dict[str, Any]]:
        if not self._running:
            return []
        try:
            data = await self._exec_json("print(__omicslab_list_vars())")
        except Exception as exc:
            logger.warning("list_vars failed: %s", exc)
            return []
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        return []

    async def var_detail(self, name: str) -> dict[str, Any]:
        if not self._running:
            return {"error": "内核未运行"}
        safe = json.dumps(str(name))
        try:
            data = await self._exec_json(f"print(__omicslab_var_detail({safe}))", timeout_s=30.0)
        except Exception as exc:
            return {"name": name, "error": str(exc)}
        if not isinstance(data, dict):
            return {"name": name, "error": "无法解析变量详情"}
        return data

    # ---------------------------------------------------------- notebook io

    def build_notebook(self) -> dict[str, Any]:
        cells = []
        for entry in self._history:
            cells.append(
                {
                    "cell_type": "code",
                    "execution_count": None,
                    "metadata": {},
                    "outputs": self._nb_outputs(entry.get("outputs") or []),
                    "source": [line + "\n" for line in str(entry.get("code", "")).splitlines()],
                }
            )
        return {
            "cells": cells,
            "metadata": {
                "kernelspec": {"display_name": "素问 Suwen Python", "language": "python", "name": "omicslab"},
                "language_info": {"name": "python", "version": "3"},
            },
            "nbformat": 4,
            "nbformat_minor": 5,
        }

    @staticmethod
    def _nb_outputs(outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        nb: list[dict[str, Any]] = []
        for out in outputs:
            if out.get("type") == "stream":
                nb.append({"name": out.get("name", "stdout"), "output_type": "stream", "text": [out.get("text", "")]})
            elif out.get("type") in ("result", "display"):
                nb.append(
                    {
                        "data": {"text/plain": [str(out.get("text", ""))]},
                        "execution_count": None,
                        "metadata": {},
                        "output_type": "execute_result",
                    }
                )
            elif out.get("type") == "error":
                nb.append(
                    {
                        "ename": out.get("ename", "Error"),
                        "evalue": out.get("evalue", ""),
                        "output_type": "error",
                        "traceback": out.get("traceback") or [],
                    }
                )
        return nb
