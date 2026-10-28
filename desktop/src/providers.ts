import { safeError } from './security.js';
import type { Json } from './harness/types.js';
export interface ModelConfig { provider:'openai'|'anthropic'; baseUrl:string; model:string; apiKey:string; contextWindow:number; maxOutput:number }
export function validateModelConfig(value:unknown):ModelConfig {
 const c=value as ModelConfig;const fields=new Set(['provider','baseUrl','model','apiKey','contextWindow','maxOutput']);
 if(!c||Array.isArray(c)||typeof c!=='object'||Object.keys(c).some(k=>!fields.has(k))||!['openai','anthropic'].includes(c.provider)||typeof c.apiKey!=='string'||c.apiKey.length>4096||/[\u0000-\u001f\u007f]/.test(c.apiKey)||typeof c.model!=='string'||!c.model.trim()||c.model.length>160||/[\u0000-\u001f\u007f]/.test(c.model)||typeof c.baseUrl!=='string')throw new Error('模型配置无效');
 const url=new URL(c.baseUrl);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('模型地址需要 HTTPS 或本地回环 HTTP');
 if(url.username||url.password||url.search||url.hash)throw new Error('模型地址不能包含凭据或查询参数');
 if(!Number.isSafeInteger(c.contextWindow)||c.contextWindow<4096||c.contextWindow>2_000_000||!Number.isSafeInteger(c.maxOutput)||c.maxOutput<128||c.maxOutput>32768||c.maxOutput>=c.contextWindow/2)throw new Error('上下文与输出预算无效');
 return {...c,baseUrl:c.baseUrl.replace(/\/$/,'')};
}
export interface FunctionSpec { name:string; description:string; parameters:Record<string,Json> }
export interface ToolCall { id:string; name:string; arguments:string }
export interface TurnMessage { role:'system'|'user'|'assistant'|'tool'; content:string; tool_calls?: Array<{id:string;type:'function';function:{name:string;arguments:string}}>; tool_call_id?:string; reasoning_content?:string }
export interface ModelTurn { text:string; tokens:number; toolCalls:ToolCall[]; reasoningContent?:string }
export class ModelTruncatedError extends Error {
 constructor(readonly partialText:string,readonly tokens:number,readonly hasToolCalls:boolean){super('模型输出达到长度上限（截断），尚未完成');this.name='ModelTruncatedError';}
}
export class ModelApiError extends Error {
 readonly definitive:boolean;readonly retryable:boolean;
 constructor(readonly status:number,readonly retryAfterMs=2000,readonly contextOverflow=false){super(`模型 API HTTP ${status}; provider request rejected${status===429?'（限流或额度不足）':''}`);this.name='ModelApiError';this.definitive=[400,401,403,404,409,422,429].includes(status);this.retryable=status===429;}
}
function anthropicMessages(messages:TurnMessage[]):any[] {
 const result:any[]=[];
 for(const m of messages.filter(m=>m.role!=='system')){
  let role=m.role==='assistant'?'assistant':'user';let content:any[];
  if(m.role==='tool')content=[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}];
  else {content=m.content?[{type:'text',text:m.content}]:[];for(const t of m.tool_calls??[]){let input:unknown;try{input=JSON.parse(t.function.arguments);}catch{throw new Error('模型工具参数不是有效 JSON');}content.push({type:'tool_use',id:t.id,name:t.function.name,input});}}
  if(result.at(-1)?.role===role)result.at(-1).content.push(...content);else result.push({role,content});
 }
 return result;
}
async function streamReply(c:ModelConfig,messages:TurnMessage[],signal:AbortSignal,onText:(text:string)=>void,tools:FunctionSpec[]):Promise<ModelTurn> {
 const anthropic=c.provider==='anthropic';
 const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 const nativeMessages=anthropic&&(tools.length||messages.some(m=>m.role==='tool'||m.tool_calls?.length))?anthropicMessages(messages):messages.filter(m=>m.role!=='system');
 const body=anthropic?{model:c.model,max_tokens:c.maxOutput,system,messages:nativeMessages,stream:true,...(tools.length?{tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}))}:{})}:{model:c.model,max_tokens:c.maxOutput,messages,stream:true,stream_options:{include_usage:true},...(tools.length?{tools:tools.map(t=>({type:'function',function:t})),tool_choice:'auto'}:{})};
 const headers:Record<string,string>=anthropic?{'Content-Type':'application/json','x-api-key':c.apiKey,'anthropic-version':'2023-06-01'}:{'Content-Type':'application/json','Authorization':`Bearer ${c.apiKey}`};
 const response=await fetch(c.baseUrl+(anthropic?'/messages':'/chat/completions'),{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
 if(!response.ok){
  const retry=Number(response.headers.get('retry-after'));let diagnostic='';
  if([400,413,422].includes(response.status)&&response.body){
   const reader=response.body.getReader();
   try{while(diagnostic.length<16000){const part=await reader.read();if(part.done)break;diagnostic+=new TextDecoder().decode(part.value).slice(0,16000-diagnostic.length);}}finally{await reader.cancel();}
  }else await response.body?.cancel();
  const overflow=/context_length_exceeded|maximum context|context.{0,25}(?:too long|exceed)|prompt.{0,25}too long|上下文.{0,20}(?:超|长)/i.test(diagnostic);
  throw new ModelApiError(response.status,Number.isFinite(retry)&&retry>0?Math.min(10000,retry*1000):2000,overflow);
 }
 if(!response.body)throw new Error('模型返回空响应流');
 const decoder=new TextDecoder();let pending='',text='',tokens=0,complete=false,inputTokens=0,reasoningContent='',finishReason='';
 const calls=new Map<number,ToolCall>();let dataLines:string[]=[];
 const processEvent=():void=>{
   if(!dataLines.length)return;const raw=dataLines.join('\n');dataLines=[];if(raw==='[DONE]'){complete=true;return;}
   let e:any;try{e=JSON.parse(raw);}catch{throw new Error('模型流包含无效 JSON');}
   if(e.error||e.type==='error')throw new Error('模型流返回错误；请在供应商控制台检查请求');
   if(anthropic){
    if(e.type==='message_start')inputTokens=e.message?.usage?.input_tokens??0;
    if(e.type==='message_delta'){tokens=inputTokens+(e.usage?.output_tokens??0);finishReason=e.delta?.stop_reason??finishReason;}
    if(e.type==='message_stop')complete=true;
    if(e.type==='content_block_start'&&e.content_block?.type==='tool_use')calls.set(e.index,{id:e.content_block.id,name:e.content_block.name,arguments:Object.keys(e.content_block.input??{}).length?JSON.stringify(e.content_block.input):''});
    if(e.type==='content_block_delta'&&e.delta?.type==='input_json_delta'){const call=calls.get(e.index);if(!call)throw new Error('模型工具参数流缺少起始事件');call.arguments+=e.delta.partial_json??'';}
   }else{
    if(e.usage)tokens=(e.usage.prompt_tokens??0)+(e.usage.completion_tokens??0);
    const choice=e.choices?.[0];if(choice?.finish_reason){finishReason=choice.finish_reason;complete=true;}
    for(const item of choice?.delta?.tool_calls??[]){if(!Number.isSafeInteger(item.index)||item.index<0||item.index>31)throw new Error('模型工具调用索引无效');let call=calls.get(item.index);if(!call){call={id:'',name:'',arguments:''};calls.set(item.index,call);}call.id+=item.id??'';call.name+=item.function?.name??'';call.arguments+=item.function?.arguments??'';}
    if(typeof choice?.delta?.reasoning_content==='string')reasoningContent+=choice.delta.reasoning_content;
   }
   const delta=anthropic?(e.delta?.type==='text_delta'?e.delta.text:''):(e.choices?.[0]?.delta?.content??'');
   if(typeof delta==='string'&&delta){text+=delta;if(text.length>500000)throw new Error('模型输出超过限额');onText(text);}
   if(reasoningContent.length>500000||[...calls.values()].some(x=>x.arguments.length>100000))throw new Error('模型工具参数或推理流超过限额');
 };
 const line=(value:string):void=>{if(!value){processEvent();return;}if(value.startsWith('data:'))dataLines.push(value.slice(5).replace(/^ /,''));};
 for await (const chunk of response.body){
  pending+=decoder.decode(chunk,{stream:true});if(pending.length>2_000_000)throw new Error('单个流事件超过限额');
  let boundary:number;
  while((boundary=pending.indexOf('\n'))>=0){const value=pending.slice(0,boundary).replace(/\r$/,'');pending=pending.slice(boundary+1);line(value);}
 }
 pending+=decoder.decode();if(pending)line(pending.replace(/\r$/,''));processEvent();
 if(!complete)throw new Error('模型流意外中断；已收到的片段尚未确认为最终结果');
 if(['length','max_tokens'].includes(finishReason))throw new ModelTruncatedError(text,tokens,calls.size>0);
 if(finishReason==='content_filter')throw new Error('模型输出被过滤，未确认为完成');
 const toolCalls=[...calls.values()];
 if(toolCalls.some(x=>!x.id||!x.name))throw new Error('模型工具调用缺少 ID 或名称');
 for(const call of toolCalls)if(!call.arguments)call.arguments='{}';
 if(!text.trim()&&!toolCalls.length)throw new Error('模型没有返回文本或工具调用');
 return {text,tokens,toolCalls,...(reasoningContent?{reasoningContent}:{})};
}
export async function modelTurn(c:ModelConfig,messages:TurnMessage[],signal:AbortSignal,onText:(text:string)=>void,tools:FunctionSpec[]=[]):Promise<ModelTurn> {
 try {return await streamReply(validateModelConfig(c),messages,signal,onText,tools);}
 catch(error) {
  if(error instanceof ModelApiError||error instanceof ModelTruncatedError)throw error;
  // Never persist arbitrary transport/SDK exceptions, which can echo enterprise credentials.
  const message=error instanceof Error?error.message:'';
  const safe=/^(?:模型|单个流事件)/.test(message)&&!message.includes(c.apiKey||'\u0000');
  throw new Error(safe?message:(signal.aborted?'模型请求已取消；外部计费结果需要核查':'模型连接失败；请检查供应商、网络和配置。请求可能已计费。'));
 }
}
export async function modelReply(c:ModelConfig,messages:any[],signal:AbortSignal,onText:(text:string)=>void):Promise<{text:string;tokens:number}> {
 const result=await modelTurn(c,messages,signal,onText);
 if(result.toolCalls.length)throw new Error('模型请求了工具，但当前调用入口未注册工具');
 return {text:result.text,tokens:result.tokens};
}
