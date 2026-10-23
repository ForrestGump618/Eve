"""Build and query the function registry index.

The index is produced in a *separate* subprocess using the configured kernel
interpreter, which keeps the server process free of heavyweight imports such as
``scanpy`` or ``torch``. Each package contributes its public top-level
functions and classes with signature and docstring summary.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from omicslab.config import ConfigError, Settings
from omicslab.utils import atomic_write_text

logger = logging.getLogger(__name__)

DEFAULT_PACKAGES: tuple[str, ...] = (
    "numpy",
    "pandas",
    "scipy",
    "sklearn",
    "statsmodels",
    "matplotlib",
    "seaborn",
    "scanpy",
    "anndata",
    "omicverse",
    "lifelines",
    "gseapy",
    "pydeseq2",
    "flowio",
    "flowkit",
    "rdkit",
    "squidpy",
    "harmonypy",
    "bio",
    "plotly",
    "networkx",
    "umap",
    "leidenalg",
)

MAX_ENTRIES_PER_PACKAGE = 520
REFRESH_TIMEOUT_S = 300

# Executed in the kernel interpreter; must stay self-contained (no omicslab
# imports) because that interpreter may be a different environment.
_INTROSPECT_SCRIPT = r"""
import importlib
import inspect
import json
import sys

MAX_ENTRIES = {max_entries}


def _summarize(doc):
    if not doc:
        return ""
    lines = [line.strip() for line in doc.strip().splitlines() if line.strip()]
    return " ".join(lines)[:220]


def _signature(obj):
    try:
        return str(inspect.signature(obj))
    except (ValueError, TypeError, RuntimeError):
        return ""


def _entries(package_name):
    try:
        module = importlib.import_module(package_name)
    except Exception as exc:  # noqa: BLE001 - report import failure verbatim
        return None, "", "{}: {}".format(type(exc).__name__, exc)
    version = ""
    try:
        version = str(getattr(module, "__version__", "") or "")
    except Exception:  # noqa: BLE001
        version = ""
    items = []
    root = package_name.split(".")[0]
    for name in dir(module):
        if name.startswith("_"):
            continue
        try:
            obj = getattr(module, name)
        except Exception:  # noqa: BLE001 - descriptors may raise on access
            continue
        if inspect.isclass(obj):
            kind = "class"
        elif callable(obj) and not inspect.ismodule(obj):
            # numpy exposes many callables as ufunc / ArrayFunctionDispatcher
            # objects rather than plain Python functions; treat them as callable
            # functions so ``mean``/``dot``-style APIs stay discoverable.
            kind = "function"
        else:
            continue
        declared = getattr(obj, "__module__", "") or ""
        if declared and not str(declared).startswith(root):
            continue
        doc = inspect.getdoc(obj) or ""
        items.append(
            {{
                "name": name,
                "qualname": package_name + "." + name,
                "module": declared or package_name,
                "kind": kind,
                "signature": _signature(obj),
                "summary": _summarize(doc),
                "package": package_name,
                "package_version": version,
                "docstring": doc[:800],
            }}
        )
        if len(items) >= MAX_ENTRIES:
            break
    items.sort(key=lambda item: (item["kind"] != "function", item["name"].lower()))
    return items, version, ""


def main():
    packages = json.loads(sys.argv[1])
    out_path = sys.argv[2]
    items = []
    modules = []
    missing = []
    errors = {{}}
    for package in packages:
        found, version, error = _entries(package)
        if found is None:
            missing.append(package)
            errors[package] = error
            continue
        items.extend(found)
        modules.append({{"name": package, "version": version, "count": len(found)}})
    payload = {{"items": items, "modules": modules, "missing": missing, "errors": errors}}
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    print("ok")


main()
""".replace("{{", "{").replace("}}", "}").replace("{max_entries}", str(MAX_ENTRIES_PER_PACKAGE))


class RegistryError(RuntimeError):
    """Raised when the registry index cannot be built or read."""


class RegistryIndex:
    """Manage a searchable index of scientific Python APIs."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    # ------------------------------------------------------------------ paths
    @property
    def index_path(self) -> Path:
        return self.settings.registry_dir / "index.json"

    # ------------------------------------------------------------------ build
    def refresh(self, packages: Iterable[str] | None = None) -> dict[str, Any]:
        """Re-introspect the requested packages and persist the index."""
        requested = [str(name).strip() for name in (packages or DEFAULT_PACKAGES)]
        requested = [name for name in requested if name]
        if not requested:
            raise RegistryError("未指定要扫描的包")
        self.settings.registry_dir.mkdir(parents=True, exist_ok=True)
        self.settings.tmp_dir.mkdir(parents=True, exist_ok=True)
        out_path = self.settings.tmp_dir / "registry-introspect.json"
        if out_path.exists():
            out_path.unlink()
        try:
            interpreter = self.settings.resolve_kernel_python()
        except ConfigError as exc:
            raise RegistryError(f"内核解释器不可用：{exc}") from exc
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env.setdefault("MPLBACKEND", "Agg")
        command = [interpreter, "-c", _INTROSPECT_SCRIPT, json.dumps(requested), str(out_path)]
        try:
            completed = subprocess.run(
                command,
                cwd=str(self.settings.workspace),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=REFRESH_TIMEOUT_S,
            )
        except FileNotFoundError as exc:
            raise RegistryError(f"找不到内核解释器：{interpreter}") from exc
        except subprocess.TimeoutExpired as exc:
            raise RegistryError(f"函数索引构建超时（>{REFRESH_TIMEOUT_S}s）") from exc
        if completed.returncode != 0 or not out_path.is_file():
            tail = (completed.stderr or completed.stdout or "").strip()[-1200:]
            raise RegistryError(f"函数索引构建失败：{tail or '子进程无输出'}")
        try:
            payload = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RegistryError(f"无法读取索引结果：{exc}") from exc
        finally:
            try:
                out_path.unlink()
            except OSError:
                pass

        items = payload.get("items") or []
        modules = payload.get("modules") or []
        missing = payload.get("missing") or []
        errors = payload.get("errors") or {}
        for entry in items:
            entry.setdefault("package_version", "")
        index = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "python": interpreter,
            "requested_packages": requested,
            "modules": modules,
            "missing_packages": missing,
            "errors": errors,
            "items": items,
            "stats": {
                "items": len(items),
                "modules": len(modules),
                "functions": sum(1 for item in items if item.get("kind") == "function"),
                "classes": sum(1 for item in items if item.get("kind") == "class"),
            },
        }
        atomic_write_text(self.index_path, json.dumps(index, ensure_ascii=False, indent=1))
        logger.info(
            "函数索引已更新：%d 项 / %d 个模块（缺失 %d）",
            len(items),
            len(modules),
            len(missing),
        )
        return self.stats() | {"missing_packages": missing, "errors": errors}

    # ------------------------------------------------------------------ read
    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            logger.warning("读取函数索引失败：%s", exc)
            return {}
        return data if isinstance(data, dict) else {}

    def exists(self) -> bool:
        return self.index_path.is_file()

    def ensure(self, packages: Iterable[str] | None = None) -> dict[str, Any]:
        """Build the index when it is missing; otherwise return its stats."""
        if not self.exists():
            return self.refresh(packages)
        return self.stats()

    def stats(self) -> dict[str, Any]:
        data = self._read()
        stats = dict(data.get("stats") or {"items": 0, "modules": 0, "functions": 0, "classes": 0})
        stats["generated_at"] = data.get("generated_at", "")
        stats["missing_packages"] = data.get("missing_packages") or []
        return stats

    def modules(self) -> list[dict[str, Any]]:
        data = self._read()
        modules = data.get("modules") or []
        return [dict(module) for module in modules if isinstance(module, dict)]

    def get(self, qualname: str) -> dict[str, Any] | None:
        wanted = str(qualname or "").strip()
        if not wanted:
            return None
        data = self._read()
        lowered = wanted.lower()
        for item in data.get("items") or []:
            if str(item.get("qualname", "")).lower() == lowered:
                return dict(item)
        return None

    def search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        text = str(query or "").strip()
        if not text:
            return []
        try:
            limit = max(1, min(int(limit), 50))
        except (TypeError, ValueError):
            limit = 10
        tokens = [token for token in text.lower().replace("_", " ").split() if token]
        data = self._read()
        scored: list[tuple[float, dict[str, Any]]] = []
        for item in data.get("items") or []:
            haystack = " ".join(
                [
                    str(item.get("qualname", "")),
                    str(item.get("name", "")),
                    str(item.get("module", "")),
                    str(item.get("summary", "")),
                ]
            ).lower()
            if not all(token in haystack for token in tokens):
                continue
            name = str(item.get("name", "")).lower()
            qualname = str(item.get("qualname", "")).lower()
            score = 0.0
            if qualname == text.lower():
                score += 100.0
            if name == text.lower():
                score += 60.0
            for token in tokens:
                if name.startswith(token):
                    score += 24.0
                elif token in name:
                    score += 12.0
                if token in qualname:
                    score += 6.0
                if token in str(item.get("summary", "")).lower():
                    score += 3.0
            if item.get("kind") == "function":
                score += 2.0
            scored.append((score, dict(item)))
        scored.sort(key=lambda pair: (-pair[0], str(pair[1].get("qualname", "")).lower()))
        return [item for _score, item in scored[:limit]]
