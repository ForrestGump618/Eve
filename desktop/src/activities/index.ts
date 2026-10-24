/**
 * Single registration point for every durable activity kind.
 *
 * The durable engine accepts a kind only when a handler exists here, so this
 * module is the authoritative mapping between `TASK_STEP_KINDS` and code.
 */
import type { ActivityHandler, ArtifactReference, Json } from '../harness/types.js';
import { ValidationError } from '../harness/types.js';
import type { ActivityServices } from '../shared/contract.js';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { writeArtifact } from '../harness/artifacts.js';
import { createModelActivity, type ModelActivityDeps } from './model.js';
import { createDatabaseActivities } from './databases.js';
import { createResearchHandlers } from './research.js';
import { createToolHandlers, type ToolServices } from './tools.js';

export interface AllActivityDeps {
  model: ModelActivityDeps;
  databases: { home: string };
  toolServices: ToolServices;
}

/**
 * `python` steps execute inside the isolated Python research worker.
 *
 * The step input is the typed `runScript` request ({ source, args, files, ... });
 * arbitrary shell is still impossible because the worker rejects unknown ops and
 * the desktop never passes the script through a shell.
 */
/**
 * Commit the sandbox files reported by the worker as durable artifacts.
 *
 * The worker owns the sandbox directory, so the activity re-reads each claimed
 * file and writes an immutable copy under `home/artifacts`; the recorded digest
 * then proves exactly which bytes a later verification step can rely on.
 */
async function commitWorkerArtifacts(services: ActivityServices, output: Record<string, Json>): Promise<ArtifactReference[]> {
  const sandbox = typeof output.sandbox === 'string' ? resolve(output.sandbox) : null;
  const files = Array.isArray(output.files) ? output.files : [];
  const artifacts: ArtifactReference[] = [];
  if (!sandbox) return artifacts;
  const maxBytes = 8 * 1024 * 1024;
  for (const raw of files.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, Json>;
    if (entry.input === true) continue;
    const relative = typeof entry.path === 'string' ? entry.path : null;
    const bytes = typeof entry.bytes === 'number' ? entry.bytes : 0;
    if (!relative || typeof entry.sha256 !== 'string' || bytes < 0 || bytes > maxBytes) continue;
    const full = resolve(sandbox, relative);
    if (!full.startsWith(sandbox + sep)) continue;
    try {
      artifacts.push(await writeArtifact(join(services.home, 'artifacts'), await readFile(full), 'application/octet-stream'));
    } catch { /* file changed or removed after the worker reported it: skip explicitly */ }
  }
  return artifacts;
}

function createPythonActivity(services: ActivityServices): ActivityHandler {
  return async ctx => {
    const raw = ctx.step.input === undefined || ctx.step.input === null ? {} : ctx.step.input;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('python step input must be an object with a source string');
    const input = raw as Record<string, Json>;
    if (typeof input.source !== 'string' || !input.source.trim()) throw new ValidationError('python step input.source must be a non-empty string');
    const sandboxRoot = typeof input.sandboxRoot === 'string' && input.sandboxRoot.length > 0 ? input.sandboxRoot : join(services.home, 'sandbox');
    mkdirSync(sandboxRoot, { recursive: true });
    const output = (await services.worker.call('runScript', { language: 'python', ...input, sandboxRoot } as Json, ctx.signal)) as Record<string, Json>;
    const artifacts = await commitWorkerArtifacts(services, output);
    return { output, artifacts };
  };
}

/**
 * Build the complete handler table.
 *
 * `services` is the same object handed to research/tool activities; model and
 * database handlers receive their narrower dependencies explicitly so that
 * stream bookkeeping and home isolation cannot be bypassed by a caller.
 */
export function createAllActivities(services: ActivityServices, deps: AllActivityDeps): Record<string, ActivityHandler> {
  const toolServices: ActivityServices & { tools?: ToolServices } = { ...services, tools: deps.toolServices };
  return {
    model: createModelActivity(deps.model),
    python: createPythonActivity(services),
    ...createDatabaseActivities(deps.databases),
    ...createResearchHandlers(services),
    ...createToolHandlers(toolServices),
  };
}

export type { ModelActivityDeps } from './model.js';
export type { ToolServices } from './tools.js';
