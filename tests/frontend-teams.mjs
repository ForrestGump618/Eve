// Real Edge integration against the production view, store, bus, API client and CSS.
// Run: node --test tests/frontend-teams.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const screenshots = path.resolve(process.env.EVE_TEAMS_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-teams-browser'));
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return {promise, release}; };
const makeTeam = (scope = 'ws_main', overrides = {}) => ({
  id: 'team-research', title: scope === 'ws_main' ? '空间组学证据复核' : '新工作区团队',
  captain_session: 'captain-session', draft: false, archived: false, status: 'running',
  members: [
    {id: 'evidence', name: '证据检索', provider: 'OpenAI', model: 'research-model', goal: '核对空间转录组研究的来源、样本与适用条件。', depends_on: [], task: {status: 'running', nodes: {work: {run_id: 'run-a', session_id: 'session-a'}}}},
    {id: 'methods', name: '方法复核', provider: 'Anthropic', model: 'review-model', goal: '独立检查细胞注释与批次校正，记录不确定性。', depends_on: [], task: {status: 'succeeded', result: '已完成方法清单；仍需核对原始数据。', nodes: {work: {session_id: 'session-b'}}}},
    {id: 'synthesis', name: '汇总验证', provider: 'OpenAI', model: 'research-model', goal: '汇总两位成员的证据，提出可验证的下一步。', depends_on: ['evidence', 'methods'], task: {status: 'queued', nodes: {}}},
  ], ...overrides,
});
const initialMessages = () => [
  {id: 'm1', sender: 'captain', recipient: 'all', content: '请分别检索和复核；汇总前明确标出缺失数据。', created_at: 1793268000, deliveries: [{member: 'evidence', status: 'mailbox_saved'}, {member: 'methods', status: 'mailbox_saved'}]},
  {id: 'm2', sender: 'methods', recipient: 'captain', content: '方法清单已整理，批次效应的判断仍需要原始矩阵。', created_at: 1793268060, deliveries: []},
];
let state;
function reset() {
  state = {teams: {ws_main: [makeTeam()], ws_other: [makeTeam('ws_other')]}, messages: {ws_main: initialMessages(), ws_other: []},
    calls: [], failList: false, failRead: false, failSend: false, listGate: null, readGate: null, sendGate: null, settingsGate: null};
}
reset();
const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['base','components','views','studio','platform','workspace-tools'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<style>html,body{height:100%;margin:0}body{display:block}#fixture-shell{height:100%;display:grid;grid-template-rows:44px minmax(0,1fr)}#fixture-shell>header{display:flex;align-items:center;gap:18px;border-bottom:1px solid var(--border);padding:0 24px;font-size:12px;color:var(--text-2)}#fixture-shell>header strong{color:var(--text)}#view{min-height:0;height:100%;overflow:hidden}</style>
</head><body><div id="fixture-shell"><header><strong>Eve</strong><span>研究工作区</span><span>团队协作</span></header><main id="view"></main></div></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = (data, status = 200) => { res.writeHead(status, {'content-type': 'application/json;charset=utf-8'}); res.end(JSON.stringify(data)); };
    if (url.pathname === '/__teams-test') { res.writeHead(200, {'content-type': 'text/html;charset=utf-8'}); res.end(fixture); return; }
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null, scope = url.searchParams.get('scope') || 'ws_main';
      state.calls.push({path: url.pathname, method: req.method, scope, body});
      if (url.pathname === '/api/settings') {
        const gate = state.settingsGate; if (gate) await gate.promise;
        json({providers: {primary: {id: 'primary', configured: true, label: 'Primary', default_model: 'default-model'}}, llm: {provider: 'primary', model: 'default-model'}}); return;
      }
      if (url.pathname === '/api/teams') {
        if (req.method === 'POST') {
          const team = makeTeam(scope, {...body, id: 'team-created', draft: true, status: 'draft'});
          state.teams[scope].push(team); json(team); return;
        }
        const snapshot = structuredClone((state.teams[scope] || []).filter(team => Boolean(team.archived) === (url.searchParams.get('archived') === 'true')));
        const failed = state.failList, gate = state.listGate; if (gate) await gate.promise;
        json(failed ? {error: {message: '团队列表暂不可用'}} : {items: snapshot}, failed ? 503 : 200); return;
      }
      const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/([^/]+)$/);
      if (match) {
        if (req.method !== 'POST') { json({error: {message: 'POST required'}}, 405); return; }
        const [, id, action] = match;
        const team = (state.teams[scope] || []).find(item => item.id === decodeURIComponent(id));
        if (!team) { json({error: {message: '团队不存在'}}, 404); return; }
        if (action === 'messages') {
          const snapshot = structuredClone(state.messages[scope] || []), failed = state.failRead, gate = state.readGate;
          if (gate) await gate.promise;
          json(failed ? {error: {message: '讨论读取中断'}} : {items: snapshot}, failed ? 503 : 200); return;
        }
        if (action === 'message') {
          const failed = state.failSend, gate = state.sendGate; if (gate) await gate.promise;
          if (failed) { json({error: {message: '下发服务暂不可用'}}, 503); return; }
          const recipients = team.members.filter(member => body.recipient === 'all' || body.recipient === member.id);
          const message = {id: 'm' + state.calls.length, sender: 'user', recipient: body.recipient, content: body.content, created_at: 1793268120,
            deliveries: recipients.map(member => ({member: member.id, status: body.wake && member.task?.status === 'succeeded' ? 'followup_queued' : 'mailbox_saved'}))};
          state.messages[scope].push(message); json(message); return;
        }
        if (action === 'approve') { team.draft = false; team.status = 'queued'; }
        if (action === 'archive') { team.archived = true; team.status = 'archived'; }
        if (action === 'pause') { team.status = 'paused'; team.members.forEach(member => { if (member.task.status === 'running') member.task.status = 'paused'; }); }
        if (action === 'assign') { team.members.find(member => member.id === body.member_id).goal = body.goal; }
        json(team); return;
      }
      json({error: {message: 'Unexpected fixture endpoint'}}, 404); return;
    }
    const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(web, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await readFile(target);
      res.writeHead(200, {'content-type': target.endsWith('.js') ? 'text/javascript;charset=utf-8' : target.endsWith('.css') ? 'text/css;charset=utf-8' : 'application/octet-stream'}); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  } catch (error) { res.writeHead(500); res.end(error.message); }
});

await test('Teams view in real Edge', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1320}});
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = suffix => state.calls.filter(call => call.path.endsWith(suffix));
  const input = () => page.locator('[data-team="team-research"] textarea[name="content"]');
  const submit = () => page.locator('[data-team="team-research"] [type="submit"]');
  const refresh = () => page.locator('#teams-refresh').click();
  async function mount() {
    await page.goto(base + '/__teams-test');
    await page.evaluate(async () => {
      window.store = await import('/js/store.js?v=2.1.1');
      window.bus = await import('/js/bus.js?v=2.1.1');
      window.teams = await import('/js/views/teams.js');
      store.setState({workspaceId: 'ws_main', activeConversationId: 'captain-session'});
      window.view = await teams.mount(document.querySelector('#view'));
    });
    await page.waitForFunction(() => document.querySelector('link[data-team-styles]')?.sheet);
  }
  async function waitMessage(text) { await page.waitForFunction(text => document.querySelector('.team-mailbox')?.textContent.includes(text), text); }
  async function cleanMount() { reset(); await mount(); await waitMessage('方法清单已整理'); }
  try {
    await t.test('captain, compact dependencies, visible discussion and disabled empty send', async () => {
      await cleanMount();
      assert.equal(await page.locator('.team-roster-row').count(), 3);
      assert.match(await page.locator('.team-captain').textContent(), /主会话统筹与汇总/);
      assert.match(await page.locator('[data-member-id="synthesis"] .team-dependency').textContent(), /证据检索、方法复核/);
      assert.equal(await page.locator('.team-discussion').getAttribute('open'), '');
      assert.equal(await submit().isDisabled(), true);
      assert.equal(await page.locator('link[data-team-styles]').count(), 1);
      assert.match(await page.locator('.team-mailbox').textContent(), /队长.*所有成员/s);
      assert.match(await page.locator('.team-deliveries').first().textContent(), /已存入成员信箱/);
      await input().fill('   ');
      assert.equal(await submit().isDisabled(), true);
      await input().fill('');
      await mkdir(screenshots, {recursive: true});
      await page.screenshot({path: path.join(screenshots, 'teams-desktop.png'), fullPage: true});
    });

    await t.test('native keyboard toggle loads on the first opening and retries failed reads', async () => {
      reset(); state.failRead = true; await mount();
      await page.locator('.team-discussion-feedback [role="alert"]').waitFor();
      const summary = page.locator('.team-discussion > summary');
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.team-discussion').getAttribute('open'), null);
      state.failRead = false;
      await page.keyboard.press('Enter');
      await waitMessage('方法清单已整理');
      assert.equal(await summary.evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('.team-discussion-feedback').textContent(), '');
    });

    await t.test('broadcast reaches the REST endpoint once and renders every member receipt', async () => {
      await cleanMount();
      const gate = deferred(); state.sendGate = gate;
      await input().fill('请所有成员核对原始证据，再公开讨论。');
      await page.locator('[name="wake"]').check();
      const sent = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/message'));
      await input().press('Control+Enter'); await sent;
      assert.equal(await submit().isDisabled(), true);
      assert.equal(await input().getAttribute('readonly'), '');
      await input().press('Control+Enter');
      assert.equal(calls('/message').length, 1);
      assert.deepEqual(calls('/message')[0].body, {recipient: 'all', content: '请所有成员核对原始证据，再公开讨论。', wake: true});
      state.sendGate = null; gate.release();
      await waitMessage('请所有成员核对原始证据');
      await page.waitForFunction(() => !document.querySelector('form').matches('[aria-busy="true"]'));
      assert.equal(await input().inputValue(), '');
      const receipt = page.locator('.team-message').last();
      for (const name of ['证据检索', '方法复核', '汇总验证']) assert.match(await receipt.textContent(), new RegExp(name));
      assert.match(await receipt.textContent(), /后续任务已排队/);
      await page.locator('[name="recipient"]').selectOption('evidence');
      await input().fill('仅给检索成员的复核要求'); await submit().click();
      await waitMessage('仅给检索成员的复核要求');
      assert.equal(calls('/message').at(-1).body.recipient, 'evidence');
      assert.equal(state.messages.ws_main.at(-1).deliveries.length, 1);
    });

    await t.test('failed send retains draft, recipient and wake for a successful retry', async () => {
      await cleanMount(); state.failSend = true;
      await page.locator('[name="recipient"]').selectOption('methods');
      await page.locator('[name="wake"]').check();
      await input().fill('这条消息应保留以便重试'); await submit().click();
      await page.locator('.team-discussion-feedback [role="alert"]').waitFor();
      assert.equal(await input().inputValue(), '这条消息应保留以便重试');
      assert.equal(await page.locator('[name="recipient"]').inputValue(), 'methods');
      assert.equal(await page.locator('[name="wake"]').isChecked(), true);
      assert.equal(await submit().isEnabled(), true);
      state.failSend = false; await submit().click(); await waitMessage('这条消息应保留以便重试');
      assert.equal(calls('/message').length, 2);
    });

    await t.test('actual polling preserves focused composer, selection, options and scroll', async () => {
      await cleanMount();
      await input().fill('继续编辑，刷新不应中断这段消息');
      await page.locator('[name="recipient"]').selectOption('methods');
      await page.locator('[name="wake"]').check();
      await input().focus();
      await input().evaluate(node => { window.originalComposer = node; node.setSelectionRange(2, 6); });
      state.teams.ws_main[0].members[0].task.status = 'succeeded';
      state.messages.ws_main.push({id: 'new-poll', sender: 'captain', recipient: 'all', content: '轮询带来的新讨论', created_at: 1793268200});
      await waitMessage('轮询带来的新讨论');
      assert.deepEqual(await input().evaluate(node => ({same: node === window.originalComposer, focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd})), {same: true, focused: true, start: 2, end: 6});
      assert.equal(await input().inputValue(), '继续编辑，刷新不应中断这段消息');
      assert.equal(await page.locator('[name="recipient"]').inputValue(), 'methods');
      assert.equal(await page.locator('[name="wake"]').isChecked(), true);
      assert.match(await page.locator('[data-member-id="evidence"] .team-status').textContent(), /已完成/);
      const log = page.locator('.team-mailbox');
      state.messages.ws_main = Array.from({length: 140}, (_, i) => ({id: 'bulk-' + i, sender: 'user', recipient: 'all', content: `长讨论 ${i} <img src=x onerror="window.injected=true">`, created_at: 1793268200 + i}));
      await refresh(); await waitMessage('长讨论 139');
      assert.equal(await page.locator('.team-message').count(), 100);
      assert.equal(await page.locator('.team-mailbox img').count(), 0);
      await log.evaluate(node => { node.scrollTop = 25; });
      state.messages.ws_main.at(-1).content += ' 更新';
      await refresh(); await waitMessage('139 <img src=x onerror="window.injected=true"> 更新');
      assert.equal(await log.evaluate(node => node.scrollTop), 25);
      await page.locator('.team-discussion > summary').click();
      state.teams.ws_main[0].members[0].task.status = 'running';
      await refresh();
      await page.waitForFunction(() => document.querySelector('[data-member-id="evidence"] .team-status')?.textContent === '运行中');
      assert.equal(await page.locator('.team-discussion').getAttribute('open'), null);
    });

    await t.test('list failure keeps the existing draft and exposes retry', async () => {
      await cleanMount(); await input().fill('列表失败时保留'); state.failList = true;
      await refresh(); await page.locator('[data-retry-list]').waitFor();
      assert.equal(await input().inputValue(), '列表失败时保留');
      state.failList = false; await page.locator('[data-retry-list]').click();
      await page.waitForFunction(() => !document.querySelector('[data-retry-list]'));
      assert.equal(await input().inputValue(), '列表失败时保留');
    });

    await t.test('failed mailbox refresh keeps messages and recovers without resetting the form', async () => {
      await cleanMount(); await input().fill('读取讨论失败也保留输入'); state.failRead = true;
      await page.locator('[data-retry-discussion]').click();
      await page.locator('.team-discussion-feedback [role="alert"]').waitFor();
      assert.match(await page.locator('.team-mailbox').textContent(), /方法清单已整理/);
      assert.equal(await input().inputValue(), '读取讨论失败也保留输入');
      assert.equal(await page.locator('[data-retry-discussion]').isEnabled(), true);
      state.failRead = false; await page.locator('[data-retry-discussion]').click();
      await page.waitForFunction(() => !document.querySelector('.team-discussion-feedback [role="alert"]'));
      assert.equal(await input().inputValue(), '读取讨论失败也保留输入');
    });

    await t.test('send supersedes an older mailbox read, including failed send recovery', async () => {
      await cleanMount(); const gate = deferred(); state.readGate = gate;
      const reading = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/messages'));
      await page.locator('[data-retry-discussion]').click(); await reading;
      state.readGate = null;
      await input().fill('发送必须覆盖较早的读取'); await submit().click();
      await waitMessage('发送必须覆盖较早的读取'); gate.release();
      await page.waitForFunction(() => document.querySelector('.team-mailbox').getAttribute('aria-busy') === 'false');
      assert.match(await page.locator('.team-mailbox').textContent(), /发送必须覆盖较早的读取/);
      const failedGate = deferred(); state.readGate = failedGate;
      const oldRead = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/messages'));
      await page.locator('[data-retry-discussion]').click(); await oldRead;
      state.readGate = null; state.failSend = true;
      await input().fill('失败时刷新讨论仍然可用'); await submit().click();
      await page.locator('.team-discussion-feedback [role="alert"]').waitFor();
      failedGate.release();
      assert.equal(await page.locator('[data-retry-discussion]').isEnabled(), true);
      assert.equal(await input().inputValue(), '失败时刷新讨论仍然可用');
    });

    await t.test('captain navigation persists the selected conversation for the parent view', async () => {
      await cleanMount();
      await page.evaluate(() => { window.selectedSession = null; bus.on('chat:select', id => { selectedSession = id; }); localStorage.setItem('unrelated-preference', 'preserved'); });
      await page.locator('.team-captain [data-session]').click();
      assert.deepEqual(await page.evaluate(async () => ({session: store.getState().activeConversationId, persisted: (await import('/js/util.js?v=2.1.1')).getPref('activeConversationId'), selected: selectedSession, hash: location.hash})),
        {session: 'captain-session', persisted: 'captain-session', selected: 'captain-session', hash: '#/workbench'});
    });

    await t.test('draft and archived discussions stay read-only; approval enables composing', async () => {
      reset(); state.teams.ws_main[0].draft = true; state.teams.ws_main[0].status = 'draft';
      await mount(); await waitMessage('方法清单已整理');
      assert.equal(await input().isDisabled(), true);
      assert.match(await page.locator('.team-readonly').textContent(), /批准方案/);
      await page.locator('[data-team-action="approve"]').click();
      await page.waitForFunction(() => !document.querySelector('form fieldset').disabled);
      assert.equal(await input().isEnabled(), true);
      state.teams.ws_main[0].archived = true; state.teams.ws_main[0].status = 'archived';
      await page.locator('#teams-archive-view').click(); await input().waitFor();
      assert.equal(await input().isDisabled(), true);
      assert.match(await page.locator('.team-readonly').textContent(), /已归档/);
      assert.equal(await page.locator('[data-team-action]').count(), 0);
    });

    await t.test('creation preserves captain, whitespace-separated dependencies and member limits', async () => {
      await cleanMount(); await page.locator('#team-create').click();
      await page.getByRole('dialog', {name: '新建协作团队'}).waitFor();
      const modal = page.getByRole('dialog', {name: '新建协作团队'});
      await modal.locator('[name="goal"]').nth(0).fill('查阅原始证据');
      await modal.locator('[name="goal"]').nth(1).fill('复核并汇总');
      await modal.locator('[name="dependencies"]').nth(1).fill('member1  member1，member1');
      await modal.getByRole('button', {name: '保存方案', exact: true}).click();
      await page.locator('[data-team="team-created"]').waitFor();
      const created = calls('/api/teams').find(call => call.method === 'POST').body;
      assert.equal(created.captain_session, 'captain-session');
      assert.deepEqual(created.members[1].depends_on, ['member1', 'member1', 'member1']);
      await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
      await page.locator('#team-create').click();
      await modal.waitFor();
      for (let i = 0; i < 6; i++) await modal.locator('#team-add-member').click();
      assert.equal(await modal.locator('[data-member]').count(), 8);
      assert.equal(await modal.locator('#team-add-member').isDisabled(), true);
      await modal.locator('[data-remove-member]').last().click();
      assert.equal(await modal.locator('#team-add-member').isEnabled(), true);
      await modal.getByRole('button', {name: '取消', exact: true}).click();
    });

    await t.test('late mailbox and send responses cannot cross workspace boundaries', async () => {
      await cleanMount();
      const gate = deferred(); state.readGate = gate;
      const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/messages'));
      await page.locator('[data-retry-discussion]').click(); await pending;
      state.readGate = null;
      await page.evaluate(() => { store.setState({workspaceId: 'ws_other'}); bus.emit('workspace:change', 'ws_other'); });
      await page.waitForFunction(() => document.querySelector('.team-card-title')?.textContent.includes('新工作区团队'));
      gate.release();
      await page.waitForFunction(() => document.querySelector('.team-empty-discussion'));
      assert.doesNotMatch(await page.locator('#view').textContent(), /方法清单已整理/);
      const sendGate = deferred(); state.sendGate = sendGate;
      await input().fill('只发给旧工作区');
      const sent = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/message'));
      await submit().click(); await sent;
      state.sendGate = null;
      await page.evaluate(() => { store.setState({workspaceId: 'ws_main'}); bus.emit('workspace:change', 'ws_main'); });
      await waitMessage('方法清单已整理'); await input().fill('新工作区的草稿');
      sendGate.release();
      await page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/messages'));
      assert.equal(await input().inputValue(), '新工作区的草稿');
      assert.doesNotMatch(await page.locator('.team-discussion-feedback').textContent(), /消息已保存/);
      assert.equal(calls('/message').at(-1).scope, 'ws_other');
    });

    await t.test('delayed list and settings responses are ignored across A-B-A workspace changes', async () => {
      await cleanMount(); const gate = deferred(); state.listGate = gate;
      state.teams.ws_main[0].title = '过期列表快照';
      const pending = page.waitForRequest(request => new URL(request.url()).pathname === '/api/teams');
      await refresh(); await pending;
      state.listGate = null; state.teams.ws_main[0].title = '最新团队快照';
      await page.evaluate(() => {
        store.setState({workspaceId: 'ws_other'}); bus.emit('workspace:change');
        store.setState({workspaceId: 'ws_main'}); bus.emit('workspace:change');
      });
      await page.waitForFunction(() => document.querySelector('.team-card-title')?.textContent.includes('最新团队快照'));
      gate.release();
      const settingsGate = deferred(); state.settingsGate = settingsGate;
      const settings = page.waitForRequest(request => new URL(request.url()).pathname === '/api/settings');
      await page.locator('#team-create').click(); await settings;
      state.settingsGate = null;
      await page.evaluate(() => { store.setState({workspaceId: 'ws_other'}); bus.emit('workspace:change'); });
      await page.waitForFunction(() => document.querySelector('.team-card-title')?.textContent.includes('新工作区团队'));
      settingsGate.release();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.doesNotMatch(await page.locator('#view').textContent(), /过期列表快照/);
    });

    await t.test('teardown aborts delayed reads, removes listeners and supports remount', async () => {
      await cleanMount(); const gate = deferred(); state.readGate = gate;
      const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/messages'));
      await page.locator('[data-retry-discussion]').click(); await pending;
      await page.evaluate(() => { window.oldRoot = document.querySelector('#view'); window.view.destroy(); oldRoot.innerHTML = '<p id="replacement">另一个页面</p>'; });
      const count = state.calls.length; state.readGate = null; gate.release();
      await page.evaluate(() => { bus.emit('workspace:change', 'ws_main'); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(3250);
      assert.equal(state.calls.length, count, 'no poll or bus subscriptions survive destroy');
      assert.equal(await page.locator('#view').textContent(), '另一个页面');
      await page.evaluate(async () => { window.view = await teams.mount(oldRoot); });
      await waitMessage('方法清单已整理');
      assert.equal(await page.locator('link[data-team-styles]').count(), 1);
    });

    await t.test('mobile, keyboard focus, reduced motion and long content remain usable', async () => {
      await cleanMount();
      await page.setViewportSize({width: 390, height: 844});
      await page.emulateMedia({reducedMotion: 'reduce'});
      state.teams.ws_main[0].title += ' '.repeat(2) + '很长的项目名称'.repeat(8);
      state.teams.ws_main[0].members[0].model = 'long-model-name-'.repeat(20);
      await refresh();
      await page.waitForFunction(() => document.querySelector('.team-card-title h2')?.textContent.length > 40);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.team-view').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await input().focus();
      assert.notEqual(await input().evaluate(node => getComputedStyle(node).outlineStyle), 'none');
      await input().fill('移动端也能广播'); await submit().click(); await waitMessage('移动端也能广播');
      assert.equal(await submit().evaluate(node => node.getBoundingClientRect().height >= 44), true);
      await page.screenshot({path: path.join(screenshots, 'teams-mobile-long.png'), fullPage: true});
      state.teams.ws_main[0] = makeTeam();
      await refresh();
      await page.waitForFunction(() => document.querySelector('.team-card-title h2')?.textContent === '空间组学证据复核');
      await page.locator('.team-view').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({path: path.join(screenshots, 'teams-mobile.png'), fullPage: true});
      await page.locator('.team-discussion').evaluate(node => node.scrollIntoView({block: 'start'}));
      await page.screenshot({path: path.join(screenshots, 'teams-mobile-discussion.png'), fullPage: true});
      for (const width of [320, 768, 980]) {
        await page.setViewportSize({width, height: 900});
        assert.equal(await page.locator('.team-view').evaluate(node => node.scrollWidth <= node.clientWidth), true, `no overflow at ${width}px`);
      }
      await page.setViewportSize({width: 1440, height: 1320});
      await page.emulateMedia({reducedMotion: 'no-preference'});
    });

    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    console.log(`Screenshots: ${screenshots}`);
  } finally {
    for (const key of ['listGate', 'readGate', 'sendGate', 'settingsGate']) state[key]?.release();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
