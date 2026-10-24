import type { ActivityHandler, Json } from '../harness/types.js';
import { ValidationError } from '../harness/types.js';
import type { ActivityServices, RecordStore, WorkerClient } from '../shared/contract.js';
import {
  McpRegistry, SkillRegistry, type McpRegistryOptions, type SkillRegistryOptions, type ToolDeps,
} from '../domain/tools.js';
import { ChannelService, type ChannelDeps } from '../domain/channels.js';
import { RsiEngine, type EvalRunner, type RsiEngineOptions, type RsiKind, type StrategyView } from '../domain/rsi.js';

/** The tool-domain service bundle the Lead wires into the daemon and activity engine. */
export interface ToolServices {
  mcp: McpRegistry;
  skills: SkillRegistry;
  channels: ChannelService;
  rsi: RsiEngine;
}

export interface CreateToolServicesOptions {
  mcpOptions?: McpRegistryOptions;
  skillOptions?: SkillRegistryOptions;
  channelOptions?: Omit<ChannelDeps, 'store' | 'home' | 'clock' | 'fetch' | 'secrets'> & {
    fetch?: ChannelDeps['fetch'];
    secrets?: ChannelDeps['secrets'];
  };
  rsiOptions?: RsiEngineOptions;
  /** Convenience alias for rsiOptions.runner. */
  runner?: EvalRunner;
}

/**
 * Build the tool-domain services from injected dependencies. `fetch`, `secrets`
 * and the SMTP transport are injected, so tests never touch the network.
 */
export function createToolServices(deps: ToolDeps, options: CreateToolServicesOptions = {}): ToolServices {
  const channels = new ChannelService({
    store: deps.store,
    home: deps.home,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
    ...(options.channelOptions ?? {}),
  });
  const rsiOptions: RsiEngineOptions = {
    ...(options.rsiOptions ?? {}),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  };
  return {
    mcp: new McpRegistry(deps, options.mcpOptions ?? {}),
    skills: new SkillRegistry(deps, options.skillOptions ?? {}),
    channels,
    rsi: new RsiEngine({ store: deps.store, ...(deps.clock === undefined ? {} : { clock: deps.clock }) }, rsiOptions),
  };
}

export type ToolActivityServices = ActivityServices & { tools?: ToolServices };

function toolServices(services: ToolActivityServices): ToolServices {
  if (services.tools) return services.tools;
  // Defensive fallback for a bare ActivityServices; the daemon normally passes `tools`.
  const deps: ToolDeps = {
    store: services.store,
    home: services.home,
    worker: services.worker,
    clock: services.clock,
  };
  return createToolServices(deps);
}

function json(value: unknown): Json { return value as Json; }

function inputObject(context: { step: { input?: Json } }): Record<string, Json> {
  const input = context.step?.input;
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('step input must be an object');
  return input as Record<string, Json>;
}

function requireText(value: Json | undefined, name: string, min = 1, max = 10_000): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new ValidationError(`${name} must be a string of ${min}..${max} characters`);
  return value;
}

function optionalText(value: Json | undefined, name: string, max = 10_000): string | undefined {
  return value === undefined || value === null ? undefined : requireText(value, name, 1, max);
}

/** Resolve a skill id from either `skillId` or `id`. */
function skillIdOf(input: Record<string, Json>): string {
  return requireText(input.skillId ?? input.id ?? input.skill, 'skillId', 1, 200);
}

/** Resolve a channel id from either `channelId` or `id`. */
function channelIdOf(input: Record<string, Json>): string {
  return requireText(input.channelId ?? input.id ?? input.channel, 'channelId', 1, 200);
}

// ---------------------------------------------------------------------------
// Activities (`skill.test`, `channel.send`, `rsi.evaluate`)
// ---------------------------------------------------------------------------

/**
 * Activity handlers registered by the Lead for the tool-domain step kinds.
 *
 * - `skill.test` runs the skill manifest's declared test in the isolated worker.
 * - `channel.send` sends through the configured channel; task builders must mark
 *   it `sideEffect: true` and insert an approval step for non read-only channels.
 * - `rsi.evaluate` runs one bounded RSI cycle with the injected evaluation runner.
 */
export function createToolHandlers(services: ToolActivityServices): Record<string, ActivityHandler> {
  const tools = toolServices(services);

  const skillTest: ActivityHandler = async context => {
    const input = inputObject(context);
    const id = skillIdOf(input);
    const worker: WorkerClient | undefined = services.worker;
    const result = await tools.skills.test(id, { signal: context.signal, ...(worker === undefined ? {} : { worker }) });
    return {
      output: json({
        skillId: id,
        status: result.status,
        detail: result.detail,
        skill: result.skill,
        result: result.result,
      }),
    };
  };

  const channelSend: ActivityHandler = async context => {
    const input = inputObject(context);
    const id = channelIdOf(input);
    const text = requireText(input.text, 'text', 1, 100_000);
    const message: Record<string, Json> = { text };
    const to = optionalText(input.to, 'to', 320);
    if (to !== undefined) message.to = to;
    const subject = optionalText(input.subject, 'subject', 200);
    if (subject !== undefined) message.subject = subject;
    const sent = await tools.channels.send(id, message as Json);
    return { output: json(sent) };
  };

  const rsiEvaluate: ActivityHandler = async context => {
    const input = inputObject(context);
    const run = await tools.rsi.run(input as Json, context.signal);
    return { output: json(run) };
  };

  return {
    'skill.test': skillTest,
    'channel.send': channelSend,
    'rsi.evaluate': rsiEvaluate,
  };
}

/** Step kinds this factory provides. */
export const TOOL_ACTIVITY_KINDS = ['skill.test', 'channel.send', 'rsi.evaluate'] as const;

// ---------------------------------------------------------------------------
// RPC helpers (daemon routes `skill.*`, `mcp.*`, `channel.*`, `rsi.*` here)
// ---------------------------------------------------------------------------

export type ToolRpcHandler = (params: Json) => Promise<Json> | Json;

function paramsObject(params: Json | undefined): Record<string, Json> {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new ValidationError('params must be an object');
  return params as Record<string, Json>;
}

/**
 * Plain RPC handlers for the daemon dispatch table. Return values are plain JSON:
 * list methods return `{ <plural>: [...] }`, mutations return the updated view,
 * removals return `{ ok: true }`.
 */
export function createToolRpcHandlers(services: ToolActivityServices): Record<string, ToolRpcHandler> {
  const tools = toolServices(services);
  const handlers: Record<string, ToolRpcHandler> = {
    // skills
    'skill.list': () => json({ skills: tools.skills.list() }),
    'skill.inspect': async params => json({ inspection: await tools.skills.inspect(params) }),
    'skill.install': async params => json({ skill: await tools.skills.install(params) }),
    'skill.enable': async params => {
      const input = paramsObject(params);
      return json({ skill: await tools.skills.enable(requireText(input.id ?? input.skillId, 'id', 1, 200), true) });
    },
    'skill.disable': async params => {
      const input = paramsObject(params);
      return json({ skill: await tools.skills.enable(requireText(input.id ?? input.skillId, 'id', 1, 200), false) });
    },
    'skill.test': async params => {
      const input = paramsObject(params);
      const result = await tools.skills.test(requireText(input.id ?? input.skillId, 'id', 1, 200));
      return json({ skill: result.skill, status: result.status, detail: result.detail, result: result.result });
    },
    'skill.remove': async params => {
      const input = paramsObject(params);
      return json(await tools.skills.remove(requireText(input.id ?? input.skillId, 'id', 1, 200)));
    },

    // MCP servers
    'mcp.list': params => {
      const input = paramsObject(params);
      const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
      return json({ servers: tools.mcp.list(projectId) });
    },
    'mcp.add': async params => json({ server: await tools.mcp.add(params) }),
    'mcp.remove': async params => {
      const input = paramsObject(params);
      return json(await tools.mcp.remove(requireText(input.id, 'id', 1, 200)));
    },
    'mcp.health': async params => {
      const input = paramsObject(params);
      return json({ server: await tools.mcp.health(requireText(input.id, 'id', 1, 200)) });
    },
    'mcp.tools': async params => {
      const input = paramsObject(params);
      const id = requireText(input.id, 'id', 1, 200);
      const list = await tools.mcp.tools(id, input.refresh === true ? { refresh: true } : {});
      return json({ tools: list });
    },
    'mcp.enable': async params => {
      const input = paramsObject(params);
      const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
      return json({ server: await tools.mcp.enable(requireText(input.id, 'id', 1, 200), true, projectId) });
    },
    'mcp.disable': async params => {
      const input = paramsObject(params);
      const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
      return json({ server: await tools.mcp.enable(requireText(input.id, 'id', 1, 200), false, projectId) });
    },

    // channels
    'channel.list': () => json({ channels: tools.channels.list() }),
    'channel.save': async params => json({ channel: await tools.channels.save(params) }),
    'channel.test': async params => {
      const input = paramsObject(params);
      return json({ health: await tools.channels.test(requireText(input.id ?? input.channelId, 'id', 1, 200)) });
    },
    'channel.send': async params => {
      const input = paramsObject(params);
      const id = requireText(input.id ?? input.channelId, 'id', 1, 200);
      const text = requireText(input.text, 'text', 1, 100_000);
      const message: Record<string, Json> = { text };
      if (typeof input.to === 'string') message.to = requireText(input.to, 'to', 1, 320);
      if (typeof input.subject === 'string') message.subject = requireText(input.subject, 'subject', 1, 200);
      return json(await tools.channels.send(id, message as Json));
    },
    'channel.inbox': params => {
      const input = paramsObject(params);
      const options: { channelId?: string; limit?: number } = {};
      if (typeof input.channelId === 'string') options.channelId = input.channelId;
      if (typeof input.limit === 'number' && Number.isFinite(input.limit)) options.limit = Math.max(1, Math.min(Math.floor(input.limit), 500));
      return json({ messages: tools.channels.inbox(options) });
    },
    'channel.remove': async params => {
      const input = paramsObject(params);
      return json(await tools.channels.remove(requireText(input.id ?? input.channelId, 'id', 1, 200)));
    },

    // RSI
    'rsi.list': params => {
      const input = paramsObject(params);
      const kind = typeof input.kind === 'string' ? input.kind as RsiKind : undefined;
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(Math.floor(input.limit), 500)) : undefined;
      return json({ runs: tools.rsi.list({ ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }) }) });
    },
    'rsi.run': async params => json({ run: await tools.rsi.run(params) }),
    'rsi.review': params => {
      const input = paramsObject(params);
      const reviewInput: Record<string, Json> = {};
      if (typeof input.decision === 'string') reviewInput.decision = input.decision;
      if (typeof input.note === 'string') reviewInput.note = input.note;
      return json({ run: tools.rsi.review(requireText(input.runId ?? input.id, 'runId', 1, 200), reviewInput as Json) });
    },
    'rsi.promote': params => {
      const input = paramsObject(params);
      const promoteInput: Record<string, Json> = { confirm: input.confirm === true };
      if (typeof input.note === 'string') promoteInput.note = input.note;
      return json({ run: tools.rsi.promote(requireText(input.runId ?? input.id, 'runId', 1, 200), promoteInput as Json) });
    },
    'rsi.rollback': params => {
      const input = paramsObject(params);
      const rollbackInput: Record<string, Json> = {};
      if (typeof input.note === 'string') rollbackInput.note = input.note;
      return json({ run: tools.rsi.rollback(requireText(input.runId ?? input.id, 'runId', 1, 200), rollbackInput as Json) });
    },
    'rsi.active': params => {
      const input = paramsObject(params);
      const kind = typeof input.kind === 'string' ? input.kind as RsiKind : undefined;
      const active: Array<{ kind: string; strategy: StrategyView | null }> = [];
      for (const candidateKind of (kind === undefined ? (['routing', 'prompt', 'skill', 'tool-selection', 'test-coverage'] as RsiKind[]) : [kind])) {
        let strategy: StrategyView | null = null;
        try { strategy = tools.rsi.active(candidateKind); } catch { strategy = null; }
        active.push({ kind: candidateKind, strategy });
      }
      return json(kind === undefined ? { active } : { active: active[0]?.strategy ?? null });
    },
  };
  return handlers;
}

export interface ToolDoctorCheck { id: string; status: 'ok' | 'warn' | 'failed'; detail: string }

/** Health summary entries for `doctor.run` (mcp / channels / skills / rsi). */
export function collectToolDoctorChecks(services: ToolActivityServices): ToolDoctorCheck[] {
  const tools = toolServices(services);
  const checks: ToolDoctorCheck[] = [];
  const servers = tools.mcp.list();
  const failedServers = servers.filter(server => server.health.status === 'failed');
  checks.push({
    id: 'mcp',
    status: failedServers.length ? 'failed' : servers.length ? 'ok' : 'warn',
    detail: `${servers.length} configured, ${servers.filter(server => server.enabled).length} enabled, ${failedServers.length} failed health`,
  });
  const skills = tools.skills.list();
  const failedSkills = skills.filter(skill => skill.test.status === 'failed');
  checks.push({
    id: 'skills',
    status: failedSkills.length ? 'warn' : skills.length ? 'ok' : 'warn',
    detail: `${skills.length} installed, ${skills.filter(skill => skill.enabled).length} enabled, ${failedSkills.length} failing tests`,
  });
  const channels = tools.channels.list();
  const failedChannels = channels.filter(channel => channel.health.status === 'failed');
  checks.push({
    id: 'channels',
    status: failedChannels.length ? 'failed' : channels.length ? 'ok' : 'warn',
    detail: `${channels.length} configured, ${channels.filter(channel => channel.enabled).length} enabled, ${failedChannels.length} failed health`,
  });
  const runs = tools.rsi.list({ limit: 1 });
  const lastRun = runs[0];
  checks.push({
    id: 'rsi',
    status: lastRun && lastRun.status === 'failed' ? 'warn' : 'ok',
    detail: lastRun ? `last cycle ${lastRun.cycle} ${lastRun.kind} => ${lastRun.status}` : 'no cycles yet',
  });
  return checks;
}

/** Narrow helper for daemons that only need the activity handler map. */
export function isToolActivityKind(kind: string): kind is (typeof TOOL_ACTIVITY_KINDS)[number] {
  return (TOOL_ACTIVITY_KINDS as readonly string[]).includes(kind);
}

/** Re-exported for tests and the Lead: record kinds written by this domain. */
export const TOOL_RECORD_KINDS = [
  'mcpServer', 'skill', 'channel', 'channelMessage', 'channelAudit', 'rsiRun', 'strategy', 'evalCase', 'rsiAudit',
] as const;

// Keep RecordStore referenced for consumers that build deps objects from this module.
export type ToolRecordStore = RecordStore;
