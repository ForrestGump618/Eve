import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactReference } from './types.js';

/** Write immutable artifacts before committing their references in Store.complete().
 * A crash before the database commit can leave an unreferenced file, never a partial indexed artifact.
 */
export async function writeArtifact(root: string, data: string | Uint8Array, mediaType?: string): Promise<ArtifactReference> {
  await mkdir(root, { recursive: true });
  const id = randomUUID(); const temp = join(root, `.${id}.pending`); const path = join(root, `${id}.artifact`);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await open(temp, 'wx');
  try { await file.writeFile(bytes); await file.sync(); } catch (error) { await file.close(); await rm(temp, { force: true }); throw error; }
  await file.close();
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
  return { id, path, sha256, bytes: bytes.byteLength, mediaType };
}
export async function verifyArtifact(artifact: ArtifactReference): Promise<boolean> {
  try {
    if ((await stat(artifact.path)).size !== artifact.bytes) return false;
    const hash = createHash('sha256'); for await (const chunk of createReadStream(artifact.path)) hash.update(chunk);
    return hash.digest('hex') === artifact.sha256;
  } catch { return false; }
}
