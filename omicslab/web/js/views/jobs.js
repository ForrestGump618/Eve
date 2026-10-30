// Background jobs view: submit python/shell tasks, watch incremental logs, cancel.

import { icon } from '../icons.js?v=1.0.0';
import { esc, fmtBytes, relTime, fmtTime, fmtDuration, uid } from '../util.js?v=1.0.0';
import { api, errorMessage } from '../api.js?v=1.0.0';
import {
  toastSuccess,
  toastError,
  toastInfo,
  confirmDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.0.0';

const LOG_POLL_MS = 1500;
const LIST_POLL_MS = 5000;

const STATUS_META = {
  queued: { label: '排队中', cls: 'is-queued' },
  pending: { label: '排队中', cls: 'is-queued' },
  running: { label: '运行中', cls: 'is-running' },
  succeeded: { label: '已完成', cls: 'is-ok' },
  success: { label: '已完成', cls: 'is-ok' },
  failed: { label: '失败', cls: 'is-fail' },
  error: { label: '失败', cls: 'is-fail' },
  cancelled: { label: '已取消', cls: 'is-cancelled' },
  canceled: { label: '已取消', cls: 'is-cancelled' },
  timeout: { label: '超时', cls: 'is-fail' },
};

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    form: root.querySelector('#job-form'),
    kind: root.querySelector('#job-kind'),
    name: root.querySelector('#job-name'),
    code: root.querySelector('#job-code'),
    submit: root.querySelector('#job-submit'),
    list: root.querySelector('#jobs-list'),
    count: root.querySelector('#jobs-count'),
    refresh: root.querySelector('#jobs-refresh'),
    codeHint: root.querySelector('#job-code-hint'),
  };

  const local = {
    jobs: [],
    kind: 'python',
    expanded: null, // job id
    logs: new Map(), // id -> {offset, text, eof, timer, error}
    listTimer: 0,
    loading: false,
  };

  /* ---------------------------------------------------------------- */
  /* Submit form                                                       */
  /* ---------------------------------------------------------------- */

  const PLACEHOLDERS = {
    python:
      '# 在后台内核外运行，适合长时间任务\nimport time\nfor i in range(5):\n    print(f"step {i}")\n    time.sleep(1)\nprint("done")',
    shell: '# 运行 shell 命令，例如：\npython scripts/train.py --epochs 10 2>&1',
  };

  function setKind(kind) {
    local.kind = kind;
    el.kind.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.kind === kind);
    });
    el.code.placeholder = PLACEHOLDERS[kind];
    el.codeHint.textContent =
      kind === 'python'
        ? 'Python 代码以后台进程运行，输出会实时写入日志。'
        : 'Shell 命令以 /bin/sh 或 cmd.exe 执行，输出会写入日志。';
  }

  el.kind.addEventListener('click', (evt) => {
    const btn = evt.target.closest('.seg-btn');
    if (btn) setKind(btn.dataset.kind);
  });

  el.form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const code = el.code.value.trim();
    if (!code) {
      toastInfo('请填写要执行的代码');
      el.code.focus();
      return;
    }
    const name = el.name.value.trim() || `任务 ${new Date().toLocaleTimeString('zh-CN')}`;
    el.submit.disabled = true;
    el.submit.classList.add('is-loading');
    try {
      const created = await api.jobs.create({ kind: local.kind, code, name });
      const job = created?.job || created;
      toastSuccess('任务已提交');
      el.name.value = '';
      el.code.value = '';
      await loadJobs();
      if (job?.id) {
        local.jobs.unshift(job);
        renderJobs();
        toggleLog(job.id);
      }
    } catch (err) {
      toastError(`提交失败：${errorMessage(err)}`);
    } finally {
      el.submit.disabled = false;
      el.submit.classList.remove('is-loading');
    }
  });

  /* ---------------------------------------------------------------- */
  /* List                                                              */
  /* ---------------------------------------------------------------- */

  function statusMeta(status) {
    const key = String(status || '').toLowerCase();
    return STATUS_META[key] || { label: status || '未知', cls: 'is-unknown' };
  }

  function sortedJobs() {
    return [...local.jobs].sort((a, b) => {
      const ta = timeOf(b.started_at) || timeOf(b.created_at);
      const tb = timeOf(a.started_at) || timeOf(a.created_at);
      return ta - tb;
    });
  }

  function timeOf(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : 0;
  }

  function renderJobs() {
    el.count.textContent = `${local.jobs.length} 个任务`;
    const jobs = sortedJobs();
    if (!jobs.length) {
      el.list.innerHTML = emptyStateHtml({
        iconName: 'jobs',
        title: '还没有后台任务',
        hint: '在左侧提交 Python 脚本或 Shell 命令，任务会在后台运行并可实时查看日志。',
      });
      return;
    }
    el.list.innerHTML = jobs
      .map((job) => {
        const meta = statusMeta(job.status);
        const expanded = local.expanded === job.id;
        const started = job.started_at ? fmtTime(job.started_at) : '—';
        const ended = job.ended_at ? fmtTime(job.ended_at) : '';
        const running = ['running', 'queued', 'pending'].includes(String(job.status || '').toLowerCase());
        return (
          `<div class="job-item${expanded ? ' is-expanded' : ''}" data-id="${esc(job.id)}">` +
          '<div class="job-head" role="button" tabindex="0">' +
          `<span class="job-status-dot ${meta.cls}"></span>` +
          '<div class="job-main">' +
          `<div class="job-title-row"><span class="job-name">${esc(job.name || job.id)}</span>` +
          `<span class="kind-chip">${esc(job.kind || 'python')}</span>` +
          `<span class="status-chip ${meta.cls}"><span class="status-dot"></span>${esc(meta.label)}</span>` +
          (job.exit_code != null ? `<span class="exit-chip ${job.exit_code === 0 ? 'ok' : 'fail'}">exit ${esc(job.exit_code)}</span>` : '') +
          '</div>' +
          `<div class="job-meta"><span>${esc(job.id)}</span><span>开始：${esc(started)}</span>` +
          (ended ? `<span>结束：${esc(ended)}</span>` : '') +
          (running ? '<span class="job-running-label">运行中…</span>' : '') +
          '</div>' +
          '</div>' +
          '<div class="job-actions">' +
          `<span class="job-log-size">${job.log_bytes != null ? fmtBytes(job.log_bytes) : ''}</span>` +
          (running
            ? `<button type="button" class="btn btn-ghost btn-sm job-cancel">${icon('stop', { size: 14 })}<span>取消</span></button>`
            : '') +
          `<button type="button" class="icon-btn job-log-toggle" title="${expanded ? '收起日志' : '查看日志'}" aria-label="查看日志">${icon(expanded ? 'chevronUp' : 'chevronDown', { size: 16 })}</button>` +
          '</div></div>' +
          `<div class="job-log-panel"${expanded ? '' : ' hidden'}>` +
          '<div class="job-log-head">' +
          `<span class="job-log-title">${icon('terminal', { size: 14 })}<span>实时日志</span></span>` +
          '<span class="job-log-actions">' +
          '<label class="switch-label"><input type="checkbox" class="job-autoscroll" checked /><span>自动滚动</span></label>' +
          `<button type="button" class="btn btn-ghost btn-sm job-log-clear">清空显示</button>` +
          '</span></div>' +
          `<pre class="job-log" data-id="${esc(job.id)}">${esc(logTextFor(job.id) || '等待日志输出…')}</pre>` +
          '</div></div>'
        );
      })
      .join('');
  }

  function logTextFor(id) {
    const rec = local.logs.get(id);
    return rec ? rec.text : '';
  }

  async function loadJobs({ quiet = false } = {}) {
    if (local.loading) return;
    local.loading = true;
    if (!quiet) el.refresh.classList.add('is-spinning');
    try {
      const data = await api.jobs.list();
      local.jobs = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      renderJobs();
    } catch (err) {
      if (!quiet) {
        el.list.innerHTML =
          `<div class="panel-error"><div class="error-card"><div class="error-card-head">` +
          `<span class="error-card-icon">${icon('alert', { size: 16 })}</span>` +
          '<div class="error-card-title">无法读取任务列表</div></div>' +
          `<div class="error-card-msg">${esc(errorMessage(err))}</div>` +
          '<div class="error-card-actions"><button type="button" class="btn btn-primary btn-sm" id="jobs-retry">重试</button></div></div></div>';
        el.list.querySelector('#jobs-retry')?.addEventListener('click', () => loadJobs());
      }
    } finally {
      local.loading = false;
      el.refresh.classList.remove('is-spinning');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Log polling                                                       */
  /* ---------------------------------------------------------------- */

  function stopLogPoll(id) {
    const rec = local.logs.get(id);
    if (rec?.timer) {
      clearTimeout(rec.timer);
      rec.timer = 0;
    }
  }

  function stopAllLogPolls() {
    for (const [id, rec] of local.logs.entries()) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = 0;
    }
  }

  function logPanel(id) {
    return el.list.querySelector(`.job-log[data-id="${cssEsc(id)}"]`);
  }

  function appendLog(id, text) {
    const pre = logPanel(id);
    const rec = local.logs.get(id);
    if (!rec) return;
    if (!pre) {
      rec.text += text;
      return;
    }
    const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
    if (pre.textContent === '等待日志输出…') pre.textContent = '';
    pre.textContent += text;
    rec.text = pre.textContent;
    const auto = el.list.querySelector(`.job-item[data-id="${cssEsc(id)}"] .job-autoscroll`);
    if (!auto || auto.checked) {
      if (wasAtBottom || pre.scrollTop === 0) pre.scrollTop = pre.scrollHeight;
    }
  }

  function scheduleLogPoll(id, delay = 0) {
    const rec = local.logs.get(id);
    if (!rec || rec.eof) return;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(() => pollLog(id), delay);
  }

  async function pollLog(id) {
    const rec = local.logs.get(id);
    if (!rec || rec.eof) return;
    if (!document.body.contains(el.list)) return; // view destroyed
    const job = local.jobs.find((j) => j.id === id);
    const running = !job || ['running', 'queued', 'pending'].includes(String(job.status || '').toLowerCase());
    try {
      const data = await api.jobs.log(id, rec.offset);
      if (typeof data?.text === 'string' && data.text) appendLog(id, data.text);
      rec.offset = Number(data?.next_offset ?? rec.offset) || rec.offset;
      rec.eof = Boolean(data?.eof) || !running;
      if (rec.eof) {
        rec.timer = 0;
        renderJobs();
        // refresh once so the final status is accurate
        loadJobs({ quiet: true });
      } else {
        scheduleLogPoll(id, LOG_POLL_MS);
      }
    } catch (err) {
      rec.timer = 0;
      const pre = logPanel(id);
      if (pre) {
        pre.textContent += `\n[日志读取失败] ${errorMessage(err)}\n`;
        rec.text = pre.textContent;
      }
      if (!rec.errorShown) {
        rec.errorShown = true;
        toastError(`读取日志失败：${errorMessage(err)}`);
      }
    }
  }

  async function toggleLog(id) {
    if (local.expanded === id) {
      stopLogPoll(id);
      local.expanded = null;
      renderJobs();
      return;
    }
    if (local.expanded) stopLogPoll(local.expanded);
    local.expanded = id;
    if (!local.logs.has(id)) local.logs.set(id, { offset: 0, text: '', eof: false, timer: 0 });
    renderJobs();
    const pre = logPanel(id);
    if (pre) pre.scrollTop = pre.scrollHeight;
    scheduleLogPoll(id, 60);
  }

  function cssEsc(value) {
    if (window.CSS && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\\]]/g, '\\$&');
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  el.list.addEventListener('click', async (evt) => {
    const item = evt.target.closest('.job-item');
    if (!item) return;
    const id = item.dataset.id;
    const cancelBtn = evt.target.closest('.job-cancel');
    if (cancelBtn) {
      evt.stopPropagation();
      const ok = await confirmDialog({
        title: '取消任务',
        message: '确定要取消这个后台任务吗？',
        confirmText: '取消任务',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.jobs.cancel(id);
        toastSuccess('已请求取消任务');
        local.logs.delete(id);
        await loadJobs();
        if (local.expanded === id) {
          local.expanded = null;
          renderJobs();
          toggleLog(id);
        }
      } catch (err) {
        toastError(`取消失败：${errorMessage(err)}`);
      }
      return;
    }
    const clearBtn = evt.target.closest('.job-log-clear');
    if (clearBtn) {
      evt.stopPropagation();
      const rec = local.logs.get(id);
      const pre = logPanel(id);
      if (rec) rec.text = '';
      if (pre) pre.textContent = '等待日志输出…';
      return;
    }
    const toggleBtn = evt.target.closest('.job-log-toggle');
    if (toggleBtn || evt.target.closest('.job-head')) {
      toggleLog(id);
    }
  });

  el.list.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const head = evt.target.closest('.job-head');
    if (!head) return;
    evt.preventDefault();
    const item = head.closest('.job-item');
    if (item) toggleLog(item.dataset.id);
  });

  el.refresh.addEventListener('click', () => loadJobs());

  /* boot ------------------------------------------------------------ */
  setKind('python');
  await loadJobs();
  local.listTimer = setInterval(() => {
    if (document.hidden) return;
    if (local.loading) return;
    const anyRunning = local.jobs.some((j) =>
      ['running', 'queued', 'pending'].includes(String(j.status || '').toLowerCase()),
    );
    if (anyRunning || local.expanded) loadJobs({ quiet: true });
    if (local.expanded) {
      const rec = local.logs.get(local.expanded);
      if (rec && !rec.eof && !rec.timer) scheduleLogPoll(local.expanded, 0);
    }
  }, LIST_POLL_MS);

  return {
    destroy() {
      clearInterval(local.listTimer);
      stopAllLogPolls();
      root.innerHTML = '';
    },
  };
}

function layout() {
  return (
    '<div class="page jobs-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">后台任务</h1>' +
    '<p class="page-subtitle">在独立进程中运行长时间脚本，实时查看增量日志</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="toolbar-meta" id="jobs-count"></span>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="jobs-refresh">${icon('refresh', { size: 15 })}<span>刷新</span></button>` +
    '</div>' +
    '</header>' +
    '<div class="jobs-layout">' +
    '<section class="card job-form-card">' +
    '<div class="card-head"><h2 class="card-title">提交任务</h2></div>' +
    '<form id="job-form" class="job-form">' +
    '<div class="field">' +
    '<span class="field-label">运行类型</span>' +
    '<div class="segmented" id="job-kind">' +
    `<button type="button" class="seg-btn is-active" data-kind="python">${icon('code', { size: 14 })}<span>Python</span></button>` +
    `<button type="button" class="seg-btn" data-kind="shell">${icon('terminal', { size: 14 })}<span>Shell</span></button>` +
    '</div></div>' +
    '<label class="field"><span class="field-label">任务名称（可选）</span>' +
    '<input class="input" id="job-name" type="text" placeholder="例如 训练模型" /></label>' +
    '<label class="field"><span class="field-label">代码</span>' +
    '<textarea class="input code-input" id="job-code" rows="10" spellcheck="false"></textarea>' +
    '<span class="field-hint" id="job-code-hint"></span></label>' +
    `<button type="submit" class="btn btn-primary btn-block" id="job-submit">${icon('play', { size: 15 })}<span>提交并在后台运行</span></button>` +
    '</form></section>' +
    '<section class="card jobs-list-card">' +
    '<div class="card-head"><h2 class="card-title">任务列表</h2>' +
    '<span class="card-sub">点击任务展开实时日志</span></div>' +
    '<div class="jobs-list" id="jobs-list"></div>' +
    '</section>' +
    '</div></div>'
  );
}

void uid;
void fmtDuration;
