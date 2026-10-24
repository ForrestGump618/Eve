/** Read-only public database activities backed by the fixed MCP servers. */
import { join } from 'node:path';
import type { ActivityHandler, Json } from '../harness/types.js';
import { writeArtifact } from '../harness/artifacts.js';
import { queryViaMcp } from '../mcp-client.js';

export interface DatabaseActivityDeps { home: string }

export function createDatabaseActivities(deps: DatabaseActivityDeps): Record<string, ActivityHandler> {
  const databaseActivity = (kind: 'pubmed' | 'uniprot'): ActivityHandler => async ctx => {
    const input = (ctx.step.input ?? {}) as Record<string, Json>;
    const query = typeof input.query === 'string' ? input.query : '';
    if (!query.trim()) throw new Error(`${kind} query is required`);
    const output = await queryViaMcp(kind, query, ctx.signal);
    const artifact = await writeArtifact(join(deps.home, 'artifacts'), JSON.stringify(output), 'application/json');
    return { output, artifacts: [artifact] };
  };
  return { pubmed: databaseActivity('pubmed'), uniprot: databaseActivity('uniprot') };
}
