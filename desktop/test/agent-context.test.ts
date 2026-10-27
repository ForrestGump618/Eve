import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerContextTools} from '../src/agent-context.js';
import {prepareContextAsync} from '../src/context-async.js';
import {queryContextAsync} from '../src/context-query.js';
import {ToolRegistry} from '../src/harness/tool-registry.js';
import type {ContextMessage} from '../src/context.js';
import type {TurnMessage} from '../src/providers.js';

test('model-written context ranges survive restart, recall originals and never replay tools',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'eve-acp-tools-'));
 const opts={directory,model:'deepseek-v4.1-flash-economy',contextWindow:64000,outputTokens:512,accounting:'estimate' as const};
 const original='negative result /remote/研究.csv pmid:16904174\n'.repeat(120);
 let messages:TurnMessage[]=[
  {role:'system',content:'User permissions must remain unchanged.'},
  {role:'user',content:'Analyze the actual file and preserve failures.'},
  {role:'assistant',content:'',tool_calls:[{id:'read1',type:'function',function:{name:'read_file',arguments:'{"path":"研究.csv"}'}}]},
  {role:'tool',tool_call_id:'read1',content:JSON.stringify({ok:true,result:original})},
  {role:'user',content:'Compare this with previous findings.'},
 ];
 const journal={
  record:async(m:TurnMessage[],tools:unknown[])=>{
   const r=await prepareContextAsync(opts,{messages:m as ContextMessage[],tools,recordOnly:true});return r.requestSequence!;
  },
  source:async(source:any)=>await queryContextAsync(opts,'source',source) as unknown as ContextMessage,
  search:(query:string)=>queryContextAsync(opts,'search',undefined,{text:query}),
 };
 try{
  let registry=new ToolRegistry();
  const record=registerContextTools(registry,messages,journal,()=>{});
  await record(registry.definitions(),{turn:0,reservedTokens:2000});
  await assert.rejects(registry.execute('compress',{startMessage:0,endMessage:3,summary:'Do not remove system/user authority.'},new AbortController().signal));
  await assert.rejects(registry.execute('compress',{startMessage:2,endMessage:2,summary:'Incomplete tool pair must not be removed.'},new AbortController().signal));
  const compressed=await registry.execute('compress',{startMessage:2,endMessage:3,summary:'Negative result from /remote/研究.csv. Preserve pmid:16904174; causal inference is unresolved.'},new AbortController().signal) as {id:string};
  assert.equal(messages.length,4);assert.equal(messages[0]!.role,'system');assert.equal(messages[1]!.role,'user');
  const archived=JSON.stringify(messages);
  messages=JSON.parse(archived);registry=new ToolRegistry();
  registerContextTools(registry,messages,journal,()=>{});
  const search=await registry.execute('search_context',{query:'研究.csv'},new AbortController().signal) as {matches:any[]};
  assert.ok(search.matches.length>0);
  const source=search.matches.find(m=>m.role==='tool').source;
  const read=await registry.execute('read_context',{source},new AbortController().signal) as {content:string};
  assert.ok(read.content.includes('negative result'));
  const restored=await registry.execute('decompress',{id:compressed.id},new AbortController().signal) as {toolsReplayed:boolean};
  assert.equal(restored.toolsReplayed,false);assert.equal(messages.length,5);
  assert.equal(messages[3]!.content,JSON.stringify({ok:true,result:original}));
  const requests=await queryContextAsync(opts,'requests') as {total:number};
  assert.equal(requests.total,1);
  const request=await queryContextAsync(opts,'request',undefined,{sequence:1}) as {tools:unknown[];messages:unknown[]};
  assert.ok(request.tools.length>=5);assert.equal(request.messages.length,5);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
