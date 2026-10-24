// Durable soak with real fault injection: runs the actual detached daemon over a named pipe,
// creates durable tasks repeatedly, and injects process kills / cancellations at a fixed cadence.
//
// Usage: node scripts/durability-soak.mjs [--minutes 25] [--interval 30] [--out <path>]
// Writes an evidence JSON document; never claims 8/24/72 h coverage.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MINUTES = Math.max(1, Number(flag('minutes', '25')));
const INTERVAL_MS = Math.max(5, Number(flag('interval', '30'))) * 1000;
const OUT = resolve(flag('out', join(root, '..', 'docs', 'verification', 'durability-soak.json')));
const HOME = join(process.env.TEMP ?? root, `suwen-soak-${Date.now()}-${randomUUID().slice(0, 8)}`);
const WORKER = join(root, 'worker', 'research_worker.py');
const DAEMON = join(root, 'dist', 'src', 'daemon.js');
mkdirSync(HOME, { recursive: true });
const startedAt = new Date();
const report = {
  schema: 'suwen-durability-soak/1',
  startedAt: startedAt.toISOString(),
  plannedMinutes: MINUTES,
  intervalSeconds: INTERVAL_MS / 1000,
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  limits: [
    'single Windows session, one host',
    'not an 8 h / 24 h / 72 h endurance run',
    'no sleep/hibernate, power loss, OS reboot or disk-full injection',
  ],
  cycles: [], faults: [], tasks: {}, errors: [],
};

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function rpc(connection, method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ path: connection.pipe });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`rpc timeout: ${method}`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, index));
        if (message.error) reject(new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`));
        else resolvePromise(message.result);
      } catch (error) {
        reject(new Error(`${method}: invalid response ${error.message}`));
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readConnection() {
  const path = join(HOME, 'connection.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* retry */
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

let daemon = null;
async function startDaemon() {
  daemon = spawn(process.execPath, [DAEMON, '--home', HOME, '--worker', WORKER], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemon.stdout.on('data', () => {});
  daemon.stderr.on('data', () => {});
  daemon.on('exit', code => log(`daemon exited code=${code}`));
  const connection = await waitFor(() => {
    const value = readConnection();
    return value && value.pipe ? value : null;
  }, 30_000, 'daemon connection');
  // A SIGKILLed daemon leaves a stale connection.json behind; re-read it every attempt so the
  // freshly spawned daemon's pipe/token are picked up instead of the dead one.
  await waitFor(async () => {
    const fresh = readConnection();
    if (!fresh?.pipe) return null;
    try {
      const health = await rpc(fresh, 'health');
      return health.ready ? health : null;
    } catch {
      return null;
    }
  }, 45_000, 'daemon health');
  report.daemon = { spawendAt: new Date().toISOString(), pid: daemon.pid };
  return readConnection() ?? connection;
}

async function killProcessTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

function pythonWorkerPids(daemonPid) {
  if (!daemonPid) return [];
  const script = `
$out = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'python3.exe'" |
  Where-Object { $_.ParentProcessId -eq ${Number(daemonPid)} -and $_.CommandLine -like '*research_worker.py*' } |
  Select-Object -ExpandProperty ProcessId
if ($out) { $out -join ',' }`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return result.stdout.trim().split(',').map(Number).filter(Boolean);
}

async function createTask(connection, name, steps) {
  const result = await rpc(connection, 'create', { name, steps });
  return result.task?.id ?? result.taskId ?? result.id;
}

async function snapshot(connection) {
  return rpc(connection, 'snapshot', {}, 30_000);
}

function findTask(state, id) {
  return (state.tasks ?? []).find(task => task.id === id) ?? null;
}

function cycleSteps(index) {
  const cycleTag = `soak-${index}-${Date.now()}`;
  if (index % 3 === 0) {
    return {
      kind: 'python',
      waitMs: 0,
      steps: [
        { id: 'prepare', kind: 'echo', input: { cycle: cycleTag } },
        {
          id: 'compute',
          kind: 'python',
          dependsOn: ['prepare'],
          sideEffect: true,
          maxAttempts: 3,
          input: {
            language: 'python',
            source: 'import json, os\nprint(json.dumps({"cycle": os.environ.get("SUWEN_SOAK", "soak")}))\nopen("soak-artifact.txt", "w").write("ok")\n',
            timeoutMs: 30_000,
          },
        },
      ],
    };
  }
  return {
    kind: 'timer',
    waitMs: 4000,
    steps: [
      { id: 'start', kind: 'echo', input: { cycle: cycleTag } },
      { id: 'timer', kind: 'delay', dependsOn: ['start'], input: { ms: 4000 } },
      { id: 'finish', kind: 'echo', dependsOn: ['timer'], input: { cycle: cycleTag } },
    ],
  };
}

async function waitTerminal(connection, taskId, timeoutMs = 45_000) {
  return waitFor(async () => {
    const state = await snapshot(connection);
    const task = findTask(state, taskId);
    if (!task) return null;
    return ['completed', 'failed', 'cancelled'].includes(task.status) ? task : null;
  }, timeoutMs, `task ${taskId}`);
}

async function main() {
  log(`soak home ${HOME}`);
  let connection = await startDaemon();
  const deadline = Date.now() + MINUTES * 60_000;
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle += 1;
    const plan = cycleSteps(cycle);
    const taskId = await createTask(connection, `soak cycle ${cycle}`, plan.steps);
    const created = { cycle, at: new Date().toISOString(), taskId, kind: plan.kind };
    report.cycles.push(created);
    try {
      if (cycle % 5 === 0) {
        const faultKind = ['daemon-kill', 'python-worker-kill', 'cancel'][(cycle / 5) % 3 | 0];
        const fault = { cycle, kind: faultKind, at: new Date().toISOString(), taskId };
        // Let the step start before injecting.
        await new Promise(r => setTimeout(r, 700));
        if (faultKind === 'daemon-kill') {
          await killProcessTree(daemon?.pid);
          daemon = null;
          connection = await startDaemon();
        } else if (faultKind === 'python-worker-kill') {
          const pids = pythonWorkerPids();
          fault.pids = pids;
          for (const pid of pids) await killProcessTree(pid);
        } else {
          const state = await snapshot(connection);
          const task = findTask(state, taskId);
          if (task) await rpc(connection, 'control', { taskId, action: 'cancel', expectedVersion: task.version }).catch(() => {});
        }
        fault.recovered = false;
        try {
          // Kill any in-flight task is allowed to recover on its own; verify the daemon still serves.
          if (daemon === null) connection = await startDaemon();
          const health = await rpc(connection, 'health');
          fault.health = { ready: health.ready === true, version: health.version };
          const verifierId = await createTask(connection, `soak verify ${cycle}`, [
            { id: 'echo', kind: 'echo', input: { afterFault: cycle } },
          ]);
          const verifier = await waitTerminal(connection, verifierId);
          fault.verifier = { taskId: verifierId, status: verifier.status };
          fault.recovered = verifier.status === 'completed' && health.ready === true;
        } catch (error) {
          fault.error = String(error);
        }
        report.faults.push(fault);
        log(`fault ${faultKind} recovered=${fault.recovered} ${fault.error ?? ''}`);
      }
      const terminal = await waitTerminal(connection, taskId, plan.kind === 'timer' ? 60_000 : 45_000).catch(error => ({ status: 'timeout', error: String(error) }));
      report.tasks[taskId] = { cycle, kind: plan.kind, status: terminal.status, attempts: terminal.attempts ?? null };
    } catch (error) {
      report.errors.push({ cycle, error: String(error) });
      log(`cycle ${cycle} error ${error}`);
      try {
        await rpc(connection, 'health');
      } catch {
        daemon = null;
        try {
          connection = await startDaemon();
        } catch (restartError) {
          report.errors.push({ cycle, restartError: String(restartError) });
        }
      }
    }
    const sleep = Math.max(0, Math.min(INTERVAL_MS, deadline - Date.now()));
    if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
  }
  const terminalCount = Object.values(report.tasks).filter(t => ['completed', 'cancelled', 'failed'].includes(t.status)).length;
  const completed = Object.values(report.tasks).filter(t => t.status === 'completed').length;
  report.finishedAt = new Date().toISOString();
  report.durationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  report.summary = {
    cycles: report.cycles.length,
    faults: report.faults.length,
    faultsRecovered: report.faults.filter(f => f.recovered).length,
    tasksTerminal: terminalCount,
    tasksCompleted: completed,
    errors: report.errors.length,
  };
  report.result = report.errors.length === 0 && report.faults.every(f => f.recovered) ? 'passed' : 'failed';
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`summary ${JSON.stringify(report.summary)} result=${report.result}`);
  log(`report ${OUT}`);
  try {
    await rpc(connection, 'shutdown');
  } catch {
    /* ignore */
  }
  await new Promise(r => setTimeout(r, 500));
  await killProcessTree(daemon?.pid);
  process.exit(report.result === 'passed' ? 0 : 1);
}

main().catch(error => {
  report.errors.push({ fatal: String(error) });
  report.finishedAt = new Date().toISOString();
  report.result = 'failed';
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error(error);
  killProcessTree(daemon?.pid);
  process.exit(1);
});
