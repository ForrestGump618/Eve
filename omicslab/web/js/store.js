// Shell-level application state shared by the router, top bar and views.
// Views never import app.js; they read/write this store and emit events via bus.js.

import { emit } from './bus.js?v=2.1.0';
import { getPref, setPref } from './util.js?v=2.1.0';

export const ROUTES = [
  { id: 'tasks2', label: '任务中心', icon: 'jobs', subtitle: '持续任务、自动化与多 Agent 讨论' },
  { id: 'research', label: '科研与证据', icon: 'shield', subtitle: '生物工具、来源与独立验证' },
  { id: 'knowledge', label: '知识与记忆', icon: 'memory', subtitle: '当前工作区的检索知识' },
  { id: 'workflow', label: '工作流', icon: 'layers', subtitle: '可视化步骤与审批' },
  { id: 'artifacts', label: '产物中心', icon: 'files', subtitle: '文件、快照与版本' },
  { id: 'extensions', label: '能力中心', icon: 'skills', subtitle: 'MCP、Skills、Agent 和消息渠道' },
  { id: 'diagnostics', label: '系统诊断', icon: 'cpu', subtitle: '状态、资源与执行追踪' },
  { id: 'connections', label: '连接设置', icon: 'key', subtitle: '兼容的模型连接与凭据配置', hidden: true },
  { id: 'workbench', label: '工作台', icon: 'layers', subtitle: '工作区、会话与计算面板' },
  { id: 'chat', label: '对话', icon: 'chat', subtitle: '与智能体协作分析' },
  { id: 'discovery', label: '发现', icon: 'discovery', subtitle: '自主发现（RSI）项目' },
  { id: 'vars', hidden: true, label: '变量', icon: 'vars', subtitle: '内核工作区变量' },
  { id: 'files', hidden: true, label: '文件', icon: 'files', subtitle: '工作区文件管理' },
  { id: 'figures', hidden: true, label: '图库', icon: 'figures', subtitle: '已生成的图表' },
  { id: 'jobs', hidden: true, label: '任务', icon: 'jobs', subtitle: '后台脚本任务' },
  { id: 'skills', hidden: true, label: '技能', icon: 'skills', subtitle: '可复用的分析技能包' },
  { id: 'registry', hidden: true, label: '函数库', icon: 'registry', subtitle: '已安装包函数索引' },
  { id: 'memory', hidden: true, label: '记忆', icon: 'memory', subtitle: '长期项目记忆' },
  { id: 'ssh', label: 'SSH', icon: 'ssh', subtitle: '远程主机终端' },
  { id: 'settings', label: '设置', icon: 'settings', subtitle: '模型、外观与系统' },
];

export const ROUTE_IDS = ROUTES.map((r) => r.id);

export const state = {
  route: 'workbench',
  routeParams: {},
  agents: [],
  agentId: getPref('agent', ''),
  // Effective default agent resolved at startup (CONTRACTS-3 T07):
  // { id, source: 'session'|'settings'|'builtin', message } or null when unknown.
  agentDefault: null,
  conversations: [],
  activeConversationId: null,
  health: null,
  online: true,
  kernel: { running: false, varsCount: 0 },
  figuresCount: 0,
  settings: null,
  providers: [],
  // Currently selected workspace used for new runs / panels (T09).
  workspaceId: getPref('workspaceId', ''),
  workspace: null,
  bootError: null,
};

export function getState() {
  return state;
}

/** Merge a shallow patch into the state and notify subscribers. */
export function setState(patch) {
  if (!patch || typeof patch !== 'object') return state;
  Object.assign(state, patch);
  emit('state:change', patch);
  return state;
}

/** Parse the route id out of a location hash (`#/files` -> `files`). */
export function parseHash(hash = window.location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  const preferred = getPref('homeRoute', 'workbench');
  return ROUTE_IDS.includes(raw) ? raw : ROUTE_IDS.includes(preferred) ? preferred : 'workbench';
}

/** Navigate to a view by updating the hash (the router reacts to hashchange). */
export function navigate(route, params = null) {
  const target = ROUTE_IDS.includes(route) ? route : 'chat';
  if (params && typeof params === 'object') state.routeParams = { ...params };
  const next = `#/${target}`;
  if (window.location.hash === next) {
    emit('route:request', { route: target, params });
  } else {
    window.location.hash = next;
  }
}

export function routeMeta(routeId) {
  return ROUTES.find((r) => r.id === routeId) || ROUTES[0];
}

export function setAgent(agentId) {
  state.agentId = agentId || '';
  setPref('agent', state.agentId);
  emit('agent:change', state.agentId);
}

/** Remember the backend-provided effective default agent (T07). */
export function setAgentDefault(info) {
  state.agentDefault = info || null;
  return state.agentDefault;
}

/** Remember the active workspace (id + public record) and notify panes (T09). */
export function setWorkspace(workspace) {
  state.workspace = workspace || null;
  state.workspaceId = workspace?.workspace_id || '';
  if (state.workspaceId) setPref('workspaceId', state.workspaceId);
  emit('workspace:change', { workspace: state.workspace, workspaceId: state.workspaceId });
  return state.workspace;
}

export function bumpFigures(delta = 1) {
  state.figuresCount = Math.max(0, state.figuresCount + delta);
  emit('figures:count', state.figuresCount);
}

/** Refresh the data shown in the chrome (agents, health, figures count). */
export function requestShellRefresh() {
  emit('shell:refresh');
}
