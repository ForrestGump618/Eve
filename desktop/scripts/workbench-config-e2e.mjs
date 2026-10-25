#!/usr/bin/env node
/**
 * Verifies that the durable daemon injects the session model configuration into
 * the hosted legacy web workspace in memory, and restarts the bridge when that
 * configuration changes. Real daemon process, real Python bridge, real loopback
 * HTTP; the provider URL is a closed local port so nothing is billed and no
 * external network is used.
 *
 * Usage (from desktop/):
 *   npm run build
 *   node scripts/workbench-config-e2e.mjs [--python python] [--deps <dir>] [--out <json>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');            // desktop/
const repo = resolve(root, '..');            // TARGET_ROOT
const python = arg('python', process.env.SUWEN_PYTHON || 'python');
const deps = resolve(arg('deps', join(tmpdir(), 'suwen-workbench-smoke')));
const out = resolve(arg('out', join(repo, 'docs', 'verification', 'workbench-config-injection.json')));
const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: String(detail).slice(0, 400) });

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function rpc(connection, method, params = {}) {
  return new Promise((resolveRpc, rejectRpc) => {
    const socket = net.connect(connection.pipe);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); rejectRpc(new Error('RPC timeout ' + method)); }, 60000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (!line) return;
      clearTimeout(timer);
      socket.end();
      try {
        const message = JSON.parse(line);
        if (message.error) rejectRpc(new Error(message.error.message || 'RPC failed'));
        else resolveRpc(message.result);
      } catch (error) { rejectRpc(error); }
    });
    socket.on('error', error => { clearTimeout(timer); rejectRpc(error); });
  });
}

function getJson(port, path, token) {
  return new Promise((resolveGet, rejectGet) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers: { Authorization: 'Bearer ' + token }, timeout: 20000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolveGet({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }); }
        catch (error) { rejectGet(new Error('Non-JSON response (' + response.statusCode + ')')); }
      });
    });
    request.on('timeout', () => { request.destroy(); rejectGet(new Error('HTTP timeout')); });
    request.on('error', rejectGet);
  });
}

async function waitForConnection(home, deadlineMs) {
  const path = join(home, 'connection.json');
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* still being written */ }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('daemon connection.json did not appear');
}

const home = mkdtempSync(join(tmpdir(), 'suwen-wbcfg-'));
const daemon = spawn(process.execPath, [join(root, 'dist', 'src', 'daemon.js'), '--home', home, '--worker', join(root, 'worker', 'research_worker.py'), '--legacy-source', repo], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let daemonStderr = '';
daemon.stderr.on('data', chunk => { if (daemonStderr.length < 20000) daemonStderr += chunk; });
let connection;
try {
  check('deps-installed', existsSync(join(deps, '.suwen-workbench.json')), deps);
  check('python-available', true, python);
  connection = await waitForConnection(home, 30000);
  check('daemon-ready', Boolean(connection?.pipe && connection?.token), 'pipe+token');
  const health = await rpc(connection, 'health');
  check('daemon-version', typeof health.version === 'string' && health.version.length > 0, health.version);

  const first = await rpc(connection, 'legacyStart', {
    deps,
    config: { provider: 'custom-openai', model: 'legacy-injected', apiBase: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-not-real-credential' },
  });
  check('bridge-started', Number(first.port) > 0 && typeof first.token === 'string', 'pid=' + first.pid + ' port=' + first.port);
  const settings1 = await getJson(first.port, '/api/settings', first.token);
  const view1 = settings1.body?.settings && !Array.isArray(settings1.body.settings) ? settings1.body.settings : settings1.body;
  check('injected-provider', view1?.provider === 'custom_openai', view1?.provider);
  check('injected-model', view1?.model === 'legacy-injected', view1?.model);
  check('injected-api-base', view1?.api_base === 'http://127.0.0.1:9/v1', view1?.api_base);
  check('bridge-csp', /default-src 'self'/.test(String(settings1.headers['content-security-policy'] || '')), String(settings1.headers['content-security-policy'] || '').slice(0, 80));
  const appearance = await getJson(first.port, '/api/platform/config/appearance', first.token).catch(() => null);
  const theme = appearance?.body?.value?.theme;
  check('dark-default-seeded', theme === 'dark', String(theme));

  const second = await rpc(connection, 'legacyStart', {
    deps,
    config: { provider: 'custom-anthropic', model: 'legacy-injected-2', apiBase: 'http://127.0.0.1:9', apiKey: 'sk-test-not-real-credential-2' },
  });
  check('config-change-restarts-bridge', second.pid !== first.pid, 'pid ' + first.pid + ' -> ' + second.pid);
  const settings2 = await getJson(second.port, '/api/settings', second.token);
  const view2 = settings2.body?.settings && !Array.isArray(settings2.body.settings) ? settings2.body.settings : settings2.body;
  check('restart-applied-model', view2?.model === 'legacy-injected-2', view2?.model);
  check('restart-applied-provider', view2?.provider === 'custom_anthropic', view2?.provider);

  await rpc(connection, 'shutdown').catch(() => {});
} catch (error) {
  check('run', false, error?.message || String(error));
} finally {
  daemon.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
}

const failed = checks.filter(entry => !entry.ok);
const report = {
  at: new Date().toISOString(),
  result: failed.length === 0 ? 'passed' : 'failed',
  checks,
  daemonStderr: daemonStderr.slice(-2000),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  limits: ['local loopback only', 'provider URL is a closed port; no vendor API is called', 'single Windows session'],
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, passed: checks.length - failed.length, failed: failed.map(entry => entry.id), report: out }));
process.exit(failed.length === 0 ? 0 : 1);
