import {icon} from './icons.js?v=1.0.0';
import {api,errorMessage} from './api.js?v=1.0.0';
import {esc,escAttr} from './util.js?v=1.0.0';
import {getState,setState} from './store.js?v=1.0.0';
import {getPref,setPref,relTime} from './util.js?v=1.0.0';
import {on} from './bus.js?v=1.0.0';
import {promptDialog,confirmDialog,toastError} from './ui.js?v=1.0.0';
import {mountProjectFiles} from './project-files.js?v=1.0.0';
import {artifactConfig} from './artifact-config.js?v=1.0.0';

export const conversationFlag = (conversation, key) => Boolean(conversation[key] ?? conversation.meta?.[key]);

export function workspaceSidebarHtml(){return `
 <div class="chat-brand">Eve<span class="brand-chevron">⌄</span></div>
 <div class="chat-sidebar-head"><button type="button" class="btn btn-primary btn-block" id="new-conv">${icon('edit',{size:17})}<span>新聊天</span></button>
 <div class="conv-search">${icon('search',{size:14})}<input type="search" id="conv-filter" placeholder="搜索会话" aria-label="搜索会话"/></div></div>
 <section class="project-files" aria-label="项目文件"><div class="sidebar-section-label"><span>项目文件</span><div class="project-tools"><button type="button" class="icon-btn" id="project-search" aria-label="检索项目文件">${icon('search',{size:13})}</button><button type="button" class="icon-btn" id="project-git" aria-label="Git 状态与历史">${icon('gitBranch',{size:13})}</button><button type="button" class="icon-btn" id="project-refresh" aria-label="刷新项目文件">${icon('refresh',{size:13})}</button></div></div><select id="project-workspace" aria-label="当前项目工作区"></select><div id="project-file-tree" class="project-file-tree"></div></section>
 ${conversationControlsHtml()}<div class="conv-list" id="conv-list"></div>
 <div class="chat-sidebar-foot"><a href="#/workbench">工作台</a><a href="#/research">科研</a><a href="#/extensions">技能</a><a href="#/ssh">SSH</a><a href="#/tasks2">任务</a><a href="#/context">上下文</a><a href="#/evolution">自我改进</a><a href="#/settings">设置</a></div>
 <div class="sidebar-actions sidebar-utilities"><button type="button" class="icon-btn" id="theme-toggle" aria-label="切换主题">${icon('sun',{size:16})}</button><button type="button" class="icon-btn" id="palette-open" aria-label="打开命令面板">${icon('command',{size:16})}</button></div>`;}

export function conversationControlsHtml(){return `<div class="sidebar-section-label"><span>会话</span><span id="sidebar-conv-count"></span></div><div class="sidebar-conv-tools"><select id="conv-view" aria-label="会话视图"><option value="recent">最近</option><option value="archived">已归档</option><option value="all">全部</option></select><label title="只显示当前工作区"><input id="conv-workspace-only" type="checkbox"/>当前项目</label></div>`;}

export function conversationListHtml(conversations,{query='',view='recent',workspaceOnly=false,activeId='',limit=artifactConfig.sidebar.pageSize}={}){
 const workspaceId=getState().workspaceId||'ws_main';
 const items=conversations.filter(c=>(view==='all'||conversationFlag(c,'archived')===(view==='archived'))&&(!workspaceOnly||(c.workspace_id||c.meta?.workspace_id||'ws_main')===workspaceId)&&(!query||String(c.title||'').toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>Number(conversationFlag(b,'pinned'))-Number(conversationFlag(a,'pinned'))||Number(b.updated_at||0)-Number(a.updated_at||0));
 let group='';
 return (items.slice(0,limit).map(conv=>{
  const pinned=conversationFlag(conv,'pinned'),archived=conversationFlag(conv,'archived');
  const age=(Date.now()/1000-Number(conv.updated_at||0))/86400;
  const label=pinned?'置顶':age<1?'今天':age<7?'本周':'更早';
  const heading=label!==group?`<div class="conv-group">${label}</div>`:'';group=label;
  return heading+`<div class="conv-item${conv.id===activeId?' is-active':''}" data-id="${escAttr(conv.id)}" role="button" tabindex="0"><div class="conv-main"><div class="conv-title" title="${escAttr(conv.title||'新聊天')}">${esc(conv.title||'新聊天')}</div><div class="conv-meta">${esc(relTime(conv.updated_at))}${archived?' · 已归档':''}</div></div><div class="conv-actions"><button class="icon-btn conv-pin" data-id="${escAttr(conv.id)}" aria-label="${pinned?'取消置顶':'置顶会话'}" title="${pinned?'取消置顶':'置顶'}">${icon('bookmark',{size:13})}</button><button class="icon-btn conv-archive" data-id="${escAttr(conv.id)}" aria-label="${archived?'恢复会话':'归档会话'}" title="${archived?'恢复会话':'归档'}">${icon(archived?'refresh':'folder',{size:13})}</button><button class="icon-btn conv-rename" data-id="${escAttr(conv.id)}" aria-label="重命名会话" title="重命名">${icon('pencil',{size:13})}</button>${archived?`<button class="icon-btn conv-delete" data-id="${escAttr(conv.id)}" aria-label="删除会话" title="删除">${icon('trash',{size:13})}</button>`:''}</div></div>`;
 }).join('')||'<div class="conv-empty">没有会话</div>')+(items.length>limit?'<button class="btn btn-ghost btn-sm" data-conv-more>显示更多</button>':'');
}

/** Non-chat routes share the same sidebar and persisted conversation metadata. */
export async function mountSidebarNavigation(root,open){
 const controller=new AbortController(),signal=controller.signal;
 let disposed=false,conversations=[],limit=artifactConfig.sidebar.pageSize,lastHtml='';
 const list=root.querySelector('#conv-list'),filter=root.querySelector('#conv-filter'),view=root.querySelector('#conv-view'),workspaceOnly=root.querySelector('#conv-workspace-only');
 view.value=getPref('conversationView','recent');workspaceOnly.checked=getPref('conversationWorkspaceOnly',false);
 function render(){if(!disposed){const html=conversationListHtml(conversations,{query:filter.value,view:view.value,workspaceOnly:workspaceOnly.checked,activeId:getState().activeConversationId,limit});if(html!==lastHtml){list.innerHTML=html;lastHtml=html;}}}
 try{const data=await api.conversations.list();conversations=data.conversations||[];render();}catch(error){list.textContent=errorMessage(error);}
 root.querySelector('#new-conv').addEventListener('click',()=>open({type:'new'}),{signal});
 filter.addEventListener('input',render,{signal});
 view.addEventListener('change',()=>{setPref('conversationView',view.value);render();},{signal});
 workspaceOnly.addEventListener('change',()=>{setPref('conversationWorkspaceOnly',workspaceOnly.checked);render();},{signal});
 list.addEventListener('click',async event=>{
  if(event.target.closest('[data-conv-more]')){limit+=artifactConfig.sidebar.pageSize;render();return;}
  const node=event.target.closest('[data-id]');if(!node)return;
  const conv=conversations.find(c=>c.id===node.dataset.id);if(!conv)return;
  const action=event.target.closest('.conv-archive,.conv-pin');
  if(action){action.disabled=true;try{
   const key=action.classList.contains('conv-pin')?'pinned':'archived';
   const record=await api.conversations.update(conv.id,{[key]:!conversationFlag(conv,key)});
   if(disposed)return;
   Object.assign(conv,record,{archived:conversationFlag(record,'archived'),pinned:conversationFlag(record,'pinned')});setState({conversations:[...conversations]});render();
  }catch(error){if(!disposed)toastError(errorMessage(error));}finally{action.disabled=false;}return;}
  if(event.target.closest('.conv-rename')){
   const title=await promptDialog({title:'重命名会话',label:'会话标题',value:conv.title||'',confirmText:'保存'});
   if(title?.trim())try{await api.conversations.update(conv.id,{title:title.trim()});conv.title=title.trim();setState({conversations:[...conversations]});render();}catch(error){toastError(errorMessage(error));}
   return;
  }
  if(event.target.closest('.conv-delete')){
   if(!await confirmDialog({title:'删除会话',message:'将删除此会话。归档可保留历史；删除前请确认不再需要。',confirmText:'删除',danger:true}))return;
   try{await api.conversations.remove(conv.id);conversations=conversations.filter(c=>c.id!==conv.id);setState({conversations:[...conversations]});render();}catch(error){toastError(errorMessage(error));}
   return;
  }
  open({type:'select',id:node.dataset.id});
 },{signal});
 list.addEventListener('keydown',event=>{if(event.target.closest('button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();const row=event.target.closest('[data-id]');if(row)open({type:'select',id:row.dataset.id});}},{signal});
 const off=on('state:change',patch=>{if(Array.isArray(patch?.conversations))conversations=patch.conversations;render();});
 const offWorkspace=on('workspace:change',render);
 const files=await mountProjectFiles(root,{busy:()=>false,changed:()=>open({type:'new'})});
 return ()=>{disposed=true;controller.abort();off();offWorkspace();files();};
}
