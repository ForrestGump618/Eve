/**
 * SuWen desktop performance baseline (round 3).
 *
 * Measures only things this host can measure reliably, from the real compiled
 * daemon and the real Python research worker:
 *   - daemon cold/warm startup to authenticated RPC ready
 *   - events.stream latency / payload size after a burst of durable tasks
 *   - SQLite / WAL sizes after the burst; daemon RSS
 *   - Python worker health/describe/flowSummary latency on a real FCS file
 *
 * It does NOT measure Electron UI launch, markdown render CPU, first-token
 * latency via a real provider, or 8/24/72h endurance; those stay NOT_VERIFIED
 * (see docs/verification/performance-baseline.md).
 *
 * Usage: node scripts/performance-baseline.mjs [--json] [--out <path>] [--tasks 60] [--dist dist]
 */
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const outArg = args.indexOf('--out');
const outPath = outArg >= 0 ? resolve(args[outArg + 1]) : null;
const tasksArg = args.indexOf('--tasks');
const TASKS = tasksArg >= 0 ? Math.max(5, Number(args[tasksArg + 1])) : 60;
const distArg = args.indexOf('--dist');
const distDir = resolve(distArg >= 0 ? args[distArg + 1] : 'dist');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const daemonPath = join(distDir, 'src', 'daemon.js');
const workerPath = join(root, 'worker', 'research_worker.py');
const demoFcs = resolve(root, '..', 'omicslab', 'data', 'demo.fcs');

if (!existsSync(daemonPath)) {
  console.error(`compiled daemon not found: ${daemonPath}; run "npm run build" first`);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
function stats(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
    min: values.length ? Math.min(...values) : null,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
}

let rpcSeq = 0;
function rpc(connection, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const id = String(++rpcSeq);
    const socket = connect(connection.pipe);
    let raw = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`RPC timeout: ${method}`)), timeoutMs);
    socket.on('error', error => { clearTimeout(timer); finish(error); });
    socket.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 16_000_000) { clearTimeout(timer); finish(new Error('RPC response too large')); return; }
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const message = JSON.parse(raw.slice(0, newline));
        if (message.error) finish(new Error(String(message.error)));
        else finish(null, message.result);
      } catch (error) { finish(error); }
    });
    socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n'));
  });
}

function readConnection(home) {
  const file = join(home, 'connection.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

async function startDaemon(home) {
  const startedAt = now();
  const child = spawn(process.execPath, [daemonPath, '--home', home, '--worker', workerPath], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', c => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const connection = readConnection(home);
    if (connection?.pipe && connection?.token) {
      try {
        const health = await rpc(connection, 'health', {}, 5000);
        if (health?.ready) return { child, connection, startedAt, health, readyMs: now() - startedAt };
      } catch { /* not ready yet */ }
    }
    if (child.exitCode !== null) throw new Error(`daemon exited early (${child.exitCode}): ${stderr}`);
    await sleep(50);
  }
  child.kill('SIGKILL');
  throw new Error(`daemon did not become ready: ${stderr}`);
}

async function stopDaemon(child, connection) {
  try { await rpc(connection, 'shutdown', {}, 5000); } catch { /* ignore */ }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

async function benchDaemonStartup() {
  const cold = [];
  const warm = [];
  for (let i = 0; i < 3; i += 1) {
    const home = mkdtempSync(join(tmpdir(), 'suwen-perf-cold-'));
    try {
      const { child, connection, readyMs } = await startDaemon(home);
      cold.push(readyMs);
      await stopDaemon(child, connection);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const warmHome = mkdtempSync(join(tmpdir(), 'suwen-perf-warm-'));
  try {
    for (let i = 0; i < 2; i += 1) {
      const { child, connection, readyMs } = await startDaemon(warmHome);
      warm.push(readyMs);
      await stopDaemon(child, connection);
    }
  } finally {
    try { rmSync(warmHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { coldStartupMs: { values: cold, ...stats(cold) }, warmStartupMs: { values: warm, ...stats(warm) } };
}

async function benchRpcSurface() {
  const home = mkdtempSync(join(tmpdir(), 'suwen-perf-burst-'));
  const result = { home, taskCount: TASKS };
  let child = null;
  let connection = null;
  try {
    const started = await startDaemon(home);
    child = started.child;
    connection = started.connection;

    const createLatency = [];
    for (let i = 0; i < TASKS; i += 1) {
      const t0 = now();
      await rpc(connection, 'create', {
        name: `perf-echo-${i}`,
        steps: [{ id: 'echo', kind: 'echo', input: { i } }],
      }, 10_000);
      createLatency.push(now() - t0);
    }
    result.createLatencyMs = { values: createLatency.slice(0, 10), ...stats(createLatency) };

    // Let the engine drain the burst before measuring the event stream.
    await sleep(1200);

    const streamLatency = [];
    let lastPayloadBytes = 0;
    let lastEvents = 0;
    for (let i = 0; i < 10; i += 1) {
      const t0 = now();
      const response = await rpc(connection, 'events.stream', { since: 0, limit: 2000 }, 10_000);
      streamLatency.push(now() - t0);
      lastPayloadBytes = JSON.stringify(response).length;
      lastEvents = Array.isArray(response?.events) ? response.events.length : 0;
    }
    result.eventsStreamMs = { values: streamLatency, ...stats(streamLatency) };
    result.eventsStreamPayloadBytes = lastPayloadBytes;
    result.eventsStreamEventCount = lastEvents;

    const snapshotT0 = now();
    await rpc(connection, 'snapshot', {}, 10_000);
    result.snapshotMs = now() - snapshotT0;

    const db = join(home, 'harness.sqlite');
    const sizeOf = p => { try { return statSync(p).size; } catch { return null; } };
    result.sqliteBytes = sizeOf(db);
    result.sqliteWalBytes = sizeOf(`${db}-wal`);
    result.sqliteShmBytes = sizeOf(`${db}-shm`);

    const pid = started.health.pid;
    const tasklist = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const match = /"[^"]*","[^"]*","[^"]*","[^"]*","([\d,]+) K"/.exec(tasklist.stdout || '');
    result.daemonRssKb = match ? Number(match[1].replace(/,/g, '')) : null;
    result.daemonPid = pid;
  } finally {
    if (child && connection) await stopDaemon(child, connection);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    delete result.home;
  }
  return result;
}

async function benchPythonWorker() {
  const child = spawn('python', ['-u', workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const handler = pending.get(message.id);
        if (handler) { pending.delete(message.id); handler(null, message); }
      } catch { /* ignore non-JSON */ }
    }
  });
  child.stderr.on('data', () => {});
  const call = (op, input, timeoutMs = 60_000) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`worker timeout: ${op}`)); }, timeoutMs);
    pending.set(id, (error, message) => { clearTimeout(timer); if (error) reject(error); else resolvePromise(message); });
    child.stdin.write(JSON.stringify({ id, op, input }) + '\n');
  });
  const result = { demoFcs, demoFcsBytes: existsSync(demoFcs) ? statSync(demoFcs).size : null };
  try {
    const healthT0 = now();
    const health = await call('health', {}, 10_000);
    result.healthMs = now() - healthT0;
    result.health = health?.result ?? null;
    const describeT0 = now();
    const describe = await call('describe', {}, 10_000);
    result.describeMs = now() - describeT0;
    result.describeOps = describe?.result?.capabilities ?? null;
    if (!result.demoFcsBytes) {
      result.flowSummary = { skipped: 'demo.fcs missing' };
      return result;
    }
    const flowT0 = now();
    const flow = await call('flowSummary', { path: demoFcs, maxEvents: 6000 }, 120_000);
    result.flowSummaryMs = now() - flowT0;
    result.flowSummaryOk = flow?.ok === true;
    const parsed = flow?.result ?? {};
    result.flowSummary = {
      events: parsed.total ?? parsed.eventCount ?? null,
      channels: Array.isArray(parsed.channels) ? parsed.channels.length : null,
      firstChannels: Array.isArray(parsed.channels)
        ? parsed.channels.slice(0, 5).map(c => c.name ?? c.channel)
        : null,
    };
    return result;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* best effort */ }
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const results = {
    tool: 'suwen-performance-baseline',
    startedAt,
    root,
    environment: {
      platform: process.platform,
      osRelease: (await import('node:os')).release(),
      cpus: (await import('node:os')).cpus()?.[0]?.model ?? null,
      cpuCount: (await import('node:os')).cpus()?.length ?? null,
      totalMemBytes: (await import('node:os')).totalmem(),
      node: process.version,
      electronRuntime: process.versions.electron ?? null,
      daemonDist: daemonPath,
      python: spawnSync('python', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
    },
    benchmarks: {},
    notMeasured: [
      'Electron UI cold/warm launch (owned by T2 UI evidence; packaged timing in installer-lifecycle artifacts)',
      'Markdown render CPU for 10k deltas (T2 visual/streaming audit owns the browser measurement)',
      'First-token latency against a real vendor provider (no real account; local fixture only)',
      '8h/24h/72h endurance (NOT VERIFIED — not run on this host)',
    ],
  };
  results.benchmarks.daemonStartup = await benchDaemonStartup();
  results.benchmarks.rpcBurst = await benchRpcSurface();

  results.benchmarks.pythonWorker = await benchPythonWorker();

  const serialized = JSON.stringify(results, null, 2) + '\n';
  if (outPath) writeFileSync(outPath, serialized, 'utf8');
  console.log(serialized);
}

main().catch(error => {
  console.error(`performance-baseline error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
});
