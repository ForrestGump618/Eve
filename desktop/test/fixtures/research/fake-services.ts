/**
 * Deterministic, in-memory fakes for the research activity tests.
 *
 * No network, no real worker, no real model. The fake store mirrors the
 * contract v3 semantics that the real store exposes (CAS versions, projectId
 * scoping, newest-first listing, kind validation); the fake clock is
 * monotonic so every run produces identical records.
 */
import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConflictError, ValidationError } from '../../../src/harness/types.js';
import type {
  ActivityContext,
  ActivityResult,
  Json,
  StepRun,
  TaskLimits,
  TaskRun,
} from '../../../src/harness/types.js';
import type {
  ActivityServices,
  DatabaseQuery,
  ModelCaller,
  ModelMessage,
  PutRecordOptions,
  RecordRow,
  RecordStore,
  WorkerClient,
  WorkerHealth,
} from '../../../src/shared/contract.js';
import { isPlainObject, payloadSha256, sha256Hex, toJson } from '../../../src/domain/research.js';

export class FakeClock {
  private value: number;

  constructor(start = 1_700_000_000_000) {
    this.value = start;
  }

  now(): number {
    this.value += 1;
    return this.value;
  }
}

const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export class FakeRecordStore implements RecordStore {
  readonly rows = new Map<string, RecordRow>();

  private sequence = 0;

  constructor(private readonly now: () => number) {}

  putRecord(kind: string, data: Json, options: PutRecordOptions = {}): RecordRow {
    if (!KIND_PATTERN.test(kind)) throw new ValidationError(`invalid record kind '${kind}'`);
    if (options.id !== undefined && options.id.length > 200) throw new ValidationError('record id is longer than 200 characters');
    let projectId: string | null = null;
    if (isPlainObject(data) && typeof data.projectId === 'string') projectId = data.projectId;
    if (options.projectId !== undefined) projectId = options.projectId;
    const id = options.id ?? `rec-${++this.sequence}`;
    const existing = this.rows.get(id);
    const existingVersion = existing === undefined ? 0 : existing.version;
    if (options.expectedVersion !== undefined && options.expectedVersion !== existingVersion) {
      throw new ConflictError(`record '${id}' version mismatch: expected ${options.expectedVersion}, found ${existingVersion}`);
    }
    const version = existingVersion + 1;
    const row: RecordRow = {
      id,
      kind,
      version,
      data,
      provenance: options.provenance === undefined ? existing?.provenance ?? null : options.provenance,
      projectId,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.rows.set(id, row);
    return row;
  }

  getRecord(id: string): RecordRow | undefined {
    return this.rows.get(id);
  }

  listRecords(kind: string, options: { projectId?: string | null; limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}): RecordRow[] {
    const matches: RecordRow[] = [];
    for (const row of this.rows.values()) {
      if (row.kind !== kind) continue;
      if (options.projectId !== undefined && row.projectId !== options.projectId) continue;
      matches.push(row);
    }
    matches.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    if (options.order === 'asc') matches.reverse();
    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? 100, 500);
    return matches.slice(offset, offset + limit);
  }

  countRecords(kind: string, options: { projectId?: string | null } = {}): number {
    return this.listRecords(kind, { ...options, limit: 500 }).length;
  }

  deleteRecord(id: string, expectedVersion?: number): void {
    const existing = this.rows.get(id);
    if (existing === undefined) return;
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new ConflictError(`record '${id}' version mismatch: expected ${expectedVersion}, found ${existing.version}`);
    }
    this.rows.delete(id);
  }
}

export type ModelResponder = (messages: ModelMessage[]) => string;

export class FakeModel implements ModelCaller {
  configuredValue = true;

  readonly calls: ModelMessage[][] = [];

  private responders: ModelResponder[] = [];

  configured(): boolean {
    return this.configuredValue;
  }

  contextWindow(): number {
    return 128_000;
  }

  model(): string | null {
    return 'fake-model';
  }

  /** Queue one response per upcoming model call; never falls back silently. */
  script(...responses: Array<string | ModelResponder>): this {
    for (const response of responses) {
      this.responders.push(typeof response === 'function' ? response : () => response);
    }
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.responders = [];
  }

  async call(messages: ModelMessage[], signal: AbortSignal, onText?: (text: string) => void): Promise<{ text: string; tokens: number }> {
    if (!this.configuredValue) throw new Error('FakeModel: model is not configured');
    if (signal.aborted) throw new Error('FakeModel: signal already aborted');
    this.calls.push(messages.map((message) => ({ ...message })));
    const responder = this.responders.shift();
    if (responder === undefined) {
      throw new Error(`FakeModel: unexpected model call #${this.calls.length}; script a response first`);
    }
    const text = responder(messages);
    onText?.(text);
    return { text, tokens: 42 };
  }

  lastMessages(): ModelMessage[] {
    return this.calls[this.calls.length - 1] ?? [];
  }

  lastUserContent(): string {
    return this.lastMessages().filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  }
}

export type WorkerResponder = (input: Json) => Json | Promise<Json>;

export class FakeWorker implements WorkerClient {
  readonly calls: Array<{ op: string; input: Json }> = [];

  readonly handlers = new Map<string, WorkerResponder>();

  closed = false;

  on(op: string, responder: WorkerResponder): this {
    this.handlers.set(op, responder);
    return this;
  }

  async health(): Promise<WorkerHealth> {
    return { status: 'ok', python: '3.12.0', version: 'fake-1', capabilities: ['describe', 'datasetProfile', 'runScript'] };
  }

  async call(op: string, input: Json, signal: AbortSignal): Promise<Json> {
    if (signal.aborted) throw new Error('FakeWorker: signal already aborted');
    this.calls.push({ op, input });
    const handler = this.handlers.get(op);
    if (handler === undefined) throw new Error(`FakeWorker: unexpected operation '${op}'`);
    return handler(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  lastCall(op?: string): { op: string; input: Json } | undefined {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const call = this.calls[index];
      if (op === undefined || call.op === op) return call;
    }
    return undefined;
  }
}

export type DatabaseResponder = Json | Error | ((query: string) => Json);

export class FakeDatabases implements DatabaseQuery {
  readonly calls: Array<{ kind: 'pubmed' | 'uniprot'; query: string }> = [];

  private readonly responders = new Map<string, DatabaseResponder>();

  respond(kind: 'pubmed' | 'uniprot', responder: DatabaseResponder): this {
    this.responders.set(kind, responder);
    return this;
  }

  async query(kind: 'pubmed' | 'uniprot', query: string, signal: AbortSignal): Promise<Json> {
    if (signal.aborted) throw new Error('FakeDatabases: signal already aborted');
    this.calls.push({ kind, query });
    const responder = this.responders.get(kind);
    if (responder === undefined) throw new Error(`FakeDatabases: no responder configured for '${kind}'`);
    const payload = typeof responder === 'function' ? responder(query) : responder;
    if (payload instanceof Error) throw payload;
    return payload;
  }
}

export interface FakeServices {
  services: ActivityServices;
  store: FakeRecordStore;
  model: FakeModel;
  worker: FakeWorker;
  databases: FakeDatabases;
  clock: FakeClock;
  home: string;
  cleanup(): void;
}

export interface CreateFakeServicesOptions {
  home?: string;
  configured?: boolean;
  clockStart?: number;
}

export function createFakeServices(options: CreateFakeServicesOptions = {}): FakeServices {
  const createdHome = options.home === undefined;
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'suwen-research-'));
  const clock = new FakeClock(options.clockStart);
  const store = new FakeRecordStore(() => clock.now());
  const model = new FakeModel();
  model.configuredValue = options.configured ?? true;
  const worker = new FakeWorker();
  const databases = new FakeDatabases();
  worker.on('health', () => ({
    status: 'ok',
    python: '3.12.0',
    version: 'fake-1',
    biomni_available: false,
    isolation: 'subprocess, not an OS security sandbox',
  }));
  worker.on('describe', (input) => {
    const values = isPlainObject(input) && Array.isArray(input.values) ? input.values : [];
    return { count: values.length, mean: 0, median: 0, data_sha256: sha256Hex(JSON.stringify(values)) };
  });
  worker.on('datasetProfile', (input) => ({
    rows: 2,
    columns: ['x', 'y'],
    source: isPlainObject(input) ? input.datasetPath ?? input.source ?? null : null,
  }));
  worker.on('runScript', () => ({
    exitCode: 0,
    stdout: '{"metrics":{"score":0.87},"score":0.87}',
    stderr: '',
    files: [],
    versions: { python: '3.12.0', node: null },
    sandbox: join(home, 'sandbox', 'fake'),
  }));
  const services: ActivityServices = {
    store,
    model,
    worker,
    databases,
    home,
    clock: () => clock.now(),
  };
  return {
    services,
    store,
    model,
    worker,
    databases,
    clock,
    home,
    cleanup: () => {
      if (createdHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface FakeContextOptions {
  taskId?: string;
  stepId?: string;
  kind?: string;
  dependsOn?: string[];
  operationId?: string;
  limits?: TaskLimits;
}

/** Build a complete ActivityContext with a never-aborted signal. */
export function makeContext(input: Json, options: FakeContextOptions = {}): ActivityContext {
  const now = 1_700_000_000_000;
  const limits: TaskLimits = options.limits ?? {};
  const task: TaskRun = {
    id: options.taskId ?? 'task-research-1',
    name: 'research activity test task',
    parentId: null,
    status: 'running',
    version: 1,
    createdAt: now,
    updatedAt: now,
    limits,
    calls: 0,
    cost: 0,
    tokens: 0,
  };
  const step: StepRun = {
    id: options.stepId ?? 'step-1',
    taskId: task.id,
    kind: options.kind ?? 'knowledge',
    input,
    dependsOn: options.dependsOn ?? [],
    sideEffect: false,
    maxAttempts: 3,
    timeoutMs: 60_000,
    status: 'running',
    version: 1,
    operationId: options.operationId ?? 'op-1',
    attempts: 1,
    owner: null,
    fence: 1,
    leaseUntil: null,
    dueAt: null,
    error: null,
  };
  const controller = new AbortController();
  return {
    task,
    step,
    operationId: step.operationId,
    signal: controller.signal,
    heartbeat: () => true,
  };
}

/** Normalise ActivityResult|Json to the handler's output payload. */
export function extractOutput(result: ActivityResult | Json): Json {
  if (isPlainObject(result) && 'output' in result) return toJson(result.output);
  return toJson(result);
}

/** Read a JSON-object record or fail loudly (test helper). */
export function recordData(row: RecordRow | undefined): Record<string, unknown> {
  if (row === undefined) throw new Error('expected a record, found none');
  if (!isPlainObject(row.data)) throw new Error(`record '${row.id}' does not contain a JSON object`);
  return row.data;
}

export { payloadSha256, sha256Hex };
