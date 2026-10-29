import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Real renderer files, isolated RPC fixture. No daemon, model calls or user profile writes.
test('native desktop history, locator, code disclosure and bounded lists', { timeout: 90000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL || 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('suwen.locale', 'en');
    localStorage.setItem('suwen.theme', 'light');
    window.suwen = {
      call: async method => {
        if (method === 'snapshot') return { tasks: [] };
        if (method === 'health') return { ready: true };
        if (method === 'settings') return {};
        if (method === 'conversation.list' || method === 'project.list') return [];
        if (method === 'preferences.get') return { theme: 'light' };
        return {};
      },
    };
  });
  await page.goto(new URL('../ui/index.html', import.meta.url).href);
  await page.waitForFunction(() => typeof renderChat === 'function' && typeof S !== 'undefined' && S.stream.store);
  await page.evaluate(() => {
    clearInterval(S.pollTimer);
    clearTimeout(S.chatRenderTimer);
    S.chatRenderTimer = 0;
    S.conversationSelectionTouched = true;
    S.conversationId = 'fixture';
    S.conversation = { id: 'fixture', messages: Array.from({ length: 2000 }, (_, index) => ({
      id: `m-${index}`, role: index % 2 ? 'assistant' : 'user',
      text: index % 2 ? 'Evidence is ready.\n\n```python\nprint("private-source")\n```' : `Question ${index / 2 + 1}: compare evidence and uncertainty`,
      at: 1700000000000,
    })) };
    S.snapshot = { tasks: [] };
    S.chatSignature = '';
    renderChat();
  });
  assert.equal(await page.locator('#timeline .message').count(), 80);
  assert.equal(await page.locator('#timeline .user h3').count(), 40);
  const code = page.locator('.chat-code-disclosure').first();
  assert.equal(await code.getAttribute('open'), null);
  assert.equal(await code.locator('pre').isVisible(), false);
  await code.locator('summary').click();
  assert.equal(await code.locator('pre').isVisible(), true);

  const locator = page.locator('#message-locator');
  const summary = locator.locator(':scope > summary');
  assert.equal(await summary.textContent(), 'Your messages (1000)');
  await summary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await locator.locator('li').count(), 24);
  await locator.locator('[data-locator-next]').click();
  assert.match(await locator.locator('li').first().textContent(), /^25\./);
  await locator.locator('input').fill('Question 1:');
  assert.equal(await locator.locator('li').count(), 1);
  await locator.locator('li button').click();
  assert.equal(await page.locator('[data-locator-id="0"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('[data-locator-id="0"]').isVisible(), true);
  assert.equal(await page.locator('[data-locator-id="0"]').evaluate(node => {
    const timeline = document.getElementById('timeline');
    return node.getBoundingClientRect().top >= timeline.getBoundingClientRect().top + parseFloat(getComputedStyle(timeline).paddingTop);
  }), true);
  assert.equal(await page.locator('#timeline .message').count(), 80);
  assert.equal(await page.evaluate(() => S.stream.userIntent), 'up');
  await page.locator('#jump-latest').click();
  assert.equal(await page.locator('[data-locator-id="1998"]').count(), 1);
  assert.equal(await page.evaluate(() => S.chatWindow.end), null);
  await summary.click();
  await locator.locator('input').focus();
  await page.keyboard.press('Escape');
  assert.equal(await locator.getAttribute('open'), null);
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  await summary.click();
  await locator.locator('input').fill('no such user question');
  assert.equal(await locator.locator('li').count(), 0);
  assert.match(await locator.locator('[role="status"]').textContent(), /No matching/);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    S.conversations = Array.from({ length: 300 }, (_, index) => ({ id: `c-${index}`, title: `Archive ${index}`, messages: [], mode: 'chat', updatedAt: 0 }));
    renderSessions();
  });
  const rows = page.locator('#sessions .session-cell');
  assert.ok(await rows.count() < 50);
  assert.equal(await rows.first().evaluate(node => node.getBoundingClientRect().height), 48);
  await page.locator('#sessions').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('#sessions .vrows')?.textContent.includes('Archive 299'));
  const beforeRefresh = await page.locator('#sessions').evaluate(node => node.scrollTop);
  await page.evaluate(() => renderSessions());
  assert.equal(await page.locator('#sessions').evaluate(node => node.scrollTop), beforeRefresh);
  await page.locator('#session-search').fill('Archive 29');
  assert.equal(await page.locator('#sessions .session').count(), 11);
  await page.locator('#session-search').fill('no archive');
  assert.match(await page.locator('#sessions').textContent(), /No matching/);
  await page.locator('#session-search').fill('');

  // Exercise the task-derived fallback independently of saved conversation records.
  await page.evaluate(() => {
    S.conversation = null;
    S.chatWindow = null;
    S.snapshot = { tasks: Array.from({ length: 200 }, (_, index) => ({
      id: `task-${index}`, name: `Recovered question ${index}`, status: 'completed', createdAt: 1700000000000,
      steps: [{ id: 'model', kind: 'model', input: { conversationId: 'fixture', prompt: `Recovered question ${index}` }, output: { text: 'Recovered answer' } }],
    })) };
    S.chatSignature = '';
    renderChat();
  });
  assert.equal(await page.locator('#timeline .message').count(), 80);
  await summary.click();
  await locator.locator('input').fill('Recovered question 0');
  await locator.locator('li button').click();
  assert.equal(await page.locator('[data-locator-id="0"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#timeline .message').count(), 80);

  await page.evaluate(() => {
    S.conversation = null;
    S.snapshot = { tasks: [{ id: 'live-task', name: 'Streaming question', status: 'running',
      stream: { text: 'Partial answer\n\n```python\nprint("stream-secret")' },
      steps: [{ id: 'model', kind: 'model', input: { conversationId: 'fixture', prompt: 'Streaming question' } }],
    }] };
    S.chatSignature = '';
    renderChat();
    applyStreamTextPatches();
  });
  assert.equal(await page.locator('.message.assistant pre').isVisible(), false);
  assert.ok(!(await page.locator('.message.assistant').innerText()).includes('stream-secret'));
  await page.evaluate(() => {
    S.snapshot.tasks[0].stream.text += '\n```\n\nA conclusion';
    const ref = S.stream.nodes.get('live-task');
    ref.renderedAt = -UI.timing.streamMarkdownMs;
    applyStreamTextPatches();
  });
  assert.equal(await page.locator('.message.assistant .md-code-block pre').isVisible(), false);
  assert.match(await page.locator('.message.assistant').innerText(), /A conclusion/);

  // Open and complete fences, including an empty fence and a fallback without Markdown.
  const fenced = await page.evaluate(() => {
    const samples = ['Before\n```sh\necho secret', 'Before\n~~~js\nalert(1)\n~~~\nAfter', '```\n```\nAfter'];
    return samples.map(text => {
      const bubble = messageBubble('assistant', text);
      document.getElementById('timeline').replaceChildren(bubble);
      return { details: bubble.querySelectorAll('details').length, visible: bubble.innerText, source: bubble.textContent };
    });
  });
  assert.ok(fenced.every(result => result.details === 1 && !result.visible.includes('echo secret') && !result.visible.includes('alert(1)')));
  assert.ok(fenced[1].visible.includes('After'));

  const oversized = await page.evaluate(() => {
    const text = '```sh\necho oversized-secret\n```\n\n' + 'Context '.repeat(30000);
    const bubble = messageBubble('assistant', text, { markdown: true });
    document.getElementById('timeline').replaceChildren(bubble);
    return { visible: bubble.innerText, disclosures: bubble.querySelectorAll('.chat-code-disclosure').length };
  });
  assert.ok(!oversized.visible.includes('echo oversized-secret'));

  await page.evaluate(() => { S.snapshot = { tasks: [] }; S.chatWindow = null; S.conversation = { id: 'fixture', messages: [{ id: 'one', role: 'user', text: 'Short question' }, { id: 'two', role: 'assistant', text: 'Short answer' }] }; S.chatSignature = ''; renderChat(); });
  const output = mkdtempSync(join(tmpdir(), 'eve-desktop-ui-'));
  for (const [width, height] of [[1440, 900], [700, 680], [390, 700]]) {
    await page.setViewportSize({ width, height });
    await summary.click();
    await locator.locator('input').fill('');
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.message-locator-panel').getBoundingClientRect();
      const composer = document.getElementById('composer').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, panelLeft: panel.left, panelRight: panel.right, composerBottom: composer.bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.ok(layout.panelLeft >= 0 && layout.panelRight <= layout.width, JSON.stringify(layout));
    assert.ok(layout.composerBottom <= layout.height, JSON.stringify(layout));
    await page.screenshot({ path: join(output, `${width}.png`) });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(output, `${width}-closed.png`) });
    if (width <= 700) {
      await page.locator('#toggle-sessions').click();
      assert.equal(await page.locator('#session-search').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('#toggle-sessions').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#toggle-sessions').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('#toggle-sessions').getAttribute('aria-expanded'), 'false');
    }
  }
  await page.locator('#language').click();
  await page.waitForFunction(() => document.getElementById('message-locator').textContent.includes('你的消息 (1)'));
  await page.evaluate(() => applyTheme('dark'));
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.evaluate(() => newConversation());
  await page.waitForFunction(() => document.getElementById('message-locator').hidden);
  assert.equal(await page.locator('#prompt').evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log(`Desktop UI screenshots: ${output}`);
});
