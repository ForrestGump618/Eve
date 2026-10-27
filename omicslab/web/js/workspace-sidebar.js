import {icon} from './icons.js?v=2.1.1';
import {api,errorMessage} from './api.js?v=2.1.1';
import {esc,escAttr} from './util.js?v=2.1.1';
import {getState} from './store.js?v=2.1.1';
import {on} from './bus.js?v=2.1.1';
import {mountProjectFiles} from './project-files.js?v=2.1.1';

export function workspaceSidebarHtml(){return `
 <div class="chat-brand">Eve<span class="brand-chevron">⌄</span></div>
 <div class="chat-sidebar-head"><button type="button" class="btn btn-primary btn-block" id="new-conv">${icon('edit',{size:17})}<span>新聊天</span></button>
 <div class="conv-search">${icon('search',{size:14})}<input type="search" id="conv-filter" placeholder="搜索会话" aria-label="搜索会话"/></div></div>
 <section class="project-files" aria-label="项目文件"><div class="sidebar-section-label"><span>项目文件</span><button type="button" class="icon-btn" id="project-refresh" aria-label="刷新项目文件">${icon('refresh',{size:13})}</button></div><select id="project-workspace" aria-label="当前项目工作区"></select><div id="project-file-tree" class="project-file-tree"></div></section>
 <div class="sidebar-section-label">最近会话</div><div class="conv-list" id="conv-list"></div>
 <div class="chat-sidebar-foot"><a href="#/workbench">工作台</a><a href="#/research">科研</a><a href="#/extensions">技能</a><a href="#/ssh">SSH</a><a href="#/tasks2">任务</a><a href="#/settings">设置</a></div>
 <div class="sidebar-actions sidebar-utilities"><button type="button" class="icon-btn" id="theme-toggle" aria-label="切换主题">${icon('sun',{size:16})}</button><button type="button" class="icon-btn" id="palette-open" aria-label="打开命令面板">${icon('command',{size:16})}</button></div>`;}

/** Non-chat routes share the same live sidebar, never a second page shell. */
export async function mountSidebarNavigation(root,open){
 const controller=new AbortController(),signal=controller.signal;
 let disposed=false,conversations=[];
 const list=root.querySelector('#conv-list'),filter=root.querySelector('#conv-filter');
 function render(){
  if(disposed)return;
  const query=filter.value.toLowerCase();
  list.innerHTML=conversations.filter(c=>String(c.title||'').toLowerCase().includes(query)).slice(0,80).map(c=>`<button type="button" class="sidebar-recent${c.id===getState().activeConversationId?' is-active':''}" data-conversation="${escAttr(c.id)}">${esc(c.title||'新聊天')}</button>`).join('')||'<span class="project-empty">还没有会话</span>';
 }
 try{const data=await api.conversations.list();conversations=data.conversations||data.items||data||[];if(!Array.isArray(conversations))conversations=[];render();}catch(error){list.textContent=errorMessage(error);}
 root.querySelector('#new-conv').addEventListener('click',()=>open({type:'new'}),{signal});
 filter.addEventListener('input',render,{signal});
 list.addEventListener('click',event=>{const node=event.target.closest('[data-conversation]');if(node)open({type:'select',id:node.dataset.conversation});},{signal});
 const off=on('state:change',patch=>{if(Array.isArray(patch?.conversations)){conversations=patch.conversations;render();}});
 const files=await mountProjectFiles(root,{busy:()=>false,changed:()=>open({type:'new'})});
 return ()=>{disposed=true;controller.abort();off();files();};
}
