import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/harness/store.js';
import { rpc } from '../src/rpc.js';
import { readConnection, type Connection } from '../src/security.js';

test('real daemon/authenticated pipe survives client exit and forced restart without replaying committed work', { timeout: 40000 }, async t => {
  const started = performance.now();
  const home = mkdtempSync(join(tmpdir(), 'suwen-daemon-integration-'));
  const children: ChildProcess[] = []; const diagnostics: string[] = [];
  const deadline = Date.now() + 35000;
  const poll = async <T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string): Promise<T> => {
    let last: unknown;
    while (Date.now() < deadline) {
      try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = error; }
      await sleep(75);
    }
    throw new Error(`${label} timed out; last=${last instanceof Error ? last.message : JSON.stringify(last)}; daemon=${diagnostics.join('\n').slice(-3000)}`);
  };
  const waitExit = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off('exit', onExit); reject(new Error('Daemon did not exit within 3 seconds')); }, 3000);
      child.once('exit', onExit);
    });
  };
  const daemonFile = fileURLToPath(new URL('../src/daemon.js', import.meta.url));
  const launch = async (): Promise<{ child: ChildProcess; connection: Connection }> => {
    const child = spawn(process.execPath, [daemonFile, '--home', home], { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    children.push(child);
    child.stdout?.on('data', chunk => diagnostics.push(String(chunk).slice(-2000)));
    child.stderr?.on('data', chunk => diagnostics.push(String(chunk).slice(-2000)));
    child.on('error', error => diagnostics.push(error.message));
    const connection = await poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Daemon exited: ${child.exitCode ?? child.signalCode}`);
      const candidate = readConnection(home); if (!candidate || candidate.pid !== child.pid) return null;
      const health = await rpc(candidate, 'health'); return health.ready ? candidate : null;
    }, value => value !== null, 'Daemon startup');
    return { child, connection: connection! };
  };
  const openResponses = new Set<ServerResponse>(); let requests = 0;
  const fakeApi = createServer((request, response) => {
    requests++; openResponses.add(response); request.resume();
    // Hold a real local request in flight. No external model or credentials are used.
    response.on('close', () => openResponses.delete(response));
  });
  await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await waitExit(child); }
    for (const response of openResponses) response.destroy(); fakeApi.closeAllConnections();
    await new Promise<void>(resolve => fakeApi.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  // This is persisted queued work from an earlier session; create RPC correctly rejects new locked-model requests.
  const seed = new Store(join(home, 'harness.sqlite'));
  seed.createTask({ id: 'locked-at-startup', steps: [{ id: 'model', kind: 'model', input: { prompt: 'local integration test' }, sideEffect: true, maxAttempts: 3 }] }); seed.close();
  const first = await launch(); let connection = first.connection;
  await assert.rejects(rpc({ ...connection, token: 'incorrect-authentication-token' }, 'health'), /Unauthorized/);
  const initial = await rpc(connection, 'snapshot'); const locked = initial.tasks.find((task: any) => task.id === 'locked-at-startup');
  assert.equal(initial.health.configured, false); assert.equal(locked.calls, 0); assert.equal(locked.steps[0].attempts, 0); assert.equal(locked.steps[0].status, 'queued');

  const definition = { id: 'restart-dag', steps: [{ id: 'before', kind: 'echo', input: 'committed-before-daemon-kill' }, { id: 'timer', kind: 'delay', input: { ms: 5000 }, dependsOn: ['before'] }, { id: 'after', kind: 'echo', input: 'resumed-after-daemon-kill', dependsOn: ['timer'] }] };
  const clientScript = `import { rpc } from ${JSON.stringify(new URL('../src/rpc.js', import.meta.url).href)}; import { readConnection } from ${JSON.stringify(new URL('../src/security.js', import.meta.url).href)}; const result=await rpc(readConnection(${JSON.stringify(home)}),'create',${JSON.stringify(definition)}); process.stdout.write(JSON.stringify({id:result.id}));`;
  const client = spawnSync(process.execPath, ['--input-type=module', '-e', clientScript], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
  assert.equal(client.status, 0, client.stderr); assert.equal(JSON.parse(client.stdout).id, 'restart-dag');
  const waiting = await poll(async () => (await rpc(connection, 'snapshot')).tasks.find((task: any) => task.id === 'restart-dag'), value => value?.steps.find((step: any) => step.id === 'timer')?.status === 'waiting_external', 'Durable timer persisted');
  const beforeOperation = waiting.steps.find((step: any) => step.id === 'before').operationId;
  assert.equal((await rpc(connection, 'health')).pid, first.child.pid, 'daemon stays alive after independent client process exits');
  assert.equal(waiting.steps.find((step: any) => step.id === 'before').attempts, 1);
  await rpc(connection, 'control', { id: 'locked-at-startup', action: 'cancel' });

  const address = fakeApi.address(); assert.ok(address && typeof address === 'object');
  await rpc(connection, 'configure', { provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-fault-injection', apiKey: 'synthetic-integration-key', contextWindow: 4096, maxOutput: 128 });
  await rpc(connection, 'create', { id: 'killed-in-flight', steps: [{ id: 'model', kind: 'model', input: { prompt: 'hold until forced process termination' }, sideEffect: true, maxAttempts: 3, timeoutMs: 5000 }] });
  await poll(() => requests, value => value === 1, 'Real model activity reached local HTTP server');
  const inFlight = (await rpc(connection, 'snapshot')).tasks.find((task: any) => task.id === 'killed-in-flight');
  assert.equal(inFlight.steps[0].status, 'running'); assert.equal(inFlight.steps[0].attempts, 1);
  assert.ok(inFlight.steps[0].leaseUntil > Date.now());
  first.child.kill('SIGKILL'); await waitExit(first.child);
  const second = await launch(); connection = second.connection;
  assert.notEqual(second.child.pid, first.child.pid); assert.notEqual(connection.token, first.connection.token);
  assert.equal((await rpc(connection, 'health')).configured, false, 'model credentials do not silently reappear on restart');
  const recovered = await poll(async () => rpc(connection, 'snapshot'), value => value.tasks.find((task: any) => task.id === 'restart-dag')?.status === 'completed' && value.tasks.find((task: any) => task.id === 'killed-in-flight')?.status === 'waiting_approval', 'Restarted daemon recovered durable timer and expired unsafe lease');
  const task = recovered.tasks.find((entry: any) => entry.id === 'restart-dag');
  assert.equal(task.steps.find((step: any) => step.id === 'before').operationId, beforeOperation);
  assert.equal(task.steps.find((step: any) => step.id === 'before').output, 'committed-before-daemon-kill');
  assert.equal(task.steps.find((step: any) => step.id === 'after').output, 'resumed-after-daemon-kill');
  for (const step of task.steps) assert.equal(step.attempts, 1, `${step.id} must execute once`);
  assert.equal(task.events.filter((event: any) => event.stepId === 'before' && event.type === 'step.completed').length, 1);
  const unsafe = recovered.tasks.find((entry: any) => entry.id === 'killed-in-flight');
  assert.equal(unsafe.calls, 1); assert.equal(unsafe.steps[0].attempts, 1); assert.equal(requests, 1, 'unknown side effect must not replay');
  assert.equal(unsafe.steps[0].output, undefined); assert.match(unsafe.steps[0].error, /unknown|expired/i);
  assert.equal(recovered.tasks.find((entry: any) => entry.id === 'locked-at-startup').calls, 0);

  await rpc(connection, 'create', { id: 'cancelled-timer', steps: [{ id: 'timer', kind: 'delay', input: { ms: 1000 } }, { id: 'late', kind: 'echo', input: 'must-never-commit', dependsOn: ['timer'] }] });
  await poll(async () => (await rpc(connection, 'snapshot')).tasks.find((entry: any) => entry.id === 'cancelled-timer'), value => value?.steps[0].status === 'waiting_external', 'Cancellation timer persisted');
  await rpc(connection, 'control', { id: 'cancelled-timer', action: 'cancel' }); await sleep(1200);
  const cancelled = (await rpc(connection, 'snapshot')).tasks.find((entry: any) => entry.id === 'cancelled-timer');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps[1].attempts, 0); assert.equal(cancelled.steps[1].output, undefined);
  assert.equal(cancelled.events.some((event: any) => event.type === 'task.completed'), false);
  await rpc(connection, 'shutdown'); await waitExit(second.child);
  t.diagnostic(`Actual short fault-injection run: ${Math.round(performance.now() - started)} ms; independent client exit, daemon SIGKILL, lease expiry, durable timer recovery, cancellation; no long-duration claim.`);
});
