"""Suwen's real storage/protocol/queue boundaries; no paid model or external account."""
import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI,Request
from fastapi.responses import JSONResponse

from omicslab.config import Settings
from omicslab.agent.tools import build_registry,ToolContext
from omicslab.agent.types import ToolResult
from omicslab.agent.templates import load_agents
from omicslab.agent.approvals import Approver
from omicslab.server.routes_platform import router
from omicslab.server import files
from omicslab.suwen.service import Platform
from omicslab.suwen.store import Conflict,redact
from omicslab.suwen.tasks import validate_workflow
from omicslab.suwen.mcp import MCPConnection
from omicslab.suwen.models import compact_messages
from omicslab.workspace.service import WorkspaceService


class FilesBackend:
    def __init__(self,settings,workspace):self.settings=settings;self.workspace=workspace;self.kind='local'
    async def read_text(self,path,max_bytes=200000):return files.read_text(self.settings,path,max_bytes,root=self.workspace.root)
    async def read_bytes(self,path):
        target=files.resolve_path(self.settings,path,root=self.workspace.root)
        return target.read_bytes(),target.name,files.guess_mime(target)
    async def save_upload(self,parent,name,data):return files.save_upload(self.settings,parent,name,data,root=self.workspace.root)
    def describe(self):return {'kind':'local','root':str(self.workspace.root)}


@pytest.fixture
def p(tmp_path):
    settings=Settings(workspace=tmp_path/'workspace',home=tmp_path/'home');settings.ensure_dirs()
    workspaces=WorkspaceService(settings)
    state=SimpleNamespace(settings=settings,workspaces=workspaces,registry=build_registry(settings),agents=load_agents(settings),
        loop=SimpleNamespace(),llm_info=lambda:{'provider':'mock','model':'mock-model','configured':True})
    platform=Platform(state);state.platform=platform
    async def backend(scope):return FilesBackend(settings,platform.require_workspace(scope))
    platform.backend=backend
    yield platform
    platform.store.close()


@pytest.fixture
def client_app(p):
    app=FastAPI();app.state.omicslab=p.state;app.include_router(router)
    @app.exception_handler(ValueError)
    async def value_error(request:Request,exc):return JSONResponse({'error':str(exc)},status_code=400)
    @app.exception_handler(PermissionError)
    async def permission_error(request:Request,exc):return JSONResponse({'error':str(exc)},status_code=403)
    return app


def test_migration_is_backed_up_and_repeatable(p):
    migration=p.store.get('migration','v2')
    assert Path(migration['backup']).is_dir()
    original=migration['revision'];p._migrate()
    assert p.store.get('migration','v2')['revision']==original
    assert p.state.workspaces.default().root==p.settings.workspace


def test_versioned_configuration_rejects_stale_update_and_rolls_back(p):
    p.config.update('models',{'mode':'fast'},expected=0)
    p.config.update('models',{'mode':'deep'},expected=1)
    with pytest.raises(Conflict):p.config.update('models',{'mode':'balanced'},expected=1)
    result=p.config.rollback('models',1,'global')
    assert result['value']['mode']=='fast'
    assert len(p.store.history('config','models'))==2


@pytest.mark.parametrize('section,value',[
 ('models',{'mode':'unlimited'}),('appearance',{'font_size':500}),('appearance',{'accent':'url(evil)'}),
 ('permissions',{'shell':'sometimes'}),('budget',{'max_cost':-1}),('models',{'roles':{'text':{'api_key':'plain'}}}),
 ('memory',{'enabled':'yes'}),('vision',{'max_repairs':999}),
])
def test_configuration_validation(p,section,value):
    with pytest.raises(ValueError):p.config.update(section,value)


def test_workspace_configuration_inherits_but_does_not_leak(p):
    other=p.state.workspaces.create('other')
    p.config.update('models',{'mode':'fast'})
    p.config.update('models',{'mode':'deep'},other.workspace_id)
    assert p.config.get('models','ws_main')['value']['mode']=='fast'
    assert p.config.get('models',other.workspace_id)['value']['mode']=='deep'


def test_redaction_nested_keys_and_tokens():
    clean=redact({'api_key':'private','nested':[{'Authorization':'Bearer private'}],'message':'request /bot123:abcdEFGh123/getMe sk-secretabc123'})
    assert 'private' not in json.dumps(clean)
    assert 'abcdEFGh' not in json.dumps(clean)
    assert 'sk-secretabc' not in json.dumps(clean)


@pytest.mark.skipif(sys.platform!='win32',reason='DPAPI is Windows only')
def test_dpapi_credentials_and_legacy_key_endpoint_are_encrypted(p):
    p.vault.put('test','private-test-key')
    p.vault.temporary.clear()
    assert p.vault.get('test')=='private-test-key'
    assert 'private-test-key' not in p.store.path.read_bytes().decode('latin1')
    p.settings.set_keys({'OPENAI_API_KEY':'private-provider-key'})
    assert p.settings.auth()['OPENAI_API_KEY']=='private-provider-key'
    assert 'private-provider-key' not in p.settings.auth_path.read_text()


@pytest.mark.asyncio
async def test_knowledge_scope_expiry_conflict_and_secret_filter(p):
    other=p.state.workspaces.create('other')
    await p.knowledge.add('ws_main','质量标准','肿瘤样本质量检查，要求测序数据与对照组独立。')
    private=await p.knowledge.add(other.workspace_id,'质量标准','肿瘤样本的私有知识。')
    results=await p.knowledge.search('ws_main','肿瘤样本')
    assert results and all(r['id']!=private['id'] for r in results)
    conflict=await p.knowledge.add('ws_main','质量标准','质量标准发生变化，需要重新验证。')
    assert conflict['conflicts']
    with pytest.raises(ValueError,match='敏感'):await p.knowledge.add('ws_main','bad','api_key = private')
    assert await p.knowledge.add('ws_main','auto','x'*100,auto=True) is None
    p.config.update('memory',{'enabled':False},'ws_main')
    assert await p.knowledge.search('ws_main','肿瘤')==[]


@pytest.mark.asyncio
async def test_incremental_document_index_reuses_content_and_keeps_source_locator(p):
    first=await p.knowledge.index('ws_main','guide.md','质量控制与独立样本验证'.encode())
    second=await p.knowledge.index('ws_main','guide.md','质量控制与独立样本验证'.encode())
    assert first['chunks']==second['chunks']
    result=await p.knowledge.search('ws_main','独立样本')
    assert result[0]['locator'].startswith('text;chars:')


@pytest.mark.asyncio
async def test_deterministic_sequence_qc(p):
    result=p.biomedical.sequence('ACGT Nn')
    assert result['length']==6 and result['gc_fraction']==.5 and result['reverse_complement']=='NNACGT'
    assert not p.biomedical.sequence('AXCGT')['valid']
    with pytest.raises(ValueError):p.biomedical.sequence('')


@pytest.mark.asyncio
async def test_evidence_checks_read_real_metrics_and_never_auto_validate_science(p):
    source=p.store.put('bio_source','paper1',{'source_verified':True,'retracted':False,'doi':'10.test/example'},'ws_main')
    claim=p.biomedical.record_claim('ws_main','run1',{'kind':'inference','statement':'候选基因值得复核','sources':[source['id']]})
    path=p.settings.workspace/'metrics.json';path.write_text(json.dumps({'adjusted_p':.03,'replicates':2}))
    failed=await p.biomedical.verify('ws_main',claim['id'],'metrics.json',[{'metric':'replicates','op':'ge','threshold':3}])
    assert failed['validation_status']=='insufficient_evidence'
    passed=await p.biomedical.verify('ws_main',claim['id'],'metrics.json',[{'metric':'adjusted_p','op':'lt','threshold':.05}])
    assert passed['validation_status']=='checks_passed_needs_human'
    assert p.biomedical.gate('ws_main','run1','',True)['status']=='needs_review'
    assert passed['metrics_sha256']==__import__('hashlib').sha256(path.read_text().encode()).hexdigest()
    with pytest.raises(ValueError):await p.biomedical.verify('ws_main',claim['id'],'../escape.json',[{'metric':'a','op':'lt','threshold':1}])


def test_research_gate_blocks_missing_sources(p):
    gate=p.biomedical.gate('ws_main','research-run','model says correct',True)
    assert gate['status']=='needs_review' and gate['blockers']
    assert p.biomedical.gate('ws_main','ordinary','hello',False)['status']=='not_applicable'
    with pytest.raises(ValueError):p.biomedical.record_claim('ws_main','r',{'statement':'claim','kind':'evidence','sources':['other-workspace-source']})


@pytest.mark.asyncio
async def test_snapshot_history_restores_actual_file(p):
    path=p.settings.workspace/'result.txt';path.write_text('version one')
    first=await p.snapshot('ws_main','result.txt')
    path.write_text('version two');second=await p.snapshot('ws_main','result.txt')
    assert first['digest']!=second['digest']
    await p.restore_artifact('ws_main',first['id'],first['revision'])
    assert path.read_text()=='version one'


def test_workflow_rejects_cycles_unknown_dependencies_and_types():
    for nodes in [[],[{'id':'a','type':'python'}],[{'id':'a','type':'model','depends_on':['a']}],
                  [{'id':'a','type':'model','depends_on':['missing']}]]:
        with pytest.raises(ValueError):validate_workflow({'nodes':nodes})


@pytest.mark.asyncio
async def test_queue_persists_checkpoints_and_manual_approval(p):
    task=p.tasks.create('ws_main',{'workflow':{'nodes':[{'id':'first','type':'output','text':'committed'},
      {'id':'human','type':'approval','depends_on':['first']},{'id':'last','type':'output','depends_on':['human'],'text':'done'}]}})
    await p.tasks.start()
    try:
        for _ in range(200):
            row=p.store.get('task',task['id'],'ws_main')
            if row['status']=='waiting_approval':break
            await asyncio.sleep(.01)
        assert row['status']=='waiting_approval'
        assert row['nodes']['first']['result']=='committed'
        original_time=row['nodes']['first'].get('started_at')
        p.tasks.node_patch(task['id'],'ws_main','human',approved=True)
        while task['id'] in p.tasks.active:await asyncio.sleep(.01)
        await p.tasks.control(task['id'],'ws_main','resume')
        for _ in range(200):
            row=p.store.get('task',task['id'],'ws_main')
            if row['status']=='succeeded':break
            await asyncio.sleep(.01)
        assert row['status']=='succeeded'
        assert row['nodes']['first'].get('started_at')==original_time
    finally:await p.tasks.close()


@pytest.mark.asyncio
async def test_task_recovery_does_not_replay_inflight_work(p):
    task=p.tasks.create('ws_main',{'prompt':'test','idempotency_key':'unique'})
    assert p.tasks.create('ws_main',{'prompt':'test','idempotency_key':'unique'})['id']==task['id']
    p.tasks.patch(task['id'],'ws_main',status='running')
    await p.tasks.start()
    try:
        assert p.store.get('task',task['id'],'ws_main')['status']=='interrupted'
        with pytest.raises(ValueError,match='确认'):await p.tasks.control(task['id'],'ws_main','resume')
    finally:await p.tasks.close()


@pytest.mark.asyncio
async def test_channels_deduplicate_and_reject_unauthorized_contacts(p):
    row=p.channels.save({'name':'web','adapter':'webchat','workspace':'ws_main','enabled':True,'contacts':['owner']})
    with pytest.raises(PermissionError):await p.channels.inbound(row['id'],{'message_id':'1','contact':'stranger','text':'run shell'})
    first=await p.channels.inbound(row['id'],{'message_id':'1','contact':'owner','text':'read progress'})
    duplicate=await p.channels.inbound(row['id'],{'message_id':'1','contact':'owner','text':'read progress'})
    assert not first['duplicate'] and duplicate['duplicate']
    task=p.store.get('task',first['task'],'ws_main')
    assert task['workflow']['nodes'][0]['restricted']
    with pytest.raises(PermissionError):await p.channels.send(row['id'],'owner','message',True)
    assert not p.channels.capabilities('wechat')['qr_login']
    assert not p.channels.capabilities('wechat')['inbound']


def test_permission_denial_and_channel_restriction_happen_before_execution(p):
    ctx=ToolContext(settings=p.settings,registry=p.state.registry);ctx.backend=FilesBackend(p.settings,p.state.workspaces.default())
    p.config.update('permissions',{'shell':'deny'},'ws_main')
    with pytest.raises(Exception,match='禁止'):p.permissions(ctx,p.state.registry.get('run_shell'))
    ctx.restricted_channel=True
    with pytest.raises(Exception,match='只读'):p.permissions(ctx,p.state.registry.get('run_python_code'))
    assert p.permissions(ctx,p.state.registry.get('list_files'))=='allow'


@pytest.mark.asyncio
async def test_scoped_public_api_layout_import_and_human_review(p,client_app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client_app),base_url='http://test') as client:
        assert (await client.get('/api/platform/bootstrap')).json()['brand']=='素问 Suwen'
        response=await client.put('/api/platform/layout',json={'rightWidth':900})
        assert response.status_code==400
        await client.put('/api/platform/layout',json={'rightWidth':300,'bottomHeight':220,'hideRight':True})
        assert (await client.get('/api/platform/layout')).json()['hideRight']
        bad=await client.post('/api/platform/configuration/import',json={'schema_version':2,'config':{'models':{'mode':'fast'},'appearance':{'font_size':900}}})
        assert bad.status_code==400
        assert p.config.get('models')['value']['mode']=='balanced'
        assert (await client.get('/api/platform/bootstrap?scope=missing')).status_code==400
        p.store.put('bio_source','source',{'source_verified':True},'ws_main')
        claim=p.biomedical.record_claim('ws_main','run1',{'statement':'复核示例','kind':'inference','sources':['source']})
        reviewed=await client.post(f'/api/platform/research/claims/{claim["id"]}/review',json={'confirmed':True,'reviewer':'human','notes':'已独立阅读原始来源与方法，并记录其科学局限。'})
        assert reviewed.status_code==200 and reviewed.json()['validation_status']=='human_reviewed'


@pytest.mark.asyncio
async def test_real_stdio_mcp_handshake_discovery_and_call(p,tmp_path):
    server=tmp_path/'server.py'
    server.write_text('''import sys,json
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r:continue
 m=r['method'];result={}
 if m=='initialize':result={'protocolVersion':'2025-06-18','capabilities':{'tools':{},'resources':{},'prompts':{}},'serverInfo':{'name':'test','version':'1'}}
 elif m=='tools/list':result={'tools':[{'name':'add','description':'add numbers','inputSchema':{'type':'object'}}]}
 elif m=='resources/list':result={'resources':[]}
 elif m=='prompts/list':result={'prompts':[]}
 elif m=='tools/call':result={'content':[{'type':'text','text':str(sum(r['params']['arguments']['values']))}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
''')
    row=p.mcp.save({'name':'test','transport':'stdio','command':sys.executable,'args':[str(server)],'enabled':True,'workspaces':['ws_main']})
    result=await p.mcp.discover(row['id'])
    assert result['status']=='connected' and result['tools'][0]['name']=='add'
    with pytest.raises(ValueError):await p.mcp.test_tool(row['id'],'add',{'values':[2,3]},'ws_main',False)
    actual=await p.mcp.test_tool(row['id'],'add',{'values':[2,3]},'ws_main',True)
    assert actual['content'][0]['text']=='5'
    assert not p.mcp.allowed(row,'other-workspace')


@pytest.mark.asyncio
async def test_streamable_http_mcp_negotiates_session_and_json(p,monkeypatch):
    original=httpx.AsyncClient;seen=[]
    async def respond(request):
        if request.method=='DELETE':return httpx.Response(204)
        data=json.loads(request.content);seen.append((data,dict(request.headers)))
        if data['method']=='notifications/initialized':return httpx.Response(202)
        result={'protocolVersion':'2025-06-18','capabilities':{}} if data['method']=='initialize' else {'value':42}
        return httpx.Response(200,json={'jsonrpc':'2.0','id':data['id'],'result':result},headers={'Mcp-Session-Id':'session1'})
    monkeypatch.setattr('omicslab.suwen.mcp.httpx.AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(respond),**kwargs))
    async with MCPConnection({'transport':'http','url':'https://mcp.test/rpc'},p.vault) as client:
        assert (await client.rpc('ping'))['value']==42
    assert seen[-1][1]['mcp-session-id']=='session1'


def test_budget_tracks_workspace_and_fails_closed_at_hard_limit(p):
    p.config.update('budget',{'max_tokens':1000},'ws_main')
    p.models.record('ws_main','task1','lead','mock',{'prompt_tokens':900,'completion_tokens':101},.1)
    with pytest.raises(Exception,match='硬限制'):p.models.check_budget('ws_main')


def test_context_compaction_keeps_goal_and_completed_tool_pair():
    messages=[{'role':'system','content':'research instructions '*1000},
        {'role':'user','content':'Analyze the expression matrix'},
        {'role':'assistant','content':'I will inspect it','tool_calls':[{'id':'call_1','type':'function','function':{'name':'run_python_code','arguments':'{}'}}]},
        {'role':'tool','tool_call_id':'call_1','name':'run_python_code','content':'shape: (200,50)'}]
    compacted=compact_messages(messages,10000,2000,1000)
    assert compacted[-1]['role']=='tool' and compacted[-1]['content']=='shape: (200,50)'
    assert any(m['role']=='user' and 'expression matrix' in m['content'] for m in compacted)
    assert len(json.dumps(compacted,ensure_ascii=False))<7000


def test_insufficient_context_fails_before_request():
    with pytest.raises(Exception,match='上下文'):
        compact_messages([{'role':'system','content':'s'},{'role':'user','content':'u'}],2048,1024,5000)


def test_redaction_scrubs_credentials_inside_recorded_code():
    code="password='private-pass'\napi_key = \"private-key\"\nsecret: 'hidden'"
    assert all(s not in redact(code) for s in ['private-pass','private-key','hidden'])


@pytest.mark.parametrize('value',[
    {'roles':{'code':'invalid'}},{'fallbacks':{}},{'capabilities':{'m':{'max_output':True}}},
    {'capabilities':{'m':{'token_parameter':'invalid'}}},
])
def test_model_nested_configuration_rejects_runtime_crashes(p,value):
    with pytest.raises(ValueError):p.config.update('models',value)


def test_model_role_connection_does_not_override_explicit_agent_connection(p):
    p.vault.put('coder','test-only-key',False)
    p.config.update('models',{'roles':{'code':{'provider':'custom_openai','model':'coder','api_base':'https://role.example/v1','credential_ref':'coder'}}})
    backend=SimpleNamespace(workspace=p.require_workspace('ws_main'))
    routed,_,target=p.models.prepare(p.settings,None,None,p.state.agents['lead'],backend,'write Python code')
    assert target.model=='coder' and target.api_base=='https://role.example/v1'
    _,_,explicit=p.models.prepare(p.settings,'mock','explicit',p.state.agents['lead'],backend,'write Python code')
    assert explicit.model=='explicit' and explicit.api_base!='https://role.example/v1'


def test_privacy_guard_rejects_remote_ollama_and_accepts_loopback():
    from omicslab.suwen.models import require_private_endpoint
    with pytest.raises(Exception,match='隐私'):require_private_endpoint('privacy','https://remote.example','ollama')
    require_private_endpoint('privacy','http://127.0.0.1:8000/v1','custom_openai')
    require_private_endpoint('privacy','http://[::1]:8000/v1')


@pytest.mark.asyncio
async def test_private_embedding_is_rejected_before_any_network_request(p):
    p.config.update('models',{'strategy':'privacy'},'ws_main')
    p.config.update('memory',{'embedding':'api','embedding_url':'https://external.example/v1','embedding_model':'embed'},'ws_main')
    with pytest.raises(Exception,match='隐私'):await p.knowledge.vector('private knowledge','ws_main')


@pytest.mark.asyncio
async def test_vision_failures_consume_bounded_review_attempts(p):
    p.config.update('vision',{'enabled':True,'auto_review':True,'max_repairs':1},'ws_main')
    for _ in range(3):await p.auto_review('ws_main','run-test',[{'name':'missing.png'}])
    assert len(p.store.list('review','ws_main'))==2


@pytest.mark.asyncio
async def test_failed_channel_task_can_be_delivered_again(p,monkeypatch):
    channel=p.channels.save({'name':'test','adapter':'webchat','enabled':True,'workspace':'ws_main','contacts':['1']})
    message={'message_id':'retry-1','contact':'1','text':'hello'}
    original=p.tasks.create
    monkeypatch.setattr(p.tasks,'create',lambda *a:(_ for _ in ()).throw(ValueError('temporary failure')))
    with pytest.raises(ValueError):await p.channels.inbound(channel['id'],message)
    monkeypatch.setattr(p.tasks,'create',original)
    assert (await p.channels.inbound(channel['id'],message))['duplicate'] is False


@pytest.mark.asyncio
async def test_failed_parallel_node_cancels_siblings_before_committing(p,monkeypatch):
    task=p.tasks.create('ws_main',{'workflow':{'nodes':[{'id':'fail','type':'output'},{'id':'long','type':'output'}]}})
    p.tasks.patch(task['id'],'ws_main',status='running')
    stopped=asyncio.Event()
    async def execute(id,scope,node):
        if node['id']=='fail':
            await asyncio.sleep(.02)
            raise ValueError('invalid output')
        try:await asyncio.sleep(10)
        finally:stopped.set()
    monkeypatch.setattr(p.tasks,'_execute_node',execute)
    with pytest.raises(ValueError):await p.tasks._workflow(task['id'],'ws_main')
    assert stopped.is_set()
    nodes=p.store.get('task',task['id'],'ws_main')['nodes']
    assert nodes['fail']['status']=='failed' and nodes['long']['status']=='interrupted'


@pytest.mark.asyncio
async def test_docker_sandbox_flags_and_cleanup_on_timeout(p,monkeypatch):
    import subprocess
    from omicslab.suwen import sandbox
    commands=[]
    monkeypatch.setattr(sandbox.shutil,'which',lambda name:'docker')
    def run(command,**options):
        commands.append(command)
        if command[1]=='run':raise subprocess.TimeoutExpired(command,1)
        return SimpleNamespace(returncode=0,stdout='',stderr='')
    monkeypatch.setattr(sandbox.subprocess,'run',run)
    with pytest.raises(ValueError,match='超时'):await p.sandbox.execute('ws_main','while True: pass',1)
    command=next(c for c in commands if c[1]=='run')
    assert command[command.index('--network')+1]=='none'
    assert '--read-only' in command and '--memory' in command and '--cap-drop' in command
    assert commands[-1][:3]==['docker','rm','-f']


@pytest.mark.asyncio
async def test_openai_parameter_compatibility_performs_real_http_protocol(p,monkeypatch):
    from omicslab.agent.providers import ProviderConfig
    from omicslab.agent.providers.openai_compat import OpenAICompatProvider
    from omicslab.config import LLMTarget
    payloads=[]
    def handle(request):
        payload=json.loads(request.content);payloads.append(payload)
        if 'temperature' in payload:return httpx.Response(400,json={'error':'Unsupported temperature'})
        if 'max_tokens' in payload:return httpx.Response(400,json={'error':'Use max_completion_tokens instead of max_tokens'})
        return httpx.Response(200,headers={'content-type':'text/event-stream'},text='data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(handle),**kw))
    target=LLMTarget(provider='custom_openai',model='test',api_base='https://test.example/v1',api_key='key',family='openai',label='test')
    events=[e async for e in OpenAICompatProvider(target).stream_chat([{'role':'user','content':'test'}],None,ProviderConfig(temperature=.3,max_tokens=32))]
    assert len(payloads)==3 and payloads[-1]['max_completion_tokens']==32
    assert any(e.get('delta')=='OK' for e in events)


@pytest.mark.asyncio
async def test_gateway_fallback_never_replays_partial_output(p,monkeypatch):
    from omicslab.suwen import models
    from omicslab.agent.providers import ProviderConfig,LLMError
    backend=SimpleNamespace(workspace=p.require_workspace('ws_main'))
    p.config.update('models',{'fallbacks':[{'provider':'ollama','model':'fallback'}]})
    calls=[]
    class Provider:
        def __init__(self,target):self.target=target
        async def stream_chat(self,*args):
            calls.append(self.target.model)
            yield {'type':'text','delta':'partial'}
            raise LLMError('lost stream',retryable=True)
    monkeypatch.setattr(models,'make_provider',Provider)
    routed,cfg,_=p.models.prepare(p.settings,'mock','primary',p.state.agents['lead'],backend)
    with pytest.raises(LLMError):
        async for _ in routed.stream_chat([{'role':'system','content':'s'},{'role':'user','content':'u'}],None,cfg):pass
    assert calls==['primary']
