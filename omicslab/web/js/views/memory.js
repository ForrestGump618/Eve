// Memory view: long-lived project notes stored as slugged markdown documents.

import { icon } from '../icons.js?v=1.5.0';
import { renderMarkdown } from '../markdown.js?v=1.5.0';
import { esc, relTime, fmtBytes } from '../util.js?v=1.5.0';
import { api, errorMessage } from '../api.js?v=1.5.0';
import {
  toastSuccess,
  toastError,
  toastInfo,
  confirmDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.5.0';

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    list: root.querySelector('#memory-list'),
    count: root.querySelector('#memory-count'),
    refresh: root.querySelector('#memory-refresh'),
    newBtn: root.querySelector('#memory-new'),
    editor: root.querySelector('#memory-editor'),
  };

  const local = {
    items: [],
    active: null, // slug
    draft: null, // {slug, title, body, isNew, dirty}
    tab: 'edit',
    loading: false,
  };

  function renderList() {
    el.count.textContent = `${local.items.length} 条记忆`;
    if (!local.items.length) {
      el.list.innerHTML = emptyStateHtml({
        iconName: 'memory',
        title: '还没有记忆',
        hint: '保存项目约定、数据字典或分析结论，后续对话可检索。',
        actionLabel: '新建记忆',
        actionId: 'memory-new-inline',
      });
      el.list.querySelector('#memory-new-inline')?.addEventListener('click', () => startNew());
      return;
    }
    el.list.innerHTML = local.items
      .map((item) => {
        const slug = item.slug || item.name || '';
        const active = local.active === slug;
        return (
          `<button type="button" class="memory-item${active ? ' is-active' : ''}" data-slug="${esc(slug)}">` +
          `<span class="memory-item-icon">${icon('memory', { size: 16 })}</span>` +
          '<span class="memory-item-body">' +
          `<span class="memory-item-title">${esc(item.title || slug)}</span>` +
          `<span class="memory-item-meta">${esc(slug)}${item.updated_at ? ` · ${esc(relTime(item.updated_at))}` : ''}` +
          (item.size != null ? ` · ${esc(fmtBytes(item.size))}` : '') +
          '</span></span>' +
          '</button>'
        );
      })
      .join('');
  }

  function renderEditor() {
    const draft = local.draft;
    if (!draft) {
      el.editor.innerHTML = emptyStateHtml({
        iconName: 'memory',
        title: '选择或新建一条记忆',
        hint: '记忆会持久化在项目目录中，可按 slug 在对话中被引用。',
        actionLabel: '新建记忆',
        actionId: 'memory-new-blank',
      });
      el.editor.querySelector('#memory-new-blank')?.addEventListener('click', () => startNew());
      return;
    }
    el.editor.innerHTML =
      '<div class="memory-editor-head">' +
      `<div class="memory-editor-title-wrap">` +
      (draft.isNew
        ? `<label class="field inline"><span class="field-label">Slug</span><input class="input" id="memory-slug" value="${esc(draft.slug || '')}" placeholder="例如 project-conventions" /></label>`
        : `<div class="memory-editor-title">${esc(draft.title || draft.slug)}</div><div class="memory-editor-sub">${esc(draft.slug)}</div>`) +
      '</div>' +
      '<div class="memory-editor-actions">' +
      '<div class="tabs" id="memory-tabs">' +
      `<button type="button" class="tab${local.tab === 'edit' ? ' is-active' : ''}" data-tab="edit">编辑</button>` +
      `<button type="button" class="tab${local.tab === 'preview' ? ' is-active' : ''}" data-tab="preview">预览</button>` +
      '</div>' +
      (draft.isNew ? '' : `<button type="button" class="btn btn-danger btn-sm" id="memory-delete">${icon('trash', { size: 15 })}<span>删除</span></button>`) +
      `<button type="button" class="btn btn-primary btn-sm" id="memory-save">${icon('save', { size: 15 })}<span>保存</span></button>` +
      '</div></div>' +
      `<div class="memory-editor-body">` +
      `<label class="field"><span class="field-label">标题</span><input class="input" id="memory-title" value="${esc(draft.title || '')}" placeholder="记忆标题" /></label>` +
      (local.tab === 'edit'
        ? `<textarea class="input memory-textarea" id="memory-body" spellcheck="false" placeholder="# 标题\n\n记录项目约定、数据结构或分析结论…">${esc(draft.body || '')}</textarea>`
        : `<article class="markdown-body memory-preview">${renderMarkdown(draft.body || '（空）')}</article>`) +
      '</div>' +
      (draft.dirty ? '<div class="dirty-hint">有未保存的修改</div>' : '');

    bindEditor();
  }

  function bindEditor() {
    const slugInput = el.editor.querySelector('#memory-slug');
    const titleInput = el.editor.querySelector('#memory-title');
    const bodyInput = el.editor.querySelector('#memory-body');

    const markDirty = () => {
      if (!local.draft) return;
      local.draft.dirty = true;
      const hint = el.editor.querySelector('.dirty-hint');
      if (!hint) {
        const node = document.createElement('div');
        node.className = 'dirty-hint';
        node.textContent = '有未保存的修改';
        el.editor.appendChild(node);
      }
    };

    if (slugInput) {
      slugInput.addEventListener('input', () => {
        local.draft.slug = slugInput.value.trim();
        markDirty();
      });
    }
    if (titleInput) {
      titleInput.addEventListener('input', () => {
        local.draft.title = titleInput.value;
        markDirty();
      });
    }
    if (bodyInput) {
      bodyInput.addEventListener('input', () => {
        local.draft.body = bodyInput.value;
        markDirty();
      });
      bodyInput.addEventListener('keydown', (evt) => {
        if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === 's') {
          evt.preventDefault();
          save();
        }
      });
    }

    el.editor.querySelector('#memory-tabs')?.addEventListener('click', (evt) => {
      const tab = evt.target.closest('.tab');
      if (!tab) return;
      local.tab = tab.dataset.tab;
      // capture latest textarea value before switching
      const body = el.editor.querySelector('#memory-body');
      if (body && local.draft) local.draft.body = body.value;
      renderEditor();
    });

    el.editor.querySelector('#memory-save')?.addEventListener('click', () => save());
    el.editor.querySelector('#memory-delete')?.addEventListener('click', () => deleteActive());
  }

  async function save() {
    if (!local.draft) return;
    const titleEl = el.editor.querySelector('#memory-title');
    if (titleEl) local.draft.title = titleEl.value;
    const bodyEl = el.editor.querySelector('#memory-body');
    if (bodyEl) local.draft.body = bodyEl.value;
    const slugEl = el.editor.querySelector('#memory-slug');
    if (slugEl) local.draft.slug = slugEl.value.trim();

    const slug = String(local.draft.slug || '').trim();
    const title = String(local.draft.title || '').trim();
    if (!slug) {
      toastInfo('请填写 slug（用于在对话中引用）');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
      toastInfo('slug 只能包含字母、数字、点、下划线和短横线');
      return;
    }
    if (!title) {
      toastInfo('请填写标题');
      return;
    }
    const btn = el.editor.querySelector('#memory-save');
    if (btn) btn.disabled = true;
    try {
      await api.memory.save(slug, { title, body: local.draft.body || '' });
      toastSuccess('记忆已保存');
      local.draft.dirty = false;
      local.active = slug;
      local.draft.isNew = false;
      await load({ keepDraft: false, select: slug });
    } catch (err) {
      toastError(`保存失败：${errorMessage(err)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteActive() {
    const slug = local.draft?.slug || local.active;
    if (!slug) return;
    const ok = await confirmDialog({
      title: '删除记忆',
      message: `确定删除「${local.draft?.title || slug}」吗？此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.memory.remove(slug);
      toastSuccess('记忆已删除');
      local.active = null;
      local.draft = null;
      await load({ keepDraft: false });
    } catch (err) {
      toastError(`删除失败：${errorMessage(err)}`);
    }
  }

  async function openItem(slug) {
    if (local.draft?.dirty) {
      const ok = await confirmDialog({
        title: '放弃未保存的修改？',
        message: '当前记忆有未保存的修改，切换后将会丢失。',
        confirmText: '放弃修改',
        danger: true,
      });
      if (!ok) return;
    }
    local.active = slug;
    renderList();
    el.editor.innerHTML = `<div class="detail-loading">${spinnerHtml('读取记忆')}</div>`;
    try {
      const data = await api.memory.get(slug);
      const item = data?.item || data;
      local.draft = {
        slug: item?.slug || slug,
        title: item?.title || slug,
        body: item?.body || '',
        isNew: false,
        dirty: false,
      };
      local.tab = 'edit';
      renderEditor();
    } catch (err) {
      el.editor.innerHTML =
        `<div class="detail-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取记忆</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="memory-retry">重试</button></div></div></div>';
      el.editor.querySelector('#memory-retry')?.addEventListener('click', () => openItem(slug));
    }
  }

  async function startNew() {
    if (local.draft?.dirty) {
      const ok = await confirmDialog({
        title: '放弃未保存的修改？',
        message: '当前记忆有未保存的修改，新建后将会丢失。',
        confirmText: '放弃修改',
        danger: true,
      });
      if (!ok) return;
    }
    local.active = null;
    local.tab = 'edit';
    local.draft = { slug: '', title: '', body: '', isNew: true, dirty: false };
    renderList();
    renderEditor();
    setTimeout(() => el.editor.querySelector('#memory-slug')?.focus(), 40);
  }

  async function load({ keepDraft = false, select = null } = {}) {
    if (local.loading) return;
    local.loading = true;
    el.refresh.classList.add('is-spinning');
    if (!local.items.length) el.list.innerHTML = `<div class="panel-loading">${spinnerHtml('读取记忆列表')}</div>`;
    try {
      const data = await api.memory.list();
      local.items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      renderList();
      if (select) {
        await openItem(select);
      } else if (!keepDraft && !local.draft && local.items.length) {
        await openItem(local.items[0].slug || local.items[0].name);
      } else if (!local.items.length && !local.draft) {
        local.draft = null;
        renderEditor();
      }
    } catch (err) {
      el.list.innerHTML =
        `<div class="panel-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取记忆列表</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="memory-retry-list">重试</button></div></div></div>';
      el.list.querySelector('#memory-retry-list')?.addEventListener('click', () => load());
      if (!local.draft) renderEditor();
    } finally {
      local.loading = false;
      el.refresh.classList.remove('is-spinning');
    }
  }

  el.list.addEventListener('click', (evt) => {
    const item = evt.target.closest('.memory-item');
    if (!item) return;
    if (item.dataset.slug === local.active) return;
    openItem(item.dataset.slug);
  });
  el.newBtn.addEventListener('click', () => startNew());
  el.refresh.addEventListener('click', () => load({ keepDraft: true }));

  await load();
  return { destroy() { root.innerHTML = ''; } };
}

function layout() {
  return (
    '<div class="page memory-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">记忆</h1>' +
    '<p class="page-subtitle">跨会话保留的项目知识、约定与分析结论</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="memory-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="memory-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="memory-new">${icon('plus', { size: 15 })}<span>新建记忆</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="memory-layout">' +
    '<div class="memory-list" id="memory-list"></div>' +
    '<section class="card memory-editor" id="memory-editor"></section>' +
    '</div></div>'
  );
}
