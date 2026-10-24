import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { Json } from './harness/types.js';
import { safeError } from './security.js';

const VERSION = '2025-03-26'; const MAX_FRAME = 2_000_000;
interface Pending { method: string; resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }
export interface McpClientOptions { requestTimeoutMs?: number; maxFrameBytes?: number; closeTransport?: () => Promise<void> | void }
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** JSON-lines protocol session; stream injection lets tests avoid network and arbitrary executable paths. */
export class McpClientSession {
  private nextId = 1; private initialized = false; private closed = false; private buffer = '';
  private closing?: Promise<void>; private pending = new Map<number, Pending>(); private decoder = new StringDecoder('utf8');
  constructor(private readonly source: Readable, private readonly sink: Writable, private readonly options: McpClientOptions = {}) {
    source.on('data', this.onData); source.once('end', () => this.fail(new Error('MCP server closed its output')));
    source.once('error', error => this.fail(asError(error))); sink.once('error', error => this.fail(asError(error)));
  }
  private send(value: unknown): void {
    if (this.closed || this.sink.destroyed || this.sink.writableEnded) throw new Error('MCP session is closed');
    const line = JSON.stringify(value); if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? MAX_FRAME)) throw new Error('MCP outgoing frame limit exceeded');
    this.sink.write(line + '\n');
  }
  notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(asError(signal.reason ?? new Error('MCP request aborted')));
    if (this.closed) return Promise.reject(new Error('MCP session is closed'));
    if (this.pending.size >= 8) return Promise.reject(new Error('MCP pending-request limit exceeded'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (reason: Error): void => {
        const entry = this.pending.get(id); if (!entry) return;
        this.pending.delete(id); clearTimeout(entry.timer); entry.cleanup();
        // Lifecycle forbids cancellation of initialize; closing its transport is sufficient.
        if (method !== 'initialize') try { this.notify('notifications/cancelled', { requestId: id, reason: 'Client cancelled or timed out' }); } catch {}
        reject(reason);
      };
      const onAbort = () => cancel(asError(signal?.reason ?? new Error('MCP request aborted')));
      const timer = setTimeout(() => cancel(new Error(`MCP ${method} timed out`)), this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { method, resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(asError(error)); }
    });
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) throw new Error('MCP session already initialized');
    const response = await this.request('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'suwen-harness', version: '1.0.0' } }, signal);
    if (response?.protocolVersion !== VERSION || !response?.capabilities?.tools || typeof response?.serverInfo?.name !== 'string') throw new Error('Incompatible MCP version or missing tools capability');
    this.notify('notifications/initialized'); this.initialized = true;
  }
  async listTools(signal?: AbortSignal): Promise<any[]> {
    if (!this.initialized) throw new Error('MCP initialization required');
    const result = await this.request('tools/list', {}, signal); if (!Array.isArray(result?.tools)) throw new Error('Malformed MCP tools/list result'); return result.tools;
  }
  async callTool(name: string, args: Record<string, Json>, signal?: AbortSignal): Promise<Json> {
    if (!this.initialized) throw new Error('MCP initialization required');
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    if (!result || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0]?.text !== 'string') throw new Error('Malformed MCP tool result');
    if (result.isError) throw new Error(`MCP tool failed: ${safeError(result.content[0].text)}`);
    try { return JSON.parse(result.content[0].text) as Json; } catch { throw new Error('MCP database result is not JSON'); }
  }
  private receive = (message: any): void => {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') throw new Error('Invalid MCP response envelope');
    if (typeof message.method === 'string') {
      // This client grants no sampling, roots, filesystem, or other server-requested capabilities.
      if (Object.hasOwn(message, 'id')) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method unavailable' } });
      return;
    }
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid MCP response ID');
    const entry = this.pending.get(message.id); if (!entry) return; // Ignore late cancelled responses.
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('MCP response must contain exactly one result or error');
    if (Object.hasOwn(message, 'error') && (!message.error || typeof message.error !== 'object' || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) throw new Error('Malformed MCP error response');
    this.pending.delete(message.id); clearTimeout(entry.timer); entry.cleanup();
    if (message.error) entry.reject(new Error(`MCP protocol error ${message.error.code}: ${safeError(message.error.message)}`)); else entry.resolve(message.result);
  };
  private onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    try {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      let boundary: number;
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, boundary).replace(/\r$/, ''); this.buffer = this.buffer.slice(boundary + 1);
        if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? MAX_FRAME)) throw new Error('MCP incoming frame limit exceeded');
        const value = JSON.parse(line); if (Array.isArray(value)) { if (!value.length || value.length > 32) throw new Error('Invalid MCP response batch'); for (const message of value) this.receive(message); } else this.receive(value);
      }
      if (Buffer.byteLength(this.buffer) > (this.options.maxFrameBytes ?? MAX_FRAME)) throw new Error('MCP incoming frame limit exceeded');
    } catch (error) { this.fail(asError(error)); }
  };
  private fail(error: Error): void {
    if (this.closed) return;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.cleanup(); entry.reject(error); } this.pending.clear();
    void this.close().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.method !== 'initialize' && !this.sink.destroyed && !this.sink.writableEnded) this.sink.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Client session closing' } }) + '\n');
      clearTimeout(entry.timer); entry.cleanup(); entry.reject(new Error('MCP session closed'));
    }
    this.pending.clear(); this.source.off('data', this.onData);
    if (!this.sink.destroyed && !this.sink.writableEnded) this.sink.end();
    this.closing = Promise.resolve().then(() => this.options.closeTransport?.()); return this.closing;
  }
}

let children = 0;
/** Fixed bundled server only: no command, shell, executable, or server-path setting exists. */
export function createDatabaseMcpClient(): McpClientSession {
  if (children >= 4) throw new Error('MCP subprocess concurrency limit reached'); children++;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-server.js', import.meta.url))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_USE_ENV_PROXY: '1' } });
  let finished = false;
  const closed = new Promise<void>(resolve => child.once('close', () => { finished = true; children--; resolve(); }));
  const wait = async (ms: number): Promise<void> => { if (finished) return; let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); if (timer) clearTimeout(timer); };
  const session = new McpClientSession(child.stdout!, child.stdin!, { closeTransport: async () => { await wait(300); if (!finished) { child.kill('SIGTERM'); await wait(300); } if (!finished) { child.kill('SIGKILL'); await wait(1000); } if (!finished) throw new Error('MCP child did not exit after forced cleanup'); } });
  child.once('error', () => { void session.close().catch(() => {}); });
  return session;
}
export async function queryViaMcp(kind: 'pubmed' | 'uniprot', query: string, signal: AbortSignal): Promise<Json> {
  if (!['pubmed', 'uniprot'].includes(kind) || typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Invalid MCP database query');
  if (signal.aborted) throw asError(signal.reason ?? new Error('MCP request aborted'));
  const client = createDatabaseMcpClient();
  try {
    await client.initialize(signal); const name = `${kind}_search`;
    const tools = await client.listTools(signal); if (!tools.some(tool => tool?.name === name)) throw new Error('Bundled MCP tool unavailable');
    return await client.callTool(name, { query }, signal);
  } finally { await client.close(); }
}
