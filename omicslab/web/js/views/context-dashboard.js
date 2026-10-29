import {api,errorMessage} from '../api.js?v=1.3.0';
import {esc,escAttr} from '../util.js?v=1.3.0';
import {getState} from '../store.js?v=1.3.0';
import {on} from '../bus.js?v=1.3.0';
import {openModal,toastError,toastSuccess} from '../ui.js?v=1.3.0';
import {contextRequestsHtml,contextActivityHtml,contextOverviewHtml} from '../context-components.js?v=1.3.0';
import {openRunDetail} from '../runview.js?v=1.3.0';

export async function mount(root){
 const abort=new AbortController();let disposed=false,epoch=0,data=null,sourceRefs=[],overview=null,overviewEpoch=0,overviewMode=false;
 const filters={query:'',sort:'recent',day:''};
 root.innerHTML=`<div class="eve-dashboard"><header class="eve-page-header"><h1>上下文</h1><div><button class="btn btn-sm" id="context-overview-toggle">全局洞察</button><select id="context-range" aria-label="统计范围" hidden><option value="7">7 天</option><option value="30">30 天</option><option value="0">全部</option></select><select id="context-conversation" aria-label="上下文会话"></select><button class="btn btn-sm" id="context-refresh">刷新</button></div></header><div id="context-overview" hidden></div><div id="context-content">正在读取…</div></div>`;
 const selector=root.querySelector('#context-conversation'),content=root.querySelector('#context-content');
 async function list(){
  try{
   const result=await api.conversations.list();if(disposed)return;
   const items=(result.conversations||[]).filter(c=>!getState().workspaceId||(c.workspace_id||'ws_main')===getState().workspaceId);
   selector.innerHTML=items.map(c=>`<option value="${escAttr(c.id)}">${esc(c.title||'新会话')}${c.archived?' · 已归档':''}</option>`).join('');
   if(items.some(c=>c.id===getState().activeConversationId))selector.value=getState().activeConversationId;
   await load();
  }catch(error){if(!disposed)content.textContent=errorMessage(error);}
 }
 async function load(query=''){
  const current=++epoch,cid=selector.value;if(!cid){content.textContent='请选择一个会话';return;}
  try{
   const result=await api.request(`/api/conversations/${encodeURIComponent(cid)}/context${query?'?query='+encodeURIComponent(query):''}`,{signal:abort.signal});
   if(disposed||current!==epoch)return;data=result;
   if(query){showMatches(result.matches||[]);return;}
   render();
  }catch(error){if(!disposed&&current===epoch)content.textContent=errorMessage(error);}
 }
 function render(){
  const harness=data.harness,composition=harness?.composition||data.composition||{},total=Object.values(composition).reduce((n,v)=>n+Number(v),0);
  const snapshots=harness?.snapshots||[];sourceRefs=[];
  content.innerHTML=`<div class="eve-metric-grid"><article><span>原始消息</span><strong>${data.message_count}</strong></article><article><span>内容估算</span><strong>${total.toLocaleString()}</strong><small>UTF-8 字节上界，非供应商计量</small></article><article><span>模型窗口</span><strong>${harness?.contextWindow?.toLocaleString()||'—'}</strong><small>${esc(harness?.model||'暂无 Harness 记录')}</small></article><article><span>运行累计 Token</span><strong>${Number(data.usage?.total_tokens||0).toLocaleString()}</strong><small>最近 30 次运行；缺失用量不计入</small></article></div>
   <section class="eve-dashboard-card"><h2>组成</h2><div class="context-composition">${Object.entries(composition).map(([role,value])=>`<div><span>${esc(({system:'系统规则',user:'用户消息',assistant:'模型输出',tool:'工具结果',error:'错误'})[role]||role)}</span><meter min="0" max="${Math.max(1,total)}" value="${Number(value)}"></meter><code>${Number(value).toLocaleString()}</code></div>`).join('')}</div><p class="eve-detail-note">内容分类不含模型隐藏推理、供应商协议封装或本轮动态工具目录。</p></section>
   <section class="eve-dashboard-card"><div class="eve-card-heading"><h2>压缩记录</h2><button class="btn btn-sm" data-context-action="compact" ${data.task_id?'':'disabled'}>生成摘要</button></div><p class="eve-detail-note">自动压缩由运行时执行。此处管理摘要视图；恢复摘要不回滚文件、工具操作或会话原文。执行中的会话禁止手动压缩与恢复。</p>${data.harness_error?`<p role="alert">${esc(data.harness_error)}</p>`:''}
   ${snapshots.map(snapshot=>{
    const refs=[...(snapshot.userGoals||[]),...(snapshot.observedFacts||[])];
    return `<details class="context-snapshot"><summary>版本 ${snapshot.version} · ${new Date(snapshot.createdAt).toLocaleString()}<span>${snapshot.stats.beforeTokens.toLocaleString()} → ${snapshot.stats.afterTokens.toLocaleString()}</span></summary><div class="context-snapshot-body"><p>显式字段校验保留率 ${Math.round(snapshot.stats.explicitFactRetention*100)}%（不代表全文语义无损）</p><pre>${esc(JSON.stringify(snapshot.state,null,2))}</pre><div>${refs.slice(0,30).map(ref=>{const index=sourceRefs.push(ref.source)-1;return `<button class="context-source" data-context-source="${index}">${esc(ref.text.slice(0,180))}</button>`;}).join('')}</div><button class="btn btn-sm" data-context-action="restore" data-version="${snapshot.version}">恢复此摘要视图</button></div></details>`;
   }).join('')||'<p class="eve-muted">尚无压缩摘要。原始上下文仍保留。</p>'}</section>
   ${contextRequestsHtml(harness?.requests)}${contextActivityHtml(data)}
   <section class="eve-dashboard-card"><h2>查找会话与压缩前原文</h2><form id="context-search"><input class="input" id="context-query" placeholder="关键词、路径或错误信息" aria-label="检索上下文"/><button class="btn btn-sm">查找</button></form><div id="context-matches"></div></section>`;
 }
 function showMatches(matches){
  const box=root.querySelector('#context-matches');if(!box)return;
  box.innerHTML=matches.map(m=>`<details class="context-snapshot"><summary>${esc(m.role)} · ${new Date(m.ts*1000).toLocaleString()}</summary><pre>${esc(m.text)}</pre><small>消息 ID：${esc(m.id)}</small></details>`).join('')||'<p class="eve-muted">没有匹配的原文</p>';
 }
 root.addEventListener('click',async event=>{
  const request=event.target.closest('[data-context-request]'),more=event.target.closest('[data-context-more]'),run=event.target.closest('[data-context-run]'),pick=event.target.closest('[data-context-session]'),day=event.target.closest('[data-context-day]');
  if(run){openRunDetail({runId:run.dataset.contextRun});return;}
  if(day){filters.day=filters.day===day.dataset.contextDay?'':day.dataset.contextDay;renderOverview();return;}
  if(pick){selector.value=pick.dataset.contextSession;toggleOverview(false);await load();return;}
  if(request||more){
   const button=request||more;button.disabled=true;const cid=selector.value,currentTask=data.task_id;
   try{
    const result=await api.request(`/api/conversations/${encodeURIComponent(cid)}/context/${request?'request':'requests'}`,{method:'POST',body:{task_id:currentTask,...(request?{sequence:Number(request.dataset.contextRequest)}:{offset:Number(more.dataset.contextMore)})}});
    if(disposed||selector.value!==cid)return;
    if(request){
     const modal=openModal({title:`模型请求 ${result.sequence}`,size:'lg',html:`<div class="context-request-browser">${(result.messages||[]).map(m=>`<details class="context-snapshot"><summary>${esc(m.role)} · ${m.content.length} 字符</summary><pre class="context-original">${esc(m.content)}</pre>${m.tool_calls?`<pre>${esc(JSON.stringify(m.tool_calls,null,2))}</pre>`:''}<button class="btn btn-sm" data-original-index="${m.source.messageIndex}">原文来源</button></details>`).join('')}<details><summary>工具 Schema（${result.tools?.length||0}）</summary><pre class="context-original">${esc(JSON.stringify(result.tools,null,2))}</pre></details></div>`});
     modal.body.onclick=async e=>{const source=e.target.closest('[data-original-index]');if(!source)return;source.disabled=true;try{
      const m=result.messages.find(m=>m.source.messageIndex===Number(source.dataset.originalIndex));
      const original=await api.request(`/api/conversations/${encodeURIComponent(cid)}/context/source`,{method:'POST',body:{task_id:currentTask,source:m.source}});
      openModal({title:'已校验的原始上下文',html:`<pre class="context-original">${esc(original.content)}</pre>`});
     }catch(error){toastError(errorMessage(error));}finally{source.disabled=false;}};
     if(result.nextOffset!==null)modal.body.insertAdjacentHTML('beforeend',`<p class="eve-detail-note">当前显示前 ${result.messages.length} 条，共 ${result.total} 条；可使用原文检索定位后续内容。</p>`);
    }else{data.harness.requests={...result,items:[...data.harness.requests.items,...result.items]};render();}
   }catch(error){toastError(errorMessage(error));}finally{button.disabled=false;}return;
  }
  const action=event.target.closest('[data-context-action]'),source=event.target.closest('[data-context-source]');
  if(!action&&!source)return;
  const button=action||source;button.disabled=true;
  try{
   const result=await api.request(`/api/conversations/${encodeURIComponent(selector.value)}/context/${source?'source':action.dataset.contextAction}`,{method:'POST',body:{task_id:data.task_id,...(source?{source:sourceRefs[Number(source.dataset.contextSource)]}:{version:Number(action.dataset.version)||undefined})}});
   if(disposed)return;
   if(source)openModal({title:'已校验的原始上下文',html:`<pre class="context-original">${esc(result.content||'')}</pre>`});
   else{toastSuccess('摘要视图已更新');await load();}
  }catch(error){toastError(errorMessage(error));}finally{button.disabled=false;}
 },{signal:abort.signal});
 root.addEventListener('submit',async event=>{if(event.target.id==='context-search'){
  event.preventDefault();const query=root.querySelector('#context-query').value.trim();if(!query)return;
  const current=epoch,cid=selector.value;await load(query);if(disposed||current+1!==epoch||selector.value!==cid)return;
  if(data.task_id)try{
   const result=await api.request(`/api/conversations/${encodeURIComponent(cid)}/context/search`,{method:'POST',body:{task_id:data.task_id,query}});
   if(disposed||selector.value!==cid)return;
   root.querySelector('#context-matches')?.insertAdjacentHTML('beforeend',(result.matches||[]).map(m=>{const index=sourceRefs.push(m.source)-1;return `<details class="context-snapshot"><summary>请求 ${m.source.requestSequence} · ${esc(m.role)} · 原始存档</summary><pre>${esc(m.text)}</pre><button class="btn btn-sm" data-context-source="${index}">读取已校验原文</button></details>`;}).join(''));
  }catch(error){toastError(errorMessage(error));}
 }},{signal:abort.signal});
 function renderOverview(){if(!disposed&&overview)root.querySelector('#context-overview').innerHTML=contextOverviewHtml(overview,filters);}
 async function loadOverview(){
  const current=++overviewEpoch,scope=getState().workspaceId||'ws_main';
  try{const value=await api.request(`/api/context/insights?scope=${encodeURIComponent(scope)}&days=${root.querySelector('#context-range').value}`,{signal:abort.signal});
   if(disposed||current!==overviewEpoch||scope!==(getState().workspaceId||'ws_main'))return;overview=value;renderOverview();
  }catch(error){if(!disposed)toastError(errorMessage(error));}
 }
 function toggleOverview(value){
  overviewMode=value;content.hidden=value;selector.hidden=value;
  root.querySelector('#context-overview').hidden=!value;root.querySelector('#context-range').hidden=!value;
  root.querySelector('#context-overview-toggle').textContent=value?'会话上下文':'全局洞察';if(value)void loadOverview();
 }
 root.querySelector('#context-overview-toggle').addEventListener('click',()=>toggleOverview(!overviewMode),{signal:abort.signal});
 root.querySelector('#context-range').addEventListener('change',()=>loadOverview(),{signal:abort.signal});
 root.addEventListener('change',event=>{if(event.target.id==='insights-sort'){filters.sort=event.target.value;renderOverview();}},{signal:abort.signal});
 root.addEventListener('input',event=>{if(event.target.id==='insights-query'){
  filters.query=event.target.value;const start=event.target.selectionStart;renderOverview();const next=root.querySelector('#insights-query');next.focus();next.setSelectionRange(start,start);
 }},{signal:abort.signal});
 selector.addEventListener('change',()=>load(),{signal:abort.signal});
 root.querySelector('#context-refresh').addEventListener('click',()=>overviewMode?loadOverview():load(),{signal:abort.signal});
 const off=on('workspace:change',()=>{overviewEpoch++;filters.day='';void list();if(overviewMode)void loadOverview();});
 await list();
 return {destroy(){disposed=true;epoch++;abort.abort();off();root.innerHTML='';}};
}
