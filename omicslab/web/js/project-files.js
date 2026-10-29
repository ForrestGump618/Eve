import {api,errorMessage} from './api.js?v=1.2.0';
import {getState,setWorkspace,navigate} from './store.js?v=1.2.0';
import {on} from './bus.js?v=1.2.0';
import {esc,escAttr} from './util.js?v=1.2.0';
import {icon} from './icons.js?v=1.2.0';
import {openModal,toastError,toastInfo} from './ui.js?v=1.2.0';
import {openWorkspaceEditor,openWorkspaceSearch,openWorkspaceGit} from './workspace-editor.js?v=1.2.0';
import {openHtmlArtifact} from './artifact-viewer.js?v=1.2.0';

/** Lazy, bounded file tree. No polling, recursive preload or cross-workspace cache. */
export async function mountProjectFiles(root,{busy,changed}){
 const tree=root.querySelector('#project-file-tree'),select=root.querySelector('#project-workspace');
 if(!tree||!select)return ()=>{};
 let disposed=false,epoch=0;
 async function listing(path,target,level=0){
  const version=epoch,id=getState().workspaceId;
  if(!id)return;
  target.textContent='正在读取…';
  try{
   const data=await api.workspaces.files.tree(id,path);
   if(disposed||version!==epoch||!target.isConnected)return;
   const entries=data.entries||data.tree?.entries||[];
   target.innerHTML=entries.slice(0,200).map(e=>`<div class="project-entry"><button type="button" class="project-file" data-path="${escAttr(e.path||e.rel||[path==='.'?'':path,e.name].filter(Boolean).join('/'))}" data-directory="${e.is_dir?'true':'false'}" style="--file-depth:${level}">${icon(e.is_dir?'folder':'file',{size:14})}<span>${esc(e.name)}</span></button></div>`).join('')||'<span class="project-empty">此目录为空</span>';
   if(entries.length>200)target.insertAdjacentHTML('beforeend','<span class="project-empty">仅显示前 200 项，可在文件浏览器中查看</span>');
  }catch(error){if(!disposed&&version===epoch)target.textContent=`无法读取目录：${errorMessage(error)}`;}
 }
 async function refresh(){
  const version=++epoch;
  try{
   const data=await api.workspaces.list();
   if(disposed||version!==epoch)return;
   const list=data.workspaces||[];
   if(!getState().workspaceId&&data.default_id){const workspace=list.find(w=>w.workspace_id===data.default_id);if(workspace)setWorkspace(workspace);}
   select.innerHTML=list.map(w=>`<option value="${escAttr(w.workspace_id)}">${esc(w.name)}${w.backend==='ssh'?' · SSH':''}</option>`).join('');
   select.value=getState().workspaceId;
   select.title=(()=>{const w=getState().workspace;return w?.backend==='ssh'?`SSH · ${w.remote?.root||''}`:w?.local_path||'';})();
   await listing('.',tree);
  }catch(error){if(!disposed)tree.textContent=errorMessage(error);}
 }
 async function change(){
  const id=select.value;
  select.disabled=true;
  try{
   const data=await api.workspaces.get(id),workspace=data.workspace||data;
   const probe=await api.workspaces.probe(id);
   if(probe.ok===false)throw Error(probe.error||'工作区不可访问');
   if(disposed)return;
   setWorkspace(workspace);await changed(workspace);
  }catch(error){toastError(errorMessage(error));select.value=getState().workspaceId;}
  finally{if(!disposed)select.disabled=false;}
 }
 async function click(event){
  const button=event.target.closest('.project-file');if(!button)return;
  const path=button.dataset.path;
  if(button.dataset.directory==='true'){
   const existing=button.parentElement.querySelector('.project-children');
   if(existing){existing.remove();button.setAttribute('aria-expanded','false');return;}
   const children=document.createElement('div');children.className='project-children';button.after(children);button.setAttribute('aria-expanded','true');
   await listing(path,children,Math.min(10,Number(button.style.getPropertyValue('--file-depth'))+1));
  }else{
   const id=getState().workspaceId,version=epoch;
   try{if(disposed||version!==epoch)return;if(/\.html?$/i.test(path))await openHtmlArtifact(id,path,path.split('/').at(-1));else await openWorkspaceEditor({...getState().workspace,workspace_id:id},path);}catch(error){toastError(errorMessage(error));}
  }
 }
 select.addEventListener('change',change);tree.addEventListener('click',click);
 const off=on('workspace:change',()=>{void refresh();});
 const offFiles=on('workspace:files-changed',event=>{if(event.workspaceId===getState().workspaceId)void listing('.',tree);});
 const search=()=>openWorkspaceSearch(getState().workspace).catch(error=>toastError(errorMessage(error)));
 const git=()=>openWorkspaceGit(getState().workspace).catch(error=>toastError(errorMessage(error)));
 root.querySelector('#project-search')?.addEventListener('click',search);
 root.querySelector('#project-git')?.addEventListener('click',git);
 root.querySelector('#project-refresh')?.addEventListener('click',refresh);
 await refresh();
 return ()=>{disposed=true;epoch++;off();offFiles();select.removeEventListener('change',change);tree.removeEventListener('click',click);root.querySelector('#project-refresh')?.removeEventListener('click',refresh);root.querySelector('#project-search')?.removeEventListener('click',search);root.querySelector('#project-git')?.removeEventListener('click',git);};
}
