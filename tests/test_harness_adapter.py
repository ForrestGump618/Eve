import asyncio
import subprocess
import sys
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from omicslab.config import Settings
from omicslab.workspace import Workspace
from omicslab.execution.local import LocalExecutionBackend
from omicslab.agent.approvals import Approver
from omicslab.server.routes_harness import router


@pytest.mark.asyncio
async def test_authenticated_adapter_returns_after_disconnect_monitor_cleanup(tmp_path):
    workspace=Workspace('ws_adapter','Adapter',local_path=str(tmp_path))
    settings=Settings(home=tmp_path/'home',workspace=tmp_path)
    backend=LocalExecutionBackend(settings,workspace,kernel=None)
    handle=SimpleNamespace(run_id='run_adapter',session_id='session',workspace=workspace,backend=backend,
                           permission_mode='full',cancel_event=asyncio.Event(),status='running')
    frames=[]
    async def emit(*args): frames.append(args)
    runs=SimpleNamespace(_handles={'run_adapter':handle},_emit=emit,_on_loop_event=emit,approver=Approver('auto',timeout_s=.03))
    app=FastAPI();app.include_router(router);app.state.harness_token='adapter-secret'
    from omicslab.suwen.store import PlatformStore
    platform_store = PlatformStore(settings.home)
    app.state.omicslab=SimpleNamespace(runs=runs, platform=SimpleNamespace(store=platform_store))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
        headers={'authorization':'Bearer adapter-secret'}
        async def call(operation,args,timeout=1):
            return await asyncio.wait_for(client.post('/api/harness/runs/run_adapter/tool',headers=headers,
                                                      json={'operation':operation,'arguments':args}),timeout)
        approved=await call('authorize',{'tool':'skill_run','arguments':{}})
        assert approved.status_code==200
        saved=await call('write_file',{'path':'result.txt','content':'ACTUAL_DISK_DATA'})
        assert saved.status_code==200 and saved.json()['verified']
        changes = platform_store.list("file_change", workspace.workspace_id)
        assert len(changes) == 1 and changes[0]["session_id"] == "session"
        assert changes[0]["afterSha256"] == saved.json()["sha256"]
        read=await call('read_file',{'path':'result.txt'})
        assert read.json()['content']=='ACTUAL_DISK_DATA'
        assert read.json()['execution_target']['kind']=='local'
        # Exercise the same authenticated HTTP -> FastAPI -> to_thread shell path
        # used by the desktop Harness. The adapter must return the real command
        # result instead of waiting for the outer 150-second tool deadline.
        command=subprocess.list2cmdline([
            sys.executable,'-c',"import time; time.sleep(2); print('ADAPTER_SHELL_OK')"
        ])
        started=time.perf_counter()
        shell=await call('run_shell',{'command':command,'timeoutSeconds':10},timeout=8)
        elapsed=time.perf_counter()-started
        assert shell.status_code==200
        assert shell.json()['stdout'].strip()=='ADAPTER_SHELL_OK'
        assert shell.json()['ok'] is True
        assert elapsed < 7
        slow_command=subprocess.list2cmdline([
            sys.executable,'-c',"import time; time.sleep(10); print('SHOULD_NOT_FINISH')"
        ])
        started=time.perf_counter()
        timed=await call('run_shell',{'command':slow_command,'timeoutSeconds':1},timeout=8)
        elapsed=time.perf_counter()-started
        assert timed.status_code==422
        assert 'timed_out' in timed.text and 'True' in timed.text
        assert elapsed < 7
        handle.permission_mode='ask'
        denied=await call('write_file',{'path':'denied.txt','content':'MUST_NOT_WRITE'})
        assert denied.status_code==403 and not (tmp_path/'denied.txt').exists()
        unauthenticated=await client.post('/api/harness/runs/run_adapter/tool',json={'operation':'read_file','arguments':{'path':'result.txt'}})
        assert unauthenticated.status_code==403
        handle.cancel_event.set()
        cancelled=await call('read_file',{'path':'result.txt'})
        assert cancelled.status_code==409
    platform_store.close()

@pytest.mark.asyncio
@pytest.mark.parametrize('remote',[False,True])
async def test_resume_uses_public_workspace_path_and_refuses_environment_change(tmp_path,remote):
    from omicslab.server.chat import router as chat_router
    from omicslab.workspace.service import WorkspaceService
    settings=Settings(home=tmp_path/'home',workspace=tmp_path/'workspace')
    settings.ensure_dirs()
    workspaces=WorkspaceService(settings)
    ws=workspaces.create(name='Bound',backend='ssh',remote={'profile_id':'server','root':'~/project'}) if remote else workspaces.create(name='Bound',local_path=str(tmp_path/'project'))
    public=workspaces.public(ws)
    row={'run_id':'previous','status':'cancelled','session_id':'conversation','workspace':public,
         'meta':{'workspace_id':ws.workspace_id,'harness_task_id':'checkpoint'}}
    class Harness:
        async def rpc(self,method,**params):
            return {'status':'cancelled','steps':[{'input':{'prompt':'finish original goal'}}],
                    'events':[{'type':'agent.checkpoint'}]}
    submissions=[]
    async def submit(**kwargs):submissions.append(kwargs);return {'run':{'run_id':'resumed'}}
    runs=SimpleNamespace(loop=SimpleNamespace(desktop_harness=Harness()),submit=submit)
    state=SimpleNamespace(events=SimpleNamespace(get_run=lambda _:row),workspaces=workspaces,runs=runs)
    app=FastAPI();app.include_router(chat_router);app.state.omicslab=state
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
        response=await client.post('/api/runs/previous/resume',json={'confirm_unknown':True})
        assert response.status_code==200 and submissions[0]['resume_task_id']=='checkpoint'
        assert submissions[0]['permission_mode']=='ask'
        public['resolved_path']='different-environment'
        denied=await client.post('/api/runs/previous/resume',json={'confirm_unknown':True})
        assert denied.status_code==409 and len(submissions)==1

@pytest.mark.asyncio
async def test_conversation_model_settings_are_independent_and_preserve_live_history(tmp_path):
    from omicslab.server.routes import router as routes
    from omicslab.session.store import ConversationStore
    from omicslab.agent.types import ChatMessage
    settings=Settings(home=tmp_path/'home',workspace=tmp_path/'workspace');settings.ensure_dirs()
    store=ConversationStore(settings);a=store.create(title='A');b=store.create(title='B')
    a.messages.append(ChatMessage(role='assistant',content='unsaved live observation'))
    handle=SimpleNamespace(session_id=a.id,conversation=a)
    state=SimpleNamespace(settings=settings,store=store,runs=SimpleNamespace(_handles={'a':handle}))
    app=FastAPI();app.include_router(routes);app.state.omicslab=state
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
        first=await client.patch(f'/api/conversations/{a.id}/execution',json={'provider':'mock','model':'model-A','permission_mode':'full'})
        second=await client.patch(f'/api/conversations/{b.id}/execution',json={'provider':'mock','model':'model-B','permission_mode':'review'})
        assert first.status_code==second.status_code==200
        assert store.get(a.id).meta['execution']=={'provider':'mock','model':'model-A','permission_mode':'full'}
        assert store.get(b.id).meta['execution']=={'provider':'mock','model':'model-B','permission_mode':'review'}
        assert store.get(a.id).messages[-1].content=='unsaved live observation'
        bad=await client.patch(f'/api/conversations/{a.id}/execution',json={'permission_mode':'invalid'})
        assert bad.status_code==400 and store.get(a.id).meta['execution']['model']=='model-A'
