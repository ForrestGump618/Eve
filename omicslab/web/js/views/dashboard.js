// Research overview. All figures come from the platform dashboard projection;
// controls only change the local presentation and never start a second runner.
import {api, errorMessage} from '../api.js?v=1.0.0';
import {icon} from '../icons.js?v=1.0.0';
import {esc, escAttr, fmtDuration, fmtNum, getPref, relTime, setPref, truncate} from '../util.js?v=1.0.0';
import {getState, navigate, setState} from '../store.js?v=1.0.0';
import {emit} from '../bus.js?v=1.0.0';
import {spinnerHtml} from '../ui.js?v=1.0.0';

const RUN_LABELS = {
  queued: '排队中',
  preparing: '准备中',
  running: '执行中',
  waiting_approval: '等待确认',
  stopping: '正在停止',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '待恢复',
};

const INSIGHT_LABELS = {
  memory: '记忆',
  skill: '技能',
  follow_up: '后续课题',
  workflow: '流程',
  correction: '修正',
};

const RANGE_OPTIONS = [7, 30];
const METRIC_OPTIONS = [
  {id: 'tokens', label: 'Token', short: 'Token'},
  {id: 'requests', label: '请求数', short: '请求'},
  {id: 'duration_ms', label: '平均耗时', short: '耗时'},
  {id: 'cost', label: '估算成本', short: '成本'},
];

// SVG coordinates are chart geometry, not interface sizing. The rendered chart
// remains fluid through viewBox and CSS.
const CHART = {
  width: 720,
  height: 224,
  left: 56,
  right: 18,
  top: 18,
  bottom: 30,
  gridLines: 4,
};

const state = {
  data: null,
  rangeDays: RANGE_OPTIONS.includes(Number(getPref('dashboardRangeDays', 7)))
    ? Number(getPref('dashboardRangeDays', 7))
    : 7,
  metric: METRIC_OPTIONS.some((item) => item.id === getPref('dashboardMetric', 'tokens'))
    ? getPref('dashboardMetric', 'tokens')
    : 'tokens',
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function boundedPercent(value) {
  return Math.max(0, Math.min(100, Math.round(finite(value))));
}

function compactNumber(value) {
  const number = finite(value);
  return new Intl.NumberFormat('zh-CN', {
    notation: number >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(number);
}

function formatCost(value) {
  const number = finite(value);
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: number > 0 && number < 1 ? 2 : 0,
    maximumFractionDigits: number > 0 && number < 1 ? 6 : 3,
  }).format(number);
}

function when(value) {
  if (!value) return '';
  const timestamp = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  return relTime(timestamp) || '';
}

function nextAction(wish) {
  const action = wish?.next_action;
  if (!action) return '等待下一步';
  return action.label || action.stage || '继续推进';
}

function currentMetric() {
  return METRIC_OPTIONS.find((item) => item.id === state.metric) || METRIC_OPTIONS[0];
}

function visibleRows() {
  const rows = Array.isArray(state.data?.trends?.days) ? state.data.trends.days : [];
  return rows.slice(-Math.max(1, state.rangeDays));
}

function metricValue(row, metric = state.metric) {
  if (metric === 'duration_ms') return finite(row?.duration_ms);
  if (metric === 'cost') return finite(row?.cost);
  if (metric === 'requests') return finite(row?.requests);
  return finite(row?.tokens);
}

function formatMetricValue(value, metric = state.metric) {
  if (metric === 'duration_ms') return fmtDuration(finite(value)) || '0 ms';
  if (metric === 'cost') {
    return state.data?.metrics?.pricing_configured ? formatCost(value) : '未配置';
  }
  if (metric === 'requests') return `${fmtNum(finite(value))} 次`;
  return `${compactNumber(value)} Token`;
}

function metricSummary(rows, metric = state.metric) {
  if (!rows.length) return {value: '—', detail: '当前范围没有数据'};
  if (metric === 'tokens') {
    const input = rows.reduce((sum, row) => sum + finite(row.input_tokens), 0);
    const output = rows.reduce((sum, row) => sum + finite(row.output_tokens), 0);
    return {
      value: `${compactNumber(input + output)} Token`,
      detail: `输入 ${compactNumber(input)} · 输出 ${compactNumber(output)}`,
    };
  }
  if (metric === 'requests') {
    const total = rows.reduce((sum, row) => sum + finite(row.requests), 0);
    return {
      value: `${fmtNum(total)} 次请求`,
      detail: `日均 ${(total / Math.max(1, rows.length)).toFixed(total < rows.length ? 1 : 0)} 次`,
    };
  }
  if (metric === 'duration_ms') {
    const active = rows.map((row) => finite(row.duration_ms)).filter((value) => value > 0);
    const average = active.length ? active.reduce((sum, value) => sum + value, 0) / active.length : 0;
    const longest = active.length ? Math.max(...active) : 0;
    return {
      value: average ? fmtDuration(average) : '暂无耗时',
      detail: active.length ? `最长 ${fmtDuration(longest)} · ${active.length} 天有记录` : '运行结束后记录耗时',
    };
  }
  const total = rows.reduce((sum, row) => sum + finite(row.cost), 0);
  return {
    value: state.data?.metrics?.pricing_configured ? formatCost(total) : '未配置价格',
    detail: state.data?.metrics?.pricing_configured ? '按设置中的模型价格估算' : '设置模型价格后显示成本',
  };
}

function dateLabel(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5).replace('-', '/') : text;
}

function tooltipText(row, metric) {
  const tokens = `输入 ${compactNumber(row.input_tokens)} · 输出 ${compactNumber(row.output_tokens)}`;
  const runs = `${fmtNum(row.runs)} 次运行 · ${fmtNum(row.succeeded)} 完成 · ${fmtNum(row.failed)} 异常`;
  return {
    title: `${row.date} · ${METRIC_OPTIONS.find((item) => item.id === metric)?.label || metric}`,
    value: formatMetricValue(metricValue(row, metric), metric),
    detail: metric === 'tokens' ? tokens : metric === 'cost' && !state.data?.metrics?.pricing_configured ? '价格未配置' : runs,
  };
}

function chartSvg(rows, metric) {
  const values = rows.map((row) => metricValue(row, metric));
  const hasData = values.some((value) => value > 0);
  if (!hasData) {
    const message = metric === 'cost' && !state.data?.metrics?.pricing_configured
      ? '设置模型价格后可查看成本趋势。'
      : '当前范围没有可展示的用量。';
    return `<div class="dashboard-chart-empty">${icon('info', {size: 18})}<span>${esc(message)}</span></div>`;
  }

  const width = CHART.width;
  const height = CHART.height;
  const plotWidth = width - CHART.left - CHART.right;
  const plotHeight = height - CHART.top - CHART.bottom;
  const baseline = CHART.top + plotHeight;
  const maximum = Math.max(1, ...values);
  const xAt = (index) => CHART.left + (rows.length === 1 ? plotWidth / 2 : (plotWidth * index) / (rows.length - 1));
  const yAt = (value) => CHART.top + plotHeight - (value / maximum) * plotHeight;
  const points = rows.map((row, index) => {
    const value = values[index];
    return {row, value, x: xAt(index), y: yAt(value)};
  });
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(2)} ${baseline} L${points[0].x.toFixed(2)} ${baseline} Z`;
  const ticks = Array.from({length: CHART.gridLines + 1}, (_, index) => {
    const y = CHART.top + (plotHeight * index) / CHART.gridLines;
    return `<line class="dashboard-chart-grid" x1="${CHART.left}" y1="${y}" x2="${width - CHART.right}" y2="${y}"/>`;
  }).join('');
  const xTickCount = rows.length <= 3 ? rows.length : 4;
  const xTickIndexes = [...new Set(Array.from({length: xTickCount}, (_, index) => (
    Math.round((index * (rows.length - 1)) / Math.max(1, xTickCount - 1))
  )))];
  const xTicks = xTickIndexes.map((index) => {
    const anchor = index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle';
    return `<text class="dashboard-chart-axis" x="${xAt(index)}" y="${height - 8}" text-anchor="${anchor}">${esc(dateLabel(rows[index].date))}</text>`;
  }).join('');
  const focusPoints = points.map((point, index) => {
    const text = tooltipText(point.row, metric);
    const label = `${text.title}，${text.value}，${text.detail}`;
    return `<g class="dashboard-chart-point" data-chart-point="${index}" tabindex="0" role="img" aria-label="${escAttr(label)}">
      <circle class="dashboard-chart-hit" cx="${point.x}" cy="${point.y}" r="10"/>
      <circle class="dashboard-chart-dot" cx="${point.x}" cy="${point.y}" r="3"/>
    </g>`;
  }).join('');
  const summary = metricSummary(rows, metric);
  return `<svg class="dashboard-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="dashboard-chart-title dashboard-chart-summary">
    <title id="dashboard-chart-title">近 ${state.rangeDays} 天${currentMetric().label}趋势</title>
    <desc id="dashboard-chart-summary">${esc(`${summary.value}，${summary.detail}`)}</desc>
    <defs>
      <linearGradient id="dashboard-area-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" class="dashboard-chart-fill-start"/>
        <stop offset="100%" class="dashboard-chart-fill-end"/>
      </linearGradient>
    </defs>
    ${ticks}
    <line class="dashboard-chart-cursor" data-chart-cursor x1="0" y1="${CHART.top}" x2="0" y2="${baseline}" hidden/>
    <path class="dashboard-chart-area" d="${area}"/>
    <path class="dashboard-chart-line" d="${line}"/>
    ${xTicks}
    ${focusPoints}
  </svg>
  <div class="dashboard-chart-tooltip" data-chart-tooltip hidden>
    <strong data-chart-tooltip-title></strong>
    <span data-chart-tooltip-value></span>
    <small data-chart-tooltip-detail></small>
  </div>`;
}

function metricCard({label, value, detail, iconName, target, attention = false}) {
  return `<button type="button" class="dashboard-metric${attention ? ' is-attention' : ''}" data-dashboard-target="${escAttr(target)}" aria-label="${escAttr(`${label}：${value}。${detail}`)}">
    <span class="dashboard-metric-icon">${icon(iconName, {size: 17})}</span>
    <strong>${esc(value)}</strong>
    <span>${esc(label)}</span>
    <small>${esc(detail || '')}</small>
    <span class="dashboard-metric-go">${icon('chevronRight', {size: 14})}</span>
  </button>`;
}

function emptyCard(hint, action, label) {
  return `<div class="dashboard-empty">
    <p>${esc(hint)}</p>
    <button type="button" class="btn btn-ghost btn-sm" data-dashboard="${escAttr(action)}">${esc(label)}</button>
  </div>`;
}

function trendCard() {
  const rows = visibleRows();
  const metric = currentMetric();
  const summary = metricSummary(rows, metric.id);
  const metricButtons = METRIC_OPTIONS.map((item) => `
    <button type="button" class="seg-btn${item.id === metric.id ? ' is-active' : ''}" data-dashboard-metric="${item.id}" aria-pressed="${item.id === metric.id}">${esc(item.short)}</button>
  `).join('');
  const rangeButtons = RANGE_OPTIONS.map((days) => `
    <button type="button" class="seg-btn${days === state.rangeDays ? ' is-active' : ''}" data-dashboard-range="${days}" aria-pressed="${days === state.rangeDays}">${days} 天</button>
  `).join('');
  return `<section class="dashboard-card dashboard-trend" id="dashboard-trend" tabindex="-1">
    <header class="dashboard-card-head">
      <div><h2>使用趋势</h2><p>Token、请求、耗时与成本。</p></div>
      <div class="dashboard-chart-controls">
        <div class="segmented" role="group" aria-label="趋势指标">${metricButtons}</div>
        <div class="segmented" role="group" aria-label="时间范围">${rangeButtons}</div>
      </div>
    </header>
    <div class="dashboard-chart-summary" aria-live="polite">
      <strong>${esc(summary.value)}</strong>
      <span>${esc(summary.detail)}</span>
    </div>
    <div class="dashboard-chart-stage">${chartSvg(rows, metric.id)}</div>
    <footer class="dashboard-chart-foot">按模型实际上报用量统计；没有记录的日期显示为零。</footer>
  </section>`;
}

function outcomeCard(metrics) {
  const succeeded = finite(metrics.succeeded_runs);
  const failed = finite(metrics.failed_runs);
  const total = Math.max(finite(metrics.total_runs), succeeded + failed);
  const other = Math.max(0, total - succeeded - failed);
  const denominator = Math.max(1, total);
  const groups = [
    {key: 'succeeded', label: '完成', value: succeeded},
    {key: 'failed', label: '异常', value: failed},
    {key: 'other', label: '进行中 / 其它', value: other},
  ];
  return `<section class="dashboard-card dashboard-outcomes" id="dashboard-outcomes" tabindex="-1">
    <header class="dashboard-card-head">
      <div><h2>运行结果</h2><p>已记录任务的完成与异常分布。</p></div>
      <span class="dashboard-outcome-rate">${finite(metrics.success_rate).toFixed(1)}%<small>成功率</small></span>
    </header>
    <div class="dashboard-outcome-summary">
      <strong>${fmtNum(total)}</strong><span>次运行</span>
    </div>
    <div class="dashboard-outcome-bar" role="img" aria-label="${escAttr(groups.map((group) => `${group.label} ${group.value} 次`).join('，'))}">
      ${groups.map((group) => `<span class="dashboard-outcome-segment" data-outcome="${group.key}" tabindex="0" title="${escAttr(`${group.label}：${group.value} 次`)}" style="--dashboard-share:${((group.value / denominator) * 100).toFixed(2)}%" aria-label="${escAttr(`${group.label} ${group.value} 次，占 ${Math.round((group.value / denominator) * 100)}%`)}"></span>`).join('')}
    </div>
    <div class="dashboard-outcome-legend">
      ${groups.map((group) => `<div data-outcome="${group.key}"><span class="dashboard-outcome-dot"></span><span>${esc(group.label)}</span><strong>${fmtNum(group.value)}</strong></div>`).join('')}
    </div>
    <div class="dashboard-outcome-stats">
      <div><span>平均耗时</span><strong>${metrics.avg_duration_ms ? fmtDuration(metrics.avg_duration_ms) : '暂无'}</strong></div>
      <div><span>模型请求</span><strong>${fmtNum(metrics.requests)}</strong></div>
      <div><span>平均延迟</span><strong>${metrics.avg_latency_ms ? fmtDuration(metrics.avg_latency_ms) : '暂无'}</strong></div>
    </div>
  </section>`;
}

function projectRows(wishes) {
  return wishes.map((wish) => {
    const progress = wish.progress || {};
    const percent = boundedPercent(progress.percent);
    const stage = progress.current_stage || wish.phase || '规划中';
    return `<button type="button" class="dashboard-project" data-wish="${escAttr(wish.id)}" aria-label="${escAttr(`打开课题：${wish.title || '未命名课题'}，进度 ${percent}%`)}">
      <span class="dashboard-project-main">
        <span class="dashboard-project-title"><strong>${esc(wish.title || '未命名课题')}</strong><span>${percent}%</span></span>
        <span class="dashboard-project-stage">${esc(stage)}<span>·</span>${esc(nextAction(wish))}</span>
        <span class="dashboard-progress-track" role="progressbar" aria-label="${escAttr(`${wish.title || '课题'}进度`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="--dashboard-progress:${percent}%"></span></span>
        <small>${esc(`${progress.recorded ?? 0}/${progress.total ?? 0} 个阶段`)}${wish.blockers_count ? ` · ${wish.blockers_count} 个阻塞项` : ''}</small>
      </span>
      <span class="dashboard-project-time">${esc(when(wish.updated_at))}</span>
      ${icon('chevronRight', {size: 15})}
    </button>`;
  }).join('');
}

function planRows(plans) {
  return plans.map((plan) => {
    const owner = plan.owner === 'user' ? '你' : '智能体';
    return `<button type="button" class="dashboard-plan" data-wish="${escAttr(plan.wish_id)}">
      <span class="dashboard-plan-owner" data-owner="${escAttr(plan.owner || 'agent')}">${esc(owner)}</span>
      <span class="dashboard-plan-copy">
        <strong>${esc(plan.label || plan.stage || '推进下一阶段')}</strong>
        <span>${esc(plan.wish_title || '科研课题')}</span>
        ${plan.reason ? `<small>${esc(truncate(plan.reason, 92))}</small>` : ''}
      </span>
      <span class="dashboard-project-time">${esc(when(plan.updated_at))}</span>
    </button>`;
  }).join('');
}

function conversationRows(conversations) {
  return conversations.map((conversation) => `
    <button type="button" class="dashboard-conversation" data-conversation="${escAttr(conversation.id)}">
      <span>${icon('chat', {size: 15})}</span>
      <span class="dashboard-conversation-copy">
        <strong>${esc(conversation.title || '未命名会话')}</strong>
        <small>${esc(conversation.message_count ? `${conversation.message_count} 条消息` : '继续对话')}</small>
      </span>
      <span class="dashboard-project-time">${esc(when(conversation.updated_at))}</span>
    </button>`).join('');
}

function runRows(runs) {
  return runs.map((run) => `
    <button type="button" class="dashboard-run" data-conversation="${escAttr(run.session_id || '')}" ${run.session_id ? '' : 'disabled'}>
      <span class="dashboard-run-state" data-status="${escAttr(run.status || '')}"></span>
      <span class="dashboard-run-copy">
        <strong>${esc(RUN_LABELS[run.status] || run.status || '运行')}</strong>
        <small>${esc(when(run.created_at))}${run.duration_ms ? ` · ${esc(fmtDuration(run.duration_ms))}` : ''}</small>
      </span>
      <span class="dashboard-run-tokens">${esc(compactNumber(run.tokens || run.usage?.total_tokens))}</span>
    </button>`).join('');
}

function insightRows(insights) {
  return insights.map((candidate) => `
    <button type="button" class="dashboard-insight" data-insight="${escAttr(candidate.id)}">
      <span class="dashboard-insight-kind">${esc(INSIGHT_LABELS[candidate.kind] || candidate.kind || '建议')}</span>
      <strong>${esc(candidate.title || '待确认建议')}</strong>
      <p>${esc(truncate(candidate.summary || '', 150))}</p>
    </button>`).join('');
}

function literatureCard(literature) {
  const today = literature?.today || {};
  const proactive = literature?.proactive || {};
  const last = literature?.last_run || {};
  const items = [
    {label: '今日入库', value: fmtNum(today.papers), note: '公开文献'},
    {label: '精读', value: fmtNum(today.deep_read), note: '待审核方法'},
    {label: '反思', value: fmtNum(literature?.reflections_pending), note: '待你审核'},
    {label: '技能候选', value: fmtNum(literature?.skill_candidates_pending), note: '默认停用'},
    {label: '朋友圈', value: fmtNum(literature?.feed_posts), note: `今日 ${fmtNum(today.feed)} 条`},
    {label: '主动分享', value: fmtNum(proactive.queued), note: `今日已发 ${fmtNum(proactive.sent_today)}`},
  ];
  return `<section class="dashboard-card dashboard-literature" id="dashboard-literature" tabindex="-1">
    <header class="dashboard-card-head">
      <div><h2>文献雷达</h2></div>
      <button type="button" class="btn btn-ghost btn-sm" data-dashboard="literature">打开文献雷达</button>
    </header>
    <div class="dashboard-literature-grid">
      ${items.map(item => `<div class="dashboard-literature-stat"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong><small>${esc(item.note)}</small></div>`).join('')}
    </div>
    <footer class="dashboard-card-foot">
      <span>${last.finished_at ? `上次循环 ${esc(when(last.finished_at))}` : (literature?.enabled ? '等待首次循环' : '文献雷达已关闭')}</span>
      ${Array.isArray(last.warnings) && last.warnings.length ? `<span class="is-warning">${fmtNum(last.warnings.length)} 个来源提示</span>` : '<span>来源故障彼此隔离</span>'}
    </footer>
  </section>`;
}

function render(data) {
  const metrics = data.metrics || {};
  const wishes = Array.isArray(data.wishes) ? data.wishes : [];
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const insights = Array.isArray(data.insights) ? data.insights : [];
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const dream = data.dreaming || {};
  const literature = data.literature || {};
  const brief = data.brief || {};
  const averageProgress = wishes.length
    ? wishes.reduce((sum, wish) => sum + boundedPercent(wish.progress?.percent), 0) / wishes.length
    : 0;

  return `<div class="dashboard-page">
    <header class="dashboard-head">
      <div>
        <span class="dashboard-eyebrow">${esc(getState().workspace?.name || data.scope || '当前工作区')}</span>
        <h1>研究总览</h1>
        <p>课题进度、运行质量与资源用量。</p>
      </div>
      <div class="dashboard-head-actions">
        <button type="button" class="btn btn-ghost btn-sm dashboard-icon-btn" data-dashboard="refresh" aria-label="刷新总览" title="刷新">${icon('refresh', {size: 16})}</button>
        <button type="button" class="btn btn-primary btn-sm" data-dashboard="new-wish">新建课题</button>
      </div>
    </header>

    <div class="dashboard-brief" aria-label="当前摘要">
      <span><strong>${fmtNum(brief.user_actions)}</strong> 项待你处理</span>
      <span><strong>${fmtNum(brief.agent_actions)}</strong> 项可继续</span>
      <span><strong>${fmtNum(metrics.running_runs)}</strong> 项运行中</span>
      ${brief.blocked_wishes ? `<span class="is-warning"><strong>${fmtNum(brief.blocked_wishes)}</strong> 个受阻课题</span>` : ''}
    </div>

    <section class="dashboard-metrics" aria-label="研究指标">
      ${metricCard({
        label: '课题平均进度',
        value: `${Math.round(averageProgress)}%`,
        detail: `${fmtNum(metrics.active_wishes)} 个进行中的课题`,
        iconName: 'discovery',
        target: 'dashboard-projects',
      })}
      ${metricCard({
        label: '运行成功率',
        value: `${finite(metrics.success_rate).toFixed(1)}%`,
        detail: `${fmtNum(metrics.succeeded_runs)} 完成 · ${fmtNum(metrics.failed_runs)} 异常`,
        iconName: 'checkCircle',
        target: 'dashboard-outcomes',
        attention: finite(metrics.failed_runs) > 0,
      })}
      ${metricCard({
        label: '累计 Token',
        value: compactNumber(metrics.tokens),
        detail: `${fmtNum(metrics.requests)} 次模型请求`,
        iconName: 'cpu',
        target: 'dashboard-trend',
      })}
      ${metricCard({
        label: '平均运行耗时',
        value: metrics.avg_duration_ms ? fmtDuration(metrics.avg_duration_ms) : '暂无',
        detail: `${fmtNum(metrics.total_runs)} 次已记录运行`,
        iconName: 'clock',
        target: 'dashboard-outcomes',
      })}
    </section>

    <div class="dashboard-analytics">
      ${trendCard()}
      ${outcomeCard(metrics)}
    </div>

    <div class="dashboard-grid">
      <section class="dashboard-card dashboard-projects" id="dashboard-projects" tabindex="-1">
        <header class="dashboard-card-head">
          <div><h2>进行中的课题</h2><p>阶段进度与下一步。</p></div>
          ${wishes.length ? `<button type="button" class="btn btn-ghost btn-sm" data-dashboard="research">查看全部</button>` : ''}
        </header>
        <div class="dashboard-project-list">${projectRows(wishes) || emptyCard('暂无课题。', 'new-wish', '新建课题')}</div>
      </section>

      <section class="dashboard-card dashboard-plans" id="dashboard-plans" tabindex="-1">
        <header class="dashboard-card-head">
          <div><h2>后续计划</h2><p>按处理方与更新时间排列。</p></div>
          <span class="dashboard-card-count">${fmtNum(plans.length)}</span>
        </header>
        <div class="dashboard-plan-list">${planRows(plans) || '<p class="dashboard-card-empty">没有待执行节点。</p>'}</div>
      </section>

      <section class="dashboard-card dashboard-activity" id="dashboard-activity" tabindex="-1">
        <header class="dashboard-card-head">
          <div><h2>最近运行</h2><p>状态、耗时与 Token。</p></div>
          <button type="button" class="btn btn-ghost btn-sm" data-dashboard="workbench">打开工作台</button>
        </header>
        <div class="dashboard-run-list">${runRows(runs) || '<p class="dashboard-card-empty">还没有运行记录。</p>'}</div>
      </section>

      <section class="dashboard-card dashboard-conversations" id="dashboard-conversations" tabindex="-1">
        <header class="dashboard-card-head">
          <div><h2>最近会话</h2><p>按更新时间排列。</p></div>
        </header>
        <div class="dashboard-conversation-list">${conversationRows(conversations) || '<p class="dashboard-card-empty">还没有会话记录。</p>'}</div>
      </section>

      ${literatureCard(literature)}

      <section class="dashboard-card dashboard-insights" id="dashboard-insights" tabindex="-1">
        <header class="dashboard-card-head">
          <div><h2>经验建议</h2><p>确认后写入记忆或技能。</p></div>
          <button type="button" class="btn btn-ghost btn-sm" data-dashboard="dreaming">${dream.enabled ? '管理经验整理' : '设置经验整理'}</button>
        </header>
        <div class="dashboard-insight-list">${insightRows(insights) || `<div class="dashboard-empty"><p>${dream.enabled ? '暂无待确认建议。' : '经验整理未开启。'}</p><button type="button" class="btn btn-ghost btn-sm" data-dashboard="dreaming">${dream.enabled ? '立即整理' : '查看设置'}</button></div>`}</div>
        ${dream.last_run?.finished_at ? `<footer class="dashboard-card-foot">上次整理：${esc(when(dream.last_run.finished_at))}</footer>` : ''}
      </section>
    </div>
  </div>`;
}

function hideChartTooltip(stage, force = false) {
  if (!stage) return;
  const active = document.activeElement;
  if (!force && active?.matches?.('[data-chart-point]') && stage.contains(active)) return;
  const tooltip = stage.querySelector('[data-chart-tooltip]');
  const cursor = stage.querySelector('[data-chart-cursor]');
  if (tooltip) tooltip.hidden = true;
  if (cursor) cursor.hidden = true;
}

function showChartTooltip(point) {
  const stage = point.closest('.dashboard-chart-stage');
  const tooltip = stage?.querySelector('[data-chart-tooltip]');
  const cursor = stage?.querySelector('[data-chart-cursor]');
  const index = Number(point.dataset.chartPoint);
  const row = visibleRows()[index];
  if (!stage || !tooltip || !row) return;
  const metric = currentMetric().id;
  const text = tooltipText(row, metric);
  tooltip.querySelector('[data-chart-tooltip-title]').textContent = text.title;
  tooltip.querySelector('[data-chart-tooltip-value]').textContent = text.value;
  tooltip.querySelector('[data-chart-tooltip-detail]').textContent = text.detail;
  tooltip.hidden = false;
  const stageRect = stage.getBoundingClientRect();
  const pointRect = point.getBoundingClientRect();
  const localX = pointRect.left + pointRect.width / 2 - stageRect.left;
  const localY = pointRect.top - stageRect.top;
  const half = tooltip.offsetWidth / 2;
  tooltip.style.left = `${Math.max(half, Math.min(stageRect.width - half, localX))}px`;
  tooltip.style.top = `${localY}px`;
  tooltip.dataset.side = localY < tooltip.offsetHeight + 16 ? 'below' : 'above';
  const hit = point.querySelector('.dashboard-chart-hit');
  if (cursor && hit) {
    const x = hit.getAttribute('cx');
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.hidden = false;
  }
  stage.querySelectorAll('.dashboard-chart-point.is-selected').forEach((node) => {
    if (node !== point) node.classList.remove('is-selected');
  });
  point.classList.add('is-selected');
}

function updateAnalytics(root, focusSelector = '') {
  const host = root.querySelector('.dashboard-analytics');
  if (!host || !state.data) return;
  host.outerHTML = `<div class="dashboard-analytics">${trendCard()}${outcomeCard(state.data.metrics || {})}</div>`;
  if (focusSelector) root.querySelector(focusSelector)?.focus({preventScroll: true});
}

export async function mount(root) {
  let disposed = false;
  let fetchController = new AbortController();
  const listeners = new AbortController();

  root.innerHTML = `<div class="dashboard-page dashboard-loading">${spinnerHtml('正在读取研究概览…')}</div>`;

  async function load({quiet = false} = {}) {
    if (disposed) return;
    if (!quiet) root.innerHTML = `<div class="dashboard-page dashboard-loading">${spinnerHtml('正在读取研究概览…')}</div>`;
    fetchController.abort();
    fetchController = new AbortController();
    try {
      const scope = getState().workspaceId || 'ws_main';
      const data = await api.request(`/api/platform/dashboard?scope=${encodeURIComponent(scope)}`, {
        quiet: true,
        signal: fetchController.signal,
      });
      if (disposed) return;
      state.data = data;
      root.innerHTML = render(data);
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      root.innerHTML = `<div class="dashboard-page"><div class="dashboard-card dashboard-error">
        <h2>总览暂时不可用</h2>
        <p>${esc(errorMessage(error))}</p>
        <button type="button" class="btn btn-primary btn-sm" data-dashboard="refresh">重试</button>
      </div></div>`;
    }
  }

  const onClick = (event) => {
    const chartPoint = event.target.closest('[data-chart-point]');
    if (chartPoint) {
      chartPoint.focus({preventScroll: true});
      showChartTooltip(chartPoint);
      return;
    }
    const metric = event.target.closest('[data-dashboard-metric]')?.dataset.dashboardMetric;
    if (metric) {
      state.metric = metric;
      setPref('dashboardMetric', metric);
      updateAnalytics(root, `[data-dashboard-metric="${metric}"]`);
      return;
    }
    const range = Number(event.target.closest('[data-dashboard-range]')?.dataset.dashboardRange);
    if (RANGE_OPTIONS.includes(range)) {
      state.rangeDays = range;
      setPref('dashboardRangeDays', range);
      updateAnalytics(root, `[data-dashboard-range="${range}"]`);
      return;
    }
    const target = event.target.closest('[data-dashboard-target]')?.dataset.dashboardTarget;
    if (target) {
      const section = root.querySelector(`#${target}`);
      section?.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
      section?.focus({preventScroll: true});
      return;
    }
    const conversation = event.target.closest('[data-conversation]');
    if (conversation?.dataset.conversation) {
      const id = conversation.dataset.conversation;
      setPref('activeConversationId', id);
      setState({activeConversationId: id});
      navigate('workbench');
      emit('chat:select', id);
      return;
    }
    const wish = event.target.closest('[data-wish]');
    if (wish) {
      navigate('research', {section: 'wishes', wishId: wish.dataset.wish});
      return;
    }
    const insight = event.target.closest('[data-insight]');
    if (insight) {
      navigate('settings', {section: 'dreaming', candidateId: insight.dataset.insight});
      return;
    }
    const action = event.target.closest('[data-dashboard]')?.dataset.dashboard;
    if (!action) return;
    if (action === 'refresh') void load();
    else if (action === 'new-wish') navigate('research', {section: 'wishes'});
    else if (action === 'dreaming') navigate('settings', {section: 'dreaming'});
    else if (action === 'literature') navigate('literature');
    else if (action === 'research') navigate('research');
    else if (action === 'workbench') navigate('workbench');
  };

  const onPointerOver = (event) => {
    const point = event.target.closest('[data-chart-point]');
    if (point) showChartTooltip(point);
  };

  const onPointerOut = (event) => {
    const stage = event.target.closest('.dashboard-chart-stage');
    if (stage && !stage.contains(event.relatedTarget)) hideChartTooltip(stage);
  };

  const onFocusIn = (event) => {
    const point = event.target.closest('[data-chart-point]');
    if (point) showChartTooltip(point);
  };

  const onFocusOut = (event) => {
    const stage = event.target.closest('.dashboard-chart-stage');
    if (stage && !stage.contains(event.relatedTarget)) hideChartTooltip(stage);
  };

  const onKeyDown = (event) => {
    const point = event.target.closest('[data-chart-point]');
    if (!point) return;
    if (event.key === 'Escape') {
      hideChartTooltip(point.closest('.dashboard-chart-stage'), true);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const points = [...point.closest('.dashboard-chart-stage').querySelectorAll('[data-chart-point]')];
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const next = points[Math.max(0, Math.min(points.length - 1, points.indexOf(point) + offset))];
    if (next && next !== point) {
      event.preventDefault();
      next.focus();
    }
  };

  root.addEventListener('click', onClick, {signal: listeners.signal});
  root.addEventListener('pointerover', onPointerOver, {signal: listeners.signal});
  root.addEventListener('pointerout', onPointerOut, {signal: listeners.signal});
  root.addEventListener('focusin', onFocusIn, {signal: listeners.signal});
  root.addEventListener('focusout', onFocusOut, {signal: listeners.signal});
  root.addEventListener('keydown', onKeyDown, {signal: listeners.signal});
  await load();

  return {
    destroy() {
      disposed = true;
      fetchController.abort();
      listeners.abort();
      root.innerHTML = '';
    },
  };
}
