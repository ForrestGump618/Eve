import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ContextOptions, ContextResult, PrepareContext } from './context.js';

type WorkerResponse = { ok: true; result: ContextResult } | { ok: false; code: 'CONTEXT_BUDGET' | 'CONTEXT_PREPARATION_FAILED' };

// One writer per canonical directory inside this daemon process. This is not an
// inter-process lock: a separate daemon must not own the same context directory.
const queues = new Map<string, Promise<void>>();

function directoryKey(directory: string): string {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonical = join(realpathSync.native(ancestor), ...missing);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function cancelled(): Error {
  const error = new Error('Context preparation cancelled');
  error.name = 'AbortError';
  return error;
}

function preparationFailed(code = 'CONTEXT_PREPARATION_FAILED'): Error {
  // Worker exceptions may include user input, paths or provider credentials.
  // Only fixed codes cross the error boundary; no original stack or message.
  return Object.assign(new Error(code === 'CONTEXT_BUDGET' ? 'Context budget cannot safely fit this request' : 'Context preparation failed'), { code });
}

function runWorker(options: ContextOptions, input: PrepareContext, signal?: AbortSignal): Promise<ContextResult> {
  return new Promise((resolveResult, rejectResult) => {
    if (signal?.aborted) { rejectResult(cancelled()); return; }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./context-worker.js', import.meta.url), { workerData: { options, input } });
    } catch {
      rejectResult(preparationFailed()); return;
    }
    let response: WorkerResponse | undefined;
    let failed = false;
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      // Keep the directory queue occupied until the old writer has exited.
      void worker.terminate().catch(() => undefined);
    };
    worker.once('message', (message: WorkerResponse) => { response = message; });
    worker.once('error', () => { failed = true; });
    worker.once('exit', (exitCode) => {
      signal?.removeEventListener('abort', abort);
      if (aborted || signal?.aborted) { rejectResult(cancelled()); return; }
      if (failed || exitCode !== 0 || !response) { rejectResult(preparationFailed()); return; }
      if (!response.ok) { rejectResult(preparationFailed(response.code)); return; }
      resolveResult(response.result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Run tokenization, compaction and synchronous archive IO off the daemon loop.
 * Same-directory calls are serialized; cancelled queued calls never start a
 * worker. Cancellation of running work can preserve already committed raw
 * records, and does not erase them or pretend that they were never written.
 */
export function prepareContextAsync(options: ContextOptions, input: PrepareContext, signal?: AbortSignal): Promise<ContextResult> {
  if (signal?.aborted) return Promise.reject(cancelled());
  let key: string;
  let queuedOptions: ContextOptions;
  let queuedInput: PrepareContext;
  try {
    if (options.compaction !== undefined) throw new Error('Worker compaction extensions must be data-only');
    key = directoryKey(options.directory);
    queuedOptions = { ...options };
    queuedInput = structuredClone(input);
  } catch {
    return Promise.reject(preparationFailed());
  }
  const previous = queues.get(key) ?? Promise.resolve();
  const work = previous.then(() => runWorker(queuedOptions, queuedInput, signal));
  const tail = work.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  if (!signal) return work;

  // Return immediately when a queued request is cancelled, without releasing
  // its queue slot early or allowing it to write once earlier work completes.
  let abortListener: (() => void) | undefined;
  const earlyAbort = new Promise<ContextResult>((_resolve, reject) => {
    abortListener = () => reject(cancelled());
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  return Promise.race([work, earlyAbort]).finally(() => {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  });
}
