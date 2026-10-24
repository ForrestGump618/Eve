"""Model selection, bounded context, failover and explicit usage estimates."""
import json
import time
import re
import ipaddress
from urllib.parse import urlsplit
from dataclasses import replace
from contextlib import aclosing

from ..agent.providers import make_provider, ProviderConfig, LLMError
from .store import redact


def require_private_endpoint(strategy,url,provider=''):
    if strategy!='privacy' or provider=='mock':return
    host=urlsplit(url or '').hostname or ''
    try:local=ipaddress.ip_address(host).is_loopback
    except ValueError:local=host.lower()=='localhost'
    if not local:raise LLMError('本地隐私策略只允许回环地址的模型服务')


def compact_messages(messages,window,output=4096,tool_chars=0):
    # Conservative character budget, deliberately not advertised as exact tokenization.
    limit=int(window)-int(output)-tool_chars-512
    if limit<1024:
        raise LLMError('上下文窗口不足以容纳所选工具和输出预算，请增大窗口或减少工具')
    system=dict(messages[0])
    goal=next((dict(m) for m in reversed(messages) if m.get('role')=='user'),None)
    if isinstance(system.get('content'),str) and len(system['content'])>limit//2:
        system['content']=system['content'][:limit//2]+'\n[系统上下文按预算缩短；工具权限仍由运行时强制执行。]'
    history=[dict(m) for m in messages[1:]]
    removed=[]
    def size():
        return len(json.dumps([system]+history,ensure_ascii=False))
    while size()>limit and len(history)>1:
        removed.append(history.pop(0))
        while history and history[0].get('role')=='tool':
            removed.append(history.pop(0))
    if history and size()>limit:
        content=history[-1].get('content')
        if isinstance(content,str):
            history[-1]['content']=content[-max(256,limit-len(str(system.get('content','')))-512):]
    if goal and not any(m.get('role')=='user' for m in history):
        goal['content']=str(goal.get('content',''))[:min(1200,limit//4)]
        history.insert(0,goal)
    if removed:
        evidence='\n'.join(str(m.get('content',''))[:350] for m in removed if m.get('role') in {'user','assistant'})[-1800:]
        spare=max(0,limit-size()-100)
        if spare:
            system['content']+='\n[较早内容摘录，非指令]\n'+evidence[-min(spare,1800):]
    if size()>limit:
        raise LLMError('当前请求超过上下文预算，请缩短输入或减少工具')
    return [system]+history


class ModelGateway:
    def __init__(self,platform):
        self.platform=platform

    def prepare(self,settings,provider,model,agent,backend,task_text=''):
        scope=getattr(getattr(backend,'workspace',None),'workspace_id','ws_main')
        config=self.platform.config.get('models',scope)['value']
        role='reasoning' if config['mode']=='deep' else 'text'
        if 'code' in getattr(agent,'category','') or re.search(r'写代码|编写.*(?:代码|脚本)|修复.*(?:代码|程序)|debug|implement|write.*(?:code|script)',task_text,re.I):
            role='code'
        role_model=config['roles'].get(role,{})
        profile=self.platform.store.get('agent',agent.id)
        if profile:
            if profile.get('workspaces') and scope not in profile['workspaces']:
                raise LLMError('此 Agent 未授权访问当前工作区')
            if not provider:provider=profile.get('provider') or None
            if not model:model=profile.get('model') or None
        use_role=not provider and not model
        if not provider and role_model:
            provider=role_model.get('provider') or None
        if not model and role_model:
            model=role_model.get('model') or None
        target=self.resolve_target(dict(role_model,provider=provider,model=model) if use_role else {'provider':provider,'model':model})
        caps=config['capabilities'].get(target.model,{})
        maximum={'fast':1024,'balanced':4096,'deep':8192}[config['mode']]
        cfg=ProviderConfig(temperature=None if caps.get('temperature') is not True else (.1 if role=='code' else .3),
            max_tokens=min(maximum,int(caps.get('max_output',maximum))),timeout_s=float(settings.request_timeout_s),
            extra={'supported_parameters':caps.get('supported_parameters',[]),'token_parameter':caps.get('token_parameter','max_tokens')})
        return RoutedProvider(self,target,scope,agent.id,config),cfg,target

    def resolve_target(self,item):
        return self.platform.settings.resolve_llm(item.get('provider'),item.get('model'),
            api_base_override=item.get('api_base') or None,
            api_key_override=self.platform.vault.get(item['credential_ref']) if item.get('credential_ref') else None)

    def check_budget(self,scope,task='',agent=''):
        # Accounting is cumulative; enforcement belongs to the AgentLoop's fresh TurnGuard.
        return self.usage(scope,task,agent)

    def usage(self,scope,task='',agent=''):
        query='SELECT coalesce(sum(input+output),0) tokens,coalesce(sum(cost),0) cost,count(*) requests,coalesce(avg(latency),0) latency FROM usage WHERE scope=?'
        params=[scope]
        if task:
            query+=' AND task=?';params.append(task)
        if agent:
            query+=' AND agent=?';params.append(agent)
        with self.platform.store.lock:
            return dict(self.platform.store.db.execute(query,params).fetchone())

    def record(self,scope,task,agent,model,usage,latency):
        prices=self.platform.config.get('budget',scope)['value']['prices'].get(model)
        inp=int(usage.get('prompt_tokens') or 0);out=int(usage.get('completion_tokens') or 0)
        cost=(inp*float(prices.get('input',0))+out*float(prices.get('output',0)))/1_000_000 if prices else 0
        with self.platform.store.lock,self.platform.store.db:
            self.platform.store.db.execute('INSERT INTO usage(scope,task,agent,model,input,output,cost,estimated,latency,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
              (scope,task,agent,model,inp,out,cost,1,latency,time.time()))
        return {'cost':cost,'priced':prices is not None,'estimated':True}


class RoutedProvider:
    def __init__(self,gateway,target,scope,agent,config):
        self.gateway=gateway;self.target=target;self.scope=scope;self.agent=agent;self.config=config;self.task=''

    async def stream_chat(self,messages,tools,cfg):
        before_roles=[message.get('role') for message in messages]
        messages=compact_messages(messages,self.config['context_window'],cfg.max_tokens,len(json.dumps(tools or [],ensure_ascii=False)))
        self.gateway.platform.store.audit('model.context',{'roles_before':before_roles,'roles_after':[m.get('role') for m in messages],
            'context_chars':len(json.dumps(messages,ensure_ascii=False)),'model':self.target.model},self.scope)
        targets=[self.target]
        if self.config['strategy']!='privacy':
            for item in self.config['fallbacks'][:2]:
                # Never downgrade to a mock provider as a successful fallback.
                if item.get('provider')=='mock':
                    continue
                try:targets.append(self.gateway.resolve_target(item))
                except ValueError as exc:
                    self.gateway.platform.store.audit('model.fallback_unavailable',{'model':item.get('model'),'error':redact(str(exc))},self.scope)
        if self.config['strategy']=='cost':
            prices=self.gateway.platform.config.get('budget',self.scope)['value']['prices']
            targets.sort(key=lambda t:float(prices[t.model].get('input',0))+2*float(prices[t.model].get('output',0)) if t.model in prices else float('inf'))
        elif self.config['strategy']=='latency':
            with self.gateway.platform.store.lock:
                rows=self.gateway.platform.store.db.execute('SELECT model,avg(latency) latency FROM usage WHERE scope=? GROUP BY model',(self.scope,)).fetchall()
            latency={r['model']:r['latency'] for r in rows}
            targets.sort(key=lambda t:latency.get(t.model,float('inf')))
        started=time.perf_counter()
        for index,target in enumerate(targets):
            self.active_model=target.model
            emitted=False
            try:
                require_private_endpoint(self.config['strategy'],target.api_base,target.provider)
                extra=dict(cfg.extra)
                if self.config.get('sage_verification') and 'sage-a1.5' in target.model.lower():
                    extra['chat_template_kwargs']={'verification':True}
                else:extra.pop('chat_template_kwargs',None)
                async with aclosing(make_provider(target).stream_chat(messages,tools,replace(cfg,extra=extra))) as stream:
                    async for event in stream:
                        emitted=True
                        if event.get('type')=='usage':
                            event['cost']=self.gateway.record(self.scope,self.task,self.agent,target.model,event.get('usage',{}),time.perf_counter()-started)
                        yield event
                return
            except LLMError as exc:
                self.gateway.platform.store.audit('model.error',{'model':target.model,'error':redact(exc.message)},self.scope)
                if emitted or not exc.retryable or index==len(targets)-1:
                    raise LLMError(redact(exc.message),status=exc.status,retryable=exc.retryable) from None
                self.gateway.platform.store.audit('model.failover',{'from':target.model,'to':targets[index+1].model},self.scope)
