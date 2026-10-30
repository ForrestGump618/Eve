import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { newConnection, safeError, secretEqual, connectionPath, readConnection, atomicJson, atomicJsonAsync } from '../src/security.js';
import { rpc } from '../src/rpc.js';

test('connection publication survives a real Windows sharing lock without blocking timers',
  {skip:process.platform!=='win32',timeout:15000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'eve-connection-lock-')),path=join(directory,'connection.json');
 atomicJson(path,{generation:1});
 const child=spawn('powershell.exe',['-NoProfile','-Command',
  '$stream=[IO.File]::Open($env:EVE_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try {[Console]::WriteLine("LOCKED"); [Console]::ReadLine() | Out-Null} finally {$stream.Dispose()}'],
  {windowsHide:true,env:{...process.env,EVE_TEST_LOCK_PATH:path},stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}rmSync(directory,{recursive:true,force:true});});
 let output='';
 while(!output.includes('LOCKED')){const [chunk]=await once(child.stdout,'data');output+=chunk.toString();}
 const started=Date.now();let timerFired=false;
 const timer=setTimeout(()=>{timerFired=true;child.stdin.end('\n');},250);
 try{await atomicJsonAsync(path,{generation:2});}finally{
  clearTimeout(timer);
  if(child.exitCode===null)child.stdin.end('\n');
 }
 await exited;
 if(!timerFired){
  t.skip('This Windows host allows replacement without observing the sharing lock');
  return;
 }
 assert.equal(timerFired,true,'replacement must await release without blocking timers');
 assert.ok(Date.now()-started>=240);
 assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{generation:2});
 assert.deepEqual(readdirSync(directory),['connection.json']);
});

test('authentication comparison fails closed for wrong types and unequal secrets', () => {
  const value = 'fixture-auth-token';
  for (const wrong of [undefined, null, 1, {}, [], 'different-auth-token', '']) assert.equal(secretEqual(wrong, value), false);
  assert.equal(secretEqual(value, value), true);
  const a = newConnection('fixture-home');
  const b = newConnection('fixture-home');
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.pipe, b.pipe);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  if (process.platform === 'win32') assert.equal(a.pipe.startsWith(String.raw`\\.\pipe\suwen-`), true);
});

test('diagnostic redaction removes bearer, plain assignments and JSON credential fields', () => {
  const secrets = ['bearer-fixture-value', 'plain-fixture-value', 'json-fixture-value'];
  const output = safeError(new Error('HTTP failure Bearer bearer-fixture-value apiKey=plain-fixture-value {"apiKey":"json-fixture-value"}'));
  for (const secret of secrets) assert.equal(output.includes(secret), false, 'Credentials must not appear in diagnostic messages');
  assert.ok(safeError('x'.repeat(1000)).length <= 600);
});

test('actual daemon named-pipe RPC rejects an unauthorized mutation and keeps authorized state intact', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-rpc-auth-'));
  const daemonPath = new URL('../src/daemon.js', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(daemonPath), '--home', directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const closed = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await closed; }
    // Only this test-created absolute temporary directory is removed.
    rmSync(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 12_000;
  while (!existsSync(connectionPath(directory)) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(existsSync(connectionPath(directory)), true, `Daemon failed to start: ${safeError(stderr)}`);
  const connection = readConnection(directory);
  assert.ok(connection);
  assert.equal(JSON.parse(readFileSync(connectionPath(directory), 'utf8')).token, connection.token);
  await assert.rejects(rpc({ ...connection, token: 'invalid-fixture-token' }, 'create', { name: 'unauthorized-task', steps: [{ id: 'a', kind: 'echo' }] }), /Unauthorized/);
  const snapshot = await rpc(connection, 'snapshot');
  assert.deepEqual(snapshot.tasks, []);
  assert.equal((await rpc(connection, 'health')).configured, false);
  const modelCredential = 'fixture-config-must-stay-in-daemon-memory';
  await rpc(connection, 'configure', { provider: 'openai', baseUrl: 'http://127.0.0.1:18080/v1', model: 'fixture-model', apiKey: modelCredential, contextWindow: 8192, maxOutput: 512 });
  assert.equal(JSON.stringify(await rpc(connection, 'snapshot')).includes(modelCredential), false);
  const task = await rpc(connection, 'create', { name: 'schema-fixture', steps: [{ id: 'approval', kind: 'approval' }] });
  let waiting: any;
  for (let attempt = 0; attempt < 40; attempt++) {
    waiting = (await rpc(connection, 'snapshot')).tasks.find((candidate: any) => candidate.id === task.id);
    if (waiting?.steps[0]?.status === 'waiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(waiting?.steps[0]?.status, 'waiting_approval');
  await assert.rejects(rpc(connection, 'approval', { taskId: task.id, stepId: 'approval', decision: { action: 'unrecognized-action' }, version: waiting.steps[0].version }));
  const afterInvalid = (await rpc(connection, 'snapshot')).tasks.find((candidate: any) => candidate.id === task.id);
  assert.equal(afterInvalid.steps[0].status, 'waiting_approval');
  assert.equal(afterInvalid.steps[0].version, waiting.steps[0].version);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile()) assert.equal(readFileSync(join(directory, entry.name)).includes(Buffer.from(modelCredential)), false, 'Daemon must not persist the model credential');
  }
  await rpc(connection, 'shutdown');
  await closed;
  assert.equal(child.exitCode, 0);
});
