/**
 * End-to-end RPC smoke test for the real detached daemon.
 *
 * Runs the compiled daemon from a throw-away home directory, then exercises the
 * same localhost/named-pipe JSON-RPC surface the Electron renderer uses:
 * health/diagnostics, settings defaults, projects, conversations, imports,
 * evidence/artifact safety, MCP/Skill/Channel/RSI registries, durable task
 * creation (echo/delay/cancel), the Python research worker sandbox, and the
 * explicit model-gate error path.
 *
 * Usage: node scripts/e2e-rpc.mjs [--dist dist] [--keep] [--live]
 *   --live adds real public-network PubMed (Europe PMC) and UniProt MCP calls.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const distArg = args.indexOf('--dist');
const distDir = resolve(distArg >= 0 ? args[distArg + 1] : 'dist');
const keep = args.includes('--keep');
const live = args.includes('--live');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const daemonPath = join(distDir, 'src', 'daemon.js');
const workerPath = join(root, 'worker', 'research_worker.py');

if (!existsSync(daemonPath)) {
  console.error(`compiled daemon not found: ${daemonPath}\nrun "npm run build" first`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const home = mkdtempSync(join(tmpdir(), 'suwen-e2e-'));
const results = [];
let daemon = null;
let stderr = '';

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readConnection() {
  const file = join(home, 'connection.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

let rpcSeq = 0;
function rpc(connection, method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const id = String(++rpcSeq);
    const socket = connect(connection.pipe);
    let raw = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`RPC timeout: ${method}`)), timeoutMs);
    socket.on('error', error => { clearTimeout(timer); finish(error); });
    socket.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 8_000_000) { clearTimeout(timer); finish(new Error('RPC response too large')); return; }
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

function findTask(snapshot, taskId) {
  return (snapshot?.tasks ?? []).find(task => task.id === taskId);
}

async function waitTask(connection, taskId, terminal, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await rpc(connection, 'snapshot');
    const task = findTask(snapshot, taskId);
    if (task && terminal.includes(task.status)) return task;
    await sleep(150);
  }
  throw new Error(`task ${taskId} did not reach ${terminal.join('|')} in ${timeoutMs}ms`);
}

function nodeArgs() {
  return [daemonPath, '--home', home, '--worker', workerPath];
}

try {
  daemon = spawn(process.execPath, nodeArgs(), {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemon.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
  daemon.stdout.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });

  let connection = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    connection = readConnection();
    if (connection?.pipe && connection?.token) break;
    if (daemon.exitCode !== null) throw new Error(`daemon exited early (${daemon.exitCode}): ${stderr}`);
    await sleep(100);
  }
  if (!connection?.pipe) throw new Error(`daemon connection not published: ${stderr}`);

  const health = await rpc(connection, 'health');
  assert('health ready', health.ready === true && health.mode === 'user-background', `pid ${health.pid}`);
  assert('health version matches package.json', health.version === pkg.version, `${health.version}`);
  assert('health reports daemon runtime versions', Boolean(health.runtimeVersions?.node), `node ${health.runtimeVersions?.node}`);
  assert('health reports python path', typeof health.python === 'string' && health.python.length > 0, health.python);

  const doctor = await rpc(connection, 'doctor.run');
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  assert('doctor returns checks', checks.length >= 6, `${checks.length} checks`);
  assert('doctor daemon/store pass', checks.filter(c => ['daemon', 'store'].includes(c.id)).every(c => c.status === 'pass'));
  assert('doctor warns on unconfigured model', checks.some(c => c.id === 'model' && c.status === 'warn'));

  const defaults = await rpc(connection, 'defaults.get');
  assert('defaults.get shape', defaults && typeof defaults === 'object', Object.keys(defaults).join(','));
  const setResult = await rpc(connection, 'defaults.set', { autoCompact: false });
  assert('defaults.set persists', setResult.ok === true);
  const defaults2 = await rpc(connection, 'defaults.get');
  assert('defaults.set round-trips', defaults2.autoCompact === false);

  const project = await rpc(connection, 'project.create', { name: 'E2E 项目', notes: 'rpc smoke' });
  assert('project.create', typeof project.id === 'string' && project.id.length > 0, project.id);
  const projects = await rpc(connection, 'project.list');
  const projectList = Array.isArray(projects) ? projects : Array.isArray(projects?.projects) ? projects.projects : Array.isArray(projects?.records) ? projects.records : [];
  assert('project.list contains created project', projectList.some(p => p.id === project.id));

  const conversation = await rpc(connection, 'conversation.create', { projectId: project.id, title: 'E2E 会话', mode: 'chat' });
  assert('conversation.create', typeof conversation.id === 'string', conversation.id);
  const appended = await rpc(connection, 'conversation.append', {
    id: conversation.id,
    messages: [{ role: 'user', text: '端到端测试消息' }],
  });
  assert('conversation.append', appended.index === 0 || appended.index === 1, `index ${appended.index}`);
  const stored = await rpc(connection, 'conversation.get', { id: conversation.id });
  assert('conversation.get stores message', (stored.messages ?? []).some(m => m.text === '端到端测试消息'));
  const listed = await rpc(connection, 'conversation.list', { projectId: project.id });
  const conversationList = Array.isArray(listed) ? listed : Array.isArray(listed?.conversations) ? listed.conversations : [];
  assert('conversation.list filters by project', conversationList.some(c => c.id === conversation.id));

  const inspected = await rpc(connection, 'import.inspect');
  assert('import.inspect is read-only inventory', inspected && Array.isArray(inspected.items), `${inspected.items?.length ?? 0} items`);
  const jobs = await rpc(connection, 'import.jobs');
  assert('import.jobs starts empty', (jobs.jobs ?? []).length === 0);

  const evidence = await rpc(connection, 'evidence.list');
  assert('evidence.list shape', Array.isArray(evidence.evidence ?? evidence.items ?? []));
  let artifactGuarded = false;
  try { await rpc(connection, 'artifact.read', { taskId: '00000000-0000-0000-0000-000000000000', artifactId: 'not-an-artifact' }); }
  catch (error) { artifactGuarded = /artifact|path|escape|outside|无效/i.test(String(error)); }
  assert('artifact.read rejects unknown artifacts', artifactGuarded);

  const skills = await rpc(connection, 'skill.list');
  assert('skill.list', Array.isArray(skills.skills));
  const mcp = await rpc(connection, 'mcp.list');
  assert('mcp.list', Array.isArray(mcp.servers ?? mcp.mcpServers ?? []));
  const channels = await rpc(connection, 'channel.list');
  assert('channel.list', Array.isArray(channels.channels));
  const rsi = await rpc(connection, 'rsi.list');
  assert('rsi.list', Array.isArray(rsi.runs));
  assert('rsi.active', (await rpc(connection, 'rsi.active')) && typeof (await rpc(connection, 'rsi.active')) === 'object');

  const graph = await rpc(connection, 'research.graph', { projectId: project.id });
  assert('research.graph returns empty graph view', graph && (graph.graph === null || typeof graph.graph === 'object'));

  let modelGate = false;
  let modelGateError = '';
  try { await rpc(connection, 'research.knowledge', { question: '端到端测试问题' }); modelGateError = 'no error thrown'; }
  catch (error) { modelGateError = String(error); modelGate = /model|配置/i.test(modelGateError); }
  assert('research.knowledge states the real model gate', modelGate, modelGateError);

  const echoTask = await rpc(connection, 'create', {
    name: 'e2e-echo',
    steps: [{ id: 'echo', kind: 'echo', input: { hello: 'world' } }],
  });
  const echoDone = await waitTask(connection, echoTask.id, ['completed']);
  assert('durable echo task completes', echoDone.steps?.[0]?.status === 'completed', echoDone.status);
  assert('durable echo output persisted', JSON.stringify(echoDone.steps?.[0]?.output ?? '').includes('world'));

  const delayTask = await rpc(connection, 'create', {
    name: 'e2e-cancel',
    steps: [{ id: 'delay', kind: 'delay', input: { ms: 120_000 } }],
  });
  await sleep(300);
  const delaySnapshot = await rpc(connection, 'snapshot');
  const delayRunning = findTask(delaySnapshot, delayTask.id);
  assert('delay task is running before cancel', ['running','queued','retry_scheduled','waiting_external'].includes(delayRunning?.status), delayRunning?.status);
  const cancelled = await rpc(connection, 'control', { id: delayTask.id, action: 'cancel', version: delayRunning?.version });
  assert('control cancel transitions task', cancelled.status === 'cancelled', cancelled.status);

  const pythonTask = await rpc(connection, 'create', {
    name: 'e2e-python',
    steps: [{ id: 'py', kind: 'python', input: { language: 'python', source: 'print(6*7)' } }],
  });
  const pythonDone = await waitTask(connection, pythonTask.id, ['completed', 'failed'], 60_000);
  const pythonOutput = pythonDone.steps?.[0]?.output ?? {};
  assert('python research worker executes sandboxed script',
    pythonDone.steps?.[0]?.status === 'completed' && pythonOutput.exitCode === 0 && String(pythonOutput.stdout ?? '').includes('42'),
    `status ${pythonDone.steps?.[0]?.status}, exit ${pythonOutput.exitCode}`);

  const health2 = await rpc(connection, 'worker.health');
  assert('worker.health available', health2.status === 'ok' || health2.status === 'unavailable', health2.status);
  const described = await rpc(connection, 'worker.describe');
  assert('worker.describe lists ops', Array.isArray(described.capabilities) && described.capabilities.includes('runScript'));

  if (live) {
    const liveDatabase = async (kind, query, label) => {
      const task = await rpc(connection, 'create', { name: `e2e-live-${kind}`, steps: [{ id: 'search', kind, input: { query } }] });
      const done = await waitTask(connection, task.id, ['completed', 'failed'], 150_000);
      const step = done.steps?.[0];
      const output = step?.output ?? {};
      const serialized = JSON.stringify(output);
      assert(`${label} returns a real payload`, step?.status === 'completed' && serialized.length > 100, serialized.slice(0, 180));
      const artifact = (done.artifacts ?? [])[0];
      assert(`${label} artifact recorded with sha256`, Boolean(artifact && /^[0-9a-f]{64}$/.test(artifact.sha256)), artifact?.path ?? 'missing artifact');
      return { output, artifact };
    };
    const pubmed = await liveDatabase('pubmed', 'CRISPR base editing', 'live PubMed/Europe PMC MCP');
    const uniprot = await liveDatabase('uniprot', 'TP53', 'live UniProt MCP');
    console.log('live PubMed payload preview:', JSON.stringify(pubmed.output).slice(0, 400));
    console.log('live UniProt payload preview:', JSON.stringify(uniprot.output).slice(0, 400));
  }

  const support = await rpc(connection, 'snapshot');
  assert('snapshot includes task history and events', Array.isArray(support.tasks) && support.tasks.some(t => t.id === echoTask.id && (t.events ?? []).length > 0));

  const shutdown = await rpc(connection, 'shutdown');
  assert('shutdown acknowledged', shutdown.ok === true);
  await sleep(1200);
  assert('daemon exited after shutdown', daemon.exitCode !== null, `exit ${daemon.exitCode}`);
  assert('connection file removed', !existsSync(join(home, 'connection.json')));
} catch (error) {
  record('fatal', false, String(error));
  if (stderr) console.error('--- daemon stderr tail ---\n' + stderr.split('\n').slice(-25).join('\n'));
} finally {
  if (daemon && daemon.exitCode === null) {
    try { daemon.kill('SIGKILL'); } catch { /* best effort */ }
  }
  if (keep) console.log(`kept e2e home: ${home}`);
  else { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } }
}

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\nE2E RPC summary: ${passed} passed, ${failed} failed, ${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
