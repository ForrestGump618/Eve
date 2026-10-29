// Literature radar: search, user-fed PDFs, private research feed and review queue.
import {request, errorMessage} from '../api.js?v=1.4.0';
import {icon} from '../icons.js?v=1.4.0';
import {esc, escAttr, fmtNum, relTime, truncate} from '../util.js?v=1.4.0';
import {navigate, getState} from '../store.js?v=1.4.0';
import {confirmDialog, promptDialog, spinnerHtml} from '../ui.js?v=1.4.0';

const SOURCES = [
  ['europe_pmc', 'Europe PMC'],
  ['openalex', 'OpenAlex'],
  ['biorxiv', 'bioRxiv'],
  ['arxiv', 'arXiv'],
];
const TYPES = [
  ['all', '全部'],
  ['research', '研究论文'],
  ['review', '综述'],
  ['method', '方法'],
  ['position', '观点'],
];
const TABS = [
  ['radar', '雷达', 'search'],
  ['feed', '朋友圈', 'chat'],
  ['pending', '待审核', 'shield'],
  ['proactive', '主动分享', 'send'],
];

const local = {
  tab: 'radar',
  data: null,
  search: null,
  busy: false,
  uploadBusy: false,
  disposed: false,
  generation: 0,
};

function scope() {
  return getState().workspaceId || getState().workspace?.workspace_id || 'ws_main';
}

function when(value) {
  if (!value) return '';
  const timestamp = Number(value);
  return relTime(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) || '';
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function percent(value) {
  const number = score(value);
  return number == null ? '—' : `${Math.round(number * 100)}%`;
}

function typeLabel(value) {
  return {research: '研究', review: '综述', method: '方法', position: '观点'}[value] || '研究';
}

function domainLabel(value) {
  return {
    biology: '生物医学',
    methods: '方法学',
    cross_disciplinary: '跨学科',
    conference: '会议',
  }[value] || '生物医学';
}

function sourceLabel(value) {
  return Object.fromEntries(SOURCES)[value] || value || '来源';
}

function safeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function pageData() {
  return local.data || {
    status: {},
    feed: [],
    reflections: [],
    proactive: [],
    candidates: [],
  };
}

function empty(title, hint, action = '', label = '') {
  return `<div class="lit-empty"><span>${icon('book', {size: 22})}</span><strong>${esc(title)}</strong><p>${esc(hint)}</p>${action ? `<button type="button" class="btn btn-ghost btn-sm" data-lit-action="${escAttr(action)}">${esc(label)}</button>` : ''}</div>`;
}

function metric(label, value, note, tab, iconName, attention = false) {
  return `<button type="button" class="lit-metric${attention ? ' is-attention' : ''}" data-lit-tab="${tab}">
    <span class="lit-metric-icon">${icon(iconName, {size: 17})}</span>
    <span><strong>${esc(value)}</strong><small>${esc(label)}</small></span>
    <span class="lit-metric-note">${esc(note)}</span>
  </button>`;
}

function scoreBar(label, value) {
  const number = score(value);
  if (number == null) return '';
  return `<span class="lit-score" title="${escAttr(`${label} ${percent(number)}`)}"><span>${esc(label)}</span><i style="--lit-score:${Math.round(number * 100)}%"></i><b>${percent(number)}</b></span>`;
}

function topBar() {
  const data = pageData();
  const status = data.status || {};
  const today = status.today || {};
  const proactive = status.proactive || {};
  const last = status.last_run || {};
  const warnings = Array.isArray(last.warnings) ? last.warnings.filter(row => row?.message).slice(0, 2) : [];
  return `<header class="lit-head">
    <div>
      <span class="lit-eyebrow">${esc(getState().workspace?.name || '当前工作区')}</span>
      <h1>文献雷达</h1>
      <p>检索、精读、反思与课题联动。</p>
    </div>
    <div class="lit-head-actions">
      <input type="file" id="lit-pdf" accept="application/pdf,.pdf" hidden/>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="upload">${icon('upload', {size: 15})}<span>${local.uploadBusy ? '解析中' : '投喂 PDF'}</span></button>
      <button type="button" class="btn btn-primary btn-sm" data-lit-action="run" ${local.busy ? 'disabled' : ''}>${icon('play', {size: 15})}<span>${local.busy ? '运行中' : '运行今日检索'}</span></button>
    </div>
  </header>
  <section class="lit-metrics" aria-label="文献指标">
    ${metric('今日精读', fmtNum(today.deep_read), `${fmtNum(today.papers)} 篇入库`, 'radar', 'book')}
    ${metric('待审核反思', fmtNum(status.reflections_pending), '待你审核', 'pending', 'shield', Number(status.reflections_pending) > 0)}
    ${metric('技能候选', fmtNum(status.skill_candidates_pending), '默认停用', 'pending', 'skills')}
    ${metric('主动分享', fmtNum(proactive.queued), `今日已发 ${fmtNum(proactive.sent_today)}`, 'proactive', 'send')}
  </section>
  ${!status.enabled ? `<div class="lit-notice">${icon('info', {size: 16})}<span>文献雷达已关闭。</span><button type="button" class="btn btn-ghost btn-sm" data-lit-action="settings">前往设置</button></div>` : ''}
  ${warnings.length ? `<details class="lit-warning"><summary>${icon('alert', {size: 15})}<span>${esc(warnings[0].message)}</span></summary>${warnings.map(row => `<p>${esc(row.message)}</p>`).join('')}</details>` : ''}`;
}

function tabs() {
  return `<nav class="lit-tabs" aria-label="文献工作台">${TABS.map(([id, label, iconName]) => `<button type="button" class="lit-tab${local.tab === id ? ' is-active' : ''}" data-lit-tab="${id}" aria-selected="${local.tab === id}">${icon(iconName, {size: 15})}<span>${esc(label)}</span><b>${id === 'pending' ? fmtNum(Number(pageData().status?.reflections_pending) + Number(pageData().status?.skill_candidates_pending)) : id === 'proactive' ? fmtNum(pageData().status?.proactive?.queued) : ''}</b></button>`).join('')}</nav>`;
}

function searchPanel() {
  const settings = pageData().status?.settings || {};
  const enabledSources = settings.sources || {};
  return `<form class="lit-search" id="lit-search-form">
    <div class="lit-search-main">
      ${icon('search', {size: 18})}
      <input id="lit-query" name="query" autocomplete="off" placeholder="课题、机制、方法或作者" aria-label="文献检索主题"/>
      <button type="submit" class="btn btn-primary btn-sm">${local.busy ? '检索中' : '检索'}</button>
    </div>
    <div class="lit-filters">
      <div class="lit-source-row" aria-label="文献来源">
        ${SOURCES.map(([id, label]) => `<label class="lit-check"><input type="checkbox" name="source" value="${id}" ${enabledSources[id] === false ? 'disabled' : 'checked'}/><span>${label}</span></label>`).join('')}
      </div>
      <label><span>类型</span><select id="lit-type">${TYPES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
      <label><span>开始</span><input id="lit-from" type="date"/></label>
      <label><span>结束</span><input id="lit-to" type="date"/></label>
      <label><span>最低兴趣度</span><input id="lit-threshold" type="number" min="0" max="1" step="0.05" value="${escAttr(settings.min_interestingness ?? 0.35)}"/></label>
      <label><span>跨学科权重</span><input id="lit-bridge" type="number" min="0" max="1" step="0.05" value="${escAttr(settings.cross_discipline_weight ?? 0.25)}"/></label>
    </div>
  </form>`;
}

function paperCard(item) {
  const scores = item.scores || {};
  const url = safeUrl(item.url) || (safeUrl(item.doi) ? `https://doi.org/${encodeURIComponent(item.doi)}` : '');
  const prior = Array.isArray(item.prior_art) ? item.prior_art.slice(0, 3) : [];
  return `<article class="lit-paper" data-paper="${escAttr(item.id)}">
    <header>
      <div class="lit-paper-source"><span>${esc(sourceLabel(item.source))}</span><span>${esc(item.published || '日期未知')}</span><span>${esc(typeLabel(item.publication_type))}</span><span>${esc(domainLabel(item.domain))}</span></div>
      <span class="lit-interest">${icon('discovery', {size: 14})}${percent(scores.interestingness)}</span>
    </header>
    <h2>${url ? `<a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title)}</h2>
    <p class="lit-authors">${esc(truncate(item.authors || item.venue || '来源信息待补充', 180))}</p>
    <p class="lit-abstract">${esc(truncate(item.abstract || '暂无摘要。', 520))}</p>
    <div class="lit-scores">${scoreBar('相关', scores.relevance)}${scoreBar('时效', scores.recency)}${scoreBar('跨学科', scores.cross_disciplinary)}${scoreBar('接地新颖性', item.novelty_grounded)}</div>
    ${item.novelty_status && item.novelty_status !== 'grounded' ? `<p class="lit-novelty">${icon('info', {size: 14})}${esc(item.novelty_note || '新颖性尚未评分')}</p>` : ''}
    ${prior.length ? `<details class="lit-prior"><summary>查看 ${prior.length} 条先验工作</summary><div>${prior.map(row => `<a href="${escAttr(safeUrl(row.url) || (safeUrl(row.doi) ? `https://doi.org/${encodeURIComponent(row.doi)}` : '#'))}" target="_blank" rel="noopener"><span>${esc(row.title)}</span><small>${esc(row.published || '')} · 相似度 ${percent(row.similarity)}</small></a>`).join('')}</div></details>` : ''}
    <footer>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="save-paper" data-id="${escAttr(item.id)}">${icon('bookmark', {size: 14})}收藏</button>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="hide-paper" data-id="${escAttr(item.id)}">${icon('close', {size: 14})}减少此类</button>
      ${url ? `<a class="btn btn-ghost btn-sm" href="${escAttr(url)}" target="_blank" rel="noopener">${icon('external', {size: 14})}原文</a>` : ''}
    </footer>
  </article>`;
}

function radarView() {
  const result = local.search;
  if (result?.loading) return `<section class="lit-panel">${spinnerHtml('检索文献')}</section>`;
  if (!result) {
    const last = pageData().status?.last_run;
    return `${searchPanel()}<section class="lit-panel">${last ? `<div class="lit-run-summary"><span>${icon('history', {size: 16})}</span><div><strong>最近一次检索 ${when(last.finished_at || last.started_at)}</strong><p>${fmtNum(last.selected)} 篇入库 · ${fmtNum(last.deep_read)} 篇精读 · ${fmtNum(last.feed_posts)} 条朋友圈</p></div></div>` : ''}${empty('输入主题开始检索', '可检索论文、方法或综述。')}</section>`;
  }
  if (!result.items?.length) return `${searchPanel()}<section class="lit-panel">${empty('没有符合条件的文献', '可放宽日期、类型或最低兴趣度。', 'retry-search', '重新检索')}</section>`;
  return `${searchPanel()}<section class="lit-result-head"><div><strong>${fmtNum(result.items.length)} 篇</strong><span>${esc(result.range?.from || '')} 至 ${esc(result.range?.to || '')}</span></div><button type="button" class="btn btn-ghost btn-sm" data-lit-action="retry-search">${icon('refresh', {size: 14})}刷新结果</button></section><div class="lit-paper-list">${result.items.map(paperCard).join('')}</div>`;
}

function feedView() {
  const posts = pageData().feed || [];
  if (!posts.length) return empty('暂无文献动态', '今日检索后，值得关注的论文会出现在这里。', 'run', '运行今日检索');
  return `<div class="lit-feed-list">${posts.map(post => {
    const url = safeUrl(post.url);
    const scores = post.scores || {};
    return `<article class="lit-feed-post" data-feed="${escAttr(post.id)}">
      <header><div><span>${esc(sourceLabel(post.source))}</span><time>${esc(when(post.created_at))}</time></div><b>${percent(scores.interestingness)}</b></header>
      <h2>${url ? `<a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(post.title)}</a>` : esc(post.title)}</h2>
      <p>${esc(post.note || '')}</p>
      <div class="lit-feed-comments">${(post.comments || []).map(comment => `<div><span>你</span><p>${esc(comment.text)}</p><time>${esc(when(comment.created_at))}</time></div>`).join('')}</div>
      <form class="lit-comment-form" data-feed-id="${escAttr(post.id)}"><input placeholder="写下判断或补充证据" aria-label="评论"/><button type="submit" class="btn btn-ghost btn-sm">${icon('send', {size: 14})}评论</button></form>
    </article>`;
  }).join('')}</div>`;
}

function reflectionCard(row) {
  return `<article class="lit-review-card">
    <header><span>${icon('brain', {size: 15})}反思</span><time>${esc(when(row.created_at))}</time></header>
    <h2>${esc(row.paper_title || '文献反思')}</h2>
    <p>${esc(truncate(row.summary || '', 600))}</p>
    ${row.method_steps?.length ? `<ol>${row.method_steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
    ${row.experiment_ideas?.length ? `<div class="lit-idea"><strong>实验建议</strong>${row.experiment_ideas.map(text => `<span>${esc(text)}</span>`).join('')}</div>` : ''}
    <footer><span>${row.model_error ? '模型抽取未完成' : '待你判断是否用于课题'}</span></footer>
  </article>`;
}

function candidateCard(row) {
  return `<article class="lit-review-card lit-candidate">
    <header><span>${icon('skills', {size: 15})}${esc({skill: '技能候选', follow_up: '课题联动', memory: '记忆候选', correction: '纠错候选', workflow: '流程候选'}[row.kind] || '候选')}</span><time>${esc(when(row.created_at))}</time></header>
    <h2>${esc(row.title)}</h2>
    <p>${esc(truncate(row.summary || '', 520))}</p>
    <small>${esc(truncate(row.rationale || '', 360))}</small>
    <footer>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="reject-candidate" data-id="${escAttr(row.id)}">忽略</button>
      <button type="button" class="btn btn-primary btn-sm" data-lit-action="accept-candidate" data-id="${escAttr(row.id)}">审核并采纳</button>
    </footer>
  </article>`;
}

function pendingView() {
  const reflections = pageData().reflections || [];
  const candidates = pageData().candidates || [];
  if (!reflections.length && !candidates.length) {
    return empty('没有待审核内容', '文献反思和技能候选只会在你确认后进入后续流程。');
  }
  return `<div class="lit-review-grid">
    <section><header class="lit-section-head"><div><h2>反思</h2><p>方法与课题的候选映射。</p></div><b>${reflections.length}</b></header>${reflections.map(reflectionCard).join('') || '<p class="lit-muted">没有待审反思。</p>'}</section>
    <section><header class="lit-section-head"><div><h2>技能与后续</h2><p>采纳后仍需检查脚本、权限和适用条件。</p></div><b>${candidates.length}</b></header>${candidates.map(candidateCard).join('') || '<p class="lit-muted">没有待审技能候选。</p>'}</section>
  </div>`;
}

function proactiveView() {
  const rows = pageData().proactive || [];
  if (!rows.length) return empty('当前没有待分享内容', '新的文献判断会在这里出现。', 'run', '运行今日检索');
  return `<div class="lit-proactive-list">${rows.map(row => `<article class="lit-proactive-card">
    <header><span>${icon('book', {size: 15})}主动分享</span><time>${esc(when(row.created_at))}</time></header>
    <h2>${esc(row.title)}</h2>
    <p>${esc(row.body)}</p>
    <footer>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="dismiss-message" data-id="${escAttr(row.id)}">忽略</button>
      <button type="button" class="btn btn-ghost btn-sm" data-lit-action="reply-message" data-id="${escAttr(row.id)}">回复</button>
      <button type="button" class="btn btn-primary btn-sm" data-lit-action="send-message" data-id="${escAttr(row.id)}">继续讨论</button>
    </footer>
  </article>`).join('')}</div>`;
}

function content() {
  if (!local.data && local.busy) return `<section class="lit-panel">${spinnerHtml('读取文献工作台')}</section>`;
  if (local.tab === 'feed') return feedView();
  if (local.tab === 'pending') return pendingView();
  if (local.tab === 'proactive') return proactiveView();
  return radarView();
}

function render(root) {
  if (local.disposed) return;
  root.innerHTML = `<div class="lit-page">${topBar()}${tabs()}<div class="lit-content">${content()}</div></div>`;
}

async function load(root, generation = local.generation) {
  if (local.disposed || generation !== local.generation) return;
  local.busy = true;
  render(root);
  const q = `scope=${encodeURIComponent(scope())}`;
  const results = await Promise.allSettled([
    request(`/api/literature/status?${q}`),
    request(`/api/literature/feed?${q}&limit=30`),
    request(`/api/literature/reflections?${q}&status=pending&limit=30`),
    request(`/api/literature/proactive?${q}&include_silent=false`),
    request(`/api/platform/dreaming?${q}`),
  ]);
  if (local.disposed || generation !== local.generation) return;
  const value = (index, fallback) => results[index]?.status === 'fulfilled' ? results[index].value : fallback;
  local.data = {
    status: value(0, {}),
    feed: value(1, {items: []}).items || [],
    reflections: value(2, {items: []}).items || [],
    proactive: value(3, {items: []}).items || [],
    candidates: (value(4, {candidates: []}).candidates || []).filter(row => row.evidence_refs?.some(ref => String(ref).startsWith('literature:'))),
  };
  local.busy = false;
  render(root);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    const message = errorMessage(failed.reason);
    const content = root.querySelector('.lit-content');
    if (content) content.insertAdjacentHTML('afterbegin', `<div class="lit-notice is-error">${icon('alert', {size: 16})}<span>${esc(message)}</span></div>`);
  }
}

async function runSearch(root) {
  const form = root.querySelector('#lit-search-form');
  const query = form?.querySelector('#lit-query')?.value.trim() || '';
  if (!query) {
    form?.querySelector('#lit-query')?.focus();
    return;
  }
  const sources = [...form.querySelectorAll('input[name="source"]:checked')].map(input => input.value);
  local.search = {loading: true};
  local.busy = true;
  render(root);
  try {
    local.search = await request(`/api/literature/search?scope=${encodeURIComponent(scope())}`, {
      method: 'POST',
      timeout: 120000,
      body: {
        query,
        sources,
        type_filter: form.querySelector('#lit-type')?.value || 'all',
        date_from: form.querySelector('#lit-from')?.value || '',
        date_to: form.querySelector('#lit-to')?.value || '',
        min_interestingness: Number(form.querySelector('#lit-threshold')?.value || 0),
        cross_discipline_weight: Number(form.querySelector('#lit-bridge')?.value || 0),
        limit: 12,
        ground_novelty: true,
      },
    });
  } catch (err) {
    local.search = {items: [], warnings: [{message: errorMessage(err)}]};
  } finally {
    local.busy = false;
    render(root);
  }
}

async function uploadPdf(root, file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    const content = root.querySelector('.lit-content');
    if (content) content.insertAdjacentHTML('afterbegin', `<div class="lit-notice is-error">${icon('alert', {size: 16})}<span>请选择 PDF 文件。</span></div>`);
    return;
  }
  const form = new FormData();
  form.append('file', file, file.name);
  local.uploadBusy = true;
  render(root);
  let notice = null;
  let loaded = false;
  try {
    const result = await request(`/api/literature/ingest?scope=${encodeURIComponent(scope())}`, {
      method: 'POST',
      body: form,
      timeout: 180000,
    });
    local.tab = 'pending';
    await load(root);
    loaded = true;
    notice = {
      error: false,
      text: result.duplicate ? '这篇文献已经投喂过。' : `已投喂：${result.item?.title || file.name}`,
    };
  } catch (err) {
    notice = {error: true, text: errorMessage(err)};
  } finally {
    local.uploadBusy = false;
    if (!loaded) render(root);
    if (notice) {
      const content = root.querySelector('.lit-content');
      if (content) {
        content.insertAdjacentHTML(
          'afterbegin',
          `<div class="lit-notice${notice.error ? ' is-error' : ''}">${icon(notice.error ? 'alert' : 'check', {size: 16})}<span>${esc(notice.text)}</span></div>`,
        );
      }
    }
  }
}

async function runDaily(root) {
  if (local.busy) return;
  local.busy = true;
  render(root);
  try {
    await request(`/api/literature/run?scope=${encodeURIComponent(scope())}`, {
      method: 'POST',
      timeout: 240000,
      body: {trigger: 'manual', force: false},
    });
    await load(root);
  } catch (err) {
    local.busy = false;
    render(root);
    const content = root.querySelector('.lit-content');
    if (content) content.insertAdjacentHTML('afterbegin', `<div class="lit-notice is-error">${icon('alert', {size: 16})}<span>${esc(errorMessage(err))}</span></div>`);
  }
}

function bind(root) {
  const onClick = async event => {
    const tab = event.target.closest('[data-lit-tab]');
    if (tab) {
      local.tab = tab.dataset.litTab;
      render(root);
      return;
    }
    const button = event.target.closest('[data-lit-action]');
    if (!button) return;
    const action = button.dataset.litAction;
    const id = button.dataset.id || '';
    try {
      if (action === 'settings') {
        navigate('settings', {section: 'literature'});
      } else if (action === 'run') {
        await runDaily(root);
      } else if (action === 'upload') {
        root.querySelector('#lit-pdf')?.click();
      } else if (action === 'retry-search') {
        await runSearch(root);
      } else if (action === 'save-paper' || action === 'hide-paper') {
        await request(`/api/literature/feedback?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {
            paper_id: id,
            action: action === 'save-paper' ? 'save' : 'hide',
            rating: action === 'save-paper' ? 1 : -1,
          },
        });
        button.textContent = action === 'save-paper' ? '已收藏' : '已调整';
        button.disabled = true;
      } else if (action === 'accept-candidate') {
        if (!await confirmDialog({
          title: '采纳候选',
          message: '候选会进入现有记忆或技能流程；技能仍默认停用，需要检查后再启用。',
          confirmText: '确认采纳',
        })) return;
        await request(`/api/platform/dreaming/candidates/${encodeURIComponent(id)}/accept?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {confirmed: true},
        });
        await load(root);
      } else if (action === 'reject-candidate') {
        const reason = await promptDialog({
          title: '忽略候选',
          message: '可记录原因，便于后续减少类似建议。',
          placeholder: '可选',
        });
        if (reason === null) return;
        await request(`/api/platform/dreaming/candidates/${encodeURIComponent(id)}/reject?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {reason},
        });
        await load(root);
      } else if (action === 'send-message') {
        const result = await request(`/api/literature/proactive/${encodeURIComponent(id)}/send?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {},
        });
        navigate('workbench', {prefill: result.chat_prompt || ''});
      } else if (action === 'dismiss-message') {
        const reason = await promptDialog({
          title: '忽略这条分享',
          message: '可记录忽略原因。',
          placeholder: '可选',
        });
        if (reason === null) return;
        await request(`/api/literature/proactive/${encodeURIComponent(id)}/dismiss?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {reason},
        });
        await load(root);
      } else if (action === 'reply-message') {
        const text = await promptDialog({
          title: '继续讨论',
          message: '回复会作为当前文献的讨论上下文。',
          placeholder: '写下判断、问题或下一步',
        });
        if (!text) return;
        const result = await request(`/api/literature/proactive/${encodeURIComponent(id)}/reply?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {text},
        });
        navigate('workbench', {prefill: result.chat_prompt || text});
      }
    } catch (err) {
      const content = root.querySelector('.lit-content');
      if (content) content.insertAdjacentHTML('afterbegin', `<div class="lit-notice is-error">${icon('alert', {size: 16})}<span>${esc(errorMessage(err))}</span></div>`);
    }
  };

  const onSubmit = async event => {
    if (event.target.id === 'lit-search-form') {
      event.preventDefault();
      await runSearch(root);
    } else if (event.target.matches('.lit-comment-form')) {
      event.preventDefault();
      const input = event.target.querySelector('input');
      const text = input?.value.trim() || '';
      if (!text) return;
      try {
        await request(`/api/literature/feed/${encodeURIComponent(event.target.dataset.feedId)}/comments?scope=${encodeURIComponent(scope())}`, {
          method: 'POST',
          body: {text},
        });
        await load(root);
      } catch (err) {
        const content = root.querySelector('.lit-content');
        if (content) content.insertAdjacentHTML('afterbegin', `<div class="lit-notice is-error">${icon('alert', {size: 16})}<span>${esc(errorMessage(err))}</span></div>`);
      }
    }
  };

  const onChange = event => {
    if (event.target.id === 'lit-pdf') uploadPdf(root, event.target.files?.[0]);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('change', onChange);
  };
}

export async function mount(root) {
  local.generation += 1;
  const generation = local.generation;
  local.disposed = false;
  local.search = null;
  local.tab = 'radar';
  render(root);
  const dispose = bind(root);
  await load(root, generation);
  return {
    destroy() {
      if (local.generation === generation) local.disposed = true;
      dispose();
    },
  };
}
