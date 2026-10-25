#!/usr/bin/env node
/**
 * Electron E2E: native "工作台" (workbench) runtime page + hosted legacy web SPA.
 *
 * Deterministic, loopback-only. Launches the development Electron app with a fresh
 * SUWEN_TEST_HOME and the existing managed Python dependency set supplied through
 * SUWEN_WORKBENCH_DEPS (no pip install is ever attempted). The native workbench page
 * must detect the installed runtime, then main's `legacyOpen` bridge starts the real
 * Python legacy server (desktop/worker/legacy_server.py) and opens the real legacy SPA
 * (omicslab/web) in an isolated, Bearer-authenticated window. This script audits that
 * window's shell and all 12 visible routes, capturing screenshots and console errors.
 *
 * Output: desktop/release/workbench-e2e/<stamp>/report.json + screenshots/
 * Usage:  node scripts/workbench-ui-e2e.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(project, '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require('playwright-core');

const ROUTES = [
  { id: 'workbench', label: '工作台' },
  { id: 'chat', label: '对话' },
  { id: 'tasks2', label: '任务中心' },
  { id: 'research', label: '科研与证据' },
  { id: 'knowledge', label: '知识与记忆' },
  { id: 'workflow', label: '工作流' },
  { id: 'artifacts', label: '产物中心' },
  { id: 'extensions', label: '能力中心' },
  { id: 'discovery', label: '发现' },
  { id: 'ssh', label: 'SSH' },
  { id: 'settings', label: '设置' },
  { id: 'diagnostics', label: '系统诊断' },
];
const NATIVE_PAGES = ['chat', 'projects', 'tasks', 'tools', 'settings', 'workbench'];
const GLOBAL_TIMEOUT_MS = 12 * 60 * 1000;

/** Deterministic markdown answer served by the local OpenAI-SSE fixture (KaTeX + Mermaid + table + code). */
const MARKDOWN_TEXT = [
  '## Markdown 升级审计',
  '',
  '行内公式：$E=mc^2$',
  '',
  '块级公式：',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '| 项目 | 结果 | 说明 |',
  '| --- | --- | --- |',
  '| KaTeX | inline | $E=mc^2$ |',
  '| Mermaid | graph | A-->B |',
  '',
  '```js',
  'const audited = true;',
  '```',
].join('\n');

/**
 * Minimal loopback OpenAI-compatible SSE server for deterministic markdown rendering.
 * One assistant message: first chunk, ~900 ms pause (streaming window), remaining chunks,
 * finish_reason + usage, then [DONE].
 */
async function startMarkdownFixture() {
  const state = { startedAt: nowIso(), requests: [], textSha256: createHash('sha256').update(MARKDOWN_TEXT).digest('hex') };
  // First chunk ends inside the Mermaid fence so the streaming window contains a genuinely open
  // construct: closed blocks before it may typeset, the open fence must stay plain text in
  // `.md-stream-tail`, and no diagram may render before completion.
  const fieldStart = MARKDOWN_TEXT.indexOf('```mermaid');
  const firstChunk = fieldStart > 0 ? MARKDOWN_TEXT.slice(0, fieldStart + 10) : MARKDOWN_TEXT.slice(0, 24);
  const rest = MARKDOWN_TEXT.slice(firstChunk.length);
  const pending = new Set();
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !/^\/v1\/chat\/completions/.test(request.url || '')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = null;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find(message => message?.role === 'user');
      state.requests.push({
        at: nowIso(),
        url: request.url,
        model: body?.model ?? null,
        stream: body?.stream === true,
        maxTokens: body?.max_tokens ?? null,
        includeUsage: body?.stream_options?.include_usage === true,
        authorization: request.headers.authorization || null,
        messages: messages.map(message => ({ role: message?.role, contentLen: String(message?.content ?? '').length, contentHead: String(message?.content ?? '').slice(0, 80) })),
        lastUserHead: String(lastUser?.content ?? '').slice(0, 120),
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ id: 'md-fixture', object: 'chat.completion.chunk', model: body?.model ?? 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: firstChunk }, finish_reason: null }] });
      const timer = setTimeout(() => {
        pending.delete(timer);
        send({ id: 'md-fixture', object: 'chat.completion.chunk', model: body?.model ?? 'fixture', choices: [{ index: 0, delta: { content: rest }, finish_reason: null }] });
        send({
          id: 'md-fixture',
          object: 'chat.completion.chunk',
          model: body?.model ?? 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 32, completion_tokens: 220, total_tokens: 252 },
        });
        response.write('data: [DONE]\n\n');
        response.end();
      }, 900);
      pending.add(timer);
      response.on('close', () => {
        clearTimeout(timer);
        pending.delete(timer);
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    port,
    state,
    close: async () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function collectMarkdownDom() {
  const bodies = [...document.querySelectorAll('.message:not(.user) .body.markdown')];
  const last = bodies[bodies.length - 1] ?? null;
  if (!last) return { hasBody: false, counts: {} };
  const count = selector => last.querySelectorAll(selector).length;
  const svgCounts = [...last.querySelectorAll('[data-mermaid][data-md-state="rendered"]')].map(node => node.querySelectorAll('svg').length);
  const renderedMath = [...last.querySelectorAll('[data-math][data-md-state="rendered"]')];
  return {
    hasBody: true,
    counts: {
      bodyTextLen: (last.textContent || '').length,
      mathPlaceholders: count('[data-math]'),
      mathRendered: renderedMath.length,
      displayMath: last.querySelectorAll('[data-math][data-display="1"][data-md-state="rendered"]').length,
      katex: count('.katex'),
      mermaidPlaceholders: count('[data-mermaid]'),
      mermaidRendered: count('[data-mermaid][data-md-state="rendered"]'),
      diagramSvg: count('[data-mermaid][data-md-state="rendered"] .md-diagram-svg svg'),
      diagramSvgPerContainer: svgCounts,
      table: count('table, .md-table'),
      tableScroll: count('.md-table-scroll'),
      codeBlocks: count('.md-code-block'),
      pre: count('pre'),
      failed: count('[data-md-state="failed"]'),
      fallbackText: /not rendered|not supported|LaTeX not rendered|Mermaid not rendered/.test(last.textContent || ''),
      renderedStates: count('[data-md-state="rendered"]'),
    },
  };
}

async function waitForMarkdownDom(page, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      last = await page.evaluate(collectMarkdownDom);
    } catch {
      last = null;
    }
    if (last?.hasBody && last.counts.mathRendered >= 2 && last.counts.diagramSvg >= 1 && last.counts.table >= 1 && last.counts.pre >= 1) return last;
    await sleep(250);
  }
  return last ?? { hasBody: false, counts: {} };
}

/**
 * Native chat markdown audit: deterministic local model fixture returns KaTeX inline/block math,
 * a Mermaid diagram, a table and a code block; assert rendered DOM, no failed placeholders,
 * no duplicate diagram containers after a timeline re-render, and screenshot light+dark.
 */
async function runMarkdownAudit(ctx) {
  const { nativePage, fixture, report, shotsDir, reportDir, check, log } = ctx;
  const audit = (report.native.markdown = report.native.markdown || {});
  audit.fixture = { url: `http://127.0.0.1:${fixture.port}/v1`, endpoint: '/v1/chat/completions', textSha256: fixture.state.textSha256, textLen: MARKDOWN_TEXT.length };
  audit.generatedAt = nowIso();
  const consoleStartIndex = Array.isArray(ctx.nativeConsole) ? ctx.nativeConsole.length : 0;

  let configure = null;
  try {
    configure = await nativePage.evaluate(async baseUrl => {
      try {
        const result = await window.suwen.call('configure', {
          provider: 'openai',
          baseUrl,
          model: 'fixture',
          apiKey: 'fixture',
          contextWindow: 8192,
          maxOutput: 512,
        });
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }, audit.fixture.url);
  } catch (error) {
    configure = { ok: false, error: String(error?.message || error) };
  }
  audit.configure = configure;
  check('native.markdown.configure', configure.ok ? 'PASS' : 'FAIL', configure.ok ? `local fixture ${audit.fixture.url} model=fixture` : String(configure.error).slice(0, 300));
  if (!configure.ok) return;

  await nativePage.locator('[data-page="chat"]').click();
  await sleep(250);
  try {
    await nativePage.locator('#new-chat').click({ timeout: 5000 });
  } catch {
    /* fresh profile may already be on an empty conversation */
  }
  await sleep(250);
  await nativePage.waitForSelector('#prompt', { timeout: 15000 });
  await nativePage.locator('#prompt').fill('E2E Markdown 渲染审计（KaTeX + Mermaid + 表格 + 代码块）');
  const nativeErrorsBefore = ctx.nativeErrorCount();
  await nativePage.locator('#send').click();
  audit.sentAt = nowIso();

  // Round-5 progressive rendering: closed blocks are typeset during the stream, the open tail stays
  // plain text inside `.md-stream-tail`. Partial constructs (open fence/open row/unclosed math/Mermaid)
  // are intentionally not typeset; Mermaid is deferred until the message completes.
  // The fixture holds a ~900 ms streaming window; sample the live DOM fast so the streaming phase is
  // observed rather than guessed (and record why if it is never rendered).
  let streaming = null;
  const streamWatch = { startedAt: nowIso(), samples: 0, seenStreaming: false, firstSeenMs: null, progressiveSeen: false, classes: [], timelineMessages: [], notes: null };
  const watchStart = Date.now();
  let firstStreamingSnapshot = null;
  let lastStreamingSnapshot = null;
  try {
    while (Date.now() - watchStart < 25000) {
      const snap = await nativePage.evaluate(() => {
        const articles = [...document.querySelectorAll('#timeline .message')];
        const streamingArticle = document.querySelector('#timeline .message.streaming');
        const body = streamingArticle?.querySelector('.body');
        const tail = body?.querySelector('.md-stream-tail');
        let taskList = [];
        try {
          taskList = typeof chatTaskList === 'function' ? chatTaskList().map(task => `${task.id}:${task.status}`) : [];
        } catch { taskList = ['!error']; }
        const banner = document.getElementById('stream-banner');
        return {
          at: Date.now(),
          messages: articles.length,
          classes: articles.map(article => article.className),
          streaming: !!streamingArticle,
          bodyClass: body ? body.className : '',
          progressive: !!body && body.classList.contains('progressive'),
          tailPresent: !!tail,
          tailTextLen: tail ? (tail.textContent || '').length : 0,
          textLen: body ? (body.textContent || '').length : 0,
          katex: streamingArticle ? streamingArticle.querySelectorAll('.katex').length : 0,
          tables: streamingArticle ? streamingArticle.querySelectorAll('table, .md-table').length : 0,
          codeBlocks: streamingArticle ? streamingArticle.querySelectorAll('.md-code-block').length : 0,
          diagrams: streamingArticle ? streamingArticle.querySelectorAll('[data-mermaid][data-md-state="rendered"] .md-diagram-svg svg').length : 0,
          banner: banner ? { hidden: banner.hidden, text: (banner.textContent || '').slice(0, 80) } : null,
          conversationId: typeof S !== 'undefined' ? S.conversationId : null,
          selectedTaskId: typeof S !== 'undefined' ? S.selectedTaskId : null,
          conversationTaskList: taskList,
        };
      });
      streamWatch.samples += 1;
      const classesKey = snap.classes.join('|');
      if (!streamWatch.classes.includes(classesKey) || snap.progressive) {
        streamWatch.classes.push(`${classesKey} body=${snap.bodyClass} progressive=${snap.progressive} tail=${snap.tailPresent}`);
        streamWatch.timelineMessages.push({ at: snap.at, messages: snap.messages, classes: snap.classes, bodyClass: snap.bodyClass, progressive: snap.progressive, tailPresent: snap.tailPresent, textLen: snap.textLen, taskList: snap.conversationTaskList });
      }
      if (snap.streaming) {
        if (!streamWatch.seenStreaming) {
          streamWatch.seenStreaming = true;
          streamWatch.firstSeenMs = Date.now() - watchStart;
          firstStreamingSnapshot = snap;
        }
        lastStreamingSnapshot = snap;
        if (snap.progressive && snap.tailPresent) {
          streamWatch.progressiveSeen = true;
          streaming = {
            found: true,
            bodyClass: snap.bodyClass,
            markdownClass: snap.bodyClass.split(/\s+/).includes('markdown'),
            progressiveClass: snap.progressive,
            tailPresent: snap.tailPresent,
            tailTextLen: snap.tailTextLen,
            textLen: snap.textLen,
            katex: snap.katex,
            tables: snap.tables,
            codeBlocks: snap.codeBlocks,
            diagrams: snap.diagrams,
            bannerHidden: snap.banner ? snap.banner.hidden : null,
            bannerText: snap.banner ? snap.banner.text : '',
          };
          const streamingShot = join(shotsDir, 'markdown-streaming.png');
          await nativePage.screenshot({ path: streamingShot });
          streaming.screenshot = relativeTo(reportDir, streamingShot);
          break;
        }
      } else if (streamWatch.seenStreaming && !streaming) {
        /* Stream completed before the progressive patch was observed: keep the last streaming view. */
        const snap2 = lastStreamingSnapshot;
        streaming = {
          found: true,
          bodyClass: snap2.bodyClass,
          markdownClass: snap2.bodyClass.split(/\s+/).includes('markdown'),
          progressiveClass: snap2.progressive,
          tailPresent: snap2.tailPresent,
          tailTextLen: snap2.tailTextLen,
          textLen: snap2.textLen,
          katex: snap2.katex,
          tables: snap2.tables,
          codeBlocks: snap2.codeBlocks,
          diagrams: snap2.diagrams,
          bannerHidden: snap2.banner ? snap2.banner.hidden : null,
          bannerText: snap2.banner ? snap2.banner.text : '',
        };
        break;
      }
      await sleep(120);
    }
    if (!streaming && firstStreamingSnapshot) {
      streaming = {
        found: true,
        bodyClass: firstStreamingSnapshot.bodyClass,
        markdownClass: firstStreamingSnapshot.bodyClass.split(/\s+/).includes('markdown'),
        progressiveClass: firstStreamingSnapshot.progressive,
        tailPresent: firstStreamingSnapshot.tailPresent,
        tailTextLen: firstStreamingSnapshot.tailTextLen,
        textLen: firstStreamingSnapshot.textLen,
        katex: firstStreamingSnapshot.katex,
        tables: firstStreamingSnapshot.tables,
        codeBlocks: firstStreamingSnapshot.codeBlocks,
        diagrams: firstStreamingSnapshot.diagrams,
        bannerHidden: firstStreamingSnapshot.banner ? firstStreamingSnapshot.banner.hidden : null,
        bannerText: firstStreamingSnapshot.banner ? firstStreamingSnapshot.banner.text : '',
      };
    }
    if (!streaming) {
      streamWatch.notes = 'no .message.streaming observed while sampling; see timelineMessages for rendered classes';
      streamWatch.lastTimelineState = await nativePage.evaluate(() => {
        const articles = [...document.querySelectorAll('#timeline .message')];
        const last = articles[articles.length - 1];
        return {
          messages: articles.length,
          lastClass: last ? last.className : null,
          lastTextHead: last ? (last.textContent || '').slice(0, 120) : null,
          conversationId: typeof S !== 'undefined' ? S.conversationId : null,
          selectedTaskId: typeof S !== 'undefined' ? S.selectedTaskId : null,
          taskList: (() => { try { return typeof chatTaskList === 'function' ? chatTaskList().map(task => `${task.id}:${task.status}`) : []; } catch { return ['!error']; } })(),
        };
      });
    }
  } catch (error) {
    streaming = { found: false, error: String(error?.message || error).slice(0, 300) };
  }
  audit.streamingWatch = streamWatch;
  audit.streaming = streaming;
  check(
    'native.markdown.streamingProgressive',
    streaming?.found && streaming.progressiveClass && streaming.tailPresent ? 'PASS' : 'FAIL',
    streaming?.found
      ? `bodyClass="${streaming.bodyClass}" tailPresent=${streaming.tailPresent} tailTextLen=${streaming.tailTextLen} typesetWhileStreaming={katex:${streaming.katex},tables:${streaming.tables},codeBlocks:${streaming.codeBlocks}} firstSeenMs=${streamWatch.firstSeenMs} shot=${streaming.screenshot || ''}`
      : `progressive streaming bubble not observed within 25s (samples=${streamWatch.samples}, timeline=${JSON.stringify((streamWatch.timelineMessages || []).slice(-3))}, last=${JSON.stringify(streamWatch.lastTimelineState || null)})`,
  );
  check(
    'native.markdown.streamingPartialConstructsDeferred',
    streaming?.found && streaming.diagrams === 0 ? 'PASS' : 'FAIL',
    streaming?.found
      ? `diagrams=${streaming.diagrams} tables=${streaming.tables} codeBlocks=${streaming.codeBlocks} (partial constructs are never typeset; Mermaid deferred until completion)`
      : 'streaming bubble not observed',
  );

  await nativePage.waitForFunction(() => document.querySelectorAll('.message:not(.user) .body.markdown').length > 0, null, { timeout: 150000 });
  const before = await waitForMarkdownDom(nativePage, 90000);
  audit.domBefore = before;
  const counts = before.counts || {};
  check('native.markdown.katex', counts.mathRendered >= 2 && counts.katex >= 2 ? 'PASS' : 'FAIL', `renderedMath=${counts.mathRendered} displayMath=${counts.displayMath} katexNodes=${counts.katex}`);
  check('native.markdown.mermaidSvg', counts.mermaidRendered >= 1 && counts.diagramSvg >= 1 && (counts.diagramSvgPerContainer || []).every(value => value === 1) ? 'PASS' : 'FAIL', `renderedDiagrams=${counts.mermaidRendered} svg=${counts.diagramSvg} svgPerContainer=${JSON.stringify(counts.diagramSvgPerContainer)}`);
  check('native.markdown.table', counts.table >= 1 ? 'PASS' : 'FAIL', `tables=${counts.table} tableScroll=${counts.tableScroll}`);
  check('native.markdown.codeBlock', counts.pre >= 1 ? 'PASS' : 'FAIL', `pre=${counts.pre} codeBlocks=${counts.codeBlocks}`);
  check('native.markdown.noFailedPlaceholders', counts.failed === 0 && !counts.fallbackText ? 'PASS' : 'FAIL', `failedPlaceholders=${counts.failed} fallbackText=${counts.fallbackText}`);

  // Theme screenshots (light + dark) with markdown rendered; theme control lives in settings.
  const themeResults = { light: null, dark: null };
  const setNativeTheme = async mode => {
    await nativePage.locator('[data-page="settings"]').click();
    await sleep(250);
    const control = nativePage.locator('#defaults-theme');
    if ((await control.count()) === 0) throw new Error('#defaults-theme not found (theme control missing)');
    await control.selectOption(mode);
    await sleep(500);
    const resolved = await nativePage.evaluate(() => document.documentElement.dataset.theme || '');
    await nativePage.locator('[data-page="chat"]').click();
    await sleep(600);
    return resolved;
  };
  const screenshots = {};
  for (const mode of ['light', 'dark']) {
    try {
      const resolved = await setNativeTheme(mode);
      const dom = await waitForMarkdownDom(nativePage, 60000);
      const shot = join(shotsDir, `markdown-${mode}.png`);
      await nativePage.screenshot({ path: shot });
      screenshots[mode] = relativeTo(reportDir, shot);
      themeResults[mode] = { requested: mode, resolved, dom: dom.counts };
      check(`native.markdown.screenshot.${mode}`, resolved === mode && dom.counts?.katex >= 2 && dom.counts?.diagramSvg >= 1 ? 'PASS' : 'FAIL', `resolvedTheme=${resolved} katex=${dom.counts?.katex} diagramSvg=${dom.counts?.diagramSvg} shot=${relativeTo(reportDir, shot)}`);
    } catch (error) {
      themeResults[mode] = { requested: mode, error: String(error?.message || error).slice(0, 300) };
      check(`native.markdown.screenshot.${mode}`, 'FAIL', String(error?.message || error).slice(0, 300));
    }
  }
  audit.themes = themeResults;
  audit.screenshots = screenshots;

  // Re-render (page switch) must not duplicate diagram/math containers.
  const after = await (async () => {
    await nativePage.locator('[data-page="tasks"]').click();
    await sleep(400);
    await nativePage.locator('[data-page="chat"]').click();
    await sleep(800);
    return waitForMarkdownDom(nativePage, 60000);
  })();
  audit.domAfterRerender = after;
  const cBefore = before.counts || {};
  const cAfter = after.counts || {};
  const stable = cAfter.diagramSvg === cBefore.diagramSvg && cAfter.mermaidRendered === cBefore.mermaidRendered && (cAfter.diagramSvgPerContainer || []).every(value => value === 1) && cAfter.mathRendered >= 2;
  check('native.markdown.noDuplicateContainers', stable ? 'PASS' : 'FAIL', `before: diagrams=${cBefore.mermaidRendered} svgPerContainer=${JSON.stringify(cBefore.diagramSvgPerContainer)}; after: diagrams=${cAfter.mermaidRendered} svgPerContainer=${JSON.stringify(cAfter.diagramSvgPerContainer)}`);

  const newPageErrors = ctx.nativeErrorsSince(nativeErrorsBefore);
  audit.newPageErrors = newPageErrors;
  audit.fixtureRequests = fixture.state.requests;
  audit.fixtureRequestCount = fixture.state.requests.length;
  check('native.markdown.noPageErrors', newPageErrors.length === 0 ? 'PASS' : 'FAIL', newPageErrors.length === 0 ? `0 page errors, ${audit.fixtureRequestCount} fixture request(s)` : newPageErrors.slice(0, 3).join(' | ').slice(0, 300));

  // CSP compatibility: mermaid bakes inline styles into its SVG; the UI CSP is style-src 'self'.
  const markdownConsole = (ctx.nativeConsole || []).slice(consoleStartIndex);
  const consoleErrors = markdownConsole.filter(item => item.type === 'error');
  const cspViolations = consoleErrors.filter(item => /Content Security Policy/i.test(item.text || ''));
  audit.console = {
    total: markdownConsole.length,
    errors: consoleErrors.length,
    cspViolations: cspViolations.length,
    cspSamples: cspViolations.slice(0, 2).map(item => ({ text: item.text.slice(0, 260), url: item.url, line: item.line, phase: item.phase })),
    errorSamples: consoleErrors.filter(item => !/Content Security Policy/i.test(item.text || '')).slice(0, 5).map(item => ({ text: item.text.slice(0, 260), url: item.url, line: item.line })),
  };
  check(
    'native.markdown.noCspViolations',
    cspViolations.length === 0 ? 'PASS' : 'FAIL',
    `${cspViolations.length} CSP violation(s) while rendering markdown/mermaid${cspViolations[0] ? `: ${String(cspViolations[0].text).slice(0, 220)}` : ''}`,
  );
  check(
    'native.markdown.noUnexpectedConsoleErrors',
    audit.console.errorSamples.length === 0 ? 'PASS' : 'FAIL',
    audit.console.errorSamples.length === 0 ? 'no non-CSP console errors' : audit.console.errorSamples.map(item => item.text).join(' | ').slice(0, 300),
  );
  log('markdown', `katex=${cBefore.katex} diagrams=${cBefore.mermaidRendered} tables=${cBefore.table} pre=${cBefore.pre} reqs=${audit.fixtureRequestCount} theme=${JSON.stringify(themeResults.light?.resolved || '?')}->${JSON.stringify(themeResults.dark?.resolved || '?')} cspViolations=${cspViolations.length}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

function log(phase, message) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  console.log(`[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${phase.padEnd(12)} ${message}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function taskkill(pid) {
  if (!pid) return false;
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Deep file inventory for the managed runtime dir (fast enough at ~12k files). */
function dirInventory(dir) {
  let bytes = 0;
  let files = 0;
  const walk = d => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          bytes += statSync(full).size;
          files += 1;
        }
      } catch {
        /* raced */
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function collectProcessesLike(patterns) {
  // Best-effort residual check via WMIC-free PowerShell CIM query.
  try {
    const command =
      "Get-CimInstance Win32_Process | Where-Object { " +
      patterns.map(p => `($_.CommandLine -like '*${p}*')`).join(' -or ') +
      " } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(item => ({ pid: item.ProcessId, name: item.Name, cmd: String(item.CommandLine || '').slice(0, 300) }));
  } catch {
    return [];
  }
}

const fatal = message => {
  console.error(`FATAL ${message}`);
  process.exitCode = 2;
};

async function main() {
  const startedAt = nowIso();
  const startedMs = nowMs();
  const reportDir = join(project, 'release', 'workbench-e2e', stamp());
  const shotsDir = join(reportDir, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });

  const report = {
    schema: 'suwen-workbench-e2e/v1',
    startedAt,
    finishedAt: null,
    durationMs: null,
    environment: {
      host: {
        platform: process.platform,
        hostNode: process.version,
        arch: process.arch,
      },
      electronPackage: null,
      playwrightCore: null,
      appVersion: null,
      runtimeVersions: null,
    },
    runtimeValidation: null,
    profileDir: null,
    native: { checks: [], workbench: null, railButtons: [], pages: [], pageErrors: [], console: [] },
    legacy: { opened: false, checks: [], pageErrors: [], console: [], window: null, shell: null },
    routes: [],
    checks: [],
    cleanup: {},
    limitations: [],
    error: null,
  };

  const check = (id, status, detail) => {
    report.checks.push({ id, status, detail, at: nowIso() });
    log('check', `${String(status).padEnd(7)} ${id}${detail ? ' — ' + detail : ''}`);
  };

  // ---------- environment ----------
  try {
    const os = await import('node:os');
    report.environment.host = {
      platform: process.platform,
      release: os.release(),
      version: os.version ? os.version() : undefined,
      arch: process.arch,
      cpuModel: os.cpus()?.[0]?.model ?? null,
      cpuCores: os.cpus()?.length ?? null,
      totalMemGiB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
      hostNode: process.version,
    };
  } catch {
    /* non-fatal */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    report.environment.appVersion = pkg.version;
    report.environment.electronPackage = pkg.devDependencies?.electron ?? null;
    report.environment.playwrightCore = pkg.devDependencies?.['playwright-core'] ?? null;
  } catch {
    /* non-fatal */
  }

  // ---------- fail-fast runtime validation (no Electron yet) ----------
  const depsDir = process.env.SUWEN_WORKBENCH_DEPS
    ? resolve(process.env.SUWEN_WORKBENCH_DEPS)
    : join(process.env.TEMP || tmpdir(), 'suwen-workbench-smoke');
  const electronExe = join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
  const uiFile = join(project, 'dist', 'ui', 'index.html');
  const mainFile = join(project, 'dist', 'main.js');
  const rpcFile = join(project, 'dist', 'src', 'rpc.js');
  const securityFile = join(project, 'dist', 'src', 'security.js');
  const legacyConfig = join(repoRoot, 'omicslab', 'config.py');
  const markerPath = join(depsDir, '.suwen-workbench.json');

  if (!existsSync(electronExe)) throw new Error(`Electron dev binary missing: ${electronExe}`);
  if (!existsSync(mainFile) || !existsSync(uiFile)) throw new Error('dist build missing; run `npm run build` in desktop/ first');
  if (!existsSync(rpcFile) || !existsSync(securityFile)) throw new Error('dist/src rpc modules missing; run `npm run build` first');
  if (!existsSync(legacyConfig)) throw new Error(`legacy source tree missing: ${legacyConfig}`);
  if (!existsSync(markerPath)) throw new Error(`workbench runtime marker missing: ${markerPath} (set SUWEN_WORKBENCH_DEPS to an installed runtime)`);

  const workbenchModule = await import(pathToFileURL(join(project, 'dist', 'src', 'workbench.js')).href);
  const expectedHash = workbenchModule.requirementsHash();
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  const markerHashOk = marker.schema === 1 && marker.requirementsHash === expectedHash;
  const pythonProbe = spawnSync('python', ['-E', '-s', '-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const pythonVersion = (pythonProbe.stdout || '').trim();
  const pythonMinor = v => {
    const m = String(v || '').match(/^(\d+)\.(\d+)\./);
    return m ? `${m[1]}.${m[2]}` : null;
  };
  const pythonOk = pythonProbe.status === 0 && pythonMinor(pythonVersion) === pythonMinor(marker.python);
  const inventory = dirInventory(depsDir);
  report.runtimeValidation = {
    depsDir,
    markerPath,
    markerSha256: sha256File(markerPath),
    markerSchema: marker.schema,
    markerRequirementsHash: marker.requirementsHash,
    expectedRequirementsHash: expectedHash,
    markerHashMatch: markerHashOk,
    markerPython: marker.python,
    detectedPythonVersion: pythonVersion || null,
    pythonPath: (() => {
      try {
        const found = spawnSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        return (found.stdout || '').trim() || null;
      } catch {
        return null;
      }
    })(),
    pythonMinorMatch: pythonOk,
    bytes: inventory.bytes,
    files: inventory.files,
    markerInstalledAt: typeof marker.installedAt === 'number' ? marker.installedAt : null,
  };
  log('runtime', `deps=${depsDir}`);
  log('runtime', `marker hash match=${markerHashOk} python=${pythonVersion || 'missing'} size=${(inventory.bytes / 1048576).toFixed(1)}MB files=${inventory.files}`);
  if (!markerHashOk) throw new Error(`workbench runtime marker does not match current pinned requirements (marker=${marker.requirementsHash} expected=${expectedHash}); refusing to reinstall — repair the runtime manually`);
  if (!pythonOk) throw new Error(`Python 3.11.x required but detected "${pythonVersion || 'none'}"; marker python=${marker.python}`);

  // ---------- launch ----------
  const profile = mkdtempSync(join(tmpdir(), 'suwen-wb-e2e-'));
  report.profileDir = profile;
  const env = { ...process.env, SUWEN_TEST_HOME: profile, SUWEN_WORKBENCH_DEPS: depsDir };
  // DSH shells export ELECTRON_RUN_AS_NODE=1; Electron would silently run as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  log('launch', `Electron ${electronExe}`);
  log('launch', `SUWEN_TEST_HOME=${profile}`);
  log('launch', `SUWEN_WORKBENCH_DEPS=${depsDir}`);

  let app = null;
  let markdownFixture = null;
  let nativePage = null;
  let legacyPage = null;
  let connection = null;
  let daemonPid = null;
  let legacyPid = null;
  let legacyPort = null;
  let consoleSeq = 0;
  const nativeConsole = [];
  const legacyConsole = [];
  const nativePageErrors = [];
  const legacyPageErrors = [];
  const armed = new WeakSet();

  const armPage = (page, kind) => {
    if (!page || armed.has(page)) return;
    armed.add(page);
    page.on('pageerror', error => {
      const item = { at: nowIso(), kind, message: String(error?.message || error).slice(0, 800), stack: String(error?.stack || '').split('\n').slice(0, 4).join('\n'), phase: currentPhase };
      if (kind === 'legacy') legacyPageErrors.push(item);
      else nativePageErrors.push(item);
    });
    page.on('console', message => {
      const type = message.type();
      const location = message.location();
      const item = {
        seq: ++consoleSeq,
        at: nowIso(),
        kind,
        type,
        text: String(message.text() || '').slice(0, 1000),
        url: location?.url ?? '',
        line: location?.lineNumber ?? null,
        phase: currentPhase,
      };
      if (kind === 'legacy') legacyConsole.push(item);
      else nativeConsole.push(item);
    });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('crash', () => {
      const item = { at: nowIso(), kind, message: 'renderer crashed', phase: currentPhase };
      if (kind === 'legacy') legacyPageErrors.push(item);
      else nativePageErrors.push(item);
    });
  };

  let currentPhase = 'launch';

  const cleanup = {
    legacyWindowClosed: false,
    appCloseRequested: false,
    appCloseError: null,
    daemonPid: null,
    daemonStopped: false,
    legacyPid: null,
    legacyStopped: false,
    legacyPortClosed: null,
    electronPid: null,
    electronExited: null,
    profileRemoved: false,
    residualProcesses: [],
  };
  report.cleanup = cleanup;

  const globalTimer = setTimeout(() => {
    console.error('GLOBAL TIMEOUT reached; attempting cleanup and writing partial report');
    report.error = report.error || 'global timeout';
    try {
      writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
    } catch {
      /* ignore */
    }
    if (app) taskkill(app.process()?.pid);
    if (daemonPid) taskkill(daemonPid);
    if (legacyPid) taskkill(legacyPid);
    process.exit(3);
  }, GLOBAL_TIMEOUT_MS);
  globalTimer.unref?.();

  try {
    markdownFixture = await startMarkdownFixture();
    report.native.markdownFixture = { url: `http://127.0.0.1:${markdownFixture.port}/v1`, port: markdownFixture.port, deterministic: true, plainHttpOnly: true };
    log('fixture', `markdown SSE fixture http://127.0.0.1:${markdownFixture.port}/v1 (deterministic local)`);
    app = await _electron.launch({ executablePath: electronExe, args: [project], env, timeout: 60000 });
    const electronPid = app.process()?.pid;
    cleanup.electronPid = electronPid;
    log('launch', `electron pid=${electronPid}`);
    nativePage = await app.firstWindow();
    armPage(nativePage, 'native');
    await nativePage.waitForSelector('#health', { timeout: 30000 });
    await nativePage.waitForFunction(() => document.getElementById('health').textContent.includes('后台运行'), null, { timeout: 40000 });
    log('native', 'daemon connection ready (后台运行)');
    try {
      const versions = await app.evaluate(() => ({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      }));
      report.environment.runtimeVersions = versions;
      const appInfo = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion() }));
      report.environment.appName = appInfo.name;
      report.environment.appVersion = appInfo.version || report.environment.appVersion;
      log('native', `app=${appInfo.name} ${appInfo.version} electron=${versions.electron} chrome=${versions.chrome} node=${versions.node}`);
    } catch (error) {
      log('native', `version probe failed: ${error.message}`);
    }

    // ---------- native workbench page ----------
    currentPhase = 'native-workbench';
    await nativePage.locator('.rail [data-page]').first().waitFor({ state: 'visible', timeout: 15000 });
    const railPages = await nativePage.$$eval('.rail [data-page]', buttons => buttons.map(b => b.dataset.page));
    report.native.railButtons = railPages;
    check('native.rail.sixWorkspaces', railPages.length === 6 ? 'PASS' : 'FAIL', `buttons=[${railPages.join(',')}]`);
    check('native.rail.workbenchPresent', railPages.includes('workbench') ? 'PASS' : 'FAIL', 'data-page="workbench"');

    await nativePage.locator('[data-page="workbench"]').click();
    await nativePage.waitForFunction(() => {
      const section = document.getElementById('workbench');
      return !!section && !section.hidden;
    }, null, { timeout: 15000 });
    await nativePage.waitForFunction(() => {
      const state = document.getElementById('wb-state');
      const text = state ? state.textContent || '' : '';
      return text.includes('工作台运行时已就绪') || text.includes('运行时已就绪') || (text.includes('就绪') && !text.includes('尚未'));
    }, null, { timeout: 120000 });
    const wbStateText = await nativePage.$eval('#wb-state', element => element.textContent || '');
    log('native', `#wb-state: ${wbStateText.replace(/\n/g, ' | ').slice(0, 240)}`);
    await nativePage.waitForFunction(() => {
      const button = document.getElementById('wb-open');
      return !!button && !button.disabled;
    }, null, { timeout: 60000 });
    const nativeShot = join(shotsDir, 'native-workbench.png');
    await nativePage.screenshot({ path: nativeShot });
    report.native.workbench = {
      screenshot: relativeTo(reportDir, nativeShot),
      stateText: wbStateText,
      openEnabled: true,
    };
    report.native.workbench.status = await nativePage.evaluate(async () => {
      try {
        return await window.suwen.call('workbench.status');
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    });
    const wbStatus = report.native.workbench.status || {};
    check('native.workbench.stateReady', /就绪/.test(wbStateText) ? 'PASS' : 'FAIL', wbStateText.split('\n')[0]);
    check('native.workbench.openEnabled', 'PASS', '#wb-open enabled');
    check('native.workbench.installed', wbStatus.installed === true ? 'PASS' : 'FAIL', `installed=${wbStatus.installed} python=${wbStatus.pythonVersion} bytes=${wbStatus.bytes}`);
    check('native.workbench.depsDir', resolve(String(wbStatus.depsDir || '')) === resolve(depsDir) ? 'PASS' : 'FAIL', String(wbStatus.depsDir));

    // ---------- open hosted legacy SPA ----------
    currentPhase = 'legacy-open';
    const windowEvent = app.waitForEvent('window', { timeout: 120000 }).catch(error => ({ waitError: error }));
    let openResult = null;
    let openError = null;
    const openPromise = nativePage
      .evaluate(() => window.suwen.call('legacyOpen'))
      .then(result => {
        openResult = result;
        return result;
      })
      .catch(error => {
        openError = String(error?.message || error);
        return null;
      });
    const windowOrError = await windowEvent;
    if (windowOrError && windowOrError.waitError) throw new Error(`legacy window did not open: ${windowOrError.waitError.message}`);
    legacyPage = windowOrError;
    armPage(legacyPage, 'legacy');
    log('legacy', `window event received url=${legacyPage.url()}`);
    await openPromise;
    if (openError) throw new Error(`legacyOpen bridge failed: ${openError}`);
    if (openResult && openResult.ok === false) throw new Error(`legacyOpen refused: ${JSON.stringify(openResult).slice(0, 400)}`);
    await legacyPage.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await legacyPage.waitForSelector('#app-shell', { timeout: 90000 });
    await legacyPage.waitForFunction(() => document.querySelectorAll('#app-nav .nav-item').length >= 12, null, { timeout: 30000 });
    await sleep(600);
    // First-boot onboarding modal (legacy store default onboarded=false) covers route content.
    const onboarding = await legacyPage.evaluate(() => {
      const modal = document.querySelector('#modal-root .modal') || document.querySelector('.modal');
      return modal
        ? {
            present: true,
            title: (modal.querySelector('.modal-title')?.textContent || '').trim(),
            bodyLen: (modal.querySelector('.modal-body')?.innerText || '').trim().length,
            buttons: [...modal.querySelectorAll('.modal-foot button')].map(button => (button.textContent || '').trim()),
          }
        : { present: false };
    });
    report.legacy.onboarding = onboarding;
    check(
      'legacy.onboarding.visibleOnFirstBoot',
      onboarding.present ? 'PASS' : 'PARTIAL',
      onboarding.present ? `"${onboarding.title}" buttons=[${onboarding.buttons.join(', ')}]` : 'no first-boot modal observed',
    );
    if (onboarding.present) {
      try {
        const firstBootShot = join(shotsDir, 'legacy-first-boot.png');
        await legacyPage.screenshot({ path: firstBootShot });
        report.legacy.firstBootScreenshot = relativeTo(reportDir, firstBootShot);
      } catch {
        /* screenshot is best-effort */
      }
      try {
        await legacyPage.getByRole('button', { name: '先看看' }).click({ timeout: 8000 });
      } catch {
        await legacyPage.locator('#modal-root .modal-close, .modal .modal-close').first().click({ timeout: 5000 }).catch(() => {});
      }
      await sleep(800);
      const stillOpen = await legacyPage.evaluate(() => !!document.querySelector('#modal-root .modal, .modal'));
      check('legacy.onboarding.dismissed', stillOpen ? 'FAIL' : 'PASS', stillOpen ? 'modal still present after dismiss attempt' : 'dismissed via 先看看');
    }
    const shellInfo = await legacyPage.evaluate(() => ({
      title: document.title,
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      hash: location.hash,
      theme: document.documentElement.dataset.theme || '',
      themeMode: document.documentElement.dataset.themeMode || '',
      storedTheme: (() => {
        try {
          return localStorage.getItem('omicslab.theme');
        } catch {
          return null;
        }
      })(),
      prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
      lang: document.documentElement.lang || '',
      brand: (document.querySelector('.brand-name')?.textContent || '').trim(),
      navCount: document.querySelectorAll('#app-nav .nav-item').length,
      navRoutes: [...document.querySelectorAll('#app-nav .nav-item')].map(button => button.dataset.route),
      navLabels: [...document.querySelectorAll('#app-nav .nav-item .nav-label')].map(node => (node.textContent || '').trim()),
      bootSplashPresent: !!document.getElementById('boot-splash'),
      window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
      bodyTextLen: (document.body.innerText || '').trim().length,
    }));
    report.legacy.opened = true;
    report.legacy.window = shellInfo.window;
    report.legacy.shell = shellInfo;
    log('legacy', `title="${shellInfo.title}" nav=${shellInfo.navCount} theme=${shellInfo.theme} brand="${shellInfo.brand}"`);
    check('legacy.window.event', 'PASS', `url=${shellInfo.url}`);
    check('legacy.title.contains素问', /素问/.test(shellInfo.title) ? 'PASS' : 'FAIL', shellInfo.title);
    check('legacy.shell.navItems>=12', shellInfo.navCount >= 12 ? 'PASS' : 'FAIL', `${shellInfo.navCount} nav items: ${shellInfo.navRoutes.join(',')}`);
    check('legacy.shell.brand', /素问/.test(shellInfo.brand) ? 'PASS' : 'FAIL', shellInfo.brand);
    check(
      'legacy.theme.darkDefault',
      shellInfo.theme === 'dark' ? 'PASS' : 'FAIL',
      `data-theme=${shellInfo.theme || '(none)'} (requirement: dark by default; storedPref=${shellInfo.storedTheme}; prefersLight=${shellInfo.prefersLight}; static index.html fallback is dark, but platform appearance default "system" resolves from OS)`,
    );
    check('legacy.isolated.session', !/127\.0\.0\.1/.test(shellInfo.url) ? 'FAIL' : 'PASS', `origin=${shellInfo.origin}`);
    const shellShot = join(shotsDir, 'legacy-shell.png');
    await legacyPage.screenshot({ path: shellShot });
    report.legacy.shellScreenshot = relativeTo(reportDir, shellShot);
    check('legacy.renderer.noNode', (await legacyPage.evaluate(() => typeof window.require)) === 'undefined' ? 'PASS' : 'FAIL', 'window.require undefined');
    check('legacy.renderer.noBridge', (await legacyPage.evaluate(() => typeof window.suwen)) === 'undefined' ? 'PASS' : 'FAIL', 'window.suwen undefined');
    // Theme toggle control must work in the hosted shell; restore the resolved initial theme afterwards.
    try {
      const toggleBefore = await legacyPage.evaluate(() => document.documentElement.dataset.theme || '');
      await legacyPage.locator('#theme-toggle').click({ timeout: 8000 });
      await sleep(600);
      const toggleAfter = await legacyPage.evaluate(() => document.documentElement.dataset.theme || '');
      await legacyPage.locator('#theme-toggle').click({ timeout: 8000 });
      await sleep(600);
      const toggleRestored = await legacyPage.evaluate(() => document.documentElement.dataset.theme || '');
      report.legacy.themeToggle = { before: toggleBefore, after: toggleAfter, restored: toggleRestored };
      check(
        'legacy.theme.toggleWorks',
        toggleAfter !== toggleBefore && /^(light|dark)$/.test(toggleAfter) && toggleRestored === toggleBefore ? 'PASS' : 'FAIL',
        `${toggleBefore} -> ${toggleAfter} -> ${toggleRestored}`,
      );
    } catch (error) {
      report.legacy.themeToggle = { error: String(error?.message || error).slice(0, 400) };
      check('legacy.theme.toggleWorks', 'FAIL', String(error?.message || error).slice(0, 300));
    }

    // daemon health for legacy pid/port evidence
    try {
      const rpc = await import(pathToFileURL(rpcFile).href);
      const security = await import(pathToFileURL(securityFile).href);
      connection = security.readConnection(join(profile, 'runtime'));
      if (connection) {
        const health = await rpc.rpc(connection, 'health');
        daemonPid = connection.pid;
        if (health?.legacy?.pid) legacyPid = health.legacy.pid;
        if (health?.legacy?.port) legacyPort = health.legacy.port;
        report.native.daemon = { pid: daemonPid, legacy: health?.legacy ?? null, runtimeVersions: health?.runtimeVersions ?? null };
        log('daemon', `pid=${daemonPid} legacy=${JSON.stringify(health?.legacy ?? null)}`);
      }
    } catch (error) {
      log('daemon', `health probe failed: ${error.message}`);
    }

    // ---------- route audit ----------
    currentPhase = 'routes';
    for (let index = 0; index < ROUTES.length; index += 1) {
      const route = ROUTES[index];
      const routePhase = `route:${route.id}`;
      currentPhase = routePhase;
      const seqBefore = consoleSeq;
      const t0 = nowMs();
      let status = 'PASS';
      let failure = '';
      try {
        await legacyPage.evaluate(id => {
          window.location.hash = `#/${id}`;
        }, route.id);
        await legacyPage.waitForFunction(
          ({ label }) => {
            const root = document.getElementById('view-root');
            if (!root || root.children.length === 0) return false;
            if (root.querySelector('.route-loading')) return false;
            if (document.title !== `${label} · 素问 Suwen`) return false;
            return true;
          },
          { label: route.label },
          { timeout: 30000 },
        );
        await sleep(500);
      } catch (error) {
        status = 'FAIL';
        failure = `render timeout: ${String(error?.message || error).split('\n')[0].slice(0, 300)}`;
      }
      const data = await legacyPage.evaluate(() => {
        const root = document.getElementById('view-root');
        const errorCard = root?.querySelector('.error-card');
        const body = document.body.innerText || '';
        return {
          title: document.title,
          hash: location.hash,
          viewTextLen: ((root?.innerText || '').trim().length) || 0,
          childCount: root?.children.length || 0,
          loading: !!root?.querySelector('.route-loading'),
          errorCard: errorCard ? (errorCard.innerText || '').trim().slice(0, 500) : null,
          bootError: body.includes('界面未能启动') || body.includes('界面脚本加载失败'),
          bodyText: body.replace(/\s+/g, ' ').trim().slice(0, 260),
        };
      });
      if (!failure) {
        if (data.errorCard) {
          status = 'FAIL';
          failure = 'fatal error card';
        } else if (data.bootError) {
          status = 'FAIL';
          failure = 'boot splash failure state';
        } else if (data.viewTextLen === 0 && data.childCount === 0) {
          status = 'FAIL';
          failure = 'empty route container';
        } else if (data.loading) {
          status = 'FAIL';
          failure = 'route still loading after settle';
        } else if (data.hash !== `#/${route.id}`) {
          status = 'FAIL';
          failure = `hash mismatch: ${data.hash}`;
        }
      }
      const pageErrorsForRoute = legacyPageErrors.filter(item => item.phase === routePhase);
      if (status === 'PASS' && pageErrorsForRoute.length > 0) {
        status = 'FAIL';
        failure = `uncaught page error: ${pageErrorsForRoute[0].message.slice(0, 200)}`;
      }
      const consoleForRoute = legacyConsole.filter(item => item.seq > seqBefore);
      const consoleErrors = consoleForRoute.filter(item => item.type === 'error');
      const benignErrors = consoleErrors.filter(item => isBenignConsoleError(item));
      const realErrors = consoleErrors.filter(item => !isBenignConsoleError(item));
      const shot = join(shotsDir, `route-${String(index + 1).padStart(2, '0')}-${route.id}.png`);
      try {
        await legacyPage.screenshot({ path: shot });
      } catch (error) {
        log(routePhase, `screenshot failed: ${error.message}`);
      }
      report.routes.push({
        index: index + 1,
        route: route.id,
        label: route.label,
        status,
        failure,
        elapsedMs: nowMs() - t0,
        title: data.title,
        hash: data.hash,
        viewTextLen: data.viewTextLen,
        childCount: data.childCount,
        errorCard: data.errorCard,
        bodySample: data.bodyText,
        screenshot: relativeTo(reportDir, shot),
        console: {
          total: consoleForRoute.length,
          errors: consoleErrors.length,
          benign: benignErrors.length,
          real: realErrors.map(item => ({ type: item.type, text: item.text.slice(0, 300), url: item.url, line: item.line })),
        },
        pageErrors: pageErrorsForRoute.map(item => item.message.slice(0, 300)),
      });
      log(routePhase, `${status} title="${data.title}" textLen=${data.viewTextLen} children=${data.childCount} consoleErrors=${realErrors.length}${failure ? ' — ' + failure : ''}`);
    }
    const routeFailures = report.routes.filter(route => route.status !== 'PASS');
    check('legacy.routes.all12', routeFailures.length === 0 ? 'PASS' : 'FAIL', `${12 - routeFailures.length}/12 routes rendered${routeFailures.length ? '; failures: ' + routeFailures.map(r => r.route).join(',') : ''}`);

    // ---------- native regression after legacy window ----------
    currentPhase = 'native-regression';
    for (const pageName of NATIVE_PAGES) {
      const pageResult = { page: pageName, visible: false, title: null, error: null };
      try {
        await nativePage.locator(`[data-page="${pageName}"]`).click();
        await nativePage.waitForFunction(name => {
          const section = document.getElementById(name);
          return !!section && !section.hidden;
        }, pageName, { timeout: 15000 });
        pageResult.visible = true;
        pageResult.title = await nativePage.evaluate(() => document.getElementById('page-title')?.textContent || '');
      } catch (error) {
        pageResult.error = String(error?.message || error).split('\n')[0].slice(0, 200);
      }
      report.native.pages.push(pageResult);
      log('native', `page ${pageName} visible=${pageResult.visible} title="${pageResult.title || ''}"`);
    }
    const nativePageFailures = report.native.pages.filter(page => !page.visible);
    check('native.pages.noRegression', nativePageFailures.length === 0 ? 'PASS' : 'FAIL', nativePageFailures.length ? 'failed: ' + nativePageFailures.map(p => p.page).join(',') : 'all native pages open');
    const electronAlive = app.process()?.exitCode === null;
    check('native.electron.alive', electronAlive ? 'PASS' : 'FAIL', `exitCode=${app.process()?.exitCode}`);
    try {
      const finalShot = join(shotsDir, 'native-after-legacy.png');
      await nativePage.screenshot({ path: finalShot });
      report.native.afterLegacyScreenshot = relativeTo(reportDir, finalShot);
    } catch {
      /* non-fatal */
    }

    // ---------- native chat markdown (KaTeX + Mermaid) ----------
    currentPhase = 'native-markdown';
    try {
      const nativeErrorsBefore = nativePageErrors.length;
      await runMarkdownAudit({
        nativePage,
        fixture: markdownFixture,
        report,
        shotsDir,
        reportDir,
        check,
        log,
        nativeConsole,
        nativeErrorCount: () => nativePageErrors.length,
        nativeErrorsSince: index => nativePageErrors.slice(index).map(item => item.message),
        nativeErrorsBefore,
      });
    } catch (error) {
      report.native.markdown = { ...(report.native.markdown || {}), error: String(error?.stack || error).slice(0, 3000) };
      check('native.markdown.run', 'FAIL', String(error?.message || error).slice(0, 300));
    }
  } catch (error) {
    report.error = String(error?.stack || error).slice(0, 4000);
    log('error', `E2E failed: ${error?.message || error}`);
    check('e2e.run', 'FAIL', String(error?.message || error).slice(0, 400));
  } finally {
    currentPhase = 'cleanup';
    log('cleanup', 'starting');
    report.native.console = nativeConsole;
    report.native.pageErrors = nativePageErrors;
    report.legacy.console = legacyConsole;
    report.legacy.pageErrors = legacyPageErrors;

    if (legacyPage) {
      try {
        await Promise.race([
          legacyPage.close(),
          sleep(5000).then(() => {
            throw new Error('legacy page close timeout');
          }),
        ]);
        cleanup.legacyWindowClosed = true;
      } catch (error) {
        cleanup.legacyWindowClosed = false;
        cleanup.legacyWindowCloseError = String(error?.message || error);
      }
    }
    if (app) {
      cleanup.appCloseRequested = true;
      try {
        await Promise.race([
          app.close(),
          sleep(8000).then(() => {
            throw new Error('app.close timeout');
          }),
        ]);
      } catch (error) {
        cleanup.appCloseError = String(error?.message || error);
        const pid = app.process()?.pid;
        if (pid) taskkill(pid);
      }
    }
    await sleep(300);
    cleanup.electronExited = cleanup.electronPid ? !pidAlive(cleanup.electronPid) : null;
    if (cleanup.electronPid && pidAlive(cleanup.electronPid)) taskkill(cleanup.electronPid);

    // daemon shutdown after window close: also stops the Python legacy server.
    try {
      const rpc = await import(pathToFileURL(rpcFile).href);
      const security = await import(pathToFileURL(securityFile).href);
      connection = connection || security.readConnection(join(profile, 'runtime'));
      if (connection) {
        cleanup.daemonPid = connection.pid;
        try {
          await rpc.rpc(connection, 'shutdown');
        } catch {
          /* pipe already closed */
        }
        for (let i = 0; i < 30; i += 1) {
          if (!pidAlive(connection.pid)) break;
          await sleep(200);
        }
        cleanup.daemonStopped = !pidAlive(connection.pid);
        if (!cleanup.daemonStopped) {
          taskkill(connection.pid);
          await sleep(300);
          cleanup.daemonStopped = !pidAlive(connection.pid);
        }
      }
    } catch (error) {
      cleanup.daemonShutdownError = String(error?.message || error);
    }
    cleanup.legacyPid = legacyPid;
    if (legacyPid) {
      for (let i = 0; i < 20; i += 1) {
        if (!pidAlive(legacyPid)) break;
        await sleep(200);
      }
      cleanup.legacyStopped = !pidAlive(legacyPid);
      if (!cleanup.legacyStopped) {
        taskkill(legacyPid);
        await sleep(300);
        cleanup.legacyStopped = !pidAlive(legacyPid);
      }
    }
    if (legacyPort) {
      try {
        await fetch(`http://127.0.0.1:${legacyPort}/`, { signal: AbortSignal.timeout(2500) });
        cleanup.legacyPortClosed = false;
      } catch {
        cleanup.legacyPortClosed = true;
      }
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      cleanup.profileRemoved = true;
    } catch (error) {
      cleanup.profileRemoved = false;
      cleanup.profileRemoveError = String(error?.message || error);
    }
    cleanup.residualProcesses = collectProcessesLike([`suwen-wb-e2e-`, depsDir]);
    if (cleanup.residualProcesses.length) {
      for (const processInfo of cleanup.residualProcesses) taskkill(processInfo.pid);
    }
    if (markdownFixture) {
      try {
        await markdownFixture.close();
        cleanup.markdownFixtureClosed = true;
      } catch (error) {
        cleanup.markdownFixtureClosed = false;
        cleanup.markdownFixtureCloseError = String(error?.message || error);
      }
    }

    report.finishedAt = nowIso();
    report.durationMs = nowMs() - startedMs;
    const hardFailure = report.checks.some(item => item.status === 'FAIL') || !report.legacy.opened || !!report.error;
    const partial = report.checks.some(item => item.status === 'PARTIAL');
    report.summary = {
      checks: report.checks.reduce((acc, item) => {
        const key = String(item.status);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      routes: report.routes.length,
      routesPassed: report.routes.filter(route => route.status === 'PASS').length,
      routesFailed: report.routes.filter(route => route.status !== 'PASS').length,
      legacyConsoleErrors: legacyConsole.filter(item => item.type === 'error').length,
      legacyConsoleErrorsReal: legacyConsole.filter(item => item.type === 'error' && !isBenignConsoleError(item)).length,
      legacyPageErrors: legacyPageErrors.length,
      nativePageErrors: nativePageErrors.length,
      nativeConsoleErrors: nativeConsole.filter(item => item.type === 'error').length,
      markdown: report.native.markdown
        ? {
            katex: report.native.markdown.domBefore?.counts?.katex ?? null,
            diagrams: report.native.markdown.domBefore?.counts?.mermaidRendered ?? null,
            tables: report.native.markdown.domBefore?.counts?.table ?? null,
            pageErrors: report.native.markdown.newPageErrors?.length ?? null,
            fixtureRequests: report.native.markdown.fixtureRequestCount ?? null,
            cspViolations: report.native.markdown.console?.cspViolations ?? null,
            themes: Object.fromEntries(Object.entries(report.native.markdown.themes || {}).map(([mode, value]) => [mode, value?.resolved ?? value?.error ?? null])),
          }
        : null,
      status: hardFailure ? 'FAIL' : partial ? 'PARTIAL' : 'PASS',
    };
    report.limitations = [
      'Deterministic local run: no real model provider credentials are configured; legacy chat/research views render unconfigured/empty states. Native markdown rendering is driven by a local loopback OpenAI-compatible SSE fixture (127.0.0.1, fixed payload, ~900 ms pause to observe the streaming state) — not a real provider.',
      'Only loopback traffic (Electron IPC + 127.0.0.1 Python bridge + in-page /api requests + the local markdown fixture) is exercised; external services (SSH hosts, message channels, model APIs, public databases) are not contacted.',
      'Route checks assert shell mount, non-fatal render, per-route title, and absence of fatal error cards; they do not validate every legacy feature action (approvals, uploads, kernels, SSH sessions) beyond whatever each view initializes on mount.',
      'Legacy SPA is Chinese-only (zh-CN). Its shell resolves the appearance default theme="system"; on this light-mode host that resolves to light, so the task-13 expectation "dark by default" fails (see checks legacy.theme.darkDefault). Toggle to dark was exercised and is captured in report.legacy.themeToggle.',
      'The first-boot onboarding modal (欢迎来到素问) is dismissed via its 先看看 button before route checks; the modal screenshot legacy-first-boot.png is retained.',
      'Native markdown audit assumes the rebuilt UI (app.js) contains the markdown/KaTeX/Mermaid renderer; if the build predates it, native.markdown.* checks fail with explicit reasons.',
      'The managed Python dependency directory is reused as-is via SUWEN_WORKBENCH_DEPS; installation/repair flows (network + pip) are not exercised.',
      'Renderer screenshots are viewport captures of the isolated 1600x1000 window; no OS-level DPI / accessibility / contrast measurements are claimed.',
    ];
    try {
      writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
      log('report', join(reportDir, 'report.json'));
    } catch (error) {
      log('report', `write failed: ${error.message}`);
    }
    const summary = report.summary || {};
    console.log('\n=== workbench UI E2E summary ===');
    console.log(JSON.stringify({ status: summary.status, checks: summary.checks, routes: `${summary.routesPassed}/${summary.routes}`, markdown: summary.markdown, legacyErrors: summary.legacyConsoleErrorsReal, pageErrors: summary.legacyPageErrors + summary.nativePageErrors, report: join(reportDir, 'report.json') }, null, 2));
    setTimeout(() => process.exit(report.summary.status === 'PASS' ? 0 : 1), 250);
  }
}

function relativeTo(base, path) {
  return relative(base, path).split('\\').join('/');
}

function isBenignConsoleError(item) {
  const text = String(item.text || '');
  const url = String(item.url || '');
  if (/favicon/i.test(text) || /favicon/i.test(url)) return true;
  if (/Failed to load resource.*(401|403)/i.test(text) && /\/api\//.test(url)) return false;
  if (/net::ERR_ABORTED/i.test(text)) return true;
  return false;
}

main().catch(error => {
  fatal(String(error?.stack || error));
  setTimeout(() => process.exit(2), 200);
});
