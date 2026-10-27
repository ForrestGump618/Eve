/** Real detached-daemon upgrade/reuse regression, using isolated user data.
 * Run before replacing win-unpacked when testing a previous same-version build. */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright-core');
const { rpc } = await import('../dist/src/rpc.js');
const oldExe = process.argv.find(arg => arg.startsWith('--previous='))?.slice(11);
if (!oldExe || !existsSync(oldExe)) throw Error('Provide an existing --previous=Eve.exe');
const profile = mkdtempSync(join(tmpdir(), 'eve-startup-upgrade-'));
const env = { ...process.env, EVE_TEST_HOME: profile, SUWEN_TEST_HOME: profile };
delete env.ELECTRON_RUN_AS_NODE;
const out = resolve(root, '../docs/verification/eve-1.0');
mkdirSync(out, { recursive: true });
const report = { kind: 'real same-version detached runtime upgrade and formal product UI; no model requests', checks: [], errors: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw Error(name);
};
let app, connection;
const connectionFile = join(profile, 'runtime/connection.json');
const readConnection = () => JSON.parse(readFileSync(connectionFile, 'utf8'));
try {
  app = await _electron.launch({ executablePath: resolve(oldExe), args: ['--native', '--background'], env });
  let page = await app.firstWindow();
  await page.waitForFunction(() => window.suwen && document.getElementById('health'));
  const previous = await page.evaluate(() => window.suwen.call('health', {}));
  connection = readConnection();
  const marker = join(profile, 'runtime', 'upgrade-preservation.txt');
  writeFileSync(marker, 'preserve user data through same-version upgrades');
  const dormant = await rpc(connection, 'create', { name: 'upgrade retains pending human approval', steps: [{ id: 'review', kind: 'approval' }] });
  await rpc(connection, 'control', { id: dormant.id, action: 'pause' });
  await app.evaluate(({ app }) => app.exit(0));
  app = null;
  check('old-daemon-outlives-window', (await rpc(connection, 'health')).pid === previous.pid);
  // Reproduce an upgraded profile with incompatible historical wheels before
  // the new main process creates its daemon.
  const staleDeps = join(profile, 'python-env');
  mkdirSync(staleDeps);
  writeFileSync(join(staleDeps, '.suwen-workbench.json'), JSON.stringify({ schema: 1, python: '3.0.0', requirementsHash: 'old' }));
  writeFileSync(join(staleDeps, 'fastapi.py'), 'raise RuntimeError("incompatible historical dependency must not load")\n');

  app = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: [root, '--native', '--background'], env,
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.suwen && document.getElementById('health'));
  const current = await page.evaluate(() => window.suwen.call('health', {}));
  connection = readConnection();
  check('same-version-old-runtime-replaced', previous.version === current.version && previous.pid !== current.pid);
  check('current-build-and-code-root-match', current.buildId === JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')).buildId
    && current.runtimeRoot === join(root, 'dist'));
  check('upgrade-preserves-user-data', readFileSync(marker, 'utf8') === 'preserve user data through same-version upgrades');
  check('upgrade-preserves-paused-task-without-replaying-it', (await rpc(connection, 'snapshot')).tasks.some(task => task.id === dormant.id && task.status === 'paused'));
  check('diagnostic-bootstrap-has-no-visible-window', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())));
  await app.evaluate(({ app }) => app.exit(0));
  app = null;

  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env });
  for (let i = 0; i < 180; i++) {
    page = app.windows().find(p => /^http:\/\/127\.0\.0\.1:/.test(p.url()));
    if (page) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await page.waitForSelector('.workbench-page .chat-view #chat-input', { timeout: 30000 });
  page.on('pageerror', error => report.errors.push(error.message));
  const dismiss = page.getByRole('button', { name: '先看看', exact: true });
  try {
    await dismiss.waitFor({ state: 'visible', timeout: 8000 });
    await dismiss.click();
    await dismiss.waitFor({ state: 'hidden' });
  } catch (error) {
    if (await dismiss.isVisible()) throw error;
  }
  check('matching-build-reuses-runtime', (await rpc(connection, 'health')).pid === current.pid);
  check('rejected-historical-dependencies-do-not-override-runtime-selection', true);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), visible: w.isVisible() })));
  check('only-one-formal-window-no-legacy-console', windows.length === 1 && windows[0].visible && windows[0].url.startsWith('http:'));
  check('formal-workbench-is-light', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
  await page.screenshot({ path: join(out, 'startup-current-workbench.png') });
  check('no-renderer-errors', report.errors.length === 0);
  report.previous = { pid: previous.pid, version: previous.version, buildId: previous.buildId ?? null };
  report.current = { pid: current.pid, version: current.version, buildId: current.buildId, runtimeRoot: '<current desktop>/dist' };
} catch (error) {
  report.error = String(error);
  console.error(report.error);
} finally {
  if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  try { connection = readConnection(); await rpc(connection, 'shutdown'); } catch {}
  writeFileSync(join(out, 'startup-build-upgrade.json'), JSON.stringify(report, null, 2));
  process.exit(report.error || report.checks.some(c => !c.ok) ? 1 : 0);
}
