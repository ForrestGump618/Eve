import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/harness/store.js';
import { collectStreamEvents, protocolEventType } from '../src/stream-events.js';
import type { StreamBuffer } from '../src/shared/contract.js';

function storeInTemp(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'suwen-stream-'));
  return { store: new Store(join(dir, 'harness.sqlite')), dir };
}

test('protocol event types map persisted names onto the v1 wire protocol', () => {
  assert.equal(protocolEventType('task.created'), 'run.queued');
  assert.equal(protocolEventType('step.claimed'), 'step.started');
  assert.equal(protocolEventType('step.waiting_approval'), 'approval.requested');
  assert.equal(protocolEventType('task.completed'), 'run.completed');
  // unknown types pass through so a future store event is not silently lost
  assert.equal(protocolEventType('step.heartbeat'), 'step.heartbeat');
});

test('initial batch contains task.created event and task summary', () => {
  const { store, dir } = storeInTemp();
  try {
    const task = store.createTask({ steps: [{ id: 'a', kind: 'echo' }] });
    const streams = new Map<string, StreamBuffer>();
    const batch = collectStreamEvents(store, streams, { since: 0 });
    assert.equal(batch.schemaVersion, 1);
    assert.equal(batch.reset, undefined);
    assert.ok(batch.events.length >= 1);
    const created = batch.events.find(event => event.sourceType === 'task.created');
    assert.ok(created);
    assert.equal(created.type, 'run.queued');
    assert.equal(created.taskId, task.id);
    assert.equal(created.eventId, `e:${created.sequence}`);
    assert.equal(batch.cursor, batch.events[batch.events.length - 1]!.sequence);
    assert.ok(batch.tasks.some(summary => summary.taskId === task.id && summary.status === 'queued'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor windows are monotonic and do not repeat delivered events', () => {
  const { store, dir } = storeInTemp();
  try {
    for (let index = 0; index < 5; index += 1) store.createTask({ steps: [{ id: 'a', kind: 'echo' }] });
    const streams = new Map<string, StreamBuffer>();
    const first = collectStreamEvents(store, streams, { since: 0 });
    assert.ok(first.events.length >= 5);
    const second = collectStreamEvents(store, streams, { since: first.cursor });
    assert.equal(second.events.length, 0);
    assert.equal(second.cursor, first.cursor);
    assert.equal(second.reset, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cursor beyond the newest sequence asks the client to reset', () => {
  const { store, dir } = storeInTemp();
  try {
    store.createTask({ steps: [{ id: 'a', kind: 'echo' }] });
    const streams = new Map<string, StreamBuffer>();
    const batch = collectStreamEvents(store, streams, { since: store.maxEventSequence() + 50 });
    assert.equal(batch.reset, true);
    assert.equal(batch.cursor, 0);
    assert.equal(batch.events.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live stream buffers are attached to their task and stale buffers are dropped', () => {
  const { store, dir } = storeInTemp();
  try {
    const task = store.createTask({ steps: [{ id: 'model', kind: 'model' }] });
    const streams = new Map<string, StreamBuffer>([
      [task.id, { text: 'hello 世界', stepId: 'model', updatedAt: 1234 }],
      ['missing-task', { text: 'stale', updatedAt: 1 }],
    ]);
    const batch = collectStreamEvents(store, streams, { since: 0 });
    const view = batch.streams.find(stream => stream.taskId === task.id);
    assert.ok(view);
    assert.equal(view.text, 'hello 世界');
    assert.equal(view.stepId, 'model');
    assert.ok(batch.tasks.some(summary => summary.taskId === task.id));
    assert.equal(batch.streams.some(stream => stream.taskId === 'missing-task'), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parameters are clamped and invalid values fall back safely', () => {
  const { store, dir } = storeInTemp();
  try {
    store.createTask({ steps: [{ id: 'a', kind: 'echo' }] });
    const streams = new Map<string, StreamBuffer>();
    const negative = collectStreamEvents(store, streams, { since: -10, limit: -5 });
    assert.equal(negative.reset, undefined);
    const huge = collectStreamEvents(store, streams, { since: 0, limit: 100000 });
    assert.ok(huge.events.length <= 2000);
    const invalid = collectStreamEvents(store, streams, { since: 'nope' as unknown as number, limit: 'nope' as unknown as number });
    assert.equal(invalid.reset, undefined);
    assert.ok(Array.isArray(invalid.events));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
