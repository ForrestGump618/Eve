import { safeError } from './security.js';
export interface ModelConfig { provider:'openai'|'anthropic'; baseUrl:string; model:string; apiKey:string; contextWindow:number; maxOutput:number }
export function validateModelConfig(value:unknown):ModelConfig {
 const c=value as ModelConfig;const fields=new Set(['provider','baseUrl','model','apiKey','contextWindow','maxOutput']);
 if(!c||Array.isArray(c)||typeof c!=='object'||Object.keys(c).some(k=>!fields.has(k))||!['openai','anthropic'].includes(c.provider)||typeof c.apiKey!=='string'||c.apiKey.length>4096||/[\u0000-\u001f\u007f]/.test(c.apiKey)||typeof c.model!=='string'||!c.model.trim()||c.model.length>160||/[\u0000-\u001f\u007f]/.test(c.model)||typeof c.baseUrl!=='string')throw new Error('模型配置无效');
 const url=new URL(c.baseUrl);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('模型地址需要 HTTPS 或本地回环 HTTP');
 if(url.username||url.password||url.search||url.hash)throw new Error('模型地址不能包含凭据或查询参数');
 if(!Number.isSafeInteger(c.contextWindow)||c.contextWindow<4096||c.contextWindow>2_000_000||!Number.isSafeInteger(c.maxOutput)||c.maxOutput<128||c.maxOutput>32768||c.maxOutput>=c.contextWindow/2)throw new Error('上下文与输出预算无效');
 return {...c,baseUrl:c.baseUrl.replace(/\/$/,'')};
}
async function streamReply(c:ModelConfig,messages:any[],signal:AbortSignal,onText:(text:string)=>void):Promise<{text:string;tokens:number}> {
 const anthropic=c.provider==='anthropic';
 const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 const body=anthropic?{model:c.model,max_tokens:c.maxOutput,system,messages:messages.filter(m=>m.role!=='system'),stream:true}:{model:c.model,max_tokens:c.maxOutput,messages,stream:true,stream_options:{include_usage:true}};
 const headers:Record<string,string>=anthropic?{'Content-Type':'application/json','x-api-key':c.apiKey,'anthropic-version':'2023-06-01'}:{'Content-Type':'application/json','Authorization':`Bearer ${c.apiKey}`};
 const response=await fetch(c.baseUrl+(anthropic?'/messages':'/chat/completions'),{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
 if(!response.ok)throw new Error(`模型 API HTTP ${response.status}; provider=${c.provider}。请求可能已计费，请检查服务端记录后重试。`);
 if(!response.body)throw new Error('模型返回空响应流');
 const decoder=new TextDecoder();let pending='',text='',tokens=0,complete=false,inputTokens=0;
 for await (const chunk of response.body){
  pending+=decoder.decode(chunk,{stream:true});if(pending.length>2_000_000)throw new Error('单个流事件超过限额');
  let boundary:number;
  while((boundary=pending.indexOf('\n'))>=0){const line=pending.slice(0,boundary).trimEnd();pending=pending.slice(boundary+1);if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(raw==='[DONE]'){complete=true;continue;}
   let e:any;try{e=JSON.parse(raw);}catch{throw new Error('模型流包含无效 JSON');}
   if(e.error||e.type==='error')throw new Error('模型流返回错误；请在供应商控制台检查请求');
   if(anthropic){if(e.type==='message_start')inputTokens=e.message?.usage?.input_tokens??0;if(e.type==='message_delta')tokens=inputTokens+(e.usage?.output_tokens??0);if(e.type==='message_stop')complete=true;}
   else {if(e.usage)tokens=(e.usage.prompt_tokens??0)+(e.usage.completion_tokens??0);if(e.choices?.[0]?.finish_reason)complete=true;}
   const delta=anthropic?(e.delta?.type==='text_delta'?e.delta.text:''):(e.choices?.[0]?.delta?.content??'');
   if(typeof delta==='string'&&delta){text+=delta;if(text.length>500_000)throw new Error('模型输出超过限额');onText(text);}
  }
 }
 if(!complete)throw new Error('模型流意外中断；已收到的片段尚未确认为最终结果');
 if(!text.trim())throw new Error('模型没有返回文本');
 return {text,tokens};
}
export async function modelReply(c:ModelConfig,messages:any[],signal:AbortSignal,onText:(text:string)=>void):Promise<{text:string;tokens:number}> {
 try {return await streamReply(validateModelConfig(c),messages,signal,onText);}
 catch(error) {
  // Never persist arbitrary transport/SDK exceptions, which can echo enterprise credentials.
  const message=error instanceof Error?error.message:'';
  const safe=/^(?:模型|单个流事件)/.test(message)&&!message.includes(c.apiKey||'\u0000');
  throw new Error(safe?message:(signal.aborted?'模型请求已取消；外部计费结果需要核查':'模型连接失败；请检查供应商、网络和配置。请求可能已计费。'));
 }
}
