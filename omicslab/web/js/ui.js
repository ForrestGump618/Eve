// Shared UI primitives: toasts, busy indicator, modal / confirm / prompt dialogs,
// lightbox, empty states, theme switching and small DOM helpers.

import { icon } from './icons.js?v=2.0.0';
import { esc, getPref, setPref, copyText } from './util.js?v=2.0.0';
import { on, emit } from './bus.js?v=2.0.0';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/** Create an element from an HTML string (first element). */
export function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

/** Replace children of a node with an HTML string. */
export function setHtml(node, html) {
  node.innerHTML = html;
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape for innerHTML templates. Re-exported for view modules. */
export { esc };

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

const TOAST_ICONS = {
  success: 'checkCircle',
  error: 'xCircle',
  warn: 'alert',
  info: 'info',
};

function toastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Show a stacked, auto-dismissing toast.
 * @param {string} message
 * @param {{type?: 'success'|'error'|'warn'|'info', title?: string, timeout?: number,
 *          action?: {label: string, onClick: () => void}}} [opts]
 */
export function toast(message, opts = {}) {
  const { type = 'info', title = '', timeout = type === 'error' ? 6500 : 3600, action = null } = opts;
  const root = toastRoot();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML =
    `<span class="toast-icon">${icon(TOAST_ICONS[type] || 'info', { size: 17 })}</span>` +
    '<div class="toast-body">' +
    (title ? `<div class="toast-title">${esc(title)}</div>` : '') +
    `<div class="toast-msg">${esc(message)}</div>` +
    '</div>' +
    (action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : '') +
    `<button type="button" class="toast-close" aria-label="关闭提示">${icon('close', { size: 13 })}</button>`;

  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 180);
  };

  el.querySelector('.toast-close')?.addEventListener('click', close);
  const actionBtn = el.querySelector('.toast-action');
  if (actionBtn && action) {
    actionBtn.addEventListener('click', () => {
      try {
        action.onClick();
      } finally {
        close();
      }
    });
  }

  root.appendChild(el);
  // Keep the stack bounded so a reconnect loop cannot flood the screen.
  while (root.children.length > 5) root.firstElementChild?.remove();

  let timer = 0;
  if (timeout > 0) timer = setTimeout(close, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    if (timeout > 0) timer = setTimeout(close, 1800);
  });

  return { close, el };
}

export const toastSuccess = (msg, opts = {}) => toast(msg, { ...opts, type: 'success' });
export const toastError = (msg, opts = {}) => toast(msg, { ...opts, type: 'error' });
export const toastWarn = (msg, opts = {}) => toast(msg, { ...opts, type: 'warn' });
export const toastInfo = (msg, opts = {}) => toast(msg, { ...opts, type: 'info' });

/* ------------------------------------------------------------------ */
/* Busy indicator                                                      */
/* ------------------------------------------------------------------ */

let busyCount = 0;

function updateBusy() {
  const bar = document.getElementById('busy-bar');
  if (!bar) return;
  bar.classList.toggle('is-active', busyCount > 0);
}

function initBusy() {
  on('api:busy', ({ delta }) => {
    busyCount = Math.max(0, busyCount + (Number(delta) || 0));
    updateBusy();
  });
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

let modalLayer = 0;
const modalStack = [];
let modalEscHandler = null;

function ensureModalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    root.className = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

/** Modal root only intercepts pointer events while a dialog is attached (T01). */
function pruneModalRoot(root) {
  if (!root) root = document.getElementById('modal-root');
  if (!root || modalStack.length) return;
  if (!root.children.length) root.remove();
}

function modalErrorMessage(err) {
  if (!err) return '操作失败，请重试。';
  const base = err.message || String(err);
  const code = err.code ? `（${err.code}）` : '';
  const detail = err.detail && typeof err.detail === 'string' ? ` ${err.detail}` : '';
  return `${base}${code}${detail}`;
}

function bindModalEsc() {
  if (modalEscHandler) return;
  modalEscHandler = (evt) => {
    if (evt.key !== 'Escape' || evt.defaultPrevented) return;
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    evt.preventDefault();
    top.requestClose();
  };
  document.addEventListener('keydown', modalEscHandler, true);
}

function unbindModalEsc() {
  if (!modalEscHandler) return;
  document.removeEventListener('keydown', modalEscHandler, true);
  modalEscHandler = null;
}

/** Close every open dialog (route unmount / emergency cleanup). */
export function closeAllModals({ immediate = true } = {}) {
  for (const entry of [...modalStack]) {
    try {
      if (immediate) entry.finishNow();
      else entry.requestClose();
    } catch (err) {
      console.error('[modal] close failed', err);
    }
  }
}

export function hasOpenModal() {
  return modalStack.length > 0;
}

/**
 * Open an accessible modal.
 * @param {{title?: string, html?: string, node?: Node, bodyClass?: string, size?: 'sm'|'md'|'lg'|'xl',
 *          actions?: Array<{label: string, kind?: 'primary'|'ghost'|'danger', onClick?: (api: {close: () => void}) => void|boolean|Promise<void|boolean>}>,
 *          onClose?: () => void, dismissable?: boolean}} opts
 * @returns {{close: () => void, el: HTMLElement, body: HTMLElement, footer: HTMLElement}}
 */
export function openModal(opts = {}) {
  const {
    title = '',
    html = '',
    node = null,
    bodyClass = '',
    size = 'md',
    actions = [],
    onClose = null,
    dismissable = true,
  } = opts;

  const root = ensureModalRoot();
  const layerId = ++modalLayer;
  const previousFocus = document.activeElement;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.layer = String(layerId);
  backdrop.innerHTML =
    `<div class="modal modal-${size}" role="dialog" aria-modal="true" aria-label="${esc(title || '对话框')}">` +
    '<div class="modal-head">' +
    `<h3 class="modal-title">${esc(title) || '&nbsp;'}</h3>` +
    (dismissable
      ? `<button type="button" class="btn btn-ghost btn-icon modal-close" aria-label="关闭">${icon('close', { size: 16 })}</button>`
      : '') +
    '</div>' +
    `<div class="modal-body ${bodyClass}"></div>` +
    '<div class="modal-foot"></div>' +
    '</div>';

  const dialog = backdrop.querySelector('.modal');
  const body = backdrop.querySelector('.modal-body');
  const footer = backdrop.querySelector('.modal-foot');
  if (node) body.appendChild(node);
  else if (html) body.innerHTML = html;

  let closing = false;
  let finished = false;
  let closeTimer = 0;
  let downOnBackdrop = false;
  let errorBox = null;

  const restoreFocus = () => {
    if (!previousFocus || previousFocus === document.body) return;
    if (previousFocus.isConnected === false) return;
    if (typeof previousFocus.focus !== 'function') return;
    try {
      previousFocus.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(closeTimer);
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    if (backdrop.isConnected) backdrop.remove();
    if (!modalStack.length) unbindModalEsc();
    pruneModalRoot(root);
    restoreFocus();
    if (onClose) {
      try {
        onClose();
      } catch (err) {
        console.error('[modal] onClose failed', err);
      }
    }
  };

  const requestClose = () => {
    if (closing || finished || !backdrop.isConnected) return;
    closing = true;
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    backdrop.classList.add('is-closing');
    closeTimer = setTimeout(finish, 140);
  };

  const entry = { id: layerId, requestClose, finishNow: finish };
  modalStack.push(entry);
  bindModalEsc();

  const showActionError = (err) => {
    if (!errorBox) {
      errorBox = document.createElement('div');
      errorBox.className = 'modal-action-error';
      errorBox.setAttribute('role', 'alert');
      if (footer.isConnected) footer.prepend(errorBox);
      else body.prepend(errorBox);
    }
    errorBox.hidden = false;
    errorBox.textContent = modalErrorMessage(err);
    if (typeof errorBox.scrollIntoView === 'function') {
      try {
        errorBox.scrollIntoView({ block: 'nearest' });
      } catch {
        /* ignore */
      }
    }
  };

  const hideActionError = () => {
    if (errorBox) errorBox.hidden = true;
  };

  if (dismissable) {
    backdrop.querySelector('.modal-close')?.addEventListener('click', requestClose);
    backdrop.addEventListener('pointerdown', (evt) => {
      downOnBackdrop = evt.target === backdrop;
    });
    backdrop.addEventListener('click', (evt) => {
      if (downOnBackdrop && evt.target === backdrop) requestClose();
      downOnBackdrop = false;
    });
  }

  const actionApi = { close: requestClose, body, footer };
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${
      action.kind === 'primary' ? 'btn-primary' : action.kind === 'danger' ? 'btn-danger' : 'btn-ghost'
    }`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hideActionError();
      let result;
      try {
        result = action.onClick ? action.onClick(actionApi) : undefined;
      } catch (err) {
        // A synchronous throw must never leave the button dead or swallow the error.
        showActionError(err);
        return;
      }
      if (result && typeof result.then === 'function') {
        btn.disabled = true;
        Promise.resolve(result)
          .then((keep) => {
            btn.disabled = false;
            if (keep !== false) requestClose();
          })
          .catch((err) => {
            btn.disabled = false;
            showActionError(err);
            if (typeof btn.focus === 'function') btn.focus({ preventScroll: true });
          });
      } else if (result !== false) {
        requestClose();
      }
    });
    footer.appendChild(btn);
  }
  if (!actions.length) footer.remove();

  root.appendChild(backdrop);
  requestAnimationFrame(() => {
    if (finished) return;
    backdrop.classList.add('is-open');
    const focusTarget =
      body.querySelector('input, textarea, select, button:not(.modal-close)') ||
      footer.querySelector('button') ||
      dialog;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  });

  return { close: requestClose, el: backdrop, body, footer };
}

/** Confirmation dialog -> Promise<boolean>. */
export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      size: 'sm',
      html: `<p class="confirm-text">${esc(message)}</p>`,
      actions: [
        { label: cancelText, kind: 'ghost', onClick: () => done(false) },
        { label: confirmText, kind: danger ? 'danger' : 'primary', onClick: () => done(true) },
      ],
      onClose: () => done(false),
    });
    modal.el.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !(evt.target instanceof HTMLTextAreaElement)) {
        evt.preventDefault();
        done(true);
        modal.close();
      }
    });
  });
}

/** Text prompt dialog -> Promise<string|null>. */
export function promptDialog({
  title = '输入',
  message = '',
  value = '',
  placeholder = '',
  confirmText = '确定',
  cancelText = '取消',
  multiline = false,
  rows = 4,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const field = multiline
      ? `<textarea class="input input-area" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
    const modal = openModal({
      title,
      size: 'sm',
      html: (message ? `<p class="confirm-text">${esc(message)}</p>` : '') + field,
      actions: [
        { label: cancelText, kind: 'ghost', onClick: () => done(null) },
        {
          label: confirmText,
          kind: 'primary',
          onClick: ({ body }) => {
            const input = body.querySelector('.input');
            done(input ? input.value : null);
          },
        },
      ],
      onClose: () => done(null),
    });
    const input = modal.body.querySelector('.input');
    if (input) {
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' && (!multiline || evt.metaKey || evt.ctrlKey)) {
          evt.preventDefault();
          done(input.value);
          modal.close();
        }
      });
      setTimeout(() => {
        input.focus();
        if (!multiline) input.select();
      }, 30);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Lightbox                                                            */
/* ------------------------------------------------------------------ */

/**
 * Full-screen image viewer.
 * @param {{src: string, title?: string, alt?: string, downloadUrl?: string}} opts
 */
export function openLightbox({ src, title = '', alt = '', downloadUrl = '' } = {}) {
  const root = ensureModalRoot();
  const backdrop = document.createElement('div');
  backdrop.className = 'lightbox-backdrop';
  backdrop.innerHTML =
    '<div class="lightbox" role="dialog" aria-modal="true">' +
    `<img class="lightbox-img" src="${esc(src)}" alt="${esc(alt || title || '图片预览')}" />` +
    '<div class="lightbox-bar">' +
    `<span class="lightbox-title">${esc(title || alt || '')}</span>` +
    '<span class="lightbox-actions">' +
    (downloadUrl
      ? `<a class="btn btn-ghost btn-sm" href="${esc(downloadUrl)}" download>${icon('download', { size: 15 })}<span>下载</span></a>`
      : '') +
    `<button type="button" class="btn btn-ghost btn-sm lightbox-close" aria-label="关闭">${icon('close', { size: 15 })}<span>关闭</span></button>` +
    '</span></div></div>';

  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.classList.add('is-closing');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => backdrop.remove(), 140);
  };
  const onKey = (evt) => {
    if (evt.key === 'Escape') {
      evt.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', (evt) => {
    if (evt.target === backdrop || evt.target.classList.contains('lightbox-close') || evt.target.closest?.('.lightbox-close')) {
      close();
    }
  });
  root.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  return { close };
}

/* ------------------------------------------------------------------ */
/* Empty state / errors / loaders                                      */
/* ------------------------------------------------------------------ */

/** HTML string for a friendly empty state with optional inline action button. */
export function emptyStateHtml({ iconName = 'sparkle', title = '暂无内容', hint = '', actionLabel = '', actionId = '' } = {}) {
  const ic = iconName === 'sparkle' ? icon('wand', { size: 30 }) : icon(iconName, { size: 30 });
  return (
    '<div class="empty-state">' +
    `<div class="empty-art">${ic}</div>` +
    `<div class="empty-title">${esc(title)}</div>` +
    (hint ? `<div class="empty-hint">${esc(hint)}</div>` : '') +
    (actionLabel
      ? `<button type="button" class="btn btn-primary btn-sm empty-action"${actionId ? ` id="${esc(actionId)}"` : ''}>${esc(actionLabel)}</button>`
      : '') +
    '</div>'
  );
}

export function spinnerHtml(label = '加载中…') {
  return `<div class="loading-inline"><span class="spinner"></span><span>${esc(label)}</span></div>`;
}

/** Build an error card element (never a white screen). Used by the app error boundary. */
export function errorCard(err, { retryLabel = '', onRetry = null, context = '' } = {}) {
  const message = err && err.message ? err.message : String(err || '未知错误');
  const detail = err && (err.stack || err.detail) ? err.stack || JSON.stringify(err.detail, null, 2) : '';
  const el = h(
    '<div class="error-card" role="alert">' +
      `<div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 18 })}</span>` +
      `<div><div class="error-card-title">页面出现错误</div>` +
      (context ? `<div class="error-card-context">${esc(context)}</div>` : '') +
      '</div></div>' +
      `<div class="error-card-msg">${esc(message)}</div>` +
      (retryLabel ? '<div class="error-card-actions"></div>' : '') +
      (detail
        ? `<details class="error-card-detail"><summary>技术细节</summary><pre>${esc(detail)}</pre></details>`
        : '') +
      '</div>',
  );
  if (retryLabel && onRetry) {
    const actions = el.querySelector('.error-card-actions');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = retryLabel;
    btn.addEventListener('click', onRetry);
    actions.appendChild(btn);
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export function currentTheme() {
  const stored = getPref('theme', null);
  if (stored === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (stored === 'light' || stored === 'dark') return stored;
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme, { persist = true } = {}) {
  const value = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  if (persist) setPref('theme', theme === 'system' ? 'system' : value);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', value === 'light' ? '#f5f6fa' : '#0f1117');
  emit('theme:change', { theme: value });
  return value;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

/* ------------------------------------------------------------------ */
/* Clipboard delegation + global keys                                  */
/* ------------------------------------------------------------------ */

/** Copy buttons rendered by the markdown renderer: `.code-copy` inside `.md-code`. */
async function handleCopyClick(evt) {
  const btn = evt.target.closest?.('.code-copy, [data-copy]');
  if (!btn) return;
  let text = btn.getAttribute('data-copy');
  if (text === null) {
    const host = btn.closest('.md-code, .code-block');
    const code = host?.querySelector('pre code, pre');
    text = code ? code.textContent : '';
  }
  if (!text) return;
  const ok = await copyText(text);
  if (!ok) {
    toastError('复制失败，请手动选择文本');
    return;
  }
  const label = btn.querySelector('span');
  const original = label ? label.textContent : '';
  btn.classList.add('is-copied');
  if (label) label.textContent = '已复制';
  setTimeout(() => {
    btn.classList.remove('is-copied');
    if (label && original) label.textContent = original;
  }, 1400);
}

/** Wire global UI behaviour once at boot. */
export function initUi() {
  initBusy();
  document.addEventListener('click', handleCopyClick);
  document.addEventListener('click', (evt) => {
    const themeBtn = evt.target.closest?.('[data-action="toggle-theme"]');
    if (themeBtn) toggleTheme();
  });
  document.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape' || evt.defaultPrevented) return;
    const top = modalStack[modalStack.length - 1];
    if (top) {
      evt.preventDefault();
      top.requestClose?.();
    }
  });
  applyTheme(currentTheme(), { persist: false });
}
