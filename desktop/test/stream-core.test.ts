import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/* These tests load the real ui/stream-core.js with node:vm (no DOM, no bundler) so the
   reducer that ships inside the Electron renderer is the exact code under test. */

type Json = Record<string, unknown>;

interface StreamBatch {
  schemaVersion?: number;
  cursor?: number;
  reset?: boolean;
  tasks?: Json[];
  events?: Json[];
  streams?: Json[];
}

interface StreamResult {
  ok: boolean;
  reset: boolean;
  epoch: number;
  cursor: number;
  writes: number;
  changed: string[];
  deltas: Array<{ taskId: string; delta: string; length: number }>;
  replay: { since: number; taskIds: string[] } | null;
  replayFailed: boolean;
  duplicates: number;
  stale: number;
  gaps: number;
  ignoredTerminal: number;
  unknownSchema: boolean;
}

interface TaskView {
  taskId: string;
  status: string;
  text: string;
  stepId?: string;
  terminal: boolean;
}

interface StreamStore {
  maxSeen: number;
  maxReplayAttempts: number;
  seen: Map<string, unknown>;
  tasks: Map<string, Json>;
  epoch: number;
  connection: { state: string; at: number };
  stats: Record<string, number>;
}

interface Core {
  SCHEMA_VERSION: number;
  createStore(options?: Json): StreamStore;
  applyBatch(store: StreamStore, batch: StreamBatch, options?: Json): StreamResult;
  applyConnection(store: StreamStore, payload: Json): { ok: boolean; state: string };
  markCancelling(store: StreamStore, taskId: string): boolean;
  taskView(store: StreamStore, taskId: string): TaskView | null;
  runState(store: StreamStore, taskId: string): string;
  shouldFollowScroll(input: Json): boolean;
  isTerminal(status: string): boolean;
  stats(store: StreamStore): Record<string, number>;
}

const corePath = fileURLToPath(new URL('../../ui/stream-core.js', import.meta.url));

function loadCore(): Core {
  const source = readFileSync(corePath, 'utf8');
  const sandbox: Record<string, unknown> = { console };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'stream-core.js' });
  const loaded = sandbox.SuwenStreamCore as Core | undefined;
  assert.ok(loaded, 'stream-core.js must expose SuwenStreamCore through the vm sandbox');
  return loaded;
}

const core: Core = loadCore();

function event(sequence: number, taskId: string, type: string, extra: Json = {}): Json {
  return {
    schemaVersion: 1,
    eventId: `e:${sequence}`,
    sequence,
    taskId,
    stepId: 's1',
    type,
    sourceType: type,
    at: 1700000000000 + sequence,
    payload: {},
    ...extra,
  };
}

function batch(parts: StreamBatch = {}): StreamBatch {
  return { schemaVersion: 1, cursor: 0, ...parts };
}

function summary(taskId: string, status: string, version = 1): Json {
  return { taskId, status, version, updatedAt: 1000 + version };
}

function stream(taskId: string, text: string, stepId = 's1'): Json {
  return { taskId, stepId, text, updatedAt: 1000 + text.length };
}

function apply(store: StreamStore, parts: StreamBatch, options: Json = {}): StreamResult {
  return core.applyBatch(store, batch(parts), options);
}

function fresh(options: Json = {}): StreamStore {
  return core.createStore(options);
}

test('stream core loads in a DOM-free vm sandbox and exposes the frozen schema version', () => {
  assert.equal(core.SCHEMA_VERSION, 1);
  const store = fresh();
  assert.equal(store.epoch, 0);
  assert.equal(store.connection.state, 'connected');
  assert.equal(core.runState(store, 'missing'), 'idle');
  assert.equal(store.seen.size, 0);
});

test('100, 1000 and 10000 single-character stream deltas lose, duplicate and reorder nothing', () => {
  for (const count of [100, 1000, 10000]) {
    const store = fresh();
    const taskId = `task-${count}`;
    let expected = '';
    let rendered = '';
    let lastLength = 0;
    let maxDelta = 0;
    for (let index = 0; index < count; index += 1) {
      const char = String.fromCharCode(97 + (index % 26));
      expected += char;
      const result = apply(store, { cursor: index + 1, streams: [stream(taskId, expected)] });
      assert.equal(result.ok, true);
      assert.equal(result.deltas.length, 1, `exactly one delta per appended snapshot at ${index}`);
      assert.equal(result.deltas[0]!.delta, char);
      assert.equal(result.deltas[0]!.length, expected.length);
      assert.ok(result.deltas[0]!.length > lastLength);
      lastLength = result.deltas[0]!.length;
      maxDelta = Math.max(maxDelta, result.deltas[0]!.delta.length);
      rendered += result.deltas[0]!.delta;
      assert.equal(result.writes, 1);
    }
    const view = core.taskView(store, taskId);
    assert.ok(view);
    assert.equal(view!.text, expected);
    assert.equal(view!.text.length, count);
    assert.equal(rendered, expected, 'renderer-applied deltas equal the source snapshot');
    assert.equal(maxDelta, 1);
    assert.equal(store.stats.chars, count);
    assert.equal(store.stats.duplicates, 0);
    assert.equal(store.stats.stale, 0);
  }
});

test('UTF-16 surrogate pairs split across appended suffixes keep the code units intact', () => {
  const store = fresh();
  const taskId = 'surrogate';
  const steps: Array<[string, string]> = [
    ['a\uD83D', 'a\uD83D'],
    ['a\uD83D\uDE00', '\uDE00'],
    ['a\uD83D\uDE00b', 'b'],
  ];
  for (const [text, expectedDelta] of steps) {
    const result = apply(store, { streams: [stream(taskId, text)] });
    assert.equal(result.deltas.length, 1);
    assert.equal(result.deltas[0]!.delta, expectedDelta);
  }
  const view = core.taskView(store, taskId);
  assert.equal(view!.text, 'a\uD83D\uDE00b');
  assert.equal(view!.text.length, 4);
  assert.equal([...view!.text].length, 3, 'two code units still form one code point');
  assert.equal(view!.text.indexOf('\uFFFD'), -1, 'no replacement character was introduced');
});

test('duplicate event ids and repeated stream snapshots write nothing twice', () => {
  const store = fresh();
  const taskId = 'dup';
  const first = apply(store, {
    tasks: [summary(taskId, 'queued')],
    events: [event(1, taskId, 'run.queued')],
    streams: [stream(taskId, 'hello')],
  });
  assert.equal(first.writes, 2, 'task summary status and the stream text each write once');
  const second = apply(store, {
    events: [event(1, taskId, 'run.queued')],
    streams: [stream(taskId, 'hello')],
  });
  assert.equal(second.writes, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(core.taskView(store, taskId)!.text, 'hello');
});

test('out-of-order envelopes are stale and never move state backwards', () => {
  const store = fresh();
  const taskId = 'order';
  apply(store, { events: [event(1, taskId, 'run.queued'), event(2, taskId, 'step.started')] });
  assert.equal(core.taskView(store, taskId)!.status, 'running');
  apply(store, { streams: [stream(taskId, 'abc')] });
  const stale = apply(store, { events: [event(2, taskId, 'run.paused', { eventId: 'late:2' })] });
  assert.equal(stale.stale, 1);
  assert.equal(stale.writes, 0);
  assert.equal(core.taskView(store, taskId)!.status, 'running');
  assert.equal(store.stats.stale, 1);
});

test('events inside one batch are applied in ascending sequence order', () => {
  const store = fresh();
  const taskId = 'sort';
  apply(store, { events: [event(1, taskId, 'run.queued'), event(2, taskId, 'step.started')] });
  /* If processed in array order, run.resumed (4) then run.paused (3) would end paused. */
  const result = apply(store, {
    events: [event(4, taskId, 'run.resumed'), event(3, taskId, 'run.paused')],
  });
  assert.equal(result.ok, true);
  assert.equal(core.taskView(store, taskId)!.status, 'running', 'ascending order ends on the resumed event');
});

test('a sequence gap requests exactly one replay and resolves once the gap is filled', () => {
  const store = fresh();
  const taskId = 'gap';
  apply(store, { events: [event(1, taskId, 'run.queued'), event(2, taskId, 'step.started')] });
  const gap = apply(store, { events: [event(4, taskId, 'step.completed')] });
  assert.ok(gap.replay);
  assert.equal(gap.replay!.since, 2);
  assert.equal(gap.gaps, 1);
  assert.equal(gap.writes, 0, 'gap event is not rendered before the replay');
  /* While a replay is outstanding no new request is emitted. */
  const again = apply(store, { events: [event(5, taskId, 'step.completed', { eventId: 'e:5' })] });
  assert.equal(again.replay, null);
  assert.equal(again.gaps, 1);
  const replayed = apply(
    store,
    { events: [event(3, taskId, 'step.completed'), event(4, taskId, 'step.completed')] },
    { fromReplay: true },
  );
  assert.equal(replayed.replay, null);
  assert.equal(replayed.replayFailed, false);
  assert.equal(replayed.stale, 0);
  assert.equal(store.stats.replays, 1);
});

test('replay attempts are bounded so a permanently missing event cannot loop forever', () => {
  const store = fresh({ maxReplayAttempts: 2 });
  const taskId = 'exhaust';
  apply(store, { events: [event(1, taskId, 'run.queued')] });
  const gap = apply(store, { events: [event(3, taskId, 'step.started')] });
  assert.equal(gap.replay!.since, 1);
  const first = apply(store, { events: [] }, { fromReplay: true });
  assert.equal(first.replayFailed, true, 'the second failed replay attempt exhausts the budget');
  const second = apply(store, { events: [] }, { fromReplay: true });
  assert.equal(second.replayFailed, false, 'no replay is outstanding so nothing is consumed');
  const third = apply(store, { events: [event(9, taskId, 'step.completed')] });
  assert.equal(third.replay, null);
  assert.equal(third.replayFailed, true, 'a further gap after exhaustion fails fast');
  assert.equal(store.stats.replayFailures, 2);
});

test('reset drops per-run caches, advances the epoch and rebuilds from the batch', () => {
  const store = fresh();
  core.applyConnection(store, { state: 'reconnecting', at: 5 });
  const taskId = 'reset';
  apply(store, {
    events: [event(1, taskId, 'run.queued'), event(2, taskId, 'run.cancelled')],
    streams: [stream(taskId, 'old output that must disappear')],
    tasks: [summary(taskId, 'cancelled')],
  });
  assert.equal(core.taskView(store, taskId)!.terminal, true);
  const before = store.epoch;
  const result = apply(store, {
    reset: true,
    cursor: 0,
    tasks: [summary(taskId, 'running', 2)],
    streams: [stream(taskId, 'fresh')],
  });
  assert.equal(result.reset, true);
  assert.equal(store.epoch, before + 1);
  const view = core.taskView(store, taskId)!;
  assert.equal(view.terminal, false);
  assert.equal(view.status, 'running');
  assert.equal(view.text, 'fresh');
  assert.equal(store.connection.state, 'reconnecting', 'reset keeps transport state, not run data');
  assert.equal(store.seen.size, 0, 'reset drops the dedupe cache so replay can be applied');
});

test('late events and deltas after a terminal run are ignored (0 writes)', () => {
  const store = fresh();
  const taskId = 'cancel';
  apply(store, { events: [event(1, taskId, 'run.queued')], streams: [stream(taskId, 'partial')] });
  apply(store, { events: [event(2, taskId, 'run.cancelled')] });
  const terminalView = core.taskView(store, taskId)!;
  assert.equal(terminalView.terminal, true);
  assert.equal(terminalView.status, 'cancelled');
  const late = apply(store, {
    tasks: [summary(taskId, 'running', 3)],
    events: [event(3, taskId, 'step.completed'), event(4, taskId, 'run.completed')],
    streams: [stream(taskId, 'partial then late text')],
  });
  assert.equal(late.writes, 0);
  assert.ok(late.ignoredTerminal >= 2);
  const view = core.taskView(store, taskId)!;
  assert.equal(view.status, 'cancelled');
  assert.equal(view.text, 'partial');
  assert.equal(core.runState(store, taskId), 'cancelled');
});

test('two concurrent runs stay isolated by taskId and one terminal run cannot freeze the other', () => {
  const store = fresh();
  const left = 'run-left';
  const right = 'run-right';
  apply(store, {
    tasks: [summary(left, 'queued'), summary(right, 'queued')],
    events: [
      event(1, left, 'run.queued'),
      event(2, right, 'run.queued'),
      event(3, left, 'step.started'),
      event(4, right, 'step.started'),
    ],
  });
  for (let index = 0; index < 50; index += 1) {
    apply(store, {
      streams: [stream(left, 'L'.repeat(index + 1)), stream(right, 'R'.repeat(index + 1))],
    });
  }
  assert.equal(core.taskView(store, left)!.text, 'L'.repeat(50));
  assert.equal(core.taskView(store, right)!.text, 'R'.repeat(50));
  apply(store, { events: [event(5, left, 'run.cancelled')], streams: [stream(left, 'L'.repeat(51))] });
  assert.equal(core.taskView(store, left)!.text, 'L'.repeat(50));
  apply(store, { streams: [stream(right, 'R'.repeat(51))] });
  assert.equal(core.taskView(store, right)!.text, 'R'.repeat(51));
  assert.equal(core.runState(store, left), 'cancelled');
  assert.equal(core.runState(store, right), 'streaming');
});

test('scroll intent follows only an explicitly pinned or near-bottom reader', () => {
  assert.equal(core.shouldFollowScroll({ pinned: true }), true);
  assert.equal(core.shouldFollowScroll({ pinned: false }), false);
  assert.equal(core.shouldFollowScroll({ pinned: false, nearBottom: true }), false);
  assert.equal(core.shouldFollowScroll({ pinned: true, userIntent: 'up' }), false);
  assert.equal(core.shouldFollowScroll({ nearBottom: true }), true);
  assert.equal(core.shouldFollowScroll({ nearBottom: false }), false);
  assert.equal(core.shouldFollowScroll({}), false);
});

test('run state machine walks queued -> tool -> streaming -> approval -> compacting -> paused -> terminal', () => {
  const store = fresh();
  const taskId = 'state';
  assert.equal(core.runState(store, taskId), 'idle');
  apply(store, { tasks: [summary(taskId, 'queued')] });
  assert.equal(core.runState(store, taskId), 'preparing');
  apply(store, { events: [event(1, taskId, 'run.queued')] });
  assert.equal(core.runState(store, taskId), 'preparing');
  apply(store, { events: [event(2, taskId, 'step.started')] });
  assert.equal(core.runState(store, taskId), 'tool_running');
  apply(store, { streams: [stream(taskId, 'token')] });
  assert.equal(core.runState(store, taskId), 'streaming');
  apply(store, { events: [event(3, taskId, 'approval.requested')] });
  assert.equal(core.runState(store, taskId), 'waiting_approval');
  apply(store, { events: [event(4, taskId, 'approval.resolved')] });
  assert.equal(core.runState(store, taskId), 'streaming');
  apply(store, { events: [event(5, taskId, 'context.compaction.started')] });
  assert.equal(core.runState(store, taskId), 'compacting');
  apply(store, { events: [event(6, taskId, 'context.compaction.completed')] });
  assert.equal(core.runState(store, taskId), 'streaming');
  apply(store, { events: [event(7, taskId, 'run.paused')] });
  assert.equal(core.runState(store, taskId), 'paused');
  apply(store, { events: [event(8, taskId, 'run.resumed')] });
  assert.equal(core.runState(store, taskId), 'streaming');
  assert.equal(core.markCancelling(store, taskId), true);
  assert.equal(core.runState(store, taskId), 'cancelling');
  apply(store, { events: [event(9, taskId, 'run.cancelled')] });
  assert.equal(core.runState(store, taskId), 'cancelled');
  assert.equal(core.isTerminal('cancelled'), true);
  assert.equal(core.isTerminal('running'), false);
});

test('run state machine maps failed and completed terminal states', () => {
  const failedStore = fresh();
  apply(failedStore, { events: [event(1, 'f', 'run.failed')] });
  assert.equal(core.runState(failedStore, 'f'), 'failed');
  const completedStore = fresh();
  apply(completedStore, { events: [event(1, 'c', 'run.completed')] });
  assert.equal(core.runState(completedStore, 'c'), 'completed');
});

test('transport reconnecting overrides active runs but never a terminal run', () => {
  const store = fresh();
  apply(store, {
    tasks: [summary('active', 'running'), summary('done', 'completed')],
    events: [event(1, 'active', 'step.started')],
  });
  apply(store, { streams: [stream('active', 'hello')] });
  assert.equal(core.runState(store, 'active'), 'streaming');
  core.applyConnection(store, { state: 'reconnecting', at: 7 });
  assert.equal(core.runState(store, 'active'), 'reconnecting');
  assert.equal(core.runState(store, 'done'), 'completed');
  core.applyConnection(store, { state: 'restored', at: 8 });
  assert.equal(core.runState(store, 'active'), 'streaming');
  const invalid = core.applyConnection(store, { state: 'nonsense' });
  assert.equal(invalid.ok, false);
});

test('unknown protocol event types are observable but never corrupt status or text', () => {
  const store = fresh();
  const taskId = 'unknown';
  apply(store, { events: [event(1, taskId, 'run.queued'), event(2, taskId, 'step.heartbeat')] });
  const view = core.taskView(store, taskId)!;
  assert.equal(view.status, 'queued');
  assert.equal((view as unknown as { lastEventType: string }).lastEventType, 'step.heartbeat');
  const result = apply(store, { events: [event(3, taskId, 'timer.scheduled')] });
  assert.equal(result.writes, 0);
});

test('an unknown schema version is reported but additive fields still apply', () => {
  const store = fresh();
  const result = apply(store, {
    schemaVersion: 2,
    events: [event(1, 'v2', 'run.queued')],
  } as Json as StreamBatch);
  assert.equal(result.unknownSchema, true);
  assert.equal(result.writes, 1);
  assert.equal(core.runState(store, 'v2'), 'preparing');
});

test('snapshot reconciliation can complete a live task but cannot shrink its text', () => {
  const store = fresh();
  const taskId = 'reconcile';
  apply(store, {
    events: [event(1, taskId, 'run.queued'), event(2, taskId, 'step.started')],
    streams: [stream(taskId, 'live text')],
  });
  const shrink = apply(
    store,
    { tasks: [summary(taskId, 'running')], streams: [stream(taskId, 'live')] },
    { reconcile: true },
  );
  assert.equal(shrink.writes, 0);
  assert.equal(core.taskView(store, taskId)!.text, 'live text');
  const complete = apply(store, { tasks: [summary(taskId, 'completed')] }, { reconcile: true });
  assert.equal(complete.writes, 1);
  assert.equal(core.taskView(store, taskId)!.terminal, true);
  assert.equal(core.taskView(store, taskId)!.text, 'live text');
});

test('stream step changes replace text while the same step only ever appends', () => {
  const store = fresh();
  const taskId = 'steps';
  apply(store, { streams: [stream(taskId, 'first step')] });
  const replaced = apply(store, { streams: [stream(taskId, 'second', 's2')] });
  assert.equal(replaced.writes, 1);
  assert.equal(core.taskView(store, taskId)!.text, 'second');
  assert.equal(core.taskView(store, taskId)!.stepId, 's2');
  const shortened = apply(store, { streams: [stream(taskId, 'sec', 's2')] });
  assert.equal(shortened.writes, 1, 'a shorter buffer without reconcile is a replace');
  assert.equal(core.taskView(store, taskId)!.text, 'sec');
});

test('dedupe memory is bounded to maxSeen while keeping recent ids', () => {
  const store = fresh({ maxSeen: 3 });
  const taskId = 'lru';
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    apply(store, { events: [event(sequence, taskId, 'unknown.type')] });
  }
  assert.ok(store.seen.size <= 3);
  assert.equal(store.seen.has('e:6'), true);
  assert.equal(store.seen.has('e:1'), false);
});

test('invalid batches are rejected without throwing or mutating the store', () => {
  const store = fresh();
  const bad = core.applyBatch(store, null as unknown as StreamBatch);
  assert.equal(bad.ok, false);
  assert.equal(bad.writes, 0);
  const result = core.applyBatch(store, [] as unknown as StreamBatch);
  assert.equal(result.ok, false);
  assert.equal(store.stats.batches, 0, 'rejected batches never count as applied');
});

test('stats expose the quantified counters used by the verification report', () => {
  const store = fresh();
  apply(store, {
    tasks: [summary('stats', 'queued')],
    events: [event(1, 'stats', 'run.queued'), event(2, 'stats', 'run.queued', { eventId: 'e:1' })],
    streams: [stream('stats', 'abc')],
  });
  const stats = core.stats(store);
  assert.equal(stats.batches, 1);
  assert.equal(stats.events, 2);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.streams, 1);
  assert.equal(stats.chars, 3);
  assert.equal(stats.cursor, 0);
  assert.equal(stats.tasks, 1);
});

/* App-level payload regression (found by T2 in round 3): model.ts uses input.messages verbatim
   when it is an array and ignores input.prompt, so the UI must place the current user turn (and
   each mode specific instruction) inside messages[] - otherwise the provider never sees the
   typed prompt. These assertions extract the real functions from ui/app.js with node:vm. */
test('chat model steps carry the current user turn and mode instruction inside messages[]', () => {
  const appPath = fileURLToPath(new URL('../../ui/app.js', import.meta.url));
  const source = readFileSync(appPath, 'utf8');
  const start = source.indexOf('function chatSteps(');
  const end = source.indexOf('async function appendConversationMessage(');
  assert.ok(start > 0 && end > start, 'chatSteps/buildHistory markers must exist in ui/app.js');

  const completed: Json[] = [];
  const sandbox: Record<string, unknown> = {
    S: { conversationId: 'conv-1' },
    t: (key: string, values?: { question?: string }) => (values && values.question ? `${key}:${values.question}` : key),
    conversationTaskList: () => completed,
    firstPrompt: (task: Json) => String(task.prompt ?? ''),
    taskText: (task: Json) => String(task.reply ?? ''),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\n;globalThis.__app = { chatSteps, buildHistory };`, context, { filename: 'ui/app.js#chatSteps' });

  type AppHooks = {
    chatSteps: (prompt: string, mode: string, messages: Json[]) => Json[];
    buildHistory: (conversationId: string | null) => Json[];
  };
  const hooks = sandbox.__app as AppHooks;
  assert.equal(typeof hooks?.chatSteps, 'function');
  assert.equal(typeof hooks?.buildHistory, 'function');

  const history = hooks.buildHistory(null);
  assert.equal(history.length, 1, 'empty conversation history is only the system turn');
  assert.equal(history[0].role, 'system');
  assert.equal(typeof history[0].content, 'string');
  assert.equal('text' in history[0], false, 'history uses content (model.ts reads content first)');

  const chat = hooks.chatSteps('hello world', 'chat', history);
  const reply = chat[0];
  const replyInput = reply.input as Json;
  const messages = replyInput.messages as Json[];
  assert.deepEqual(Array.from(messages, message => message.role), ['system', 'user']);
  assert.equal(messages[1].content, 'hello world', 'the typed prompt reaches the provider payload');
  assert.equal(replyInput.prompt, 'hello world');

  completed.push({ status: 'completed', prompt: 'prior question', reply: 'prior answer', createdAt: 1 });
  const multi = (hooks.chatSteps('second question', 'chat', hooks.buildHistory('conv-1'))[0].input as Json).messages as Json[];
  assert.deepEqual(Array.from(multi, message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(multi[multi.length - 1].content, 'second question');
  assert.ok(multi.every(message => typeof message.content === 'string' && message.content.length > 0));

  const research = hooks.chatSteps('find papers', 'research', hooks.buildHistory('conv-1'));
  const synthesis = research.find(step => step.id === 'research') as Json;
  const synthesisMessages = (synthesis.input as Json).messages as Json[];
  assert.match(String(synthesisMessages[synthesisMessages.length - 1].content), /find papers/);
  assert.equal(research.length, 1, 'research uses the unified model/tool activity, not a forced raw-query PubMed step');

  const debate = hooks.chatSteps('argue', 'debate', hooks.buildHistory('conv-1'));
  for (const step of debate) {
    const stepInput = step.input as Json;
    const stepMessages = stepInput.messages as Json[];
    const tail = stepMessages[stepMessages.length - 1];
    assert.equal(tail.role, 'user');
    assert.equal(tail.content, stepInput.prompt, `debate step ${String(step.id)} must send its own instruction`);
  }

  const bounded = hooks.buildHistory(null);
  assert.ok(bounded.length <= 16, 'history stays bounded');
});

