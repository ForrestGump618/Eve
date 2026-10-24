import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMcpServer, DATABASE_TOOLS, MCP_VERSION } from '../src/mcp-server.js';
import { McpClientSession, createDatabaseMcpClient, queryViaMcp } from '../src/mcp-client.js';
import type { McpServerOptions } from '../src/mcp-server.js';

function pair(options: McpServerOptions = {}, requestTimeoutMs = 1000) {
  const requests = new PassThrough(); const responses = new PassThrough(); let cleaned = 0;
  const server = createMcpServer(requests, responses, options);
  const client = new McpClientSession(responses, requests, { requestTimeoutMs, closeTransport: () => { cleaned++; server.close(); } });
  return { client, server, requests, responses, cleaned: () => cleaned };
}
test('bundled MCP schemas expose exactly two read-only scientific searches', () => {
  assert.equal(MCP_VERSION, '2025-03-26'); assert.deepEqual(DATABASE_TOOLS.map(tool => tool.name), ['pubmed_search', 'uniprot_search']);
  for (const tool of DATABASE_TOOLS) {
    assert.deepEqual(tool.inputSchema.required, ['query']); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.query.maxLength, 1000); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
  }
});
test('initialize and tools/list operate over a real fixed child process without network access', { timeout: 5000 }, async () => {
  const client = createDatabaseMcpClient();
  try { await client.initialize(); assert.deepEqual((await client.listTools()).map(tool => tool.name), ['pubmed_search', 'uniprot_search']); }
  finally { await client.close(); }
});
test('protocol handshake, argument schemas and JSON tool results are validated using a local query fixture', async () => {
  const observed: unknown[] = [];
  const p = pair({ query: async (kind, query) => { observed.push({ kind, query }); return { database: kind, query, results: [{ id: 'fixture', title: '纯离线协议测试' }] }; } });
  try {
    await assert.rejects(p.client.request('tools/list'), /initialization required/);
    await p.client.initialize(); assert.equal((await p.client.listTools()).length, 2);
    for (const args of [{}, { query: '' }, { query: 'x'.repeat(1001) }, { query: 'tp53', command: 'forbidden' }]) await assert.rejects(p.client.request('tools/call', { name: 'pubmed_search', arguments: args }), /-32602/);
    await assert.rejects(p.client.request('tools/call', { name: 'shell', arguments: { query: 'tp53' } }), /-32602/);
    const result = await p.client.callTool('pubmed_search', { query: 'tp53' }); assert.equal((result as any).results[0].title, '纯离线协议测试');
    assert.deepEqual(observed, [{ kind: 'pubmed', query: 'tp53' }]);
  } finally { await p.client.close(); }
  assert.equal(p.cleaned(), 1);
});
test('client parses fragmented UTF-8 frames, response batches and notification traffic', async () => {
  const source = new PassThrough(); const sink = new PassThrough(); let requestBuffer = '';
  sink.on('data', chunk => {
    requestBuffer += chunk.toString(); let boundary: number;
    while ((boundary = requestBuffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(requestBuffer.slice(0, boundary)); requestBuffer = requestBuffer.slice(boundary + 1);
      if (!Object.hasOwn(request, 'id')) continue;
      const result = request.method === 'initialize' ? { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'offline-fragment-fixture' } } : { content: [{ type: 'text', text: JSON.stringify({ title: '细胞🧬' }) }], isError: false };
      const bytes = Buffer.from(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/message', params: {} }, { jsonrpc: '2.0', id: request.id, result }]) + '\n');
      // Every byte is a separate chunk, including bytes within multibyte characters.
      for (const byte of bytes) source.write(Buffer.from([byte]));
    }
  });
  const client = new McpClientSession(source, sink);
  try { await client.initialize(); assert.deepEqual(await client.callTool('pubmed_search', { query: 'cell' }), { title: '细胞🧬' }); }
  finally { await client.close(); source.destroy(); sink.destroy(); }
});
test('tool failures are distinguished from protocol errors and credentials are sanitized', async () => {
  const p = pair({ query: async () => { throw new Error('Fixture API failure api_key=synthetic-secret'); } });
  try { await p.client.initialize(); await assert.rejects(p.client.callTool('uniprot_search', { query: 'TP53' }), error => error instanceof Error && /MCP tool failed/.test(error.message) && !error.message.includes('synthetic-secret')); }
  finally { await p.client.close(); }
});
test('cancellation and request timeout abort query work, ignore late replies, and close transport once', async () => {
  for (const cancellation of ['signal', 'timeout'] as const) {
    let aborted = false;
    const p = pair({ query: async (_kind, _query, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve({ late: true }); }, { once: true }); }) }, cancellation === 'timeout' ? 20 : 1000);
    const controller = new AbortController();
    try {
      await p.client.initialize(); const pending = p.client.callTool('pubmed_search', { query: 'offline' }, controller.signal);
      if (cancellation === 'signal') controller.abort(new Error('fixture cancelled'));
      await assert.rejects(pending, cancellation === 'signal' ? /fixture cancelled/ : /timed out/); await sleep(5); assert.equal(aborted, true);
    } finally { await p.client.close(); await p.client.close(); }
    assert.equal(p.cleaned(), 1);
  }
});
test('server enforces concurrency and call limits and bounds tool time', async () => {
  let completed = false;
  const p = pair({ maxConcurrent: 1, maxCalls: 1, timeoutMs: 25, query: async () => new Promise(() => {}) });
  try {
    await p.client.initialize(); const first = p.client.callTool('pubmed_search', { query: 'one' }).catch(error => { completed = true; throw error; });
    await assert.rejects(p.client.callTool('uniprot_search', { query: 'two' }), /resource limit/);
    await assert.rejects(first, /timed out/); assert.equal(completed, true);
    await assert.rejects(p.client.callTool('pubmed_search', { query: 'three' }), /resource limit/);
  } finally { await p.client.close(); }
});
test('invalid stdout and oversized frames fail pending requests and invoke cleanup', async () => {
  for (const frame of ['not-json\n', 'x'.repeat(513)]) {
    const source = new PassThrough(); const sink = new PassThrough(); let cleanup = 0;
    const client = new McpClientSession(source, sink, { maxFrameBytes: 512, closeTransport: () => { cleanup++; } });
    const pending = client.request('initialize'); source.write(frame);
    await assert.rejects(pending); await client.close(); assert.equal(cleanup, 1); source.destroy(); sink.destroy();
  }
});
test('pre-aborted and invalid database requests are rejected before launching a child', async () => {
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  await assert.rejects(queryViaMcp('pubmed', 'offline', controller.signal), /already cancelled/);
  await assert.rejects(queryViaMcp('pubmed', '', new AbortController().signal), /Invalid/);
  await assert.rejects(queryViaMcp('arbitrary-command' as any, 'offline', new AbortController().signal), /Invalid/);
});
test('initialization cancellation closes cleanly without a forbidden initialize cancellation notification', async () => {
  const source = new PassThrough(); const sink = new PassThrough(); const frames: any[] = [];
  sink.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) frames.push(JSON.parse(line)); });
  const client = new McpClientSession(source, sink); const controller = new AbortController();
  const pending = client.initialize(controller.signal); controller.abort(new Error('stop initialization'));
  await assert.rejects(pending, /stop initialization/); await client.close();
  assert.deepEqual(frames.map(frame => frame.method), ['initialize']); source.destroy(); sink.destroy();
});
test('server supports post-initialization batches and emits a parse error for malformed JSON', async () => {
  const p = pair({ query: async () => null });
  try {
    await p.client.initialize(); const lines: any[] = []; p.responses.on('data', chunk => lines.push(JSON.parse(chunk.toString())));
    p.requests.write(JSON.stringify([{ jsonrpc: '2.0', id: 100, method: 'tools/list' }, { jsonrpc: '2.0', id: 101, method: 'ping' }]) + '\n');
    await sleep(1); assert.ok(lines.some(line => Array.isArray(line) && line.length === 2 && line[0].id === 100 && line[1].id === 101));
    p.requests.write('not-json\n'); await sleep(1); assert.ok(lines.some(line => line.error?.code === -32700));
  } finally { await p.client.close(); }
});
