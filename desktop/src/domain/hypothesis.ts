/**
 * Domain layer for hypothesis and debate workflows (owner: research-domain).
 *
 * Builds the durable task templates named by contract section 3:
 *   hypothesis → generate → critique → rank
 *   debate     → (propose → critique → revise) × rounds → synthesize
 * Also owns hypothesis dedupe keys and the legal status-transition table.
 */
import type { Json, StepDefinition, TaskDefinition, TaskLimits } from '../harness/types.js';
import { ValidationError } from '../harness/types.js';

import {
  payloadSha256,
  optionalInteger,
  optionalProjectId,
  optionalString,
  requiredString,
  requireObject,
  sha256Hex,
  toJson,
  normalizeEvidenceIds,
  type TaskBuildOptions,
} from './research.js';

export const HYPOTHESIS_STATUSES = [
  'draft',
  'critiqued',
  'ranked',
  'selected',
  'rejected',
  'testing',
  'supported',
  'refuted',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

const HYPOTHESIS_TRANSITIONS: Record<HypothesisStatus, readonly HypothesisStatus[]> = {
  draft: ['critiqued', 'rejected'],
  critiqued: ['ranked', 'rejected'],
  ranked: ['selected', 'rejected'],
  selected: ['testing', 'rejected'],
  testing: ['supported', 'refuted'],
  rejected: [],
  supported: [],
  refuted: [],
};

/** Contract section 2 status machine; throws ValidationError for illegal moves. */
export function assertHypothesisTransition(from: string, to: HypothesisStatus): void {
  const source = HYPOTHESIS_STATUSES.find((status) => status === from);
  if (source === undefined) throw new ValidationError(`hypothesis has unknown status '${from}'`);
  if (source === to) return;
  if (!HYPOTHESIS_TRANSITIONS[source].includes(to)) {
    throw new ValidationError(`hypothesis status transition '${source}' -> '${to}' is not allowed`);
  }
}

/**
 * Stable dedupe key for a hypothesis statement: NFKC normalised, lowercased,
 * whitespace collapsed, then hashed together with the question.
 */
export function hypothesisDedupeKey(question: string, statement: string): string {
  const normalizedQuestion = normalizeQuestionText(question);
  const normalizedStatement = normalizeQuestionText(statement);
  return sha256Hex(JSON.stringify([normalizedQuestion, normalizedStatement]));
}

function normalizeQuestionText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Canonical sorted order used by deterministic model fixtures / ranking output. */
export function rankHypothesisRows<T extends { id: string; score: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.id.localeCompare(right.id);
  });
}

function assertTaskSteps(steps: StepDefinition[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new ValidationError(`task template contains duplicate step id '${step.id}'`);
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new ValidationError(`task template step '${step.id}' depends on '${dependency}', which is not an earlier step of the task`);
      }
    }
    ids.add(step.id);
  }
}

function baseTask(args: {
  prefix: string;
  template: string;
  steps: StepDefinition[];
  limits: TaskLimits;
  options?: TaskBuildOptions;
  input: unknown;
}): TaskDefinition {
  assertTaskSteps(args.steps);
  const digest = payloadSha256(args.input).slice(0, 12);
  const task: TaskDefinition = {
    id: args.options?.id ?? `${args.prefix}-${digest}`,
    name: args.options?.name ?? `${args.prefix}.${args.template}`,
    steps: args.steps,
    limits: args.limits,
  };
  if (args.options?.parentId !== undefined) task.parentId = args.options.parentId;
  return task;
}

export interface HypothesisTaskInput {
  question: string;
  context?: string;
  evidenceIds?: string[];
  projectId?: string;
}

/** hypothesis → generate → critique → rank. */
export function buildHypothesisTask(input: HypothesisTaskInput, options?: TaskBuildOptions): TaskDefinition {
  const raw = requireObject(input, 'hypothesis task input');
  const question = requiredString(raw.question, 'hypothesis task input.question', 3, 2000);
  const context = optionalString(raw.context, 'hypothesis task input.context', 1, 20_000);
  const evidenceIds = normalizeEvidenceIds(raw.evidenceIds);
  if (evidenceIds.length > 0 && context === undefined) {
    // evidence citations are attached by the handler; the id list is passed through
  }
  const projectId = optionalProjectId(raw);
  const generateInput: Record<string, unknown> = { op: 'generate', question, evidenceIds };
  if (context !== undefined) generateInput.context = context;
  if (projectId !== undefined) generateInput.projectId = projectId;
  const critiqueInput: Record<string, unknown> = { op: 'critique', question };
  const rankInput: Record<string, unknown> = { op: 'rank', question };
  if (projectId !== undefined) {
    critiqueInput.projectId = projectId;
    rankInput.projectId = projectId;
  }
  const steps: StepDefinition[] = [
    { id: 'hypothesis_generate', kind: 'hypothesis', input: toJson(generateInput), sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
    { id: 'hypothesis_critique', kind: 'hypothesis', input: toJson(critiqueInput), dependsOn: ['hypothesis_generate'], sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
    { id: 'hypothesis_rank', kind: 'hypothesis', input: toJson(rankInput), dependsOn: ['hypothesis_critique'], sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
  ];
  return baseTask({
    prefix: 'hypothesis',
    template: 'generate-critique-rank',
    steps,
    limits: { maxCalls: 12, maxTokens: 120_000, maxWallMs: 1_800_000, concurrency: 2 },
    options,
    input: toJson({ question, context: context ?? null, evidenceIds, projectId: projectId ?? null }),
  });
}

export interface DebateTaskInput {
  question: string;
  rounds?: number;
  roles?: string[];
  projectId?: string;
}

/** debate → (propose → critique → revise) × rounds → synthesize. */
export function buildDebateTask(input: DebateTaskInput, options?: TaskBuildOptions): TaskDefinition {
  const raw = requireObject(input, 'debate task input');
  const question = requiredString(raw.question, 'debate task input.question', 3, 2000);
  const rounds = optionalInteger(raw.rounds, 'debate task input.rounds', 1, 3) ?? 2;
  const projectId = optionalProjectId(raw);
  const roles = raw.roles === undefined || raw.roles === null
    ? ['proposer', 'critic']
    : (() => {
        if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > 4) {
          throw new ValidationError('debate task input.roles must be an array of 1 to 4 role names');
        }
        return raw.roles.map((role, index) => requiredString(role, `debate task input.roles[${index}]`, 2, 60));
      })();
  const proposerRole = roles[0];
  const criticRole = roles[1] ?? roles[0];
  const steps: StepDefinition[] = [];
  let previous: string | undefined;
  for (let round = 1; round <= rounds; round += 1) {
    const proposeId = `debate_r${round}_propose`;
    const critiqueId = `debate_r${round}_critique`;
    const reviseId = `debate_r${round}_revise`;
    const baseInput: Record<string, unknown> = { question, round };
    if (projectId !== undefined) baseInput.projectId = projectId;
    const proposeInput: Record<string, unknown> = { ...baseInput, op: 'propose', role: proposerRole };
    const critiqueInput: Record<string, unknown> = { ...baseInput, op: 'critique', role: criticRole };
    const reviseInput: Record<string, unknown> = { ...baseInput, op: 'revise', role: proposerRole };
    const proposeDepends = previous === undefined ? [] : [previous];
    steps.push(
      { id: proposeId, kind: 'debate', input: toJson(proposeInput), dependsOn: proposeDepends, sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
      { id: critiqueId, kind: 'debate', input: toJson(critiqueInput), dependsOn: [proposeId], sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
      { id: reviseId, kind: 'debate', input: toJson(reviseInput), dependsOn: [critiqueId], sideEffect: false, maxAttempts: 2, timeoutMs: 180_000 },
    );
    previous = reviseId;
  }
  const synthesizeInput: Record<string, unknown> = { op: 'synthesize', question, role: 'chair', round: rounds + 1 };
  if (projectId !== undefined) synthesizeInput.projectId = projectId;
  steps.push({
    id: 'debate_synthesize',
    kind: 'debate',
    input: toJson(synthesizeInput),
    dependsOn: previous === undefined ? [] : [previous],
    sideEffect: false,
    maxAttempts: 2,
    timeoutMs: 180_000,
  });
  return baseTask({
    prefix: 'debate',
    template: `rounds-${rounds}-synthesize`,
    steps,
    limits: { maxCalls: rounds * 3 + 2, maxTokens: 240_000, maxWallMs: 2_400_000, concurrency: 1 },
    options,
    input: toJson({ question, rounds, roles, projectId: projectId ?? null }),
  });
}

/** Shape of the hypothesis fields persisted by the activity handlers. */
export interface HypothesisRecordData {
  projectId: string | null;
  taskId: string;
  question: string;
  statement: string;
  rationale: string;
  evidenceIds: string[];
  score: number;
  critique: string;
  revision: number;
  status: HypothesisStatus;
  dedupeKey: string;
  novelty: number;
  testability: number;
}

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === 'string' && (HYPOTHESIS_STATUSES as readonly string[]).includes(value);
}

/** Json-safe projection used when handing a hypothesis to model prompts. */
export function hypothesisPromptView(record: {
  id: string;
  statement: string;
  rationale: string;
  novelty: number;
  testability: number;
  evidenceIds: string[];
}): Json {
  return toJson({
    id: record.id,
    statement: record.statement,
    rationale: record.rationale,
    novelty: record.novelty,
    testability: record.testability,
    evidenceIds: record.evidenceIds,
  });
}
