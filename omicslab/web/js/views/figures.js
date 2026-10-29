// Figures view: thumbnail gallery of generated plots with lightbox / download / delete.

import { icon } from '../icons.js?v=1.5.0';
import { esc, fmtBytes, relTime, fmtTime, baseName } from '../util.js?v=1.5.0';
import { api, errorMessage } from '../api.js?v=1.5.0';
import {
  toastSuccess,
  toastError,
  confirmDialog,
  openLightbox,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.5.0';
import { setState } from '../store.js?v=1.5.0';
import {annotateFigure} from '../figure-annotator.js?v=1.5.0';

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    grid: root.querySelector('#figures-grid'),
    count: root.querySelector('#figures-count'),
    refresh: root.querySelector('#figures-refresh'),
    filter: root.querySelector('#figures-filter'),
  };
  const local = { figures: [], filter: '', loading: false };

  function render() {
    const q = local.filter.trim().toLowerCase();
    const figures = local.figures.filter((f) => !q || String(f.name || f.title || '').toLowerCase().includes(q));
    el.count.textContent = `${local.figures.length} 张图表`;
    if (!figures.length) {
      el.grid.innerHTML = emptyStateHtml({
        iconName: 'figures',
        title: local.figures.length ? '没有匹配的图表' : '还没有生成图表',
        hint: local.figures.length
          ? '换个关键词试试'
          : '暂无图表。',
      });
      return;
    }
    el.grid.innerHTML = figures
      .map((fig) => {
        const name = fig.name || baseName(fig.url || '');
        const src = api.figures.url(fig);
        const title = fig.title || name;
        const meta = [fig.size != null ? fmtBytes(fig.size) : '', fig.mtime ? relTime(fig.mtime) : '']
          .filter(Boolean)
          .join(' · ');
        return (
          `<figure class="figure-card" data-name="${esc(name)}">` +
          `<button type="button" class="figure-thumb" aria-label="查看 ${esc(title)}">` +
          `<img src="${esc(src)}" alt="${esc(title)}" loading="lazy" />` +
          `<span class="figure-zoom">${icon('search', { size: 18 })}</span>` +
          '</button>' +
          '<figcaption class="figure-caption">' +
          `<span class="figure-name" title="${esc(name)}">${esc(title)}</span>` +
          `<span class="figure-meta">${esc(meta)}</span>` +
          '</figcaption>' +
          '<div class="figure-actions">' +
          `<button type="button" class="icon-btn figure-annotate" title="勾画批注" aria-label="勾画批注">${icon('pencil', { size: 15 })}</button>` +
          `<a class="icon-btn" href="${esc(src)}" download title="下载" aria-label="下载图表">${icon('download', { size: 15 })}</a>` +
          `<button type="button" class="icon-btn figure-delete" title="删除" aria-label="删除图表">${icon('trash', { size: 15 })}</button>` +
          '</div></figure>'
        );
      })
      .join('');
  }

  async function load() {
    if (local.loading) return;
    local.loading = true;
    el.refresh.classList.add('is-spinning');
    if (!local.figures.length) el.grid.innerHTML = `<div class="panel-loading">${spinnerHtml('读取图库')}</div>`;
    try {
      const data = await api.figures.list();
      local.figures = Array.isArray(data?.figures) ? data.figures : Array.isArray(data) ? data : [];
      setState({ figuresCount: local.figures.length });
      render();
    } catch (err) {
      el.grid.innerHTML =
        `<div class="panel-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取图库</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="fig-retry">重试</button></div></div></div>';
      el.grid.querySelector('#fig-retry')?.addEventListener('click', () => load());
    } finally {
      local.loading = false;
      el.refresh.classList.remove('is-spinning');
    }
  }

  el.grid.addEventListener('click', async (evt) => {
    const card = evt.target.closest('.figure-card');
    if (!card) return;
    const fig = local.figures.find((f) => (f.name || baseName(f.url || '')) === card.dataset.name);
    if (!fig) return;
    const src = api.figures.url(fig);
    const title = fig.title || fig.name || '图表';
    if (evt.target.closest('.figure-delete')) {
      const ok = await confirmDialog({
        title: '删除图表',
        message: `确定删除「${title}」吗？此操作不可撤销。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.figures.remove(fig.name || card.dataset.name);
        toastSuccess('图表已删除');
        await load();
      } catch (err) {
        toastError(`删除失败：${errorMessage(err)}`);
      }
      return;
    }
    if (evt.target.closest('.figure-annotate')) { try { await annotateFigure(fig); } catch (err) { toastError(`批注失败：${errorMessage(err)}`); } return; }
    if (evt.target.closest('.figure-thumb')) {
      openLightbox({
        src,
        title,
        alt: title,
        downloadUrl: src,
      });
    }
  });

  el.refresh.addEventListener('click', () => load());
  el.filter.addEventListener('input', () => {
    local.filter = el.filter.value;
    render();
  });

  await load();
  return { destroy() { root.innerHTML = ''; } };
}

function layout() {
  return (
    '<div class="page figures-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">图库</h1>' +
    '<p class="page-subtitle">分析过程中生成的图表</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="figures-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="figures-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="toolbar">' +
    `<div class="search-box">${icon('search', { size: 15 })}<input type="search" id="figures-filter" placeholder="按图表名筛选" aria-label="筛选图表" /></div>` +
    '</div>' +
    '<div class="figures-grid" id="figures-grid"></div>' +
    '</div>'
  );
}

void fmtTime;
