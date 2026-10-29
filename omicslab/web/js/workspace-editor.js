import {api,errorMessage} from './api.js?v=1.4.0';
import {esc,escAttr} from './util.js?v=1.4.0';
import {openModal,toastError,toastSuccess} from './ui.js?v=1.4.0';
import {getState} from './store.js?v=1.4.0';
import {emit} from './bus.js?v=1.4.0';

// Small dirty buffers survive dialog dismissal/route changes; never evict edits.
const drafts=new Map();
export async function openWorkspaceEditor(workspace,path){
 if(!workspace?.workspace_id)throw new Error('请先选择工作区');
 const id=workspace.workspace_id,key=JSON.stringify([id,workspace.resolved_path,path]);
 const old=drafts.get(key);
 if(!old&&drafts.size>=12)throw new Error('已有 12 份未保存草稿，请先保存或放弃部分草稿');
 const data=await api.request(`/api/workspaces/${encodeURIComponent(id)}/sidebar/editor?path=${encodeURIComponent(path)}`);
 const content=old?.content??data.content;
 const readonly=data.truncated||data.binary;
 const modal=openModal({title:`${workspace.name||id} · ${path}`,size:'xl',html:`<div class="workspace-editor"><div class="eve-card-heading"><span class="eve-detail-note">${readonly?'文件较大或非完整文本，仅预览；请使用文件工具分段读取。':old?'已恢复本次打开中的未保存草稿':''}</span><button class="btn btn-sm" data-editor-reference>引用到对话</button></div><textarea class="workspace-editor-text" aria-label="文件内容" spellcheck="false" ${readonly?'readonly':''}>${esc(content||'')}</textarea><div class="eve-detail-note" data-editor-state>${old?'未保存':''}</div></div>`,actions:[
  {label:'关闭',kind:'ghost'},
  ...(readonly?[]:[{label:'放弃草稿',kind:'ghost',onClick:()=>drafts.delete(key)},
  {label:'保存',kind:'primary',onClick:async({body})=>{
   const text=body.querySelector('textarea').value;
   const saved=await api.request(`/api/workspaces/${encodeURIComponent(id)}/sidebar/editor`,{method:'POST',body:{path,content:text,expectedSha256:old?.sha256||data.sha256}});
   if(!saved.verified)throw new Error('写入后尚未校验，不能确认保存成功');
   drafts.delete(key);toastSuccess('已保存并校验');emit('workspace:files-changed',{workspaceId:id,path});
  }}]),
 ]});
 const textarea=modal.body.querySelector('textarea'),state=modal.body.querySelector('[data-editor-state]');
 textarea.oninput=()=>{
  if(textarea.value===data.content){drafts.delete(key);state.textContent='';}
  else{drafts.set(key,{content:textarea.value,sha256:old?.sha256||data.sha256});state.textContent='未保存 · 关闭后保留本次打开中的草稿';}
 };
 modal.body.querySelector('[data-editor-reference]').onclick=()=>{
  if(getState().workspaceId!==id){toastError('请先切回此文件所属工作区再引用');return;}
  const input=document.querySelector('#chat-input');
  if(!input){toastError('请在工作台打开对话后引用');return;}
  input.value+=(input.value?'\n':'')+`文件：${path}`;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();modal.close();
 };
}

export async function openWorkspaceSearch(workspace){
 if(!workspace?.workspace_id)throw new Error('请先选择工作区');
 const id=workspace.workspace_id;
 const modal=openModal({title:`${workspace.name||id} · 文件检索`,size:'lg',html:'<form class="workspace-search"><input class="input" aria-label="文件内容检索" placeholder="在项目文件中查找文本"/><button class="btn btn-sm">查找</button></form><div class="workspace-search-results"></div>'});
 let epoch=0;
 modal.body.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const current=++epoch,query=modal.body.querySelector('input').value.trim();if(!query)return;
  const box=modal.body.querySelector('.workspace-search-results');box.textContent='正在查找…';
  try{
   const result=await api.request(`/api/workspaces/${encodeURIComponent(id)}/sidebar/files?query=${encodeURIComponent(query)}`);
   if(current!==epoch||!modal.el.isConnected)return;
   box.innerHTML=(result.matches||[]).map(m=>`<button class="context-source" data-search-file="${escAttr(m.path)}"><strong>${esc(m.path)}:${m.line}</strong><pre>${esc(m.text)}</pre></button>`).join('')||'<p class="eve-muted">没有匹配项</p>';
   box.insertAdjacentHTML('beforeend',`<p class="eve-detail-note">已检查 ${result.visited} 项${result.limited?'，达到扫描上限，可缩小目录范围':''}</p>`);
  }catch(error){if(current===epoch)box.textContent=errorMessage(error);}
 };
 modal.body.onclick=event=>{const row=event.target.closest('[data-search-file]');if(row)void openWorkspaceEditor(workspace,row.dataset.searchFile).catch(error=>toastError(errorMessage(error)));};
}

export async function openWorkspaceGit(workspace){
 if(!workspace?.workspace_id)throw new Error('请先选择工作区');
 const endpoint=`/api/workspaces/${encodeURIComponent(workspace.workspace_id)}/sidebar/git`;
 const modal=openModal({title:`${workspace.name||workspace.workspace_id} · Git`,size:'xl',html:'<div class="workspace-git"><div class="eve-card-heading"><h4>工作区状态</h4><button class="btn btn-sm" data-git-refresh>刷新</button></div><p class="eve-detail-note" role="status" data-git-state>正在读取…</p><div data-git-files></div><form data-git-form hidden><h4>暂存差异</h4><p class="eve-detail-note" data-git-paths></p><pre class="context-original" data-git-diff></pre><label>提交说明<textarea class="input" name="message" rows="2" required aria-label="提交说明"></textarea></label><label class="eve-detail-note"><input type="checkbox" name="confirmed" required>我已检查以上完整暂存差异，确认提交这些文件</label><button class="btn btn-sm btn-primary" type="submit">提交已暂存更改</button><p class="eve-detail-note">仅提交已暂存内容，不会自动添加其他文件。提交不运行 Git hooks，也不签名。</p></form><details><summary>分支与提交历史</summary><div data-git-history></div></details><div data-git-detail></div></div>'});
 let data=null,busy=false,message='';
 const el=selector=>modal.body.querySelector(selector);
 function state(text){el('[data-git-state]').textContent=text;}
 function render(){
  if(!modal.el.isConnected)return;
  el('[data-git-files]').innerHTML=data.entries.map((entry,index)=>`<div class="eve-card-heading"><span><code>${esc(entry.index+entry.worktree)}</code> ${esc(entry.path)}${entry.blocked?' · 敏感路径，禁止操作':''}</span><span>${entry.worktree!==' '&&!entry.blocked?`<button class="btn btn-sm" data-git-stage="${index}">暂存</button>`:''}${entry.index!==' '&&entry.index!=='?'&&!entry.blocked?`<button class="btn btn-sm" data-git-unstage="${index}">取消暂存</button>`:''}</span></div>`).join('')||'<p class="eve-muted">工作区干净</p>';
  el('[data-git-form]').hidden=false;
  el('[data-git-paths]').textContent=data.staged_paths.length?`已暂存：${data.staged_paths.join('、')}`:'尚无暂存文件';
  el('[data-git-diff]').textContent=data.reviewable?(data.staged_diff||'无暂存差异'):'暂存区包含敏感路径，无法预览或提交。请先在 Git 工具中处理。';
  el('[name=message]').value=message;
  el('[name=message]').maxLength=data.message_bytes;
  el('[name=confirmed]').checked=false;
 }
 function controls(){
  modal.body.querySelectorAll('button,input,textarea').forEach(node=>{node.disabled=busy;});
  if(!busy){
   modal.body.querySelectorAll('[data-git-stage],[data-git-unstage]').forEach(node=>{node.disabled=!data?.can_write;});
   el('[type=submit]').disabled=!data?.can_write||!data?.reviewable||!data?.staged_paths.length;
  }
 }
 async function history(){
  try{
   const result=await api.request(endpoint,{timeout:data.request_timeout_ms,quiet:true});
   if(!modal.el.isConnected)return;
   el('[data-git-history]').innerHTML=`<pre>${esc(result.branches)}</pre>${result.graph.split('\n').map(line=>{
    const commit=line.match(/(?:^|[\s*|\\/])([a-f0-9]{7,40})(?:\s|$)/)?.[1];
    return commit?`<button class="workspace-git-row" data-git-commit="${commit}">${esc(line)}</button>`:`<pre>${esc(line)}</pre>`;
   }).join('')}<p class="eve-detail-note">最近 ${result.history_limit} 条；点击提交查看详情。</p>`;
  }catch(error){if(modal.el.isConnected)el('[data-git-history]').textContent=data?.head?errorMessage(error):'尚无提交历史';}
 }
 async function refresh(){
  if(busy)return;busy=true;controls();state('正在刷新…');
  try{
   message=el('[name=message]').value;
   data=await api.request(`${endpoint}/review`);render();
   state(data.can_write?'点击文件旁的按钮暂存或取消暂存；提交前检查差异。':'当前工作区只允许查看 Git。');
   await history();
  }catch(error){data=null;state(errorMessage(error));}
  finally{busy=false;controls();}
 }
 async function mutate(action,path){
  if(busy||!data)return;
  const reviewed=data;message=el('[name=message]').value;
  const confirmed=action!=='commit'||el('[name=confirmed]').checked;
  if(!confirmed){state('请先检查暂存差异并勾选确认');return;}
  busy=true;controls();state(action==='commit'?'正在提交并核验…':'正在更新暂存区…');
  try{
   const result=await api.request(`${endpoint}/${action}`,{method:'POST',timeout:reviewed.request_timeout_ms,body:{path,message,confirmed,digest:reviewed.digest,index_digest:reviewed.index_digest}});
   if(!result.verified)throw new Error('Git 操作尚未通过读取核验，请刷新状态');
   if(!modal.el.isConnected)return;
   data=result;if(action==='commit')message='';render();
   state(result.commit?`已提交并核验：${result.commit}；文件：${result.committed_paths.join('、')}`:`已核验暂存区：${result.staged_paths.join('、')||'空'}`);
   if(result.commit){toastSuccess(`已提交 ${result.commit}`);await history();}
  }catch(error){data=null;el('[name=confirmed]').checked=false;state(`${errorMessage(error)}；请刷新并重新检查差异后再操作。`);}
  finally{busy=false;controls();}
 }
 modal.body.onclick=async event=>{
  if(busy)return;
  if(event.target.closest('[data-git-refresh]')){await refresh();return;}
  const stage=event.target.closest('[data-git-stage]'),unstage=event.target.closest('[data-git-unstage]');
  if(stage||unstage){const index=Number(stage?.dataset.gitStage??unstage.dataset.gitUnstage);await mutate(stage?'stage':'unstage',data.entries[index].path);return;}
  const row=event.target.closest('[data-git-commit]');if(!row)return;
  row.disabled=true;
  try{const details=await api.request(`${endpoint}?commit=${row.dataset.gitCommit}`);if(modal.el.isConnected)el('[data-git-detail]').innerHTML=`<pre class="context-original">${esc(details.detail)}</pre>`;}catch(error){state(errorMessage(error));}finally{row.disabled=false;}
 };
 el('[data-git-form]').onsubmit=event=>{event.preventDefault();void mutate('commit');};
 await refresh();
}
