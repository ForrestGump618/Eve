/**
 * Conversation records: the chat transcript is stored as one versioned record
 * per conversation (`kind: 'conversation'`) with append-only messages in the
 * record payload. Raw context snapshots remain in the context manager's
 * append-only hash chain; this record is the UI/API mirror.
 */
import { ConflictError, ValidationError, type Json } from './harness/types.js';
import type { RecordRow, RecordStore } from './shared/contract.js';
import { randomUUID } from 'node:crypto';

export type ConversationRole = 'system' | 'user' | 'assistant';
export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  text: string;
  at: number;
  taskId?: string;
  mode?: string;
  revisionOf?: string;
  supersededBy?: string;
  branchId?: string;
  replacesTaskId?: string;
}
export interface ConversationView {
  projectId: string | null;
  title: string;
  mode: string;
  messages: ConversationMessage[];
  activeBranchId?: string;
  updatedAt: number;
  legacy?: Json;
}

const MAX_MESSAGES = 4000;
const MAX_TEXT = 100_000;

export function normalizeConversation(data: Json): ConversationView {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Json>) : {};
  const messages: ConversationMessage[] = [];
  if (Array.isArray(value.messages)) {
    for (const item of value.messages.slice(0, MAX_MESSAGES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const message = item as Record<string, Json>;
      const role = message.role === 'system' || message.role === 'assistant' ? message.role : 'user';
      if (typeof message.text !== 'string') continue;
      messages.push({
        id: typeof message.id === 'string' ? message.id : `m-${messages.length}`,
        role,
        text: message.text.length > MAX_TEXT ? message.text.slice(0, MAX_TEXT) : message.text,
        at: typeof message.at === 'number' ? message.at : 0,
        ...(typeof message.taskId === 'string' ? { taskId: message.taskId } : {}),
        ...(typeof message.mode === 'string' ? { mode: message.mode } : {}),
        ...(typeof message.revisionOf === 'string' ? { revisionOf: message.revisionOf } : {}),
        ...(typeof message.supersededBy === 'string' ? { supersededBy: message.supersededBy } : {}),
        ...(typeof message.branchId === 'string' ? { branchId: message.branchId } : {}),
        ...(typeof message.replacesTaskId === 'string' ? { replacesTaskId: message.replacesTaskId } : {})
      });
    }
  }
  return {
    projectId: typeof value.projectId === 'string' ? value.projectId : null,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 300) : '新会话',
    mode: typeof value.mode === 'string' ? value.mode.slice(0, 32) : 'chat',
    messages,
    ...(typeof value.activeBranchId === 'string' && value.activeBranchId ? { activeBranchId: value.activeBranchId } : {}),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    ...(value.legacy === undefined ? {} : { legacy: value.legacy })
  };
}

export function validateMessage(message: ConversationMessage, now: number): ConversationMessage {
  if (!message || typeof message !== 'object') throw new ValidationError('message must be an object');
  if (typeof message.text !== 'string' || message.text.length < 1) throw new ValidationError('message.text must be a non-empty string');
  if (message.text.length > MAX_TEXT) throw new ValidationError(`message.text must be <= ${MAX_TEXT} characters`);
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') throw new ValidationError('message.role is invalid');
  if (typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 100) throw new ValidationError('message.id is invalid');
  const at = typeof message.at === 'number' && Number.isFinite(message.at) && message.at > 0 ? Math.round(message.at) : now;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    at,
    ...(typeof message.taskId === 'string' && message.taskId.length <= 200 ? { taskId: message.taskId } : {}),
    ...(typeof message.mode === 'string' && message.mode.length <= 32 ? { mode: message.mode } : {}),
    ...(typeof message.revisionOf === 'string' && message.revisionOf.length <= 100 ? { revisionOf: message.revisionOf } : {}),
    ...(typeof message.supersededBy === 'string' && message.supersededBy.length <= 100 ? { supersededBy: message.supersededBy } : {}),
    ...(typeof message.branchId === 'string' && message.branchId.length <= 200 ? { branchId: message.branchId } : {}),
    ...(typeof message.replacesTaskId === 'string' && message.replacesTaskId.length <= 200 ? { replacesTaskId: message.replacesTaskId } : {})
  };
}

/** Append one message with optimistic concurrency; returns the new record and message index. */
export function appendConversationMessage(store: RecordStore, conversationId: string, message: ConversationMessage, now = Date.now()): { record: RecordRow; index: number } {
  if (typeof conversationId !== 'string' || conversationId.length < 1 || conversationId.length > 200) throw new ValidationError('conversationId is invalid');
  const normalized = validateMessage(message, now);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = store.getRecord(conversationId);
    if (!current) throw new ValidationError(`Unknown conversation: ${conversationId}`);
    if (current.kind !== 'conversation') throw new ValidationError(`Record ${conversationId} is not a conversation`);
    const view = normalizeConversation(current.data);
    // Idempotent by message id: a retried durable step may append the same assistant turn
    // again (same operationId-derived id); never duplicate the transcript entry in that case.
    const existingIndex = view.messages.findIndex(entry => entry.id === normalized.id);
    if (existingIndex >= 0) return { record: current, index: existingIndex };
    // Single assistant turn per task: the daemon appends the model answer, but the renderer may
    // also append its own copy under a different client id when it observes completion first.
    // Merge by (taskId, role) so a recovered/retried task never duplicates the transcript.
    if (normalized.role === 'assistant' && normalized.taskId) {
      const taskIndex = view.messages.findIndex(entry => entry.role === 'assistant' && entry.taskId === normalized.taskId);
      if (taskIndex >= 0) return { record: current, index: taskIndex };
    }
    const messages = [...view.messages, normalized].slice(-MAX_MESSAGES);
    try {
      const record = store.putRecord('conversation', {
        projectId: view.projectId,
        title: view.title,
        mode: view.mode,
        messages,
        ...(view.activeBranchId ? { activeBranchId: view.activeBranchId } : {}),
        updatedAt: now,
        ...(view.legacy === undefined ? {} : { legacy: view.legacy })
      } as unknown as Json, { id: conversationId, expectedVersion: current.version });
      return { record, index: messages.length - 1 };
    } catch (error) {
      if (error instanceof ConflictError && attempt < 3) continue;
      throw error;
    }
  }
  throw new ConflictError('Conversation was modified concurrently; retry');
}

export interface RewriteConversationOptions {
  now?: number;
  mode?: string;
  branchId?: string;
  replacesTaskId?: string;
  pausedTaskIds?: string[];
}

/**
 * Rewrite one user turn as a new branch. The old suffix is copied to an
 * immutable audit record before the visible conversation is truncated. The
 * caller pauses active tasks first, so an in-flight run cannot silently append
 * a stale answer to the new branch.
 */
export function rewriteConversationMessage(
  store: RecordStore,
  conversationId: string,
  messageId: string,
  text: string,
  options: RewriteConversationOptions = {},
): { record: RecordRow; messages: ConversationMessage[]; branchId: string; originalIndex: number; auditId: string } {
  if (typeof conversationId !== 'string' || !conversationId) throw new ValidationError('conversationId is invalid');
  if (typeof messageId !== 'string' || !messageId) throw new ValidationError('messageId is invalid');
  const nextText = text.trim();
  if (!nextText) throw new ValidationError('message.text must be a non-empty string');
  if (nextText.length > MAX_TEXT) throw new ValidationError(`message.text must be <= ${MAX_TEXT} characters`);
  const current = store.getRecord(conversationId);
  if (!current) throw new ValidationError(`Unknown conversation: ${conversationId}`);
  if (current.kind !== 'conversation') throw new ValidationError(`Record ${conversationId} is not a conversation`);
  const view = normalizeConversation(current.data);
  const originalIndex = view.messages.findIndex(message => message.id === messageId);
  if (originalIndex < 0) throw new ValidationError('Conversation message not found');
  const original = view.messages[originalIndex]!;
  if (original.role !== 'user') throw new ValidationError('Only user messages can be rewritten');
  const now = options.now ?? Date.now();
  const branchId = options.branchId ?? `branch-${randomUUID()}`;
  const messageIdNew = `m-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const auditId = `conversation-branch-${randomUUID()}`;
  const replacedMessages = view.messages.slice(originalIndex);
  store.putRecord('conversationBranch', {
    conversationId,
    branchId,
    fromMessageId: original.id,
    toMessageId: messageIdNew,
    taskId: original.taskId ?? null,
    replacesTaskId: options.replacesTaskId ?? original.taskId ?? null,
    pausedTaskIds: options.pausedTaskIds ?? [],
    messages: replacedMessages as unknown as Json,
    at: now,
  } as unknown as Json, {
    id: auditId,
    projectId: view.projectId,
    provenance: { kind: 'conversation.rewrite', at: now, conversationId, messageId },
  });
  const revised: ConversationMessage = {
    id: messageIdNew,
    role: 'user',
    text: nextText,
    at: now,
    ...(options.mode ? { mode: options.mode } : original.mode ? { mode: original.mode } : {}),
    revisionOf: original.id,
    branchId,
    ...(options.replacesTaskId || original.taskId ? { replacesTaskId: options.replacesTaskId ?? original.taskId } : {}),
  };
  const messages = [...view.messages.slice(0, originalIndex), revised];
  const record = store.putRecord('conversation', {
    projectId: view.projectId,
    title: view.title,
    mode: options.mode ?? view.mode,
    messages,
    activeBranchId: branchId,
    updatedAt: now,
    ...(view.legacy === undefined ? {} : { legacy: view.legacy }),
  } as unknown as Json, {
    id: conversationId,
    expectedVersion: current.version,
    projectId: view.projectId,
    provenance: { kind: 'conversation.rewrite', at: now, auditId },
  });
  return { record, messages, branchId, originalIndex, auditId };
}
