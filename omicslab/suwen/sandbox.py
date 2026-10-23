"""Opt-in Docker execution; never falls back to unrestricted host Python."""
import asyncio
import shutil
import subprocess

from .store import uid


class DockerSandbox:
    IMAGE='python:3.12-slim'
    def __init__(self,platform):self.platform=platform

    def status(self):
        return {'binary_available':bool(shutil.which('docker')),'daemon_status':'not_probed',
            'image':self.IMAGE,'network':'disabled','host_credentials':'not_mounted',
            'scope':'local workspace only','default_host_kernel_is_sandboxed':False}

    async def execute(self,scope,code,timeout=60):
        if not shutil.which('docker'):raise ValueError('Docker 未安装；隔离执行不可用，不会改用本机 Python')
        workspace=self.platform.require_workspace(scope)
        if workspace.backend!='local':raise ValueError('此 Docker 沙箱只支持本机工作区，不会把远端文件回退到本机')
        if not code.strip():raise ValueError('代码不能为空')
        path=str(workspace.root)
        if ',' in path:raise ValueError('Docker bind mount 不支持此处的逗号路径，请选择其他工作区')
        options={'capture_output':True,'text':True,'encoding':'utf-8','errors':'replace',
                 'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)}
        image=await asyncio.to_thread(subprocess.run,['docker','image','inspect',self.IMAGE],timeout=15,**options)
        if image.returncode:raise ValueError('Docker 守护进程或指定镜像不可用；请先检查 Docker 并手动准备官方 '+self.IMAGE+' 镜像')
        name=uid('suwen-sandbox')
        command=['docker','run','--name',name,'--rm','--network','none','--read-only',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534',
            '--pids-limit','64','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
            '--mount',f'type=bind,source={path},target=/workspace','--workdir','/workspace',
            self.IMAGE,'python','-I','-c',code]
        try:
            result=await asyncio.to_thread(subprocess.run,command,timeout=min(300,max(1,timeout)),**options)
            return {'ok':result.returncode==0,'exit_code':result.returncode,'stdout':result.stdout[-20000:],
                'stderr':result.stderr[-20000:],'sandbox':'docker','network':'none','image':self.IMAGE}
        except subprocess.TimeoutExpired:
            raise ValueError('沙箱执行超时；已请求终止容器，不会自动重试')
        finally:
            await asyncio.to_thread(subprocess.run,['docker','rm','-f',name],timeout=15,**options)

    def register(self):
        from ..agent.tools import ToolSpec
        from ..agent.types import ToolResult
        import json
        async def execute(ctx,args):
            scope=getattr(getattr(getattr(ctx,'backend',None),'workspace',None),'workspace_id','ws_main')
            result=await self.execute(scope,str(args.get('code') or ''),int(args.get('timeout_s') or 60))
            return ToolResult('','sandbox_python',result['ok'],json.dumps(result,ensure_ascii=False),data=result)
        self.platform.state.registry.register(ToolSpec('sandbox_python','在断网、限额的 Docker 容器中执行不可信 Python。需要已安装 Docker 与官方镜像；不可用时拒绝主机回退。',
            {'type':'object','properties':{'code':{'type':'string'},'timeout_s':{'type':'integer'}},'required':['code']},'python',execute,True))
