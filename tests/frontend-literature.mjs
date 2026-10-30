// Real Edge coverage for literature search, ingestion, review and proactive sharing.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const output = process.env.EVE_VERIFY_OUTPUT || fileURLToPath(new URL('../docs/verification/eve-1.0.1-release/', import.meta.url));
const calls = [];
const now = 1_793_246_400;
const browserBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
  10080,
]);

const status = {
  enabled: true,
  daily_enabled: true,
  today: {papers: 18, deep_read: 4, feed: 3},
  reflections_pending: 1,
  skill_candidates_pending: 1,
  feed_posts: 3,
  proactive: {queued: 2, silent: 1, sent_today: 0},
  last_run: {
    status: 'completed',
    selected: 18,
    deep_read: 4,
    feed_posts: 3,
    finished_at: now - 600,
    warnings: [],
  },
  settings: {
    sources: {
      pubmed: true,
      medrxiv: true,
      europe_pmc: true,
      openalex: true,
      biorxiv: true,
      arxiv: true,
    },
    min_interestingness: 0.35,
    cross_discipline_weight: 0.25,
  },
};

const paper = {
  id: 'paper-1',
  source: 'europe_pmc',
  source_label: 'Europe PMC',
  title: 'Topological signatures in tumor microenvironment imaging',
  authors: 'A. Researcher, B. Scientist',
  abstract: 'A reproducible study connecting topological data analysis with tissue imaging.',
  published: '2026-10-27',
  venue: 'Nature Methods',
  url: 'https://example.test/paper-1',
  doi: '10.1000/example',
  publication_type: 'research',
  domain: 'cross_disciplinary',
  scores: {interestingness: 0.82, relevance: 0.78, recency: 0.9, cross_disciplinary: 0.74},
  novelty_grounded: 0.71,
  novelty_status: 'grounded',
  prior_art: [{
    title: 'Earlier topological imaging analysis',
    published: '2022-05-01',
    similarity: 0.61,
    doi: '10.1000/prior',
  }],
};

const reflections = [{
  id: 'reflection-1',
  paper_title: paper.title,
  summary: 'Topological persistence features may complement density-based tissue profiling.',
  method_steps: ['Estimate persistence diagrams', 'Compare against matched tissue regions'],
  experiment_ideas: ['Test on a held-out imaging cohort'],
  model_error: '',
  status: 'pending',
  created_at: now - 300,
}];

const candidates = [{
  id: 'candidate-1',
  kind: 'skill',
  title: '拓扑影像检查',
  summary: '把持久同调特征与组织区域匹配整理为待审技能。',
  rationale: '来自当前用户投喂的文献方法；需人工核对适用范围。',
  evidence_refs: ['literature:paper-1'],
  created_at: now - 300,
}];

const feed = [{
  id: 'feed-1',
  literature_id: 'paper-1',
  source: 'europe_pmc',
  title: paper.title,
  url: paper.url,
  note: '值得比较持久同调与密度特征的稳定性。',
  scores: paper.scores,
  comments: [
    {author: 'user', text: '先检查样本批次。', created_at: now - 120},
    {
      author: 'agent',
      text: '同意，但还需要独立队列复核。',
      stance: 'uncertain',
      created_at: now - 100,
    },
  ],
  created_at: now - 600,
}];

let proactive = [
  {
    id: 'message-1',
    title: paper.title,
    body: '这条方法可能帮助当前课题处理组织边界的不稳定性。',
    status: 'queued',
    created_at: now - 400,
    expires_at: now + 3600,
  },
  {
    id: 'message-2',
    title: 'A second grounded paper',
    body: '一篇跨学科方法论文可能与当前假设冲突。',
    status: 'queued',
    created_at: now - 200,
    expires_at: now + 3600,
  },
];

const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['base', 'components', 'views', 'platform', 'literature'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<style>html,body{height:100%;margin:0}#view{min-height:100%}</style>
</head><body><main id="view"></main><script type="module">
window.mountLiterature = async () => {
  window.view?.destroy?.();
  const store = await import('/js/store.js?v=1.0.0');
  window.eveStore = store;
  store.setState({route:'literature',routeParams:{},workspaceId:'ws_main',workspace:{name:'肿瘤微环境项目'}});
  const {mount} = await import('/js/views/literature.js?v=1.0.0');
  window.view = await mount(document.querySelector('#view'));
};
</script></body></html>`;

function json(res, data, statusCode = 200) {
  res.writeHead(statusCode, {'content-type': 'application/json;charset=utf-8'});
  res.end(JSON.stringify(data));
}

async function listenOnBrowserSafePort(server) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 30000 + Math.floor(Math.random() * 30000);
    if (browserBlockedPorts.has(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  throw new Error('could not bind a browser-safe test port');
}

async function bodyText(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__literature') {
      res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
      res.end(fixture);
      return;
    }
    if (url.pathname === '/api/literature/status') {
      json(res, status);
      return;
    }
    if (url.pathname === '/api/literature/feed') {
      json(res, {items: feed});
      return;
    }
    if (url.pathname === '/api/literature/reflections') {
      json(res, {items: reflections});
      return;
    }
    if (url.pathname === '/api/literature/proactive') {
      json(res, {items: proactive, deferred: 0, sent_today: 0});
      return;
    }
    if (url.pathname === '/api/platform/dreaming') {
      json(res, {candidates});
      return;
    }
    if (url.pathname === '/api/literature/search' && req.method === 'POST') {
      const body = JSON.parse(await bodyText(req));
      calls.push({kind: 'search', body});
      const result={
        items: [paper],
        warnings: [],
        sources: {europe_pmc: 1},
        range: {from: body.date_from || '2026-10-01', to: body.date_to || '2026-10-29'},
      };
      status.jobs={search:{job_id:'job-fixture',status:'running'}};
      setTimeout(()=>{status.jobs.search={job_id:'job-fixture',status:'completed',result};},500);
      json(res,status.jobs.search);
      return;
    }
    if (url.pathname === '/api/literature/ingest' && req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '');
      const raw = await bodyText(req);
      calls.push({
        kind: 'ingest',
        contentType,
        body: raw,
      });
      json(res, {
        item: {id: `uploaded-paper-${calls.filter(call => call.kind === 'ingest').length}`,
          title: contentType.startsWith('application/json') ? 'Reference paper' : 'Uploaded PDF'},
        duplicate: false,
        reflection: {id: 'reflection-uploaded'},
        candidate_ids: [],
      });
      return;
    }
    if (url.pathname === '/api/literature/run' && req.method === 'POST') {
      calls.push({kind: 'run', body: JSON.parse(await bodyText(req))});
      json(res, {status: 'completed'});
      return;
    }
    if (url.pathname === '/api/literature/feedback') {
      calls.push({kind: 'feedback', body: JSON.parse(await bodyText(req))});
      json(res, {ok: true});
      return;
    }
    if (url.pathname === '/api/literature/feed/feed-1/comments') {
      const body = JSON.parse(await bodyText(req));
      calls.push({kind: 'comment', body});
      const user = {id: 'comment-user', author: 'user', text: body.text, created_at: now + 1};
      const agent = {
        id: 'comment-agent',
        author: 'agent',
        text: '这个判断需要独立队列验证。',
        stance: 'adjust',
        created_at: now + 2,
      };
      feed[0].comments = [...feed[0].comments, user, agent];
      json(res, {
        comment: user,
        agent_comment: agent,
        stance: 'adjust',
        adjustment_candidate: {id: 'candidate-correction'},
        model_error: '',
      });
      return;
    }
    if (url.pathname === '/api/literature/proactive/message-1/reply') {
      const body = JSON.parse(await bodyText(req));
      calls.push({kind: 'reply', body});
      const user = {id: 'reply-user', author: 'user', text: body.text, created_at: now + 3};
      const agent = {
        id: 'reply-agent',
        author: 'agent',
        text: '接受质疑，我会收窄适用范围。',
        stance: 'adjust',
        created_at: now + 4,
      };
      proactive[0].replies = [...(proactive[0].replies || []), user, agent];
      json(res, {
        reply: user,
        agent_reply: agent,
        stance: 'adjust',
        adjustment_candidate: {id: 'candidate-reply'},
        model_error: '',
        chat_prompt: '继续讨论。',
      });
      return;
    }
    if (url.pathname === '/api/literature/proactive/message-1/dismiss') {
      calls.push({kind: 'dismiss', body: JSON.parse(await bodyText(req))});
      proactive = proactive.filter(row => row.id !== 'message-1');
      json(res, {ok: true});
      return;
    }
    if (url.pathname === '/api/literature/proactive/message-2/send') {
      calls.push({kind: 'send'});
      json(res, {chat_prompt: '结合当前课题讨论第二篇文献。'});
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json(res, {error: {message: `unexpected fixture endpoint: ${url.pathname}`}}, 404);
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
    json(res, {error: {message: error.message}}, 500);
  }
});

test('literature UI uses typed payloads, persistent upload feedback and responsive layout', {timeout: 90000}, async t => {
  await mkdir(output, {recursive: true});
  const port = await listenOnBrowserSafePort(server);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/__literature`);
  await page.evaluate(() => window.mountLiterature());
  await page.waitForSelector('.lit-page');
  assert.match(await page.locator('.lit-head h1').innerText(), /文献雷达/);
  assert.equal(await page.locator('.lit-tab').count(), 4);
  assert.equal(await page.locator('.lit-metric').count(), 4);
  assert.doesNotMatch(await page.locator('body').innerText(), /\{\s*"/);

  await page.locator('#lit-query').fill('拓扑 组织 影像');
  await page.locator('#lit-search-form button[type="submit"]').click();
  // Detach while running, then remount after the server-owned job completes.
  await page.waitForFunction(()=>document.querySelector('#lit-search-form button[type="submit"]')?.textContent.includes('检索中'));
  await page.evaluate(()=>{window.view.destroy();document.querySelector('#view').replaceChildren();});
  await page.waitForTimeout(650);
  await page.evaluate(()=>window.mountLiterature());
  await page.waitForSelector('.lit-paper');
  const searchCall = calls.find(call => call.kind === 'search');
  assert.ok(searchCall);
  assert.equal(searchCall.body.query, '拓扑 组织 影像');
  assert.equal(searchCall.body.ground_novelty, true);
  assert.equal(searchCall.body.background,true);
  await page.locator('#lit-query').fill('');
  await page.locator('#lit-search-form button[type="submit"]').click();
  await page.waitForTimeout(650);
  await page.evaluate(()=>window.mountLiterature());
  await page.waitForSelector('.lit-paper');
  assert.equal(calls.filter(call=>call.kind==='search').at(-1).body.query,'');
  assert.deepEqual(searchCall.body.sources.sort(), ['arxiv', 'biorxiv', 'europe_pmc', 'medrxiv', 'openalex', 'pubmed']);
  assert.match(await page.locator('.lit-paper').innerText(), /Topological signatures/);
  await page.screenshot({path: path.join(output, 'literature-desktop.png'), fullPage: true});

  await page.locator('[data-lit-action="ingest"]').click();
  await page.waitForSelector('#lit-pdf', {state: 'attached'});
  await page.locator('#lit-pdf').setInputFiles({
    name: 'uploaded-paper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7 fixture'),
  });
  await page.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => document.querySelector('.lit-notice')?.textContent.includes('已加入'));
  assert.match(
    calls.find(call => call.kind === 'ingest').contentType,
    /^multipart\/form-data;/,
  );
  await page.waitForTimeout(250);
  assert.match(await page.locator('.lit-notice').innerText(), /已加入/);
  assert.equal(await page.locator('.lit-tab.is-active').getAttribute('data-lit-tab'), 'pending');
  assert.match(await page.locator('.lit-review-grid').innerText(), /拓扑影像检查/);
  assert.doesNotMatch(await page.locator('body').innerText(), /\{\s*"/);

  await page.locator('[data-lit-action="ingest"]').click();
  await page.waitForSelector('#lit-reference');
  await page.locator('#lit-reference').fill('PMID: 12345678');
  await page.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.lit-notice')].some(node => node.textContent.includes('Reference paper'))
  ));
  const referenceIngest = calls.filter(call => call.kind === 'ingest').at(-1);
  assert.match(referenceIngest.contentType, /^application\/json/);
  assert.equal(JSON.parse(referenceIngest.body).reference, 'PMID: 12345678');

  await page.locator('.lit-tab[data-lit-tab="feed"]').click();
  await page.waitForSelector('.lit-feed-post');
  assert.match(await page.locator('.lit-feed-comments').innerText(), /Eve/);
  await page.locator('.lit-comment-form input').fill('这个结论能外推到所有队列吗？');
  await page.locator('.lit-comment-form button[type="submit"]').click();
  await page.waitForFunction(() => (
    document.querySelectorAll('.lit-feed-comments [data-comment-author="agent"]').length >= 2
  ));
  const commentCall = calls.find(call => call.kind === 'comment');
  assert.equal(commentCall.body.text, '这个结论能外推到所有队列吗？');
  assert.match(await page.locator('.lit-feed-comments').innerText(), /这个判断需要独立队列验证/);

  await page.locator('.lit-tab[data-lit-tab="proactive"]').click();
  await page.waitForSelector('.lit-proactive-card');
  await page.locator('[data-lit-action="reply-message"]').first().click();
  await page.waitForSelector('#lit-discussion-input');
  await page.locator('#lit-discussion-input').fill('现有数据不足以支持这个外推。');
  await page.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => (
    document.querySelectorAll('#lit-discussion-thread .lit-discussion-line').length >= 2
  ));
  const replyCall = calls.find(call => call.kind === 'reply');
  assert.equal(replyCall.body.text, '现有数据不足以支持这个外推。');
  assert.match(await page.locator('#lit-discussion-thread').innerText(), /接受质疑/);
  await page.locator('.modal-foot button').first().click();
  await page.waitForSelector('.modal-body', {state: 'detached'});

  await page.locator('[data-lit-action="dismiss-message"]').first().click();
  await page.locator('.modal-body input').fill('与当前课题无关');
  await page.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => window.__literatureDismissed || document.querySelectorAll('.lit-proactive-card').length === 1);
  const dismissCall = calls.find(call => call.kind === 'dismiss');
  assert.equal(dismissCall.body.reason, '与当前课题无关');

  await page.locator('[data-lit-action="send-message"]').first().click();
  await page.waitForFunction(() => location.hash === '#/workbench');
  const routeState = await page.evaluate(() => ({
    routeParams: window.eveStore.state.routeParams,
    hash: location.hash,
  }));
  assert.equal(routeState.hash, '#/workbench');
  assert.equal(routeState.routeParams.prefill, '结合当前课题讨论第二篇文献。');
  assert.deepEqual(errors, []);

  const mobile = await browser.newPage({viewport: {width: 390, height: 844}});
  const mobileErrors = [];
  mobile.on('pageerror', error => mobileErrors.push(error.message));
  await mobile.goto(`${origin}/__literature`);
  await mobile.evaluate(() => window.mountLiterature());
  await mobile.waitForSelector('.lit-page');
  const measurements = await mobile.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(measurements.scrollWidth <= measurements.viewport + 1, JSON.stringify(measurements));
  assert.ok(measurements.bodyWidth <= measurements.viewport + 1, JSON.stringify(measurements));
  assert.equal(await mobile.locator('.lit-metric').count(), 4);
  await mobile.screenshot({path: path.join(output, 'literature-mobile.png'), fullPage: true});
  assert.deepEqual(mobileErrors, []);
});
