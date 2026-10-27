import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { modelReply, modelTurn, ModelApiError, validateModelConfig, type ModelConfig } from '../src/providers.js';

async function fixture(t: any, handler: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      await handler(request, response, body ? JSON.parse(body) : null);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1`;
}

function config(baseUrl: string, provider: 'openai' | 'anthropic' = 'openai'): ModelConfig {
  return validateModelConfig({ provider, baseUrl, model: 'local-protocol-fixture', apiKey: 'fixture-enterprise-credential', contextWindow: 8192, maxOutput: 512 });
}

test('OpenAI error observation survives malformed arguments without running the Anthropic serializer', async t=>{
 const baseUrl=await fixture(t,(_request,response,body)=>{
  assert.equal(body.messages[1].tool_calls[0].function.arguments,'{"query":');
  assert.equal(body.messages[2].role,'tool');
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  response.end('data: {"choices":[{"delta":{"content":"Corrected response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 });
 const result=await modelTurn(config(baseUrl),[
  {role:'user',content:'lookup'},
  {role:'assistant',content:'',tool_calls:[{id:'bad',type:'function',function:{name:'lookup',arguments:'{"query":'}}]},
  {role:'tool',tool_call_id:'bad',content:'{"ok":false,"error":"Tool arguments are not valid JSON"}'}
 ],new AbortController().signal,()=>{},[{name:'lookup',description:'lookup',parameters:{type:'object'}}]);
 assert.equal(result.text,'Corrected response');
});

test('OpenAI-compatible protocol sends authenticated request and joins fragmented UTF-8 SSE text with usage', async t => {
  let seen = false;
  const baseUrl = await fixture(t, (request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-enterprise-credential');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(body.messages[0].content, 'System instruction');
    seen = true;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const data = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
    const chinese = data.indexOf(Buffer.from('你好'));
    response.write(data.subarray(0, chinese + 1));
    response.write(data.subarray(chinese + 1, chinese + 4));
    response.end(data.subarray(chinese + 4));
  });
  const chunks: string[] = [];
  const result = await modelReply(config(baseUrl), [{ role: 'system', content: 'System instruction' }, { role: 'user', content: 'hello' }], new AbortController().signal, text => chunks.push(text));
  assert.equal(seen, true);
  assert.deepEqual(result, { text: '你好 world', tokens: 14 });
  assert.equal(chunks.at(-1), result.text);
});

test('Anthropic protocol separates system text, uses native key header, and records terminal usage', async t => {
  const baseUrl = await fixture(t, (request, response, body) => {
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'fixture-enterprise-credential');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(body.system, 'System instruction');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"native reply"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const result = await modelReply(config(baseUrl, 'anthropic'), [{ role: 'system', content: 'System instruction' }, { role: 'user', content: 'hello' }], new AbortController().signal, () => {});
  assert.deepEqual(result, { text: 'native reply', tokens: 17 });
});

test('malformed JSON, unfinished streams and provider errors reject instead of settling partial output', async t => {
  const cases = [
    ['data: not-json\n\n', /JSON/],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', /中断/],
    ['data: {"error":{"message":"provider echoed fixture-enterprise-credential"}}\n\n', /模型流返回错误/],
  ] as const;
  for (const [stream, pattern] of cases) {
    const baseUrl = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(stream); });
    await assert.rejects(modelReply(config(baseUrl), [{ role: 'user', content: 'hello' }], new AbortController().signal, () => {}), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes('fixture-enterprise-credential'), false);
      return true;
    });
  }
});

test('HTTP failure excludes credential-bearing response body', async t => {
  const baseUrl = await fixture(t, (_request, response) => { response.writeHead(429); response.end('invalid API key: fixture-enterprise-credential'); });
  await assert.rejects(modelReply(config(baseUrl), [{ role: 'user', content: 'hello' }], new AbortController().signal, () => {}), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes('fixture-enterprise-credential'), false);
    return true;
  });
});

test('cancelling a live stream rejects the request and closes its connection', async t => {
  let disconnected = false;
  const baseUrl = await fixture(t, (_request, response) => {
    response.on('close', () => { disconnected = true; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fixture cancellation')), 100);
  try {
    await assert.rejects(modelReply(config(baseUrl), [{ role: 'user', content: 'hello' }], controller.signal, () => {}));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(disconnected, true);
  } finally { clearTimeout(timer); }
});

test('configuration rejects remote cleartext, URL credentials, controls and unknown configuration fields', () => {
  const good = config('http://127.0.0.1:18080/v1');
  for (const bad of [
    { ...good, baseUrl: 'http://remote.example/v1' },
    { ...good, baseUrl: 'https://username:password@example.com/v1' },
    { ...good, baseUrl: 'https://example.com/v1?apiKey=value' },
    { ...good, maxOutput: good.contextWindow },
    { ...good, apiKey: 'fixture-enterprise-credential\r\ninjected: true' },
    { ...good, model: 'model\u0000name' },
    { ...good, executeCommand: 'forbidden-extra-setting' },
  ]) assert.throws(() => validateModelConfig(bad));
});

test('fragmented function-call arguments survive streaming and a text-free tool turn is valid',async t=>{
  const baseUrl=await fixture(t,(_request,response,body)=>{
    assert.equal(body.tools[0].function.name,'lookup');
    response.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'lookup',arguments:'{"que'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'ry":"cells"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}])response.write('data: '+JSON.stringify(event)+'\n\n');
    response.end('data: [DONE]'); // Terminal event without a final newline.
  });
  const result=await modelTurn(config(baseUrl),[{role:'user',content:'lookup cells'}],new AbortController().signal,()=>{},[{name:'lookup',description:'lookup',parameters:{type:'object'}}]);
  assert.equal(result.text,'');assert.deepEqual(result.toolCalls,[{id:'call-1',name:'lookup',arguments:'{"query":"cells"}'}]);
});
test('truncated answers and rejected API calls have truthful completion/retry semantics',async t=>{
  const short=await fixture(t,(_r,response)=>{response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');});
  await assert.rejects(modelReply(config(short),[{role:'user',content:'hello'}],new AbortController().signal,()=>{}),/截断/);
  const limited=await fixture(t,(_r,response)=>{response.writeHead(429,{'retry-after':'1'});response.end('credential-bearing error fixture-enterprise-credential');});
  await assert.rejects(modelReply(config(limited),[{role:'user',content:'hello'}],new AbortController().signal,()=>{}),e=>e instanceof ModelApiError&&e.definitive&&e.retryable&&e.retryAfterMs===1000&&!e.message.includes('fixture-enterprise-credential'));
});
test('Anthropic tool blocks and tool results preserve native protocol semantics',async t=>{
  const baseUrl=await fixture(t,(_r,response,body)=>{
    assert.equal(body.messages[1].content[0].type,'tool_use');assert.equal(body.messages[2].content[0].type,'tool_result');
    response.writeHead(200,{'content-type':'text/event-stream'});
    const events=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'native-1',name:'lookup',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"query":"cells"}'}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
    response.end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  });
  const result=await modelTurn(config(baseUrl,'anthropic'),[{role:'user',content:'hello'},{role:'assistant',content:'',tool_calls:[{id:'previous',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'previous',content:'{"result":1}'}],new AbortController().signal,()=>{},[{name:'lookup',description:'lookup',parameters:{type:'object'}}]);
  assert.deepEqual(result.toolCalls,[{id:'native-1',name:'lookup',arguments:'{"query":"cells"}'}]);
});
