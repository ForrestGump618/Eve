import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const baselineRef = process.env.UI_BASELINE_REF || 'HEAD';
const git = args => execFileSync('git', args, { cwd: root });
const baselineFiles = git(['ls-tree', '-r', '--name-only', baselineRef, '--', 'desktop/ui']).toString().trim().split(/\r?\n/);
const sourceBytes = value => Buffer.byteLength(value.toString().replaceAll('\r\n', '\n'));
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const currentFiles = files(resolve(root, 'desktop/ui')).map(path => relative(root, path).replaceAll('\\', '/'));
const assetBytes = [...new Set([...baselineFiles, ...currentFiles])].map(path => ({
  path,
  before: baselineFiles.includes(path) ? sourceBytes(git(['show', `${baselineRef}:${path}`])) : 0,
  after: currentFiles.includes(path) ? sourceBytes(readFileSync(resolve(root, path))) : 0,
})).map(row => ({ ...row, delta: row.after - row.before }));

const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL || 'msedge', headless: true });
const measure = async changed => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    // Identical parent geometry and text; load each version's actual bubble renderer and CSS.
    await page.setContent('<main><section id="chat" class="page"><div id="timeline" class="timeline"></div></section></main>');
    const source = path => changed ? readFileSync(resolve(root, path), 'utf8') : git(['show', `${baselineRef}:${path}`]).toString();
    await page.addStyleTag({ content: source('desktop/ui/style.css') });
    if (changed) for (const name of ['ui-config', 'chat-presentation']) await page.addScriptTag({ content: source(`desktop/ui/${name}.js`) });
    await page.addScriptTag({ content: source('desktop/ui/app.js').replace(/void boot\(\);\s*$/, '') });
    return await page.evaluate(() => {
      locale = 'en';
      document.documentElement.dataset.theme = 'light';
      const bubble = messageBubble('user', 'Short question', { meta: '12:00:00' });
      document.getElementById('timeline').append(bubble);
      const style = getComputedStyle(bubble);
      const body = getComputedStyle(bubble.querySelector('.body'));
      const box = bubble.getBoundingClientRect();
      return { text: 'Short question', height: box.height, width: box.width, paddingBlock: style.paddingTop, gap: style.gap, font: body.fontFamily, bodyFontSize: body.fontSize, bodyLineHeight: body.lineHeight };
    });
  } finally { await page.close(); }
};
try {
  const before = await measure(false);
  const after = await measure(true);
  assert.equal(before.font, after.font);
  assert.equal(before.bodyFontSize, after.bodyFontSize);
  assert.equal(before.bodyLineHeight, after.bodyLineHeight);
  assert.ok(after.height < before.height);
  const totals = assetBytes.reduce((sum, row) => ({ before: sum.before + row.before, after: sum.after + row.after }), { before: 0, after: 0 });
  console.log(JSON.stringify({
    baseline: git(['rev-parse', baselineRef]).toString().trim(),
    environment: { browser: await browser.version(), viewport: '1440x900', theme: 'light', text: 'Short question', meta: '12:00:00', comparison: 'same geometry, actual git baseline/current source renderer and CSS; no boot or RPC' },
    userBubble: { before, after, heightDelta: after.height - before.height, heightReductionPercent: Number(((1 - after.height / before.height) * 100).toFixed(2)) },
    assetBytes: { ...totals, delta: totals.after - totals.before, convention: 'All desktop/ui source assets, normalized to LF for a like-for-like Git comparison; excludes tests and generated vendor assets', onDiskAfter: currentFiles.reduce((sum, path) => sum + readFileSync(resolve(root, path)).byteLength, 0), changedFiles: assetBytes.filter(row => row.delta) },
  }, null, 2));
} finally { await browser.close(); }
