import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { McpClientSession, McpHttpSession } from '../mcp-client.js';
import { ConflictError, ValidationError, type Json } from '../harness/types.js';
import { safeError } from '../security.js';
import { parseMcpResult } from '../mcp-result.js';
import { validateArguments } from '../harness/tool-registry.js';
import type { McpServerView, RecordRow, RecordStore, SkillView, WorkerClient } from '../shared/contract.js';

/** Minimal injectable fetch surface; tests pass a deterministic fake and never touch the public network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Secret references are resolved only at call time; resolved values are never persisted or logged. */
export type SecretResolver = (ref: string) => string | undefined | Promise<string | undefined>;

/** Dependencies injected into the tool-domain services. */
export interface ToolDeps {
  store: RecordStore;
  home: string;
  clock?: () => number;
  worker?: WorkerClient;
  fetch?: FetchLike;
  secrets?: SecretResolver;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const clockOf = (deps: ToolDeps): number => (deps.clock ?? Date.now)();

function failureMessage(value: unknown): string {
  return safeError(value instanceof Error ? value.message : value);
}

/** Replace every literal secret value with a stable marker; used before errors are surfaced. */
export function redactSecretValues(message: string, values: Iterable<string>): string {
  let out = message;
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) out = out.split(value).join('[redacted]');
  }
  return safeError(out);
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || CONTROL.test(value)) {
    throw new ValidationError(`${name} must be a string of ${min}..${max} printable characters`);
  }
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, 1, max);
}

function plainObject(value: unknown, name: string): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, Json>;
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordData(row: RecordRow): Record<string, Json> {
  return row.data as unknown as Record<string, Json>;
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

// ---------------------------------------------------------------------------
// MCP registry
// ---------------------------------------------------------------------------

export const MCP_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Environment variables a spawned MCP server may never inherit or receive. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV', 'IFS', 'SHELL', 'COMSPEC',
  'ELECTRON_RUN_AS_NODE', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);
const SAFE_BASE_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'USERNAME', 'LANG', 'LC_ALL',
];

export interface McpEnvRef { name: string; ref: string }
export interface McpHeaderRef { name: string; ref: string }

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Json;
}

export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }

export interface McpProbeTool extends McpToolDescriptor { annotations?: McpToolAnnotations }

export interface McpProbeResult {
  tools: McpProbeTool[];
  serverInfo: { name: string; version?: string } | null;
}

export interface McpServerInput {
  id?: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env: McpEnvRef[];
  headers: McpHeaderRef[];
  readOnly: boolean;
  enabled: boolean;
  projects: string[];
}

/** Persisted data for kind `mcpServer`; extends the frozen view with env refs and tool annotations. */
export interface McpServerRecordData extends McpServerView {
  env: McpEnvRef[];
  headers: McpHeaderRef[];
  projects: string[];
  toolAnnotations: Array<{ name: string; annotations: McpToolAnnotations }>;
}

export type McpProbe = (server: McpServerRecordData, signal: AbortSignal) => Promise<McpProbeResult>;
export type McpToolCaller = (server: McpServerRecordData, tool: string, args: Record<string, Json>, signal: AbortSignal) => Promise<Json>;

export interface McpRegistryOptions {
  prober?: McpProbe;
  caller?: McpToolCaller;
  healthTimeoutMs?: number;
  proxyEnv?: Record<string, string>;
}

function envRefEntries(value: unknown): McpEnvRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError('env must be an array of {name, ref} entries');
  if (value.length > 32) throw new ValidationError('env supports at most 32 entries');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = plainObject(entry, `env[${index}]`);
    const name = requireString(item.name, `env[${index}].name`, 1, 64);
    if (!MCP_ENV_NAME.test(name)) throw new ValidationError(`env[${index}].name must match ${MCP_ENV_NAME}`);
    if (RESERVED_ENV_KEYS.has(name)) throw new ValidationError(`env[${index}].name ${name} is reserved and cannot be forwarded`);
    const ref = requireString(item.ref, `env[${index}].ref`, 1, 160);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,159}$/.test(ref)) throw new ValidationError(`env[${index}].ref must be a secret reference name`);
    if (seen.has(name)) throw new ValidationError(`env name ${name} is duplicated`);
    seen.add(name);
    return { name, ref };
  });
}

const MCP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_MCP_HEADER_NAMES: ReadonlySet<string> = new Set([
  'accept', 'connection', 'content-length', 'content-type', 'host', 'mcp-protocol-version', 'mcp-session-id',
  'transfer-encoding', 'upgrade',
]);

function headerRefEntries(value: unknown): McpHeaderRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError('headers must be an array of {name, ref} entries');
  if (value.length > 32) throw new ValidationError('headers supports at most 32 entries');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = plainObject(entry, `headers[${index}]`);
    const name = requireString(item.name, `headers[${index}].name`, 1, 128);
    if (!MCP_HEADER_NAME.test(name)) throw new ValidationError(`headers[${index}].name is not a valid HTTP header name`);
    if (RESERVED_MCP_HEADER_NAMES.has(name.toLowerCase())) throw new ValidationError(`headers[${index}].name ${name} is reserved`);
    const ref = requireString(item.ref, `headers[${index}].ref`, 1, 160);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,159}$/.test(ref)) throw new ValidationError(`headers[${index}].ref must be a secret reference name`);
    if (seen.has(name.toLowerCase())) throw new ValidationError(`header name ${name} is duplicated`);
    seen.add(name.toLowerCase());
    return { name, ref };
  });
}

function validatedArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new ValidationError('args must be an array with at most 64 entries');
  return value.map((arg, index) => requireString(arg, `args[${index}]`, 0, 2000));
}

function projectIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new ValidationError('projects must be an array with at most 50 project ids');
  return value.map((id, index) => requireString(id, `projects[${index}]`, 1, 200));
}

/** Validate an MCP add/update payload; secret values are rejected because only secret references are accepted. */
export function validateMcpServer(input: Json, existing?: McpServerRecordData): McpServerInput {
  const value = plainObject(input, 'mcp server');
  const name = requireString(value.name, 'name', 1, 120).trim();
  if (!name) throw new ValidationError('name must not be blank');
  const transport = value.transport;
  if (transport !== 'stdio' && transport !== 'http') throw new ValidationError("transport must be 'stdio' or 'http'");
  const readOnly = bool(value.readOnly, 'readOnly', existing?.readOnly ?? true);
  const enabled = bool(value.enabled, 'enabled', existing?.enabled ?? true);
  const env = value.env === undefined ? (existing?.env ?? []) : envRefEntries(value.env);
  const headers = value.headers === undefined ? (existing?.headers ?? []) : headerRefEntries(value.headers);
  const projects = value.projects === undefined ? (existing?.projects ?? []) : projectIds(value.projects);
  const out: McpServerInput = { name, transport, readOnly, enabled, env, headers, projects };
  if (existing?.id) out.id = existing.id;
  if (typeof value.id === 'string') out.id = requireString(value.id, 'id', 1, 200);
  if (transport === 'stdio') {
    const command = requireString(value.command, 'command', 1, 1000);
    if (!/^[A-Za-z0-9_./\\:\- ]+$/.test(command) || /(?:^|\s)(?:&&|\|\||;|`)/.test(command)) {
      throw new ValidationError('command must be a bare executable or absolute path without shell metacharacters');
    }
    if (typeof value.url === 'string') throw new ValidationError('stdio servers must not define url');
    if (headers.length) throw new ValidationError('stdio servers must not define HTTP headers');
    out.command = command;
    out.args = validatedArgs(value.args) ?? existing?.args ?? [];
  } else {
    const raw = requireString(value.url, 'url', 8, 2000);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new ValidationError('url must be a valid http(s) URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError('url must use http or https');
    if (parsed.username || parsed.password) throw new ValidationError('url must not embed credentials; use secret references');
    if (typeof value.command === 'string') throw new ValidationError('http servers must not define command');
    if (value.args !== undefined) throw new ValidationError('http servers must not define args');
    out.url = raw;
  }
  return out;
}

function mcpEnv(server: McpServerRecordData, secrets: SecretResolver | undefined, proxyEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_BASE_ENV) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (proxyEnv) for (const [key, value] of Object.entries(proxyEnv)) if (MCP_ENV_NAME.test(key)) env[key] = value;
  for (const entry of server.env) {
    const resolved = secrets?.(entry.ref);
    if (resolved instanceof Promise) throw new ValidationError(`secret reference ${entry.ref} must resolve synchronously for stdio servers`);
    if (typeof resolved !== 'string' || !resolved.length) throw new ValidationError(`MCP secret reference unavailable: ${entry.ref}`);
    env[entry.name] = resolved;
  }
  return env;
}

function mcpHeaders(server: McpServerRecordData, secrets: SecretResolver | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of server.headers) {
    const resolved = secrets?.(entry.ref);
    if (resolved instanceof Promise) throw new ValidationError(`secret reference ${entry.ref} must resolve synchronously for HTTP headers`);
    if (typeof resolved !== 'string' || !resolved.length) throw new ValidationError(`MCP secret reference unavailable: ${entry.ref}`);
    headers[entry.name] = resolved;
  }
  return headers;
}

interface StdioSession {
  session: McpClientSession;
  failure: Promise<never>;
  handshakeComplete: () => void;
}

function openStdioSession(server: McpServerRecordData, secrets: SecretResolver | undefined, proxyEnv: Record<string, string> | undefined, timeoutMs: number): StdioSession {
  if (typeof server.command !== 'string') throw new ValidationError('MCP stdio server is missing command');
  const child = spawn(server.command, server.args ?? [], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: mcpEnv(server, secrets, proxyEnv),
  });
  let exited = false;
  let handshake = false;
  const failure = new Promise<never>((_, reject) => {
    child.once('error', error => reject(new Error(`Failed to start MCP server: ${failureMessage(error)}`)));
    child.once('exit', (code, signal) => {
      exited = true;
      if (!handshake) reject(new Error(`MCP server exited early (${signal ?? code ?? 'unknown'})`));
    });
  });
  failure.catch(() => { /* raced or ignored after handshake */ });
  let closed = false;
  const session = new McpClientSession(child.stdout!, child.stdin!, {
    requestTimeoutMs: timeoutMs,
    closeTransport: async () => {
      if (closed) return;
      closed = true;
      if (exited) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 750);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
      });
    },
  });
  return { session, failure, handshakeComplete: () => { handshake = true; } };
}

function probeTool(tool: unknown): McpProbeTool {
  const item = plainObject(tool, 'tool');
  const name = requireString(item.name, 'tool name', 1, 128);
  const out: McpProbeTool = { name };
  if (typeof item.description === 'string') out.description = item.description.slice(0, 2000);
  if (item.inputSchema !== undefined) out.inputSchema = item.inputSchema;
  if (item.annotations !== undefined) {
    const annotations = plainObject(item.annotations, 'annotations');
    const kept: McpToolAnnotations = {};
    if (typeof annotations.readOnlyHint === 'boolean') kept.readOnlyHint = annotations.readOnlyHint;
    if (typeof annotations.destructiveHint === 'boolean') kept.destructiveHint = annotations.destructiveHint;
    if (typeof annotations.idempotentHint === 'boolean') kept.idempotentHint = annotations.idempotentHint;
    if (Object.keys(kept).length) out.annotations = kept;
  }
  return out;
}

/** Default MCP prober: real stdio child process (McpClientSession) or HTTP JSON-RPC handshake. */
export function createMcpProbe(options: { secrets?: SecretResolver; timeoutMs?: number; fetch?: FetchLike; proxyEnv?: Record<string, string> } = {}): McpProbe {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000));
  return async (server, signal) => {
    if (server.transport === 'stdio') {
      const opened = openStdioSession(server, options.secrets, options.proxyEnv, timeoutMs);
      try {
        await withDeadline(Promise.race([opened.session.initialize(signal), opened.failure]), timeoutMs, 'MCP initialize');
        opened.handshakeComplete();
        const tools = await withDeadline(Promise.race([opened.session.listTools(signal), opened.failure]), timeoutMs, 'MCP tools/list');
        return { tools: tools.map(tool => probeTool(tool)), serverInfo: null };
      } finally {
        await opened.session.close();
      }
    }
    const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const session=new McpHttpSession(server.url!,fetchImpl as typeof fetch,timeoutMs,mcpHeaders(server,options.secrets));
    try{await session.initialize(signal);return {tools:(await session.listTools(signal)).map((tool:unknown)=>probeTool(tool)),serverInfo:null};}finally{await session.close();}
  };
}

/** Default MCP tool caller; refuses malformed results and never echoes tool payloads into errors. */
export function createMcpToolCaller(options: { secrets?: SecretResolver; timeoutMs?: number; fetch?: FetchLike; proxyEnv?: Record<string, string> } = {}): McpToolCaller {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000));
  return async (server, tool, args, signal) => {
    if (server.transport === 'stdio') {
      const opened = openStdioSession(server, options.secrets, options.proxyEnv, timeoutMs);
      try {
        await withDeadline(Promise.race([opened.session.initialize(signal), opened.failure]), timeoutMs, 'MCP initialize');
        opened.handshakeComplete();
        return await withDeadline(Promise.race([opened.session.callTool(tool, args, signal), opened.failure]), timeoutMs, 'MCP tools/call');
      } finally {
        await opened.session.close();
      }
    }
    const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const session=new McpHttpSession(server.url!,fetchImpl as typeof fetch,timeoutMs,mcpHeaders(server,options.secrets));
    try{await session.initialize(signal);return await session.callTool(tool,args,signal);}finally{await session.close();}
  };
}


export class McpRegistry {
  private readonly store: RecordStore;
  private readonly clock: () => number;
  private readonly prober: McpProbe;
  private readonly caller: McpToolCaller;
  private readonly healthTimeoutMs: number;

  constructor(deps: ToolDeps, options: McpRegistryOptions = {}) {
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.healthTimeoutMs = Math.max(250, Math.min(options.healthTimeoutMs ?? 10_000, 30_000));
    this.prober = options.prober ?? createMcpProbe({ secrets: deps.secrets, timeoutMs: this.healthTimeoutMs, fetch: deps.fetch, proxyEnv: options.proxyEnv });
    this.caller = options.caller ?? createMcpToolCaller({ secrets: deps.secrets, timeoutMs: this.healthTimeoutMs, fetch: deps.fetch, proxyEnv: options.proxyEnv });
  }

  private row(id: string): RecordRow {
    if (typeof id !== 'string' || !id.length) throw new ValidationError('MCP id required');
    const row = this.store.getRecord(id);
    if (!row || row.kind !== 'mcpServer') throw new ValidationError(`Unknown MCP server: ${id}`);
    return row;
  }

  private data(row: RecordRow): McpServerRecordData {
    const data = recordData(row) as unknown as Record<string, Json>;
    return {
      id: row.id,
      name: String(data.name),
      transport: data.transport === 'http' ? 'http' : 'stdio',
      command: typeof data.command === 'string' ? data.command : undefined,
      args: Array.isArray(data.args) ? data.args.map(String) : [],
      url: typeof data.url === 'string' ? data.url : undefined,
      readOnly: data.readOnly !== false,
      enabled: data.enabled !== false,
      health: data.health && typeof data.health === 'object' ? data.health as unknown as McpServerView['health'] : { status: 'unknown', at: 0 },
      tools: Array.isArray(data.tools) ? data.tools as unknown as McpServerView['tools'] : [],
      env: Array.isArray(data.env) ? data.env as unknown as McpEnvRef[] : [],
      headers: Array.isArray(data.headers) ? data.headers as unknown as McpHeaderRef[] : [],
      projects: Array.isArray(data.projects) ? data.projects.map(String) : [],
      toolAnnotations: Array.isArray(data.toolAnnotations) ? data.toolAnnotations as unknown as McpServerRecordData['toolAnnotations'] : [],
    };
  }

  toView(row: RecordRow): McpServerView {
    const data = this.data(row);
    const view: McpServerView = {
      id: row.id, name: data.name, transport: data.transport,
      readOnly: data.readOnly, enabled: data.enabled, health: data.health,
      tools: data.tools.map(tool => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      })),
    };
    if (data.command !== undefined) view.command = data.command;
    if (data.transport === 'stdio') view.args = data.args;
    if (data.url !== undefined) view.url = data.url;
    return view;
  }

  list(projectId?: string | null): McpServerView[] {
    const rows = this.store.listRecords('mcpServer', { limit: 500 });
    if (projectId === undefined) return rows.map(row => this.toView(row));
    if (projectId === null) return rows.filter(row => this.data(row).projects.length === 0).map(row => this.toView(row));
    return rows
      .filter(row => {
        const projects = this.data(row).projects;
        return projects.length === 0 || projects.includes(projectId);
      })
      .map(row => this.toView(row));
  }

  get(id: string): McpServerView { return this.toView(this.row(id)); }

  /** Per-project enablement: with no project list a server is available wherever enabled. */
  isEnabledFor(server: McpServerView | McpServerRecordData, projectId: string | null | undefined): boolean {
    if (!server.enabled) return false;
    const projects = (server as McpServerRecordData).projects;
    if (!projectId) return true;
    return !Array.isArray(projects) || projects.length === 0 || projects.includes(projectId);
  }

  async add(input: Json): Promise<McpServerView> {
    const value = plainObject(input, 'mcp server');
    const requestedId = typeof value.id === 'string' ? value.id : undefined;
    const existingRow = requestedId === undefined ? undefined : this.store.getRecord(requestedId);
    const existing = existingRow && existingRow.kind === 'mcpServer' ? this.data(existingRow) : undefined;
    const validated = validateMcpServer(input, existing);
    const data: McpServerRecordData = {
      id: existingRow?.id ?? validated.id ?? randomUUID(),
      name: validated.name,
      transport: validated.transport,
      readOnly: validated.readOnly,
      enabled: validated.enabled,
      health: existing?.health ?? { status: 'unknown', at: 0 },
      tools: existing?.tools ?? [],
      env: validated.env,
      headers: validated.headers,
      projects: validated.projects,
      toolAnnotations: existing?.toolAnnotations ?? [],
    };
    if (validated.command !== undefined) data.command = validated.command;
    if (validated.transport === 'stdio') data.args = validated.args ?? [];
    if (validated.url !== undefined) data.url = validated.url;
    const row = this.store.putRecord('mcpServer', data as unknown as Json, {
      id: data.id!,
      expectedVersion: existingRow ? existingRow.version : 0,
      provenance: { kind: 'mcp.add', at: this.clock() },
    });
    return this.toView(row);
  }

  async update(id: string, patch: Json): Promise<McpServerView> {
    const row = this.row(id);
    return this.add({ ...(recordData(row) as Record<string, Json>), ...plainObject(patch, 'mcp patch'), id } as Json);
  }

  async remove(id: string, expectedVersion?: number): Promise<{ ok: true }> {
    this.row(id);
    this.store.deleteRecord(id, expectedVersion);
    return { ok: true };
  }

  async enable(id: string, enabled: boolean, projectId?: string | null): Promise<McpServerView> {
    const row = this.row(id);
    const data = this.data(row);
    if (projectId) {
      const projects = new Set(data.projects);
      if (enabled) projects.add(projectId); else projects.delete(projectId);
      const updated = this.store.putRecord('mcpServer', { ...(recordData(row) as Record<string, Json>), projects: [...projects] } as Json, { id, expectedVersion: row.version });
      return this.toView(updated);
    }
    const updated = this.store.putRecord('mcpServer', { ...(recordData(row) as Record<string, Json>), enabled } as Json, { id, expectedVersion: row.version });
    return this.toView(updated);
  }

  async health(id: string, signal?:AbortSignal): Promise<McpServerView> {
    signal?.throwIfAborted();
    const row = this.row(id);
    const data = this.data(row);
    const started = this.clock();
    let health: McpServerView['health'] = { status: 'unknown', at: started };
    let tools = data.tools;
    let annotations = data.toolAnnotations;
    try {
      const controller = new AbortController();
      const cancel=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});
      const timer = setTimeout(() => controller.abort(new Error('MCP health check timed out')), this.healthTimeoutMs);
      try {
        const probe = await withDeadline(this.prober(data, controller.signal), this.healthTimeoutMs + 100, 'MCP health check');
        tools = probe.tools.map(tool => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }));
        annotations = probe.tools.map(tool => ({ name: tool.name, annotations: tool.annotations ?? {} }));
        health = { status: 'ok', at: this.clock(), latencyMs: Math.max(0, this.clock() - started) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort',cancel);
      }
    } catch (error) {
      health = { status: 'failed', at: this.clock(), latencyMs: Math.max(0, this.clock() - started), error: failureMessage(error) };
    }
    const updated = this.store.putRecord('mcpServer', {
      ...(recordData(row) as Record<string, Json>),
      health: health as unknown as Json,
      tools: tools as unknown as Json,
      toolAnnotations: annotations as unknown as Json,
    } as Json, { id, expectedVersion: row.version, provenance: { kind: 'mcp.health', at: this.clock() } });
    return this.toView(updated);
  }

  async tools(id: string, options: { refresh?: boolean;signal?:AbortSignal } = {}): Promise<McpServerView['tools']> {
    options.signal?.throwIfAborted();
    const row = this.row(id);
    const data = this.data(row);
    if (options.refresh || data.health.status !== 'ok' || data.tools.length === 0) return (await this.health(id,options.signal)).tools;
    return data.tools;
  }

  private annotationsFor(data: McpServerRecordData, tool: string): McpToolAnnotations {
    return data.toolAnnotations.find(entry => entry.name === tool)?.annotations ?? {};
  }

  /** Read-only servers may only invoke tools explicitly annotated `readOnlyHint: true`. */
  async callTool(id: string, tool: string, args: Record<string, Json>, options: { signal?: AbortSignal; projectId?: string | null } = {}): Promise<Json> {
    options.signal?.throwIfAborted();
    const row = this.row(id);
    const data = this.data(row);
    if (!this.isEnabledFor(data, options.projectId)) throw new ValidationError(`MCP server ${id} is disabled`);
    const name = requireString(tool, 'tool', 1, 128);
    if (!data.tools.some(entry => entry.name === name)) throw new ValidationError(`MCP server ${id} has no tool named ${name}; run mcp.tools first`);
    const schema = data.tools.find(entry => entry.name === name)?.inputSchema;
    if (schema) validateArguments(args, schema);
    if (data.readOnly && this.annotationsFor(data, name).readOnlyHint !== true) {
      throw new ValidationError(`MCP server ${id} is read-only; tool ${name} is not annotated readOnlyHint:true`);
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('MCP tool call timed out')), this.healthTimeoutMs);
    try {
      return await withDeadline(this.caller(data, name, args, controller.signal), this.healthTimeoutMs + 100, 'MCP tool call');
    } catch (error) {
      throw new Error(failureMessage(error));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Skill registry
// ---------------------------------------------------------------------------

export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_FILE_BYTES = 1_000_000;
export const MAX_SKILL_TOTAL_BYTES = 10_000_000;
const BINARY_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.pyc', '.class', '.jar', '.msi', '.com', '.scr', '.node', '.dmg', '.iso', '.zip', '.gz', '.7z']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build']);

export interface SkillTestDeclaration { language: 'python' | 'node'; script: string; args?: string[]; timeoutMs?: number }
export interface SkillManifest {
  name: string;
  version: string;
  entry: string;
  license: string | null;
  permissions: string[];
  description?: string;
  test?: SkillTestDeclaration;
  run?: SkillTestDeclaration;
  dependencies?: string[];
  samples?: string[];
}
export interface SkillFileEntry { path: string; sha256: string; bytes: number }
export interface SkillSourceFile { path: string; bytes: Buffer; text: string | null; sha256: string }
export type SkillSeverity = 'blocker' | 'danger' | 'warning';
export interface SkillScanFinding { code: string; severity: SkillSeverity; path: string; message: string }
export interface SkillInspection {
  source: { kind: 'local'; path: string } | { kind: 'github'; url: string; checkoutPath: string | null };
  remote: boolean;
  blocked: string | null;
  plan: string[];
  manifest: SkillManifest | null;
  files: SkillFileEntry[];
  sha256: string;
  bytes: number;
  license: string | null;
  permissions: string[];
  findings: SkillScanFinding[];
  allowed: boolean;
}

interface ScanRule { code: string; severity: SkillSeverity; pattern: RegExp; message: string }

const SECURITY_RULES: ScanRule[] = [
  { code: 'child-process', severity: 'danger', pattern: /\bchild_process\b|require\s*\(\s*['"]child_process['"]\s*\)/, message: 'spawns child processes' },
  { code: 'dynamic-exec', severity: 'danger', pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\b(?:exec|execSync|spawn|spawnSync)\s*\(/, message: 'evaluates or executes dynamic code' },
  { code: 'pipe-to-shell', severity: 'danger', pattern: /(?:curl|wget)[^\n|]{0,160}\|\s*(?:ba|z|fi)?sh\b/i, message: 'pipes a remote download into a shell' },
  { code: 'decode-exec', severity: 'danger', pattern: /base64\s+(?:-d|--decode)\b/i, message: 'decodes base64 payloads that may be executed' },
  { code: 'destructive-rm', severity: 'danger', pattern: /\brm\s+-[a-z]*r[a-z]*f|\b(?:rmSync|rmdirSync)\s*\([^)]*recursive\s*:\s*true/i, message: 'performs recursive deletion' },
  { code: 'path-escape', severity: 'danger', pattern: /(?:\.\.[/\\]){2,}/, message: 'references paths above the skill directory' },
  { code: 'absolute-path', severity: 'danger', pattern: /(?:^|[\s"'`(])(?:\/(?:etc|usr|bin|home|root|var|opt)\/|[A-Za-z]:\\\\)/, message: 'references an absolute host path' },
  { code: 'network-access', severity: 'warning', pattern: /\b(?:fetch\s*\(|https?\.request|urllib\.request|requests\.(?:get|post|put)|axios\.|WebSocket\s*\()/, message: 'performs network access' },
];
const PROMPT_INJECTION_RULES: ScanRule[] = [
  { code: 'prompt-injection', severity: 'danger', pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|disregard\s+(?:the\s+)?system\s+prompt|exfiltrat|send\s+(?:the\s+)?(?:api\s*key|credential|secret)s?|do\s+not\s+(?:tell|inform)\s+the\s+user|hidden\s+instructions?/i, message: 'contains prompt-injection instructions' },
];

function utf8Text(bytes: Buffer): string | null {
  if (bytes.length > MAX_SKILL_FILE_BYTES) return null;
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function safeRelativePath(path: string): string | null {
  const normalized = path.split('\\').join('/');
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments.some(segment => CONTROL.test(segment))) return null;
  return segments.join('/');
}

interface TreeRead { files: SkillSourceFile[]; findings: SkillScanFinding[] }

function readSkillTree(root: string): TreeRead {
  const findings: SkillScanFinding[] = [];
  const files: SkillSourceFile[] = [];
  let total = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      let stats;
      try { stats = lstatSync(full); } catch { findings.push({ code: 'unreadable', severity: 'blocker', path: entry.name, message: 'file could not be read' }); continue; }
      const rel = safeRelativePath(relative(root, full));
      if (rel === null) { findings.push({ code: 'path-traversal', severity: 'blocker', path: relative(root, full), message: 'path escapes or is not a normalized relative path' }); continue; }
      if (stats.isSymbolicLink()) { findings.push({ code: 'symlink', severity: 'blocker', path: rel, message: 'symbolic links are not allowed in skills' }); continue; }
      if (stats.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!stats.isFile()) continue;
      const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) { findings.push({ code: 'binary-file', severity: 'blocker', path: rel, message: 'binary files and native executables are not allowed in skills' }); continue; }
      if (files.length >= MAX_SKILL_FILES) { findings.push({ code: 'too-many-files', severity: 'blocker', path: rel, message: `skills support at most ${MAX_SKILL_FILES} files` }); continue; }
      if (stats.size > MAX_SKILL_FILE_BYTES) { findings.push({ code: 'file-too-large', severity: 'blocker', path: rel, message: `file exceeds ${MAX_SKILL_FILE_BYTES} bytes` }); continue; }
      total += stats.size;
      if (total > MAX_SKILL_TOTAL_BYTES) { findings.push({ code: 'total-too-large', severity: 'blocker', path: rel, message: `skill exceeds ${MAX_SKILL_TOTAL_BYTES} bytes in total` }); continue; }
      const bytes = readFileSync(full);
      const text = utf8Text(bytes);
      if (text === null) { findings.push({ code: 'binary-file', severity: 'blocker', path: rel, message: 'file is not valid UTF-8 text' }); continue; }
      files.push({ path: rel, bytes, text, sha256: sha256(bytes) });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, findings };
}

function parseManifest(files: SkillSourceFile[], findings: SkillScanFinding[]): SkillManifest | null {
  const manifestFile = files.find(file => file.path === 'skill.json') ?? files.find(file => file.path === 'manifest.json');
  let raw: Record<string, Json> = {};
  if (manifestFile) {
    if (manifestFile.text === null) { findings.push({ code: 'invalid-manifest', severity: 'blocker', path: manifestFile.path, message: 'manifest must be a UTF-8 JSON file' }); return null; }
    try {
      raw = plainObject(JSON.parse(manifestFile.text), manifestFile.path);
    } catch (error) {
      findings.push({ code: 'invalid-manifest', severity: 'blocker', path: manifestFile.path, message: `manifest is not valid JSON: ${failureMessage(error)}` });
      return null;
    }
  } else {
    findings.push({ code: 'missing-manifest', severity: 'danger', path: 'skill.json', message: 'skill declares no skill.json manifest' });
  }
  const skillMd = files.find(file => file.path.toLowerCase() === 'skill.md');
  if (!skillMd) findings.push({ code: 'missing-skill-md', severity: 'blocker', path: 'SKILL.md', message: 'SKILL.md documentation is required' });
  const heading = skillMd?.text?.match(/^#\s+([^\n]{1,120})\s*$/m)?.[1] ?? null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : heading ?? 'skill';
  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version : '0.1.0';
  const entry = typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry : 'SKILL.md';
  const license = typeof raw.license === 'string' && raw.license.trim() ? raw.license.trim() : null;
  if (!license) findings.push({ code: 'missing-license', severity: 'danger', path: manifestFile?.path ?? 'skill.json', message: 'skill must declare a license field' });
  let permissions: string[] = [];
  if (Array.isArray(raw.permissions)) {
    permissions = raw.permissions.map((value, index) => requireString(value, `permissions[${index}]`, 1, 64));
  }
  for (const permission of permissions) {
    if (!['network', 'filesystem', 'exec', 'inbound'].includes(permission)) findings.push({ code: 'unknown-permission', severity: 'warning', path: manifestFile?.path ?? 'skill.json', message: `unknown permission ${permission}` });
  }
  let test: SkillTestDeclaration | undefined;
  if (raw.test !== undefined) {
    try {
      const rawTest = plainObject(raw.test, 'manifest test');
      if (rawTest.language !== 'python' && rawTest.language !== 'node') {
        findings.push({ code: 'invalid-test', severity: 'blocker', path: 'skill.json', message: "test.language must be 'python' or 'node'" });
      } else {
        const script = requireString(rawTest.script, 'test.script', 1, 300);
        if (!files.some(file => file.path === script)) findings.push({ code: 'invalid-test', severity: 'blocker', path: 'skill.json', message: `test script ${script} does not exist` });
        test = { language: rawTest.language, script };
        if (Array.isArray(rawTest.args)) test.args = rawTest.args.map((value, index) => requireString(value, `test.args[${index}]`, 0, 500));
        if (typeof rawTest.timeoutMs === 'number' && Number.isFinite(rawTest.timeoutMs)) test.timeoutMs = Math.max(1_000, Math.min(rawTest.timeoutMs, 120_000));
      }
    } catch (error) {
      findings.push({ code: 'invalid-test', severity: 'blocker', path: 'skill.json', message: failureMessage(error) });
    }
  }
  const manifest: SkillManifest = { name, version, entry, license, permissions };
  if (typeof raw.description === 'string') manifest.description = raw.description.slice(0, 2000);
  if (test) manifest.test = test;
  if (raw.run !== undefined) {
    try {
      const run = plainObject(raw.run, 'manifest run');
      if (run.language !== 'python' && run.language !== 'node') throw new ValidationError('run.language must be python or node');
      const script = requireString(run.script, 'run.script', 1, 300);
      if (!safeRelativePath(script) || !files.some(file => file.path === script)) throw new ValidationError('run script is missing or unsafe');
      manifest.run = { language:run.language, script, timeoutMs: typeof run.timeoutMs === 'number' ? Math.max(1000,Math.min(120000,run.timeoutMs)) : 30000 };
    } catch(error) { findings.push({code:'invalid-run',severity:'blocker',path:'skill.json',message:failureMessage(error)}); }
  }
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies) || raw.dependencies.some(x=>typeof x !== 'string'||!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(x))) findings.push({code:'invalid-dependencies',severity:'blocker',path:'skill.json',message:'dependencies must be module names'});
    else manifest.dependencies = raw.dependencies as string[];
  }
  if (Array.isArray(raw.samples)) {
    try {
      manifest.samples = raw.samples.map((value, index) => requireString(value, `samples[${index}]`, 1, 300));
    } catch (error) {
      findings.push({ code: 'invalid-samples', severity: 'warning', path: 'skill.json', message: failureMessage(error) });
    }
  }
  return manifest;
}

/** Pure static scan over already-read files; exported so tests can assert individual rules. */
export function scanSkillFiles(files: SkillSourceFile[], manifest: SkillManifest | null): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  if (!files.some(file => file.path.toLowerCase() === 'skill.md')) findings.push({ code: 'missing-skill-md', severity: 'blocker', path: 'SKILL.md', message: 'SKILL.md documentation is required' });
  if (manifest && !files.some(file => file.path === manifest.entry)) findings.push({ code: 'missing-entry', severity: 'blocker', path: manifest.entry, message: 'declared entry file does not exist' });
  const permissions = new Set(manifest?.permissions ?? []);
  for (const file of files) {
    if (file.text === null) continue;
    for (const rule of SECURITY_RULES) {
      if (!rule.pattern.test(file.text)) continue;
      if (rule.code === 'network-access') {
        if (!permissions.has('network')) findings.push({ code: 'undeclared-network', severity: 'danger', path: file.path, message: 'network access is used but the network permission is not declared' });
        continue;
      }
      findings.push({ code: rule.code, severity: rule.severity, path: file.path, message: rule.message });
    }
    if (file.path.toLowerCase() === 'skill.md') {
      for (const rule of PROMPT_INJECTION_RULES) {
        if (rule.pattern.test(file.text)) findings.push({ code: rule.code, severity: rule.severity, path: file.path, message: rule.message });
      }
    }
  }
  const deduped = new Map<string, SkillScanFinding>();
  for (const finding of findings) deduped.set(`${finding.code}:${finding.path}`, finding);
  return [...deduped.values()];
}

function treeSha(files: SkillSourceFile[]): string {
  return sha256(files.map(file => `${file.path}\u0000${file.sha256}\n`).join(''));
}

function skillId(name: string, tree: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
  return `${base}-${tree.slice(0, 12)}`;
}

export interface SkillRegistryOptions {
  maxFiles?: number;
  installRoot?: string;
}

export class SkillRegistry {
  private readonly store: RecordStore;
  private readonly clock: () => number;
  private readonly worker?: WorkerClient;
  private readonly installRoot: string;
  private readonly sandboxRoot: string;
  private readonly maxFiles: number;

  constructor(deps: ToolDeps, options: SkillRegistryOptions = {}) {
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.worker = deps.worker;
    this.installRoot = options.installRoot ?? join(deps.home, 'skills');
    this.sandboxRoot = join(deps.home, 'sandbox');
    this.maxFiles = options.maxFiles ?? MAX_SKILL_FILES;
  }

  private row(id: string): RecordRow {
    if (typeof id !== 'string' || !id.length) throw new ValidationError('skill id required');
    const row = this.store.getRecord(id);
    if (!row || row.kind !== 'skill') throw new ValidationError(`Unknown skill: ${id}`);
    return row;
  }

  toView(row: RecordRow): SkillView {
    const data = recordData(row);
    const rawTest = data.test && typeof data.test === 'object' ? data.test as unknown as SkillView['test'] : { status: 'not_run' as const, at: null };
    return {
      id: row.id,
      name: String(data.name),
      description: (data.manifest as unknown as SkillManifest)?.description ?? '',
      executable: Boolean((data.manifest as unknown as SkillManifest)?.run),
      dependencies: (data.manifest as unknown as SkillManifest)?.dependencies ?? [],
      version: String(data.version),
      source: String(data.source ?? 'local'),
      license: typeof data.license === 'string' ? data.license : null,
      entry: String(data.entry ?? 'SKILL.md'),
      permissions: Array.isArray(data.permissions) ? data.permissions.map(String) : [],
      enabled: data.enabled !== false,
      sha256: String(data.sha256 ?? ''),
      test: rawTest,
      installedAt: typeof data.installedAt === 'number' ? data.installedAt : row.createdAt,
    };
  }

  list(): SkillView[] { return this.store.listRecords('skill', { limit: 500 }).map(row => this.toView(row)); }
  get(id: string): SkillView { return this.toView(this.row(id)); }

  /** Progressive discovery: descriptions only, never all SKILL.md bodies. */
  search(query: string): Json {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    return this.store.listRecords('skill',{limit:500}).filter(row=>recordData(row).enabled!==false).map(row=>{
      const data=recordData(row),manifest=data.manifest as unknown as SkillManifest;
      const description=manifest?.description??'';
      const text=`${data.name} ${description}`.toLowerCase();
      return {id:row.id,name:String(data.name),version:String(data.version),description,score:words.reduce((n,w)=>n+(text.includes(w)?1:0),0)};
    }).sort((a,b)=>b.score-a.score).slice(0,8) as unknown as Json;
  }
  load(id: string): Json {
    const row=this.row(id),data=recordData(row);
    if(data.enabled===false)throw new ValidationError('Skill is disabled');
    const files=this.installedFiles(id);
    if(treeSha(files)!==data.sha256)throw new ValidationError('Skill content digest changed; reinstall and review');
    const manifest=data.manifest as unknown as SkillManifest;
    const entry=files.find(file=>file.path===manifest.entry);
    if(!entry?.text)throw new ValidationError('Skill instructions missing');
    const adaptation=manifest.name==='skill-creator'?'SuWen runtime: use skill_create to create/install skills, skill_load then skill_run for execution. Do not install into Codex global configuration.':manifest.name==='skill-installer'?'SuWen runtime: use skill_install with a workspace path or GitHub tree URL. Installation targets the SuWen managed registry, not CODEX_HOME. Then skill_load; execute only when run is declared.':'';
    return {id,name:manifest.name,version:manifest.version,instructions:(adaptation+'\n'+entry.text).slice(0,32000),resources:files.filter(file=>file.path!==manifest.entry).map(file=>({path:file.path,bytes:file.bytes.length})),run:manifest.run as unknown as Json??null,dependencies:manifest.dependencies??[],sha256:String(data.sha256)};
  }
  readResource(id:string,path:string,start=0):Json {
    this.load(id); // Rechecks enabled state and the complete installed digest.
    const file=this.installedFiles(id).find(item=>item.path===path);
    if(!file?.text)throw new ValidationError('Unknown or non-text skill resource');
    const end=Math.min(file.text.length,start+28000);
    return {id,path,startChar:start,content:file.text.slice(start,end),nextStartChar:end<file.text.length?end:null,sha256:file.sha256};
  }
  async run(id:string,input:Json,signal:AbortSignal,execute?: (input:Record<string,Json>,signal:AbortSignal)=>Promise<Json>):Promise<Json> {
    signal.throwIfAborted();this.load(id);
    const data=recordData(this.row(id)),manifest=data.manifest as unknown as SkillManifest;
    if(!manifest.run)throw new ValidationError('Skill declares no executable run entry; tests are not task execution');
    if(manifest.permissions.length)throw new ValidationError('Chat skill execution only permits reviewed skills without host/network permissions');
    if(!execute&&!this.worker)throw new ValidationError('Skill Python worker unavailable');
    if(!execute)mkdirSync(this.sandboxRoot,{recursive:true});
    const files=this.installedFiles(id),script=files.find(x=>x.path===manifest.run!.script);
    if(!script?.text)throw new ValidationError('Skill run script missing');
    let source=script.text;
    if(manifest.dependencies?.length){
      if(manifest.run.language!=='python')throw new ValidationError('Node dependency preflight is unsupported');
      source=`import importlib.util\nfor _module in ${JSON.stringify(manifest.dependencies)}:\n    if importlib.util.find_spec(_module) is None: raise RuntimeError('Missing dependency: '+_module)\n`+source;
    }
    const request={language:manifest.run.language,source,args:[JSON.stringify(input)],timeoutMs:manifest.run.timeoutMs??30000,files:files.filter(x=>x.text!==null).map(x=>({name:x.path,text:x.text!}))};
    const result=execute?await execute(request,signal):await this.worker!.call('runScript',{...request,sandboxRoot:this.sandboxRoot},signal);
    const shaped=plainObject(result,'skill run result');
    if(shaped.timedOut===true||shaped.exitCode!==0)throw new Error(`Skill execution failed (exit=${shaped.exitCode}, timedOut=${shaped.timedOut===true})`);
    if(typeof shaped.stdout!=='string'||!shaped.stdout.trim())throw new Error('Skill produced no result');
    return {skillId:id,version:manifest.version,sha256:String(data.sha256),result};
  }

  installedPath(id: string): string {
    const data = recordData(this.row(id));
    const candidate = typeof data.installedPath === 'string' ? data.installedPath : join(this.installRoot, id);
    // Defense in depth: a record-supplied path must stay inside the managed skills root.
    // Records are normally written by trusted activities, but this closes a traversal hole if
    // a malformed/forged record ever points at an arbitrary directory.
    const resolved = resolve(candidate);
    const root = resolve(this.installRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new ValidationError(`Skill ${id} installation path is outside the skills root`);
    return resolved;
  }

  private installedFiles(id: string): SkillSourceFile[] {
    return readSkillTree(this.installedPath(id)).files;
  }

  async inspect(input: Json): Promise<SkillInspection> {
    const value = plainObject(input, 'skill inspect');
    const url = optionalString(value.url, 'url', 2000);
    const requestedPath = optionalString(value.path, 'path', 1000);
    const checkoutPath = optionalString(value.checkoutPath, 'checkoutPath', 1000);
    if (url !== undefined) {
      if (!/^https?:\/\//i.test(url)) throw new ValidationError('url must be a public GitHub http(s) URL');
      if (checkoutPath === undefined) {
        return {
          source: { kind: 'github', url, checkoutPath: null },
          remote: true,
          blocked: 'BLOCKED_EXTERNAL',
          plan: [
            'main process fetches the public GitHub repository archive only after explicit approval',
            'main process stages the checkout in a restricted temporary directory',
            'skill.inspect runs static checks on the staged tree: path traversal, absolute paths, binaries/executables, size caps, network/exec declarations, license field',
            'skill.install with confirm:true copies the checked tree atomically into <home>/skills/<id>',
          ],
          manifest: null, files: [], sha256: '', bytes: 0, license: null, permissions: [],
          findings: [{ code: 'blocked-external', severity: 'blocker', path: url, message: 'Remote fetch is not performed by the tool domain; provide checkoutPath from an approved main-process fetch' }],
          allowed: false,
        };
      }
      return this.inspectLocal(checkoutPath, { kind: 'github', url, checkoutPath });
    }
    if (requestedPath === undefined) throw new ValidationError('skill inspect requires path or url');
    return this.inspectLocal(requestedPath, { kind: 'local', path: requestedPath });
  }

  private inspectLocal(root: string, source: SkillInspection['source']): SkillInspection {
    let stats;
    try { stats = lstatSync(root); } catch { throw new ValidationError(`Skill path not found: ${root}`); }
    if (!stats.isDirectory()) throw new ValidationError('Skill path must be a directory');
    const tree = readSkillTree(root);
    const manifest = parseManifest(tree.files, tree.findings);
    const findings = [...tree.findings, ...scanSkillFiles(tree.files, manifest)];
    if (tree.files.length > this.maxFiles) findings.push({ code: 'too-many-files', severity: 'blocker', path: '.', message: `skills support at most ${this.maxFiles} files` });
    const deduped = new Map<string, SkillScanFinding>();
    for (const finding of findings) deduped.set(`${finding.code}:${finding.path}`, finding);
    const all = [...deduped.values()];
    return {
      source,
      remote: false,
      blocked: null,
      plan: [],
      manifest,
      files: tree.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.length })),
      sha256: treeSha(tree.files),
      bytes: tree.files.reduce((sum, file) => sum + file.bytes.length, 0),
      license: manifest?.license ?? null,
      permissions: manifest?.permissions ?? [],
      findings: all,
      allowed: !all.some(finding => finding.severity === 'blocker' || finding.severity === 'danger'),
    };
  }

  async install(input: Json): Promise<SkillView> {
    const value = plainObject(input, 'skill install');
    if (value.confirm !== true) throw new ValidationError('Skill install requires confirm:true (external code executes in the sandbox)');
    const url = optionalString(value.url, 'url', 2000);
    const requestedPath = optionalString(value.path, 'path', 1000);
    const checkoutPath = optionalString(value.checkoutPath, 'checkoutPath', 1000);
    if (url !== undefined && !/^https?:\/\//i.test(url)) throw new ValidationError('url must be a public GitHub http(s) URL');
    if (url !== undefined && checkoutPath === undefined) throw new Error('BLOCKED_EXTERNAL: GitHub skill install requires an approved main-process fetch; pass checkoutPath with the staged tree');
    const root = checkoutPath ?? requestedPath;
    if (root === undefined) throw new ValidationError('skill install requires path or checkoutPath');
    const inspection = this.inspectLocal(root, url === undefined ? { kind: 'local', path: root } : { kind: 'github', url, checkoutPath: root });
    const blockers = inspection.findings.filter(finding => finding.severity === 'blocker');
    if (blockers.length) throw new ValidationError(`Skill install rejected: ${blockers.map(finding => `${finding.code}(${finding.path})`).join(', ')}`);
    const dangers = inspection.findings.filter(finding => finding.severity === 'danger');
    const confirmDanger = value.confirmDanger === true;
    if (dangers.length && !confirmDanger) {
      throw new ValidationError(`Skill install rejected by static scan: ${dangers.map(finding => `${finding.code}(${finding.path})`).join(', ')}; pass confirmDanger:true to override`);
    }
    const manifest = inspection.manifest;
    if (!manifest) throw new ValidationError('Skill install requires a valid manifest');
    const id = skillId(manifest.name, inspection.sha256);
    const existing = this.store.getRecord(id);
    if (existing) {
      const view = this.toView(existing);
      if (view.sha256 === inspection.sha256) return view;
      throw new ConflictError(`Skill ${id} already installed with different content`);
    }
    mkdirSync(this.installRoot, { recursive: true });
    const target = join(this.installRoot, id);
    // A previous crash can leave an orphan tree without its record (the record is
    // written after the copy). Windows renameSync then fails with EPERM against the
    // existing directory, so clear the orphan first; a live record would have been
    // returned or rejected above.
    try { rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
    const staging = join(this.installRoot, `.staging-${randomUUID()}`);
    mkdirSync(staging, { recursive: false });
    try {
      for (const file of readSkillTree(root).files) {
        const destination = join(staging, ...file.path.split('/'));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, file.bytes, { mode: 0o600, flag: 'wx' });
      }
      // Windows scanners or another process can briefly hold the staging tree;
      // retry the rename a few times before surfacing the failure.
      for (let attempt = 0; ; attempt += 1) {
        try { renameSync(staging, target); break; }
        catch (error) {
          if (attempt >= 3 || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
      throw new Error(`Skill copy failed: ${failureMessage(error)}`);
    }
    const installedAt = this.clock();
    const source = url === undefined ? `local:${root}` : `github:${url}`;
    const data = {
      name: manifest.name,
      version: manifest.version,
      source,
      license: manifest.license,
      entry: manifest.entry,
      permissions: manifest.permissions,
      enabled: value.enabled !== false,
      sha256: inspection.sha256,
      test: { status: 'not_run', at: null },
      installedAt,
      manifest: manifest as unknown as Json,
      files: inspection.files as unknown as Json,
      installedPath: target,
      dangerApproved: dangers.length > 0 && confirmDanger,
      sampleFiles: (manifest.samples ?? []) as unknown as Json,
    } as unknown as Json;
    const row = this.store.putRecord('skill', data, {
      id, expectedVersion: 0,
      provenance: { kind: 'skill.install', at: installedAt, sha256: inspection.sha256, source },
    });
    return this.toView(row);
  }

  async enable(id: string, enabled: boolean): Promise<SkillView> {
    const row = this.row(id);
    const updated = this.store.putRecord('skill', { ...(recordData(row) as Record<string, Json>), enabled } as Json, { id, expectedVersion: row.version });
    return this.toView(updated);
  }

  async remove(id: string, expectedVersion?: number): Promise<{ ok: true }> {
    const row = this.row(id);
    const installed = this.installedPath(id);
    this.store.deleteRecord(id, expectedVersion);
    try { rmSync(installed, { recursive: true, force: true }); } catch { /* record removal is authoritative */ }
    return { ok: true };
  }

  /** Run the manifest-declared test in the isolated worker and persist passed/failed evidence. */
  async test(id: string, options: { signal?: AbortSignal; worker?: WorkerClient } = {}): Promise<{ skill: SkillView; result: Json; status: 'passed' | 'failed'; detail: string }> {
    const row = this.row(id);
    const data = recordData(row);
    const manifest = (data.manifest ?? null) as unknown as SkillManifest | null;
    if (!manifest?.test) throw new ValidationError(`Skill ${id} declares no test command`);
    const worker = options.worker ?? this.worker;
    if (!worker) throw new ValidationError('Worker unavailable for skill test');
    const files = this.installedFiles(id);
    const script = files.find(file => file.path === manifest.test!.script);
    if (!script || script.text === null) throw new ValidationError(`Skill test script ${manifest.test.script} is missing or not text`);
    const signal = options.signal ?? AbortSignal.timeout(120_000);
    mkdirSync(this.sandboxRoot, { recursive: true });
    const input = {
      language: manifest.test.language,
      source: script.text,
      args: manifest.test.args ?? [],
      timeoutMs: manifest.test.timeoutMs ?? 60_000,
      sandboxRoot: this.sandboxRoot,
      files: files.filter(file => file.text !== null).map(file => ({ name: file.path, text: file.text })),
    } as unknown as Json;
    const at = this.clock();
    try {
      const result = await worker.call('runScript', input, signal);
      const shaped = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, Json> : {};
      const exitCode = typeof shaped.exitCode === 'number' ? shaped.exitCode : 1;
      const timedOut = shaped.timedOut === true;
      const stdout = typeof shaped.stdout === 'string' ? shaped.stdout : '';
      const stderr = typeof shaped.stderr === 'string' ? shaped.stderr : '';
      const detail = `exit=${exitCode}${timedOut ? ' timedOut' : ''}${stdout ? ` stdout=${stdout.slice(0, 300)}` : ''}${stderr ? ` stderr=${stderr.slice(0, 300)}` : ''}`;
      const status: 'passed' | 'failed' = !timedOut && exitCode === 0 ? 'passed' : 'failed';
      const updated = this.store.putRecord('skill', {
        ...(recordData(row) as Record<string, Json>),
        test: { status, at, detail },
      } as Json, { id, expectedVersion: row.version, provenance: { kind: 'skill.test', at, status, script: manifest.test.script } });
      return { skill: this.toView(updated), result, status, detail };
    } catch (error) {
      const detail = `worker error: ${failureMessage(error)}`;
      this.store.putRecord('skill', {
        ...(recordData(row) as Record<string, Json>),
        test: { status: 'failed', at, detail },
      } as Json, { id, expectedVersion: row.version, provenance: { kind: 'skill.test', at, status: 'failed', transportError: true } });
      throw new Error(`Skill test worker failed: ${detail}`);
    }
  }
}
