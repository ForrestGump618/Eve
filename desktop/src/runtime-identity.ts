import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RuntimeIdentity {
  version: string;
  buildId: string | null;
  runtimeRoot: string;
}

/** Version alone cannot identify a build: development and release builds can
 * share 1.0.0 while serving different Python modules and UI assets. */
export function runtimeIdentity(version: string, distRoot: string): RuntimeIdentity {
  let buildId: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(join(distRoot, 'build-info.json'), 'utf8'));
    if (typeof manifest.buildId === 'string' && /^[a-f0-9]{64}$/.test(manifest.buildId)) {
      buildId = manifest.buildId;
    }
  } catch { /* Unidentified builds must not reuse a detached runtime. */ }
  return { version, buildId, runtimeRoot: resolve(distRoot) };
}

export function compatibleRuntime(actual: Partial<RuntimeIdentity>, expected: RuntimeIdentity): boolean {
  return Boolean(expected.buildId
    && actual.version === expected.version
    && actual.buildId === expected.buildId
    && actual.runtimeRoot === expected.runtimeRoot);
}

/** Paused work and unanswered approvals are durable records, not live activity.
 * They survive a clean daemon shutdown; runnable work must finish first. */
export function blocksRuntimeUpgrade(snapshot: {
  tasks: Array<{ status: string; steps?: Array<{ status: string }> }>;
}): boolean {
  const dormant = new Set(['completed', 'failed', 'cancelled', 'paused', 'waiting_approval']);
  return snapshot.tasks.some(task => !dormant.has(task.status)
    || task.steps?.some(step => step.status === 'running'));
}

/** Legacy console switches are supported only in explicitly isolated test
 * profiles. Normal and installed launches always open the formal workbench. */
export function diagnosticConsole(args: readonly string[], testHome?: string): boolean {
  return Boolean(testHome && args.includes('--native'));
}
