/**
 * Core local RPC handlers: projects, conversations, legacy import, evidence,
 * hypotheses, experiments, artifacts, defaults, diagnostics and the research
 * worker bridge. Capability-specific handlers live in `./capabilities.ts`.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { ValidationError, type Artifact, type Json } from '../harness/types.js';
import type { Store } from '../harness/store.js';
import { atomicJson } from '../security.js';
import type { ModelRuntime } from '../model-runtime.js';
import type { ImportService } from '../import-service.js';
import { appendConversationMessage, normalizeConversation, rewriteConversationMessage, type ConversationMessage } from '../conversations.js';
import type { WorkerHealth } from '../shared/contract.js';
import { WorkspaceFiles } from '../workspace-files.js';

const MAX_ARTIFACT_TEXT = 200_000;
const MAX_ARTIFACT_BINARY = 4_000_000;
const PREFERENCE_KEYS = new Set(['language', 'theme', 'autoCompact', 'compactWarn', 'compactHard', 'autoApproveLowRisk', 'showEvidence', 'sendOnEnter', 'defaultMode', 'defaultProjectId', 'confirmHighRisk', 'keepLogs', 'maxTokens', 'budgetCalls', 'budgetCost', 'compactionWarn', 'compactionForce', 'concurrency']);
const PROJECT_WORKSPACE_DIRECTORIES = Object.freeze([
  'data', 'experiments', 'analysis', 'figures', 'reports', 'evidence', 'provenance',
]);

function projectWorkspacePath(home: string, projectId: string): string {
  const safeId = projectId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const suffix = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
  return join(home, 'projects', `${safeId || 'project'}-${suffix}`);
}

function provisionProjectWorkspace(home: string, projectId: string, data: Record<string, Json>): Record<string, Json> {
  const projectsRoot = resolve(join(home, 'projects'));
  const stored = typeof data.workspaceRoot === 'string' ? resolve(data.workspaceRoot) : null;
  const insideProjects = stored && (stored === projectsRoot || stored.startsWith(`${projectsRoot}${sep}`));
  const root = insideProjects ? stored : projectWorkspacePath(home, projectId);
  mkdirSync(root, { recursive: true });
  for (const directory of PROJECT_WORKSPACE_DIRECTORIES) mkdirSync(join(root, directory), { recursive: true });
  return {
    ...data,
    workspaceRoot: root,
    workspaceDirectories: [...PROJECT_WORKSPACE_DIRECTORIES],
  };
}

/** Validate one preference value and return it normalized; rejects values the runtime cannot honor. */
function preferenceValue(key: string, value: Json): Json {
  const numeric = key === 'maxTokens' || key === 'budgetCalls' || key === 'budgetCost' || key === 'concurrency';
  if (numeric) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ValidationError(`${key} must be a nonnegative number`);
    if (key === 'maxTokens' && value < 256) throw new ValidationError('maxTokens must be at least 256');
    if (key === 'budgetCalls' && value < 1) throw new ValidationError('budgetCalls must be at least 1');
    if (key === 'concurrency' && (value < 1 || value > 32 || !Number.isInteger(value))) throw new ValidationError('concurrency must be an integer between 1 and 32');
    return value;
  }
  if (key === 'compactionWarn' || key === 'compactionForce' || key === 'compactWarn' || key === 'compactHard') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) throw new ValidationError(`${key} must be a fraction between 0 and 1`);
    return value;
  }
  if (key === 'autoCompact' || key === 'autoApproveLowRisk' || key === 'showEvidence' || key === 'sendOnEnter' || key === 'confirmHighRisk' || key === 'keepLogs') {
    if (typeof value !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
    return value;
  }
  if (key === 'language') { if (value !== 'zh' && value !== 'en') throw new ValidationError('language must be zh or en'); return value; }
  if (key === 'theme') { if (value !== 'light' && value !== 'dark' && value !== 'system') throw new ValidationError('theme must be light, dark or system'); return value; }
  if (key === 'defaultMode') { if (value !== 'auto' && value !== 'chat' && value !== 'research' && value !== 'debate') throw new ValidationError('defaultMode must be auto, chat, research or debate'); return value; }
  if (typeof value !== 'string') throw new ValidationError(`${key} must be a string`);
  return value.length <= 500 ? value : (() => { throw new ValidationError(`${key} is too long`); })();
}

export interface CoreRpcDeps {
  home: string;
  store: Store;
  model: ModelRuntime;
  imports: ImportService;
  preferencesPath: string;
  pythonPath: () => string;
  setPythonPath: (value: string) => void;
  workerHealth: () => Promise<WorkerHealth>;
  workerDescribe: () => Promise<Json>;
  version: string;
  startedAt: number;
  activeTasks: () => number;
}

type Params = Record<string, Json>;
type Handler = (params: Params) => Promise<Json> | Json;

function str(params: Params, key: string, min = 1, max = 500): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length < min) throw new ValidationError(`${key} must be a string >= ${min}`);
  if (value.length > max) throw new ValidationError(`${key} must be <= ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ValidationError(`${key} contains control characters`);
  return value;
}
function optStr(params: Params, key: string, max = 500): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${key} must be a string`);
  if (value.length > max) throw new ValidationError(`${key} must be <= ${max} characters`);
  return value;
}
function optNum(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${key} must be a finite number`);
  return value;
}
function recordOrThrow(store: Store, id: string, kind?: string) {
  const record = store.getRecord(id);
  if (!record) throw new ValidationError(`Unknown record: ${id}`);
  if (kind && record.kind !== kind) throw new ValidationError(`Record ${id} is a ${record.kind}, expected ${kind}`);
  return record;
}
function recordData(record: { data: Json }): Record<string, Json> {
  return record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? (record.data as Record<string, Json>) : {};
}

export function createCoreHandlers(deps: CoreRpcDeps): Record<string, Handler> {
  const { home, store, model, imports } = deps;

  const listView = (kind: string, options: { projectId?: string | null; limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}): Json[] =>
    store.listRecords(kind, { ...options, limit: Math.min(options.limit ?? 200, 500) }).map(record => ({ id: record.id, version: record.version, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt, ...recordData(record) }));
  const projectContext = (id: string): { record: ReturnType<Store['getRecord']> & { kind: string }; data: Record<string, Json>; root: string } => {
    const record = recordOrThrow(store, id, 'project');
    const current = recordData(record);
    const data = provisionProjectWorkspace(home, record.id, current);
    if (current.workspaceRoot !== data.workspaceRoot || JSON.stringify(current.workspaceDirectories) !== JSON.stringify(data.workspaceDirectories)) {
      const updated = store.putRecord('project', data as unknown as Json, {
        id: record.id,
        expectedVersion: record.version,
        provenance: { kind: 'project.workspace.provision', at: Date.now() },
      });
      return { record: updated, data: recordData(updated), root: String(data.workspaceRoot) };
    }
    return { record: record as typeof record & { kind: string }, data, root: String(data.workspaceRoot) };
  };
  const projectFiles = (root: string): WorkspaceFiles => new WorkspaceFiles([root], []);

  const handlers: Record<string, Handler> = {
    'project.list': () => store.listRecords('project', { limit: 500 }).map(record => {
      const data = provisionProjectWorkspace(home, record.id, recordData(record));
      return { id: record.id, version: record.version, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt, ...data };
    }),
    'project.get': params => {
      const context = projectContext(str(params, 'id'));
      return { id: context.record.id, version: context.record.version, createdAt: context.record.createdAt, updatedAt: context.record.updatedAt, ...context.data, conversations: store.countRecords('conversation', { projectId: context.record.id }) };
    },
    'project.create': params => {
      const name = str(params, 'name', 1, 200).trim();
      if (!name) throw new ValidationError('name must not be blank');
      const notes = optStr(params, 'notes', 20_000) ?? '';
      const id = `project-${randomUUID()}`;
      const data = provisionProjectWorkspace(home, id, { name, notes, archived: false, createdAt: Date.now() });
      const record = store.putRecord('project', data as unknown as Json, { id, projectId: id });
      return { id: record.id, version: record.version, project: { id: record.id, version: record.version, projectId: null, createdAt: record.createdAt, updatedAt: record.updatedAt, ...recordData(record) } };
    },
    'project.update': params => {
      const id = str(params, 'id');
      const current = recordOrThrow(store, id, 'project');
      const data = provisionProjectWorkspace(home, id, recordData(current));
      const next: Record<string, Json> = { ...data };
      const name = optStr(params, 'name', 200);
      if (name !== undefined) { if (!name.trim()) throw new ValidationError('name must not be blank'); next.name = name; }
      const notes = optStr(params, 'notes', 20_000);
      if (notes !== undefined) next.notes = notes;
      if (typeof params.archived === 'boolean') next.archived = params.archived;
      const record = store.putRecord('project', next as unknown as Json, { id, expectedVersion: current.version });
      return { id: record.id, version: record.version, updatedAt: record.updatedAt, ...recordData(record) };
    },
    'project.delete': params => {
      const id = str(params, 'id');
      if (params.confirm !== true) throw new ValidationError('project.delete requires confirm: true');
      const project = recordOrThrow(store, id, 'project');
      let detached = 0;
      for (const conversation of store.listRecords('conversation', { projectId: id, limit: 500 })) {
        const data = recordData(conversation);
        store.putRecord('conversation', { ...data, projectId: null } as unknown as Json, { id: conversation.id, expectedVersion: conversation.version, projectId: null });
        detached += 1;
      }
      store.deleteRecord(project.id);
      const workspaceRoot = typeof recordData(project).workspaceRoot === 'string'
        ? String(recordData(project).workspaceRoot)
        : projectWorkspacePath(home, id);
      return { deleted: id, detachedConversations: detached, workspaceRetained: workspaceRoot };
    },
    'project.workspace.list': async params => {
      const context = projectContext(str(params, 'id'));
      const path = optStr(params, 'path', 1_000) ?? '.';
      const offset = optNum(params, 'offset') ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('offset must be a nonnegative integer');
      return {
        projectId: context.record.id,
        root: context.root,
        directories: PROJECT_WORKSPACE_DIRECTORIES,
        ...(await projectFiles(context.root).list(path, offset) as Record<string, Json>),
      } as unknown as Json;
    },
    'project.workspace.read': async params => {
      const context = projectContext(str(params, 'id'));
      const path = str(params, 'path', 1, 1_000);
      const start = optNum(params, 'startLine') ?? 1;
      const limit = optNum(params, 'limit') ?? 400;
      if (!Number.isSafeInteger(start) || start < 1) throw new ValidationError('startLine must be a positive integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new ValidationError('limit must be between 1 and 2000');
      return { projectId: context.record.id, ...(await projectFiles(context.root).read(path, start, limit) as Record<string, Json>) } as unknown as Json;
    },
    'project.workspace.search': async params => {
      const context = projectContext(str(params, 'id'));
      const query = str(params, 'query', 1, 500);
      const path = optStr(params, 'path', 1_000) ?? '.';
      return { projectId: context.record.id, ...(await projectFiles(context.root).search(query, path) as Record<string, Json>) } as unknown as Json;
    },
    'project.workspace.write': async params => {
      const context = projectContext(str(params, 'id'));
      const path = str(params, 'path', 1, 1_000);
      const content = str(params, 'content', 1, 200_000);
      const expectedSha256 = optStr(params, 'expectedSha256', 64);
      if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ValidationError('expectedSha256 is invalid');
      return { projectId: context.record.id, ...(await projectFiles(context.root).write(path, content, expectedSha256) as Record<string, Json>) } as unknown as Json;
    },

    'conversation.list': params => {
      const projectId = params.projectId === null ? null : optStr(params, 'projectId');
      const records = store.listRecords('conversation', { projectId, limit: Math.min(optNum(params, 'limit') ?? 200, 500), order: 'desc' });
      return records.map(record => {
        const view = normalizeConversation(record.data);
        const last = [...view.messages].reverse().find(message => message.text);
        return { id: record.id, version: record.version, projectId: view.projectId, title: view.title, mode: view.mode, messageCount: view.messages.length, preview: last ? last.text.slice(0, 160) : '', updatedAt: view.updatedAt || record.updatedAt, legacy: view.legacy ?? null };
      });
    },
    'conversation.create': params => {
      const projectId = optStr(params, 'projectId');
      if (projectId) recordOrThrow(store, projectId, 'project');
      const title = (optStr(params, 'title', 300) ?? '').trim() || '新会话';
      const mode = (optStr(params, 'mode', 32) ?? 'chat').trim() || 'chat';
      const record = store.putRecord('conversation', { projectId: projectId ?? null, title, mode, messages: [], updatedAt: Date.now() } as unknown as Json, { projectId: projectId ?? null });
      return { id: record.id, version: record.version, title, mode, projectId: projectId ?? null, messages: [], activeBranchId: null, updatedAt: record.updatedAt };
    },
    'conversation.get': params => {
      const record = recordOrThrow(store, str(params, 'id'), 'conversation');
      const view = normalizeConversation(record.data);
      return { id: record.id, version: record.version, projectId: view.projectId, title: view.title, mode: view.mode, messages: view.messages as unknown as Json, activeBranchId: view.activeBranchId ?? null, updatedAt: view.updatedAt, legacy: view.legacy ?? null };
    },
    'conversation.append': params => {
      const id = str(params, 'id');
      const rawInputs: Json[] = Array.isArray(params.messages) ? (params.messages as Json[]) : params.message !== undefined ? [params.message] : [];
      if (!rawInputs.length) throw new ValidationError('message or messages is required');
      if (rawInputs.length > 32) throw new ValidationError('at most 32 messages per append');
      const messages: ConversationMessage[] = rawInputs.map(input => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('message must be an object');
        const raw = input as Record<string, Json>;
        return {
          id: typeof raw.id === 'string' && raw.id ? raw.id : `m-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          role: raw.role === 'assistant' ? 'assistant' : raw.role === 'system' ? 'system' : 'user',
          text: typeof raw.text === 'string' ? raw.text : '',
          at: typeof raw.at === 'number' ? raw.at : Date.now(),
          ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
          ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
          ...(typeof raw.revisionOf === 'string' ? { revisionOf: raw.revisionOf } : {}),
          ...(typeof raw.supersededBy === 'string' ? { supersededBy: raw.supersededBy } : {}),
          ...(typeof raw.branchId === 'string' ? { branchId: raw.branchId } : {}),
          ...(typeof raw.replacesTaskId === 'string' ? { replacesTaskId: raw.replacesTaskId } : {})
        } as ConversationMessage;
      });
      let record = recordOrThrow(store, id, 'conversation');
      const indices: number[] = [];
      for (const message of messages) {
        const appended = appendConversationMessage(store, id, message);
        record = appended.record;
        indices.push(appended.index);
      }
      const view = normalizeConversation(record.data);
      return {
        record: { id: record.id, version: record.version, updatedAt: view.updatedAt },
        index: indices[0],
        indices,
        message: view.messages[indices[0]] as unknown as Json,
        messages: view.messages as unknown as Json,
      } as unknown as Json;
    },
    'conversation.update': params => {
      const id = str(params, 'id');
      const current = recordOrThrow(store, id, 'conversation');
      const view = normalizeConversation(current.data);
      const title = optStr(params, 'title', 300);
      const mode = optStr(params, 'mode', 32);
      const data: Record<string, Json> = { projectId: view.projectId, title: title ?? view.title, mode: mode ?? view.mode, messages: view.messages as unknown as Json, updatedAt: Date.now() };
      if (view.activeBranchId) data.activeBranchId = view.activeBranchId;
      if (view.legacy !== undefined) data.legacy = view.legacy;
      if (params.projectId !== undefined) {
        if (params.projectId === null) data.projectId = null;
        else { const projectId = str(params, 'projectId'); recordOrThrow(store, projectId, 'project'); data.projectId = projectId; }
      }
      const record = store.putRecord('conversation', data as unknown as Json, { id, expectedVersion: current.version });
      return { id: record.id, version: record.version, updatedAt: record.updatedAt, title: data.title, mode: data.mode, projectId: data.projectId };
    },
    'conversation.rewrite': params => {
      const id = str(params, 'id');
      const messageId = str(params, 'messageId', 1, 100);
      const text = str(params, 'text', 1, 100_000);
      const mode = optStr(params, 'mode', 32);
      const current = recordOrThrow(store, id, 'conversation');
      const view = normalizeConversation(current.data);
      const original = view.messages.find(message => message.id === messageId);
      if (!original || original.role !== 'user') throw new ValidationError('Only an existing user message can be rewritten');
      const taskUsesConversation = (task: ReturnType<Store['listTasks']>[number]): boolean =>
        store.getSteps(task.id).some(step => String((step.input as Record<string, Json> | undefined)?.conversationId ?? '') === id);
      const activeStatuses = new Set(['queued', 'running', 'waiting_external', 'waiting_approval', 'retry_scheduled']);
      const activeTasks = store.listTasks().filter(task => activeStatuses.has(task.status) && taskUsesConversation(task));
      const pausedTaskIds: string[] = [];
      for (const task of activeTasks) {
        // Pause before truncating the transcript. If a task cannot be paused we
        // abort the rewrite rather than allow stale work to append to the branch.
        store.pauseTask(task.id, task.version);
        pausedTaskIds.push(task.id);
      }
      const rewritten = rewriteConversationMessage(store, id, messageId, text, {
        ...(mode === undefined ? {} : { mode }),
        ...(original.taskId ? { replacesTaskId: original.taskId } : {}),
        pausedTaskIds,
      });
      return {
        id,
        version: rewritten.record.version,
        messages: rewritten.messages as unknown as Json,
        branchId: rewritten.branchId,
        auditId: rewritten.auditId,
        originalIndex: rewritten.originalIndex,
        previousTaskId: original.taskId ?? null,
        pausedTaskIds,
        message: rewritten.messages[rewritten.originalIndex] as unknown as Json,
      } as unknown as Json;
    },
    'conversation.delete': params => {
      if (params.confirm !== true) throw new ValidationError('conversation.delete requires confirm: true');
      const record = recordOrThrow(store, str(params, 'id'), 'conversation');
      store.deleteRecord(record.id);
      return { deleted: record.id };
    },

    'import.inspect': () => imports.inspect() as unknown as Json,
    'import.apply': params => imports.apply({ kinds: Array.isArray(params.kinds) ? params.kinds.filter((kind): kind is string => typeof kind === 'string') : undefined, dryRun: params.dryRun === true }) as unknown as Json,
    'import.jobs': () => imports.jobs() as unknown as Json,
    'import.rollback': params => imports.rollback(str(params, 'jobId')) as unknown as Json,

    'evidence.list': params => {
      const kind = optStr(params, 'kind', 64);
      const taskId = optStr(params, 'taskId', 200);
      const projectId = params.projectId === null ? null : optStr(params, 'projectId', 200);
      const records = store.listRecords('evidence', { projectId, limit: Math.min(optNum(params, 'limit') ?? 200, 500), order: 'desc' });
      return records.filter(record => !kind || recordData(record).kind === kind).filter(record => !taskId || recordData(record).taskId === taskId).map(record => ({ id: record.id, version: record.version, projectId: record.projectId, createdAt: record.createdAt, ...recordData(record) }));
    },
    'evidence.get': params => {
      const record = recordOrThrow(store, str(params, 'id'), 'evidence');
      return { id: record.id, version: record.version, projectId: record.projectId, provenance: record.provenance, createdAt: record.createdAt, ...recordData(record) };
    },

    'hypothesis.list': params => {
      const status = optStr(params, 'status', 32);
      return listView('hypothesis', { projectId: params.projectId === null ? null : optStr(params, 'projectId'), limit: Math.min(optNum(params, 'limit') ?? 200, 500), order: 'desc' }).filter(row => !status || (row as Record<string, Json>).status === status);
    },
    'hypothesis.get': params => {
      const record = recordOrThrow(store, str(params, 'id'), 'hypothesis');
      return { id: record.id, version: record.version, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt, ...recordData(record) };
    },
    'hypothesis.select': params => {
      const id = str(params, 'id');
      const current = recordOrThrow(store, id, 'hypothesis');
      const data = recordData(current);
      for (const peer of store.listRecords('hypothesis', { projectId: current.projectId, limit: 500 })) {
        if (peer.id === id) continue;
        const peerData = recordData(peer);
        if (peerData.selected === true) store.putRecord('hypothesis', { ...peerData, selected: false } as unknown as Json, { id: peer.id, expectedVersion: peer.version });
      }
      const record = store.putRecord('hypothesis', { ...data, selected: true, selectedAt: Date.now(), status: 'selected' } as unknown as Json, { id, expectedVersion: current.version });
      return { id: record.id, version: record.version, selected: true };
    },

    'experiment.list': params => listView('experiment', { projectId: params.projectId === null ? null : optStr(params, 'projectId'), limit: Math.min(optNum(params, 'limit') ?? 200, 500), order: 'desc' }),
    'experiment.get': params => {
      const record = recordOrThrow(store, str(params, 'id'), 'experiment');
      return { id: record.id, version: record.version, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt, ...recordData(record) };
    },
    'experiment.create': params => {
      const design = str(params, 'design', 1, 20_000);
      const hypothesisId = optStr(params, 'hypothesisId', 200);
      let projectId = optStr(params, 'projectId', 200) ?? null;
      if (hypothesisId) projectId = projectId ?? recordOrThrow(store, hypothesisId, 'hypothesis').projectId;
      const record = store.putRecord('experiment', {
        projectId, hypothesisId: hypothesisId ?? null, design,
        protocol: optStr(params, 'protocol', 20_000) ?? '', simulated: params.simulated === true,
        status: 'proposed', approval: null, result: null, createdAt: Date.now()
      } as unknown as Json, { projectId });
      return { id: record.id, version: record.version, ...recordData(record) };
    },
    'experiment.approve': params => {
      const id = str(params, 'id');
      const decision = str(params, 'decision', 1, 20);
      if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('decision must be approve or reject');
      const current = recordOrThrow(store, id, 'experiment');
      const data = recordData(current);
      if (data.status !== 'proposed') throw new ValidationError(`Only proposed experiments can be approved (status=${String(data.status)})`);
      const record = store.putRecord('experiment', { ...data, status: decision === 'approve' ? 'approved' : 'rejected', approval: { decision, at: Date.now(), note: optStr(params, 'note', 2000) ?? '' } } as unknown as Json, { id, expectedVersion: current.version });
      return { id: record.id, version: record.version, status: decision === 'approve' ? 'approved' : 'rejected' };
    },
    'experiment.result': params => {
      const id = str(params, 'id');
      const result = params.result;
      if (result === undefined || result === null) throw new ValidationError('result is required');
      const simulated = params.simulated === true;
      const current = recordOrThrow(store, id, 'experiment');
      const data = recordData(current);
      if (data.status !== 'approved' && data.status !== 'awaiting_result') throw new ValidationError(`Experiment must be approved before importing a result (status=${String(data.status)})`);
      if (!simulated && data.simulated === true) throw new ValidationError('A simulated experiment cannot receive a real result without creating a new experiment');
      const record = store.putRecord('experiment', { ...data, result, resultKind: simulated ? 'simulated' : 'real', status: simulated ? 'simulated_completed' : 'completed', completedAt: Date.now() } as unknown as Json, { id, expectedVersion: current.version });
      return { id: record.id, version: record.version, status: simulated ? 'simulated_completed' : 'completed', simulated };
    },

    'artifact.read': params => {
      const taskId = str(params, 'taskId', 1, 200);
      const artifactId = str(params, 'artifactId', 1, 200);
      const artifacts = store.artifacts(taskId);
      const artifact: Artifact | undefined = artifacts.find(item => item.id === artifactId);
      if (!artifact) throw new ValidationError('Unknown artifact');
      const root = resolve(join(home, 'artifacts'));
      const target = resolve(artifact.path);
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new ValidationError('Artifact path is outside the artifact root');
      if (!existsSync(target)) throw new ValidationError('Artifact file is missing');
      const size = statSync(target).size;
      const bytes = readFileSync(target);
      const textual = /^(text\/)|json|csv|markdown|yaml/i.test(artifact.mediaType ?? '') || /\.(txt|md|json|csv|tsv|log|yaml|yml|py|js|ts)$/i.test(target);
      const view: Record<string, Json> = { taskId, artifactId, path: basename(target), mediaType: artifact.mediaType ?? null, bytes: size, sha256: artifact.sha256 };
      if (textual) {
        view.encoding = 'utf8';
        view.truncated = bytes.byteLength > MAX_ARTIFACT_TEXT;
        view.text = bytes.subarray(0, MAX_ARTIFACT_TEXT).toString('utf8');
        return view;
      }
      view.encoding = 'base64';
      view.truncated = bytes.byteLength > MAX_ARTIFACT_BINARY;
      view.base64 = bytes.subarray(0, MAX_ARTIFACT_BINARY).toString('base64');
      return view;
    },

    'defaults.get': () => {
      let preferences: Record<string, Json> = {};
      try {
        const parsed = JSON.parse(readFileSync(deps.preferencesPath, 'utf8')) as Json;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) preferences = parsed as Record<string, Json>;
      } catch { preferences = {}; }
      // Return the preferences flat (the settings UI binds these keys directly) and nested for callers that prefer a namespace.
      return { ...preferences, preferences, model: model.publicConfig(), pythonPath: deps.pythonPath() } as unknown as Json;
    },
    'defaults.set': params => {
      const current = (() => { try { const parsed = JSON.parse(readFileSync(deps.preferencesPath, 'utf8')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Json> : {}; } catch { return {} as Record<string, Json>; } })();
      const next: Record<string, Json> = { ...current };
      const inputs: Record<string, Json> = {};
      if (params.preferences !== undefined) {
        if (!params.preferences || typeof params.preferences !== 'object' || Array.isArray(params.preferences)) throw new ValidationError('preferences must be an object');
        Object.assign(inputs, params.preferences as Record<string, Json>);
      }
      for (const [key, value] of Object.entries(params)) {
        if (key === 'preferences' || key === 'pythonPath') continue;
        if (!PREFERENCE_KEYS.has(key)) throw new ValidationError(`Unknown preference: ${key}`);
        inputs[key] = value;
      }
      for (const [key, value] of Object.entries(inputs)) {
        if (!PREFERENCE_KEYS.has(key)) throw new ValidationError(`Unknown preference: ${key}`);
        next[key] = preferenceValue(key, value);
      }
      if (typeof next.compactionWarn === 'number' && typeof next.compactionForce === 'number' && next.compactionWarn >= next.compactionForce) throw new ValidationError('compactionWarn must be below compactionForce');
      if (typeof next.compactWarn === 'number' && typeof next.compactHard === 'number' && next.compactWarn >= next.compactHard) throw new ValidationError('compactWarn must be below compactHard');
      if (JSON.stringify(next).length > 32_000) throw new ValidationError('preferences are too large');
      if (params.pythonPath !== undefined) {
        const pythonPath = str(params, 'pythonPath', 1, 1000);
        next.pythonPath = pythonPath;
        deps.setPythonPath(pythonPath);
      }
      atomicJson(deps.preferencesPath, next);
      return { ok: true, preferences: next, pythonPath: deps.pythonPath() } as unknown as Json;
    },

    'worker.health': async () => {
      const health = await deps.workerHealth();
      return { ...health, pythonPath: deps.pythonPath() } as unknown as Json;
    },
    'worker.describe': async () => deps.workerDescribe(),

    'doctor.run': async () => {
      const checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [];
      const push = (id: string, status: 'pass' | 'warn' | 'fail', detail: string) => checks.push({ id, status, detail });
      push('daemon', 'pass', `pid ${process.pid}, up ${Math.round((Date.now() - deps.startedAt) / 1000)}s, active tasks ${deps.activeTasks()}`);
      push('store', 'pass', `${store.listTasks().length} tasks, ${store.countRecords('conversation')} conversations, ${store.countRecords('evidence')} evidence records`);
      push('model', model.configured() ? 'pass' : 'warn', model.configured() ? `${model.provider()} / ${model.model()} (窗口 ${model.contextWindow()})` : '未配置模型：聊天与依赖模型的任务会明确失败，请在设置中配置');
      try {
        const pythonPath = deps.pythonPath();
        const probe = spawnSync(pythonPath, ['-c', 'import sys;print(sys.version.split()[0])'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
        push('python', probe.status === 0 ? 'pass' : 'warn', probe.status === 0 ? `${pythonPath} → ${String(probe.stdout ?? '').trim()}` : `${pythonPath} 不可用：${String(probe.error?.message ?? probe.stderr ?? 'unknown').slice(0, 200)}`);
      } catch (error) { push('python', 'warn', `Python 探测失败：${error instanceof Error ? error.message : String(error)}`); }
      const health = await deps.workerHealth();
      push('researchWorker', health.status === 'ok' ? 'pass' : 'warn', health.status === 'ok' ? `worker 就绪 ${health.python ?? ''} ${health.version ?? ''}`.trim() : `worker 不可用：${health.error ?? 'unknown'}`);
      const artifactRoot = join(home, 'artifacts');
      push('artifacts', existsSync(artifactRoot) ? 'pass' : 'warn', existsSync(artifactRoot) ? artifactRoot : '工件目录尚未创建');
      const migrationRoot = join(home, 'migration');
      let backups = 0;
      try { backups = existsSync(migrationRoot) ? readdirSync(migrationRoot).length : 0; } catch { backups = 0; }
      push('migration', 'pass', `${backups} 个迁移备份；旧数据导入需要显式触发`);
      push('mcp', store.countRecords('mcpServer') > 0 ? 'pass' : 'warn', `${store.countRecords('mcpServer')} 个自定义 MCP 服务器；内置只读 PubMed/UniProt 始终可用`);
      push('skills', store.countRecords('skill') > 0 ? 'pass' : 'warn', `${store.countRecords('skill')} 个已注册技能`);
      push('channels', store.countRecords('channel') > 0 ? 'pass' : 'warn', `${store.countRecords('channel')} 个消息渠道配置`);
      try {
        const stats = statSync(home);
        push('home', 'pass', `${home} (${stats.isDirectory() ? 'directory' : 'file'})`);
      } catch { push('home', 'fail', `用户数据目录不可访问：${home}`); }
      return { at: Date.now(), version: deps.version, checks };
    }
  };
  return handlers;
}
