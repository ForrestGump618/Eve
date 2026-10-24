/**
 * Streaming event collection for the `events.stream` RPC (see
 * docs/architecture/streaming-events.md). Pure mapping from persisted store
 * events + live model buffers to the frozen wire protocol; no I/O besides the
 * Store reads needed for task summaries.
 */
import type { Store } from './harness/store.js';
import type { Json, RunEvent } from './harness/types.js';
import {
  STREAM_EVENT_SCHEMA_VERSION,
  type StreamBatch,
  type StreamBuffer,
  type StreamEnvelope,
  type StreamSnapshotView,
  type StreamTaskSummary,
} from './shared/contract.js';

/** Persisted store event type -> protocol event type. Unknown types pass through. */
const PROTOCOL_TYPES: Record<string, string> = {
  'task.created': 'run.queued',
  'step.claimed': 'step.started',
  'step.completed': 'step.completed',
  'step.failed': 'step.failed',
  'step.retry_scheduled': 'step.retry_scheduled',
  'step.reconciliation_required': 'step.reconciliation_required',
  'step.waiting_approval': 'approval.requested',
  'approval.resolved': 'approval.resolved',
  'task.paused': 'run.paused',
  'task.resumed': 'run.resumed',
  'task.completed': 'run.completed',
  'task.failed': 'run.failed',
  'task.cancelled': 'run.cancelled',
  'task.retry_scheduled': 'run.retry_scheduled',
  'context.compaction.started': 'context.compaction.started',
  'context.compaction.completed': 'context.compaction.completed',
};

export function protocolEventType(sourceType: string): string {
  return PROTOCOL_TYPES[sourceType] ?? sourceType;
}

function envelope(event: RunEvent): StreamEnvelope {
  return {
    schemaVersion: STREAM_EVENT_SCHEMA_VERSION,
    eventId: `e:${event.sequence}`,
    sequence: event.sequence,
    taskId: event.taskId,
    stepId: event.stepId ?? undefined,
    type: protocolEventType(event.type),
    sourceType: event.type,
    at: event.at,
    payload: event.data,
  };
}

function integer(value: Json | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Collect the event window after `since` plus the current live text buffers.
 * `streams` is keyed by task id and is owned by the daemon's model activity.
 */
export function collectStreamEvents(
  store: Store,
  streams: Map<string, StreamBuffer>,
  params: Record<string, Json> = {},
): StreamBatch {
  const since = integer(params.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(params.limit, 500, 1, 2000);
  const maximum = store.maxEventSequence();
  const reset = since > maximum;
  const events = reset ? [] : store.eventsSince(since, limit);
  const cursor = events.length > 0 ? events[events.length - 1].sequence : reset ? 0 : since;

  const tasks = new Map<string, StreamTaskSummary>();
  const addTask = (taskId: string): void => {
    if (tasks.has(taskId)) return;
    const task = store.getTask(taskId);
    if (!task) return;
    tasks.set(taskId, { taskId: task.id, status: task.status, version: task.version, updatedAt: task.updatedAt });
  };
  for (const event of events) addTask(event.taskId);

  const views: StreamSnapshotView[] = [];
  for (const [taskId, buffer] of streams) {
    // A stale buffer for a deleted task must not leak into the UI.
    const task = store.getTask(taskId);
    if (!task) continue;
    addTask(taskId);
    views.push({ taskId, stepId: buffer.stepId, text: buffer.text, updatedAt: buffer.updatedAt });
  }

  const batch: StreamBatch = {
    schemaVersion: STREAM_EVENT_SCHEMA_VERSION,
    cursor,
    tasks: [...tasks.values()],
    events: events.map(envelope),
    streams: views,
  };
  if (reset) batch.reset = true;
  return batch;
}
