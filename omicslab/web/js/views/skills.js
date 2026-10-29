// Skills view: catalogue of reusable analysis skill packs + markdown detail pane.

import { icon } from '../icons.js?v=1.5.0';
import { renderMarkdown } from '../markdown.js?v=1.5.0';
import { esc, relTime, copyText } from '../util.js?v=1.5.0';
import { api, errorMessage } from '../api.js?v=1.5.0';
import {
  toastError,
  toastSuccess,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.5.0';
import { navigate } from '../store.js?v=1.5.0';

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    list: root.querySelector('#skills-list'),
    detail: root.querySelector('#skill-detail'),
    filter: root.querySelector('#skills-filter'),
    count: root.querySelector('#skills-count'),
    refresh: root.querySelector('#skills-refresh'),
  };
  const local = { skills: [], active: null, detail: null, filter: '', loading: false, detailLoading: false };

  function renderList() {
    const q = local.filter.trim().toLowerCase();
    const list = local.skills.filter(
      (s) =>
        !q ||
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.description || '').toLowerCase().includes(q) ||
        String(s.when_to_use || '').toLowerCase().includes(q),
    );
    el.count.textContent = `${local.skills.length} 个技能`;
    if (!list.length) {
      el.list.innerHTML = emptyStateHtml({
        iconName: 'skills',
        title: local.skills.length ? '没有匹配的技能' : '还没有可用技能',
        hint: local.skills.length ? '换个关键词试试' : '技能包会从 skills 目录自动加载，放入新的技能后刷新即可看到。',
      });
      return;
    }
    el.list.innerHTML = list
      .map((s) => {
        const name = s.name || '';
        const active = local.active === name;
        return (
          `<button type="button" class="skill-card${active ? ' is-active' : ''}" data-name="${esc(name)}">` +
          `<span class="skill-card-icon">${icon('skills', { size: 18 })}</span>` +
          '<span class="skill-card-body">' +
          `<span class="skill-card-title">${esc(name)}</span>` +
          `<span class="skill-card-desc">${esc(s.description || s.when_to_use || '暂无描述')}</span>` +
          (s.source ? `<span class="skill-card-source">${esc(String(s.name).startsWith('science-') ? '科学工具 · 按需加载' : s.source)}</span>` : '') +
          '</span>' +
          `<span class="skill-card-chev">${icon('chevronRight', { size: 16 })}</span>` +
          '</button>'
        );
      })
      .join('');
  }

  function renderDetailLoading() {
    el.detail.innerHTML = `<div class="detail-loading">${spinnerHtml('读取技能内容')}</div>`;
  }

  async function openDetail(name) {
    local.active = name;
    renderList();
    renderDetailLoading();
    local.detailLoading = true;
    try {
      const data = await api.skills.get(name);
      const skill = data?.skill || data;
      local.detail = skill;
      const files = Array.isArray(skill?.files) ? skill.files : [];
      el.detail.innerHTML =
        '<div class="skill-detail-head">' +
        '<div class="skill-detail-title-row">' +
        `<h2 class="skill-detail-title">${esc(skill?.name || name)}</h2>` +
        (skill?.version ? `<span class="tag">${esc(skill.version)}</span>` : '') +
        '</div>' +
        (skill?.description ? `<p class="skill-detail-desc">${esc(skill.description)}</p>` : '') +
        '<div class="skill-detail-actions">' +
        `<button type="button" class="btn btn-primary btn-sm" id="skill-use">${icon('chat', { size: 15 })}<span>在对话中使用</span></button>` +
        `<button type="button" class="btn btn-ghost btn-sm" id="skill-copy">${icon('copy', { size: 15 })}<span>复制技能名</span></button>` +
        (skill?.path ? `<span class="skill-path" title="${esc(skill.path)}">${icon('folder', { size: 13 })}<span>${esc(skill.path)}</span></span>` : '') +
        '</div></div>' +
        (skill?.preparation
          ? '<section class="skill-when"><span class="skill-when-label">执行环境</span>' +
            `<p>在当前本地或 SSH 工作区运行 · ${skill.run?.language==='node'?'Node.js 18+ · 最终生成需要当前主机的浏览器':'uv 独立依赖环境'}${skill.run?.scripts?.length ? ` · ${skill.run.scripts.length} 个入口` : ' · 工作流指引'}</p>` +
            '<p>先检查执行环境，运行遵循当前任务权限。</p>' +
            (skill.preparation.requiredCredentials?.length
              ? `<p>必需凭据：${skill.preparation.requiredCredentials.map(esc).join('、')}（运行时检查）</p>` : '') +
            (skill.preparation.optionalCredentials?.length
              ? `<p>可选凭据：${skill.preparation.optionalCredentials.map(esc).join('、')}；公开查询可不配置。</p>` : '') +
            (skill.preparation.externalRequirements?.length
              ? `<p>外部环境：${skill.preparation.externalRequirements.map(esc).join('；')}</p>` : '') +
            '</section>' : '') +
        (skill?.when_to_use
          ? `<div class="skill-when"><span class="skill-when-label">${icon('info', { size: 14 })}<span>适用场景</span></span><p>${esc(skill.when_to_use)}</p></div>`
          : '') +
        '<article class="markdown-body skill-markdown">' +
        renderMarkdown(skill?.body || '（该技能没有正文）') +
        '</article>' +
        (files.length
          ? `<div class="skill-files"><h4>相关文件</h4><ul>${files
              .map((f) => `<li>${icon('file', { size: 13 })}<span>${esc(typeof f === 'string' ? f : f?.path || f?.name || '')}</span></li>`)
              .join('')}</ul></div>`
          : '');
      bindDetailActions(skill);
    } catch (err) {
      el.detail.innerHTML =
        `<div class="detail-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取技能详情</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="skill-retry">重试</button></div></div></div>';
      el.detail.querySelector('#skill-retry')?.addEventListener('click', () => openDetail(name));
    } finally {
      local.detailLoading = false;
    }
  }

  function bindDetailActions(skill) {
    const name = skill?.name || local.active;
    el.detail.querySelector('#skill-use')?.addEventListener('click', () => {
      navigate('chat', { prefill: `请使用「${name}」技能来帮我完成一项任务：` });
    });
    el.detail.querySelector('#skill-copy')?.addEventListener('click', async () => {
      const ok = await copyText(name);
      if (ok) toastSuccess('技能名已复制');
      else toastError('复制失败');
    });
  }

  async function load() {
    if (local.loading) return;
    local.loading = true;
    el.refresh.classList.add('is-spinning');
    if (!local.skills.length) el.list.innerHTML = `<div class="panel-loading">${spinnerHtml('读取技能列表')}</div>`;
    try {
      const data = await api.skills.list();
      local.skills = Array.isArray(data?.skills) ? data.skills : Array.isArray(data) ? data : [];
      renderList();
      const requested = ctx.getState?.()?.routeParams?.skillName;
      if (requested && local.skills.some(skill => skill.name === requested)) {
        delete ctx.getState().routeParams.skillName;
        await openDetail(requested);
        return;
      }
      if (local.skills.length && !local.active) {
        const first = local.skills[0];
        await openDetail(first.name);
      } else if (local.active) {
        await openDetail(local.active);
      } else {
        el.detail.innerHTML = emptyStateHtml({
          iconName: 'skills',
          title: '选择一个技能查看详情',
          hint: '技能是可复用的分析方法与提示词组合。',
        });
      }
    } catch (err) {
      el.list.innerHTML =
        `<div class="panel-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取技能列表</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="skills-retry">重试</button></div></div></div>';
      el.list.querySelector('#skills-retry')?.addEventListener('click', () => load());
    } finally {
      local.loading = false;
      el.refresh.classList.remove('is-spinning');
    }
  }

  el.list.addEventListener('click', (evt) => {
    const card = evt.target.closest('.skill-card');
    if (!card) return;
    if (card.dataset.name === local.active) return;
    openDetail(card.dataset.name);
  });
  el.filter.addEventListener('input', () => {
    local.filter = el.filter.value;
    renderList();
  });
  el.refresh.addEventListener('click', () => load());

  await load();
  return { destroy() { root.innerHTML = ''; } };
}

function layout() {
  return (
    '<div class="page skills-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">技能</h1>' +
    '<p class="page-subtitle">可复用的分析方法、操作手册与提示词</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="skills-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="skills-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="toolbar">' +
    `<div class="search-box">${icon('search', { size: 15 })}<input type="search" id="skills-filter" placeholder="搜索技能名称或描述" aria-label="筛选技能" /></div>` +
    '</div>' +
    '<div class="skills-layout">' +
    '<div class="skills-list" id="skills-list"></div>' +
    '<section class="card skill-detail" id="skill-detail">' +
    `<div class="detail-placeholder">${emptyStateHtml({ iconName: 'skills', title: '选择一个技能', hint: '左侧列表中选择技能查看详情' })}</div>` +
    '</section>' +
    '</div></div>'
  );
}

void relTime;
