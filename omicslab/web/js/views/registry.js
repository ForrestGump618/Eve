// Function registry view: search installed packages' functions, filter by module,
// copy a usage example and rebuild the index.

import { icon } from '../icons.js?v=1.0.0';
import {
  esc,
  escAttr,
  fmtNum,
  truncate,
  debounce,
  copyText,
} from '../util.js?v=1.0.0';
import { api, errorMessage } from '../api.js?v=1.0.0';
import {
  toastSuccess,
  toastError,
  toastInfo,
  openModal,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.0.0';

const SEARCH_LIMIT = 40;
const KIND_LABELS = { function: '函数', class: '类', method: '方法', module: '模块' };

function layout() {
  return (
    '<div class="page registry-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">函数库</h1>' +
    '<p class="page-subtitle">检索已安装科学计算包中的函数与类，查看签名、摘要与所属版本，一键复制调用示例。</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="registry-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="registry-refresh">${icon('refresh', {
      size: 15,
    })}<span>刷新索引</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="toolbar registry-toolbar">' +
    `<div class="search-box registry-search">${icon('search', { size: 15 })}` +
    '<input type="search" id="registry-search" placeholder="搜索函数、类或功能，例如 normalize、cluster、read_csv" aria-label="搜索函数" />' +
    '</div>' +
    '<label class="select-wrap registry-module-wrap" title="按模块过滤">' +
    icon('layers', { size: 15 }) +
    '<select id="registry-module" aria-label="模块过滤"><option value="">全部模块</option></select>' +
    '</label>' +
    `<span class="toolbar-meta" id="registry-index-meta"></span>` +
    '</div>' +
    '<div class="registry-results" id="registry-results"></div>' +
    '</div>'
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickResults(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['results', 'items', 'functions', 'matches', 'entries']) {
    const value = data?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeModules(data) {
  const raw = Array.isArray(data) ? data : asArray(data?.modules);
  const modules = [];
  for (const entry of raw) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      modules.push({ id: entry, label: entry, count: null });
      continue;
    }
    const id = entry.id || entry.module || entry.name || entry.path || '';
    if (!id) continue;
    const count =
      entry.count ?? entry.functions ?? entry.total ?? (Array.isArray(entry.items) ? entry.items.length : null);
    modules.push({ id: String(id), label: String(entry.label || id), count });
  }
  return modules;
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '函数';
}

function signatureHtml(signature) {
  if (!signature) return '';
  return `<code class="registry-signature">${esc(signature)}</code>`;
}

function pythonPath(item) {
  return String(item.module || item.package || item.qualname || item.name || '');
}

function exampleFor(item) {
  const name = String(item.qualname || item.name || '');
  const shortName = name.includes('.') ? name.split('.').pop() : name;
  const module = String(item.module || '');
  const packageName = String(item.package || '');
  const target = name.includes('.') ? name.split('.')[0] : name;
  const lines = [];
  if (module) {
    lines.push(`from ${module} import ${target}`);
  } else if (packageName) {
    lines.push(`from ${packageName} import ${target}`);
  } else {
    lines.push(`import ${target}`);
  }
  lines.push('');
  if (item.kind === 'class') lines.push(`obj = ${target}(...)`);
  else lines.push(`result = ${shortName}(...)`);
  if (item.signature) {
    lines.unshift(`# ${item.signature}`);
  }
  return lines.join('\n').trim();
}

function packageHtml(item) {
  if (!item.package) return '';
  const version = item.package_version || item.version || '';
  return `<span class="registry-pkg">${icon('book', { size: 12 })}${esc(item.package)}${
    version ? `<span class="registry-pkg-version">v${esc(String(version))}</span>` : ''
  }</span>`;
}

function resultCardHtml(item, idx) {
  const name = String(item.name || item.qualname || '未命名');
  const summary = item.summary || item.description || '';
  const docstring = item.docstring || '';
  const showDoc = docstring && docstring.trim() && docstring.trim() !== summary.trim();
  return (
    `<article class="registry-card" data-idx="${idx}">` +
    '<div class="registry-card-head">' +
    `<span class="registry-name">${esc(name)}</span>` +
    `<span class="kind-chip">${esc(kindLabel(item.kind))}</span>` +
    packageHtml(item) +
    '<span class="registry-card-actions">' +
    `<button type="button" class="btn btn-ghost btn-sm" data-action="detail" data-idx="${idx}">${icon(
      'eye',
      { size: 14 },
    )}<span>详情</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-action="copy-example" data-idx="${idx}">${icon(
      'copy',
      { size: 14 },
    )}<span>复制示例</span></button>` +
    '</span>' +
    '</div>' +
    (item.signature ? `<div class="registry-signature-row">${signatureHtml(item.signature)}</div>` : '') +
    (summary ? `<div class="registry-summary">${esc(summary)}</div>` : '') +
    '<div class="registry-meta">' +
    (item.module ? `<span class="registry-module">${icon('code', { size: 12 })}${esc(item.module)}</span>` : '') +
    (item.qualname && item.qualname !== name
      ? `<span class="registry-qualname">${esc(item.qualname)}</span>`
      : '') +
    (showDoc
      ? '<details class="registry-doc"><summary>查看文档</summary>' +
        `<pre class="registry-doc-text">${esc(truncate(docstring, 4000))}</pre></details>`
      : '') +
    '</div></article>'
  );
}

export async function mount(root, ctx = {}) {
  void ctx;
  root.innerHTML = layout();

  const el = {
    results: root.querySelector('#registry-results'),
    search: root.querySelector('#registry-search'),
    moduleSelect: root.querySelector('#registry-module'),
    refresh: root.querySelector('#registry-refresh'),
    count: root.querySelector('#registry-count'),
    indexMeta: root.querySelector('#registry-index-meta'),
  };

  const local = {
    query: '',
    module: '',
    results: [],
    modules: [],
    total: null,
    ready: null,
    stats: null,
    loading: false,
    refreshing: false,
    searched: false,
    error: '',
    reqId: 0,
    timer: 0,
  };

  function setCount(text) {
    if (el.count) el.count.textContent = text || '';
  }

  function renderModuleOptions() {
    const current = local.module;
    const options = ['<option value="">全部模块</option>'];
    for (const mod of local.modules) {
      const suffix = mod.count != null ? `（${fmtNum(mod.count)}）` : '';
      options.push(
        `<option value="${escAttr(mod.id)}">${esc(mod.label)}${esc(suffix)}</option>`,
      );
    }
    el.moduleSelect.innerHTML = options.join('');
    if (current && local.modules.some((m) => m.id === current)) el.moduleSelect.value = current;
    else local.module = el.moduleSelect.value || '';
  }

  function visibleResults() {
    if (!local.module) return local.results;
    const needle = local.module.toLowerCase();
    return local.results.filter((item) => {
      const module = String(item.module || item.package || '').toLowerCase();
      return module === needle || module.startsWith(`${needle}.`) || module.includes(needle);
    });
  }

  function renderResults() {
    if (local.loading) {
      el.results.innerHTML = spinnerHtml('搜索函数');
      return;
    }
    if (local.error) {
      el.results.innerHTML =
        '<div class="panel-error"><div class="error-card">' +
        `<div class="error-card-head"><span class="error-card-icon">${icon('alert', { size: 18 })}</span>` +
        '<div><div class="error-card-title">函数索引请求失败</div></div></div>' +
        `<div class="error-card-msg">${esc(local.error)}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="retry">重试</button></div>' +
        '</div></div>';
      return;
    }
    const items = visibleResults();
    if (!items.length) {
      const query = local.query.trim();
      const filtered = Boolean(query || local.module);
      if (!filtered && local.ready === false) {
        el.results.innerHTML = emptyStateHtml({
          iconName: 'registry',
          title: '函数索引尚未建立',
          hint: '点击「刷新索引」扫描工作区已安装的 Python 包（冷启动大约需要 30 秒）。',
          actionLabel: '刷新索引',
          actionId: 'registry-empty-refresh',
        });
        return;
      }
      if (!filtered) {
        el.results.innerHTML = emptyStateHtml({
          iconName: 'registry',
          title: '输入关键词开始搜索',
          hint: '支持函数名、模块名（如 scanpy.pp）或摘要关键词；索引覆盖工作区已安装的 Python 包。',
        });
        return;
      }
      el.results.innerHTML = emptyStateHtml({
        iconName: 'registry',
        title: '没有匹配的函数',
        hint: '试试更短的关键词，或切换模块过滤；索引只包含已安装且被索引的包。',
      });
      return;
    }
    el.results.innerHTML = `<div class="registry-list">${items
      .map((item) => resultCardHtml(item, local.results.indexOf(item)))
      .join('')}</div>`;
  }

  function updateMeta() {
    if (local.loading) {
      setCount('搜索中…');
      return;
    }
    const items = visibleResults();
    if (!local.searched) {
      setCount('');
      return;
    }
    const totalText = local.total != null && local.module ? `（总索引 ${fmtNum(local.total)}）` : '';
    setCount(`${fmtNum(items.length)} 个结果${totalText}`);
    if (el.indexMeta) {
      const stats = local.stats;
      const total = Number(stats?.items);
      const modules = Number(stats?.modules ?? local.modules.length);
      if (local.ready === false) {
        el.indexMeta.textContent = '索引尚未建立';
      } else if (Number.isFinite(total) && total > 0) {
        el.indexMeta.textContent = `索引 ${fmtNum(total)} 项 · ${fmtNum(modules)} 个模块`;
      } else if (local.modules.length) {
        el.indexMeta.textContent = `${fmtNum(local.modules.length)} 个模块已索引`;
      } else {
        el.indexMeta.textContent = '';
      }
    }
  }

  async function loadModules() {
    try {
      const data = await api.registry.modules();
      local.modules = normalizeModules(data);
      if (data?.ready != null) local.ready = data.ready !== false;
      if (data?.stats && typeof data.stats === 'object') local.stats = data.stats;
      renderModuleOptions();
    } catch {
      // Module filter is optional; search still works without it.
      local.modules = [];
      renderModuleOptions();
    }
  }

  async function runSearch() {
    local.reqId += 1;
    const reqId = local.reqId;
    const query = local.query.trim();
    if (!query) {
      local.loading = false;
      local.error = '';
      local.results = [];
      local.total = null;
      local.searched = true;
      renderResults();
      updateMeta();
      return;
    }
    local.loading = true;
    local.error = '';
    renderResults();
    updateMeta();
    try {
      const data = await api.registry.search(query, SEARCH_LIMIT);
      if (reqId !== local.reqId) return;
      local.results = pickResults(data);
      local.ready = data?.ready !== false;
      local.stats = data?.stats && typeof data.stats === 'object' ? data.stats : null;
      local.total =
        local.stats?.items != null && Number.isFinite(Number(local.stats.items))
          ? Number(local.stats.items)
          : local.results.length;
      local.searched = true;
    } catch (err) {
      if (reqId !== local.reqId) return;
      local.error = errorMessage(err);
      local.results = [];
      local.total = null;
    } finally {
      if (reqId === local.reqId) {
        local.loading = false;
        renderResults();
        updateMeta();
      }
    }
  }

  const debouncedSearch = debounce(() => {
    runSearch();
  }, 280);

  async function refreshIndex() {
    if (local.refreshing) return;
    local.refreshing = true;
    const startedAt = Date.now();
    local.timer = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      el.refresh.innerHTML = `${icon('spinner', { size: 15, cls: 'is-spinning' })}<span>正在刷新索引… ${secs}s</span>`;
    }, 1000);
    el.refresh.disabled = true;
    el.refresh.innerHTML = `${icon('spinner', { size: 15, cls: 'is-spinning' })}<span>正在刷新索引…</span>`;
    toastInfo('正在重建函数索引，冷启动可能需要约 30 秒，请勿关闭页面。', { timeout: 5000 });
    try {
      const data = await api.registry.refresh();
      const stats = data?.stats && typeof data.stats === 'object' ? data.stats : data || {};
      const missing = asArray(stats.missing_packages ?? data?.missing_packages);
      const indexed =
        stats.items ??
        stats.functions ??
        data?.indexed ??
        data?.total ??
        data?.count ??
        (Array.isArray(data?.modules) ? data.modules.length : null);
      if (data?.stats && typeof data.stats === 'object') local.stats = data.stats;
      if (data?.ok) local.ready = true;
      const parts = [];
      if (indexed != null) parts.push(`已索引 ${fmtNum(indexed)} 项`);
      if (missing.length) parts.push(`缺少包：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`);
      toastSuccess(parts.length ? `索引已更新：${parts.join('；')}` : '函数索引已更新');
      await loadModules();
      await runSearch();
    } catch (err) {
      toastError(`刷新索引失败：${errorMessage(err)}`);
    } finally {
      if (local.timer) clearInterval(local.timer);
      local.timer = 0;
      local.refreshing = false;
      el.refresh.disabled = false;
      el.refresh.innerHTML = `${icon('refresh', { size: 15 })}<span>刷新索引</span>`;
    }
  }

  function findItem(idx) {
    return local.results[Number(idx)] || null;
  }

  async function copyExample(idx) {
    const item = findItem(idx);
    if (!item) return;
    const example = exampleFor(item);
    const ok = await copyText(example);
    if (ok) toastSuccess(`已复制 ${item.name || item.qualname || ''} 的调用示例`);
    else toastError('复制失败，请手动选择文本');
  }

  async function showDetail(idx) {
    const item = findItem(idx);
    if (!item) return;
    let detail = item;
    if (item.name || item.qualname) {
      try {
        const data = await api.registry.func(item.name || item.qualname);
        const candidate = data?.function || data?.item || data?.result || data;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          detail = { ...item, ...candidate };
        }
      } catch {
        // Fall back to the search result row.
      }
    }
    const doc = detail.docstring || detail.description || '';
    const html =
      '<div class="registry-detail">' +
      '<div class="registry-detail-head">' +
      `<span class="registry-name">${esc(String(detail.name || detail.qualname || ''))}</span>` +
      `<span class="kind-chip">${esc(kindLabel(detail.kind))}</span>` +
      packageHtml(detail) +
      '</div>' +
      (detail.signature ? `<div class="registry-signature-row">${signatureHtml(detail.signature)}</div>` : '') +
      `<div class="registry-detail-path">${icon('code', { size: 13 })}<code>${esc(
        pythonPath(detail),
      )}</code></div>` +
      (detail.summary || detail.description
        ? `<div class="registry-detail-summary">${esc(detail.summary || detail.description)}</div>`
        : '') +
      (doc
        ? `<pre class="registry-doc-text registry-doc-full">${esc(truncate(doc, 8000))}</pre>`
        : '<div class="muted">该函数没有可用的文档字符串。</div>') +
      `<pre class="registry-example">${esc(exampleFor(detail))}</pre>` +
      '</div>';
    openModal({
      title: '函数详情',
      size: 'lg',
      html,
      actions: [
        { label: '关闭', kind: 'ghost' },
        {
          label: '复制示例',
          kind: 'primary',
          onClick: () =>
            copyText(exampleFor(detail)).then((ok) => {
              if (ok) toastSuccess('调用示例已复制');
              else toastError('复制失败');
            }),
        },
      ],
    });
  }

  el.search.addEventListener('input', () => {
    local.query = el.search.value;
    debouncedSearch();
  });

  el.moduleSelect.addEventListener('change', () => {
    local.module = el.moduleSelect.value;
    renderResults();
    updateMeta();
  });

  el.refresh.addEventListener('click', refreshIndex);

  el.results.addEventListener('click', (evt) => {
    if (evt.target.closest('#registry-empty-refresh')) {
      refreshIndex();
      return;
    }
    const retry = evt.target.closest('[data-action="retry"]');
    if (retry) {
      runSearch();
      return;
    }
    const actionEl = evt.target.closest('[data-action]');
    if (!actionEl) return;
    const idx = actionEl.dataset.idx;
    if (actionEl.dataset.action === 'copy-example') copyExample(idx);
    else if (actionEl.dataset.action === 'detail') showDetail(idx);
  });

  renderResults();
  updateMeta();
  await Promise.all([loadModules(), runSearch()]);
  renderResults();
  updateMeta();

  return {
    destroy() {
      if (local.timer) clearInterval(local.timer);
      local.timer = 0;
      debouncedSearch.cancel?.();
      root.innerHTML = '';
    },
  };
}
