/**
 * Run detail modal / drawer (CONTRACTS-3 §3 + task book T04/T09).
 *
 * Shows one Run's snapshot, its Trace timeline (with after_seq pagination and
 * a lightweight client-side replay), approval records and usage. Used from the
 * chat live bubble, the session run list and child task cards.
 */

import { api, errorMessage } from './api.js?v=1.3.0';
import { icon } from './icons.js?v=1.3.0';
import { esc, escAttr, cleanValue, fmtClock, fmtDuration, truncate, setPref } from './util.js?v=1.3.0';
import { openModal, spinnerHtml, toastError, toastSuccess, toastWarn, confirmDialog } from './ui.js?v=1.3.0';
import {navigate,setState} from './store.js?v=1.3.0';
import {emit} from './bus.js?v=1.3.0';

const RUN_LABELS = {
  queued: '排队中',
  preparing: '准备中',
  running: '运行中',
  waiting_approval: '等待审批',
  stopping: '正在停止',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '状态待确认',
};

const RUN_ACTIVE = new Set(['queued', 'preparing', 'running', 'waiting_approval', 'stopping']);
const EVENT_LIMIT = 500;
const POLL_MS = 2500;
const REPLAY_MS = 140;

const EVENT_META = {
  run_status: { icon: 'dot', title: '状态变化', cls: 'is-status' },
  step: { icon: 'clockPlay', title: '步骤', cls: 'is-step' },
  status: { icon: 'info', title: '状态', cls: 'is-status' },
  text: { icon: 'chat', title: '输出', cls: 'is-text' },
  reasoning: { icon: 'brain', title: '推理', cls: 'is-reasoning' },
  tool_call: { icon: 'wand', title: '工具调用', cls: 'is-tool' },
  tool_result: { icon: 'checkCircle', title: '工具结果', cls: 'is-tool' },
  approval_request: { icon: 'shield', title: '审批请求', cls: 'is-approval' },
  approval_resolved: { icon: 'checkCircle', title: '审批结果', cls: 'is-approval' },
  child_run: { icon: 'layers', title: '子任务', cls: 'is-child' },
  figure: { icon: 'figures', title: '图表', cls: 'is-figure' },
  usage: { icon: 'cpu', title: '用量', cls: 'is-usage' },
  error: { icon: 'alert', title: '错误', cls: 'is-error' },
  stop_reason: { icon: 'shield', title: '停止原因', cls: 'is-status' },
  resource_degraded: { icon: 'cpu', title: '自动资源降级', cls: 'is-status' },
  done: { icon: 'checkCircle', title: '结束', cls: 'is-done' },
  user_message: { icon: 'chat', title: '用户消息', cls: 'is-user' },
  heartbeat: { icon: 'dot', title: '心跳', cls: 'is-heartbeat' },
};

function runLabel(status) {
  return RUN_LABELS[status] || status || '未知状态';
}

function runChip(status, extra = '') {
  return `<span class="run-chip is-${escAttr(status || 'unknown')} ${extra}">${esc(runLabel(status))}</span>`;
}

function payloadSummary(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  switch (event.type) {
    case 'run_status':
      return `状态：${runLabel(data.status)}`;
    case 'step':
      return `${data.label || data.name || '步骤'}${data.status ? ` · ${data.status}` : ''}`;
    case 'status':
    case 'status_text':
      return data.text || data.message || '';
    case 'text':
      return data.delta || '';
    case 'reasoning':
      return data.delta || '';
    case 'tool_call':
      return `${data.name || '工具'}${data.arguments ? ` ${truncate(JSON.stringify(data.arguments), 160)}` : ''}`;
    case 'tool_result':
      return `${data.ok === false ? '失败' : '成功'}${data.preview ? ` · ${truncate(String(data.preview), 200)}` : ''}`;
    case 'approval_request':
      return `工具 ${data.tool || ''}${data.reason ? `：${data.reason}` : ''}`;
    case 'approval_resolved':
      return data.approved || data.decision !== 'deny' ? '已批准' : '已拒绝';
    case 'child_run': {
      const status = data.status === 'running' ? '开始' : runLabel(data.status);
      return `${data.agent_id || '子任务'} · ${status}${data.task_id ? ` · ${data.task_id}` : ''}`;
    }
    case 'figure':
      return data.title || data.path || '已生成图表';
    case 'usage':
      return data.total_tokens != null ? `共 ${data.total_tokens} tokens` : '用量更新';
    case 'error':
      return data.message || '运行出错';
    case 'stop_reason':
      return `${data.code || ''} · ${data.message || ''}`;
    case 'resource_degraded':
      return '接近本轮用量限制，已缩短输出并裁剪工具结果。';
    case 'done':
      return `结束：${runLabel(data.status)}${data.finish_reason ? ` · ${data.finish_reason}` : ''}`;
    case 'user_message':
      return data.content || data.message || '';
    default:
      return data.message || data.text || '';
  }
}

function eventTs(event) {
  const raw = event.ts;
  if (typeof raw === 'number') return fmtClock(new Date(raw * 1000).toISOString());
  if (typeof raw === 'string' && raw) {
    const num = Number(raw);
    if (Number.isFinite(num) && raw.length < 12) return fmtClock(new Date(num * 1000).toISOString());
    return fmtClock(raw);
  }
  return '';
}

function eventRowHtml(event) {
  const meta = EVENT_META[event.type] || { icon: 'dot', title: event.type || '事件', cls: '' };
  const summary = payloadSummary(event);
  const body =
    event.type === 'text' || event.type === 'reasoning'
      ? `<div class="run-event-text">${esc(truncate(summary, 1200))}</div>`
      : `<div class="run-event-summary">${esc(truncate(summary, 300))}</div>`;
  return (
    `<div class="run-event ${meta.cls}" data-seq="${escAttr(String(event.seq ?? ''))}">` +
    `<span class="run-event-dot">${icon(meta.icon, { size: 13 })}</span>` +
    '<div class="run-event-main">' +
    `<div class="run-event-head"><span class="run-event-title">${esc(meta.title)}</span>` +
    `<span class="run-event-seq">#${esc(String(event.seq ?? ''))}</span>` +
    `<span class="run-event-time">${esc(eventTs(event))}</span></div>` +
    body +
    '</div></div>'
  );
}

/** Merge consecutive text/status frames so the timeline stays readable. */
function timelineRows(events) {
  const rows = [];
  for (const event of events) {
    if (event.type === 'heartbeat') continue;
    if (event.type === 'text' && rows.length) {
      const last = rows[rows.length - 1];
      if (last.type === 'text') {
        last.data = { ...(last.data || {}), delta: String((last.data?.delta || '') + (event.data?.delta || '')) };
        last.seqEnd = event.seq;
        continue;
      }
    }
    rows.push({ ...event, seqEnd: event.seq });
  }
  return rows;
}

/**
 * Open the run detail modal.
 * @param {{runId: string, traceId?: string, title?: string}} opts
 * @returns {{close: () => void}}
 */
export function openRunDetail(opts = {}) {
  const runId = String(opts.runId || '');
  if (!runId) {
    toastWarn('缺少运行 ID，无法打开运行详情');
    return { close() {} };
  }
  const state = {
    runId,
    traceId: opts.traceId || '',
    run: null,
    events: [],
    lastSeq: 0,
    maxSeq: 0,
    hasMore: false,
    loading: true,
    error: null,
    tab: 'timeline',
    replay: false,
    replayIndex: 0,
    replayTimer: 0,
    pollTimer: 0,
  };

  const modal = openModal({
    title: `运行详情 · ${runId}`,
    size: 'xl',
    bodyClass: 'run-detail-body',
    html: `<div class="run-detail">${spinnerHtml('正在加载运行详情…')}</div>`,
    actions: [
      { label: '刷新', kind: 'ghost', onClick: () => { void refresh(); return false; } },
      { label: '回放', kind: 'ghost', onClick: () => { void toggleReplay(); return false; } },
      { label: '从检查点恢复', kind: 'ghost', onClick: async () => {
        if(state.loading)await refresh();
        if(!state.run?.actions?.resume){toastWarn('该运行没有可恢复的检查点，或尚未停止');return false;}
        const confirmed=await confirmDialog({title:'从检查点恢复',message:'已提交的工具结果会复用。请先核对中断时结果未知的命令；恢复后修改文件、执行代码和安装技能会重新请求批准。',confirmText:'已核对，继续恢复',cancelText:'取消'});
        if(!confirmed)return false;
        try{
          const result=await api.request(`/api/runs/${encodeURIComponent(runId)}/resume`,{method:'POST',body:{confirm_unknown:true}});
          const id=state.run.session_id,run=result.run||result;
          setPref('activeRun.'+id,JSON.stringify({runId:run.run_id,traceId:run.trace_id,status:run.status}));
          setPref('activeConversationId',id);setState({activeConversationId:id});
          if(location.hash==='#/workbench')emit('chat:select',id);else navigate('workbench');
          toastSuccess('已从检查点创建恢复任务');return true;
        }catch(error){toastError(errorMessage(error));return false;}
      } },
      { label: '取消运行', kind: 'danger', onClick: () => { void cancelRun(); return false; } },
      { label: '关闭', kind: 'ghost' },
    ],
    onClose: () => stopTimers(),
  });

  const root = () => modal.body.querySelector('.run-detail');

  function stopTimers() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
    }
    if (state.replayTimer) {
      clearInterval(state.replayTimer);
      state.replayTimer = 0;
    }
    state.replay = false;
  }

  function active() {
    return Boolean(state.run && RUN_ACTIVE.has(state.run.status));
  }

  function headerHtml() {
    const run = state.run || {};
    const ws = run.workspace && typeof run.workspace === 'object' ? run.workspace : {};
    const duration =
      run.started_at && run.ended_at
        ? fmtDuration(Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at)))
        : null;
    const meta = [
      ['智能体', run.agent_id || ''],
      ['会话', run.session_id || ''],
      ['工作区', ws.name || ws.workspace_id || ''],
      ['目录', ws.resolved_path || ''],
      ['开始', run.started_at ? fmtClock(run.started_at) : ''],
      ['结束', run.ended_at ? fmtClock(run.ended_at) : ''],
      ['用时', duration || ''],
      ['结束原因', run.finish_reason || ''],
    ]
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="run-meta-item"><span class="run-meta-label">${esc(k)}</span>` +
          `<span class="run-meta-value">${esc(String(v))}</span></div>`,
      )
      .join('');
    return (
      '<div class="run-detail-head">' +
      `<div class="run-detail-title">${state.traceId ? `<span class="run-detail-trace">${esc(state.traceId)}</span>` : ''}` +
      `${runChip(run.status)}` +
      (active() ? `<span class="run-live-hint">${icon('spinner', { size: 13, cls: 'is-spinning' })}实时更新中</span>` : '') +
      '</div>' +
      `<div class="run-meta-grid">${meta}</div>` +
      (run.error && typeof run.error === 'object' && run.error.message
        ? `<div class="run-error">${icon('alert', { size: 14 })}<span>${esc(run.error.message)}</span></div>`
        : '') +
      '</div>'
    );
  }

  function tabsHtml() {
    const tabs = [
      ['timeline', '时间线', state.events.length],
      ['approvals', '审批', (state.run?.approvals || []).length],
      ['usage', '用量', ''],
    ];
    return (
      '<div class="run-tabs">' +
      tabs
        .map(
          ([id, label, count]) =>
            `<button type="button" class="run-tab${state.tab === id ? ' is-active' : ''}" data-run-tab="${id}">` +
            `${esc(label)}${count !== '' ? `<span class="run-tab-count">${esc(String(count))}</span>` : ''}</button>`,
        )
        .join('') +
      '<div class="run-tabs-spacer"></div>' +
      `<button type="button" class="btn btn-ghost btn-sm" data-run-more ${state.hasMore ? '' : 'disabled'}>加载更多</button>` +
      '</div>'
    );
  }

  function timelineHtml() {
    const rows = timelineRows(state.events);
    if (state.replay) {
      const shown = rows.slice(0, state.replayIndex);
      return (
        `<div class="run-timeline">${shown.map(eventRowHtml).join('') || '<div class="run-empty">回放准备中…</div>'}</div>` +
        `<div class="run-replay-note">回放中 ${state.replayIndex}/${rows.length}</div>`
      );
    }
    if (!rows.length) {
      return '<div class="run-empty">暂无事件记录</div>';
    }
    return `<div class="run-timeline">${rows.map(eventRowHtml).join('')}</div>`;
  }

  function approvalsHtml() {
    const approvals = Array.isArray(state.run?.approvals) ? state.run.approvals : [];
    if (!approvals.length) return '<div class="run-empty">该运行没有审批记录</div>';
    return (
      '<div class="run-approvals">' +
      approvals
        .map((approval) => {
          const target = approval.target && typeof approval.target === 'object' ? approval.target : {};
          const targetBits = [];
          const targetKind = cleanValue(target.kind, 40);
          const targetCwd = cleanValue(target.cwd);
          const targetRoot = cleanValue(target.root);
          if (targetKind) targetBits.push(targetKind === 'ssh' ? 'SSH' : '本机');
          if (targetCwd) targetBits.push(targetCwd);
          else if (targetRoot) targetBits.push(targetRoot);
          const status = approval.status || approval.decision || 'pending';
          const cls = ['approved', 'denied', 'cancelled'].includes(status) ? status : 'pending';
          return (
            `<div class="run-approval is-${esc(cls)}">` +
            `<div class="run-approval-head">${icon('shield', { size: 14 })}<span>${esc(approval.tool || '工具调用')}</span>` +
            `<span class="run-approval-status">${esc(status)}</span></div>` +
            (approval.reason ? `<div class="run-approval-reason">${esc(approval.reason)}</div>` : '') +
            (targetBits.length ? `<div class="run-approval-target">${esc(targetBits.join(' · '))}</div>` : '') +
            `<div class="run-approval-meta">${esc(approval.approval_id || approval.id || '')}` +
            `${approval.created_at ? ` · ${esc(fmtClock(approval.created_at))}` : ''}</div>` +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function usageHtml() {
    const usage = state.run?.usage && typeof state.run.usage === 'object' ? state.run.usage : {};
    const items = Object.entries(usage)
      .filter(([, v]) => typeof v === 'number')
      .map(
        ([k, v]) =>
          `<div class="run-usage-item"><span>${esc(k)}</span><strong>${esc(String(v))}</strong></div>`,
      )
      .join('');
    const result = state.run?.result_text
      ? `<div class="run-section"><div class="run-section-title">结果文本</div><pre class="run-result">${esc(
          truncate(String(state.run.result_text), 8000),
        )}</pre></div>`
      : '';
    return (
      '<div class="run-usage">' +
      (items ? `<div class="run-usage-grid">${items}</div>` : '<div class="run-empty">暂无用量数据</div>') +
      result +
      '</div>'
    );
  }

  function render() {
    const box = root();
    if (!box) return;
    if (state.loading && !state.run) {
      box.innerHTML = spinnerHtml('正在加载运行详情…');
      return;
    }
    if (state.error && !state.run) {
      box.innerHTML =
        '<div class="panel-error">' +
        `<div class="error-card"><div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        `<div class="error-card-title">无法加载运行详情</div></div>` +
        `<div class="error-card-msg">${esc(errorMessage(state.error))}</div>` +
        `<div class="error-card-actions"><button type="button" class="btn btn-ghost btn-sm" data-run-retry>重试</button></div></div></div>`;
      return;
    }
    const body =
      state.tab === 'approvals' ? approvalsHtml() : state.tab === 'usage' ? usageHtml() : timelineHtml();
    box.innerHTML = headerHtml() + tabsHtml() + `<div class="run-tab-body">${body}</div>`;
    if (state.tab === 'timeline' && !state.replay) {
      const tl = box.querySelector('.run-timeline');
      if (tl) tl.scrollTop = tl.scrollHeight;
    }
  }

  async function loadRun() {
    try {
      const data = await api.runtime.getRun(runId);
      const run = data?.run || data || null;
      if (run && typeof run === 'object') state.run = run;
      if (state.run?.trace_id) state.traceId = state.run.trace_id;
      state.error = null;
    } catch (err) {
      state.error = err;
      if (!state.run) toastError(`加载运行失败：${errorMessage(err)}`);
    }
  }

  async function loadEvents(afterSeq = 0, append = false) {
    if (!state.traceId) return;
    try {
      const data = await api.runtime.timeline(state.traceId, afterSeq, EVENT_LIMIT);
      const events = Array.isArray(data?.events) ? data.events : [];
      if (append) state.events = state.events.concat(events.filter((e) => e.seq > state.lastSeq));
      else state.events = events;
      const seqs = state.events.map((e) => Number(e.seq) || 0);
      state.lastSeq = seqs.length ? Math.max(...seqs) : state.lastSeq;
      state.maxSeq = Number(data?.max_seq) || state.maxSeq;
      state.hasMore = Boolean(data?.next_seq && Number(data.next_seq) < state.maxSeq);
      if (state.replay) {
        state.replayIndex = Math.min(state.replayIndex, timelineRows(state.events).length);
      }
    } catch (err) {
      if (!state.events.length) state.error = err;
    }
  }

  async function refresh() {
    state.loading = true;
    if (!state.run) render();
    await loadRun();
    if (state.run && state.run.trace_id) state.traceId = state.run.trace_id;
    await loadEvents(state.lastSeq > 0 ? state.lastSeq : 0, state.lastSeq > 0);
    state.loading = false;
    render();
    schedulePoll();
  }

  function schedulePoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
    }
    if (!active()) return;
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = 0;
      await loadRun();
      await loadEvents(state.lastSeq, true);
      render();
      schedulePoll();
    }, POLL_MS);
  }

  async function cancelRun() {
    if (!state.run) {
      toastWarn('运行信息尚未加载完成');
      return;
    }
    if (!active()) {
      toastWarn(`该运行已结束（${runLabel(state.run.status)}），无需取消`);
      return;
    }
    try {
      await api.runtime.cancelRun(runId);
      toastSuccess('已请求取消该运行');
      await refresh();
    } catch (err) {
      toastError(`取消失败：${errorMessage(err)}`);
    }
  }

  async function toggleReplay() {
    if (state.replay) {
      stopTimers();
      render();
      return;
    }
    if (!state.events.length) {
      toastWarn('暂无事件可回放');
      return;
    }
    state.replay = true;
    state.replayIndex = 0;
    render();
    state.replayTimer = setInterval(() => {
      const total = timelineRows(state.events).length;
      if (state.replayIndex >= total) {
        stopTimers();
        render();
        return;
      }
      state.replayIndex += 1;
      render();
    }, REPLAY_MS);
  }

  async function loadMore() {
    if (!state.hasMore) return;
    await loadEvents(state.lastSeq, true);
    render();
  }

  modal.body.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-run-tab]');
    if (tab) {
      state.tab = tab.dataset.runTab;
      render();
      return;
    }
    if (event.target.closest('[data-run-more]')) {
      void loadMore();
      return;
    }
    if (event.target.closest('[data-run-retry]')) {
      state.error = null;
      void refresh();
    }
  });

  void refresh();
  return { close: () => modal.close() };
}

/** Session-level run list (entry point for historical runs). */
export function openRunList(sessionId, opts = {}) {
  const session = String(sessionId || '');
  if (!session) {
    toastWarn('请先选择一个会话');
    return { close() {} };
  }
  const modal = openModal({
    title: '运行记录',
    size: 'lg',
    html: `<div class="run-list">${spinnerHtml('正在加载运行记录…')}</div>`,
    actions: [{ label: '刷新', kind: 'ghost', onClick: () => { void load(); return false; } }, { label: '关闭', kind: 'ghost' }],
  });
  const box = () => modal.body.querySelector('.run-list');

  async function load() {
    const el = box();
    if (!el) return;
    el.innerHTML = spinnerHtml('正在加载运行记录…');
    try {
      const data = await api.runtime.sessionRuns(session, 30);
      const runs = Array.isArray(data?.runs) ? data.runs : [];
      if (!runs.length) {
        el.innerHTML = '<div class="run-empty">该会话还没有运行记录</div>';
        return;
      }
      el.innerHTML = runs
        .map((run) => {
          const active = RUN_ACTIVE.has(run.status);
          return (
            `<button type="button" class="run-list-item${active ? ' is-active' : ''}" data-run-id="${escAttr(run.run_id || '')}" data-trace-id="${escAttr(run.trace_id || '')}">` +
            `<span class="run-list-status">${runChip(run.status)}</span>` +
            `<span class="run-list-main"><span class="run-list-goal">${esc(truncate(run.result_text || run.client_request_id || run.run_id || '', 120))}</span>` +
            `<span class="run-list-meta">${esc(run.run_id || '')} · ${esc(run.started_at ? fmtClock(run.started_at) : '')}` +
            `${run.usage && run.usage.total_tokens != null ? ` · ${esc(String(run.usage.total_tokens))} tokens` : ''}</span></span>` +
            `<span class="run-list-chevron">${icon('chevronRight', { size: 14 })}</span></button>`
          );
        })
        .join('');
    } catch (err) {
      el.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  modal.body.addEventListener('click', (event) => {
    const item = event.target.closest('[data-run-id]');
    if (!item) return;
    openRunDetail({ runId: item.dataset.runId, traceId: item.dataset.traceId });
  });

  void load();
  return { close: () => modal.close() };
}
