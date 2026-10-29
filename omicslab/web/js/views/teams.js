import {api, errorMessage} from '../api.js?v=1.4.0';
import {esc, escAttr, setPref} from '../util.js?v=1.4.0';
import {getState, navigate, setState} from '../store.js?v=1.4.0';
import {on, emit} from '../bus.js?v=1.4.0';
import {openModal, toastError, confirmDialog, promptDialog} from '../ui.js?v=1.4.0';
import {openRunDetail} from '../runview.js?v=1.4.0';
import {teamConfig, teamLabels, deliveryLabels, teamActions, ensureTeamStyles} from '../team-config.js?v=1.4.0';

const actionLabels = {approve: '批准并运行', pause: '暂停', resume: '恢复', cancel: '取消任务', archive: '归档'};
const statusLabel = status => teamLabels[status] || status || '任务缺失';
const button = (label, attrs = '') => `<button type="button" class="btn btn-sm" ${attrs}>${label}</button>`;

export async function mount(root) {
  ensureTeamStyles();
  let disposed = false, timer = 0, generation = 0, listEpoch = 0, archived = false;
  const scope = () => getState().workspaceId || 'ws_main';
  let boundScope = scope(), requests = new AbortController(), createModal = null, createBusy = false;
  const events = new AbortController(), cards = new Map();
  const alive = token => !disposed && token === generation && boundScope === scope();
  const teamUrl = (id, action) => `/api/teams/${encodeURIComponent(id)}/${action}?scope=${encodeURIComponent(boundScope)}`;

  root.innerHTML = `<div class="eve-dashboard team-view">
    <header class="eve-page-header"><div class="team-page-title"><h1>团队协作</h1><p>队长统筹，成员并行；在讨论中同步证据与进展。</p></div>
      <div class="team-toolbar">${button('已归档', 'id="teams-archive-view" aria-pressed="false"')}${button('刷新', 'id="teams-refresh"')}<button type="button" class="btn btn-primary btn-sm" id="team-create">新建团队</button></div></header>
    <div class="team-list-feedback" role="status"></div><div id="team-list" aria-label="协作团队">正在读取团队…</div></div>`;
  const list = root.querySelector('#team-list'), feedback = root.querySelector('.team-list-feedback');
  const refresh = root.querySelector('#teams-refresh');

  function schedule() {
    clearTimeout(timer);
    if (!disposed && !archived && cards.size) timer = setTimeout(() => {
      if (document.hidden) schedule(); else void load();
    }, document.hidden ? teamConfig.hiddenPollMs : teamConfig.pollMs);
  }

  async function load() {
    if (!alive(generation)) return;
    clearTimeout(timer);
    const token = generation, current = ++listEpoch, requestScope = boundScope, archiveView = archived;
    refresh.disabled = true;
    try {
      const data = await api.request(`/api/teams?scope=${encodeURIComponent(requestScope)}&archived=${archiveView}`, {quiet: true, signal: requests.signal});
      if (!alive(token) || current !== listEpoch || archiveView !== archived) return;
      feedback.textContent = '';
      reconcile(data.items || []);
      for (const card of cards.values()) if (card.details.open) void loadDiscussion(card);
    } catch (error) {
      if (!alive(token) || current !== listEpoch || error.name === 'AbortError') return;
      feedback.innerHTML = `<span role="alert">读取团队失败：${esc(errorMessage(error))}</span>${button('重试', 'data-retry-list')}`;
      if (!cards.size) list.textContent = '';
    } finally {
      if (alive(token) && current === listEpoch) { refresh.disabled = false; schedule(); }
    }
  }

  function memberOverview(team) {
    const members = team.members || [], name = id => members.find(member => member.id === id)?.name || id;
    return `<div class="team-captain"><div><strong>队长</strong><span>${team.captain_session ? '主会话统筹与汇总' : '尚未关联队长会话'}</span></div>
      ${team.captain_session ? button('打开队长会话', `data-session="${escAttr(team.captain_session)}"`) : '<span class="team-note">可从主会话创建队长方案</span>'}</div>
      <div class="team-roster-heading"><h3>执行成员</h3><span>${members.length} 位成员 · ${members.filter(member => member.task?.status === 'succeeded').length} 位已完成</span></div>
      <div class="team-roster">${members.map(member => {
        const task = member.task || {}, node = task.nodes?.work || {};
        return `<article class="team-roster-row" data-member-id="${escAttr(member.id)}">
          <div class="team-member-identity"><h4>${esc(member.name || member.id)}</h4><span class="team-note">${esc(member.provider || '默认供应商')} / ${esc(member.model || '默认模型')}</span></div>
          <div class="team-member-goal"><p>${esc(member.goal || '尚未分配目标')}</p><span class="team-dependency">${member.depends_on?.length ? '依赖：' + member.depends_on.map(id => esc(name(id))).join('、') : '无依赖，可独立执行'}</span>
            ${task.error ? `<p class="team-error" role="alert">${esc(task.error)}</p>` : ''}
            ${task.result ? `<details class="team-result"><summary>执行结果</summary><pre>${esc(task.result)}</pre></details>` : ''}</div>
          <div class="team-member-controls"><span class="team-status" data-status="${escAttr(task.status || (team.draft ? 'draft' : 'missing'))}">${esc(team.draft ? '待批准' : statusLabel(task.status))}</span><div class="team-row-actions">
            ${node.run_id ? button('轨迹', `data-run="${escAttr(node.run_id)}"`) : ''}${node.session_id ? button('打开会话', `data-session="${escAttr(node.session_id)}"`) : ''}
            ${!team.draft && !team.archived && member.task ? button('后续任务', `data-member-followup="${escAttr(member.id)}"`) : ''}</div></div></article>`;
      }).join('')}</div>`;
  }

  function newCard(team) {
    const el = document.createElement('section');
    el.className = 'team-card'; el.dataset.team = team.id;
    el.innerHTML = `<div class="team-card-header"></div><div class="team-overview"></div>
      <details class="team-discussion" open><summary>团队讨论与下发</summary>
        <div class="team-discussion-body"><div class="team-discussion-toolbar"><span class="team-message-count">最近 ${teamConfig.messageLimit} 条以内</span>${button('刷新讨论', 'data-retry-discussion')}</div>
          <div class="team-mailbox" role="log" aria-label="团队讨论" aria-live="polite" aria-relevant="additions text" tabindex="0"><p class="team-note">正在读取讨论…</p></div>
          <div class="team-discussion-feedback" role="status"></div><p class="team-readonly" hidden></p>
          <form class="team-discuss-form"><fieldset><legend>向团队下发消息</legend>
            <div class="team-compose-options"><label>收件人<select name="recipient"><option value="all">所有成员（广播）</option><option value="captain">队长</option></select></label>
              <label class="team-wake"><input type="checkbox" name="wake">成员已完成时启动后续任务</label></div>
            <label class="team-content-label">消息<textarea name="content" rows="3" maxlength="${teamConfig.messageMaxLength}" required placeholder="同步用户要求、证据或需要成员复核的问题"></textarea></label>
            <div class="team-compose-footer"><span class="team-note">Ctrl / ⌘ + Enter 下发 · <span class="team-char-count">0</span> / ${teamConfig.messageMaxLength}</span><button class="btn btn-primary btn-sm" type="submit" disabled>广播给所有成员</button></div>
          </fieldset></form><p class="team-note team-delivery-note">讨论会保存在团队信箱；下发状态以每位成员的回执为准。</p></div></details>`;
    return {el, team, details: el.querySelector('.team-discussion'), form: el.querySelector('form'), loaded: false, loading: false, sending: false, messageEpoch: 0, logSignature: '', overviewSignature: '', headerSignature: '', recipientSignature: ''};
  }

  function reconcile(items) {
    const ids = new Set(items.map(team => team.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    if (!cards.size) list.replaceChildren();
    items.forEach((team, index) => {
      let card = cards.get(team.id);
      if (!card) { card = newCard(team); cards.set(team.id, card); }
      card.team = team;
      // Keep discussion and composer nodes stable, including focus, selection and scroll.
      const actions = teamActions(team), heading = JSON.stringify([team.title, team.status, actions]);
      if (heading !== card.headerSignature) {
        card.headerSignature = heading;
        card.el.querySelector('.team-card-header').innerHTML = `<div class="team-card-title"><h2>${esc(team.title || '协作团队')}</h2><span class="team-status" data-status="${escAttr(team.status)}">${esc(statusLabel(team.status))}</span></div><div class="team-card-actions">${actions.map(action => button(actionLabels[action], `data-team-action="${action}" ${action === 'approve' ? 'data-primary' : ''}`)).join('')}</div>`;
      }
      const overview = JSON.stringify([team.captain_session, team.members, team.draft, team.archived]);
      if (overview !== card.overviewSignature) {
        card.overviewSignature = overview;
        const host = card.el.querySelector('.team-overview');
        const openResults = [...host.querySelectorAll('.team-result[open]')].map(node => node.closest('[data-member-id]').dataset.memberId);
        host.innerHTML = memberOverview(team);
        host.querySelectorAll('[data-member-id]').forEach(row => { if (openResults.includes(row.dataset.memberId)) row.querySelector('.team-result')?.setAttribute('open', ''); });
      }
      const recipients = JSON.stringify((team.members || []).map(member => [member.id, member.name]));
      if (recipients !== card.recipientSignature) {
        card.recipientSignature = recipients;
        const select = card.form.elements.recipient, value = select.value;
        select.innerHTML = `<option value="all">所有成员（广播）</option><option value="captain">队长</option>${(team.members || []).map(member => `<option value="${escAttr(member.id)}">${esc(member.name || member.id)}</option>`).join('')}`;
        select.value = [...select.options].some(option => option.value === value) ? value : 'all';
      }
      updateComposer(card);
      if (list.children[index] !== card.el) list.insertBefore(card.el, list.children[index] || null);
    });
    if (!items.length) list.innerHTML = `<div class="eve-empty"><h2>${archived ? '暂无归档团队。' : '暂无团队。'}</h2></div>`;
  }

  function updateComposer(card) {
    const blocked = Boolean(card.team.archived || card.team.draft), form = card.form;
    form.querySelector('fieldset').disabled = blocked;
    form.elements.content.readOnly = card.sending;
    form.elements.recipient.disabled = card.sending;
    form.elements.wake.disabled = card.sending;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = blocked || card.sending || !form.elements.content.value.trim();
    submit.textContent = card.sending ? '正在下发…' : form.elements.recipient.value === 'all' ? '广播给所有成员' : '发送并下发';
    form.querySelector('.team-char-count').textContent = form.elements.content.value.length;
    form.setAttribute('aria-busy', String(card.sending));
    const note = card.el.querySelector('.team-readonly');
    note.hidden = !blocked;
    note.textContent = card.team.archived ? '团队已归档，讨论只读。' : '批准方案后即可向成员下发消息。';
  }

  async function loadDiscussion(card, force = false) {
    const token = generation;
    if (!alive(token) || cards.get(card.team.id) !== card || card.loading || (card.sending && !force)) return;
    const current = ++card.messageEpoch;
    card.loading = true;
    const log = card.el.querySelector('.team-mailbox'), retry = card.el.querySelector('[data-retry-discussion]');
    retry.disabled = true; log.setAttribute('aria-busy', 'true');
    try {
      const result = await api.request(teamUrl(card.team.id, 'messages'), {method: 'POST', body: {}, quiet: true, signal: requests.signal});
      if (!alive(token) || cards.get(card.team.id) !== card || current !== card.messageEpoch) return;
      const rows = (result.items || []).slice(-teamConfig.messageLimit), signature = JSON.stringify(rows);
      if (signature !== card.logSignature) {
        card.logSignature = signature;
        const bottom = !card.loaded || log.scrollHeight - log.scrollTop - log.clientHeight < 36, top = log.scrollTop;
        const name = id => ({all: '所有成员', captain: '队长', user: '你'})[id] || (card.team.members || []).find(member => member.id === id)?.name || id;
        log.innerHTML = rows.map(message => {
          const date = new Date(Number(message.created_at) * 1000), validDate = Number(message.created_at) > 0 && Number.isFinite(date.getTime());
          return `<article class="team-message"><header><strong>${esc(name(message.sender))}<span class="team-message-route">发给 ${esc(name(message.recipient))}</span></strong>${validDate ? `<time datetime="${date.toISOString()}">${esc(date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}))}</time>` : ''}</header><p>${esc(message.content)}</p><div class="team-deliveries">${(message.deliveries || []).map(delivery => `<span>${esc(name(delivery.member))}：${esc(deliveryLabels[delivery.status] || delivery.status)}</span>`).join('') || '<span>已保存在团队信箱</span>'}</div></article>`;
        }).join('') || '<p class="team-empty-discussion">还没有讨论。向所有成员广播要求，或选择一位成员交流。</p>';
        log.scrollTop = bottom ? log.scrollHeight : top;
      }
      card.loaded = true;
      card.el.querySelector('.team-message-count').textContent = `最近 ${rows.length} 条讨论（最多 ${teamConfig.messageLimit} 条）`;
      const notice = card.el.querySelector('.team-discussion-feedback');
      if (notice.dataset.kind === 'read-error') { notice.textContent = ''; delete notice.dataset.kind; }
    } catch (error) {
      if (!alive(token) || current !== card.messageEpoch || error.name === 'AbortError') return;
      const notice = card.el.querySelector('.team-discussion-feedback');
      notice.dataset.kind = 'read-error';
      notice.innerHTML = `<span role="alert">读取讨论失败：${esc(errorMessage(error))}。请点击“刷新讨论”重试。</span>`;
      if (!card.loaded) log.innerHTML = '<p class="team-note">讨论暂时无法读取。</p>';
    } finally {
      if (alive(token) && current === card.messageEpoch) { card.loading = false; retry.disabled = false; log.setAttribute('aria-busy', 'false'); }
    }
  }

  async function send(card) {
    const token = generation, form = card.form, content = form.elements.content.value.trim();
    if (!alive(token) || card.sending || card.team.draft || card.team.archived || !content || content.length > teamConfig.messageMaxLength) return;
    card.sending = true; updateComposer(card);
    const notice = card.el.querySelector('.team-discussion-feedback');
    notice.textContent = ''; delete notice.dataset.kind;
    try {
      // A send supersedes an older mailbox read; late reads must not hide its receipt.
      card.messageEpoch++; card.loading = false;
      await api.request(teamUrl(card.team.id, 'message'), {method: 'POST', body: {recipient: form.elements.recipient.value, content, wake: form.elements.wake.checked}, signal: requests.signal, quiet: true});
      if (!alive(token) || cards.get(card.team.id) !== card) return;
      form.elements.content.value = '';
      notice.textContent = '消息已保存，下发回执见讨论。';
      await loadDiscussion(card, true);
    } catch (error) {
      if (!alive(token) || cards.get(card.team.id) !== card || error.name === 'AbortError') return;
      notice.dataset.kind = 'send-error';
      notice.innerHTML = `<span role="alert">发送失败：${esc(errorMessage(error))}。消息已保留，可重试下发。</span>`;
    } finally {
      if (alive(token) && cards.get(card.team.id) === card) {
        card.sending = false; updateComposer(card);
        if (!card.loading) {
          card.el.querySelector('[data-retry-discussion]').disabled = false;
          card.el.querySelector('.team-mailbox').setAttribute('aria-busy', 'false');
        }
      }
    }
  }

  async function create() {
    if (createBusy || createModal) return;
    const token = generation, requestScope = boundScope, captainSession = getState().activeConversationId;
    createBusy = true; root.querySelector('#team-create').disabled = true;
    try {
      const settings = await api.request('/api/settings', {signal: requests.signal, quiet: true});
      if (!alive(token)) return;
      const providers = Object.values(settings.providers || {}).filter(provider => provider.configured && provider.id !== 'mock');
      const active = settings.llm || {}; let counter = 0;
      const modal = openModal({title: '新建协作团队', size: 'lg', bodyClass: 'team-editor', onClose: () => { if (createModal === modal) createModal = null; },
        html: `<label class="sw-field"><span>团队名称</span><input class="input" id="team-title" maxlength="${teamConfig.titleMaxLength}" value="研究协作"></label><p class="team-note">${captainSession ? '当前主会话作为队长，负责统筹与汇总。' : '尚未选择主会话；也可以先保存成员方案。'}</p><div id="team-edit-members"></div>${button('添加成员', 'id="team-add-member"')}<p class="team-note">依赖填成员 ID，以逗号或空格分隔。无依赖成员并行运行；保存方案后需要批准才会执行。</p>`,
        actions: [{label: '取消', kind: 'ghost'}, {label: '保存方案', kind: 'primary', onClick: async ({body}) => {
          if (!alive(token)) return;
          const members = [...body.querySelectorAll('[data-member]')].map(row => ({
            id: row.dataset.member, name: row.querySelector('[name="name"]').value,
            goal: row.querySelector('[name="goal"]').value.trim(), provider: row.querySelector('[name="provider"]').value,
            model: row.querySelector('[name="model"]').value, permission_mode: row.querySelector('[name="permission"]').value,
            depends_on: row.querySelector('[name="dependencies"]').value.split(/[,，\s]+/).filter(Boolean),
          }));
          if (!members.length || members.some(member => !member.goal)) throw new Error('请为每位成员填写分配目标');
          await api.request(`/api/teams?scope=${encodeURIComponent(requestScope)}`, {method: 'POST', body: {title: body.querySelector('#team-title').value, members, captain_session: captainSession || undefined}, signal: requests.signal});
          if (alive(token)) await load();
        }}]});
      createModal = modal;
      const box = modal.body.querySelector('#team-edit-members'), addButton = modal.body.querySelector('#team-add-member');
      function add() {
        if (!alive(token) || box.children.length >= teamConfig.memberLimit) return;
        const id = 'member' + (++counter), row = document.createElement('section');
        row.className = 'team-edit-member'; row.dataset.member = id;
        row.innerHTML = `<div class="eve-card-heading"><strong>${id}</strong>${button('移除', `data-remove-member aria-label="移除 ${id}"`)}</div><div class="sw-form-grid">
          <label class="sw-field"><span>成员名称</span><input class="input" name="name" value="成员 ${counter}"></label>
          <label class="sw-field"><span>依赖成员 ID</span><input class="input" name="dependencies" placeholder="member1, member2"></label>
          <label class="sw-field"><span>供应商</span><select class="input" name="provider"><option value="">默认供应商</option>${providers.map(provider => `<option value="${escAttr(provider.id)}">${esc(provider.label || provider.id)}</option>`).join('')}</select></label>
          <label class="sw-field"><span>模型</span><input class="input" name="model" placeholder="使用供应商默认模型"></label>
          <label class="sw-field"><span>权限</span><select name="permission"><option value="ask">请求批准</option><option value="review">帮我审核</option><option value="full">完全权限</option></select></label></div>
          <label class="sw-field"><span>分配目标</span><textarea class="input" name="goal" rows="3" required maxlength="${teamConfig.goalMaxLength}" placeholder="明确交付结果、资料和验证要求"></textarea></label>`;
        const provider = row.querySelector('[name="provider"]'), model = row.querySelector('[name="model"]');
        provider.value = active.provider || ''; model.value = active.model || '';
        provider.addEventListener('change', () => { model.value = providers.find(item => item.id === provider.value)?.default_model || ''; }, {signal: events.signal});
        row.querySelector('[data-remove-member]').addEventListener('click', () => { row.remove(); addButton.disabled = false; addButton.focus(); }, {signal: events.signal});
        box.append(row); addButton.disabled = box.children.length >= teamConfig.memberLimit;
      }
      addButton.addEventListener('click', add, {signal: events.signal}); add(); add();
    } catch (error) { if (alive(token) && error.name !== 'AbortError') toastError(errorMessage(error)); }
    finally { if (alive(token)) { createBusy = false; root.querySelector('#team-create').disabled = false; } }
  }

  // Native toggle runs after details changes state, including keyboard activation.
  root.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.matches('.team-discussion') || !details.open) return;
    const card = cards.get(details.closest('[data-team]').dataset.team);
    if (card && !card.loaded) void loadDiscussion(card);
  }, {capture: true, signal: events.signal});
  for (const type of ['input', 'change']) root.addEventListener(type, event => {
    const card = cards.get(event.target.closest('[data-team]')?.dataset.team);
    if (card && event.target.closest('form')) updateComposer(card);
  }, {signal: events.signal});
  root.addEventListener('submit', event => {
    if (!event.target.matches('.team-discuss-form')) return;
    event.preventDefault(); const card = cards.get(event.target.closest('[data-team]').dataset.team); if (card) void send(card);
  }, {signal: events.signal});
  root.addEventListener('keydown', event => {
    if (event.isComposing || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || !event.target.matches('textarea[name="content"]')) return;
    event.preventDefault(); const card = cards.get(event.target.closest('[data-team]').dataset.team); if (card) void send(card);
  }, {signal: events.signal});
  root.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    if (target.matches('[data-retry-list], #teams-refresh')) { void load(); return; }
    if (target.id === 'team-create') { void create(); return; }
    if (target.id === 'teams-archive-view') {
      archived = !archived; resetScope();
      target.textContent = archived ? '活动团队' : '已归档'; target.setAttribute('aria-pressed', String(archived)); void load(); return;
    }
    const card = cards.get(target.closest('[data-team]')?.dataset.team); if (!card) return;
    const token = generation;
    if (target.hasAttribute('data-retry-discussion')) { void loadDiscussion(card); return; }
    if (target.dataset.run) { openRunDetail({runId: target.dataset.run}); return; }
    if (target.dataset.session) {
      const session = target.dataset.session;
      setPref('activeConversationId', session);
      setState({activeConversationId: session}); navigate('workbench'); emit('chat:select', session); return;
    }
    if (!target.dataset.teamAction && !target.dataset.memberFollowup) return;
    target.disabled = true;
    try {
      if (target.dataset.memberFollowup) {
        const member = card.team.members.find(item => item.id === target.dataset.memberFollowup);
        const goal = await promptDialog({title: '成员后续任务', label: '目标', confirmText: '分配任务'});
        if (!alive(token) || cards.get(card.team.id) !== card || !goal?.trim()) return;
        let confirmed = false;
        if (!['succeeded', 'cancelled'].includes(member.task?.status)) {
          confirmed = await confirmDialog({title: '接管成员任务', message: '旧任务将先停止。请核对已执行的外部操作；确认后在原成员会话中分配新目标。', confirmText: '已核对，接管'});
          if (!confirmed || !alive(token)) return;
        }
        await api.request(teamUrl(card.team.id, 'assign'), {method: 'POST', body: {member_id: member.id, goal, confirmed}, signal: requests.signal});
      } else {
        const action = target.dataset.teamAction; let confirmed = false;
        if (action === 'resume') {
          confirmed = await confirmDialog({title: '恢复团队', message: '请核对中断成员已执行的外部操作。已完成成员不会重放，失败成员会从已有会话继续。', confirmText: '已核对，继续'});
          if (!confirmed || !alive(token)) return;
        }
        if (!alive(token)) return;
        const result = await api.request(teamUrl(card.team.id, action), {method: 'POST', body: {confirmed}, signal: requests.signal});
        if (alive(token) && result.errors?.length) toastError(result.errors.join('；'));
      }
      if (alive(token)) await load();
    } catch (error) { if (alive(token) && error.name !== 'AbortError') toastError(errorMessage(error)); }
    finally { if (alive(token) && target.isConnected) target.disabled = false; }
  }, {signal: events.signal});

  function resetScope() {
    generation++; listEpoch++; clearTimeout(timer); requests.abort(); requests = new AbortController();
    createModal?.close(); createModal = null; createBusy = false;
    boundScope = scope(); cards.clear(); list.textContent = '正在读取团队…'; feedback.textContent = '';
    root.querySelector('#team-create').disabled = false;
  }
  const off = on('workspace:change', () => { if (!disposed) { resetScope(); void load(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && alive(generation)) void load(); }, {signal: events.signal});
  await load();
  return {destroy() {
    disposed = true; generation++; listEpoch++; clearTimeout(timer); requests.abort(); events.abort(); off();
    createModal?.close(); createModal = null; cards.clear(); root.replaceChildren();
  }};
}
