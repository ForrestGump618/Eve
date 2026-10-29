// Sidebar child agents + no raw JSON in the chat composer / markdown flow.
// Run: node --test tests/frontend-agents.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

const makeTeam = (draft = true) => ({
  id: 'team-research', title: '空间组学证据复核', captain_session: 'captain-session',
  draft, archived: false, status: draft ? 'draft' : 'running',
  members: [
    {id: 'evidence', name: '证据检索', provider: 'OpenAI', model: 'research-model',
     goal: '核对空间转录组研究的来源、样本与适用条件。', depends_on: [],
     task: {status: draft ? 'missing' : 'running', nodes: {work: {session_id: 'session-a'}}}},
    {id: 'methods', name: '方法复核', provider: 'Anthropic', model: 'review-model',
     goal: '独立检查细胞注释与批次校正。', depends_on: [],
     task: {status: draft ? 'missing' : 'succeeded', nodes: {work: {session_id: 'session-b'}}}},
  ],
});
let state = {team: makeTeam(true), calls: []};
const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/views.css"><link rel="stylesheet" href="/css/workspace-tools.css">
</head><body>
<aside id="app-sidebar" class="workspace-sidebar">
  <section class="sidebar-conv"><div class="sidebar-section-label"><span>会话</span></div><div id="conv-list"></div></section>
  <section class="project-files"></section>
</aside>
<main id="view"></main>
<script type="module">
  window.runAgents = async () => {
    const {mountAgentsPanel} = await import('/js/agents-panel.js?v=1.0.0');
    window.opened = [];
    window.panel = await mountAgentsPanel(document.querySelector('#app-sidebar'), {
      getContext: () => ({conversationId: 'captain-session', scope: 'ws_main'}),
      onSelectConversation: (id) => window.opened.push(id),
    });
  };
  window.renderBlock = async (text) => {
    const {renderMarkdown} = await import('/js/markdown.js?v=2.1.1');
    document.querySelector('#view').innerHTML = renderMarkdown(text);
  };
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = (data, status = 200) => { res.writeHead(status, {'content-type': 'application/json;charset=utf-8'}); res.end(JSON.stringify(data)); };
    if (url.pathname === '/__agents-test') { res.writeHead(200, {'content-type': 'text/html;charset=utf-8'}); res.end(fixture); return; }
    if (url.pathname === '/api/teams') {
      state.calls.push({path: url.pathname, query: url.search});
      json({items: state.team ? [JSON.parse(JSON.stringify(state.team))] : []});
      return;
    }
    const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/approve$/);
    if (match && req.method === 'POST') {
      state.calls.push({path: url.pathname, query: url.search});
      if (state.team) { state.team.draft = false; state.team.status = 'queued'; }
      json(state.team || {});
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname.startsWith('/api/')) { json({error: {message: 'unexpected'}}, 404); return; }
    const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(web, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(target);
    res.writeHead(200, {'content-type': target.endsWith('.js') ? 'text/javascript;charset=utf-8' : target.endsWith('.css') ? 'text/css;charset=utf-8' : 'application/octet-stream'});
    res.end(data);
  } catch (error) {
    res.writeHead(500); res.end(error.message);
  }
});

test('agent sidebar, approval and conversation opening in real Edge', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('draft team shows pending card and approve starts members', async () => {
    await page.goto(base + '/__agents-test');
    await page.evaluate(() => window.runAgents());
    await page.waitForFunction(() => document.querySelector('#sidebar-agents') && !document.querySelector('#sidebar-agents').hidden)
      .catch(async (error) => { throw new Error(`${error.message}\nBrowser errors: ${errors.join(' | ')}\nCalls: ${JSON.stringify(state.calls)}\nPanel: ${await page.locator('#app-sidebar').innerHTML()}`); });
    assert.match(await page.locator('#sidebar-agents').textContent(), /待批准方案/);
    assert.equal(await page.locator('.sidebar-agent-row').count(), 2);
    await page.locator('[data-approve="team-research"]').click();
    await page.evaluate(() => window.panel.refresh());
    await page.waitForFunction(() => document.querySelector('#sidebar-agents')?.textContent.includes('协作中'));
    assert.equal(state.team.draft, false);
    assert.ok(state.calls.some((call) => call.path === '/api/teams/team-research/approve'));
  });

  await t.test('member conversation opens and the panel polls', async () => {
    await page.evaluate(() => window.panel.refresh());
    await page.waitForFunction(() => document.querySelector('[data-open="session-a"]'));
    await page.locator('[data-open="session-a"]').click();
    assert.deepEqual(await page.evaluate(() => window.opened), ['session-a']);
  });

  await t.test('markdown json fence renders as summary, not raw JSON', async () => {
    await page.evaluate(() => window.renderBlock('```json\n[{"id":1,"name":"来源A","status":"ok"}]\n```'));
    assert.equal(await page.locator('.json-summary[data-summary-json]').count(), 1);
    assert.match(await page.locator('.json-summary').textContent(), /1 条记录/);
  });

  assert.deepEqual(errors, [], JSON.stringify(state.calls));
});

test('chat composer contract hides standalone team entry points', async () => {
  const chat = await readFile(path.join(root, 'omicslab/web/js/views/chat.js'), 'utf8');
  assert.ok(!chat.includes('chat-collaboration-mode'), 'forced collaboration selector must be gone');
  assert.ok(!chat.includes('chat-team-open'), 'standalone team button must be gone');
  assert.ok(chat.includes('chat-agents-open'), 'sidebar child-agent toggle must exist');
  const store = await readFile(path.join(root, 'omicslab/web/js/store.js'), 'utf8');
  assert.match(store, /\{id:'teams',[^}]*hidden:true/);
  const markdown = await readFile(path.join(root, 'omicslab/web/js/markdown.js'), 'utf8');
  assert.match(markdown, /data-summary-json/);
});
