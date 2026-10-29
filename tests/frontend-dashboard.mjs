// Real Edge coverage for the research overview and review-gated reflection UI.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const output = fileURLToPath(new URL('../docs/verification/literature-1.4.0/', import.meta.url));
const calls = [];
const fixtureNow = 1_793_246_400;

const trendDays = Array.from({length: 30}, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 30 + index)).toISOString().slice(0, 10);
  const input = 1200 + index * 90;
  const output = 320 + index * 18;
  const succeeded = 1 + (index % 3);
  const failed = index % 5 === 0 ? 1 : 0;
  const other = index % 7 === 0 ? 1 : 0;
  return {
    date,
    input_tokens: input,
    output_tokens: output,
    tokens: input + output,
    requests: 2 + (index % 6),
    cost: (index + 1) * 0.0013,
    latency_ms: 820 + index * 7,
    runs: succeeded + failed + other,
    succeeded,
    failed,
    other,
    duration_ms: 3600 + index * 125,
  };
});

const dashboard = {
  scope: 'ws_main',
  metrics: {
    active_wishes: 2,
    running_runs: 1,
    pending_insights: 1,
    tokens: 12840,
    total_runs: 42,
    succeeded_runs: 35,
    failed_runs: 4,
    success_rate: 89.7,
    avg_duration_ms: 48200,
    requests: 47,
    avg_latency_ms: 1250,
    cost: 0.042,
    pricing_configured: true,
  },
  brief: {user_actions: 1, agent_actions: 2, blocked_wishes: 1},
  trends: {range_days: 30, days: trendDays},
  plans: [{
    wish_id: 'wish-1',
    wish_title: '验证肿瘤微环境中的因果调控',
    stage: 'evidence_matrix',
    label: '核对证据矩阵',
    owner: 'agent',
    reason: '整理公共数据、文献与项目内证据的对应关系。',
    updated_at: fixtureNow,
  }, {
    wish_id: 'wish-1',
    wish_title: '验证肿瘤微环境中的因果调控',
    stage: 'preregistration',
    label: '确认分析边界',
    owner: 'user',
    reason: '需要补齐样本使用授权。',
    updated_at: fixtureNow,
  }],
  wishes: [{
    id: 'wish-1',
    title: '验证肿瘤微环境中的因果调控',
    status: 'active',
    phase: 'evidence_matrix',
    updated_at: fixtureNow,
    next_action: {label: '核对证据矩阵'},
    blockers_count: 1,
    progress: {
      recorded: 4,
      total: 9,
      percent: 44,
      current_stage: '证据矩阵',
      current_stage_id: 'evidence_matrix',
    },
  }],
  conversations: [{
    id: 'chat-1',
    title: '单细胞数据质量检查',
    message_count: 12,
    updated_at: fixtureNow - 600,
  }],
  runs: [{
    run_id: 'run-1',
    session_id: 'chat-1',
    status: 'running',
    created_at: fixtureNow - 1_200,
    duration_ms: 48200,
    tokens: 12840,
  }],
  insights: [{
    id: 'dream-2',
    kind: 'memory',
    title: '先核对样本过滤规则',
    summary: '多次会话出现相同遗漏，建议在分析前统一检查数据字典。',
  }],
  literature: {
    enabled: true,
    daily_enabled: true,
    today: {papers: 18, deep_read: 4, feed: 3},
    reflections_pending: 2,
    skill_candidates_pending: 1,
    feed_posts: 7,
    proactive: {queued: 2, silent: 1, sent_today: 1},
    last_run: {status: 'completed', selected: 18, deep_read: 4, finished_at: fixtureNow - 900},
  },
  dreaming: {enabled: true, auto: false, last_run: {finished_at: fixtureNow - 1_800}},
};

const dreamStatus = {
  enabled: false,
  auto: false,
  config: {value: {enabled: false, auto: false}, revision: 1},
  pending_count: 2,
  last_run: {
    status: 'completed',
    focus: 'sessions',
    candidate_ids: ['dream-1', 'dream-2'],
    finished_at: fixtureNow - 1_800,
  },
  runs: [{
    status: 'completed',
    focus: 'sessions',
    candidate_ids: ['dream-1', 'dream-2'],
    finished_at: fixtureNow - 1_800,
  }],
  candidates: [{
    id: 'dream-1',
    kind: 'skill',
    title: '差异表达检查清单',
    summary: '把重复出现的检查步骤整理成默认停用的技能草稿。',
    rationale: '当前工作区的多个会话反复执行相同检查。',
    confidence: 0.78,
    evidence: [{kind: 'conversation', label: '既往差异表达会话'}],
    suggested_steps: ['核对分组', '检查批次', '运行敏感性分析'],
  }, {
    id: 'dream-2',
    kind: 'memory',
    title: '记录样本过滤规则',
    summary: '分析开始前先核对样本过滤规则。',
    rationale: '相同遗漏在多个会话中出现。',
    confidence: 0.84,
    evidence: [{kind: 'conversation', label: '既往样本清洗会话'}],
    suggested_steps: ['读取数据字典', '记录过滤依据'],
  }],
};

const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['base', 'components', 'views', 'platform', 'literature'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<style>html,body{height:100%;margin:0}#view{height:100%}</style>
</head><body><main id="view"></main><script type="module">
window.mountDashboard = async () => {
  window.view?.destroy?.();
  const {setState} = await import('/js/store.js?v=1.4.0');
  setState({route:'dashboard',routeParams:{},workspaceId:'ws_main',workspace:{name:'肿瘤微环境项目'}});
  const {mount} = await import('/js/views/dashboard.js');
  window.view = await mount(document.querySelector('#view'));
};
window.mountDreaming = async () => {
  window.view?.destroy?.();
  const {setState} = await import('/js/store.js?v=1.4.0');
  setState({route:'settings',routeParams:{section:'dreaming',candidateId:'dream-2'},workspaceId:'ws_main',workspace:{name:'肿瘤微环境项目'}});
  const {mount} = await import('/js/views/platform.js');
  window.view = await mount(document.querySelector('#view'));
};
</script></body></html>`;

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {'content-type': 'application/json;charset=utf-8'});
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__dashboard') {
      res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
      res.end(fixture);
      return;
    }
    if (url.pathname === '/api/platform/dashboard') {
      jsonResponse(res, dashboard);
      return;
    }
    if (url.pathname === '/api/platform/dreaming' && req.method === 'GET') {
      jsonResponse(res, dreamStatus);
      return;
    }
    if (url.pathname === '/api/platform/dreaming/settings' && req.method === 'PATCH') {
      const body = await readJson(req);
      calls.push({kind: 'settings', body});
      dreamStatus.enabled = Boolean(body.enabled);
      dreamStatus.config.value.enabled = dreamStatus.enabled;
      jsonResponse(res, {ok: true, settings: dreamStatus.config.value, status: dreamStatus});
      return;
    }
    if (url.pathname === '/api/platform/dreaming/run' && req.method === 'POST') {
      const body = await readJson(req);
      calls.push({kind: 'run', body});
      jsonResponse(res, {
        ok: true,
        run: {status: 'completed', summary: '生成 2 条待审候选', candidate_ids: ['dream-1', 'dream-2']},
        status: dreamStatus,
      });
      return;
    }
    if (url.pathname.endsWith('/accept') && req.method === 'POST') {
      const body = await readJson(req);
      calls.push({kind: 'accept', path: url.pathname, body});
      jsonResponse(res, {status: 'accepted', accepted_result: {kind: 'memory', id: 'mem-1'}});
      return;
    }
    if (url.pathname.endsWith('/reject') && req.method === 'POST') {
      const body = await readJson(req);
      calls.push({kind: 'reject', path: url.pathname, body});
      jsonResponse(res, {status: 'rejected'});
      return;
    }
    if (url.pathname === '/api/platform/bootstrap') {
      jsonResponse(res, {
        settings: {
          appearance: {value: {theme: 'light', font: 'system', font_size: 14, accent: '#404040', density: 'comfortable', radius: 12, mode: 'research', home: 'dashboard', agent_name: 'Eve', avatar: '', shortcuts: {palette: 'k'}}},
          dreaming: {value: {enabled: false, auto: false}, revision: 1},
        },
        workspaces: [],
      });
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      jsonResponse(res, {error: {message: `Unexpected fixture endpoint: ${url.pathname}`}}, 404);
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
    jsonResponse(res, {error: {message: error.message}}, 500);
  }
});

test('research dashboard and review-gated reflection render without raw JSON', {timeout: 60000}, async t => {
  await mkdir(output, {recursive: true});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  const measurements = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/__dashboard`);
  measurements.desktopMount = await page.evaluate(async () => {
    performance.clearResourceTimings();
    const started = performance.now();
    await window.mountDashboard();
    await new Promise(requestAnimationFrame);
    return {
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      domNodes: document.querySelectorAll('*').length,
      resourceBytes: performance.getEntriesByType('resource').reduce((sum, item) => sum + (item.encodedBodySize || 0), 0),
    };
  });
  await page.waitForSelector('.dashboard-project');

  assert.equal(await page.locator('.dashboard-metric').count(), 4);
  assert.match(await page.locator('.dashboard-projects').innerText(), /验证肿瘤微环境/);
  assert.match(await page.locator('.dashboard-projects').innerText(), /4\/9 个阶段/);
  assert.match(await page.locator('.dashboard-projects').innerText(), /44%/);
  assert.match(await page.locator('.dashboard-plans').innerText(), /核对证据矩阵/);
  assert.match(await page.locator('.dashboard-plans').innerText(), /确认分析边界/);
  assert.match(await page.locator('.dashboard-insights').innerText(), /先核对样本过滤规则/);
  assert.match(await page.locator('.dashboard-literature').innerText(), /今日入库/);
  assert.match(await page.locator('.dashboard-literature').innerText(), /主动分享/);
  assert.equal(await page.locator('.dashboard-chart-point').count(), 7);
  assert.match(await page.locator('.dashboard-chart-summary').innerText(), /Token/);
  measurements.chartSwitchMs = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('[data-dashboard-range="30"]').click();
    await new Promise(requestAnimationFrame);
    return Math.round((performance.now() - started) * 100) / 100;
  });
  assert.equal(await page.locator('.dashboard-chart-point').count(), 30);
  assert.equal(await page.locator('[data-dashboard-range="30"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-dashboard-metric="requests"]').click();
  assert.match(await page.locator('.dashboard-chart-summary').innerText(), /次请求/);
  await page.locator('.dashboard-chart-point').nth(4).focus();
  await page.locator('[data-chart-tooltip]').waitFor();
  assert.match(await page.locator('[data-chart-tooltip]').innerText(), /请求数/);
  assert.ok((await page.locator('[data-chart-tooltip]').innerText()).includes('2026-'));
  assert.equal(await page.locator('pre').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(output, 'dashboard-desktop.png'), fullPage: true});

  await page.locator('.dashboard-project').click();
  assert.equal(await page.evaluate(() => location.hash), '#/research');
  assert.deepEqual(await page.evaluate(async () => {
    const {getState} = await import('/js/store.js?v=1.4.0');
    return getState().routeParams;
  }), {section: 'wishes', wishId: 'wish-1'});

  await page.setViewportSize({width: 390, height: 844});
  measurements.mobileMount = await page.evaluate(async () => {
    performance.clearResourceTimings();
    const started = performance.now();
    await window.mountDashboard();
    await new Promise(requestAnimationFrame);
    return {
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      domNodes: document.querySelectorAll('*').length,
      resourceBytes: performance.getEntriesByType('resource').reduce((sum, item) => sum + (item.encodedBodySize || 0), 0),
    };
  });
  await page.waitForSelector('.dashboard-project');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('[data-dashboard-metric="requests"]').evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  assert.equal(await page.evaluate(() => {
    const page = document.querySelector('.dashboard-page');
    return page.scrollHeight > page.clientHeight;
  }), true);
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(output, 'dashboard-mobile.png'), fullPage: true});
  await page.locator('.dashboard-plans').evaluate(node => node.scrollIntoView({block: 'start'}));
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => {
    const page = document.querySelector('.dashboard-page');
    return page.scrollTop > 0;
  }), true);
  assert.equal(await page.locator('.dashboard-plans').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.top < innerHeight && rect.bottom > 0;
  }), true);
  await page.screenshot({path: path.join(output, 'dashboard-mobile-plans.png')});

  await page.setViewportSize({width: 1440, height: 1000});
  await page.evaluate(() => window.mountDreaming());
  await page.waitForSelector('[data-candidate-id="dream-2"]');
  assert.equal(await page.locator('.sw-dream-candidate').count(), 2);
  assert.equal(await page.locator('[data-candidate-id="dream-2"]').evaluate(node => node.classList.contains('is-focus')), true);
  assert.equal(await page.locator('pre').count(), 0);
  assert.match(await page.locator('[data-candidate-id="dream-1"]').innerText(), /差异表达检查清单/);

  await page.locator('#dream-enabled').check();
  await page.locator('[data-action="dream-save"]').click();
  await page.waitForFunction(() => document.querySelector('#dream-enabled')?.checked);
  assert.deepEqual(calls.find(call => call.kind === 'settings').body, {enabled: true});

  await page.locator('[data-action="dream-run"]').click();
  const runDialog = page.getByRole('dialog', {name: '整理历史记录'});
  await runDialog.waitFor();
  await runDialog.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => document.querySelector('[data-action="dream-run"]'));
  assert.equal(calls.find(call => call.kind === 'run').body.focus, 'all');

  await page.locator('[data-candidate-id="dream-2"] [data-action="dream-accept"]').click();
  const acceptDialog = page.getByRole('dialog', {name: '采纳经验建议'});
  await acceptDialog.waitFor();
  await acceptDialog.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
  const accepted = calls.find(call => call.kind === 'accept');
  assert.match(accepted.path, /dream-2\/accept$/);
  assert.equal(accepted.body.confirmed, true);
  await page.screenshot({path: path.join(output, 'dreaming-settings-desktop.png'), fullPage: true});

  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => window.mountDreaming());
  await page.waitForSelector('[data-candidate-id="dream-2"]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: path.join(output, 'dreaming-settings-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);

  await writeFile(path.join(output, 'dashboard-browser-results.json'), JSON.stringify({
    browser: await browser.version(),
    checks: [
      'dashboard metrics, projects, runs and insights render',
      '7/30 day range and metric switches update the interactive chart',
      'chart points expose keyboard focus, labels and tooltips',
      'wish progress and upcoming plans are summarized without raw JSON',
      'dashboard route links preserve existing workflows',
      'desktop and mobile contain no page-level overflow',
      'mobile metric controls remain readable and the internal scroll reaches project plans',
      'dreaming section opens from route parameters',
      'reflection opt-in and manual run save real structured values',
      'candidate acceptance requires explicit confirmation',
      'no raw JSON or executable output is exposed',
    ],
    calls,
    errors,
    measurements,
    viewports: ['1440x1000', '390x844'],
  }, null, 2));
  console.log(`Dashboard and reflection checks passed; screenshots: ${output}`);
});
