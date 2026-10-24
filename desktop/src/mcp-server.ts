import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { queryDatabase } from './databases.js';
import { safeError } from './security.js';

export const MCP_VERSION = '2025-03-26';
export const DATABASE_TOOLS = [
  { name: 'pubmed_search', description: 'Read-only literature search through the Europe PMC public API, retaining PubMed identifiers when available.' },
  { name: 'uniprot_search', description: 'Read-only protein search through the UniProt public API.' }
].map(tool => ({ ...tool, inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Public scientific search query. Do not include credentials or private patient information.' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));
type Id = number | string;
type Message = Record<string, any>;
type Query = (kind: 'pubmed' | 'uniprot', query: string, signal: AbortSignal) => Promise<unknown>;
export interface McpServerOptions { query?: Query; timeoutMs?: number; maxConcurrent?: number; maxCalls?: number; maxFrameBytes?: number }
const object = (value: unknown): value is Message => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is Id => typeof value === 'string' && value.length <= 128 || typeof value === 'number' && Number.isSafeInteger(value);
const error = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Fixed SuWen database MCP server; injected query is for protocol tests, never a CLI option. */
export function createMcpServer(input: Readable, output: Writable, options: McpServerOptions = {}): { close(): void } {
  const query = options.query ?? queryDatabase; const maxFrame = options.maxFrameBytes ?? 2_000_000;
  const active = new Map<Id, AbortController>(); const seen = new Set<Id>();
  let negotiated = false, initialized = false, closed = false, buffer = '', calls = 0;
  const decoder = new StringDecoder('utf8');
  const write = (value: unknown): void => {
    if (closed || output.destroyed) return;
    let text = JSON.stringify(value);
    if (Buffer.byteLength(text) > maxFrame) text = JSON.stringify(error(object(value) && validId(value.id) ? value.id : null, -32001, 'MCP response exceeds frame limit'));
    if (output.writableLength > maxFrame) { close(); return; }
    output.write(text + '\n');
  };
  const dispatch = async (message: unknown, batch = false): Promise<unknown | undefined> => {
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Object.hasOwn(message, 'id') && !validId(message.id)) return error(null, -32600, 'Invalid JSON-RPC request');
    const notification = !Object.hasOwn(message, 'id'); const id = notification ? null : message.id as Id;
    if (notification) {
      if (message.method === 'notifications/initialized' && negotiated) initialized = true;
      if (message.method === 'notifications/cancelled' && validId(message.params?.requestId)) active.get(message.params.requestId)?.abort(new Error('MCP request cancelled'));
      return undefined;
    }
    if (seen.has(id!)) return error(id, -32600, 'Request ID reused');
    if (seen.size >= 1024) return error(id, -32001, 'MCP session request limit reached'); seen.add(id!);
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'initialize') {
      const p = message.params;
      if (batch || negotiated || !object(p) || typeof p.protocolVersion !== 'string' || !object(p.capabilities) || !object(p.clientInfo) || typeof p.clientInfo.name !== 'string' || typeof p.clientInfo.version !== 'string') return error(id, -32602, 'Invalid initialization');
      negotiated = true;
      return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'suwen-public-databases', version: '1.0.0' } } };
    }
    if (!initialized) return error(id, -32002, 'MCP initialization required');
    if (message.method === 'tools/list') {
      if (message.params !== undefined && (!object(message.params) || message.params.cursor !== undefined)) return error(id, -32602, 'This fixed tool list has no pagination cursor');
      return { jsonrpc: '2.0', id, result: { tools: DATABASE_TOOLS } };
    }
    if (message.method !== 'tools/call') return error(id, -32601, 'Method not found');
    const p = message.params; const args = p?.arguments;
    if (!object(p) || !['pubmed_search', 'uniprot_search'].includes(p.name) || !object(args) || Object.keys(args).some(key => key !== 'query') || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) return error(id, -32602, 'Expected a supported tool and query string of 1-1000 characters');
    if (active.size >= (options.maxConcurrent ?? 2) || calls >= (options.maxCalls ?? 100)) return error(id, -32001, 'MCP tool resource limit reached');
    calls++; const controller = new AbortController(); active.set(id!, controller);
    const timeout = setTimeout(() => controller.abort(new Error('MCP tool timed out')), options.timeoutMs ?? 25000);
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      const result = await Promise.race([query(p.name === 'pubmed_search' ? 'pubmed' : 'uniprot', args.query, controller.signal), cancelled]);
      if (controller.signal.aborted || closed) return undefined;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } };
    } catch (failure) {
      if (closed || controller.signal.aborted && controller.signal.reason?.message === 'MCP request cancelled') return undefined;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: safeError(failure) }], isError: true } };
    } finally { clearTimeout(timeout); if (onAbort) controller.signal.removeEventListener('abort', onAbort); active.delete(id!); }
  };
  const processLine = (line: string): void => {
    let value: unknown; try { value = JSON.parse(line); } catch { write(error(null, -32700, 'Invalid JSON')); return; }
    if (Array.isArray(value)) {
      if (!value.length || value.length > 32) { write(error(null, -32600, 'Invalid or oversized batch')); return; }
      void Promise.all(value.map(message => dispatch(message, true))).then(responses => { const results = responses.filter(result => result !== undefined); if (results.length) write(results); }).catch(() => write(error(null, -32603, 'Internal protocol error')));
    } else void dispatch(value).then(response => { if (response !== undefined) write(response); }).catch(() => write(error(null, -32603, 'Internal protocol error')));
  };
  const onData = (chunk: Buffer | string): void => {
    if (closed) return; buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).replace(/\r$/, ''); buffer = buffer.slice(boundary + 1);
      if (Buffer.byteLength(line) > maxFrame) { write(error(null, -32001, 'MCP request frame too large')); close(); return; }
      if (line.trim()) processLine(line);
    }
    if (Buffer.byteLength(buffer) > maxFrame) { write(error(null, -32001, 'MCP request frame too large')); close(); }
  };
  const close = (): void => { if (closed) return; closed = true; for (const controller of active.values()) controller.abort(new Error('MCP transport closed')); input.off('data', onData); output.end(); };
  input.on('data', onData); input.once('end', close); input.once('error', close); output.once('error', close);
  return { close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createMcpServer(process.stdin, process.stdout);
  process.once('SIGTERM', () => { server.close(); process.stdin.destroy(); });
  process.once('SIGINT', () => { server.close(); process.stdin.destroy(); });
}
