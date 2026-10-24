import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/harness/store.js';
import { ValidationError } from '../src/harness/types.js';
import type { Json } from '../src/harness/types.js';
import {
  DEFAULT_THRESHOLDS, MAX_CANDIDATES, MAX_EVAL_CASES, RSI_KINDS, RsiEngine,
  aggregateMetrics, assertStrategyConfigSafe, candidateScore, detectRegressions,
  type EvalCase, type EvalCaseResult, type EvalRunner, type StrategyMetrics,
} from '../src/domain/rsi.js';
import type { RsiRunView } from '../src/shared/contract.js';

const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;

interface RsiHarness {
  store: Store;
  engine: RsiEngine;
}

function createStore(t: { after: (callback: () => void) => void }): Store {
  const store = new Store(':memory:');
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
  });
  return store;
}

function createEngine(
  t: { after: (callback: () => void) => void },
  options: ConstructorParameters<typeof RsiEngine>[1] = {},
): RsiHarness {
  const store = createStore(t);
  return { store, engine: new RsiEngine({ store, clock }, options) };
}

function routingCases(count = 4): EvalCase[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `case-${index + 1}`,
    kind: 'routing' as const,
    input: { index },
    expect: { success: true },
    weight: 1,
  }));
}

function goodResult(caseId: string): EvalCaseResult {
  return { caseId, success: true, evidenceScore: 1, cost: 0.1, latencyMs: 100, reproducible: true };
}

const passRunner: EvalRunner = args => goodResult(args.evalCase.id);

const regressingRunner: EvalRunner = args => {
  const hasChange = Object.keys(args.change as Record<string, Json>).length > 0;
  return hasChange
    ? { caseId: args.evalCase.id, success: false, evidenceScore: 0.2, toolFailure: true, cost: 0.5, latencyMs: 900, reproducible: false }
    : goodResult(args.evalCase.id);
};

function metricsOf(view: RsiRunView, candidateId: string): StrategyMetrics {
  const candidate = view.candidates.find(entry => entry.id === candidateId);
  assert.ok(candidate, `candidate ${candidateId} missing`);
  return candidate.metrics as unknown as StrategyMetrics;
}

// ---------------------------------------------------------------------------
// Deterministic candidate generation
// ---------------------------------------------------------------------------

test('rsi candidate generation is deterministic from the seed and varies across seeds', async t => {
  const first = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'seed-alpha', maxCandidates: 4 });
  const runA = await first.engine.run({ kind: 'routing' });
  const second = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'seed-alpha', maxCandidates: 4 });
  const runB = await second.engine.run({ kind: 'routing' });
  assert.deepEqual(runA.candidates.map(candidate => candidate.change), runB.candidates.map(candidate => candidate.change));
  assert.deepEqual(runA.candidates.map(candidate => candidate.metrics), runB.candidates.map(candidate => candidate.metrics));
  assert.equal(runA.candidates.length, 4);
  assert.match(runA.candidates[0].id, /^cand-1-1-/);

  const third = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'seed-omega', maxCandidates: 4 });
  const runC = await third.engine.run({ kind: 'routing' });
  assert.notDeepEqual(runA.candidates.map(candidate => candidate.change), runC.candidates.map(candidate => candidate.change));
});

// ---------------------------------------------------------------------------
// Regression => rollback
// ---------------------------------------------------------------------------

test('rsi regression rolls the cycle back without touching the active strategy', async t => {
  const { store, engine } = createEngine(t, { runner: regressingRunner, evaluationSet: routingCases() });
  const run = await engine.run({ kind: 'routing' });
  assert.equal(run.status, 'rolled_back');
  assert.match(run.note ?? '', /baseline retained/);
  assert.equal(run.chosenCandidateId, null);
  assert.ok(run.candidates.length > 0);
  for (const candidate of run.candidates) {
    assert.equal(candidate.passed, false);
    assert.ok(candidate.regressions.length > 0);
  }
  const active = engine.active('routing');
  assert.equal(active.id, run.baseline.strategyId);
  assert.equal(active.version, 1);
  assert.equal(active.status, 'active');
  const audits = engine.audit(run.id);
  assert.ok(audits.some(entry => entry.transition === 'regression-rollback'));
  assert.equal(store.countRecords('rsiAudit', {}), audits.length);
  assert.equal(store.countRecords('rsiRun', {}), 1);
});

// ---------------------------------------------------------------------------
// Review / promote / rollback
// ---------------------------------------------------------------------------

test('rsi review, promote and rollback version the strategy and restore it', async t => {
  const { store, engine } = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'promote-seed' });
  const run = await engine.run({ kind: 'routing' });
  assert.equal(run.status, 'review');
  assert.ok(run.chosenCandidateId);
  const chosen = run.candidates.find(candidate => candidate.id === run.chosenCandidateId);
  assert.ok(chosen);
  assert.equal(chosen.passed, true);
  assert.throws(() => engine.promote(run.id, {}), ValidationError);
  assert.throws(() => engine.promote(run.id, { confirm: false }), /confirm:true/);

  const canary = engine.review(run.id, { decision: 'approve', note: 'looks good' });
  assert.equal(canary.status, 'canary');
  const promoted = engine.promote(run.id, { confirm: true });
  assert.equal(promoted.status, 'promoted');

  const active = engine.active('routing');
  assert.notEqual(active.id, run.baseline.strategyId);
  assert.equal(active.version, 2);
  assert.equal(active.status, 'active');
  const history = engine.strategies({ kind: 'routing' });
  assert.equal(history.length, 2);
  const previous = history.find(strategy => strategy.id === run.baseline.strategyId);
  assert.ok(previous);
  assert.equal(previous.status, 'inactive');
  assert.match(JSON.stringify(store.getRecord(active.id)?.provenance), /rsi\.promote/);

  const rolled = engine.rollback(run.id, { confirm: true });
  assert.equal(rolled.status, 'rolled_back');
  const restored = engine.active('routing');
  assert.equal(restored.id, run.baseline.strategyId);
  assert.equal(restored.version, 1);
  assert.equal(restored.status, 'active');
  const after = engine.strategies({ kind: 'routing' });
  const replaced = after.find(strategy => strategy.id === active.id);
  assert.ok(replaced);
  assert.equal(replaced.status, 'rolled_back');
  assert.equal(engine.rollback(run.id).status, 'rolled_back');
});

test('rsi review rejection fails the run and blocks promotion', async t => {
  const { engine } = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'reject-seed' });
  const run = await engine.run({ kind: 'prompt' });
  assert.throws(() => engine.review(run.id, { decision: 'maybe' }), ValidationError);
  const rejected = engine.review(run.id, { decision: 'reject', note: 'not better' });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.note, 'not better');
  assert.throws(() => engine.promote(run.id, { confirm: true }), /review or canary/);
  assert.equal(engine.rollback(run.id).status, 'rolled_back');
  const stillActive = engine.active('prompt');
  assert.equal(stillActive.id, run.baseline.strategyId);
  assert.equal(stillActive.version, 1);
  assert.equal(stillActive.status, 'active');
});

test('rsi promote offers a direct review-to-promote path with canary transition', async t => {
  const { engine } = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'direct-seed' });
  const run = await engine.run({ kind: 'tool-selection' });
  assert.equal(run.status, 'review');
  const promoted = engine.promote(run.id, { confirm: true });
  assert.equal(promoted.status, 'promoted');
  const transitions = engine.audit(run.id).map(entry => entry.transition);
  assert.ok(transitions.includes('canary-start'));
  assert.ok(transitions.includes('promote'));
  assert.equal(engine.active('tool-selection').version, 2);
});

// ---------------------------------------------------------------------------
// Bounds and determinism of the evaluation harness
// ---------------------------------------------------------------------------

test('rsi bounds candidates and evaluation cases and reuses one evaluation set', async t => {
  const store = createStore(t);
  const groups = new Map<string, string[]>();
  const recordingRunner: EvalRunner = args => {
    const bucket = groups.get(args.candidateId) ?? [];
    bucket.push(args.evalCase.id);
    groups.set(args.candidateId, bucket);
    return goodResult(args.evalCase.id);
  };
  const engine = new RsiEngine({ store, clock }, {
    runner: recordingRunner,
    evaluationSet: routingCases(25),
    seed: 'bounded-seed',
    maxCandidates: 50,
    maxCases: 50,
  });
  const run = await engine.run({ kind: 'routing' });
  assert.ok(run.candidates.length <= MAX_CANDIDATES);
  assert.ok(run.candidates.length >= 1);
  assert.equal((run.baseline.metrics as unknown as StrategyMetrics).cases, MAX_EVAL_CASES);
  const baselineGroup = [...groups.entries()].find(([candidateId]) => candidateId.startsWith('baseline-'));
  assert.ok(baselineGroup);
  const baselineCases = [...baselineGroup[1]].sort();
  assert.equal(baselineCases.length, MAX_EVAL_CASES);
  for (const [candidateId, caseIds] of groups.entries()) {
    if (candidateId === baselineGroup[0]) continue;
    assert.deepEqual([...caseIds].sort(), baselineCases);
  }
});

test('rsi persists a deterministic evaluation set when none is injected', async t => {
  const { store, engine } = createEngine(t, { runner: passRunner, seed: 'persisted-seed' });
  const cases = engine.evalCases('routing');
  assert.ok(cases.length >= 2);
  const run = await engine.run({ kind: 'routing' });
  assert.equal(run.status, 'review');
  assert.ok(store.countRecords('evalCase', {}) >= 2);
  assert.equal(store.countRecords('strategy', {}), 1);
  assert.equal(store.countRecords('rsiRun', {}), 1);
  for (const entry of engine.audit(run.id)) {
    assert.equal(typeof entry.transition, 'string');
    assert.equal(typeof entry.runId, 'string');
    assert.equal(typeof entry.at, 'number');
  }
});

// ---------------------------------------------------------------------------
// Safety: no source/runtime mutation
// ---------------------------------------------------------------------------

test('rsi strategy config cannot modify source code or the runtime', async t => {
  assert.throws(() => assertStrategyConfigSafe('routing', { source: 'patched.ts' }), /source or runtime/);
  assert.throws(() => assertStrategyConfigSafe('routing', { command: 'node evil.js' }), /source or runtime/);
  assert.throws(() => assertStrategyConfigSafe('routing', { unknownKnob: 1 }), /unknown strategy key/);
  assert.throws(() => assertStrategyConfigSafe('routing', { smallModelThreshold: null }), /must not be null/);
  assert.doesNotThrow(() => assertStrategyConfigSafe('routing', { smallModelThreshold: 0.4, maxToolsPerStep: 5 }));

  const store = createStore(t);
  let failure: unknown;
  try {
    const engine = new RsiEngine({ store, clock }, {
      runner: passRunner,
      evaluationSet: routingCases(),
      baseline: { routing: { command: 'node server.js' } },
    });
    await engine.run({ kind: 'routing' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'unsafe baseline must be rejected');
  assert.match(String((failure as Error).message ?? failure), /source or runtime/);

  const { store: cleanStore, engine } = createEngine(t, { runner: passRunner, evaluationSet: routingCases(), seed: 'safe-seed' });
  const run = await engine.run({ kind: 'routing' });
  for (const strategy of engine.strategies({ kind: 'routing' })) {
    assert.doesNotMatch(JSON.stringify(strategy.config), /source|code|script|command|path/i);
  }
  const persisted = cleanStore.listRecords('rsiRun', { limit: 10 });
  assert.equal(persisted.length, 1);
  const serialized = JSON.stringify(persisted[0].data);
  assert.doesNotMatch(serialized, /execSync|child_process|\.ts\b|\.js\b/);
  assert.equal(run.status, 'review');
});

// ---------------------------------------------------------------------------
// Metric aggregation and regression thresholds
// ---------------------------------------------------------------------------

test('rsi metric aggregation and regression thresholds are deterministic', () => {
  const aggregate = aggregateMetrics([
    { caseId: 'a', success: true, evidenceScore: 1, cost: 0.1, latencyMs: 100, reproducible: true },
    { caseId: 'b', success: false, evidenceScore: 0, toolFailure: true, cost: 0.3, latencyMs: 300, reproducible: false },
  ]);
  assert.equal(aggregate.taskSuccess, 0.5);
  assert.equal(aggregate.evidenceAccuracy, 0.5);
  assert.equal(aggregate.toolFailureRate, 0.5);
  assert.equal(aggregate.cost, 0.2);
  assert.equal(aggregate.latency, 200);
  assert.equal(aggregate.reproducibility, 0.5);
  assert.equal(aggregate.cases, 2);
  assert.throws(() => aggregateMetrics([]), ValidationError);

  const baseline: StrategyMetrics = {
    taskSuccess: 1, evidenceAccuracy: 0.9, toolFailureRate: 0, cost: 0.1, latency: 100, reproducibility: 1, cases: 4,
  };
  assert.deepEqual(detectRegressions(baseline, baseline), []);
  const regressed = detectRegressions({ ...baseline, taskSuccess: 0.75, evidenceAccuracy: 0.5, toolFailureRate: 0.5, cost: 1, latency: 900, reproducibility: 0.5 }, baseline);
  assert.deepEqual([...regressed].sort(), ['cost', 'evidenceAccuracy', 'latency', 'reproducibility', 'taskSuccess', 'toolFailureRate']);
  assert.ok(candidateScore({ ...baseline, taskSuccess: 0.9 }) < candidateScore(baseline));
  assert.equal(DEFAULT_THRESHOLDS.maxSuccessDrop, 0);
  assert.deepEqual([...RSI_KINDS], ['routing', 'prompt', 'skill', 'tool-selection', 'test-coverage']);
});
