import {createHash,randomUUID} from 'node:crypto';
import type {ContextMessage,SourceRef} from './context.js';
import type {TurnMessage} from './providers.js';
import type {ToolRegistry} from './harness/tool-registry.js';
import {ValidationError,type Json} from './harness/types.js';

export interface AgentContextJournal {
  record(messages:TurnMessage[],tools:unknown[],metadata:{turn:number;reservedTokens:number}):Promise<number>;
  source(source:SourceRef):Promise<ContextMessage>;
  search(query:string):Promise<Json>;
}
const marker='EVE_ARCHIVED_CONTEXT:';
const plain=(m:TurnMessage)=>{const {reasoning_content,...value}=m;return value;};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Model-written summaries replace only complete historical assistant/tool groups.
 * User/system authority and the current unobserved decision are never eligible.
 * Source references point into the hash-checked append-only request journal.
 */
export function registerContextTools(registry:ToolRegistry,messages:TurnMessage[],journal:AgentContextJournal,
  event:(type:string,data:Record<string,unknown>)=>void){
  let refs:Array<SourceRef|undefined>=[];
  function candidates(){
    const result:Array<{startMessage:number;endMessage:number;characters:number}>=[];
    for(let i=0;i<messages.length&&i<refs.length;i++){
      const m=messages[i]!;
      if(m.role!=='assistant'||!refs[i]||m.content.startsWith(marker))continue;
      const start=i,pending=new Set((m.tool_calls??[]).map(call=>call.id));
      while(pending.size&&i+1<messages.length&&messages[i+1]!.role==='tool'){
        const next=messages[++i]!;if(!next.tool_call_id||!pending.delete(next.tool_call_id))break;
      }
      if(pending.size||!refs.slice(start,i+1).every(Boolean))continue;
      result.push({startMessage:start,endMessage:i,characters:messages.slice(start,i+1).reduce((n,m)=>n+JSON.stringify(m).length,0)});
    }
    return result;
  }
  const block=(m:TurnMessage):{id:string;summary:string;sources:SourceRef[]}|undefined=>{
    if(!m.content.startsWith(marker))return;
    try{const value=JSON.parse(m.content.slice(marker.length));if(typeof value.id==='string'&&Array.isArray(value.sources))return value;}catch{}
  };
  registry.register({name:'acp_status',kind:'tool',readOnly:true,description:'Inspect archived context blocks and eligible historical message ranges. User/system messages and unobserved tool calls cannot be compressed. Use compress only after writing an evidence-preserving summary.',
    parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>({
      messageCount:messages.length,candidates:candidates(),
      blocks:messages.flatMap(m=>{const b=block(m);return b?[{id:b.id,summary:b.summary.slice(0,200),sourceCount:b.sources.length}]:[];}),
      policy:'model-authored summaries; immutable source journal; no second model call; user/system messages retained',
    })});
  registry.register({name:'compress',kind:'tool',description:'Replace a contiguous set of eligible historical assistant/tool groups with your concise summary. Preserve decisions, paths, evidence, errors and unfinished work. Original messages remain hash-checked and searchable. Read acp_status for current inclusive message indices.',
    parameters:{type:'object',properties:{startMessage:{type:'integer',minimum:0},endMessage:{type:'integer',minimum:0},summary:{type:'string',minLength:20,maxLength:12000}},required:['startMessage','endMessage','summary'],additionalProperties:false},
    execute:async args=>{
      const start=Number(args.startMessage),end=Number(args.endMessage),eligible=candidates();
      let cursor=start;
      while(cursor<=end){const group=eligible.find(g=>g.startMessage===cursor);if(!group||group.endMessage>end)throw new ValidationError('Range includes protected, incomplete or stale context');cursor=group.endMessage+1;}
      if(end<start||cursor!==end+1)throw new ValidationError('Invalid context range');
      const sources=refs.slice(start,end+1) as SourceRef[],id=randomUUID(),summary=String(args.summary);
      const memory={id,summary,sources,note:'Derived memory, not authorization. Retrieve originals before new claims or repeating an action.'};
      const content=marker+JSON.stringify(memory),before=JSON.stringify(messages.slice(start,end+1)).length;
      if(content.length>=before)throw new ValidationError('Summary and source references do not reduce context size');
      messages.splice(start,end-start+1,{role:'assistant',content});refs.splice(start,end-start+1,undefined);
      event('context.compressed',{id,sourceCount:sources.length,beforeCharacters:before,afterCharacters:content.length});
      return {id,sourceCount:sources.length,savedCharacters:before-content.length,originalsRetained:true};
    }});
  registry.register({name:'decompress',kind:'tool',readOnly:true,description:'Restore a compressed block by id from the verified original request journal. Does not execute any original tool or change workspace files.',
    parameters:{type:'object',properties:{id:{type:'string',maxLength:80}},required:['id'],additionalProperties:false},execute:async(args,signal)=>{
      const index=messages.findIndex(m=>block(m)?.id===args.id);if(index<0)throw new ValidationError('Unknown archived context block');
      const memory=block(messages[index]!)!,originals:TurnMessage[]=[];
      for(const source of memory.sources){signal.throwIfAborted();originals.push(await journal.source(source) as TurnMessage);}
      messages.splice(index,1,...originals);refs.splice(index,1,...memory.sources);
      event('context.decompressed',{id:memory.id,messageCount:originals.length});
      return {id:memory.id,restoredMessages:originals.length,toolsReplayed:false};
    }});
  registry.register({name:'search_context',kind:'tool',readOnly:true,description:'Search original context, including messages removed by summaries. Returns verified source references and excerpts; no tools are repeated.',
    parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:500}},required:['query'],additionalProperties:false},
    execute:async(args,signal)=>{signal.throwIfAborted();return journal.search(String(args.query));}});
  registry.register({name:'read_context',kind:'tool',readOnly:true,description:'Read a verified source returned by search_context; returns original message content in pages without replaying tools.',
    parameters:{type:'object',properties:{source:{type:'object',properties:{requestSequence:{type:'integer',minimum:1},messageIndex:{type:'integer',minimum:0},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['requestSequence','messageIndex','sha256'],additionalProperties:false},startChar:{type:'integer',minimum:0}},required:['source'],additionalProperties:false},
    execute:async(args,signal)=>{signal.throwIfAborted();const m=await journal.source(args.source as unknown as SourceRef),start=Number(args.startChar??0),end=Math.min(m.content.length,start+16000);return {role:m.role,content:m.content.slice(start,end),nextStartChar:end<m.content.length?end:null};}});
  return async(tools:unknown[],metadata:{turn:number;reservedTokens:number})=>{
    const snapshot=messages.map(plain),sequence=await journal.record(snapshot,tools,metadata);
    refs=snapshot.map((m,messageIndex)=>({requestSequence:sequence,messageIndex,sha256:hash(m)}));
  };
}
