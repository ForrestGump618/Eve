// Application shell: sidebar navigation, hash router, health polling,
// offline banner, theme switching and the Ctrl/Cmd+K command palette.

import { icon, brandMark } from './icons.js?v=1.0.0';
import { esc, getPref, relTime } from './util.js?v=1.0.0';
import { api, errorMessage } from './api.js?v=1.0.0';
import {
  initUi,
  toastError,
  toastSuccess,
  toastInfo,
  errorCard,
  emptyStateHtml,
  spinnerHtml,
  currentTheme,
  toggleTheme,
  confirmDialog,
  closeAllModals,
  h,
} from './ui.js?v=1.0.0';
import { on, emit } from './bus.js?v=1.0.0';
import {workspaceSidebarHtml,mountSidebarNavigation} from './workspace-sidebar.js?v=1.0.0';
import { initApprovalCenter } from './approvals.js?v=1.0.0';
import { mountEveSelects } from './eve-select.js?v=1.0.0';
import {
  ROUTES,
  state,
  getState,
  setState,
  navigate,
  parseHash,
  routeMeta,
  requestShellRefresh,
} from './store.js?v=1.0.0';

const HEALTH_INTERVAL_MS = 15000;

const VIEW_LOADERS = {
  dashboard: () => import('./views/dashboard.js?v=1.0.0'),
  literature: () => import('./views/literature.js?v=1.0.0'),
  evolution: () => import('./views/evolution.js?v=1.0.0'),
  context: () => import('./views/context-dashboard.js?v=1.0.0'),
  teams: () => import('./views/teams.js?v=1.0.0'),
  settings: () => import('./views/platform.js?v=1.0.0'),
  tasks2: () => import('./views/platform.js?v=1.0.0'),
  extensions: () => import('./views/platform.js?v=1.0.0'),
  knowledge: () => import('./views/platform.js?v=1.0.0'),
  workflow: () => import('./views/platform.js?v=1.0.0'),
  research: () => import('./views/platform.js?v=1.0.0'),
  artifacts: () => import('./views/platform.js?v=1.0.0'),
  diagnostics: () => import('./views/platform.js?v=1.0.0'),
  connections: () => import('./views/settings.js?v=1.0.0'),
  workbench: () => import('./views/workbench.js?v=1.0.0'),
  chat: () => import('./views/chat.js?v=1.0.0'),
  discovery: () => import('./views/discovery.js?v=1.0.0'),
  vars: () => import('./views/vars.js?v=1.0.0'),
  files: () => import('./views/files.js?v=1.0.0'),
  figures: () => import('./views/figures.js?v=1.0.0'),
  jobs: () => import('./views/jobs.js?v=1.0.0'),
  skills: () => import('./views/skills.js?v=1.0.0'),
  registry: () => import('./views/registry.js?v=1.0.0'),
  memory: () => import('./views/memory.js?v=1.0.0'),
  ssh: () => loadSshView(),
};

// SSH lives in js/views/ssh.js and is authored in parallel. If the module has not
// landed yet (or fails to load), fall back to a friendly placeholder instead of the
// generic error card so navigation never breaks.
async function loadSshView() {
  let mod = null;
  try {
    mod = await import('./views/ssh.js?v=1.0.0');
  } catch (err) {
    console.warn('[app] views/ssh.js 尚未就绪', err);
    return sshPlaceholderView();
  }
  const view = mod && typeof mod.mount === 'function' ? mod : mod?.default;
  if (!view || typeof view.mount !== 'function') {
    console.warn('[app] views/ssh.js 未导出 mount');
    return sshPlaceholderView();
  }
  return {
    async mount(root, ctx) {
      const instance = await view.mount(root, ctx);
      return {
        destroy() {
          try {
            if (instance && typeof instance.destroy === 'function') instance.destroy();
            else if (typeof view.unmount === 'function') view.unmount();
          } catch (err) {
            console.warn('[app] SSH 页面卸载失败', err);
          }
        },
      };
    },
  };
}

function sshPlaceholderView() {
  return {
    mount(root) {
      root.innerHTML =
        '<div class="page ssh-page">' +
        emptyStateHtml({
          iconName: 'ssh',
          title: 'SSH 模块未就绪',
          hint: 'SSH 前端模块（js/views/ssh.js）尚未加载，可能仍在构建中。稍后点击重试即可。',
          actionLabel: '重试',
          actionId: 'ssh-retry',
        }) +
        '</div>';
      const btn = root.querySelector('#ssh-retry');
      const onClick = () => renderRoute('ssh', { force: true });
      if (btn) btn.addEventListener('click', onClick);
      return {
        destroy() {
          if (btn) btn.removeEventListener('click', onClick);
          root.innerHTML = '';
        },
      };
    },
  };
}

const app = {
  shell: null,
  viewRoot: null,
  nav: null,
  current: null,
  mountToken: 0,
  healthTimer: 0,
  palette: null,
  navOpen: false,
  selectDispose: null,
};

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function shellHtml() {
  const order = ['dashboard','literature','workbench','chat','tasks2','teams','context','research','knowledge','workflow','artifacts','extensions','discovery','ssh','settings','diagnostics'];
  const navItems = ROUTES.filter(route => !route.hidden).sort((a,b) => order.indexOf(a.id)-order.indexOf(b.id)).map(
    (route) =>
      `<button type="button" class="nav-item" data-route="${route.id}" title="${esc(route.label)}">` +
      `<span class="nav-icon">${icon(route.icon, { size: 18 })}</span>` +
      `<span class="nav-label">${esc(route.label)}</span>` +
      `<span class="nav-badge" data-badge="${route.id}" hidden></span>` +
      '</button>',
  ).join('');

  return (
    '<div id="busy-bar" class="busy-bar" role="progressbar" aria-hidden="true"></div>' +
    '<div class="offline-banner" id="offline-banner" hidden>' +
    `<span class="offline-icon">${icon('alert', { size: 16 })}</span>` +
    '<span class="offline-text">无法连接后端服务，界面处于离线状态</span>' +
    '<span class="offline-detail" id="offline-detail"></span>' +
    '<button type="button" class="btn btn-ghost btn-sm offline-retry" id="offline-retry">重试连接</button>' +
    '</div>' +
    '<div class="app-shell" id="app-shell">' +
    '<aside class="app-sidebar chat-sidebar workspace-sidebar" id="app-sidebar" aria-label="项目与最近会话">' +
    workspaceSidebarHtml() +
    `<details class="workspace-menu"><summary>更多功能</summary><nav class="app-nav" id="app-nav">${navItems}</nav></details>` +
    '</aside>' +
    '<div class="app-scrim" id="app-scrim"></div>' +
    '<div class="app-body">' +
    '<header class="mobile-topbar">' +
    `<button type="button" class="icon-btn" id="nav-toggle" aria-label="打开导航">${icon('menu', { size: 20 })}</button>` +
    `<span class="mobile-brand">${brandMark(24, 'mobile')}<span>Eve</span></span>` +
    '<span class="mobile-status"><span class="status-dot" id="mobile-status-dot"></span></span>' +
    '</header>' +
    '<main class="view-root" id="view-root" role="main"></main>' +
    '</div>' +
    '</div>'
  );
}

function buildShell(root) {
  root.innerHTML = shellHtml();
  app.selectDispose?.();
  app.selectDispose = mountEveSelects(document);
  app.shell = root.querySelector('#app-shell');
  app.viewRoot = root.querySelector('#view-root');
  app.nav = root.querySelector('#app-nav');

  app.nav.addEventListener('click', (evt) => {
    const btn = evt.target.closest('.nav-item');
    if (!btn) return;
    navigate(btn.dataset.route);
    closeNav();
  });

  root.querySelector('#nav-toggle')?.addEventListener('click', () => toggleNav());
  root.querySelector('#app-scrim')?.addEventListener('click', () => closeNav());
  root.querySelector('#sidebar-kernel')?.addEventListener('click', () => navigate('vars'));
  root.querySelector('#theme-toggle')?.addEventListener('click', () => {
    toggleTheme();
    updateThemeButton();
  });
  root.querySelector('#palette-open')?.addEventListener('click', () => openPalette());
  root.querySelector('#offline-retry')?.addEventListener('click', async () => {
    const btn = root.querySelector('#offline-retry');
    btn.disabled = true;
    btn.classList.add('is-loading');
    await pollHealth({ initial: false });
    btn.disabled = false;
    btn.classList.remove('is-loading');
  });

  on('theme:change', () => {
    updateThemeButton();
  });
  on('figures:count', (count) => {
    updateFiguresBadge(count);
  });
}

function toggleNav(force) {
  app.navOpen = force == null ? !app.navOpen : Boolean(force);
  app.shell?.classList.toggle('nav-open', app.navOpen);
}

function closeNav() {
  if (app.navOpen) toggleNav(false);
}

function updateNav() {
  const route = state.route;
  app.nav?.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.route === route);
  });
}

function updateThemeButton() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  btn.innerHTML = icon(dark ? 'sun' : 'moon', { size: 17 });
  btn.title = dark ? '切换到浅色主题' : '切换到深色主题';
}

function updateFiguresBadge(count) {
  const badge = app.nav?.querySelector('[data-badge="figures"]');
  if (!badge) return;
  const n = Number(count) || 0;
  if (n > 0) {
    badge.hidden = false;
    badge.textContent = n > 99 ? '99+' : String(n);
  } else {
    badge.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

function updateHealthUi() {
  const health = state.health;
  const online = state.online;
  const banner = document.getElementById('offline-banner');
  if (banner) {
    banner.hidden = online;
    const detail = document.getElementById('offline-detail');
    if (detail) detail.textContent = online ? '' : '（API 请求可能失败，正在自动重试）';
  }
  const kernel = health?.kernel || {};
  const kernelRunning = Boolean(kernel.running);
  const label = document.querySelector('.sidebar-kernel-label');
  const dot = document.querySelector('#sidebar-kernel .status-dot');
  if (label) label.textContent = online ? (kernelRunning ? '内核运行中' : '内核未启动') : '后端未连接';
  if (dot) {
    dot.className = 'status-dot';
    if (!online) dot.classList.add('is-off');
    else dot.classList.add(kernelRunning ? 'is-ok' : 'is-warn');
  }
  const mobileDot = document.getElementById('mobile-status-dot');
  if (mobileDot) {
    mobileDot.className = 'status-dot';
    mobileDot.classList.add(!online ? 'is-off' : health?.ok ? 'is-ok' : 'is-warn');
  }
  const version = document.getElementById('sidebar-version');
  if (version) {
    const bits = ['Eve'];
    if (health?.version) bits.push(`v${health.version}`);
    bits.push(online ? '本地运行' : '离线');
    version.textContent = bits.join(' · ');
  }
  if (health?.workspace) {
    document.documentElement.dataset.workspace = health.workspace;
  }
}

async function pollHealth({ initial = false } = {}) {
  try {
    const health = await api.health();
    setState({ health, online: Boolean(health?.ok !== false) });
    updateHealthUi();
    return health;
  } catch (err) {
    if (initial && state.online !== false) {
      // keep the banner only for the initial failure; polling refreshes it silently
    }
    setState({ online: false, health: null });
    updateHealthUi();
    return null;
  }
}

function startHealthPolling() {
  stopHealthPolling();
  app.healthTimer = setInterval(() => {
    if (document.hidden) return;
    pollHealth();
  }, HEALTH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollHealth();
  });
  window.addEventListener('online', () => pollHealth());
  window.addEventListener('offline', () => {
    setState({ online: false });
    updateHealthUi();
  });
}

function stopHealthPolling() {
  if (app.healthTimer) clearInterval(app.healthTimer);
  app.healthTimer = 0;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function renderRoute(route, { force = false } = {}) {
  const target = ROUTES.some((r) => r.id === route) ? route : 'chat';
  if (!force && app.current && state.route === target) return;
  document.body.dataset.route = target;
  // T01: dialogs are view-owned; leave no stale layer behind on route change.
  closeAllModals();
  app.sidebarDispose?.();app.sidebarDispose=null;
  const previousInstance=app.current;
  const previousMount=app.viewRoot?.querySelector(':scope > .route-mount')||null;
  const token = ++app.mountToken;
  const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  setState({ route: target });
  updateNav();
  document.title = `${routeMeta(target).label} · Eve`;
  closeNav();
  if(previousMount&&!reduceMotion){
    previousMount.classList.add('is-route-leaving');
    await new Promise(resolve=>setTimeout(resolve,100));
    if(token!==app.mountToken)return;
  }
  if (previousInstance) {
    try {
      previousInstance.destroy?.();
    } catch (err) {
      console.warn('[app] view destroy failed', err);
    }
    app.current = null;
  }
  app.viewRoot.innerHTML = `<div class="route-loading">${spinnerHtml('加载页面')}</div>`;
  try {
    const loader = VIEW_LOADERS[target];
    if (!loader) throw new Error(`未知页面：${target}`);
    const mod = await loader();
    if (token !== app.mountToken) return;
    if (typeof mod.mount !== 'function') throw new Error('页面模块缺少 mount 导出');
    app.viewRoot.innerHTML = '';
    // Each asynchronous mount owns its own DOM root. A superseded mount's
    // destroy() must never clear a newer route that shares viewRoot.
    const mountRoot=document.createElement('div');
    mountRoot.className=reduceMotion?'route-mount':'route-mount is-route-entering';
    app.viewRoot.replaceChildren(mountRoot);
    const instance = await mod.mount(mountRoot, {
      navigate,
      refreshShell: requestShellRefresh,
      getState,
      setState,
      shellSidebar:document.querySelector('#app-sidebar'),
      toggleNav,
    });
    if (token !== app.mountToken) {
      instance?.destroy?.();
      return;
    }
    app.current = instance || null;
    if (target === 'workbench' && typeof state.routeParams?.prefill === 'string') {
      const text = state.routeParams.prefill;
      delete state.routeParams.prefill;
      emit('chat:prefill', { text });
    }
    if(!reduceMotion)requestAnimationFrame(()=>requestAnimationFrame(()=>mountRoot.classList.remove('is-route-entering')));
    if(!['workbench','chat'].includes(target))app.sidebarDispose=await mountSidebarNavigation(document.querySelector('#app-sidebar'),action=>{app.pendingChatAction=action;navigate('workbench');});
    if(app.pendingChatAction&&['workbench','chat'].includes(target)){const action=app.pendingChatAction;app.pendingChatAction=null;emit(action.type==='new'?'chat:new-conversation':'chat:select',action.id);}
  } catch (err) {
    if (token !== app.mountToken) return;
    console.error('[app] view failed', err);
    app.viewRoot.innerHTML = '';
    app.viewRoot.appendChild(
      errorCard(err, {
        context: `页面「${routeMeta(target).label}」加载失败`,
        retryLabel: '重新加载页面',
        onRetry: () => renderRoute(target, { force: true }),
      }),
    );
    toastError(`页面加载失败：${errorMessage(err)}`, {
      action: { label: '重新加载', onClick: () => renderRoute(target, { force: true }) },
    });
  }
}

function handleHashChange() {
  const route = parseHash(window.location.hash);
  renderRoute(route);
}

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

function paletteActions() {
  const routeActions = ROUTES.map((route) => ({
    id: `route-${route.id}`,
    label: `前往${route.label}`,
    hint: route.subtitle,
    icon: route.icon,
    group: '页面',
    run: () => {
      navigate(route.id);
    },
  }));
  return [
    ...routeActions,
    {
      id: 'new-conv',
      label: '新建对话',
      hint: '打开聊天并创建一个新会话',
      icon: 'plus',
      group: '操作',
      run: () => {
        navigate('chat');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('omicslab:new-conversation'));
        }, 120);
      },
    },
    {
      id: 'restart-kernel',
      label: '重启内核',
      hint: '清空内核变量并重新启动 Jupyter 内核',
      icon: 'refresh',
      group: '操作',
      run: async () => {
        const ok = await confirmDialog({
          title: '重启内核',
          message: '重启后当前内核中的所有变量都会丢失，确定继续吗？',
          confirmText: '重启内核',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.kernel.restart();
          toastSuccess('内核已重启');
          pollHealth();
        } catch (err) {
          toastError(`重启失败：${errorMessage(err)}`);
        }
      },
    },
    {
      id: 'toggle-theme',
      label: '切换浅色 / 深色主题',
      hint: '主题偏好会保存在浏览器中',
      icon: 'sun',
      group: '外观',
      run: () => toggleTheme(),
    },
    {
      id: 'refresh-health',
      label: '重新检测后端连接',
      hint: '立即轮询 /api/health',
      icon: 'refresh',
      group: '系统',
      run: async () => {
        const health = await pollHealth();
        if (health) toastSuccess('后端连接正常');
        else toastError('仍然无法连接后端');
      },
    },
    {
      id: 'reload-view',
      label: '刷新当前页面',
      hint: '重新挂载当前视图',
      icon: 'refresh',
      group: '系统',
      run: () => renderRoute(state.route, { force: true }),
    },
  ];
}

function openPalette() {
  if (app.palette) {
    closePalette();
    return;
  }
  const root = document.createElement('div');
  root.className = 'palette-root';
  root.innerHTML =
    '<div class="palette-backdrop">' +
    '<div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">' +
    '<div class="palette-input-wrap">' +
    `${icon('search', { size: 17 })}` +
    '<input class="palette-input" type="text" placeholder="搜索页面或命令…" aria-label="命令搜索" autocomplete="off" />' +
    '<kbd class="palette-esc">Esc</kbd>' +
    '</div>' +
    '<div class="palette-results" id="palette-results"></div>' +
    '<div class="palette-foot"><span>↑ ↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></div>' +
    '</div></div>';
  document.body.appendChild(root);
  app.palette = root;

  const input = root.querySelector('.palette-input');
  const results = root.querySelector('#palette-results');
  const actions = paletteActions();
  let filtered = actions;
  let activeIndex = 0;

  const render = () => {
    if (!filtered.length) {
      results.innerHTML = `<div class="palette-empty">没有匹配的命令</div>`;
      return;
    }
    let html = '';
    let lastGroup = '';
    filtered.forEach((action, idx) => {
      if (action.group !== lastGroup) {
        html += `<div class="palette-group">${esc(action.group)}</div>`;
        lastGroup = action.group;
      }
      html +=
        `<button type="button" class="palette-item${idx === activeIndex ? ' is-active' : ''}" data-idx="${idx}">` +
        `<span class="palette-item-icon">${icon(action.icon || 'chevronRight', { size: 16 })}</span>` +
        `<span class="palette-item-body"><span class="palette-item-label">${esc(action.label)}</span>` +
        `<span class="palette-item-hint">${esc(action.hint || '')}</span></span>` +
        (idx === activeIndex ? '<span class="palette-enter">Enter</span>' : '') +
        '</button>';
    });
    results.innerHTML = html;
  };

  const runAt = (idx) => {
    const action = filtered[idx];
    if (!action) return;
    closePalette();
    setTimeout(() => {
      try {
        action.run();
      } catch (err) {
        toastError(errorMessage(err));
      }
    }, 10);
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? actions.filter(
          (a) =>
            a.label.toLowerCase().includes(q) ||
            (a.hint || '').toLowerCase().includes(q) ||
            (a.group || '').toLowerCase().includes(q),
        )
      : actions;
    activeIndex = 0;
    render();
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (evt) => {
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      activeIndex = (activeIndex + 1) % Math.max(1, filtered.length);
      render();
      scrollActiveIntoView(results);
    } else if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      activeIndex = (activeIndex - 1 + filtered.length) % Math.max(1, filtered.length);
      render();
      scrollActiveIntoView(results);
    } else if (evt.key === 'Enter') {
      evt.preventDefault();
      runAt(activeIndex);
    } else if (evt.key === 'Escape') {
      evt.preventDefault();
      closePalette();
    }
  });
  results.addEventListener('click', (evt) => {
    const item = evt.target.closest('.palette-item');
    if (item) runAt(Number(item.dataset.idx));
  });
  root.addEventListener('mousedown', (evt) => {
    if (evt.target === root || evt.target.classList.contains('palette-backdrop')) closePalette();
  });

  render();
  requestAnimationFrame(() => input.focus());
  document.addEventListener('keydown', paletteEscHandler, true);
}

function scrollActiveIntoView(container) {
  const active = container.querySelector('.palette-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paletteEscHandler(evt) {
  if (evt.key === 'Escape') {
    evt.preventDefault();
    closePalette();
  }
}

function closePalette() {
  if (!app.palette) return;
  app.palette.remove();
  app.palette = null;
  document.removeEventListener('keydown', paletteEscHandler, true);
}

/* ------------------------------------------------------------------ */
/* Global shortcuts + error boundary                                   */
/* ------------------------------------------------------------------ */

function bindGlobalKeys() {
  document.addEventListener('keydown', (evt) => {
    const meta = evt.metaKey || evt.ctrlKey;
    if (meta && evt.shiftKey && evt.key.toLowerCase() === 'f' && state.route === 'workbench') {
      // The mounted chat view owns the actual locator and performs the jump.
      evt.preventDefault();
      evt.stopPropagation();
      document.querySelector('#chat-locator-btn')?.click();
      return;
    }
    if (meta && evt.key.toLowerCase() === getPref('paletteShortcut','k')) {
      evt.preventDefault();
      openPalette();
      return;
    }
    if (evt.key === 'Escape' && app.navOpen) {
      closeNav();
    }
  });
  window.addEventListener('omicslab:new-conversation', () => {
    // Chat view listens to this detached event via the store/bus bridge below.
  });
  // Bridge: CustomEvent from the palette -> bus event (chat view subscribes).
  window.addEventListener('omicslab:new-conversation', async () => {
    const { emit } = await import('./bus.js?v=1.0.0');
    emit('chat:new-conversation', {});
  });
}

function bindErrorBoundary() {
  window.addEventListener('unhandledrejection', (evt) => {
    console.error('[app] unhandled rejection', evt.reason);
    const msg = errorMessage(evt.reason);
    if (msg && !/aborted|AbortError/i.test(msg)) toastError(msg, { timeout: 5000 });
  });
  window.addEventListener('error', (evt) => {
    if (evt?.error) console.error('[app] window error', evt.error);
  });
}

async function loadFiguresBadge() {
  try {
    const data = await api.figures.list();
    const figures = Array.isArray(data?.figures) ? data.figures : Array.isArray(data) ? data : [];
    setState({ figuresCount: figures.length });
    updateFiguresBadge(figures.length);
  } catch {
    updateFiguresBadge(0);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  const root = document.getElementById('app');
  if (!root) {
    console.error('[app] #app root not found');
    return;
  }
  buildShell(root);
  if(window.suwenDesktop){
    document.documentElement.classList.add('desktop-hosted');
    const titlebar=document.createElement('div');titlebar.className='desktop-titlebar';
    titlebar.innerHTML=`<button type="button" class="desktop-history" id="desktop-back" aria-label="返回">←</button><button type="button" class="desktop-history" id="desktop-forward" aria-label="前进">→</button><span class="desktop-app-label">Eve</span>`;
    titlebar.querySelector('#desktop-back').addEventListener('click',()=>history.back());titlebar.querySelector('#desktop-forward').addEventListener('click',()=>history.forward());
    const rail=document.createElement('nav');rail.className='desktop-rail';rail.setAttribute('aria-label','快捷导航');
    rail.innerHTML=[['workbench','layers','工作台'],['literature','book','文献'],['tasks2','clock','任务'],['extensions','skills','技能'],['ssh','terminal','SSH'],['settings','settings','设置']].map(([route,name,label])=>`<a href="#/${route}" title="${label}" aria-label="${label}">${icon(name,{size:22})}</a>`).join('');
    document.body.prepend(titlebar,rail);
  }
  initUi();
  initApprovalCenter();
  bindGlobalKeys();
  bindErrorBoundary();
  updateThemeButton();
  updateNav();
  setState({ route: parseHash() });

  window.addEventListener('hashchange', handleHashChange);

  await Promise.allSettled([pollHealth({ initial: true }), loadFiguresBadge()]);
  startHealthPolling();

  const bootRoute = parseHash();
  await renderRoute(bootRoute);
  const { initPlatform } = await import("./suwen.js?v=1.0.0");
  await initPlatform();
  document.documentElement.dataset.ready='true';
  window.addEventListener('beforeunload', () => {
    try {
      app.current?.destroy?.();
    } catch {
      /* ignore */
    }
  });
}

boot();

void getPref;
void h;
void relTime;
void emptyStateHtml;
void toastInfo;
