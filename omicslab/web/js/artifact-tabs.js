import {icon} from './icons.js?v=2.1.1';
import {on} from './bus.js?v=2.1.1';
import {errorMessage} from './api.js?v=2.1.1';
import {artifactConfig, ensureArtifactStyles} from './artifact-config.js';

let sidebar = null;
let nextTabId = 0;

/** Trusted renderers return {node, dispose?}; disposal also runs for late results. */
export function createArtifactSidebar({host = document.body} = {}) {
  ensureArtifactStyles();
  const controller = new AbortController();
  const {signal} = controller;
  const entries = new Map();
  const previousFocus = document.activeElement;
  let activeId = null;
  let disposed = false;
  const root = document.createElement('aside');
  root.className = 'artifact-sidebar';
  root.setAttribute('aria-label', '工作产物');
  root.innerHTML = `<header class="artifact-sidebar-head"><strong>工作产物</strong><div class="artifact-sidebar-controls">
    <button type="button" class="icon-btn" data-artifact-expand aria-label="展开产物面板" aria-pressed="false">${icon('external')}</button>
    <button type="button" class="icon-btn" data-artifact-minimize aria-label="收起产物面板">${icon('minus')}</button>
    <button type="button" class="icon-btn" data-artifact-close-all aria-label="关闭全部产物">${icon('close')}</button>
    </div></header><div class="artifact-tablist" role="tablist" aria-label="已打开的产物"></div><div class="artifact-panels"></div>`;
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'btn artifact-reopen';
  reopen.textContent = '查看产物';
  reopen.hidden = true;
  reopen.setAttribute('aria-expanded', 'false');
  host.append(root, reopen);
  const tabs = root.querySelector('.artifact-tablist');
  const panels = root.querySelector('.artifact-panels');
  const listen = (node, type, handler) => node.addEventListener(type, handler, {signal});

  function activate(id, focus = true) {
    if (disposed || !entries.has(id)) return;
    activeId = id;
    root.hidden = false;
    reopen.hidden = true;
    reopen.setAttribute('aria-expanded', 'true');
    for (const [key, entry] of entries) {
      const selected = key === id;
      entry.tab.setAttribute('aria-selected', String(selected));
      entry.tab.tabIndex = selected ? 0 : -1;
      entry.panel.hidden = !selected;
    }
    if (focus) entries.get(id).tab.focus({preventScroll: true});
  }

  function minimize() {
    root.hidden = true;
    reopen.hidden = false;
    reopen.setAttribute('aria-expanded', 'false');
    reopen.focus({preventScroll: true});
  }

  function release(entry) {
    entry.controller.abort();
    try { entry.result?.dispose?.(); }
    catch (error) { console.error('[artifact] cleanup failed', error); }
    entry.result = null;
    entry.wrapper.remove();
    entry.panel.remove();
  }

  function close(id) {
    const entry = entries.get(id);
    if (!entry) return;
    const keys = [...entries.keys()];
    const index = keys.indexOf(id);
    entries.delete(id);
    release(entry);
    if (!entries.size) { dispose(); return; }
    if (id === activeId) activate(keys[index + 1] || keys[index - 1]);
  }

  async function load(entry) {
    entry.panel.setAttribute('aria-busy', 'true');
    const status = document.createElement('p');
    status.className = 'artifact-status';
    status.setAttribute('role', 'status');
    status.textContent = '正在读取产物…';
    entry.panel.replaceChildren(status);
    try {
      const result = await entry.render({signal: entry.controller.signal, close: entry.handle.close});
      if (disposed || entry.controller.signal.aborted) { result?.dispose?.(); return; }
      if (!(result?.node instanceof Node)) {
        result?.dispose?.();
        throw Error('预览器没有返回可显示的内容');
      }
      entry.result = result;
      entry.panel.replaceChildren(result.node);
    } catch (error) {
      if (disposed || entry.controller.signal.aborted) return;
      status.setAttribute('role', 'alert');
      status.textContent = `无法预览：${errorMessage(error)}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-ghost btn-sm';
      retry.textContent = '重新读取';
      listen(retry, 'click', () => { void load(entry); });
      entry.panel.append(retry);
    } finally {
      entry.panel.removeAttribute('aria-busy');
    }
  }

  function open({id, title, render}) {
    if (disposed) throw Error('产物面板已关闭');
    if (entries.has(id)) { activate(id); return entries.get(id).handle; }
    if (entries.size >= artifactConfig.maxTabs) throw Error('产物标签已满，请先关闭一个标签');
    const domId = `eve-artifact-${++nextTabId}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'artifact-tab';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `${domId}-tab`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', domId);
    tab.textContent = title || '工作产物';
    tab.title = tab.textContent;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.setAttribute('aria-label', `关闭 ${tab.textContent}`);
    remove.innerHTML = icon('close');
    const panel = document.createElement('section');
    panel.id = domId;
    panel.className = 'artifact-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    wrapper.append(tab, remove);
    tabs.append(wrapper);
    panels.append(panel);
    const handle = {close: () => close(id), activate: () => activate(id), body: panel, el: root};
    const entry = {tab, wrapper, panel, render, handle, controller: new AbortController(), result: null};
    entries.set(id, entry);
    listen(tab, 'click', () => activate(id));
    listen(remove, 'click', () => close(id));
    activate(id);
    void load(entry);
    return handle;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    offRoute(); offWorkspace();
    for (const entry of entries.values()) release(entry);
    entries.clear();
    const restoreFocus = root.contains(document.activeElement) || document.activeElement === reopen;
    root.remove(); reopen.remove();
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    if (sidebar === service) sidebar = null;
  }

  listen(root.querySelector('[data-artifact-expand]'), 'click', event => {
    const expanded = root.classList.toggle('is-expanded');
    event.currentTarget.setAttribute('aria-pressed', String(expanded));
    event.currentTarget.setAttribute('aria-label', expanded ? '还原产物面板' : '展开产物面板');
  });
  listen(root.querySelector('[data-artifact-minimize]'), 'click', minimize);
  listen(root.querySelector('[data-artifact-close-all]'), 'click', dispose);
  listen(reopen, 'click', () => activate(activeId));
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); minimize(); }
  });
  listen(tabs, 'keydown', event => {
    if (event.target.getAttribute('role') !== 'tab') return;
    const ids = [...entries.keys()];
    const index = ids.indexOf(activeId);
    let target;
    if (event.key === 'ArrowRight') target = ids[(index + 1) % ids.length];
    if (event.key === 'ArrowLeft') target = ids[(index + ids.length - 1) % ids.length];
    if (event.key === 'Home') target = ids[0];
    if (event.key === 'End') target = ids.at(-1);
    if (event.key === 'Delete') { event.preventDefault(); close(activeId); }
    if (target) { event.preventDefault(); activate(target); }
  });
  listen(window, 'hashchange', dispose);
  const offRoute = on('route:request', dispose);
  const offWorkspace = on('workspace:change', dispose);
  const service = {open, close, dispose, el: root};
  return service;
}

export function getArtifactSidebar() {
  if (!sidebar) sidebar = createArtifactSidebar();
  return sidebar;
}

export function closeArtifactSidebar() { sidebar?.dispose(); }
