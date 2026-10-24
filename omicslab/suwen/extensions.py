"""Managed, versioned skill copies and explicit channel capability states."""
import asyncio
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from .store import uid

SCIENTIFIC = [
 {'id':'paper2agent','name':'Paper2Agent','source':'https://github.com/jmiao24/Paper2Agent',
  'description':'提取论文方法、仓库与环境，产出可复现的 Skill / MCP 草稿。','dependencies':['git','python'],'version':'public-method-1','status':'method_installed','upstream_status':'not_installed'},
 {'id':'co-scientist','name':'Co-Scientist','source':'https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-co-scientist/',
  'description':'多角色假设生成、交叉批评与排序；基于公开研究的本地实现。','dependencies':['configured_llm'],'version':'public-method-1','status':'method_installed','upstream_status':'not_open_source'},
 {'id':'robin','name':'Robin','source':'https://github.com/Future-House/robin',
  'description':'文献、实验策略与数据反馈循环。上游组件尚未安装，可能需要第三方 API。','dependencies':['configured_llm','futurehouse_api'],'version':'public-method-1','status':'method_installed','upstream_status':'not_installed'},
 {'id':'empirical-research','name':'Empirical Research Assistance','source':'https://arxiv.org/abs/2509.06503',
  'description':'用可执行评估指标比较候选程序；不声称包含未公开的原始系统。','dependencies':['python','evaluation_dataset'],'version':'public-method-1','status':'method_installed','upstream_status':'not_installed'},
]


class SkillRegistry:
    def __init__(self,platform):
        self.platform=platform;self.store=platform.store

    def installed(self,scope):
        result=[]
        for row in self.store.list('skill',scope):
            path=Path(row['path'])/'SKILL.md'
            row['installed']=path.is_file()
            row['status']='installed' if path.is_file() else 'missing'
            result.append(row)
        return result

    def load(self,scope):
        from ..agent.skills import _parse_skill_dir
        skills={}
        for row in self.installed(scope):
            if row.get('enabled') and row['installed']:
                skill=_parse_skill_dir(Path(row['path']),'managed')
                if skill:skills[skill.name]=skill
        return skills

    async def install(self,scope,data):
        self.platform.require_workspace(scope)
        if not data.get('trusted'):raise ValueError('请先审核来源和权限，并明确确认安装；安装不会运行脚本')
        source=str(data.get('source') or '')
        with tempfile.TemporaryDirectory(prefix='suwen-skill-') as temporary:
            if source.startswith('https://') and source.endswith('.git'):
                if not shutil.which('git'):raise ValueError('未安装 Git')
                args=['git','clone','--depth','1','--no-recurse-submodules']
                if data.get('ref'):
                    ref=str(data['ref'])
                    if ref.startswith('-'):raise ValueError('版本引用无效')
                    args+=['--branch',ref]
                target=Path(temporary)/'repo'
                result=await asyncio.to_thread(subprocess.run,args+['--',source,str(target)],capture_output=True,timeout=120,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                if result.returncode:raise ValueError('Git 获取失败；请检查仓库、权限和版本')
                source_dir=target
            else:
                source_dir=Path(source).expanduser().resolve()
            subpath=str(data.get('subpath') or '.')
            directory=(source_dir/subpath).resolve()
            if not directory.is_relative_to(source_dir) or not (directory/'SKILL.md').is_file():raise ValueError('目录必须包含 SKILL.md')
            from ..agent.skills import _parse_skill_dir
            skill=_parse_skill_dir(directory,'managed')
            if not skill:raise ValueError('SKILL.md 无效')
            files=[];total=0;digest=hashlib.sha256();risks=[]
            for path in sorted(directory.rglob('*')):
                if '.git' in path.relative_to(directory).parts:continue
                if path.is_symlink():raise ValueError('技能包不允许符号链接')
                if not path.is_file():continue
                total+=path.stat().st_size
                if total>50_000_000 or len(files)>=1000:raise ValueError('技能包超过 50MB 或 1000 个文件')
                content=path.read_bytes();digest.update(path.relative_to(directory).as_posix().encode()+content)
                if path.suffix in {'.py','.sh','.ps1','.js'}:risks.append(str(path.relative_to(directory)))
                files.append(path)
            version=digest.hexdigest()[:16]
            name=re.sub(r'[^a-zA-Z0-9_-]','-',skill.name)[:80] or uid('skill')
            destination=self.store.home/'suwen'/'skills'/scope/name/version
            destination.mkdir(parents=True,exist_ok=True)
            for path in files:
                out=destination/path.relative_to(directory);out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,out)
            return self.store.put('skill',name,{'name':skill.name,'description':skill.description,'path':str(destination),
                'source':source,'version':version,'ref':data.get('ref'),'enabled':False,'scripts':risks,
                'dependencies':data.get('dependencies',[]),'permissions':data.get('permissions',['files']),
                'test_status':'not_run','review':'安装完成，默认停用；请检查脚本后启用'},scope)


class Channels:
    def __init__(self,platform):
        self.platform=platform;self.store=platform.store
        from .wechat import Wechat
        self.wechat=Wechat(platform)

    def capabilities(self,adapter):
        if adapter=='webchat':return {'inbound':True,'outbound':True,'attachments':False,'groups':False,'qr_login':False,'implementation':'builtin'}
        if adapter=='telegram':return {'inbound':True,'outbound':True,'attachments':False,'groups':False,'qr_login':False,'implementation':'bot-api'}
        if adapter=='wechat':return {'inbound':True,'outbound':True,'attachments':False,'groups':False,'qr_login':True,'implementation':'weixin-ilink-text'}
        return {'inbound':False,'outbound':False,'attachments':False,'groups':False,'qr_login':False,
          'implementation':'external_adapter_required','reason':'需要平台官方协议或受支持的 OpenClaw 适配器；未内置扫码登录，未假定互通'}

    def save(self,data,id=None):
        if data.get('adapter') not in {'webchat','telegram','wechat','wecom','feishu','qq','openclaw'}:raise ValueError('未知消息渠道')
        self.platform.require_workspace(data.get('workspace',''))
        row={k:v for k,v in data.items() if k in {'name','adapter','enabled','workspace','agent','contacts','credential_ref','webhook_ref','allow_send','read_only','bot_id','base_url'}}
        if row['adapter']=='wechat':
            from .wechat import trusted_base
            row['base_url']=trusted_base(row.get('base_url') or 'https://ilinkai.weixin.qq.com')
            if row.get('enabled') and (not row.get('bot_id') or not self.platform.vault.get(row.get('credential_ref'))):raise ValueError('请通过微信扫码建立连接')
        row.setdefault('enabled',False);row.setdefault('contacts',[]);row.setdefault('read_only',True);row.setdefault('allow_send',False)
        if not isinstance(row['contacts'],list) or len(row['contacts'])>100 or any(not isinstance(v,str) or not v for v in row['contacts']):raise ValueError('授权联系人需要非空 ID 的数组')
        row['capabilities']=self.capabilities(row['adapter'])
        row['status']='disabled' if not row['enabled'] else 'configured' if row['capabilities']['inbound'] else 'external_dependency'
        return self.store.put('channel',id or uid('channel'),row)

    async def test(self,id):
        channel=self.store.get('channel',id)
        if not channel or not channel['enabled']:raise ValueError('渠道不存在或已停用')
        if channel['adapter']=='webchat':return {'ok':True,'method':'local_webchat','capabilities':channel['capabilities']}
        if channel['adapter']=='wechat':return await self.wechat.test(channel)
        if channel['adapter']!='telegram':raise ValueError(channel['capabilities']['reason'])
        token=self.platform.vault.get(channel.get('credential_ref'))
        if not token:raise ValueError('尚未配置 Telegram Bot Token')
        async with httpx.AsyncClient(timeout=20) as client:
            response=await client.get(f'https://api.telegram.org/bot{token}/getMe')
            if response.status_code!=200 or not response.json().get('ok'):raise ValueError('Telegram 认证测试失败，请检查 Bot Token 和网络')
        return {'ok':True,'method':'telegram.getMe','username':response.json()['result'].get('username'),'capabilities':channel['capabilities']}

    async def inbound(self,id,message):
        channel=self.store.get('channel',id)
        if not channel or not channel['enabled'] or not channel['capabilities']['inbound']:raise ValueError('渠道未启用或适配器不可用')
        contact=str(message.get('contact') or '')
        if contact not in [str(c) for c in channel['contacts']]:raise PermissionError('联系人未授权')
        if not message.get('message_id') or not message.get('text'):raise ValueError('消息需要 message_id 与 text')
        import sqlite3,time
        with self.store.lock,self.store.db:
            rate=self.store.db.execute('SELECT count(*) FROM dedup WHERE channel=? AND created>?',(id,time.time()-60)).fetchone()[0]
            if rate>=20:raise ValueError('此渠道超过每分钟 20 条限制')
            try:self.store.db.execute('INSERT INTO dedup VALUES(?,?,?)',(id,str(message['message_id']),time.time()))
            except sqlite3.IntegrityError:return {'duplicate':True}
        try:
            task=self.platform.tasks.create(channel['workspace'],{'prompt':message['text'],'title':f'{channel["name"]} · {contact}',
                'workflow':{'nodes':[{'id':'reply','type':'model','prompt':message['text'],'agent':channel.get('agent','lead'),'restricted':channel.get('read_only',True)}]},
                'idempotency_key':f'{id}:{message["message_id"]}'})
        except Exception:
            with self.store.lock,self.store.db:
                self.store.db.execute('DELETE FROM dedup WHERE channel=? AND message=?',(id,str(message['message_id'])))
            raise
        self.store.put('channel_message',uid(),{'channel':id,'contact':contact,'task':task['id'],'direction':'inbound'},channel['workspace'])
        return {'task':task['id'],'scope':channel['workspace'],'duplicate':False}

    async def send(self,id,contact,text,approved=False):
        channel=self.store.get('channel',id)
        if not channel or not channel['enabled'] or not channel.get('allow_send') or not approved:
            raise PermissionError('主动发送需启用渠道、允许外发并明确确认')
        if str(contact) not in [str(c) for c in channel['contacts']]:raise PermissionError('接收者未授权')
        if channel['adapter']=='webchat':
            return self.store.put('channel_message',uid(),{'channel':id,'contact':str(contact),'text':text,'direction':'outbound'},channel['workspace'])
        if channel['adapter']=='wechat':return await self.wechat.send(channel,str(contact),text)
        if channel['adapter']!='telegram':raise ValueError('此适配器尚不支持发送')
        token=self.platform.vault.get(channel.get('credential_ref'))
        if not token:raise ValueError('Bot Token 未配置')
        async with httpx.AsyncClient(timeout=20) as client:
            response=await client.post(f'https://api.telegram.org/bot{token}/sendMessage',json={'chat_id':contact,'text':text[:4096]})
            if response.status_code!=200 or not response.json().get('ok'):raise ValueError('Telegram 发送失败；不会自动重试以避免重复消息')
        return {'ok':True,'message_id':response.json()['result']['message_id']}
