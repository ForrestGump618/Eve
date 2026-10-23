"""MCP JSON-RPC client: stdio and Streamable HTTP, bounded requests, no tool replay."""
from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import threading
import time

import httpx

from .store import uid,redact

PROTOCOL='2025-06-18'


class MCPConnection:
    def __init__(self,server,vault):
        self.server=server;self.vault=vault;self.process=None;self.client=None
        self.responses=queue.Queue(maxsize=1000);self.id=0;self.session='';self.protocol=PROTOCOL;self.errors=[]

    async def __aenter__(self):
        if self.server['transport']=='stdio':
            command=self.server.get('command','')
            if not shutil.which(command) and not os.path.isfile(command):
                raise ValueError('MCP 命令不存在，请先安装该服务的运行环境')
            env=dict(os.environ)
            for key,ref in self.server.get('env_refs',{}).items():
                env[key]=self.vault.get(ref)
            options={'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)} if os.name=='nt' else {}
            self.process=subprocess.Popen([command]+self.server.get('args',[]),stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,bufsize=0,**options)
            def pump(stream,errors=False):
                try:
                    while True:
                        line=stream.readline(2_000_001)
                        if not line:
                            break
                        if len(line)>2_000_000:
                            break
                        if errors:
                            self.errors[:]=[redact(line.decode('utf-8','replace'))[:1000]]
                        else:
                            try:self.responses.put_nowait(json.loads(line))
                            except (ValueError,queue.Full):pass
                finally:
                    if not errors:
                        try:self.responses.put_nowait({'closed':True})
                        except queue.Full:pass
            threading.Thread(target=pump,args=(self.process.stdout,),daemon=True).start()
            threading.Thread(target=pump,args=(self.process.stderr,True),daemon=True).start()
        else:
            self.client=httpx.AsyncClient(timeout=float(self.server.get('timeout',30)),follow_redirects=False)
        try:
            init=await self.rpc('initialize',{'protocolVersion':PROTOCOL,'capabilities':{},'clientInfo':{'name':'Suwen','version':'2.0.0'}})
            self.protocol=init.get('protocolVersion',PROTOCOL)
            self.capabilities=init.get('capabilities',{})
            await self.rpc('notifications/initialized',notification=True)
            return self
        except BaseException:
            await self.__aexit__(None,None,None)
            raise

    async def __aexit__(self,*args):
        if self.client:
            if self.session:
                try:await self.client.delete(self.server['url'],headers=self._headers())
                except Exception:pass
            await self.client.aclose()
        if self.process:
            self.process.terminate()
            try:await asyncio.to_thread(self.process.wait,3)
            except subprocess.TimeoutExpired:
                self.process.kill();await asyncio.to_thread(self.process.wait,3)
            for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
                try:stream.close()
                except Exception:pass

    def _headers(self):
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':self.protocol}
        if self.session:headers['Mcp-Session-Id']=self.session
        for key,ref in self.server.get('header_refs',{}).items():
            value=self.vault.get(ref)
            if value:headers[key]=value
        return headers

    async def rpc(self,method,params=None,notification=False):
        self.id+=1
        payload={'jsonrpc':'2.0','method':method}
        if params is not None:payload['params']=params
        if not notification:payload['id']=self.id
        expected=self.id
        timeout=min(180,max(1,float(self.server.get('timeout',30))))
        if self.process:
            raw=(json.dumps(payload,ensure_ascii=False)+'\n').encode()
            await asyncio.to_thread(self.process.stdin.write,raw)
            await asyncio.to_thread(self.process.stdin.flush)
            if notification:return {}
            deadline=time.monotonic()+timeout
            while True:
                try:response=await asyncio.to_thread(self.responses.get,True,max(.01,deadline-time.monotonic()))
                except queue.Empty:raise ValueError('MCP 响应超时，服务已关闭；有副作用的工具不会自动重试')
                if response.get('closed'):raise ValueError('MCP 服务进程已退出：'+''.join(self.errors))
                if response.get('id')==expected and ('result' in response or 'error' in response):break
                if time.monotonic()>=deadline:raise ValueError('MCP 响应超时')
        else:
            async with self.client.stream('POST',self.server['url'],json=payload,headers=self._headers()) as http:
                if http.status_code==401:raise ValueError('MCP 需要认证；OAuth 服务须先在原服务完成授权并配置凭据')
                if http.status_code>=400:raise ValueError(f'MCP HTTP {http.status_code}')
                self.session=http.headers.get('Mcp-Session-Id',self.session)
                if notification:return {}
                if 'text/event-stream' in http.headers.get('content-type',''):
                    response=None;size=0
                    async for line in http.aiter_lines():
                        size+=len(line)
                        if size>2_000_000:raise ValueError('MCP 响应超过 2MB')
                        if line.startswith('data:'):
                            try:item=json.loads(line[5:].strip())
                            except ValueError:continue
                            if item.get('id')==expected:
                                response=item;break
                    if response is None:raise ValueError('MCP SSE 没有返回对应请求结果')
                else:
                    raw=bytearray()
                    async for chunk in http.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw)>2_000_000:raise ValueError('MCP 响应超过 2MB')
                    response=json.loads(raw)
        if response.get('error'):
            raise ValueError('MCP 错误：'+str(redact(response['error']))[:1000])
        if 'result' not in response:raise ValueError('MCP 协议响应缺少 result')
        return response['result']


class MCPManager:
    def __init__(self,platform):
        self.platform=platform;self.store=platform.store;self.locks={}

    def save(self,data,id=None):
        if data.get('transport') not in {'stdio','http'}:raise ValueError('仅支持 stdio 和 Streamable HTTP')
        if data['transport']=='stdio' and (not data.get('command') or not isinstance(data.get('args',[]),list)):
            raise ValueError('stdio 需要命令与参数数组')
        if data['transport']=='http' and not str(data.get('url','')).startswith(('http://','https://')):
            raise ValueError('HTTP 服务需要有效 URL')
        if data.get('auth')=='oauth':data['authorization_status']='requires_external_authorization'
        data={k:v for k,v in data.items() if k in {'name','transport','command','args','url','timeout','enabled','workspaces','agents','tools','auth','authorization_status','env_refs','header_refs'}}
        data.setdefault('enabled',False);data.setdefault('workspaces',[]);data.setdefault('agents',[])
        return self.store.put('mcp',id or uid('mcp'),data)

    def allowed(self,server,scope,agent=''):
        return server.get('enabled',False) and scope in server.get('workspaces',[]) and (not server.get('agents') or agent in server['agents'])

    async def discover(self,id):
        server=self.store.get('mcp',id)
        if not server:raise ValueError('MCP 服务不存在')
        if not server.get('enabled'):raise ValueError('MCP 服务已停用；请先启用')
        async with self.locks.setdefault(id,asyncio.Lock()):
            try:
                async with MCPConnection(server,self.platform.vault) as client:
                    result={'protocol':client.protocol,'tools':[],'resources':[],'prompts':[]}
                    for kind in ('tools','resources','prompts'):
                        if kind in client.capabilities:
                            cursor=None
                            for _ in range(10):
                                response=await client.rpc(kind+'/list',{'cursor':cursor} if cursor else {})
                                result[kind].extend(response.get(kind,[]))
                                cursor=response.get('nextCursor')
                                if not cursor:break
                    result['checked_at']=time.time();result['status']='connected'
                    self.store.put('mcp_status',id,result)
                    self.register(id,result['tools'])
                    return result
            except Exception as exc:
                self.store.put('mcp_status',id,{'status':'error','error':redact(str(exc)),'checked_at':time.time()})
                raise

    def register(self,id,tools):
        from ..agent.tools import ToolSpec
        from ..agent.types import ToolResult
        registry=self.platform.state.registry
        for tool in tools:
            remote_name=tool['name']
            name=(id+'__'+remote_name)[:64]
            async def call(ctx,args,server_id=id,remote=remote_name,tool_name=name):
                workspace=getattr(getattr(ctx,'backend',None),'workspace',None)
                scope=getattr(workspace,'workspace_id','ws_main')
                server=self.store.get('mcp',server_id)
                if not server or not self.allowed(server,scope,ctx.agent_id):raise ValueError('此 Agent 或工作区无权调用该 MCP 服务')
                if server.get('tools') and remote not in server['tools']:raise ValueError('该 MCP 工具未授权')
                async with self.locks.setdefault(server_id,asyncio.Lock()):
                    async with MCPConnection(server,self.platform.vault) as client:
                        result=await client.rpc('tools/call',{'name':remote,'arguments':args})
                return ToolResult('',tool_name,not result.get('isError'),json.dumps(redact(result),ensure_ascii=False)[:20000],data=result)
            spec=ToolSpec(name,tool.get('description','MCP tool')[:1500],tool.get('inputSchema',{'type':'object'}),'mcp',call,True)
            if registry.has(name):registry._specs[name]=spec
            else:registry.register(spec)

    async def test_tool(self,id,name,args,scope,approved=False):
        server=self.store.get('mcp',id)
        if not server or not self.allowed(server,scope):raise ValueError('工作区未授权或服务停用')
        if not approved:raise ValueError('工具测试可能产生外部操作；必须明确确认')
        if server.get('tools') and name not in server['tools']:raise ValueError('工具未授权')
        async with self.locks.setdefault(id,asyncio.Lock()):
            async with MCPConnection(server,self.platform.vault) as client:
                return await client.rpc('tools/call',{'name':name,'arguments':args})
