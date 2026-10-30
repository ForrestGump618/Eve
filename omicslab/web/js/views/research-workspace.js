import {esc,escAttr,setPref,summarizeValue,prettyValue} from '../util.js?v=1.0.0';
import {navigate} from '../store.js?v=1.0.0';
import {openModal,toastError,toastSuccess} from '../ui.js?v=1.0.0';

const statuses={pending:'未开始',running:'执行中',needs_evidence:'待登记证据',recorded:'证据已登记',failed:'失败',cancelled:'已取消',interrupted:'待恢复'};
const field=(label,id,value='')=>`<label class="sw-field"><span>${esc(label)}</span><input class="input" id="${id}" value="${escAttr(value)}"/></label>`;
const area=(label,id,value='')=>`<label class="sw-field"><span>${esc(label)}</span><textarea class="input" id="${id}" rows="4">${esc(value)}</textarea></label>`;

export async function mountResearchWorkspace(root,{request}){
 const controller=new AbortController();let quests=[],selected=null,disposed=false,refreshTimer;
 const action=(name,label,id='',stage='')=>`<button type="button" class="btn btn-ghost btn-sm" data-research="${name}" data-id="${escAttr(id)}" data-stage="${escAttr(stage)}">${esc(label)}</button>`;
 async function reload(){
  clearTimeout(refreshTimer);
  const result=await request('/quests');if(disposed)return;
  quests=result.items;selected=quests.find(q=>q.id===selected?.id)||quests[0]||null;render();
  if(quests.some(q=>q.stages.some(s=>s.status==='running')))refreshTimer=setTimeout(()=>{
   if(document.hidden){refreshTimer=setTimeout(()=>reload().catch(error=>toastError(error.message)),5000);return;}
   reload().catch(error=>toastError(error.message));
  },3000);
 }
 function render(){
  root.innerHTML=`<section class="sw-card eve-research-head"><div><span class="sw-overline">研究课题</span><h2>研究阶段与证据</h2><p>阶段、运行和产物都保留记录。</p></div><div class="sw-inline">${action('new','新建课题')}${action('refresh','刷新状态')}</div></section>
  <div class="eve-quest-layout"><aside class="eve-quest-list" aria-label="科研课题">${quests.map(q=>`<button type="button" class="eve-quest-item ${q.id===selected?.id?'is-active':''}" data-research="select" data-id="${escAttr(q.id)}"><strong>${esc(q.title)}</strong><span>${q.stages.filter(s=>s.status==='recorded').length}/7 阶段 · ${q.status==='completed'?'已人工结题':'进行中'}</span></button>`).join('')||'<p class="sw-muted">创建一个课题，明确研究问题和比较契约。</p>'}</aside>
  <div class="eve-quest-body">${selected?questHtml(selected):''}</div></div>
`;
 }
 function questHtml(q){
  return `<section class="sw-card"><header><div><h2>${esc(q.title)}</h2><p>${esc(q.question)}</p></div><span class="sw-badge">科学结论：待复核</span></header><div class="eve-contract"><span>数据集 <strong>${esc(q.dataset)}</strong></span><span>协议 <strong>${esc(q.protocol)}</strong></span><span>指标 ${q.metrics.map(m=>`${esc(m.name)} ${m.direction==='min'?'↓':'↑'}`).join(' · ')}</span></div></section>
  <div class="eve-stage-map" role="list" aria-label="科研阶段图">${q.stages.map((s,i)=>`<article role="listitem" class="eve-stage" data-status="${escAttr(s.status)}"><span class="eve-stage-number">${String(i+1).padStart(2,'0')}</span><h3>${esc(s.label)}</h3><span class="sw-badge">${esc(statuses[s.status]||s.status)}</span><p>${esc(s.summary||'等待运行和产物证据')}</p><div class="sw-inline">${s.id!=='finalize'&&s.status!=='running'?action('launch','启动阶段',q.id,s.id):''}${action('record',s.id==='finalize'?'人工复核结题':'登记证据',q.id,s.id)}${s.session_id?action('chat','查看任务',s.session_id):''}</div><details><summary>产物与指标 (${s.evidence.length})</summary><ul>${s.evidence.map(e=>`<li><code>${esc(e.path)}</code><small>${esc(e.sha256)}</small></li>`).join('')}</ul>${s.measured?`<p class="sw-muted">指标：${esc(summarizeValue(s.measured, 180))}</p><details class="technical-details"><summary>指标数据</summary><pre class="sw-json">${esc(prettyValue(s.measured, 40_000))}</pre></details>`:''}${s.comparison?`<p class="sw-muted">比较：${esc(summarizeValue(s.comparison, 180))}</p><details class="technical-details"><summary>比较数据</summary><pre class="sw-json">${esc(prettyValue(s.comparison, 40_000))}</pre></details>`:''}${s.run_id?`<p class="sw-muted">运行 ${esc(s.run_id)} · ${esc(s.run_status||s.status)}</p>`:''}</details></article>`).join('')}</div>
  <section class="sw-card"><h3>发现与失败记录</h3>${q.findings.slice(-30).reverse().map(f=>`<div class="eve-finding"><span>${esc(f.stage)}</span><p>${esc(f.summary)}</p><small>${f.evidence.length} 个来源 · ${new Date(f.at*1000).toLocaleString()}</small></div>`).join('')||'<p class="sw-muted">尚无证据记录。失败与阴性结果同样保留。</p>'}</section>`;
 }
 function form(title,html,submit,label='保存'){
  openModal({title,size:'lg',html,actions:[{label:'取消'},{label,kind:'primary',onClick:async ({body})=>{
   try{await submit(body);await reload();toastSuccess('已保存真实课题记录');return true;}catch(error){toastError(error.message);return false;}
  }}]});
 }
 root.addEventListener('click',async event=>{
  const node=event.target.closest('[data-research]');if(!node)return;
  const {research:kind,id,stage}=node.dataset;
  try{
   if(kind==='refresh')return await reload();
   if(kind==='select'){selected=quests.find(q=>q.id===id);render();return;}
   if(kind==='chat'){setPref('activeConversationId',id);navigate('workbench');return;}
   if(kind==='new')return form('新建科研课题',field('课题名称','quest-title')+area('研究问题','quest-question')+field('数据集标识','quest-dataset')+field('评估协议 / split','quest-protocol')+area('指标契约 JSON','quest-metrics','[{"name":"accuracy","direction":"max"}]'),async body=>{
    const value=id=>body.querySelector('#'+id).value;
    selected=await request('/quests','POST',{title:value('quest-title'),question:value('quest-question'),dataset:value('quest-dataset'),protocol:value('quest-protocol'),metrics:JSON.parse(value('quest-metrics'))});
   });
   if(kind==='launch'){
    node.disabled=true;
    try{await request(`/quests/${encodeURIComponent(id)}/launch`,'POST',{stage});await reload();toastSuccess('阶段任务已启动，默认请求批准；可在聊天中跟进');}finally{node.disabled=false;}
   }
   if(kind==='record')return form(stage==='finalize'?'人工复核并结题':'登记真实产物',
    area('产物路径（每行一个，当前本地或 SSH 工作区）','quest-paths')+
    (['baseline','experiment'].includes(stage)?field('指标 JSON 路径','quest-metric-path'):'')+
    area('结论、失败或未完成事项','quest-summary')+
    (stage==='finalize'?'<label class="sw-check"><input id="quest-approved" type="checkbox"/>我已复核证据、局限和未完成事项，同意结题</label>':''),
    async body=>request(`/quests/${encodeURIComponent(id)}/record`,'POST',{stage,artifacts:body.querySelector('#quest-paths').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),summary:body.querySelector('#quest-summary').value,metrics_path:body.querySelector('#quest-metric-path')?.value,human_approved:body.querySelector('#quest-approved')?.checked===true}));
  }catch(error){toastError(error.message);}
 },{signal:controller.signal});
 await reload();
 return {destroy(){disposed=true;clearTimeout(refreshTimer);controller.abort();}};
}
