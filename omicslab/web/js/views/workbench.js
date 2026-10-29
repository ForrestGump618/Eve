/**
 * Workbench view (task book T04/T09).
 *
 * One screen for the whole analysis loop:
 *   top bar   : workspace + backend / host / directory / environment / connection
 *   left      : sessions
 *   center    : shared conversation controller, rendered directly as a workbench pane
 *   right     : Results / Files / Variables panes (switchable, drag-resizable)
 *   bottom    : Compute (terminal / job log / background jobs / child task tree)
 *
 * Legacy routes are preserved: the top bar offers "专注对话" and every pane keeps
 * working through the same REST APIs as the standalone pages.
 */

import { api, errorMessage } from '../api.js?v=1.3.0';
import { icon } from '../icons.js?v=1.3.0';
import { esc, escAttr, relTime, fmtClock, fmtDuration, truncate, getPref, setPref } from '../util.js?v=1.3.0';
import {
  toastError,
  toastInfo,
  toastSuccess,
  toastWarn,
  openModal,
  openLightbox,
  spinnerHtml,
  emptyStateHtml,
  confirmDialog,
} from '../ui.js?v=1.3.0';
import { getState, setState, navigate, setWorkspace } from '../store.js?v=1.3.0';
import { on, emit } from '../bus.js?v=1.3.0';
import { openRunDetail } from '../runview.js?v=1.3.0';

const RIGHT_MIN = 240;
const RIGHT_MAX = 640;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 460;
const FILES_ROOT = '.';

const CHILD_STATUS = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '等待审批',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '待确认',
};

function fmtWs(ws) {
  if (!ws) return '未选择工作区';
  return ws.name || ws.workspace_id || '工作区';
}

function backendLabel(ws) {
  return ws?.backend === 'ssh' ? 'SSH' : '本机';
}

function hostLabel(ws) {
  const remote = ws?.remote && typeof ws.remote === 'object' ? ws.remote : {};
  return remote.host || remote.hostname || remote.profile_id || ws?.host || '本机';
}

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  if(ctx.shellSidebar)root.querySelector('.workbench-page').classList.add('unified-workspace');
  const el = {
    page: root.querySelector('.workbench-page'),
    wsBtn: root.querySelector('#wb-ws-btn'),
    wsName: root.querySelector('#wb-ws-name'),
    wsPath: root.querySelector('#wb-ws-path'),
    backend: root.querySelector('#wb-backend'),
    host: root.querySelector('#wb-host'),
    dir: root.querySelector('#wb-dir'),
    env: root.querySelector('#wb-env'),
    conn: root.querySelector('#wb-conn'),
    probeBtn: root.querySelector('#wb-probe'),
    newWsBtn: root.querySelector('#wb-new-ws'),
    center: root.querySelector('#wb-center'),
    convs: root.querySelector('#wb-convs'),
    newConvBtn: root.querySelector('#wb-new-conv'),
    right: root.querySelector('#wb-right'),
    rightBody: root.querySelector('#wb-right-body'),
    rightSplitter: root.querySelector('#wb-splitter-right'),
    bottom: root.querySelector('#wb-bottom'),
    bottomBody: root.querySelector('#wb-bottom-body'),
    bottomSplitter: root.querySelector('#wb-splitter-bottom'),
    bottomCollapse: root.querySelector('#wb-bottom-collapse'),
  };

  const local = {
    workspaces: [],
    workspace: null,
    conversations: [],
    activeConversationId: getState().activeConversationId || null,
    pane: getPref('workbenchPane', 'files'),
    compute: getPref('workbenchCompute', 'terminal'),
    filesPath: FILES_ROOT,
    chat: null,
    rightWidth: clampNum(getPref('wbRightWidth', 330), RIGHT_MIN, RIGHT_MAX),
    bottomHeight: clampNum(getPref('wbBottomHeight', 210), BOTTOM_MIN, BOTTOM_MAX),
    terminal: { output: '', busy: false },
    terminalEpoch: 0,
    destroyed: false,
    logs: { jobs: [], active: '', log: '' },
    jobs: { items: [], loading: false },
    tree: { runs: [], loading: false },
    resize: null,
    hideRight: false,
    hideBottom: false,
  };

  async function loadWorkspaceLayout() {
    const id = local.workspace?.workspace_id;
    if (!id) return;
    try {
      const data = await api.request(`/api/platform/layout?scope=${encodeURIComponent(id)}`);
      if (local.workspace?.workspace_id !== id) return;
      local.rightWidth = clampNum(data.rightWidth || 330, RIGHT_MIN, RIGHT_MAX);
      local.bottomHeight = clampNum(data.bottomHeight || 210, BOTTOM_MIN, BOTTOM_MAX);
      local.hideRight = Boolean(data.hideRight); local.hideBottom = Boolean(data.hideBottom);
      applyPanelVisibility(); applySizes();
    } catch { /* Legacy server fallback keeps the existing layout. */ }
  }
  function applyPanelVisibility() {
    el.right.hidden = local.hideRight; el.rightSplitter.hidden = local.hideRight;
    el.bottom.hidden = local.hideBottom; el.bottomSplitter.hidden = local.hideBottom;
    el.page.classList.toggle('is-right-hidden', local.hideRight);
  }
  async function saveWorkspaceLayout() {
    const id = local.workspace?.workspace_id;
    if (!id) return;
    try { await api.request(`/api/platform/layout?scope=${encodeURIComponent(id)}`, {method:'PUT',body:{
      rightWidth:local.rightWidth,bottomHeight:local.bottomHeight,hideRight:local.hideRight,hideBottom:local.hideBottom}}); }
    catch (err) { toastWarn(`布局保存失败：${errorMessage(err)}`); }
  }
  root.querySelector('#wb-layout')?.addEventListener('click', () => {
    openModal({title:'工作区布局',size:'sm',html:'<label class="sw-check"><input type="checkbox" id="layout-right" '+(!local.hideRight?'checked':'')+'/>显示文件、变量与结果面板</label><label class="sw-check"><input type="checkbox" id="layout-bottom" '+(!local.hideBottom?'checked':'')+'/>显示计算面板</label><p class="sw-muted">面板边界可拖动，布局分别保存到当前工作区。</p>',actions:[{label:'取消',kind:'ghost'},
    {label:'保存布局',kind:'primary',onClick:async({body})=>{local.hideRight=!body.querySelector('#layout-right').checked;local.hideBottom=!body.querySelector('#layout-bottom').checked;applyPanelVisibility();await saveWorkspaceLayout();}}]});
  });

  function clampNum(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
  }

  applySizes();

  /* ---------------------------------------------------------------- */
  /* Workspace header + switcher                                       */
  /* ---------------------------------------------------------------- */

  function workspaceChips(probe) {
    const ws = local.workspace;
    el.wsName.textContent = fmtWs(ws);
    el.wsPath.textContent = ws?.resolved_path || ws?.scope || '尚未选择工作区';
    el.wsPath.title = ws?.resolved_path || '';
    el.backend.textContent = backendLabel(ws);
    el.host.textContent = hostLabel(ws);
    el.dir.textContent = ws?.resolved_path || '—';
    el.dir.title = ws?.resolved_path || '';
    const kernel = ws?.kernel || null;
    const python = kernel?.python || '';
    const envName = python ? python.split(/[\\/]/).pop() : ws ? '默认环境' : '—';
    el.env.textContent = envName;
    el.env.title = python || '主内核默认环境';
    const online = ws?.backend === "ssh" ? ws.online === true : Boolean(ws);
    const unknown = ws?.backend === "ssh" && ws.online == null;
    const writable = probe ? Boolean(probe.ok) : null;
    el.conn.className = 'wb-conn ' + (unknown ? '' : online ? (writable === false ? 'is-warn' : 'is-ok') : 'is-fail');
    el.conn.innerHTML =
      `<span class="wb-conn-dot"></span>` +
      `<span>${unknown ? '待检测' : online ? '可访问' : '不可访问'}</span>`;
  }

  async function loadWorkspaces({ silent = false } = {}) {
    try {
      const data = await api.workspaces.list();
      local.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
      const preferred =
        local.workspaces.find((w) => w.workspace_id === getState().workspaceId) ||
        local.workspaces.find((w) => w.workspace_id === data?.default_id) ||
        local.workspaces.find((w) => w.default) ||
        local.workspaces[0] ||
        null;
      local.workspace = preferred;
      if (preferred) setWorkspace(preferred);
      workspaceChips(null);
      if (!silent && !local.workspaces.length) {
        toastInfo('还没有工作区，可点击“新建工作区”创建');
      }
    } catch (err) {
      if (!silent) toastError(`加载工作区失败：${errorMessage(err)}`);
      workspaceChips(null);
    }
  }

  async function probeWorkspace() {
    const ws = local.workspace;
    if (!ws) {
      toastWarn('请先选择工作区');
      return;
    }
    el.probeBtn.disabled = true;
    try {
      const data = await api.workspaces.probe(ws.workspace_id);
      ws.online = Boolean(data?.ok ?? data?.exists);
      ws.kernel = data?.kernel || ws.kernel;
      workspaceChips(data);
      (data?.ok ? toastSuccess : toastWarn)(
        data?.ok
          ? `工作区可访问 · ${data?.entries ?? 0} 个条目`
          : `工作区探测失败：${typeof data?.detail === 'string' ? data.detail : '路径不可写'}`,
      );
      if (local.pane === 'files') await loadFiles(local.filesPath);
    } catch (err) {
      el.conn.className = 'wb-conn is-fail';
      el.conn.innerHTML = '<span class="wb-conn-dot"></span><span>探测失败</span>';
      toastError(`探测失败：${errorMessage(err)}`);
    } finally {
      el.probeBtn.disabled = false;
    }
  }

  function openWorkspaceSwitcher() {
    const state = { selected: local.workspace?.workspace_id || '' };
    const modal = openModal({
      title: '切换工作区',
      size: 'lg',
      html: '<div class="wb-ws-list"></div>',
      actions: [
        { label: '新建工作区', kind: 'ghost', onClick: () => { void openNewWorkspaceModal(); return false; } },
        { label: '刷新', kind: 'ghost', onClick: () => { void renderList(); return false; } },
        {
          label: '应用',
          kind: 'primary',
          onClick: () => {
            const ws = local.workspaces.find((w) => w.workspace_id === state.selected);
            if (!ws) {
              toastWarn('请先选择一个工作区');
              return false;
            }
            local.workspace = ws;
            setWorkspace(ws);
            workspaceChips(null);
            toastSuccess(`已切换到工作区「${fmtWs(ws)}」`);
            void loadFiles(local.filesPath);
            void loadTree();
            return true;
          },
        },
        { label: '取消', kind: 'ghost' },
      ],
    });
    const listEl = () => modal.body.querySelector('.wb-ws-list');

    async function renderList() {
      const box = listEl();
      if (!box) return;
      box.innerHTML = spinnerHtml('正在加载工作区…');
      try {
        const data = await api.workspaces.list();
        local.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
        if (!local.workspaces.length) {
          box.innerHTML = emptyStateHtml({
            iconName: 'folder',
            title: '还没有工作区',
            hint: '创建第一个工作区后，运行与会话会绑定到它的目录和内核。',
          });
          return;
        }
        box.innerHTML = local.workspaces
          .map((ws) => {
            const active = ws.workspace_id === state.selected;
            return (
              `<button type="button" class="wb-ws-option${active ? ' is-active' : ''}" data-ws-id="${escAttr(ws.workspace_id)}">` +
              `<span class="wb-ws-option-icon">${icon(ws.backend === 'ssh' ? 'ssh' : 'folder', { size: 16 })}</span>` +
              '<span class="wb-ws-option-main">' +
              `<span class="wb-ws-option-name">${esc(fmtWs(ws))}${ws.default ? '<span class="tag tag-purple">默认</span>' : ''}</span>` +
              `<span class="wb-ws-option-path">${esc(ws.resolved_path || ws.scope || '')}</span>` +
              '</span>' +
              `<span class="wb-ws-option-meta">${esc(backendLabel(ws))} · ${ws.online === false ? '离线' : '在线'}</span>` +
              (active ? `<span class="wb-ws-check">${icon('check', { size: 15 })}</span>` : '') +
              '</button>'
            );
          })
          .join('');
      } catch (err) {
        box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
      }
    }

    modal.body.addEventListener('click', (event) => {
      const option = event.target.closest('[data-ws-id]');
      if (!option) return;
      state.selected = option.dataset.wsId;
      void renderList();
    });
    void renderList();
  }

  async function openNewWorkspaceModal() {
    let profiles = [];
    try { profiles = (await api.request("/api/ssh/profiles")).profiles || []; }
    catch (err) { toastWarn(`SSH 档案加载失败：${errorMessage(err)}`); }
    const modal = openModal({
      title: '新建工作区',
      size: 'md',
      html:
        '<div class="form-stack">' +
        '<label class="field"><span class="field-label">名称</span>' +
        '<input class="input" id="wb-new-name" placeholder="例如：单细胞分析 / 远程 GPU" /></label>' +
        '<label class="field"><span class="field-label">运行位置</span>' +
        '<select class="input" id="wb-new-backend"><option value="local">本机目录</option><option value="ssh">SSH 远程工作区</option></select></label>' +
        '<label class="field" id="wb-new-profile-field" hidden><span class="field-label">已有 SSH 连接</span>' +
        '<select class="input" id="wb-new-profile">' + profiles.map(p => `<option value="${escAttr(p.id)}">${esc(p.name || p.host)} · ${esc(p.username)}@${esc(p.host)}</option>`).join('') + '</select>' +
        '<span class="field-hint">复用 SSH 页保存的连接和凭据。创建时将验证远端目录。</span></label>' +
        '<label class="field"><span class="field-label" id="wb-new-path-label">本机目录（留空自动创建）</span>' +
        '<input class="input" id="wb-new-path" placeholder="C:\\\\data\\\\project" /></label>' +
        '</div>',
      actions: [
        {
          label: '创建',
          kind: 'primary',
          onClick: async ({ body }) => {
            const name = body.querySelector('#wb-new-name').value.trim();
            const path = body.querySelector('#wb-new-path').value.trim();
            if (!name) {
              toastWarn('请填写工作区名称');
              return false;
            }
            try {
              const backend = body.querySelector('#wb-new-backend').value;
              const profileId = body.querySelector('#wb-new-profile').value;
              if (backend === 'ssh' && !profileId) { toastWarn('请先在 SSH 页添加连接'); return false; }
              const data = await api.workspaces.create(backend === 'ssh'
                ? { name, backend, remote: { profile_id: profileId, root: path || '~' } }
                : { name, local_path: path, backend });
              const ws = data?.workspace;
              if (ws) {
                local.workspaces.push(ws);
                local.workspace = ws;
                setWorkspace(ws);
                workspaceChips(null);
                toastSuccess(`已创建工作区「${name}」`);
                void loadFiles(FILES_ROOT);
                void loadTree();
              }
            } catch (err) {
              toastError(`创建失败：${errorMessage(err)}`);
              return false;
            }
            return true;
          },
        },
        { label: '取消', kind: 'ghost' },
      ],
    });
    modal.body.querySelector('#wb-new-backend').addEventListener('change', (event) => {
      const remote = event.target.value === 'ssh';
      modal.body.querySelector('#wb-new-profile-field').hidden = !remote;
      modal.body.querySelector('#wb-new-path-label').textContent = remote ? '远程工作目录（留空使用主目录）' : '本机目录（留空自动创建）';
      modal.body.querySelector('#wb-new-path').placeholder = remote ? '/home/user/project' : '本机目录路径';
    });
    return modal;
  }

  /* ---------------------------------------------------------------- */
  /* Left: sessions                                                    */
  /* ---------------------------------------------------------------- */

  async function loadConversations({ silent = false } = {}) {
    try {
      const data = await api.conversations.list();
      local.conversations = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data) ? data : [];
      renderConversations();
    } catch (err) {
      if (!silent) toastError(`加载会话失败：${errorMessage(err)}`);
    }
  }

  function renderConversations() {
    if (!local.conversations.length) {
      el.convs.innerHTML = '<div class="wb-left-empty">还没有会话</div>';
      return;
    }
    el.convs.innerHTML = local.conversations
      .map((conv) => {
        const active = conv.id === local.activeConversationId;
        return (
          `<button type="button" class="wb-conv${active ? ' is-active' : ''}" data-conv-id="${escAttr(conv.id)}">` +
          `<span class="wb-conv-title">${esc(conv.title || '新会话')}</span>` +
          `<span class="wb-conv-meta">${esc(conv.agent || '')}${conv.updated_at ? ` · ${esc(relTime(conv.updated_at))}` : ''}</span>` +
          '</button>'
        );
      })
      .join('');
  }

  async function selectConversation(conversationId) {
    if (!conversationId) return;
    local.activeConversationId = conversationId;
    setState({ activeConversationId: conversationId });
    renderConversations();
    emit('chat:select', conversationId);
    void loadTree();
  }

  /* ---------------------------------------------------------------- */
  /* Right panes: Results / Files / Variables                          */
  /* ---------------------------------------------------------------- */

  function rightTabs() {
    const panes = [
      ['results', '结果', 'figures'],
      ['files', '文件', 'files'],
      ['vars', '变量', 'vars'],
    ];
    return (
      '<div class="wb-right-head">' +
      '<div class="wb-right-tabs">' +
      panes
        .map(
          ([id, label, iconName]) =>
            `<button type="button" class="wb-right-tab${local.pane === id ? ' is-active' : ''}" data-pane="${id}">` +
            `${icon(iconName, { size: 14 })}<span>${label}</span></button>`,
        )
        .join('') +
      '</div>' +
      `<button type="button" class="icon-btn" id="wb-right-refresh" title="刷新">${icon('refresh', { size: 15 })}</button>` +
      '</div>' +
      '<div class="wb-right-body" id="wb-right-body"></div>'
    );
  }

  function renderRightShell() {
    el.right.innerHTML = rightTabs();
    el.rightBody = el.right.querySelector('#wb-right-body');
    el.right.querySelector('#wb-right-refresh')?.addEventListener('click', () => {
      void loadPane(local.pane, { force: true });
    });
  }

  async function loadPane(pane, { force = false } = {}) {
    local.pane = pane;
    setPref('workbenchPane', pane);
    el.right.querySelectorAll('[data-pane]').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.pane === pane);
    });
    if (!el.rightBody) return;
    if (pane === 'results') await loadResults();
    else if (pane === 'files') await loadFiles(local.filesPath, { force });
    else await loadVars();
  }

  async function loadResults() {
    const box = el.rightBody;
    if (!box) return;
    box.innerHTML = spinnerHtml('正在加载结果…');
    try {
      const ws = local.workspace;
      let data;
      if (ws?.backend === 'ssh') {
        try {
          const listing = await api.workspaces.files.tree(ws.workspace_id, 'figures');
          data = {figures: (listing.entries || []).filter(e => !e.is_dir && /\.(png|jpg|jpeg|webp|svg)$/i.test(e.name)).map(e => ({...e, url: api.workspaces.files.rawUrl(ws.workspace_id, e.path)}))};
        } catch (err) {
          box.innerHTML = emptyStateHtml({iconName: 'figures', title: '远程图表目录暂不可用', hint: errorMessage(err)});
          return;
        }
      } else { data = await api.figures.list(); }
      const figures = Array.isArray(data?.figures) ? data.figures : Array.isArray(data) ? data : [];
      if (!figures.length) {
        box.innerHTML = emptyStateHtml({
          iconName: 'figures',
          title: '还没有结果图',
          hint: '智能体生成图表后会出现在这里，也可以直接打开图库页。',
          actionLabel: '打开图库',
          actionId: 'wb-open-figures',
        });
        box.querySelector('#wb-open-figures')?.addEventListener('click', () => navigate('figures'));
        return;
      }
      box.innerHTML =
        '<div class="wb-results">' +
        figures
          .map((fig) => {
            const src = api.figures.url(fig);
            return (
              `<button type="button" class="wb-result" data-src="${escAttr(src)}" data-name="${escAttr(fig.name || '')}" title="${escAttr(fig.name || '')}">` +
              `<img src="${escAttr(src)}" alt="${escAttr(fig.name || 'figure')}" loading="lazy" />` +
              `<span class="wb-result-name">${esc(fig.name || '')}</span>` +
              '</button>'
            );
          })
          .join('') +
        '</div>';
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  function breadcrumbHtml(path) {
    const parts = String(path || '.').split('/').filter(Boolean);
    const crumbs = ['<button type="button" class="wb-crumb" data-file-nav=".">根目录</button>'];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      crumbs.push(`<span class="wb-crumb-sep">/</span>`);
      crumbs.push(`<button type="button" class="wb-crumb" data-file-nav="${escAttr(acc)}">${esc(part)}</button>`);
    }
    return `<div class="wb-breadcrumb">${crumbs.join('')}</div>`;
  }

  async function loadFiles(path = '.', { force = false } = {}) {
    const box = el.rightBody;
    if (!box) return;
    local.filesPath = path || '.';
    const wsId = local.workspace?.workspace_id || getState().workspaceId || '';
    box.innerHTML = spinnerHtml('正在读取目录…');
    try {
      const data = wsId
        ? await api.workspaces.files.tree(wsId, local.filesPath)
        : await api.files.tree(local.filesPath);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      const rows = entries
        .map((entry) => {
          const isDir = Boolean(entry.is_dir);
          const entryPath = entry.path || entry.name;
          return (
            `<button type="button" class="wb-file-row${isDir ? ' is-dir' : ''}" data-file-path="${escAttr(entryPath)}" data-file-dir="${isDir ? '1' : '0'}" data-file-ext="${escAttr(entry.ext || '')}">` +
            `<span class="wb-file-icon">${icon(isDir ? 'folder' : fileIcon(entry.ext), { size: 15 })}</span>` +
            `<span class="wb-file-name">${esc(entry.name || '')}</span>` +
            `<span class="wb-file-meta">${isDir ? '目录' : esc(fmtSize(entry.size))}</span>` +
            '</button>'
          );
        })
        .join('');
      box.innerHTML =
        breadcrumbHtml(local.filesPath) +
        (local.filesPath !== '.'
          ? '<button type="button" class="wb-file-up" data-file-nav="..">' + icon('arrowUp', { size: 14 }) + '<span>上一级</span></button>'
          : '') +
        (rows ? `<div class="wb-files">${rows}</div>` : '<div class="wb-left-empty">目录为空</div>');
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}${wsId ? '（工作区文件接口不可用）' : ''}</div>`;
    }
  }

  function fmtSize(size) {
    const num = Number(size);
    if (!Number.isFinite(num) || num <= 0) return '';
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileIcon(ext) {
    const suffix = String(ext || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'].includes(suffix)) return 'image';
    if (['py', 'js', 'r', 'sh', 'ipynb'].includes(suffix)) return 'code';
    if (['csv', 'tsv', 'xlsx', 'json'].includes(suffix)) return 'table';
    return 'file';
  }

  async function openFile(entryPath, ext) {
    const wsId = local.workspace?.workspace_id || getState().workspaceId || '';
    const suffix = String(ext || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(suffix)) {
      const src = wsId ? api.workspaces.files.rawUrl(wsId, entryPath) : api.files.rawUrl(entryPath);
      openLightbox({ src, title: entryPath, downloadUrl: src });
      return;
    }
    const modal = openModal({
      title: entryPath,
      size: 'lg',
      html: `<div class="wb-file-preview">${spinnerHtml('正在读取文件…')}</div>`,
      actions: [{ label: '关闭', kind: 'ghost' }],
    });
    const box = modal.body.querySelector('.wb-file-preview');
    try {
      const data = wsId
        ? await api.workspaces.files.read(wsId, entryPath)
        : await api.files.read(entryPath);
      const text = data?.content ?? data?.text ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      box.innerHTML = `<pre class="wb-file-text">${esc(truncate(String(text || ''), 60000))}</pre>`;
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  async function loadVars() {
    const box = el.rightBody;
    if (!box) return;
    box.innerHTML = spinnerHtml('正在读取变量…');
    try {
      const data = await api.request(`/api/kernels/${encodeURIComponent(local.workspace?.scope || "main")}/vars`);
      const items = Array.isArray(data?.vars) ? data.vars : [];
      if (!items.length) {
        box.innerHTML = emptyStateHtml({
          iconName: 'vars',
          title: '工作区没有变量',
          hint: data?.running === false ? '内核尚未启动。' : '运行代码后，变量会显示在这里。',
        });
        return;
      }
      box.innerHTML =
        '<div class="wb-vars">' +
        items
          .map(
            (item) =>
              `<button type="button" class="wb-var" data-var-name="${escAttr(item.name || '')}">` +
              `<span class="wb-var-name">${esc(item.name || '')}</span>` +
              `<span class="wb-var-type">${esc(item.type || '')}</span>` +
              `<span class="wb-var-shape">${esc(item.shape || item.preview || '')}</span>` +
              '</button>',
          )
          .join('') +
        '</div>';
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Bottom: Compute (terminal / logs / jobs / child task tree)        */
  /* ---------------------------------------------------------------- */

  function computeTabs() {
    const tabs = [
      ['terminal', '终端', 'terminal'],
      ['python', 'Python', 'code'],
      ['logs', '日志', 'fileText'],
      ['jobs', '后台任务', 'jobs'],
      ['children', '子任务树', 'layers'],
    ];
    return (
      '<div class="wb-bottom-head">' +
      '<div class="wb-compute-tabs">' +
      tabs
        .map(
          ([id, label, iconName]) =>
            `<button type="button" class="wb-compute-tab${local.compute === id ? ' is-active' : ''}" data-compute="${id}">` +
            `${icon(iconName, { size: 14 })}<span>${label}</span></button>`,
        )
        .join('') +
      '</div>' +
      '<div class="wb-bottom-actions">' +
      `<span class="wb-compute-hint" id="wb-compute-hint"></span>` +
      `<button type="button" class="icon-btn" id="wb-compute-refresh" title="刷新">${icon('refresh', { size: 15 })}</button>` +
      `<button type="button" class="icon-btn" id="wb-bottom-collapse" title="收起 Compute">${icon('chevronDown', { size: 16 })}</button>` +
      '</div></div>' +
      '<div class="wb-bottom-body" id="wb-bottom-body"></div>'
    );
  }

  function renderBottomShell() {
    el.bottom.innerHTML = computeTabs();
    el.bottomBody = el.bottom.querySelector('#wb-bottom-body');
    el.bottomCollapse = el.bottom.querySelector('#wb-bottom-collapse');
    el.bottomCollapse?.addEventListener('click', () => toggleBottom());
    el.bottom.querySelector('#wb-compute-refresh')?.addEventListener('click', () => {
      void loadCompute(local.compute, { force: true });
    });
    toggleBottom(getPref('wbBottomCollapsed', false) === true);
  }

  function toggleBottom(collapsed) {
    const next = collapsed ?? !el.bottom.classList.contains('is-collapsed');
    el.bottom.classList.toggle('is-collapsed', next);
    setPref('wbBottomCollapsed', next);
    if (el.bottomCollapse) {
      el.bottomCollapse.innerHTML = icon(next ? 'chevronUp' : 'chevronDown', { size: 16 });
      el.bottomCollapse.title = next ? '展开 Compute' : '收起 Compute';
    }
    if (next) {
      el.bottom.style.height = '42px';
    } else {
      el.bottom.style.height = `${local.bottomHeight}px`;
    }
  }

  async function loadCompute(tab, { force = false } = {}) {
    local.compute = tab;
    setPref('workbenchCompute', tab);
    el.bottom.querySelectorAll('[data-compute]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.compute === tab);
    });
    const box = el.bottomBody;
    if (!box) return;
    local.terminalEpoch++;
    if (tab === 'terminal') await renderShell();
    else if (tab === 'python') renderTerminal();
    else if (tab === 'logs') await loadLogs();
    else if (tab === 'jobs') await loadJobs();
    else await loadTree();
  }

  async function renderShell() {
    const workspace = local.workspace;
    if (!workspace) { el.bottomBody.textContent = '请先选择工作区'; return; }
    const epoch = local.terminalEpoch;
    try {
      const service=await import('../terminal-panel.js?v=1.3.0');
      if(epoch!==local.terminalEpoch||local.destroyed)return;
      const session=await service.acquireTerminalSession(workspace);
      if(epoch!==local.terminalEpoch||local.destroyed)return;
      const tabs=document.createElement('nav');tabs.className='eve-terminal-tabs';tabs.setAttribute('aria-label','终端会话');
      tabs.innerHTML=service.terminalSessions(workspace).map(s=>`<button class="${s.id===session.id?'is-active':''}" data-terminal-id="${escAttr(s.id)}">${esc(s.title)}</button>`).join('')+'<button data-terminal-new aria-label="新建终端">+</button>';
      tabs.onclick=async event=>{
        const selected=event.target.closest('[data-terminal-id]'),add=event.target.closest('[data-terminal-new]');
        if(!selected&&!add)return;
        try{
          if(add){add.disabled=true;await service.acquireTerminalSession(workspace,{fresh:true});}
          else service.selectTerminalSession(workspace,selected.dataset.terminalId);
          if(!local.destroyed&&local.workspace?.workspace_id===workspace.workspace_id&&local.compute==='terminal')await renderShell();
        }catch(error){toastError(errorMessage(error));}finally{if(add)add.disabled=false;}
      };
      el.bottomBody.replaceChildren(tabs,session.panel.node);session.panel.focus();
    }catch(error){if(epoch===local.terminalEpoch&&!local.destroyed)el.bottomBody.textContent=errorMessage(error);}
  }

  function renderTerminal() {
    const box = el.bottomBody;
    if (!box) return;
    box.innerHTML =
      '<div class="wb-terminal">' +
      `<pre class="wb-term-output">${esc(local.terminal.output || 'Eve 工作区 Python 控制台。输入代码后按 Enter 运行。\n')}</pre>` +
      '<div class="wb-term-input-row">' +
      '<span class="wb-term-prompt">In [ ]:</span>' +
      '<input class="wb-term-input" id="wb-term-input" placeholder="print(1 + 1)" autocomplete="off" />' +
      '<button type="button" class="btn btn-primary btn-sm" id="wb-term-run">运行</button>' +
      '</div></div>';
    const input = box.querySelector('#wb-term-input');
    const run = box.querySelector('#wb-term-run');
    const output = box.querySelector('.wb-term-output');
    const scroll = () => {
      output.scrollTop = output.scrollHeight;
    };
    scroll();
    async function execute(code) {
      if (local.terminal.busy) {
        toastInfo('上一条命令仍在执行');
        return;
      }
      local.terminal.busy = true;
      local.terminal.output += `\nIn [ ]: ${code}\n`;
      output.textContent = local.terminal.output;
      scroll();
      try {
        const scope = local.workspace?.scope || "main";
        const data = (await api.request(`/api/kernels/${encodeURIComponent(scope)}/execute`, {method: "POST", body: {code}, timeout: 300000})) || {};
        // The kernel route returns {ok, outputs:[{type,name,text}], duration_ms, error}.
        const outputs = Array.isArray(data.outputs) ? data.outputs : [];
        let stdout = typeof data.stdout === 'string' ? data.stdout : '';
        let stderr = typeof data.stderr === 'string' ? data.stderr : '';
        for (const item of outputs) {
          if (!item) continue;
          const text = typeof item.text === 'string'
            ? item.text
            : Array.isArray(item.traceback)
              ? item.traceback.join('\n')
              : Array.isArray(item.data?.['text/plain'])
                ? item.data['text/plain'].join('\n')
                : String(item.data?.['text/plain'] ?? '');
          if (!text) continue;
          if (item.type === 'error' || item.name === 'stderr') stderr += text.endsWith('\n') ? text : `${text}\n`;
          else stdout += text.endsWith('\n') ? text : `${text}\n`;
        }
        const errorText = data.error && typeof data.error === 'string'
          ? data.error
          : data.ok === false
            ? data.message || '执行失败'
            : '';
        const elapsed = typeof data.duration_ms === 'number' ? `${data.duration_ms} ms` : '';
        const empty = !stdout && !stderr && !errorText;
        local.terminal.output += `${stdout}${stderr ? `[stderr] ${stderr}` : ''}${
          errorText ? `[error] ${errorText}\n` : ''
        }${empty ? `（无输出${elapsed ? `，${elapsed}` : ''}）\n` : ''}`;
      } catch (err) {
        local.terminal.output += `[error] ${errorMessage(err)}\n`;
      } finally {
        local.terminal.busy = false;
        output.textContent = local.terminal.output;
        scroll();
        input.value = '';
        input.focus();
      }
    }
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        const code = input.value.trim();
        if (code) void execute(code);
      }
    });
    run.addEventListener('click', () => {
      const code = input.value.trim();
      if (code) void execute(code);
    });
    setTimeout(() => input.focus(), 20);
  }

  async function loadLogs() {
    const box = el.bottomBody;
    if (!box) return;
    box.innerHTML = spinnerHtml('正在加载任务日志…');
    try {
      const data = local.workspace?.backend === 'ssh'
        ? await api.request(`/api/workspaces/${encodeURIComponent(local.workspace.workspace_id)}/jobs`)
        : await api.jobs.list();
      if (Array.isArray(data?.jobs)) data.jobs = data.jobs.map(job => ({...job, id: job.id || job.job_id}));
      local.logs.jobs = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      if (!local.logs.jobs.length) {
        box.innerHTML = '<div class="wb-left-empty">还没有后台任务记录</div>';
        return;
      }
      if (!local.logs.jobs.some((job) => job.id === local.logs.active)) {
        local.logs.active = local.logs.jobs[0].id;
      }
      box.innerHTML =
        '<div class="wb-log-layout">' +
        '<div class="wb-log-list">' +
        local.logs.jobs
          .map(
            (job) =>
              `<button type="button" class="wb-log-item${job.id === local.logs.active ? ' is-active' : ''}" data-log-id="${escAttr(job.id)}">` +
              `<span class="wb-log-name">${esc(job.name || job.id)}</span>` +
              `<span class="wb-log-status is-${escAttr(job.status || 'unknown')}">${esc(job.status || '')}</span></button>`,
          )
          .join('') +
        '</div>' +
        '<pre class="wb-log-output" id="wb-log-output">加载中…</pre>' +
        '</div>';
      await loadJobLog(local.logs.active);
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  async function loadJobLog(jobId) {
    if (!jobId) return;
    local.logs.active = jobId;
    const out = el.bottomBody?.querySelector('#wb-log-output');
    if (out) out.textContent = '加载中…';
    try {
      const data = local.workspace?.backend === 'ssh'
        ? await api.request(`/api/workspaces/${encodeURIComponent(local.workspace.workspace_id)}/jobs/${encodeURIComponent(jobId)}/log`)
        : await api.jobs.log(jobId);
      local.logs.log = data?.log || data?.content || data?.output || (typeof data === 'string' ? data : '');
      if (out) {
        out.textContent = local.logs.log || '（无日志输出）';
        out.scrollTop = out.scrollHeight;
      }
    } catch (err) {
      if (out) out.textContent = `读取日志失败：${errorMessage(err)}`;
    }
    el.bottomBody?.querySelectorAll('[data-log-id]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.logId === jobId);
    });
  }

  async function loadJobs() {
    const box = el.bottomBody;
    if (!box) return;
    box.innerHTML = spinnerHtml('正在加载后台任务…');
    try {
      const data = local.workspace?.backend === 'ssh'
        ? await api.request(`/api/workspaces/${encodeURIComponent(local.workspace.workspace_id)}/jobs`)
        : await api.jobs.list();
      if (Array.isArray(data?.jobs)) data.jobs = data.jobs.map(job => ({...job, id: job.id || job.job_id}));
      const items = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      local.jobs.items = items;
      if (!items.length) {
        box.innerHTML = '<div class="wb-left-empty">还没有后台任务</div>';
        return;
      }
      box.innerHTML =
        '<div class="wb-jobs">' +
        items
          .map(
            (job) =>
              `<div class="wb-job">` +
              `<span class="wb-job-status is-${escAttr(job.status || 'unknown')}">${esc(job.status || '')}</span>` +
              `<span class="wb-job-name">${esc(job.name || job.id)}</span>` +
              `<span class="wb-job-meta">${esc(job.pid ? `PID ${job.pid}` : '')}${job.started_at ? ` · ${esc(fmtClock(job.started_at))}` : ''}</span>` +
              (job.status === 'running' || job.status === 'queued'
                ? `<button type="button" class="btn btn-ghost btn-sm" data-job-cancel="${escAttr(job.id)}">取消</button>`
                : '') +
              '</div>',
          )
          .join('') +
        '</div>';
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  async function loadTree() {
    const box = el.bottomBody;
    if (!box) return;
    const conversationId = local.activeConversationId || getState().activeConversationId;
    if (!conversationId) {
      box.innerHTML = emptyStateHtml({
        iconName: 'layers',
        title: '选择会话后查看子任务树',
        hint: '子任务树展示当前会话每个运行的子智能体任务。',
      });
      return;
    }
    box.innerHTML = spinnerHtml('正在加载子任务树…');
    try {
      const data = await api.runtime.sessionRuns(conversationId, 20);
      const allRuns = Array.isArray(data?.runs) ? data.runs : [];
      // Child runs belong under their parent; do not list them as top-level runs.
      const runs = allRuns.filter((run) => !run.parent_run_id);
      local.tree.runs = runs;
      if (!runs.length) {
        box.innerHTML = '<div class="wb-left-empty">该会话还没有运行记录</div>';
        return;
      }
      const blocks = [];
      for (const run of runs) {
        let children = [];
        try {
          const childData = await api.runtime.children(run.run_id);
          children = Array.isArray(childData?.children) ? childData.children : [];
        } catch {
          children = [];
        }
        blocks.push(
          '<div class="wb-tree-run">' +
            `<button type="button" class="wb-tree-run-head" data-run-id="${escAttr(run.run_id || '')}" data-trace-id="${escAttr(run.trace_id || '')}">` +
            `<span class="wb-tree-status is-${escAttr(run.status || 'unknown')}">${esc(run.status || '')}</span>` +
            `<span class="wb-tree-run-id">${esc(run.run_id || '')}</span>` +
            `<span class="wb-tree-run-meta">${esc(run.started_at ? fmtClock(run.started_at) : '')}</span>` +
            '</button>' +
            (children.length
              ? '<div class="wb-tree-children">' +
                children
                  .map((child) => {
                    const status = child.status || 'unknown';
                    return (
                      `<button type="button" class="wb-tree-child" data-run-id="${escAttr(child.run_id || '')}" data-trace-id="${escAttr(child.trace_id || '')}">` +
                      `<span class="wb-tree-branch">${icon('layers', { size: 12 })}</span>` +
                      `<span class="wb-tree-status is-${escAttr(status)}">${esc(CHILD_STATUS[status] || status)}</span>` +
                      `<span class="wb-tree-child-goal">${esc(truncate(child.goal || child.profile || child.task_id || '', 90))}</span>` +
                      '</button>'
                    );
                  })
                  .join('') +
                '</div>'
              : '<div class="wb-tree-empty">无子任务</div>') +
            '</div>',
        );
      }
      box.innerHTML = `<div class="wb-tree">${blocks.join('')}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sizing                                                            */
  /* ---------------------------------------------------------------- */

  function applySizes() {
    el.page?.style.setProperty('--wb-right-w', `${local.rightWidth}px`);
    el.page?.style.setProperty('--wb-bottom-h', `${local.bottomHeight}px`);
    if (el.bottom && !el.bottom.classList.contains('is-collapsed')) {
      el.bottom.style.height = `${local.bottomHeight}px`;
    }
  }

  function startResize(kind, evt) {
    evt.preventDefault();
    local.resize = { kind, startX: evt.clientX, startY: evt.clientY, right: local.rightWidth, bottom: local.bottomHeight };
    document.body.classList.add('is-resizing-col');
    document.body.classList.add(kind === 'right' ? 'is-resizing-x' : 'is-resizing-y');
  }

  function onResizeMove(evt) {
    if (!local.resize) return;
    if (local.resize.kind === 'right') {
      local.rightWidth = clampNum(local.resize.right - (evt.clientX - local.resize.startX), RIGHT_MIN, RIGHT_MAX);
    } else {
      local.bottomHeight = clampNum(local.resize.bottom - (evt.clientY - local.resize.startY), BOTTOM_MIN, BOTTOM_MAX);
    }
    applySizes();
  }

  function onResizeEnd() {
    if (!local.resize) return;
    local.resize = null;
    document.body.classList.remove('is-resizing-col', 'is-resizing-x', 'is-resizing-y');
    setPref('wbRightWidth', local.rightWidth);
    setPref('wbBottomHeight', local.bottomHeight);
    void saveWorkspaceLayout();
  }

  /* ---------------------------------------------------------------- */
  /* Event wiring                                                      */
  /* ---------------------------------------------------------------- */

  el.wsBtn.addEventListener('click', () => openWorkspaceSwitcher());
  el.probeBtn.addEventListener('click', () => void probeWorkspace());
  el.newWsBtn.addEventListener('click', () => openNewWorkspaceModal());
  el.newConvBtn.addEventListener('click', () => {
    emit('chat:new-conversation');
    setTimeout(() => void loadConversations({ silent: true }), 800);
  });
  el.convs.addEventListener('click', (event) => {
    const item = event.target.closest('[data-conv-id]');
    if (item) void selectConversation(item.dataset.convId);
  });

  el.rightSplitter.addEventListener('mousedown', (evt) => startResize('right', evt));
  el.bottomSplitter.addEventListener('mousedown', (evt) => startResize('bottom', evt));
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);

  el.right.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-pane]');
    if (tab) {
      void loadPane(tab.dataset.pane);
      return;
    }
    const result = event.target.closest('.wb-result');
    if (result) {
      openLightbox({ src: result.dataset.src, title: result.dataset.name, downloadUrl: result.dataset.src });
      return;
    }
    const nav = event.target.closest('[data-file-nav]');
    if (nav) {
      const target = nav.dataset.fileNav;
      void loadFiles(target === '..' ? parentPath(local.filesPath) : target);
      return;
    }
    const fileRow = event.target.closest('[data-file-path]');
    if (fileRow) {
      if (fileRow.dataset.fileDir === '1') void loadFiles(fileRow.dataset.filePath);
      else void openFile(fileRow.dataset.filePath, fileRow.dataset.fileExt);
      return;
    }
    const varRow = event.target.closest('[data-var-name]');
    if (varRow) {
      void showVar(varRow.dataset.varName);
    }
  });

  el.bottom.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-compute]');
    if (tab) {
      void loadCompute(tab.dataset.compute);
      return;
    }
    const logItem = event.target.closest('[data-log-id]');
    if (logItem) {
      void loadJobLog(logItem.dataset.logId);
      return;
    }
    const cancelBtn = event.target.closest('[data-job-cancel]');
    if (cancelBtn) {
      void cancelJob(cancelBtn.dataset.jobCancel);
      return;
    }
    const runNode = event.target.closest('[data-run-id]');
    if (runNode) {
      openRunDetail({ runId: runNode.dataset.runId, traceId: runNode.dataset.traceId || '' });
    }
  });

  function parentPath(path) {
    const parts = String(path || '.').split('/').filter(Boolean);
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  }

  async function showVar(name) {
    if (!name) return;
    const modal = openModal({
      title: `变量 · ${name}`,
      size: 'lg',
      html: `<div class="wb-var-detail">${spinnerHtml('正在读取变量…')}</div>`,
      actions: [{ label: '关闭', kind: 'ghost' }],
    });
    const box = modal.body.querySelector('.wb-var-detail');
    try {
      const data = await api.request(`/api/kernels/${encodeURIComponent(local.workspace?.scope || "main")}/vars/${encodeURIComponent(name)}`);
      const preview =
        data?.preview ?? data?.value ?? data?.repr ?? data?.content ?? JSON.stringify(data, null, 2);
      box.innerHTML = `<pre class="wb-file-text">${esc(truncate(String(preview ?? ''), 40000))}</pre>`;
    } catch (err) {
      box.innerHTML = `<div class="panel-error">${esc(errorMessage(err))}</div>`;
    }
  }

  async function cancelJob(jobId) {
    const ok = await confirmDialog({
      title: '取消后台任务',
      message: `确定取消任务 ${jobId} 吗？`,
      confirmText: '取消任务',
      cancelText: '保留',
      danger: true,
    });
    if (!ok) return;
    try {
      if (local.workspace?.backend === 'ssh') {
        await api.request(`/api/workspaces/${encodeURIComponent(local.workspace.workspace_id)}/jobs/${encodeURIComponent(jobId)}/cancel`, {method: 'POST'});
      } else { await api.jobs.cancel(jobId); }
      toastSuccess('已请求取消任务');
      await loadJobs();
    } catch (err) {
      toastError(`取消失败：${errorMessage(err)}`);
    }
  }

  const offState = on('state:change', (patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'activeConversationId')) {
      local.activeConversationId = patch.activeConversationId;
      renderConversations();
      if (local.compute === 'children') void loadTree();
    }
    if (patch && Array.isArray(patch.conversations)) {
      local.conversations = patch.conversations;
      renderConversations();
    }
  });
  const offWorkspace = on('workspace:change', () => {
    if (getState().workspace) local.workspace = getState().workspace;
    local.filesPath = FILES_ROOT;
    void loadWorkspaceLayout();
    local.terminal.output = '';
    if (local.compute === 'terminal') void loadCompute('terminal');
    if (local.pane === 'vars') void loadVars();
    if (local.pane === 'results') void loadResults();
    if (local.compute !== 'terminal') void loadCompute(local.compute);
    workspaceChips(null);
    if (local.pane === 'files') void loadFiles(local.filesPath);
    if (local.compute === 'children') void loadTree();
  });
  const offTerminals=on('terminal:sessions',event=>{
    if(!local.destroyed&&local.compute==='terminal'&&event.workspaceId===local.workspace?.workspace_id)void renderShell();
  });

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  renderRightShell();
  renderBottomShell();
  await loadWorkspaces({ silent: true });
  await loadWorkspaceLayout();
  await loadConversations({ silent: true });
  await loadPane(local.pane);

  // Mount the standard chat view in the centre so every chat feature keeps working.
  try {
    const chatModule = await import('./chat.js?v=1.3.0');
    local.chat = await chatModule.mount(el.center, ctx);
    el.center.classList.add('is-chat-mounted');
  } catch (err) {
    el.center.innerHTML = `<div class="panel-error">聊天视图加载失败：${esc(errorMessage(err))}</div>`;
  }

  await loadCompute(local.compute);

  return {
    destroy() {
      local.destroyed = true; local.terminalEpoch++;
      // Retained terminal sessions keep their PTYs; closing a tab closes one.
      offTerminals();
      offState();
      offWorkspace();
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
      document.body.classList.remove('is-resizing-col', 'is-resizing-x', 'is-resizing-y');
      local.chat?.destroy?.();
      local.chat = null;
      root.innerHTML = '';
    },
  };
}

/* ------------------------------------------------------------------ */
/* Static layout                                                       */
/* ------------------------------------------------------------------ */

function layout() {
  return (
    '<div class="workbench-page">' +
    '<div class="wb-topbar">' +
    '<button type="button" class="wb-ws-btn" id="wb-ws-btn" title="切换工作区">' +
    `<span class="wb-ws-icon">${icon('folder', { size: 17 })}</span>` +
    '<span class="wb-ws-text">' +
    '<span class="wb-ws-name" id="wb-ws-name">加载工作区…</span>' +
    '<span class="wb-ws-path" id="wb-ws-path"></span>' +
    '</span>' +
    `<span class="wb-ws-caret">${icon('chevronDown', { size: 15 })}</span>` +
    '</button>' +
    '<div class="wb-topmeta">' +
    '<span class="wb-chip" title="后端类型"><span class="wb-chip-label">后端</span><span id="wb-backend">—</span></span>' +
    '<span class="wb-chip" title="主机"><span class="wb-chip-label">主机</span><span id="wb-host">—</span></span>' +
    '<span class="wb-chip" title="目录"><span class="wb-chip-label">目录</span><span id="wb-dir">—</span></span>' +
    '<span class="wb-chip" title="环境"><span class="wb-chip-label">环境</span><span id="wb-env">—</span></span>' +
    '<span class="wb-conn" id="wb-conn"><span class="wb-conn-dot"></span><span>—</span></span>' +
    '</div>' +
    '<div class="wb-topactions">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="wb-layout">布局</button>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="wb-probe">${icon('refresh', { size: 14 })}<span>刷新状态</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="wb-new-ws">${icon('folderPlus', { size: 14 })}<span>新建工作区</span></button>` +
    '</div>' +
    '</div>' +
    '<div class="wb-main">' +
    '<aside class="wb-left">' +
    '<div class="wb-left-head"><span>会话</span>' +
    `<button type="button" class="icon-btn" id="wb-new-conv" title="新建会话">${icon('plus', { size: 15 })}</button></div>` +
    '<div class="wb-convs" id="wb-convs"></div>' +
    '</aside>' +
    '<section class="wb-center" id="wb-center"></section>' +
    '<div class="wb-splitter wb-splitter-right" id="wb-splitter-right" role="separator" aria-orientation="vertical"></div>' +
    '<aside class="wb-right" id="wb-right"></aside>' +
    '</div>' +
    '<div class="wb-splitter wb-splitter-bottom" id="wb-splitter-bottom" role="separator" aria-orientation="horizontal"></div>' +
    '<footer class="wb-bottom" id="wb-bottom"></footer>' +
    '</div>'
  );
}

/** Allow the shell to open the workbench on a specific conversation. */
export function focusConversation(conversationId) {
  if (!conversationId) return;
  setState({ activeConversationId: conversationId });
  emit('chat:select', conversationId);
}
