import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(process.env.EVE_SMOKE_OUTPUT ?? process.env.SUWEN_SMOKE_OUTPUT ?? join(project, 'release', 'smoke'));
mkdirSync(join(workspace, 'outputs'), {recursive: true});
mkdirSync(join(workspace, 'work'), {recursive: true});

const require = createRequire(join(project, 'package.json'));
const {_electron} = require('playwright-core');
const {rpc} = await import(pathToFileURL(join(project, 'dist/src/rpc.js')).href);
const {readConnection} = await import(pathToFileURL(join(project, 'dist/src/security.js')).href);

const profile = join(workspace, 'work', `electron-e2e-profile-${Date.now()}`);
mkdirSync(profile, {recursive: true});
// app.close() bypasses the product's ask/background UI in automation.
writeFileSync(join(profile, 'desktop-window.json'), JSON.stringify({closeAction: 'quit'}));

const fixtureRequests = [];
const fixture = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.endsWith('/models') && req.method === 'GET') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({data: [{id: 'local-protocol-fixture'}]}));
    return;
  }
  assert.match(url.pathname, /\/chat\/completions$/);
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  fixtureRequests.push({path: url.pathname, bytes: body.length});
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.write('data: ' + JSON.stringify({
    choices: [{delta: {role: 'assistant', content: '这是一条本地模拟服务的界面验收响应。\n\n'}}],
  }) + '\n\n');
  const timer = setTimeout(() => {
    res.write('data: ' + JSON.stringify({
      choices: [{delta: {content: '已验证流式显示、任务持久化与执行记录；这不是科研结论。'}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 100, completion_tokens: 50},
    }) + '\n\n');
    res.end('data: [DONE]\n\n');
  }, 250);
  res.on('close', () => clearTimeout(timer));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

const env = {...process.env, EVE_TEST_HOME: profile, SUWEN_TEST_HOME: profile};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.SUWEN_SMOKE_PACKAGED === '1' || process.env.EVE_SMOKE_PACKAGED === '1';
const executablePath = packaged
  ? join(project, 'release', 'win-unpacked', 'Eve.exe')
  : join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
const launchArgs = packaged ? [] : [project];

let app;
let connection;
let appProcessHandle = null;
const log = {
  modelProtocol: 'local HTTP fixture only; no external model account',
  renderer: 'single hosted workbench',
  checks: [],
};

async function waitForProcessExit(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (handle.exitCode === null && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return handle.exitCode;
}

function forceStopElectron(handle) {
  if (!handle?.pid || handle.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(handle.pid), '/F'], {stdio: 'ignore'});
    } catch (error) {
      // The app can exit between the timeout and taskkill. Treat only that
      // already-stopped race as success; a live process remains a failure.
      let alive = true;
      try {
        process.kill(handle.pid, 0);
      } catch (probeError) {
        alive = probeError.code !== 'ESRCH';
      }
      if (alive) throw error;
    }
  } else {
    handle.kill('SIGKILL');
  }
}

function forceStopPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], {stdio: 'ignore'});
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already stopped */
  }
}

async function boundedCleanup(label, task, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise(resolveWait => {
    timer = setTimeout(() => {
      log.cleanupTimeouts ??= [];
      log.cleanupTimeouts.push(label);
      resolveWait(false);
    }, timeoutMs);
  });
  try {
    const completed = Promise.resolve().then(task).then(
      () => true,
      error => {
        log.cleanupErrors ??= [];
        log.cleanupErrors.push(`${label}: ${error.message}`);
        return false;
      },
    );
    return await Promise.race([completed, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHostedUi(page, timeout = 120000) {
  await page.waitForFunction(
    () => document.documentElement.dataset.ready === 'true' && Boolean(document.querySelector('#app-shell')),
    null,
    {timeout},
  );
  const shell = await page.evaluate(() => ({
    title: document.title,
    routes: document.querySelectorAll('[data-route]').length,
    routeNames: [...document.querySelectorAll('[data-route]')].map(node => node.getAttribute('data-route')),
    legacyPreloadBridge: typeof window.suwen,
    desktopBridge: Boolean(window.suwenDesktop),
    legacyHealth: Boolean(document.querySelector('#health')),
    legacyTimeline: Boolean(document.querySelector('#timeline')),
    bodyRoute: document.body.dataset.route || '',
  }));
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/);
  assert.match(shell.title, /Eve/);
  assert.ok(shell.routes >= 8, `expected hosted navigation, got ${shell.routes} routes`);
  assert.equal(shell.legacyPreloadBridge, 'undefined');
  assert.equal(shell.desktopBridge, true);
  assert.equal(shell.legacyHealth, false);
  assert.equal(shell.legacyTimeline, false);
  return shell;
}

async function dismissOnboarding(page) {
  const modal = page.locator('.modal-backdrop');
  if (!(await modal.count())) return false;
  const close = modal.locator('.modal-close').first();
  if (await close.count()) await close.click();
  await modal.waitFor({state: 'detached', timeout: 5000});
  return true;
}

function authorizedFetch(origin, token, path, init = {}) {
  return fetch(origin + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function waitTask(taskId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    const snapshot = await rpc(connection, 'snapshot');
    task = snapshot.tasks.find(candidate => candidate.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label}: ${JSON.stringify(task?.steps?.map(step => ({id: step.id, status: step.status, error: step.error})) ?? null)}`);
}

try {
  app = await _electron.launch({executablePath, args: launchArgs, env, timeout: 30000});
  let page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const initialShell = await waitForHostedUi(page);
  appProcessHandle = app.process();
  assert.equal(app.windows().length, 1, 'only the hosted workbench window may open');
  log.checks.push('normal launch opens only the hosted Eve workbench');
  log.shell = initialShell;

  connection = readConnection(join(profile, 'runtime'));
  assert.ok(connection, 'detached daemon connection');
  const bridge = await rpc(connection, 'legacyStart', {});
  const origin = new URL(page.url()).origin;
  assert.equal(origin, `http://127.0.0.1:${bridge.port}`);
  log.daemonPid = connection.pid;
  log.workbenchPort = bridge.port;

  const onboarding = await dismissOnboarding(page);
  assert.equal(onboarding, true, 'first-run model prompt is presented');
  log.checks.push('first-run prompt is contained in the hosted renderer');

  const saveResponse = await authorizedFetch(origin, bridge.token, '/api/settings/keys', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom_openai',
      model: 'local-protocol-fixture',
      api_base: `${fixtureOrigin}/v1`,
      key: 'fixture-only-not-a-real-secret',
      models: ['local-protocol-fixture'],
      activate: true,
    }),
  });
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200, JSON.stringify(saved));
  assert.equal(saved.ok, true);
  assert.equal(saved.llm?.configured, true);
  log.checks.push('hosted settings save provider, model and encrypted credential');

  const testResponse = await authorizedFetch(origin, bridge.token, '/api/settings/test_llm', {
    method: 'POST',
    body: '{}',
  });
  const tested = await testResponse.json();
  assert.equal(testResponse.status, 200, JSON.stringify(tested));
  assert.equal(tested.ok, true, JSON.stringify(tested));
  log.checks.push('hosted settings test the real configured HTTP protocol');

  await page.evaluate(() => { location.hash = '#/workbench'; });
  await page.waitForFunction(
    () => Boolean(document.querySelector('.chat-view[data-ready="true"] #chat-input')),
    null,
    {timeout: 60000},
  );
  await page.locator('#chat-input').fill('界面验收：请明确标注这是一条本地模拟服务响应。');
  await page.locator('#send-btn').click();
  await page.waitForFunction(
    () => document.querySelector('#messages')?.textContent?.includes('这不是科研结论。'),
    null,
    {timeout: 180000},
  );
  await page.waitForFunction(
    () => document.querySelector('#send-btn')?.disabled === false,
    null,
    {timeout: 60000},
  );
  assert.ok(fixtureRequests.length >= 1);
  log.checks.push('hosted chat streamed through the unified daemon harness');
  await page.screenshot({path: join(workspace, 'outputs', 'Eve-hosted-workbench.png'), fullPage: true});

  const demoTask = await rpc(connection, 'create', {
    name: '后台恢复演示',
    steps: [
      {id: 'start', kind: 'echo', input: 'committed-before-ui-exit'},
      {id: 'timer', kind: 'delay', input: {ms: 30000}, dependsOn: ['start']},
      {id: 'finish', kind: 'echo', input: 'completed-after-reopen', dependsOn: ['timer']},
    ],
  });
  await waitTask(demoTask.id, task => task.steps.find(step => step.id === 'start')?.status === 'completed', 10000, 'timer task did not start');

  const processHandle = app.process();
  await Promise.race([
    app.evaluate(({app}) => app.exit(0)).catch(() => {}),
    new Promise(resolveWait => setTimeout(resolveWait, 3000)),
  ]);
  app = null;
  let exitCode = await waitForProcessExit(processHandle, 15000);
  if (exitCode === null) {
    forceStopElectron(processHandle);
    exitCode = await waitForProcessExit(processHandle, 5000);
  }
  assert.notEqual(exitCode, null, 'Electron launcher did not exit');
  assert.equal((await rpc(connection, 'health')).pid, connection.pid);
  appProcessHandle = null;
  log.checks.push('forced UI exit leaves the detached daemon running');

  const completed = await waitTask(demoTask.id, task => task.status === 'completed', 45000, 'durable timer did not complete');
  assert.equal(completed.steps.find(step => step.id === 'start')?.attempts, 1);
  log.checks.push('durable timer completed once after the renderer exited');

  app = await _electron.launch({executablePath, args: launchArgs, env, timeout: 30000});
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  const reopenedShell = await waitForHostedUi(page);
  assert.equal(app.windows().length, 1);
  assert.equal(readConnection(join(profile, 'runtime')).pid, connection.pid);
  assert.equal(reopenedShell.legacyHealth, false);
  log.checks.push('reopen attaches to the same daemon and the single hosted renderer');

  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForFunction(() => document.body.dataset.route === 'dashboard' && Boolean(document.querySelector('.dashboard-page, .dashboard-project, #app-shell')), null, {timeout: 60000});
  await page.screenshot({path: join(workspace, 'outputs', 'Eve-dashboard.png'), fullPage: true});
  log.checks.push('dashboard route renders after relaunch');

  if (process.env.SUWEN_SMOKE_LIVE === '1' || process.env.EVE_SMOKE_LIVE === '1') {
    const databaseTask = await rpc(connection, 'create', {
      name: 'Packaged live MCP public database QA',
      steps: [
        {id: 'literature', kind: 'pubmed', input: {query: 'TP53 cancer'}, timeoutMs: 30000, maxAttempts: 1},
        {id: 'protein', kind: 'uniprot', input: {query: 'gene:TP53 AND organism_id:9606'}, timeoutMs: 30000, maxAttempts: 1},
      ],
    });
    const databaseResult = await waitTask(
      databaseTask.id,
      task => ['completed', 'failed', 'waiting_approval'].includes(task.status),
      35000,
      'live MCP task did not finish',
    );
    assert.equal(databaseResult.status, 'completed', JSON.stringify(databaseResult.steps.map(step => ({kind: step.kind, error: step.error}))));
    assert.ok(databaseResult.steps.every(step => step.output?.results?.length > 0));
    writeFileSync(join(workspace, 'work', 'packaged-live-mcp-results.json'), JSON.stringify(databaseResult, null, 2));
    log.checks.push('live readonly PubMed and UniProt searches completed');
  } else {
    log.liveMcp = 'skipped: EVE_SMOKE_LIVE is unset';
  }

  const pythonTask = await rpc(connection, 'create', {
    name: 'Packaged Python research-worker sandbox QA',
    steps: [{
      id: 'stats',
      kind: 'python',
      input: {language: 'python', source: 'import statistics; print(statistics.mean([2,4,4,6,9]))'},
      timeoutMs: 30000,
      maxAttempts: 1,
    }],
  });
  const pythonResult = await waitTask(
    pythonTask.id,
    task => ['completed', 'failed'].includes(task.status),
    45000,
    'Python worker task did not finish',
  );
  assert.equal(pythonResult.status, 'completed', JSON.stringify(pythonResult.steps.map(step => ({kind: step.kind, error: step.error}))));
  const pythonOutput = pythonResult.steps[0].output;
  assert.equal(pythonOutput.exitCode, 0);
  assert.match(String(pythonOutput.stdout), /\b5(\.0)?\b/);
  log.checks.push('Python research worker ran a sandboxed stdlib script');

  assert.deepEqual(pageErrors, []);
  log.runtimeVersions = (await rpc(connection, 'health')).runtimeVersions;
  log.packaged = packaged;
  log.fixtureRequests = fixtureRequests.length;
  log.result = 'passed';
} catch (error) {
  log.result = 'failed';
  log.error = error.message;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (appProcessHandle) {
    try {
      forceStopElectron(appProcessHandle);
    } catch {
      /* already stopped */
    }
  }
  if (connection) {
    const stopped = await boundedCleanup('daemon shutdown', () => rpc(connection, 'shutdown'));
    if (!stopped) forceStopPid(connection.pid);
  }
  if (app) {
    const handle = app.process();
    const closed = await boundedCleanup('Electron close', () => app.close());
    if (!closed) forceStopElectron(handle);
  }
  fixture.closeAllConnections();
  await boundedCleanup('fixture server close', () => new Promise(resolveWait => fixture.close(resolveWait)), 3000);
  writeFileSync(join(workspace, 'work', 'electron-e2e-result.json'), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log, null, 2));
  setTimeout(() => process.exit(log.result === 'passed' ? 0 : 1), 25);
}
