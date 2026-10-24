/**
 * Non-destructive, backup-first import of the legacy SuWen/OmicLab data home.
 *
 * The legacy source is only ever read. Every write performed by this service
 * happens under the new vNext home (backups, copied artifacts and versioned
 * records). Secrets such as `auth.json` and `ssh.json` are never imported, and
 * API keys from `settings.json` are excluded by key pattern.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Json } from './harness/types.js';
import type { RecordStore } from './shared/contract.js';
import { ValidationError } from './harness/types.js';

export const IMPORT_KINDS = ['conversations', 'settings', 'memory', 'discovery', 'registry', 'trajectories', 'figures', 'uploads'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

const SECRET_FILE_PATTERNS = [/^auth\.json$/i, /^ssh\.json$/i, /^ssh_known_hosts\.json$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)/i;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_COPY_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_MESSAGES = 4000;

interface InspectItem { kind: string; name: string; count: number; path: string; bytes: number; importable: boolean; note?: string }
export interface ImportInspect { legacyHome: string; exists: boolean; inspectedAt: number; items: InspectItem[]; counts: Record<string, number>; warnings: string[] }
export interface ImportApplyOptions { kinds?: string[]; dryRun?: boolean }
export interface ImportJobView {
  id: string;
  at: number;
  kinds: string[];
  status: 'dry_run' | 'completed' | 'partial' | 'rolled_back';
  backupPath: string | null;
  counts: { imported: number; skipped: number; failed: number; filesCopied: number; bytesCopied: number };
  warnings: string[];
  createdRecordIds: string[];
  legacyHome: string;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
function sha256Buffer(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeRelative(root: string, path: string): string {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || /^[A-Za-z]:/.test(rel)) throw new ValidationError('Import path escaped the legacy home');
  return rel.split(sep).join('/');
}
function listFiles(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      if (SECRET_FILE_PATTERNS.some(pattern => pattern.test(entry.name))) continue;
      out.push(full);
      if (out.length >= limit) break;
    }
  }
  return out;
}
function readJson(path: string): Json | undefined {
  try {
    if (statSync(path).size > MAX_SOURCE_FILE_BYTES) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch { return undefined; }
}
function toMillis(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  // Legacy timestamps are seconds; values above ~10^11 are already milliseconds.
  return num > 100_000_000_000 ? Math.round(num) : Math.round(num * 1000);
}
function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.length > limit ? value.slice(0, limit) : value;
}
function isJsonObject(value: Json | undefined): value is Record<string, Json> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface ImportServiceOptions { legacyHome?: string; clock?: () => number }
export class ImportService {
  private readonly legacyHome: string;
  private readonly clock: () => number;
  private readonly home: string;
  constructor(private readonly store: RecordStore, home: string, options: ImportServiceOptions = {}) {
    this.home = resolve(home);
    const configured = options.legacyHome ?? process.env.SUWEN_LEGACY_HOME ?? join(homedir(), '.omicslab');
    this.legacyHome = resolve(configured);
    this.clock = options.clock ?? Date.now;
  }

  inspect(): ImportInspect {
    const warnings: string[] = [];
    const items: InspectItem[] = [];
    const exists = existsSync(this.legacyHome);
    if (!exists) {
      return { legacyHome: this.legacyHome, exists: false, inspectedAt: this.clock(), items, counts: { totalFiles: 0, totalBytes: 0 }, warnings: [`Legacy home not found: ${this.legacyHome}`] };
    }
    const sources: Array<{ kind: ImportKind | 'settings'; dir: string }> = [
      { kind: 'conversations', dir: join(this.legacyHome, 'conversations') },
      { kind: 'settings', dir: join(this.legacyHome, 'settings.json') },
      { kind: 'memory', dir: join(this.legacyHome, 'memory') },
      { kind: 'discovery', dir: join(this.legacyHome, 'discovery') },
      { kind: 'registry', dir: join(this.legacyHome, 'registry') },
      { kind: 'trajectories', dir: join(this.legacyHome, 'trajectories') },
      { kind: 'figures', dir: join(this.legacyHome, 'figures') },
      { kind: 'uploads', dir: join(this.legacyHome, 'uploads') }
    ];
    let totalFiles = 0, totalBytes = 0;
    for (const source of sources) {
      if (!existsSync(source.dir)) { items.push({ kind: source.kind, name: basename(source.dir), count: 0, path: source.dir, bytes: 0, importable: true, note: 'absent' }); continue; }
      const stat = statSync(source.dir);
      const files = stat.isDirectory() ? listFiles(source.dir, 2000) : [source.dir];
      let bytes = 0;
      for (const file of files) { try { bytes += statSync(file).size; } catch { /* raced */ } }
      if (source.kind === 'settings') {
        const parsed = readJson(source.dir);
        if (!isJsonObject(parsed)) warnings.push('settings.json is missing or not a JSON object');
        else {
          const keys = Object.keys(parsed);
          const secretKeys = keys.filter(key => SECRET_KEY_PATTERN.test(key));
          if (secretKeys.length) warnings.push(`settings.json contains ${secretKeys.length} secret-named key(s) that will NOT be imported: ${secretKeys.join(', ')}`);
        }
      }
      items.push({ kind: source.kind, name: basename(source.dir), count: files.length, path: source.dir, bytes, importable: true });
      totalFiles += files.length; totalBytes += bytes;
    }
    const excluded = ['auth.json', 'ssh.json', 'ssh_known_hosts.json', 'ipython', 'jupyter', 'kernels', 'logs', 'matplotlib', 'tmp'];
    items.push({ kind: 'excluded', name: 'secrets-and-runtime', count: excluded.filter(name => existsSync(join(this.legacyHome, name))).length, path: this.legacyHome, bytes: 0, importable: false, note: `Never imported: ${excluded.join(', ')}` });
    if (!existsSync(join(this.legacyHome, 'conversations'))) warnings.push('No legacy conversations directory; legacy agent sessions will not be imported.');
    return { legacyHome: this.legacyHome, exists: true, inspectedAt: this.clock(), items, counts: { totalFiles, totalBytes }, warnings };
  }

  jobs(): ImportJobView[] {
    return this.store.listRecords('importJob', { limit: 100 }).map(row => this.jobView(row.data, row.id));
  }

  apply(options: ImportApplyOptions = {}): ImportJobView {
    const inspection = this.inspect();
    if (!inspection.exists) throw new ValidationError(`Legacy home not found: ${this.legacyHome}`);
    const requested = Array.isArray(options.kinds) ? options.kinds : [...IMPORT_KINDS];
    const kinds = requested.filter(kind => (IMPORT_KINDS as readonly string[]).includes(kind));
    if (kinds.length !== requested.length || kinds.length === 0) throw new ValidationError(`kinds must be a non-empty subset of: ${IMPORT_KINDS.join(', ')}`);
    const at = this.clock();
    const warnings: string[] = [];
    const counts = { imported: 0, skipped: 0, failed: 0, filesCopied: 0, bytesCopied: 0 };
    const createdRecordIds: string[] = [];
    if (options.dryRun) {
      for (const item of inspection.items) if (kinds.includes(item.kind as ImportKind)) counts.skipped += item.count;
      return { id: 'dry-run', at, kinds, status: 'dry_run', backupPath: null, counts, warnings: inspection.warnings, createdRecordIds, legacyHome: this.legacyHome };
    }
    const jobId = stableId('import', `${this.legacyHome}|${at}|${Math.random()}`);
    const backupPath = join(this.home, 'migration', `backup-${at}-${jobId.slice(-6)}`);
    const manifest: Array<{ path: string; bytes: number; sha256: string; copied: string }> = [];
    mkdirSync(backupPath, { recursive: true });
    let copiedTotal = 0;
    const copyFile = (source: string, rel: string): string | null => {
      try {
        const stat = statSync(source);
        if (stat.size > MAX_SOURCE_FILE_BYTES) { warnings.push(`Skipped oversized file (${stat.size} bytes): ${rel}`); return null; }
        if (copiedTotal + stat.size > MAX_COPY_TOTAL_BYTES) { warnings.push(`Copy budget exceeded; skipped: ${rel}`); return null; }
        const destination = join(backupPath, rel.split('/').join(sep));
        mkdirSync(join(destination, '..'), { recursive: true });
        copyFileSync(source, destination);
        const bytes = readFileSync(source);
        manifest.push({ path: rel, bytes: bytes.byteLength, sha256: sha256Buffer(bytes), copied: relative(backupPath, destination).split(sep).join('/') });
        copiedTotal += bytes.byteLength;
        counts.filesCopied += 1; counts.bytesCopied += bytes.byteLength;
        return destination;
      } catch (err) {
        warnings.push(`Failed to back up ${rel}: ${(err as Error).message}`);
        return null;
      }
    };
    const putRecord = (kind: string, data: Json, id: string): boolean => {
      const existing = this.store.getRecord(id);
      if (existing) { counts.skipped += 1; return false; }
      this.store.putRecord(kind, data, { id, provenance: { source: 'legacy-import', sourcePath: legacySourceOf(data), sourceSha256: hashOf(data), importedAt: at, jobId } });
      createdRecordIds.push(id);
      counts.imported += 1;
      return true;
    };
    const legacySourceOf = (data: Json): string => isJsonObject(data) && isJsonObject(data.legacy) && typeof data.legacy.sourcePath === 'string' ? data.legacy.sourcePath : this.legacyHome;
    const hashOf = (data: Json): string => isJsonObject(data) && isJsonObject(data.legacy) && typeof data.legacy.sourceSha256 === 'string' ? data.legacy.sourceSha256 : sha256Buffer(Buffer.from(JSON.stringify(data)));
    try {
      for (const kind of kinds) {
        if (kind === 'conversations') {
          const dir = join(this.legacyHome, 'conversations');
          if (!existsSync(dir)) continue;
          for (const file of listFiles(dir, MAX_MESSAGES).filter(name => name.endsWith('.json'))) {
            const rel = safeRelative(this.legacyHome, file);
            const raw = readFileSync(file);
            const sha = sha256Buffer(raw);
            const backup = copyFile(file, rel);
            const parsed = readJson(file);
            if (!isJsonObject(parsed)) { counts.failed += 1; warnings.push(`Conversation is not a JSON object: ${rel}`); continue; }
            const id = typeof parsed.id === 'string' && parsed.id ? parsed.id : safeRelative(dir, file).replace(/\.json$/, '');
            const messagesJson = Array.isArray(parsed.messages) ? parsed.messages : [];
            const messages: Json[] = [];
            for (const item of messagesJson.slice(0, MAX_MESSAGES)) {
              if (!isJsonObject(item)) continue;
              const rawRole = typeof item.role === 'string' ? item.role : 'user';
              const role = rawRole === 'assistant' || rawRole === 'system' ? rawRole : 'user';
              const text = cleanText(item.content ?? item.text ?? '', 100_000);
              const prefix = rawRole === 'tool' ? '[tool] ' : rawRole === 'error' ? '[error] ' : '';
              messages.push({ id: typeof item.id === 'string' ? item.id : `m-${messages.length}`, role, text: prefix + text, at: toMillis(item.ts ?? item.at, at) });
            }
            const data: Json = {
              projectId: null,
              title: cleanText(parsed.title, 300) || '导入的旧会话',
              mode: 'chat',
              agent: typeof parsed.agent === 'string' ? cleanText(parsed.agent, 100) : 'legacy',
              messages,
              legacy: { sourcePath: file, sourceSha256: sha, sourceAt: toMillis(parsed.updated_at ?? parsed.created_at, at), backupPath: backup, jobId },
              updatedAt: toMillis(parsed.updated_at ?? parsed.created_at, at)
            };
            const recordId = stableId('legacy-conv', `${this.legacyHome}|${id}`);
            if (!putRecord('conversation', data, recordId)) warnings.push(`Already imported (skipped): ${rel}`);
          }
        } else if (kind === 'settings') {
          const file = join(this.legacyHome, 'settings.json');
          if (!existsSync(file)) continue;
          copyFile(file, 'settings.json');
          const parsed = readJson(file);
          if (!isJsonObject(parsed)) { counts.failed += 1; warnings.push('settings.json is not a JSON object'); continue; }
          const values: Record<string, Json> = {};
          const ignored: string[] = [];
          for (const [key, value] of Object.entries(parsed)) {
            if (SECRET_KEY_PATTERN.test(key)) { ignored.push(key); continue; }
            const json = JSON.parse(JSON.stringify(value)) as Json;
            if (!isJsonObject(json) && !Array.isArray(json) && !(typeof json === 'string' && json.length <= 500)) { ignored.push(key); continue; }
            values[key] = json;
          }
          const data: Json = { values, ignoredSecrets: ignored, legacy: { sourcePath: file, sourceSha256: sha256Buffer(readFileSync(file)), sourceAt: at, jobId } };
          putRecord('importedSettings', data, stableId('legacy-settings', this.legacyHome));
          if (ignored.length) warnings.push(`settings.json: excluded secret-named keys: ${ignored.join(', ')}`);
        } else {
          const dir = join(this.legacyHome, kind);
          if (!existsSync(dir)) continue;
          const files = listFiles(dir, 2000);
          for (const file of files) {
            const rel = safeRelative(this.legacyHome, file);
            const stat = statSync(file);
            if (stat.size > MAX_SOURCE_FILE_BYTES) { warnings.push(`Skipped oversized ${kind} file: ${rel}`); continue; }
            const backup = copyFile(file, rel);
            if (!backup) continue;
            const raw = readFileSync(file);
            const sha = sha256Buffer(raw);
            const base = basename(file);
            let text: string | null = null;
            if (/\.(txt|md|json|jsonl|csv|tsv|yaml|yml|log)$/i.test(base) && raw.byteLength <= MAX_TEXT_BYTES) {
              try { text = raw.toString('utf8'); if (text.includes('\uFFFD')) text = null; } catch { text = null; }
            }
            const data: Json = {
              name: base,
              relativePath: rel,
              kind,
              sha256: sha,
              bytes: raw.byteLength,
              copiedTo: backup,
              text,
              legacy: { sourcePath: file, sourceSha256: sha, sourceAt: at, jobId }
            };
            putRecord('importedFile', data, stableId(`legacy-${kind}`, `${this.legacyHome}|${rel}`));
          }
        }
      }
      const job: Json = {
        at, kinds, status: counts.failed > 0 ? 'partial' : 'completed', backupPath, counts: counts as unknown as Json,
        warnings, createdRecordIds, legacyHome: this.legacyHome, manifest
      };
      writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify({ legacyHome: this.legacyHome, at, jobId, kinds, counts, files: manifest }, null, 2), { encoding: 'utf8', flag: 'wx' });
      const record = this.store.putRecord('importJob', job, { id: jobId, provenance: { legacyHome: this.legacyHome, backupPath } });
      return this.jobView(record.data, record.id);
    } catch (error) {
      const job: Json = { at, kinds, status: 'partial', backupPath, counts: counts as unknown as Json, warnings, createdRecordIds, legacyHome: this.legacyHome };
      const record = this.store.putRecord('importJob', job, { id: jobId, provenance: { legacyHome: this.legacyHome, backupPath } });
      throw new ValidationError(`Import failed after partial progress (job ${record.id}): ${(error as Error).message}`);
    }
  }

  rollback(jobId: string): { jobId: string; removed: number; backupPath: string | null } {
    const row = this.store.getRecord(jobId);
    if (!row || row.kind !== 'importJob') throw new ValidationError('Unknown import job');
    const data = row.data as Record<string, Json>;
    const ids = Array.isArray(data.createdRecordIds) ? data.createdRecordIds.filter((value): value is string => typeof value === 'string') : [];
    let removed = 0;
    for (const id of ids) {
      if (id === jobId) continue;
      try { this.store.deleteRecord(id); removed += 1; } catch { /* record may have been edited or removed by the user */ }
    }
    const updated = { ...(data as object), status: 'rolled_back', rolledBackAt: this.clock() } as Json;
    this.store.putRecord('importJob', updated, { id: jobId, expectedVersion: row.version });
    return { jobId, removed, backupPath: typeof data.backupPath === 'string' ? data.backupPath : null };
  }

  private jobView(data: Json, id: string): ImportJobView {
    const value = isJsonObject(data) ? data : {};
    const counts = isJsonObject(value.counts) ? value.counts : {};
    return {
      id,
      at: typeof value.at === 'number' ? value.at : 0,
      kinds: Array.isArray(value.kinds) ? value.kinds.filter((kind): kind is string => typeof kind === 'string') : [],
      status: value.status === 'dry_run' || value.status === 'partial' || value.status === 'rolled_back' ? value.status : 'completed',
      backupPath: typeof value.backupPath === 'string' ? value.backupPath : null,
      counts: {
        imported: typeof counts.imported === 'number' ? counts.imported : 0,
        skipped: typeof counts.skipped === 'number' ? counts.skipped : 0,
        failed: typeof counts.failed === 'number' ? counts.failed : 0,
        filesCopied: typeof counts.filesCopied === 'number' ? counts.filesCopied : 0,
        bytesCopied: typeof counts.bytesCopied === 'number' ? counts.bytesCopied : 0
      },
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : [],
      createdRecordIds: Array.isArray(value.createdRecordIds) ? value.createdRecordIds.filter((item): item is string => typeof item === 'string') : [],
      legacyHome: typeof value.legacyHome === 'string' ? value.legacyHome : this.legacyHome
    };
  }
}
