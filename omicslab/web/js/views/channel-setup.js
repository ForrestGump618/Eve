/** Guided channel setup. QR/status comes from the actual server, never a placeholder. */
import { esc, escAttr } from '../util.js?v=1.0.0';
import { openModal, toastSuccess, toastError } from '../ui.js?v=1.0.0';

export async function renderChannels(root,{request,scope,reload}){
 const controller=new AbortController();let qrModal=null,qrTimer=0,disposed=false;
 const rows=(await request('/registry/channel')).items.filter(row=>row.adapter!=='webchat');
 const names={wechat:'微信',telegram:'Telegram',wecom:'企业微信',feishu:'飞书',dingtalk:'钉钉',qq:'QQ',openclaw:'OpenClaw'};
 const action=(key,label,id='')=>`<button class="btn btn-ghost btn-sm" data-channel-action="${key}" data-channel-id="${escAttr(id)}">${esc(label)}</button>`;
 root.innerHTML=`<section class="sw-card sw-hero"><h2>消息连接</h2><p>当前工作区 ${esc(scope())}。凭据只保存在本机。</p></section><div class="sw-grid sw-channel-options"><article class="sw-card"><span class="sw-channel-symbol">微</span><h3>微信</h3><p>扫码连接本人私聊，消息进入 Eve 任务中心。</p>${action('wechat','微信扫码连接')}</article><article class="sw-card"><span class="sw-channel-symbol">↗</span><h3>Telegram</h3><p>通过 BotFather 创建机器人并填写 Token。</p>${action('telegram','按步骤连接')}</article><article class="sw-card"><span class="sw-channel-symbol">飞</span><h3>飞书</h3><p>群自定义机器人 Webhook，仅支持外发。</p>${action('feishu','配置飞书机器人')}</article><article class="sw-card"><span class="sw-channel-symbol">钉</span><h3>钉钉</h3><p>群自定义机器人 Webhook，仅支持外发。</p>${action('dingtalk','配置钉钉机器人')}</article></div><div class="sw-toolbar"><h2>当前工作区的连接</h2>${action('reload','刷新连接状态')}</div><div class="sw-stack">${rows.map(c=>`<article class="sw-card"><header><div><span class="sw-overline">${esc(names[c.adapter]||c.adapter)}</span><h3>${esc(c.name)}</h3></div><span class="sw-badge">${!c.enabled?'已停用':c.connection?.status==='connected'?'接收消息中':c.connection?.status==='error'?'连接中断':c.adapter==='wechat'?'已扫码绑定':c.capabilities?.outbound&&!c.capabilities?.inbound?'已配置外发':'已配置'}</span></header><p>${c.allow_send?'允许向授权目标发送':'仅接收，结果在任务中心查看'} · ${c.read_only!==false?'只读 Agent':'按工作区权限执行'}</p>${c.connection?.error?`<p class="sw-error">${esc(c.connection.error)}</p>`:''}${c.capabilities?.reason?`<p>${esc(c.capabilities.reason)}</p>`:''}<div class="sw-inline">${action('test','测试连接',c.id)}${action('edit','连接设置',c.id)}${action('toggle',c.enabled?'停用':'启用',c.id)}${c.adapter==='wechat'?action('wechat','重新扫码'):''}</div></article>`).join('')||'<section class="sw-card"><p>还没有连接。可选择微信、Telegram、飞书或钉钉。</p></section>'}</div><p class="sw-muted">飞书与钉钉当前仅支持群机器人外发；接收消息需要平台官方应用事件订阅。微信暂不支持群聊、图片、语音和文件。</p>`;
 const textInput=(label,id,value='',type='text')=>`<label class="sw-field"><span>${esc(label)}</span><input class="input" type="${type}" id="${id}" value="${escAttr(value)}" autocomplete="off"/></label>`;
 function options(existing={}){return textInput('连接名称','channel-name',existing.name||'我的微信助手')+`<p>工作区：${esc(scope())} · Agent：${esc(existing.agent||'lead')}</p><label class="sw-check"><input type="checkbox" id="channel-reply" ${existing.allow_send?'checked':''}/>${existing.adapter&&existing.adapter!=='wechat'?'允许向已授权联系人发送文字消息（仍需确认）':'将成功完成的文字回答自动回复给扫码本人'}</label><p class="sw-muted">默认只接收消息。权限受限或证据待复核的任务在Eve中处理，不会自动发送研究结论。</p>`;}
 function wechatOptions(){let modal=openModal({title:'连接微信',html:options(),actions:[{label:'取消'},{label:'生成二维码',kind:'primary',onClick:async()=>{
  const data={name:modal.body.querySelector('#channel-name').value,allow_send:modal.body.querySelector('#channel-reply').checked};
  try{await showQR(data);}catch(err){toastError(err.message||String(err));return false;}
 }}]});}
 async function showQR(data){
  const login=await request('/channels/wechat/login','POST',data);if(disposed){await request(`/channels/wechat/login/${login.session_id}`,'DELETE');return;}
  let closed=false,verify='',refresh=false;
  qrModal=openModal({title:'用微信扫一扫',html:`<div class="sw-qr"><img src="${escAttr(login.image)}" alt="微信服务生成的登录二维码"/><p id="qr-status" role="status">请用手机微信扫描，并在手机上确认连接。</p><p class="sw-muted">二维码约三分钟有效，仅绑定扫码本人。关闭此窗口会停止等待。</p><div id="qr-verify" hidden>${textInput('手机显示的验证码','qr-code')}<button class="btn btn-primary" id="qr-submit">提交验证码</button></div></div>`,actions:[{label:'关闭'},{label:'刷新二维码',onClick:()=>{refresh=true;}}],onClose:()=>{
   closed=true;clearTimeout(qrTimer);void request(`/channels/wechat/login/${login.session_id}`,'DELETE').catch(()=>{});
   if(refresh&&!disposed)void showQR(data).catch(e=>toastError(e.message));
  }});
  const modal=qrModal;
  modal.body.querySelector('#qr-submit').addEventListener('click',()=>{verify=modal.body.querySelector('#qr-code').value.trim();});
  async function poll(){
   if(closed||disposed)return;
   try{
    const result=await request(`/channels/wechat/login/${login.session_id}/status`,'POST',{verify_code:verify});verify='';
    if(closed||disposed)return;
    const labels={wait:'等待手机扫码…',scaned:'已扫码，请在手机上确认。',need_verifycode:'请输入手机上显示的验证码。',expired:'二维码已过期，请点击刷新二维码。',verify_code_blocked:'验证码失败次数过多，请刷新二维码。',binded_redirect:'此微信已绑定其他实例，请先在手机上检查绑定。',cancelled:'扫码已取消。'};
    modal.body.querySelector('#qr-status').textContent=labels[result.status]||'微信已连接。';
    modal.body.querySelector('#qr-verify').hidden=result.status!=='need_verifycode';
    if(result.status==='confirmed'){toastSuccess('微信已连接，发一条文字消息试试');modal.close();await reload();return;}
    if(['expired','verify_code_blocked','binded_redirect','cancelled'].includes(result.status))return;
    qrTimer=setTimeout(poll,2000);
   }catch(err){if(!closed)modal.body.querySelector('#qr-status').textContent=(err.message||'连接中断')+'；请刷新二维码重试。';}
  }
  void poll();
 }
 function edit(channel){let modal=openModal({title:'连接设置',html:options(channel),actions:[{label:'取消'},{label:'保存',kind:'primary',onClick:async()=>{
  try{await request(`/registry/channel/${channel.id}`,'PUT',{name:modal.body.querySelector('#channel-name').value,allow_send:modal.body.querySelector('#channel-reply').checked});await reload();}catch(err){toastError(err.message);}
 }}]});}
 function telegram(){let connected=false;let modal=openModal({title:'连接 Telegram',html:`<ol><li>在 Telegram 打开官方 @BotFather，发送 /newbot 并完成命名。</li><li>将收到的 Bot Token 粘贴到下方。密钥通过本机凭据库保存。</li><li>填写允许对话的 Telegram 用户 ID；当前版本需要已部署的 HTTPS Webhook，尚无自动轮询。</li></ol>`+textInput('连接名称','tg-name','我的 Telegram 助手')+textInput('Bot Token','tg-token','','password')+textInput('授权用户 ID（多个用逗号分隔）','tg-contacts')+textInput('Webhook 共享密钥','tg-webhook','','password')+`<label class="sw-check"><input type="checkbox" id="tg-temp"/>仅在本次启动期间保存凭据（非 Windows 请选择此项）</label><p id="tg-status" role="status"></p>`,actions:[{label:'取消'},{label:'保存并测试',kind:'primary',close:false,onClick:async()=>{
  if(connected)return true;
  const get=id=>modal.body.querySelector('#'+id).value.trim();const status=modal.body.querySelector('#tg-status');
  try{
   if(!get('tg-token')||!get('tg-contacts')||!get('tg-webhook'))throw new Error('请填写 Token、用户 ID 与 Webhook 密钥');
   const id='telegram-'+crypto.randomUUID(),persist=!modal.body.querySelector('#tg-temp').checked;
   await request('/credentials/'+id,'POST',{value:get('tg-token'),persist});
   await request('/credentials/'+id+'-webhook','POST',{value:get('tg-webhook'),persist});
   const row=await request('/registry/channel','POST',{name:get('tg-name'),adapter:'telegram',workspace:scope(),agent:'lead',contacts:get('tg-contacts').split(/[,，\s]+/).filter(Boolean),credential_ref:id,webhook_ref:id+'-webhook',enabled:true,read_only:true,allow_send:false});
   await request(`/channels/${row.id}/test`,'POST',{});
   status.textContent=`机器人认证成功。请将公开 HTTPS 地址 /api/platform/channels/${row.id}/webhook 注册为 Telegram Webhook，并使用刚填写的共享密钥。`;connected=true;modal.footer.querySelector('button:last-child').textContent='完成';await reload();
  }catch(err){status.textContent=err.message||String(err);}
  return false;
 }}]});}
 function webhookChannel(adapter){
  const label=adapter==='feishu'?'飞书':'钉钉';
  const hint=adapter==='feishu'?'飞书群设置 → 群机器人 → 自定义机器人 → Webhook 地址':'钉钉群设置 → 机器人 → 自定义机器人 → Webhook 地址';
  let connected=false;
  const modal=openModal({title:`配置${label}机器人`,html:`<p class="sw-muted">${hint}</p>`+textInput('连接名称',`${adapter}-name`,`我的${label}通知`)+textInput('Webhook URL',`${adapter}-webhook`,'','password')+textInput('签名密钥（机器人启用签名时填写）',`${adapter}-secret`,'','password')+`<p class="sw-muted">Webhook 与签名密钥分别加密保存。当前只支持向群机器人发送文字。</p><p id="${adapter}-status" role="status"></p>`,actions:[{label:'取消'},{label:'保存并检查',kind:'primary',close:false,onClick:async()=>{
   if(connected)return true;
   const get=id=>modal.body.querySelector('#'+id).value.trim();
   const status=modal.body.querySelector(`#${adapter}-status`);
   try{
    const webhook=get(`${adapter}-webhook`);
    if(!webhook)throw new Error('请填写 Webhook URL');
    const ref=`${adapter}-${crypto.randomUUID()}`;
    await request('/credentials/'+ref+'-webhook','POST',{value:webhook});
    if(get(`${adapter}-secret`))await request('/credentials/'+ref+'-secret','POST',{value:get(`${adapter}-secret`)});
    const row=await request('/registry/channel','POST',{name:get(`${adapter}-name`),adapter,workspace:scope(),agent:'lead',contacts:[],webhook_ref:ref+'-webhook',credential_ref:get(`${adapter}-secret`)?ref+'-secret':'',enabled:true,read_only:true,allow_send:true});
    await request(`/channels/${row.id}/test`,'POST',{});
    status.textContent='配置已保存。可在“当前工作区的连接”中发送测试。';connected=true;modal.footer.querySelector('button:last-child').textContent='完成';await reload();
   }catch(err){status.textContent=err.message||String(err);}
   return false;
  }}]});
 }
 root.addEventListener('click',async event=>{
  const target=event.target.closest('[data-channel-action]');if(!target)return;
  const key=target.dataset.channelAction,row=rows.find(c=>c.id===target.dataset.channelId);
  try{
   if(key==='wechat')wechatOptions();
   else if(key==='telegram')telegram();
   else if(key==='feishu'||key==='dingtalk')webhookChannel(key);
   else if(key==='edit')edit(row);
   else if(key==='reload')await reload();
   else if(key==='toggle'){await request(`/registry/channel/${row.id}`,'PUT',{enabled:!row.enabled});await reload();}
   else if(key==='test'){await request(`/channels/${row.id}/test`,'POST',{});toastSuccess('连接测试通过');await reload();}
  }catch(err){toastError(err.message||String(err));}
 },{signal:controller.signal});
 return {destroy(){disposed=true;controller.abort();clearTimeout(qrTimer);qrModal?.close();}};
}
