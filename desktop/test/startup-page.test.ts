import assert from 'node:assert/strict';
import test from 'node:test';
import {startupPage, startupStateScript} from '../src/startup-page.js';

function decode(dataUrl: string): string {
  assert.ok(dataUrl.startsWith('data:text/html;charset=utf-8,'));
  return decodeURIComponent(dataUrl.slice('data:text/html;charset=utf-8,'.length));
}

test('startup page uses the hosted workbench visual language', () => {
  const html = decode(startupPage('1.5.0', {
    title: '正在准备 Eve',
    detail: '检查本地运行环境',
  }));
  assert.match(html, /科研工作台/);
  assert.match(html, /--accent: #3157d5/);
  assert.match(html, /--neutral-50: #f7f8fa/);
  assert.match(html, /--neutral-130: #f0f2f5/);
  assert.match(html, /--neutral-980: #171b21/);
  assert.match(html, /setEveStartupState/);
  assert.match(html, /data-state/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /1\.5\.0/);
  assert.doesNotMatch(html, /#eef1f6|#f5f5f5/);
});

test('startup progress and failure states are text-only and escaped', () => {
  const script = startupStateScript({
    title: '启动未完成',
    detail: '<script>alert(1)</script>',
    failed: true,
  });
  assert.match(script, /window\.setEveStartupState/);
  assert.match(script, /\\u003cscript>/);
  assert.doesNotMatch(script, /<script>/);

  const html = decode(startupPage('1.5.0', {
    title: '启动未完成',
    detail: '<img src=x onerror=alert(1)>',
    failed: true,
  }));
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
