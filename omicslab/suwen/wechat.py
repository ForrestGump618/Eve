"""Weixin iLink QR binding and bounded text-message polling.

Protocol reference: Tencent/openclaw-weixin/docs/protocol_zh_CN.md.
Tokens and conversation context are held in the OS vault, never QR status responses.
"""
import asyncio
import base64
import io
import os
import secrets
import time
from urllib.parse import urlsplit

import httpx

from .. import __version__
from .store import uid

BASE = 'https://ilinkai.weixin.qq.com'


def trusted_base(url):
    parsed = urlsplit(url)
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or not (host == 'weixin.qq.com' or host.endswith('.weixin.qq.com')) or parsed.username or parsed.password or parsed.port not in {None,443}:
        raise ValueError('微信服务返回了不受信任的地址')
    return f'https://{host}'


def qr_image(content):
    import qrcode
    from qrcode.image.svg import SvgPathImage
    if content.startswith('data:image/png;base64,'):
        raw = base64.b64decode(content.split(',',1)[1],validate=True)
        if len(raw)>500_000 or not raw.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('二维码图片无效')
        return content
    if not content or len(content)>4096:raise ValueError('二维码内容无效')
    output=io.BytesIO()
    qrcode.make(content,image_factory=SvgPathImage,border=4).save(output)
    return 'data:image/svg+xml;base64,'+base64.b64encode(output.getvalue()).decode()


class Wechat:
    def __init__(self,platform):
        self.platform=platform
        self.sessions={}
        self.workers={}
        self.manager=None

    async def request(self,base,path,*,token='',data=None,params=None,timeout=40):
        base=trusted_base(base)
        headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':str(sum(int(v)<<s for v,s in zip(__version__.split('.')[:3],(16,8,0))))}
        if data is not None:
            headers.update({'AuthorizationType':'ilink_bot_token','X-WECHAT-UIN':base64.b64encode(str(secrets.randbits(32)).encode()).decode()})
            data={**data,'base_info':{'channel_version':__version__,'bot_agent':'Suwen'}}
        if token:headers['Authorization']='Bearer '+token
        async with httpx.AsyncClient(timeout=timeout,follow_redirects=False) as client:
            try:
                r=await client.request('POST' if data is not None else 'GET',base+path,headers=headers,json=data,params=params)
                r.raise_for_status()
                result=r.json()
            except (httpx.HTTPError,ValueError) as exc:
                raise ValueError('微信服务暂不可用，请检查网络后重试；登录凭据不会写入错误信息') from None
        if not isinstance(result,dict) or result.get('ret',0)!=0 or result.get('errcode',0)!=0:
            raise ValueError('微信服务拒绝请求，请重新扫码或检查连接状态')
        return result

    async def begin(self,scope,data):
        self.platform.require_workspace(scope)
        now=time.monotonic()
        self.sessions={k:v for k,v in self.sessions.items() if v['expires']>now}
        if len(self.sessions)>=6:raise ValueError('已有扫码会话，请关闭旧会话或等待过期')
        result=await self.request(BASE,'/ilink/bot/get_bot_qrcode',data={'local_token_list':[]},params={'bot_type':3})
        if not result.get('qrcode'):raise ValueError('微信服务没有返回二维码，请重试')
        id=uid('wxlogin')
        self.sessions[id]={'scope':scope,'qrcode':result['qrcode'],'base':BASE,'expires':now+180,'lock':asyncio.Lock(),
                           'name':str(data.get('name') or '我的微信助手')[:80],'agent':str(data.get('agent') or 'lead'),
                           'allow_send':data.get('allow_send') is True}
        return {'session_id':id,'image':qr_image(str(result.get('qrcode_img_content') or result['qrcode'])),'expires_in':180,'status':'wait'}

    def session(self,id,scope):
        item=self.sessions.get(id)
        if not item or item['scope']!=scope:raise ValueError('扫码会话不存在或不属于当前工作区')
        return item

    async def status(self,id,scope,verify_code=''):
        item=self.session(id,scope)
        async with item['lock']:
            if item.get('channel_id'):return {'status':'confirmed','channel_id':item['channel_id']}
            if item['expires']<=time.monotonic():return {'status':'expired'}
            params={'qrcode':item['qrcode']}
            if verify_code:
                if not verify_code.isdigit() or not 4<=len(verify_code)<=12:raise ValueError('请输入手机显示的数字验证码')
                params['verify_code']=verify_code
            result=await self.request(item['base'],'/ilink/bot/get_qrcode_status',params=params)
            if self.sessions.get(id) is not item:return {'status':'cancelled'}
            status=result.get('status','wait')
            if status=='scaned_but_redirect':
                redirect=str(result.get('redirect_host') or '')
                item['base']=trusted_base(redirect if '://' in redirect else 'https://'+redirect)
                return {'status':'scaned'}
            if status=='confirmed':
                token,user,bot=result.get('bot_token'),result.get('ilink_user_id'),result.get('ilink_bot_id')
                if not all(isinstance(v,str) and v for v in (token,user,bot)):raise ValueError('微信登录响应缺少账号字段，未建立连接')
                base=trusted_base(result.get('baseurl') or item['base'])
                existing=next((c for c in self.platform.store.list('channel') if c.get('adapter')=='wechat' and c.get('bot_id')==bot),None)
                channel_id=existing['id'] if existing else uid('channel');ref=channel_id+'-wechat'
                self.platform.vault.put(ref,token,persist=os.name=='nt')
                self.platform.channels.save({'name':item['name'],'adapter':'wechat','workspace':scope,'agent':item['agent'],
                    'contacts':[user],'credential_ref':ref,'bot_id':bot,'base_url':base,'enabled':True,'read_only':True,'allow_send':item['allow_send']},channel_id)
                item['channel_id']=channel_id
                return {'status':'confirmed','channel_id':channel_id,'credential_storage':'os' if os.name=='nt' else 'session'}
            if status not in {'wait','scaned','expired','need_verifycode','verify_code_blocked','binded_redirect'}:
                raise ValueError('微信返回未知登录状态，请刷新二维码')
            return {'status':status}

    def cancel(self,id,scope):
        self.session(id,scope)
        self.sessions.pop(id,None)
        return {'ok':True}

    async def test(self,channel):
        token=self.platform.vault.get(channel.get('credential_ref'))
        if not token:raise ValueError('微信凭据不可用，请重新扫码连接')
        await self.request(channel.get('base_url') or BASE,'/ilink/bot/getconfig',token=token,data={'ilink_user_id':channel['contacts'][0]})
        worker=self.workers.get(channel['id'])
        if worker is not None and worker.done():self.workers.pop(channel['id'])
        return {'ok':True,'method':'wechat.ilink.getconfig'}

    async def send(self,channel,contact,text):
        token=self.platform.vault.get(channel.get('credential_ref'))
        context=self.platform.vault.get(channel['id']+'-context-'+contact)
        if not token or not context:raise ValueError('请先在微信给助手发送一条文字消息，再测试回复')
        client_id=uid('suwen')
        await self.request(channel.get('base_url') or BASE,'/ilink/bot/sendmessage',token=token,data={'msg':{
            'from_user_id':'','to_user_id':contact,'client_id':client_id,'message_type':2,'message_state':2,
            'context_token':context,'item_list':[{'type':1,'text_item':{'text':str(text)[:4000]}}]}})
        return {'ok':True,'message_id':client_id}

    async def poll_once(self,channel):
        store=self.platform.store;id=channel['id']
        state=store.get('wechat_state',id) or {'cursor':'','replies':[]}
        token=self.platform.vault.get(channel.get('credential_ref'))
        if not token:raise ValueError('微信登录凭据失效，请重新扫码')
        result=await self.request(channel.get('base_url') or BASE,'/ilink/bot/getupdates',token=token,data={'get_updates_buf':state['cursor']})
        for msg in (result.get('msgs') or [])[:100]:
            contact=str(msg.get('from_user_id') or '')
            if msg.get('message_type')!=1 or contact not in channel['contacts']:continue
            text='\n'.join(str(i.get('text_item',{}).get('text') or '') for i in msg.get('item_list',[]) if i.get('type')==1).strip()
            if not text or not msg.get('message_id'):continue
            if msg.get('context_token'):
                self.platform.vault.put(id+'-context-'+contact,msg['context_token'],persist=os.name=='nt')
            task=await self.platform.channels.inbound(id,{'contact':contact,'message_id':str(msg['message_id']),'text':text[:16000]})
            if not task.get('duplicate'):
                state['replies'].append({'task':task['task'],'contact':contact})
        if result.get('get_updates_buf'):state['cursor']=result['get_updates_buf']
        pending=[]
        for reply in state['replies'][-100:]:
            task=store.get('task',reply['task'],channel['workspace'])
            if not task:continue
            if task['status'] in {'queued','running','waiting_approval'}:
                pending.append(reply);continue
            if task['status']=='succeeded' and channel.get('allow_send'):
                # Reserve a durable send receipt first; ambiguous sends are never replayed.
                if store.get('wechat_reply',reply['task']):continue
                store.put('wechat_reply',reply['task'],{'channel':id,'status':'attempted'})
                await self.platform.channels.send(id,reply['contact'],task.get('result') or '本轮已完成，请在素问查看结果。',approved=True)
                store.put('wechat_reply',reply['task'],{'channel':id,'status':'sent'})
        checkpoint={'cursor':state['cursor'],'replies':pending}
        previous=store.get('wechat_state',id)
        if previous is None or any(previous.get(k)!=v for k,v in checkpoint.items()):store.put('wechat_state',id,checkpoint)

    async def worker(self,id):
        failures=0
        while True:
            channel=self.platform.store.get('channel',id)
            if not channel or not channel.get('enabled'):return
            try:
                await self.poll_once(channel)
                failures=0
                prior=self.platform.store.get('channel_status',id)
                if not prior or prior.get('status')!='connected':self.platform.store.put('channel_status',id,{'status':'connected','text':'微信文字消息接收中'})
                await asyncio.sleep(1)
            except asyncio.CancelledError:raise
            except Exception:
                failures+=1
                self.platform.store.put('channel_status',id,{'status':'error','error':'微信连接中断；请测试网络或重新扫码。'})
                if failures>=3:return
                await asyncio.sleep(min(30,5*failures))

    async def run(self):
        while True:
            active={c['id'] for c in self.platform.store.list('channel') if c.get('adapter')=='wechat' and c.get('enabled')}
            for id in active:
                if id not in self.workers:self.workers[id]=asyncio.create_task(self.worker(id))
            for id in list(self.workers):
                if id not in active:
                    self.workers.pop(id).cancel()
            await asyncio.sleep(2)

    async def start(self):
        self.manager=asyncio.create_task(self.run())

    async def close(self):
        tasks=[t for t in [self.manager,*self.workers.values()] if t is not None]
        for task in tasks:task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
