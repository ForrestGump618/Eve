import httpx
import pytest
from fastapi import FastAPI

from omicslab.server.routes_evolution import router
from test_suwen_platform import p


async def test_plans_are_workspace_scoped_and_do_not_start_until_confirmed(p):
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        status = await client.get('/api/evolution')
        assert status.status_code == 200
        created = await client.post('/api/evolution/plans', json={'goal': 'Preserve scientific evidence'})
        assert created.status_code == 200
        plan = created.json()
        assert plan['status'] == 'planned'
        assert (await client.get('/api/evolution/' + plan['id'])).json()['progress'] == []
        refused = await client.post('/api/evolution/' + plan['id'] + '/start', json={})
        assert refused.status_code == 422
        assert not p.state.evolution.processes
        assert (await client.get('/api/evolution/../../outside')).status_code == 404


@pytest.mark.parametrize('patch', [{'files': 'deny'}, {'files': 'read_only'}, {'network': 'deny'},
                                  {'skills': 'deny'}, {'tools': {'write_file': 'deny'}}])
async def test_confirmed_plan_cannot_bypass_workspace_permissions(p, patch):
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(router)
    p.config.update('permissions', patch, 'ws_main')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        status = (await client.get('/api/evolution')).json()
        assert status['readiness']['ready'] is False
        assert any(issue['code'] == 'permission' for issue in status['readiness']['issues'])
        plan = (await client.post('/api/evolution/plans', json={'goal': 'Inspect'})).json()
        result = await client.post(f"/api/evolution/{plan['id']}/start", json={'plan_hash': plan['plan_hash']})
        assert result.status_code == 403
        assert not p.state.evolution.processes


async def test_unknown_workspace_is_rejected_without_default_fallback(p):
    app = FastAPI()
    app.state.omicslab = p.state
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/api/evolution?scope=missing')).status_code == 404
        assert not getattr(p.state, 'evolution', None)
