"""Evolution RPC over the workspace's existing SSH worker, never local fallback."""
import asyncio
import dataclasses
from pathlib import Path
import threading

from .proteus_adapter import EvolutionPolicy


class RemoteEvolutionService:
    def __init__(self, platform, scope):
        self.platform, self.scope = platform, scope
        self.policy = EvolutionPolicy()

    async def invoke(self, method, **params):
        backend = await self.platform.backend(self.scope)
        if backend.kind != 'ssh':
            raise ValueError('执行环境已改变，请重新创建实验方案')
        from ..execution.base import BackendError
        try:
            return await backend.evolution_request(method, scope=self.scope, **params)
        except BackendError as exc:
            if method == 'readiness':
                return {'ready':False, 'source_ready':False, 'validation_ready':False,
                        'dependency':{'available':False,'install':'在远端安装科研运行依赖'},
                        'issues':[{'code':'remote_environment','message':str(exc),
                                   'action':'检查 SSH 环境与 EVE_RSI_SOURCE_ROOT 后重试'}]}
            if method == 'list':
                return []
            raise ValueError(str(exc)) from exc


_loop = None
_lock = threading.Lock()
_services = {}


def worker_request(request):
    """Runs only in the remote worker; secrets never enter argv or Python history."""
    global _loop
    with _lock:
        if _loop is None:
            _loop = asyncio.new_event_loop()
            threading.Thread(target=_loop.run_forever, daemon=True, name='eve-evolution').start()
    return asyncio.run_coroutine_threadsafe(_dispatch(request), _loop).result()


async def _dispatch(request):
    from .service import EvolutionService
    from ..config import LLMTarget
    import hashlib
    scope = request['scope']
    # Scope is data, never part of an unchecked filesystem path.
    root = Path.cwd() / '.omicslab' / 'evolution-home' / hashlib.sha256(scope.encode()).hexdigest()
    key = str(root)
    if key not in _services:
        _services[key] = EvolutionService(root)
    service = _services[key]
    method = request['method']
    params = dict(request.get('params') or {})
    if params.get('target'):
        params['target'] = LLMTarget(**params['target'])
    if method == 'readiness':
        return await asyncio.to_thread(service.readiness, params.get('target'))
    if method == 'list':
        return service.list(scope)
    if method == 'plan':
        record = service.plan(scope, params['goal'])
        record['plan']['execution_target'] = {'kind': 'ssh', 'root': str(Path.cwd())}
        record['plan_hash'] = hashlib.sha256(__import__('json').dumps(record['plan'], sort_keys=True).encode()).hexdigest()
        service._save(record)
        return record
    if method in {'get', 'progress'}:
        return getattr(service, method)(params['id'], scope)
    if method == 'start':
        return await service.start(params['id'], scope, params['plan_hash'], params['target'])
    if method == 'stop':
        return await service.stop(params['id'], scope)
    raise ValueError('不支持的实验操作')


async def invoke(service, method, **params):
    if isinstance(service, RemoteEvolutionService):
        if params.get('target'):
            params['target'] = dataclasses.asdict(params['target'])
        params.pop('scope', None)
        return await service.invoke(method, **params)
    result = await asyncio.to_thread(getattr(service, method), **params) if method == 'readiness' else getattr(service, method)(**params)
    return await result if hasattr(result, '__await__') else result
