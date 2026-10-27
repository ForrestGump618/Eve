/** Real model + real daemon/IPC/tools. Local MCP/Skill fixtures are explicitly labelled.
 * node scripts/harness-benchmark.mjs --phase=baseline --credentials=C:\path\API.txt
 * Credentials stay in memory. Reports contain no configuration/key/connection token.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const phase = arg('phase', 'final');
const taskBytes = readFileSync(join(root, 'scripts/harness-tasks.json'));
const tasks = JSON.parse(taskBytes);
const credentialFile = arg('credentials', '');
if (!credentialFile) throw new Error('Explicit --credentials=path required');
const lines = readFileSync(credentialFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const baseUrl = lines.find(x => /^https:\/\//.test(x));
const apiKey = lines.find(x => !/^https?:\/\//.test(x));
if (!apiKey || !baseUrl) throw new Error('Credential file must contain one key and one HTTPS endpoint');
const model = arg('model', 'deepseek-v4.1-flash-economy');
const home = mkdtempSync(join(tmpdir(), 'suwen-harness-live-'));
const out = resolve(root, '../docs/verification/harness-20261025');
mkdirSync(out, { recursive: true });
const reportFile = join(out, `${phase}.json`);
const report = { phase, model, taskSetSha256: createHash('sha256').update(taskBytes).digest('hex'), startedAt: new Date().toISOString(), kind: 'real external model, public network, real isolated daemon; MCP/Skill are local executable fixtures', results: [] };
const redact = text => String(text).split(apiKey).join('[redacted]').replace(/Bearer\s+\S+|sk-[\w-]+/g, '[redacted]');
function save() { writeFileSync(reportFile, redact(JSON.stringify(report, null, 2))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rpc(connection, method, params = {}) {
  return new Promise((res, rej) => {
    const socket = connect(connection.pipe); let raw = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? rej(error) : res(value); };
    const timer = setTimeout(() => finish(new Error(`IPC timeout: ${method}`)), 30000);
    socket.on('error', () => finish(new Error(`IPC transport: ${method}`)));
    socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n'));
    socket.on('data', chunk => { raw += chunk.toString(); if (raw.length > 8e6) return finish(new Error('IPC frame too large')); if (!raw.includes('\n')) return; try { const m = JSON.parse(raw.slice(0, raw.indexOf('\n'))); finish(m.error ? new Error(redact(JSON.stringify(m.error))) : null, m.result); } catch { finish(new Error('IPC invalid JSON')); } });
  });
}
const child = spawn(process.execPath, [join(root, 'dist/src/daemon.js'), '--home', home, '--worker', join(root, 'worker/research_worker.py')], { cwd: root, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
child.stderr.on('data', () => {}); // No arbitrary transport logs in reports.
let connection;
try {
  for (let i = 0; i < 150; i++) { try { connection = JSON.parse(readFileSync(join(home, 'connection.json'), 'utf8')); break; } catch { await sleep(100); } }
  if (!connection) throw new Error('Daemon did not start');
  await rpc(connection, 'configure', { provider: 'openai', baseUrl, apiKey, model, contextWindow: 65536, maxOutput: 2048 });
  const notes = join(home, 'benchmark-notes.txt');
  writeFileSync(notes, 'experiment=control\nnumbers=[2,4,6,8,10]\nsample_count=5\nmean=6\nconclusion=Mean matches the recorded control.\nmarker=SW-BENCH-20261025\n');
  const mcp = await rpc(connection, 'mcp.add', { name: 'benchmark-local-mcp', transport: 'stdio', command: process.execPath, args: [join(root, 'scripts/fixtures/research-e2e/mcp-server.mjs')], readOnly: true, enabled: true });
  await rpc(connection, 'mcp.health', { id: mcp.server.id });
  const skillDir = join(home, 'benchmark-skill-source'); mkdirSync(skillDir);
  writeFileSync(join(skillDir, 'SKILL.md'), '# benchmark-mean\nCompute a mean. Input is a JSON object with a numbers array. Use skill_run with input {"numbers":[2,4,6,8,10]}. Dependencies: Python standard library only.');
  writeFileSync(join(skillDir, 'mean.py'), 'import sys, json\ndata=json.loads(sys.argv[1])\nvalues=data["numbers"]\nif not values: raise ValueError("numbers must not be empty")\nprint(json.dumps({"count":len(values),"mean":sum(values)/len(values)}))\n');
  writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({ name:'benchmark-mean', version:'1.0.0', entry:'SKILL.md', license:'MIT', description:'Compute arithmetic mean of numbers 均值计算', permissions:[], run:{language:'python', script:'mean.py', timeoutMs:15000} }));
  await rpc(connection, 'skill.install', { path: skillDir, confirm: true });
  for (const item of tasks.filter(x => !arg('only','') || arg('only','').split(',').includes(x.id))) {
    const started = Date.now(); let entry = { id:item.id, category:item.category, prompt:item.prompt, status:'unverified' };
    try {
      const task = await rpc(connection, 'create', { name:item.id, steps:[{ id:'reply', kind:'model', input:{prompt:item.prompt, allowedFiles:[notes],permissionMode:'full'}, sideEffect:true, maxAttempts:1, timeoutMs:240000 }], limits:{maxTokens:160000, maxWallMs:270000} });
      entry.taskId = task.id;
      let snapshot;
      while (Date.now() - started < 265000) {
        snapshot = (await rpc(connection,'snapshot')).tasks.find(x => x.id === task.id);
        if (snapshot && ['completed','failed','cancelled','waiting_approval'].includes(snapshot.status)) break;
        await sleep(250);
      }
      const step = snapshot?.steps?.[0]; const output = step?.output;
      // Failed activities have no final output, but retain fenced trace events.
      // Count those calls as well; otherwise failures misleadingly erase tools.
      const toolTrace = output?.trace ?? (snapshot?.events ?? []).filter(x => /^(agent\.|model\.|tool\.)/.test(x.type) && x.data?.traceId).map(x => ({ ...x.data, type:x.type, at:x.at }));
      const completedTools = toolTrace.filter(x => x.type === 'tool.completed').map(x => x.name);
      const missingTools = item.tools.filter(name => !completedTools.includes(name));
      const text = output?.text ?? '';
      const missingContent = item.contains.filter(x => !text.toLowerCase().includes(x.toLowerCase()));
      entry = { ...entry, runStatus:snapshot?.status, answer:text, traceId:output?.traceId ?? toolTrace.find(x=>x.traceId)?.traceId ?? null, trace:toolTrace, events:snapshot?.events ?? [], sources:output?.sources ?? [], verification:output?.verification ?? null, tokens:snapshot?.tokens ?? 0, calls:snapshot?.calls ?? 0, missingTools, missingContent, error:step?.error ?? null, status:snapshot?.status === 'completed' && text.trim() && !missingTools.length && !missingContent.length && output?.verification?.passed !== false ? 'passed' : 'failed' };
    } catch (e) { entry.error = redact(e.message); entry.status='failed'; }
    entry.latencyMs = Date.now() - started; report.results.push(entry); save();
    console.log(`${phase} ${item.id}: ${entry.status} (${entry.latencyMs} ms) ${entry.error ?? ''}`);
  }
} catch (e) { report.error = redact(e.message); }
finally {
  try { if (connection) await rpc(connection,'shutdown'); } catch {} child.kill();
  report.finishedAt=new Date().toISOString();
  const sorted = report.results.map(x=>x.latencyMs).sort((a,b)=>a-b);
  const traces = report.results.flatMap(x=>x.trace ?? []);
  report.metrics = { passed:report.results.filter(x=>x.status==='passed').length, total:report.results.length, p50Ms:sorted[Math.max(0,Math.ceil(sorted.length*.5)-1)] ?? null, p95Ms:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)] ?? null, tokens:report.results.reduce((n,x)=>n+(x.tokens??0),0), toolCompleted:traces.filter(x=>x.type==='tool.completed').length, toolFailed:traces.filter(x=>x.type==='tool.failed').length, cost:null, costNote:'Provider did not report monetary cost; no invented price estimate.', citationNote:'URL membership/provenance check; semantic entailment requires answer review.' };
  save(); console.log(JSON.stringify(report.metrics)); console.log(reportFile);
  if (report.error || report.metrics.passed < Math.ceil(report.metrics.total*.9)) process.exitCode=1;
}
