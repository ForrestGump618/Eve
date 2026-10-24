/**
 * Conversation records: the chat transcript is stored as one versioned record
 * per conversation (`kind: 'conversation'`) with append-only messages in the
 * record payload. Raw context snapshots remain in the context manager's
 * append-only hash chain; this record is the UI/API mirror.
 */
import { ConflictError, ValidationError, type Json } from './harness/types.js';
import type { RecordRow, RecordStore } from './shared/contract.js';

export type ConversationRole = 'system' | 'user' | 'assistant';
export interface ConversationMessage { id: string; role: ConversationRole; text: string; at: number; taskId?: string; mode?: string }
export interface ConversationView {
  projectId: string | null;
  title: string;
  mode: string;
  messages: ConversationMessage[];
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
        ...(typeof message.mode === 'string' ? { mode: message.mode } : {})
      });
    }
  }
  return {
    projectId: typeof value.projectId === 'string' ? value.projectId : null,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 300) : '新会话',
    mode: typeof value.mode === 'string' ? value.mode.slice(0, 32) : 'chat',
    messages,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
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
    ...(typeof message.mode === 'string' && message.mode.length <= 32 ? { mode: message.mode } : {})
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
    const messages = [...view.messages, normalized].slice(-MAX_MESSAGES);
    try {
      const record = store.putRecord('conversation', {
        projectId: view.projectId,
        title: view.title,
        mode: view.mode,
        messages,
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
