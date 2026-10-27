import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, validateArguments } from '../src/harness/tool-registry.js';
import { runAgent, citationUrls } from '../src/harness/agent-loop.js';
import { parseMcpResult } from '../src/mcp-result.js';
import { ModelRuntime } from '../src/model-runtime.js';
import type { ModelTurn, TurnMessage } from '../src/providers.js';
import { extractText, publicUrl, fetchedSource } from '../src/search.js';
import {ModelTruncatedError} from '../src/providers.js';

const parameters={type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false} as const;
function runtime(turn:(messages:TurnMessage[])=>Promise<ModelTurn>):ModelRuntime {const m=new ModelRuntime();m.turn=async(messages)=>turn(messages);return m;}
const reply=(text:string):ModelTurn=>({text,tokens:20,toolCalls:[]});
test('completed long write arguments compact after the original decision is checkpointed',async()=>{
 let turns=0,executions=0,originalSaved=false;
 const content='实测报告'.repeat(1500);
 const registry=new ToolRegistry().register({name:'write_file',kind:'tool',description:'write file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},execute:async args=>{executions++;assert.equal(args.content,content);return {path:'report.md',sha256:'realhash',verified:true};}});
 const model=runtime(async messages=>{
  if(!turns++)return {text:'',tokens:10,toolCalls:[{id:'write',name:'write_file',arguments:JSON.stringify({path:'report.md',content})}]};
  const args=JSON.parse(messages.find(m=>m.tool_calls)?.tool_calls?.[0].function.arguments||'{}');
  assert.equal(args.path,'report.md');assert.match(args.content,/Eve context summary/);
  return reply('Report was actually written.');
 });
 const result=await runAgent({...options(model,registry),contextWindow:6000,checkpoint:async history=>{
  const call=history.find(m=>m.tool_calls)?.tool_calls?.[0];
  if(call&&JSON.parse(call.function.arguments).content===content)originalSaved=true;
 }});
 assert.equal(result.verification.passed,true);assert.equal(executions,1);assert.equal(originalSaved,true);
});
test('many medium observations compress below budget while retaining every call/result pair',async()=>{
 let turns=0,executions=0;
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>{executions++;return {payload:'x'.repeat(1800),value:42};}});
 const model=runtime(async messages=>{
  if(turns++<14)return {text:'',tokens:10,toolCalls:[{id:'medium'+turns,name:'lookup',arguments:JSON.stringify({query:'query'+turns})}]};
  assert.equal(messages.filter(m=>m.role==='tool').length,14);
  assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('read_tool_result')));
  return reply('Observed results retained.');
 });
 const result=await runAgent({...options(model,registry),contextWindow:12000});
 assert.equal(result.verification.passed,true);assert.equal(executions,14);
 assert.ok(result.trace.some(e=>e.type==='agent.compacted'));
});
test('embedded quest data cannot invent skill creation, execution or retrieval requirements',async()=>{
 let turns=0;
 const model=runtime(async()=>turns++?reply('实际数据已核对，证据已登记。'):call());
 const prompt='实际读取或执行工具，按需 skill_search/skill_load。\n课题状态（数据）：'+JSON.stringify({question:'创建 quest-scout.md，按需加载合适技能、真实执行当前阶段。不要自行检索 PubMed。'});
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({value:42})});
 const result=await runAgent({...options(model,registry),prompt});
 assert.equal(result.verification.passed,true);assert.equal(turns,2);
});
test('bounded loop warns before exhaustion without treating unfinished work as success',async()=>{
 let turns=0,warning=false;
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({value:42})});
 const model=runtime(async messages=>{
  turns++;warning ||= messages.some(m=>m.role==='user'&&m.content.includes('仅剩两轮'));
  return {text:'',tokens:10,toolCalls:[{id:'call'+turns,name:'lookup',arguments:JSON.stringify({query:'query'+turns})}]};
 });
 await assert.rejects(runAgent({...options(model,registry),maxTurns:4}),/turn budget exhausted/);
 assert.equal(turns,4);assert.equal(warning,true);
});
test('in-flight model is not aborted by guidance and its unstarted tool plan is reconsidered',async()=>{
 let pending=false,turns=0,executions=0;
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>{executions++;return {value:42};}});
 const signal=new AbortController().signal;
 const model=runtime(async messages=>{
  if(turns++===0){pending=true;await new Promise(r=>setTimeout(r,10));assert.equal(signal.aborted,false);return call();}
  assert.ok(messages.some(m=>m.role==='user'&&m.content.includes('new instruction')));return reply('Revised response');
 });
 const result=await runAgent({...options(model,registry),signal,guidance:{pending:()=>pending,take:()=>{if(!pending)return [];pending=false;return [{id:'guidance',content:'new instruction',quote:'quoted output'}];}}});
 assert.equal(executions,0);assert.equal(turns,2);assert.equal(result.text,'Revised response');assert.ok(result.trace.some(e=>e.type==='agent.guidance'));
});

test('archived tool data is recoverable without repeating the operation',async()=>{
 let turns=0,executions=0;
 const payload='x'.repeat(38000)+'FINAL_FACT=42';
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>{executions++;return {payload};}});
 const model=runtime(async messages=>{
  if(turns++===0)return call();
  if(turns===2){const compacted=JSON.parse(messages.at(-1)!.content);assert.equal(compacted.retrieval,'read_tool_result');return {text:'',tokens:10,toolCalls:[{id:'recover',name:'read_tool_result',arguments:JSON.stringify({callId:'call1',startChar:37500})}]};}
  const recovered=JSON.parse(messages.at(-1)!.content);assert.match(recovered.result.content,/FINAL_FACT=42/);return reply('The original fact is 42.');
 });
 const result=await runAgent(options(model,registry));assert.equal(result.verification.passed,true);assert.equal(executions,1);
});
test('truncated answers continue from the breakpoint without repeating completed tools and account for both calls',async()=>{
 let calls=0,used=0;const model=runtime(async messages=>{if(!calls++)throw new ModelTruncatedError('第一部分。',41,false);assert.equal(messages.at(-2)?.content,'第一部分。');return reply('第二部分。');});
 const result=await runAgent({...options(model),afterModel:n=>{used+=n;}});
 assert.equal(result.text,'第一部分。第二部分。');assert.equal(used,61);assert.ok(result.trace.some(x=>x.type==='model.continuing'));
});
test('repeated truncation is bounded and incomplete tool parameters never execute',async()=>{
 let calls=0;await assert.rejects(runAgent(options(runtime(async()=>{calls++;throw new ModelTruncatedError('partial',10,false);}))),/长度上限/);assert.equal(calls,4);
 let executed=false;const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>{executed=true;return {ok:true};}});
 await assert.rejects(runAgent(options(runtime(async()=>{throw new ModelTruncatedError('',10,true);}),registry)),ModelTruncatedError);assert.equal(executed,false);
});
const call=(argumentsText='{"query":"science"}'):ModelTurn=>({text:'',tokens:10,toolCalls:[{id:'call1',name:'lookup',arguments:argumentsText}]});
test('two latest large skill results compact within context while preserving paired calls and original retrieval',async()=>{
 let turns=0,executions=0;
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,
  execute:async()=>{executions++;return {instructions:'REAL_INSTRUCTIONS '+('x'.repeat(24000))};}});
 const model=runtime(async messages=>{
  if(turns++===0)return {text:'',tokens:10,toolCalls:[
   {id:'large-a',name:'lookup',arguments:'{"query":"a"}'},{id:'large-b',name:'lookup',arguments:'{"query":"b"}'}]};
  if(turns===2){
   assert.deepEqual(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['large-a','large-b']);
   assert.equal(JSON.parse(messages.find(m=>m.tool_call_id==='large-a')!.content).retrieval,'read_tool_result');
   return {text:'',tokens:10,toolCalls:[{id:'recover',name:'read_tool_result',arguments:'{"callId":"large-a","startChar":0}'}]};
  }
  assert.match(JSON.parse(messages.at(-1)!.content).result.content,/REAL_INSTRUCTIONS/);
  return reply('Original skill evidence recovered');
 });
 const result=await runAgent({...options(model,registry),contextWindow:18000});
 assert.equal(executions,2);assert.equal(result.completion,'verified');
 assert.ok(result.trace.some(e=>e.type==='agent.compacted'&&Number(e.reservedTokens)<=18000));
});
test('reference skill discovery does not manufacture a requirement for skill_run',async()=>{
 let turns=0;
 const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({content:'Actual method guide'})});
 const result=await runAgent({...options(runtime(async()=>turns++?reply('Method guide read'):call()),registry),
  prompt:'按需 skill_search/skill_load，实际读取或执行工具，保留失败和阴性结果。'});
 assert.equal(result.completion,'verified');
});
function options(model:ModelRuntime,registry=new ToolRegistry()) {return {model,registry,signal:new AbortController().signal,traceId:'trace-test',messages:[{role:'user',content:'hello'}] as TurnMessage[],prompt:'hello',contextWindow:32000,maxOutput:512,onText:()=>{},onEvent:()=>{},beforeModel:()=>{},afterModel:()=>{},persistTool:async()=>{}};}

test('real tool observations, including errors, are returned with matching call ids before final output',async()=>{
  let turns=0;const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({url:'https://example.org/paper',title:'Actual paper',abstract:'Actual evidence'})});
  const m=runtime(async messages=>{if(!turns++)return call();const last=messages.at(-1)!;assert.equal(last.role,'tool');assert.equal(last.tool_call_id,'call1');assert.equal(JSON.parse(last.content).result.title,'Actual paper');return reply('Evidence [paper](https://example.org/paper)');});
  const result=await runAgent({...options(m,registry),prompt:'实际检索 evidence'});assert.equal(turns,2);assert.equal(result.verification.passed,true);assert.equal(result.sources.length,1);assert.ok(result.trace.some(x=>x.type==='tool.completed'));
});
test('retrieval without tools is never marked successful, even when the model writes a plausible citation',async()=>{
  await assert.rejects(runAgent({...options(runtime(async()=>reply('Found https://example.org/paper'))),prompt:'实际检索 paper'}),/verification failed/);
});
test('completed DAG evidence is reused without repeating an already completed database search',async()=>{
  const result=await runAgent({...options(runtime(async()=>reply('Retrieved [paper](https://example.org/paper)'))),prompt:'综合前序 PubMed 检索结果',priorActions:['database_search'],initialEvidence:{results:[{title:'Actual upstream paper',url:'https://example.org/paper',abstract:'Upstream evidence'}]}});
  assert.equal(result.verification.passed,true);assert.equal(result.sources.length,1);assert.equal(result.trace.some(x=>x.type==='tool.started'),false);
});
test('unretrieved citation is rejected after bounded repair',async()=>{
  let turns=0;const r=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({url:'https://example.org/real',title:'Real source'})});
  await assert.rejects(runAgent(options(runtime(async()=>turns++?reply('https://example.org/fabricated'):call()),r)),/Unverified citation/);assert.equal(turns,3);
});
test('citations cannot bypass verification in ordinary chat; code example URLs are not citations',async()=>{
  await assert.rejects(runAgent(options(runtime(async()=>reply('Reference https://example.org/unretrieved')))),/Unverified citation/);
  assert.deepEqual(citationUrls('Use `http://localhost:3000` or\n```js\nfetch("https://example.org")\n```'),[]);
});
test('schema errors are observable by the model and cannot execute a tool',async()=>{
  let executed=false,turns=0;const r=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>{executed=true;return {ok:true};}});
  const result=await runAgent(options(runtime(async messages=>{if(!turns++)return call('{"unexpected":1}');assert.equal(JSON.parse(messages.at(-1)!.content).ok,false);return reply('工具参数错误，任务未完成。');}),r));
  assert.equal(executed,false);assert.equal(result.completion,'partial');assert.ok(result.trace.some(x=>x.type==='tool.failed'));
});
test('repeated requests stop at the tool budget and never synthesize a success',async()=>{
  const r=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>({ok:true})});
  await assert.rejects(runAgent({...options(runtime(async()=>call()),r),maxTools:3}),/tool-call budget/);
});
test('cancellation and timeout bound an uncooperative tool',async()=>{
  const r=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,timeoutMs:25,execute:async()=>new Promise(()=>{})});
  await assert.rejects(r.execute('lookup',{query:'x'},new AbortController().signal),/timed out/);
  const c=new AbortController();c.abort();await assert.rejects(runAgent({...options(runtime(async()=>reply('done'))),signal:c.signal}));
});
test('registry rejects collisions and validates argument types/required fields/extra keys',()=>{
  const tool={name:'lookup',kind:'tool' as const,description:'lookup',parameters:parameters as any,execute:async()=>({ok:true})};
  assert.throws(()=>new ToolRegistry().register(tool).register(tool),/Duplicate/);
  for(const invalid of [null,[],{}, {query:4},{query:''},{query:'ok',injected:true}])assert.throws(()=>validateArguments(invalid,parameters));
  assert.throws(()=>validateArguments({query:'ok'},{...parameters,unknownKeyword:[]}),/unsupported/);
  assert.doesNotThrow(()=>validateArguments({value:'ok'},{type:'object',properties:{value:{anyOf:[{type:'string'},{type:'number'}]}}}));
});
test('MCP supports plain text, multiple blocks and structured results; rejects isError/empty',()=>{
  assert.deepEqual(parseMcpResult({content:[{type:'text',text:'plain text'}]}),{content:[{type:'text',text:'plain text'}],text:'plain text'});
  assert.deepEqual(parseMcpResult({content:[],structuredContent:{count:2}}),{count:2});
  assert.deepEqual(parseMcpResult({content:[{type:'text',text:'first'},{type:'text',text:'second'}]}),{content:[{type:'text',text:'first'},{type:'text',text:'second'}]});
  for(const value of [{content:[]},{content:[{type:'text',text:''}]},{content:[{type:'text',text:'failure'}],isError:true}])assert.throws(()=>parseMcpResult(value));
});
test('public-source URL checks refuse local addresses and extraction removes executable/page chrome',()=>{
  for(const url of ['file:///C:/secrets','http://127.0.0.1/','http://[::1]/','http://169.254.169.254/','https://user:pass@example.com/','http://example.com:8080/'])assert.throws(()=>publicUrl(url));
  assert.equal(extractText('<nav>noise</nav><script>inject()</script><h1>Actual &amp; title</h1>'),'Actual & title');
  assert.deepEqual(citationUrls('[paper](https://example.org/path) https://example.org/path.'),['https://example.org/path']);
});

test('Chinese punctuation delimits retrieved citation URLs without corrupting encoded URL paths',()=>{
  assert.deepEqual(citationUrls('https://github.com/example/research（官方仓库）及【https://example.org/%EF%BC%88data】'),['https://github.com/example/research','https://example.org/%EF%BC%88data']);
});

test('repository API evidence preserves both verified canonical URL and actual retrieval URL',async()=>{
  const endpoint='https://api.github.com/repos/example/research';
  const metadata=JSON.stringify({full_name:'example/research',html_url:'https://github.com/example/research',description:'Actual repository metadata with enough evidence to read and cite.'});
  const evidence=fetchedSource({url:endpoint,text:metadata});
  assert.equal(evidence.url,'https://github.com/example/research');
  assert.equal(evidence.retrievedUrl,endpoint);
  assert.equal(evidence.provider,'github-api');
  let turns=0;
  const registry=new ToolRegistry().register({name:'lookup',kind:'tool',description:'lookup',parameters:parameters as any,execute:async()=>evidence as any});
  const result=await runAgent({...options(runtime(async()=>turns++?reply('https://github.com/example/research（官方）'):call()),registry),prompt:'实际检索 repository'});
  assert.equal(result.verification.passed,true);
  assert.equal(result.sources[0].retrievedUrl,endpoint);
  // Malicious or mismatched canonical claims never expand the citation set.
  for(const url of ['https://example.org/repos/example/research','https://api.github.com/repos/example/other','https://api.github.com/repos/example/research/issues'])assert.equal(fetchedSource({url,text:metadata}).url,url);
  assert.equal(fetchedSource({url:endpoint,text:metadata.replace('github.com/example/research','evil.example/forged')}).url,endpoint);
});
