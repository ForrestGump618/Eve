import {api,errorMessage} from './api.js?v=2.1.1';
import {esc,escAttr} from './util.js?v=2.1.1';
import {openModal,toastError,toastSuccess} from './ui.js?v=2.1.1';
import {getState} from './store.js?v=2.1.1';
import {emit} from './bus.js?v=2.1.1';

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
 const modal=openModal({title:`${workspace.name||workspace.workspace_id} · Git`,size:'xl',html:'<div class="workspace-git">正在读取…</div>'});
 const data=await api.request(endpoint);if(!modal.el.isConnected)return;
 modal.body.innerHTML=`<div class="workspace-git"><h4>工作区状态</h4><pre>${esc(data.status||'工作区干净')}</pre><details><summary>分支</summary><pre>${esc(data.branches)}</pre></details><h4>提交图</h4><div>${data.graph.split('\n').map(line=>{
  const commit=line.match(/(?:^|[\s*|\\/])([a-f0-9]{7,40})(?:\s|$)/)?.[1];
  return commit?`<button class="workspace-git-row" data-git-commit="${commit}">${esc(line)}</button>`:`<pre>${esc(line)}</pre>`;
 }).join('')}</div><div data-git-detail></div><p class="eve-detail-note">只读历史，最近 ${data.history_limit} 条。分支查看不会切换目录或拉取远程。</p></div>`;
 modal.body.onclick=async event=>{const row=event.target.closest('[data-git-commit]');if(!row)return;row.disabled=true;
  try{const details=await api.request(`${endpoint}?commit=${row.dataset.gitCommit}`);if(modal.el.isConnected)modal.body.querySelector('[data-git-detail]').innerHTML=`<pre class="context-original">${esc(details.detail)}</pre>`;}catch(error){toastError(errorMessage(error));}finally{row.disabled=false;}
 };
}
