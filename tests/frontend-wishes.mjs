// Real Edge fixture for the production wish-research view and API client.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const output = fileURLToPath(new URL('../docs/verification/eve-1.0.0-release/', import.meta.url));
const calls = [];
const appearance = {theme: 'light', font: 'system', font_size: 14, accent: '#404040', density: 'comfortable', radius: 12, mode: 'research', home: 'workbench', agent_name: 'Eve', avatar: '', shortcuts: {palette: 'k'}};
const wish = {
  id: 'wish-demo',
  title: '识别耐药相关的细胞状态',
  wish: '找出公开单细胞数据中与耐药相关的细胞状态，并设计能独立验证它的实验。',
  status: 'active',
  scientific_status: 'unverified',
  phase: 'scouting',
  charter: {
    goal: '找出公开单细胞数据中与耐药相关的细胞状态，并设计能独立验证它的实验。',
    boundaries: ['只使用公开且允许重用的数据。', '不可逆外部操作需用户确认。'],
    success_criteria: ['候选细胞状态可在独立数据中复现。', '给出带对照与停止规则的验证方案。'],
    unknowns: ['耐药标签是否可靠。'],
    assumptions: ['原始元数据足以恢复样本分组。'],
    stop_conditions: ['关键数据不可获得。'],
  },
  blockers: [],
  workspace: {
    base: 'research-wishes/wish-demo',
    directories: ['data', 'evidence', 'analysis', 'experiments', 'figures', 'reports', 'provenance']
      .map(name => `research-wishes/wish-demo/${name}`),
  },
  stages: [
    ['charter', '愿望章程', 'recorded', [], '已确认目标、成功判据与停止条件。'],
    ['scouting', '资源侦察', 'pending', ['charter'], null],
    ['evidence_matrix', '证据矩阵', 'pending', ['scouting'], null],
    ['hypotheses', '可证伪假设', 'pending', ['evidence_matrix'], null],
    ['preregistration', '预注册方案', 'pending', ['hypotheses'], null],
    ['analysis', '数据分析', 'pending', ['preregistration'], null],
    ['experiment_design', '实验与独立验证', 'pending', ['preregistration'], null],
    ['figures', '图表与证据整合', 'pending', ['analysis', 'experiment_design'], null],
    ['review', '用户复核', 'needs_review', ['figures'], null],
  ].map(([id, label, status, depends_on, summary]) => ({
    id, label, status, depends_on, summary,
    output: id === 'charter' ? 'charter.md' : `${id}/result.md`,
    purpose: `${label}的可核查产物。`,
    evidence: status === 'recorded' ? [{path: 'research-wishes/wish-demo/charter.md', sha256: 'a'.repeat(64), bytes: 128}] : [],
  })),
  next_actions: [{
    stage: 'scouting', label: '资源侦察', owner: 'agent',
    output: 'research-wishes/wish-demo/evidence/scouting.md',
    reason: '盘点工作区数据、公开资源、文献、工具和可执行环境。',
  }],
};

const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['base', 'components', 'views', 'studio', 'platform', 'workspace-tools'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<style>html,body{height:100%;margin:0}body{display:block}#fixture-shell{height:100%;display:grid;grid-template-rows:44px minmax(0,1fr)}#fixture-shell>header{display:flex;align-items:center;gap:18px;border-bottom:1px solid var(--border);padding:0 24px;font-size:12px;color:var(--text-2)}#fixture-shell>header strong{color:var(--text)}#view{min-height:0;height:100%;overflow:auto}</style>
</head><body><div id="fixture-shell"><header><strong>Eve</strong><span>研究工作区</span><span>科研愿望</span></header><main id="view"></main></div></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = (data, status = 200) => {
      res.writeHead(status, {'content-type': 'application/json;charset=utf-8'});
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/__wish-test') {
      res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
      res.end(fixture);
      return;
    }
    if (url.pathname === '/api/platform/bootstrap') {
      json({settings: {appearance: {value: appearance}}, workspaces: []});
      return;
    }
    if (url.pathname === '/api/platform/wishes' && req.method === 'GET') {
      calls.push({path: url.pathname, method: req.method, scope: url.searchParams.get('scope')});
      json({items: [structuredClone(wish)]});
      return;
    }
    if (url.pathname === '/api/platform/wishes/wish-demo/launch' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      calls.push({path: url.pathname, method: req.method, scope: url.searchParams.get('scope'), body: JSON.parse(raw)});
      json({wish_id: wish.id, session_id: 'session-wish-demo', stage: 'scouting', run: {run_id: 'run-wish-demo'}});
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json({error: {message: `Unexpected fixture endpoint: ${url.pathname}`}}, 404);
      return;
    }
    const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(web, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': target.endsWith('.js') ? 'text/javascript;charset=utf-8'
        : target.endsWith('.css') ? 'text/css;charset=utf-8' : 'application/octet-stream',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});

await mkdir(output, {recursive: true});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  const desktopStarted = performance.now();
  await page.goto(base + '/__wish-test');
  const desktopMountMs = await page.evaluate(async () => {
    const {setState} = await import('/js/store.js?v=1.0.0');
    setState({route: 'research', workspaceId: 'ws_main', workspace: {name: 'Research'}});
    const {mount} = await import('/js/views/platform.js?v=1.0.0');
    const started = performance.now();
    window.platformView = await mount(document.querySelector('#view'));
    return performance.now() - started;
  });
  await page.locator('[data-wish-stage="scouting"]').waitFor();
  const desktopVisibleMs = performance.now() - desktopStarted;
  await page.waitForTimeout(400);

  assert.match(await page.locator('.wish-hero h2').textContent(), /从课题目标到分析、图表与复核/);
  assert.equal(await page.locator('[data-wish-stage]').count(), 9);
  assert.match(await page.locator('[data-wish-stage="figures"] footer').textContent(), /前置：分析、实验/);
  assert.match(await page.locator('[data-wish-stage="charter"] footer').textContent(), /起始节点/);
  assert.match(await page.locator('#view').textContent(), /继续执行下一阶段/);
  assert.doesNotMatch(await page.locator('#view').textContent(), /"stages"\s*:/);
  assert.doesNotMatch(await page.locator('#view').textContent(), /"run_id"\s*:/);
  await page.locator('.wish-hero').screenshot({path: path.join(output, 'wish-hero-element.png')});
  await page.screenshot({path: path.join(output, 'wish-research-desktop.png'), animations: 'disabled'});

  await page.getByRole('button', {name: '继续执行下一阶段'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /遇到阻塞、审批或人工复核时停止/);
  await dialog.getByRole('button', {name: '继续', exact: true}).click();
  await page.waitForFunction(() => location.hash === '#/workbench');
  assert.deepEqual(calls.find(call => call.method === 'POST').body, {stage: 'scouting', advance: true});
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('omicslab.activeConversationId'))), 'session-wish-demo');

  const mobileStarted = performance.now();
  await page.goto(base + '/__wish-test');
  const mobileMountMs = await page.evaluate(async () => {
    const {setState} = await import('/js/store.js?v=1.0.0');
    setState({route: 'research', workspaceId: 'ws_main', workspace: {name: 'Research'}});
    const {mount} = await import('/js/views/platform.js?v=1.0.0');
    const started = performance.now();
    window.platformView = await mount(document.querySelector('#view'));
    return performance.now() - started;
  });
  await page.locator('[data-wish-stage="scouting"]').waitFor();
  const mobileVisibleMs = performance.now() - mobileStarted;
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.wish-detail').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.getByRole('button', {name: '继续执行下一阶段'}).evaluate(node => node.getBoundingClientRect().height >= 32), true);
  await page.screenshot({path: path.join(output, 'wish-research-mobile.png'), animations: 'disabled'});
  assert.deepEqual(errors, []);
  const browserMetrics = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    return {
      domNodes: document.getElementsByTagName('*').length,
      resourceEntries: resources.length,
      resourceEncodedBytes: resources.reduce((total, entry) => total + (entry.encodedBodySize || 0), 0),
    };
  });

  await writeFile(path.join(output, 'wish-browser-results.json'), JSON.stringify({
    browser: await browser.version(),
    checks: ['desktop render', 'stage dependencies', 'no raw JSON', 'launch payload', 'conversation selection', 'mobile overflow'],
    timings: {
      desktopMountMs: Math.round(desktopMountMs * 100) / 100,
      desktopVisibleMs: Math.round(desktopVisibleMs * 100) / 100,
      mobileMountMs: Math.round(mobileMountMs * 100) / 100,
      mobileVisibleMs: Math.round(mobileVisibleMs * 100) / 100,
      note: 'Local loopback fixture and in-process API response; this does not include model or scientific workload latency.',
    },
    browserMetrics,
    calls,
    errors,
  }, null, 2));
  console.log(`Wish UI checks passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
