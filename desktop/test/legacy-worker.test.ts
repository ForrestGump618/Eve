import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { launchLegacy } from '../src/legacy-worker.js';

test('optional actual Python workbench authenticates all routes and shuts down its kernel in an isolated home', { timeout: 110_000 }, async t => {
  const python = process.env.SUWEN_TEST_PYTHON || 'python';
  const probe = spawnSync(python, ['-E', '-c', 'import uvicorn, fastapi, jupyter_client, ipykernel, nbformat, httpx, rich, yaml, prompt_toolkit, qrcode'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (probe.error || probe.status !== 0) { t.skip('Optional Python interpreter or legacy dependencies are unavailable'); return; }
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'suwen-legacy-bridge-')));
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const script = fileURLToPath(new URL('../../worker/legacy_server.py', import.meta.url));
  const bridge = await launchLegacy(python, script, source, home);
  t.after(async () => { await bridge.stop(); rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${bridge.port}`;
  for (const route of ['/api/health', '/', '/api/openapi.json']) {
    assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await fetch(base + route, { headers: { Authorization: 'Bearer wrong-test-token' } })).status, 401);
  }
  const deniedWebSocketStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
    const upgrade = request(base + '/ws/terminal', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    upgrade.on('response', response => { response.resume(); resolveStatus(response.statusCode ?? 0); });
    upgrade.on('upgrade', (_response, socket) => { socket.destroy(); rejectStatus(new Error('Unauthenticated WebSocket was accepted')); });
    upgrade.on('error', rejectStatus);
    upgrade.end();
  });
  assert.equal(deniedWebSocketStatus, 403); // ASGI sends close 4401 before accept, encoded as HTTP denial.
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const health = await fetch(base + '/api/health', { headers });
  assert.equal(health.status, 200);
  const status: any = await health.json();
  assert.equal(JSON.stringify(status).includes(bridge.token), false);
  assert.equal(status.llm.provider, 'mock');
  assert.equal(status.kernel.running, true);
  assert.equal(Number.isInteger(status.kernel.pid) && status.kernel.pid > 0, true);
  const system: any = await (await fetch(base + '/api/system/info', { headers })).json();
  assert.equal(system.home, home);
  assert.equal(system.workspace, join(home, 'workspace'));
  const page = await fetch(base + '/', { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /素问|suwen/i);
  assert.equal((await fetch(base + '/api/conversations', { headers })).status, 200);
  assert.ok(readdirSync(home).length > 0);
  for (const entry of readdirSync(home, { withFileTypes: true })) if (entry.isFile()) assert.equal(readFileSync(join(home, entry.name)).includes(Buffer.from(bridge.token)), false);
  const kernelPid = status.kernel?.pid;
  await bridge.stop();
  assert.throws(() => process.kill(bridge.pid, 0));
  assert.throws(() => process.kill(kernelPid, 0));
  await assert.rejects(fetch(base + '/api/health', { headers }));
});

test('legacy launch rejects a pre-cancelled request without starting Python', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchLegacy('python', '/unused/legacy_server.py', '/unused/source', '/unused/home', controller.signal), /cancelled/);
});
