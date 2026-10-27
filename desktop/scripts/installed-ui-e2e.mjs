/** Inspect an explicitly launched installed app without replacing its user data.
 * Disconnect by exiting this verifier; do not close the user's app or runtime. */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { rpc } = await import('../dist/src/rpc.js');
const endpoint = process.argv.find(arg => arg.startsWith('--endpoint='))?.slice(11);
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('Explicit loopback --endpoint required');
const out = resolve(root, '../docs/verification/eve-1.0');
mkdirSync(out, { recursive: true });
const report = { kind: 'installed Windows app, actual existing user profile, read-only UI inspection', checks: [], errors: [] };
const check = (name, ok) => {
  report.checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
try {
  const browser = await chromium.connectOverCDP(endpoint);
  let page;
  const startupDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < startupDeadline) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:'));
    if (page) break;
    const startup = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('data:'));
    if (startup) {
      const message = await startup.locator('#startup-status').textContent({ timeout: 1000 }).catch(() => '');
      if (message.startsWith('工作台启动失败')) throw Error(message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!page) throw Error('Installed formal workbench unavailable');
  await page.waitForSelector('.workbench-page .chat-view #chat-input', { timeout: 30000 });
  page.on('pageerror', error => report.errors.push(error.message));
  const pages = browser.contexts().flatMap(c => c.pages());
  check('only-formal-page-no-diagnostic-console', pages.length === 1 && !pages.some(p => p.url().startsWith('file:')));
  check('default-light-workbench', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
  check('shared-project-and-history-sidebar', await page.locator('.workspace-sidebar .project-files').count() === 1);
  check('single-chat-composer', await page.locator('#chat-input').count() === 1);
  const installRoot = join(process.env.LOCALAPPDATA, 'Programs/Eve');
  const manifest = JSON.parse(readFileSync(join(installRoot, 'resources/app/dist/build-info.json'), 'utf8'));
  const connection = JSON.parse(readFileSync(join(process.env.APPDATA, 'Eve/runtime/connection.json'), 'utf8'));
  const health = await rpc(connection, 'health');
  check('installed-build-serves-current-runtime', health.buildId === manifest.buildId
    && health.runtimeRoot === join(installRoot, 'resources/app/dist'));
  report.version = health.version;
  report.buildId = health.buildId;
  report.workbenchTitle = await page.title();
  await page.screenshot({ path: join(out, 'installed-current-workbench.png') });
  check('no-observed-renderer-errors', report.errors.length === 0);
} catch (error) {
  report.error = String(error);
  console.error(report.error);
} finally {
  writeFileSync(join(out, 'installed-current-ui.json'), JSON.stringify(report, null, 2));
  // CDP is only an inspector connection to a user-owned app.
  process.exit(report.error || report.checks.some(c => !c.ok) ? 1 : 0);
}
