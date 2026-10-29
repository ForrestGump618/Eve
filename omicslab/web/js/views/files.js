// Files view: lazy workspace tree on the left, preview (text/image/CSV/binary) on the right,
// plus upload / new file / new folder / delete.

import { icon } from '../icons.js?v=1.2.0';
import {
  esc,
  fmtBytes,
  fmtTime,
  extOf,
  baseName,
  dirName,
  getPref,
  setPref,
  parseDelimited,
  debounce,
} from '../util.js?v=1.2.0';
import { api, errorMessage } from '../api.js?v=1.2.0';
import {
  h,
  toast,
  toastError,
  toastSuccess,
  openLightbox,
  confirmDialog,
  promptDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.2.0';

const TREE_MIN = 190;
const TREE_MAX = 520;
const TREE_DEFAULT = 292;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff']);
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.py', '.r', '.rmd', '.js', '.mjs', '.ts',
  '.css', '.html', '.htm', '.sh', '.bash', '.cfg', '.ini', '.toml', '.log', '.sql', '.tex', '.bib', '.ipynb',
  '.xml', '.plist', '.env', '.gitignore', '.dockerfile', '.h5ad.txt', '.rst', '.svg.txt',
]);
const TABLE_EXTS = new Set(['.csv', '.tsv']);

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    page: root.querySelector('.files-page'),
    tree: root.querySelector('#file-tree'),
    preview: root.querySelector('#file-preview'),
    previewHead: root.querySelector('#preview-head'),
    previewBody: root.querySelector('#preview-body'),
    splitter: root.querySelector('.file-splitter'),
    refresh: root.querySelector('#files-refresh'),
    newFile: root.querySelector('#files-new-file'),
    newFolder: root.querySelector('#files-new-folder'),
    uploadBtn: root.querySelector('#files-upload'),
    uploadInput: root.querySelector('#files-file-input'),
    targetLabel: root.querySelector('#files-target'),
    dropOverlay: root.querySelector('.drop-overlay'),
    crumb: root.querySelector('#files-crumb'),
  };

  const local = {
    children: new Map(),
    expanded: new Set(['.']),
    loading: new Set(),
    selected: null,
    currentDir: '.',
    previewAbort: null,
    dragDepth: 0,
    sort: 'name',
    rootError: null,
  };

  applyTreeWidth(getPref('filesTreeWidth', TREE_DEFAULT));

  function applyTreeWidth(width) {
    const w = Math.min(TREE_MAX, Math.max(TREE_MIN, Number(width) || TREE_DEFAULT));
    el.page.style.setProperty('--tree-w', `${w}px`);
  }

  const kindOf = (pathOrEntry) => {
    const isDir = typeof pathOrEntry === 'object' ? pathOrEntry.is_dir : false;
    if (isDir) return 'dir';
    const path = typeof pathOrEntry === 'object' ? pathOrEntry.path : pathOrEntry;
    const ext = extOf(path);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (TABLE_EXTS.has(ext)) return 'table';
    if (TEXT_EXTS.has(ext)) return 'text';
    return 'binary';
  };

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      if (Boolean(a.is_dir) !== Boolean(b.is_dir)) return a.is_dir ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
  }

  async function loadDir(path, { force = false } = {}) {
    if (!force && local.children.has(path)) return local.children.get(path);
    if (local.loading.has(path)) return null;
    local.loading.add(path);
    if (path === '.') local.rootError = null;
    renderTree();
    try {
      const data = await api.files.tree(path);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      local.children.set(path, sortEntries(entries));
      return entries;
    } catch (err) {
      toastError(`读取目录失败：${errorMessage(err)}`);
      local.children.delete(path);
      if (path === '.') local.rootError = err;
      return null;
    } finally {
      local.loading.delete(path);
      renderTree();
    }
  }

  async function retryRoot() {
    local.rootError = null;
    await loadDir('.', { force: true });
    renderTree();
    renderDirPreview({ path: '.', name: '工作区', is_dir: true });
  }

  function renderTree() {
    if (!local.children.has('.')) {
      if (local.rootError) {
        el.tree.innerHTML =
          '<div class="tree-empty tree-error">' +
          `<div class="tree-error-title">${icon('alert', { size: 16 })}<span>无法读取文件树</span></div>` +
          `<div class="tree-error-msg">${esc(errorMessage(local.rootError))}</div>` +
          '<button type="button" class="btn btn-ghost btn-sm" id="tree-retry">重试</button>' +
          '</div>';
        el.tree.querySelector('#tree-retry')?.addEventListener('click', () => {
          loadDir('.', { force: true }).then(() => renderDirPreview({ path: '.', name: '工作区', is_dir: true }));
        });
        return;
      }
      el.tree.innerHTML = `<div class="tree-loading">${spinnerHtml('加载文件树')}</div>`;
      return;
    }
    const html = [];
    const walk = (dirPath, depth) => {
      const entries = local.children.get(dirPath) || [];
      for (const entry of entries) {
        const path = entry.path || entry.name;
        const isDir = Boolean(entry.is_dir);
        const expanded = isDir && local.expanded.has(path);
        const selected = local.selected && (local.selected.path === path || (isDir && local.currentDir === path));
        const loading = local.loading.has(path);
        const iconName = isDir
          ? expanded
            ? 'folder'
            : 'folder'
          : kindOf(entry) === 'image'
            ? 'image'
            : kindOf(entry) === 'table'
              ? 'table'
              : kindOf(entry) === 'text'
                ? 'fileText'
                : 'file';
        html.push(
          '<div class="tree-row' +
            (selected ? ' is-selected' : '') +
            (isDir ? ' is-dir' : '') +
            '"' +
            ` data-path="${esc(path)}" data-dir="${isDir ? '1' : '0'}" data-depth="${depth}"` +
            ` role="button" tabindex="0" title="${esc(path)}">` +
            `<span class="tree-twisty">${isDir ? icon(expanded ? 'chevronDown' : 'chevronRight', { size: 13 }) : ''}</span>` +
            `<span class="tree-icon">${icon(iconName, { size: 15 })}</span>` +
            `<span class="tree-name">${esc(entry.name || baseName(path))}</span>` +
            (loading ? '<span class="tree-spinner spinner"></span>' : '') +
            (entry.size != null && !isDir ? `<span class="tree-size">${esc(fmtBytes(entry.size))}</span>` : '') +
            '</div>',
        );
        if (isDir && expanded) walk(path, depth + 1);
      }
    };
    walk('.', 0);
    el.tree.innerHTML = html.length ? html.join('') : `<div class="tree-empty">空目录</div>`;
    el.tree.querySelectorAll('.tree-row').forEach((row) => {
      row.style.setProperty('--depth', row.dataset.depth);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Preview                                                           */
  /* ---------------------------------------------------------------- */

  function renderCrumb(path) {
    const parts = String(path || '.').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) {
      el.crumb.innerHTML = '<span class="crumb-item is-current">工作区根目录</span>';
      return;
    }
    el.crumb.innerHTML =
      '<button type="button" class="crumb-item crumb-root" data-path=".">工作区</button>' +
      parts
        .map((part, idx) => {
          const sub = parts.slice(0, idx + 1).join('/');
          const isLast = idx === parts.length - 1;
          return (
            `<span class="crumb-sep">${icon('chevronRight', { size: 12 })}</span>` +
            `<button type="button" class="crumb-item${isLast ? ' is-current' : ''}" data-path="${esc(sub)}">${esc(part)}</button>`
          );
        })
        .join('');
  }

  function showPlaceholder() {
    el.previewHead.innerHTML = '<span class="preview-title">预览</span>';
    el.previewBody.innerHTML = emptyStateHtml({
      iconName: 'files',
      title: '选择一个文件预览',
      hint: '支持文本（带行号）、图片、CSV / TSV 表格与二进制下载。也可以把文件拖进这个面板上传。',
      actionLabel: '上传文件',
      actionId: 'preview-upload',
    });
    el.previewBody.querySelector('#preview-upload')?.addEventListener('click', () => el.uploadInput.click());
  }

  function renderDirPreview(entry) {
    const path = entry.path || local.currentDir || '.';
    local.currentDir = path;
    local.selected = entry;
    renderCrumb(path);
    const children = local.children.get(path);
    el.previewHead.innerHTML =
      '<div class="preview-heading">' +
      `<span class="preview-icon">${icon('folder', { size: 18 })}</span>` +
      '<div><div class="preview-title">' +
      esc(entry.name || baseName(path) || '工作区') +
      '</div>' +
      `<div class="preview-sub">${esc(path)}</div></div></div>` +
      '<div class="preview-actions">' +
      `<button type="button" class="btn btn-ghost btn-sm" id="dir-new-file">${icon('filePlus', { size: 15 })}<span>新建文件</span></button>` +
      `<button type="button" class="btn btn-ghost btn-sm" id="dir-new-folder">${icon('folderPlus', { size: 15 })}<span>新建文件夹</span></button>` +
      `<button type="button" class="btn btn-primary btn-sm" id="dir-upload">${icon('upload', { size: 15 })}<span>上传到此目录</span></button>` +
      '</div>';
    el.previewHead.querySelector('#dir-new-file')?.addEventListener('click', () => newFile(path));
    el.previewHead.querySelector('#dir-new-folder')?.addEventListener('click', () => newFolder(path));
    el.previewHead.querySelector('#dir-upload')?.addEventListener('click', () => el.uploadInput.click());
    if (!children && local.rootError && path === '.') {
      el.previewBody.innerHTML =
        '<div class="dir-preview dir-preview-error"><div class="error-card">' +
        '<div class="error-card-head">' +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取目录</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(local.rootError))}</div>` +
        '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="dir-retry">重试</button></div>' +
        '</div></div>';
      el.previewBody.querySelector('#dir-retry')?.addEventListener('click', () => retryRoot());
      return;
    }
    el.previewBody.innerHTML =
      '<div class="dir-preview">' +
      `<div class="dir-meta">${children == null ? spinnerHtml('读取目录') : `${children.length} 个条目`}</div>` +
      '<div class="dir-grid" id="dir-grid"></div>' +
      '</div>';
    if (children) renderDirGrid(children);
    void children;
  }

  function renderDirGrid(children) {
    const grid = el.previewBody.querySelector('#dir-grid');
    if (!grid) return;
    if (!children.length) {
      grid.innerHTML = '<div class="dir-empty">这个目录是空的</div>';
      return;
    }
    grid.innerHTML = children
      .slice(0, 200)
      .map((entry) => {
        const kind = kindOf(entry);
        const iconName = entry.is_dir
          ? 'folder'
          : kind === 'image'
            ? 'image'
            : kind === 'table'
              ? 'table'
              : kind === 'text'
                ? 'fileText'
                : 'file';
        const meta = entry.is_dir ? '文件夹' : fmtBytes(entry.size);
        return (
          `<button type="button" class="dir-item" data-path="${esc(entry.path || entry.name)}" data-dir="${entry.is_dir ? '1' : '0'}">` +
          `<span class="dir-item-icon">${icon(iconName, { size: 22 })}</span>` +
          `<span class="dir-item-name" title="${esc(entry.name)}">${esc(entry.name)}</span>` +
          `<span class="dir-item-meta">${esc(meta)}</span>` +
          '</button>'
        );
      })
      .join('');
    grid.querySelectorAll('.dir-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const path = btn.dataset.path;
        if (btn.dataset.dir === '1') {
          local.expanded.add(path);
          loadDir(path).then(() => {
            renderTree();
            renderDirPreview({ path, name: baseName(path), is_dir: true });
          });
        } else {
          openFile({ path, name: baseName(path), is_dir: false });
        }
      });
    });
  }

  async function openFile(entry) {
    local.selected = entry;
    renderTree();
    const path = entry.path;
    const kind = kindOf(entry);
    renderCrumb(dirName(path) === '.' ? path : path);
    el.previewBody.innerHTML = `<div class="preview-loading">${spinnerHtml('加载文件')}</div>`;
    el.previewHead.innerHTML =
      '<div class="preview-heading">' +
      `<span class="preview-icon">${icon(kind === 'image' ? 'image' : kind === 'table' ? 'table' : 'fileText', { size: 18 })}</span>` +
      `<div><div class="preview-title">${esc(entry.name || baseName(path))}</div>` +
      `<div class="preview-sub">${esc(path)}</div></div></div>` +
      '<div class="preview-actions">' +
      `<a class="btn btn-ghost btn-sm" href="${esc(api.files.rawUrl(path))}" download>${icon('download', { size: 15 })}<span>下载</span></a>` +
      `<button type="button" class="btn btn-danger btn-sm" id="file-delete">${icon('trash', { size: 15 })}<span>删除</span></button>` +
      '</div>';
    el.previewHead.querySelector('#file-delete')?.addEventListener('click', () => deletePath(path, false));

    if (kind === 'image') {
      const src = api.files.rawUrl(path);
      el.previewBody.innerHTML = `<div class="image-preview"><img src="${esc(src)}" alt="${esc(entry.name || '')}" /></div>`;
      el.previewBody.querySelector('img')?.addEventListener('click', () =>
        openLightbox({ src, title: entry.name || baseName(path), downloadUrl: src }),
      );
      return;
    }

    if (kind === 'binary') {
      el.previewBody.innerHTML =
        '<div class="binary-preview">' +
        `<div class="binary-icon">${icon('file', { size: 42 })}</div>` +
        `<div class="binary-name">${esc(entry.name || baseName(path))}</div>` +
        `<div class="binary-meta">${esc(fmtBytes(entry.size))}${entry.mtime ? ` · ${esc(fmtTime(entry.mtime))}` : ''}</div>` +
        '<div class="binary-hint">该文件类型不支持在线预览，请下载后查看。</div>' +
        `<a class="btn btn-primary btn-sm" href="${esc(api.files.rawUrl(path))}" download>${icon('download', { size: 15 })}<span>下载文件</span></a>` +
        '</div>';
      return;
    }

    try {
      const data = await api.files.read(path, 512000);
      if (data?.binary) {
        el.previewBody.innerHTML =
          `<div class="binary-preview"><div class="binary-icon">${icon('file', { size: 42 })}</div>` +
          `<div class="binary-name">${esc(entry.name || baseName(path))}</div>` +
          `<div class="binary-meta">${esc(fmtBytes(data.size ?? entry.size))} · ${esc(data.mime || '二进制文件')}</div>` +
          '<div class="binary-hint">后端判定为二进制文件，无法以文本预览。</div>' +
          `<a class="btn btn-primary btn-sm" href="${esc(api.files.rawUrl(path))}" download>${icon('download', { size: 15 })}<span>下载文件</span></a></div>`;
        return;
      }
      const text = String(data?.text ?? '');
      const truncated = Boolean(data?.truncated);
      if (kind === 'table') {
        renderTablePreview(text, truncated, extOf(path) === '.tsv' ? '\t' : ',');
        return;
      }
      renderTextPreview(text, truncated);
    } catch (err) {
      el.previewBody.innerHTML =
        `<div class="preview-error"><div class="error-card"><div class="error-card-head">` +
        `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
        '<div class="error-card-title">无法读取文件</div></div>' +
        `<div class="error-card-msg">${esc(errorMessage(err))}</div></div></div>`;
    }
  }

  function renderTextPreview(text, truncated) {
    const lines = text.split('\n');
    const lineCount = lines.length;
    const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');
    el.previewBody.innerHTML =
      '<div class="text-preview">' +
      (truncated ? '<div class="preview-notice">文件较大，仅显示前 512 KB 内容。</div>' : '') +
      '<div class="code-view"><div class="line-nums">' +
      esc(gutter) +
      '</div><pre class="code-text">' +
      esc(text) +
      '</pre></div></div>';
  }

  function renderTablePreview(text, truncated, delimiter) {
    const rows = parseDelimited(text, delimiter, 201);
    const header = rows[0] || [];
    const body = rows.slice(1, 201);
    const totalCols = Math.max(header.length, ...body.slice(0, 50).map((r) => r.length), 1);
    const headCells = Array.from({ length: totalCols }, (_, i) => header[i] ?? '');
    el.previewBody.innerHTML =
      '<div class="csv-preview">' +
      (truncated ? '<div class="preview-notice">文件较大，表格仅解析已读取的前 512 KB。</div>' : '') +
      `<div class="preview-notice subtle">CSV 预览：${body.length} 行 × ${totalCols} 列（最多显示 200 行）</div>` +
      '<div class="table-wrap"><table class="data-table csv-table"><thead><tr>' +
      `<th class="row-index">#</th>${headCells.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
      body
        .map(
          (row, idx) =>
            `<tr><td class="row-index">${idx + 1}</td>` +
            headCells.map((_h, i) => `<td>${esc(row[i] ?? '')}</td>`).join('') +
            '</tr>',
        )
        .join('') +
      '</tbody></table></div></div>';
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  function currentTargetDir() {
    if (local.selected?.is_dir) return local.selected.path || '.';
    if (local.selected?.path) {
      const dir = dirName(local.selected.path);
      return dir || '.';
    }
    return local.currentDir || '.';
  }

  function updateTargetLabel() {
    if (el.targetLabel) el.targetLabel.textContent = currentTargetDir();
  }

  async function refreshTree({ keepSelection = false } = {}) {
    const selected = keepSelection ? local.selected : null;
    const expanded = [...local.expanded];
    local.children.clear();
    await loadDir('.');
    await Promise.all(expanded.filter((p) => p !== '.').map((p) => loadDir(p)));
    renderTree();
    if (selected?.path) {
      if (selected.is_dir) renderDirPreview(selected);
      else openFile(selected);
    }
    updateTargetLabel();
  }

  async function uploadFiles(files, dir) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let ok = 0;
    for (const file of list) {
      try {
        await api.files.upload(file, dir || '.', {
          onProgress: (pct) => {
            if (pct >= 100) toastInfo(`上传完成：${file.name}`, { timeout: 1600 });
          },
        });
        ok += 1;
      } catch (err) {
        toastError(`上传 ${file.name} 失败：${errorMessage(err)}`);
      }
    }
    if (ok) {
      toastSuccess(`已上传 ${ok} 个文件到 ${dir || '.'}`);
      if (local.children.has(dir)) local.children.delete(dir);
      await loadDir(dir || '.', { force: true });
      renderTree();
      if (local.selected?.is_dir && local.selected.path === (dir || '.')) renderDirPreview(local.selected);
      if (!local.selected) {
        const entry = (local.children.get(dir || '.') || []).find((e) => e.name === list[0].name);
        if (entry) openFile(entry);
      }
    }
  }

  async function newFile(dir) {
    const name = await promptDialog({
      title: '新建文件',
      message: `目录：${dir}`,
      placeholder: '例如 analysis.py',
      confirmText: '创建',
    });
    if (!name || !name.trim()) return;
    const path = joinPath(dir, name.trim());
    try {
      await api.files.write(path, '');
      toastSuccess('文件已创建');
      await loadDir(dir, { force: true });
      renderTree();
      openFile({ path, name: baseName(path), is_dir: false });
    } catch (err) {
      toastError(`创建失败：${errorMessage(err)}`);
    }
  }

  async function newFolder(dir) {
    const name = await promptDialog({
      title: '新建文件夹',
      message: `目录：${dir}`,
      placeholder: '例如 results',
      confirmText: '创建',
    });
    if (!name || !name.trim()) return;
    const path = joinPath(dir, name.trim());
    try {
      await api.files.mkdir(path);
      toastSuccess('文件夹已创建');
      await loadDir(dir, { force: true });
      renderTree();
      renderDirPreview({ path: dir, name: baseName(dir) || '工作区', is_dir: true });
    } catch (err) {
      toastError(`创建失败：${errorMessage(err)}`);
    }
  }

  async function deletePath(path, isDir) {
    const name = baseName(path);
    const ok = await confirmDialog({
      title: isDir ? '删除文件夹' : '删除文件',
      message: `确定删除「${name}」吗？${isDir ? '文件夹内的所有内容都会被删除。' : ''}此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.files.remove(path);
      toastSuccess('已删除');
      local.selected = null;
      const parent = dirName(path) || '.';
      if (local.children.has(parent)) local.children.delete(parent);
      await loadDir(parent, { force: true });
      renderTree();
      showPlaceholder();
      renderCrumb('.');
    } catch (err) {
      toastError(`删除失败：${errorMessage(err)}`);
    }
  }

  function joinPath(dir, name) {
    const d = String(dir || '.').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!d || d === '.') return name;
    return `${d}/${name}`;
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  el.tree.addEventListener('click', async (evt) => {
    const row = evt.target.closest('.tree-row');
    if (!row) return;
    const path = row.dataset.path;
    const isDir = row.dataset.dir === '1';
    if (isDir) {
      if (local.expanded.has(path)) {
        local.expanded.delete(path);
        local.currentDir = path;
        local.selected = { path, name: baseName(path), is_dir: true };
        renderTree();
        await loadDir(path);
        renderDirPreview(local.selected);
      } else {
        local.expanded.add(path);
        local.currentDir = path;
        local.selected = { path, name: baseName(path), is_dir: true };
        renderTree();
        await loadDir(path);
        renderDirPreview(local.selected);
      }
      updateTargetLabel();
    } else {
      openFile({ path, name: baseName(path), is_dir: false, size: null });
    }
  });

  el.tree.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const row = evt.target.closest('.tree-row');
    if (!row) return;
    evt.preventDefault();
    row.click();
  });

  el.crumb.addEventListener('click', async (evt) => {
    const btn = evt.target.closest('.crumb-item');
    if (!btn) return;
    const path = btn.dataset.path;
    if (path === '.') {
      local.currentDir = '.';
      local.selected = { path: '.', name: '工作区', is_dir: true };
      await loadDir('.');
      renderTree();
      renderDirPreview(local.selected);
    } else if (local.children.has(path)) {
      local.currentDir = path;
      local.selected = { path, name: baseName(path), is_dir: true };
      renderTree();
      renderDirPreview(local.selected);
    } else {
      const parent = dirName(path) || '.';
      local.currentDir = parent;
      await loadDir(parent);
      local.expanded.add(parent);
      renderTree();
      renderDirPreview({ path: parent, name: baseName(parent) || '工作区', is_dir: true });
    }
  });

  el.refresh.addEventListener('click', () => {
    refreshTree({ keepSelection: true });
  });
  el.newFile.addEventListener('click', () => newFile(currentTargetDir()));
  el.newFolder.addEventListener('click', () => newFolder(currentTargetDir()));
  el.uploadBtn.addEventListener('click', () => el.uploadInput.click());
  el.uploadInput.addEventListener('change', async () => {
    const dir = currentTargetDir();
    await uploadFiles(el.uploadInput.files, dir);
    el.uploadInput.value = '';
  });

  // Drag & drop upload over the preview panel
  const hasFiles = (evt) => Array.from(evt.dataTransfer?.types || []).includes('Files');
  el.preview.addEventListener('dragenter', (evt) => {
    if (!hasFiles(evt)) return;
    evt.preventDefault();
    local.dragDepth += 1;
    el.dropOverlay.classList.add('is-visible');
  });
  el.preview.addEventListener('dragover', (evt) => {
    if (!hasFiles(evt)) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
  });
  el.preview.addEventListener('dragleave', (evt) => {
    if (!hasFiles(evt)) return;
    local.dragDepth = Math.max(0, local.dragDepth - 1);
    if (!local.dragDepth) el.dropOverlay.classList.remove('is-visible');
  });
  el.preview.addEventListener('drop', async (evt) => {
    if (!hasFiles(evt)) return;
    evt.preventDefault();
    local.dragDepth = 0;
    el.dropOverlay.classList.remove('is-visible');
    const dir = currentTargetDir();
    await uploadFiles(evt.dataTransfer.files, dir);
  });

  // splitter
  let dragging = false;
  const onMove = (evt) => {
    if (!dragging) return;
    const rect = el.page.getBoundingClientRect();
    applyTreeWidth(evt.clientX - rect.left);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing');
    const width = parseInt(getComputedStyle(el.page).getPropertyValue('--tree-w'), 10);
    setPref('filesTreeWidth', width || TREE_DEFAULT);
  };
  el.splitter.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    dragging = true;
    document.body.classList.add('is-resizing');
  });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  /* boot ------------------------------------------------------------ */
  await loadDir('.');
  local.selected = { path: '.', name: '工作区', is_dir: true };
  renderTree();
  renderDirPreview(local.selected);
  updateTargetLabel();

  return {
    destroy() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      local.previewAbort?.abort();
      root.innerHTML = '';
    },
  };
}

function layout() {
  return (
    '<div class="page files-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">文件</h1>' +
    '<p class="page-subtitle">工作区文件浏览 · 上传目标：<code id="files-target">.</code></p>' +
    '</div>' +
    '<div class="page-actions">' +
    `<button type="button" class="btn btn-ghost btn-sm" id="files-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="files-new-file">${icon('filePlus', { size: 15 })}<span>新建文件</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="files-new-folder">${icon('folderPlus', { size: 15 })}<span>新建文件夹</span></button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="files-upload">${icon('upload', { size: 15 })}<span>上传</span></button>` +
    '<input type="file" id="files-file-input" multiple hidden />' +
    '</div>' +
    '</header>' +
    '<div class="files-body">' +
    '<aside class="file-tree-panel">' +
    '<div class="tree-panel-head">' +
    `<span class="tree-panel-title">${icon('files', { size: 14 })}<span>工作区</span></span>` +
    '</div>' +
    '<div class="file-tree" id="file-tree" role="tree"></div>' +
    '</aside>' +
    '<div class="file-splitter" role="separator" aria-orientation="vertical" title="拖动调整宽度"></div>' +
    '<section class="file-preview" id="file-preview">' +
    '<nav class="file-crumb" id="files-crumb"></nav>' +
    '<header class="preview-head" id="preview-head"></header>' +
    '<div class="preview-body" id="preview-body"></div>' +
    '<div class="drop-overlay"><div class="drop-inner">' +
    `${icon('upload', { size: 28 })}<div class="drop-title">松开鼠标上传文件</div>` +
    '<div class="drop-hint">文件将上传到当前选中的目录</div>' +
    '</div></div>' +
    '</section>' +
    '</div>' +
    '</div>'
  );
}
