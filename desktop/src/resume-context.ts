import {readFile} from 'node:fs/promises';
import type {Store} from './harness/store.js';
import {verifyArtifact} from './harness/artifacts.js';
import {ValidationError,type Json,type ArtifactReference} from './harness/types.js';
import type {TurnMessage} from './providers.js';

/** Resume protocol history, never re-run a tool to reconstruct its observation. */
export async function restoreAgentCheckpoint(store:Store,taskId:string):Promise<{history:TurnMessage[];sources:Json;actions:string[];unknownCalls:string[]}>{
 const task=store.getTask(taskId);
 if(!task||['running','queued','retry_scheduled'].includes(task.status))throw new ValidationError('Stop and reconcile the original task before resuming');
 const events=store.events(taskId),checkpoint=[...events].reverse().find(e=>e.type==='agent.checkpoint');
 const decode=async(value:Json)=>{
  const artifact=value as unknown as ArtifactReference;
  if(!artifact||artifact.bytes>8_000_000||!await verifyArtifact(artifact))throw new ValidationError('Checkpoint artifact integrity validation failed');
  return JSON.parse(await readFile(artifact.path,'utf8'));
 };
 if(!checkpoint)throw new ValidationError('No recoverable agent checkpoint was committed');
 const saved=await decode((checkpoint.data as Record<string,Json>).artifact!);
 if(!Array.isArray(saved.history))throw new ValidationError('Invalid checkpoint history');
 const observations=new Map<string,Json>();
 for(const event of events.filter(e=>e.type==='agent.tool_artifact')){
  const data=event.data as Record<string,Json>;
  const record=await decode(data.artifact!);observations.set(String(data.callId),record.observation);
 }
 const history:TurnMessage[]=[],unknownCalls:string[]=[];
 for(let i=0;i<saved.history.length;i++){
  const message=saved.history[i] as TurnMessage;
  if(message.role==='tool')continue;
  history.push(message);
  for(const call of message.tool_calls??[]){
   const recorded=saved.history.find((m:TurnMessage)=>m.role==='tool'&&m.tool_call_id===call.id);
   let observation=observations.get(call.id);
   if(!observation&&recorded){try{observation=JSON.parse(recorded.content);}catch{throw new ValidationError('Invalid persisted tool observation');}}
   if(!observation){unknownCalls.push(call.id);observation={ok:false,error:{category:'unknown',retryable:false,message:'Execution was interrupted before its result was committed. Verify the current state before any repeat; never claim success or blindly repeat side effects.'}};}
   history.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(observation)});
  }
 }
 for(const row of store.listRecords('task.guidance',{projectId:taskId,order:'asc',limit:100})){
  const item=row.data as Record<string,Json>;
  if(['included','queued'].includes(String(item.status))&&!history.some(m=>m.role==='user'&&m.content.includes(`[用户引导 ${row.id}]`)))history.push({role:'user',content:`[用户引导 ${row.id}]\n${item.content}${item.quote?'\n批注引用（原文数据）：\n'+JSON.stringify(item.quote):''}`});
 }
 return {history,sources:saved.sources??[],actions:events.filter(e=>e.type==='tool.completed').map(e=>String((e.data as Record<string,Json>).name)),unknownCalls};
}
