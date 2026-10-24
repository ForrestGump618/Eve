import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareContextAsync } from '../src/context-async.js';
import type { ContextOptions, PrepareContext } from '../src/context.js';

const options = (directory: string): ContextOptions => ({ directory, model: 'gpt-4o', contextWindow: 64_000, outputTokens: 256 });
const request = (content: string): PrepareContext => ({ messages: [{ role: 'user', content }] });

test('worker preparation keeps daemon timers responsive', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-async-'));
  let ticks = 0;
  const interval = setInterval(() => { ticks++; }, 5);
  try {
    const result = await prepareContextAsync(options(directory), request(' datapoint'.repeat(10_000)));
    assert.equal(result.action, 'none');
    assert.ok(ticks >= 2, `daemon timer should run while tokenization is in progress, got ${ticks} ticks`);
  } finally { clearInterval(interval); rmSync(directory, { recursive: true, force: true }); }
});

test('same-directory requests serialize and queued cancellation never writes', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-queue-'));
  const controller = new AbortController();
  try {
    const first = prepareContextAsync(options(directory), { ...request('first goal'), force: true });
    const queued = prepareContextAsync(options(join(directory, '.')), request('cancelled secret goal'), controller.signal);
    const cancelledAssertion = assert.rejects(queued, { name: 'AbortError' });
    controller.abort();
    const third = prepareContextAsync(options(directory), { ...request('third goal'), force: true });
    await cancelledAssertion;
    const [one, three] = await Promise.all([first, third]);
    assert.equal(one.summary?.version, 1);
    assert.equal(three.summary?.version, 2);
    const raw = readFileSync(join(directory, 'raw-events.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    assert.ok(!raw.includes('cancelled secret goal'));
    assert.ok(raw.includes('first goal') && raw.includes('third goal'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cancelled work terminates its worker before a following writer starts', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'suwen-context-abort-'));
  const directory = join(root, 'not-created');
  const controller = new AbortController();
  try {
    const work = prepareContextAsync(options(directory), { messages: [
      { role: 'user', content: 'A cancellable analysis.' },
      { role: 'assistant', content: ' datapoint'.repeat(50_000) },
    ] }, controller.signal);
    const rejected = assert.rejects(work, { name: 'AbortError' });
    // Raw append precedes the CPU-heavy count: cancellation now interrupts a
    // genuinely running preparation instead of only worker module startup.
    const rawPath = join(directory, 'raw-events.jsonl');
    const deadline = Date.now() + 5000;
    while (!existsSync(rawPath) && Date.now() < deadline) await delay(5);
    assert.ok(existsSync(rawPath));
    controller.abort();
    await rejected;
    const following = await prepareContextAsync(options(directory), request('following goal'));
    assert.equal(following.action, 'none');
    const raw = readFileSync(join(directory, 'raw-events.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    assert.ok(raw.includes('following goal'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-aborted requests create no archive and worker errors do not disclose model text', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'suwen-context-error-'));
  const directory = join(root, 'not-created');
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(prepareContextAsync(options(directory), request('never write'), controller.signal), { name: 'AbortError' });
    assert.equal(existsSync(directory), false);
    await assert.rejects(prepareContextAsync({ ...options(directory), model: 'unknown-sk-secret-value' }, request('private')), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Context preparation failed');
      assert.ok(!error.message.includes('sk-secret-value'));
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
