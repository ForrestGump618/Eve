// Variables view: kernel workspace variables with a detail inspector.

import { icon } from '../icons.js?v=2.1.0';
import { esc, fmtBytes, fmtShape, debounce, truncate } from '../util.js?v=2.1.0';
import { api, errorMessage } from '../api.js?v=2.1.0';
import {
  h,
  toast,
  toastError,
  toastSuccess,
  openModal,
  confirmDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=2.1.0';

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    status: root.querySelector('#vars-kernel-status'),
    body: root.querySelector('#vars-body'),
    refresh: root.querySelector('#vars-refresh'),
    restart: root.querySelector('#vars-restart'),
    interrupt: root.querySelector('#vars-interrupt'),
    filter: root.querySelector('#vars-filter'),
    count: root.querySelector('#vars-count'),
  };

  const local = { vars: [], running: false, filter: '', loading: false };

  function renderStatus() {
    if (local.running) {
      el.status.className = 'status-chip is-ok';
      el.status.innerHTML = `<span class="status-dot"></span>内核运行中`;
    } else {
      el.status.className = 'status-chip is-off';
      el.status.innerHTML = `<span class="status-dot"></span>内核未启动`;
    }
  }

  function rows() {
    const q = local.filter.trim().toLowerCase();
    return local.vars.filter((v) => !q || String(v.name || '').toLowerCase().includes(q));
  }

  function render() {
    el.count.textContent = `${local.vars.length} 个变量`;
    renderStatus();
    const list = rows();
    if (!list.length) {
      el.body.innerHTML = emptyStateHtml({
        iconName: 'vars',
        title: local.vars.length ? '没有匹配的变量' : '内核中还没有变量',
        hint: local.vars.length
          ? '换个关键词试试'
          : '在对话中执行代码或使用后台任务后，变量会出现在这里。',
      });
      return;
    }
    el.body.innerHTML =
      '<div class="table-wrap"><table class="data-table vars-table">' +
      '<thead><tr>' +
      '<th class="col-name">名称</th><th class="col-type">类型</th><th class="col-shape">形状</th>' +
      '<th class="col-size">大小</th><th class="col-tags">标记</th><th class="col-preview">预览</th>' +
      '</tr></thead><tbody>' +
      list
        .map((v) => {
          const tags = [];
          if (v.is_dataframe) tags.push('<span class="tag tag-purple">DataFrame</span>');
          if (v.is_anndata) tags.push('<span class="tag tag-cyan">AnnData</span>');
          return (
            `<tr class="var-row" data-name="${esc(v.name || '')}" tabindex="0">` +
            `<td class="col-name"><span class="var-name">${esc(v.name || '')}</span></td>` +
            `<td class="col-type"><span class="type-chip">${esc(v.type || '—')}</span></td>` +
            `<td class="col-shape">${esc(fmtShape(v.shape))}</td>` +
            `<td class="col-size">${esc(v.size_bytes != null ? fmtBytes(v.size_bytes) : '—')}</td>` +
            `<td class="col-tags">${tags.join(' ') || '—'}</td>` +
            `<td class="col-preview"><code class="var-repr">${esc(truncate(v.repr || '', 120))}</code></td>` +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  async function load() {
    if (local.loading) return;
    local.loading = true;
    el.refresh.classList.add('is-spinning');
    if (!local.vars.length) el.body.innerHTML = `<div class="panel-loading">${spinnerHtml('读取内核变量')}</div>`;
    try {
      const data = await api.kernel.vars();
      local.vars = Array.isArray(data?.vars) ? data.vars : Array.isArray(data) ? data : [];
      local.running = Boolean(data?.running ?? local.vars.length);
      render();
    } catch (err) {
      local.running = false;
      renderStatus();
      el.body.innerHTML = '';
      el.body.appendChild(errorPanel(errorMessage(err), () => load()));
    } finally {
      local.loading = false;
      el.refresh.classList.remove('is-spinning');
    }
  }

  function errorPanel(message, retry) {
    const node = h(
      '<div class="panel-error"><div class="error-card"><div class="error-card-head">' +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取内核变量</div></div>' +
        `<div class="error-card-msg">${esc(message)}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm">重试</button></div></div></div>',
    );
    node.querySelector('button').addEventListener('click', retry);
    return node;
  }

  async function openDetail(name) {
    const holder = h(
      `<div class="var-detail"><div class="panel-loading">${spinnerHtml('读取变量详情')}</div></div>`,
    );
    const modal = openModal({
      title: `变量：${name}`,
      size: 'lg',
      node: holder,
      actions: [{ label: '关闭', kind: 'ghost' }],
    });
    try {
      const d = await api.kernel.varDetail(name);
      if (d?.error) {
        holder.innerHTML = `<div class="inline-error">${icon('alert', { size: 15 })}<span>${esc(String(d.error))}</span></div>`;
        return;
      }
      holder.innerHTML = varDetailHtml(d, name);
    } catch (err) {
      holder.innerHTML = `<div class="inline-error">${icon('alert', { size: 15 })}<span>${esc(errorMessage(err))}</span></div>`;
    }
    void modal;
  }

  function varDetailHtml(d, fallbackName) {
    const meta = [];
    if (d?.type) meta.push(`<span class="detail-kv"><b>类型</b>${esc(d.type)}</span>`);
    if (d?.shape) meta.push(`<span class="detail-kv"><b>形状</b>${esc(fmtShape(d.shape))}</span>`);
    if (d?.size_bytes != null) meta.push(`<span class="detail-kv"><b>大小</b>${esc(fmtBytes(d.size_bytes))}</span>`);

    const repr = d?.repr ? `<div class="detail-section"><h4>repr</h4><pre class="detail-pre">${esc(d.repr)}</pre></div>` : '';
    const dtypes = renderDtypes(d?.dtypes, d?.columns);
    const head = renderHead(d?.head, d?.columns);
    const describe = renderDescribe(d?.describe);
    void fallbackName;
    return (
      `<div class="detail-meta">${meta.join('') || '<span class="muted">无附加信息</span>'}</div>` +
      repr +
      head +
      dtypes +
      describe
    );
  }

  function renderHead(headData, columns) {
    if (headData == null || headData === '') return '';
    if (typeof headData === 'string') {
      return `<div class="detail-section"><h4>数据预览</h4><pre class="detail-pre">${esc(headData)}</pre></div>`;
    }
    if (!Array.isArray(headData)) {
      return `<div class="detail-section"><h4>数据预览</h4><pre class="detail-pre">${esc(safeJson(headData))}</pre></div>`;
    }
    if (!headData.length) return '';
    const cols = Array.isArray(columns) && columns.length ? columns : null;
    if (headData.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      const keys = cols || Object.keys(headData[0]);
      return (
        '<div class="detail-section"><h4>数据预览</h4><div class="table-wrap"><table class="data-table mini">' +
        `<thead><tr><th class="row-index">#</th>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>` +
        headData
          .map(
            (row, idx) =>
              `<tr><td class="row-index">${idx}</td>${keys
                .map((k) => `<td>${esc(cellText(row?.[k]))}</td>`)
                .join('')}</tr>`,
          )
          .join('') +
        '</tbody></table></div></div>'
      );
    }
    if (headData.every((r) => Array.isArray(r))) {
      const width = Math.max(...headData.map((r) => r.length));
      const headers = cols && cols.length === width ? cols : Array.from({ length: width }, (_, i) => String(i));
      return (
        '<div class="detail-section"><h4>数据预览</h4><div class="table-wrap"><table class="data-table mini">' +
        `<thead><tr><th class="row-index">#</th>${headers.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>` +
        headData
          .map((row, idx) => `<tr><td class="row-index">${idx}</td>${headers.map((_k, i) => `<td>${esc(cellText(row[i]))}</td>`).join('')}</tr>`)
          .join('') +
        '</tbody></table></div></div>'
      );
    }
    return `<div class="detail-section"><h4>数据预览</h4><pre class="detail-pre">${esc(safeJson(headData))}</pre></div>`;
  }

  function renderDtypes(dtypes, columns) {
    if (dtypes == null) return '';
    if (typeof dtypes === 'string') {
      return `<div class="detail-section"><h4>dtypes</h4><pre class="detail-pre">${esc(dtypes)}</pre></div>`;
    }
    let entries = [];
    if (Array.isArray(dtypes)) {
      entries = dtypes.map((v, i) => [columns?.[i] ?? String(i), cellText(v)]);
    } else if (typeof dtypes === 'object') {
      entries = Object.entries(dtypes).map(([k, v]) => [k, cellText(v)]);
    }
    if (!entries.length) return '';
    return (
      '<div class="detail-section"><h4>dtypes</h4><div class="dtype-grid">' +
      entries
        .map(([k, v]) => `<div class="dtype-item"><span class="dtype-key">${esc(k)}</span><span class="dtype-val">${esc(v)}</span></div>`)
        .join('') +
      '</div></div>'
    );
  }

  function renderDescribe(describe) {
    if (describe == null || describe === '') return '';
    if (typeof describe === 'string') {
      return `<div class="detail-section"><h4>describe()</h4><pre class="detail-pre">${esc(describe)}</pre></div>`;
    }
    if (Array.isArray(describe)) {
      return `<div class="detail-section"><h4>describe()</h4><pre class="detail-pre">${esc(safeJson(describe))}</pre></div>`;
    }
    if (typeof describe === 'object') {
      const keys = Object.keys(describe);
      const cols = keys.length ? (typeof describe[keys[0]] === 'object' ? Object.keys(describe[keys[0]] || {}) : []) : [];
      if (cols.length) {
        return (
          '<div class="detail-section"><h4>describe()</h4><div class="table-wrap"><table class="data-table mini">' +
          `<thead><tr><th class="row-index">统计量</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
          keys
            .map(
              (key) =>
                `<tr><td class="row-index">${esc(key)}</td>${cols
                  .map((c) => `<td>${esc(cellText(describe[key]?.[c]))}</td>`)
                  .join('')}</tr>`,
            )
            .join('') +
          '</tbody></table></div></div>'
        );
      }
      return `<div class="detail-section"><h4>describe()</h4><pre class="detail-pre">${esc(safeJson(describe))}</pre></div>`;
    }
    return '';
  }

  function cellText(value) {
    if (value == null) return '—';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
    if (typeof value === 'object') return safeJson(value);
    return String(value);
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /* events ---------------------------------------------------------- */

  el.body.addEventListener('click', (evt) => {
    const row = evt.target.closest('.var-row');
    if (!row) return;
    openDetail(row.dataset.name);
  });
  el.body.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    const row = evt.target.closest('.var-row');
    if (row) openDetail(row.dataset.name);
  });
  el.filter.addEventListener(
    'input',
    debounce(() => {
      local.filter = el.filter.value;
      render();
    }, 120),
  );
  el.refresh.addEventListener('click', () => load());
  el.restart.addEventListener('click', async () => {
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
      await load();
    } catch (err) {
      toastError(`重启失败：${errorMessage(err)}`);
    }
  });
  el.interrupt.addEventListener('click', async () => {
    try {
      await api.kernel.interrupt();
      toastSuccess('已发送中断信号');
    } catch (err) {
      toastError(`中断失败：${errorMessage(err)}`);
    }
  });

  await load();
  return { destroy() { root.innerHTML = ''; } };
}

function layout() {
  return (
    '<div class="page vars-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">变量</h1>' +
    '<p class="page-subtitle">当前 Jupyter 内核工作区中的对象概览</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="status-chip" id="vars-kernel-status"><span class="status-dot"></span>检测中…</span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="vars-interrupt" title="中断当前执行">${icon('stop', { size: 15 })}<span>中断</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="vars-restart">${icon('refresh', { size: 15 })}<span>重启内核</span></button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="vars-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="toolbar">' +
    '<div class="search-box">' +
    icon('search', { size: 15 }) +
    '<input type="search" id="vars-filter" placeholder="按变量名筛选" aria-label="筛选变量" />' +
    '</div>' +
    '<span class="toolbar-meta" id="vars-count"></span>' +
    '</div>' +
    '<div class="card panel vars-panel" id="vars-body"></div>' +
    '</div>'
  );
}
