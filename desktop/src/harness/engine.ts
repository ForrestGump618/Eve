import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { ActivityHandler, ActivityResult, ConflictError, FailureOptions, Json, Lease, StepRun, TaskRun, ValidationError } from './types.js';

export interface EngineOptions {
  owner?: string; handlers?: Record<string, ActivityHandler>; leaseMs?: number; pollMs?: number;
  concurrency?: number; onError?: (error: unknown) => void;
  canRun?: (step: StepRun, task: TaskRun) => boolean;
}
export interface DurableWorkflowEngine { start(): void; stop(options?: { pause?: boolean }): Promise<void>; tick(): Promise<number> }
/** Scheduler runs outside Electron and injects all network/research capabilities as activities. */
export class Engine implements DurableWorkflowEngine {
  readonly owner: string;
  private readonly handlers: Record<string, ActivityHandler>;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { lease: Lease; controller: AbortController; promise: Promise<void> }>();
  private stopped = false;
  constructor(readonly store: Store, readonly options: EngineOptions = {}) {
    this.owner = options.owner ?? `worker-${process.pid}-${randomUUID()}`;
    this.handlers = { echo: async ({ step }) => ({ output: step.input ?? null }), ...options.handlers };
    this.leaseMs = options.leaseMs ?? 30000; this.concurrency = options.concurrency ?? 4;
    if (this.leaseMs < 30 || this.concurrency < 1 || !Number.isInteger(this.concurrency)) throw new ValidationError('leaseMs must be >=30; concurrency must be a positive integer');
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(e => this.options.onError?.(e)); }, this.options.pollMs ?? 250);
    void this.tick().catch(e => this.options.onError?.(e));
  }
  /** No completion may commit after stopping. Unknown side effects are retained for reconciliation. */
  async stop(options: { pause?: boolean } = {}): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const tasks = new Set([...this.active.values()].map(v => v.lease.task.id));
    if (options.pause !== false) for (const id of tasks) { try { this.store.pauseTask(id); } catch (e) { if (!(e instanceof ConflictError)) throw e; } }
    for (const value of this.active.values()) value.controller.abort(new Error('Engine stopped'));
    // Handlers may ignore abort; fencing makes their eventual replies inert. Do not await an untrusted handler.
  }
  async tick(): Promise<number> {
    if (this.stopped) return 0;
    // The scheduler is intentionally durable, but an idle application must
    // not open two SQLite write transactions four times per second forever.
    if (!this.store.hasPendingWork()) return 0;
    this.store.reclaimExpired();
    for (const value of this.active.values()) if (!this.store.isLeaseValid(value.lease)) value.controller.abort(new Error('Lease invalidated'));
    let count = 0;
    while (this.active.size < this.concurrency) {
      const lease = this.store.claim(this.owner, this.leaseMs, this.options.canRun); if (!lease) break;
      const controller = new AbortController();
      const key = `${lease.task.id}:${lease.step.id}:${lease.fence}`;
      const promise = Promise.resolve().then(() => this.execute(lease, controller)).catch(e => this.options.onError?.(e)).finally(() => this.active.delete(key));
      this.active.set(key, { lease, controller, promise }); count++;
    }
    return count;
  }
  async whenIdle(): Promise<void> { await Promise.all([...this.active.values()].map(x => x.promise)); }
  get runningCount(): number { return this.active.size; }
  private async execute(lease: Lease, controller: AbortController): Promise<void> {
    const { step } = lease;
    if (this.stopped || controller.signal.aborted || !this.store.isLeaseValid(lease)) return;
    try {
      if (step.kind === 'delay') {
        const input = step.input;
        const ms = typeof input === 'number' ? input : input && typeof input === 'object' && !Array.isArray(input) ? input.ms : undefined;
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new ValidationError('delay input requires nonnegative ms');
        this.store.defer(lease, ms); return;
      }
      if (step.kind === 'approval') { this.store.waitForApproval(lease); return; }
      const handler = this.handlers[step.kind]; if (!handler) throw new ValidationError(`No activity handler registered for ${step.kind}`);
      let heartbeatError: unknown;
      const heartbeat = (): boolean => { try { return this.store.heartbeat(lease, this.leaseMs); } catch (error) { heartbeatError = error; controller.abort(error); return false; } };
      const interval = setInterval(heartbeat, Math.max(10, Math.floor(Math.min(this.leaseMs, step.timeoutMs) / 3))); interval.unref();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          abortListener = () => reject(controller.signal.reason ?? new Error('Activity aborted'));
          if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener('abort', abortListener, { once: true });
        });
        timeout = setTimeout(() => controller.abort(new Error(`Activity timed out after ${step.timeoutMs} ms`)), step.timeoutMs);
        const result = await Promise.race([handler({ task: lease.task, step, operationId: step.operationId, signal: controller.signal, heartbeat }), aborted]);
        if (controller.signal.aborted || heartbeatError || this.stopped) return;
        if (result && typeof result === 'object' && !Array.isArray(result) && Object.hasOwn(result, 'output')) {
          const envelope = result as ActivityResult; this.store.complete(lease, envelope.output, envelope);
        } else this.store.complete(lease, result as Json);
      } finally {
        clearInterval(interval); if (timeout) clearTimeout(timeout);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      }
    } catch (error) {
      // Cancellation, pause and a newer owner all revoke this execution's authority.
      if (!this.store.isLeaseValid(lease)) return;
      const classified = error as Error & FailureOptions;
      try { this.store.fail(lease, error, { retryable: error instanceof ValidationError ? false : classified.retryable, definitive: error instanceof ValidationError ? true : classified.definitive, retryAfterMs: classified.retryAfterMs }); }
      catch (failure) { if (!(failure instanceof ConflictError)) throw failure; }
    }
  }
}
