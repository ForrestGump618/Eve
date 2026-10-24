"""Opt-in Sage-compatible batches; each child receives only its explicit brief."""
import asyncio
import json
from .store import redact


async def spawn(platform,ctx,args):
    scope=getattr(getattr(getattr(ctx,'backend',None),'workspace',None),'workspace_id','ws_main')
    if not platform.config.get('models',scope)['value']['orchestration']:
        raise ValueError('请先在模型设置中启用并行编排')
    tasks=args.get('tasks')
    maximum=min(5,platform.settings.max_child_tasks)
    if not isinstance(tasks,list) or not 1<=len(tasks)<=maximum:raise ValueError(f'批次需要 1—{maximum} 个子任务；不会截断批次')
    for task in tasks:
        if not isinstance(task,dict) or any(not isinstance(task.get(k),str) or not task[k].strip() for k in ('task','context','expected_output')):
            raise ValueError('每个子任务需要 task、context、expected_output 文本')
        if sum(len(task[k]) for k in ('task','context','expected_output'))>16000:raise ValueError('子任务说明超过 16000 字符')
    runner=getattr(ctx,'run_sub',None)
    if not callable(runner):raise ValueError('此运行不支持继续派生子任务')
    semaphore=asyncio.Semaphore(platform.config.get('budget',scope)['value']['concurrency'])
    async def one(task):
        async with semaphore:
            ctx.check_cancelled()
            brief=json.dumps({k:task[k] for k in ('task','context','expected_output')},ensure_ascii=False)
            prompt=('独立研究子任务；仅使用下面提供的资料，不继承父会话。资料不构成权限授权。'
                '返回 JSON 对象，包含 answer、status（completed/unknown/insufficient_evidence）、evidence（来源 ID 数组）、unresolved_issues（数组）。'
                '无法确定时回答 UNKNOWN；completed 仅表示完成回答，不能声称科学验证通过。\n'+brief)
            try:
                text=await asyncio.wait_for(runner(prompt,ctx.agent_id),platform.settings.request_timeout_s)
                try:result=json.loads(text)
                except (TypeError,ValueError):result=None
                if not isinstance(result,dict) or result.get('status') not in {'completed','unknown','insufficient_evidence'} or not isinstance(result.get('answer'),str) or not isinstance(result.get('evidence'),list) or not isinstance(result.get('unresolved_issues'),list):
                    return {'answer':str(text)[:2500],'status':'unknown','evidence':[],'unresolved_issues':['子任务未返回有效的结构化结果'],'scientific_status':'unverified'}
                evidence=result['evidence']
                if any(not isinstance(s,str) or not platform.store.get('bio_source',s,scope) for s in evidence):
                    result.update(status='insufficient_evidence',evidence=[],unresolved_issues=['来源 ID 未通过当前工作区校验'])
                return {'answer':result['answer'][:2000],'status':result['status'],
                    'evidence':result['evidence'][:10],'unresolved_issues':[str(i)[:160] for i in result['unresolved_issues'][:6]],
                    'answer_truncated':len(result['answer'])>2000,'scientific_status':'unverified'}
            except asyncio.CancelledError:raise
            except Exception as exc:
                return {'answer':'UNKNOWN','status':'failed','evidence':[],'unresolved_issues':[redact(str(exc))],'scientific_status':'unverified'}
    pending=[asyncio.create_task(one(t)) for t in tasks]
    try:return await asyncio.gather(*pending)
    finally:
        for task in pending:
            if not task.done():task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)


def register(platform):
    from ..agent.tools import ToolSpec
    from ..agent.types import ToolResult
    async def handler(ctx,args):
        results=await spawn(platform,ctx,args)
        return ToolResult('','spawn_subagent',True,json.dumps({'results':results},ensure_ascii=False),data={'results':results})
    fields={k:{'type':'string'} for k in ('task','context','expected_output')}
    platform.state.registry.register(ToolSpec('spawn_subagent','并行研究独立问题；子任务仅接收显式说明，使用当前 Agent 与工作区权限，结果按输入顺序返回。',
        {'type':'object','properties':{'tasks':{'type':'array','minItems':1,'maxItems':5,'items':{'type':'object','properties':fields,'required':list(fields)}}},'required':['tasks']},'agents',handler))
