"""Suwen V2 platform API. All scoped endpoints validate the workspace first."""
import json
import re
import secrets
from datetime import datetime, time as dt_time, timedelta

from fastapi import APIRouter,Request,HTTPException,UploadFile
from fastapi.responses import JSONResponse

from .. import __version__
from ..suwen.configuration import DEFAULTS
from ..suwen.extensions import SCIENTIFIC
from ..suwen.store import uid,redact,Conflict
from ..suwen.tasks import validate_workflow

router=APIRouter(prefix='/api/platform',tags=['Suwen platform'])


def _session_has_runs(state,session_id):
    """Return true when submission produced a durable run before raising."""
    events=getattr(state,'events',None)
    list_runs=getattr(events,'list_runs',None)
    if callable(list_runs):
        try:
            return bool(list_runs(session_id=session_id,limit=1))
        except (AttributeError,KeyError,TypeError):
            pass
    active=getattr(events,'active_run_for_session',None)
    if callable(active):
        try:
            return bool(active(session_id))
        except (AttributeError,KeyError,TypeError):
            pass
    return False


def _discard_placeholder(state,conversation):
    """Remove an empty conversation only when no durable run can reference it."""
    if _session_has_runs(state,conversation.id):
        return False
    try:
        state.store.delete(conversation.id)
        return True
    except Exception:
        return False


async def _cancel_after_state_error(state,run_id):
    if not run_id:
        return
    try:
        await state.runs.cancel(run_id,'科研项目状态更新失败，已取消未登记运行')
    except Exception:
        pass


@router.get('/file-changes')
async def file_changes(request:Request,scope:str='ws_main',session_id:str=''):
    p=platform(request);p.require_workspace(scope)
    rows=p.store.list('file_change',scope,limit=100,session_id=session_id or None)
    return {'items':[{k:v for k,v in row.items() if k!='before'} for row in rows]}


@router.post('/file-changes/{change_id}/restore')
async def restore_file_change(request:Request,change_id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    from ..suwen.file_changes import restore
    try:
        return await restore(p,scope,change_id)
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc


@router.get('/science')
async def science_catalog(request:Request,scope:str='ws_main'):
    p=platform(request);ws=p.require_workspace(scope)
    from ..suwen.science_workbench import catalog
    _,skills=await desktop_skills(p)
    return {'workflows':catalog(skills),'skills':len(skills),'workspace':scope,
            'backend':ws.backend,'root':str(ws.remote.get('root','')) if ws.backend=='ssh' else str(ws.root),
            'recent':p.store.list('science_inspection',scope)[:10]}


@router.post('/science/inspect')
async def science_inspect(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    from .routes_harness import execute_backend
    try:
        if set(data)-{'kind','path'}:raise ValueError('未知检查参数')
        result=await execute_backend(await p.backend(scope),'science_inspect',data)
        # Persist compact provenance, not full coordinates/sequences per check.
        p.store.put('science_inspection',uid('inspect'),
            {key:result[key] for key in ['kind','path','workspace','sha256','bytes','status'] if key in result},
            scope,expected=0)
        return result
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/science/launch')
async def science_launch(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    from ..suwen.science_workbench import task_prompt
    try:
        _,skills=await desktop_skills(p)
        goal=data.get('goal')
        flow,prompt=task_prompt(data.get('lane'),goal,data.get('inputs',''),skills)
        conversation=p.state.store.create(agent=p.state.default_agent_info()['agent_id'],
            title=f"{flow['label']} · {str(goal).strip()[:60]}")
        from .chat import _workspace_binding
        _workspace_binding(p.state,conversation,scope)
        try:
            result=await p.state.runs.submit(session_id=conversation.id,message=prompt,
                workspace_id=scope,conversation=conversation,permission_mode='ask')
        except Exception as exc:
            _discard_placeholder(p.state,conversation)
            raise HTTPException(503,'任务提交失败，请检查模型、工作区与运行引擎状态') from exc
        return {'session_id':conversation.id,'run':result.get('run') or {}}
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.get('/quests')
async def quest_list(request:Request,scope:str='ws_main'):
    return {'items':platform(request).research.list(scope)}


@router.post('/quests')
async def quest_create(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    return guarded(lambda:p.research.create(scope,data))


@router.post('/quests/{id}/record')
async def quest_record(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:return await p.research.record(scope,id,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/quests/{id}/launch')
async def quest_launch(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    stage_id=data.get('stage')
    try:
        async with p.research.lock(scope,id):
            prompt=p.research.prompt(scope,id,stage_id)
            quest=p.research.get(scope,id)
            stage=next(s for s in quest['stages'] if s['id']==stage_id)
            if stage['status'] in {'running','recorded'}:raise ValueError('此阶段已有任务或证据，请查看原任务或创建后续课题')
            conversation=p.state.store.create(agent=p.state.default_agent_info()['agent_id'],title=f"Eve · {quest['title'][:60]} · {stage['label']}")
            from .chat import _workspace_binding
            _workspace_binding(p.state,conversation,scope)
            try:
                result=await p.state.runs.submit(session_id=conversation.id,message=prompt,workspace_id=scope,
                    conversation=conversation,permission_mode='ask')
            except Exception as exc:
                _discard_placeholder(p.state,conversation)
                raise HTTPException(503,'任务提交失败，请检查模型、工作区与运行引擎状态') from exc
            run=result.get('run') or {}
            stage.update(status='running',run_id=run.get('run_id'),session_id=conversation.id)
            try:
                p.store.put('research_quest',id,quest,scope,expected=quest['revision'])
            except Exception as exc:
                await _cancel_after_state_error(p.state,run.get('run_id'))
                raise HTTPException(409,'课题状态已变化，任务已取消；请刷新后重新启动') from exc
            return {'quest_id':id,'run':run,'session_id':conversation.id}
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.get('/wishes')
async def wish_list(request:Request,scope:str='ws_main'):
    return {'items':platform(request).wishes.list(scope)}


@router.get('/wishes/{id}')
async def wish_get(request:Request,id:str,scope:str='ws_main'):
    return guarded(lambda:platform(request).wishes.get(scope,id))


@router.post('/wishes')
async def wish_start(request:Request,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:return await p.wishes.start(scope,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.put('/wishes/{id}')
async def wish_update(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:return await p.wishes.update(scope,id,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/wishes/{id}/record')
async def wish_record(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:return await p.wishes.record(scope,id,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/wishes/{id}/block')
async def wish_block(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:return await p.wishes.block(scope,id,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/wishes/{id}/review')
async def wish_review(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    if data.get('confirmed') is not True:
        raise HTTPException(400,'需要用户明确确认')
    try:return await p.wishes.review(scope,id,data)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@router.post('/wishes/{id}/launch')
async def wish_launch(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);data=await body(request)
    try:
        async with p.wishes.lock(scope,id):
            # Validate before creating a conversation. A recorded, running or
            # blocked stage must not leave an orphan conversation behind.
            wish,stage_id=p.wishes.launch_target(scope,id,data.get('stage'))
            prompt=p.wishes.prompt(scope,id,stage_id,advance=data.get('advance') is not False)
            stage_label=next(s['label'] for s in wish['stages'] if s['id']==stage_id)
            conversation=p.state.store.create(agent=p.state.default_agent_info()['agent_id'],
                title=f"Eve · {wish['title'][:52]} · {stage_label}")
            from .chat import _workspace_binding
            _workspace_binding(p.state,conversation,scope)
            try:
                result=await p.state.runs.submit(session_id=conversation.id,message=prompt,workspace_id=scope,
                    conversation=conversation,permission_mode='ask')
            except Exception as exc:
                # Validation happens before creation, but the durable engine can
                # still reject a submission. Do not leave an empty conversation
                # in the sidebar when no run was created.
                _discard_placeholder(p.state,conversation)
                raise HTTPException(503,'任务提交失败，请检查模型、工作区与运行引擎状态') from exc
            run=result.get('run') or {}
            # launch_target reconciled a stale failed run to "failed". Use the
            # same projection here; checking the raw record would mistake that
            # old run for the new one and leave the submitted conversation
            # orphaned.
            fresh=p.wishes._reconcile(p.store.get('research_wish',id,scope))
            stage=next(s for s in fresh['stages'] if s['id']==stage_id)
            if stage['status'] in {'recorded','running'}:
                await _cancel_after_state_error(p.state,run.get('run_id'))
                raise ValueError('节点状态已变化，重复任务已取消')
            stage.update(status='running',run_id=run.get('run_id'),session_id=conversation.id)
            try:
                p.store.put('research_wish',id,fresh,scope,expected=fresh['revision'])
            except Exception as exc:
                await _cancel_after_state_error(p.state,run.get('run_id'))
                raise HTTPException(409,'科研愿望状态已变化，任务已取消；请刷新后重试') from exc
            p.store.audit('research_wish.launch',{'id':id,'stage':stage_id,'run':run.get('run_id')},scope)
            return {'wish_id':id,'run':run,'session_id':conversation.id,'stage':stage_id}
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


def _dashboard_time(value):
    """Parse run timestamps without making dashboard reads depend on one format."""
    if value in (None, ''):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value)).astimezone()
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip().replace('Z', '+00:00')
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        try:
            return datetime.fromtimestamp(float(text)).astimezone()
        except (OverflowError, OSError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone()


def _dashboard_timestamp(value):
    parsed=_dashboard_time(value)
    return parsed.timestamp() if parsed else 0


def _dashboard_scoped_runs(state,scope):
    events=getattr(state,'events',None)
    rows=[]
    if events is None:
        return rows
    try:
        summaries=events.list_run_summaries(500)
    except Exception:
        return rows
    for run in summaries:
        workspace=run.get('workspace') if isinstance(run.get('workspace'),dict) else {}
        if str(workspace.get('workspace_id') or workspace.get('id') or 'ws_main')!=scope:
            continue
        created=_dashboard_time(run.get('created_at'))
        started=_dashboard_time(run.get('started_at'))
        ended=_dashboard_time(run.get('ended_at'))
        duration_ms=None
        if started and ended and ended>=started:
            duration_ms=round((ended-started).total_seconds()*1000)
        usage=run.get('usage') if isinstance(run.get('usage'),dict) else {}
        tokens=int(usage.get('total_tokens') or 0)
        if not tokens:
            tokens=int(usage.get('prompt_tokens') or 0)+int(usage.get('completion_tokens') or 0)
        rows.append({
            'run_id':run.get('run_id'),
            'session_id':run.get('session_id'),
            'status':run.get('status'),
            'created_at':run.get('created_at'),
            'created':created,
            'started':started,
            'ended':ended,
            'duration_ms':duration_ms,
            'usage':usage,
            'tokens':tokens,
        })
    return rows


def _dashboard_usage_days(store,scope,days):
    """Return daily model usage in the server timezone with zero-filled days."""
    today=datetime.now().astimezone().date()
    dates=[today-timedelta(days=offset) for offset in range(days-1,-1,-1)]
    values={
        day.isoformat(): {
            'date':day.isoformat(),
            'input_tokens':0,
            'output_tokens':0,
            'tokens':0,
            'requests':0,
            'cost':0.0,
            'latency_ms':0.0,
        }
        for day in dates
    }
    start=datetime.combine(dates[0],dt_time.min).astimezone().timestamp()
    latency={key:[] for key in values}
    try:
        with store.lock:
            rows=store.db.execute(
                'SELECT input,output,cost,latency,created FROM usage '
                'WHERE scope=? AND created>=? ORDER BY created',
                (scope,start),
            ).fetchall()
    except Exception:
        rows=[]
    for row in rows:
        created=_dashboard_time(row['created'])
        if created is None:
            continue
        bucket=values.get(created.date().isoformat())
        if bucket is None:
            continue
        incoming=int(row['input'] or 0)
        outgoing=int(row['output'] or 0)
        bucket['input_tokens']+=incoming
        bucket['output_tokens']+=outgoing
        bucket['tokens']+=incoming+outgoing
        bucket['requests']+=1
        bucket['cost']+=float(row['cost'] or 0)
        if row['latency'] is not None:
            latency[bucket['date']].append(float(row['latency']))
    for day, samples in latency.items():
        if samples:
            values[day]['latency_ms']=round(sum(samples)/len(samples)*1000,1)
        values[day]['cost']=round(values[day]['cost'],6)
    return [values[day.isoformat()] for day in dates]


@router.get('/dashboard')
async def dashboard(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    wishes=p.wishes.list(scope)
    active=[wish for wish in wishes if wish.get('status') not in {'completed','archived'}]
    conversations=[
        row for row in p.state.store.list()
        if str(row.get('workspace_id') or 'ws_main')==scope
    ][:6]
    runs=_dashboard_scoped_runs(p.state,scope)
    dream=p.dreaming.status(scope)
    literature=p.literature.status(scope)
    usage=p.models.usage(scope)
    usage_days=_dashboard_usage_days(p.store,scope,30)
    trend_by_day={item['date']:item for item in usage_days}
    for item in usage_days:
        item.update({
            'runs':0,
            'succeeded':0,
            'failed':0,
            'other':0,
            'duration_ms':0.0,
        })
    duration_sum={day:0 for day in trend_by_day}
    duration_count={day:0 for day in trend_by_day}
    for run in runs:
        created=run.get('created')
        if created is None:
            continue
        item=trend_by_day.get(created.date().isoformat())
        if item is None:
            continue
        item['runs']+=1
        status=run.get('status')
        if status=='succeeded':
            item['succeeded']+=1
        elif status in {'failed','interrupted'}:
            item['failed']+=1
        else:
            item['other']+=1
        if run.get('duration_ms') is not None:
            key=item['date']
            duration_sum[key]+=run['duration_ms']
            duration_count[key]+=1
    for item in usage_days:
        if duration_count[item['date']]:
            item['duration_ms']=round(duration_sum[item['date']]/duration_count[item['date']],1)

    active_states={'queued','preparing','running','waiting_approval','stopping'}
    succeeded=sum(1 for run in runs if run.get('status')=='succeeded')
    failed=sum(1 for run in runs if run.get('status') in {'failed','interrupted'})
    durations=[run['duration_ms'] for run in runs if run.get('duration_ms') is not None]
    run_tokens=sum(run.get('tokens',0) for run in runs)
    usage_tokens=int(usage.get('tokens') or 0)

    projected_wishes=[]
    plans=[]
    blocked_wishes=0
    for wish in active:
        stages=wish.get('stages') or []
        recorded=sum(1 for stage in stages if stage.get('status')=='recorded')
        total=len(stages)
        blockers=[item for item in wish.get('blockers',[]) if item.get('resolved') is not True]
        if blockers:
            blocked_wishes+=1
        current=next(
            (stage for stage in stages if stage.get('status')!='recorded'),
            None,
        )
        next_actions=wish.get('next_actions') or []
        projected_wishes.append({
            'id':wish['id'],
            'title':wish['title'],
            'status':wish['status'],
            'phase':wish['phase'],
            'updated_at':wish.get('updated_at'),
            'next_action':next_actions[0] if next_actions else None,
            'next_actions':next_actions[:3],
            'blockers_count':len(blockers),
            'progress':{
                'recorded':recorded,
                'total':total,
                'percent':round(recorded/total*100) if total else 0,
                'current_stage':current.get('label') if current else '已进入复核',
                'current_stage_id':current.get('id') if current else 'review',
            },
        })
        for action in next_actions[:2]:
            plans.append({
                'wish_id':wish['id'],
                'wish_title':wish['title'],
                'stage':action.get('stage'),
                'label':action.get('label'),
                'owner':action.get('owner'),
                'reason':action.get('reason'),
                'output':action.get('output'),
                'updated_at':wish.get('updated_at'),
            })
        if blockers:
            plans.append({
                'wish_id':wish['id'],
                'wish_title':wish['title'],
                'stage':blockers[0].get('id'),
                'label':'补齐阻塞条件',
                'owner':'user',
                'reason':blockers[0].get('needed') or blockers[0].get('reason'),
                'output':'',
                'updated_at':wish.get('updated_at'),
            })
    plans.sort(key=lambda item:(
        0 if item.get('owner')=='user' else 1,
        -_dashboard_timestamp(item.get('updated_at')),
    ))
    user_actions=sum(1 for plan in plans if plan.get('owner')=='user')
    pricing_configured=bool(
        p.config.get('budget',scope)['value'].get('prices')
    )
    return {
        'scope':scope,
        'metrics':{
            'active_wishes':len(active),
            'running_runs':sum(1 for run in runs if run.get('status') in active_states),
            'pending_insights':dream['pending_count'],
            'tokens':usage_tokens or run_tokens,
            'total_runs':len(runs),
            'succeeded_runs':succeeded,
            'failed_runs':failed,
            'success_rate':round(succeeded/(succeeded+failed)*100,1) if succeeded+failed else 0,
            'avg_duration_ms':round(sum(durations)/len(durations)) if durations else 0,
            'requests':int(usage.get('requests') or 0),
            'avg_latency_ms':round(float(usage.get('latency') or 0)*1000,1),
            'cost':round(float(usage.get('cost') or 0),4),
            'pricing_configured':pricing_configured,
            'literature_deep_read':literature['today']['deep_read'],
            'literature_pending':literature['reflections_pending'],
            'skill_candidates_pending':literature['skill_candidates_pending'],
            'proactive_messages':literature['proactive']['queued'],
        },
        'brief':{
            'user_actions':user_actions,
            'agent_actions':sum(1 for plan in plans if plan.get('owner')=='agent'),
            'blocked_wishes':blocked_wishes,
        },
        'trends':{
            'range_days':30,
            'days':usage_days,
        },
        'plans':plans[:8],
        'wishes':projected_wishes[:6],
        'conversations':conversations,
        'runs':[
            {
                'run_id':run.get('run_id'),
                'session_id':run.get('session_id'),
                'status':run.get('status'),
                'created_at':run.get('created_at'),
                'usage':run.get('usage') or {},
                'tokens':run.get('tokens',0),
                'duration_ms':run.get('duration_ms'),
            }
            for run in runs[:6]
        ],
        'insights':dream['candidates'],
        'dreaming':{
            'enabled':dream['enabled'],
            'auto':dream['auto'],
            'last_run':dream['last_run'],
        },
        'literature':{
            'enabled':literature['enabled'],
            'daily_enabled':literature['daily_enabled'],
            'last_run':literature['last_run'],
            'today':literature['today'],
            'reflections_pending':literature['reflections_pending'],
            'skill_candidates_pending':literature['skill_candidates_pending'],
            'feed_posts':literature['feed_posts'],
            'proactive':literature['proactive'],
        },
    }


@router.get('/dreaming')
async def dreaming_status(request:Request,scope:str='ws_main'):
    return platform(request).dreaming.status(scope)


@router.patch('/dreaming/settings')
async def dreaming_settings(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    try:
        value=p.dreaming.update(scope,data)
        return {'ok':True,'settings':value,'status':p.dreaming.status(scope)}
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc


@router.post('/dreaming/run')
async def dreaming_run(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    try:
        result=await p.dreaming.run(
            scope,
            trigger='manual',
            focus=str(data.get('focus') or 'all'),
        )
        return {'ok':result.get('status')!='failed','run':result,'status':p.dreaming.status(scope)}
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc


@router.get('/dreaming/candidates')
async def dreaming_candidates(request:Request,scope:str='ws_main',status:str='pending'):
    try:
        return {'items':platform(request).dreaming.candidates(scope,status)}
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc


@router.post('/dreaming/candidates/{id}/accept')
async def dreaming_accept(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if data.get('confirmed') is not True:
        raise HTTPException(400,'需要用户明确确认')
    try:
        return await p.dreaming.accept(scope,id,note=str(data.get('note') or ''))
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc


@router.post('/dreaming/candidates/{id}/reject')
async def dreaming_reject(request:Request,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    try:
        return p.dreaming.reject(scope,id,reason=str(data.get('reason') or ''))
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc


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


async def sync_desktop_mcp(p,server):
    """Mirror one UI-managed MCP into the unified desktop Harness registry.

    Python retains the legacy Capability Center and its health/details view,
    while the TypeScript registry remains the single MCP registry consumed by
    the unified Agent loop. Secret values move only through the authenticated,
    in-process named pipe and are never persisted by the desktop daemon.
    """
    adapter=getattr(p.state.loop,'desktop_harness',None)
    if not adapter or not isinstance(server,dict):return
    env_refs=server.get('env_refs') if isinstance(server.get('env_refs'),dict) else {}
    header_refs=server.get('header_refs') if isinstance(server.get('header_refs'),dict) else {}
    references=[str(ref) for ref in (*env_refs.values(),*header_refs.values()) if ref]
    refs={ref:p.vault.get(ref) for ref in references if p.vault.get(ref)}
    if refs:await adapter.rpc('secrets.set',refs=refs)
    payload={
        'id':server.get('id'),
        'name':server.get('name') or 'MCP server',
        'transport':'http' if server.get('transport')=='http' else 'stdio',
        'enabled':bool(server.get('enabled')),
        'readOnly':server.get('read_only',True) is not False,
        'projects':[str(item) for item in server.get('workspaces',[])],
        'env':[{'name':str(name),'ref':str(ref)} for name,ref in env_refs.items()],
        'headers':[{'name':str(name),'ref':str(ref)} for name,ref in header_refs.items()],
    }
    if payload['transport']=='http':payload['url']=server.get('url')
    else:
        payload['command']=server.get('command')
        payload['args']=[str(item) for item in server.get('args',[])]
    await adapter.rpc('mcp.add',**payload)


async def remove_desktop_mcp(p,id):
    adapter=getattr(p.state.loop,'desktop_harness',None)
    if not adapter:return
    listed=await adapter.rpc('mcp.list')
    if any(item.get('id')==id for item in listed.get('servers',[])):
        await adapter.rpc('mcp.remove',id=id)


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
    return {'brand':'素问 Suwen','version':__version__,'schema_version':2,'scope':scope,
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
async def registry_list(request:Request,kind:str,scope:str='ws_main',q:str='',offset:int=0,limit:int=0):
    p=platform(request);p.require_workspace(scope)
    if kind not in {'mcp','channel','agent','skill','workflow','schedule','artifact','evidence','review','source','trash'}:raise HTTPException(404,'未知注册表')
    if kind=='skill':
        adapter,native=await desktop_skills(p)
        items=p.skills.installed(scope)
        items.extend(dict(item,runtime='desktop',status='installed' if item['enabled'] else 'disabled') for item in native)
        if q:
            words=q.casefold().split()
            items=[item for item in items if all(word in (str(item.get('name',''))+' '+str(item.get('description',''))).casefold() for word in words)]
        total=len(items)
        offset=max(0,offset)
        if limit:items=items[offset:offset+min(100,max(1,limit))]
        return {'items':items,'total':total,'offset':offset,'scientific':SCIENTIFIC}
    items=p.store.list(kind,'global' if kind in {'mcp','channel','agent'} else scope)
    if kind=='mcp':
        items=[dict(r,status=p.store.get('mcp_status',r['id'])) for r in items]
        for row in items:await sync_desktop_mcp(p,row)
    if kind=='channel':items=[dict(r,connection=p.store.get('channel_status',r['id'])) for r in items if r.get('workspace')==scope]
    return {'items':redact(items)}


@router.post('/registry/{kind}')
async def registry_create(request:Request,kind:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    if kind=='mcp':
        row=guarded(lambda:p.mcp.save(data))
        await sync_desktop_mcp(p,row)
        return row
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
    if kind=='mcp':
        row=guarded(lambda:p.mcp.save(value,id))
        await sync_desktop_mcp(p,row)
        return row
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
    if kind=='mcp':await remove_desktop_mcp(p,id)
    if kind not in {'mcp','channel','agent','skill','workflow','schedule','evidence','source','artifact'}:raise HTTPException(400,'记录不可通过此接口删除')
    return guarded(lambda:p.store.delete(kind,id,'global' if kind in {'mcp','channel','agent'} else scope))


@router.get('/registry/{kind}/{id}/history')
async def registry_history(request:Request,kind:str,id:str,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    if kind not in {'skill','workflow','artifact','evidence'}:raise HTTPException(400,'不支持此类历史')
    return {'items':p.store.history(kind,id,scope)}


@router.post('/skills/install')
async def skill_install(request:Request,scope:str='ws_main'):
    p=platform(request);workspace=p.require_workspace(scope);data=await body(request)
    adapter=getattr(p.state.loop,'desktop_harness',None)
    if not adapter:return await p.skills.install(scope,data)
    if data.get('trusted') is not True:raise HTTPException(400,'请审核来源并确认安装')
    from pathlib import Path
    source=str(data.get('source') or '')
    if source.startswith('https://'):
        if source.endswith('.git'):
            source=source[:-4]+'/tree/'+str(data.get('ref') or 'main')+'/'+str(data.get('subpath') or '.')
        return await adapter.rpc('skill.import',url=source)
    source_path=Path(source).expanduser()
    # The desktop bridge runs from its isolated runtime directory. Relative
    # paths in the Capability Center therefore resolve against the selected
    # workspace, matching file tools and chat rather than the bridge CWD.
    if not source_path.is_absolute():
        if workspace.backend!='local' or workspace.root is None:
            raise HTTPException(400,'远程工作区的 UI 技能安装需要绝对路径；Agent 可使用 skill_install 从远端目录安装')
        workspace_root=Path(workspace.root).expanduser().resolve()
        source_path=(workspace_root/source_path).resolve()
        if not source_path.is_relative_to(workspace_root):
            raise HTTPException(400,'相对技能路径不能越过当前工作区')
    root=source_path.resolve()
    directory=(root/str(data.get('subpath') or '.')).resolve()
    if not directory.is_relative_to(root) or not (directory/'skill.json').is_file():raise HTTPException(400,'本地技能目录需要 skill.json 与 SKILL.md；Codex 技能可使用 GitHub tree 目录链接安装')
    return await adapter.rpc('skill.import',path=str(directory))


@router.get('/skills/graph')
async def skill_graph_status(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope)
    skills=dict(p.state.loop.skills,p.skills.load(scope))
    p.skill_graph.sync(scope,skills)
    return p.skill_graph.status(scope,len(skills))


@router.post('/skills/graph/select')
async def skill_graph_select(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    query=str(data.get('query') or '').strip()
    if not query:
        raise HTTPException(400,'需要检索任务描述')
    skills=dict(p.state.loop.skills,p.skills.load(scope))
    selected=p.skill_graph.select(scope,query,skills)
    return {
        'query':query,
        'skills':[
            {
                'name':skill.name,
                'description':skill.description,
                'dependencies':skill.dependencies,
                'source':skill.source,
            }
            for skill in selected.values()
        ],
    }


@router.post('/skills/graph/feedback')
async def skill_graph_feedback(request:Request,scope:str='ws_main'):
    p=platform(request);p.require_workspace(scope);data=await body(request)
    run_id=str(data.get('run_id') or '').strip()
    if not run_id or not isinstance(data.get('success'),bool):
        raise HTTPException(400,'需要 run_id 与 success 布尔值')
    p.skill_graph.finish_run(
        scope,
        run_id,
        data['success'],
        str(data.get('summary') or ''),
    )
    return p.skill_graph.status(scope,len(dict(p.state.loop.skills,p.skills.load(scope))))


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
        row=p.mcp.save({'name':name,'transport':'http' if value.get('url') else 'stdio',
            'url':value.get('url'),'command':value.get('command'),'args':value.get('args',[]),
            'env_refs':refs,'header_refs':headers,'enabled':False,'workspaces':[scope]},key)
        await sync_desktop_mcp(p,row)
        records.append(row)
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
