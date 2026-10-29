// Discovery (RSI) view: project list, live run timeline (7 steps), hypothesis
// ledger, evidence, insights, strategy library and report preview.

import { renderMarkdown } from '../markdown.js?v=1.3.0';
import { icon } from '../icons.js?v=1.3.0';
import {
  esc,
  escAttr,
  relTime,
  fmtTime,
  fmtNum,
  truncate,
  uid,
  copyText,
  downloadText,
} from '../util.js?v=1.3.0';
import { api, errorMessage } from '../api.js?v=1.3.0';
import { streamSSE } from '../sse.js?v=1.3.0';
import {
  toastSuccess,
  toastError,
  toastInfo,
  openModal,
  confirmDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.3.0';
import { getState } from '../store.js?v=1.3.0';

const STEP_ORDER = [
  'observe',
  'hypothesize',
  'prioritize',
  'preregister',
  'execute',
  'evaluate',
  'reflect',
];

const STEP_LABELS = {
  observe: '观察',
  hypothesize: '提出假设',
  prioritize: '优先排序',
  preregister: '预注册',
  execute: '执行',
  evaluate: '评估',
  reflect: '反思',
};

const PROJECT_STATUS = {
  idle: { label: '待运行', cls: 'is-idle' },
  running: { label: '运行中', cls: 'is-running' },
  paused: { label: '已暂停', cls: 'is-paused' },
  done: { label: '已完成', cls: 'is-done' },
  failed: { label: '失败', cls: 'is-failed' },
  cancelled: { label: '已取消', cls: 'is-cancelled' },
};

const HYPOTHESIS_STATUS = {
  proposed: { label: '待验证', cls: 'is-proposed' },
  testing: { label: '验证中', cls: 'is-testing' },
  supported: { label: '得到支持', cls: 'is-supported' },
  refuted: { label: '被反驳', cls: 'is-refuted' },
  inconclusive: { label: '不确定', cls: 'is-inconclusive' },
};

const EVIDENCE_KINDS = {
  data: '数据',
  statistics: '统计',
  literature: '文献',
  experiment: '实验',
  critique: '批评',
};

const STRENGTHS = { strong: '强', moderate: '中', weak: '弱' };

const TIMELINE_ICONS = {
  round: 'refresh',
  step: 'dot',
  status: 'info',
  text: 'fileText',
  tool: 'code',
  figure: 'figures',
  hypothesis: 'brain',
  evidence: 'table',
  insight: 'wand',
  strategy: 'layers',
  reflection: 'history',
  report: 'fileText',
  prediction: 'tag',
  outcome: 'checkCircle',
  error: 'alert',
  done: 'checkCircle',
};

const TABS = [
  { id: 'timeline', label: '时间线', icon: 'clockPlay' },
  { id: 'hypotheses', label: '假设', icon: 'brain' },
  { id: 'evidence', label: '证据', icon: 'table' },
  { id: 'insights', label: '洞察', icon: 'wand' },
  { id: 'strategies', label: '策略库', icon: 'layers' },
  { id: 'rounds', label: '轮次', icon: 'history' },
  { id: 'report', label: '报告', icon: 'fileText' },
];

const TIMELINE_LIMIT = 400;

function fmtTs(ts) {
  if (!ts) return '';
  try {
    return fmtTime(ts);
  } catch {
    return '';
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function statusChip(status, extraClass = '') {
  const meta = PROJECT_STATUS[status] || { label: status || '未知', cls: 'is-idle' };
  return `<span class="disc-status ${meta.cls}${extraClass ? ` ${extraClass}` : ''}"><span class="status-dot"></span>${esc(meta.label)}</span>`;
}

function fieldHtml(label, control, hint = '') {
  return (
    `<label class="field"><span class="field-label">${esc(label)}</span>` +
    control +
    (hint ? `<span class="field-hint">${esc(hint)}</span>` : '') +
    '</label>'
  );
}

function toolArgsText(data) {
  const args = data?.arguments ?? data?.args ?? data?.input ?? '';
  if (args && typeof args === 'object') {
    try {
      return truncate(JSON.stringify(args), 300);
    } catch {
      return '';
    }
  }
  return truncate(String(args || data?.summary || ''), 300);
}

function resultText(data) {
  const value = data?.result ?? data?.output ?? data?.summary ?? data?.text ?? '';
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value || '');
}

function normalizeDetail(data) {
  const project = data?.project || (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) || {};
  return {
    project,
    hypotheses: asArray(data?.hypotheses),
    evidence: asArray(data?.evidence),
    insights: asArray(data?.insights),
    strategies: asArray(data?.strategies),
    rounds: asArray(data?.rounds),
  };
}

function buildHistoryTimeline(rounds) {
  const out = [];
  for (const round of asArray(rounds)) {
    const index = round.index ?? round.round ?? '';
    out.push({
      kind: 'round',
      title: `第 ${index || '?'} 轮${round.strategy_id ? ` · 策略 ${round.strategy_id}` : ''}`,
      body: round.plan || '',
      ts: round.started_at,
    });
    if (round.prediction) out.push({ kind: 'prediction', title: '预测', body: round.prediction, ts: round.started_at });
    if (round.success_criteria) {
      out.push({ kind: 'prediction', title: '成功标准', body: round.success_criteria, ts: round.started_at });
    }
    if (round.outcome) out.push({ kind: 'outcome', title: '结果', body: round.outcome, ts: round.ended_at });
    if (round.reward != null && round.reward !== '') {
      out.push({ kind: 'outcome', title: '奖励', body: String(round.reward), ts: round.ended_at });
    }
    if (round.reflection) out.push({ kind: 'reflection', title: '反思', body: round.reflection, ts: round.ended_at });
    if (round.error) out.push({ kind: 'error', title: '错误', body: String(round.error), ts: round.ended_at });
  }
  return out;
}

function timelineEntryHtml(entry) {
  const ic = TIMELINE_ICONS[entry.kind] || 'dot';
  return (
    `<div class="disc-timeline-item is-${escAttr(entry.kind || 'info')}" data-tl-id="${escAttr(entry.id || '')}">` +
    `<div class="disc-timeline-rail"><span class="disc-timeline-dot">${icon(ic, { size: 12 })}</span></div>` +
    '<div class="disc-timeline-body">' +
    '<div class="disc-timeline-head">' +
    `<span class="disc-timeline-title">${esc(entry.title || '')}</span>` +
    (entry.ts ? `<span class="disc-timeline-time">${esc(fmtTs(entry.ts))}</span>` : '') +
    '</div>' +
    (entry.body
      ? `<div class="disc-timeline-text">${esc(truncate(entry.body, 400))}</div>`
      : '') +
    '</div></div>'
  );
}

function stepsHtml(stepStates) {
  return STEP_ORDER.map((step, idx) => {
    const state = stepStates[step] || 'pending';
    const dot = state === 'done' ? icon('check', { size: 12 }) : String(idx + 1);
    return (
      `<div class="disc-step is-${escAttr(state)}">` +
      `<span class="disc-step-dot">${dot}</span>` +
      `<span class="disc-step-label">${esc(STEP_LABELS[step])}</span>` +
      '</div>'
    );
  }).join('');
}

function hypothesisCardHtml(hyp) {
  const status = hyp.status || 'proposed';
  const meta = HYPOTHESIS_STATUS[status] || { label: status, cls: 'is-proposed' };
  const confidence = Math.max(0, Math.min(1, Number(hyp.confidence) || 0));
  const evidenceCount = asArray(hyp.evidence_ids).length;
  const rows = [];
  if (hyp.rationale) rows.push(['依据', hyp.rationale]);
  if (hyp.prediction) rows.push(['预测', hyp.prediction]);
  if (hyp.test_plan) rows.push(['检验计划', hyp.test_plan]);
  if (hyp.success_criteria) rows.push(['成功标准', hyp.success_criteria]);
  const tags = asArray(hyp.tags);
  return (
    `<article class="hypothesis-card ${meta.cls}">` +
    '<div class="hypothesis-head">' +
    `<span class="hypothesis-id">${esc(hyp.id || '假设')}</span>` +
    `<span class="hypothesis-status">${esc(meta.label)}</span>` +
    '</div>' +
    `<div class="hypothesis-statement">${esc(hyp.statement || '')}</div>` +
    rows
      .map(
        ([label, value]) =>
          `<div class="hypothesis-row"><span class="hypothesis-label">${esc(label)}</span><div class="hypothesis-value">${esc(value)}</div></div>`,
      )
      .join('') +
    '<div class="hypothesis-foot">' +
    '<div class="confidence">' +
    `<span class="confidence-label">置信度 ${Math.round(confidence * 100)}%</span>` +
    `<div class="confidence-bar"><span style="width:${Math.round(confidence * 100)}%"></span></div>` +
    '</div>' +
    `<span class="hypothesis-meta">${evidenceCount ? `${evidenceCount} 条证据` : '暂无关联证据'}${
      hyp.round ? ` · 第 ${esc(String(hyp.round))} 轮` : ''
    }</span>` +
    '</div>' +
    (tags.length
      ? `<div class="hypothesis-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
      : '') +
    '</article>'
  );
}

function evidenceCardHtml(evi) {
  const kind = EVIDENCE_KINDS[evi.kind] || evi.kind || '证据';
  const strength = STRENGTHS[evi.strength] || evi.strength || '';
  return (
    '<article class="evidence-card">' +
    '<div class="evidence-head">' +
    `<span class="kind-chip">${esc(kind)}</span>` +
    (strength ? `<span class="tag tag-cyan">强度 ${esc(strength)}</span>` : '') +
    (evi.reproducible === false ? '<span class="tag tag-purple">未复现</span>' : '') +
    `<span class="evidence-time">${esc(relTime(evi.created_at) || '')}</span>` +
    '</div>' +
    `<div class="evidence-summary">${esc(evi.summary || '')}</div>` +
    (evi.result_excerpt
      ? `<pre class="evidence-excerpt">${esc(truncate(evi.result_excerpt, 1200))}</pre>`
      : '') +
    (evi.code
      ? `<details class="evidence-code"><summary>查看代码</summary><pre>${esc(truncate(evi.code, 4000))}</pre></details>`
      : '') +
    '</article>'
  );
}

function insightItemHtml(ins) {
  const confidence = Math.max(0, Math.min(1, Number(ins.confidence) || 0));
  return (
    '<article class="insight-item">' +
    `<div class="insight-icon">${icon('wand', { size: 15 })}</div>` +
    '<div class="insight-body">' +
    `<div class="insight-text">${esc(ins.text || '')}</div>` +
    `<div class="insight-meta">置信度 ${Math.round(confidence * 100)}%${
      ins.round ? ` · 第 ${esc(String(ins.round))} 轮` : ''
    }${asArray(ins.evidence_ids).length ? ` · ${asArray(ins.evidence_ids).length} 条证据` : ''}</div>` +
    '</div></article>'
  );
}

function strategyRowHtml(st) {
  const reward = Number(st.reward);
  return (
    `<tr class="strategy-row">` +
    `<td class="strategy-name">${esc(st.name || '')}${
      st.lineage ? `<span class="strategy-lineage">血缘 ${esc(String(st.lineage))}</span>` : ''
    }</td>` +
    `<td class="strategy-desc">${esc(truncate(st.description || '', 220))}</td>` +
    `<td class="num">${esc(fmtNum(st.uses ?? 0))}</td>` +
    `<td class="num">${esc(fmtNum(st.successes ?? 0))}</td>` +
    `<td class="num">${Number.isFinite(reward) ? esc(reward.toFixed(2)) : '—'}</td>` +
    '</tr>'
  );
}

function roundCardHtml(round) {
  const rows = [];
  if (round.plan) rows.push(['计划', round.plan]);
  if (round.prediction) rows.push(['预测', round.prediction]);
  if (round.outcome) rows.push(['结果', round.outcome]);
  if (round.reflection) rows.push(['反思', round.reflection]);
  if (round.error) rows.push(['错误', round.error]);
  return (
    '<article class="round-card">' +
    '<div class="round-head">' +
    `<span class="round-index">第 ${esc(String(round.index ?? round.round ?? '?'))} 轮</span>` +
    (round.reward != null && round.reward !== ''
      ? `<span class="tag">奖励 ${esc(String(round.reward))}</span>`
      : '') +
    (round.strategy_id ? `<span class="tag tag-cyan">策略 ${esc(round.strategy_id)}</span>` : '') +
    `<span class="round-time">${esc(fmtTs(round.ended_at || round.started_at))}</span>` +
    '</div>' +
    (rows.length
      ? `<div class="round-rows">${rows
          .map(
            ([label, value]) =>
              `<div class="round-row"><span class="round-label">${esc(label)}</span><div class="round-value">${esc(truncate(value, 600))}</div></div>`,
          )
          .join('')}</div>`
      : '<div class="round-empty">本轮暂无记录</div>') +
    '</article>'
  );
}

function layout() {
  return (
    '<div class="page discovery-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">发现</h1>' +
    '<p class="page-subtitle">递归式科研（RSI）：提出假设、设计实验、记录证据，并沉淀可复用的研究策略。</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="discovery-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="discovery-refresh">${icon('refresh', {
      size: 15,
    })}<span>刷新</span></button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="discovery-new">${icon('plus', {
      size: 15,
    })}<span>新建项目</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="discovery-layout">' +
    '<aside class="discovery-list-panel" aria-label="发现项目列表">' +
    '<div class="discovery-list-head">' +
    `<div class="conv-search">${icon('search', { size: 14 })}<input type="search" id="discovery-filter" placeholder="搜索项目" aria-label="搜索项目" /></div>` +
    '<select id="discovery-status" class="input input-sm" aria-label="按状态过滤">' +
    '<option value="all">全部状态</option>' +
    '<option value="idle">待运行</option>' +
    '<option value="running">运行中</option>' +
    '<option value="done">已完成</option>' +
    '<option value="failed">失败</option>' +
    '<option value="cancelled">已取消</option>' +
    '</select>' +
    '</div>' +
    '<div class="discovery-list" id="discovery-projects"></div>' +
    '</aside>' +
    '<section class="discovery-detail" id="discovery-detail" aria-label="项目详情"></section>' +
    '</div>' +
    '</div>'
  );
}

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();

  const el = {
    count: root.querySelector('#discovery-count'),
    projects: root.querySelector('#discovery-projects'),
    detail: root.querySelector('#discovery-detail'),
    filter: root.querySelector('#discovery-filter'),
    status: root.querySelector('#discovery-status'),
    refresh: root.querySelector('#discovery-refresh'),
    newBtn: root.querySelector('#discovery-new'),
  };

  const local = {
    projects: [],
    filter: '',
    statusFilter: 'all',
    activeId: '',
    detail: null,
    tab: 'timeline',
    report: null,
    reportFor: '',
    reportError: '',
    reportLoading: false,
    reportAttempted: false,
    timeline: [],
    liveText: null,
    running: false,
    runProjectId: '',
    abort: null,
    stepStates: {},
    roundNo: 0,
    statusText: '',
  };
  void ctx;

  /* ---------------------------------------------------------------- */
  /* Project list                                                      */
  /* ---------------------------------------------------------------- */

  function syncListedStatus(id, status) {
    if (!id || !status) return;
    const listed = local.projects.find((item) => item.id === id);
    if (listed) listed.status = status;
  }

  function renderProjectList() {
    const query = local.filter.trim().toLowerCase();
    const items = local.projects.filter((proj) => {
      if (local.statusFilter !== 'all' && (proj.status || 'idle') !== local.statusFilter) return false;
      if (!query) return true;
      const haystack = `${proj.title || ''} ${proj.objective || ''} ${proj.domain || ''}`.toLowerCase();
      return haystack.includes(query);
    });
    if (el.count) el.count.textContent = `${local.projects.length} 个项目`;
    if (!items.length) {
      const empty = emptyStateHtml({
        iconName: 'discovery',
        title: local.projects.length ? '没有匹配的项目' : '还没有发现项目',
        hint: local.projects.length
          ? '试试更换搜索词或状态过滤。'
          : '新建项目后，从研究目标开始组织假设、实验与证据。',
        actionLabel: local.projects.length ? '' : '新建项目',
        actionId: local.projects.length ? '' : 'discovery-empty-new',
      });
      el.projects.innerHTML = empty;
      return;
    }
    el.projects.innerHTML = items
      .map((proj) => {
        const active = proj.id === local.activeId;
        const total = Number(proj.max_rounds) || 0;
        const done = Number(proj.rounds_count) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        return (
          `<button type="button" class="discovery-item${active ? ' is-active' : ''}" data-id="${escAttr(
            proj.id || '',
          )}">` +
          '<div class="discovery-item-head">' +
          `<span class="discovery-item-title">${esc(proj.title || proj.id || '未命名项目')}</span>` +
          statusChip(proj.status || 'idle', 'is-sm') +
          '</div>' +
          `<div class="discovery-item-obj">${esc(truncate(proj.objective || '', 90))}</div>` +
          '<div class="discovery-item-meta">' +
          `<span>${icon('history', { size: 12 })} 第 ${esc(fmtNum(done))}${
            total ? ` / ${esc(fmtNum(total))}` : ''
          } 轮</span>` +
          `<span>${esc(relTime(proj.updated_at || proj.created_at) || '')}</span>` +
          '</div>' +
          (proj.status === 'running'
            ? '<div class="discovery-item-progress"><span class="spinner"></span><span>研究中…</span></div>'
            : total > 0
              ? `<div class="discovery-item-bar"><span style="width:${pct}%"></span></div>`
              : '') +
          '</button>'
        );
      })
      .join('');
  }

  async function loadProjects() {
    if (!local.projects.length) el.projects.innerHTML = spinnerHtml('加载发现项目');
    try {
      const data = await api.discovery.listProjects();
      local.projects = Array.isArray(data?.projects)
        ? data.projects
        : Array.isArray(data)
          ? data
          : [];
      renderProjectList();
      if (!local.activeId && local.projects.length) {
        await openProject(local.projects[0].id);
      } else if (!local.projects.length) {
        local.detail = null;
        renderDetail();
      } else if (local.activeId && !local.projects.some((p) => p.id === local.activeId)) {
        await openProject(local.projects[0].id);
      }
    } catch (err) {
      el.projects.innerHTML =
        '<div class="panel-error"><div class="error-card">' +
        `<div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 18 })}</span>` +
        '<div><div class="error-card-title">项目列表加载失败</div></div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        `<div class="error-card-actions"><button type="button" class="btn btn-ghost btn-sm" id="discovery-retry">重试</button></div>` +
        '</div></div>';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Detail                                                            */
  /* ---------------------------------------------------------------- */

  function metaChips(project) {
    const items = [];
    if (project.domain) items.push(`领域 ${project.domain}`);
    if (project.agent) items.push(`智能体 ${project.agent}`);
    const total = Number(project.max_rounds) || 0;
    items.push(`轮次 ${fmtNum(project.current_round ?? 0)}${total ? ` / ${fmtNum(total)}` : ''}`);
    if (project.rounds_count != null) items.push(`已完成 ${fmtNum(project.rounds_count)} 轮`);
    if (project.updated_at) items.push(`更新 ${relTime(project.updated_at)}`);
    return items.map((t) => `<span class="disc-meta-chip">${esc(t)}</span>`).join('');
  }

  function renderDetail() {
    if (!local.detail?.project || !local.activeId) {
      el.detail.innerHTML = emptyStateHtml({
        iconName: 'discovery',
        title: '选择一个发现项目',
        hint: '从左侧选择项目查看假设、证据与报告，或点击「新建项目」开始一次自主发现。',
      });
      return;
    }
    const project = local.detail.project;
    const running = local.running && local.runProjectId === project.id;
    const foreignRunning = !local.running && project.status === 'running';
    const runAction = running
      ? '<button type="button" class="btn btn-danger btn-sm" data-action="stop">' +
        `${icon('stop', { size: 14 })}<span>停止</span></button>`
      : foreignRunning
        ? '<button type="button" class="btn btn-danger btn-sm" data-action="stop">' +
          `${icon('stop', { size: 14 })}<span>停止运行</span></button>`
        : '<button type="button" class="btn btn-primary btn-sm" data-action="run">' +
          `${icon('play', { size: 14 })}<span>运行</span></button>`;

    const runLine = running
      ? '<div class="discovery-run-status">' +
        '<span class="spinner"></span>' +
        `<span id="discovery-run-text">${esc(local.statusText || '智能体正在自主研究…')}</span>` +
        '</div>'
      : foreignRunning
        ? '<div class="discovery-run-status is-warn"><span class="status-dot"></span>' +
          '<span>该项目正在运行（可能来自其他窗口），可点击「停止运行」取消。</span></div>'
        : '';

    el.detail.innerHTML =
      '<div class="discovery-detail-head">' +
      '<div class="discovery-detail-title-row">' +
      `<h2 class="discovery-detail-title">${esc(project.title || '未命名项目')}</h2>` +
      statusChip(project.status || 'idle') +
      '</div>' +
      `<p class="discovery-detail-obj">${esc(project.objective || '')}</p>` +
      `<div class="disc-meta">${metaChips(project)}</div>` +
      (project.data_hints
        ? `<div class="disc-detail-hints">${icon('folder', { size: 13 })}<span>${esc(
            project.data_hints,
          )}</span></div>`
        : '') +
      (project.summary
        ? `<div class="disc-detail-summary">${esc(project.summary)}</div>`
        : '') +
      '<div class="discovery-detail-actions">' +
      runAction +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="refresh">${icon('refresh', {
        size: 15,
      })}<span>刷新</span></button>` +
      `<button type="button" class="btn btn-danger btn-sm" data-action="delete">${icon('trash', {
        size: 15,
      })}<span>删除</span></button>` +
      '</div>' +
      runLine +
      '</div>' +
      `<div class="tabs discovery-tabs">${TABS.map((tab) => {
        const count = tabBadge(tab.id);
        return (
          `<button type="button" class="tab${local.tab === tab.id ? ' is-active' : ''}" data-tab="${tab.id}">` +
          `${icon(tab.icon, { size: 14 })}<span>${tab.label}</span>` +
          (count != null ? `<span class="tab-count">${esc(String(count))}</span>` : '') +
          '</button>'
        );
      }).join('')}</div>` +
      `<div class="discovery-tab-body" id="discovery-tab-body">${tabContentHtml()}</div>`;

    if (local.tab === 'report' && !local.reportAttempted) ensureReport();
  }

  function tabBadge(tabId) {
    const detail = local.detail;
    if (!detail) return null;
    switch (tabId) {
      case 'hypotheses':
        return detail.hypotheses.length || null;
      case 'evidence':
        return detail.evidence.length || null;
      case 'insights':
        return detail.insights.length || null;
      case 'strategies':
        return detail.strategies.length || null;
      case 'rounds':
        return detail.rounds.length || null;
      default:
        return null;
    }
  }

  function renderTabBody() {
    const body = el.detail.querySelector('#discovery-tab-body');
    if (!body) return;
    body.innerHTML = tabContentHtml();
  }

  function tabContentHtml() {
    switch (local.tab) {
      case 'timeline':
        return timelineTabHtml();
      case 'hypotheses':
        return hypothesesTabHtml();
      case 'evidence':
        return evidenceTabHtml();
      case 'insights':
        return insightsTabHtml();
      case 'strategies':
        return strategiesTabHtml();
      case 'rounds':
        return roundsTabHtml();
      case 'report':
        return reportTabHtml();
      default:
        return '';
    }
  }

  function timelineTabHtml() {
    const showSteps = local.running || Object.keys(local.stepStates).length > 0;
    const ribbon = showSteps
      ? `<div class="disc-steps" id="discovery-steps">${stepsHtml(local.stepStates)}</div>`
      : '';
    const entries = local.timeline;
    const list = entries.length
      ? `<div class="discovery-timeline" id="discovery-timeline">${entries
          .map(timelineEntryHtml)
          .join('')}</div>`
      : '<div class="discovery-timeline is-empty" id="discovery-timeline">' +
        emptyStateHtml({
          iconName: 'clockPlay',
          title: local.running ? '正在等待智能体事件…' : '还没有运行记录',
          hint: local.running
            ? '运行后，7 步流程与产出会显示在这里。'
            : '点击「运行」开始自主发现；时间线会按 观察 → 提出假设 → 优先排序 → 预注册 → 执行 → 评估 → 反思 展示每一步。',
        }) +
        '</div>';
    return ribbon + list;
  }

  function hypothesesTabHtml() {
    const hypotheses = local.detail?.hypotheses || [];
    if (!hypotheses.length) {
      return emptyStateHtml({
        iconName: 'brain',
        title: '还没有假设',
        hint: '运行项目后，可检验的假设会写入这里。',
      });
    }
    return `<div class="hypothesis-list">${hypotheses.map(hypothesisCardHtml).join('')}</div>`;
  }

  function evidenceTabHtml() {
    const evidence = local.detail?.evidence || [];
    if (!evidence.length) {
      return emptyStateHtml({
        iconName: 'table',
        title: '还没有证据',
        hint: '执行实验或分析后，结果会登记为证据。',
      });
    }
    return `<div class="evidence-list">${evidence.map(evidenceCardHtml).join('')}</div>`;
  }

  function insightsTabHtml() {
    const insights = local.detail?.insights || [];
    if (!insights.length) {
      return emptyStateHtml({
        iconName: 'wand',
        title: '还没有洞察',
        hint: '证据累积后，跨轮次洞察会显示在这里。',
      });
    }
    return `<div class="insight-list">${insights.map(insightItemHtml).join('')}</div>`;
  }

  function strategiesTabHtml() {
    const strategies = local.detail?.strategies || [];
    if (!strategies.length) {
      return (
        emptyStateHtml({
          iconName: 'layers',
          title: '策略库为空',
          hint: '从内置策略开始，使用次数与奖励会记录在这里。',
          actionLabel: '导入种子策略',
          actionId: 'discovery-seed',
        }) || ''
      );
    }
    return (
      '<div class="table-wrap strategy-table-wrap">' +
      '<table class="data-table strategy-table">' +
      '<thead><tr><th>名称</th><th>说明</th><th class="num">使用</th><th class="num">成功</th><th class="num">奖励</th></tr></thead>' +
      `<tbody>${strategies.map(strategyRowHtml).join('')}</tbody>` +
      '</table></div>'
    );
  }

  function roundsTabHtml() {
    const rounds = local.detail?.rounds || [];
    if (!rounds.length) {
      return emptyStateHtml({
        iconName: 'history',
        title: '还没有轮次记录',
        hint: '每轮运行结束后，这里会记录计划、预测、结果与反思。',
      });
    }
    return `<div class="round-list">${rounds.map(roundCardHtml).join('')}</div>`;
  }

  function reportTabHtml() {
    const project = local.detail?.project;
    if (!project) return '';
    if (local.reportLoading) {
      return `<div class="panel-loading">${spinnerHtml('生成报告预览')}</div>`;
    }
    const hasReport = local.report && local.report.markdown;
    let body;
    if (hasReport) {
      body = `<div class="markdown-body report-preview">${renderMarkdown(local.report.markdown)}</div>`;
    } else if (local.reportError) {
      body =
        '<div class="report-empty">' +
        `<div class="report-empty-title">报告暂不可用</div>` +
        `<div class="report-empty-hint">${esc(local.reportError)}</div>` +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="report-load">重新加载</button>' +
        '</div>';
    } else {
      body =
        '<div class="report-empty">' +
        '<div class="report-empty-title">还没有报告</div>' +
        '<div class="report-empty-hint">项目运行结束后可生成 Markdown 报告；也可以手动触发一次加载。</div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-action="report-load">生成 / 加载报告</button>' +
        '</div>';
    }
    const toolbar = hasReport
      ? '<div class="report-toolbar">' +
        '<span class="toolbar-meta">Markdown 报告</span>' +
        `<button type="button" class="btn btn-ghost btn-sm" data-action="report-copy">${icon('copy', {
          size: 14,
        })}<span>复制 Markdown</span></button>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-action="report-download">${icon('download', {
          size: 14,
        })}<span>下载 .md</span></button>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-action="report-load">${icon('refresh', {
          size: 14,
        })}<span>刷新</span></button>` +
        '</div>'
      : '';
    return toolbar + body;
  }

  /* ---------------------------------------------------------------- */
  /* Report                                                            */
  /* ---------------------------------------------------------------- */

  async function ensureReport(force = false) {
    const project = local.detail?.project;
    if (!project) return;
    if (!force && local.report && local.reportFor === project.id) return;
    if (local.reportLoading) return;
    local.reportAttempted = true;
    local.reportLoading = true;
    local.reportError = '';
    renderTabBody();
    try {
      const data = await api.discovery.report(project.id);
      local.report = {
        project_id: data?.project_id || project.id,
        markdown: data?.markdown || data?.report || '',
      };
      local.reportFor = project.id;
      if (!local.report.markdown) {
        local.reportError = '后端返回的报告为空，可能项目尚未完成运行。';
      }
    } catch (err) {
      local.report = null;
      local.reportFor = '';
      local.reportError = errorMessage(err);
    } finally {
      local.reportLoading = false;
      renderTabBody();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Run (SSE)                                                         */
  /* ---------------------------------------------------------------- */

  function pushTimeline(entry) {
    const item = { id: uid('tl'), ts: Date.now(), ...entry };
    local.timeline.push(item);
    if (local.timeline.length > TIMELINE_LIMIT) {
      local.timeline.splice(0, local.timeline.length - TIMELINE_LIMIT);
    }
    return item;
  }

  function markStep(step) {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < 0) return;
    const states = {};
    STEP_ORDER.forEach((name, i) => {
      states[name] = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    });
    local.stepStates = states;
    local.roundNo = local.roundNo || Number(local.detail?.project?.current_round) || 0;
  }

  function upsertHypothesis(hyp) {
    if (!hyp || !hyp.statement) return;
    const list = local.detail?.hypotheses;
    if (!list) return;
    const idx = list.findIndex((item) => (hyp.id && item.id === hyp.id) || (!hyp.id && item.statement === hyp.statement));
    if (idx >= 0) list[idx] = { ...list[idx], ...hyp };
    else list.push(hyp);
  }

  function upsertEvidence(evi) {
    if (!evi || !evi.summary) return;
    const list = local.detail?.evidence;
    if (!list) return;
    const idx = list.findIndex((item) => (evi.id && item.id === evi.id) || (!evi.id && item.summary === evi.summary));
    if (idx >= 0) list[idx] = { ...list[idx], ...evi };
    else list.push(evi);
  }

  function upsertStrategy(strategy) {
    if (!strategy || !strategy.name) return;
    const list = local.detail?.strategies;
    if (!list) return;
    const idx = list.findIndex(
      (item) => (strategy.id && item.id === strategy.id) || (!strategy.id && item.name === strategy.name),
    );
    if (idx >= 0) list[idx] = { ...list[idx], ...strategy };
    else list.push(strategy);
  }

  function handleDiscoveryEvent(data) {
    const kind = data?.kind || 'info';
    const project = local.detail?.project;
    if (STEP_ORDER.includes(kind)) {
      markStep(kind);
      local.liveText = null;
      pushTimeline({
        kind: 'step',
        title: `第 ${local.roundNo || '?'} 轮 · ${STEP_LABELS[kind]}`,
        body: data.text || data.message || data.summary || '',
        ts: data.ts,
      });
      local.statusText = `第 ${local.roundNo || '?'} 轮 · ${STEP_LABELS[kind]}`;
      return;
    }
    switch (kind) {
      case 'project':
        if (data.project && project) Object.assign(project, data.project);
        if (data.status && project) project.status = data.status;
        break;
      case 'status':
        local.statusText = data.text || data.message || data.status || '运行中…';
        break;
      case 'round': {
        const phase = String(data.phase || '');
        if (phase === 'preregister') {
          markStep('preregister');
          pushTimeline({
            kind: 'round',
            title: `第 ${local.roundNo || '?'} 轮 · 预注册`,
            body: truncate(data.prediction || data.plan || data.success_criteria || '', 400),
            ts: data.ts,
          });
          local.statusText = `第 ${local.roundNo || '?'} 轮 · 预注册`;
          break;
        }
        if (phase === 'evaluate') {
          markStep('evaluate');
          const record = data.round && typeof data.round === 'object' ? data.round : null;
          if (record) {
            const list = local.detail?.rounds;
            if (list) {
              const idx = list.findIndex(
                (item) =>
                  (record.id && item.id === record.id) ||
                  (record.index && item.index === record.index),
              );
              if (idx >= 0) list[idx] = { ...list[idx], ...record };
              else list.push(record);
            }
            if (record.outcome) {
              pushTimeline({
                kind: 'outcome',
                title: `第 ${local.roundNo || '?'} 轮结果`,
                body: truncate(record.outcome, 500),
                ts: data.ts,
              });
            }
          }
          local.statusText = `第 ${local.roundNo || '?'} 轮 · 评估完成`;
          break;
        }
        // phase=observe (or unknown): a new round begins, reset the 7-step ribbon.
        const index = Number(data.round ?? data.index ?? data.round_index ?? 0);
        local.roundNo = index || local.roundNo + 1;
        local.stepStates = {};
        local.liveText = null;
        if (project) project.current_round = local.roundNo;
        markStep('observe');
        const strategyName =
          (data.strategy && typeof data.strategy === 'object' ? data.strategy.name : data.strategy) ||
          data.strategy_name ||
          '';
        pushTimeline({
          kind: 'round',
          title: `第 ${local.roundNo} 轮开始`,
          body: truncate(strategyName || data.plan || data.text || '', 300),
          ts: data.ts,
        });
        local.statusText = `第 ${local.roundNo} 轮 · 观察`;
        break;
      }
      case 'hypothesis': {
        const hyp = data.hypothesis || data;
        upsertHypothesis(hyp);
        local.liveText = null;
        if (data.phase === 'prioritize') markStep('prioritize');
        else if (data.phase === 'evaluate') markStep('evaluate');
        pushTimeline({
          kind: 'hypothesis',
          title: '新假设',
          body: truncate(hyp.statement || data.text || '', 300),
          ts: data.ts,
        });
        break;
      }
      case 'evidence': {
        const evi = data.evidence || data;
        upsertEvidence(evi);
        markStep('execute');
        local.liveText = null;
        pushTimeline({
          kind: 'evidence',
          title: `新证据${evi.strength ? `（${STRENGTHS[evi.strength] || evi.strength}）` : ''}`,
          body: truncate(evi.summary || data.text || '', 300),
          ts: data.ts,
        });
        break;
      }
      case 'insight': {
        const ins = data.insight || data;
        const list = local.detail?.insights;
        if (list && (ins.text || data.text)) list.push({ ...ins, text: ins.text || data.text });
        local.liveText = null;
        pushTimeline({ kind: 'insight', title: '新洞察', body: truncate(ins.text || data.text || '', 300), ts: data.ts });
        break;
      }
      case 'strategy': {
        const strategy = data.strategy || data;
        upsertStrategy(strategy);
        pushTimeline({
          kind: 'strategy',
          title: `策略更新${strategy.name ? `：${strategy.name}` : ''}`,
          body: truncate(strategy.description || data.text || '', 240),
          ts: data.ts,
        });
        break;
      }
      case 'reflection':
        markStep('reflect');
        local.liveText = null;
        pushTimeline({
          kind: 'reflection',
          title: `第 ${local.roundNo || '?'} 轮反思`,
          body: truncate(data.reflection || data.text || '', 500),
          ts: data.ts,
        });
        STEP_ORDER.forEach((step) => {
          local.stepStates[step] = 'done';
        });
        break;
      case 'report': {
        STEP_ORDER.forEach((step) => {
          local.stepStates[step] = 'done';
        });
        const markdown = data.markdown || data.report || '';
        local.report = { project_id: local.activeId, markdown };
        local.reportFor = markdown ? local.activeId : '';
        local.reportAttempted = true;
        local.reportError = '';
        pushTimeline({ kind: 'report', title: '生成研究报告', body: data.title || '报告已写入项目', ts: data.ts });
        break;
      }
      case 'finished': {
        const result = data.result && typeof data.result === 'object' ? data.result : {};
        local.running = false;
        local.statusText = '运行结束';
        STEP_ORDER.forEach((step) => {
          local.stepStates[step] = 'done';
        });
        if (project) {
          project.status = result.status || data.status || 'done';
          if (Number.isFinite(Number(result.rounds))) project.rounds_count = Number(result.rounds);
          syncListedStatus(local.activeId, project.status);
        }
        pushTimeline({
          kind: 'done',
          title: '运行结束',
          body: result.report_path ? `报告已写入 ${result.report_path}` : '项目运行完成。',
        });
        break;
      }
      case 'error': {
        local.statusText = data.message || data.error || '运行出错';
        pushTimeline({ kind: 'error', title: '步骤错误', body: data.message || data.error || '', ts: data.ts });
        break;
      }
      default:
        pushTimeline({
          kind: 'info',
          title: kind,
          body: data.text || data.message || (typeof data === 'object' ? '' : String(data)),
          ts: data.ts,
        });
        break;
    }
  }

  function updateRunStatusDom() {
    const node = el.detail.querySelector('#discovery-run-text');
    if (node) node.textContent = local.statusText || '智能体正在自主研究…';
  }

  function scrollTimeline() {
    const list = el.detail.querySelector('#discovery-timeline');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function afterEvent(type) {
    updateRunStatusDom();
    if (local.tab !== 'timeline') return;
    if (type === 'text' && local.liveText) {
      const entry = el.detail.querySelector(
        `[data-tl-id="${local.liveText.id}"] .disc-timeline-text`,
      );
      if (entry) {
        entry.textContent = truncate(local.liveText.body, 400);
        scrollTimeline();
        return;
      }
    }
    renderTabBody();
    scrollTimeline();
  }

  function handleRunEvent(ev) {
    const type = ev?.type || '';
    const data = ev?.data || {};
    switch (type) {
      case 'connected':
        local.statusText = data.message || '已连接，智能体开始研究…';
        break;
      case 'status':
        local.statusText = data.text || data.message || '处理中…';
        break;
      case 'text': {
        const delta = data.delta || data.text || '';
        if (delta) {
          if (!local.liveText) {
            local.liveText = pushTimeline({ kind: 'text', title: '智能体输出', body: '' });
          }
          local.liveText.body += delta;
        }
        break;
      }
      case 'reasoning':
        local.statusText = '推理中…';
        break;
      case 'tool_call':
        local.liveText = null;
        pushTimeline({
          kind: 'tool',
          title: `调用工具：${data.name || '工具'}`,
          body: toolArgsText(data),
        });
        break;
      case 'tool_result':
        pushTimeline({ kind: 'tool', title: '工具返回', body: truncate(resultText(data), 300) });
        break;
      case 'figure':
        pushTimeline({
          kind: 'figure',
          title: '生成图表',
          body: data.title || data.path || data.name || '',
        });
        break;
      case 'discovery':
        handleDiscoveryEvent(data);
        break;
      case 'usage':
        break;
      case 'error':
        local.statusText = '运行出错';
        pushTimeline({ kind: 'error', title: '运行错误', body: data.message || data.error || '未知错误' });
        break;
      case 'done':
        local.statusText = '已完成';
        local.stepStates = STEP_ORDER.reduce((acc, step) => {
          acc[step] = 'done';
          return acc;
        }, {});
        if (data.project && local.detail?.project) Object.assign(local.detail.project, data.project);
        if (data.status && local.detail?.project) {
          local.detail.project.status = data.status;
          syncListedStatus(local.activeId, data.status);
        }
        pushTimeline({
          kind: 'done',
          title: '运行结束',
          body: data.report ? '报告已生成，可在「报告」标签查看。' : '项目运行完成。',
        });
        break;
      default:
        break;
    }
    afterEvent(type);
  }

  async function runProject() {
    const project = local.detail?.project;
    if (!project || !local.activeId) return;
    if (local.running) {
      toastInfo('已有运行中的发现任务');
      return;
    }
    local.running = true;
    local.runProjectId = project.id;
    local.abort = new AbortController();
    local.timeline = [];
    local.liveText = null;
    local.stepStates = {};
    local.roundNo = Number(project.current_round || project.rounds_count || 0) || 0;
    local.statusText = '正在连接…';
    local.report = null;
    local.reportFor = '';
    local.reportError = '';
    local.reportAttempted = false;
    project.status = 'running';
    syncListedStatus(project.id, 'running');
    renderProjectList();
    renderDetail();

    let error = null;
    let completed = false;
    try {
      const result = await streamSSE(api.discovery.runUrl(project.id), {}, {
        signal: local.abort.signal,
        onEvent: (ev) => {
          try {
            handleRunEvent(ev);
          } catch (err) {
            console.warn('[discovery] 处理事件失败', err);
          }
        },
      });
      completed = Boolean(result?.completed);
      error = result?.error || null;
    } catch (err) {
      error = err;
    }

    const aborted = Boolean(local.abort?.signal?.aborted) || error?.name === 'AbortError';
    local.running = false;
    local.runProjectId = '';
    local.abort = null;
    if (error && !aborted) {
      const conflict = error?.status === 409;
      toastError(conflict ? '该项目已在运行中（可能存在并发任务），请稍后刷新' : `运行失败：${errorMessage(error)}`);
      pushTimeline({ kind: 'error', title: conflict ? '并发冲突' : '运行失败', body: errorMessage(error) });
      renderDetail();
    } else if (aborted) {
      toastInfo('已停止发现任务');
      pushTimeline({ kind: 'status', title: '已停止', body: '用户手动停止' });
      renderDetail();
    } else if (completed) {
      toastSuccess('发现任务已结束');
    } else {
      toastInfo('连接已结束，正在刷新项目数据…');
    }
    await loadProjects();
    if (local.activeId) await openProject(local.activeId, { silent: true });
  }

  async function stopProject() {
    const project = local.detail?.project;
    if (!project) return;
    try {
      await api.discovery.stopRun(project.id);
      toastInfo('已请求停止，等待当前步骤收尾…');
    } catch (err) {
      toastError(`停止失败：${errorMessage(err)}`);
    }
    local.abort?.abort();
  }

  /* ---------------------------------------------------------------- */
  /* Project open / delete / create                                    */
  /* ---------------------------------------------------------------- */

  async function openProject(id, { silent = false } = {}) {
    if (!id) return;
    if (local.running && local.runProjectId !== id) {
      toastInfo('发现任务运行中，请先停止或等待完成后再切换项目');
      return;
    }
    local.activeId = id;
    renderProjectList();
    if (!silent) el.detail.innerHTML = `<div class="panel-loading">${spinnerHtml('加载项目详情')}</div>`;
    try {
      const data = await api.discovery.getProject(id);
      if (local.activeId !== id) return;
      const detail = normalizeDetail(data);
      local.detail = detail;
      if (local.reportFor !== id) {
        local.report = null;
        local.reportFor = '';
        local.reportError = '';
        local.reportAttempted = false;
      }
      if (!local.running || local.runProjectId !== id) {
        local.timeline = buildHistoryTimeline(detail.rounds);
        local.liveText = null;
        local.stepStates = {};
      }
      local.roundNo = Number(detail.project.current_round || detail.project.rounds_count || 0) || local.roundNo;
      syncListedStatus(id, detail.project.status);
      renderDetail();
    } catch (err) {
      el.detail.innerHTML =
        '<div class="panel-error"><div class="error-card">' +
        `<div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 18 })}</span>` +
        '<div><div class="error-card-title">项目详情加载失败</div></div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="refresh">重试</button></div>' +
        '</div></div>';
    }
  }

  async function deleteProject() {
    const project = local.detail?.project;
    if (!project) return;
    const ok = await confirmDialog({
      title: '删除发现项目',
      message: `确定删除「${project.title || project.id}」吗？其假设、证据、策略与报告都会一并删除，且不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.discovery.removeProject(project.id);
      toastSuccess('项目已删除');
      local.detail = null;
      local.activeId = '';
      local.timeline = [];
      local.report = null;
      await loadProjects();
    } catch (err) {
      toastError(`删除失败：${errorMessage(err)}`);
    }
  }

  function agentOptions() {
    const agents = Array.isArray(getState().agents) ? getState().agents : [];
    const options = ['<option value="">默认智能体</option>'];
    for (const agent of agents) {
      const id = agent.id || agent.name || '';
      if (!id) continue;
      options.push(`<option value="${escAttr(id)}">${esc(agent.name || id)}</option>`);
    }
    return `<select class="input" id="np-agent">${options.join('')}</select>`;
  }

  function readNewProject(body) {
    const val = (id) => String(body.querySelector(`#${id}`)?.value || '').trim();
    const num = (id, fallback) => {
      const n = Number(val(id));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const objective = val('np-objective');
    if (!objective) {
      toastError('请填写研究目标');
      body.querySelector('#np-objective')?.focus();
      return null;
    }
    const title = val('np-title') || truncate(objective, 40);
    const payload = {
      title,
      objective,
      max_rounds: num('np-rounds', 3),
      budget_minutes: num('np-budget', 30),
    };
    const domain = val('np-domain');
    if (domain) payload.domain = domain;
    const agent = val('np-agent');
    if (agent) payload.agent = agent;
    const hints = val('np-hints');
    if (hints) payload.data_hints = hints;
    return payload;
  }

  function openNewProjectModal() {
    const html =
      '<form class="form-stack" id="discovery-project-form" autocomplete="off">' +
      fieldHtml(
        '标题',
        '<input class="input" id="np-title" maxlength="120" placeholder="例如：三阴性乳腺癌耐药机制探索" />',
        '留空则自动使用研究目标的前 40 个字符',
      ) +
      fieldHtml(
        '研究目标 *',
        '<textarea class="input" id="np-objective" rows="4" placeholder="描述要回答的科学问题、可用数据与期望产出"></textarea>',
        '目标越具体，假设越可检验',
      ) +
      '<div class="field-grid">' +
      fieldHtml('领域', '<input class="input" id="np-domain" placeholder="如 肿瘤免疫 / 单细胞" />') +
      fieldHtml('智能体', agentOptions()) +
      '</div>' +
      fieldHtml(
        '数据线索',
        '<input class="input" id="np-hints" placeholder="工作区路径或数据说明，例如 data/demo.h5ad" />',
        '可选：用路径或说明标出可用数据',
      ) +
      '<div class="field-grid">' +
      fieldHtml('最大轮数', '<input class="input" type="number" id="np-rounds" min="1" max="20" value="3" />') +
      fieldHtml(
        '预算（分钟）',
        '<input class="input" type="number" id="np-budget" min="1" max="600" value="30" />',
      ) +
      '</div>' +
      '<div class="field-hint">创建后点击「运行」，7 个阶段和产出会显示在这里。</div>' +
      '</form>';

    openModal({
      title: '新建发现项目',
      size: 'md',
      html,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '创建项目',
          kind: 'primary',
          onClick: ({ body }) => {
            const payload = readNewProject(body);
            if (!payload) return false;
            return api.discovery
              .createProject(payload)
              .then(async (data) => {
                const project = data?.project || data;
                toastSuccess('发现项目已创建');
                await loadProjects();
                if (project?.id) await openProject(project.id);
                return undefined;
              })
              .catch((err) => {
                toastError(`创建失败：${errorMessage(err)}`);
                return false;
              });
          },
        },
      ],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  el.refresh.addEventListener('click', async () => {
    el.refresh.disabled = true;
    try {
      await loadProjects();
      if (local.activeId) await openProject(local.activeId, { silent: true });
    } finally {
      el.refresh.disabled = false;
    }
  });

  el.newBtn.addEventListener('click', openNewProjectModal);

  el.filter.addEventListener('input', () => {
    local.filter = el.filter.value;
    renderProjectList();
  });

  el.status.addEventListener('change', () => {
    local.statusFilter = el.status.value;
    renderProjectList();
  });

  el.projects.addEventListener('click', (evt) => {
    if (evt.target.closest('#discovery-retry')) {
      loadProjects();
      return;
    }
    if (evt.target.closest('#discovery-empty-new')) {
      openNewProjectModal();
      return;
    }
    const item = evt.target.closest('.discovery-item');
    if (item?.dataset.id) openProject(item.dataset.id);
  });

  el.detail.addEventListener('click', (evt) => {
    const tabBtn = evt.target.closest('[data-tab]');
    if (tabBtn) {
      const next = tabBtn.dataset.tab;
      if (next && next !== local.tab) {
        local.tab = next;
        renderDetail();
      }
      return;
    }
    const actionEl = evt.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    switch (action) {
      case 'run':
        runProject();
        break;
      case 'stop':
        stopProject();
        break;
      case 'refresh':
        openProject(local.activeId);
        break;
      case 'delete':
        deleteProject();
        break;
      case 'seed-strategies':
        seedStrategies();
        break;
      case 'report-load':
        ensureReport(true);
        break;
      case 'report-copy':
        if (local.report?.markdown) {
          copyText(local.report.markdown).then((ok) => {
            if (ok) toastSuccess('报告 Markdown 已复制');
            else toastError('复制失败，请手动选择文本');
          });
        }
        break;
      case 'report-download':
        if (local.report?.markdown) {
          const title = local.detail?.project?.title || 'discovery-report';
          downloadText(`${String(title).replace(/[\\/:*?"<>|\s]+/g, '_')}.md`, local.report.markdown, 'text/markdown;charset=utf-8');
          toastSuccess('报告已下载');
        }
        break;
      default:
        break;
    }
  });

  async function seedStrategies() {
    try {
      await api.discovery.seedStrategies();
      toastSuccess('种子策略已导入');
      if (local.activeId) await openProject(local.activeId, { silent: true });
    } catch (err) {
      toastError(`导入失败：${errorMessage(err)}`);
    }
  }

  // The seed action lives in the strategies tab empty state.
  el.detail.addEventListener('click', (evt) => {
    if (evt.target.closest('#discovery-seed')) seedStrategies();
  });

  renderDetail();
  await loadProjects();

  return {
    destroy() {
      local.abort?.abort();
      local.abort = null;
      local.running = false;
      root.innerHTML = '';
    },
  };
}
