/**
 * Shared vNext contract for the SuWen desktop daemon.
 *
 * This file is LEAD-OWNED and frozen. Do not edit it from a teammate task.
 * If an interface is missing, report the exact need to the Lead instead of
 * changing this file, so parallel writers cannot fork the contract.
 */
import type { Json } from '../harness/types.js';

/** Roles accepted by both providers and by persisted conversation history. */
export type MessageRole = 'system' | 'user' | 'assistant';
export interface ModelMessage { role: MessageRole; content: string }

/** Configured model caller. `configured()` is false until the user stores credentials. */
export interface ModelCaller {
  configured(): boolean;
  contextWindow(): number;
  model(): string | null;
  call(messages: ModelMessage[], signal: AbortSignal, onText?: (text: string) => void): Promise<{ text: string; tokens: number }>;
}

/** Generic versioned record. Secrets must be redacted before persistence. */
export interface RecordRow {
  id: string;
  kind: string;
  version: number;
  data: Json;
  provenance: Json | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PutRecordOptions {
  id?: string;
  /** Optimistic concurrency: must equal the current version for updates, or 0 for creates. */
  expectedVersion?: number;
  provenance?: Json;
  projectId?: string | null;
}

/** Generic record store implemented by harness/store.ts. All mutations are transactional. */
export interface RecordStore {
  putRecord(kind: string, data: Json, options?: PutRecordOptions): RecordRow;
  getRecord(id: string): RecordRow | undefined;
  listRecords(kind: string, options?: { projectId?: string | null; limit?: number; offset?: number; order?: 'asc' | 'desc' }): RecordRow[];
  countRecords(kind: string, options?: { projectId?: string | null }): number;
  deleteRecord(id: string, expectedVersion?: number): void;
}

export interface WorkerHealth {
  status: 'ok' | 'unavailable';
  python?: string;
  version?: string;
  capabilities?: string[];
  deps?: Record<string, string | null>;
  error?: string;
}

/** Long-lived typed research worker client (Python, managed process). */
export interface WorkerClient {
  health(): Promise<WorkerHealth>;
  call(op: string, input: Json, signal: AbortSignal): Promise<Json>;
  close(): Promise<void>;
}

export interface DatabaseQuery {
  query(kind: 'pubmed' | 'uniprot', query: string, signal: AbortSignal): Promise<Json>;
}

/** Dependencies injected into every research/tool activity handler. */
export interface ActivityServices {
  store: RecordStore;
  model: ModelCaller;
  worker: WorkerClient;
  databases: DatabaseQuery;
  /** Absolute per-user data directory; activity artifacts and sandboxes live below it. */
  home: string;
  clock: () => number;
}

/** A single RPC-visible MCP server. */
export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  readOnly: boolean;
  enabled: boolean;
  health: { status: 'ok' | 'failed' | 'unknown'; at: number; latencyMs?: number; error?: string };
  tools: Array<{ name: string; description?: string; inputSchema?: Json }>;
}

/** A single installed skill. `test` records the last real isolated test result. */
export interface SkillView {
  id: string;
  name: string;
  version: string;
  source: string;
  license: string | null;
  entry: string;
  permissions: string[];
  enabled: boolean;
  sha256: string;
  test: { status: 'passed' | 'failed' | 'not_run'; at: number | null; detail?: string };
  installedAt: number;
}

/** A configured outbound/inbound message channel; config never contains raw secrets. */
export interface ChannelView {
  id: string;
  type: 'telegram' | 'slack' | 'discord' | 'email' | 'webhook' | 'wechat-official';
  name: string;
  enabled: boolean;
  readOnly: boolean;
  workspaceId: string | null;
  config: Json;
  health: { status: 'ok' | 'failed' | 'unknown'; at: number; detail?: string };
}

/** One RSI improvement cycle persisted under kind `rsiRun`. */
export interface RsiRunView {
  id: string;
  cycle: number;
  kind: 'routing' | 'prompt' | 'skill' | 'tool-selection' | 'test-coverage';
  status: 'draft' | 'benchmarking' | 'review' | 'canary' | 'promoted' | 'rolled_back' | 'failed';
  baseline: { strategyId: string; metrics: Json };
  candidates: Array<{ id: string; change: Json; metrics: Json; passed: boolean; regressions: string[] }>;
  chosenCandidateId: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Live model/step text buffer; append-only within one step. See docs/architecture/streaming-events.md. */
export interface StreamBuffer {
  text: string;
  updatedAt: number;
  stepId?: string;
}

export const STREAM_EVENT_SCHEMA_VERSION = 1;

export interface StreamTaskSummary {
  taskId: string;
  status: string;
  version: number;
  updatedAt: number;
}

export interface StreamEnvelope {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  taskId: string;
  stepId?: string;
  type: string;
  sourceType: string;
  at: number;
  payload: Json;
}

export interface StreamSnapshotView {
  taskId: string;
  stepId?: string;
  text: string;
  updatedAt: number;
}

export interface StreamBatch {
  schemaVersion: number;
  cursor: number;
  reset?: boolean;
  tasks: StreamTaskSummary[];
  events: StreamEnvelope[];
  streams: StreamSnapshotView[];
}

/** Canonical RPC method names. daemon.ts and main.ts must agree with this list. */
export const RPC_METHODS = [
  'health', 'snapshot', 'create', 'control', 'approval', 'configure', 'python', 'shutdown', 'events.stream',
  'contextHistory', 'contextRestore', 'contextCompact', 'legacyStart',
  'project.list', 'project.create', 'project.update', 'project.delete',
  'conversation.list', 'conversation.create', 'conversation.get', 'conversation.append', 'conversation.update', 'conversation.delete',
  'import.inspect', 'import.apply', 'import.jobs', 'import.rollback',
  'research.knowledge', 'research.hypothesis', 'research.debate', 'research.methods',
  'research.analysis', 'research.discovery', 'research.autonomy', 'research.graph',
  'hypothesis.list', 'hypothesis.get', 'hypothesis.select',
  'experiment.list', 'experiment.create', 'experiment.approve', 'experiment.result',
  'evidence.list', 'evidence.get', 'artifact.read',
  'skill.list', 'skill.inspect', 'skill.install', 'skill.enable', 'skill.disable', 'skill.test', 'skill.remove',
  'mcp.list', 'mcp.add', 'mcp.remove', 'mcp.health', 'mcp.tools', 'mcp.enable', 'mcp.disable',
  'channel.list', 'channel.save', 'channel.test', 'channel.send', 'channel.inbox', 'channel.remove',
  'rsi.list', 'rsi.run', 'rsi.review', 'rsi.promote', 'rsi.rollback', 'rsi.active',
  'doctor.run', 'worker.health', 'worker.describe',
  'defaults.get', 'defaults.set',
  'secrets.status', 'secret.put', 'secret.remove', 'secrets.set',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

/** Step kinds the daemon may accept for user-created tasks (extended by each module). */
export const TASK_STEP_KINDS = [
  'echo', 'delay', 'approval', 'model', 'pubmed', 'uniprot', 'python',
  'research', 'knowledge', 'hypothesis', 'debate', 'methods', 'analysis', 'discovery', 'autonomy',
  'skill.test', 'channel.send', 'rsi.evaluate',
] as const;
export type TaskStepKind = (typeof TASK_STEP_KINDS)[number];
