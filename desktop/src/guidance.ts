import type {Store} from './harness/store.js';
import {ConflictError,ValidationError,type Json} from './harness/types.js';

export interface Guidance {id:string;version:number;content:string;quote:string;status:string;createdAt:number}
const active=(store:Store,taskId:string)=>{const task=store.getTask(taskId);if(!task||['completed','failed','cancelled'].includes(task.status))throw new ConflictError('Task has ended; send a new task instead');};
export function listGuidance(store:Store,taskId:string):Guidance[]{
 if(!store.getTask(taskId))throw new ValidationError('Task not found');
 return store.listRecords('task.guidance',{projectId:taskId,order:'asc',limit:100}).map(row=>({...(row.data as unknown as Guidance),id:row.id,version:row.version,createdAt:row.createdAt}));
}
export function changeGuidance(store:Store,taskId:string,input:Record<string,Json>):Guidance[] {
 const content=String(input.content??'').trim(),quote=String(input.quote??'').trim();
 if(content.length>5000||quote.length>2000)throw new ValidationError('Guidance is limited to 5000 characters and a 2000-character quotation');
 const items=listGuidance(store,taskId);
 const id=typeof input.messageId==='string'?input.messageId:null;
 if(!id){
  if(!['candidate','send'].includes(String(input.action)))throw new ValidationError('Invalid guidance action');
  active(store,taskId);if(!content)throw new ValidationError('Guidance is empty');
  if(items.length>=50)throw new ValidationError('Guidance queue limit reached');
  store.putRecord('task.guidance',{content,quote,status:input.action==='candidate'?'candidate':'queued'},{projectId:taskId});
 }else{
  const item=items.find(x=>x.id===id);if(!item)throw new ValidationError('Guidance not found in this task');
  if(item.status==='included')throw new ConflictError('Guidance is already in model context and cannot be withdrawn');
  if(input.expectedVersion!==item.version)throw new ConflictError('Guidance changed; refresh before editing');
  if(input.action==='delete')store.deleteRecord(id,item.version);
  else{
   if(input.action==='send')active(store,taskId);
   if(!['send','edit','withdraw'].includes(String(input.action)))throw new ValidationError('Invalid guidance action');
   if(input.action==='edit'&&!content)throw new ValidationError('Guidance is empty');
   const original=store.getRecord(id)!;
   store.putRecord('task.guidance',{...(original.data as Record<string,Json>),...(input.action==='edit'?{content,quote:input.quote===undefined?item.quote:quote}:{}),status:input.action==='send'?'queued':'candidate'},{id,expectedVersion:item.version,projectId:taskId});
  }
 }
 return listGuidance(store,taskId);
}
/** Atomic synchronous boundary: edits/withdrawals cannot race context inclusion. */
export function takeGuidance(store:Store,taskId:string):Guidance[]{
 const queued=listGuidance(store,taskId).filter(x=>x.status==='queued').slice(0,3);
 for(const item of queued){const row=store.getRecord(item.id)!;store.putRecord('task.guidance',{...(row.data as Record<string,Json>),status:'included'},{id:item.id,expectedVersion:item.version,projectId:taskId});}
 return queued;
}
