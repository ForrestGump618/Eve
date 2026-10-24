/* SuWen stream core - DOM-free incremental reducer for the frozen streaming protocol v1.
   See docs/architecture/streaming-events.md. This file must stay pure: no DOM, no window,
   no timers and no network. ui/app.js consumes it; test/stream-core.test.ts loads it with
   node:vm and drives it with deterministic batches.

   Responsibilities:
   - merge StreamSnapshot text buffers into append-only deltas (UTF-16 safe suffix appends)
   - bounded eventId LRU de-duplication and per-task strictly-increasing sequence checks
   - gap detection -> one replay request (main bridge events.replay), bounded attempts
   - reset (daemon restart) -> drop per-run caches and rebuild from the batch
   - terminal immutability: late events/deltas after completed/failed/cancelled are ignored
   - two concurrent runs stay isolated by taskId; text never moves between tasks
   - renderer run-state machine and scroll-intent decision helper
*/
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var DEFAULT_MAX_SEEN = 10000;
  var DEFAULT_MAX_REPLAY_ATTEMPTS = 3;
  var TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
  var FINAL_STATUS = new Set(TERMINAL_STATUSES);
  var CONNECTION_STATES = ['reconnecting', 'restored', 'lost'];
  var MAX_STATUS = new Set([
    'queued', 'running', 'waiting_external', 'waiting_approval', 'paused',
    'retry_scheduled', 'completed', 'failed', 'cancelled',
  ].concat([]));

  /* Protocol event type -> state flags. Unknown types pass through untouched so a newer
     daemon event stays observable without a renderer release. */
  var PROTOCOL_TYPES = {
    'run.queued': 'queued',
    'step.started': 'started',
    'step.completed': 'step_done',
    'step.failed': 'step_failed',
    'step.retry_scheduled': 'retry',
    'step.reconciliation_required': 'reconcile',
    'approval.requested': 'approval',
    'approval.resolved': 'approval_done',
    'run.paused': 'paused',
    'run.resumed': 'resumed',
    'run.completed': 'completed',
    'run.failed': 'failed',
    'run.cancelled': 'cancelled',
    'context.compaction.started': 'compact_start',
    'context.compaction.completed': 'compact_done',
    'connection.reset': 'reset',
  };

  function numberOrNull(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && isFinite(Number(value))) return Number(value);
    return null;
  }

  function isTerminal(status) {
    return typeof status === 'string' && FINAL_STATUS.has(status);
  }

  function createStore(options) {
    var settings = options || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      maxSeen: numberOrNull(settings.maxSeen) || DEFAULT_MAX_SEEN,
      maxReplayAttempts: numberOrNull(settings.maxReplayAttempts) || DEFAULT_MAX_REPLAY_ATTEMPTS,
      seen: new Map(),
      tasks: new Map(),
      cursor: 0,
      lastSequence: 0,
      pendingReplaySince: null,
      replayAttempts: 0,
      replayExhausted: false,
      epoch: 0,
      connection: { state: 'connected', at: 0 },
      stats: {
        batches: 0, events: 0, streams: 0, duplicates: 0, stale: 0, gaps: 0,
        resets: 0, replays: 0, replayFailures: 0, writes: 0, chars: 0,
        ignoredTerminal: 0, connections: 0,
      },
    };
  }

  function resetStore(store) {
    store.tasks = new Map();
    store.seen = new Map();
    store.cursor = 0;
    store.lastSequence = 0;
    store.pendingReplaySince = null;
    store.replayAttempts = 0;
    store.replayExhausted = false;
    store.epoch += 1;
    store.stats.resets += 1;
  }

  function ensureTask(store, taskId) {
    if (typeof taskId !== 'string' || !taskId) return null;
    var task = store.tasks.get(taskId);
    if (task) return task;
    task = {
      taskId: taskId,
      status: 'unknown',
      version: null,
      updatedAt: null,
      text: '',
      stepId: undefined,
      updatedAtText: null,
      terminal: false,
      writes: 0,
      appendCount: 0,
      replaceCount: 0,
      approvalPending: false,
      compacting: false,
      cancelling: false,
      reconcile: false,
      started: false,
      lastEventType: '',
      lastEventAt: null,
    };
    store.tasks.set(taskId, task);
    return task;
  }

  function markChanged(task, result) {
    task.writes += 1;
    storeWrite(result);
    if (result._changed.indexOf(task.taskId) < 0) result._changed.push(task.taskId);
  }

  function storeWrite(result) {
    result.writes += 1;
  }

  function rememberSeen(store, eventId) {
    store.seen.set(eventId, true);
    while (store.seen.size > store.maxSeen) {
      var first = store.seen.keys().next();
      if (first.done) break;
      store.seen.delete(first.value);
    }
  }

  function touchStatus(task, status) {
    if (!task || typeof status !== 'string' || !MAX_STATUS.has(status)) return false;
    if (task.terminal) return false;
    var next = status;
    if (task.status === next) return false;
    task.status = next;
    if (isTerminal(next)) task.terminal = true;
    return true;
  }

  /* Global envelope sequence tracking (one daemon-wide counter). A gap requests one
     events.replay(since) through the main bridge; the replay is global, so tracking is
     global too - per-task counters would false-positive whenever another run emits. */
  function scheduleReplay(store, result, taskId) {
    store.stats.gaps += 1;
    result.gaps += 1;
    if (store.pendingReplaySince !== null) return; /* one outstanding replay at a time */
    if (store.replayAttempts >= store.maxReplayAttempts) {
      store.replayExhausted = true;
      store.stats.replayFailures += 1;
      result.replayFailed = true;
      return;
    }
    store.replayAttempts += 1;
    store.stats.replays += 1;
    store.pendingReplaySince = Math.max(0, store.lastSequence);
    result.replay = { since: store.pendingReplaySince, taskIds: taskId ? [taskId] : [] };
  }

  function applyTaskSummary(store, summary, result) {
    if (!summary || typeof summary !== 'object') return;
    var taskId = typeof summary.taskId === 'string' ? summary.taskId : (typeof summary.id === 'string' ? summary.id : '');
    if (!taskId) return;
    var existed = store.tasks.has(taskId);
    var task = ensureTask(store, taskId);
    if (!task) return;
    var status = typeof summary.status === 'string' ? summary.status : '';
    var version = numberOrNull(summary.version);
    var updatedAt = numberOrNull(summary.updatedAt);
    var wrote = false;
    if (status && !task.terminal) {
      if (task.status !== status && MAX_STATUS.has(status)) {
        task.status = status;
        if (isTerminal(status)) task.terminal = true;
        wrote = true;
      }
    }
    if (version !== null) task.version = version;
    if (updatedAt !== null) task.updatedAt = updatedAt;
    if (!existed || wrote) markChanged(task, result);
  }

  function applyEvent(store, envelope, result) {
    if (!envelope || typeof envelope !== 'object') return;
    var task = ensureTask(store, envelope.taskId);
    if (!task) return;
    store.stats.events += 1;
    var eventId = typeof envelope.eventId === 'string' ? envelope.eventId : '';
    if (eventId) {
      if (store.seen.has(eventId)) {
        result.duplicates += 1;
        store.stats.duplicates += 1;
        return;
      }
    }
    var type = typeof envelope.type === 'string' && envelope.type
      ? envelope.type
      : (typeof envelope.sourceType === 'string' ? envelope.sourceType : '');
    var sequence = numberOrNull(envelope.sequence);
    if (sequence !== null) {
      if (store.lastSequence && sequence <= store.lastSequence) {
        result.stale += 1;
        store.stats.stale += 1;
        return;
      }
      if (store.lastSequence && sequence > store.lastSequence + 1) {
        /* Keep the id unseen so the replayed copy is not mistaken for a duplicate. */
        if (eventId) store.seen.delete(eventId);
        scheduleReplay(store, result, task.taskId);
        return;
      }
      store.lastSequence = sequence;
      if (store.pendingReplaySince !== null) {
        store.pendingReplaySince = null;
        store.replayAttempts = 0;
      }
    }
    if (eventId) rememberSeen(store, eventId);
    if (task.terminal) {
      /* The run is immutable, but the global sequence above must keep advancing so
         later envelopes from healthy runs are not misread as a gap. */
      result.ignoredTerminal += 1;
      store.stats.ignoredTerminal += 1;
      return;
    }
    task.lastEventType = type;
    var at = numberOrNull(envelope.at);
    if (at !== null) task.lastEventAt = at;
    var stepId = typeof envelope.stepId === 'string' ? envelope.stepId : '';
    var kind = PROTOCOL_TYPES[type] || '';
    var wrote = false;
    switch (kind) {
      case 'queued':
        wrote = touchStatus(task, 'queued');
        break;
      case 'started':
        task.started = true;
        if (stepId) task.startedStepId = stepId;
        if (task.status === 'queued' || task.status === 'waiting_external' || task.status === 'retry_scheduled') {
          wrote = touchStatus(task, 'running');
        }
        break;
      case 'step_done':
        break;
      case 'step_failed':
        task.lastStepFailed = true;
        break;
      case 'retry':
        wrote = touchStatus(task, 'retry_scheduled');
        break;
      case 'reconcile':
        task.reconcile = true;
        wrote = touchStatus(task, 'waiting_external');
        break;
      case 'approval':
        task.approvalPending = true;
        wrote = touchStatus(task, 'waiting_approval');
        break;
      case 'approval_done':
        task.approvalPending = false;
        wrote = touchStatus(task, 'running');
        break;
      case 'paused':
        wrote = touchStatus(task, 'paused');
        break;
      case 'resumed':
        wrote = touchStatus(task, 'running');
        break;
      case 'compact_start':
        task.compacting = true;
        wrote = true;
        break;
      case 'compact_done':
        task.compacting = false;
        wrote = true;
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        if (!task.terminal) {
          task.status = kind;
          task.terminal = true;
          wrote = true;
        }
        break;
      case 'reset':
        /* surfaced by the caller as a synthetic reset; nothing task-specific to do. */
        break;
      default:
        /* Unknown protocol type: observable through lastEventType, no rendered mutation. */
        break;
    }
    if (wrote) markChanged(task, result);
  }

  function applyStream(store, snapshot, result, options) {
    if (!snapshot || typeof snapshot !== 'object') return;
    var text = typeof snapshot.text === 'string' ? snapshot.text : null;
    if (text === null) return;
    var task = ensureTask(store, snapshot.taskId);
    if (!task) return;
    store.stats.streams += 1;
    if (task.terminal) {
      result.ignoredTerminal += 1;
      store.stats.ignoredTerminal += 1;
      return;
    }
    var stepId = typeof snapshot.stepId === 'string' ? snapshot.stepId : undefined;
    var previousText = task.text;
    /* Before the first snapshot the step is unknown: adopt the incoming step and
       append from the empty string instead of replacing, so no delta is lost. */
    var sameStep = task.stepId === undefined || task.stepId === stepId;
    var kind;
    var delta = '';
    if (text === previousText) return;
    if (sameStep && text.length >= previousText.length && text.indexOf(previousText) === 0) {
      kind = 'append';
      delta = text.slice(previousText.length);
    } else if (sameStep && options && options.reconcile && text.length <= previousText.length) {
      /* Snapshot reconciliation must never shrink live text for the same step. */
      return;
    } else {
      kind = 'replace';
    }
    if (kind === 'replace' && !sameStep) task.replaceCount += 1;
    else if (kind === 'replace') task.replaceCount += 1;
    else task.appendCount += 1;
    task.text = text;
    task.stepId = stepId;
    var updatedAt = numberOrNull(snapshot.updatedAt);
    if (updatedAt !== null) task.updatedAtText = updatedAt;
    store.stats.chars += delta.length;
    markChanged(task, result);
    if (kind === 'append') result.deltas.push({ taskId: task.taskId, delta: delta, length: text.length });
  }

  function applyBatch(store, batch, options) {
    var opts = options || {};
    var result = {
      ok: false,
      schemaVersion: SCHEMA_VERSION,
      reset: false,
      epoch: store.epoch,
      cursor: store.cursor,
      writes: 0,
      deltas: [],
      changed: [],
      replay: null,
      replayFailed: false,
      duplicates: 0,
      stale: 0,
      gaps: 0,
      ignoredTerminal: 0,
      unknownSchema: false,
      batches: 0,
      _changed: [],
      get taskIds() { return this._changed.slice(); },
    };
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return result;
    var schema = numberOrNull(batch.schemaVersion);
    if (schema !== null && schema !== SCHEMA_VERSION) result.unknownSchema = true;
    result.batches = 1;
    store.stats.batches += 1;
    if (batch.reset === true) {
      resetStore(store);
      result.reset = true;
      result.epoch = store.epoch;
    }
    var cursor = numberOrNull(batch.cursor);
    if (cursor !== null && cursor > store.cursor) store.cursor = cursor;
    var summaries = Array.isArray(batch.tasks) ? batch.tasks : [];
    for (var t = 0; t < summaries.length; t += 1) applyTaskSummary(store, summaries[t], result);
    var events = Array.isArray(batch.events) ? batch.events.slice(0) : [];
    if (events.length > 1) {
      events.sort(function (left, right) {
        var a = numberOrNull(left && left.sequence);
        var b = numberOrNull(right && right.sequence);
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b;
      });
    }
    for (var e = 0; e < events.length; e += 1) applyEvent(store, events[e], result);
    var streams = Array.isArray(batch.streams) ? batch.streams : [];
    for (var s = 0; s < streams.length; s += 1) applyStream(store, streams[s], result, opts);
    /* A replay response that still leaves the gap open consumes one attempt. If the
       budget is exhausted, stop asking and surface replayFailed so the UI can fall
       back to the slow snapshot reconciliation. */
    if (opts.fromReplay && store.pendingReplaySince !== null) {
      store.replayAttempts += 1;
      if (store.replayAttempts >= store.maxReplayAttempts) {
        store.pendingReplaySince = null;
        store.replayExhausted = true;
        store.stats.replayFailures += 1;
        result.replayFailed = true;
      }
    }
    result.ok = true;
    result.cursor = store.cursor;
    result.epoch = store.epoch;
    result.changed = result._changed.slice();
    return result;
  }

  function applyConnection(store, payload) {
    var state = payload && typeof payload === 'object' && typeof payload.state === 'string' ? payload.state : '';
    if (CONNECTION_STATES.indexOf(state) < 0) return { ok: false, state: store.connection.state };
    store.stats.connections += 1;
    store.connection = { state: state, at: numberOrNull(payload.at) || 0 };
    if (state === 'restored') {
      /* A reconnect grants a fresh replay budget; terminal tasks stay immutable. */
      store.replayAttempts = 0;
      store.replayExhausted = false;
    }
    return { ok: true, state: state };
  }

  function markCancelling(store, taskId) {
    var task = store.tasks.get(taskId);
    if (!task || task.terminal) return false;
    if (task.cancelling) return false;
    task.cancelling = true;
    return true;
  }

  function taskView(store, taskId) {
    var task = store.tasks.get(taskId);
    if (!task) return null;
    return {
      taskId: task.taskId,
      status: task.status,
      version: task.version,
      updatedAt: task.updatedAt,
      text: task.text,
      stepId: task.stepId,
      updatedAtText: task.updatedAtText,
      terminal: task.terminal,
      approvalPending: task.approvalPending,
      compacting: task.compacting,
      cancelling: task.cancelling,
      lastEventType: task.lastEventType,
    };
  }

  /* Renderer run state machine. Exactly one state; terminal state wins over transport
     issues so a completed run is never shown as reconnecting. */
  function runState(store, taskId) {
    var connection = store.connection && store.connection.state ? store.connection.state : 'connected';
    var disconnected = connection === 'reconnecting' || connection === 'lost';
    var task = taskId ? store.tasks.get(taskId) : null;
    if (!task) return disconnected ? 'reconnecting' : 'idle';
    if (task.terminal) return task.status;
    if (task.cancelling) return 'cancelling';
    if (disconnected) return 'reconnecting';
    if (task.status === 'paused') return 'paused';
    if (task.compacting) return 'compacting';
    if (task.approvalPending || task.status === 'waiting_approval') return 'waiting_approval';
    if (task.reconcile || task.status === 'waiting_external') return 'waiting_approval';
    if (task.status === 'retry_scheduled') return 'preparing';
    if (task.status === 'queued') return 'preparing';
    if (task.status === 'running') {
      if (task.text && task.text.length > 0) return 'streaming';
      if (task.lastEventType === 'step.started') return 'tool_running';
      return 'preparing';
    }
    return 'idle';
  }

  /* Scroll intent: follow new output only while the user is pinned to the bottom.
     A user scrolling up must win even if the view still looks close to the bottom. */
  function shouldFollowScroll(input) {
    var state = input || {};
    if (state.userIntent === 'up') return false;
    if (state.pinned === true) return true;
    if (state.pinned === false) return false;
    return state.nearBottom === true;
  }

  function stats(store) {
    return Object.assign({}, store.stats, { cursor: store.cursor, epoch: store.epoch, tasks: store.tasks.size });
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    TERMINAL_STATUSES: TERMINAL_STATUSES.slice(0),
    CONNECTION_STATES: CONNECTION_STATES.slice(0),
    PROTOCOL_TYPES: Object.assign({}, PROTOCOL_TYPES),
    createStore: createStore,
    resetStore: resetStore,
    applyBatch: applyBatch,
    applyConnection: applyConnection,
    markCancelling: markCancelling,
    taskView: taskView,
    runState: runState,
    shouldFollowScroll: shouldFollowScroll,
    isTerminal: isTerminal,
    stats: stats,
  };

  if (root) {
    root.SuwenStreamCore = api;
    /* The task contract names the global SuWenStreamCore; keep both spellings so the
       reducer stays reachable from either integration. */
    root.SuWenStreamCore = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
