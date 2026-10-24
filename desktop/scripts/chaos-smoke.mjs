/**
 * Short-window durability fault-injection smoke test for the real detached daemon.
 *
 * This is NOT an 8/24/72-hour soak test. It injects real faults in the current
 * session and measures recovery from the durable SQLite state:
 *   1. force-kill the Python research worker while a sandboxed step is running;
 *   2. SIGKILL the daemon while a Python step and its lease are in flight, then restart it;
 *   3. SIGKILL the daemon while a committed step is followed by a durable timer, then restart it;
 *   4. cancel a running sandboxed step and confirm cancellation propagates without artifacts;
 *   5. inject HTTP 429/500 provider failures and confirm bounded retry + recovery.
 *
 * Usage: node scripts/chaos-smoke.mjs [--dist dist] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const distArg = args.indexOf('--dist');
const distDir = resolve(distArg >= 0 ? args[distArg + 1] : 'dist');
const keep = args.includes('--keep');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsVerification = resolve(root, '..', 'docs', 'verification');
const daemonPath = join(distDir, 'src', 'daemon.js');
const workerPath = join(root, 'worker', 'research_worker.py');
const home = mkdtempSync(join(tmpdir(), 'suwen-chaos-'));
const report = { home, startedAt: new Date().toISOString(), scenarios: [], limits: [
  'Short-window fault injection in one Windows session only.',
  'No 8h/24h/72h soak, no sleep/hibernate, no power loss, no OS reboot, no disk-full test.',
  'Model-provider faults are injected by a local HTTP fixture, not a real vendor account.',
] };
const results = [];
let daemon = null;
const children = [];
let stderr = '';
let seq = 0;
const phase = name => console.log(`[${new Date().toISOString()}] phase: ${name}`);
const watchdog = setTimeout(() => {
  console.error('chaos watchdog fired: writing partial report and exiting');
  report.scenarios = results; report.result = 'failed'; report.error = 'watchdog timeout';
  report.durationMs = Date.now() - started;
  try { mkdirSync(docsVerification, { recursive: true }); writeFileSync(join(docsVerification, 'chaos-results.json'), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  process.exit(2);
}, 300_000);
watchdog.unref();

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function connectionFile() { return join(home, 'connection.json'); }
function readConnection() {
  const file = connectionFile();
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function rpc(connection, method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(connection.pipe);
    let raw = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolvePromise(value); };
    const timer = setTimeout(() => finish(new Error(`RPC timeout: ${method}`)), timeoutMs);
    socket.on('error', error => { clearTimeout(timer); finish(error); });
    socket.on('data', chunk => {
      raw += chunk.toString();
      if (raw.length > 8_000_000) { clearTimeout(timer); finish(new Error('RPC response too large')); return; }
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const message = JSON.parse(raw.slice(0, newline));
        if (message.error) finish(new Error(String(message.error))); else finish(null, message.result);
      } catch (error) { finish(error); }
    });
    socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n'));
  });
}
async function launchDaemon() {
  const child = spawn(process.execPath, [daemonPath, '--home', home, '--worker', workerPath], {
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.stdout?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  children.push(child);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`daemon exited during startup: ${child.exitCode ?? child.signalCode}\n${stderr.slice(-2000)}`);
    const connection = readConnection();
    if (connection && connection.pid === child.pid) {
      try { const health = await rpc(connection, 'health'); if (health.ready) return { child, connection }; } catch { /* not ready yet */ }
    }
    await sleep(100);
  }
  throw new Error(`daemon startup timed out\n${stderr.slice(-2000)}`);
}
async function waitExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(timeoutMs)]);
}
async function waitTask(connection, id, accepts, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await rpc(connection, 'snapshot');
    const task = snapshot.tasks.find(entry => entry.id === id);
    if (task) { last = task; if (accepts.includes(task.status)) return task; }
    await sleep(100);
  }
  throw new Error(`task ${id} timed out in ${last?.status}${last?.steps?.[0]?.error ? `: ${last.steps[0].error}` : ''}`);
}
function workerChildPids() {
  if (!daemon?.pid) return [];
  try {
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${daemon.pid}" | Where-Object { $_.CommandLine -like '*research_worker.py*' } | Select-Object -ExpandProperty ProcessId`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return out.split(/\s+/).map(Number).filter(value => Number.isFinite(value) && value > 0);
  } catch { return []; }
}
function taskArtifacts(task) { return task.artifacts ?? []; }
function operationIds(task) { return (task.steps ?? []).map(step => step.operationId); }

const started = Date.now();
try {
  let launched = await launchDaemon();
  daemon = launched.child;
  let connection = launched.connection;
  record('daemon starts from durable state', Boolean(connection), `pid ${connection.pid}`);

  // Scenario 1: force-kill the Python worker while a sandboxed step is in flight.
  phase('scenario 1: python worker SIGKILL');
  const workerKillTask = (await rpc(connection, 'create', {
    name: 'chaos-python-worker-kill',
    steps: [{ id: 'kill', kind: 'python', input: { language: 'python', source: 'from pathlib import Path\nimport time\ntime.sleep(12)\nPath("worker-recovered.txt").write_text("recovered")\nprint("worker-recovered")' }, timeoutMs: 90_000, maxAttempts: 3 }],
  })).id;
  let pids = [];
  const pidDeadline = Date.now() + 20_000;
  while (Date.now() < pidDeadline && pids.length === 0) { pids = workerChildPids(); if (pids.length === 0) await sleep(150); }
  const killStarted = Date.now();
  for (const pid of pids) { try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ } }
  const recovered = await waitTask(connection, workerKillTask, ['completed', 'failed'], 120_000);
  const recoveredStep = recovered.steps?.[0];
  record('python worker SIGKILL is retried and recovers', recoveredStep?.status === 'completed' && (recoveredStep?.attempts ?? 0) >= 2 && String(recoveredStep?.output?.stdout ?? '').includes('worker-recovered'),
    `attempts ${recoveredStep?.attempts}, ${Date.now() - killStarted} ms`);
  record('recovered python step wrote exactly one artifact', taskArtifacts(recovered).length === 1, `${taskArtifacts(recovered).length} artifacts`);
  record('daemon still answers after worker restart', (await rpc(connection, 'worker.health')).status === 'ok');

  // Scenario 2: SIGKILL the daemon with a Python step/lease in flight, then restart.
  phase('scenario 2: daemon SIGKILL mid-python-step');
  const daemonKillTask = (await rpc(connection, 'create', {
    name: 'chaos-daemon-kill-python',
    steps: [{ id: 'long', kind: 'python', input: { language: 'python', source: 'from pathlib import Path\nimport time\ntime.sleep(10)\nPath("daemon-recovered.txt").write_text("recovered")\nprint("daemon-recovered")' }, timeoutMs: 90_000, maxAttempts: 3 }],
  })).id;
  await waitTask(connection, daemonKillTask, ['running'], 20_000);
  const inFlight = (await rpc(connection, 'snapshot')).tasks.find(task => task.id === daemonKillTask);
  const operationBeforeKill = inFlight.steps[0].operationId;
  daemon.kill('SIGKILL');
  await waitExit(daemon);
  const killAt = Date.now();
  launched = await launchDaemon();
  daemon = launched.child;
  connection = launched.connection;
  const daemonRecovered = await waitTask(connection, daemonKillTask, ['completed', 'failed'], 150_000);
  const daemonStep = daemonRecovered.steps?.[0];
  record('daemon SIGKILL mid-step recovers from durable lease', daemonRecovered.status === 'completed' && operationIds(daemonRecovered)[0] === operationBeforeKill,
    `${daemonStep?.status}, attempts ${daemonStep?.attempts}, ${Date.now() - killAt} ms after restart`);
  record('recovery kept the same operation id and one artifact', taskArtifacts(daemonRecovered).length === 1, `${taskArtifacts(daemonRecovered).length} artifacts`);

  // Scenario 3: committed step must not be replayed after a daemon SIGKILL.
  phase('scenario 3: committed step no-replay after SIGKILL');
  const committedTask = (await rpc(connection, 'create', {
    name: 'chaos-no-replay',
    steps: [
      { id: 'before', kind: 'echo', input: 'committed-once' },
      { id: 'timer', kind: 'delay', input: { ms: 4000 }, dependsOn: ['before'] },
      { id: 'after', kind: 'echo', input: 'after-restart', dependsOn: ['timer'] },
    ],
  })).id;
  const committedDeadline = Date.now() + 20_000;
  let committed;
  while (Date.now() < committedDeadline) {
    const snapshot = await rpc(connection, 'snapshot');
    committed = snapshot.tasks.find(task => task.id === committedTask);
    if (committed?.steps?.[0]?.status === 'completed' && committed?.steps?.[1]?.status === 'waiting_external') break;
    await sleep(100);
  }
  daemon.kill('SIGKILL');
  await waitExit(daemon);
  launched = await launchDaemon();
  daemon = launched.child;
  connection = launched.connection;
  const noReplay = await waitTask(connection, committedTask, ['completed', 'failed'], 60_000);
  record('committed step is not replayed after daemon SIGKILL', noReplay.steps?.find(step => step.id === 'before')?.attempts === 1 && noReplay.status === 'completed',
    `before attempts ${noReplay.steps?.find(step => step.id === 'before')?.attempts}, timer attempts ${noReplay.steps?.find(step => step.id === 'timer')?.attempts}`);

  // Scenario 4: cancel propagates to a sandboxed step and no artifact is committed.
  phase('scenario 4: cancel propagation');
  const cancelTask = (await rpc(connection, 'create', {
    name: 'chaos-cancel',
    steps: [{ id: 'cancel', kind: 'python', input: { language: 'python', source: 'import time\ntime.sleep(60)' }, timeoutMs: 90_000, maxAttempts: 1 }],
  })).id;
  await waitTask(connection, cancelTask, ['running'], 20_000);
  const cancelSnapshot = (await rpc(connection, 'snapshot')).tasks.find(task => task.id === cancelTask);
  const cancelled = await rpc(connection, 'control', { id: cancelTask, action: 'cancel', version: cancelSnapshot.version });
  const cancelFinal = await waitTask(connection, cancelTask, ['cancelled'], 20_000);
  record('cancel propagates to sandboxed worker step', cancelled.status === 'cancelled' && cancelFinal.status === 'cancelled', cancelFinal.status);
  record('cancelled step commits no artifact', taskArtifacts(cancelFinal).length === 0, `${taskArtifacts(cancelFinal).length} artifacts`);
  record('daemon remains responsive after cancellation', (await rpc(connection, 'health')).ready === true);

  // Scenario 5: provider 429/500 failures retried, then completed without silent provider switch.
  phase('scenario 5: provider 429/500 retry');
  let providerRequests = 0;
  const provider = createServer(async (request, response) => {
    providerRequests += 1; request.resume();
    if (providerRequests === 1) { response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":{"message":"rate limited by fixture"}}'); return; }
    if (providerRequests === 2) { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"fixture upstream failure"}}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'retry-recovered' } }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolveListen => provider.listen(0, '127.0.0.1', resolveListen));
  const providerPort = provider.address().port;
  await rpc(connection, 'configure', { provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: 'chaos-fixture', apiKey: 'synthetic-chaos-key', contextWindow: 4096, maxOutput: 128 });
  const modelTask = (await rpc(connection, 'create', {
    name: 'chaos-provider-retry',
    steps: [{ id: 'model', kind: 'model', input: { prompt: 'retry through two injected failures' }, sideEffect: true, maxAttempts: 5, timeoutMs: 30_000 }],
  })).id;
  const modelDeadline = Date.now() + 120_000;
  let modelDone = await waitTask(connection, modelTask, ['completed', 'failed', 'waiting_approval'], 60_000);
  let approvals = 0;
  while (modelDone.status === 'waiting_approval' && Date.now() < modelDeadline) {
    const waiting = (modelDone.steps ?? []).find(step => step.status === 'waiting_approval');
    if (!waiting) throw new Error('task is waiting_approval but no step is waiting');
    await rpc(connection, 'approval', { taskId: modelTask, stepId: waiting.id, decision: { action: 'retry' }, version: waiting.version });
    approvals += 1;
    modelDone = await waitTask(connection, modelTask, ['completed', 'failed', 'waiting_approval'], 60_000);
  }
  record('provider 429/500 faults are retried then completed', modelDone.status === 'completed' && providerRequests >= 3 && approvals >= 1,
    `${providerRequests} requests, ${approvals} human approvals, ${modelDone.status}`);
  const eventTypes = (modelDone.events ?? []).map(event => event.type);
  record('billing-unknown 429/500 needed explicit approval, visible in the durable event log',
    eventTypes.some(type => /retry|failed|approval\.resolved/.test(type)), eventTypes.slice(-8).join(','));
  provider.close(); provider.closeAllConnections();

  report.scenarios = results;
  report.durationMs = Date.now() - started;
  report.result = results.every(entry => entry.ok) ? 'passed' : 'failed';
  await rpc(connection, 'shutdown').catch(() => {});
  await waitExit(daemon);
} catch (error) {
  record('chaos run completed', false, error.message);
  report.scenarios = results;
  report.result = 'failed';
  report.error = error.message;
  if (stderr) report.daemonStderrTail = stderr.split('\n').slice(-40).join('\n');
} finally {
  clearTimeout(watchdog);
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } } }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  const out = join(docsVerification, 'chaos-results.json');
  try { writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`wrote ${out}`); } catch (error) { console.error('could not write chaos report:', error.message); }
  console.log(`\nChaos summary: ${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed, ${results.length} checks, ${report.durationMs} ms`);
  if (!keep) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } }
  else console.log(`kept chaos home: ${home}`);
  process.exit(report.result === 'passed' ? 0 : 1);
}
