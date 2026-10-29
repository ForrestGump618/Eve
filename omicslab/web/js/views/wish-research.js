import {closeAllModals,confirmDialog,openModal,toastError,toastSuccess} from '../ui.js?v=1.2.0';
import {esc,escAttr,setPref} from '../util.js?v=1.2.0';
import {navigate} from '../store.js?v=1.2.0';

const statusLabels={
 active:'进行中',blocked:'等待条件',awaiting_review:'等待用户复核',completed:'已人工结题',
 pending:'未开始',running:'执行中',needs_evidence:'待真实产物',recorded:'证据已登记',
 failed:'失败待恢复',needs_review:'等待用户复核',
};
const kindLabels={
 charter:'章程',scouting:'侦察',evidence_matrix:'证据',hypotheses:'假设',
 preregistration:'预注册',analysis:'分析',experiment_design:'实验',figures:'图表',review:'复核',
};
const actionButton=(kind,label,id='',stage='',primary=false)=>
 `<button type="button" class="${primary?'btn btn-primary':'btn btn-ghost'} btn-sm" data-wish-action="${kind}" data-id="${escAttr(id)}" data-stage="${escAttr(stage)}">${esc(label)}</button>`;
const field=(label,id,value='',placeholder='',type='text')=>
 `<label class="sw-field"><span>${esc(label)}</span><input class="input" id="${id}" type="${escAttr(type)}" value="${escAttr(value||'')}" placeholder="${escAttr(placeholder)}"/></label>`;
const area=(label,id,value='',placeholder='',rows=4)=>
 `<label class="sw-field"><span>${esc(label)}</span><textarea class="input" id="${id}" rows="${rows}" placeholder="${escAttr(placeholder)}">${esc(value||'')}</textarea></label>`;
const lines=value=>String(value||'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
const statusBadge=status=>`<span class="sw-badge wish-status status-${escAttr(status)}">${esc(statusLabels[status]||status)}</span>`;

export async function mountWishResearch(root,{request}){
 const controller=new AbortController();
 let wishes=[],selected=null,disposed=false,timer=0;
 async function reload(){
  clearTimeout(timer);
  const result=await request('/wishes');
  if(disposed)return;
  wishes=result.items||[];
  selected=wishes.find(item=>item.id===selected?.id)||wishes[0]||null;
  render();
  if(wishes.some(wish=>wish.stages.some(stage=>stage.status==='running'))){
   timer=setTimeout(()=>reload().catch(error=>toastError(error.message)),3500);
  }
 }
 function render(){
  root.innerHTML=`<section class="sw-card wish-hero">
   <div class="wish-hero-copy"><span class="sw-overline">科研愿望</span><h2>说清课题，Eve 按证据链推进。</h2><p>从一句话开始建立持久项目。Eve 盘点数据与文献、提出可证伪假设、预注册分析、执行计算并规划验证；遇到阻塞或人工复核时停下。真实输入、代码、结果与图表都留在项目工作区。</p></div>
   <div class="wish-hero-action">${actionButton('new','新建科研愿望','', '', true)}</div>
  </section>
  <div class="wish-layout">
   <aside class="wish-list" aria-label="科研愿望">${wishes.map(wish=>wishListItem(wish)).join('')||`<div class="wish-list-empty"><span>还没有科研愿望</span><button type="button" class="btn btn-ghost btn-sm" data-wish-action="new">新建科研愿望</button></div>`}</aside>
   <main class="wish-detail">${selected?detail(selected):emptyState()}</main>
  </div>`;
 }
 function wishListItem(wish){
  const recorded=wish.stages.filter(stage=>stage.status==='recorded').length;
  const next=wish.next_actions?.[0];
  return `<button type="button" class="wish-list-item ${wish.id===selected?.id?'is-active':''}" data-wish-action="select" data-id="${escAttr(wish.id)}">
   <span class="wish-list-title">${esc(wish.title)}</span>
   <span class="wish-list-meta">${statusBadge(wish.status)}<small>${recorded}/${wish.stages.length} 节点</small></span>
   <span class="wish-list-next">${esc(next?.label||(wish.status==='awaiting_review'?'等待你复核':'已收口'))}</span>
  </button>`;
 }
 function emptyState(){
  return `<section class="sw-card wish-empty"><span class="wish-empty-mark">W</span><h3>从一个问题开始</h3><p>例如：“我想知道这个公开单细胞数据集里，哪些细胞状态与耐药相关，并设计能验证它的实验。”</p>${actionButton('new','新建科研愿望','', '', true)}</section>`;
 }
 function detail(wish){
  const nextAgent=wish.next_actions.find(action=>action.owner==='agent');
  const nextUser=wish.next_actions.find(action=>action.owner==='user');
  const blockers=wish.blockers.filter(item=>!item.resolved);
  return `${blockers.length?blockerCard(blockers):''}
  <section class="sw-card wish-summary">
   <header><div><span class="sw-overline">${esc(kindLabels[wish.phase]||wish.phase)}</span><h2>${esc(wish.title)}</h2><p class="wish-question">${esc(wish.wish)}</p></div>${statusBadge(wish.status)}</header>
   <div class="wish-next">${nextAgent?`<div><span>下一步</span><strong>${esc(nextAgent.label)}</strong><p>${esc(nextAgent.reason)} · 完成后 Eve 会按依赖继续，直到阻塞或需要你复核。</p><code>${esc(nextAgent.output)}</code></div>${actionButton('launch','让 Eve 连续推进',wish.id,nextAgent.stage,true)}`:nextUser?`<div><span>等待你</span><strong>${esc(nextUser.label)}</strong><p>证据链已齐，需要你核对局限与未完成项。</p></div>${actionButton('review','复核并结题',wish.id,'','')}`:`<div><span>当前状态</span><strong>${esc(statusLabels[wish.status]||wish.status)}</strong><p>${wish.status==='completed'?'此愿望已由用户复核结题。':'当前没有可执行节点；请查看阻塞项或进度。'}</p></div>`}</div>
   <div class="sw-inline">${actionButton('charter','调整章程',wish.id)}${actionButton('refresh','刷新')}</div>
  </section>
  <section class="sw-card wish-charter"><header><div><h3>成功画面</h3><p>先约定“什么算完成”，避免智能体用热闹的过程替代证据。</p></div><span class="wish-count">${wish.charter.success_criteria.length} 条判据</span></header>
   <div class="wish-criteria">${wish.charter.success_criteria.map((item,index)=>`<div><span>${String(index+1).padStart(2,'0')}</span><p>${esc(item)}</p></div>`).join('')}</div>
   <div class="wish-boundary-grid"><div><h4>边界</h4>${wish.charter.boundaries.map(item=>`<p>${esc(item)}</p>`).join('')}</div><div><h4>停止条件</h4>${wish.charter.stop_conditions.map(item=>`<p>${esc(item)}</p>`).join('')}</div></div>
  </section>
  <section class="sw-card wish-workspace"><header><div><h3>项目工作区</h3><p>分析、实验和图表都有固定位置；平台只记录真实文件哈希。</p></div><code>${esc(wish.workspace.base)}</code></header>
   <div class="wish-workspace-grid">${wish.workspace.directories.map(directory=>`<div><span>${esc(directory.split('/').pop())}</span><code>${esc(directory)}</code></div>`).join('')}</div>
  </section>
  <section class="wish-pipeline" aria-label="研究节点">${wish.stages.map(stageCard).join('')}</section>
  <section class="sw-card wish-activity"><header><div><h3>证据与失败记录</h3><p>阴性结果、阻塞和失败不会被“成功叙事”删除。</p></div><span class="wish-count">${wish.stages.reduce((count,stage)=>count+(stage.evidence?.length||0),0)} 个产物</span></header>
   ${wish.stages.filter(stage=>stage.summary).slice().reverse().map(stage=>`<article><span>${esc(stage.label)}</span><p>${esc(stage.summary)}</p><small>${stage.evidence?.length||0} 个产物${stage.skipped?' · 已说明不适用':''}</small></article>`).join('')||'<p class="sw-muted">尚未登记节点结论。</p>'}
  </section>`;
 }
 function blockerCard(blockers){
  return `<section class="sw-card wish-blocker"><div><span class="sw-overline">BLOCKED</span><h3>Eve 需要一个不可推断的条件</h3>${blockers.map(item=>`<p><strong>${esc(item.reason)}</strong><br>${esc(item.needed)}</p><button type="button" class="btn btn-ghost btn-sm" data-wish-action="resolve-block" data-id="${escAttr(selected.id)}" data-stage="${escAttr(item.id)}">条件已补齐</button>`).join('')}</div></section>`;
 }
 function stageCard(stage,index){
  const evidence=stage.evidence||[];
  const dependencies=(stage.depends_on||[]).map(id=>kindLabels[id]||id);
  return `<article class="wish-stage" data-wish-stage="${escAttr(stage.id)}" data-status="${escAttr(stage.status)}">
   <header><span>${String(index+1).padStart(2,'0')} · ${esc(kindLabels[stage.id]||stage.id)}</span>${statusBadge(stage.status)}</header>
   <h3>${esc(stage.label)}</h3><p>${esc(stage.summary||stage.purpose)}</p>
   <footer><span>${dependencies.length?`前置：${esc(dependencies.join('、'))}`:'起始节点'} · ${evidence.length?`${evidence.length} 个产物`:'等待真实产物'}</span><code>${esc(stage.output)}</code></footer>
  </article>`;
 }
 function form(title,html,submit,label='保存'){
  openModal({title,size:'lg',html,actions:[
   {label:'取消'},
   {label,kind:'primary',onClick:async ({body})=>{
    try{await submit(body);closeAllModals();await reload();toastSuccess('愿望项目已更新');return true;}
    catch(error){toastError(error.message);return false;}
   }},
  ]});
 }
 function startForm(){
  form('新建科研愿望',area('你希望 Eve 帮你完成什么？','wish-text','','用自然语言描述目标、困惑或想验证的课题。',6)+
   area('你认为什么算完成？（每行一条，可选）','wish-success','','例如：找到可复现的候选细胞状态，并给出独立验证实验',3)+
   area('不能越过的边界（每行一条，可选）','wish-boundaries','','例如：只使用公开数据；不发送未脱敏样本信息',3),
  async body=>{
   const data={wish:body.querySelector('#wish-text').value};
   const success=lines(body.querySelector('#wish-success').value);if(success.length)data.success_criteria=success;
   const boundaries=lines(body.querySelector('#wish-boundaries').value);if(boundaries.length)data.boundaries=boundaries;
   selected=await request('/wishes','POST',data);
  },'建立愿望项目');
 }
 function charterForm(wish){
  form('调整愿望章程',field('课题标题','wish-title',wish.title)+area('可验证目标','wish-goal',wish.charter.goal,'',5)+
   area('成功判据（每行一条）','wish-success',wish.charter.success_criteria.join('\n'),'',4)+
   area('边界（每行一条）','wish-boundaries',wish.charter.boundaries.join('\n'),'',3)+
   area('未知项（每行一条）','wish-unknowns',wish.charter.unknowns.join('\n'),'',3)+
   area('停止条件（每行一条）','wish-stops',wish.charter.stop_conditions.join('\n'),'',3),
  async body=>{
   selected=await request(`/wishes/${encodeURIComponent(wish.id)}`,'PUT',{
    title:body.querySelector('#wish-title').value,
    wish:body.querySelector('#wish-goal').value,
    success_criteria:lines(body.querySelector('#wish-success').value),
    boundaries:lines(body.querySelector('#wish-boundaries').value),
    unknowns:lines(body.querySelector('#wish-unknowns').value),
    stop_conditions:lines(body.querySelector('#wish-stops').value),
   });
  },'保存章程');
 }
 function reviewForm(wish){
  form('人工复核并结题',field('复核人','wish-reviewer','','你的名字')+area('你核对了什么？还有什么局限或未完成项？','wish-review-notes','','至少 20 字；写明证据、阴性结果、引用与限制',6)+
   '<label class="sw-check"><input id="wish-confirm" type="checkbox"/>我已核对项目内证据与产物，接受当前结论边界</label>',
  async body=>{
   if(!body.querySelector('#wish-confirm').checked)throw new Error('请先确认已人工核对');
   selected=await request(`/wishes/${encodeURIComponent(wish.id)}/review`,'POST',{
    confirmed:true,reviewer:body.querySelector('#wish-reviewer').value.trim(),
    notes:body.querySelector('#wish-review-notes').value.trim(),
   });
  },'确认结题');
 }
 function resolveBlockerForm(wish,blockerId){
  form('解除阻塞',area('你补齐了什么条件？','wish-resolution','','说明数据、授权或环境如何得到验证',4),async body=>{
   selected=await request(`/wishes/${encodeURIComponent(wish.id)}/block`,'POST',{
    resolved:true,blocker_id:blockerId,resolution:body.querySelector('#wish-resolution').value.trim(),
   });
  },'确认已补齐');
 }
 root.addEventListener('click',async event=>{
  const target=event.target.closest('[data-wish-action]');if(!target)return;
  const {wishAction:kind,id,stage}=target.dataset;
  try{
   if(kind==='new')return startForm();
   if(kind==='refresh')return await reload();
   if(kind==='select'){selected=wishes.find(wish=>wish.id===id)||null;render();return;}
   if(kind==='charter')return charterForm(selected);
   if(kind==='review')return reviewForm(selected);
   if(kind==='resolve-block')return resolveBlockerForm(selected,stage);
   if(kind==='launch'){
    if(!await confirmDialog({title:'让 Eve 连续推进研究',message:'Eve 会沿当前依赖继续执行，真实读取、计算并登记证据；遇到阻塞、审批或人工复核时停止。',confirmText:'开始'}))return;
    target.disabled=true;
    try{
     const result=await request(`/wishes/${encodeURIComponent(id)}/launch`,'POST',{stage,advance:true});
     setPref('activeConversationId',result.session_id);
     toastSuccess('任务已交给 Eve，可在对话中跟进');
     navigate('workbench');
    }finally{target.disabled=false;}
   }
  }catch(error){toastError(error.message);target.disabled=false;}
 },{signal:controller.signal});
 await reload();
 return {destroy(){disposed=true;clearTimeout(timer);controller.abort();}};
}
