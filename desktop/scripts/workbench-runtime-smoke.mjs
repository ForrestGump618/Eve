import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..');
const { WorkbenchManager } = await import(pathToFileURL(join(root, 'dist/src/workbench.js')).href);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const python = arg('python', process.env.SUWEN_PYTHON || 'python');
const depsDir = resolve(arg('deps', join(tmpdir(), 'suwen-workbench-smoke')));
const source = resolve(arg('source', resolve(root, '..')));
const doInstall = process.argv.includes('--install');
const keep = process.argv.includes('--keep');

const checks = [];
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

const manager = new WorkbenchManager({ depsDir, home: join(depsDir, 'home'), python: () => python });
let status = await manager.status();
console.log('status', JSON.stringify({ installed: status.installed, pythonVersion: status.pythonVersion, pip: status.pip, bytes: status.bytes, error: status.error }));
if (!status.installed && doInstall) {
  let last = 0;
  status = await manager.install(event => {
    if (Date.now() - last > 800) { last = Date.now(); console.log(`[install/${event.phase}] ${event.message}`); }
  });
  console.log('after install', JSON.stringify({ installed: status.installed, bytes: status.bytes, missing: status.missing, error: status.error }));
}
check('runtime-installed', status.installed, status.error || '');

const home = mkdtempSync(join(tmpdir(), 'suwen-legacy-home-'));
const token = randomBytes(32).toString('hex');
const script = join(root, 'worker/legacy_server.py');
const child = spawn(python, ['-E', '-s', script, '--source', source, '--home', home, '--deps', depsDir], {
  cwd: root,
  env: { ...process.env, SUWEN_BRIDGE_TOKEN: token },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
const ready = await new Promise((resolveReady, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error(`bridge startup timeout: ${stderr.slice(-1500)}`)), 120_000);
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const line = buffer.split(/\r?\n/)[0];
    if (buffer.includes('\n')) { clearTimeout(timer); try { resolveReady(JSON.parse(line)); } catch (error) { reject(error); } }
  });
  child.on('exit', code => { clearTimeout(timer); reject(new Error(`bridge exited early code=${code}: ${stderr.slice(-1500)}`)); });
});
check('bridge-ready', Number.isInteger(ready.port), `port=${ready.port}`);
const base = `http://127.0.0.1:${ready.port}`;
const auth = { Authorization: `Bearer ${token}` };
async function request(pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { ...auth, ...(options.headers || {}) } });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html/text asset */ }
  return { status: response.status, text, json };
}

try {
  let health = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const result = await request('/api/health'); if (result.status === 200) { health = result.json; break; } } catch { /* not up yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  check('api-health', health && health.ok === true, JSON.stringify(health).slice(0, 200));
  const index = await request('/');
  check('spa-index', index.status === 200 && /<title>Eve[\s·]/.test(index.text) && index.text.includes('js/app.js'), `status=${index.status} bytes=${index.text.length}`);
  const appJs = await request('/js/app.js');
  const appJsSha = createHash('sha256').update(appJs.text).digest('hex');
  check('spa-app-js', appJs.status === 200 && appJs.text.includes('VIEW_LOADERS'), `bytes=${appJs.text.length} sha256=${appJsSha.slice(0, 16)}`);
  const css = await request('/css/base.css');
  check('spa-css', css.status === 200 && css.text.length > 1000, `bytes=${css.text.length}`);
  const unauthenticated = await fetch(base + '/api/health');
  check('auth-required', unauthenticated.status === 401, `status=${unauthenticated.status}`);

  const endpoints = [
    '/api/settings', '/api/agents', '/api/agents/default', '/api/conversations', '/api/skills',
    '/api/memory', '/api/jobs', '/api/figures', '/api/workspaces', '/api/kernels', '/api/kernel/status',
    '/api/kernel/vars', '/api/registry/modules', '/api/registry/search?q=tool', '/api/discovery/projects',
    '/api/files/tree?path=', '/api/system/info', '/api/approvals',
  ];
  for (const pathname of endpoints) {
    const result = await request(pathname);
    check(`endpoint ${pathname}`, result.status === 200, `status=${result.status}`);
  }
  const created = await request('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'workbench smoke' }) });
  const conversationId = created.json?.id || created.json?.conversation?.id;
  check('create-conversation', (created.status === 200 || created.status === 201) && Boolean(conversationId), `status=${created.status} id=${conversationId || '?'}`);
  const run = await request(`/api/sessions/${encodeURIComponent(conversationId || '')}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello from workbench smoke' }) });
  check('create-run', run.status === 200 || run.status === 201 || run.status === 202, `status=${run.status} run=${run.json?.run_id || run.json?.id || '?'}`);
  console.log('sample', JSON.stringify({ health: health && Object.keys(health), settings: (await request('/api/settings')).json?.provider }));
} finally {
  try { child.stdin.write('shutdown\n'); child.stdin.end(); } catch { /* already closed */ }
  await new Promise(resolveExit => { const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolveExit(); }, 8000); child.on('exit', () => { clearTimeout(timer); resolveExit(); }); });
  if (!keep) { rmSync(home, { recursive: true, force: true }); }
}
const failed = checks.filter(entry => !entry.ok);
const report = {
  at: new Date().toISOString(),
  result: failed.length === 0 ? 'passed' : 'failed',
  passed: checks.length - failed.length,
  failed: failed.map(entry => entry.id),
  checks,
  environment: { node: process.version, platform: process.platform, python, depsDir },
  limits: ['local loopback only', 'uses the existing managed dependency directory', 'does not install dependencies unless --install is passed'],
  stderr: stderr.slice(-800),
};
const outPath = resolve(arg('out', join(repo, 'docs', 'verification', 'workbench-runtime-smoke.json')));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.map(entry => entry.id), report: outPath, checks, stderr: stderr.slice(-800) }));
process.exit(failed.length === 0 ? 0 : 1);
