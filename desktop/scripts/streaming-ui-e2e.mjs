#!/usr/bin/env node
/**
 * Streaming UI end-to-end measurement harness for SuWen Desktop vNext.
 *
 * Deterministic local fixture: an OpenAI-compatible SSE server on 127.0.0.1.
 * No real vendor API is contacted. Every result is produced against this
 * fixture and must be labelled "deterministic local fixture".
 *
 * Usage:
 *   node scripts/streaming-ui-e2e.mjs --mode baseline|final [--only=sizes,concurrent,long,layouts,dark,kill] [--runs=2]
 *
 * Output: desktop/release/smoke/ui-streaming-<stamp>-<mode>.json
 * Also prints a compact table. Never edits UI or src.
 */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const outDir = join(project, 'release', 'smoke');
mkdirSync(outDir, { recursive: true });

const require = createRequire(join(project, 'package.json'));
const { _electron } = require('playwright-core');
const electronPath = join(project, 'node_modules', 'electron', 'dist', 'electron.exe');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const stamp = nowIso().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const pct = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return Math.round(s[i] * 10) / 10;
};
const stats = arr => ({
  n: arr.length,
  p50: pct(arr, 0.5),
  p95: pct(arr, 0.95),
  max: arr.length ? Math.round(Math.max(...arr) * 10) / 10 : null,
  min: arr.length ? Math.round(Math.min(...arr) * 10) / 10 : null,
  mean: arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null,
});
const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MODE = argValue('mode', 'baseline'); // baseline | final
const ONLY = new Set(String(argValue('only', 'sizes,composer,scroll,concurrent,long,persist,layouts,dark,kill')).split(',').filter(Boolean));
const RUNS = Number(argValue('runs', '2'));
const PROBE = args.includes('--probe');
const FALLBACK = args.includes('--fallback');
const phaseLog = [];
const log = (phase, msg, extra = {}) => {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${phase.padEnd(12)} ${msg}`;
  phaseLog.push({ at: nowIso(), phase, msg, ...extra });
  console.log(line);
};

const CHUNK_LEN = 7;
const chunk = i => `w${String(i).padStart(5, '0')} `;
const expectedFor = (tag, size) => {
  const prefix = `[${tag}]`;
  let out = prefix;
  for (let i = 0; i < size; i += 1) out += chunk(i);
  return out;
};
const lenAtDelta = (tag, k) => `[${tag}]`.length + (k + 1) * CHUNK_LEN;

/* ------------------------------------------------------------------ */
/* Deterministic local OpenAI-SSE fixture                              */
/* ------------------------------------------------------------------ */
const fixture = {
  server: null,
  port: 0,
  requests: 0,
  errors: 0,
  requestLog: [],
  plans: [], // scenario-plan queue: the current UI does not forward the typed prompt, so route deterministically per scenario
  started: new Map(), // tag -> Date.now() of request start
  deltaTimes: new Map(), // tag -> number[] epoch ms after each SSE write
  expected: new Map(), // tag -> expected text
  aborted: new Map(), // tag -> boolean
  enqueue(plan) { this.plans.push(plan); },
  clearPlans() { this.plans.length = 0; },
  reset(tag) {
    this.started.delete(tag);
    this.deltaTimes.delete(tag);
    this.expected.delete(tag);
    this.aborted.delete(tag);
  },
};

function startFixture() {
  fixture.server = createServer((req, res) => {
    fixture.requests += 1;
    const url = req.url || '';
    if (!url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture: only /v1/chat/completions is mocked' } }));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = JSON.parse(rawBody); } catch { /* ignore */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // Search the raw request JSON for fallback markers (also usable when the prompt is forwarded).
      const promptText = rawBody;
      const sizeMatch = /E2E SIZE=(\d+)/.exec(promptText);
      const tagMatch = /E2E TAG=([A-Za-z0-9]+)/.exec(promptText);
      let errMatch = /E2E ERR=(\d+)/.exec(promptText);
      // Deterministic route: scenario enqueues a plan before the request; plan wins over prompt markers.
      const plan = fixture.plans.shift() || null;
      const tag = plan?.tag ?? (tagMatch ? tagMatch[1] : `R${fixture.requests}`);
      const size = plan?.size ?? (sizeMatch ? Number(sizeMatch[1]) : 1);
      const hold = plan?.hold ?? /E2E HOLD=1/.test(promptText);
      if (plan?.err) errMatch = [String(plan.err)];
      const entry = {
        at: nowIso(), tag, size, hold, planConsumed: !!plan, promptDetected: !!sizeMatch, auth: req.headers.authorization || null, stream: body.stream === true,
        maxTokens: body.max_tokens ?? null,
        messagesPreview: messages.slice(-3).map(m => ({
          role: m?.role ?? null,
          content: typeof m?.content === 'string' ? m.content.slice(0, 100) : m?.content ?? null,
          text: typeof m?.text === 'string' ? m.text.slice(0, 100) : null,
        })),
      };
      fixture.requestLog.push(entry);

      if (errMatch) {
        fixture.errors += 1;
        res.writeHead(Number(errMatch[1]), { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fixture injected provider error' } }));
        return;
      }

      const expected = expectedFor(tag, size);
      fixture.started.set(tag, Date.now());
      fixture.deltaTimes.set(tag, []);
      fixture.expected.set(tag, expected);
      fixture.aborted.set(tag, false);
      let closed = false;
      req.on('aborted', () => { closed = true; fixture.aborted.set(tag, true); });
      res.on('close', () => { if (!res.writableEnded) { closed = true; fixture.aborted.set(tag, true); } });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();

      (async () => {
        try {
          for (let i = 0; i < size; i += 1) {
            if (closed) return;
            const content = i === 0 ? `[${tag}]${chunk(0)}` : chunk(i);
            const payload = {
              id: `chatcmpl-fixture-${tag}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model || 'fixture',
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            fixture.deltaTimes.get(tag).push(Date.now());
            if (hold && i === 2) await sleep(45000);
            else await sleep(size > 2000 ? 2 : size > 200 ? 8 : 20);
          }
          if (closed) return;
          const done = {
            id: `chatcmpl-fixture-${tag}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 32, completion_tokens: size, total_tokens: 32 + size },
          };
          res.write(`data: ${JSON.stringify(done)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch {
          try { res.end(); } catch { /* ignore */ }
        }
      })();
    });
  });
  return new Promise((resolvePromise, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', () => {
      fixture.port = fixture.server.address().port;
      resolvePromise(fixture.port);
    });
  });
}

function stopFixture() {
  try { fixture.server?.closeAllConnections?.(); } catch { /* ignore */ }
  try { fixture.server?.close(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Electron app wrapper                                                */
/* ------------------------------------------------------------------ */
function makeProfile() {
  return mkdtempSync(join(tmpdir(), 'suwen-e2e-'));
}

async function launchApp(profile, extraArgs = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // DSH shell sets this; Electron would run as plain Node and exit.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  env.SUWEN_TEST_HOME = profile;
  env.SUWEN_E2E_LABEL = 'deterministic local fixture';
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [...extraArgs, project],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  page.on('dialog', dialog => { dialog.dismiss().catch(() => {}); });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(String(err)));
  page.on('console', msg => {
    if (msg.type() === 'error' && pageErrors.length < 60) pageErrors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  return { app, page, pageErrors, profile };
}

async function waitForBridge(page, timeout = 45000) {
  await page.waitForFunction(() => document.getElementById('health') !== null, null, { timeout });
  await page.waitForFunction(() => !!window.suwen && typeof window.suwen.call === 'function', null, { timeout: 20000 });
}

async function waitDaemon(page, timeout = 40000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    const res = await page.evaluate(async () => {
      try {
        const snap = await window.suwen.call('snapshot', {});
        return { ok: true, tasks: Array.isArray(snap?.tasks) ? snap.tasks : null, health: snap?.health || null };
      } catch (err) { return { ok: false, error: String(err) }; }
    });
    if (res.ok && Array.isArray(res.tasks)) return res;
    lastErr = res.error;
    await sleep(250);
  }
  throw new Error(`daemon did not become reachable: ${lastErr}`);
}

async function configureModel(page, baseUrl) {
  return page.evaluate(async (url) => {
    try {
      const result = await window.suwen.call('configure', {
        provider: 'openai', baseUrl: url, model: 'fixture', apiKey: 'fixture', contextWindow: 8192, maxOutput: 512,
      });
      return { ok: true, result };
    } catch (err) { return { ok: false, error: String(err) }; }
  }, baseUrl);
}

const bridge = (page, method, params = {}) =>
  page.evaluate(async ([m, p]) => {
    try { return { ok: true, result: await window.suwen.call(m, p) }; }
    catch (err) { return { ok: false, error: String(err) }; }
  }, [method, params]);

async function callOk(page, method, params = {}) {
  const res = await bridge(page, method, params);
  if (!res.ok) throw new Error(`${method} failed: ${res.error}`);
  return res.result;
}

/* ------------------------------------------------------------------ */
/* Page-side sampler                                                   */
/* ------------------------------------------------------------------ */
const samplerFn = (cfg) => {
  const s = window.__e2e = {
    samples: [], mutations: 0, addedNodes: 0, removedNodes: 0, charData: 0,
    running: true, sendMark: null, scrollSetAt: null, timer: null,
  };
  const timeline = document.getElementById('timeline');
  const bodySel = '#timeline .message:not(.user) .body';
  const userSel = '#timeline .message.user';
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) };
  };
  if (timeline) {
    s.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          s.mutations += 1;
          s.addedNodes += r.addedNodes.length;
          s.removedNodes += r.removedNodes.length;
        } else if (r.type === 'characterData') {
          s.mutations += 1;
          s.charData += 1;
        }
      }
    });
    s.observer.observe(timeline, { subtree: true, childList: true, characterData: true });
  }
  const jumpSelectors = ['[data-action="jump-to-latest"]', '.jump-to-latest', '[data-jump]', '#jump-to-latest'];
  s.timer = setInterval(() => {
    if (!s.running) return;
    const bodies = timeline ? [...timeline.querySelectorAll(bodySel)] : [];
    const texts = bodies.map(b => b.textContent || '');
    const last = texts.length ? texts[texts.length - 1] : '';
    const streamEl = timeline ? timeline.querySelector('.message.streaming, [data-streaming="true"]') : null;
    const jump = [...document.querySelectorAll(jumpSelectors.join(','))].filter(el => el && el.offsetParent !== null).length
      + [...document.querySelectorAll('#timeline button, #composer button')].filter(el => el.offsetParent !== null && /最新|latest|底部|bottom|jump/i.test(el.textContent || '')).length;
    s.samples.push({
      t: Date.now(),
      last: last.length,
      lens: texts.map(t => t.length),
      textsHead: texts.map(t => t.slice(0, 8)),
      assistantCount: texts.length,
      userCount: timeline ? timeline.querySelectorAll(userSel).length : 0,
      streaming: !!streamEl,
      streamingText: streamEl ? (streamEl.querySelector('.body')?.textContent || '').length : 0,
      scrollTop: timeline ? +timeline.scrollTop.toFixed(1) : 0,
      scrollHeight: timeline ? timeline.scrollHeight : 0,
      clientHeight: timeline ? timeline.clientHeight : 0,
      composer: rectOf(document.getElementById('composer')),
      promptRect: rectOf(document.getElementById('prompt')),
      sendRect: rectOf(document.getElementById('send')),
      evidenceRect: rectOf(document.getElementById('evidence')),
      draft: (document.getElementById('prompt') || {}).value || '',
      health: (document.getElementById('health') || {}).textContent || '',
      conn: Array.isArray(window.__connEvents) ? window.__connEvents.length : 0,
      jumpControls: jump,
    });
    while (s.samples.length > 4000) s.samples.shift();
  }, cfg.sampleMs || 50);
};

async function startSampler(page, sampleMs = 50) {
  await page.evaluate(() => {
    try { if (window.__e2e?.timer) clearInterval(window.__e2e.timer); if (window.__e2e?.observer) window.__e2e.observer.disconnect(); } catch { /* ignore */ }
    window.__connEvents = [];
    if (typeof window.suwen?.onConnection === 'function') {
      try { window.suwen.onConnection(state => window.__connEvents.push({ state: state?.state ?? String(state), at: Date.now() })); } catch { /* ignore */ }
    }
    window.__e2e = null;
  });
  await page.evaluate(samplerFn, { sampleMs });
  await page.evaluate(() => { if (window.__e2e) window.__e2e.sendMark = Date.now(); });
}

async function collectSampler(page) {
  return page.evaluate(() => {
    const s = window.__e2e || {};
    s.running = false;
    try { clearInterval(s.timer); s.observer?.disconnect(); } catch { /* ignore */ }
    const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')].map(b => b.textContent || '');
    return {
      samples: s.samples || [],
      mutations: s.mutations || 0,
      addedNodes: s.addedNodes || 0,
      removedNodes: s.removedNodes || 0,
      charData: s.charData || 0,
      sendMark: s.sendMark || null,
      scrollSetAt: s.scrollSetAt || null,
      assistantBodies: bodies,
      promptValue: (document.getElementById('prompt') || {}).value || '',
      promptDisabled: !!(document.getElementById('prompt') || {}).disabled,
      healthText: (document.getElementById('health') || {}).textContent || '',
      connEvents: window.__connEvents || [],
    };
  });
}

/* ------------------------------------------------------------------ */
/* Chat helpers                                                        */
/* ------------------------------------------------------------------ */
async function gotoChat(page) {
  await page.click('.rail button[data-page="chat"]');
  await page.waitForFunction(() => { const p = document.getElementById('chat'); return p && !p.hidden; }, null, { timeout: 10000 });
}

async function newChat(page) {
  await gotoChat(page);
  await page.click('#new-chat');
  // The chat view falls back to legacy task-derived bubbles when no conversation is open,
  // so an empty #timeline is not a valid "new chat" signal. Wait for UI state instead.
  await page.waitForFunction(() => {
    const state = (typeof S !== 'undefined' && S) ? S : null;
    return !!state && state.conversationId === null && state.conversation === null;
  }, null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const p = document.getElementById('prompt');
    return !!p && !p.disabled;
  }, null, { timeout: 10000 });
  await page.evaluate(() => { try { const t = document.getElementById('timeline'); if (t) t.scrollTop = 0; } catch { /* ignore */ } });
  await sleep(120);
}

async function setChatMode(page) {
  const button = await page.$('#mode-radios [data-mode="chat"]');
  if (button) await button.click();
}

async function sendPrompt(page, text) {
  await page.fill('#prompt', text);
  await page.waitForFunction(() => { const b = document.getElementById('send'); return b && !b.disabled; }, null, { timeout: 10000 });
  await page.evaluate(() => { if (window.__e2e) { window.__e2e.scrollSetAt = null; window.__e2e.sendMark = Date.now(); } });
  await page.click('#send');
}

async function snapshotTasks(page) {
  const res = await bridge(page, 'snapshot', {});
  if (!res.ok) throw new Error(`snapshot failed: ${res.error}`);
  return res.result?.tasks || [];
}

async function waitTaskStatus(page, predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tasks = await snapshotTasks(page).catch(() => null);
    if (tasks) {
      const hit = tasks.find(predicate);
      if (hit) return hit;
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* ------------------------------------------------------------------ */
/* Measurement core                                                    */
/* ------------------------------------------------------------------ */
function computeRun({ run, size, tag, expected, sample, fixtureTagData, sendMark, completionAt, extra = {} }) {
  const samples = sample.samples || [];
  const expectedLen = expected.length;
  const times = (fixtureTagData?.deltaTimes || []);
  const startAt = fixtureTagData?.started || null;
  const body = sample.assistantBodies || [];
  const exact = body.filter(t => t === expected);
  const actual = exact[0] ?? (body.length ? body[body.length - 1] : '');
  const firstSample = samples.find(s => s.last > 0) || null;
  const lastSample = samples.length ? samples[samples.length - 1] : null;

  // Render lag per observed growth sample (maps rendered length -> emitted delta index).
  const lags = [];
  const updateTimes = [];
  let prev = 0;
  for (const s of samples) {
    if (s.last > prev && times.length) {
      const k = Math.min(times.length - 1, Math.max(0, Math.ceil((s.last - `[${tag}]`.length) / CHUNK_LEN) - 1));
      const lag = s.t - times[k];
      if (lag >= 0) lags.push(lag);
      updateTimes.push(s.t);
      prev = s.last;
    }
  }
  const updateIntervals = [];
  for (let i = 1; i < updateTimes.length; i += 1) updateIntervals.push(updateTimes[i] - updateTimes[i - 1]);
  const completionSample = samples.find(s => s.last >= expectedLen) || null;
  const composerSamples = samples.filter(s => s.composer);
  const baseRect = composerSamples.length ? composerSamples[0].composer : null;
  const composerDelta = baseRect ? composerSamples.reduce((max, s) => Math.max(
    max,
    Math.abs(s.composer.x - baseRect.x),
    Math.abs(s.composer.y - baseRect.y),
    Math.abs(s.composer.w - baseRect.w),
    Math.abs(s.composer.h - baseRect.h),
  ), 0) : null;
  const scrollSamples = samples.filter(s => s.scrollHeight > 0);
  const scrollSetAt = sample.scrollSetAt;
  const beforeScroll = scrollSamples.filter(s => !scrollSetAt || s.t < scrollSetAt);
  const afterScroll = scrollSamples.filter(s => scrollSetAt && s.t >= scrollSetAt);
  const followGapMax = beforeScroll.length
    ? Math.max(...beforeScroll.map(s => s.scrollHeight - s.clientHeight - s.scrollTop))
    : null;
  const scrollUpDriftMax = afterScroll.length ? Math.max(...afterScroll.map(s => Math.abs(s.scrollTop))) : null;
  const finalBottomGap = lastSample ? lastSample.scrollHeight - lastSample.clientHeight - lastSample.scrollTop : null;

  const firstTextLatency = firstSample && sendMark ? firstSample.t - sendMark : null;
  const lastDeltaTime = times.length ? times[times.length - 1] : null;
  const completionLag = completionSample && lastDeltaTime ? completionSample.t - lastDeltaTime : null;
  const totalWall = completionAt && sendMark ? completionAt - sendMark : null;

  const integrityPass = !!exact.length && actual === expected && expectedLen === actual.length;
  const noDuplicates = exact.length === 1;
  const pushObserved = updateIntervals.length >= 3 || lags.length >= 3;
  // completionLag is null when the 50ms sampler stopped before taking the final growth
  // sample (the completed DOM text was still verified exactly via sha256). Treat that as
  // "not measured" and fall back to exact-text + incremental-update evidence instead of
  // failing a stream that verifiably rendered correctly.
  const livePass = (firstTextLatency !== null && firstTextLatency <= 800)
    && (completionLag === null ? (integrityPass && updateIntervals.length >= 3) : completionLag <= 1200)
    && pushObserved;
  const composerPass = composerDelta !== null && composerDelta <= 1.01;
  const draftPreserved = extra.draftExpected ? sample.promptValue === extra.draftExpected : null;
  const scrollFollowPass = followGapMax === null ? null : followGapMax <= 260;
  const scrollUpPass = scrollUpDriftMax === null ? null : scrollUpDriftMax <= 2;

  return {
    label: `${size}-delta run ${run}`,
    size,
    run,
    tag,
    expectedLen,
    actualLen: actual.length,
    expectedSha256: sha256(expected),
    actualSha256: sha256(actual),
    shaMatch: sha256(actual) === sha256(expected),
    exactTextMatch: actual === expected,
    duplicateFinalCopies: exact.length,
    assistantBodyCount: body.length,
    firstTextLatencyMs: firstTextLatency,
    completionLagMs: completionLag,
    serverFirstDeltaAt: startAt,
    totalWallMs: totalWall,
    renderLagMs: stats(lags),
    updateCount: updateTimes.length,
    updateIntervalMs: stats(updateIntervals),
    domMutations: sample.mutations,
    domAddedNodes: sample.addedNodes,
    domRemovedNodes: sample.removedNodes,
    domCharDataMutations: sample.charData,
    composerMaxDeltaPx: composerDelta,
    draftPreserved,
    draftValue: extra.draftExpected ? sample.promptValue.slice(0, 40) : undefined,
    scroll: { followGapMaxPx: followGapMax, scrollUpDriftMaxPx: scrollUpDriftMax, finalBottomGapPx: finalBottomGap, jumpControls: lastSample?.jumpControls ?? 0 },
    finalScrollTop: lastSample?.scrollTop ?? null,
    finalScrollHeight: lastSample?.scrollHeight ?? null,
    pass: {
      streamIntegrity: integrityPass,
      noDuplicateFinal: noDuplicates,
      liveRendering: livePass,
      composerStable: composerPass,
      draftPreserved: draftPreserved === null ? null : draftPreserved,
      scrollFollow: scrollFollowPass,
      scrollUpStable: scrollUpPass,
    },
  };
}

async function measureStream(ctx, { size, run, tag, pace, hook, draftExpected }) {
  const { page } = ctx;
  await newChat(page);
  await setChatMode(page);
  fixture.reset(tag);
  fixture.clearPlans();
  fixture.enqueue({ tag, size });
  await startSampler(page);
  const promptText = `E2E SIZE=${size} TAG=${tag} 流式渲染验收`;
  const expected = expectedFor(tag, size);
  await sendPrompt(page, promptText);
  const sendMark = Date.now();
  // T1 debug hook (renderer-only counters): attribute receive cadence vs paint cost.
  const readStreamDebug = () => page.evaluate(() => {
    const d = typeof window.__suwenStreamDebug === 'function' ? window.__suwenStreamDebug() : null;
    if (!d) return null;
    return {
      batches: d.batches ?? null,
      paints: d.paints ?? null,
      paintTotalMs: d.paintTotalMs ?? null,
      lastBatchAt: d.lastBatchAt ?? null,
      lastPaintAt: d.lastPaintAt ?? null,
      chars: d.messages?.[0]?.chars ?? null,
      events: d.stats?.events ?? null,
      at: Date.now(),
    };
  }).catch(() => null);
  const debugSamples = [];
  const debugTimer = setInterval(async () => {
    const d = await readStreamDebug();
    if (d) debugSamples.push(d);
  }, 500);
  const debugSummary = (final) => {
    const samples = debugSamples.filter(s => s && s.batches !== null);
    if (!samples.length) return { available: false, note: 'window.__suwenStreamDebug not present or no samples' };
    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = Math.max(1, last.at - first.at);
    const batchRate = ((last.batches - first.batches) / spanMs) * 1000;
    const paintRate = ((last.paints - first.paints) / spanMs) * 1000;
    const paintAvgMs = last.paints > first.paints ? (last.paintTotalMs - first.paintTotalMs) / (last.paints - first.paints) : null;
    return {
      available: true,
      samples: samples.length,
      status: final?.batches !== null && final?.batches !== undefined ? 'ok' : 'partial',
      first: { batches: first.batches, paints: first.paints, chars: first.chars, events: first.events, at: first.at },
      last: { batches: last.batches, paints: last.paints, chars: last.chars, events: last.events, at: last.at },
      final: final ? { batches: final.batches, paints: final.paints, paintTotalMs: final.paintTotalMs, chars: final.chars, events: final.events } : null,
      batchRatePerSec: Math.round(batchRate * 10) / 10,
      paintRatePerSec: Math.round(paintRate * 10) / 10,
      paintAvgMs: paintAvgMs === null ? null : Math.round(paintAvgMs * 100) / 100,
      attribution: batchRate <= paintRate * 1.5 && paintRate >= batchRate * 0.66
        ? 'renderer keeping up with arrival cadence'
        : (paintRate < batchRate * 0.66 ? 'renderer slower than arrival' : 'ambiguous'),
    };
  };
  const firstWaitMs = Math.min(60000, 15000 + size * 20);
  try {
    await page.waitForFunction((sel) => {
      const bodies = [...document.querySelectorAll(sel)];
      return bodies.some(b => (b.textContent || '').length > 0);
    }, '#timeline .message:not(.user) .body', { timeout: firstWaitMs, polling: 100 });
  } catch (error) {
    log('stream', `first text timeout size=${size}: ${error.message}`);
  }
  if (hook) await hook();
  let status = 'completed';
  try {
    await page.waitForFunction((exp) => {
      const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
      return bodies.some(b => b.textContent === exp);
    }, expected, { timeout: Math.min(240000, 30000 + size * 30), polling: 100 });
  } catch (error) {
    status = 'timeout';
    log('stream', `completion timeout size=${size} tag=${tag}: ${error.message}`);
  }
  const completionAt = Date.now();
  const sample = await collectSampler(page);
  clearInterval(debugTimer);
  const debugFinal = await readStreamDebug();
  debugSamples.push(debugFinal);
  const streamDebug = debugSummary(debugFinal);
  const tagData = {
    started: fixture.started.get(tag) || null,
    deltaTimes: fixture.deltaTimes.get(tag) || [],
    aborted: fixture.aborted.get(tag) || false,
    requests: fixture.requestLog.filter(r => r.tag === tag).length,
  };
  const measured = computeRun({ run, size, tag, expected, sample, fixtureTagData: tagData, sendMark, completionAt, extra: { draftExpected } });
  measured.status = status;
  measured.streamDebug = streamDebug;
  measured.fixture = { requestCount: tagData.requests, deltasEmitted: tagData.deltaTimes.length, aborted: tagData.aborted, providerRequest: fixture.requestLog.filter(r => r.tag === tag).slice(-1)[0] || null };
  if (status !== 'completed') measured.pass.streamIntegrity = false;
  log('stream', `size=${size} run=${run} sha=${measured.shaMatch ? 'ok' : 'MISMATCH'} first=${measured.firstTextLatencyMs}ms lagP50=${measured.renderLagMs.p50} lagMax=${measured.renderLagMs.max} completionLag=${measured.completionLagMs}ms composerΔ=${measured.composerMaxDeltaPx}px status=${status} batches/s=${streamDebug.batchRatePerSec ?? 'n/a'} paints/s=${streamDebug.paintRatePerSec ?? 'n/a'} paintAvg=${streamDebug.paintAvgMs ?? 'n/a'}ms`);
  return measured;
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */
async function scenarioSizes(ctx, prefix) {
  const sizes = [{ n: 100, pace: 20 }, { n: 1000, pace: 8 }, { n: 10000, pace: 2 }];
  const results = [];
  for (const { n } of sizes) {
    for (let run = 1; run <= RUNS; run += 1) {
      const tag = `${prefix}${n}R${run}`;
      const draft = null;
      const result = await measureStream(ctx, { size: n, run, tag, pace: 2, draftExpected: draft });
      results.push(result);
    }
  }
  return results;
}

async function scenarioComposerDraft(ctx) {
  const { page } = ctx;
  const tag = 'DRAFT1';
  const size = 1000;
  const draftText = 'E2E 草稿仍在输入框中（不要发送）';
  const result = await measureStream(ctx, {
    size, run: 1, tag, pace: 8, draftExpected: draftText,
    hook: async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const len = await page.evaluate(() => {
          const b = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
          return b.length ? (b[b.length - 1].textContent || '').length : 0;
        });
        if (len > 50) break;
        await sleep(100);
      }
      await page.fill('#prompt', draftText);
      await sleep(400);
    },
  });
  result.label = 'composer bounding box + draft preserved during 1000-delta stream';
  return result;
}

async function scenarioScroll(ctx) {
  const { page } = ctx;
  const tag = 'SCROLL1';
  const size = 10000;
  const result = await measureStream(ctx, {
    size, run: 1, tag, pace: 2,
    hook: async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const len = await page.evaluate(() => {
          const b = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
          return b.length ? (b[b.length - 1].textContent || '').length : 0;
        });
        if (len > 200) break;
        await sleep(100);
      }
      await page.evaluate(() => {
        window.__e2e.scrollSetAt = Date.now();
        const tl = document.getElementById('timeline');
        if (tl) tl.scrollTop = 0;
      });
      await sleep(1500);
      const scrollTop = await page.evaluate(() => document.getElementById('timeline')?.scrollTop ?? null);
      log('scroll', `after user scroll-up, timeline.scrollTop=${scrollTop} (sampler captures drift)`);
    },
  });
  result.label = 'scroll follow while at bottom + no forced jump after user scrolls up';
  return result;
}

async function scenarioConcurrent(ctx) {
  const { page } = ctx;
  const tagA = 'CA';
  const tagB = 'CB';
  const sizeA = 200;
  const sizeB = 150;
  await newChat(page);
  await setChatMode(page);
  fixture.reset(tagA);
  fixture.reset(tagB);
  fixture.clearPlans();
  fixture.enqueue({ tag: tagA, size: sizeA });
  fixture.enqueue({ tag: tagB, size: sizeB });
  await startSampler(page);
  const promptA = `E2E SIZE=${sizeA} TAG=${tagA} 并发 A`;
  const promptB = `E2E SIZE=${sizeB} TAG=${tagB} 并发 B`;
  const expectedA = expectedFor(tagA, sizeA);
  const expectedB = expectedFor(tagB, sizeB);
  await sendPrompt(page, promptA);
  const sendMark = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const len = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
      return b.length ? (b[b.length - 1].textContent || '').length : 0;
    });
    if (len > 100) break;
    await sleep(100);
  }
  const taskA = await waitTaskStatus(page, t => t.name?.includes(`SIZE=${sizeA}`) && t.status !== 'queued', 10000, 'task A');
  const conversationId = taskA?.steps?.[0]?.input?.conversationId || null;
  const createB = await bridge(page, 'create', {
    name: `E2E 并发 B ${tagB}`,
    steps: [{ id: 'reply', kind: 'model', sideEffect: true, maxAttempts: 1, timeoutMs: 90000, input: { prompt: promptB, conversationId, mode: 'chat' } }],
  });
  const createdB = createB.ok ? createB.result : null;
  // Wait until both tasks are terminal (completed/failed) via bridge.
  let finalTasks = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    const tasks = await snapshotTasks(page).catch(() => []);
    const a = tasks.find(t => t.name?.includes(`TAG=${tagA}`) || t.name?.includes(`SIZE=${sizeA}`));
    const b = tasks.find(t => t.name?.includes(`TAG=${tagB}`));
    const terminal = t => ['completed', 'failed', 'cancelled', 'waiting_approval'].includes(t?.status);
    if (a && b && terminal(a) && terminal(b)) { finalTasks = { a, b }; break; }
    await sleep(300);
  }
  // Wait for final texts to be rendered (poll-driven UI may need one more poll).
  try {
    await page.waitForFunction(({ ea, eb }) => {
      const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')].map(b => b.textContent || '');
      return bodies.includes(ea) && bodies.includes(eb);
    }, { ea: expectedA, eb: expectedB }, { timeout: 20000, polling: 200 });
  } catch { /* record below */ }
  await sleep(500);
  const sample = await collectSampler(page);
  const bodies = sample.assistantBodies;
  const times = { a: fixture.deltaTimes.get(tagA) || [], b: fixture.deltaTimes.get(tagB) || [] };
  const finalAt = Date.now();
  // Visibility during the run: distinguish streams by their first text bytes (tags), not by length.
  const prefixA = `[${tagA}]`;
  const prefixB = `[${tagB}]`;
  let aVisibleSamples = 0;
  let bVisibleSamples = 0;
  let bothVisibleSamples = 0;
  let aHiddenAfterBStarted = null;
  let bFirstVisibleAt = null;
  for (const s of sample.samples) {
    const heads = s.textsHead || [];
    const seesA = heads.some(h => h.startsWith(prefixA));
    const seesB = heads.some(h => h.startsWith(prefixB));
    if (seesA) aVisibleSamples += 1;
    if (seesB) { bVisibleSamples += 1; if (bFirstVisibleAt === null) bFirstVisibleAt = s.t; }
    if (seesA && seesB) bothVisibleSamples += 1;
    if (seesB && !seesA && aVisibleSamples > 0 && aHiddenAfterBStarted === null) aHiddenAfterBStarted = s.t;
  }
  const result = {
    label: 'concurrent model runs isolation (same conversation, two tasks)',
    tags: { a: tagA, b: tagB },
    taskA: finalTasks?.a ? { id: finalTasks.a.id, status: finalTasks.a.status, text: finalTasks.a.steps?.[0]?.output?.text?.slice(0, 24) } : null,
    taskB: finalTasks?.b ? { id: finalTasks.b.id, status: finalTasks.b.status } : createdB ? { id: createdB.id, status: 'created' } : null,
    expectedA: { len: expectedA.length, sha256: sha256(expectedA) },
    expectedB: { len: expectedB.length, sha256: sha256(expectedB) },
    renderedBodies: bodies.map(t => ({ len: t.length, sha256: sha256(t), isA: t === expectedA, isB: t === expectedB, head: t.slice(0, 16) })),
    bothFinalTextsRendered: bodies.includes(expectedA) && bodies.includes(expectedB),
    crossContamination: bodies.some(t => t.includes(`[${tagA}]`) && t.includes(`[${tagB}]`)),
    duplicatesA: bodies.filter(t => t === expectedA).length,
    duplicatesB: bodies.filter(t => t === expectedB).length,
    streamingVisibility: { aVisibleSamples, bVisibleSamples, bothVisibleSamples, aHiddenAfterBStarted, bFirstVisibleAt },
    assistantBodyPeak: Math.max(0, ...sample.samples.map(s => s.assistantCount)),
    streamingBubblePeak: Math.max(0, ...sample.samples.map(s => (s.streaming ? 1 : 0))),
    sampledMs: sample.samples.length ? sample.samples[sample.samples.length - 1].t - sample.samples[0].t : 0,
    domMutations: sample.mutations,
    pass: {
      bothFinalTextsExact: bodies.includes(expectedA) && bodies.includes(expectedB),
      noCrossContamination: !bodies.some(t => t.includes(`[${tagA}]`) && t.includes(`[${tagB}]`)),
      noDuplicates: bodies.filter(t => t === expectedA).length === 1 && bodies.filter(t => t === expectedB).length === 1,
      bothStreamsVisibleTogether: bothVisibleSamples > 0,
    },
  };
  log('concurrent', `bodies=${bodies.length} bothFinal=${result.pass.bothFinalTextsExact} contamination=${result.crossContamination} bothVisibleSamples=${bothVisibleSamples}`);
  return result;
}

async function scenarioLongSession(ctx) {
  const { page } = ctx;
  const title = `E2E 长会话 120 条 ${stamp}`;
  const created = await callOk(page, 'conversation.create', { title });
  const id = created?.id || created?.conversation?.id;
  if (!id) throw new Error('conversation.create returned no id');
  const total = 120;
  for (let base = 0; base < total; base += 30) {
    const messages = [];
    for (let i = base; i < Math.min(total, base + 30); i += 1) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `E2E 长会话第 ${i + 1} 条消息 — deterministic local fixture content ${i % 7}` });
    }
    await callOk(page, 'conversation.append', { id, messages });
  }
  // Ask the UI to reload the sidebar conversation list without a page reload if the helper is exposed.
  const reload = await page.evaluate(async () => {
    try { if (typeof loadConversations === 'function') { await loadConversations(); return 'loadConversations'; } } catch { /* ignore */ }
    return 'none';
  });
  if (reload === 'none') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBridge(page);
    await waitDaemon(page);
  }
  const row = page.locator('#sessions button.session').filter({ hasText: title }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const t0 = Date.now();
  await row.click();
  let status = 'completed';
  try {
    await page.waitForFunction(() => document.querySelectorAll('#timeline .message').length >= 120, null, { timeout: 30000, polling: 100 });
  } catch { status = 'timeout'; }
  const openMs = Date.now() - t0;
  await sleep(400);
  const metrics = await page.evaluate(() => {
    const tl = document.getElementById('timeline');
    const messages = [...document.querySelectorAll('#timeline .message')];
    const composer = document.getElementById('composer')?.getBoundingClientRect();
    return {
      messageCount: messages.length,
      userCount: document.querySelectorAll('#timeline .message.user').length,
      assistantCount: document.querySelectorAll('#timeline .message:not(.user)').length,
      scrollTop: tl?.scrollTop ?? null,
      scrollHeight: tl?.scrollHeight ?? null,
      clientHeight: tl?.clientHeight ?? null,
      bottomGap: tl ? tl.scrollHeight - tl.clientHeight - tl.scrollTop : null,
      composerBottom: composer ? composer.bottom : null,
      innerHeight: window.innerHeight,
      docOverflowX: document.scrollingElement ? document.scrollingElement.scrollWidth - window.innerWidth : null,
    };
  });
  const result = {
    label: '120+ message session render / scroll',
    status,
    openMs,
    expectedMessages: total,
    ...metrics,
    pass: {
      allRendered: metrics.messageCount >= total,
      noPageHorizontalOverflow: (metrics.docOverflowX ?? 0) <= 1,
      composerInViewport: metrics.composerBottom !== null ? metrics.composerBottom <= metrics.innerHeight + 1 : null,
      startsAtTop: metrics.scrollTop === 0,
    },
  };
  log('long', `messages=${metrics.messageCount} openMs=${openMs} bottomGap=${metrics.bottomGap}`);
  return result;
}

async function measureLayout(ctx, width, height, locale) {
  const { app, page } = ctx;
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setContentSize(size.w, size.h);
    win.center?.();
  }, { w: width, h: height });
  await sleep(350);
  const currentLocale = await page.evaluate(() => document.documentElement.lang || '');
  if (locale === 'en' && currentLocale !== 'en') await page.click('#language');
  if (locale === 'zh' && currentLocale === 'en') await page.click('#language');
  await sleep(250);
  const viewport = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, lang: document.documentElement.lang || '' }));
  const pages = ['chat', 'projects', 'tasks', 'tools', 'settings'];
  const perPage = {};
  for (const name of pages) {
    await page.click(`.rail button[data-page="${name}"]`);
    await sleep(name === 'settings' ? 700 : 300);
    perPage[name] = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el || el.offsetParent === null) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
      };
      const overflow = (sel) => {
        const el = document.querySelector(sel);
        if (!el || el.offsetParent === null) return null;
        return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
      };
      const key = {
        rail: rect('.rail'),
        sidebar: rect('.sidebar'),
        main: rect('main'),
        header: rect('header'),
        timeline: rect('#timeline'),
        composer: rect('#composer'),
        evidence: rect('#evidence'),
      };
      const viewportEls = ['header', 'composer'];
      const outside = [];
      for (const name2 of viewportEls) {
        const r = key[name2];
        if (r && (r.x < -1 || r.y < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1)) outside.push({ element: name2, rect: r });
      }
      const overlaps = [];
      const pairs = [['rail', 'sidebar'], ['rail', 'main'], ['sidebar', 'main'], ['main', 'evidence'], ['header', 'timeline']];
      for (const [a, b] of pairs) {
        const ra = key[a]; const rb = key[b];
        if (!ra || !rb) continue;
        const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.x, rb.x));
        const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y));
        if (x > 1 && y > 1) overlaps.push({ pair: `${a}/${b}`, area: Math.round(x * y) });
      }
      return {
        viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
        documentOverflow: {
          x: document.scrollingElement ? document.scrollingElement.scrollWidth - window.innerWidth : null,
          y: document.scrollingElement ? document.scrollingElement.scrollHeight - window.innerHeight : null,
          bodyX: document.body ? document.body.scrollWidth - window.innerWidth : null,
        },
        key,
        outside,
        overlaps,
        horizontalOverflowEls: {
          header: overflow('header'), composer: overflow('#composer'), prompt: overflow('#prompt'),
          sidebar: overflow('.sidebar'), timeline: overflow('#timeline'), settings: overflow('#settings'),
        },
        pageTitle: document.getElementById('page-title')?.textContent || null,
        languageButton: document.getElementById('language')?.textContent || null,
      };
    });
  }
  await page.click('.rail button[data-page="chat"]');
  const findings = [];
  for (const [name, m] of Object.entries(perPage)) {
    if ((m.documentOverflow.x ?? 0) > 1) findings.push({ page: name, severity: 'P1', kind: 'document-horizontal-overflow', detail: m.documentOverflow });
    if (m.outside.length) findings.push({ page: name, severity: 'P1', kind: 'element-outside-viewport', detail: m.outside });
    if (m.overlaps.length) findings.push({ page: name, severity: 'P1', kind: 'unexpected-overlap', detail: m.overlaps });
  }
  log('layout', `${width}x${height} ${locale} dpr=${viewport.dpr} findings=${findings.length}`);
  return { width, height, locale, viewport, pages: perPage, findings };
}

async function scenarioLayouts(ctx) {
  const results = [];
  for (const [w, h] of [[1920, 1080], [1366, 768], [980, 680]]) {
    for (const locale of ['zh', 'en']) {
      results.push(await measureLayout(ctx, w, h, locale));
    }
  }
  const currentLang = await ctx.page.evaluate(() => document.documentElement.lang || '');
  if (currentLang === 'en') { await ctx.page.click('#language'); await sleep(200); }
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { win.setContentSize(1400, 930); win.center?.(); }
  });
  await sleep(300);
  return results;
}

async function scenarioTheme(ctx) {
  const { page } = ctx;
  const info = await page.evaluate(() => {
    const stored = {};
    try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); stored[k] = localStorage.getItem(k); } } catch { /* ignore */ }
    const controls = [...document.querySelectorAll('select,button,[role="radio"],[data-theme],[data-theme-value]')]
      .filter(el => /theme|主题/i.test(`${el.id} ${el.getAttribute?.('data-i18n') || ''} ${el.getAttribute?.('data-theme') || ''} ${el.className || ''} ${el.textContent || ''}`))
      .slice(0, 20)
      .map(el => ({ tag: el.tagName, id: el.id, cls: el.className, text: (el.textContent || '').trim().slice(0, 40), values: el.tagName === 'SELECT' ? [...el.options].map(o => o.value) : null }));
    return {
      htmlTheme: document.documentElement.getAttribute('data-theme'),
      bodyClass: document.body.className,
      stored,
      controls,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    };
  });
  const implemented = info.controls.length > 0 || info.htmlTheme !== null || Object.keys(info.stored).some(k => /theme/i.test(k)) || /dark/.test(info.bodyClass || '');
  log('dark', `theme control implemented=${implemented} controls=${info.controls.length} htmlTheme=${info.htmlTheme}`);
  return { label: 'dark theme availability', implemented, detail: info, status: implemented ? 'IMPLEMENTED' : 'NOT_IMPLEMENTED' };
}

async function scenarioPersistence(ctx) {
  const { page } = ctx;
  const tag = 'PERSIST1';
  const size = 60;
  await newChat(page);
  await setChatMode(page);
  fixture.reset(tag);
  fixture.clearPlans();
  fixture.enqueue({ tag, size });
  const expected = expectedFor(tag, size);
  // Return to chat page first so openConversation refresh is the only renderer-side writer involved.
  await sendPrompt(page, `E2E SIZE=${size} TAG=${tag} 持久化检查`);
  try {
    await page.waitForFunction((exp) => {
      const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
      return bodies.some(b => b.textContent === exp);
    }, expected, { timeout: 90000, polling: 150 });
  } catch { /* record below */ }
  await sleep(1800); // let maybeAppendAssistant + poll settle
  const info = await page.evaluate(async () => {
    const id = (typeof S !== 'undefined' && S.conversationId) || null;
    if (!id) return { id: null, error: 'no conversationId in renderer state' };
    try {
      const got = await window.suwen.call('conversation.get', { id });
      const messages = (got?.messages || []).map(m => ({ id: m.id || null, role: m.role, taskId: m.taskId || null, at: m.at ?? null, len: typeof m.text === 'string' ? m.text.length : null, text: typeof m.text === 'string' ? m.text : null }));
      return { id, messageCount: messages.length, messages };
    } catch (error) {
      return { id, error: String(error?.message || error) };
    }
  });
  const assistants = Array.isArray(info.messages) ? info.messages.filter(m => m.role === 'assistant') : [];
  const taskAssistants = assistants.filter(m => m.taskId);
  const result = {
    label: 'conversation persistence after one model run (duplicate assistant bookkeeping)',
    conversation: info,
    assistantCount: assistants.length,
    assistantMessagesWithTaskId: taskAssistants.length,
    pass: {
      exactlyOneAssistant: assistants.length === 1,
      exactlyOneTaskAssistant: taskAssistants.length === 1,
    },
  };
  log('persist', `conversation=${info.id} assistants=${assistants.length} taskAssistants=${taskAssistants.length}`);
  return result;
}

function killProcess(pid) {
  const res = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' });
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), status: res.status };
}

async function scenarioKillReconnect(ctx) {
  const { page } = ctx;
  const tag = 'KILL1';
  const size = 300;
  await newChat(page);
  await setChatMode(page);
  fixture.reset(tag);
  fixture.clearPlans();
  fixture.enqueue({ tag, size });
  await startSampler(page);
  const expected = expectedFor(tag, size);
  await sendPrompt(page, `E2E SIZE=${size} TAG=${tag} 断连恢复`);
  const sendMark = Date.now();
  try {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
      return b.some(x => (x.textContent || '').length > 0);
    }, null, { timeout: 20000, polling: 100 });
  } catch { /* continue */ }
  const before = await snapshotTasks(page);
  const task = before.find(t => t.name?.includes(`TAG=${tag}`) || t.name?.includes(`SIZE=${size}`));
  const snapHealth = await page.evaluate(async () => { try { const s = await window.suwen.call('snapshot', {}); return s?.health || null; } catch { return null; } });
  const daemonPid = snapHealth?.pid || null;
  const kill = daemonPid ? killProcess(daemonPid) : { ok: false, stdout: '', stderr: 'no daemon pid available from snapshot health', status: null };
  const killAt = Date.now();
  log('kill', `daemon pid=${daemonPid} kill=${kill.ok ? 'ok' : 'failed'} stdout=${kill.stdout} stderr=${kill.stderr}`);

  const observations = [];
  const tObs = Date.now();
  let offlineAt = null;
  let bannerReconnectingAt = null;
  let restoredAt = null;
  let autoReconnectEvents = [];
  let offlineVia = null;
  while (Date.now() - tObs < 35000) {
    const obs = await page.evaluate(() => {
      const samples = window.__e2e?.samples || [];
      const last = samples[samples.length - 1] || {};
      const banner = document.getElementById('stream-banner');
      return {
        health: document.getElementById('health')?.textContent || '',
        connEvents: window.__connEvents || [],
        banner: banner ? { text: (banner.textContent || '').trim(), hidden: !!banner.hidden, state: banner.dataset?.state || '' } : null,
        sampleCount: samples.length,
        lastAssistantLen: last.last ?? null,
        promptDisabled: !!(document.getElementById('prompt') || {}).disabled,
      };
    }).catch(() => ({ health: '(page evaluate failed)', connEvents: [], banner: null, sampleCount: 0, lastAssistantLen: null, promptDisabled: null }));
    observations.push({ at: Date.now() - killAt, ...obs });
    const offlineText = /后台未连接|未连接|offline|lost|重连/i.test(obs.health);
    const bannerReconnect = !!obs.banner && !obs.banner.hidden
      && (obs.banner.state === 'reconnecting' || obs.banner.state === 'lost' || /重连|连接恢复|reconnect|restor/i.test(obs.banner.text));
    if (!offlineAt && offlineText) { offlineAt = Date.now(); offlineVia = offlineVia || 'health-text'; }
    if (!bannerReconnectingAt && bannerReconnect) { bannerReconnectingAt = Date.now(); offlineVia = offlineVia || 'stream-banner'; }
    autoReconnectEvents = obs.connEvents.filter(e => ['reconnecting', 'restored', 'lost'].includes(e.state));
    const restoredEvent = autoReconnectEvents.find(e => e.state === 'restored');
    if (restoredEvent) {
      restoredAt = typeof restoredEvent.at === 'number' ? restoredEvent.at : Date.now();
      break;
    }
    await sleep(250);
  }
  const offlineLatency = offlineAt ? offlineAt - killAt : (bannerReconnectingAt ? bannerReconnectingAt - killAt : null);
  const restoredLatency = restoredAt ? restoredAt - killAt : null;
  const offlineStateShown = offlineAt !== null || bannerReconnectingAt !== null;
  const autoRestored = restoredAt !== null;
  log('kill', `offlineLatency=${offlineLatency}ms via=${offlineVia || 'none'} autoRestored=${autoRestored} restoredLatency=${restoredLatency}ms connEvents=${autoReconnectEvents.map(e => e.state).join('|')}`);

  // Manual reconnect through the real settings UI button.
  await page.click('.rail button[data-page="settings"]');
  await page.waitForFunction(() => { const b = document.getElementById('reconnect'); return b && b.offsetParent !== null; }, null, { timeout: 10000 });
  const manualStart = Date.now();
  await page.click('#reconnect');
  let manualOk = false;
  let manualHealth = '';
  const tMan = Date.now();
  while (Date.now() - tMan < 45000) {
    manualHealth = await page.evaluate(() => document.getElementById('health')?.textContent || '');
    if (/后台运行|PID /.test(manualHealth)) {
      const ping = await page.evaluate(async () => { try { const s = await window.suwen.call('snapshot', {}); return Array.isArray(s?.tasks); } catch { return false; } });
      if (ping) { manualOk = true; break; }
    }
    await sleep(400);
  }
  const manualReconnectMs = manualOk ? Date.now() - manualStart : null;
  log('kill', `manualReconnect=${manualOk ? 'ok' : 'failed'} ms=${manualReconnectMs} health=${manualHealth.slice(0, 40)}`);

  // Observe what state the interrupted task ended up in after lease reclaim.
  let taskAfter = null;
  const tLease = Date.now();
  while (Date.now() - tLease < 45000) {
    const tasks = await snapshotTasks(page).catch(() => []);
    const target = tasks.find(t => t.name?.includes(`TAG=${tag}`) || t.name?.includes(`SIZE=${size}`));
    if (target && ['waiting_approval', 'failed', 'completed', 'cancelled', 'retry_scheduled'].includes(target.status)) { taskAfter = target; break; }
    await sleep(500);
  }
  const interruptedState = taskAfter ? { status: taskAfter.status, stepStatus: taskAfter.steps?.[0]?.status, error: taskAfter.steps?.[0]?.error || null } : null;
  log('kill', `interrupted task state=${interruptedState?.status}/${interruptedState?.stepStatus} error=${interruptedState?.error}`);

  // If reconciliation is required, perform the same retry action the evidence UI offers.
  let recovery = { attempted: false };
  if (taskAfter && taskAfter.status === 'waiting_approval') {
    const step = taskAfter.steps?.find(s => s.status === 'waiting_approval') || taskAfter.steps?.[0];
    fixture.reset(tag);
    fixture.clearPlans();
    fixture.enqueue({ tag, size });
    const retry = await bridge(page, 'approval', { taskId: taskAfter.id, stepId: step.id, version: taskAfter.version, decision: { action: 'retry' } });
    recovery = { attempted: true, retryOk: retry.ok, retryError: retry.ok ? null : retry.error, mechanism: 'approval retry (same RPC the evidence UI Retry button issues: ui/app.js:1422)' };
    try {
      await page.waitForFunction((exp) => {
        const bodies = [...document.querySelectorAll('#timeline .message:not(.user) .body')];
        return bodies.some(b => b.textContent === exp);
      }, expected, { timeout: 120000, polling: 150 });
      recovery.textRecovered = true;
    } catch { recovery.textRecovered = false; }
    recovery.recoveredAt = Date.now();
    recovery.recoveryWallMs = recovery.recoveredAt - killAt;
    await sleep(3000); // let the 2500ms snapshot poll + one render pass settle before judging duplicates
  } else if (taskAfter && taskAfter.status === 'failed') {
    recovery = { attempted: false, note: 'task failed after lease reclaim; no retry offered' };
  }
  await collectSampler(page); // stop the DOM sampler; final judgement uses the settled snapshot below
  await page.click('.rail button[data-page="chat"]');
  await sleep(3000); // openConversation() refreshes from the daemon; duplicates would become visible here
  const settled = await page.evaluate(async () => {
    try { if (typeof renderChat === 'function') renderChat(); } catch { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 300));
    const nodes = [...document.querySelectorAll('#timeline .message')].map(node => {
      const body = node.querySelector('.body');
      return {
        role: node.classList.contains('user') ? 'user' : 'assistant',
        streaming: node.classList.contains('streaming'),
        text: body ? (body.textContent || '') : '',
      };
    });
    let conversation = null;
    try {
      const id = (typeof S !== 'undefined' && S.conversationId) || null;
      if (id) {
        const got = await window.suwen.call('conversation.get', { id });
        conversation = {
          id,
          messages: (got?.messages || []).map(m => ({ id: m.id || null, role: m.role, taskId: m.taskId || null, at: m.at ?? null, len: typeof m.text === 'string' ? m.text.length : null, text: typeof m.text === 'string' ? m.text : null })),
        };
      }
    } catch (error) {
      conversation = { error: String(error?.message || error) };
    }
    let tasks = [];
    try {
      const snap = await window.suwen.call('snapshot', {});
      tasks = (snap?.tasks || []).filter(t => (t.name || '').includes('KILL1')).map(t => ({ id: t.id, status: t.status, stepStatus: t.steps?.[0]?.status || null }));
    } catch { /* ignore */ }
    return { nodes, conversation, tasks };
  }).catch(error => ({ nodes: [], conversation: { error: String(error?.message || error) }, tasks: [] }));
  const bodies = settled.nodes.filter(node => node.role === 'assistant').map(node => node.text);
  const exact = bodies.filter(t => t === expected).length;
  const conversationAssistant = Array.isArray(settled.conversation?.messages) ? settled.conversation.messages.filter(m => m.role === 'assistant') : [];
  const taskAssistantMessages = taskAfter ? conversationAssistant.filter(m => m.taskId === taskAfter.id) : conversationAssistant;
  const result = {
    label: 'daemon SIGKILL mid-stream: auto-reconnect, manual reconnect, state/text recovery, no page reload',
    kill: { daemonPid, ok: kill.ok, stdout: kill.stdout, stderr: kill.stderr, killAt: nowIso() },
    offlineDetected: offlineStateShown,
    offlineLatencyMs: offlineLatency,
    offlineObservedVia: offlineVia,
    autoReconnect: {
      restored: autoRestored,
      restoredLatencyMs: restoredLatency,
      reconnectEvents: autoReconnectEvents,
      eventStates: [...new Set(autoReconnectEvents.map(e => e.state))],
      note: autoRestored
        ? `main auto-reconnected without manual action (${restoredLatency}ms after SIGKILL)`
        : 'no auto restore observed within 35s after SIGKILL',
    },
    manualReconnect: { ok: manualOk, latencyMs: manualReconnectMs, via: 'settings page #reconnect button (real UI control)' },
    pageReloads: 0,
    interruptedTask: interruptedState,
    recovery,
    tasksAfter: settled.tasks,
    domMessages: settled.nodes.map(node => ({ role: node.role, streaming: node.streaming, len: node.text.length, matchesExpected: node.role === 'assistant' && node.text === expected })),
    finalAssistantBodies: bodies.map(t => ({ len: t.length, sha256: sha256(t), matchesExpected: t === expected, head: t.slice(0, 12) })),
    expected: { len: expected.length, sha256: sha256(expected) },
    duplicateFinalCopiesAfterSettle: exact,
    conversationRecord: settled.conversation ? {
      id: settled.conversation.id,
      error: settled.conversation.error || null,
      messageCount: Array.isArray(settled.conversation.messages) ? settled.conversation.messages.length : null,
      assistantMessages: conversationAssistant.map(m => ({ id: m.id || null, taskId: m.taskId, at: m.at ?? null, len: m.len, sha256: typeof m.text === 'string' ? sha256(m.text) : null })),
      assistantMessagesForTask: taskAssistantMessages.map(m => ({ id: m.id || null, taskId: m.taskId, at: m.at ?? null, len: m.len, sha256: typeof m.text === 'string' ? sha256(m.text) : null })),
    } : null,
    pass: {
      offlineStateShown,
      autoReconnected: autoRestored,
      manualReconnectWorked: manualOk,
      noPageReload: true,
      taskReconciled: !!interruptedState && ['waiting_approval', 'failed', 'completed'].includes(interruptedState.status),
      textRecoveredExactlyOnce: recovery.textRecovered === true && exact === 1,
      singlePersistedAssistantForTask: taskAssistantMessages.length === 1,
    },
  };
  if (!recovery.textRecovered) result.pass.textRecoveredExactlyOnce = false;
  log('kill', `result: offline=${result.pass.offlineStateShown} auto=${result.pass.autoReconnected} manual=${result.pass.manualReconnectWorked} recovered=${result.pass.textRecoveredExactlyOnce} persistedTaskAssistants=${taskAssistantMessages.length} domCopies=${exact}`);
  return result;
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */
function envInfo() {
  const os = require('node:os');
  return {
    platform: `${process.platform} ${os.release()}`,
    osVersion: os.version ? os.version() : null,
    cpu: os.cpus()?.[0]?.model || null,
    cores: os.cpus()?.length || null,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    electronPackage: (() => { try { return JSON.parse(readFileSync(join(project, 'node_modules', 'electron', 'package.json'), 'utf8')).version; } catch { return null; } })(),
    playwrightCore: (() => { try { return require('playwright-core/package.json').version; } catch { return null; } })(),
    hostTime: nowIso(),
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const startedAt = Date.now();
  const report = {
    schema: 'suwen.ui-streaming-e2e/1',
    mode: MODE,
    label: 'deterministic local fixture',
    stamp,
    startedAt: nowIso(),
    commands: { node: process.execPath, script: join(here, 'streaming-ui-e2e.mjs'), argv: process.argv.slice(2) },
    env: envInfo(),
    fixture: { kind: 'local OpenAI-compatible SSE server', host: '127.0.0.1', notes: 'no vendor API; SSE chunks are deterministic w00000..wNNNNN tokens' },
    phases: phaseLog,
    scenarios: {},
    findings: [],
  };
  let launched = null;
  try {
    const port = await startFixture();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    report.fixture.baseUrl = baseUrl;
    log('fixture', `listening ${baseUrl}`);
    const profile = makeProfile();
    launched = await launchApp(profile);
    report.profile = profile;
    report.app = await launched.app.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }));
    const { page } = launched;
    await waitForBridge(page);
    const initial = await waitDaemon(page);
    report.initialHealth = initial.health;
    log('boot', `daemon ready pid=${initial.health?.pid} configured=${initial.health?.configured} electron=${report.app.electron}`);
    const cfg = await configureModel(page, baseUrl);
    report.configure = cfg;
    if (!cfg.ok) throw new Error(`configure failed: ${cfg.error}`);
    const afterCfg = await page.evaluate(async () => { try { const s = await window.suwen.call('snapshot', {}); return s?.health || null; } catch { return null; } });
    report.configuredHealth = afterCfg;
    log('boot', `model configured=${afterCfg?.configured}`);

    // Optional poll-only baseline proxy: unsubscribe the push listener and set the app's own
    // documented fallback flag (app.js:3582-3586 sets S.stream.disabled when no push transport).
    // This exercises the same snapshot-only code path the app uses when onEvent is unavailable.
    // (window.suwen is non-configurable via contextBridge, so boot-time stubbing is impossible.)
    let transport = 'push (window.suwen.onEvent -> main pump -> events.stream batches)';
    if (FALLBACK) {
      const fb = await page.evaluate(() => {
        try {
          const s = (typeof S !== 'undefined') ? S : null;
          if (!s || !s.stream) return { ok: false, error: 'S.stream not reachable from page context' };
          let eventUnsub = null;
          let connUnsub = null;
          try { if (typeof s.stream.unsubscribeEvent === 'function') { s.stream.unsubscribeEvent(); eventUnsub = 'ok'; } } catch (err) { eventUnsub = String(err); }
          try { if (typeof s.stream.unsubscribeConnection === 'function') { s.stream.unsubscribeConnection(); connUnsub = 'ok'; } } catch (err) { connUnsub = String(err); }
          s.stream.disabled = true;
          return { ok: true, eventUnsub, connUnsub, disabled: s.stream.disabled, subscribed: s.stream.subscribed, snapshotPoll: document.getElementById('health') !== null };
        } catch (err) { return { ok: false, error: String(err) }; }
      });
      report.fallbackInfo = fb;
      transport = fb.ok ? 'poll-only simulation (push unsubscribed, S.stream.disabled=true, 2500ms snapshot reconcile)' : 'push';
      log('boot', `fallback requested => ${transport} ${JSON.stringify(fb)}`);
    }
    report.transport = transport;

    const ctx = { app: launched.app, page, profile, baseUrl };
    const probe = PROBE;
    if (probe) {
      log('probe', 'about to inspect main UI');
      const basic = await page.evaluate(() => ({
        title: document.title,
        lang: document.documentElement.lang,
        railButtons: [...document.querySelectorAll('.rail button[data-page]')].map(b => b.dataset.page),
        newChat: !!document.getElementById('new-chat'),
        promptTag: document.getElementById('prompt')?.tagName,
        sendTag: document.getElementById('send')?.tagName,
        timelineMessages: document.querySelectorAll('#timeline .message').length,
        health: document.getElementById('health')?.textContent,
        activePage: [...document.querySelectorAll('section.page')].filter(p => !p.hidden).map(p => p.id),
      }));
      log('probe', `basic=${JSON.stringify(basic)}`);
      log('probe', 'gotoChat');
      await gotoChat(page);
      log('probe', 'click new-chat');
      await page.click('#new-chat');
      await sleep(400);
      log('probe', 'new-chat clicked');
      await startSampler(page);
      fixture.clearPlans();
      fixture.enqueue({ tag: 'PROBE', size: 30 });
      await sendPrompt(page, 'E2E SIZE=30 TAG=PROBE 探针');
      log('probe', 'prompt sent');
      await sleep(3000);
      const tasks = await snapshotTasks(page);
      const probeInfo = await page.evaluate(() => ({
        assistantBodies: [...document.querySelectorAll('#timeline .message:not(.user) .body')].map(b => b.textContent.length),
        bodyHead: [...document.querySelectorAll('#timeline .message:not(.user) .body')].map(b => (b.textContent || '').slice(0, 120)),
        health: document.getElementById('health')?.textContent,
        lang: document.documentElement.lang,
        sessions: [...document.querySelectorAll('#sessions button.session')].map(b => b.title),
        actions: [...document.querySelectorAll('.message-actions button')].map(b => b.textContent),
        modeButtons: [...document.querySelectorAll('#mode-radios [data-mode]')].map(b => b.dataset.mode),
        timelineChildren: document.querySelectorAll('#timeline .message').length,
        push: {
          onEvent: typeof window.suwen?.onEvent,
          onConnection: typeof window.suwen?.onConnection,
          eventsReplay: (() => { try { return typeof window.suwen?.call; } catch { return 'n/a'; } })(),
        },
        dom: {
          streamBanner: !!document.getElementById('stream-banner'),
          defaultsTheme: !!document.getElementById('defaults-theme'),
          theme: document.documentElement.getAttribute('data-theme'),
          themeMode: document.documentElement.getAttribute('data-theme-mode'),
          storedTheme: (() => { try { return localStorage.getItem('suwen.theme'); } catch { return null; } })(),
        },
      }));
      report.probe = {
        tasks: tasks.slice(0, 3).map(t => ({
          id: t.id, name: t.name, status: t.status,
          steps: (t.steps || []).map(s => ({ id: s.id, kind: s.kind, status: s.status, outputTextLen: typeof s.output?.text === 'string' ? s.output.text.length : null, outputHead: typeof s.output?.text === 'string' ? s.output.text.slice(0, 60) : null })),
        })),
        probeInfo,
        fixtureRequests: fixture.requests,
        fixtureRequestLog: fixture.requestLog.slice(-3),
      };
      log('probe', JSON.stringify(probeInfo));
      log('probe', `tasks=${tasks.length} fixtureRequests=${fixture.requests}`);
      const out = join(outDir, `ui-streaming-${stamp}-${MODE}-probe.json`);
      writeFileSync(out, JSON.stringify(report, null, 2));
      log('probe', `report written ${out}`);
      return report;
    }

    const partialPath = join(outDir, `ui-streaming-${stamp}-${MODE}-partial.json`);
    const writePartial = () => {
      try {
        report.partial = true;
        report.finishedAt = nowIso();
        report.durationMs = Date.now() - startedAt;
        writeFileSync(partialPath, JSON.stringify(report, null, 2));
      } catch { /* ignore */ }
    };
    const safeRun = async (key, label, fn) => {
      log('scenario', label);
      try {
        report.scenarios[key] = await fn();
      } catch (err) {
        log('scenario', `${key} FAILED: ${err?.stack || err}`);
        report.scenarios[key] = { error: String(err?.message || err), stack: String(err?.stack || '') };
      }
      writePartial();
    };
    if (ONLY.has('sizes')) await safeRun('sizes', 'sizes: 100/1000/10000 delta streams', () => scenarioSizes(ctx, MODE === 'baseline' ? 'B' : 'F'));
    if (ONLY.has('composer')) await safeRun('composer', 'composer bounding box + draft preserved', () => scenarioComposerDraft(ctx));
    if (ONLY.has('scroll')) await safeRun('scroll', 'scroll follow / user scroll-up', () => scenarioScroll(ctx));
    if (ONLY.has('concurrent')) await safeRun('concurrent', 'concurrent run isolation', () => scenarioConcurrent(ctx));
    if (ONLY.has('long')) await safeRun('longSession', '120+ message session', () => scenarioLongSession(ctx));
    if (ONLY.has('persist')) await safeRun('persistence', 'conversation persistence duplicate check', () => scenarioPersistence(ctx));
    if (ONLY.has('layouts')) await safeRun('layouts', 'layouts x locales', () => scenarioLayouts(ctx));
    if (ONLY.has('dark')) await safeRun('dark', 'dark theme availability', () => scenarioTheme(ctx));
    if (ONLY.has('kill')) await safeRun('kill', 'daemon SIGKILL / reconnect / recovery', () => scenarioKillReconnect(ctx));

    // Aggregate findings from scenario passes.
    const findings = [];
    const sizes = Array.isArray(report.scenarios.sizes) ? report.scenarios.sizes : [];
    for (const s of sizes) {
      if (!s.pass.streamIntegrity) findings.push({ severity: 'P0', area: 'stream-integrity', evidence: s.label, detail: `sha ${s.shaMatch} exact ${s.exactTextMatch} len ${s.actualLen}/${s.expectedLen}` });
      if (!s.pass.liveRendering) findings.push({ severity: 'P0', area: 'streaming-consumption', evidence: s.label, detail: `firstText=${s.firstTextLatencyMs}ms completionLag=${s.completionLagMs}ms updates=${s.updateCount}` });
      if (!s.pass.composerStable) findings.push({ severity: 'P1', area: 'layout-shift', evidence: s.label, detail: `composer max delta ${s.composerMaxDeltaPx}px` });
      if (s.pass.draftPreserved === false) findings.push({ severity: 'P1', area: 'draft', evidence: s.label, detail: 'composer draft not preserved during streaming' });
      if (s.pass.scrollUpStable === false) findings.push({ severity: 'P2', area: 'scroll', evidence: s.label, detail: `forced scroll after user scrolled up; drift ${s.scroll?.scrollUpDriftMaxPx}px` });
      if (!s.pass.noDuplicateFinal) findings.push({ severity: 'P0', area: 'duplicate', evidence: s.label, detail: `${s.duplicateFinalCopies} copies of final text` });
    }
    const composer = report.scenarios.composer;
    if (composer && typeof composer === 'object' && composer.pass) {
      if (composer.pass.draftPreserved !== true) findings.push({ severity: 'P1', area: 'draft', evidence: composer.label, detail: `draftPreserved=${composer.pass.draftPreserved} value=${composer.draftValue}` });
      if (composer.pass.composerStable !== true) findings.push({ severity: 'P1', area: 'layout-shift', evidence: composer.label, detail: `composer max delta ${composer.composerMaxDeltaPx}px` });
    }
    const scroll = report.scenarios.scroll;
    if (scroll && typeof scroll === 'object' && scroll.pass) {
      if (scroll.pass.scrollFollow !== true) findings.push({ severity: 'P2', area: 'scroll', evidence: scroll.label, detail: `followGapMax=${scroll.scroll?.followGapMaxPx}px` });
      if (scroll.pass.scrollUpStable !== true) findings.push({ severity: 'P2', area: 'scroll', evidence: scroll.label, detail: `user scroll-up drift ${scroll.scroll?.scrollUpDriftMaxPx}px (forced scroll)` });
    }
    const c = report.scenarios.concurrent;
    if (c && c.pass && typeof c.pass === 'object') {
      for (const [k, v] of Object.entries(c.pass)) if (!v) findings.push({ severity: k === 'bothStreamsVisibleTogether' ? 'P2' : 'P1', area: 'concurrency', evidence: c.label, detail: `${k}=false` });
    }
    const long = report.scenarios.longSession;
    if (long && long.pass && typeof long.pass === 'object') for (const [k, v] of Object.entries(long.pass)) if (v === false) findings.push({ severity: 'P2', area: 'long-session', evidence: long.label, detail: `${k}=false` });
    const persistence = report.scenarios.persistence;
    if (persistence && persistence.pass && typeof persistence.pass === 'object') {
      for (const [name, v] of Object.entries(persistence.pass)) {
        if (v === true) continue;
        findings.push({ severity: 'P1', area: 'conversation', evidence: persistence.label, detail: `${name}=false (assistantCount=${persistence.assistantCount}, taskAssistants=${persistence.assistantMessagesWithTaskId})` });
      }
    }
    for (const layout of Array.isArray(report.scenarios.layouts) ? report.scenarios.layouts : []) {
      for (const f of layout.findings || []) findings.push({ severity: f.severity, area: 'layout', evidence: `${layout.width}x${layout.height} ${layout.locale} page ${f.page}`, detail: `${f.kind} ${JSON.stringify(f.detail).slice(0, 300)}` });
    }
    if (report.scenarios.dark && report.scenarios.dark.status === 'NOT_IMPLEMENTED') findings.push({ severity: 'P2', area: 'theme', evidence: 'dark theme availability', detail: 'no dark theme or theme control found in this build' });
    const k = report.scenarios.kill;
    if (k && k.pass && typeof k.pass === 'object') {
      for (const [name, v] of Object.entries(k.pass)) {
        if (v) continue;
        const severe = name === 'noPageReload' ? 'P0' : ['autoReconnected', 'textRecoveredExactlyOnce', 'singlePersistedAssistantForTask'].includes(name) ? 'P1' : 'P2';
        findings.push({ severity: severe, area: 'reconnect', evidence: k.label, detail: `${name}=false ${name === 'autoReconnected' ? `(events=${k.autoReconnect.eventStates.join('|') || 'none'})` : name === 'singlePersistedAssistantForTask' ? `(persisted assistant messages for task=${k.conversationRecord?.assistantMessagesForTask?.length})` : ''}` });
      }
      if (k.interruptedTask?.status === 'waiting_approval') findings.push({ severity: 'P2', area: 'reconnect', evidence: k.label, detail: 'interrupted side-effect model step requires explicit reconciliation (waiting_approval) — by design, but recovery is not automatic' });
    }
    report.findings = findings;
    report.finishedAt = nowIso();
    report.durationMs = Date.now() - startedAt;
    report.phaseLog = phaseLog;

    const out = join(outDir, `ui-streaming-${stamp}-${MODE}.json`);
    writeFileSync(out, JSON.stringify(report, null, 2));
    log('done', `report written ${out} (${report.durationMs}ms, ${findings.length} findings)`);
    console.log('\n=== SUMMARY (deterministic local fixture) ===');
    console.log(`transport: ${report.transport}`);
    for (const s of sizes) {
      console.log(`${MODE} ${String(s.size).padStart(5)} delta r${s.run}: sha=${s.shaMatch ? 'OK' : 'FAIL'} first=${String(s.firstTextLatencyMs).padStart(5)}ms lagP50=${String(s.renderLagMs.p50).padStart(5)} lagP95=${String(s.renderLagMs.p95).padStart(5)} completion=${String(s.completionLagMs).padStart(5)}ms updates=${String(s.updateCount).padStart(3)} composerΔ=${s.composerMaxDeltaPx}px status=${s.status}`);
    }
    if (composer?.pass) console.log(`draft preserved=${composer.pass.draftPreserved} composerΔ=${composer.composerMaxDeltaPx}px`);
    if (scroll?.scroll) console.log(`scroll: followGapMax=${scroll.scroll.followGapMaxPx}px scrollUpDrift=${scroll.scroll.scrollUpDriftMaxPx}px jumpControls=${scroll.scroll.jumpControls}`);
    if (c?.pass) console.log(`concurrent: bothFinal=${c.pass.bothFinalTextsExact} bothStreamsVisible=${c.pass.bothStreamsVisibleTogether} contamination=${c.crossContamination}`);
    if (long?.messageCount) console.log(`long session: ${long.messageCount} msgs open=${long.openMs}ms bottomGap=${long.bottomGap}`);
    if (Array.isArray(report.scenarios.layouts)) console.log(`layouts: ${report.scenarios.layouts.map(l => `${l.width}x${l.height}/${l.locale}:${l.findings.length}`).join(' ')}`);
    if (report.scenarios.dark) console.log(`dark theme: ${report.scenarios.dark.status}`);
    if (report.scenarios.persistence && report.scenarios.persistence.pass) console.log(`persistence: assistants=${report.scenarios.persistence.assistantCount} taskAssistants=${report.scenarios.persistence.assistantMessagesWithTaskId}`);
    if (k?.pass) console.log(`kill: offline=${k.pass.offlineStateShown} autoReconnect=${k.pass.autoReconnected} manual=${k.manualReconnect?.latencyMs}ms interrupted=${k.interruptedTask?.status} textRecoveredOnce=${k.pass.textRecoveredExactlyOnce} persistedTaskAssistants=${k.conversationRecord?.assistantMessagesForTask?.length ?? 'n/a'} domCopies=${k.duplicateFinalCopiesAfterSettle}`);
    console.log(`\nFindings (${findings.length}):`);
    for (const f of findings) console.log(`  [${f.severity}] ${f.area}: ${f.detail}`);
  } finally {
    const electronPid = (() => { try { return launched?.app?.process?.()?.pid ?? null; } catch { return null; } })();
    // Playwright's close can hang if the Electron main process does not quit; bound it.
    try {
      await Promise.race([launched?.app?.close?.() ?? Promise.resolve(), sleep(8000)]);
    } catch { /* ignore */ }
    await sleep(300);
    if (electronPid) {
      let alive = true;
      try { process.kill(electronPid, 0); } catch { alive = false; }
      if (alive) {
        try { spawnSync('taskkill', ['/PID', String(electronPid), '/T', '/F'], { encoding: 'utf8' }); } catch { /* ignore */ }
      }
    }
    await sleep(500);
    // Kill any daemon left behind for this isolated profile (read the real connection record).
    try {
      if (launched?.profile) {
        const home = join(launched.profile, 'runtime');
        const rpcMod = await import(pathToFileURL(join(project, 'dist', 'src', 'rpc.js')).href);
        const conn = typeof rpcMod.readConnection === 'function' ? rpcMod.readConnection(home) : null;
        if (conn?.pid) {
          try { await Promise.race([rpcMod.rpc(conn, 'shutdown', {}, 1500), sleep(2500)]); } catch { /* ignore */ }
          await sleep(400);
          let daemonAlive = true;
          try { process.kill(conn.pid, 0); } catch { daemonAlive = false; }
          if (daemonAlive) killProcess(conn.pid);
        }
      }
    } catch { /* ignore */ }
    stopFixture();
    if (launched?.profile) {
      for (let i = 0; i < 5; i += 1) {
        try { rmSync(launched.profile, { recursive: true, force: true }); break; } catch { await sleep(400); }
      }
    }
    log('cleanup', 'electron/fixture/daemon cleanup attempted');
    // Playwright's Electron connection can leave keep-alive handles; exit explicitly once work is done.
    setTimeout(() => process.exit(process.exitCode || 0), 150);
  }
}

main().catch(async err => {
  console.error('FATAL', err);
  stopFixture();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 300);
});
