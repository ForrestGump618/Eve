/**
 * Capability RPC handlers: the six research capabilities plus tool, MCP,
 * skill, channel, RSI and secret-management endpoints.
 *
 * Research endpoints only build a validated task DAG and hand it to the
 * durable store. Execution happens in the harness engine, so closing the UI or
 * crashing the daemon never leaves a half-executed capability in renderer
 * memory.
 */
import { ValidationError, type Json, type TaskDefinition } from '../harness/types.js';
import type { Store } from '../harness/store.js';
import type { ActivityServices } from '../shared/contract.js';
import {
  buildAnalysisTask,
  buildAutonomyTask,
  buildDiscoveryTask,
  buildKnowledgeTask,
  buildMethodsTask,
  loadResearchGraph,
  type AnalysisTaskInput,
  type AutonomyTaskInput,
  type DiscoveryTaskInput,
  type KnowledgeTaskInput,
  type MethodsTaskInput,
} from '../domain/research.js';
import {
  buildDebateTask,
  buildHypothesisTask,
  type DebateTaskInput,
  type HypothesisTaskInput,
} from '../domain/hypothesis.js';
import {
  createToolRpcHandlers,
  type ToolRpcHandler,
  type ToolServices,
} from '../activities/tools.js';

export interface CapabilityDeps {
  store: Store;
  /** Shared activity services handed to tool activities. */
  services: ActivityServices;
  tools: ToolServices;
  /**
   * Main-process only: push decrypted credential references into the daemon's
   * in-memory secret map. Never persisted by the daemon.
   */
  setSecrets?: (refs: Record<string, string>) => void;
}

type Handler = (params: Record<string, Json>) => Promise<Json> | Json;

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SECRET_REF = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/;
const MODEL_REQUIRED = '请先配置并解锁模型；离线后台演示和数据库检索无需模型。';

function objectParams(params: unknown): Record<string, Json> {
  if (params === null || params === undefined) return {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new ValidationError('RPC 参数必须是 JSON 对象');
  return params as Record<string, Json>;
}

/**
 * Create a durable task from a research template.
 *
 * A template that requires model reasoning is rejected before persistence when
 * no model is configured, mirroring the legacy desktop behaviour instead of
 * silently queuing a task that can never run.
 */
function submitTask(store: Store, services: ActivityServices, definition: TaskDefinition): Json {
  const needsModel = definition.steps.some(step => step.kind === 'model') || definition.steps.some(step => step.kind === 'hypothesis' || step.kind === 'debate');
  if (needsModel && !services.model.configured()) throw new ValidationError(MODEL_REQUIRED);
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) throw new ValidationError('研究任务必须包含至少一个步骤');
  const task = store.createTask(definition);
  return { taskId: task.id, task: task as unknown as Json };
}

function graphParams(params: Record<string, Json>): { graphId?: string; taskId?: string; projectId?: string } {
  const out: { graphId?: string; taskId?: string; projectId?: string } = {};
  for (const key of ['graphId', 'taskId', 'projectId'] as const) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !RECORD_ID.test(value)) throw new ValidationError(`research.graph 参数 ${key} 无效`);
    out[key] = value;
  }
  return out;
}

export function createCapabilityHandlers(deps: CapabilityDeps): Record<string, Handler> {
  const { store, services, tools } = deps;
  const toolHandlers: Record<string, ToolRpcHandler> = createToolRpcHandlers({ ...services, tools });
  const handlers: Record<string, Handler> = {};

  handlers['research.knowledge'] = params => submitTask(store, services, buildKnowledgeTask(objectParams(params) as unknown as KnowledgeTaskInput));
  handlers['research.hypothesis'] = params => submitTask(store, services, buildHypothesisTask(objectParams(params) as unknown as HypothesisTaskInput));
  handlers['research.debate'] = params => submitTask(store, services, buildDebateTask(objectParams(params) as unknown as DebateTaskInput));
  handlers['research.methods'] = params => submitTask(store, services, buildMethodsTask(objectParams(params) as unknown as MethodsTaskInput));
  handlers['research.analysis'] = params => submitTask(store, services, buildAnalysisTask(objectParams(params) as unknown as AnalysisTaskInput));
  handlers['research.discovery'] = params => submitTask(store, services, buildDiscoveryTask(objectParams(params) as unknown as DiscoveryTaskInput));
  handlers['research.autonomy'] = params => submitTask(store, services, buildAutonomyTask(objectParams(params) as unknown as AutonomyTaskInput));
  handlers['research.graph'] = params => {
    const p = objectParams(params);
    const loaded = loadResearchGraph(store, graphParams(p));
    if (loaded === undefined) {
      const rows = store.listRecords('researchGraph', { limit: 100 });
      return {
        graph: null,
        recordId: null,
        records: rows.map(row => ({ id: row.id, version: row.version, updatedAt: row.updatedAt, objective: (row.data as Record<string, Json>).objective ?? null })),
      } as unknown as Json;
    }
    return { recordId: loaded.row.id, graph: loaded.data as unknown as Json } as unknown as Json;
  };

  const setSecrets = deps.setSecrets;
  if (setSecrets) {
    handlers['secrets.set'] = params => {
      const p = objectParams(params);
      const refs = p.refs;
      if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) throw new ValidationError('refs 必须是对象');
      const entries = Object.entries(refs as Record<string, Json>);
      if (entries.length > 200) throw new ValidationError('凭据引用过多');
      const clean: Record<string, string> = {};
      for (const [reference, value] of entries) {
        if (!SECRET_REF.test(reference)) throw new ValidationError(`凭据引用名无效: ${reference}`);
        if (typeof value !== 'string' || value.length > 8192) throw new ValidationError(`凭据 ${reference} 必须是字符串`);
        clean[reference] = value;
      }
      setSecrets(clean);
      return { ok: true, count: Object.keys(clean).length };
    };
  }

  for (const [method, handler] of Object.entries(toolHandlers)) handlers[method] = handler;
  return handlers;
}
