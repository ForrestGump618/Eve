import { parentPort, workerData } from 'node:worker_threads';
import { ContextBudgetError, ContextManager, type ContextOptions, type PrepareContext } from './context.js';

// This module is the private thread entry point. Never log workerData or relay
// exception text: either can contain unredacted task data or credentials.
if (parentPort) {
  try {
    const { options, input } = workerData as { options: ContextOptions; input: PrepareContext };
    const result = new ContextManager(options).prepare(input);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error instanceof ContextBudgetError ? 'CONTEXT_BUDGET' : 'CONTEXT_PREPARATION_FAILED' });
  } finally {
    parentPort.close();
  }
}
