"""Suwen V2 platform API. All scoped endpoints validate the workspace first."""
import json
import re
import secrets

from fastapi import APIRouter,Request,HTTPException,UploadFile
from fastapi.responses import JSONResponse

from ..suwen.configuration import DEFAULTS
from ..suwen.extensions import SCIENTIFIC
from ..suwen.store import uid,redact,Conflict
from ..suwen.tasks import validate_workflow

router=APIRouter(prefix='/api/platform',tags=['Suwen platform'])


def platform(request):
    service=getattr(request.app.state.omicslab,'platform',None)
    if service is None:raise HTTPException(503,'平台服务未就绪')
    return service


def scope_for(p,scope):
    if scope!='global':p.require_workspace(scope)
    return scope


async def desktop_skills(p):
    """Use the same installed catalog and toggles as chat's durable harness."""
    adapter=getattr(p.state.loop,'desktop_harness',None)
    if not adapter:return None,[]
    return adapter,(await adapter.rpc('skill.list')).get('skills',[])


async def body(request):
    raw=await request.body()
    if len(raw)>4_000_000:raise HTTPException(413,'请求超过 4MB')
    try:data=json.loads(raw or '{}')
    except ValueError:raise HTTPException(400,'JSON 格式错误')
    if not isinstance(data,dict):raise HTTPException(400,'需要 JSON 对象')
    return data


def guarded(fn):
    # Kept as a helper for actionable, redacted operation errors.
    try:return fn()
    except PermissionError as exc:raise HTTPException(403,str(exc))
    except Conflict as exc:raise HTTPException(409,str(exc))
    except (ValueError,KeyError) as exc:raise HTTPException(400,redact(str(exc)))


@router.get('/bootstrap')
async def bootstrap(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    return {'brand':'素问 Suwen','version':'2.1.1','schema_version':2,'scope':scope,
        'settings':{key:p.config.get(key,scope) for key in DEFAULTS},
        'sections':list(DEFAULTS),'migration':redact(p.store.get('migration','v2')),
        'scientific':SCIENTIFIC,'capabilities':{'persistent_tasks':True,'mcp':['stdio','http'],'knowledge':['text','markdown','docx','pdf_optional'],
          'channels':['webchat','telegram','wechat'],'os_sandbox':p.sandbox.status(),'multiuser_rbac':False}}


@router.get('/config/{section}')
async def config_get(request:Request,section:str,scope:str='global'):
    p=platform(request);scope_for(p,scope)
    return guarded(lambda:p.config.get(section,scope))


@router.put('/config/{section}')
async def config_put(request:Request,section:str,scope:str='global'):
    p=platform(request);scope_for(p,scope);data=await body(request)
    result=guarded(lambda:p.config.update(section,data.get('value',{}),scope,data.get('revision')))
    if section=='appearance':p.refresh_agents()
    return result


@router.get('/config/{section}/history')
async def config_history(request:Request,section:str,scope:str='global'):
    p=platform(request);scope_for(p,scope)
    return {'items':p.store.history('config',section,scope)}


@router.post('/config/{section}/rollback')
async def config_rollback(request:Request,section:str,scope:str='global'):
    p=platform(request);scope_for(p,scope);data=await body(request)
    return guarded(lambda:p.config.rollback(section,int(data.get('revision',0)),scope))


@router.post('/config/{section}/reset')
async def config_reset(request:Request,section:str,scope:str='global'):
    p=platform(request);scope_for(p,scope)
    return guarded(lambda:p.config.update(section,DEFAULTS[section],scope))


@router.get('/configuration/export')
async def config_export(request:Request,scope:str='global'):
    p=platform(request);scope_for(p,scope)
    return JSONResponse({'schema_version':2,'config':{key:redact(p.config.get(key,scope)['value']) for key in DEFAULTS}},
        headers={'Content-Disposition':'attachment; filename="suwen-config.json"'})


@router.post('/configuration/import')
async def config_import(request:Request,scope:str='global'):
    p=platform(request);scope_for(p,scope);data=await body(request)
    if data.get('schema_version')!=2:raise HTTPException(400,'仅接受 Schema V2 脱敏配置')
    config=data.get('config')
    if not isinstance(config,dict):raise HTTPException(400,'缺少 config 对象')
    for key,value in config.items():guarded(lambda:p.config.update(key,value,scope,validate_only=True))
    p.store.backup()
    return {'settings':{key:guarded(lambda:p.config.update(key,value,scope)) for key,value in config.items()}}


@router.post('/credentials/{id}')
async def credential_put(request:Request,id:str):
    p=platform(request);data=await body(request)
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',id):raise HTTPException(400,'凭据标识无效')
    return guarded(lambda:p.vault.put(id,data.get('value',''),data.get('persist',True)))


@router.get('/diagnostics')
async def diagnostics(request:Request,scope:str='ws_main',download:bool=False):
    p=platform(request);data=guarded(lambda:redact(p.diagnostics(scope)))
    return JSONResponse(data,headers={'Content-Disposition':'attachment; filename="suwen-diagnostics.json"'} if download else {})


@router.post('/diagnostics/model-test')
async def model_test(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    from dataclasses import replace
    from types import SimpleNamespace
    import time
    start=time.monotonic()
    events=[]
    target=p.settings.resolve_llm()
    try:
        routed,cfg,target=p.models.prepare(p.settings,None,None,p.state.agents['lead'],SimpleNamespace(workspace=p.require_workspace(scope)))
        async for event in routed.stream_chat([{'role':'system','content':'You are a connection test.'},{'role':'user','content':'Reply OK.'}],None,replace(cfg,max_tokens=32,timeout_s=30)):
            if event.get('type')=='text':events.append(event.get('delta',''))
        result={'ok':True,'mode':'mock' if target.provider=='mock' else 'live','model':routed.active_model,'latency_ms':int((time.monotonic()-start)*1000),'response':''.join(events)[:500]}
    except Exception as exc:
        result={'ok':False,'mode':'live','error':redact(str(exc))[:1000]}
    p.store.audit('model.test',result,scope);return result


@router.get('/registry/{kind}')
async def registry_list(request:Request,kind:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    if kind not in {'mcp','channel','agent','skill','workflow','schedule','artifact','evidence','review','source','trash'}:raise HTTPException(404,'未知注册表')
    if kind=='skill':
        adapter,native=await desktop_skills(p)
        items=p.skills.installed(scope)
        items.extend(dict(item,runtime='desktop',status='installed' if item['enabled'] else 'disabled') for item in native)
        return {'items':items,'scientific':SCIENTIFIC}
    items=p.store.list(kind,'global' if kind in {'mcp','channel','agent'} else scope)
    if kind=='mcp':items=[dict(r,status=p.store.get('mcp_status',r['id'])) for r in items]
    if kind=='channel':items=[dict(r,connection=p.store.get('channel_status',r['id'])) for r in items if r.get('workspace')==scope]
    return {'items':redact(items)}


@router.post('/registry/{kind}')
async def registry_create(request:Request,kind:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if kind=='mcp':return guarded(lambda:p.mcp.save(data))
    if kind=='channel':return guarded(lambda:p.channels.save(data))
    if kind=='agent':return guarded(lambda:p.save_agent(data))
    if kind=='workflow':
        guarded(lambda:validate_workflow(data))
        return p.store.put('workflow',uid('flow'),data,scope)
    if kind=='schedule':return guarded(lambda:p.schedule(scope,data))
    if kind=='evidence':
        if data.get('kind') not in {'evidence','inference','hypothesis'}:raise HTTPException(400,'需要明确证据、推断或假设类型')
        if data['kind']=='evidence' and not (data.get('citations') or data.get('task')):raise HTTPException(400,'证据必须关联来源或计算任务')
        if data.get('task') and not p.store.get('task',data['task'],scope):raise HTTPException(400,'关联任务不在当前工作区')
        return p.store.put('evidence',uid('evidence'),data,scope)
    raise HTTPException(400,'此类记录不支持通用创建')


@router.put('/registry/{kind}/{id}')
async def registry_update(request:Request,kind:str,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    store_scope='global' if kind in {'mcp','channel','agent'} else scope
    if kind=='skill':
        adapter,native=await desktop_skills(p)
        if any(item['id']==id for item in native):
            if set(data)!={'enabled'} or not isinstance(data['enabled'],bool):raise HTTPException(400,'技能仅可启停')
            return (await adapter.rpc('skill.enable' if data['enabled'] else 'skill.disable',id=id))['skill']
    old=p.store.get(kind,id,store_scope)
    if not old:raise HTTPException(404,'记录不存在')
    value=dict(old,**data)
    if kind=='mcp':return guarded(lambda:p.mcp.save(value,id))
    if kind=='channel':return guarded(lambda:p.channels.save(value,id))
    if kind=='agent':return guarded(lambda:p.save_agent(value,id))
    if kind=='workflow':guarded(lambda:validate_workflow(value));return p.store.put(kind,id,value,scope)
    if kind=='schedule':return guarded(lambda:p.schedule(scope,value,id))
    if kind=='skill':
        if set(data)-{'enabled'}:raise HTTPException(400,'技能仅可通过此接口启停；升级请安装新版本')
        return p.store.put(kind,id,value,scope)
    raise HTTPException(400,'此记录不可直接编辑')


@router.delete('/registry/{kind}/{id}')
async def registry_delete(request:Request,kind:str,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    if kind=='skill':
        adapter,native=await desktop_skills(p)
        if any(item['id']==id for item in native):return await adapter.rpc('skill.remove',id=id)
    if kind not in {'mcp','channel','agent','skill','workflow','schedule','evidence','source','artifact'}:raise HTTPException(400,'记录不可通过此接口删除')
    return guarded(lambda:p.store.delete(kind,id,'global' if kind in {'mcp','channel','agent'} else scope))


@router.get('/registry/{kind}/{id}/history')
async def registry_history(request:Request,kind:str,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    if kind not in {'skill','workflow','artifact','evidence'}:raise HTTPException(400,'不支持此类历史')
    return {'items':p.store.history(kind,id,scope)}


@router.post('/skills/install')
async def skill_install(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    adapter=getattr(p.state.loop,'desktop_harness',None)
    if not adapter:return await p.skills.install(scope,data)
    if data.get('trusted') is not True:raise HTTPException(400,'请审核来源并确认安装')
    from pathlib import Path
    source=str(data.get('source') or '')
    if source.startswith('https://'):
        if source.endswith('.git'):
            source=source[:-4]+'/tree/'+str(data.get('ref') or 'main')+'/'+str(data.get('subpath') or '.')
        return await adapter.rpc('skill.import',url=source)
    root=Path(source).expanduser().resolve()
    directory=(root/str(data.get('subpath') or '.')).resolve()
    if not directory.is_relative_to(root) or not (directory/'skill.json').is_file():raise HTTPException(400,'本地技能目录需要 skill.json 与 SKILL.md；Codex 技能可使用 GitHub tree 目录链接安装')
    return await adapter.rpc('skill.import',path=str(directory))


@router.post('/skills/{id}/rollback')
async def skill_rollback(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    row=next((r for r in p.store.history('skill',id,scope) if r['revision']==data.get('revision')),None)
    if not row or not ( __import__('pathlib').Path(row['path'])/'SKILL.md').is_file():raise HTTPException(400,'旧版本不存在')
    return p.store.put('skill',id,dict(row,enabled=False),scope)


@router.post('/mcp/{id}/discover')
async def mcp_discover(request:Request,id:str):return await platform(request).mcp.discover(id)


@router.post('/mcp/{id}/test-tool')
async def mcp_test(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return await p.mcp.test_tool(id,data.get('name',''),data.get('arguments',{}),scope,data.get('approved',False))


@router.get('/tasks')
async def tasks_list(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);return {'items':p.store.list('task',scope)}


@router.post('/tasks')
async def tasks_create(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    if data.get('workflow_id'):
        workflow=p.store.get('workflow',data['workflow_id'],scope)
        if not workflow:raise HTTPException(404,'工作流不存在')
        data['workflow']=workflow
    return guarded(lambda:p.tasks.create(scope,data))


@router.post('/tasks/{id}/{action}')
async def task_control(request:Request,id:str,action:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if action=='approve':
        task=p.store.get('task',id,scope)
        if not task or task['status']!='waiting_approval':raise HTTPException(400,'没有等待审批的节点')
        if not data.get('confirmed'):raise HTTPException(400,'请明确确认审批')
        for node,value in task['nodes'].items():
            if value['status']=='waiting_approval':p.tasks.node_patch(id,scope,node,approved=True)
        return await p.tasks.control(id,scope,'resume')
    return await p.tasks.control(id,scope,action,data.get('confirmed',False))


@router.post('/debate')
async def debate(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request);return guarded(lambda:p.debate(scope,data))


@router.get('/knowledge')
async def knowledge_list(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);return p.knowledge.export(scope)


@router.post('/knowledge')
async def knowledge_add(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return await p.knowledge.add(scope,data.get('title','记忆'),data.get('text',''),data.get('kind','memory'),data.get('source',''))


@router.post('/knowledge/search')
async def knowledge_search(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return {'items':await p.knowledge.search(scope,data.get('query',''),int(data.get('limit',5)),data.get('source',''))}


@router.put('/knowledge/{id}')
async def knowledge_edit(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    old=p.store.get('knowledge',id,scope)
    if not old:raise HTTPException(404,'记忆不存在')
    text=data.get('text',old['text'])
    from ..suwen.knowledge import sensitive
    if sensitive(text):raise HTTPException(400,'包含敏感信息，请先脱敏')
    vector=await p.knowledge.vector(text,scope)
    import hashlib
    return p.store.put('knowledge',id,dict(old,text=text,title=data.get('title',old['title']),vector=vector,
        digest=hashlib.sha256(text.strip().encode()).hexdigest()),scope)


@router.delete('/knowledge/{id}')
async def knowledge_delete(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);return guarded(lambda:p.store.delete('knowledge',id,scope))


@router.post('/knowledge/import')
async def knowledge_import(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    items=data.get('items',[])
    if len(items)>1000:raise HTTPException(400,'一次最多导入 1000 条记忆')
    return {'items':[await p.knowledge.add(scope,item.get('title','记忆'),item['text'],item.get('kind','memory'),item.get('source','')) for item in items]}


@router.post('/knowledge/upload')
async def knowledge_upload(request:Request,file:UploadFile,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    return await p.knowledge.index(scope,file.filename or 'document.txt',await file.read(10_000_001))


@router.post('/knowledge/reembed')
async def knowledge_reembed(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);count=0
    config=p.config.get('memory',scope)['value']
    for item in p.store.list('knowledge',scope):
        vector=await p.knowledge.vector(item['text'],scope)
        p.store.put('knowledge',item['id'],dict(item,vector=vector,embedding_model=config['embedding_model'] if vector else None),scope);count+=1
    return {'ok':True,'updated':count}


@router.post('/artifacts/snapshot')
async def artifact_snapshot(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request);return await p.snapshot(scope,data.get('path',''),data.get('task',''))


@router.post('/artifacts/{id}/restore')
async def artifact_restore(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    if not data.get('confirmed'):raise HTTPException(400,'恢复会修改工作文件，请明确确认')
    return await p.restore_artifact(scope,id,data.get('revision'))


@router.post('/reviews')
async def review(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request);return await p.review(scope,data.get('path',''),data.get('run',''),data.get('original_data',''))


@router.post('/channels/{id}/test')
async def channel_test(request:Request,id:str):return await platform(request).channels.test(id)


@router.post('/channels/wechat/login')
async def wechat_login(request:Request,scope:str='ws_main'):
    return await platform(request).channels.wechat.begin(scope,await body(request))


@router.post('/channels/wechat/login/{id}/status')
async def wechat_login_status(request:Request,id:str,scope:str='ws_main'):
    data=await body(request)
    return await platform(request).channels.wechat.status(id,scope,str(data.get('verify_code') or ''))


@router.delete('/channels/wechat/login/{id}')
async def wechat_login_cancel(request:Request,id:str,scope:str='ws_main'):
    return platform(request).channels.wechat.cancel(id,scope)


@router.post('/channels/{id}/send')
async def channel_send(request:Request,id:str):
    p=platform(request);data=await body(request)
    return await p.channels.send(id,data.get('contact',''),data.get('text',''),data.get('approved',False))


@router.post('/channels/{id}/webhook')
async def channel_webhook(request:Request,id:str):
    p=platform(request);row=p.store.get('channel',id)
    expected=p.vault.get(row.get('webhook_ref')) if row else ''
    supplied=request.headers.get('X-Suwen-Token') or request.headers.get('X-Telegram-Bot-Api-Secret-Token') or ''
    if not expected or not secrets.compare_digest(supplied,expected):raise HTTPException(401,'Webhook 未授权')
    data=await body(request)
    if row['adapter']=='telegram':
        message=data.get('message',{});sender=message.get('from',{})
        if message.get('chat',{}).get('type')!='private':raise HTTPException(403,'此渠道未启用群聊')
        data={'contact':str(sender.get('id','')),'message_id':str(data.get('update_id','')),'text':message.get('text','')}
    return await p.channels.inbound(id,data)


@router.post('/backup')
async def backup(request:Request):
    p=platform(request);return {'ok':True,'path':str(p.store.backup()),'credentials':'OS-encrypted; not a portable credential export'}


@router.get('/layout')
async def layout_get(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    return p.store.get('layout','workspace',scope) or {'rightWidth':330,'bottomHeight':210,'hideRight':False,'hideBottom':False}


@router.put('/layout')
async def layout_put(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if not 240<=float(data.get('rightWidth',330))<=640 or not 120<=float(data.get('bottomHeight',210))<=460:
        raise HTTPException(400,'面板大小超出允许范围')
    return p.store.put('layout','workspace',{key:data.get(key,default) for key,default in
        {'rightWidth':330,'bottomHeight':210,'hideRight':False,'hideBottom':False}.items()},scope)


@router.post('/mcp/import')
async def mcp_import(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    definitions=data.get('mcpServers')
    if not isinstance(definitions,dict) or len(definitions)>30:raise HTTPException(400,'需要最多 30 个 mcpServers 定义')
    records=[]
    for name,value in definitions.items():
        key=uid('mcp');refs={};headers={}
        for env,secret in value.get('env',{}).items():
            ref=f'{key}_env_{len(refs)}';p.vault.put(ref,str(secret));refs[env]=ref
        for header,secret in value.get('headers',{}).items():
            ref=f'{key}_header_{len(headers)}';p.vault.put(ref,str(secret));headers[header]=ref
        records.append(p.mcp.save({'name':name,'transport':'http' if value.get('url') else 'stdio',
            'url':value.get('url'),'command':value.get('command'),'args':value.get('args',[]),
            'env_refs':refs,'header_refs':headers,'enabled':False,'workspaces':[scope]},key))
    return {'items':records,'enabled':False}


@router.get('/biomedical')
async def biomedical_status(request:Request):return platform(request).biomedical.status()


@router.post('/biomedical/tools')
async def biomedical_tools(request:Request):
    p=platform(request);data=await body(request);return {'tools':p.biomedical.retrieve(data.get('query',''))}


@router.post('/biomedical/sequence')
async def biomedical_sequence(request:Request):
    p=platform(request);data=await body(request);return guarded(lambda:p.biomedical.sequence(data.get('sequence','')))


@router.post('/biomedical/protein')
async def biomedical_protein(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return await p.biomedical.protein(scope,data.get('accession',''))


@router.get('/research')
async def research_get(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    return {'claims':p.store.list('claim',scope),'sources':p.store.list('bio_source',scope),
        'gates':p.store.list('evidence_gate',scope),'provenance':p.store.list('provenance',scope)}


@router.post('/research/literature')
async def research_literature(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return await p.biomedical.literature(scope,data.get('query',''),int(data.get('limit',5)))


@router.post('/research/claims')
async def research_claim(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return guarded(lambda:p.biomedical.record_claim(scope,data.get('run',''),data))


@router.post('/research/claims/{id}/verify')
async def research_verify(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    return await p.biomedical.verify(scope,id,data.get('path',''),data.get('rules',[]))


@router.post('/research/claims/{id}/review')
async def research_review(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    claim=p.store.get('claim',id,scope)
    if not claim:raise HTTPException(404,'结论不存在')
    if not data.get('confirmed') or not data.get('reviewer') or len(data.get('notes',''))<10:
        raise HTTPException(400,'需要明确确认、复核署名和至少 10 个字的复核说明')
    if not claim.get('sources'):raise HTTPException(400,'没有可追溯来源，不能标记科学复核完成')
    if any(not c.get('passed') for c in claim.get('checks',[])):raise HTTPException(400,'存在未通过的指标检查，请先解决')
    for source in claim['sources']:
        row=p.store.get('bio_source',source,scope)
        if not row or row.get('retracted') or not row.get('source_verified'):raise HTTPException(400,'来源缺失、未验证或包含撤稿标志')
    row=p.store.put('claim',id,dict(claim,validation_status='human_reviewed',reviewer=data['reviewer'],review_notes=data['notes']),scope)
    if claim.get('run'):p.biomedical.gate(scope,claim['run'],'',True)
    p.store.audit('research.human_review',{'claim':id,'reviewer':data['reviewer']},scope)
    return row


@router.get('/artifacts/{id}/diff')
async def artifact_diff(request:Request,id:str,revision:int,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    current=p.store.get('artifact',id,scope)
    previous=next((r for r in p.store.history('artifact',id,scope) if r['revision']==revision),None)
    if not current or not previous:raise HTTPException(404,'产物或历史版本不存在')
    from pathlib import Path
    import difflib
    folder=p.store.home/'suwen'/'blobs'
    old=(folder/previous['digest']).read_bytes();new=(folder/current['digest']).read_bytes()
    if len(old)+len(new)>400000 or b'\0' in old or b'\0' in new:
        return {'binary':True,'old':previous['digest'],'new':current['digest'],'diff':'二进制或大文件请下载后使用对应工具比较'}
    return {'binary':False,'diff':''.join(difflib.unified_diff(old.decode('utf-8','replace').splitlines(True),new.decode('utf-8','replace').splitlines(True),fromfile=f'v{revision}',tofile=f'v{current["revision"]}'))}


@router.post('/trash/{id}/restore')
async def trash_restore(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);scope_for(p,scope)
    row=p.store.get('trash',id,scope)
    if not row:raise HTTPException(404,'可恢复记录不存在')
    kind=row['kind'];record=row['record']
    if kind not in {'mcp','channel','agent','skill','workflow','schedule','evidence','source','artifact','knowledge'}:raise HTTPException(400,'此记录不能恢复')
    if p.store.get(kind,record['id'],scope):raise HTTPException(409,'原标识已经存在，请检查当前记录')
    if kind in {'mcp','channel','skill','schedule'}:record['enabled']=False
    result=p.store.put(kind,record['id'],record,scope)
    p.store.put('trash',id,dict(row,restored=True),scope)
    if kind=='agent':p.refresh_agents()
    return result


@router.get('/experiments')
async def experiments_list(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    return {'items':p.store.list('experiment',scope)}


@router.post('/experiments')
async def experiment_record(request:Request,scope:str='ws_main'):
    return await platform(request).experiments.record(scope,await body(request))


@router.post('/experiments/compare')
async def experiments_compare(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    return guarded(lambda:p.experiments.compare(scope,data.get('ids')))


@router.get('/workflows/{id}/export')
async def workflow_export(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    flow=p.store.get('workflow',id,scope)
    if not flow:raise HTTPException(404,'工作流不存在')
    return {'schema_version':1,'workflow':redact({k:flow[k] for k in ('name','nodes') if k in flow})}


@router.post('/workflows/import')
async def workflow_import(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if data.get('schema_version')!=1:raise HTTPException(400,'工作流 Schema 必须为 1')
    flow=data.get('workflow')
    if not isinstance(flow,dict):raise HTTPException(400,'缺少工作流对象')
    guarded(lambda:validate_workflow(flow))
    return p.store.put('workflow',uid('flow'),{k:flow[k] for k in ('name','nodes') if k in flow},scope)
