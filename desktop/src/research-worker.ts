/**
 * Long-lived research-worker client.
 *
 * Spawns `worker/research_worker.py` once and talks to it over line-delimited
 * JSON-RPC (one request line, one response line). The client adds:
 *  - request ids and per-request timeouts (worker-side `runScript` timeout + slack),
 *  - `AbortSignal` cancellation that kills the process tree and restarts it,
 *  - crash detection with bounded exponential restart backoff,
 *  - a bounded stderr ring buffer for diagnostics,
 *  - a `health()` that degrades to WorkerHealth `unavailable` when Python or the
 *    worker script is missing instead of throwing.
 *
 * Only `node:` builtins and type-only local imports are used so the module can
 * be wired into any harness surface (daemon, main) without pulling dependencies.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from './harness/types.js';
import type { WorkerClient, WorkerHealth } from './shared/contract.js';

/** Protocol tag emitted by the Python worker (`describe().protocol`). */
export const RESEARCH_WORKER_PROTOCOL = 'suwen-research-worker/2';

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_RESTART_BACKOFF_MS = 2_000;
const BASE_RESTART_BACKOFF_MS = 100;
const CLOSE_GRACE_MS = 500;
const MAX_WORKER_TIMEOUT_MS = 600_000;

/** Environment variables forwarded to the worker process (allowlist only). */
const ENV_ALLOWLIST = [
  'SYSTEMROOT',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
] as const;

export type ResearchWorkerState = 'idle' | 'spawning' | 'ready' | 'crashed' | 'unavailable' | 'closed';

export interface ResearchWorkerStatus {
  state: ResearchWorkerState;
  pid: number | null;
  restarts: number;
  lastError: string | null;
}

export interface ResearchWorkerDiagnostics extends ResearchWorkerStatus {
  stderr: string;
  pending: number;
  python: string;
  script: string | null;
}

export interface ResearchWorkerOptions {
  /** Python executable. Defaults to SUWEN_PYTHON, then `python` on PATH. */
  python?: string;
  /** Explicit worker script path; otherwise resolved relative to this module. */
  scriptPath?: string;
  /** Timeout for ordinary ops. Defaults to 180_000 ms. */
  requestTimeoutMs?: number;
  /** Timeout for startup, `health` and `describe`. Defaults to 30_000 ms. */
  startupTimeoutMs?: number;
  /** Maximum accepted stdout line length. Defaults to 32 MiB. */
  maxLineBytes?: number;
  /** Tail of stderr retained for diagnostics. Defaults to 64 KiB. */
  maxStderrBytes?: number;
  /** Upper bound of the crash restart backoff. Defaults to 2_000 ms. */
  restartBackoffMs?: number;
  /** Node executable injected into `runScript` node calls when set. */
  nodePath?: string;
}

/** Structured client-side (or forwarded worker-side) failure. */
export class ResearchWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResearchWorkerError';
    this.code = code;
  }
}

/** Resolve the bundled worker script without starting a process. */
export function resolveResearchWorkerScript(options: Pick<ResearchWorkerOptions, 'scriptPath'> = {}): string {
  const candidates: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  push(options.scriptPath);
  push(process.env.SUWEN_WORKER_SCRIPT);
  // dist/src/research-worker.js -> desktop/worker/research_worker.py
  push(fileURLToPath(new URL('../../worker/research_worker.py', import.meta.url)));
  // dist/research-worker.js -> desktop/worker/research_worker.py
  push(fileURLToPath(new URL('../worker/research_worker.py', import.meta.url)));
  push(resolve(process.cwd(), 'worker', 'research_worker.py'));
  push(resolve(process.cwd(), 'desktop', 'worker', 'research_worker.py'));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new ResearchWorkerError(
    'WORKER_UNAVAILABLE',
    `research_worker.py not found; looked in: ${candidates.join(', ')}`,
  );
}

interface PendingRequest {
  id: number;
  op: string;
  timer: NodeJS.Timeout;
  cleanup: () => void;
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const deferred: Deferred = {
    promise,
    settled: false,
    resolve: () => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise();
    },
    reject: (error: Error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
}

function delay(ms: number): Promise<void> {
  // Deliberately ref'd: an unref'd restart timer can be dropped while an
  // awaiting caller is still pending, silently leaving that promise unsettled.
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms);
  });
}

function isJsonObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

const NEVER_ABORTED = new AbortController().signal;

/** Persistent, restartable research worker. */
export class ResearchWorkerClient implements WorkerClient {
  private readonly options: Required<Pick<ResearchWorkerOptions, 'requestTimeoutMs' | 'startupTimeoutMs' | 'maxLineBytes' | 'maxStderrBytes' | 'restartBackoffMs'>> & ResearchWorkerOptions;
  private readonly python: string;
  private readonly script: string | null;
  private readonly scriptError: string | null;
  private readonly intentionalKills = new WeakSet<ChildProcess>();

  private child: ChildProcess | null = null;
  private spawnTask: Promise<void> | null = null;
  private spawnDeferred: Deferred | null = null;
  private spawnTimer: NodeJS.Timeout | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private state: ResearchWorkerState = 'idle';
  private restarts = 0;
  private consecutiveCrashes = 0;
  private restartAt = 0;
  private lastError: string | null = null;
  private stderrText = '';
  private stdoutBuffer = '';
  private closed = false;

  constructor(options: ResearchWorkerOptions = {}) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      restartBackoffMs: options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS,
    };
    this.python = options.python ?? process.env.SUWEN_PYTHON ?? 'python';
    try {
      this.script = resolveResearchWorkerScript(options);
      this.scriptError = null;
    } catch (error) {
      this.script = null;
      this.scriptError = errorMessage(error);
      this.state = 'unavailable';
      this.lastError = this.scriptError;
    }
  }

  /** Best-effort health check; never throws for a missing interpreter or script. */
  async health(): Promise<WorkerHealth> {
    if (this.closed) {
      return { status: 'unavailable', python: this.python, error: 'Research worker client is closed' };
    }
    if (!this.script) {
      return { status: 'unavailable', python: this.python, error: this.scriptError ?? 'research worker script is unavailable' };
    }
    try {
      const result = await this.dispatch('health', {}, null, this.options.startupTimeoutMs);
      if (!isJsonObject(result)) throw new ResearchWorkerError('WORKER_PROTOCOL', 'health result must be a JSON object');
      const health: WorkerHealth = { status: 'ok' };
      health.python = typeof result.python === 'string' ? result.python : this.python;
      if (typeof result.version === 'string') health.version = result.version;
      if (Array.isArray(result.capabilities)) {
        health.capabilities = result.capabilities.filter((entry): entry is string => typeof entry === 'string');
      }
      if (isJsonObject(result.deps)) {
        const deps: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(result.deps)) {
          if (value === null || typeof value === 'string') deps[key] = value;
        }
        health.deps = deps;
      }
      // Preserve the remaining worker-reported facts for diagnostics/doctor output.
      return Object.assign(health, {
        protocol: result.protocol ?? null,
        platform: result.platform ?? null,
        isolation: result.isolation ?? null,
        limits: result.limits ?? null,
        features: result.features ?? null,
      }) as WorkerHealth;
    } catch (error) {
      const message = errorMessage(error);
      this.lastError = message;
      return { status: 'unavailable', python: this.python, error: message };
    }
  }

  /** Worker capability document (`describe` op). */
  async describe(signal: AbortSignal = NEVER_ABORTED): Promise<Json> {
    return this.call('describe', {}, signal);
  }

  /** Send one typed op to the worker. Rejects with ResearchWorkerError on failure. */
  async call(op: string, input: Json, signal: AbortSignal): Promise<Json> {
    if (typeof op !== 'string' || op.length === 0) {
      throw new ResearchWorkerError('INVALID_INPUT', 'op must be a non-empty string');
    }
    if (this.closed) throw new ResearchWorkerError('WORKER_CLOSED', 'Research worker client is closed');
    const effectiveSignal = signal ?? NEVER_ABORTED;
    if (effectiveSignal.aborted) throw new ResearchWorkerError('WORKER_CANCELLED', `Research worker request '${op}' was cancelled before it started`);
    return this.dispatch(op, this.injectRuntimeOptions(op, input), effectiveSignal, this.timeoutFor(op, input));
  }

  status(): ResearchWorkerStatus {
    return { state: this.state, pid: this.child?.pid ?? null, restarts: this.restarts, lastError: this.lastError };
  }

  diagnostics(): ResearchWorkerDiagnostics {
    return {
      ...this.status(),
      stderr: this.stderrTail(),
      pending: this.pending.size,
      python: this.python,
      script: this.script,
    };
  }

  /** Stop the worker and reject in-flight requests. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.rejectAll(new ResearchWorkerError('WORKER_CLOSED', 'Research worker client is closed'));
    const child = this.child;
    this.child = null;
    this.spawnTask = null;
    this.spawnDeferred = null;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    this.stdoutBuffer = '';
    if (!child) return;
    this.intentionalKills.add(child);
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be destroyed; the kill below still applies.
    }
    const exited = await this.waitForExit(child, CLOSE_GRACE_MS);
    if (!exited) this.killTree(child);
  }

  // ---------------------------------------------------------------- internals

  private timeoutFor(op: string, input: Json): number {
    if (op === 'health' || op === 'describe') return this.options.startupTimeoutMs;
    const workerTimeout = isJsonObject(input) && typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : null;
    if (op === 'runScript' && workerTimeout !== null) {
      return Math.max(5_000, Math.min(MAX_WORKER_TIMEOUT_MS + 30_000, workerTimeout + 30_000));
    }
    return this.options.requestTimeoutMs;
  }

  /** In packaged Electron builds, Node runtime calls should use the bundled runtime. */
  private injectRuntimeOptions(op: string, input: Json): Json {
    if (op !== 'runScript' || !isJsonObject(input)) return input;
    const nodePath = this.options.nodePath ?? (process.versions.electron ? process.execPath : undefined);
    if (typeof nodePath !== 'string' || nodePath.length === 0) return input;
    if (input.language !== 'node' || typeof input.nodePath === 'string') return input;
    return { ...input, nodePath };
  }

  private async dispatch(op: string, input: Json, signal: AbortSignal | null, timeoutMs: number): Promise<Json> {
    if (this.closed) throw new ResearchWorkerError('WORKER_CLOSED', 'Research worker client is closed');
    if (!this.script) throw new ResearchWorkerError('WORKER_UNAVAILABLE', this.scriptError ?? 'research worker script is unavailable');
    await this.ensureReady();
    const id = ++this.nextId;
    return new Promise<Json>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.failRequest(id, 'WORKER_TIMEOUT', `Research worker request '${op}' exceeded ${timeoutMs} ms`, true);
      }, timeoutMs);
      timer.unref();
      const onAbort = (): void => {
        this.failRequest(id, 'WORKER_CANCELLED', `Research worker request '${op}' was cancelled`, true);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        id,
        op,
        timer,
        cleanup: () => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        },
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      const child = this.child;
      try {
        if (!child?.stdin) throw new Error('worker stdin is unavailable');
        child.stdin.write(`${JSON.stringify({ id, op, input })}\n`);
      } catch (error) {
        this.failRequest(id, 'WORKER_UNAVAILABLE', `Failed to write to research worker: ${errorMessage(error)}`, false);
      }
    });
  }

  private failRequest(id: number, code: string, message: string, terminate: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(new ResearchWorkerError(code, message));
    if (terminate) this.crashAndRestart(message);
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.cleanup();
      request.reject(error);
    }
  }

  private crashAndRestart(reason: string): void {
    if (this.closed) return;
    this.lastError = reason;
    this.dropChild();
    this.state = 'crashed';
    this.recordCrash();
    this.rejectAll(new ResearchWorkerError('WORKER_CRASHED', `Research worker was restarted after: ${reason}`));
  }

  private recordCrash(): void {
    this.restarts += 1;
    this.consecutiveCrashes += 1;
    const backoff = Math.min(
      this.options.restartBackoffMs,
      BASE_RESTART_BACKOFF_MS * 2 ** Math.max(0, this.consecutiveCrashes - 1),
    );
    this.restartAt = Date.now() + backoff;
  }

  private dropChild(): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = '';
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    if (this.spawnDeferred) {
      this.spawnDeferred.reject(new ResearchWorkerError('WORKER_CRASHED', this.lastError ?? 'research worker terminated'));
      this.spawnDeferred = null;
    }
    if (!child) return;
    this.intentionalKills.add(child);
    try {
      child.stdin?.end();
    } catch {
      // ignore: the process is being killed anyway
    }
    this.killTree(child);
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new ResearchWorkerError('WORKER_CLOSED', 'Research worker client is closed');
    if (!this.script) throw new ResearchWorkerError('WORKER_UNAVAILABLE', this.scriptError ?? 'research worker script is unavailable');
    if (this.state === 'ready' && this.child) return;
    if (this.state === 'crashed') {
      const wait = this.restartAt - Date.now();
      if (wait > 0) await delay(wait);
    }
    if (!this.spawnTask) {
      const task = this.spawnChild();
      this.spawnTask = task;
      void task.finally(() => {
        if (this.spawnTask === task) this.spawnTask = null;
      }).catch(() => undefined);
    }
    await this.spawnTask;
    if (!this.child || this.state !== 'ready') {
      throw new ResearchWorkerError('WORKER_UNAVAILABLE', this.lastError ?? 'Research worker failed to start');
    }
  }

  private async spawnChild(): Promise<void> {
    this.state = 'spawning';
    const env = this.buildEnv();
    let child: ChildProcess;
    try {
      child = spawn(this.python, ['-u', this.script as string], {
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      this.state = 'unavailable';
      this.lastError = `Failed to start research worker: ${errorMessage(error)}`;
      throw new ResearchWorkerError('WORKER_UNAVAILABLE', this.lastError);
    }
    this.child = child;
    this.stdoutBuffer = '';
    const deferred = createDeferred();
    this.spawnDeferred = deferred;
    this.spawnTimer = setTimeout(() => {
      const message = `Research worker did not become ready within ${this.options.startupTimeoutMs} ms`;
      this.lastError = message;
      this.failSpawn(child, deferred, new ResearchWorkerError('WORKER_TIMEOUT', message));
    }, this.options.startupTimeoutMs);
    this.spawnTimer.unref();

    child.once('spawn', () => {
      if (this.child !== child) return;
      this.state = 'ready';
      this.clearSpawnTimer();
      this.spawnDeferred = null;
      deferred.resolve();
    });
    child.once('error', (error: Error) => {
      if (this.child !== child) return;
      this.failSpawn(child, deferred, new ResearchWorkerError('WORKER_UNAVAILABLE', `Failed to start research worker: ${error.message}`));
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
    child.once('exit', (code, signal) => this.onChildExit(child, code, signal));
    await deferred.promise;
  }

  private failSpawn(child: ChildProcess, deferred: Deferred, error: ResearchWorkerError): void {
    if (deferred.settled) return;
    this.lastError = error.message;
    this.state = 'unavailable';
    this.clearSpawnTimer();
    this.spawnDeferred = null;
    if (this.child === child) {
      this.intentionalKills.add(child);
      this.child = null;
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      this.killTree(child);
    }
    deferred.reject(error);
  }

  private clearSpawnTimer(): void {
    if (!this.spawnTimer) return;
    clearTimeout(this.spawnTimer);
    this.spawnTimer = null;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (typeof value === 'string' && value.length > 0) env[key] = value;
    }
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONNOUSERSITE = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.SUWEN_NODE_PATH = this.options.nodePath ?? process.execPath;
    return env;
  }

  private onStdout(child: ChildProcess, chunk: string): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) {
        if (line.length > this.options.maxLineBytes) {
          this.protocolFailure(`Research worker emitted an oversized line (${line.length} chars)`);
          return;
        }
        this.handleLine(line);
        if (this.child !== child) return;
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > this.options.maxLineBytes) {
      this.protocolFailure(`Research worker stdout buffer exceeded ${this.options.maxLineBytes} chars without a newline`);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrText += chunk;
    const limit = this.options.maxStderrBytes;
    if (this.stderrText.length > limit) this.stderrText = this.stderrText.slice(this.stderrText.length - limit);
  }

  private stderrTail(): string {
    return this.stderrText;
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.protocolFailure('Research worker emitted invalid JSON');
      return;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      this.protocolFailure('Research worker response must be a JSON object');
      return;
    }
    const record = payload as Record<string, unknown>;
    const id = typeof record.id === 'number' && Number.isInteger(record.id) ? record.id : null;
    if (id === null) {
      this.protocolFailure('Research worker response is missing a numeric id');
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return; // response for a request that was already timed out or cancelled
    this.pending.delete(id);
    pending.cleanup();
    this.consecutiveCrashes = 0;
    if (record.ok === true) {
      pending.resolve((record.result ?? null) as Json);
      return;
    }
    const error = typeof record.error === 'object' && record.error !== null && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : null;
    const code = typeof error?.code === 'string' ? error.code : 'WORKER_ERROR';
    const message = typeof error?.message === 'string' ? error.message : `Research worker op '${pending.op}' failed`;
    pending.reject(new ResearchWorkerError(code, message));
  }

  private protocolFailure(reason: string): void {
    this.crashAndRestart(reason);
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.intentionalKills.has(child)) {
      this.intentionalKills.delete(child);
      if (this.child === child) this.child = null;
      return;
    }
    if (this.child !== child) return;
    this.child = null;
    this.stdoutBuffer = '';
    if (this.spawnDeferred) {
      this.spawnDeferred.reject(new ResearchWorkerError(
        'WORKER_CRASHED',
        `Research worker exited during startup (code ${String(code)}, signal ${String(signal)})`,
      ));
      this.spawnDeferred = null;
    }
    this.state = 'crashed';
    this.lastError = `Research worker exited unexpectedly (code ${String(code)}, signal ${String(signal)})`;
    this.recordCrash();
    this.rejectAll(new ResearchWorkerError('WORKER_CRASHED', this.lastError));
  }

  private killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (process.platform === 'win32') {
      if (typeof pid === 'number') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      return;
    }
    if (typeof pid === 'number') {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // fall through to a plain kill
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>(resolveWait => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolveWait(false);
      }, timeoutMs);
      timer.unref();
      const onExit = (): void => {
        clearTimeout(timer);
        resolveWait(true);
      };
      child.once('exit', onExit);
    });
  }
}

/** Create the long-lived research worker client used by `ActivityServices.worker`. */
export function createResearchWorker(options: ResearchWorkerOptions = {}): ResearchWorkerClient {
  return new ResearchWorkerClient(options);
}
