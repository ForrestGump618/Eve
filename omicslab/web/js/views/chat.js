// Chat view: conversation list, message stream, markdown rendering, SSE consumption,
// tool cards, approval prompts, figures, retry/stop and the composer.

import { renderMarkdown } from '../markdown.js?v=1.4.0';
import {openHtmlArtifact} from '../artifact-viewer.js?v=1.4.0';
import {workspaceSidebarHtml,conversationListHtml,conversationFlag} from '../workspace-sidebar.js?v=1.4.0';
import {mountProjectFiles} from '../project-files.js?v=1.4.0';
import {mountGuidance} from '../guidance-ui.js?v=1.4.0';
import {mountFileChanges} from '../file-changes.js?v=1.4.0';
import {chooseComposerSkills} from '../composer-skills.js?v=1.4.0';
import {mountAgentsPanel} from '../agents-panel.js?v=1.4.0';
import { icon, brandMark } from '../icons.js?v=1.4.0';
import {
  esc,
  escAttr,
  cleanValue,
  fmtClock,
  relTime,
  fmtDuration,
  debounce,
  getPref,
  setPref,
  removePref,
  uid,
  truncate,
} from '../util.js?v=1.4.0';
import { api, errorMessage } from '../api.js?v=1.4.0';
import { streamChat, streamTrace } from '../sse.js?v=1.4.0';
import {
  toast,
  toastSuccess,
  toastError,
  toastWarn,
  toastInfo,
  h,
  openModal,
  confirmDialog,
  promptDialog,
  emptyStateHtml,
  openLightbox,
  spinnerHtml,
} from '../ui.js?v=1.4.0';
import { getState, setState, setAgent, setAgentDefault, setWorkspace, navigate } from '../store.js?v=1.4.0';
import { on, emit } from '../bus.js?v=1.4.0';
import { openRunDetail, openRunList } from '../runview.js?v=1.4.0';

const SIDEBAR_MIN = 210;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 264;
const NEAR_BOTTOM_PX = 120;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif)$/i;
// One-time migration flag for pre-1.2 expert preferences (CONTRACTS-3 T07).
const AGENT_MIGRATION_KEY = 'agentMigrationAsked';
const leadAgentLabel = () => (getPref('agentName','Eve') || 'Eve') + ' · 自动';
// Independent run + resumable trace subscription (CONTRACTS-3 §3 T03).
const RUN_WATCHDOG_MS = 45000;
const RUN_RECONNECTS = 3;
const RUN_POLL_TRIES = 5;
const RUN_POLL_DELAY_MS = 1500;
const ACTIVE_RUN_PREFIX = 'activeRun.';
const RUN_STATUS_LABELS = {
  queued: '排队中',
  preparing: '准备中',
  running: '运行中',
  waiting_approval: '等待审批',
  stopping: '正在停止',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断（服务重启）',
  unknown: '状态待确认',
};
const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** Chinese label for a Run status machine value (CONTRACTS-3 §3). */
function runStatusLabel(status) {
  return RUN_STATUS_LABELS[status] || '运行中';
}

function runRecordFrom(data) {
  if (!data || typeof data !== 'object') return null;
  return data.run && typeof data.run === 'object' ? data.run : data;
}

function runPayload(run) {
  if (!run || typeof run !== 'object') return null;
  const runId = run.run_id || run.id || '';
  const traceId = run.trace_id || run.traceId || '';
  if (!runId) return null;
  return { runId, traceId: traceId || '', status: run.status || 'queued', record: run };
}

function isEndpointMissing(err) {
  // 404 = route absent, 405 = route exists only for another method (older backend).
  return (err?.status === 404 || err?.status === 405) && err?.code !== 'run_not_found';
}

function isRunConflict(err) {
  return err?.status === 409 || err?.code === 'run_in_progress';
}

function conflictRunId(err) {
  const detail = err?.detail;
  if (typeof detail === 'string') return '';
  return detail?.run_id || detail?.active_run_id || detail?.runId || '';
}

function rememberActiveRun(convId, info) {
  if (!convId || !info?.runId) return;
  try {
    setPref(ACTIVE_RUN_PREFIX + convId, JSON.stringify(info));
  } catch {
    /* storage unavailable */
  }
}

function loadRememberedRun(convId) {
  if (!convId) return null;
  try {
    const raw = getPref(ACTIVE_RUN_PREFIX + convId, '');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function forgetActiveRun(convId) {
  if (!convId) return;
  try {
    removePref(ACTIVE_RUN_PREFIX + convId);
  } catch {
    /* storage unavailable */
  }
}

/** True when the browser file should be treated as an image (vision input). */
function isImageFile(file) {
  if (!file) return false;
  if (String(file.type || '').startsWith('image/')) return true;
  return IMAGE_EXT_RE.test(String(file.name || ''));
}

/* ------------------------------------------------------------------ */
/* Child agent tasks / task tree (CONTRACTS-3 §8, milestone 2)        */
/* ------------------------------------------------------------------ */

const CHILD_STATUS_LABELS = {
  queued: '排队中',
  pending: '待开始',
  preparing: '准备中',
  running: '运行中',
  waiting_approval: '等待审批',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '状态待确认',
};

const CHILD_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

function childStatusLabel(status) {
  return CHILD_STATUS_LABELS[status] || status || '运行中';
}

function childStatusIcon(status) {
  if (status === 'succeeded') return icon('checkCircle', { size: 14 });
  if (status === 'failed') return icon('xCircle', { size: 14 });
  if (status === 'cancelled' || status === 'interrupted') return icon('stop', { size: 14 });
  if (status === 'queued' || status === 'pending' || status === 'preparing') return icon('clock', { size: 14 });
  return icon('spinner', { size: 14, cls: 'is-spinning' });
}

/** Normalise a child_run SSE frame or an agent_tasks row into one task shape. */
function normalizeChildTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.taskId && raw.status) return raw; // already normalised (idempotent setChildren)
  const taskId = raw.task_id || raw.id || '';
  if (!taskId) return null;
  const status = raw.status || 'running';
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  const error = raw.error && typeof raw.error === 'object' ? raw.error : null;
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : raw.usage || null;
  return {
    taskId,
    runId: raw.child_run_id || raw.run_id || '',
    traceId: raw.child_trace_id || raw.trace_id || '',
    parentRunId: raw.parent_run_id || '',
    agentId: raw.agent_id || raw.profile || '',
    status,
    goal: raw.goal || raw.prompt_preview || '',
    depth: Number(raw.depth) || 0,
    position: typeof raw.position === 'number' ? raw.position : null,
    durationMs: raw.duration_ms ?? result.duration_ms ?? null,
    resultText: raw.result_preview || (typeof result.text === 'string' ? result.text : ''),
    error,
    finishReason: raw.finish_reason || result.finish_reason || '',
    createdAt: raw.created_at || '',
    updatedAt: raw.updated_at || '',
    endedAt: raw.ended_at || '',
    budget: raw.budget && typeof raw.budget === 'object' ? raw.budget : null,
    usage,
    done: CHILD_TERMINAL.has(status),
  };
}

/** Accept {children}, {tasks}, {items} or a bare array. */
function normalizeChildList(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.children)
      ? data.children
      : Array.isArray(data?.tasks)
        ? data.tasks
        : Array.isArray(data?.items)
          ? data.items
          : [];
  return list.map(normalizeChildTask).filter(Boolean);
}

function childTaskHtml(task) {
  const meta = [];
  if (task.agentId) meta.push(`<span class="child-task-agent">${esc(task.agentId)}</span>`);
  meta.push(`<span class="child-task-status">${esc(childStatusLabel(task.status))}</span>`);
  if (task.depth) meta.push(`<span>深度 ${task.depth}</span>`);
  if (task.durationMs != null) meta.push(`<span>${esc(fmtDuration(task.durationMs))}</span>`);
  const tail = task.error
    ? `<div class="child-task-error">${esc(truncate(task.error.message || '子任务失败', 180))}</div>`
    : task.resultText
      ? `<div class="child-task-result">${esc(truncate(task.resultText, 180))}</div>`
      : '';
  return (
    `<div class="child-task is-${esc(task.status)}" data-task-id="${escAttr(task.taskId)}" role="button" tabindex="0">` +
    `<span class="child-task-state">${childStatusIcon(task.status)}</span>` +
    '<div class="child-task-main">' +
    `<div class="child-task-goal">${esc(truncate(task.goal || '（无目标描述）', 160))}</div>` +
    `<div class="child-task-meta">${meta.join('')}</div>` +
    tail +
    '</div>' +
    `<span class="child-task-chevron">${icon('chevronRight', { size: 14 })}</span>` +
    '</div>'
  );
}

export async function mount(root, ctx = {}) {
  root.innerHTML = chatLayout();
  let agentsPanel=null;
  const agentsCount=root.querySelector('#chat-agents-count');
  root.querySelector('#chat-agents-open')?.addEventListener('click',()=>{
    const section=(ctx.shellSidebar||root).querySelector('#sidebar-agents');
    if(section){
      if(section.hidden)section.hidden=false;
      section.scrollIntoView({behavior:'smooth',block:'nearest'});
      section.classList.add('agents-highlight');
      setTimeout(()=>section.classList.remove('agents-highlight'),900);
    }
    agentsPanel?.refresh();
  });
  const sidebarRoot=ctx.shellSidebar||root;
  if(ctx.shellSidebar){root.querySelector('.chat-sidebar')?.remove();root.querySelector('.chat-view').classList.add('has-shell-sidebar');}
  const sidebarController=new AbortController();
  const sidebarListen=(node,type,handler)=>node.addEventListener(type,handler,{signal:sidebarController.signal});
  const el = {
    view: root.querySelector('.chat-view'),
    sidebar: (ctx.shellSidebar||root.querySelector('.chat-sidebar')),
    convList: sidebarRoot.querySelector('#conv-list'),
    convFilter: sidebarRoot.querySelector('#conv-filter'),
    newBtn: sidebarRoot.querySelector('#new-conv'),
    splitter: root.querySelector('.chat-splitter'),
    drawerBtn: root.querySelector('#chat-drawer-toggle'),
    drawerScrim: root.querySelector('.chat-drawer-scrim'),
    title: root.querySelector('#chat-title'),
    subtitle: root.querySelector('#chat-subtitle'),
    agentSelect: root.querySelector('#agent-select'),
    resendBtn: root.querySelector('#resend-btn'),
    runsBtn: root.querySelector('#runs-btn'),
    statusPill: root.querySelector('#chat-status'),
    messages: root.querySelector('#messages'),
    scrollBottom: root.querySelector('#scroll-bottom'),
    input: root.querySelector('#chat-input'),
    sendBtn: root.querySelector('#send-btn'),
    stopBtn: root.querySelector('#stop-btn'),
    attachBtn: root.querySelector('#attach-btn'),
    attachInput: root.querySelector('#chat-file-input'),
    attachments: root.querySelector('#attach-list'),
    composer: root.querySelector('.composer'),
    dropHint: root.querySelector('.chat-drop-hint'),
    modelChip: root.querySelector('#chat-model-chip'),
    composerHint: root.querySelector('#composer-hint'),
    runPanel: root.querySelector('#chat-run-panel'),
    runPanelPhase: root.querySelector('#chat-run-phase'),
    runPanelTool: root.querySelector('#chat-run-tool'),
    runPanelElapsed: root.querySelector('#chat-run-elapsed'),
    runPanelStop: root.querySelector('#chat-run-stop'),
    runPanelDetail: root.querySelector('#chat-run-detail'),
    locator: root.querySelector('#chat-locator'),
    locatorInput: root.querySelector('#chat-locator-input'),
    locatorResults: root.querySelector('#chat-locator-results'),
    locatorButton: root.querySelector('#chat-locator-btn'),
  };

  const local = {
    conversations: [],
    activeId: null,
    messages: [],
    streaming: false,
    abort: null,
    live: null,
    filter: '',
    attachments: [],
    agents: [],
    agentId: getState().agentId || '',
    agentDefault: null,
    loadedOnce: false,
    llm: { configured: false, provider: '', model: '' },
    vision: { configured: false, enabled: false, model: '' },
    visionWarned: false,
    run: null,
    catalog: [],
    taskSelection: {},
    modelPickerDispose: null,
    runState: {
      status: '',
      phase: '',
      tool: '',
      startedAt: 0,
      runId: '',
      timer: 0,
    },
    locatorIndex: -1,
  };
  // The composer is stable and read-only until history/model initialization
  // finishes. Early input cannot race a second route mount or boot projection.
  el.input.disabled=true;
  el.sendBtn.disabled=true;

  /* ---------------------------------------------------------------- */
  /* Layout helpers                                                    */
  /* ---------------------------------------------------------------- */

  function applySidebarWidth(width) {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number(width) || SIDEBAR_DEFAULT));
    el.view.style.setProperty('--chat-sidebar-w', `${w}px`);
    if(ctx.shellSidebar)document.documentElement.style.setProperty('--sidebar-w',`${w}px`);
    return w;
  }
  applySidebarWidth(getPref('chatSidebarWidth', SIDEBAR_DEFAULT));
  el.view.classList.toggle('sidebar-collapsed',Boolean(getPref('chatSidebarCollapsed',false)));

  function openDrawer(open) {
    if(ctx.shellSidebar){ctx.toggleNav?.(open);return;}
    el.view.classList.toggle('drawer-open', Boolean(open));
  }

  function updateEmptyState() {
    const hasMessages = local.messages.length > 0 || local.live;
    if (!hasMessages) {
      const agent = findAgent(local.agentId);
      const prompts = Array.isArray(agent?.example_prompts) ? agent.example_prompts.slice(0, 4) : [];
      setHtmlNode(
        el.messages,
        '<div class="chat-empty">' +
          `<div class="chat-empty-mark">${brandMark(46, 'chat')}</div>` +
          '<div class="chat-empty-title">输入任务或问题</div>' +
          (prompts.length
            ? `<div class="prompt-chips">${prompts
                .map((p) => `<button type="button" class="prompt-chip">${esc(p)}</button>`)
                .join('')}</div>`
            : '') +
          '</div>',
      );
    }
  }

  function setHtmlNode(node, html) {
    node.innerHTML = html;
  }

  function findAgent(id) {
    return local.agents.find((a) => (a.id || a.name) === id) || null;
  }

  function agentLabel(id) {
    if (!id) return '默认智能体';
    if (id === 'lead') return leadAgentLabel();
    const a = findAgent(id);
    return a ? a.name || a.id : id;
  }

  function updateHeader() {
    const conv = local.conversations.find((c) => c.id === local.activeId) || null;
    el.title.textContent = conv?.title || '新对话';
    const parts = [];
    if (conv?.agent) parts.push(agentLabel(conv.agent));
    if (conv?.message_count != null) parts.push(`${conv.message_count} 条消息`);
    if (conv?.updated_at) parts.push(`更新于 ${relTime(conv.updated_at)}`);
    if (!parts.length) parts.push('选择或新建会话');
    el.subtitle.textContent = parts.join(' · ');
    el.resendBtn.disabled = local.streaming || !local.messages.some((m) => m.role === 'user');
  }

  function setStatus(text, kind = '') {
    if (!text) {
      el.statusPill.hidden = true;
      el.statusPill.textContent = '';
      el.statusPill.className = 'chat-status';
      return;
    }
    el.statusPill.hidden = false;
    el.statusPill.className = `chat-status ${kind}`.trim();
    el.statusPill.innerHTML = `<span class="status-dot"></span><span>${esc(text)}</span>`;
  }

  function formatRunElapsed(startedAt) {
    if (!startedAt) return '0 秒';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} 分 ${seconds % 60} 秒`;
  }

  function renderRunPanel() {
    if (!el.runPanel) return;
    const state = local.runState;
    const visible = Boolean(state.status);
    el.runPanel.hidden = !visible;
    if (!visible) {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = 0;
      }
      return;
    }
    el.runPanel.dataset.status = state.status;
    el.runPanelPhase.textContent = state.phase || runStatusLabel(state.status);
    el.runPanelTool.textContent = state.tool ? `正在${state.tool}` : '正在准备下一步';
    el.runPanelElapsed.textContent = formatRunElapsed(state.startedAt);
    el.runPanelDetail.disabled = !state.runId;
    if (!state.timer) {
      state.timer = window.setInterval(() => {
        if (el.runPanelElapsed) el.runPanelElapsed.textContent = formatRunElapsed(local.runState.startedAt);
      }, 1000);
    }
  }

  function beginRunState(status = 'preparing', runId = '') {
    local.runState.status = status;
    local.runState.phase = runStatusLabel(status);
    local.runState.tool = '';
    local.runState.startedAt = Date.now();
    local.runState.runId = runId || '';
    renderRunPanel();
  }

  function updateRunState(patch = {}) {
    const state = local.runState;
    if (patch.status !== undefined) state.status = patch.status;
    if (patch.phase !== undefined) state.phase = patch.phase;
    if (patch.tool !== undefined) state.tool = patch.tool;
    if (patch.runId !== undefined) state.runId = patch.runId;
    if (patch.startedAt !== undefined) state.startedAt = patch.startedAt;
    if (RUN_TERMINAL_STATUSES.has(state.status)) {
      state.status = '';
      state.phase = '';
      state.tool = '';
    }
    renderRunPanel();
  }

  /* ---------------------------------------------------------------- */
  /* Conversation list                                                 */
  /* ---------------------------------------------------------------- */

  function sortedConversations() {
    const timestamp = (conv) => {
      const raw = conv.updated_at ?? conv.created_at;
      const value = typeof raw === 'number'
        ? (raw < 1e12 ? raw * 1000 : raw)
        : Date.parse(raw || '') || 0;
      return Number.isFinite(value) ? value : 0;
    };
    return [...local.conversations].sort((a, b) => timestamp(b) - timestamp(a));
  }

  let conversationLimit=100,lastConversationHtml='';
  function renderConversationList() {
    const html = conversationListHtml(local.conversations,{
      query:local.filter,view:sidebarRoot.querySelector('#conv-view')?.value||'recent',
      workspaceOnly:sidebarRoot.querySelector('#conv-workspace-only')?.checked,activeId:local.activeId,limit:conversationLimit});
    if(html!==lastConversationHtml){el.convList.innerHTML=html;lastConversationHtml=html;}
  }

  async function loadConversations({ selectId = null } = {}) {
    try {
      const data = await api.conversations.list();
      local.conversations = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data) ? data : [];
      setState({ conversations: local.conversations });
      local.loadedOnce = true;
      renderConversationList();
      return true;
    } catch (err) {
      local.loadedOnce = true;
      el.convList.innerHTML =
        `<div class="conv-error">${esc(errorMessage(err))}<button type="button" class="btn btn-ghost btn-sm" id="conv-retry">重试</button></div>`;
      el.convList.querySelector('#conv-retry')?.addEventListener('click', () => {
        el.convList.innerHTML = spinnerHtml('加载会话');
        loadConversations({ selectId: local.activeId });
      });
      return false;
    }
  }

  let observerEpoch=0;
  function detachActiveView(){
    observerEpoch++;
    if(local.run){local.run.detached=true;clearWatchdog(local.run);local.run.ctrl.abort();}
    local.abort?.abort();local.run=null;pendingDraft=null;setStreaming(false);
    updateRunState({status:''});
    local.guidanceRunId=null;guidanceUI.clear();
  }
  async function createConversation() {
    if(local.creatingConversation)return null;
    local.creatingConversation=true;el.input.disabled=true;el.sendBtn.disabled=true;el.newBtn.disabled=true;root.querySelector('#chat-permission-mode').disabled=true;
    try {
      const payload = {};
      if(getState().workspaceId)payload.workspace_id=getState().workspaceId;
      if (local.agentId) payload.agent = local.agentId;
      const conv = await api.conversations.create(payload);
      const record = conv?.conversation || conv;
      if (!record || !record.id) throw new Error('后端未返回新会话');
      detachActiveView();
      local.conversations = [record, ...local.conversations.filter((c) => c.id !== record.id)];
      local.activeId = record.id;
      setPref('activeConversationId', record.id);
      applyTaskSelection(record);
      setState({ conversations: local.conversations, activeConversationId: record.id });
      renderConversationList();
      local.messages = [];
      updateEmptyState();
      updateHeader();
      setStatus('');
      return record;
    } catch (err) {
      toastError(`新建会话失败：${errorMessage(err)}`);
      return null;
    } finally {
      local.creatingConversation=false;el.input.disabled=false;el.sendBtn.disabled=local.streaming;el.newBtn.disabled=false;root.querySelector('#chat-permission-mode').disabled=false;
    }
  }

  async function selectConversation(id, { scroll = true } = {}) {
    if (!id) return;
    detachActiveView();
    local.activeId = id;
    setPref('activeConversationId', id);
    const loadEpoch=local.loadEpoch=(local.loadEpoch||0)+1;
    local.historyEnd=null;
    setState({ activeConversationId: id });
    openDrawer(false);
    renderConversationList();
    updateHeader();
    setHtmlNode(el.messages, `<div class="messages-loading">${spinnerHtml('加载会话')}</div>`);
    try {
      const raw = await api.conversations.get(id);
      if(local.loadEpoch!==loadEpoch||local.activeId!==id)return;
      const conv = raw?.conversation || raw;
      applyTaskSelection(conv);
      // Runs launched by the research workspace or another window have no
      // browser-local bookmark. Recover the authoritative run from the session.
      if(conv?.meta?.last_run_id)rememberActiveRun(id,{runId:conv.meta.last_run_id});
      const boundWorkspace=conv?.meta?.workspace_id;
      if(boundWorkspace && boundWorkspace!==getState().workspaceId){
        const data=await api.workspaces.get(boundWorkspace);
        if(local.loadEpoch!==loadEpoch||local.activeId!==id)return;
        const workspace=data.workspace||data;setWorkspace(workspace);
        const chip=root.querySelector('#chat-workspace');if(chip){chip.querySelector('span').textContent=workspace.name;chip.title=workspace.backend==='ssh'?`SSH · ${workspace.remote?.root||''}`:workspace.local_path;}
      }
      if (conv?.title || conv?.agent) {
        const idx = local.conversations.findIndex((c) => c.id === id);
        if (idx >= 0) {
          local.conversations[idx] = { ...local.conversations[idx], ...(conv.id ? conv : {}) };
          renderConversationList();
        }
      }
      local.messages = Array.isArray(conv?.messages) ? conv.messages : Array.isArray(raw?.messages) ? raw.messages : [];
      void fileChanges.refresh();
      local.lastChildren = [];
      renderMessages();
      updateHeader();
      if (scroll) scrollToBottom(true);
    } catch (err) {
      if(local.loadEpoch!==loadEpoch||local.activeId!==id)return;
      el.messages.innerHTML = '';
      el.messages.appendChild(
        h(
          `<div class="messages-error"><div class="error-card"><div class="error-card-title">无法加载会话</div><div class="error-card-msg">${esc(errorMessage(err))}</div></div></div>`,
        ),
      );
    }
    // Pick up a run that outlived a previous page/route (T03 resumable subscription).
    if (!local.streaming) await resumeRunIfAny();
    if (!local.streaming) await restoreChildren();
  }

  async function renameConversation(id) {
    const conv = local.conversations.find((c) => c.id === id);
    if (!conv) return;
    const title = await promptDialog({
      title: '重命名会话',
      value: conv.title || '',
      placeholder: '会话标题',
      confirmText: '保存',
    });
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) {
      toastWarn('标题不能为空');
      return;
    }
    try {
      const updated = await api.conversations.update(id, { title: trimmed });
      const patch = updated?.conversation || updated || { title: trimmed };
      Object.assign(conv, patch);
      renderConversationList();
      if (id === local.activeId) updateHeader();
      toastSuccess('已重命名');
    } catch (err) {
      toastError(`重命名失败：${errorMessage(err)}`);
    }
  }

  async function deleteConversation(id) {
    const conv = local.conversations.find((c) => c.id === id);
    const ok = await confirmDialog({
      title: '删除会话',
      message: `确定删除「${conv?.title || '未命名会话'}」吗？该操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    if (local.streaming && id === local.activeId) await stopStreaming();
    try {
      await api.conversations.remove(id);
      local.conversations = local.conversations.filter((c) => c.id !== id);
      setState({ conversations: local.conversations });
      if (local.activeId === id) {
        local.activeId = null;
        removePref('activeConversationId');
        local.messages = [];
        setState({ activeConversationId: null });
        renderMessages();
        updateEmptyState();
        updateHeader();
        const next = sortedConversations()[0];
        if (next) await selectConversation(next.id);
      }
      renderConversationList();
      toastSuccess('会话已删除');
    } catch (err) {
      toastError(`删除失败：${errorMessage(err)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: history                                                */
  /* ---------------------------------------------------------------- */

  function renderMessages() {
    el.messages.innerHTML = '';
    if (!local.messages.length) {
      updateEmptyState();
      return;
    }
    const toolResults = new Map();
    for (const msg of local.messages) {
      if (msg?.role === 'tool' && msg.tool_call_id) toolResults.set(msg.tool_call_id, msg);
    }
    const end=local.historyEnd===null||local.historyEnd===undefined?local.messages.length:Math.min(local.historyEnd,local.messages.length);
    const start=Math.max(0,end-80);
    if(start>0){const older=h(`<button type="button" class="btn btn-ghost">查看更早消息（${start}）</button>`);older.addEventListener('click',()=>{local.historyEnd=Math.max(80,end-60);renderMessages();el.messages.scrollTop=0;});el.messages.appendChild(older);}
    for (let messageIndex=start;messageIndex<end;messageIndex+=1) {
      const msg=local.messages[messageIndex];
      if (msg?.role === 'tool') continue; // rendered together with its assistant tool card
        if(!msg?.content?.trim()&&!msg?.tool_calls?.length&&!msg?.figures?.length)continue;
      const node=renderMessage(msg, toolResults);
      node.dataset.messageIndex=String(messageIndex);
      node.dataset.messageRole=msg?.role||'assistant';
      if(String(msg?.content||'').trim())node.dataset.messageText=String(msg.content).slice(0,1200);
      el.messages.appendChild(node);
    }
    if(end<local.messages.length){const newer=h('<button type="button" class="btn btn-ghost">查看更新消息</button>');newer.addEventListener('click',()=>{local.historyEnd=end+60>=local.messages.length?null:end+60;renderMessages();});el.messages.appendChild(newer);}
    renderFinishedChildren();
    local.live = null;
    scrollToBottom(true);
  }

  function roleLabel(role) {
    return { user: '你', assistant: '助手', system: '系统', error: '错误' }[role] || role;
  }

  function renderMessage(msg, toolResults) {
    const role = msg?.role || 'assistant';
    const ts = msg?.ts;
    const time = ts ? `<span class="msg-time" title="${esc(new Date(Number(ts) * (Number(ts) < 1e12 ? 1000 : 1)).toLocaleString('zh-CN'))}">${esc(fmtClock(ts))}</span>` : '';

    if (role === 'user') {
      const node = h(
        `<div class="msg msg-user"><div class="msg-col"><div class="msg-bubble">${renderMarkdown(msg.content || '')}</div><div class="msg-meta">${time}<span class="msg-role">${roleLabel(role)}</span></div></div></div>`,
      );
      bindMessageContent(node);
      return node;
    }

    if (role === 'system') {
      return h(`<div class="msg msg-system"><div class="msg-system-line">${icon('info', { size: 14 })}<span>${esc(truncate(msg.content || '', 2000))}</span></div></div>`);
    }

    if (role === 'error') {
      return h(
        `<div class="msg msg-error"><div class="error-card"><div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 16 })}</span><div class="error-card-title">出错了</div></div><div class="error-card-msg">${esc(msg.content || '未知错误')}</div></div></div>`,
      );
    }

    // assistant (default)
    const contentHtml = msg.content ? `<div class="msg-text md">${renderMarkdown(msg.content)}</div>` : '';
    const savedSteps=Array.isArray(msg?.meta?.tool_steps)?msg.meta.tool_steps:[];
    const toolsHtml = (Array.isArray(msg.tool_calls)&&msg.tool_calls.length ? msg.tool_calls : savedSteps)
      .map((call) => {
        const result = toolResults.get(call.id) || null;
        return toolCardHtml(
          { id: call.id, name: call.name, arguments: call.arguments ?? call.args, agent: call.agent, category: call.category },
          call.result || (result
            ? { ok: result?.meta?.ok, preview: result.content, duration_ms: result?.meta?.duration_ms }
            : null),
        );
      })
      .join('');
    const figures = Array.isArray(msg.figures) ? msg.figures : [];
    const figuresHtml = figures.map((f) => figureHtml(f)).join('');
    const usage = msg?.meta?.usage;
    const usageHtml = usage
      ? `<div class="msg-usage">${usageLine(usage)}</div>`
      : '';
    const node = h(
      '<div class="msg msg-assistant">' +
        `<div class="msg-avatar">${getPref('agentAvatar','') ? esc(getPref('agentAvatar','')) : brandMark(26, `a-${esc(msg.id || uid('m'))}`)}</div>` +
        '<div class="msg-col">' +
        '<div class="eve-live-progress" hidden aria-live="polite"></div>' +
        (toolsHtml ? toolGroupHtml(toolsHtml) : '') +
        `<div class="msg-bubble">${contentHtml}${figuresHtml}</div>` +
        usageHtml +
        `<div class="msg-meta">${time}<span class="msg-role">${roleLabel(role)}</span></div>` +
        '</div></div>',
    );
    bindMessageContent(node);
    if(msg?.meta?.run_id){const meta=node.querySelector('.msg-meta');const link=document.createElement('button');link.type='button';link.className='link-btn run-detail-link';link.dataset.runId=msg.meta.run_id;link.innerHTML=`${icon('history',{size:13})}<span>查看运行详情</span>`;meta.appendChild(link);}
    updateToolGroup(node.querySelector('.tool-run'));
    return node;
  }

  function locatorEntries() {
    return local.messages
      .map((message, index) => ({
        index,
        role: message?.role || 'assistant',
        text: String(message?.content || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter(entry => entry.text && entry.role !== 'tool');
  }

  function closeLocator() {
    if (!el.locator) return;
    el.locator.hidden = true;
    el.locatorButton?.setAttribute('aria-expanded', 'false');
    local.locatorIndex = -1;
  }

  function jumpToMessage(index) {
    const targetIndex = Number(index);
    if (!Number.isSafeInteger(targetIndex) || targetIndex < 0) return;
    local.historyEnd = targetIndex >= local.messages.length ? null : Math.max(80, targetIndex + 21);
    renderMessages();
    requestAnimationFrame(() => {
      const node = el.messages.querySelector(`[data-message-index="${targetIndex}"]`);
      if (!node) {
        toastWarn('这条消息暂时无法定位');
        return;
      }
      node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      node.classList.remove('is-located');
      void node.offsetWidth;
      node.classList.add('is-located');
      window.setTimeout(() => node.classList.remove('is-located'), 1600);
    });
    closeLocator();
  }

  function renderLocator(query = '') {
    if (!el.locatorResults) return;
    const needle = query.trim().toLowerCase();
    const entries = locatorEntries()
      .filter(entry => !needle || entry.text.toLowerCase().includes(needle))
      .slice(-100)
      .reverse();
    if (!entries.length) {
      el.locatorResults.innerHTML = `<div class="chat-locator-empty">${needle ? '没有匹配的消息' : '当前会话还没有可定位的消息'}</div>`;
      local.locatorIndex = -1;
      return;
    }
    if (local.locatorIndex < 0 || local.locatorIndex >= entries.length) local.locatorIndex = 0;
    el.locatorResults.innerHTML = entries.map((entry, position) => {
      const role = entry.role === 'user' ? '你' : entry.role === 'error' ? '错误' : 'Eve';
      const text = entry.text.length > 110 ? `${entry.text.slice(0, 110)}…` : entry.text;
      return `<button type="button" class="chat-locator-item${position === local.locatorIndex ? ' is-active' : ''}" data-message-index="${entry.index}" data-locator-position="${position}">` +
        `<span class="chat-locator-role">${role}</span><span class="chat-locator-text">${esc(text)}</span></button>`;
    }).join('');
    el.locatorResults.dataset.count = String(entries.length);
  }

  function openLocator() {
    if (!el.locator) return;
    el.locator.hidden = false;
    el.locatorButton?.setAttribute('aria-expanded', 'true');
    local.locatorIndex = 0;
    renderLocator(el.locatorInput?.value || '');
    requestAnimationFrame(() => {
      el.locatorInput?.focus();
      el.locatorInput?.select();
    });
  }

  function moveLocator(delta) {
    const count = Number(el.locatorResults?.dataset.count) || 0;
    if (!count) return;
    local.locatorIndex = (local.locatorIndex + delta + count) % count;
    el.locatorResults.querySelectorAll('.chat-locator-item').forEach((item, index) => item.classList.toggle('is-active', index === local.locatorIndex));
    el.locatorResults.querySelector('.chat-locator-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function toolGroupHtml(content='') {
    return `<details class="tool-run"${content?'':' hidden'}><summary class="tool-run-summary"><span class="tool-run-state"></span><span class="tool-run-label">执行步骤</span><span class="tool-run-count"></span>${icon('chevronDown',{size:13})}</summary><div class="msg-tools">${content}</div></details>`;
  }
  function updateToolGroup(group){
    if(!group)return;
    const cards=[...group.querySelectorAll('.tool-card')],running=cards.filter(x=>x.classList.contains('is-running')),failed=cards.filter(x=>x.classList.contains('is-fail'));
    group.hidden=!cards.length;
    group.querySelector('.tool-run-state').innerHTML=running.length?'<span class="spinner"></span>':icon(failed.length?'alert':'check',{size:13});
    const last=running.at(-1);
    group.querySelector('.tool-run-label').textContent=last?`正在${last.dataset.label||'执行'}`:failed.length?'执行记录 · 含失败步骤':'执行记录';
    group.querySelector('.tool-run-count').textContent=`${cards.length} 项${failed.length?` · ${failed.length} 失败`:''}`;
  }

  function usageLine(usage) {
    const bits = [];
    if (usage.prompt_tokens != null) bits.push(`输入 ${usage.prompt_tokens}`);
    if (usage.completion_tokens != null) bits.push(`输出 ${usage.completion_tokens}`);
    if (usage.total_tokens != null) bits.push(`合计 ${usage.total_tokens}`);
    if (usage.model) bits.push(usage.model);
    return `${icon('cpu', { size: 12 })}<span>${esc(bits.join(' · '))}</span>`;
  }

  function figureHtml(fig, opts = {}) {
    const src = api.figures.url(fig);
    const title = fig?.title || fig?.name || '图表';
    return (
      `<figure class="chat-figure${opts.compact ? ' compact' : ''}">` +
      `<img src="${esc(src)}" alt="${esc(title)}" loading="lazy" data-src="${esc(src)}" data-title="${esc(title)}" />` +
      `<figcaption>${icon('image', { size: 13 })}<span>${esc(title)}</span></figcaption>` +
      '</figure>'
    );
  }

  function bindMessageContent(node) {
    const workspaceId=local.conversations.find(c=>c.id===local.activeId)?.meta?.workspace_id||getState().workspaceId;
    node.querySelectorAll('.artifact-card').forEach(button=>{
      if(button.dataset.bound)return;button.dataset.bound='true';
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try{await openHtmlArtifact(workspaceId,button.dataset.artifactPath,button.querySelector('strong')?.textContent||'交互页面');}
        catch(error){toastError(errorMessage(error));}
        finally{button.disabled=false;}
      });
    });
    node.querySelectorAll('.chat-figure img').forEach((img) => {
      img.addEventListener('click', () => {
        openLightbox({
          src: img.getAttribute('data-src') || img.src,
          title: img.getAttribute('data-title') || '',
          downloadUrl: img.getAttribute('data-src') || img.src,
        });
      });
    });
  }

  function toolDisplayName(name) {
    const names={web_search:'搜索网页',web_fetch:'读取网页',database_search:'检索文献',read_file:'读取文件',list_directory:'查看目录',search_files:'搜索文件',write_file:'保存文件',skill_search:'查找技能',skill_load:'加载技能',skill_read_resource:'读取技能参考',skill_prepare:'准备工具环境',skill_run:'运行技能',skill_create:'创建技能',skill_install:'安装技能',workspace_info:'查看工作目录',mcp_tools:'发现 MCP 工具',mcp_call:'调用 MCP 工具'};
    return names[name]||name||'执行工具';
  }
  function toolCardHtml(call, result) {
    const label=toolDisplayName(call.name);
    const ok = result ? result.ok !== false : null;
    const stateClass = result ? (ok ? 'is-ok' : 'is-fail') : 'is-running';
    const stateIcon = result
      ? ok
        ? icon('checkCircle', { size: 15 })
        : icon('xCircle', { size: 15 })
      : '<span class="spinner"></span>';
    const argsText = prettyArgs(call.arguments);
    const preview = result ? String(result.preview ?? '') : '';
    const duration = result && result.duration_ms != null ? fmtDuration(result.duration_ms) : '';
    const argDetails =
      argsText && argsText !== '{}'
        ? `<details class="tool-args"><summary>参数</summary><pre>${esc(argsText)}</pre></details>`
        : '';
    const resultBlock = result
      ? `<div class="tool-result-label">${ok ? '结果' : '错误'}</div>${preview ? `<pre class="tool-result">${esc(truncate(preview, 4000))}</pre>` : '<div class="tool-result-empty">无输出</div>'}`
      : '';
    return (
      `<div class="tool-card ${stateClass}" data-label="${esc(label)}" data-tool-id="${esc(call.id || '')}">` +
      `<button type="button" class="tool-head" aria-expanded="false">` +
      `<span class="tool-state">${stateIcon}</span>` +
      `<span class="tool-name">${esc(label)}</span>` +
      (call.agent ? `<span class="tool-agent">${esc(call.agent)}</span>` : '') +
      (call.category ? `<span class="tool-cat">${esc(call.category)}</span>` : '') +
      (duration ? `<span class="tool-dur">${esc(duration)}</span>` : '') +
      `<span class="tool-chevron">${icon('chevronDown', { size: 14 })}</span>` +
      '</button>' +
      `<div class="tool-body">${argDetails}${resultBlock}</div>` +
      '</div>'
    );
  }

  function prettyArgs(args) {
    if (args == null) return '';
    if (typeof args === 'string') {
      try {
        return JSON.stringify(JSON.parse(args), null, 2);
      } catch {
        return args;
      }
    }
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: live streaming bubble                                  */
  /* ---------------------------------------------------------------- */

  function createLiveBubble() {
    el.messages.querySelector('.chat-empty')?.remove();
    const node = h(
      '<div class="msg msg-assistant msg-live">' +
        `<div class="msg-avatar">${getPref('agentAvatar','') ? esc(getPref('agentAvatar','')) : brandMark(26, 'live')}</div>` +
        '<div class="msg-col">' +
        '<div class="eve-live-progress" hidden aria-live="polite"></div>' +
        '<details class="reasoning-block" hidden><summary>' +
        `<span class="reasoning-label">${icon('brain', { size: 13 })}<span>推理过程</span></span>` +
        `<span class="reasoning-count"></span>${icon('chevronDown', { size: 13, cls: 'reasoning-chev' })}</summary>` +
        '<div class="reasoning-body md"></div></details>' +
        toolGroupHtml() +
        '<div class="msg-children" hidden>' +
        '<div class="msg-children-head">' +
        `${icon('layers', { size: 13 })}<span>子任务</span><span class="msg-children-count"></span>` +
        '</div>' +
        '<div class="msg-children-list"></div>' +
        '</div>' +
        '<div class="msg-bubble"><div class="msg-text md"></div></div>' +
        '<div class="msg-usage" hidden></div>' +
        '<div class="msg-meta"><span class="msg-live-label">正在生成…</span></div>' +
        '</div></div>',
    );
    el.messages.appendChild(node);
    if (!el.messages.querySelector('.messages-inner')) {
      // messages container is the scroller; keep children direct
    }
    const refs = {
      root: node,
      reasoning: node.querySelector('.reasoning-block'),
      reasoningBody: node.querySelector('.reasoning-body'),
      reasoningCount: node.querySelector('.reasoning-count'),
      tools: node.querySelector('.msg-tools'),
      toolGroup: node.querySelector('.tool-run'),
      children: node.querySelector('.msg-children'),
      childrenList: node.querySelector('.msg-children-list'),
      childrenCount: node.querySelector('.msg-children-count'),
      bubble: node.querySelector('.msg-bubble'),
      text: node.querySelector('.msg-text'),
      usage: node.querySelector('.msg-usage'),
      meta: node.querySelector('.msg-meta'),
    };

    const state = {
      text: '',
      reasoning: '',
      pendingRender: false,
      startedAt: Date.now(),
      tools: 0,
      figures: 0,
      children: new Map(),
    };

    const renderChildren = () => {
      const tasks = [...state.children.values()];
      refs.children.hidden = tasks.length === 0;
      if (!tasks.length) {
        refs.childrenList.innerHTML = '';
        refs.childrenCount.textContent = '';
        return;
      }
      const running = tasks.filter((t) => !t.done).length;
      refs.childrenCount.textContent = running ? `${tasks.length} 个 · ${running} 进行中` : `${tasks.length} 个`;
      refs.childrenList.innerHTML = tasks.map((t) => childTaskHtml(t)).join('');
    };

    const scheduleTextRender = () => {
      if (state.pendingRender) return;
      state.pendingRender = true;
      requestAnimationFrame(() => {
        state.pendingRender = false;
        const follow=isNearBottom();
        refs.text.innerHTML = renderMarkdown(state.text) + (state.done ? '' : '<span class="stream-cursor"></span>');
        bindMessageContent(refs.text);
        if(follow)scrollToBottom(true);
      });
    };

    const autoScroll = () => {
      if (isNearBottom()) scrollToBottom(false);
    };

    const live = {
      state,
      appendText(delta) {
        if (!delta) return;
        state.text += delta;
        scheduleTextRender();
      },
      replaceText(text) {
        state.text=String(text||'');
        scheduleTextRender();
      },
      addProgress(text) {
        if(!text)return;
        const host=node.querySelector('.eve-live-progress');
        if(!host||host.lastChild?.textContent===text)return;
        host.hidden=false;const line=document.createElement('p');line.textContent=String(text).slice(0,1600);host.append(line);
        while(host.children.length>6)host.firstChild.remove();
        autoScroll();
      },
      appendReasoning(delta) {
        if (!delta) return;
        state.reasoning += delta;
        refs.reasoning.hidden = false;
        refs.reasoningBody.innerHTML = renderMarkdown(state.reasoning);
        refs.reasoningCount.textContent = `${state.reasoning.length} 字`;
      },
      addToolCall(data) {
        const existing=refs.tools.querySelector(`[data-tool-id="${cssEscape(data.id||'')}"]`);
        if(existing)return existing;
        state.tools += 1;
        const frag = h(toolCardHtml({ id: data.id, name: data.name, arguments: data.arguments, agent: data.agent, category: data.category }, null));
        refs.tools.appendChild(frag);
        updateToolGroup(refs.toolGroup);
        autoScroll();
        return frag;
      },
      applyToolResult(data) {
        const card = refs.tools.querySelector(`[data-tool-id="${cssEscape(data.id || '')}"]`);
        if (!card) return;
        const ok = data.ok !== false;
        card.classList.remove('is-running','is-ok','is-fail');
        card.classList.add(ok ? 'is-ok' : 'is-fail');
        const stateEl = card.querySelector('.tool-state');
        if (stateEl) {
          stateEl.innerHTML = ok ? icon('checkCircle', { size: 15 }) : icon('xCircle', { size: 15 });
        }
        const dur = card.querySelector('.tool-dur');
        if (dur && data.duration_ms != null) dur.textContent = fmtDuration(data.duration_ms);
        else if (data.duration_ms != null) {
          card.querySelector('.tool-head')?.appendChild(h(`<span class="tool-dur">${esc(fmtDuration(data.duration_ms))}</span>`));
        }
        const body = card.querySelector('.tool-body');
        if (body) {
          const preview = typeof data.preview === 'string' ? data.preview : previewOf(data.data);
          body.querySelector('.tool-result-entry')?.remove();
          const entry=h('<div class="tool-result-entry"></div>');
          entry.innerHTML =
            `<div class="tool-result-label">${ok ? '结果' : '错误'}</div>` +
            (preview ? `<pre class="tool-result">${esc(truncate(preview, 4000))}</pre>` : '<div class="tool-result-empty">无输出</div>');
          body.appendChild(entry);
        }
        updateToolGroup(refs.toolGroup);
        autoScroll();
      },
      addFigure(fig) {
        state.figures += 1;
        const tmp = h(figureHtml(fig));
        bindMessageContent(tmp);
        refs.bubble.appendChild(tmp);
        autoScroll();
      },
      addApproval(data) {
        if(node.querySelector(`.approval-card[data-approval-id="${cssEscape(data.id || '')}"]`))return;
        let group=node.querySelector('.approval-run');
        if(!group){group=h('<details class="approval-run" open><summary>待审批操作</summary><div class="approval-run-items"></div></details>');refs.bubble.appendChild(group);}
        const card = h(approvalCardHtml(data));
        bindApprovalCard(card, data);
        group.querySelector('.approval-run-items').appendChild(card);
        group.open=true;
        updateApprovalGroup(group);
        autoScroll();
      },
      upsertChild(raw) {
        const task = normalizeChildTask(raw);
        if (!task) return;
        const prev = state.children.get(task.taskId);
        if (prev) {
          // Start/terminal frames carry different fields; keep the richer values.
          task.goal = task.goal || prev.goal;
          task.runId = task.runId || prev.runId;
          task.traceId = task.traceId || prev.traceId;
          task.parentRunId = task.parentRunId || prev.parentRunId;
          task.agentId = task.agentId || prev.agentId;
          task.depth = task.depth || prev.depth;
          task.createdAt = task.createdAt || prev.createdAt;
          task.resultText = task.resultText || prev.resultText;
          task.usage = task.usage || prev.usage;
        }
        state.children.set(task.taskId, task);
        renderChildren();
        autoScroll();
      },
      setChildren(list) {
        state.children.clear();
        for (const task of normalizeChildList(list)) state.children.set(task.taskId, task);
        renderChildren();
        autoScroll();
      },
      childrenCount() {
        return state.children.size;
      },
      setUsage(usage) {
        refs.usage.hidden = false;
        refs.usage.innerHTML = usageLine(usage);
      },
      setError(err, detail) {
        const errNode = h(
          `<div class="live-error"><div class="error-card"><div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 16 })}</span><div class="error-card-title">${esc(err)}</div></div>` +
            (detail ? `<details class="error-card-detail"><summary>详情</summary><pre>${esc(detail)}</pre></details>` : '') +
            '</div></div>',
        );
        refs.bubble.appendChild(errNode);
      },
      setStatus(text) {
        const label = node.querySelector('.msg-live-label');
        if (label) label.textContent = text || '正在生成…';
      },
      setMeta(text) {
        refs.meta.innerHTML = `<span class="msg-role">${esc(text)}</span>`;
      },
      /** Attach a "run detail" entry point to the finished bubble (T04). */
      setRun(runId, traceId) {
        if (!runId) return;
        state.run = { runId, traceId: traceId || '' };
        refs.meta.innerHTML =
          '<span class="msg-role">运行记录</span>' +
          `<button type="button" class="link-btn run-detail-link" data-run-id="${escAttr(runId)}" data-trace-id="${escAttr(
            traceId || '',
          )}">${icon('history', { size: 13 })}<span>查看运行详情</span></button>`;
      },
      runRef() {
        return state.run || null;
      },
      finish(label = '') {
        state.done = true;
        scheduleTextRender();
        if (!state.text && !state.tools && !state.figures) {
          refs.text.innerHTML = '<p class="md-p muted">未收到有效回答，任务尚未验证完成。</p>';
        }
        const labelEl = node.querySelector('.msg-live-label');
        if (labelEl) {
          const dur = fmtDuration(Date.now() - state.startedAt);
          labelEl.textContent = label || `完成 · 用时 ${dur}`;
        }
        node.classList.remove('msg-live');
        setStatus('');
      },
    };
    if (local.lastChildren?.length) live.setChildren(local.lastChildren);
    return live;
  }

  function previewOf(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\\]\[]/g, '\\$&');
  }

  function approvalCardHtml(data) {
    const args = prettyArgs(data.arguments);
    const target = data.target && typeof data.target === 'object' ? data.target : {};
    const targetBits = [];
    const targetKind = cleanValue(target.kind, 40);
    const targetConnection = cleanValue(target.connection_id, 80);
    const targetCwd = cleanValue(target.cwd);
    const targetRoot = cleanValue(target.root);
    if (targetKind) targetBits.push(targetKind === 'ssh' ? 'SSH 主机' : '本机');
    if (targetConnection) targetBits.push(`连接 ${targetConnection}`);
    if (targetCwd) targetBits.push(`目录 ${targetCwd}`);
    else if (targetRoot) targetBits.push(`根目录 ${targetRoot}`);
    const scope = [];
    if (data.run_id) scope.push(`运行 ${data.run_id}`);
    if (data.agent_task_id) scope.push(`子任务 ${data.agent_task_id}`);
    if (data.child_run_id) scope.push(`子运行 ${data.child_run_id}`);
    const countdown = data.expires_at ? fmtCountdown(data.expires_at) : '';
    return (
      `<div class="approval-card" data-approval-id="${escAttr(data.id || '')}">` +
      `<div class="approval-head">${icon('shield', { size: 16 })}<span>需要你的批准</span>` +
      `<span class="approval-tool">${esc(data.tool || '工具')}</span>` +
      (countdown
        ? `<span class="approval-countdown" data-expires="${escAttr(data.expires_at)}" title="过期时间">${esc(countdown)}</span>`
        : '') +
      '</div>' +
      (data.reason ? `<div class="approval-reason">${esc(data.reason)}</div>` : '') +
      (targetBits.length
        ? `<div class="approval-target">${icon('terminal', { size: 13 })}<span>${esc(targetBits.join(' · '))}</span></div>`
        : '') +
      (scope.length ? `<div class="approval-scope">${esc(scope.join(' · '))}</div>` : '') +
      (args && args !== '{}' ? `<details class="approval-args"><summary>查看参数</summary><pre>${esc(args)}</pre></details>` : '') +
      '<div class="approval-actions">' +
      `<button type="button" class="btn btn-primary btn-sm approve-btn">${icon('check', { size: 14 })}<span>批准</span></button>` +
      `<button type="button" class="btn btn-danger btn-sm deny-btn">${icon('close', { size: 14 })}<span>拒绝</span></button>` +
      '</div></div>'
    );
  }

  /** Format an ISO expiry timestamp as mm:ss remaining (empty when unparsable). */
  function fmtCountdown(expiresAt) {
    const ts = Date.parse(expiresAt);
    if (!Number.isFinite(ts)) return '';
    const left = Math.max(0, ts - Date.now());
    const total = Math.ceil(left / 1000);
    if (total <= 0) return '已超时';
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** Paint the approval card as resolved (used by local click and approval_resolved frames). */
  function updateApprovalGroup(group){
    if(!group)return;
    const all=group.querySelectorAll('.approval-card').length;
    const waiting=group.querySelectorAll('.approval-card:not(.is-approved):not(.is-denied)').length;
    group.querySelector('summary').textContent=waiting?`待审批操作 · ${waiting} 项待处理`:`审批记录 · ${all} 项已处理`;
    if(!waiting)group.open=false;
  }
  function resolveApprovalCard(approvalId, decision) {
    if (!approvalId) return;
    const cards = [...document.querySelectorAll(`.approval-card[data-approval-id="${cssEscape(approvalId)}"]`)];
    for (const card of cards) {
      const actions = card.querySelector('.approval-actions');
      if (actions) {
        const approved = decision !== 'deny';
        actions.innerHTML = `<span class="approval-result ${approved ? 'ok' : 'deny'}">${
          approved ? icon('checkCircle', { size: 14 }) + ' 已批准' : icon('xCircle', { size: 14 }) + ' 已拒绝'
        }</span>`;
      }
      card.classList.add(decision === 'deny' ? 'is-denied' : 'is-approved');
      updateApprovalGroup(card.closest('.approval-run'));
      card.querySelectorAll('button').forEach((btn) => {
        btn.disabled = true;
      });
    }
  }

  function bindApprovalCard(card, data) {
    const decide = async (decision) => {
      const buttons = card.querySelectorAll('.approval-actions button');
      buttons.forEach((b) => {
        b.disabled = true;
      });
      try {
        try {
          await api.approvals.decide(data.id, decision);
        } catch (err) {
          // Older backend only exposes POST /api/approvals/{id}: retry only for a
          // genuinely missing newer route, never for a real decision failure.
          if (!isEndpointMissing(err)) throw err;
          await api.chat.approval(data.id, decision);
        }
        resolveApprovalCard(data.id, decision);
        emit('approval:resolved', { id: data.id, decision });
      } catch (err) {
        buttons.forEach((b) => {
          b.disabled = false;
        });
        toastError(`提交审批失败：${errorMessage(err)}`);
      }
    };
    card.querySelector('.approve-btn')?.addEventListener('click', () => decide('approve'));
    card.querySelector('.deny-btn')?.addEventListener('click', () => decide('deny'));
  }

  /* ---------------------------------------------------------------- */
  /* Child tasks: reconciliation, detail modal, continuation (M2)      */
  /* ---------------------------------------------------------------- */

  /** Reconcile the live bubble's child tasks with the backend task table. */
  async function refreshChildren(runId) {
    if (!runId) return;
    try {
      const data = await api.runtime.children(runId);
      const list = normalizeChildList(data);
      if (!list.length) return;
      local.lastChildren = list;
      local.childDirty = false;
      if (local.live) local.live.setChildren(list);
      else renderFinishedChildren();
    } catch {
      /* Older backend without the endpoint: SSE child_run frames remain authoritative. */
    }
  }

  /**
   * Paint the latest child-task list under the last finished assistant bubble.
   * The live bubble is replaced by history rendering after a turn, so the task
   * cards have to live on the persisted message node as well (T02 task tree).
   */
  function renderFinishedChildren() {
    const list = normalizeChildList(local.lastChildren);
    const nodes = el.messages.querySelectorAll('.msg.msg-assistant');
    const last = nodes.length ? nodes[nodes.length - 1] : null;
    if (!last) return;
    const col = last.querySelector('.msg-col');
    if (!col) return;
    col.querySelector('.msg-children')?.remove();
    if (!list.length) return;
    const running = list.filter((task) => !task.done).length;
    const count = running ? `${list.length} 个 · ${running} 进行中` : `${list.length} 个`;
    const block = h(
      '<div class="msg-children">' +
        `<div class="msg-children-head">${icon('layers', { size: 14 })}<span>子任务</span>` +
        `<span class="msg-children-count">${esc(count)}</span></div>` +
        `<div class="msg-children-list">${list.map((task) => childTaskHtml(task)).join('')}</div>` +
        '</div>',
    );
    col.insertBefore(block, col.querySelector('.msg-usage') || col.querySelector('.msg-meta'));
  }

  /** Recover child tasks for the most recent run after a page reload / route switch. */
  async function restoreChildren() {
    if (local.lastChildren?.length || local.streaming || !local.activeId) return;
    try {
      const data = await api.runtime.sessionRuns(local.activeId, 5);
      const runs = Array.isArray(data?.runs) ? data.runs : [];
      const lastRun = runs[0];
      if (!lastRun || !lastRun.run_id) return;
      await refreshChildren(lastRun.run_id);
    } catch {
      /* Older backend without the endpoint: nothing to recover. */
    }
  }

  function taskFieldHtml(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return (
      '<div class="task-field">' +
      `<span class="task-field-label">${esc(label)}</span>` +
      `<span class="task-field-value">${esc(String(value))}</span>` +
      '</div>'
    );
  }

  function taskDetailHtml(task, runs, error) {
    const statusCls = task.done ? 'is-done' : 'is-active';
    const ids = [
      taskFieldHtml('任务 ID', task.taskId),
      taskFieldHtml('子运行', task.runId),
      taskFieldHtml('父运行', task.parentRunId),
      taskFieldHtml('追踪 ID', task.traceId),
      taskFieldHtml('智能体', task.agentId),
      taskFieldHtml('深度', task.depth || ''),
      taskFieldHtml('结束原因', task.finishReason),
      taskFieldHtml('创建时间', task.createdAt ? fmtClock(task.createdAt) : ''),
      taskFieldHtml('结束时间', task.endedAt ? fmtClock(task.endedAt) : ''),
    ].join('');
    const budget = task.budget
      ? Object.entries(task.budget)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => taskFieldHtml(k, v))
          .join('')
      : '';
    const usage = task.usage
      ? Object.entries(task.usage)
          .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
          .map(([k, v]) => taskFieldHtml(k, v))
          .join('')
      : '';
    const runsHtml = runs.length
      ? '<div class="task-runs"><div class="task-section-title">关联运行</div>' +
        runs
          .map(
            (run) =>
              `<div class="task-run"><span class="task-run-status">${esc(runStatusLabel(run.status || ''))}</span>` +
              `<span class="task-run-id">${esc(run.run_id || '')}</span>` +
              `<span class="task-run-time">${esc(run.created_at ? fmtClock(run.created_at) : '')}</span></div>`,
          )
          .join('') +
        '</div>'
      : '';
    const errorHtml =
      task.error || error
        ? `<div class="task-error-block">${icon('alert', { size: 15 })}<div><div class="task-error-title">${
            error && !task.error ? '加载失败' : '子任务错误'
          }</div><div class="task-error-msg">${esc(
            (task.error && (task.error.message || task.error.code)) || (error ? errorMessage(error) : '未知错误'),
          )}</div></div></div>`
        : '';
    return (
      '<div class="task-detail">' +
      `<div class="task-detail-head"><span class="task-detail-title">${esc(truncate(task.goal || '（无目标描述）', 300))}</span>` +
      `<span class="child-task-status ${statusCls}">${childStatusIcon(task.status)}${esc(childStatusLabel(task.status))}</span></div>` +
      (task.depth ? `<div class="task-detail-sub">深度 ${task.depth}${task.durationMs != null ? ` · 用时 ${esc(fmtDuration(task.durationMs))}` : ''}</div>` : '') +
      (error && !task.taskId ? `<div class="panel-error">${errorMessage(error)}</div>` : '') +
      errorHtml +
      `<div class="task-grid">${ids}</div>` +
      (budget ? `<div class="task-section"><div class="task-section-title">预算</div><div class="task-grid">${budget}</div></div>` : '') +
      (usage ? `<div class="task-section"><div class="task-section-title">用量</div><div class="task-grid">${usage}</div></div>` : '') +
      (task.resultText
        ? `<div class="task-section"><div class="task-section-title">结果</div><pre class="task-result">${esc(truncate(task.resultText, 6000))}</pre></div>`
        : '') +
      runsHtml +
      '</div>'
    );
  }

  /** Continue a child task in a fresh run, carrying its goal + result as context. */
  function buildContinueMessage(task, instruction) {
    const parts = ['【继续子任务】', `原任务 ${task.taskId}（智能体 ${task.agentId || '未知'}，状态 ${childStatusLabel(task.status)}）`];
    if (task.goal) parts.push(`原目标：${task.goal}`);
    if (task.resultText) parts.push(`已有结果：\n${truncate(task.resultText, 3000)}`);
    if (task.error?.message) parts.push(`此前错误：${task.error.message}`);
    parts.push(`继续要求：${instruction || '请在此基础上继续完成剩余工作，并给出可验证的结论。'}`);
    return parts.join('\n\n');
  }

  async function openTaskDetail(taskId) {
    if (!taskId) return;
    const state = { task: null, runs: [], error: null, loading: true };
    const modal = openModal({
      title: '子任务详情',
      size: 'lg',
      html: `<div class="task-detail-shell">${spinnerHtml('正在加载子任务详情…')}</div>`,
      actions: [
        { label: '刷新', kind: 'ghost', onClick: () => { void load(); return false; } },
        {
          label: '子运行详情',
          kind: 'ghost',
          onClick: () => {
            const task = state.task;
            if (!task?.runId) {
              toastInfo('该子任务暂无子运行标识');
              return false;
            }
            openRunDetail({ runId: task.runId, traceId: task.traceId || '' });
            return false;
          },
        },
        { label: '继续子任务', kind: 'primary', onClick: () => { void continueTask(); return false; } },
        { label: '关闭', kind: 'ghost' },
      ],
    });
    const shell = () => modal.body.querySelector('.task-detail-shell');

    function fromCache() {
      return (local.lastChildren || []).find((t) => t.taskId === taskId) || null;
    }

    async function load() {
      const box = shell();
      if (!box) return;
      box.innerHTML = spinnerHtml('正在加载子任务详情…');
      state.error = null;
      try {
        const raw = await api.agentTasks.get(taskId);
        const row = raw && raw.task ? raw.task : raw;
        state.task = row && row.taskId ? row : normalizeChildTask(row);
      } catch (err) {
        state.error = err;
        state.task = fromCache();
      }
      try {
        const data = await api.agentTasks.runs(taskId);
        state.runs = Array.isArray(data?.runs) ? data.runs : [];
        if (!state.task && data?.task) {
          state.task = data.task.taskId ? data.task : normalizeChildTask(data.task);
        }
      } catch {
        state.runs = [];
      }
      state.loading = false;
      const task = state.task || normalizeChildTask({ task_id: taskId, status: 'unknown' });
      box.innerHTML = taskDetailHtml(task, state.runs, state.error);
    }

    async function continueTask() {
      const task = state.task || normalizeChildTask({ task_id: taskId, status: 'unknown' });
      const instruction = await promptDialog({
        title: '继续子任务',
        message: `将基于子任务 ${taskId} 的已有结果创建一个新的运行。请补充继续指令（可留空）：`,
        placeholder: '例如：在现有结果基础上补充显著性检验并生成图表',
        multiline: true,
        rows: 3,
        value: '',
      });
      if (instruction === null) return;
      if (local.streaming) {
        toastWarn('当前还有任务在运行，请先等待完成或停止后再继续子任务。');
        return;
      }
      modal.close();
      await sendMessage({ text: buildContinueMessage(task, instruction.trim()) });
    }

    await load();
  }

  /* ---------------------------------------------------------------- */
  /* Scrolling                                                         */
  /* ---------------------------------------------------------------- */

  function isNearBottom() {
    const box = el.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollToBottom(force = false) {
    if (!force && !isNearBottom()) {
      el.scrollBottom.classList.add('is-visible');
      return;
    }
    el.messages.scrollTop = el.messages.scrollHeight;
    el.scrollBottom.classList.remove('is-visible');
  }

  /* ---------------------------------------------------------------- */
  /* Streaming lifecycle                                               */
  /* ---------------------------------------------------------------- */

  function setStreaming(on) {
    local.streaming = on;
    el.sendBtn.disabled = false;
    el.sendBtn.classList.remove('is-hidden');
    el.sendBtn.querySelector('span').textContent=on?'发送引导':'发送';
    root.querySelector('#guidance-queue-add').hidden=!on;
    root.querySelector('#guidance-annotate').hidden=!on;
    el.stopBtn.classList.toggle('is-hidden', !on);
    el.resendBtn.disabled = on || !local.messages.some((m) => m.role === 'user');
    el.input.disabled = false;
    if (on) {
      setStatus('正在连接…');
      if (!local.runState.status) beginRunState(local.run?.status || 'preparing', local.run?.runId || '');
    } else {
      setStatus('');
      updateRunState({ status: '' });
      local.abort = null;
      local.live = null;
    }
    updateHeader();
  }

  async function stopStreaming() {
    if (!local.streaming) return;
    const flow = local.run;
    setStatus('正在停止…');
    try {
      if (flow?.runId) {
        // Cancel only this run (CONTRACTS-3 §3); the trace subscription is separate.
        flow.stopped = true;
        await api.runtime.cancelRun(flow.runId);
      } else if (local.activeId) {
        await api.chat.stop(local.activeId).catch(() => {
          /* legacy stop is best effort */
        });
      }
    } catch (err) {
      toastWarn(`停止请求失败：${errorMessage(err)}`);
    }
    local.abort?.abort();
  }

  function buildPayload(message) {
    const payload = {
      conversation_id: local.activeId,
      message,
      attachments: local.attachments.map((a) => ({ path: a.path, name: a.name })),
    };
    if (local.agentId) payload.agent = local.agentId;
    return payload;
  }

  /* ---------------------------------------------------------------- */
  /* Run + trace subscription (CONTRACTS-3 §3 / T03)                   */
  /* ---------------------------------------------------------------- */

  const turn = { firstEvent: false, hasText: false, fatalError: null, doneReceived: false };
  let pendingDraft = null;

  function resetTurn() {
    turn.firstEvent = false;
    turn.hasText = false;
    turn.fatalError = null;
    turn.doneReceived = false;
  }

  function handleStreamEvent(ev) {
    if (!ev) return;
    const type = ev.type;
    if (type === 'heartbeat') return; // liveness only; the watchdog timer is reset by the caller
    turn.firstEvent = true;
    const data = ev.data || {};
    switch (type) {
      case 'guidance_status':
        void refreshGuidance();
        break;
      case 'connected':
        if (data.message_id) local.live?.setMeta('生成中');
        if (!local.run) setStatus('已连接');
        break;
      case 'status': {
        const text = data.text || '处理中…';
        setStatus(text);
        updateRunState({ phase: text });
        local.live?.setStatus(text);
        break;
      }
      case 'run_status': {
        const status = data.status || data.run_status || '';
        if (local.run && status) local.run.status = status;
        const label = runStatusLabel(status);
        setStatus(label);
        updateRunState({ status, phase: label, runId: data.run_id || local.run?.runId || local.runState.runId });
        local.live?.setStatus(status === 'waiting_approval' ? '等待审批' : `运行${label}`);
        if (RUN_TERMINAL_STATUSES.has(status)) turn.doneReceived = true;
        break;
      }
      case 'text':
        turn.hasText = true;
        local.live?.appendText(data.delta || '');
        break;
      case 'text_snapshot':
        turn.hasText=Boolean(data.text);
        local.live?.replaceText(data.text||'');
        break;
      case 'reasoning':
        local.live?.appendReasoning(data.delta || '');
        break;
      case 'commentary':
        local.live?.addProgress(data.text||'');
        break;
      case 'tool_call':
        local.live?.addToolCall(data);
        setStatus(`调用工具：${data.name || ''}`);
        updateRunState({ status: 'running', phase: '调用工具', tool: data.name || '' });
        break;
      case 'tool_result':
        local.live?.applyToolResult(data);
        setStatus('正在生成…');
        updateRunState({ status: 'running', phase: '核对工具结果', tool: '' });
        local.live?.addProgress(`${toolDisplayName(data.name||'工具')}：${data.ok===false?'未完成，正在处理错误':'结果已返回'}`);
        if(data.name==='write_file')void fileChanges.refresh();
        break;
      case 'approval_request':
        local.live?.addApproval(data);
        emit('approval:request', data);
        setStatus('等待你的批准');
        updateRunState({ status: 'waiting_approval', phase: '等待你的批准', tool: '' });
        break;
      case 'approval_resolved': {
        // Older backends emit {id, approved}; CONTRACTS-3 uses {id, decision}.
        const decision = data.decision || (data.approved ? 'approve' : 'deny');
        resolveApprovalCard(data.id || data.approval_id, decision);
        break;
      }
      case 'child_run': {
        // Two frames per child task: started (status=running) then terminal.
        local.live?.upsertChild(data);
        const status = data.status || 'running';
        const agent = data.agent_id || '子任务';
        const label = status === 'running' ? '开始' : childStatusLabel(status);
        setStatus(`子任务 ${agent}：${label}`);
        updateRunState({ phase: `子任务 ${agent}`, tool: label });
        local.live?.setStatus(`子任务 ${agent}：${label}`);
        if (local.run && CHILD_TERMINAL.has(status)) local.childDirty = true;
        break;
      }
      case 'figure':
        local.live?.addFigure(data);
        break;
      case 'usage':
        local.live?.setUsage(data);
        break;
      case 'error':
        turn.fatalError = data;
        updateRunState({ status: 'failed', phase: data.message || '调用失败', tool: '' });
        local.live?.setError(data.message || '调用失败', data.detail || '');
        break;
      case 'done':
        turn.doneReceived = true;
        setStatus('');
        updateRunState({ status: 'succeeded' });
        break;
      default:
        break;
    }
  }

  function createFlow(runId, traceId, status = 'queued') {
    return {
      runId,
      traceId,
      status,
      afterSeq: 0,
      ctrl: new AbortController(),
      watchdog: 0,
      timedOut: false,
      stopped: false,
      terminal: false,
      reconnects: 0,
    };
  }

  function clearWatchdog(flow) {
    if (flow && flow.watchdog) {
      clearTimeout(flow.watchdog);
      flow.watchdog = 0;
    }
  }

  function armWatchdog(flow) {
    if (!flow || flow.detached) return;
    clearWatchdog(flow);
    flow.watchdog = setTimeout(() => {
      flow.watchdog = 0;
      flow.timedOut = true;
      const hint = '连接中断，任务状态待确认…';
      setStatus(hint);
      local.live?.setStatus(hint);
      toastWarn('事件流 45 秒无响应，正在检查任务状态…');
      try {
        flow.ctrl.abort();
      } catch {
        /* already aborted */
      }
    }, RUN_WATCHDOG_MS);
  }

  function noteFlowSeq(flow, ev) {
    const seq = Number(ev?.data?.seq ?? ev?.seq);
    if (Number.isFinite(seq) && seq > flow.afterSeq) flow.afterSeq = seq;
  }

  function dispatchRunEvent(flow, ev) {
    if(flow.detached)return;
    clearWatchdog(flow);
    if (ev?.type === 'heartbeat') {
      armWatchdog(flow);
      return;
    }
    noteFlowSeq(flow, ev);
    if (ev?.type === 'run_status') {
      const status = ev.data?.status || ev.data?.run_status;
      if (status) flow.status = status;
      if (RUN_TERMINAL_STATUSES.has(status)) flow.terminal = true;
    } else if (ev?.type === 'done' || ev?.type === 'finished') {
      if (ev?.data?.status) flow.status = ev.data.status;
      flow.terminal = true;
      if (ev?.type === 'finished') turn.doneReceived = true;
    }
    handleStreamEvent(ev);
    if (flow.terminal) {
      try {
        flow.ctrl.abort(); // stop consuming; run is already terminal
      } catch {
        /* already aborted */
      }
    }
  }

  async function fetchRun(runId) {
    if (!runId) return null;
    try {
      return runPayload(runRecordFrom(await api.runtime.getRun(runId)));
    } catch {
      return null;
    }
  }

  /**
   * Pick the replay URL for a run. CONTRACTS-3 backends expose
   * GET /api/traces/{trace_id}/events; the interim backend exposes
   * GET /api/runs/{run_id}/stream?after_seq=N. Try the run stream first when its id
   * is known, then fall back once to the trace endpoint (and vice versa).
   */
  function runEventsUrl(flow, preferTrace) {
    if (!preferTrace && flow.runId) return api.runtime.runStreamUrl(flow.runId, flow.afterSeq);
    if (flow.traceId) return api.runtime.traceEventsUrl(flow.traceId, flow.afterSeq);
    if (flow.runId) return api.runtime.runStreamUrl(flow.runId, flow.afterSeq);
    return '';
  }

  async function driveRun(flow) {
    let attempt = 0;
    let preferTrace = !flow.runId;
    let triedRunStream = false;
    let triedTrace = false;
    while (!flow.terminal && !flow.stopped && !flow.detached) {
      const url = runEventsUrl(flow, preferTrace);
      if (!url) return { error: new Error('缺少运行或追踪标识，无法恢复订阅') };
      if (url.includes('/api/runs/')) triedRunStream = true;
      else triedTrace = true;
      armWatchdog(flow);
      const res = await streamTrace(url, {
        signal: flow.ctrl.signal,
        onOpen: () => armWatchdog(flow),
        onEvent: (ev) => dispatchRunEvent(flow, ev),
      });
      clearWatchdog(flow);
      if(flow.detached)return {detached:true};
      if (flow.stopped) return { aborted: true };
      if (flow.terminal) return { ok: true };
      // Endpoint mismatch between backend generations: switch transport once.
      if (res.error && res.received === 0) {
        if (!preferTrace && flow.traceId && !triedTrace) {
          preferTrace = true;
          continue;
        }
        if (preferTrace && flow.runId && !triedRunStream) {
          preferTrace = false;
          continue;
        }
        if (triedRunStream && triedTrace) return { error: res.error };
      }
      // The stream dropped before a terminal frame: reconcile with the run record
      // before re-subscribing (after_seq makes replay idempotent server-side).
      const active = await fetchRun(flow.runId);
      if (active) {
        flow.status = active.status;
        if (!flow.traceId && active.traceId) flow.traceId = active.traceId;
        handleStreamEvent({
          type: 'run_status',
          data: { run_id: flow.runId, status: active.status },
        });
        if (RUN_TERMINAL_STATUSES.has(active.status)) {
          flow.terminal = true;
          return { ok: true };
        }
      }
      if (flow.timedOut) {
        flow.timedOut = false;
        toastInfo('任务仍在运行，正在恢复事件订阅…');
      }
      if (attempt >= RUN_RECONNECTS) {
        return { error: res.error || new Error('事件流多次中断，请刷新页面确认任务状态') };
      }
      attempt += 1;
      flow.reconnects = attempt;
      flow.ctrl = new AbortController();
      local.abort = flow.ctrl;
      await new Promise((resolve) => setTimeout(resolve, Math.min(6000, 800 * attempt)));
    }
    return { aborted: flow.stopped, ok: flow.terminal };
  }

  async function createRunOrResume(message, attachments) {
    // Collaboration is a runtime decision the agent makes with team tools; the
    // composer only keeps the default mode for backend compatibility.
    const payload = { message, client_request_id: uid('req'), permission_mode: root.querySelector('#chat-permission-mode')?.value || 'ask', collaboration_mode: 'team' };
    if(local.taskSelection?.provider)payload.provider=local.taskSelection.provider;
    if(local.taskSelection?.model)payload.model=local.taskSelection.model;
    if (local.agentId) payload.agent = local.agentId;
    const workspaceId = getState().workspaceId;
    if (workspaceId) payload.workspace_id = workspaceId;
    if (attachments.length) payload.attachments = attachments.map((a) => ({ path: a.path, name: a.name }));
    let data;
    try {
      data = await api.runtime.createRun(local.activeId, payload);
    } catch (err) {
      if (!isRunConflict(err)) throw err;
      const activeRunId = conflictRunId(err);
      const active = activeRunId ? await fetchRun(activeRunId) : null;
      if (!active || !active.traceId) {
        throw new Error('该会话已有进行中的任务，请等待完成或点击停止后再发送');
      }
      toastWarn('该会话已有进行中的任务，已为你接入现有运行');
      return active;
    }
    let run = runPayload(runRecordFrom(data));
    if(data.run?.meta?.team_id){
      toastInfo('协作方案已生成，可在侧边栏「子智能体」中查看并批准。',{action:{label:'查看子智能体',onClick:()=>root.querySelector('#chat-agents-open')?.click()}});
      agentsPanel?.refresh();
    }
    if (run && !run.traceId) {
      const fetched = await fetchRun(run.runId);
      if (fetched?.traceId) run = { ...run, traceId: fetched.traceId, status: fetched.status || run.status };
    }
    if (!run || !run.traceId) throw new Error('后端未返回运行/追踪标识（trace_id）');
    return run;
  }

  /**
   * Interim backend path: POST /api/chat creates the run server-side and streams its
   * trace. Capture connected.run_id/trace_id, persist them, and resume from
   * /api/runs/{run_id}/stream if the browser stream drops before a terminal frame.
   */
  async function streamLegacyRun(message, attachments) {
    const payload = buildPayload(message);
    if (attachments.length) payload.attachments = attachments.map((a) => ({ path: a.path, name: a.name }));
    else delete payload.attachments;
    payload.client_request_id = uid('req');
    payload.permission_mode = root.querySelector('#chat-permission-mode')?.value || 'ask';
    payload.collaboration_mode = 'team';
    const flow = createFlow('', '', 'preparing');
    local.run = flow;
    local.abort = flow.ctrl;
    const capture = (ev) => {
      if (ev?.type === 'connected' && !flow.runId) {
        const data = ev.data || {};
        flow.runId = data.run_id || data.runId || '';
        flow.traceId = data.trace_id || data.traceId || '';
        if (flow.runId) rememberActiveRun(local.activeId, { runId: flow.runId, traceId: flow.traceId });
      }
      dispatchRunEvent(flow, ev);
    };
    armWatchdog(flow);
    let result = await streamChat(payload, {
      signal: flow.ctrl.signal,
      onEvent: capture,
      onRetry: ({ attempt, delay }) => {
        toastInfo(`连接中断，${Math.round(delay / 100) / 10} 秒后进行第 ${attempt} 次重试…`);
        setStatus('正在重连…');
      },
    });
    clearWatchdog(flow);
    if (flow.stopped) return { aborted: true };
    if (flow.terminal) return { ok: true };
    // 409: the session already has an active run — attach to it instead of failing.
    if (result?.error && isRunConflict(result.error)) {
      const activeRunId = conflictRunId(result.error);
      const active = activeRunId ? await fetchRun(activeRunId) : await fetchRun(flow.runId);
      if (active?.runId) {
        toastWarn('该会话已有进行中的任务，已为你接入现有运行');
        flow.runId = active.runId;
        flow.traceId = active.traceId || flow.traceId;
        flow.ctrl = new AbortController();
        local.abort = flow.ctrl;
        return driveRun(flow);
      }
      const friendly = '该会话已有进行中的任务，请等待它完成或停止后再发送';
      toastWarn(friendly);
      if (result.error) result.error.message = friendly;
      return result;
    }
    if (flow.runId) {
      toastInfo('连接中断，正在恢复事件订阅…');
      flow.ctrl = new AbortController();
      local.abort = flow.ctrl;
      return driveRun(flow);
    }
    return result;
  }

  function restoreDraft() {
    if (!pendingDraft) return;
    const draft = pendingDraft;
    pendingDraft = null;
    if (draft.message && !el.input.value.trim()) {
      el.input.value = draft.message;
      autoGrow();
    }
    if (draft.attachments.length && !local.attachments.length) {
      local.attachments = draft.attachments.map((att) => ({
        ...att,
        kind: IMAGE_EXT_RE.test(att.name || '') ? 'image' : 'file',
      }));
      renderAttachments();
    }
    el.input.focus();
  }

  function finishLive(result, finalStatus = '') {
    if (!local.live) return;
    if (result?.aborted || local.run?.stopped) {
      local.live.finish('已停止');
      toastInfo('已停止生成');
      return;
    }
    if (result?.error) {
      const msg = errorMessage(result.error);
      local.live.setError(msg, result.error?.detail ? String(result.error.detail) : '');
      local.live.finish('连接中断');
      toastError(msg, { action: { label: '重发', onClick: () => resendMessage() } });
      if (!turn.hasText) restoreDraft();
      return;
    }
    if (turn.fatalError) {
      local.live.finish('出错');
      return;
    }
    local.live.finish(finalStatus && finalStatus !== 'running' && finalStatus !== 'preparing' ? runStatusLabel(finalStatus) : '');
    if (!turn.doneReceived) toastWarn('流式响应提前结束，已保留已接收内容');
  }

  /** Re-attach to a run that outlived the previous page/route (T03). */
  async function resumeRunIfAny() {
    if (local.streaming || !local.activeId) return false;
    const epoch=observerEpoch,conversationId=local.activeId;
    const saved = loadRememberedRun(conversationId);
    if (!saved?.runId) return false;
    const run = await fetchRun(saved.runId);
    if(epoch!==observerEpoch)return false;
    if (!run || RUN_TERMINAL_STATUSES.has(run.status)) {
      forgetActiveRun(local.activeId);
      return false;
    }
    toastInfo('检测到该会话仍在运行的任务，正在恢复订阅…');
    resetTurn();
    local.live = createLiveBubble();
    const flow = createFlow(run.runId, run.traceId || saved.traceId, run.status);
    local.run = flow;
    local.guidanceRunId=flow.runId;void refreshGuidance();
    local.abort = flow.ctrl;
    setStreaming(true);
    beginRunState(run.status, run.runId);
    setStatus(runStatusLabel(run.status));
    void (async()=>{let result = null;
    try {
      result = await driveRun(flow);
    } catch (err) {
      if(epoch!==observerEpoch)return;
      turn.fatalError = { message: errorMessage(err) };
      local.live?.setError(errorMessage(err));
    } finally {
      clearWatchdog(flow);
      if(epoch!==observerEpoch)return;
      forgetActiveRun(conversationId);
      await refreshChildren(flow.runId);
      if(epoch!==observerEpoch)return;
      local.run = null;
      finishLive(result, flow.status);
      local.live?.setRun(flow.runId, flow.traceId);
      setStreaming(false);
      setStatus('');
      updateEmptyState();
      local.live = null;
      await refreshAfterTurn();
    }
    })();
    return true;
  }

  async function sendMessage({ text = null, resend = false } = {}) {
    if (!await executionSelectionPending) return;
    if (local.streaming) {
      await sendGuidance('send');
      return;
    }
    const inputValue = text != null ? text : el.input.value;
    const message = String(inputValue || '').trim();
    if (!message && !local.attachments.length) {
      toastInfo('请输入要发送的内容');
      return;
    }
    if (!local.activeId) {
      const conv = await createConversation();
      if (!conv) return;
    }
    const attachments = [...local.attachments];
    const draft = { message, attachments: attachments.map((a) => ({ path: a.path, name: a.name })) };
    local.attachments = [];
    attachments.forEach(releasePreview);
    renderAttachments();
    el.input.value = '';
    autoGrow();
    openDrawer(false);

    local.messages.push({
      id: uid('local-user'),
      role: 'user',
      content: message,
      ts: Date.now() / 1000,
    });
    if (!el.messages.querySelector('.msg')) el.messages.innerHTML = '';
    const liveMessage=renderMessage(local.messages[local.messages.length - 1], new Map());
    liveMessage.dataset.messageIndex=String(local.messages.length-1);
    liveMessage.dataset.messageRole='user';
    liveMessage.dataset.messageText=message.slice(0,1200);
    el.messages.appendChild(liveMessage);
    // drop the empty state if present
    el.messages.querySelector('.chat-empty')?.remove();

    resetTurn();
    local.lastChildren = [];
    // A new turn owns its own child-task list; drop cards rendered for a previous run.
    el.messages.querySelectorAll('.msg-children').forEach((node) => node.remove());
    pendingDraft = draft;
    local.guidanceRunId=null;guidanceUI.clear();
    local.live = createLiveBubble();
    local.abort = new AbortController();
    const epoch=observerEpoch,conversationId=local.activeId;
    setStreaming(true);
    beginRunState('preparing');
    scrollToBottom(true);

    let result = null;
    let flow = null;
    try {
      let run = null;
      try {
        run = await createRunOrResume(message, attachments);
      } catch (err) {
        // Backend predates CONTRACTS-3 §3: fall back to the legacy single-shot SSE.
        if (!isEndpointMissing(err)) throw err;
        run = null;
      }
      if (run) {
        flow = createFlow(run.runId, run.traceId, run.status);
        rememberActiveRun(conversationId, { runId: flow.runId, traceId: flow.traceId });
        if(epoch!==observerEpoch){flow.detached=true;flow.ctrl.abort();return;}
        local.run = flow;
        local.guidanceRunId=flow.runId;void refreshGuidance();
        local.abort = flow.ctrl;
        rememberActiveRun(local.activeId, { runId: flow.runId, traceId: flow.traceId });
        beginRunState(run.status,flow.runId);
        setStatus(runStatusLabel(run.status));
        result = await driveRun(flow);
      } else {
        // Interim backend: POST /api/chat owns run creation + first trace stream.
        result = await streamLegacyRun(message, attachments);
        flow = local.run;
      }
    } catch (err) {
      if(epoch!==observerEpoch)return;
      const msg = errorMessage(err);
      turn.fatalError = { message: msg };
      local.live?.setError(msg, err?.detail && typeof err.detail === 'string' ? err.detail : '');
      toastError(msg);
      restoreDraft();
    } finally {
      if(epoch!==observerEpoch){if(flow)clearWatchdog(flow);return;}
      if (flow) {
        clearWatchdog(flow);
        forgetActiveRun(local.activeId);
        await refreshChildren(flow.runId);
        if(epoch!==observerEpoch)return;
      }
      const finalStatus = flow?.status || '';
      local.run = null;
      finishLive(result, finalStatus);
      if (flow?.runId) local.live?.setRun(flow.runId, flow.traceId);
      pendingDraft = null;
      setStreaming(false);
      updateRunState({status:''});
      setStatus('');
      updateEmptyState();
      local.live = null;
      syncLiveToHistory();
      await refreshAfterTurn();
      el.input.focus();
    }
  }

  function syncLiveToHistory() {
    // Keep the rendered live bubble; history is reloaded only when switching conversations.
  }

  async function refreshAfterTurn() {
    await loadConversations();
    updateHeader();
    try {
      const data = await api.figures.list();
      const figures = Array.isArray(data?.figures) ? data.figures : Array.isArray(data) ? data : [];
      setState({ figuresCount: figures.length });
    } catch {
      /* non-critical */
    }
  }

  function resendMessage() {
    for (let i = local.messages.length - 1; i >= 0; i -= 1) {
      if (local.messages[i]?.role === 'user') {
        sendMessage({ text: local.messages[i].content, resend: true });
        return;
      }
    }
    toastInfo('当前会话还没有可重发的消息');
  }

  /* ---------------------------------------------------------------- */
  /* Composer & attachments                                            */
  /* ---------------------------------------------------------------- */

  function autoGrow() {
    const ta = el.input;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(240, ta.scrollHeight)}px`;
  }

  function releasePreview(att) {
    if (!att?.previewUrl) return;
    try {
      URL.revokeObjectURL(att.previewUrl);
    } catch {
      /* ignore */
    }
    att.previewUrl = '';
  }

  function syncVisionHint() {
    if (local.vision.configured || local.visionWarned) return;
    local.visionWarned = true;
    toastWarn(
      '视觉模型未配置：图片仍会作为附件上传，但智能体无法自动解读图像内容。可在「设置 → 视觉模型」中启用。',
      { title: '图片解读未启用', timeout: 6500 },
    );
  }

  async function loadLlmSettings() {
    try {
      const data = await api.settings.get();
      const llm = data?.llm || {};
      const vision = data?.vision || {};
      local.llm = {
        configured: Boolean(llm.configured),
        provider: llm.provider || '',
        model: llm.model || '',
      };
      local.vision = {
        configured: Boolean(vision.configured),
        enabled: Boolean(vision.enabled),
        model: vision.model || '',
      };
      local.llm.configured = Boolean(llm.configured || Object.values(data?.providers || {}).some(provider => provider?.configured && provider.id !== 'mock'));
      if (!local.llm.provider || !local.llm.model) {
        const firstProvider = Object.values(data?.providers || {}).find(provider => provider?.configured && provider.id !== 'mock');
        if (firstProvider) {
          local.llm.provider = firstProvider.id;
          local.llm.model = firstProvider.default_model || firstProvider.models?.[0] || '';
        }
      }
      local.catalog = Object.values(data?.providers || {})
        .filter(provider => provider && provider.configured && provider.id !== 'mock')
        .map(provider => ({
          id: provider.id,
          label: provider.label || provider.id,
          models: Array.isArray(provider.models) ? provider.models.map(String) : [],
          defaultModel: provider.default_model || '',
        }));
    } catch {
      // Settings are advisory here: the chat still works with the backend defaults.
    }
    renderModelChip();
  }

  function renderModelChip() {
    if (el.composerHint) {
      el.composerHint.textContent = local.vision.configured
        ? '可粘贴 / 拖拽图片 · Enter 发送 · Shift+Enter 换行'
        : 'Enter 发送 · Shift+Enter 换行';
    }
    if (!el.modelChip) return;
    el.modelChip.hidden = false;
    const { configured }=local.llm;
    const provider=local.taskSelection?.provider||local.llm.provider,model=local.taskSelection?.model||local.llm.model;
    el.modelChip.setAttribute('aria-haspopup','dialog');
    if (configured) {
      const label = [provider, model].filter(Boolean).join(' / ') || '已配置';
      el.modelChip.className = 'chat-model-chip is-ok';
      el.modelChip.textContent = label;
      el.modelChip.title = `此会话后续任务使用：${label}。点击快速切换；右键打开高级配置；运行中的任务保持原模型。`;
    } else {
      el.modelChip.className = 'chat-model-chip is-warn';
      el.modelChip.textContent = '模型未配置';
      el.modelChip.title = '尚未配置可用的模型 API Key，请前往「设置 → 模型与供应商」保存并测试';
    }
    if (!local.messages.length && !local.live) updateEmptyState();
  }

  async function saveExecutionSelection(execution) {
    const next = {
      provider: execution.provider || '',
      model: execution.model || '',
      permission_mode: execution.permission_mode || root.querySelector('#chat-permission-mode')?.value || 'ask',
    };
    if (!local.activeId && !await createConversation()) return false;
    const conversationId = local.activeId;
    const conv = await api.request(`/api/conversations/${encodeURIComponent(conversationId)}/execution`, {
      method: 'PATCH',
      body: next,
    });
    if (local.activeId !== conversationId) return false;
    local.taskSelection = conv?.meta?.execution || next;
    root.querySelector('#chat-permission-mode').value = local.taskSelection.permission_mode || 'ask';
    setPref('recentExecution', JSON.stringify(next));
    renderModelChip();
    toastSuccess('此会话后续任务已切换');
    return true;
  }

  function executionCatalog() {
    const choices = [];
    const seen = new Set();
    for (const provider of local.catalog || []) {
      const models = [...new Set([provider.defaultModel, ...provider.models].filter(Boolean))];
      for (const model of models.length ? models : ['']) {
        const key = `${provider.id}\u0000${model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        choices.push({ provider: provider.id, model, label: provider.label, modelLabel: model || '默认模型' });
      }
    }
    if (local.llm.provider || local.llm.model) {
      const key = `${local.llm.provider}\u0000${local.llm.model}`;
      if (!seen.has(key)) choices.unshift({ provider: local.llm.provider, model: local.llm.model, label: '当前默认', modelLabel: local.llm.model || '默认模型' });
    }
    return choices;
  }

  async function openModelPicker() {
    try {
      const selected = local.taskSelection || {};
      const providers = (local.catalog || []).filter((provider) => provider.models.length || provider.defaultModel);
      if (!providers.length) {
        navigate('settings');
        toastInfo('请先在设置中连接一个供应商');
        return;
      }
      local.modelPickerDispose?.();
      const popover = h('<div class="eve-model-popover" role="dialog" aria-label="切换此会话的模型"></div>');
      const search = document.createElement('input');
      search.type = 'search'; search.className = 'eve-model-search'; search.placeholder = '搜索供应商或模型…';
      const body = document.createElement('div'); body.className = 'eve-model-body';
      const footer = document.createElement('div'); footer.className = 'eve-model-footer';
      footer.innerHTML = `<span>只影响后续任务 · 运行中的任务保持原模型</span><button type="button" class="eve-model-manage">${icon('settings', { size: 13 })}<span>管理供应商</span></button>`;
      popover.append(search, body, footer); document.body.appendChild(popover);
      let providerId = selected.provider || providers[0].id;
      const currentModel = () => local.taskSelection?.provider === providerId ? (local.taskSelection.model || '') : '';
      const render = () => {
        const query = search.value.trim().toLowerCase();
        const visible = providers.filter((provider) => `${provider.label} ${provider.id} ${provider.models.join(' ')}`.toLowerCase().includes(query));
        const active = providers.find((provider) => provider.id === providerId) || visible[0] || providers[0];
        providerId = active.id;
        const models = [...new Set([active.defaultModel, ...active.models].filter(Boolean))].filter((model) => !query || `${active.label} ${model}`.toLowerCase().includes(query));
        body.innerHTML = `<div class="eve-model-providers" role="listbox" aria-label="供应商">${visible.map((provider) =>
          `<button type="button" class="eve-model-provider${provider.id === providerId ? ' is-active' : ''}" data-provider="${escAttr(provider.id)}"><span>${esc(provider.label)}</span><small>${provider.models.length || 1} 个模型</small>${provider.id === selected.provider ? icon('check', { size: 13 }) : ''}</button>`
        ).join('') || '<div class="eve-model-empty">没有匹配的供应商</div>'}</div><div class="eve-model-models" role="listbox" aria-label="模型">${models.map((model) =>
          `<button type="button" class="eve-model-option${active.id === selected.provider && model === (selected.model || active.defaultModel) ? ' is-selected' : ''}" data-provider="${escAttr(active.id)}" data-model="${escAttr(model)}"><span class="eve-model-option-main"><strong>${esc(model)}</strong><small>${model === active.defaultModel ? '推荐模型' : active.label}</small></span>${active.id === selected.provider && model === (selected.model || active.defaultModel) ? icon('check', { size: 15 }) : ''}</button>`
        ).join('') || '<div class="eve-model-empty">暂无模型建议。</div>'}</div>`;
      };
      const rect = el.modelChip.getBoundingClientRect();
      popover.style.top = `${Math.min(window.innerHeight - 420, rect.bottom + 8)}px`;
      popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 460, rect.left))}px`;
      const onClick = async (event) => {
        const provider = event.target.closest('.eve-model-provider');
        if (provider) { providerId = provider.dataset.provider; render(); return; }
        const option = event.target.closest('.eve-model-option');
        if (option) {
          try {
            if (await saveExecutionSelection({ ...(local.taskSelection || {}), provider: option.dataset.provider, model: option.dataset.model, permission_mode: root.querySelector('#chat-permission-mode')?.value || 'ask' })) dispose();
          } catch (error) { toastError(errorMessage(error)); }
        }
      };
      const onOutside = (event) => { if (!popover.contains(event.target) && event.target !== el.modelChip) dispose(); };
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); dispose(); el.modelChip.focus(); } };
      const onResize = () => { const next = el.modelChip.getBoundingClientRect(); popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 460, next.left))}px`; };
      const dispose = () => { document.removeEventListener('pointerdown', onOutside, true); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); popover.remove(); if (local.modelPickerDispose === dispose) local.modelPickerDispose = null; };
      local.modelPickerDispose = dispose;
      search.addEventListener('input', render); popover.addEventListener('click', onClick); footer.querySelector('.eve-model-manage')?.addEventListener('click', () => { dispose(); navigate('settings'); });
      document.addEventListener('pointerdown', onOutside, true); document.addEventListener('keydown', onKey); window.addEventListener('resize', onResize); render(); search.focus();
    } catch (error) {
      toastError(errorMessage(error));
    }
  }

  function attachmentMedia(att, idx) {
    if (att.kind === 'image' && att.previewUrl) {
      return `<img class="attach-thumb" src="${escAttr(att.previewUrl)}" alt="${escAttr(att.name)}" data-idx="${idx}" />`;
    }
    return icon(att.kind === 'image' ? 'image' : 'file', { size: 13 });
  }

  async function addAttachmentFiles(files) {
    const uploadWorkspace = getState().workspaceId || 'ws_main';
    const list = Array.from(files || []);
    if (!list.length) return;
    if (list.some(isImageFile)) syncVisionHint();
    for (const file of list) {
      const image = isImageFile(file);
      const previewUrl =
        image && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : '';
      const meta = { kind: image ? 'image' : 'file', size: Number(file.size) || 0, previewUrl };
      try {
        const res = await api.workspaces.files.upload(uploadWorkspace, file, 'uploads', {
          onProgress: (pct) => toastInfo(`上传 ${file.name}… ${pct}%`, { timeout: 1200 }),
        });
        const path = res?.path || res?.file || file.name;
        local.attachments.push({ path, name: res?.name || file.name, ...meta });
        renderAttachments();
      } catch (err) {
        // Retry once at the workspace root (the uploads directory may not exist yet).
        try {
          const res = await api.workspaces.files.upload(uploadWorkspace, file, '.');
          local.attachments.push({
            path: res?.path || file.name,
            name: res?.name || file.name,
            ...meta,
          });
          renderAttachments();
        } catch (err2) {
          if (meta.previewUrl) releasePreview(meta);
          toastError(`附件上传失败：${errorMessage(err2 || err)}`);
        }
      }
    }
  }

  function renderAttachments() {
    if (!local.attachments.length) {
      el.attachments.innerHTML = '';
      el.attachments.hidden = true;
      return;
    }
    el.attachments.hidden = false;
    el.attachments.innerHTML = local.attachments
      .map(
        (a, idx) =>
          `<span class="attach-chip${a.kind === 'image' ? ' is-image' : ''}" title="${escAttr(a.path)}">` +
          attachmentMedia(a, idx) +
          `<span class="attach-name" title="${escAttr(a.path)}">${esc(a.name)}</span>` +
          `<button type="button" class="attach-remove" data-idx="${idx}" aria-label="移除附件">${icon('close', { size: 12 })}</button></span>`,
      )
      .join('');
  }

  /* ---------------------------------------------------------------- */
  /* Event binding                                                     */
  /* ---------------------------------------------------------------- */

  sidebarListen(el.newBtn,'click', () => {
    createConversation();
  });

  sidebarListen(el.convFilter,'input', () => {
    local.filter = el.convFilter.value;
    renderConversationList();
  });

  const convView=sidebarRoot.querySelector('#conv-view'),convWorkspaceOnly=sidebarRoot.querySelector('#conv-workspace-only');
  convView.value=getPref('conversationView','recent');convWorkspaceOnly.checked=getPref('conversationWorkspaceOnly',false);
  sidebarListen(convView,'change',()=>{setPref('conversationView',convView.value);renderConversationList();});
  sidebarListen(convWorkspaceOnly,'change',()=>{setPref('conversationWorkspaceOnly',convWorkspaceOnly.checked);renderConversationList();});

  sidebarListen(el.convList,'click', (evt) => {
    if(evt.target.closest('[data-conv-more]')){conversationLimit+=100;renderConversationList();return;}
    const metaButton=evt.target.closest('.conv-archive,.conv-pin');
    if(metaButton){
      evt.stopPropagation();
      const conv=local.conversations.find(c=>c.id===metaButton.dataset.id);
      if(!conv)return;
      const key=metaButton.classList.contains('conv-pin')?'pinned':'archived';
      metaButton.disabled=true;
      api.conversations.update(conv.id,{[key]:!conversationFlag(conv,key)}).then(record=>{
        Object.assign(conv,record,{archived:conversationFlag(record,'archived'),pinned:conversationFlag(record,'pinned')});
        setState({conversations:[...local.conversations]});renderConversationList();
        toastSuccess(key==='archived'?(conv.archived?'已归档':'已恢复'):(conv.pinned?'已置顶':'已取消置顶'));
      }).catch(error=>{metaButton.disabled=false;toastError(errorMessage(error));});return;
    }
    const renameBtn = evt.target.closest('.conv-rename');
    if (renameBtn) {
      evt.stopPropagation();
      renameConversation(renameBtn.dataset.id);
      return;
    }
    const deleteBtn = evt.target.closest('.conv-delete');
    if (deleteBtn) {
      evt.stopPropagation();
      deleteConversation(deleteBtn.dataset.id);
      return;
    }
    const item = evt.target.closest('.conv-item');
    if (item && item.dataset.id !== local.activeId) selectConversation(item.dataset.id);
  });

  sidebarListen(el.convList,'dblclick', (evt) => {
    const item = evt.target.closest('.conv-item');
    if (item) renameConversation(item.dataset.id);
  });

  sidebarListen(el.convList,'keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    if(evt.target.closest('button'))return;
    const item = evt.target.closest('.conv-item');
    if (item) {
      evt.preventDefault();
      selectConversation(item.dataset.id);
    }
  });

  el.sendBtn.addEventListener('click', () => sendMessage());
  el.stopBtn.addEventListener('click', () => {
    stopStreaming();
  });
  el.resendBtn.addEventListener('click', () => resendMessage());
  el.runsBtn?.addEventListener('click', () => {
    if (!local.activeId) {
      toastInfo('请先选择一个会话');
      return;
    }
    openRunList(local.activeId);
  });
  el.scrollBottom.addEventListener('click', () => scrollToBottom(true));

  el.messages.addEventListener('scroll', () => {
    if (isNearBottom()) el.scrollBottom.classList.remove('is-visible');
  });

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' || evt.isComposing) return;
    // Enter sends; Ctrl/Cmd+Enter also sends (legacy shortcut); Shift+Enter inserts a newline.
    if (evt.ctrlKey || evt.metaKey) {
      evt.preventDefault();
      sendMessage();
      return;
    }
    if (!evt.shiftKey) {
      evt.preventDefault();
      if(local.streaming)void sendGuidance('candidate');else sendMessage();
    }
  });

  el.input.addEventListener('paste', (evt) => {
    const items = evt.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) addAttachmentFiles(files);
  });

  el.attachBtn.addEventListener('click', () => el.attachInput.click());
  el.attachInput.addEventListener('change', async () => {
    await addAttachmentFiles(el.attachInput.files);
    el.attachInput.value = '';
  });
  el.attachments.addEventListener('click', (evt) => {
    const thumb = evt.target.closest('.attach-thumb');
    if (thumb) {
      const att = local.attachments[Number(thumb.dataset.idx)];
      if (att?.previewUrl) openLightbox({ src: att.previewUrl, title: att.name });
      return;
    }
    const btn = evt.target.closest('.attach-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    releasePreview(local.attachments[idx]);
    local.attachments.splice(idx, 1);
    renderAttachments();
  });

  // Drag & drop images / files onto the composer.
  let dragDepth = 0;
  function hasFileDrag(evt) {
    const types = evt.dataTransfer?.types;
    return Boolean(types && Array.from(types).includes('Files'));
  }
  function setDropActive(active) {
    el.composer?.classList.toggle('is-drop-active', active);
    if (el.dropHint) el.dropHint.hidden = !active;
  }
  el.composer?.addEventListener('dragenter', (evt) => {
    if (!hasFileDrag(evt)) return;
    evt.preventDefault();
    dragDepth += 1;
    setDropActive(true);
  });
  el.composer?.addEventListener('dragover', (evt) => {
    if (!hasFileDrag(evt)) return;
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
  });
  el.composer?.addEventListener('dragleave', (evt) => {
    if (!hasFileDrag(evt)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDropActive(false);
  });
  el.composer?.addEventListener('drop', (evt) => {
    const files = evt.dataTransfer?.files;
    if (!files || !files.length) return;
    evt.preventDefault();
    dragDepth = 0;
    setDropActive(false);
    addAttachmentFiles(files);
  });

  el.agentSelect.addEventListener('change', async () => {
    const id = el.agentSelect.value;
    setPref(AGENT_MIGRATION_KEY, '1');
    local.agentId = id;
    setAgent(id);
    if (local.activeId) {
      try {
        await api.conversations.update(local.activeId, { agent: id });
        const conv = local.conversations.find((c) => c.id === local.activeId);
        if (conv) conv.agent = id;
        updateHeader();
        renderConversationList();
      } catch (err) {
        toastError(`切换智能体失败：${errorMessage(err)}`);
      }
    }
    toastSuccess(`已切换到 ${agentLabel(id)}`);
  });

  // prompt chips in the empty state + child task cards (task tree) + run links
  el.messages.addEventListener('click', (evt) => {
    const toolHead=evt.target.closest('.tool-head');
    if(toolHead){const card=toolHead.closest('.tool-card');if(card){const open=card.classList.toggle('is-open');toolHead.setAttribute('aria-expanded',String(open));}return;}
    const runLink = evt.target.closest('.run-detail-link[data-run-id]');
    if (runLink) {
      openRunDetail({ runId: runLink.dataset.runId, traceId: runLink.dataset.traceId || '' });
      return;
    }
    const taskEl = evt.target.closest('.child-task[data-task-id]');
    if (taskEl) {
      void openTaskDetail(taskEl.dataset.taskId);
      return;
    }
    const chip = evt.target.closest('.prompt-chip');
    if (!chip) return;
    el.input.value = chip.textContent || '';
    autoGrow();
    el.input.focus();
  });

  el.messages.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const taskEl = evt.target.closest('.child-task[data-task-id]');
    if (!taskEl) return;
    evt.preventDefault();
    void openTaskDetail(taskEl.dataset.taskId);
  });

  // splitter drag
  let dragging = false;
  const onSplitMove = (evt) => {
    if (!dragging) return;
    const rect = el.view.getBoundingClientRect();
    const width = evt.clientX - rect.left;
    applySidebarWidth(width);
  };
  const onSplitUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing');
    const width = parseInt(getComputedStyle(el.view).getPropertyValue('--chat-sidebar-w'), 10);
    setPref('chatSidebarWidth', width || SIDEBAR_DEFAULT);
  };
  el.splitter.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    dragging = true;
    document.body.classList.add('is-resizing');
  });
  document.addEventListener('mousemove', onSplitMove);
  document.addEventListener('mouseup', onSplitUp);

  el.drawerBtn.addEventListener('click', () => {
    if(window.innerWidth<=900){openDrawer(!el.view.classList.contains('drawer-open'));return;}
    const collapsed=el.view.classList.toggle('sidebar-collapsed');setPref('chatSidebarCollapsed',collapsed);if(ctx.shellSidebar)document.body.classList.toggle('workspace-sidebar-collapsed',collapsed);el.drawerBtn.setAttribute('aria-expanded',String(!collapsed));
  });
  root.querySelector('#chat-skills-open')?.addEventListener('click',()=>chooseComposerSkills(el.input).catch(error=>toastError(errorMessage(error))));
  const fileChanges=mountFileChanges(root,()=>({workspaceId:getState().workspaceId,sessionId:local.activeId}));
  void fileChanges.refresh();
  const permissionSelect = root.querySelector('#chat-permission-mode');
  let executionSelectionPending = Promise.resolve(true);
  const guidanceUI=mountGuidance({root,context:()=>({runId:local.run?.runId||local.guidanceRunId,epoch:observerEpoch,running:local.streaming}),clearInput:()=>{el.input.value='';autoGrow();},startTask:content=>void sendMessage({text:content})});
  const offFigureApply=on('figure:annotation-apply',async detail=>{
    if(!root.isConnected||!detail?.name)return;
    detail.accept?.();
    const regions=detail.regions||[];
    const content=`局部修改图表 figures/${detail.name}。\n修改要求：${detail.note||'仅调整标注区域。'}\n归一化坐标区域：${JSON.stringify(regions)}\n先读取原图、原始数据和生成脚本，仅修改被标注的对象与相邻布局；保留未标注区域、数据、统计方法、尺寸与整体视觉样式。保存候选版本并核验差异；缺少可编辑源文件时先说明，不能整图重新生成代替局部修改。`;
    if(local.streaming)await guidanceUI.send('send',content);
    else await sendMessage({text:content});
  });
  function refreshGuidance(){return guidanceUI.refresh();}
  function sendGuidance(action){return guidanceUI.send(action);}
  permissionSelect?.addEventListener('change',()=>{
    const selection={...local.taskSelection,permission_mode:permissionSelect.value};
    executionSelectionPending=executionSelectionPending.then(()=>saveExecutionSelection(selection)).catch(error=>{toastError(errorMessage(error));return false;});
  });
  function applyTaskSelection(conv){
    local.taskSelection=conv?.meta?.execution||{};
    local.guidanceRunId=conv?.meta?.last_run_id||null;if(local.guidanceRunId)void refreshGuidance();
    const mode=local.taskSelection.permission_mode||'ask';
    root.querySelector('#chat-permission-mode').value=mode;
    renderModelChip();
  }
  async function openTaskConfig(){
    try{
      const settings=await api.settings.get(),catalog=Object.values(settings.providers||{}).filter(p=>p.configured&&p.id!=='mock');
      const selected=local.taskSelection||{};
      const modal=openModal({title:'此会话的模型与权限',html:`<div class="task-selection-form"><p>只用于此会话的后续任务。正在执行的任务保持原配置。</p><label>模型连接<select id="task-provider"><option value="">沿用工作区路由</option>${catalog.map(p=>`<option value="${escAttr(p.id)}" ${selected.provider===p.id?'selected':''}>${esc(p.label||p.id)}</option>`).join('')}</select></label><label>模型名称<input id="task-model" list="task-model-options" value="${escAttr(selected.model||'')}" placeholder="留空沿用默认模型"/><datalist id="task-model-options">${catalog.flatMap(p=>p.models||[]).map(m=>`<option value="${escAttr(typeof m==='string'?m:m.id||m.name||'')}"></option>`).join('')}</datalist></label><label>工具权限<select id="task-permission"><option value="ask">请求批准</option><option value="review">帮我审核</option><option value="full">完全权限</option></select></label></div>`,actions:[{label:'取消',kind:'ghost'},{label:'保存任务配置',kind:'primary',onClick:async()=>{
        if(!local.activeId&&!await createConversation())return false;
        const execution={provider:modal.body.querySelector('#task-provider').value,model:modal.body.querySelector('#task-model').value.trim(),permission_mode:modal.body.querySelector('#task-permission').value};
        const conv=await api.request(`/api/conversations/${encodeURIComponent(local.activeId)}/execution`,{method:'PATCH',body:execution});
        applyTaskSelection(conv);return true;
      }}]});
      modal.body.querySelector('#task-permission').value=permissionSelect.value;
    }catch(error){toastError(errorMessage(error));}
  }
  el.modelChip?.addEventListener('click',()=>void openModelPicker());
  el.modelChip?.addEventListener('contextmenu',event=>{event.preventDefault();void openTaskConfig();});
  el.locatorButton?.addEventListener('click',()=>el.locator?.hidden?openLocator():closeLocator());
  el.locatorInput?.addEventListener('input',()=>{local.locatorIndex=0;renderLocator(el.locatorInput.value);});
  el.locatorInput?.addEventListener('keydown',event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveLocator(event.key==='ArrowDown'?1:-1);return;}
    if(event.key==='Enter'){event.preventDefault();const item=el.locatorResults?.querySelector('.chat-locator-item.is-active');if(item)jumpToMessage(item.dataset.messageIndex);return;}
    if(event.key==='Escape'){event.preventDefault();closeLocator();el.input.focus();}
  });
  el.locatorResults?.addEventListener('click',event=>{const item=event.target.closest('[data-message-index]');if(item)jumpToMessage(item.dataset.messageIndex);});
  el.locator?.addEventListener('mousedown',event=>{if(event.target===el.locator)closeLocator();});
  el.runPanelStop?.addEventListener('click',()=>void stopStreaming());
  el.runPanelDetail?.addEventListener('click',()=>{
    const runId=local.runState.runId||local.run?.runId;
    if(runId)openRunDetail({runId,traceId:local.run?.traceId||''});
  });
  const locatorShortcut=event=>{
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='f'){
      event.preventDefault();event.stopPropagation();
      if(el.locator?.hidden)openLocator();else closeLocator();
    }
  };
  root.addEventListener('keydown',locatorShortcut);
  const locatorOutsidePointer=event=>{
    if(!el.locator||el.locator.hidden)return;
    if(!el.locator.contains(event.target))closeLocator();
  };
  document.addEventListener('pointerdown',locatorOutsidePointer,true);
  root.querySelector('#chat-workspace')?.addEventListener('click',async()=>{
    const value=await promptDialog({title:'选择工作目录 · 更换后开始新会话',placeholder:'输入本机文件夹的完整路径',value:getState().workspace?.local_path||getState().workspace?.root||'',confirmText:'使用此目录'});
    if(value===null||!value.trim())return;
    try{const data=await api.workspaces.create({name:value.split(/[\\/]/).filter(Boolean).at(-1)||'工作目录',local_path:value.trim()});const workspace=data.workspace;const probe=await api.workspaces.probe(workspace.workspace_id);if(probe.ok===false)throw new Error('目录不可访问');setWorkspace(workspace);await createConversation();root.querySelector('#chat-workspace').title=value;root.querySelector('#chat-workspace span').textContent=workspace.name||'工作目录';}catch(error){toastError(errorMessage(error));}
  });
  el.drawerScrim.addEventListener('click', () => openDrawer(false));

  /* ---------------------------------------------------------------- */
  /* Initial data                                                      */
  /* ---------------------------------------------------------------- */

  function knownAgentId(agents, id) {
    if (!id) return false;
    return agents.some((a) => (a.id || a.name) === id);
  }

  function agentOptionLabel(agent) {
    const id = agent.id || agent.name || '';
    if (id === 'lead') return leadAgentLabel();
    return agent.name || agent.id || '智能体';
  }

  /** Effective default agent: backend API > settings.default_agent > builtin lead (T07). */
  async function resolveDefaultAgent() {
    try {
      const data = await api.agentsDefault();
      const id = data?.agent_id || data?.id || '';
      if (id) {
        const info = { id, source: data.source || '', message: data.message || '' };
        setAgentDefault(info);
        return info;
      }
    } catch {
      /* endpoint not deployed yet: fall through to settings */
    }
    try {
      const data = await api.settings.get();
      const id = data?.settings?.default_agent || '';
      if (id) {
        const info = { id, source: 'settings', message: '' };
        setAgentDefault(info);
        return info;
      }
    } catch {
      /* ignore */
    }
    const info = { id: 'lead', source: 'builtin', message: '' };
    setAgentDefault(info);
    return info;
  }

  function renderAgentOptions() {
    el.agentSelect.innerHTML = local.agents.length
      ? local.agents
          .map((a) => {
            const id = a.id || a.name || '';
            return `<option value="${esc(id)}">${esc(agentOptionLabel(a))}</option>`;
          })
          .join('')
      : `<option value="${esc(local.agentId || 'lead')}">${esc(
          !local.agentId || local.agentId === 'lead' ? leadAgentLabel() : '默认智能体',
        )}</option>`;
    if (local.agentId) el.agentSelect.value = local.agentId;
    const defaultId = local.agentDefault?.id;
    el.agentSelect.title = defaultId ? `默认：${agentLabel(defaultId)}` : '选择智能体';
    el.input.placeholder = '输入任务或问题…';
    const workspace=getState().workspace;
    const chip=root.querySelector('#chat-workspace');
    if(chip&&workspace){chip.querySelector('span').textContent=workspace.name||'工作目录';chip.title=workspace.local_path||workspace.root||'选择工作目录';}
  }

  function applyEffectiveAgent(id) {
    local.agentId = id;
    setAgent(id);
    renderAgentOptions();
    updateHeader();
    updateEmptyState();
  }

  /** Pre-1.2 expert preference: ask once, allow keeping it (CONTRACTS-3 T07). */
  function maybePromptAgentMigration(effectiveId) {
    const stored = getPref('agent', '');
    if (!stored || stored === effectiveId) return;
    if (getPref(AGENT_MIGRATION_KEY, '')) return;
    setPref(AGENT_MIGRATION_KEY, '1');
    const keep = knownAgentId(local.agents, stored);
    openModal({
      title: '默认智能体已更新',
      size: 'sm',
      html:
        '<p class="confirm-text">旧版本保存的专家偏好是 <strong>' +
        `${esc(agentLabel(stored))}</strong>。当前默认使用「${esc(leadAgentLabel())}」。` +
        '<br /><br />可以保留原选择，或切换到当前默认。</p>',
      actions: [
        {
          label: keep ? '保留原选择' : '保留原名称',
          kind: 'ghost',
          onClick: () => {
            if (keep) {
              setAgent(stored);
              local.agentId = stored;
              renderAgentOptions();
              updateHeader();
              toastInfo(`继续使用 ${agentLabel(stored)}`);
            } else {
              applyEffectiveAgent(effectiveId);
              toastSuccess(`已使用 ${agentLabel(effectiveId)}`);
            }
          },
        },
        {
          label: '使用 Eve',
          kind: 'primary',
          onClick: () => {
            applyEffectiveAgent(effectiveId);
            toastSuccess(`已使用 ${agentLabel(effectiveId)}`);
          },
        },
      ],
    });
  }

  async function loadAgents() {
    let agents = Array.isArray(getState().agents) ? getState().agents : [];
    if (!agents.length) {
      try {
        const data = await api.agents();
        agents = Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [];
        setState({ agents });
      } catch {
        agents = [];
      }
    }
    local.agents = agents;
    const defaultInfo = await resolveDefaultAgent();
    let effectiveId = defaultInfo.id;
    // Never fall back to agents[0] blindly: prefer the builtin lead, then the
    // only remaining candidate for a degraded (custom-only) deployment.
    if (!knownAgentId(agents, effectiveId)) {
      if (knownAgentId(agents, 'lead')) effectiveId = 'lead';
      else effectiveId = agents[0]?.id || agents[0]?.name || effectiveId || 'lead';
      if (defaultInfo.id !== effectiveId) {
        setAgentDefault({ ...defaultInfo, id: effectiveId, fallback: true });
      }
    }
    local.agentDefault = getState().agentDefault || { id: effectiveId };
    const stored = local.agentId;
    if (stored && !knownAgentId(agents, stored)) {
      // Invalid / removed role: return to the effective default (never agents[0] unless necessary).
      toastInfo('原默认专家已不可用，已切换到 Eve');
      applyEffectiveAgent(effectiveId);
    } else if (!stored) {
      applyEffectiveAgent(effectiveId);
    } else {
      local.agentId = stored;
    }
    renderAgentOptions();
    updateHeader();
    maybePromptAgentMigration(effectiveId);
  }

  async function boot() {
    const restoreWorkspace=async()=>{
      const current=getState();
      if(current.workspaceId&&!current.workspace){try{const data=await api.workspaces.get(current.workspaceId);setWorkspace(data.workspace||data);}catch(error){toastError(`无法恢复工作目录：${errorMessage(error)}`);}}
    };
    await Promise.all([loadAgents(), loadConversations(), loadLlmSettings(),restoreWorkspace()]);
    renderAgentOptions();
    const stored = getPref('activeConversationId', '') || getState().activeConversationId;
    const target =
      (stored && local.conversations.find((c) => c.id === stored)) ||
      sortedConversations()[0] ||
      null;
    if (target) {
      await selectConversation(target.id, { scroll: true });
    } else {
      local.messages = [];
      updateEmptyState();
      updateHeader();
    }
    el.input.focus();
    autoGrow();
  }

  const offNewConversation = on('chat:new-conversation', () => {
    void createConversation();
  });
  const offPrefill = on('chat:prefill', (payload) => {
    const text = typeof payload === 'string' ? payload : payload?.text;
    if (!text) return;
    el.input.value = text;
    autoGrow();
    el.input.focus();
    openDrawer(false);
  });
  const offLlmChanged = on('llm:changed', () => {
    loadLlmSettings();
  });
  const offApprovalResolved = on('approval:resolved', (payload) => {
    if (payload?.id) resolveApprovalCard(payload.id, payload.decision || 'approve');
  });
  const offChatSelect = on('chat:select', (conversationId) => {
    if (!conversationId) return;
    void selectConversation(String(conversationId));
  });
  await boot();
  const disposeProjectFiles=await mountProjectFiles(sidebarRoot,{busy:()=>local.streaming,changed:async workspace=>{
    await createConversation();
    const chip=root.querySelector('#chat-workspace');
    if(chip){chip.querySelector('span').textContent=workspace.name;chip.title=workspace.backend==='ssh'?`SSH · ${workspace.remote?.root||''}`:workspace.local_path;}
  }});
  agentsPanel=await mountAgentsPanel(sidebarRoot,{
    getContext:()=>({conversationId:local.activeId,scope:getState().workspaceId||'ws_main'}),
    onSelectConversation:(conversationId)=>{
      if(conversationId)emit('chat:select',conversationId);
    },
    onChanged:(total)=>{
      if(!agentsCount)return;
      agentsCount.hidden=!total;
      agentsCount.textContent=total>99?'99+':String(total||'');
    },
  });
  if(root.isConnected){
    el.view.classList.add('is-mounted');
    el.view.dataset.ready='true';
    el.input.disabled=false;
    el.sendBtn.disabled=false;
  }

  return {
    destroy() {
      offFigureApply();
      fileChanges.destroy();
      guidanceUI.dispose();
      detachActiveView();
      sidebarController.abort();
      disposeProjectFiles();
      agentsPanel?.destroy();
      dragging = false;
      document.removeEventListener('mousemove', onSplitMove);
      document.removeEventListener('mouseup', onSplitUp);
      // Unsubscribing never cancels the run itself (CONTRACTS-3 §3).
      if (local.run) {
        clearWatchdog(local.run);
        local.run = null;
      }
      local.abort?.abort();
      local.modelPickerDispose?.();
      offNewConversation();
      offPrefill();
      offLlmChanged();
      offApprovalResolved();
      offChatSelect();
      local.attachments.forEach(releasePreview);
      local.attachments = [];
      if(local.runState.timer){clearInterval(local.runState.timer);local.runState.timer=0;}
      root.removeEventListener('keydown',locatorShortcut);
      document.removeEventListener('pointerdown',locatorOutsidePointer,true);
      setStatus('');
      root.innerHTML = '';
    },
    reload: boot,
  };
}

/* ------------------------------------------------------------------ */
/* Static layout                                                       */
/* ------------------------------------------------------------------ */

function chatLayout() {
  return (
    '<div class="chat-view">' +
    '<aside class="chat-sidebar" aria-label="会话列表">' +
    workspaceSidebarHtml() +
    '</aside>' +
    '<div class="chat-splitter" role="separator" aria-orientation="vertical" title="拖动调整宽度"></div>' +
    '<div class="chat-drawer-scrim"></div>' +
    '<section class="chat-main">' +
    '<header class="chat-header">' +
    `<button type="button" class="icon-btn chat-drawer-btn" id="chat-drawer-toggle" aria-label="显示会话列表">${icon('panelLeft', { size: 18 })}</button>` +
    '<div class="chat-heading">' +
    '<div class="chat-title-row"><h1 class="chat-title" id="chat-title">新对话</h1><span class="chat-status" id="chat-status" hidden></span><button type="button" class="chat-model-chip" id="chat-model-chip" aria-label="切换此会话模型" hidden></button><button type="button" class="icon-btn chat-locator-btn" id="chat-locator-btn" aria-label="定位聊天消息" aria-expanded="false" title="定位消息（Ctrl/Cmd+Shift+F）">' + icon('search',{size:15}) + '</button></div>' +
    `<div class="chat-subtitle" id="chat-subtitle"></div>` +
    '</div>' +
    '<div class="chat-header-actions">' +
    `<label class="select-wrap agent-select-wrap" title="选择智能体">${icon('wand', { size: 15 })}<select id="agent-select" aria-label="智能体"></select></label>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="runs-btn" title="查看本会话的运行记录与时间线">${icon('history', { size: 15 })}<span>运行</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="resend-btn" title="重发上一条消息">${icon('refresh', { size: 15 })}<span>重发</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="chat-locator" id="chat-locator" hidden role="dialog" aria-label="定位聊天消息"><div class="chat-locator-panel"><div class="chat-locator-search">' + icon('search',{size:15}) + '<input id="chat-locator-input" type="search" autocomplete="off" placeholder="搜索或跳转到消息…" aria-label="搜索聊天消息" /><kbd>Esc</kbd></div><div class="chat-locator-results" id="chat-locator-results"></div><div class="chat-locator-foot"><span>↑ ↓ 选择</span><span>Enter 跳转</span><span>Ctrl/Cmd+Shift+F</span></div></div></div>' +
    '<div class="messages" id="messages" aria-live="polite"></div>' +
    `<button type="button" class="scroll-bottom" id="scroll-bottom" aria-label="回到最新">${icon('chevronDown', { size: 18 })}</button>` +
    '<div class="composer">' +
    '<div class="chat-drop-hint" hidden>' +
    icon('image', { size: 22 }) +
    '<span>松开以添加图片 / 附件</span>' +
    '</div>' +
    '<div class="chat-run-panel" id="chat-run-panel" hidden role="status"><span class="chat-run-indicator"></span><div class="chat-run-copy"><strong id="chat-run-phase">运行中</strong><span id="chat-run-tool">正在准备下一步</span></div><span class="chat-run-elapsed" id="chat-run-elapsed">0 秒</span><button type="button" class="btn btn-ghost btn-sm" id="chat-run-detail" title="查看运行详情">' + icon('history',{size:14}) + '<span>详情</span></button><button type="button" class="btn btn-ghost btn-sm" id="chat-run-stop" title="停止当前任务">' + icon('stop',{size:14}) + '<span>停止</span></button></div>' +
    '<div class="composer-box">' +
    `<textarea id="chat-input" class="composer-input" rows="1" placeholder="描述任务，或输入 @ 引用文件、/ 查看命令…"></textarea>` +
    '<div class="composer-bar">' +
    '<div class="composer-left">' +
    `<button type="button" class="icon-btn" id="attach-btn" title="添加图片或附件（也可粘贴 / 拖拽）">${icon('upload', { size: 17 })}</button>` +
    '<input type="file" id="chat-file-input" multiple hidden />' +
    `<button type="button" class="btn btn-ghost btn-sm workspace-chip" id="chat-workspace" title="选择模型可访问的工作目录">${icon('folder',{size:14})}<span>工作目录</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="chat-skills-open" title="查看已安装技能">${icon('skills',{size:14})}<span>技能</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="chat-agents-open" title="查看当前任务的子智能体与协作状态">${icon('layers',{size:14})}<span>子智能体</span><span class="agents-badge" id="chat-agents-count" hidden></span></button>` +
    `<label class="permission-control" title="本次任务的工具权限；不会改变运行中任务">${icon('shield',{size:14})}<select id="chat-permission-mode" class="permission-mode" aria-label="任务权限"><option value="ask">请求批准</option><option value="review">帮我审核</option><option value="full">完全权限</option></select>${icon('chevronDown',{size:12})}</label>` +
    '<span class="composer-hint" id="composer-hint">Enter 发送 · Shift+Enter 换行</span>' +
    '</div>' +
    '<div class="composer-right">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="guidance-annotate" hidden>批注反馈</button><button type="button" class="btn btn-ghost btn-sm" id="guidance-queue-add" hidden>候选排队</button>' +
    `<button type="button" class="btn btn-danger btn-sm stop-btn is-hidden" id="stop-btn">${icon('stop', { size: 14 })}<span>停止</span></button>` +
    `<button type="button" class="btn btn-primary send-btn" id="send-btn" title="发送">${icon('send', { size: 17 })}<span>发送</span></button>` +
    '</div></div></div>' +
    '<div class="attach-list" id="attach-list" hidden></div>' +
    '<div id="guidance-queue" aria-live="polite"></div>' +
    '</div>' +
    '</section>' +
    '</div>'
  );
}
