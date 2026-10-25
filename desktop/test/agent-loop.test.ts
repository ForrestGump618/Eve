import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, validateArguments } from '../src/harness/tool-registry.js';
import { runAgent, citationUrls } from '../src/harness/agent-loop.js';
import { parseMcpResult } from '../src/mcp-result.js';
import { ModelRuntime } from '../src/model-runtime.js';
import type { ModelTurn, TurnMessage } from '../src/providers.js';
import { extractText, publicUrl } from '../src/search.js';

const parameters={type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false} as const;
function runtime(turn:(messages:TurnMessage[])=>Promise<ModelTurn>):ModelRuntime {const m=new ModelRuntime();m.turn=async(messages)=>turn(messages);return m;}
const reply=(text:string):ModelTurn=>({text,tokens:20,toolCalls:[]});
const call=(argumentsText='{"query":"science"}'):ModelTurn=>({text:'',tokens:10,toolCalls:[{id:'call1',name:'lookup',arguments:argumentsText}]});
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
