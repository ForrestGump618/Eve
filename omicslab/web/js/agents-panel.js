// Sidebar child-agent panel: team membership is an agent-autonomous runtime
// fact, not a standalone user feature. The panel only observes and opens sessions.
import {api,errorMessage} from './api.js?v=1.5.0';
import {esc,escAttr} from './util.js?v=1.5.0';
import {icon} from './icons.js?v=1.5.0';

const POLL_MS = 8000;
const HIDDEN_POLL_MS = 15000;
const MAX_ROWS = 12;

const statusLabel = {
  draft: '待批准方案', queued: '排队中', running: '运行中', succeeded: '已完成',
  failed: '失败', paused: '已暂停', interrupted: '待恢复', cancelled: '已取消',
  waiting_approval: '待批准', needs_review: '待复核', missing: '任务缺失',
};

function truncate(text, max = 140) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function teamRows(team, captainSession) {
  const members = Array.isArray(team.members) ? team.members : [];
  return members.slice(0, MAX_ROWS).map((member) => {
    const task = member.task || {};
    const node = task.nodes?.work || {};
    return {
      member_id: member.id,
      name: member.name || member.id,
      goal: member.goal || '',
      status: team.draft ? 'draft' : (task.status || 'missing'),
      model: member.model || '',
      provider: member.provider || '',
      conversation_id: node.session_id || null,
      team_id: team.id,
      captain_session: captainSession,
    };
  });
}

export async function mountAgentsPanel(root, {getContext, onSelectConversation, onChanged}) {
  if (!root || typeof getContext !== 'function') return {destroy() {}, refresh() {}};
  let disposed = false;
  let timer = 0;
  let lastHtml = '';
  let generation = 0;

  const section = document.createElement('section');
  section.className = 'sidebar-agents';
  section.id = 'sidebar-agents';
  section.hidden = true;
  section.innerHTML =
    '<div class="sidebar-section-label"><span>' +
    icon('layers', {size: 13}) +
    '<span>子智能体</span></span><span class="sidebar-agents-count" id="sidebar-agents-count"></span></div>' +
    '<div class="sidebar-agents-body" id="sidebar-agents-body"><p class="sw-muted">正在读取…</p></div>';
  const conversationSection = root.querySelector('#conv-list')?.closest('section');
  if (conversationSection && conversationSection.nextSibling) {
    conversationSection.after(section);
  } else {
    const files = root.querySelector('.project-files');
    if (files) files.before(section);
    else root.append(section);
  }
  const body = section.querySelector('#sidebar-agents-body');
  const count = section.querySelector('#sidebar-agents-count');

  function schedule() {
    clearTimeout(timer);
    if (disposed) return;
    timer = setTimeout(() => {
      if (document.hidden) schedule();
      else void refresh();
    }, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
  }

  async function refresh() {
    if (disposed) return;
    const token = generation;
    const {conversationId, scope} = getContext();
    if (!conversationId || !scope) {
      update(null, token);
      schedule();
      return;
    }
    try {
      const data = await api.request(
        `/api/teams?captain_session=${encodeURIComponent(conversationId)}&scope=${encodeURIComponent(scope)}`,
        {quiet: true},
      );
      if (disposed || token !== generation) return;
      const teams = Array.isArray(data.items) ? data.items : [];
      const rows = teams.flatMap((team) => {
        const members = teamRows(team, conversationId);
        return {id: team.id, title: team.title || '协作方案', draft: Boolean(team.draft), archived: Boolean(team.archived), members};
      });
      update(rows.length ? rows : null, token);
    } catch (error) {
      if (disposed || token !== generation || error?.name === 'AbortError') return;
      update(null, token, error);
    } finally {
      schedule();
    }
  }

  function update(teams, token, error = null) {
    if (disposed || token !== generation) return;
    const html = render(teams, error);
    section.hidden = !teams;
    if (html !== lastHtml) {
      body.innerHTML = html;
      lastHtml = html;
      const total = teams ? teams.reduce((sum, team) => sum + team.members.length, 0) : 0;
      count.textContent = total > 0 ? String(total) : '';
      if (typeof onChanged === 'function') onChanged(total);
    }
  }

  function render(teams, error) {
    if (!teams) {
      return error
        ? `<p class="sidebar-agents-note" role="alert">${esc(truncate(errorMessage(error), 120))}</p>`
        : '<p class="sidebar-agents-note">暂无协作成员。</p>';
    }
    return teams.map((team) => {
      const controls = team.draft
        ? `<button type="button" class="btn btn-sm btn-primary" data-approve="${escAttr(team.id)}">批准并运行</button>`
        : '';
      return (
        `<div class="sidebar-agents-team" data-team="${escAttr(team.id)}">` +
        `<div class="sidebar-agents-team-head"><strong>${esc(truncate(team.title, 60))}</strong>` +
        `<span class="team-status ${team.draft ? 'data-draft' : ''}">${esc(team.draft ? statusLabel.draft : '协作中')}</span></div>` +
        `<div class="sidebar-agents-roster">${team.members.map((member) => memberRow(member, team.draft)).join('')}</div>` +
        (controls ? `<div class="sidebar-agents-actions">${controls}</div>` : '') +
        '</div>'
      );
    }).join('');
  }

  function memberRow(member, draft) {
    const label = statusLabel[member.status] || member.status || '任务缺失';
    const metaBits = [member.provider && member.model ? `${member.provider} / ${member.model}` : member.model].filter(Boolean);
    const conversation = member.conversation_id
      ? `<button type="button" class="btn btn-ghost btn-sm" data-open="${escAttr(member.conversation_id)}" title="打开该子智能体会话，可继续对话">对话</button>`
      : '<span class="sidebar-agents-wait">等待分配会话</span>';
    return (
      `<div class="sidebar-agent-row" data-member="${escAttr(member.member_id)}">` +
      `<span class="agent-state is-${escAttr(member.status)}"></span>` +
      '<div class="sidebar-agent-main">' +
      `<div class="sidebar-agent-name">${esc(member.name)}<span class="team-status" data-status="${escAttr(member.status)}">${draft ? '方案内' : esc(label)}</span></div>` +
      `<p>${esc(truncate(member.goal, 110))}</p>` +
      (metaBits.length ? `<span class="sidebar-agent-meta">${esc(metaBits.join(' · '))}</span>` : '') +
      '</div>' +
      `<div class="sidebar-agent-actions">${conversation}</div>` +
      '</div>'
    );
  }

  section.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-open]');
    if (open && typeof onSelectConversation === 'function') {
      onSelectConversation(open.dataset.open);
      return;
    }
    const approve = event.target.closest('[data-approve]');
    if (!approve) return;
    approve.disabled = true;
    try {
      const {scope} = getContext() || {};
      await api.request(`/api/teams/${encodeURIComponent(approve.dataset.approve)}/approve?scope=${encodeURIComponent(scope)}`, {method: 'POST', body: {}});
      await refresh();
    } catch (error) {
      if (!disposed) body.insertAdjacentHTML('afterbegin', `<p class="sidebar-agents-note" role="alert">${esc(errorMessage(error))}</p>`);
    } finally {
      approve.disabled = false;
    }
  });

  await refresh();
  return {
    refresh,
    destroy() {
      disposed = true;
      generation += 1;
      clearTimeout(timer);
      section.remove();
    },
  };
}
