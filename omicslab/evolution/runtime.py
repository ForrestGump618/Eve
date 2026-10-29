"""Source-only process launch and filesystem checks for local experiments."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import site
from importlib.util import find_spec


def checked_path(value):
    path = Path(os.path.abspath(Path(value).expanduser()))
    for entry in (path, *path.parents):
        if entry.is_symlink() or (entry.exists() and
                getattr(entry.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('Symlinks and junctions are not supported')
    return path


def tree_files(root):
    root = checked_path(root)
    if not root.is_dir():
        raise ValueError('Required source directory is unavailable')
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in [*dirs, *names]:
            entry = checked_path(Path(directory) / name)
            if entry.is_file():
                if not stat.S_ISREG(entry.stat().st_mode) or entry.stat().st_nlink > 1:
                    raise ValueError('Only independent regular source files are supported')
                yield entry
        dirs[:] = [name for name in dirs if name not in {'.git', '__pycache__'}]


REQUIRED_NATIVE_FILES = (
    '__init__.py', 'config.py', 'utils.py', 'agent/__init__.py', 'agent/loop.py',
    'agent/tools.py', 'agent/types.py', 'agent/context.py', 'agent/skills.py',
    'agent/templates.py', 'agent/providers/__init__.py', 'session/store.py',
    'evolution/__init__.py', 'evolution/__main__.py', 'evolution/phase_worker.py',
    'evolution/proteus_adapter.py', 'evolution/runtime.py', 'data/evolution-policy.json',
)


def require_package(source_root):
    root = checked_path(source_root)
    package = checked_path(root / 'omicslab')
    for name in REQUIRED_NATIVE_FILES:
        path = checked_path(package / name)
        if not path.is_file():
            raise ValueError(f'Required native source file is unavailable: omicslab/{name}')
    return root


# This code is supplied by the controller, not loaded from the candidate. -I
# ignores PYTHONPATH/current-directory injection; the finder forbids fallback
# to an installed omicslab even when a candidate deletes a package/module.
BOOTSTRAP = r'''
import importlib.abc, importlib.machinery, pathlib, runpy, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
mode, args = sys.argv[2], sys.argv[3:]
class NativeOnly(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != 'omicslab' and not fullname.startswith('omicslab.'):
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, [str(root)] if path is None else path)
        if spec is None or spec.origin is None:
            raise ImportError('Required native module is missing: ' + fullname)
        origin = pathlib.Path(spec.origin).resolve()
        if not origin.is_relative_to(root / 'omicslab') or not origin.is_file():
            raise ImportError('Native import escaped source root: ' + fullname)
        return spec
sys.meta_path.insert(0, NativeOnly())
sys.path.insert(0, str(root))
import omicslab
if mode == 'pytest':
    import pytest
    class NoSkippedBaseline:
        skipped = False
        def pytest_runtest_logreport(self, report):
            if report.skipped: self.skipped = True
        def pytest_collectreport(self, report):
            if report.skipped: self.skipped = True
    plugin = NoSkippedBaseline()
    code = pytest.main(args, plugins=[plugin, 'pytest_asyncio.plugin'])
    raise SystemExit(code or (1 if plugin.skipped else 0))
sys.argv = [mode, *args]
runpy.run_module(mode, run_name='__main__', alter_sys=True)
'''


def dependency_roots(source_root):
    # Desktop --target installs are injected into the controller's sys.path,
    # not necessarily registered with site. Retain roots of resolved runtime
    # packages without forwarding arbitrary PYTHONPATH or the live source tree.
    roots = []
    for name in ('proteus', 'pytest', 'pytest_asyncio', 'fastapi', 'uvicorn', 'httpx',
                 'rich', 'yaml', 'jupyter_client', 'ipykernel', 'nbformat',
                 'multipart', 'prompt_toolkit', 'websockets', 'paramiko',
                 'winpty', 'keyring', 'qrcode'):
        spec = find_spec(name)
        if spec is None or not spec.origin or spec.origin in {'built-in', 'frozen'}:
            continue
        origin = checked_path(spec.origin)
        roots.append(origin.parent.parent if spec.submodule_search_locations is not None else origin.parent)
    roots.extend(Path(path) for path in [*site.getsitepackages(), site.getusersitepackages()])
    unique = []
    for root in roots:
        root = checked_path(root)
        if root != checked_path(source_root) and root.is_dir() and str(root) not in unique:
            unique.append(str(root))
    priority = {}
    for index, entry in enumerate(sys.path):
        if entry:
            priority.setdefault(os.path.normcase(os.path.abspath(entry)), index)
    return sorted(unique, key=lambda root: priority.get(os.path.normcase(root), len(sys.path)))


def source_command(source_root, module, *args):
    require_package(source_root)
    dependencies = dependency_roots(source_root)
    bootstrap = 'import sys; sys.path[:0] = ' + repr(dependencies) + '\n' + BOOTSTRAP
    return [sys.executable, '-I', '-B', '-c', bootstrap, str(source_root), module, *map(str, args)]


def resolve_source(home, source=None):
    if source is not None:
        return checked_path(source)
    config = checked_path(Path(home) / 'evolution' / 'config.json')
    if config.is_file():
        value = json.loads(config.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or set(value) != {'source_root'} or not isinstance(value['source_root'], str):
            raise ValueError('evolution/config.json must contain only a source_root path')
        if not Path(value['source_root']).is_absolute():
            raise ValueError('Evolution source_root must be an absolute path')
        return checked_path(value['source_root'])
    return checked_path(os.environ.get('EVE_RSI_SOURCE_ROOT') or Path(__file__).resolve().parents[2])
