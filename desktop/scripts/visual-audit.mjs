#!/usr/bin/env node
/**
 * SuWen Desktop vNext round 3 — UI visual audit (T2, deterministic local fixture).
 *
 * Captures every workspace + evidence panel + empty/loading/error states at
 * 1x / 1.25x / 1.5x device scale factor, zh + en, light + dark, with
 * programmatic overlap / overflow / bounding checks. No real vendor APIs.
 *
 * Usage:
 *   node scripts/visual-audit.mjs [--dsf=1,1.25,1.5] [--locales=zh,en]
 *        [--themes=light,dark] [--out=..\docs\verification\screenshots\round3]
 *
 * Screenshots + JSON report are artifacts for docs/verification/ui-visual-audit.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.resolve(ROOT, '..', 'docs');
const require = createRequire(path.join(ROOT, 'package.json'));
const { _electron } = require('playwright-core');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DSFS = String(argValue('dsf', '1,1.25,1.5')).split(',').map(Number).filter(n => n > 0);
const LOCALES = String(argValue('locales', 'zh,en')).split(',');
const THEMES = String(argValue('themes', 'light,dark')).split(',');
// Explicit window content sizes requested by the Lead: 1920x1080 and 1366x768 primary, 980x680 minimum.
// Format: --sizes=1920x1080,1366x768 (default audits the two primary desktop viewports).
const SIZES = String(argValue('sizes', '1920x1080,1366x768')).split(',').map((token) => {
  const [w, h] = token.toLowerCase().split('x').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w: Math.max(980, w), h: Math.max(680, h), label: `${Math.max(980, w)}x${Math.max(680, h)}` } : null;
}).filter(Boolean);
const OUT_DIR = path.resolve(argValue('out', path.join(DOCS, 'verification', 'screenshots', 'round3')));
const REPORT_DIR = path.join(ROOT, 'release', 'smoke');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const nowIso = () => new Date().toISOString();

const phaseLog = [];
const log = (phase, msg) => {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${phase.padEnd(10)} ${msg}`;
  phaseLog.push({ at: nowIso(), phase, msg });
  console.log(line);
};
const sha256 = text => createHash('sha256').update(text).digest('hex');

/* ------------------------------------------------------------------ */
/* Deterministic local OpenAI-SSE fixture (no vendor calls)            */
/* ------------------------------------------------------------------ */
const fixture = {
  server: null, port: 0, plans: [], requests: [], held: new Set(),
  enqueue(plan) { this.plans.push(plan); },
  async start() {
    this.server = createServer((req, res) => {
      const url = req.url || '';
      if (!url.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const plan = this.plans.shift() || { tag: `A${this.requests.length}`, size: 4 };
        this.requests.push({ at: nowIso(), tag: plan.tag, size: plan.size, hold: !!plan.hold, err: plan.err ?? null, stream: body.stream === true, maxTokens: body.max_tokens ?? null, prompt: raw.slice(0, 120) });
        if (plan.err) {
          res.writeHead(Number(plan.err) || 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fixture injected provider error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.flushHeaders?.();
        let closed = false;
        req.on('aborted', () => { closed = true; });
        res.on('close', () => { if (!res.writableEnded) closed = true; });
        let i = 0;
        const tick = () => {
          if (closed) { this.held.delete(plan.tag); return; }
          if (i >= plan.size) {
            const done = { id: `chatcmpl-${plan.tag}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: plan.size, total_tokens: 20 + plan.size } };
            res.write(`data: ${JSON.stringify(done)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (plan.hold && i === 3) { this.held.add(plan.tag); return; } // leave stream open for the loading state
          const content = i === 0 ? `[${plan.tag}]w00000 ` : `w${String(i).padStart(5, '0')} `;
          i += 1;
          const payload = { id: `chatcmpl-${plan.tag}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          setTimeout(tick, 12);
        };
        tick();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  },
  baseUrl() { return `http://127.0.0.1:${this.port}/v1`; },
  async close() {
    try { this.server?.closeAllConnections?.(); } catch { /* ignore */ }
    await new Promise(resolve => { try { this.server?.close(() => resolve()); } catch { resolve(); } });
  },
};

/* ------------------------------------------------------------------ */
/* Electron launch / teardown (same proven pattern as electron-smoke)  */
/* ------------------------------------------------------------------ */
let activeApp = null;
const pageErrors = [];
const consoleErrors = [];

async function killPid(pid) {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch { /* ignore */ }
}

async function launchElectron({ dsf, locale, profile, size }) {
  const env = { ...process.env, SUWEN_TEST_HOME: profile };
  delete env.ELECTRON_RUN_AS_NODE; // DSH exports this; Electron would run as Node and exit silently
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, '--native', `--force-device-scale-factor=${dsf}`, `--lang=${locale === 'zh' ? 'zh-CN' : 'en-US'}`],
    env,
    timeout: 40000,
  });
  activeApp = app;
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push({ at: nowIso(), dsf, locale, message: String(error?.message || error), stack: String(error?.stack || '').slice(0, 4000) }));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push({ at: nowIso(), dsf, locale, text: msg.text().slice(0, 2000) }); });
  await page.waitForSelector('#health', { timeout: 30000 });
  await page.waitForFunction(() => !!window.suwen && typeof window.suwen.call === 'function', null, { timeout: 30000 });
  const boot = await app.evaluate(({ screen }) => {
    const display = screen.getPrimaryDisplay();
    return { workAreaSize: display.workAreaSize, scaleFactor: display.scaleFactor, bounds: display.bounds };
  });
  // Fit the window into the work area at the forced scale factor; record the actual content size.
  const sizing = await app.evaluate(({ BrowserWindow, screen }, options) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    let w; let h;
    if (options.size && options.size.w) { w = options.size.w; h = options.size.h; }
    else {
      const { workAreaSize } = screen.getPrimaryDisplay();
      w = Math.max(980, Math.min(1400, (workAreaSize.width || 1400) - 20));
      h = Math.max(680, Math.min(930, (workAreaSize.height || 900) - 60));
    }
    win.setContentSize(w, h);
    win.center();
    const [cw, ch] = win.getContentSize();
    return { requested: { w, h }, contentSize: { w: cw, h: ch }, dsfForWindow: options.dsf, explicitSize: !!options.size };
  }, { dsf, size });
  await sleep(300);
  return { app, page, boot, sizing };
}

async function configureModel(page) {
  return page.evaluate(async (url) => {
    try {
      const result = await window.suwen.call('configure', { provider: 'openai', baseUrl: url, model: 'fixture', apiKey: 'fixture', contextWindow: 8192, maxOutput: 512 });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: String(error) }; }
  }, fixture.baseUrl());
}

const bridge = (page, method, params = {}) =>
  page.evaluate(async ([m, p]) => {
    try { return { ok: true, result: await window.suwen.call(m, p) }; } catch (error) { return { ok: false, error: String(error) }; }
  }, [method, params]);

async function callOk(page, method, params = {}) {
  const res = await bridge(page, method, params);
  if (!res.ok) throw new Error(`${method} failed: ${res.error}`);
  return res.result;
}

async function waitDaemon(page, timeout = 25000) {
  const t0 = Date.now();
  let lastError = null;
  while (Date.now() - t0 < timeout) {
    const res = await page.evaluate(async () => {
      try { const snap = await window.suwen.call('snapshot', {}); return { ok: true, health: snap?.health || null }; } catch (error) { return { ok: false, error: String(error) }; }
    });
    if (res.ok) return res.health;
    lastError = res.error;
    await sleep(250);
  }
  throw new Error(`daemon did not become reachable: ${lastError}`);
}

async function snapshotTasks(page) {
  const res = await bridge(page, 'snapshot', {});
  return res.ok ? (res.result?.tasks || []) : [];
}

async function waitTask(page, predicate, timeout = 30000, label = 'task') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const tasks = await snapshotTasks(page);
    const hit = tasks.find(predicate);
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* ------------------------------------------------------------------ */
/* Navigation helpers (use UI's own exposed functions where stable)    */
/* ------------------------------------------------------------------ */
async function showPage(page, name) {
  await page.click(`.rail button[data-page="${name}"]`);
  await page.waitForFunction(n => { const p = document.getElementById(n); return !!p && !p.hidden; }, name, { timeout: 15000 });
  await sleep(350);
}

async function ensureLocale(page, locale) {
  const norm = value => String(value || '').toLowerCase().split('-')[0];
  const current = await page.evaluate(() => document.documentElement.lang || '');
  if (locale === 'en' && norm(current) !== 'en') { await page.click('#language'); await sleep(350); }
  if (locale === 'zh' && norm(current) !== 'zh') { await page.click('#language'); await sleep(350); }
  const after = await page.evaluate(() => document.documentElement.lang || '');
  if (norm(after) !== locale) throw new Error(`locale expected ${locale} got ${after}`);
}

async function applyTheme(page, mode) {
  const result = await page.evaluate(async (value) => {
    try {
      if (typeof selectTheme === 'function') await selectTheme(value);
      else if (typeof applyTheme === 'function') applyTheme(value);
      else return { ok: false, error: 'no theme function exposed' };
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  }, mode);
  await sleep(300);
  const attr = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), mode: document.documentElement.getAttribute('data-theme-mode') }));
  return { ...result, ...attr };
}

async function newChat(page) {
  await showPage(page, 'chat');
  const res = await page.evaluate(() => {
    try {
      if (typeof newConversation === 'function') { newConversation(); return 'newConversation'; }
      document.getElementById('new-chat')?.click();
      return 'click';
    } catch (error) { return `error:${String(error)}`; }
  });
  await sleep(300);
  return res;
}

/* ------------------------------------------------------------------ */
/* Screenshot + programmatic checks                                    */
/* ------------------------------------------------------------------ */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const checksFn = () => {
  const visible = el => !!el && el.offsetParent !== null && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const rectOf = sel => {
    const el = document.querySelector(sel);
    if (!visible(el)) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
  };
  const describe = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
  const key = {
    rail: rectOf('.rail'), sidebar: rectOf('.sidebar'), main: rectOf('main'), header: rectOf('header'),
    timeline: rectOf('#timeline'), composer: rectOf('#composer'), evidence: rectOf('#evidence'),
    prompt: rectOf('#prompt'), send: rectOf('#send'), page: rectOf('.page:not([hidden])'),
  };
  const outside = [];
  for (const [name, r] of Object.entries(key)) {
    if (!r) continue;
    if (r.x < -1 || r.right > window.innerWidth + 1) outside.push({ element: name, rect: r });
  }
  const overlaps = [];
  const pairs = [['rail', 'sidebar'], ['rail', 'header'], ['sidebar', 'main'], ['sidebar', 'header'], ['header', 'timeline'], ['composer', 'timeline'], ['timeline', 'evidence'], ['composer', 'evidence'], ['main', 'evidence']];
  for (const [a, b] of pairs) {
    const ra = key[a]; const rb = key[b];
    if (!ra || !rb) continue;
    const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.x, rb.x));
    const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y));
    if (x > 1 && y > 1) overlaps.push({ pair: `${a}/${b}`, areaPx: Math.round(x * y) });
  }
  const horizontalOverflow = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('.page, .timeline, .cards, .card, #composer, header, .sidebar, .rail, #evidence, .message, .toolbar, .form-grid')) {
    if (!visible(el)) continue;
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 2 && !seen.has(el)) {
      seen.add(el);
      horizontalOverflow.push({ element: describe(el), dx, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth });
    }
  }
  const activePages = [...document.querySelectorAll('.page')].filter(visible).map(el => el.id);
  const streamingBodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
  const evidenceEl = document.getElementById('evidence');
  return {
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
    language: document.documentElement.lang || '',
    theme: {
      attr: document.documentElement.getAttribute('data-theme'),
      mode: document.documentElement.getAttribute('data-theme-mode'),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
    },
    documentOverflow: {
      x: document.scrollingElement ? Math.max(0, document.scrollingElement.scrollWidth - window.innerWidth) : null,
      y: document.scrollingElement ? Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight) : null,
      bodyX: document.body ? Math.max(0, document.body.scrollWidth - window.innerWidth) : null,
    },
    key,
    outside,
    overlaps,
    horizontalOverflow: horizontalOverflow.slice(0, 12),
    activePages,
    pageTitle: document.getElementById('page-title')?.textContent || null,
    messageCount: document.querySelectorAll('#timeline .message').length,
    assistantTextLen: streamingBodies.reduce((sum, b) => sum + (b.textContent || '').length, 0),
    streaming: {
      bubble: !!document.querySelector('#timeline .message.streaming'),
      bannerVisible: visible(document.getElementById('stream-banner')),
      bannerText: (document.getElementById('stream-banner')?.textContent || '').slice(0, 160),
    },
    evidence: {
      open: !!evidenceEl && !evidenceEl.hidden && visible(evidenceEl),
      rect: rectOf('#evidence'),
      contentLen: (document.getElementById('evidence-content')?.textContent || '').length,
      tabs: [...document.querySelectorAll('#evidence-tabs button')].map(b => (b.textContent || '').trim().slice(0, 20)),
    },
    error: {
      bannerVisible: visible(document.getElementById('error')),
      bannerText: (document.getElementById('error')?.textContent || '').slice(0, 200),
      chatNoticeVisible: visible(document.getElementById('chat-notice')),
      chatNoticeText: (document.getElementById('chat-notice')?.textContent || '').slice(0, 200),
      chatNoticeHidden: document.getElementById('chat-notice')?.hidden ?? null,
      chatNoticeRawLen: (document.getElementById('chat-notice')?.textContent || '').length,
      selectedTaskId: (typeof S === 'object' && S && S.selectedTaskId) || null,
      selectedTask: (() => {
        try {
          const task = (S?.snapshot?.tasks || []).find(item => item && item.id === S.selectedTaskId);
          return task ? { id: task.id, name: task.name, status: task.status } : null;
        } catch { return null; }
      })(),
      selectedSteps: (() => {
        try {
          const task = (S?.snapshot?.tasks || []).find(item => item && item.id === S.selectedTaskId);
          const steps = Array.isArray(task?.steps) ? task.steps : [];
          return steps.filter(step => step && ['waiting_approval', 'failed'].includes(step.status))
            .map(step => ({ id: step.id, kind: step.kind, status: step.status, errorLen: (step.error || '').length, error: String(step.error || '').slice(0, 200) }));
        } catch { return []; }
      })(),
      reviewNoticeTask: (typeof S === 'object' && S && S.reviewNoticeTask) || null,
      failedNoticeTask: (typeof S === 'object' && S && S.failedNoticeTask) || null,
      chatNoticeState: (typeof S === 'object' && S && S.chatNotice) || null,
      conversationId: (typeof S === 'object' && S && S.conversationId) || null,
      failedTask: (() => {
        try {
          const task = (S?.snapshot?.tasks || []).find(item => item && item.status === 'failed');
          return task ? { id: task.id, name: task.name, status: task.status } : null;
        } catch { return null; }
      })(),
    },
    themeControlPresent: !!document.getElementById('defaults-theme'),
  };
};

async function capture(page, state, meta) {
  await sleep(320);
  const checks = await page.evaluate(checksFn);
  const dir = OUT_DIR;
  const file = path.join(dir, `${state}_${meta.theme}_${meta.locale}_${meta.size}_dsf${String(meta.dsf).replace('.', 'p')}x.png`);
  const buffer = await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
  const size = pngSize(buffer);
  const record = {
    state, theme: meta.theme, locale: meta.locale, dsf: meta.dsf, size: meta.size,
    file: path.relative(ROOT, file), path: file, bytes: buffer.length, sha256: sha256(buffer),
    png: size, checks,
    at: nowIso(),
  };
  log('shot', `${state} ${meta.theme} ${meta.locale} ${meta.size} dsf=${meta.dsf} ${size ? size.width + 'x' + size.height : '?'} ${(buffer.length / 1024).toFixed(0)}KB`);
  return record;
}

/* ------------------------------------------------------------------ */
/* State builders                                                      */
/* ------------------------------------------------------------------ */
async function buildTasks(page, tagPrefix) {
  // Deterministic echo task (no model) for the tasks workspace + evidence panel.
  const echo = await callOk(page, 'create', {
    name: `视觉审计 echo 任务 ${tagPrefix}`,
    steps: [{ id: 'demo', kind: 'echo', input: { text: `deterministic local fixture visual audit ${tagPrefix}` } }],
    limits: { maxCalls: 2, maxWallMs: 60000, concurrency: 1, maxTokens: 1000 },
  });
  const task = await waitTask(page, t => t.id === echo.id && ['completed', 'failed', 'waiting_approval'].includes(t.status), 20000, 'echo task');
  const project = await callOk(page, 'project.create', { name: `视觉审计项目 ${tagPrefix}`, notes: 'deterministic local fixture visual audit project' });
  return { echoTask: task, projectId: project?.id || project?.project?.id || null };
}

async function ensureEvidence(page, taskId) {
  await page.evaluate((id) => {
    try { if (typeof openEvidence === 'function') openEvidence(id); } catch { /* fall through */ }
    const aside = document.getElementById('evidence');
    if (aside) aside.hidden = false;
  }, taskId);
  await page.waitForFunction(() => {
    const aside = document.getElementById('evidence');
    const content = document.getElementById('evidence-content');
    return !!aside && !aside.hidden && !!content && (content.textContent || '').length > 0;
  }, null, { timeout: 15000 });
  await sleep(250);
}

async function captureAllStates(page, meta, theme, ids) {
  const shots = [];
  const state = name => capture(page, name, meta);

  // 1) empty chat
  await newChat(page);
  shots.push(await state('chat-empty'));

  // 2) projects workspace (populated with one deterministic project)
  await showPage(page, 'projects');
  await page.waitForFunction(() => (document.getElementById('project-list')?.textContent || '').includes('视觉审计项目') || (document.getElementById('project-list')?.textContent || '').includes('visual audit'), null, { timeout: 15000 }).catch(() => {});
  shots.push(await state('workspace-projects'));

  // 3) tasks workspace with detail open
  await page.evaluate((taskId) => { try { if (typeof openTaskDetail === 'function') openTaskDetail(taskId); } catch { /* ignore */ } }, ids.echoTaskId);
  await showPage(page, 'tasks');
  shots.push(await state('workspace-tasks'));

  // 4) tools workspace
  await showPage(page, 'tools');
  shots.push(await state('workspace-tools'));

  // 5) settings workspace
  await showPage(page, 'settings');
  shots.push(await state('workspace-settings'));

  // 6) chat loading/streaming state against the held fixture stream
  await newChat(page);
  const holdTag = `V${meta.dsf}_${meta.locale}_${theme}H`.replace(/[^A-Za-z0-9_]/g, '');
  fixture.enqueue({ tag: holdTag, size: 8, hold: true });
  await page.fill('#prompt', `视觉审计 loading 状态 ${holdTag}`);
  await page.click('#send');
  await page.waitForFunction(() => {
    const streaming = document.querySelector('#timeline .message.streaming');
    const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
    return !!streaming || bodies.some(b => (b.textContent || '').length > 0);
  }, null, { timeout: 20000 }).catch(() => {});
  shots.push(await state('chat-loading'));
  const holdTask = await waitTask(page, t => (t.name || '').includes(holdTag), 15000, 'hold task').catch(() => null);
  if (holdTask) await bridge(page, 'control', { taskId: holdTask.id, action: 'cancel' }).catch(() => {});
  await sleep(500);

  // 7) chat error state (provider HTTP 500 fixture)
  await newChat(page);
  const errTag = `V${meta.dsf}_${meta.locale}_${theme}E`.replace(/[^A-Za-z0-9_]/g, '');
  fixture.enqueue({ tag: errTag, size: 4, err: 500 });
  await page.fill('#prompt', `视觉审计 error 状态 ${errTag}`);
  await page.click('#send');
  const errTask = await waitTask(page, t => (t.name || '').includes(errTag) && ['failed', 'waiting_approval', 'cancelled', 'completed'].includes(t.status), 30000, 'error task').catch(() => null);
  await sleep(1200);
  // The chat failure notice is rendered by the 2500 ms snapshot reconciliation poll, so wait one
  // poll cycle for it instead of sampling immediately (otherwise a slow poll is misread as "missing").
  const noticeShown = await page.waitForFunction(() => {
    const notice = document.getElementById('chat-notice');
    return !!notice && !notice.hidden && (notice.textContent || '').trim().length > 0;
  }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  // Fallback probe: the app reconciles chat notices on its 2500 ms snapshot poll. If the natural
  // wait missed it, force one poll (same function the timer runs) and re-check; both results are logged.
  let noticeShownAfterPoll = noticeShown;
  if (!noticeShown) {
    await page.evaluate(async () => { try { if (typeof poll === 'function') await poll(); } catch { /* ignore */ } });
    await sleep(500);
    noticeShownAfterPoll = await page.evaluate(() => {
      const notice = document.getElementById('chat-notice');
      return !!notice && !notice.hidden && (notice.textContent || '').trim().length > 0;
    });
  }
  log('shot', `chat-error task_status=${errTask?.status || 'unknown'} notice_shown=${noticeShown} notice_shown_after_forced_poll=${noticeShownAfterPoll}`);
  const errorShot = await state('chat-error');
  { const e = errorShot.checks.error; log('probe', `chat-error noticeHidden=${e.chatNoticeHidden} textLen=${e.chatNoticeRawLen} reviewNoticeTask=${e.reviewNoticeTask} failedNoticeTask=${e.failedNoticeTask} chatNoticeState=${JSON.stringify(e.chatNoticeState)?.slice(0, 120)} steps=${JSON.stringify(e.selectedSteps)?.slice(0, 400)}`); }
  shots.push(errorShot);

  // Guarded lifecycle (P2 fix verification): enqueue a success plan for the retry, re-run the interrupted
  // model step via the same approval RPC the evidence UI Retry button uses, then verify the review notice
  // clears once the task leaves waiting_approval (Lead's stale-notice lifecycle guard). Recorded per launch.
  let noticeGuard = { attempted: false };
  try {
    fixture.plans.length = 0;
    fixture.enqueue({ tag: 'GUARD1', size: 40 });
    const approval = await page.evaluate(async () => {
      try {
        const task = (S?.snapshot?.tasks || []).find(item => item && item.id === S.selectedTaskId);
        const step = (task?.steps || []).find(item => item && item.status === 'waiting_approval');
        if (!task || !step) return { ok: false, reason: 'no waiting_approval step in snapshot' };
        await window.suwen.call('approval', { taskId: task.id, stepId: step.id, version: task.version, decision: { action: 'retry' } });
        return { ok: true, taskId: task.id, stepId: step.id, version: task.version };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    });
    const cleared = await page.waitForFunction(() => {
      const notice = document.getElementById('chat-notice');
      return !!notice && notice.hidden === true;
    }, null, { timeout: 90000 }).then(() => true).catch(() => false);
    const after = await page.evaluate(() => {
      const notice = document.getElementById('chat-notice');
      const task = (S?.snapshot?.tasks || []).find(item => item && item.id === S.selectedTaskId);
      return {
        hidden: notice ? notice.hidden : null,
        textLen: (notice?.textContent || '').length,
        chatNotice: S?.chatNotice || null,
        status: task ? task.status : null,
      };
    });
    noticeGuard = {
      attempted: approval.ok === true,
      approval,
      cleared,
      after,
      pass: approval.ok === true && cleared && !!after.status && after.status !== 'waiting_approval',
    };
  } catch (error) {
    noticeGuard = { attempted: true, pass: false, error: String(error && error.message ? error.message : error) };
  }
  log('probe', `notice-guard pass=${noticeGuard.pass} status_after=${noticeGuard.after?.status || 'n/a'} hidden_after=${noticeGuard.after?.hidden} cleared=${noticeGuard.cleared}`);
  errorShot.noticeGuard = noticeGuard;

  // 8) evidence panel (chat page, task selected)
  await showPage(page, 'chat');
  await ensureEvidence(page, ids.echoTaskId);
  shots.push(await state('evidence-panel'));

  // 9) chat with error task still visible + evidence closed (final chat workspace state)
  await page.evaluate(() => { try { if (typeof closeEvidence === 'function') closeEvidence(); } catch { /* ignore */ } });
  await sleep(300);
  shots.push(await state('chat-workspace'));

  return shots;
}

/* ------------------------------------------------------------------ */
/* Programmatic findings from captured checks                          */
/* ------------------------------------------------------------------ */
function findingsFor(shots) {
  const findings = [];
  for (const shot of shots) {
    const c = shot.checks;
    if ((c.documentOverflow?.x ?? 0) > 1) {
      findings.push({ severity: 'P1', area: 'overflow', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `document horizontal overflow ${c.documentOverflow.x}px` });
    }
    if ((c.documentOverflow?.bodyX ?? 0) > 1) {
      findings.push({ severity: 'P1', area: 'overflow', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `body horizontal overflow ${c.documentOverflow.bodyX}px` });
    }
    for (const item of c.horizontalOverflow || []) {
      findings.push({ severity: 'P2', area: 'internal-horizontal-overflow', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `${item.element} scrollWidth-clientWidth=${item.dx}px` });
    }
    for (const item of c.outside || []) {
      findings.push({ severity: 'P1', area: 'outside-viewport', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `${item.element} rect=${JSON.stringify(item.rect)} viewport=${JSON.stringify(c.viewport)}` });
    }
    for (const item of c.overlaps || []) {
      findings.push({ severity: 'P1', area: 'overlap', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `${item.pair} overlap area ${item.areaPx}px²` });
    }
    const expectedPage = { 'chat-empty': 'chat', 'workspace-projects': 'projects', 'workspace-tasks': 'tasks', 'workspace-tools': 'tools', 'workspace-settings': 'settings', 'chat-loading': 'chat', 'chat-error': 'chat', 'evidence-panel': 'chat', 'chat-workspace': 'chat' }[shot.state];
    if (expectedPage && !(c.activePages || []).includes(expectedPage)) {
      findings.push({ severity: 'P1', area: 'navigation', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `expected page ${expectedPage}, visible=${JSON.stringify(c.activePages)}` });
    }
    if (shot.state === 'evidence-panel' && !c.evidence?.open) {
      findings.push({ severity: 'P2', area: 'evidence', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: 'evidence aside did not open / stayed hidden' });
    }
    if (shot.state === 'chat-loading' && !(c.streaming?.bubble || c.assistantTextLen > 0)) {
      findings.push({ severity: 'P2', area: 'loading-state', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: 'no streaming indicator or streamed text observed for the held fixture stream' });
    }
    if (shot.state === 'chat-error' && !(c.error?.bannerVisible || c.error?.chatNoticeVisible)) {
      const status = c.error?.selectedTask?.status || 'unknown';
      findings.push({ severity: 'P2', area: 'error-state', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `selected chat task ended "${status}" (provider HTTP 500 fixture) but neither #error nor #chat-notice was visible (chat-notice hidden=${c.error?.chatNoticeHidden}, text length=${(c.error?.chatNoticeText || '').length})` });
    }
    if (shot.noticeGuard?.attempted && shot.noticeGuard.pass === false) {
      const g = shot.noticeGuard;
      findings.push({ severity: 'P2', area: 'error-state-lifecycle', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `review notice not cleared after retry left waiting_approval (approval=${JSON.stringify(g.approval).slice(0, 160)}, cleared=${g.cleared}, status_after=${g.after?.status || 'unknown'}, hidden_after=${g.after?.hidden}, textLen_after=${g.after?.textLen ?? 'n/a'})` });
    }
    if (shot.png && c.viewport) {
      const expected = { w: Math.round(c.viewport.innerWidth * c.viewport.dpr), h: Math.round(c.viewport.innerHeight * c.viewport.dpr) };
      if (Math.abs(shot.png.width - expected.w) > 2 || Math.abs(shot.png.height - expected.h) > 2) {
        findings.push({ severity: 'P2', area: 'screenshot-scaling', state: shot.state, theme: shot.theme, locale: shot.locale, dsf: shot.dsf, evidence: shot.file, detail: `png ${shot.png.width}x${shot.png.height} vs viewport*dpr ${expected.w}x${expected.h}` });
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
const report = {
  schema: 'suwen-ui-visual-audit/v1',
  label: 'deterministic local fixture (no real vendor API calls)',
  stamp,
  startedAt: nowIso(),
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()} (${os.version?.() || ''})`,
    osBuild: os.version?.() || null,
    cpu: os.cpus()?.[0]?.model || null,
    cpuCount: os.cpus()?.length || null,
    totalMemGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    hostArch: process.arch,
    electronBinary: ELECTRON,
    electronPackage: JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
    playwrightCore: JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version,
    appVersion: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    uiHashes: {
      'ui/app.js': sha256(readFileSync(path.join(ROOT, 'ui', 'app.js'))),
      'ui/index.html': sha256(readFileSync(path.join(ROOT, 'ui', 'index.html'))),
      'ui/style.css': sha256(readFileSync(path.join(ROOT, 'ui', 'style.css'))),
    },
    screenshotsDir: OUT_DIR,
  },
  launches: [],
  screenshots: [],
  findings: [],
  limitations: [
    'Deterministic local OpenAI-SSE fixture only; no real vendor API, network, or credential was used.',
    'Screenshots are viewport-only (visible window content), not full-page captures.',
    'Contrast/accessibility compliance was NOT measured; computed colors were recorded as raw observations only.',
    'Device scale factor is forced per launch via --force-device-scale-factor; window content size adapts to the work area.',
  ],
  phaseLog,
};
let exitCode = 0;
const hardStop = setTimeout(() => {
  console.error('[FATAL] visual audit exceeded 20 minutes; aborting and cleaning up');
  cleanupAndExit(124);
}, 20 * 60 * 1000);

async function cleanupAndExit(code) {
  try { clearTimeout(hardStop); } catch { /* ignore */ }
  if (activeApp) {
    const app = activeApp;
    activeApp = null;
    try {
      const pid = app.process?.()?.pid;
      await Promise.race([app.close(), sleep(8000)]);
      if (pid) await killPid(pid);
    } catch { /* ignore */ }
  }
  try { await fixture.close(); } catch { /* ignore */ }
  try { writeFileSync(path.join(REPORT_DIR, `ui-visual-audit-${stamp}.json`), JSON.stringify(report, null, 2)); } catch (error) { console.error('[FATAL] report write failed', error); }
  console.log(`[${new Date().toLocaleTimeString('en-GB')}] cleanup    electron/fixture cleanup attempted; report=${path.join(REPORT_DIR, `ui-visual-audit-${stamp}.json`)}`);
  process.exit(code);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });
  log('env', `node ${process.version} electron ${report.environment.electronPackage} playwright ${report.environment.playwrightCore} app ${report.environment.appVersion}`);
  log('env', `${report.environment.platform} / ${report.environment.cpu} / ${report.environment.totalMemGiB}GiB`);
  await fixture.start();
  log('fixture', `listening ${fixture.baseUrl()} (deterministic local fixture)`);

  for (const size of SIZES) {
    for (const dsf of DSFS) {
      for (const locale of LOCALES) {
        for (const theme of THEMES) {
          if (theme === 'dark' && !THEMES.includes('dark')) continue;
          const profile = mkdtempSync(path.join(os.tmpdir(), 'suwen-visual-'));
          log('launch', `size=${size.label} dsf=${dsf} locale=${locale} theme=${theme} profile=${profile}`);
          let launch = null;
          try {
            launch = await launchElectron({ dsf, locale, profile, size });
            const { app, page, boot, sizing } = launch;
            await waitDaemon(page);
            const configured = await configureModel(page);
            if (!configured.ok) throw new Error(`configure failed: ${configured.error}`);
            await ensureLocale(page, locale);
            if (theme === 'dark') {
              const applied = await applyTheme(page, 'dark');
              if (!applied.ok || applied.theme !== 'dark') throw new Error(`dark theme did not apply: ${JSON.stringify(applied)}`);
            } else {
              const applied = await applyTheme(page, 'light');
              if (!applied.ok || applied.theme !== 'light') throw new Error(`light theme did not apply: ${JSON.stringify(applied)}`);
            }
            const dpr = await page.evaluate(() => window.devicePixelRatio);
            const ids = await buildTasks(page, `${size.label}_${dsf}_${locale}_${theme}`.replace(/[^A-Za-z0-9_]/g, ''));
            const meta = { dsf, locale, theme, size: size.label };
            const shots = await captureAllStates(page, meta, theme, { echoTaskId: ids.echoTask.id });
            report.screenshots.push(...shots);
            report.launches.push({
              size: size.label, dsf, locale, theme, profile, dpr,
              boot, sizing,
            emulateMediaDark: await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches),
            finalTheme: await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), mode: document.documentElement.getAttribute('data-theme-mode'), stored: (() => { try { return localStorage.getItem('suwen.theme'); } catch { return null; } })() })),
            shots: shots.length,
            fixtureRequests: fixture.requests.length,
          });
          report.findings = findingsFor(report.screenshots);
          log('launch', `done size=${size.label} dsf=${dsf} ${locale} ${theme} shots=${shots.length} findings=${report.findings.length}`);
        } catch (error) {
          exitCode = 1;
          log('launch', `FAILED size=${size.label} dsf=${dsf} ${locale} ${theme}: ${error?.stack || error}`);
          report.launches.push({ size: size.label, dsf, locale, theme, profile, error: String(error?.message || error), stack: String(error?.stack || '').slice(0, 6000) });
        } finally {
          if (launch) {
            const app = launch.app;
            activeApp = null;
            try {
              const pid = app.process?.()?.pid;
              await Promise.race([app.close(), sleep(8000)]);
              if (pid) await killPid(pid);
            } catch { /* ignore */ }
          }
        }
      }
    }
  }
  }

  report.findings = findingsFor(report.screenshots);
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  report.environmentMatrix = { sizes: SIZES.map(s => s.label), dsf: DSFS, locales: LOCALES, themes: THEMES, states: 9, expectedScreenshots: SIZES.length * DSFS.length * LOCALES.length * THEMES.length * 9 };
  report.coverage = {
    screenshots: report.screenshots.length,
    expected: report.environmentMatrix.expectedScreenshots,
    bySize: Object.fromEntries(SIZES.map(s => [s.label, report.screenshots.filter(x => x.size === s.label).length])),
    byTheme: Object.fromEntries(THEMES.map(t => [t, report.screenshots.filter(s => s.theme === t).length])),
    byLocale: Object.fromEntries(LOCALES.map(l => [l, report.screenshots.filter(s => s.locale === l).length])),
    byDsf: Object.fromEntries(DSFS.map(d => [d, report.screenshots.filter(s => s.dsf === d).length])),
    darkThemeImplemented: report.screenshots.some(s => s.theme === 'dark' && s.checks?.theme?.attr === 'dark'),
  };
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - Date.parse(report.startedAt);
  if (pageErrors.length) {
    for (const error of pageErrors) {
      report.findings.push({ severity: 'P1', area: 'page-error', state: 'runtime', theme: null, locale: error.locale, dsf: error.dsf, evidence: 'pageerror', detail: error.message.slice(0, 500) });
    }
  }
  const dedup = new Map();
  for (const finding of report.findings) {
    const key = `${finding.severity}|${finding.area}|${finding.detail}`;
    if (!dedup.has(key)) dedup.set(key, finding);
  }
  report.findings = [...dedup.values()].sort((a, b) => String(a.severity).localeCompare(String(b.severity)));

  console.log('\n=== VISUAL AUDIT SUMMARY (deterministic local fixture) ===');
  console.log(`screenshots: ${report.coverage.screenshots}/${report.coverage.expected} byTheme=${JSON.stringify(report.coverage.byTheme)} byLocale=${JSON.stringify(report.coverage.byLocale)} byDsf=${JSON.stringify(report.coverage.byDsf)} dark=${report.coverage.darkThemeImplemented}`);
  const counts = report.findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  console.log(`findings: ${JSON.stringify(counts)}`);
  for (const finding of report.findings.slice(0, 40)) console.log(`  ${finding.severity} ${finding.area} ${finding.state || ''} ${finding.detail}`);
  console.log(`pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length}`);
  await cleanupAndExit(exitCode);
}

main().catch(async (error) => {
  console.error('[FATAL]', error?.stack || error);
  report.fatal = String(error?.stack || error);
  await cleanupAndExit(1);
});
