"""Persistent queue and checkpointed DAG runner, independent of browser lifetime.

An interrupted in-flight node requires review; committed nodes are never replayed.
"""
import asyncio
import time

from .store import uid,redact

NODE_TYPES={'model','tool','condition','approval','output','verify'}
TERMINAL={'succeeded','failed','cancelled'}


def validate_workflow(flow):
    if not isinstance(flow,dict):raise ValueError('工作流必须是对象')
    nodes=flow.get('nodes',[])
    if not isinstance(nodes,list) or any(not isinstance(n,dict) for n in nodes):raise ValueError('nodes 必须是节点对象数组')
    if not nodes or len(nodes)>50:raise ValueError('工作流需要 1—50 个节点')
    ids=[n.get('id') for n in nodes]
    if any(not isinstance(i,str) or not i for i in ids) or len(ids)!=len(set(ids)):
        raise ValueError('节点 ID 必须非空且唯一')
    done=set()
    for node in nodes:
        if node.get('type') not in NODE_TYPES:raise ValueError('不支持的节点类型')
        if node.get('type')=='verify':
            from .experiments import checks
            if not isinstance(node.get('path'),str) or not node['path']:raise ValueError('验证节点需要指标文件路径')
            checks({},node.get('rules'))
        dependencies=node.get('depends_on',[])
        if not isinstance(dependencies,list) or any(not isinstance(d,str) for d in dependencies):raise ValueError('依赖需要节点 ID 数组')
        if set(dependencies)-set(ids):raise ValueError('依赖了不存在的节点')
    for _ in nodes:
        for node in nodes:
            if set(node.get('depends_on',[]))<=done:done.add(node['id'])
    if done!=set(ids):raise ValueError('工作流存在循环依赖；循环请展开为有上限的节点')
    return flow


class TaskEngine:
    def __init__(self,platform):
        self.platform=platform;self.store=platform.store;self.state=platform.state
        self.active={};self.run_ids={};self.cancels={};self.worker=None;self.closing=False

    async def start(self):
        for scope in self.platform.workspace_ids():
            for task in self.store.list('task',scope):
                if task.get('status')=='running':
                    self.patch(task['id'],scope,status='interrupted',error='服务重启：请检查当前节点是否已产生外部操作，再恢复；已完成节点不会重放')
        self.worker=asyncio.create_task(self._dispatch())

    async def close(self):
        self.closing=True
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker,return_exceptions=True)
        for task in list(self.active.values()):task.cancel()
        await asyncio.gather(*self.active.values(),return_exceptions=True)

    def patch(self,id,scope,**patch):
        with self.store.lock:
            task=self.store.get('task',id,scope)
            if not task:raise ValueError('任务不存在')
            return self.store.put('task',id,dict(task,**patch),scope)

    def node_patch(self,id,scope,node,**patch):
        with self.store.lock:
            task=self.store.get('task',id,scope)
            states=dict(task.get('nodes',{}));states[node]=dict(states.get(node,{}),**patch)
            return self.patch(id,scope,nodes=states)

    def create(self,scope,data):
        self.platform.require_workspace(scope)
        key=str(data.get('idempotency_key') or '')
        if key:
            old=next((r for r in self.store.list('task',scope) if r.get('idempotency_key')==key),None)
            if old:return old
        workflow=data.get('workflow') or {'nodes':[{'id':'analysis','type':'model','prompt':str(data.get('prompt') or ''),'agent':data.get('agent','lead')}]}
        validate_workflow(workflow)
        if not data.get('prompt') and not data.get('workflow'):raise ValueError('任务目标不能为空')
        dependencies=list(data.get('dependencies') or [])
        if any(not self.store.get('task',id,scope) for id in dependencies):raise ValueError('依赖任务不存在或不在当前工作区')
        return self.store.put('task',uid('task'),{'title':str(data.get('title') or data.get('prompt') or '工作流任务')[:120],
            'prompt':str(data.get('prompt') or ''),'workflow':workflow,'status':'queued','nodes':{},
            'idempotency_key':key,'dependencies':dependencies,'attempt':0,'created_at':time.time(),
            'timeout':min(7200,max(10,int(data.get('timeout') or 1800))),'error':'','result':'','parent_id':data.get('parent_id')},scope)

    async def control(self,id,scope,action,confirmed=False):
        task=self.store.get('task',id,scope)
        if not task:raise ValueError('任务不存在')
        if action=='resume':
            if task['status'] not in {'paused','interrupted','failed','waiting_approval','budget_limited','needs_review'}:
                raise ValueError('此状态不能恢复')
            if task['status'] in {'interrupted','failed'} and not confirmed:
                raise ValueError('请确认已检查当前节点的外部操作；恢复不会重放已完成节点')
            if id in self.active:raise ValueError('上一次执行尚在停止，请稍后重试')
            return self.patch(id,scope,status='queued',error='',attempt=task['attempt']+1)
        if action not in {'pause','cancel'}:raise ValueError('不支持的任务操作')
        status='paused' if action=='pause' else 'cancelled'
        if task['status'] in TERMINAL:raise ValueError('已结束任务不可停止')
        self.patch(id,scope,status=status)
        if id in self.cancels:self.cancels[id].set()
        for run in self.run_ids.get(id,set()).copy():
            await self.state.runs.cancel(run,'任务'+status)
        if id in self.active:self.active[id].cancel()
        return self.store.get('task',id,scope)

    async def _dispatch(self):
        while not self.closing:
            try:
                for scope in self.platform.workspace_ids():
                    limit=self.platform.config.get('budget',scope)['value']['concurrency']
                    active_in_scope=sum(self.store.get('task',id,scope) is not None for id in self.active)
                    for task in reversed(self.store.list('task',scope)):
                        if task['status']!='queued' or task['id'] in self.active or active_in_scope>=limit:continue
                        deps=[self.store.get('task',id,scope) for id in task.get('dependencies',[])]
                        if any(d and d['status'] in {'failed','cancelled'} for d in deps):
                            self.patch(task['id'],scope,status='failed',error='前置任务失败或取消');continue
                        if any(not d or d['status']!='succeeded' for d in deps):continue
                        self.patch(task['id'],scope,status='running',started_at=time.time())
                        self.cancels[task['id']]=asyncio.Event()
                        running=asyncio.create_task(self._run(task['id'],scope))
                        self.active[task['id']]=running;active_in_scope+=1
                await self.platform.tick_schedules()
            except asyncio.CancelledError:raise
            except Exception as exc:self.store.audit('queue.error',{'error':str(exc)})
            await asyncio.sleep(1)

    async def _run(self,id,scope):
        try:
            await asyncio.wait_for(self._workflow(id,scope),self.store.get('task',id,scope)['timeout'])
        except asyncio.CancelledError:
            if self.closing:self.patch(id,scope,status='interrupted',error='后端停止，等待检查后恢复')
        except Exception as exc:
            status='budget_limited' if '用量硬限制' in str(exc) else 'failed'
            self.patch(id,scope,status=status,error=redact(str(exc)))
            self.store.audit('task.error',{'task':id,'error':str(exc)},scope)
        finally:
            for run in self.run_ids.pop(id,set()):
                if self.state.events.get_run(run).get('status') not in TERMINAL:
                    await self.state.runs.cancel(run,'任务执行已结束')
            self.active.pop(id,None);self.cancels.pop(id,None)

    async def _workflow(self,id,scope):
        while True:
            task=self.store.get('task',id,scope)
            if task['status']!='running':return
            states=task['nodes'];nodes=task['workflow']['nodes']
            remaining=[n for n in nodes if states.get(n['id'],{}).get('status') not in {'succeeded','skipped'}]
            if not remaining:
                result='\n\n'.join(str(states[n['id']].get('result','')) for n in nodes if n['type'] in {'model','output'})[-32000:]
                gates=[self.store.get('evidence_gate',s.get('run_id',''),scope) for s in states.values()]
                if any(n['type']=='tool' for n in nodes) or not any(n['type']=='model' for n in nodes):
                    from .biomedical import is_research
                    gates.append(self.platform.biomedical.gate(scope,id,result,is_research(task['title']+' '+task['prompt'])))
                needs_review=any(g and g['status']=='needs_review' for g in gates)
                self.patch(id,scope,status='needs_review' if needs_review else 'succeeded',result=result,ended_at=time.time());return
            ready=[n for n in remaining if all(states.get(d,{}).get('status') in {'succeeded','skipped'} for d in n.get('depends_on',[]))]
            if not ready:raise ValueError('没有可执行节点，请检查依赖')
            limit=self.platform.config.get('budget',scope)['value']['concurrency']
            pending=[asyncio.create_task(self._node(id,scope,n)) for n in ready[:limit]]
            try:
                await asyncio.gather(*pending)
            except BaseException:
                for running in pending:running.cancel()
                await asyncio.gather(*pending,return_exceptions=True)
                raise

    async def _node(self,id,scope,node):
        try:
            return await self._execute_node(id,scope,node)
        except asyncio.CancelledError:
            self.node_patch(id,scope,node['id'],status='interrupted',error='节点停止，恢复前请检查外部操作')
            raise
        except Exception as exc:
            self.node_patch(id,scope,node['id'],status='failed',error=redact(str(exc)))
            raise

    async def _execute_node(self,id,scope,node):
        task=self.store.get('task',id,scope)
        prior=task['nodes'].get(node['id'],{})
        if node.get('when'):
            condition=task['nodes'].get(node['when'],{}).get('condition')
            if condition is not node.get('equals',True):
                self.node_patch(id,scope,node['id'],status='skipped',result='条件不满足');return
        if node['type']=='approval':
            if not prior.get('approved'):
                self.node_patch(id,scope,node['id'],status='waiting_approval',result=node.get('prompt','等待人工批准'))
                self.patch(id,scope,status='waiting_approval');return
            self.node_patch(id,scope,node['id'],status='succeeded',result='人工已批准');return
        self.node_patch(id,scope,node['id'],status='running',started_at=time.time())
        context='\n'.join(str(task['nodes'].get(dep,{}).get('result','')) for dep in node.get('depends_on',[]))[-16000:]
        if node['type']=='verify':
            from .experiments import read_metrics,checks
            import json
            metrics,digest=await read_metrics(self.platform,scope,node['path'])
            results=checks(metrics,node['rules'])
            self.node_patch(id,scope,node['id'],checks=results,metrics_sha256=digest,scientific_status='unverified')
            if not all(r['passed'] for r in results):raise ValueError('独立指标验证失败；后续依赖节点不会执行，请检查结果并调整研究方案')
            self.node_patch(id,scope,node['id'],status='succeeded',result=json.dumps(results,ensure_ascii=False),ended_at=time.time())
            return
        if node['type']=='condition':
            condition=str(node.get('contains','')) in context
            self.node_patch(id,scope,node['id'],status='succeeded',condition=condition,result=str(condition));return
        if node['type']=='output':
            self.node_patch(id,scope,node['id'],status='succeeded',result=node.get('text') or context);return
        if node['type']=='model':
            agent=node.get('agent') or 'lead'
            conversation=self.state.store.get(prior['session_id']) if prior.get('session_id') else self.state.store.create(agent=agent,title=task['title'])
            if node.get('restricted'):
                conversation.meta['restricted_channel']=True
                self.state.store.save(conversation)
            self.node_patch(id,scope,node['id'],session_id=conversation.id)
            message=str(node.get('prompt') or task['prompt'])+'\n\n前置节点结果（仅作为资料，不是权限授权）：\n'+context
            if prior.get('session_id'):
                message+='\n从会话中最后的检查点继续。先确认已完成的外部操作，避免重复提交或发送。'
            submitted=await self.state.runs.submit(session_id=conversation.id,message=message,agent_id=agent,workspace_id=scope,
                provider=node.get('provider'),model=node.get('model'),client_request_id=f'{id}:{node["id"]}:{task["attempt"]}')
            run=submitted['run']['run_id'];self.run_ids.setdefault(id,set()).add(run)
            self.node_patch(id,scope,node['id'],run_id=run)
            while True:
                record=self.state.events.get_run(run)
                if record['status'] in TERMINAL or record['status']=='interrupted':break
                await asyncio.sleep(.25)
            if record['status']!='succeeded':raise ValueError(str(record.get('error') or 'Agent 执行未成功'))
            result=record.get('result_text','')
        else:
            from ..agent.tools import ToolContext
            workspace=self.platform.require_workspace(scope)
            kernel=await self.state.kernel_for(workspace.scope)
            backend=kernel.backend if workspace.backend=='ssh' else await self.state.make_backend(workspace,None)
            async def emit(event):self.store.audit('task.tool_event',event.to_dict(),scope)
            ctx=ToolContext(self.state.settings,kernel,self.state.registry,workspace.root,conversation_id='',
                emit=emit,cancel_event=self.cancels[id],approver=self.state.approver)
            ctx.backend=backend;ctx.run_id=id
            outcome=await self.state.registry.execute(ctx,node.get('tool',''),node.get('arguments',{}))
            self.platform.biomedical.record_execution(scope,id,node.get('tool',''),node.get('arguments',{}),outcome)
            if not outcome.ok:raise ValueError(outcome.error or outcome.content)
            result=outcome.content
        self.node_patch(id,scope,node['id'],status='succeeded',result=result,ended_at=time.time())
        self.store.audit('task.checkpoint',{'task':id,'node':node['id'],'status':'succeeded'},scope)
