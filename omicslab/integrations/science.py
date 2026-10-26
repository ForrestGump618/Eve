"""Standalone SuWen science NDJSON service; no AppState, AgentLoop or LLM.

Run: python -m omicslab.integrations.science --stdio --workspace PATH --home PATH
Python cells have the current user's permissions; this adapter is not a sandbox.
Skills are read by the DSH host, independently of this process.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any


OPS = {
    'status': (), 'literature.search': ('query', 'limit'),
    'protein.lookup': ('accession',), 'sequence.check': ('sequence',),
    'claim.record': ('statement', 'kind', 'sources', 'limitations', 'run'),
    'claim.verify': ('claim_id', 'metrics_path', 'rules'), 'claim.list': (),
    'experiment.record': ('name', 'dataset', 'protocol', 'metric', 'path', 'direction'),
    'experiment.compare': ('ids',), 'experiment.list': (),
    'knowledge.add': ('title', 'text', 'kind', 'source', 'locator'),
    'knowledge.index': ('path',), 'knowledge.search': ('query', 'limit', 'source'),
    'knowledge.list': (), 'python.execute': ('code', 'timeout_s', 'run'),
    'python.variables': (), 'python.interrupt': (), 'notebook.export': ('path',),
    'skills.list': (), 'skills.read': ('name',), 'shutdown': (),
}


class ScienceError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _text(params, name, default=None):
    value = params.get(name, default)
    if not isinstance(value, str) or (default is None and not value.strip()):
        raise ScienceError('invalid_params', f'{name} must be a nonempty string')
    return value


def _limit(params):
    value = params.get('limit', 5)
    if type(value) is not int or not 1 <= value <= 20:
        raise ScienceError('invalid_params', 'limit must be an integer from 1 to 20')
    return value


class _Config:
    def get(self, name, scope):
        if name == 'memory':
            return {'value': {'enabled': True, 'embedding': 'disabled',
                'retention_days': 365, 'auto_capture': False,
                'embedding_url': '', 'embedding_model': ''}}
        if name == 'models':
            return {'value': {'roles': {}, 'strategy': 'local'}}
        raise ScienceError('invalid_config', f'Unsupported config: {name}')


class _Platform:
    def __init__(self, workspace, home):
        from ..suwen.store import PlatformStore
        self.workspace = Path(workspace).expanduser().resolve(strict=True)
        if not self.workspace.is_dir():
            raise ScienceError('invalid_workspace', 'workspace must be an existing directory')
        self.home = Path(home).expanduser().resolve()
        self.scope = 'ws_' + hashlib.sha256(os.path.normcase(str(self.workspace)).encode()).hexdigest()[:24]
        self.store = PlatformStore(self.home)
        self.config = _Config()

    def require_workspace(self, scope):
        if scope != self.scope:
            raise ScienceError('invalid_workspace', 'workspace scope mismatch')
        return self.workspace

    def path(self, value):
        if not isinstance(value, str) or not value or '\x00' in value or '://' in value:
            raise ScienceError('invalid_path', 'path must be a local workspace path')
        candidate = Path(value).expanduser()
        resolved = (candidate if candidate.is_absolute() else self.workspace / candidate).resolve()
        if not resolved.is_relative_to(self.workspace):
            raise ScienceError('path_outside_workspace', 'path resolves outside workspace')
        return resolved

    async def backend(self, scope):
        self.require_workspace(scope)
        return self

    async def read_text(self, path, max_bytes=200000):
        target = self.path(path)
        with target.open('rb') as stream:
            data = stream.read(max_bytes + 1)
        return {'text': data[:max_bytes].decode('utf-8-sig'), 'truncated': len(data) > max_bytes}


class ScienceService:
    """Direct service adapter; kernel_factory is injectable for deterministic tests."""
    def __init__(self, workspace, home, kernel_factory=None):
        from ..suwen.biomedical import Biomedical
        from ..suwen.experiments import Experiments
        from ..suwen.knowledge import Knowledge
        self.platform = _Platform(workspace, home)
        self.scope = self.platform.scope
        self.bio = Biomedical(self.platform)
        self.knowledge = Knowledge(self.platform)
        self.experiments = Experiments(self.platform)
        self._kernel_factory = kernel_factory
        self._kernel = None
        self._execution_lock = asyncio.Lock()
        self._closed = False
        self.session = 'science_' + os.urandom(8).hex()

    def _get_kernel(self):
        if self._kernel is None:
            from ..kernel.manager import KernelService
            figures = self.platform.workspace / 'figures'
            def ensure_dirs():
                self.platform.home.mkdir(parents=True, exist_ok=True)
                figures.mkdir(parents=True, exist_ok=True)
            settings = SimpleNamespace(home=self.platform.home, workspace=self.platform.workspace,
                figures_dir=figures, kernel_timeout_s=120,
                resolve_kernel_python=lambda: sys.executable, ensure_dirs=ensure_dirs)
            self._kernel = (self._kernel_factory or KernelService)(settings, cwd=self.platform.workspace)
        return self._kernel

    async def dispatch(self, op, params=None):
        if self._closed:
            raise ScienceError('service_closed', 'science service is closed')
        if not isinstance(op, str) or op not in OPS:
            raise ScienceError('unknown_op', 'Unknown science operation')
        if params is None:
            params = {}
        if not isinstance(params, dict) or set(params) - set(OPS[op]):
            raise ScienceError('invalid_params', f'Allowed parameters for {op}: {", ".join(OPS[op]) or "none"}')
        p = params
        scope, store = self.scope, self.platform.store
        if op == 'status':
            return {'workspace': str(self.platform.workspace), 'scope': scope,
                'home': str(self.platform.home), 'kernel': self._kernel.status() if self._kernel else {'running': False},
                'ops': list(OPS), 'llm': False, 'embedding': False,
                'python_execution': 'explicit code; current user permissions; not sandboxed',
                'skills': 'read by host'}
        if op == 'literature.search':
            return await self.bio.literature(scope, _text(p, 'query'), _limit(p))
        if op == 'protein.lookup':
            return await self.bio.protein(scope, _text(p, 'accession'))
        if op == 'sequence.check':
            return self.bio.sequence(_text(p, 'sequence'))
        if op == 'claim.record':
            data = dict(p, statement=_text(p, 'statement'), kind=_text(p, 'kind'))
            sources = p.get('sources', [])
            if not isinstance(sources, list) or any(not isinstance(s, str) for s in sources):
                raise ScienceError('invalid_params', 'sources must be an array of source IDs')
            return self.bio.record_claim(scope, _text(p, 'run', self.session), data)
        if op == 'claim.verify':
            path = str(self.platform.path(_text(p, 'metrics_path')))
            return await self.bio.verify(scope, _text(p, 'claim_id'), path, p.get('rules'))
        if op in ('skills.list', 'skills.read'):
            from ..agent.skills import load_skills
            skills = load_skills(SimpleNamespace(workspace=self.platform.workspace))
            if op == 'skills.list':
                return {'items': [skills[name].to_dict() for name in sorted(skills)]}
            name = _text(p, 'name')
            skill = skills.get(name)
            if skill is None:
                raise ScienceError('not_found', f'未知技能：{name}')
            return {'skill': {**skill.to_dict(), 'body': skill.body}}
        if op.endswith('.list'):
            kind = {'claim.list': 'claim', 'experiment.list': 'experiment', 'knowledge.list': 'knowledge'}[op]
            return {'items': [{k: v for k, v in row.items() if k != 'vector'} for row in store.list(kind, scope)]}
        if op == 'experiment.record':
            data = dict(p, path=str(self.platform.path(_text(p, 'path'))))
            return await self.experiments.record(scope, data)
        if op == 'experiment.compare':
            return self.experiments.compare(scope, p.get('ids'))
        if op == 'knowledge.add':
            return await self.knowledge.add(scope, _text(p, 'title'), _text(p, 'text'),
                _text(p, 'kind', 'memory'), _text(p, 'source', ''), _text(p, 'locator', ''))
        if op == 'knowledge.index':
            path = self.platform.path(_text(p, 'path'))
            with path.open('rb') as stream:
                data = stream.read(10_000_001)
            return await self.knowledge.index(scope, str(path.relative_to(self.platform.workspace)), data)
        if op == 'knowledge.search':
            return {'items': await self.knowledge.search(scope, _text(p, 'query'), _limit(p), _text(p, 'source', ''))}
        if op == 'python.execute':
            code = _text(p, 'code')
            if len(code) > 200000:
                raise ScienceError('invalid_params', 'code exceeds 200000 characters')
            timeout = p.get('timeout_s', 120)
            if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 3600:
                raise ScienceError('invalid_params', 'timeout_s must be finite and in (0, 3600]')
            run = _text(p, 'run', self.session)
            async with self._execution_lock:
                started = time.time()
                from ..suwen.store import uid
                record_id = uid('execution')
                record = {'session': self.session, 'run': run, 'code': code,
                    'code_sha256': hashlib.sha256(code.encode()).hexdigest(), 'started_at': started,
                    'scientific_status': 'unverified', 'status': 'running'}
                store.put('science_execution', record_id, record, scope)
                try:
                    result = await self._get_kernel().execute(code, timeout_s=timeout)
                except BaseException as exc:
                    store.put('science_execution', record_id, dict(record, status='cancelled' if isinstance(exc, asyncio.CancelledError) else 'failed', error=str(exc)), scope)
                    raise
                record.update(status='executed' if result.get('ok') else 'failed', result=result,
                    output_sha256=hashlib.sha256(json.dumps(result.get('outputs', []), ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                    finished_at=time.time())
                store.put('science_execution', record_id, record, scope)
                store.put('provenance', record_id, {k: v for k, v in record.items() if k != 'result'}, scope)
                return dict(result, provenance_id=record_id)
        if op == 'python.variables':
            return {'items': await self._kernel.list_vars() if self._kernel else []}
        if op == 'python.interrupt':
            return {'interrupted': await self._kernel.interrupt() if self._kernel else False}
        if op == 'notebook.export':
            return self.export_notebook(p.get('path'))
        return {'shutdown': True}  # transport closes after acknowledging shutdown

    def export_notebook(self, path=None):
        rows = sorted(self.platform.store.list('science_execution', self.scope), key=lambda row: row['started_at'])
        cells = []
        for row in rows:
            result = row.get('result', {})
            outputs = []
            for out in result.get('outputs', []):
                kind = out.get('type')
                if kind == 'stream':
                    outputs.append({'output_type': 'stream', 'name': out.get('name', 'stdout'), 'text': out.get('text', '')})
                elif kind in ('result', 'display'):
                    outputs.append({'output_type': 'display_data', 'data': {'text/plain': out.get('text', '')}, 'metadata': {}})
                elif kind == 'error':
                    outputs.append({'output_type': 'error', 'ename': out.get('ename', 'Error'), 'evalue': out.get('evalue', ''), 'traceback': out.get('traceback', [])})
                elif kind == 'image':
                    image = self.platform.path(str(Path('figures') / out['name']))
                    if image.is_file():
                        raw = image.read_bytes()
                        payload = raw.decode('utf-8') if out['mime'] == 'image/svg+xml' else base64.b64encode(raw).decode('ascii')
                        outputs.append({'output_type': 'display_data', 'data': {out['mime']: payload}, 'metadata': {}})
            cells.append({'cell_type': 'code', 'id': row['id'], 'source': row['code'],
                'execution_count': result.get('execution_count'), 'outputs': outputs,
                'metadata': {'science': {k: v for k, v in row.items() if k not in ('code', 'result')}}})
        notebook = {'nbformat': 4, 'nbformat_minor': 5, 'cells': cells,
            'metadata': {'kernelspec': {'name': 'python3', 'display_name': 'Python 3', 'language': 'python'},
                'language_info': {'name': 'python'}, 'science': {'scope': self.scope, 'scientific_status': 'unverified'}}}
        answer = {'notebook': notebook, 'provenance': self.platform.store.list('provenance', self.scope)}
        if path is not None:
            target = self.platform.path(path)
            if target.suffix.lower() != '.ipynb':
                raise ScienceError('invalid_path', 'notebook path must end in .ipynb')
            # Exclusive create prevents overwriting scientific inputs or previous exports.
            with target.open('x', encoding='utf-8') as stream:
                json.dump(notebook, stream, ensure_ascii=False, allow_nan=False, indent=2)
            answer['path'] = str(target)
        return answer

    async def close(self):
        if not self._closed:
            self._closed = True
            try:
                if self._kernel:
                    await self._kernel.stop()
            finally:
                self.platform.store.close()


def _error(request_id, exc):
    code = getattr(exc, 'code', None)
    if code is None:
        code = 'invalid_params' if isinstance(exc, (ValueError, TypeError, KeyError)) else 'file_error' if isinstance(exc, OSError) else 'operation_failed'
    return {'id': request_id, 'ok': False, 'error': {'code': code, 'message': str(exc), 'type': type(exc).__name__}}


async def serve(service, input_stream, output_stream):
    """Read on a daemon thread so shutdown never waits for another stdin line."""
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    tasks = set()
    def reader():
        try:
            while True:
                line = input_stream.readline(2_000_001)
                if not line:
                    break
                loop.call_soon_threadsafe(queue.put_nowait, line)
        finally:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, None)
            except RuntimeError:
                pass
    threading.Thread(target=reader, name='science-stdin', daemon=True).start()
    def emit(response):
        try:
            text = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            text = json.dumps(_error(response.get('id'), ScienceError('serialization_error', str(exc))), ensure_ascii=False)
        output_stream.write(text + '\n')
        output_stream.flush()
    async def handle(request):
        request_id = request['id']
        try:
            result = await service.dispatch(request['op'], request.get('params', {}))
            emit({'id': request_id, 'ok': True, 'result': result})
            if request['op'] == 'shutdown':
                queue.put_nowait(False)
        except Exception as exc:
            emit(_error(request_id, exc))
    try:
        while True:
            line = await queue.get()
            if line is False:
                break
            if line is None:
                if tasks:
                    await asyncio.gather(*tasks)
                break
            request_id = None
            try:
                if len(line) > 2_000_000:
                    raise ScienceError('invalid_request', 'request exceeds 2000000 characters')
                request = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'Invalid JSON constant: {value}')))
                if not isinstance(request, dict):
                    raise ScienceError('invalid_request', 'request must be an object')
                request_id = request.get('id')
                if 'id' not in request or type(request_id) not in (str, int, type(None)) or set(request) - {'id', 'op', 'params'} or not isinstance(request.get('op'), str):
                    raise ScienceError('invalid_request', 'request requires id and op; optional params must be an object')
                if len(tasks) >= 64 and request['op'] not in ('python.interrupt', 'shutdown'):
                    raise ScienceError('busy', 'Too many in-flight requests')
                if request['op'] == 'shutdown':
                    if request.get('params', {}) != {}:
                        raise ScienceError('invalid_params', 'shutdown takes no parameters')
                    await handle(request)
                    break
                task = asyncio.create_task(handle(request))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
                await asyncio.sleep(0)
            except Exception as exc:
                emit(_error(request_id, exc))
    finally:
        if tasks and service._kernel:
            await service._kernel.interrupt()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await service.close()


def main(argv=None):
    # Reserve original fd 1 for protocol and redirect ALL incidental Python/native
    # stdout (including imports and child processes) to stderr before service imports.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stdio', action='store_true', required=True)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--home', required=True)
    args = parser.parse_args(argv)
    try:
        service = ScienceService(args.workspace, args.home)
        if sys.platform == 'win32':
            # jupyter_client/zmq need add_reader, which the Proactor loop does not provide.
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(serve(service, sys.stdin, protocol))
    except Exception as exc:
        protocol.write(json.dumps(_error(None, exc), ensure_ascii=False) + '\n')
        protocol.flush()
        return 1
    finally:
        protocol.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
