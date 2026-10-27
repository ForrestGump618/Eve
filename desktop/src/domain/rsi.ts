import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, type Json } from '../harness/types.js';
import type { RecordRow, RecordStore, RsiRunView } from '../shared/contract.js';

/**
 * Constrained Recursive Self-Improvement for SuWen.
 *
 * The engine can only tune declarative configuration (routing thresholds, prompt
 * styles, skill selection, tool-selection policy, test coverage knobs). It never
 * edits source code, never spawns or rewrites runtime code, and never calls a
 * model directly: candidate generation is deterministic from a seeded PRNG and
 * evaluation runs through an injected runner over an injected evaluation set.
 *
 * Cycle: Observe -> Diagnose -> Propose -> Sandbox Test -> Benchmark -> Review
 *        -> Canary -> Promote / Rollback, with every transition persisted.
 */

export const RSI_KINDS = ['routing', 'prompt', 'skill', 'tool-selection', 'test-coverage'] as const;
export type RsiKind = (typeof RSI_KINDS)[number];

export type StrategyStatus = 'active' | 'inactive' | 'candidate' | 'rolled_back';

export interface StrategyView {
  id: string;
  kind: RsiKind;
  version: number;
  status: StrategyStatus;
  config: Json;
  metrics: Json;
  cycle: number;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyMetrics {
  taskSuccess: number;
  evidenceAccuracy: number;
  toolFailureRate: number;
  cost: number;
  latency: number;
  reproducibility: number;
  humanScore?: number;
  cases: number;
}

export interface EvalCase {
  id: string;
  kind: RsiKind;
  input: Json;
  expect: Json;
  weight: number;
}

export interface EvalCaseView extends EvalCase { createdAt: number }

export interface EvalCaseResult {
  caseId: string;
  success: boolean;
  evidenceScore?: number;
  toolFailure?: boolean;
  cost?: number;
  latencyMs?: number;
  reproducible?: boolean;
  humanScore?: number;
}

export interface EvalRunnerArgs {
  candidateId: string;
  change: Json;
  baselineConfig: Json;
  evalCase: EvalCase;
  signal?: AbortSignal;
}
export type EvalRunner = (args: EvalRunnerArgs) => EvalCaseResult | Promise<EvalCaseResult>;

export interface RegressionThresholds {
  maxSuccessDrop: number;
  maxEvidenceDrop: number;
  maxToolFailureIncrease: number;
  maxCostIncreaseRatio: number;
  maxLatencyIncreaseRatio: number;
  maxReproducibilityDrop: number;
  costAbsoluteTolerance: number;
  latencyAbsoluteToleranceMs: number;
}

export const DEFAULT_THRESHOLDS: RegressionThresholds = Object.freeze({
  maxSuccessDrop: 0,
  maxEvidenceDrop: 0.02,
  maxToolFailureIncrease: 0.02,
  maxCostIncreaseRatio: 0.25,
  maxLatencyIncreaseRatio: 0.5,
  maxReproducibilityDrop: 0.01,
  costAbsoluteTolerance: 0.05,
  latencyAbsoluteToleranceMs: 50,
});

export const MAX_CANDIDATES = 10;
export const MAX_EVAL_CASES = 20;

/**
 * Fixed strategy baseline the engine may tune; keys are the complete allowed
 * schema. Tool counts and retry values here are RSI benchmark metadata only:
 * the unified AgentLoop does not read them as runtime iteration or tool-call
 * truncation limits.
 */
export const DEFAULT_STRATEGIES: Readonly<Record<RsiKind, Json>> = Object.freeze({
  routing: Object.freeze({ smallModelThreshold: 0.35, escalateThreshold: 0.65, maxToolsPerStep: 4, toolRetryLimit: 1 }),
  prompt: Object.freeze({ systemStyle: 'concise', evidenceFirst: true, uncertaintyNote: true, maxExamples: 2 }),
  skill: Object.freeze({ topK: 4, rerank: true, minRelevance: 0.3 }),
  'tool-selection': Object.freeze({ maxToolsPerStep: 4, preferReadOnly: true, retryLimit: 1 }),
  'test-coverage': Object.freeze({ minCases: 4, includeNegative: true, coverageTarget: 0.8 }),
});

const PROMPT_STYLES = ['concise', 'evidence-first', 'uncertainty-first'];
const UNSAFE_KEY = /^(?:source|code|script|command|cmd|path|file|files|module|modules|import|require|eval|exec|shell|process|runtime|env|environment|patch|diff|binary|spawn|child|preset)$/i;

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reject any configuration that tries to touch source code or the runtime; only
 * scalar knobs from DEFAULT_STRATEGIES are accepted.
 */
export function assertStrategyConfigSafe(kind: RsiKind, config: Json): void {
  if (!RSI_KINDS.includes(kind)) throw new ValidationError(`Unknown RSI kind: ${String(kind)}`);
  if (!isRecord(config)) throw new ValidationError('strategy config must be an object');
  const allowed = Object.keys(DEFAULT_STRATEGIES[kind] as Record<string, Json>);
  for (const [key, value] of Object.entries(config)) {
    if (UNSAFE_KEY.test(key)) throw new ValidationError(`strategy config cannot modify source or runtime: ${key}`);
    if (!allowed.includes(key)) throw new ValidationError(`unknown strategy key for ${kind}: ${key}`);
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      throw new ValidationError(`strategy value for ${key} must be a scalar`);
    }
    if (value === null) throw new ValidationError(`strategy value for ${key} must not be null`);
    if (typeof value === 'string' && kind === 'prompt' && key === 'systemStyle' && !PROMPT_STYLES.includes(value)) {
      throw new ValidationError(`systemStyle must be one of ${PROMPT_STYLES.join(', ')}`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ValidationError(`strategy value for ${key} must be finite`);
  }
}

export function mergeStrategyConfig(base: Json, patch: Json): Record<string, Json> {
  const merged: Record<string, Json> = { ...(base as Record<string, Json>) };
  for (const [key, value] of Object.entries(patch as Record<string, Json>)) merged[key] = value;
  return merged;
}

/** Deterministic metric aggregation for baseline and candidates. */
export function aggregateMetrics(results: EvalCaseResult[]): StrategyMetrics {
  if (!results.length) throw new ValidationError('cannot aggregate metrics without evaluation results');
  const mean = (pick: (result: EvalCaseResult) => number): number => results.reduce((total, result) => total + pick(result), 0) / results.length;
  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  const scores = results.map(result => result.humanScore).filter((value): value is number => typeof value === 'number');
  const metrics: StrategyMetrics = {
    taskSuccess: round(mean(result => (result.success ? 1 : 0))),
    evidenceAccuracy: round(mean(result => clamp01(result.evidenceScore ?? (result.success ? 1 : 0)))),
    toolFailureRate: round(mean(result => (result.toolFailure ? 1 : 0))),
    cost: round(mean(result => Math.max(0, result.cost ?? 0))),
    latency: round(mean(result => Math.max(0, result.latencyMs ?? 0))),
    reproducibility: round(mean(result => (result.reproducible === false ? 0 : 1))),
    cases: results.length,
  };
  if (scores.length) metrics.humanScore = round(scores.reduce((total, value) => total + clamp01(value), 0) / scores.length);
  return metrics;
}

/** Regression detection used for Benchmark gating and Canary re-check. */
export function detectRegressions(candidate: StrategyMetrics, baseline: StrategyMetrics, thresholds: RegressionThresholds = DEFAULT_THRESHOLDS): string[] {
  const regressions: string[] = [];
  if (candidate.taskSuccess < baseline.taskSuccess - thresholds.maxSuccessDrop - 1e-9) regressions.push('taskSuccess');
  if (candidate.evidenceAccuracy < baseline.evidenceAccuracy - thresholds.maxEvidenceDrop - 1e-9) regressions.push('evidenceAccuracy');
  if (candidate.toolFailureRate > baseline.toolFailureRate + thresholds.maxToolFailureIncrease + 1e-9) regressions.push('toolFailureRate');
  const costBaseline = Math.max(baseline.cost, 0);
  const costLimit = costBaseline > 0 ? costBaseline * (1 + thresholds.maxCostIncreaseRatio) : thresholds.costAbsoluteTolerance;
  if (candidate.cost > costLimit + 1e-9) regressions.push('cost');
  const latencyBaseline = Math.max(baseline.latency, 0);
  const latencyLimit = latencyBaseline > 0 ? latencyBaseline * (1 + thresholds.maxLatencyIncreaseRatio) : thresholds.latencyAbsoluteToleranceMs;
  if (candidate.latency > latencyLimit + 1e-9) regressions.push('latency');
  if (candidate.reproducibility < baseline.reproducibility - thresholds.maxReproducibilityDrop - 1e-9) regressions.push('reproducibility');
  return regressions;
}

/** Higher is better; deterministic tie-break by candidate id. */
export function candidateScore(metrics: StrategyMetrics): number {
  const score = metrics.taskSuccess * 100
    + metrics.evidenceAccuracy * 50
    + metrics.reproducibility * 20
    - metrics.toolFailureRate * 30
    - metrics.cost * 10
    - metrics.latency / 1000;
  return Math.round(score * 1e6) / 1e6;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Deterministic candidate generation
// ---------------------------------------------------------------------------

function hashSeed(parts: string): number {
  const digest = createHash('sha256').update(parts).digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one of a small deterministic set; never calls a model. */
function choosePatch(kind: RsiKind, baseline: Record<string, Json>, rand: () => number, index: number): Record<string, Json> {
  const step = (base: number, deltas: number[], min: number, max: number): number => {
    const delta = deltas[Math.floor(rand() * deltas.length)];
    return Math.round(Math.max(min, Math.min(max, base + delta)) * 1000) / 1000;
  };
  const integer = (base: number, deltas: number[], min: number, max: number): number => {
    const delta = deltas[Math.floor(rand() * deltas.length)];
    return Math.max(min, Math.min(max, base + delta));
  };
  const styleIndex = typeof baseline.systemStyle === 'string' ? PROMPT_STYLES.indexOf(baseline.systemStyle) : 0;
  switch (kind) {
    case 'routing':
      return {
        smallModelThreshold: step(Number(baseline.smallModelThreshold ?? 0.35), [-0.05, -0.025, 0.025, 0.05], 0.1, 0.8),
        escalateThreshold: step(Number(baseline.escalateThreshold ?? 0.65), [-0.05, 0, 0.05], 0.2, 0.95),
        maxToolsPerStep: integer(Number(baseline.maxToolsPerStep ?? 4), [-1, 0, 1], 2, 8),
      };
    case 'prompt':
      return {
        systemStyle: PROMPT_STYLES[(styleIndex + 1 + (index % (PROMPT_STYLES.length - 1))) % PROMPT_STYLES.length],
        evidenceFirst: rand() > 0.5 ? true : Boolean(baseline.evidenceFirst),
        maxExamples: integer(Number(baseline.maxExamples ?? 2), [0, 1, -1], 0, 5),
      };
    case 'skill':
      return {
        topK: integer(Number(baseline.topK ?? 4), [-1, 1, 2], 2, 8),
        minRelevance: step(Number(baseline.minRelevance ?? 0.3), [-0.05, 0.05], 0.1, 0.7),
      };
    case 'tool-selection':
      return {
        maxToolsPerStep: integer(Number(baseline.maxToolsPerStep ?? 4), [-1, 1], 2, 8),
        retryLimit: integer(Number(baseline.retryLimit ?? 1), [0, 1, -1], 0, 3),
      };
    case 'test-coverage':
      return {
        minCases: integer(Number(baseline.minCases ?? 4), [1, 2, -1], 2, 10),
        coverageTarget: step(Number(baseline.coverageTarget ?? 0.8), [-0.05, 0.05], 0.5, 0.99),
      };
    default:
      throw new ValidationError(`Unknown RSI kind: ${String(kind)}`);
  }
}

interface Candidate { id: string; change: Json; metrics: StrategyMetrics; passed: boolean; regressions: string[]; score: number }

export interface RsiAuditRow {
  id: string;
  runId: string;
  cycle: number;
  transition: string;
  from: string;
  to: string;
  at: number;
  note: string | null;
}

export interface RsiDeps {
  store: RecordStore;
  clock?: () => number;
}

export interface RsiEngineOptions {
  evaluationSet?: EvalCase[];
  runner?: EvalRunner;
  seed?: string;
  thresholds?: RegressionThresholds;
  maxCandidates?: number;
  maxCases?: number;
  baseline?: Partial<Record<RsiKind, Json>>;
}

interface RunData {
  id: string;
  cycle: number;
  kind: RsiKind;
  status: RsiRunView['status'];
  baseline: { strategyId: string; metrics: StrategyMetrics };
  candidates: Candidate[];
  chosenCandidateId: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  audit: Json[];
  diagnosis: Json;
  seed: string;
  evalCaseIds: string[];
  thresholds: Json;
  strategyAfterId: string | null;
  baselineVersion: number;
}

const RUN_STATUSES: RsiRunView['status'][] = ['draft', 'benchmarking', 'review', 'canary', 'promoted', 'rolled_back', 'failed'];

function recordData(row: RecordRow): Record<string, Json> {
  return row.data as unknown as Record<string, Json>;
}

function asNumber(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class RsiEngine {
  private readonly store: RecordStore;
  private readonly clock: () => number;
  private readonly options: RsiEngineOptions;
  private readonly thresholds: RegressionThresholds;

  constructor(deps: RsiDeps, options: RsiEngineOptions = {}) {
    if (!deps || typeof deps !== 'object' || !deps.store) throw new ValidationError('RsiEngine requires a store');
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.options = options;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  }

  // ---- records ------------------------------------------------------------

  private runRow(id: string): RecordRow {
    if (typeof id !== 'string' || !id.length) throw new ValidationError('rsi run id required');
    const row = this.store.getRecord(id);
    if (!row || row.kind !== 'rsiRun') throw new ValidationError(`Unknown rsi run: ${id}`);
    return row;
  }

  toRunView(row: RecordRow): RsiRunView {
    const data = recordData(row);
    const baseline = data.baseline as unknown as RsiRunView['baseline'];
    const status = RUN_STATUSES.includes(data.status as RsiRunView['status']) ? data.status as RsiRunView['status'] : 'failed';
    return {
      id: row.id,
      cycle: asNumber(data.cycle, 0),
      kind: data.kind as RsiRunView['kind'],
      status,
      baseline: { strategyId: String(baseline?.strategyId ?? ''), metrics: (baseline?.metrics ?? {}) as Json },
      candidates: Array.isArray(data.candidates) ? data.candidates as unknown as RsiRunView['candidates'] : [],
      chosenCandidateId: typeof data.chosenCandidateId === 'string' ? data.chosenCandidateId : null,
      note: typeof data.note === 'string' ? data.note : null,
      createdAt: asNumber(data.createdAt, row.createdAt),
      updatedAt: asNumber(data.updatedAt, row.updatedAt),
    };
  }

  private strategyView(row: RecordRow): StrategyView {
    const data = recordData(row);
    return {
      id: row.id,
      kind: data.kind as RsiKind,
      version: asNumber(data.strategyVersion, 1),
      status: (data.status as StrategyStatus) ?? 'inactive',
      config: (data.config ?? {}) as Json,
      metrics: (data.metrics ?? {}) as Json,
      cycle: asNumber(data.cycle, 0),
      note: typeof data.note === 'string' ? data.note : null,
      createdAt: asNumber(data.createdAt, row.createdAt),
      updatedAt: asNumber(data.updatedAt, row.updatedAt),
    };
  }

  private strategiesOf(kind: RsiKind): RecordRow[] {
    return this.store.listRecords('strategy', { limit: 500 })
      .filter(row => recordData(row).kind === kind)
      .sort((left, right) => asNumber(recordData(right).strategyVersion, 0) - asNumber(recordData(left).strategyVersion, 0));
  }

  active(kind: RsiKind): StrategyView {
    if (!RSI_KINDS.includes(kind)) throw new ValidationError(`Unknown RSI kind: ${String(kind)}`);
    const active = this.strategiesOf(kind).find(row => recordData(row).status === 'active');
    if (!active) throw new ValidationError(`No active strategy for ${kind}`);
    return this.strategyView(active);
  }

  strategies(options: { kind?: RsiKind; limit?: number } = {}): StrategyView[] {
    const rows = (options.kind === undefined ? this.store.listRecords('strategy', { limit: 500 }) : this.strategiesOf(options.kind))
      .filter(row => options.kind === undefined || recordData(row).kind === options.kind);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    return rows.slice(0, limit).map(row => this.strategyView(row));
  }

  private activeRow(kind: RsiKind): RecordRow | undefined {
    return this.strategiesOf(kind).find(row => recordData(row).status === 'active');
  }

  private ensureBaseline(kind: RsiKind, cycle: number): RecordRow {
    const active = this.activeRow(kind);
    if (active) return active;
    const config = this.baselineConfig(kind);
    return this.store.putRecord('strategy', {
      kind, strategyVersion: 1, status: 'active', config, metrics: {}, cycle, note: 'initial baseline',
      createdAt: this.clock(), updatedAt: this.clock(),
    } as unknown as Json, { provenance: { kind: 'rsi.baseline', at: this.clock(), kindName: kind } });
  }

  private baselineConfig(kind: RsiKind): Json {
    const override = this.options.baseline?.[kind];
    if (override === undefined) return DEFAULT_STRATEGIES[kind];
    const merged = mergeStrategyConfig(DEFAULT_STRATEGIES[kind], override);
    assertStrategyConfigSafe(kind, merged);
    return merged;
  }

  // ---- audit --------------------------------------------------------------

  private writeAudit(runId: string, cycle: number, transition: string, from: string, to: string, note: string | null): void {
    this.store.putRecord('rsiAudit', {
      runId, cycle, transition, from, to, at: this.clock(), note,
    } as unknown as Json, { provenance: { kind: 'rsi.audit', at: this.clock(), transition } });
  }

  private appendPhase(data: RunData, transition: string, note: string, extra: Record<string, Json> = {}): RunData {
    const at = this.clock();
    const audit = [...(Array.isArray(data.audit) ? data.audit : []), { at, transition, from: data.status, to: data.status, note }].slice(-100) as Json[];
    this.writeAudit(data.id, data.cycle, transition, String(data.status), String(data.status), note);
    return { ...data, ...extra, updatedAt: at, audit };
  }

  private transition(data: RunData, to: RsiRunView['status'], transition: string, note: string | null, extra: Record<string, Json> = {}): RecordRow {
    const current = this.runRow(data.id);
    const at = this.clock();
    const audit = [...(Array.isArray(data.audit) ? data.audit : []), { at, transition, from: data.status, to, note }].slice(-100) as Json[];
    const next = this.store.putRecord('rsiRun', {
      ...data, ...extra, status: to, note: note ?? data.note ?? null, updatedAt: at, audit,
    } as unknown as Json, {
      id: data.id,
      expectedVersion: current.version,
      provenance: { kind: 'rsi.transition', at, from: data.status, to },
    });
    this.writeAudit(data.id, asNumber(data.cycle, 0), transition, String(data.status), to, note);
    return next;
  }

  // ---- evaluation set -----------------------------------------------------

  private evaluationCases(kind: RsiKind): EvalCase[] {
    const injected = this.options.evaluationSet?.filter(entry => entry.kind === kind);
    if (injected && injected.length) return injected.slice(0, Math.min(this.options.maxCases ?? MAX_EVAL_CASES, MAX_EVAL_CASES)).map(entry => ({ ...entry, weight: entry.weight ?? 1 }));
    const persisted = this.store.listRecords('evalCase', { limit: 500 })
      .filter(row => recordData(row).kind === kind)
      .map(row => {
        const data = recordData(row);
        return {
          id: String(data.caseId ?? data.id ?? row.id),
          kind: data.kind as RsiKind,
          input: (data.input ?? {}) as Json,
          expect: (data.expect ?? {}) as Json,
          weight: asNumber(data.weight, 1),
        };
      });
    if (persisted.length) return persisted.slice(0, Math.min(this.options.maxCases ?? MAX_EVAL_CASES, MAX_EVAL_CASES));
    return this.seedEvaluationCases(kind);
  }

  /** Deterministic persisted default evaluation set, shared by baseline and candidates. */
  private seedEvaluationCases(kind: RsiKind): EvalCase[] {
    const cases: EvalCase[] = [];
    const total = Math.min(8, Math.max(2, this.options.maxCases ?? 8));
    for (let index = 0; index < total; index += 1) {
      const caseId = `eval-${kind}-${index + 1}`;
      const evalCase: EvalCase = {
        id: caseId,
        kind,
        input: { task: `${kind}-case-${index + 1}`, complexity: index % 3 },
        expect: { success: true, evidence: index % 2 === 0 },
        weight: 1,
      };
      cases.push(evalCase);
      this.store.putRecord('evalCase', {
        caseId, kind, input: evalCase.input, expect: evalCase.expect, weight: 1, createdAt: this.clock(),
      } as unknown as Json, { provenance: { kind: 'rsi.evalCase.seed', at: this.clock(), kindName: kind } });
    }
    return cases;
  }

  evalCases(kind: RsiKind): EvalCaseView[] {
    return this.evaluationCases(kind).map(entry => ({ ...entry, createdAt: this.clock() }));
  }

  // ---- evaluation ---------------------------------------------------------

  private async evaluate(run: RunData, cases: EvalCase[], candidateRef: { id: string; change: Json; config: Json }, signal?: AbortSignal): Promise<StrategyMetrics> {
    const runner = this.options.runner;
    if (!runner) throw new ValidationError('rsi evaluation requires an injected runner');
    const results: EvalCaseResult[] = [];
    for (const evalCase of cases) {
      if (signal?.aborted) throw new Error('rsi evaluation aborted');
      const raw = await runner({ candidateId: candidateRef.id, change: candidateRef.change, baselineConfig: candidateRef.config, evalCase, ...(signal ? { signal } : {}) });
      results.push(this.sanitizeResult(evalCase.id, raw));
    }
    return aggregateMetrics(results);
  }

  private sanitizeResult(caseId: string, raw: EvalCaseResult): EvalCaseResult {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`evaluation runner returned an invalid result for ${caseId}`);
    if (typeof raw.success !== 'boolean') throw new ValidationError(`evaluation runner must return a boolean success for ${caseId}`);
    const result: EvalCaseResult = { caseId, success: raw.success };
    if (typeof raw.evidenceScore === 'number') result.evidenceScore = raw.evidenceScore;
    if (typeof raw.toolFailure === 'boolean') result.toolFailure = raw.toolFailure;
    if (typeof raw.cost === 'number' && Number.isFinite(raw.cost)) result.cost = Math.max(0, raw.cost);
    if (typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs)) result.latencyMs = Math.max(0, raw.latencyMs);
    if (typeof raw.reproducible === 'boolean') result.reproducible = raw.reproducible;
    if (typeof raw.humanScore === 'number' && Number.isFinite(raw.humanScore)) result.humanScore = raw.humanScore;
    return result;
  }

  // ---- cycle --------------------------------------------------------------

  async run(input: Json, signal?: AbortSignal): Promise<RsiRunView> {
    const value = isRecord(input) ? input : {};
    const kind = value.kind;
    if (typeof kind !== 'string' || !RSI_KINDS.includes(kind as RsiKind)) {
      throw new ValidationError(`rsi.run kind must be one of ${RSI_KINDS.join(', ')}`);
    }
    const kindValue = kind as RsiKind;
    const seedInput = typeof value.seed === 'string' && value.seed.length
      ? value.seed.slice(0, 200)
      : (this.options.seed ?? 'suwen-rsi-v1').slice(0, 200);
    const cycle = this.nextCycle(kindValue);
    const baselineRow = this.ensureBaseline(kindValue, cycle);
    const baselineStrategy = this.strategyView(baselineRow);
    const baselineConfig = baselineStrategy.config;
    assertStrategyConfigSafe(kindValue, baselineConfig);
    const cases = this.evaluationCases(kindValue);

    // Observe: read the active strategy and measure the baseline over the same eval set.
    let data: RunData = {
      id: randomUUID(),
      cycle,
      kind: kindValue,
      status: 'draft',
      baseline: { strategyId: baselineRow.id, metrics: {} as unknown as StrategyMetrics },
      candidates: [],
      chosenCandidateId: null,
      note: null,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      audit: [],
      diagnosis: {},
      seed: seedInput,
      evalCaseIds: cases.map(entry => entry.id),
      thresholds: this.thresholds as unknown as Json,
      strategyAfterId: null,
      baselineVersion: baselineStrategy.version,
    };
    let runRow = this.store.putRecord('rsiRun', data as unknown as Json, {
      id: data.id,
      provenance: { kind: 'rsi.run', at: this.clock(), kindName: kindValue, cycle },
    });
    data = recordData(runRow) as unknown as RunData;
    data = this.appendPhase(data, 'observe', `observed active ${kindValue} strategy v${baselineStrategy.version} over ${cases.length} eval cases`);
    const baselineMetrics = await this.evaluate(data, cases, { id: `baseline-${baselineRow.id}`, change: {}, config: baselineConfig }, signal);
    data = this.appendPhase(data, 'observe-baseline', `baseline metrics: taskSuccess=${baselineMetrics.taskSuccess} evidenceAccuracy=${baselineMetrics.evidenceAccuracy}`, {
      baseline: { strategyId: baselineRow.id, metrics: baselineMetrics as unknown as Json },
    });

    // Diagnose: turn baseline metrics into named observations.
    const observations = this.diagnose(baselineMetrics);
    data = this.appendPhase(data, 'diagnose', observations.join('; '), { diagnosis: { observations, at: this.clock() } });

    // Propose: deterministic seeded candidates from the fixed baseline schema.
    const candidates = this.propose(kindValue, baselineConfig, seedInput, cycle);
    data = this.appendPhase(data, 'propose', `proposed ${candidates.length} candidates (seed ${seedInput})`, { candidates: candidates as unknown as Json });

    // Benchmark (Sandbox Test + Benchmark): every candidate over the same eval set.
    runRow = this.transition(data, 'benchmarking', 'benchmarking', `evaluating ${candidates.length} candidates x ${cases.length} cases`);
    data = recordData(runRow) as unknown as RunData;
    const benchmarked: Candidate[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error('rsi run aborted');
      const metrics = await this.evaluate(data, cases, { id: candidate.id, change: candidate.change, config: mergeStrategyConfig(baselineConfig, candidate.change) }, signal);
      const regressions = detectRegressions(metrics, baselineMetrics, this.thresholds);
      benchmarked.push({
        id: candidate.id,
        change: candidate.change,
        metrics,
        passed: regressions.length === 0,
        regressions,
        score: candidateScore(metrics),
      });
      this.writeAudit(data.id, data.cycle, 'sandbox-test', 'benchmarking', 'benchmarking', `${candidate.id} ${regressions.length ? `regressed: ${regressions.join(',')}` : 'passed'}`);
    }
    data = this.appendPhase({ ...data, candidates: benchmarked }, 'benchmark', `benchmarked ${benchmarked.length} candidates`, { candidates: benchmarked as unknown as Json });

    const passed = benchmarked.filter(candidate => candidate.passed).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const chosen = passed[0];
    if (!chosen) {
      // Regression => rollback: keep the active baseline untouched.
      const failedRow = this.transition(data, 'rolled_back', 'regression-rollback', 'every candidate regressed; baseline retained', { chosenCandidateId: null });
      return this.toRunView(failedRow);
    }
    data = { ...data, chosenCandidateId: chosen.id, candidates: benchmarked };
    const reviewRow = this.transition(data, 'review', 'review', `candidate ${chosen.id} selected for review (score ${chosen.score})`, {
      chosenCandidateId: chosen.id,
      candidates: benchmarked as unknown as Json[],
    });
    return this.toRunView(reviewRow);
  }

  private nextCycle(kind: RsiKind): number {
    const cycles = this.store.listRecords('rsiRun', { limit: 500 })
      .filter(row => recordData(row).kind === kind)
      .map(row => asNumber(recordData(row).cycle, 0));
    return (cycles.length ? Math.max(...cycles) : 0) + 1;
  }

  private diagnose(metrics: StrategyMetrics): string[] {
    const observations: string[] = [];
    if (metrics.taskSuccess < 0.8) observations.push(`taskSuccess ${metrics.taskSuccess} below 0.80 target`);
    if (metrics.evidenceAccuracy < 0.85) observations.push(`evidenceAccuracy ${metrics.evidenceAccuracy} below 0.85 target`);
    if (metrics.toolFailureRate > 0.1) observations.push(`toolFailureRate ${metrics.toolFailureRate} above 0.10 target`);
    if (metrics.cost > 1) observations.push(`cost ${metrics.cost} above 1.0 target`);
    if (metrics.latency > 5000) observations.push(`latency ${metrics.latency}ms above 5000ms target`);
    if (!observations.length) observations.push('no dominant failure; exploring safe parameter deltas');
    return observations;
  }

  private propose(kind: RsiKind, baselineConfig: Json, seed: string, cycle: number): Array<{ id: string; change: Json }> {
    const rand = mulberry32(hashSeed(`${seed}|${kind}|${cycle}`));
    const count = Math.max(1, Math.min(this.options.maxCandidates ?? 6, MAX_CANDIDATES));
    const candidates: Array<{ id: string; change: Json }> = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      let patch = choosePatch(kind, baselineConfig as Record<string, Json>, rand, index);
      let signature = JSON.stringify(patch);
      let attempts = 0;
      while (seen.has(signature) && attempts < 5) {
        patch = choosePatch(kind, baselineConfig as Record<string, Json>, rand, index + attempts);
        signature = JSON.stringify(patch);
        attempts += 1;
      }
      seen.add(signature);
      const effective = mergeStrategyConfig(baselineConfig, patch);
      assertStrategyConfigSafe(kind, effective);
      candidates.push({ id: `cand-${cycle}-${index + 1}-${createHash('sha256').update(signature).digest('hex').slice(0, 8)}`, change: patch });
    }
    return candidates;
  }

  // ---- review / promote / rollback ---------------------------------------

  review(id: string, input: Json = {}): RsiRunView {
    const value = isRecord(input) ? input : {};
    const decision = value.decision ?? 'approve';
    if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('rsi.review decision must be approve or reject');
    const note = typeof value.note === 'string' ? value.note.slice(0, 2000) : null;
    const row = this.runRow(id);
    const data = recordData(row) as unknown as RunData;
    if (data.status !== 'review') throw new ValidationError(`rsi.review requires status review, got ${String(data.status)}`);
    if (decision === 'reject') {
      const rejected = this.transition(data, 'failed', 'review-rejected', note ?? 'candidate rejected by reviewer');
      return this.toRunView(rejected);
    }
    const canary = this.transition(data, 'canary', 'review-approved', note ?? 'candidate approved for canary');
    return this.toRunView(canary);
  }

  promote(id: string, input: Json = {}): RsiRunView {
    const value = isRecord(input) ? input : {};
    if (value.confirm !== true) throw new ValidationError('rsi.promote requires confirm:true');
    const note = typeof value.note === 'string' ? value.note.slice(0, 2000) : null;
    let row = this.runRow(id);
    let data = recordData(row) as unknown as RunData;
    if (data.status === 'promoted') throw new ValidationError('rsi run already promoted');
    if (data.status !== 'review' && data.status !== 'canary') throw new ValidationError(`rsi.promote requires review or canary, got ${String(data.status)}`);
    const chosenId = typeof data.chosenCandidateId === 'string' ? data.chosenCandidateId : null;
    const candidate = (Array.isArray(data.candidates) ? data.candidates : []).find(entry => entry.id === chosenId);
    if (!candidate) throw new ValidationError('rsi run has no chosen candidate to promote');
    if (candidate.regressions?.length) throw new ValidationError(`chosen candidate has regressions: ${candidate.regressions.join(', ')}`);
    const kind = data.kind;
    const activeRow = this.activeRow(kind);
    if (!activeRow) throw new ValidationError(`No active strategy for ${kind}`);
    const active = this.strategyView(activeRow);
    if (active.id !== data.baseline.strategyId) throw new ValidationError('active strategy drifted since benchmark; run a fresh rsi cycle');
    // Canary re-check: compare chosen metrics against the currently active metrics.
    const baselineMetrics = data.baseline.metrics as unknown as StrategyMetrics;
    const candMetrics = candidate.metrics as unknown as StrategyMetrics;
    const regressions = detectRegressions(candMetrics, baselineMetrics, this.thresholds);
    if (regressions.length) {
      const rolled = this.transition(data, 'rolled_back', 'canary-regression', `canary re-check regressed: ${regressions.join(', ')}`);
      throw new ValidationError(`canary re-check regressed (${regressions.join(', ')}); rolled back without promotion`);
    }
    if (data.status === 'review') {
      row = this.transition(data, 'canary', 'canary-start', note ?? 'entered canary before promotion');
      data = recordData(row) as unknown as RunData;
    }
    const strategyVersion = active.version + 1;
    const config = mergeStrategyConfig(active.config, candidate.change);
    assertStrategyConfigSafe(kind, config);
    const promotedRow = this.store.putRecord('strategy', {
      kind,
      strategyVersion,
      status: 'active',
      config,
      metrics: candMetrics as unknown as Json,
      cycle: data.cycle,
      note: note ?? `promoted from cycle ${data.cycle}`,
      parentStrategyId: active.id,
      createdAt: this.clock(),
      updatedAt: this.clock(),
    } as unknown as Json, { provenance: { kind: 'rsi.promote', at: this.clock(), runId: id, fromStrategyId: active.id } });
    this.store.putRecord('strategy', {
      ...(recordData(activeRow) as Record<string, Json>), status: 'inactive', updatedAt: this.clock(),
    } as Json, { id: activeRow.id, expectedVersion: activeRow.version, provenance: { kind: 'rsi.supersede', at: this.clock(), runId: id, replacedBy: promotedRow.id } });
    const promotedRun = this.transition(data, 'promoted', 'promote', note ?? `promoted strategy v${strategyVersion}`, {
      strategyAfterId: promotedRow.id,
    });
    return this.toRunView(promotedRun);
  }

  rollback(id: string, input: Json = {}): RsiRunView {
    const value = isRecord(input) ? input : {};
    const note = typeof value.note === 'string' ? value.note.slice(0, 2000) : null;
    const row = this.runRow(id);
    const data = recordData(row) as unknown as RunData;
    if (data.status === 'rolled_back') return this.toRunView(row);
    if (!['review', 'canary', 'promoted', 'failed'].includes(String(data.status))) {
      throw new ValidationError(`rsi.rollback cannot run from status ${String(data.status)}`);
    }
    const afterId = typeof data.strategyAfterId === 'string' ? data.strategyAfterId : null;
    if (afterId) {
      const promoted = this.store.getRecord(afterId);
      if (promoted && promoted.kind === 'strategy' && recordData(promoted).status === 'active') {
        this.store.putRecord('strategy', {
          ...(recordData(promoted) as Record<string, Json>), status: 'rolled_back', updatedAt: this.clock(),
        } as Json, { id: promoted.id, expectedVersion: promoted.version, provenance: { kind: 'rsi.rollback', at: this.clock(), runId: id } });
      }
      const previousId = data.baseline.strategyId;
      const previous = previousId ? this.store.getRecord(previousId) : undefined;
      if (previous && previous.kind === 'strategy') {
        this.store.putRecord('strategy', {
          ...(recordData(previous) as Record<string, Json>), status: 'active', updatedAt: this.clock(),
        } as Json, { id: previous.id, expectedVersion: previous.version, provenance: { kind: 'rsi.rollback.restore', at: this.clock(), runId: id } });
      }
    }
    const rolled = this.transition(data, 'rolled_back', afterId ? 'rollback' : 'rollback-no-promotion', note ?? (afterId ? 'restored previous strategy version' : 'run closed without promotion'));
    return this.toRunView(rolled);
  }

  get(id: string): RsiRunView { return this.toRunView(this.runRow(id)); }

  list(options: { kind?: RsiKind; limit?: number } = {}): RsiRunView[] {
    const rows = this.store.listRecords('rsiRun', { limit: 500 });
    const filtered = options.kind === undefined ? rows : rows.filter(row => recordData(row).kind === options.kind);
    return filtered.slice(0, Math.max(1, Math.min(options.limit ?? 100, 500))).map(row => this.toRunView(row));
  }

  audit(runId?: string, limit = 200): RsiAuditRow[] {
    return this.store.listRecords('rsiAudit', { limit: 500 })
      .filter(row => runId === undefined || recordData(row).runId === runId)
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map(row => {
        const data = recordData(row);
        return {
          id: row.id,
          runId: String(data.runId ?? ''),
          cycle: asNumber(data.cycle, 0),
          transition: String(data.transition ?? ''),
          from: String(data.from ?? ''),
          to: String(data.to ?? ''),
          at: asNumber(data.at, row.createdAt),
          note: typeof data.note === 'string' ? data.note : null,
        };
      });
  }
}
