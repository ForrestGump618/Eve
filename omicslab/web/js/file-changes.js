import {api,errorMessage} from './api.js?v=1.0.0';
import {esc,escAttr} from './util.js?v=1.0.0';
import {openModal,confirmDialog,toastError,toastSuccess} from './ui.js?v=1.0.0';
import {getState} from './store.js?v=1.0.0';
import {openWorkspaceEditor} from './workspace-editor.js?v=1.0.0';
import {emit} from './bus.js?v=1.0.0';

export function mountFileChanges(root,context){
 const host=document.createElement('details');host.className='eve-file-changes';host.hidden=true;
 host.innerHTML='<summary><span>文件变更</span><span data-change-count></span></summary><div data-change-items></div>';
 root.querySelector('.composer')?.prepend(host);
 let rows=[],disposed=false,epoch=0,loadedIdentity=null;
 async function refresh(){
  const identity=context(),ticket=++epoch;
  host.hidden=true;rows=[];loadedIdentity=null;
  if(!identity.sessionId){host.hidden=true;return;}
  try{
   const data=await api.request(`/api/platform/file-changes?scope=${encodeURIComponent(identity.workspaceId)}&session_id=${encodeURIComponent(identity.sessionId)}`);
   if(disposed||ticket!==epoch)return;
   rows=data.items||[];loadedIdentity=identity;host.hidden=!rows.length;
   host.querySelector('[data-change-count]').textContent=`${rows.length} 项`;
   host.querySelector('[data-change-items]').innerHTML=rows.map(r=>`<button type="button" class="eve-change-row" data-change="${escAttr(r.id)}"><span>${esc(r.path)}</span><span class="eve-change-added">+${r.added}</span><span class="eve-change-deleted">−${r.deleted}</span><small>${r.reverted?'已撤销':r.created?'新增':'已校验'}</small></button>`).join('');
  }catch(error){if(!disposed)toastError(errorMessage(error));}
 }
 host.onclick=event=>{
  const row=rows.find(r=>r.id===event.target.closest('[data-change]')?.dataset.change);if(!row)return;
  const identity=context(),workspace=getState().workspace;
  if(!loadedIdentity||identity.workspaceId!==loadedIdentity.workspaceId||identity.sessionId!==loadedIdentity.sessionId||workspace?.workspace_id!==identity.workspaceId)return;
  openModal({title:row.path,size:'xl',html:`<div class="eve-diff">${row.diff.split('\n').map(line=>`<div class="${line.startsWith('+')?'is-added':line.startsWith('-')?'is-deleted':''}">${esc(line)||' '}</div>`).join('')}</div>${row.diffTruncated?'<p class="sw-muted">差异预览已截断，请打开文件查看。</p>':''}`,actions:[
   {label:'关闭',kind:'ghost'},
   {label:'打开文件',onClick:async()=>{await openWorkspaceEditor(workspace,row.path);return false;}},
   ...(!row.reverted&&!row.created?[{label:'撤销此改动',kind:'ghost',onClick:async()=>{
    const yes=await confirmDialog({title:'撤销文件改动',message:`恢复 ${row.path} 的这次改动？文件存在后续修改时会拒绝覆盖。`,confirmText:'撤销改动'});
    if(!yes)return false;
    try{
     await api.request(`/api/platform/file-changes/${encodeURIComponent(row.id)}/restore?scope=${encodeURIComponent(identity.workspaceId)}`,{method:'POST',body:{}});
     emit('workspace:files-changed',{workspaceId:identity.workspaceId,path:row.path});toastSuccess('已撤销并校验');await refresh();return true;
    }catch(error){toastError(errorMessage(error));return false;}
   }}]:[])]});
 };
 return {refresh,destroy(){disposed=true;epoch++;host.remove();}};
}
