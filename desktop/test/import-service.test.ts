import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/harness/store.js';
import { ImportService } from '../src/import-service.js';

function fixture(): { root: string; home: string; legacy: string; store: Store; service: ImportService; clock: () => number } {
  const root = mkdtempSync(join(tmpdir(), 'suwen-import-'));
  const home = join(root, 'home');
  const legacy = join(root, 'legacy');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(legacy, 'conversations'), { recursive: true });
  mkdirSync(join(legacy, 'memory'), { recursive: true });
  mkdirSync(join(legacy, 'discovery'), { recursive: true });
  writeFileSync(join(legacy, 'conversations', 'c_0001.json'), JSON.stringify({
    id: 'c_0001', title: '旧版分析会话', agent: 'spatial-analyst',
    created_at: 1_700_000_000.5, updated_at: 1_700_000_100.5,
    messages: [
      { id: 'm1', role: 'user', content: '分析这份空间转录组数据', ts: 1_700_000_010 },
      { id: 'm2', role: 'assistant', content: '好的，我先检查数据。', ts: 1_700_000_020 },
      { id: 'm3', role: 'tool', content: 'read_file ok', ts: 1_700_000_030 },
      { id: 'm4', role: 'error', content: 'timeout', ts: 1_700_000_040 }
    ]
  }), 'utf8');
  writeFileSync(join(legacy, 'settings.json'), JSON.stringify({
    provider: 'deepseek', model: 'deepseek-chat', api_base: 'https://api.example.invalid', temperature: 0.2,
    vision_api_key: 'sk-legacy-secret-value', max_tokens: 4096
  }), 'utf8');
  writeFileSync(join(legacy, 'memory', 'research-note.md'), '# 证据\n空间邻域分析结论。', 'utf8');
  writeFileSync(join(legacy, 'discovery', 'run-1.json'), JSON.stringify({ run: 1, status: 'completed' }), 'utf8');
  writeFileSync(join(legacy, 'auth.json'), JSON.stringify({ token: 'legacy-auth-secret' }), 'utf8');
  writeFileSync(join(legacy, 'ssh.json'), JSON.stringify({ host: 'example', password: 'legacy-ssh-secret' }), 'utf8');
  let now = 1_800_000_000_000;
  const clock = () => { now += 10; return now; };
  const store = new Store(':memory:', { now: clock });
  const service = new ImportService(store, home, { legacyHome: legacy, clock });
  return { root, home, legacy, store, service, clock };
}

test('inspect is read-only and flags secret files and secret settings keys', () => {
  const f = fixture();
  try {
    const before = readdirSync(f.legacy).sort();
    const inspection = f.service.inspect();
    assert.equal(inspection.exists, true);
    assert.equal(inspection.legacyHome.endsWith('legacy'), true);
    assert.equal(inspection.counts.totalFiles, 4); // conversation + settings + memory note + discovery (auth/ssh excluded)
    const conversationItem = inspection.items.find(item => item.kind === 'conversations');
    assert.equal(conversationItem?.count, 1);
    assert.ok(inspection.warnings.some(warning => warning.includes('vision_api_key')), 'secret settings key must be reported as excluded');
    assert.deepEqual(readdirSync(f.legacy).sort(), before, 'inspect must not modify the legacy source');
    assert.equal(f.store.countRecords('conversation'), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('dry run plans an import without backups or records', () => {
  const f = fixture();
  try {
    const job = f.service.apply({ dryRun: true, kinds: ['conversations', 'settings'] });
    assert.equal(job.status, 'dry_run');
    assert.equal(job.counts.filesCopied, 0);
    assert.equal(f.store.countRecords('conversation'), 0);
    assert.equal(existsSync(join(f.home, 'migration')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('apply backs up, imports conversations/settings/memory and never imports secrets', () => {
  const f = fixture();
  try {
    const job = f.service.apply({});
    assert.equal(job.status, 'completed');
    assert.ok(job.backupPath && existsSync(job.backupPath), 'backup directory must exist');
    const manifest = JSON.parse(readFileSync(join(job.backupPath!, 'manifest.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4);
    for (const file of manifest.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.files.some((file: { path: string }) => /auth\.json|ssh\.json/.test(file.path)), false, 'secret files must not be backed up or imported');

    const conversations = f.store.listRecords('conversation');
    assert.equal(conversations.length, 1);
    const data = conversations[0].data as Record<string, unknown>;
    assert.equal(data.title, '旧版分析会话');
    assert.equal(data.projectId, null);
    const messages = data.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'user']);
    assert.equal(messages[2].text, '[tool] read_file ok');
    assert.equal(messages[3].text, '[error] timeout');
    assert.equal(messages[0].at, 1_700_000_010_000, 'legacy seconds are converted to milliseconds');
    assert.equal(conversations[0].provenance && (conversations[0].provenance as Record<string, unknown>).source, 'legacy-import');

    const settings = f.store.listRecords('importedSettings');
    assert.equal(settings.length, 1);
    const settingsData = settings[0].data as Record<string, unknown>;
    const values = settingsData.values as Record<string, unknown>;
    assert.equal(values.provider, 'deepseek');
    assert.equal(values.vision_api_key, undefined);
    assert.equal(JSON.stringify(settingsData).includes('sk-legacy-secret-value'), false);
    assert.equal(JSON.stringify(settingsData).includes('vision_api_key'), false, 'secret key names are redacted at rest too');

    const files = f.store.listRecords('importedFile');
    assert.ok(files.length >= 2, 'memory and discovery files imported');
    const memory = files.find(row => (row.data as Record<string, unknown>).kind === 'memory');
    assert.ok(memory && String((memory.data as Record<string, unknown>).text).includes('空间邻域分析结论'));

    const serialized = JSON.stringify({ conversations: f.store.listRecords('conversation'), settings: f.store.listRecords('importedSettings'), files: f.store.listRecords('importedFile'), jobs: f.service.jobs() });
    assert.equal(serialized.includes('legacy-auth-secret'), false);
    assert.equal(serialized.includes('legacy-ssh-secret'), false);
    assert.equal(serialized.includes('sk-legacy-secret-value'), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('apply is idempotent and rollback removes only the imported records while keeping backups', () => {
  const f = fixture();
  try {
    const first = f.service.apply({ kinds: ['conversations', 'settings', 'memory'] });
    const importedAfterFirst = first.counts.imported;
    assert.ok(importedAfterFirst >= 3);
    const second = f.service.apply({ kinds: ['conversations', 'settings', 'memory'] });
    assert.equal(second.counts.imported, 0, 'second import must not duplicate records');
    assert.ok(second.counts.skipped >= 3);
    assert.equal(f.store.countRecords('conversation'), 1);

    const removed = f.service.rollback(first.id);
    assert.equal(removed.removed, importedAfterFirst);
    assert.equal(f.store.countRecords('conversation'), 0);
    assert.equal(f.store.countRecords('importedSettings'), 0);
    assert.equal(f.store.countRecords('importedFile'), 0);
    assert.ok(existsSync(first.backupPath!), 'rollback never deletes the backup');
    const job = f.store.getRecord(first.id);
    assert.equal((job!.data as Record<string, unknown>).status, 'rolled_back');
    assert.equal(f.service.jobs().length, 2, 'each apply attempt is audited as its own job');
    assert.equal(f.service.jobs().filter(job => job.status === 'rolled_back').length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('apply rejects unknown kinds and a missing legacy home', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.apply({ kinds: ['secrets'] }), /kinds must be a non-empty subset/);
    const missing = new ImportService(f.store, join(f.root, 'other-home'), { legacyHome: join(f.root, 'missing'), clock: f.clock });
    assert.throws(() => missing.apply({}), /Legacy home not found/);
    assert.deepEqual(missing.inspect().exists, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
