import { Worker } from 'node:worker_threads';
import type { ContextOptions, SourceRef } from './context.js';
import type { Json } from './harness/types.js';

/** Tokenizers, journal verification and recall stay off the daemon's event loop. */
export type ContextQuery='inspect'|'source'|'requests'|'request'|'search';
export function queryContextAsync(options: ContextOptions, operation: ContextQuery, source?: SourceRef, query?:{sequence?:number;offset?:number;limit?:number;text?:string}): Promise<Json> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./context-query-worker.js', import.meta.url), {workerData:{options,operation,source,query}});
    let result: {ok:boolean;value?:Json} | undefined;
    const timeout = setTimeout(() => { void worker.terminate(); }, 15000);
    worker.once('message', value => { result=value; });
    worker.once('error', () => { /* Fixed errors only; never relay private worker data. */ });
    worker.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && result?.ok) resolve(result.value ?? null);
      else reject(new Error('上下文读取失败；原始记录未修改'));
    });
  });
}
