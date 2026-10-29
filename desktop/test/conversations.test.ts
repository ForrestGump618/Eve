import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/harness/store.js';
import type { Json } from '../src/harness/types.js';
import { appendConversationMessage, normalizeConversation, rewriteConversationMessage } from '../src/conversations.js';

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

test('rewriting a user turn creates an auditable branch and preserves the old suffix', t => {
  const store = fixture(t);
  const id = conversation(store);
  appendConversationMessage(store, id, { id: 'u1', role: 'user', text: 'Question', at: 10, taskId: 'task-1' });
  appendConversationMessage(store, id, { id: 'a1', role: 'assistant', text: 'Old answer', at: 11, taskId: 'task-1' });
  appendConversationMessage(store, id, { id: 'u2', role: 'user', text: 'Follow up', at: 12, taskId: 'task-2' });

  const rewritten = rewriteConversationMessage(store, id, 'u1', 'Corrected question', {
    now: 20, branchId: 'branch-fixed', replacesTaskId: 'task-1', pausedTaskIds: ['task-1', 'task-2'],
  });
  assert.equal(rewritten.originalIndex, 0);
  assert.equal(rewritten.branchId, 'branch-fixed');
  assert.equal(rewritten.messages.length, 1);
  assert.equal(rewritten.messages[0]!.text, 'Corrected question');
  assert.equal(rewritten.messages[0]!.revisionOf, 'u1');
  assert.equal(rewritten.messages[0]!.replacesTaskId, 'task-1');
  const view = normalizeConversation(store.getRecord(id)!.data);
  assert.equal(view.activeBranchId, 'branch-fixed');
  assert.equal(view.messages.length, 1);
  const audit = store.getRecord(rewritten.auditId)!;
  assert.equal(audit.kind, 'conversationBranch');
  const payload = audit.data as Record<string, Json>;
  assert.deepEqual(payload.pausedTaskIds, ['task-1', 'task-2']);
  assert.equal((payload.messages as Json[]).length, 3);
  assert.equal((payload.messages as Array<Record<string, Json>>)[1]!.role, 'assistant');
});

test('only user turns can be rewritten and missing turns are rejected', t => {
  const store = fixture(t);
  const id = conversation(store);
  appendConversationMessage(store, id, { id: 'a1', role: 'assistant', text: 'Answer', at: 1 });
  assert.throws(() => rewriteConversationMessage(store, id, 'a1', 'Changed'), /Only user messages/);
  assert.throws(() => rewriteConversationMessage(store, id, 'missing', 'Changed'), /not found/);
});
