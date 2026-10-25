import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/harness/store.js';
import { Engine } from '../src/harness/engine.js';
import { writeArtifact, verifyArtifact } from '../src/harness/artifacts.js';
import { ConflictError, ValidationError } from '../src/harness/types.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'suwen-durable-')); const path = join(dir, 'state.sqlite');
  const stores: Store[] = []; let time = 1000;
  const open = () => { const s = new Store(path, { now: () => time, random: () => .5, retryBaseMs: 10 }); stores.push(s); return s; };
  t.after(() => { for (const s of stores) try { s.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { path, dir, open, advance: (ms: number) => { time += ms; } };
}

test('model transcript mirror commits atomically and late replies after cancellation cannot append',t=>{
  const f=fixture(t),store=f.open();const conv=store.putRecord('conversation',{title:'test',mode:'chat',messages:[]});
  const task=store.createTask({steps:[{id:'reply',kind:'model',input:{conversationId:conv.id}}]});const lease=store.claim('owner',10000)!;
  store.complete(lease,{text:'Verified answer'});assert.equal((store.getRecord(conv.id)!.data as any).messages.length,1);
  const cancelled=store.createTask({steps:[{id:'reply',kind:'model',input:{conversationId:conv.id}}]});const late=store.claim('owner',10000)!;
  store.cancelTask(cancelled.id);assert.throws(()=>store.complete(late,{text:'Late answer'}),ConflictError);
  assert.equal((store.getRecord(conv.id)!.data as any).messages.length,1);assert.equal(store.getTask(task.id)!.status,'completed');
});
test('SQLite durability settings, atomic completion checkpoint, and restart without repeated work', async t => {
  const f = fixture(t); const first = f.open();
  assert.equal((first.db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((first.db.prepare('PRAGMA synchronous').get() as any).synchronous, 2);
  assert.equal((first.db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1);
  first.createTask({ id: 'restart', steps: [{ id: 'a', kind: 'echo', input: 'committed' }, { id: 'timer', kind: 'delay', input: { ms: 100 }, dependsOn: ['a'] }, { id: 'b', kind: 'echo', dependsOn: ['timer'] }] });
  let executions = 0;
  const engine = new Engine(first, { handlers: { echo: async ({ step }) => { executions++; return { output: step.input ?? null }; } } });
  await engine.tick(); await engine.whenIdle(); await engine.tick(); await engine.whenIdle();
  assert.equal(first.getStep('restart', 'timer')!.status, 'waiting_external');
  assert.ok(first.checkpoints('restart').some(c => c.reason === 'step.completed'));
  first.close(); f.advance(101);
  const restored = f.open(); const second = new Engine(restored, { handlers: { echo: async () => { executions++; return { output: 'done' }; } } });
  await second.tick(); await second.whenIdle();
  assert.equal(restored.getTask('restart')!.status, 'completed'); assert.equal(executions, 2);
  assert.equal(restored.getStep('restart', 'timer')!.attempts, 1);
  await second.tick(); assert.equal(executions, 2);
});
test('two owners cannot claim the same step; expired fences and late cancellation writes are rejected', t => {
  const f = fixture(t); const a = f.open(); const b = f.open();
  a.createTask({ id: 'owners', steps: [{ id: 'a', kind: 'echo' }] });
  const old = a.claim('owner-a', 100)!; assert.ok(old); assert.equal(b.claim('owner-b', 100), undefined);
  f.advance(101); assert.equal(b.reclaimExpired(), 1); f.advance(10);
  const current = b.claim('owner-b', 100)!; assert.ok(current); assert.ok(current.fence > old.fence);
  assert.equal(current.step.operationId, old.step.operationId);
  assert.throws(() => a.heartbeat(old), ConflictError); assert.throws(() => a.complete(old, 'late'), ConflictError);
  b.cancelTask('owners'); assert.throws(() => b.complete(current, 'late'), ConflictError);
  assert.equal(b.getTask('owners')!.status, 'cancelled'); assert.equal(b.getStep('owners', 'a')!.output, undefined);
});
test('unknown side effects wait for an explicit reconciliation decision and retain operation identity', t => {
  const f = fixture(t); const s = f.open();
  s.createTask({ id: 'write', steps: [{ id: 'mail', kind: 'mail', sideEffect: true }] });
  const lease = s.claim('writer', 50)!; f.advance(51); s.reclaimExpired();
  assert.equal(s.getStep('write', 'mail')!.status, 'waiting_approval'); assert.equal(s.claim('other'), undefined);
  s.resolveApproval('write', 'mail', { action: 'confirm_completed', output: { receipt: 'verified-outside-runtime' } });
  assert.equal(s.getTask('write')!.status, 'completed'); assert.equal(s.getStep('write', 'mail')!.attempts, 1);
  assert.equal(s.getStep('write', 'mail')!.operationId, lease.step.operationId); assert.throws(() => s.complete(lease, null), ConflictError);
});
test('approval, DAG dependencies, retries, and task call limits are durable', async t => {
  const f = fixture(t); const s = f.open();
  assert.throws(() => s.createTask({ steps: [{ id: 'x', kind: 'echo', dependsOn: ['missing'] }] }), ValidationError);
  assert.throws(() => s.createTask({ steps: [{ id: 'x', kind: 'echo', dependsOn: ['y'] }, { id: 'y', kind: 'echo', dependsOn: ['x'] }] }), ValidationError);
  assert.throws(() => s.createTask({ steps: [{ id: 'x', kind: 'echo' }, { id: 'x', kind: 'echo' }] }), ValidationError);
  s.createTask({ id: 'approval', steps: [{ id: 'a', kind: 'approval' }, { id: 'b', kind: 'echo', dependsOn: ['a'] }] });
  const e = new Engine(s); await e.tick(); await e.whenIdle();
  assert.equal(s.getStep('approval', 'b')!.attempts, 0);
  const version = s.getStep('approval', 'a')!.version;
  assert.throws(() => s.resolveApproval('approval', 'a', { action: 'confirm_completed' }, version - 1), ConflictError);
  s.resolveApproval('approval', 'a', { action: 'confirm_completed' }, version); await e.tick(); await e.whenIdle();
  assert.equal(s.getTask('approval')!.status, 'completed');
  s.createTask({ id: 'retry', limits: { maxCalls: 2 }, steps: [{ id: 'a', kind: 'echo', maxAttempts: 5 }] });
  let lease = s.claim('retry')!; s.fail(lease, new Error('429'), { retryAfterMs: 10 }); assert.equal(s.claim('retry'), undefined);
  f.advance(10); lease = s.claim('retry')!; s.fail(lease, new Error('503'), { retryAfterMs: 10 }); f.advance(10);
  assert.equal(s.claim('retry'), undefined); assert.equal(s.getTask('retry')!.status, 'failed'); assert.equal(s.getTask('retry')!.calls, 2);
});
test('pause/resume propagates to children, revokes leases, and retains timer deadlines', t => {
  const f = fixture(t); const s = f.open();
  s.createTask({ id: 'parent', steps: [{ id: 'a', kind: 'echo' }] });
  s.createTask({ id: 'child', parentId: 'parent', steps: [{ id: 'b', kind: 'echo' }] });
  const lease = s.claim('worker')!; const version = s.getTask('parent')!.version;
  assert.throws(() => s.pauseTask('parent', version - 1), ConflictError);
  s.pauseTask('parent', version); assert.equal(s.getTask('child')!.status, 'paused');
  assert.throws(() => s.complete(lease, null), ConflictError); assert.equal(s.claim('worker'), undefined);
  s.resumeTask('parent'); assert.equal(s.getTask('child')!.status, 'queued');
  const resumed = s.claim('worker')!; assert.equal(resumed.step.operationId, lease.step.operationId); s.complete(resumed, null);
  s.cancelTask('child'); assert.equal(s.getTask('child')!.status, 'cancelled');
});
test('activity timeout propagates AbortSignal and unsafe outcome requires reconciliation', async t => {
  const f = fixture(t); const s = f.open(); let aborted = false;
  s.createTask({ id: 'timeout', steps: [{ id: 'unsafe', kind: 'unsafe', sideEffect: true, timeoutMs: 30 }] });
  const e = new Engine(s, { leaseMs: 100, handlers: { unsafe: async ({ signal }) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve({ output: 'too late' }); }, { once: true }); }) } });
  await e.tick(); await e.whenIdle(); assert.equal(aborted, true); assert.equal(s.getTask('timeout')!.status, 'waiting_approval');
  assert.equal(s.getStep('timeout', 'unsafe')!.output, undefined);
});
test('actual abrupt worker process death preserves committed work and recovers outstanding lease', t => {
  const f = fixture(t); const s = f.open();
  s.createTask({ id: 'crash', steps: [{ id: 'done', kind: 'echo' }, { id: 'lost', kind: 'echo', dependsOn: ['done'] }] });
  const done = s.claim('parent')!; s.complete(done, 'committed-before-kill');
  const moduleUrl = new URL('../src/harness/store.js', import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(moduleUrl)}; const s=new Store(${JSON.stringify(f.path)},{now:()=>1000}); const lease=s.claim('killed-worker',30); if(!lease)process.exit(2); process.kill(process.pid,'SIGKILL');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.notEqual(result.status, 2, result.stderr); assert.equal(s.getStep('crash', 'lost')!.status, 'running');
  f.advance(31); assert.equal(s.reclaimExpired(), 1); f.advance(10); const recovered = s.claim('recovered')!; s.complete(recovered, 'recovered');
  assert.equal(s.getTask('crash')!.status, 'completed'); assert.equal(s.getStep('crash', 'done')!.attempts, 1);
  assert.equal(s.getStep('crash', 'done')!.output, 'committed-before-kill');
});
test('newer schemas are rejected and old schema upgrades create a backup', t => {
  const f = fixture(t); let raw = new DatabaseSync(f.path); raw.exec('PRAGMA user_version=999'); raw.close();
  assert.throws(() => f.open(), /newer/);
  raw = new DatabaseSync(f.path); raw.exec('PRAGMA user_version=0'); raw.close();
  const s = f.open(); assert.ok(s); assert.ok(readdirSync(f.dir).some(p => /\.pre-v\d+-/.test(p) && p.endsWith('.bak')));
});
test('artifacts, step completion, events and checkpoint references commit together; corrupt artifacts are detected', async t => {
  const f = fixture(t); const s = f.open();
  s.createTask({ id: 'artifact', steps: [{ id: 'a', kind: 'echo' }] }); const lease = s.claim('worker')!;
  const artifact = await writeArtifact(join(f.dir, 'artifacts'), 'reproducible result', 'text/plain'); assert.equal(await verifyArtifact(artifact), true);
  const before = s.events('artifact').length;
  assert.throws(() => s.complete(lease, null, { artifacts: [artifact, artifact] }), /UNIQUE/);
  assert.equal(s.artifacts('artifact').length, 0); assert.equal(s.getStep('artifact', 'a')!.status, 'running'); assert.equal(s.events('artifact').length, before);
  s.complete(lease, { file: artifact.path }, { artifacts: [artifact], contextSnapshot: 'summary-version-7', configHashes: { model: 'sha256:model-config' } });
  assert.equal(s.artifacts('artifact').length, 1);
  const checkpoint = s.checkpoints('artifact').at(-1)!; assert.equal((checkpoint.snapshot as any).contextSnapshot, 'summary-version-7'); assert.equal((checkpoint.snapshot as any).artifacts[0].sha256, artifact.sha256);
  appendFileSync(artifact.path, 'corruption'); assert.equal(await verifyArtifact(artifact), false);
});
test('failed branch and budget expiry revoke sibling authority while retaining unsafe reconciliation', t => {
  const f = fixture(t); const s = f.open();
  s.createTask({ id: 'branches', steps: [{ id: 'unsafe', kind: 'write', sideEffect: true }, { id: 'fail', kind: 'echo' }] });
  const unsafe = s.claim('unsafe')!; const fail = s.claim('failure')!; s.fail(fail, new Error('Bearer fake-credential api_key=fake-secret'), { retryable: false });
  assert.equal(s.getTask('branches')!.status, 'waiting_approval'); assert.equal(s.getStep('branches', 'unsafe')!.status, 'waiting_approval');
  assert.throws(() => s.complete(unsafe, null), ConflictError); assert.equal(JSON.stringify(s.events('branches')).includes('fake-credential'), false);
  assert.equal(s.getStep('branches', 'fail')!.error!.includes('fake-secret'), false);
  s.resolveApproval('branches', 'unsafe', { action: 'confirm_completed' }); assert.equal(s.getTask('branches')!.status, 'failed');
  s.createTask({ id: 'deadline', limits: { maxWallMs: 10 }, steps: [{ id: 'unsafe', kind: 'write', sideEffect: true }] });
  const deadline = s.claim('deadline', 100)!; f.advance(11); s.reclaimExpired();
  assert.equal(s.getTask('deadline')!.status, 'waiting_approval'); assert.throws(() => s.complete(deadline, null), ConflictError);
  const events = s.events('deadline').length; s.reclaimExpired(); assert.equal(s.events('deadline').length, events);
  assert.throws(() => s.resolveApproval('deadline', 'unsafe', { action: 'retry' }), /budget exhausted/);
  s.resolveApproval('deadline', 'unsafe', { action: 'confirm_completed' }); assert.equal(s.getTask('deadline')!.status, 'completed');
});
test('stopping before queued activity invocation revokes execution, and active admission limits are enforced', async t => {
  const f = fixture(t); const s = f.open(); let called = false;
  s.createTask({ id: 'stop', steps: [{ id: 'a', kind: 'danger', sideEffect: true }] });
  const e = new Engine(s, { handlers: { danger: async () => { called = true; return null; } } });
  const tick = e.tick(); await e.stop(); await tick; await e.whenIdle();
  assert.equal(called, false); assert.equal(s.getTask('stop')!.status, 'paused'); assert.equal(s.getStep('stop', 'a')!.status, 'waiting_approval');
  const limited = new Store(join(f.dir, 'limited.sqlite'), { maxTasks: 1 });
  try {
    limited.createTask({ id: 'one', steps: [{ id: 'a', kind: 'echo' }] });
    assert.throws(() => limited.createTask({ id: 'two', steps: [{ id: 'a', kind: 'echo' }] }), /Active task limit/);
  } finally { limited.close(); }
});
test('a final budgeted concurrent call can finish before unstarted nodes exceed the budget', async t => {
  const f = fixture(t); const s = f.open(); let calls = 0;
  s.createTask({ id: 'last-call', limits: { maxCalls: 1 }, steps: [{ id: 'first', kind: 'call' }, { id: 'second', kind: 'call' }] });
  const engine = new Engine(s, { handlers: { call: async () => { calls++; return 'accepted'; } } });
  await engine.tick(); await engine.whenIdle(); assert.equal(calls, 1); assert.equal(s.getStep('last-call', 'first')!.status, 'completed');
  await engine.tick(); assert.equal(s.getTask('last-call')!.status, 'failed'); assert.equal(s.getStep('last-call', 'second')!.attempts, 0);
});
test('invalid approval decisions and non-JSON confirmations leave persisted state unchanged', t => {
  const f = fixture(t); const s = f.open(); s.createTask({ id: 'validate', steps: [{ id: 'a', kind: 'approval' }] });
  s.waitForApproval(s.claim('approval')!); const before = JSON.stringify({ task: s.getTask('validate'), steps: s.getSteps('validate'), events: s.events('validate'), checkpoints: s.checkpoints('validate') });
  for (const invalid of [null, {}, { action: 'typo' }, { action: 'confirm_completed', output: NaN }, { action: 'confirm_completed', output: { invalid: undefined } }]) assert.throws(() => s.resolveApproval('validate', 'a', invalid as any), ValidationError);
  const circular: any = {}; circular.self = circular; assert.throws(() => s.resolveApproval('validate', 'a', { action: 'confirm_completed', output: circular }), ValidationError);
  assert.equal(JSON.stringify({ task: s.getTask('validate'), steps: s.getSteps('validate'), events: s.events('validate'), checkpoints: s.checkpoints('validate') }), before);
});
test('locked handler kinds consume neither attempts nor budget and can run after unlock', async t => {
  const f = fixture(t); const s = f.open(); let unlocked = false; let calls = 0;
  s.createTask({ id: 'locked', limits: { maxCalls: 1 }, steps: [{ id: 'model', kind: 'model', sideEffect: true }] });
  const e = new Engine(s, { canRun: step => step.kind !== 'model' || unlocked, handlers: { model: async () => { calls++; return { output: 'unlocked' }; } } });
  await e.tick(); await e.whenIdle(); assert.equal(s.getTask('locked')!.calls, 0); assert.equal(s.getStep('locked', 'model')!.attempts, 0);
  unlocked = true; await e.tick(); await e.whenIdle(); assert.equal(calls, 1); assert.equal(s.getTask('locked')!.status, 'completed');
});
