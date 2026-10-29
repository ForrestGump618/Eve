// Global approval centre (CONTRACTS-3 §7): one dock for every pending tool
// approval, including approvals raised by child tasks of any run.
//
// Sources:
//  * bus event "approval:request" emitted by the chat view from SSE frames;
//  * GET /api/approvals?status=pending polling as a safety net (page reload,
//    approvals raised while the chat view was unmounted).

import { icon } from './icons.js?v=1.5.0';
import { esc, cleanValue } from './util.js?v=1.5.0';
import { api, errorMessage } from './api.js?v=1.5.0';
import { on, emit } from './bus.js?v=1.5.0';
import { toastWarn, toastError, openModal, emptyStateHtml, spinnerHtml } from './ui.js?v=1.5.0';

const POLL_MS = 12000;

const pending = new Map();
let dock = null;
let dockCount = null;
let panelBody = null;
let panelNode = null;
let pollTimer = 0;
let countdownTimer = 0;
let refreshing = false;

function normalizeApproval(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.approval_id || '';
  if (!id) return null;
  const target = raw.target && typeof raw.target === 'object' ? raw.target : {};
  return {
    id,
    tool: raw.tool || '工具调用',
    arguments: raw.arguments ?? raw.args ?? null,
    reason: raw.reason || '',
    runId: raw.run_id || '',
    agentTaskId: raw.agent_task_id || '',
    childRunId: raw.child_run_id || '',
    target: {
      kind: target.kind || (target.connection_id ? 'ssh' : ''),
      root: target.root || '',
      cwd: target.cwd || '',
      connectionId: target.connection_id || '',
    },
    expiresAt: raw.expires_at || '',
  };
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.approvals)) return data.approvals;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.pending)) return data.pending;
  return [];
}

function fmtCountdown(expiresAt) {
  if (!expiresAt) return '';
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return '';
  const left = Math.max(0, ts - Date.now());
  const total = Math.ceil(left / 1000);
  if (total <= 0) return '已超时';
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function targetText(approval) {
  const t = approval.target || {};
  const bits = [];
  const kind = cleanValue(t.kind, 40);
  const connectionId = cleanValue(t.connectionId, 80);
  const cwd = cleanValue(t.cwd);
  const root = cleanValue(t.root);
  if (kind) bits.push(kind === 'ssh' ? 'SSH 主机' : '本机');
  if (connectionId) bits.push(`连接 ${connectionId}`);
  if (cwd) bits.push(`目录 ${cwd}`);
  else if (root) bits.push(`根目录 ${root}`);
  return bits.join(' · ');
}

function prettyArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function renderDock() {
  if (!dock) return;
  const count = pending.size;
  dock.classList.toggle('is-active', count > 0);
  if (dockCount) {
    dockCount.textContent = String(count);
    dockCount.hidden = count === 0;
  }
  dock.title = count ? `审批中心：${count} 项待处理` : '审批中心：暂无待处理项';
}

function approvalItemHtml(approval) {
  const args = prettyArgs(approval.arguments);
  const countdown = fmtCountdown(approval.expiresAt);
  const owners = [];
  if (approval.runId) owners.push(`运行 ${approval.runId}`);
  if (approval.agentTaskId) owners.push(`子任务 ${approval.agentTaskId}`);
  if (approval.childRunId) owners.push(`子运行 ${approval.childRunId}`);
  return (
    `<div class="approval-item" data-approval-id="${esc(approval.id)}">` +
    '<div class="approval-item-head">' +
    `${icon('shield', { size: 16 })}` +
    `<span class="approval-item-tool">${esc(approval.tool)}</span>` +
    '<span class="approval-item-state">待批准</span>' +
    (countdown ? `<span class="approval-countdown" data-expires="${esc(approval.expiresAt)}">${esc(countdown)}</span>` : '') +
    '</div>' +
    (approval.reason ? `<div class="approval-item-reason">${esc(approval.reason)}</div>` : '') +
    (targetText(approval)
      ? `<div class="approval-item-target">${icon('terminal', { size: 13 })}<span>${esc(targetText(approval))}</span></div>`
      : '') +
    (owners.length ? `<div class="approval-item-owner">${esc(owners.join(' · '))}</div>` : '') +
    (args && args !== '{}'
      ? `<details class="approval-item-args"><summary>查看参数</summary><pre>${esc(args)}</pre></details>`
      : '') +
    '<div class="approval-item-actions">' +
    `<button type="button" class="btn btn-primary btn-sm" data-decision="approve">${icon('check', { size: 14 })}<span>批准</span></button>` +
    `<button type="button" class="btn btn-danger btn-sm" data-decision="deny">${icon('close', { size: 14 })}<span>拒绝</span></button>` +
    '</div></div>'
  );
}

function renderPanelBody() {
  if (!panelBody) return;
  const items = [...pending.values()];
  if (!items.length) {
    panelBody.innerHTML = emptyStateHtml({
      iconName: 'shield',
      title: '暂无待审批的操作',
      hint: '待授权操作。',
    });
    return;
  }
  panelBody.innerHTML =
    `<div class="approval-center-list">${items.map(approvalItemHtml).join('')}</div>` +
    '<div class="approval-center-foot">批准 / 拒绝会立即发送给后端；过期项将自动失效。</div>';
}

function updateCountdowns() {
  if (!panelBody) return;
  panelBody.querySelectorAll('.approval-countdown').forEach((node) => {
    const text = fmtCountdown(node.dataset.expires || '');
    if (text) node.textContent = text;
  });
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = 0;
  }
}

function refresh({ silent = true } = {}) {
  if (refreshing) return;
  refreshing = true;
  return api.approvals
    .list({ status: 'pending' })
    .then((data) => {
      const list = extractList(data)
        .map(normalizeApproval)
        .filter(Boolean);
      {
        pending.clear();
        for (const item of list) pending.set(item.id, item);
        renderDock();
        renderPanelBody();
      }
      return list;
    })
    .catch(() => {
      // Older backend without the approval list endpoint: keep bus-driven state.
      return [];
    })
    .finally(() => {
      refreshing = false;
    });
}

function addPending(raw) {
  const approval = normalizeApproval(raw);
  if (!approval) return null;
  pending.set(approval.id, approval);
  renderDock();
  renderPanelBody();
  return approval;
}

function removePending(id) {
  if (!id || !pending.delete(id)) return;
  renderDock();
  renderPanelBody();
}

async function decide(approval, decision, buttons) {
  if (!approval) return;
  const btnList = buttons ? [...buttons] : [];
  btnList.forEach((btn) => {
    btn.disabled = true;
  });
  try {
    await api.approvals.decide(approval.id, decision);
    removePending(approval.id);
    emit('approval:resolved', { id: approval.id, decision });
  } catch (err) {
    btnList.forEach((btn) => {
      btn.disabled = false;
    });
    toastError(`提交审批失败：${errorMessage(err)}`);
  }
}

function openPanel() {
  if (panelNode && panelNode.isConnected) {
    panelNode.querySelector('.approval-item-actions button')?.focus();
    return;
  }
  const modal = openModal({
    title: '审批中心',
    size: 'lg',
    html: '<div class="approval-center" id="approval-center-body"><div class="panel-loading">正在读取审批…</div></div>',
    actions: [
      {
        label: '刷新',
        kind: 'ghost',
        onClick: () => {
          refresh({ silent: false });
          return false;
        },
      },
      { label: '关闭', kind: 'primary' },
    ],
    onClose: () => {
      panelBody = null;
      panelNode = null;
      stopCountdown();
    },
  });
  panelNode = modal.el;
  panelBody = modal.body.querySelector('#approval-center-body');
  panelBody.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-decision]');
    if (!btn) return;
    const item = btn.closest('.approval-item');
    const approval = pending.get(item?.dataset.approvalId || '');
    if (!approval) return;
    decide(approval, btn.dataset.decision === 'deny' ? 'deny' : 'approve', item.querySelectorAll('[data-decision]'));
  });
  renderPanelBody();
  refresh({ silent: false });
  stopCountdown();
  countdownTimer = setInterval(updateCountdowns, 1000);
}

function ensureDock() {
  if (document.getElementById('approval-dock')) {
    dock = document.getElementById('approval-dock');
    dockCount = dock.querySelector('#approval-count');
    return;
  }
  dock = document.createElement('button');
  dock.type = 'button';
  dock.id = 'approval-dock';
  dock.className = 'approval-dock';
  dock.innerHTML =
    `${icon('shield', { size: 16 })}<span class="approval-dock-label">审批</span>` +
    '<span class="approval-badge" id="approval-count" hidden>0</span>';
  dock.addEventListener('click', () => openPanel());
  (document.querySelector('.sidebar-actions') || document.body).appendChild(dock);
  dockCount = dock.querySelector('#approval-count');
}

/** Install the global approval dock. Safe to call once per page lifetime. */
export function initApprovalCenter() {
  ensureDock();
  renderDock();
  on('approval:request', (payload) => addPending(payload));
  on('approval:resolved', (payload) => removePending(payload?.id));
  refresh({ silent: true });
  if (!pollTimer) pollTimer = setInterval(() => {if(!document.hidden)refresh({ silent: true });}, POLL_MS);
  return { refresh, open: openPanel };
}

export function pendingApprovalCount() {
  return pending.size;
}
