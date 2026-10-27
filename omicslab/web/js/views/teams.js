import {api,errorMessage} from '../api.js?v=2.1.1';
import {esc,escAttr} from '../util.js?v=2.1.1';
import {getState,navigate,setState} from '../store.js?v=2.1.1';
import {on,emit} from '../bus.js?v=2.1.1';
import {openModal,toastError,confirmDialog,promptDialog} from '../ui.js?v=2.1.1';
import {openRunDetail} from '../runview.js?v=2.1.1';

const labels={draft:'待批准方案',archived:'已归档',queued:'排队中',running:'运行中',succeeded:'已完成',failed:'失败',paused:'已暂停',interrupted:'待恢复',cancelled:'已取消',waiting_approval:'待批准',needs_review:'待复核'};
export async function mount(root){
 let disposed=false,timer=0,epoch=0,signature='',items=[],archived=false;
 const abort=new AbortController(),scope=()=>getState().workspaceId||'ws_main';
 root.innerHTML='<div class="eve-dashboard"><header class="eve-page-header"><h1>团队协作</h1><div><button class="btn btn-sm" id="teams-archive-view">已归档</button><button class="btn btn-sm" id="teams-refresh">刷新</button><button class="btn btn-primary btn-sm" id="team-create">新建团队</button></div></header><div id="team-list">正在读取…</div></div>';
 const list=root.querySelector('#team-list');
 async function load(){
  clearTimeout(timer);const requestScope=scope(),current=++epoch;
  try{
   const data=await api.request(`/api/teams?scope=${encodeURIComponent(requestScope)}&archived=${archived}`,{quiet:true,signal:abort.signal});
   if(disposed||current!==epoch||requestScope!==scope())return;
   items=data.items||[];const next=JSON.stringify(items);
   if(next!==signature){signature=next;render();}
   if(items.some(t=>['queued','running'].includes(t.status)))timer=setTimeout(()=>{if(!document.hidden)void load();else timer=setTimeout(load,5000);},3000);
  }catch(error){if(!disposed)list.textContent=errorMessage(error);}
 }
 function render(){
  list.innerHTML=items.map(team=>`<section class="eve-dashboard-card team-card" data-team="${escAttr(team.id)}"><div class="eve-card-heading"><h2>${esc(team.title)}</h2><span class="sw-badge">${esc(labels[team.status]||team.status)}</span><div>${(team.archived?['messages']:team.draft?['approve','archive']:['pause','resume','cancel','messages','archive']).map(action=>`<button class="btn btn-sm" data-team-action="${action}" data-id="${escAttr(team.id)}">${({approve:'批准并运行',pause:'暂停',resume:'恢复',cancel:'取消',messages:'团队信箱',archive:'归档'})[action]}</button>`).join('')}</div></div><div class="team-members">${team.members.map(member=>{
   const task=member.task||{},node=task.nodes?.work||{};
   return `<article class="team-member"><div class="eve-card-heading"><h3>${esc(member.name||member.id)}</h3><span class="sw-badge">${esc(labels[task.status]||task.status||(team.draft?'待批准':'任务缺失'))}</span></div><div class="team-member-model">${esc(member.provider||'默认供应商')} / ${esc(member.model||'默认模型')}</div><p>${esc(member.goal)}</p><div class="team-dependencies">${member.depends_on?.length?'等待：'+member.depends_on.map(esc).join('、'):'独立执行'}</div>${task.error?`<p class="team-error" role="alert">${esc(task.error)}</p>`:''}${task.result?`<details><summary>执行结果</summary><pre>${esc(task.result)}</pre></details>`:''}<div class="team-member-actions">${node.run_id?`<button class="btn btn-sm" data-run="${escAttr(node.run_id)}">轨迹</button>`:''}${node.session_id?`<button class="btn btn-sm" data-session="${escAttr(node.session_id)}">打开会话</button>`:''}${!team.draft&&!team.archived?`<button class="btn btn-sm" data-member-followup="${escAttr(member.id)}" data-team-id="${escAttr(team.id)}">分配后续任务</button>`:''}</div></article>`;
  }).join('')}</div><small class="eve-detail-note">成员使用独立会话，依赖节点只接收已提交结果；暂停与恢复由持久任务队列处理。</small></section>`).join('')||'<div class="eve-empty"><h2>还没有团队</h2><p>为独立问题分配成员，再设置汇总或复核依赖。</p></div>';
 }
 async function create(){
  try{
   const settings=await api.settings.get(),providers=Object.values(settings.providers||{}).filter(p=>p.configured&&p.id!=='mock');
   const active=settings.llm||{};let counter=0;
   const modal=openModal({title:'新建协作团队',size:'lg',html:'<label class="sw-field"><span>团队名称</span><input class="input" id="team-title" value="研究协作"/></label><div id="team-edit-members"></div><button class="btn btn-sm" id="team-add-member">添加成员</button><p class="eve-detail-note">依赖填成员 ID，以逗号分隔。无依赖的成员并行运行；每个成员独立选择模型和权限。保存方案后需要批准才会执行。</p>',actions:[{label:'取消',kind:'ghost'},{label:'保存方案',kind:'primary',onClick:async({body})=>{
    const members=[...body.querySelectorAll('[data-member]')].map(row=>({id:row.dataset.member,name:row.querySelector('[name="name"]').value,goal:row.querySelector('[name="goal"]').value,provider:row.querySelector('[name="provider"]').value,model:row.querySelector('[name="model"]').value,permission_mode:row.querySelector('[name="permission"]').value,depends_on:row.querySelector('[name="dependencies"]').value.split(/[,，\\s]+/).filter(Boolean)}));
    if(!members.length)throw new Error('请添加成员');
    await api.request(`/api/teams?scope=${encodeURIComponent(scope())}`,{method:'POST',body:{title:body.querySelector('#team-title').value,members,captain_session:getState().activeConversationId||undefined}});
    signature='';await load();
   }}]});
   const box=modal.body.querySelector('#team-edit-members');
   function add(){
    if(box.children.length>=8)return;
    const id='member'+(++counter),row=document.createElement('section');row.className='team-edit-member';row.dataset.member=id;
    row.innerHTML=`<div class="eve-card-heading"><strong>${id}</strong><button class="btn btn-sm" data-remove-member>移除</button></div><div class="sw-form-grid"><label class="sw-field"><span>成员名称</span><input class="input" name="name" value="成员 ${counter}"/></label><label class="sw-field"><span>依赖成员 ID</span><input class="input" name="dependencies" placeholder="member1, member2"/></label><label class="sw-field"><span>供应商</span><select class="input" name="provider"><option value="">默认供应商</option>${providers.map(p=>`<option value="${escAttr(p.id)}">${esc(p.label||p.id)}</option>`).join('')}</select></label><label class="sw-field"><span>模型</span><input class="input" name="model" placeholder="留空使用供应商默认模型"/></label><label class="sw-field"><span>权限</span><select name="permission"><option value="ask">请求批准</option><option value="review">帮我审核</option><option value="full">完全权限</option></select></label></div><label class="sw-field"><span>分配目标</span><textarea class="input" name="goal" rows="3" placeholder="明确要交付的结果、使用的资料和验证要求"></textarea></label>`;
    const provider=row.querySelector('[name="provider"]'),model=row.querySelector('[name="model"]');
    provider.value=active.provider||'';model.value=active.model||'';
    provider.onchange=()=>{const selected=providers.find(p=>p.id===provider.value);model.value=selected?.default_model||'';};
    row.querySelector('[data-remove-member]').onclick=()=>row.remove();box.append(row);
   }
   modal.body.querySelector('#team-add-member').onclick=add;add();add();
  }catch(error){toastError(errorMessage(error));}
 }
 root.addEventListener('click',async event=>{
  const action=event.target.closest('[data-team-action]'),run=event.target.closest('[data-run]'),session=event.target.closest('[data-session]');
  if(run){openRunDetail({runId:run.dataset.run});return;}
  if(session){setState({activeConversationId:session.dataset.session});navigate('workbench');setTimeout(()=>emit('chat:select',session.dataset.session),100);return;}
  const followup=event.target.closest('[data-member-followup]');
  if(followup){
   const goal=await promptDialog({title:'成员后续任务',label:'目标',confirmText:'分配任务'});if(!goal?.trim())return;
   const team=items.find(t=>t.id===followup.dataset.teamId),member=team.members.find(m=>m.id===followup.dataset.memberFollowup);
   let confirmed=false;
   if(!['succeeded','cancelled'].includes(member.task.status)){
    confirmed=await confirmDialog({title:'接管成员任务',message:'旧任务将先停止。请核对已经执行的外部操作；确认后在原成员会话中分配新目标。',confirmText:'已核对，接管'});if(!confirmed)return;
   }
   try{await api.request(`/api/teams/${encodeURIComponent(team.id)}/assign?scope=${encodeURIComponent(scope())}`,{method:'POST',body:{member_id:member.id,goal,confirmed}});await load();}catch(error){toastError(errorMessage(error));}return;
  }
  if(!action)return;action.disabled=true;
  try{
   if(action.dataset.teamAction==='messages'){await mailbox(items.find(t=>t.id===action.dataset.id));return;}
   let confirmed=false;
   if(action.dataset.teamAction==='resume'){
    confirmed=await confirmDialog({title:'恢复团队',message:'请先核对中断成员已执行的外部操作。已完成成员不会重放，失败成员会从已有会话继续。',confirmText:'已核对，继续'});
    if(!confirmed)return;
   }
   const result=await api.request(`/api/teams/${encodeURIComponent(action.dataset.id)}/${action.dataset.teamAction}?scope=${encodeURIComponent(scope())}`,{method:'POST',body:{confirmed}});
   if(result.errors?.length)toastError(result.errors.join('；'));await load();
  }catch(error){toastError(errorMessage(error));}finally{action.disabled=false;}
 },{signal:abort.signal});
 async function mailbox(team){
  const boundScope=scope();
  const result=await api.request(`/api/teams/${encodeURIComponent(team.id)}/messages?scope=${encodeURIComponent(boundScope)}`,{method:'POST',body:{}});
  const modal=openModal({title:`${team.title} · 信箱`,size:'lg',html:`<div class="team-mailbox">${result.items.slice().reverse().map(m=>`<article><strong>${esc(m.sender)} → ${esc(m.recipient)}</strong><p>${esc(m.content)}</p><small>${esc((m.deliveries||[]).map(d=>`${d.member}: ${d.status}`).join(' · ')||'已持久保存')}</small></article>`).join('')||'<p class="eve-muted">暂无消息</p>'}</div>${team.archived?'':`<label class="sw-field"><span>收件人</span><select class="input" id="team-message-recipient"><option value="all">所有成员</option>${team.members.map(m=>`<option value="${escAttr(m.id)}">${esc(m.name||m.id)}</option>`).join('')}</select></label><textarea class="input" id="team-message-content" rows="3" placeholder="反馈、证据或后续要求"></textarea><label class="sw-check"><input type="checkbox" id="team-message-wake"/>成员已完成时启动后续任务</label>`}`,actions:[{label:'关闭',kind:'ghost'},...(team.archived?[]:[{label:'发送',kind:'primary',onClick:async({body})=>{
   await api.request(`/api/teams/${encodeURIComponent(team.id)}/message?scope=${encodeURIComponent(boundScope)}`,{method:'POST',body:{recipient:body.querySelector('#team-message-recipient').value,content:body.querySelector('#team-message-content').value,wake:body.querySelector('#team-message-wake').checked}});await load();
  }}])]});
 }
 root.querySelector('#teams-archive-view').addEventListener('click',()=>{archived=!archived;signature='';root.querySelector('#teams-archive-view').textContent=archived?'活动团队':'已归档';void load();},{signal:abort.signal});
 root.querySelector('#team-create').addEventListener('click',create,{signal:abort.signal});
 root.querySelector('#teams-refresh').addEventListener('click',()=>load(),{signal:abort.signal});
 const off=on('workspace:change',()=>{signature='';void load();});
 await load();
 return {destroy(){disposed=true;epoch++;clearTimeout(timer);abort.abort();off();root.innerHTML='';}};
}
