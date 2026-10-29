// Real settings form in Edge; scoped API fixtures prove saved model/permission values.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/verification/platform-upgrade');
const models = {
  mode: 'balanced', strategy: 'quality', roles: {}, fallbacks: [], context_window: 32000,
  verification: 'standard', sage_verification: false, orchestration: true,
  capabilities: {'research-model': {temperature: 0.7, context_window: 64000, max_output: 8192,
    modalities: ['text', 'image'], token_parameter: 'max_tokens', supported_parameters: ['temperature']}},
};
const permissions = Object.fromEntries(['files', 'shell', 'network', 'agents'].map(key => [key, 'allow']));
permissions.tools = {run_shell: 'ask'};
const calls = [];
const appearance = {theme: 'light', font: 'system', font_size: 14, accent: '#404040', density: 'comfortable', radius: 12, mode: 'research', home: 'workbench', agent_name: 'Eve', avatar: '', shortcuts: {palette: 'k'}};
const bootstrap = {settings: {appearance: {value: appearance}}};
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css"><link rel="stylesheet" href="/css/views.css"><link rel="stylesheet" href="/css/platform.css"></head><body><main id="view"></main><script type="module">window.loadSettings = async (route='settings') => { const {setState} = await import('/js/store.js'); setState({route,workspaceId:'ws_main',workspace:{name:'Research'}}); const {mount} = await import('/js/views/platform.js'); window.unmount = await mount(document.querySelector('#view')); };</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = data => {res.writeHead(200, {'content-type': 'application/json;charset=utf-8'});res.end(JSON.stringify(data));};
    if (url.pathname === '/__settings') {res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});res.end(html);return;}
    if (url.pathname === '/favicon.ico') {res.writeHead(204);res.end();return;}
    if (url.pathname === '/api/platform/config/models') {
      if (req.method === 'PUT') {let body='';for await(const chunk of req)body+=chunk;calls.push({section:'models',body:JSON.parse(body)});Object.assign(models,JSON.parse(body).value);}
      json({value: models});return;
    }
    if (url.pathname === '/api/platform/config/permissions') {
      if (req.method === 'PUT') {let body='';for await(const chunk of req)body+=chunk;calls.push({section:'permissions',body:JSON.parse(body)});Object.assign(permissions,JSON.parse(body).value);}
      json({value: permissions});return;
    }
    if (url.pathname === '/api/platform/bootstrap') {json(bootstrap);return;}
    if (url.pathname === '/api/settings') {json({providers: {},llm: {provider: 'mock',model: 'research-model'}});return;}
    if (url.pathname.startsWith('/api/')) {json({error: {message: 'Unexpected fixture endpoint'}});return;}
    const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    if (path.relative(web, target).startsWith('..')) {res.writeHead(403);res.end();return;}
    const data = await readFile(target);
    res.writeHead(200, {'content-type': target.endsWith('.js') ? 'text/javascript;charset=utf-8' : target.endsWith('.css') ? 'text/css;charset=utf-8' : 'application/octet-stream'});res.end(data);
  } catch (error) {res.writeHead(500);res.end(error.message);}
});

test('model parameters and permission form save real structured values', {timeout: 60000}, async t => {
  await mkdir(output, {recursive: true});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge',headless: true});
  t.after(async () => {await browser.close();await new Promise(resolve => server.close(resolve));});
  const page = await browser.newPage({viewport: {width: 1440,height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/__settings`);
  await page.evaluate(() => window.loadSettings());
  await page.waitForSelector('[data-action="save-models"]');
  await page.evaluate(async () => {
    const {applyAppearance} = await import('/js/suwen.js');
    const data = await (await fetch('/api/platform/bootstrap')).json();
    applyAppearance(data.settings.appearance.value);
  });
  // Let the themed surface transition settle before measuring and capturing.
  await page.waitForTimeout(250);
  const cap = page.locator('[data-cap-model="research-model"]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-cap-model="research-model"] [data-cap-field="temperature"]');
    return input && getComputedStyle(input).backgroundColor === 'rgb(250, 250, 250)';
  });
  assert.equal(await cap.locator('[data-cap-field="temperature"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(250, 250, 250)');
  assert.equal(await cap.locator('[data-cap-field="temperature"]').inputValue(), '0.7');
  assert.equal(await cap.locator('[data-cap-field="context_window"]').inputValue(), '64000');
  await cap.locator('[data-cap-field="temperature"]').fill('0.4');
  await page.locator('#model-verification').selectOption('sage');
  await page.locator('[data-action="save-models"]').click();
  await page.waitForFunction(() => document.querySelector('#model-verification').value === 'sage');
  const savedModel = calls.find(call => call.section === 'models').body.value;
  assert.equal(savedModel.capabilities['research-model'].temperature, 0.4);
  assert.equal(savedModel.verification, 'sage');
  assert.equal(savedModel.orchestration, true);
  await page.screenshot({path: path.join(output,'settings-models-desktop.png'),fullPage: true});

  await page.locator('[data-section="permissions"]').click();
  await page.waitForSelector('[data-action="save-permissions"]');
  assert.equal(await page.locator('#permission-shell').inputValue(), 'allow');
  await page.locator('#permission-shell').selectOption('deny');
  await page.locator('[data-action="permissions-allow-all"]').click();
  assert.equal(await page.locator('#permission-shell').inputValue(), 'allow');
  await page.locator('summary').filter({hasText: '逐工具权限覆盖'}).click();
  await page.locator('[data-tool-permission="run_shell"] select').selectOption('deny');
  await page.locator('[data-action="save-permissions"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="save-permissions"]'));
  const savedPermissions = calls.find(call => call.section === 'permissions').body.value;
  assert.equal(savedPermissions.shell, 'allow');
  assert.equal(savedPermissions.tools.run_shell, 'deny');
  await page.screenshot({path: path.join(output,'settings-permissions-desktop.png'),fullPage: true});
  await page.setViewportSize({width: 390,height: 844});
  await page.screenshot({path: path.join(output,'settings-permissions-mobile.png'),fullPage: true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output,'settings-browser-results.json'),JSON.stringify({browser:await browser.version(),savedModel,savedPermissions,errors,viewport:['1440x1000','390x844']},null,2));
});
