// Run with: node tests/frontend-artifacts.mjs
// Uses the installed desktop Playwright runtime and a local Edge/Chromium.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
let annotation = {note: '保留原始数据', strokes: []};
let failRead = false;
let failSave = false;
let readGate = null;
let saveGate = null;
let onSaveReceived = () => {};
let htmlReads = 0;
let saves = 0;
const fixture = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
  ${['base', 'components', 'views', 'studio', 'platform', 'workspace-tools'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
  </head><body><main id="chat" style="width:100%;height:100%;padding:2rem"><h2>Eve</h2><p>研究对话与工作产物</p><button id="opener" class="btn">查看分析图</button></main></body></html>`;
const payload = `<!doctype html><base href="https://blocked.invalid"><meta http-equiv="refresh" content="0;url=https://blocked.invalid/refresh">
  <h2>分析图</h2><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>
  <script>
    try { parent.document.body.dataset.escaped='yes'; } catch { document.body.dataset.parentBlocked='yes'; }
    try { top.location.hash='escaped'; } catch { document.body.dataset.topBlocked='yes'; }
    try { localStorage.setItem('escaped','yes'); } catch { document.body.dataset.storageBlocked='yes'; }
    fetch('https://blocked.invalid/fetch').catch(()=>document.body.dataset.fetchBlocked='yes');
  </script><img src="https://blocked.invalid/image"><form action="https://blocked.invalid/form"><button id="submit">提交</button></form>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(data)); };
  if (url.pathname === '/__artifact-test') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(fixture); return; }
  if (url.pathname.endsWith('/artifacts/html')) { htmlReads++; json({content: payload}); return; }
  if (url.pathname === '/api/figures/figure.png/annotations') {
    if (req.method === 'POST') {
      if (failSave) { json({error: {message: '保存失败，测试重试'}}, 500); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      onSaveReceived();
      if (saveGate) await saveGate;
      annotation = JSON.parse(body); saves++; json({annotation}); return;
    }
    if (readGate) await readGate;
    if (failRead) { json({error: {message: '读取失败，测试重试'}}, 500); return; }
    json({annotation}); return;
  }
  if (url.pathname === '/api/figures/figure.png') {
    res.setHeader('content-type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="white"/><path d="M20 100L80 40L140 65L220 20" fill="none" stroke="black" stroke-width="3"/></svg>'); return;
  }
  const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
  if (!target.startsWith(web)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(target);
    res.setHeader('content-type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const escapedRequests = [];
  await page.route('https://blocked.invalid/**', route => { escapedRequests.push(route.request().url()); return route.abort(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/__artifact-test`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    window.viewer = await import('/js/artifact-viewer.js?v=1.5.0');
    window.annotator = await import('/js/figure-annotator.js?v=1.5.0');
    window.tabs = await import('/js/artifact-tabs.js?v=1.5.0');
    window.bus = await import('/js/bus.js?v=1.5.0');
    window.config = (await import('/js/artifact-config.js?v=1.5.0')).artifactConfig;
    window.blobUrls = new Set();
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); blobUrls.add(url); return url; };
    URL.revokeObjectURL = url => { blobUrls.delete(url); revokeURL(url); };
    const Original = window.ResizeObserver;
    window.annotationObservers = new Set();
    window.ResizeObserver = class extends Original {
      observe(...args) { window.annotationObservers.add(this); super.observe(...args); }
      disconnect() { window.annotationObservers.delete(this); super.disconnect(); }
    };
  });
  const chatWidth = await page.locator('#chat').evaluate(node => node.getBoundingClientRect().width);
  await page.locator('#opener').focus();
  await page.evaluate(() => viewer.openHtmlArtifact('ws_main', 'report.html', '分析图'));
  await page.locator('.artifact-frame').waitFor();
  await page.waitForFunction(() => document.querySelector('.artifact-frame')?.clientHeight > 0);
  const content = page.frameLocator('.artifact-frame').frameLocator('iframe');
  await content.locator('#counter').click();
  assert.equal(await content.locator('#counter').textContent(), '1', 'inline interaction works');
  for (const key of ['parentBlocked', 'topBlocked', 'storageBlocked', 'fetchBlocked']) {
    assert.equal(await content.locator('body').getAttribute(`data-${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`), 'yes', key);
  }
  assert.equal(await page.locator('body').getAttribute('data-escaped'), null);
  await content.locator('#submit').click();
  // Navigation of the artifact itself must obey the trusted outer frame's CSP.
  const blockedNavigation = page.waitForEvent('framenavigated', {predicate: frame => frame.url().startsWith('chrome-error://')});
  await content.locator('body').evaluate(() => { location.href = 'https://blocked.invalid/navigation'; });
  await blockedNavigation;
  assert.deepEqual(escapedRequests, [], 'CSP blocks fetch, image, form and own-frame navigation');
  assert.equal(await page.locator('#chat').evaluate(node => node.getBoundingClientRect().width), chatWidth, 'opening a preview does not shrink chat');
  await page.evaluate(() => viewer.openHtmlArtifact('ws_main', 'report.html', '分析图'));
  assert.equal(htmlReads, 1, 'duplicate opens reuse the tab');
  await page.getByRole('button', {name: '重新加载', exact: true}).click();
  await content.locator('#counter').waitFor();
  assert.equal(await content.locator('#counter').textContent(), '0', 'reload restores the isolated document');
  await page.evaluate(() => viewer.openArtifact({type: 'text', id: 'text', title: '文本', content: '<img src=x onerror=alert(1)>'}));
  assert.equal(await page.locator('.artifact-text').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.artifact-text img').count(), 0, 'text renderer never parses HTML');
  await page.getByRole('tab', {name: '文本', exact: true}).press('Home');
  assert.equal(await page.getByRole('tab', {name: '分析图', exact: true}).getAttribute('aria-selected'), 'true');
  await page.locator('[data-artifact-minimize]').click();
  assert.equal(await page.locator('.artifact-sidebar').isVisible(), false);
  await page.locator('.artifact-reopen').click();
  await page.locator('[data-artifact-expand]').click();
  assert.equal(await page.locator('[data-artifact-expand]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-artifact-expand]').click();
  await page.screenshot({path: path.join(os.tmpdir(), 'eve-artifacts-desktop.png')});
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.locator('.artifact-sidebar').evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.getBoundingClientRect().left >= 0));
  await page.screenshot({path: path.join(os.tmpdir(), 'eve-artifacts-mobile.png')});
  await page.evaluate(() => tabs.closeArtifactSidebar());
  assert.equal(await page.locator('.artifact-sidebar').count(), 0);
  assert.equal(await page.evaluate(() => blobUrls.size), 0, 'HTML object URLs revoked');

  await page.setViewportSize({width: 1440, height: 1000});
  await page.evaluate(() => {
    window.disposals = 0;
    window.unregister = viewer.registerArtifactRenderer('late', (artifact, {signal}) => new Promise(resolve => {
      window.lateSignal = signal;
      window.resolveLate = () => resolve({node: document.createElement('p'), dispose: () => window.disposals++});
    }));
    window.late = viewer.openArtifact({type: 'late', id: 'late', title: '延迟'});
    late.close(); resolveLate();
  });
  await page.waitForFunction(() => window.disposals === 1);
  assert.equal(await page.evaluate(() => lateSignal.aborted), true, 'closing aborts renderer requests');
  await page.evaluate(() => unregister());
  await page.evaluate(() => {
    window.unregister = viewer.registerArtifactRenderer('error', () => { throw Error('可恢复的预览错误'); });
    viewer.openArtifact({type: 'error', id: 'error'});
  });
  await page.getByRole('button', {name: '重新读取', exact: true}).waitFor();
  await page.evaluate(() => { bus.emit('workspace:change', {workspace_id: 'ws_other'}); unregister(); });
  assert.equal(await page.locator('.artifact-sidebar').count(), 0, 'workspace change disposes tabs');
  const bounded = await page.evaluate(() => {
    for (let i = 0; i < config.maxTabs; i++) viewer.openArtifact({type: 'text', id: `budget-${i}`, content: String(i)});
    try { viewer.openArtifact({type: 'text', id: 'overflow', content: 'overflow'}); return false; }
    catch { return document.querySelectorAll('[role="tab"]').length === config.maxTabs; }
    finally { tabs.closeArtifactSidebar(); }
  });
  assert.equal(bounded, true, 'tab budget never silently evicts work');
  await page.evaluate(() => viewer.openArtifact({type: 'json', id: 'json', content: '{"safe":true}'}));
  assert.equal(await page.locator('.artifact-text').textContent(), '{\n  "safe": true\n}');
  await page.evaluate(() => tabs.closeArtifactSidebar());
  const sidebar = await page.evaluate(async () => {
    const {workspaceSidebarHtml, conversationListHtml} = await import('/js/workspace-sidebar.js?v=1.5.0');
    const html = conversationListHtml([{id: 'c1', title: '<script>unsafe</script>', archived: false, pinned: false, meta: {archived: true, pinned: true}}]);
    return {html, links: workspaceSidebarHtml()};
  });
  assert.ok(sidebar.html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(!sidebar.html.includes('conv-delete'), 'explicit false metadata is respected');
  assert.ok(sidebar.links.includes('href="#/evolution">自我改进</a>'));

  await page.evaluate(async () => {
    window.applyEvents = []; window.annotationEvents = [];
    bus.on('figure:annotation-apply', detail => { applyEvents.push(detail); annotationEvents.push('apply'); });
    bus.on('figure:annotations-saved', () => annotationEvents.push('saved'));
    await viewer.openHtmlArtifact('ws_main', 'report.html', '分析图');
    window.annotationTab = await annotator.annotateFigure({name: 'figure.png'});
  });
  // Opening an existing annotation tab preserves its in-progress form.
  assert.equal(await page.getByRole('tab').count(), 2, 'annotation and HTML share one sidebar');
  assert.equal(await page.locator('[role="dialog"]').count(), 0, 'annotation never opens a modal');
  assert.equal(await page.locator('#chat').evaluate(node => node.getBoundingClientRect().width), chatWidth);
  await page.locator('[data-annotation-note]').waitFor();
  await page.getByRole('button', {name: '保存批注', exact: true}).waitFor({state: 'visible'});
  // Use a fresh annotation tab to exercise a failed initial read.
  await page.evaluate(() => annotationTab.close());
  failRead = true;
  await page.evaluate(async () => { window.annotationTab = await annotator.annotateFigure({name: 'figure.png'}); });
  await page.locator('[data-annotation-retry]').waitFor();
  assert.equal(await page.getByRole('button', {name: '保存批注', exact: true}).isDisabled(), true, 'failed reads cannot overwrite existing annotations');
  failRead = false;
  await page.locator('[data-annotation-retry]').click();
  await page.waitForFunction(() => document.querySelector('canvas')?.getAttribute('aria-disabled') === 'false');
  const boxes = await page.evaluate(() => {
    const a = document.querySelector('.figure-annotator-stage img').getBoundingClientRect();
    const b = document.querySelector('canvas').getBoundingClientRect();
    return [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height];
  });
  assert.ok(boxes.every(value => Math.abs(value) < 1), `image/canvas alignment: ${boxes}`);
  const canvas = page.locator('.figure-annotator canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.up();
  assert.equal(await canvas.evaluate(node => node._strokes.length), 1);
  await page.locator('[data-annotation-undo]').click();
  assert.equal(await canvas.evaluate(node => node._strokes.length), 0);
  await page.locator('[data-annotation-redo]').click();
  assert.equal(await canvas.evaluate(node => node._strokes.length), 1);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await canvas.evaluate(node => node._strokes.at(-1).points.length), 1, 'single clicks create visible dots');
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await canvas.dispatchEvent('pointercancel', {pointerId: 1});
  await page.mouse.up();
  assert.equal(await canvas.evaluate(node => node._strokes.length), 2, 'cancelled pointer discards only the unfinished stroke');
  await page.locator('[data-annotation-width]').fill('12');
  await page.locator('[data-annotation-note]').fill('保留统计方法');
  await page.getByRole('tab', {name: '分析图', exact: true}).click();
  await content.locator('#counter').click();
  await page.evaluate(() => annotator.annotateFigure({name: 'figure.png'}));
  assert.equal(await page.getByRole('tab').count(), 2, 'reopening reuses the annotation tab');
  assert.equal(await page.locator('[data-annotation-note]').inputValue(), '保留统计方法', 'tab switch retains the draft');
  assert.equal(await canvas.evaluate(node => node._strokes.length), 2);
  failSave = true;
  await page.getByRole('button', {name: '保存批注', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-annotation-status]')?.textContent.includes('保存失败'));
  assert.equal(await page.locator('[data-annotation-note]').inputValue(), '保留统计方法');
  failSave = false;
  await page.getByRole('button', {name: '保存批注', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-annotation-status]')?.textContent === '批注已保存。');
  assert.equal(saves, 1);
  assert.equal(annotation.strokes.length, 2);
  assert.equal(annotation.note, '保留统计方法');
  assert.equal(await page.evaluate(() => applyEvents.length), 0, 'save alone never dispatches a local edit');
  assert.equal(await page.evaluate(() => annotationObservers.size), 1, 'save keeps the editable tab open');
  failSave = true;
  await page.getByRole('button', {name: '提交局部修改', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-annotation-status]')?.textContent.includes('保存失败'));
  assert.equal(await page.evaluate(() => applyEvents.length), 0, 'failed save never dispatches an apply event');
  failSave = false;
  await page.getByRole('button', {name: '提交局部修改', exact: true}).click();
  await page.waitForFunction(() => applyEvents.length === 1);
  assert.equal(saves, 2, 'apply persists the current annotation before dispatch');
  const applied = await page.evaluate(() => applyEvents[0]);
  assert.deepEqual(Object.keys(applied).sort(), ['name', 'note', 'regions']);
  assert.equal(applied.name, 'figure.png');
  assert.equal(applied.note, '保留统计方法');
  assert.equal(applied.regions.length, 2);
  for (const region of applied.regions) {
    assert.deepEqual(Object.keys(region).sort(), ['height', 'width', 'x', 'y']);
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= 1 && region.y + region.height <= 1);
  }
  assert.ok(JSON.stringify(applied).length < 500, 'event contains compact regions and no pixel/base64 payload');
  assert.deepEqual(await page.evaluate(() => annotationEvents), ['saved', 'saved', 'apply']);
  await page.locator('[data-annotation-close]').click();
  assert.equal(await page.evaluate(() => annotationObservers.size), 0, 'closing only annotation disconnects its observer');
  assert.equal(await page.getByRole('tab').count(), 1, 'closing annotation leaves the HTML tab alive');
  assert.equal(await content.locator('#counter').textContent(), '1', 'HTML tab retains its interactive state');
  await page.evaluate(async () => { window.annotationTab = await annotator.annotateFigure({name: 'figure.png'}); });
  await page.waitForFunction(() => document.querySelector('canvas')?._strokes.length === 2);
  assert.equal(await page.locator('[data-annotation-width]').inputValue(), '12', 'brush preference persists');
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  await page.getByRole('button', {name: '提交局部修改', exact: true}).scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(os.tmpdir(), 'eve-annotation-mobile.png')});
  await page.evaluate(() => bus.emit('route:request', {}));
  await page.locator('.figure-annotator').waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => annotationObservers.size), 0);
  let releaseRead;
  readGate = new Promise(resolve => { releaseRead = resolve; });
  await page.evaluate(async () => { window.annotationTab = await annotator.annotateFigure({name: 'figure.png'}); });
  await page.locator('[data-annotation-note]').waitFor();
  assert.equal(await page.getByRole('button', {name: '提交局部修改', exact: true}).isDisabled(), true);
  await page.evaluate(() => annotationTab.close());
  assert.equal(await page.evaluate(() => annotationObservers.size), 0, 'closing a loading annotation aborts and cleans up');
  releaseRead(); readGate = null;
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.figure-annotator').count(), 0, 'late reads cannot resurrect a closed tab');
  await page.evaluate(async () => { window.annotationTab = await annotator.annotateFigure({name: 'figure.png'}); });
  await page.waitForFunction(() => !document.querySelector('[data-annotation-apply]')?.disabled);
  let releaseSave;
  saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saveReceived = new Promise(resolve => { onSaveReceived = resolve; });
  await page.evaluate(() => {
    const button = document.querySelector('[data-annotation-apply]');
    button.click(); button.click();
  });
  await saveReceived;
  assert.equal(await page.getByRole('button', {name: '保存批注', exact: true}).isDisabled(), true, 'both actions lock during a pending save');
  await page.evaluate(() => annotationTab.close());
  releaseSave(); saveGate = null; onSaveReceived = () => {};
  await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(() => applyEvents.length), 1, 'closing during save cannot dispatch a late local edit');
  assert.equal(await page.evaluate(() => annotationObservers.size), 0, 'pending-save close releases the canvas observer');
  const normalized = await page.evaluate(() => annotator.normalizeAnnotationStrokes([null, {points: [{x: NaN, y: 0}]}, {color: 'url(evil)', width: 100, points: [{x: -3, y: 4}]}]));
  assert.deepEqual(normalized, [{color: '#d92d20', width: 24, points: [{x: 0, y: 1}]}]);
  const regions = await page.evaluate(() => annotator.annotationRegions([{points: [{x: -1, y: 2}], width: 3, color: '#d92d20'}]));
  assert.deepEqual(regions, [{x: 0, y: 0.995, width: 0.005, height: 0.005}]);
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS: artifact sandbox, shared annotation/HTML tabs, compact apply event after save, retry/cancel, desktop/mobile layout, drawing, persistence and cleanup');
  console.log(`Screenshots: ${os.tmpdir()}\\eve-artifacts-{desktop,mobile}.png; eve-annotation-mobile.png`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
