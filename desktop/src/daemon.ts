/**
 * SuWen durable harness daemon.
 *
 * Runs as a detached Node process (Electron in RUN_AS_NODE mode), owns the
 * SQLite state machine and every long-running activity, and exposes a
 * token-authenticated local IPC endpoint to the Electron main process. Closing
 * the UI never stops this process.
 */
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launchLegacy, type LegacyModelConfig } from './legacy-worker.js';
import { Store } from './harness/store.js';
import { Engine } from './harness/engine.js';
import { ValidationError, type TaskDefinition, type Json } from './harness/types.js';
import { ensureHome, newConnection, connectionPath, atomicJson, secretEqual, safeError } from './security.js';
import { ContextManager } from './context.js';
import { prepareContextAsync } from './context-async.js';
import { queryViaMcp } from './mcp-client.js';
import { createResearchWorker, type ResearchWorkerClient } from './research-worker.js';
import { ModelRuntime } from './model-runtime.js';
import { ImportService } from './import-service.js';
import { createToolServices } from './activities/tools.js';
import { createAllActivities } from './activities/index.js';
import { createCoreHandlers } from './rpc/core.js';
import { createCapabilityHandlers } from './rpc/capabilities.js';
import { collectStreamEvents } from './stream-events.js';
import type { ActivityServices, DatabaseQuery, ModelMessage, StreamBuffer, WorkerClient, WorkerHealth } from './shared/contract.js';
import type { SecretResolver } from './domain/tools.js';
import type { EvalRunner } from './domain/rsi.js';

const homeArg = process.argv.indexOf('--home');
if (homeArg < 0 || !process.argv[homeArg + 1]) throw new Error('Explicit --home required');
const home = resolve(process.argv[homeArg + 1]);
ensureHome(home);
const lockPath = join(home, 'daemon.lock');
function lock(): void {
  try { const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid daemon lock; review before recovery');
    try { process.kill(pid, 0); } catch (e: any) { if (e.code === 'ESRCH') { unlinkSync(lockPath); lock(); return; } throw e; }
    throw new Error('Daemon already running');
  }
}
lock();
const startedAt = Date.now();

/** Resolve the desktop package version from source or packaged layout. */
function appVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try { const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }; if (typeof pkg.version === 'string') return pkg.version; } catch { /* keep searching */ }
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}
const VERSION = appVersion();

const connection = newConnection(home);
const store = new Store(join(home, 'harness.sqlite'));
const preferencesPath = join(home, 'preferences.json');
let pythonPath = 'python';
try {
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8')) as { pythonPath?: unknown };
  if (typeof preferences.pythonPath === 'string') pythonPath = preferences.pythonPath;
} catch { /* first run or unreadable preferences */ }
const workerIndex = process.argv.indexOf('--worker');
const workerScript = workerIndex >= 0 ? resolve(process.argv[workerIndex + 1]) : resolve('worker/research_worker.py');

const modelRuntime = new ModelRuntime();
/** Step kinds whose activity calls the configured model; gated until the user unlocks credentials. */
const MODEL_KINDS = new Set(['model', 'hypothesis', 'debate', 'research', 'knowledge', 'methods', 'analysis', 'discovery', 'autonomy']);
const streams = new Map<string, StreamBuffer>();

/**
 * A WorkerClient whose Python interpreter can be repointed from the settings
 * UI without restarting the daemon.
 */
class ManagedWorker implements WorkerClient {
  private client: ResearchWorkerClient;
  private readonly script: string;
  constructor(private getPython: () => string, scriptPath: string) {
    this.script = scriptPath;
    this.client = createResearchWorker({ python: this.getPython(), scriptPath });
  }
  setPython(): void {
    const previous = this.client;
    this.client = createResearchWorker({ python: this.getPython(), scriptPath: this.script });
    void previous.close().catch(() => {});
  }
  health(): Promise<WorkerHealth> { return this.client.health(); }
  call(op: string, input: Json, signal: AbortSignal): Promise<Json> { return this.client.call(op, input, signal); }
  close(): Promise<void> { return this.client.close(); }
}
const worker = new ManagedWorker(() => pythonPath, workerScript);

const secretMap: Record<string, string> = {};
const secrets: SecretResolver = (reference: string) => secretMap[reference];

/** Normalize model answers for deterministic RSI eval-case comparison. */
function normalizeEvalValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return value;
}
function evalAnswerMatches(answer: unknown, expect: Json): boolean {
  const normalized = normalizeEvalValue(answer);
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    return JSON.stringify(normalized) === JSON.stringify(expect);
  }
  const spec = expect as Record<string, Json>;
  const text = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
  if (typeof spec.equals === 'string') return text === spec.equals.trim();
  if (typeof spec.contains === 'string') return text.includes(spec.contains);
  if (Array.isArray(spec.oneOf)) return spec.oneOf.some(entry => typeof entry === 'string' && text.includes(entry));
  if (spec.answer !== undefined) {
    const wanted = normalizeEvalValue(spec.answer);
    return JSON.stringify(normalized) === JSON.stringify(wanted) || text.includes(String(spec.answer));
  }
  return JSON.stringify(normalized) === JSON.stringify(spec);
}
/**
 * Default RSI evaluator for local runs: one bounded model call per eval case,
 * answered as JSON and compared against the persisted expectation. Failures are
 * recorded as a failed case, never silently promoted.
 */
const rsiRunner: EvalRunner = async (args) => {
  const started = Date.now();
  const messages: ModelMessage[] = [
    { role: 'system', content: 'You are the SuWen RSI evaluator. Answer the evaluation case. Reply with one compact JSON object and no prose.' },
    { role: 'user', content: JSON.stringify({ kind: args.evalCase.kind, input: args.evalCase.input }) },
  ];
  try {
    const reply = await modelRuntime.call(messages, args.signal ?? new AbortController().signal);
    let answer: unknown = reply.text;
    try { answer = JSON.parse(reply.text); } catch { /* keep raw text */ }
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && 'answer' in (answer as Record<string, unknown>)) {
      answer = (answer as Record<string, unknown>).answer;
    }
    const success = evalAnswerMatches(answer, args.evalCase.expect);
    return {
      caseId: args.evalCase.id,
      success,
      evidenceScore: success ? 1 : 0,
      toolFailure: false,
      cost: Math.max(0, reply.tokens) * 0.000001,
      latencyMs: Date.now() - started,
      reproducible: true,
    };
  } catch {
    return { caseId: args.evalCase.id, success: false, evidenceScore: 0, toolFailure: true, latencyMs: Date.now() - started, reproducible: false };
  }
};

const toolServices = createToolServices({ store, home, clock: () => Date.now(), worker, secrets }, { runner: rsiRunner });

const databases: DatabaseQuery = {
  query: (kind, query, signal) => queryViaMcp(kind, query, signal) as Promise<Json>,
};
const services: ActivityServices = { store, model: modelRuntime, worker, databases, home, clock: () => Date.now() };

const activities = createAllActivities(services, {
  model: { home, store, model: modelRuntime, streams, pythonPath: () => pythonPath },
  databases: { home },
  toolServices,
});

const engine = new Engine(store, {
  leaseMs: 15000,
  pollMs: 250,
  concurrency: 2,
  canRun: step => {
    const needsModel = MODEL_KINDS.has(step.kind);
    return !needsModel || modelRuntime.configured();
  },
  handlers: activities,
  onError: err => console.error(safeError(err)),
});
engine.start();

const imports = new ImportService(store, home);

const coreDeps = {
  home,
  store,
  model: modelRuntime,
  imports,
  preferencesPath,
  pythonPath: () => pythonPath,
  setPythonPath: (value: string) => { pythonPath = value; worker.setPython(); atomicJson(preferencesPath, { pythonPath }); },
  workerHealth: () => worker.health(),
  workerDescribe: async () => {
    const described = await worker.call('describe', {} as Json, AbortSignal.timeout(15_000));
    const record = described && typeof described === 'object' && !Array.isArray(described) ? described as Record<string, Json> : {};
    const ops = record.ops && typeof record.ops === 'object' && !Array.isArray(record.ops) ? Object.keys(record.ops as Record<string, Json>) : [];
    return { ...record, capabilities: ops } as Json;
  },
  version: VERSION,
  startedAt,
  activeTasks: () => engine.runningCount,
};
const core = createCoreHandlers(coreDeps);
const capabilities = createCapabilityHandlers({
  store,
  services,
  tools: toolServices,
  setSecrets: (refs: Record<string, string>) => { Object.assign(secretMap, refs); },
});

let legacy: Awaited<ReturnType<typeof launchLegacy>> | null = null;
let legacyStarting: Promise<Awaited<ReturnType<typeof launchLegacy>>> | null = null;
/** Signature of the model configuration currently injected into the running bridge. */
let legacySignature: string | null = null;
/** Validate the injected session model config; invalid input falls back to the bridge mock provider. */
function legacyModelConfig(value: Json | undefined): LegacyModelConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, Json | undefined>;
  const provider = raw.provider, model = raw.model, apiBase = raw.apiBase, apiKey = raw.apiKey;
  if (typeof provider !== 'string' || (provider !== 'custom-openai' && provider !== 'custom-anthropic')) return undefined;
  if (typeof model !== 'string' || model.length === 0 || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) return undefined;
  if (typeof apiBase !== 'string' || !/^https?:\/\//i.test(apiBase) || apiBase.length > 2000 || /[\u0000-\u001f\u007f]/.test(apiBase)) return undefined;
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) return undefined;
  return { provider, model, apiBase, apiKey };
}

function healthPayload(): Json {
  return {
    pid: process.pid,
    version: VERSION,
    uptime: process.uptime(),
    startedAt,
    mode: 'user-background',
    configured: modelRuntime.configured(),
    python: pythonPath,
    serviceInstalled: false,
    legacy: legacy ? { pid: legacy.pid, port: legacy.port, mode: 'python-compatibility' } : null,
    runtimeVersions: { node: process.versions.node, electron: process.versions.electron ?? null, sqlite: process.versions.sqlite ?? null },
    ready: true,
  } as unknown as Json;
}

type Dispatch = (params: Record<string, Json>) => Promise<Json> | Json;
const handlers: Record<string, Dispatch> = { ...core, ...capabilities };

handlers['health'] = () => healthPayload();
handlers['snapshot'] = () => ({
  health: healthPayload(),
  tasks: store.listTasks().slice(-100).reverse().map(task => ({
    ...task,
    steps: store.getSteps(task.id),
    events: store.events(task.id).slice(-80),
    checkpoints: store.checkpoints(task.id).slice(-3),
    artifacts: store.artifacts(task.id),
    stream: streams.get(task.id) ?? null,
  })),
}) as unknown as Json;
handlers['events.stream'] = params => collectStreamEvents(store, streams, params) as unknown as Json;
handlers['configure'] = params => {
  const config = modelRuntime.configure(params);
  if (!modelRuntime.configured) throw new ValidationError('模型配置无效');
  return { ok: true, provider: config.provider, model: config.model, contextWindow: config.contextWindow };
};
handlers['python'] = params => {
  const value = params.path;
  if (typeof value !== 'string' || value.length > 1000 || /[\r\n\0]/.test(value)) throw new ValidationError('Invalid Python path');
  coreDeps.setPythonPath(value);
  return { ok: true, python: value };
};
handlers['create'] = params => {
  const definition = params as unknown as TaskDefinition;
  const allowed = new Set(['echo', 'delay', 'approval', 'model', 'pubmed', 'uniprot', 'python', 'research', 'knowledge', 'hypothesis', 'debate', 'methods', 'analysis', 'discovery', 'autonomy', 'skill.test', 'channel.send', 'rsi.evaluate']);
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) throw new ValidationError('create requires at least one step');
  if (definition.steps.some(step => !allowed.has(step.kind))) throw new ValidationError('Unknown or forbidden activity');
  const needsModel = definition.steps.some(step => MODEL_KINDS.has(step.kind));
  if (needsModel && !modelRuntime.configured()) throw new ValidationError('请先配置并解锁模型；离线后台演示和数据库检索无需模型。');
  const EFFECTFUL = new Set(['model', 'research', 'knowledge', 'hypothesis', 'debate', 'methods', 'analysis', 'discovery', 'autonomy', 'skill.test', 'channel.send', 'rsi.evaluate']);
  return store.createTask({
    ...definition,
    steps: definition.steps.map(step => ({ ...step, sideEffect: step.sideEffect ?? EFFECTFUL.has(step.kind) })),
  }) as unknown as Json;
};
handlers['control'] = params => {
  const id = params.id;
  if (typeof id !== 'string') throw new ValidationError('Task id required');
  const version = typeof params.version === 'number' ? params.version : undefined;
  if (params.action === 'pause') store.pauseTask(id, version);
  else if (params.action === 'cancel') store.cancelTask(id, version);
  else if (params.action === 'resume') store.resumeTask(id, version);
  else throw new ValidationError('Invalid control');
  return store.getTask(id) as unknown as Json;
};
handlers['approval'] = params => {
  const taskId = params.taskId;
  const stepId = params.stepId;
  if (typeof taskId !== 'string' || typeof stepId !== 'string') throw new ValidationError('taskId and stepId required');
  const decision = params.decision as { action: 'confirm_completed' | 'retry' | 'reject'; output?: Json } | undefined;
  if (!decision || typeof decision !== 'object' || !['confirm_completed', 'retry', 'reject'].includes(String(decision.action))) throw new ValidationError('Invalid approval decision');
  store.resolveApproval(taskId, stepId, decision, typeof params.version === 'number' ? params.version : undefined);
  return { ok: true };
};

function contextOptions(params: Record<string, Json>): { id: string; conversationId: string; options: { directory: string; model: string; contextWindow: number; outputTokens: number; accounting: 'estimate' } } {
  if (typeof params.id !== 'string' || !store.getTask(params.id)) throw new ValidationError('Unknown task');
  const first = store.getSteps(params.id).find(step => step.kind === 'model');
  const conversationId = String((first?.input as Record<string, Json> | undefined)?.conversationId ?? params.id);
  const cid = createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
  const current = modelRuntime.current();
  return {
    id: params.id,
    conversationId,
    options: {
      directory: join(home, 'contexts', cid),
      model: current?.model ?? 'gpt-4o',
      contextWindow: current?.contextWindow ?? 128000,
      outputTokens: current?.maxOutput ?? 4096,
      accounting: 'estimate',
    },
  };
}
handlers['contextHistory'] = params => new ContextManager(contextOptions(params).options).history() as unknown as Json;
handlers['contextCompact'] = params => {
  const { conversationId, options } = contextOptions(params);
  const busy = store.listTasks().some(task =>
    !['completed', 'cancelled', 'failed', 'paused'].includes(task.status) &&
    store.getSteps(task.id).some(step => step.kind === 'model' && String((step.input as Record<string, Json> | undefined)?.conversationId ?? task.id) === conversationId));
  if (busy) throw new ValidationError('请先停止此会话的执行，再压缩或恢复摘要视图。');
  return prepareContextAsync(options, { force: true }) as unknown as Json;
};
handlers['contextRestore'] = params => {
  const { conversationId, options } = contextOptions(params);
  const busy = store.listTasks().some(task =>
    !['completed', 'cancelled', 'failed', 'paused'].includes(task.status) &&
    store.getSteps(task.id).some(step => step.kind === 'model' && String((step.input as Record<string, Json> | undefined)?.conversationId ?? task.id) === conversationId));
  if (busy) throw new ValidationError('请先停止此会话的执行，再压缩或恢复摘要视图。');
  return new ContextManager(options).restore(Number(params.version)) as unknown as Json;
};
handlers['legacyStart'] = async (params: Record<string, Json>) => {
  const config = legacyModelConfig(params?.config);
  const signature = config ? createHash('sha256').update([config.provider, config.model, config.apiBase, config.apiKey].join('\u0000')).digest('hex') : null;
  if (legacy) {
    let alive = false;
    try { process.kill(legacy.pid, 0); alive = true; } catch { alive = false; }
    // Reuse the running bridge only when the injected model config matches; a
    // changed desktop configuration restarts it so the hosted UI is not stale.
    if (alive && signature === legacySignature) return { port: legacy.port, pid: legacy.pid, token: legacy.token };
    if (alive) await legacy.stop();
    legacy = null;
    legacySignature = null;
  }
  const sourceArg = process.argv.indexOf('--legacy-source');
  const scriptArg = process.argv.indexOf('--legacy-script');
  const depsArg = process.argv.indexOf('--legacy-deps');
  const source = sourceArg >= 0 ? resolve(process.argv[sourceArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const script = scriptArg >= 0 ? resolve(process.argv[scriptArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/legacy_server.py');
  // Dependency directory is normally fixed at daemon spawn time, but the renderer
  // may request it after an in-session install. Only an absolute path carrying a
  // matching desktop marker is accepted; nothing is read from untrusted input.
  const requested = typeof params?.deps === 'string' && isAbsolute(params.deps) ? params.deps : null;
  const requestedValid = requested !== null && existsSync(join(requested, '.suwen-workbench.json'));
  const deps = requestedValid ? (requested as string) : (depsArg >= 0 ? resolve(process.argv[depsArg + 1]) : undefined);
  if (!legacyStarting) legacyStarting = launchLegacy(pythonPath, script, source, join(home, 'legacy'), deps, undefined, config).then(handle => { legacySignature = signature; return handle; });
  try { legacy = await legacyStarting; return { port: legacy.port, pid: legacy.pid, token: legacy.token }; } finally { legacyStarting = null; }
};
handlers['shutdown'] = () => { setTimeout(() => void shutdown(), 100); return { ok: true }; };

async function dispatch(method: string, params: Record<string, Json>): Promise<Json> {
  const handler = handlers[method];
  if (!handler) throw new ValidationError('Unsupported RPC method');
  return handler(params ?? {});
}

const server = createServer(socket => {
  socket.setTimeout(120000, () => socket.destroy());
  let raw = '';
  let handled = false;
  socket.on('error', () => {});
  socket.on('data', chunk => {
    if (handled) return;
    raw += chunk.toString();
    if (raw.length > 4_000_000) { socket.destroy(); return; }
    if (!raw.includes('\n')) return;
    handled = true;
    void (async () => {
      try {
        const request = JSON.parse(raw.slice(0, raw.indexOf('\n'))) as { token?: string; method?: string; params?: unknown };
        if (!secretEqual(request.token, connection.token)) throw new Error('Unauthorized');
        if (typeof request.method !== 'string') throw new Error('Invalid method');
        if (request.method === 'legacyStart') socket.setTimeout(120000);
        const params = (request.params ?? {}) as Record<string, Json>;
        const result = await dispatch(request.method, params);
        socket.end(JSON.stringify({ result }) + '\n');
      } catch (err) {
        socket.end(JSON.stringify({ error: safeError(err) }) + '\n');
      }
    })();
  });
});
server.maxConnections = 32;
server.on('error', err => { console.error(safeError(err)); void shutdown(); });
server.listen(connection.pipe, () => atomicJson(connectionPath(home), connection));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.close();
  await engine.stop();
  if (legacy) await legacy.stop();
  await worker.close().catch(() => {});
  try { store.close(); } catch { /* already closed */ }
  try { unlinkSync(connectionPath(home)); unlinkSync(lockPath); } catch { /* best effort cleanup */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', reason => console.error('unhandledRejection', safeError(reason)));
