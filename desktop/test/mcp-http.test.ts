import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpHttpSession } from '../src/mcp-client.js';

test('Streamable HTTP uses initialized notification, session headers, pagination and actual tool output',async t=>{
  let initialized=false,called=false,deleted=false;
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){deleted=true;res.writeHead(204);res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const m=JSON.parse(raw);
    if(m.method==='initialize'){res.setHeader('mcp-session-id','session-1');res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'http-regression'}}}));return;}
    assert.equal(req.headers['mcp-session-id'],'session-1');assert.equal(req.headers['mcp-protocol-version'],'2025-03-26');
    if(m.method==='notifications/initialized'){initialized=true;res.writeHead(202);res.end();return;}
    assert.equal(initialized,true);
    const result=m.method==='tools/list'?{tools:[{name:m.params.cursor?'second':'first'}],...(m.params.cursor?{}:{nextCursor:'page2'})}:(called=true,{content:[{type:'text',text:'Plain text result'}]});
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{}})+'\n\n');res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n\n');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();assert.ok(address&&typeof address==='object');
  const client=new McpHttpSession(`http://127.0.0.1:${address.port}/mcp`);const signal=new AbortController().signal;
  await client.initialize(signal);assert.deepEqual((await client.listTools(signal)).map(x=>x.name),['first','second']);
  assert.equal((await client.callTool('first',{},signal) as any).text,'Plain text result');await client.close();assert.equal(called,true);assert.equal(deleted,true);
});
