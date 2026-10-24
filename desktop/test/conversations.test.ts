import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/harness/store.js';
import type { Json } from '../src/harness/types.js';
import { appendConversationMessage, normalizeConversation } from '../src/conversations.js';

function fixture(t: { after: (fn: () => void) => void }): Store {
  const dir = mkdtempSync(join(tmpdir(), 'suwen-conversation-'));
  const store = new Store(join(dir, 'store.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may briefly retain SQLite WAL handles */ }
  });
  return store;
}

function conversation(store: Store): string {
  const record = store.putRecord('conversation', { title: 'test', mode: 'chat', messages: [], updatedAt: 1 } as unknown as Json, { id: 'conv-test' });
  return record.id;
}

test('append is idempotent for the same message id (durable retry does not duplicate transcript)', t => {
  const store = fixture(t);
  const id = conversation(store);
  const message = { id: 'a-op-1', role: 'assistant' as const, text: 'answer', at: 1000, taskId: 'task-1' };
  const first = appendConversationMessage(store, id, message);
  assert.equal(first.index, 0);
  const second = appendConversationMessage(store, id, message);
  assert.equal(second.index, 0);
  const view = normalizeConversation(store.getRecord(id)!.data);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].text, 'answer');
});

test('distinct message ids append in order and preserve the 4000-message bound', t => {
  const store = fixture(t);
  const id = conversation(store);
  for (let index = 0; index < 4005; index += 1) {
    appendConversationMessage(store, id, { id: `m-${index}`, role: 'user', text: `message ${index}`, at: index + 1 });
  }
  const view = normalizeConversation(store.getRecord(id)!.data);
  assert.equal(view.messages.length, 4000);
  assert.equal(view.messages[0].text, 'message 5');
  assert.equal(view.messages.at(-1)!.text, 'message 4004');
});

test('assistant turns are single-writer per task even with different client ids', t => {
  const store = fixture(t);
  const id = conversation(store);
  const daemonTurn = { id: 'a-op-1', role: 'assistant' as const, text: 'answer', at: 1000, taskId: 'task-1' };
  const rendererTurn = { id: 'uid-random-2', role: 'assistant' as const, text: 'answer', at: 1001, taskId: 'task-1' };
  assert.equal(appendConversationMessage(store, id, daemonTurn).index, 0);
  assert.equal(appendConversationMessage(store, id, rendererTurn).index, 0);
  assert.equal(normalizeConversation(store.getRecord(id)!.data).messages.length, 1);
  // A different task still appends its own assistant turn.
  appendConversationMessage(store, id, { id: 'a-op-2', role: 'assistant', text: 'second', at: 1002, taskId: 'task-2' });
  assert.equal(normalizeConversation(store.getRecord(id)!.data).messages.length, 2);
});

test('unknown conversation and invalid messages are rejected', t => {
  const store = fixture(t);
  assert.throws(() => appendConversationMessage(store, 'missing-conversation', { id: 'a', role: 'user', text: 'hi', at: 1 }), /Unknown conversation/);
  const id = conversation(store);
  assert.throws(() => appendConversationMessage(store, id, { id: 'a', role: 'tool' as never, text: 'hi', at: 1 }), /role is invalid/);
  assert.throws(() => appendConversationMessage(store, id, { id: 'a', role: 'user', text: '', at: 1 }), /non-empty/);
});
