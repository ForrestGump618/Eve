"""Workspace-scoped, explicit plan confirmation for optional Proteus runs."""
import asyncio
from fastapi import APIRouter, HTTPException, Request

from .routes_platform import body, platform
from ..evolution.service import EvolutionService
from ..config import ConfigError

router = APIRouter(prefix='/api/evolution', tags=['evolution'])


def service(request, scope):
    p = platform(request)
    try:
        workspace = p.require_workspace(scope)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    if workspace.backend == 'ssh':
        raise HTTPException(409, 'Proteus 当前只支持本地隔离实验；没有转为本地执行此 SSH 任务')
    state = request.app.state.omicslab
    if not getattr(state, 'evolution', None):
        state.evolution = EvolutionService(state.settings.home)
    return state.evolution


def permission_issue(request, scope):
    permissions = platform(request).config.get('permissions', scope)['value']
    for category in ('files', 'network'):
        if permissions[category] in {'deny', 'read_only'}:
            return f'Evolution requires {category} permission in this workspace'
    if permissions['skills'] == 'deny':
        return 'Evolution requires skill guidance permission in this workspace'
    for tool in ('list_files', 'read_file', 'write_file', 'skill_list', 'skill_view'):
        permission = permissions['tools'].get(tool)
        if permission == 'deny' or (tool == 'write_file' and permission == 'read_only'):
            return f'Evolution tool is denied in this workspace: {tool}'
    return ''


@router.get('')
async def list_runs(request: Request, scope: str = 'ws_main'):
    runner = service(request, scope)
    try:
        target = platform(request).settings.resolve_llm()
        readiness = await asyncio.to_thread(runner.readiness, target)
    except (ValueError, ConfigError):
        readiness = await asyncio.to_thread(runner.readiness)
        readiness['issues'].append({'code': 'model', 'message': 'Configure an OpenAI-compatible model connection',
                                    'action': 'Select a model and credential in model settings.'})
        readiness['ready'] = False
    if issue := permission_issue(request, scope):
        readiness['ready'] = False
        readiness['issues'].append({'code': 'permission', 'message': issue,
                                    'action': 'Review workspace permissions before confirming a run.'})
    return {'dependency': readiness['dependency'], 'validation_ready': readiness['validation_ready'], 'readiness': readiness,
            'policy': runner.policy.as_dict(), 'runs': runner.list(scope), 'scope': scope}


@router.post('/plans')
async def plan(request: Request, scope: str = 'ws_main'):
    runner = service(request, scope)
    data = await body(request)
    if set(data) != {'goal'}:
        raise HTTPException(422, '方案只接受 goal 字段')
    try:
        return runner.plan(scope, data['goal'])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get('/{id}')
async def detail(request: Request, id: str, scope: str = 'ws_main'):
    runner = service(request, scope)
    try:
        return {'run': runner.get(id, scope), 'progress': runner.progress(id, scope)}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post('/{id}/start')
async def start(request: Request, id: str, scope: str = 'ws_main'):
    runner = service(request, scope)
    data = await body(request)
    if set(data) != {'plan_hash'}:
        raise HTTPException(422, '请确认当前方案')
    try:
        if issue := permission_issue(request, scope):
            raise HTTPException(403, issue)
        target = platform(request).settings.resolve_llm()
        return await runner.start(id, scope, data['plan_hash'], target)
    except (ValueError, ConfigError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/{id}/stop')
async def stop(request: Request, id: str, scope: str = 'ws_main'):
    runner = service(request, scope)
    try:
        return await runner.stop(id, scope)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
