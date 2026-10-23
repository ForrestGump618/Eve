"""Remote workspace integration: routing, isolation and failure behavior."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from omicslab.agent.context import build_system_prompt
from omicslab.agent.tools import ToolContext, build_registry
from omicslab.config import Settings
from omicslab.server.routes_workspaces import router
from omicslab.server.state import AppState
from omicslab.workspace.service import WorkspaceService


@pytest.fixture
def setup(tmp_path):
    settings = Settings(workspace=tmp_path/'workspace', home=tmp_path/'home')
    settings.ensure_dirs()
    service = WorkspaceService(settings)
    ws = service.create('Remote', backend='ssh', remote={'profile_id':'gpu', 'root':'/analysis'})
    state = SimpleNamespace(settings=settings, workspaces=service)
    app = FastAPI()
    app.include_router(router)
    app.state.omicslab = state
    return settings, service, ws, state, app


@pytest.mark.asyncio
async def test_remote_file_routes_dispatch_and_download_contract(setup, monkeypatch):
    settings, service, ws, state, app = setup
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    monkeypatch.setattr(SSHExecutionBackend, 'start', AsyncMock())
    monkeypatch.setattr(SSHExecutionBackend, 'close', AsyncMock())
    tree = AsyncMock(return_value={'entries':[{'name':'remote.csv'}]})
    monkeypatch.setattr(SSHExecutionBackend, 'list_dir', tree)
    monkeypatch.setattr(SSHExecutionBackend, 'read_text', AsyncMock(return_value={'content':'remote data'}))
    monkeypatch.setattr(SSHExecutionBackend, 'read_bytes', AsyncMock(return_value=(b'hello', '数据.csv', 'text/csv')))
    write = AsyncMock(return_value={'ok':True})
    monkeypatch.setattr(SSHExecutionBackend, 'write_text', write)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        base=f'/api/workspaces/{ws.workspace_id}/files'
        assert (await client.get(base+'/tree')).json()['entries'][0]['name']=='remote.csv'
        assert (await client.get(base+'/read',params={'path':'data.csv'})).json()['text']=='remote data'
        raw=await client.get(base+'/raw',params={'path':'data.csv'})
        assert raw.content==b'hello'
        assert raw.headers['content-type'].startswith('text/csv')
        assert "UTF-8''" in raw.headers['content-disposition']
        assert (await client.post(base+'/write',json={'path':'out.txt','content':'value'})).status_code==200
        write.assert_awaited_once_with('out.txt','value')
        assert (await client.delete(base,params={'path':'.'})).status_code==400


@pytest.mark.asyncio
async def test_create_and_probe_check_selected_remote_directory(setup, monkeypatch):
    settings, service, ws, state, app = setup
    from omicslab.ssh import connections
    calls=[]
    def probe(pid, path):
        calls.append((pid,path))
        return {'ok':True,'exists':path!='/missing','is_dir':path!='/file','path':path,'entries':[]}
    connection=SimpleNamespace(probe=probe,get_profile=lambda pid:{'host':'gpu','username':'user'})
    monkeypatch.setattr(connections,'get_connection_service',lambda settings:connection)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        for path in ['/missing','/file']:
            response=await client.post('/api/workspaces',json={'name':'bad','backend':'ssh','remote':{'profile_id':'gpu','root':path}})
            assert response.status_code==400
        response=await client.post('/api/workspaces',json={'name':'GPU','backend':'ssh','remote':{'profile_id':'gpu','root':'/data'}})
        assert response.status_code==200
        assert response.json()['workspace']['resolved_path']=='/data'
        result=await client.post(f'/api/workspaces/{ws.workspace_id}/probe')
        assert result.json()['ok']
        assert calls[-1]==('gpu','/analysis')


@pytest.mark.asyncio
async def test_disconnected_remote_files_return_503(setup, monkeypatch):
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    from omicslab.execution.base import BackendUnavailable
    monkeypatch.setattr(SSHExecutionBackend,'start',AsyncMock(side_effect=BackendUnavailable('offline')))
    monkeypatch.setattr(SSHExecutionBackend,'close',AsyncMock())
    _,_,ws,_,app=setup
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.get(f'/api/workspaces/{ws.workspace_id}/files/tree')
        assert response.status_code==503


@pytest.mark.asyncio
@pytest.mark.parametrize('name,args,method,result',[
    ('run_python_code',{'code':'print(42)'},'execute_python',{'ok':True,'stdout':'42'}),
    ('run_shell',{'command':'pwd'},'shell',{'exit_code':0,'stdout':'/analysis'}),
    ('list_files',{},'list_dir',{'entries':[]}),
    ('read_file',{'path':'remote.txt'},'read_text',{'content':'remote only'}),
    ('write_file',{'path':'out.txt','content':'ok'},'write_text',{'ok':True}),
    ('get_system_info',{},'probe_environment',{'platform':'Linux'}),
    ('job_status',{},'process_list',[]),
    ('export_notebook',{'path':'result.ipynb'},'build_notebook',{'ok':True}),
])
async def test_agent_standard_tools_never_use_local_handlers(setup,name,args,method,result):
    settings,_,ws,_,_=setup
    registry=build_registry(settings)
    ctx=ToolContext(settings=settings,kernel=None,registry=registry,workspace=settings.workspace)
    backend=SimpleNamespace(kind='ssh',**{method:AsyncMock(return_value=result)})
    ctx.backend=backend
    outcome=await registry.execute(ctx,name,args)
    assert outcome.ok, outcome.content
    getattr(backend,method).assert_awaited_once()
    assert not (settings.workspace/'out.txt').exists()


@pytest.mark.asyncio
async def test_remote_console_and_agent_reuse_worker(setup,monkeypatch):
    from omicslab.execution.remote_kernel import RemoteKernel
    monkeypatch.setattr(RemoteKernel,'start',AsyncMock())
    settings,service,ws,_,_=setup
    state=SimpleNamespace(settings=settings,workspaces=service,kernels={},kernel_locks={})
    state.workspace_for_scope=lambda scope:service.get(scope.removeprefix('ws:'))
    state.kernel_for=lambda scope:AppState.kernel_for(state,scope)
    console=await state.kernel_for(ws.scope)
    backend=await AppState.make_backend(state,ws,None)
    assert backend is console.backend
    with pytest.raises(Exception,match='工作区不存在'):
        await state.kernel_for('ws:missing')


def test_remote_prompt_uses_remote_root(setup):
    settings,*_=setup
    backend=SimpleNamespace(describe=lambda:{'kind':'ssh','root':'/analysis'})
    prompt=build_system_prompt(settings,SimpleNamespace(name='agent',instructions=''),backend=backend)
    assert '/analysis' in prompt
    assert str(settings.workspace) not in prompt
    assert '禁止改用本地路径' in prompt


def test_remote_registry_does_not_store_secrets(setup):
    _,service,*_=setup
    ws=service.create('safe',backend='ssh',remote={'profile_id':'gpu','password':'secret','root':'/data'})
    assert 'password' not in ws.remote
    assert service.public(ws)['online'] is None


@pytest.mark.asyncio
async def test_remote_jobs_are_workspace_scoped(setup, monkeypatch):
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    monkeypatch.setattr(SSHExecutionBackend,'start',AsyncMock())
    monkeypatch.setattr(SSHExecutionBackend,'close',AsyncMock())
    monkeypatch.setattr(SSHExecutionBackend,'process_list',AsyncMock(return_value=[{'job_id':'remote-job'}]))
    monkeypatch.setattr(SSHExecutionBackend,'process_log',AsyncMock(return_value={'log':'remote log'}))
    cancel=AsyncMock(return_value={'ok':True})
    monkeypatch.setattr(SSHExecutionBackend,'process_cancel',cancel)
    _,_,ws,_,app=setup
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        base=f'/api/workspaces/{ws.workspace_id}/jobs'
        assert (await client.get(base)).json()['jobs'][0]['job_id']=='remote-job'
        assert (await client.get(base+'/remote-job/log')).json()['log']=='remote log'
        assert (await client.post(base+'/remote-job/cancel')).json()['ok']
        cancel.assert_awaited_once_with('remote-job')


@pytest.mark.asyncio
async def test_notebook_defaults_to_remote_code_history(setup):
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    settings,_,ws,_,_=setup
    backend=SSHExecutionBackend(ws,settings=settings)
    backend._history=[{'type':'code','source':'value = 42'}]
    notebook=(await backend.build_notebook())['notebook']
    assert notebook['cells'][0]['source']==['value = 42']


@pytest.mark.asyncio
async def test_remote_root_delete_is_refused_even_after_normalization(setup):
    from omicslab.execution.ssh_backend import SSHExecutionBackend
    from omicslab.execution.base import BackendError
    settings,_,ws,_,_=setup
    backend=SSHExecutionBackend(ws,settings=settings)
    backend._started=True
    backend._resolved_root='/analysis'
    backend._manager=lambda:SimpleNamespace()
    with pytest.raises(BackendError,match='不能删除工作区根目录'):
        await backend.delete_path('subdir/..')
