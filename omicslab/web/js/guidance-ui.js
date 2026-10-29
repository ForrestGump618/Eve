import {api,errorMessage} from './api.js?v=1.4.0';
import {esc,escAttr} from './util.js?v=1.4.0';
import {openModal,promptDialog,toastError,toastInfo} from './ui.js?v=1.4.0';

/** One task-bound candidate queue. Only explicit send reaches the model boundary. */
export function mountGuidance({root,context,clearInput,startTask}){
 const panel=root.querySelector('#guidance-queue'),input=root.querySelector('#chat-input');
 const controller=new AbortController(),signal=controller.signal;let timer=0,disposed=false,quote='',submitting=false;
 async function refresh(){
  const current=context();if(!current.runId||disposed)return;
  try{
   const data=await api.request(`/api/runs/${encodeURIComponent(current.runId)}/guidance`,{quiet:true});
   if(disposed||context().epoch!==current.epoch||context().runId!==current.runId)return;
   const items=data.items||[],pending=items.filter(x=>x.status!=='included');
   panel.innerHTML=items.length?`<details class="guidance-list" ${pending.length?'open':''}><summary>引导与批注 · ${pending.length} 项待处理</summary>${items.map(item=>`<div class="guidance-item" data-guidance-id="${escAttr(item.id)}" data-version="${item.version}"><div class="guidance-content">${item.quote?`<blockquote>${esc(item.quote)}</blockquote>`:''}<span>${esc(item.content)}</span></div><div class="guidance-actions"><span>${item.status==='included'?'已加入模型上下文':item.status==='queued'?'等待执行边界':'候选'}</span>${item.status!=='included'?`<button type="button" data-guidance-action="send">${current.running?'发送':'作为新任务发送'}</button><button type="button" data-guidance-action="edit">修改</button><button type="button" data-guidance-action="${item.status==='queued'?'withdraw':'delete'}">${item.status==='queued'?'撤回':'删除'}</button>`:''}</div></div>`).join('')}</details>`:'';
   clearTimeout(timer);if(current.running&&pending.some(x=>x.status==='queued'))timer=setTimeout(()=>{if(!document.hidden)void refresh();},1500);
  }catch{/* The task may still be acquiring its harness binding. */}
 }
 async function send(action,content,selectedQuote=''){
  if(submitting)return false;
  const fromComposer=content===undefined;content??=input.value;
  const current=context();if(!current.running||!current.runId){toastInfo('任务正在准备或已结束，请稍后发送或开始新任务');return false;}
  if(!String(content).trim())return false;
  submitting=true;try{
   await api.request(`/api/runs/${encodeURIComponent(current.runId)}/messages`,{method:'POST',body:{content,quote:selectedQuote,action}});
   if(context().epoch===current.epoch){if(fromComposer&&input.value===content)clearInput();await refresh();}return true;
  }catch(error){toastError(errorMessage(error));return false;}finally{submitting=false;}
 }
 root.querySelector('#guidance-queue-add').addEventListener('click',()=>void send('candidate'),{signal});
 const annotate=root.querySelector('#guidance-annotate');
 annotate.addEventListener('pointerdown',()=>{quote=window.getSelection()?.toString().slice(0,2000)||'';},{signal});
 annotate.addEventListener('click',()=>{
  const current=context(),selected=quote;
  const modal=openModal({title:'批注反馈',html:`${selected?`<blockquote class="guidance-quote">${esc(selected)}</blockquote>`:'<p>可以先选中输出文字，再添加批注。</p>'}<textarea id="guidance-feedback" rows="4" placeholder="补充要求或反馈…"></textarea>`,actions:[{label:'取消',kind:'ghost'},{label:'加入候选',kind:'ghost',onClick:async()=>current.epoch===context().epoch&&await send('candidate',modal.body.querySelector('textarea').value,selected)},{label:'立即发送',kind:'primary',onClick:async()=>current.epoch===context().epoch&&await send('send',modal.body.querySelector('textarea').value,selected)}]});
 },{signal});
 panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-guidance-action]'),item=button?.closest('[data-guidance-id]');if(!item)return;
  const current=context(),action=button.dataset.guidanceAction,body={action,expectedVersion:Number(item.dataset.version)};
  if(action==='edit'){const content=await promptDialog({title:'修改候选引导',value:item.querySelector('.guidance-content>span').textContent,multiline:true});if(content===null)return;body.content=content;}
  if(current.epoch!==context().epoch)return;button.disabled=true;
  if(action==='send'&&!current.running){
   const content=item.querySelector('.guidance-content>span').textContent,quoted=item.querySelector('blockquote')?.textContent||'';
   try{await api.request(`/api/runs/${encodeURIComponent(current.runId)}/guidance/${encodeURIComponent(item.dataset.guidanceId)}`,{method:'PATCH',body:{action:'delete',expectedVersion:body.expectedVersion}});if(context().epoch===current.epoch)startTask(content+(quoted?'\n批注引用：\n'+JSON.stringify(quoted):''));}catch(error){toastError(errorMessage(error));}return;
  }
  try{await api.request(`/api/runs/${encodeURIComponent(current.runId)}/guidance/${encodeURIComponent(item.dataset.guidanceId)}`,{method:'PATCH',body});}catch(error){toastError(errorMessage(error));}finally{await refresh();}
 },{signal});
 return {refresh,send,clear(){clearTimeout(timer);panel.innerHTML='';},dispose(){disposed=true;clearTimeout(timer);controller.abort();}};
}
