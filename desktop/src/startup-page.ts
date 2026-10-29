export type StartupState = {
  title: string;
  detail: string;
  failed?: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

const startupStyle = `
:root {
  color-scheme: light;
  --neutral-50: #f7f8fa;
  --neutral-130: #f0f2f5;
  --neutral-100: var(--neutral-130);
  --neutral-200: #e8ebef;
  --neutral-260: #d9dde3;
  --neutral-380: #a8b0bb;
  --neutral-480: #7f8895;
  --neutral-560: #666f7c;
  --neutral-680: #4b5563;
  --neutral-780: #343b45;
  --neutral-880: #242a32;
  --neutral-980: #171b21;
  --accent: #3157d5;
  --accent-hover: #2445b0;
  --accent-soft: rgba(49, 87, 213, 0.1);
  --danger: #dc2626;
  --danger-bg: #fff0f0;
  --danger-border: #f1caca;
  --surface: #ffffff;
  --panel: #f5f6fa;
  --border: #e0e5f0;
  --radius-lg: 20px;
  --radius-md: 12px;
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI Variable Text", "Segoe UI", "PingFang SC",
    "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  color: var(--neutral-980);
  background:
    radial-gradient(circle at 78% 8%, rgba(49, 87, 213, 0.09), transparent 32rem),
    linear-gradient(180deg, var(--neutral-50), var(--neutral-100));
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
.window-bar {
  height: 36px;
  -webkit-app-region: drag;
}
.shell {
  width: min(34rem, calc(100vw - 2.5rem));
  margin: clamp(2rem, 8vh, 5rem) auto 0;
  animation: enter 420ms var(--ease) both;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
}
.mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 13px;
  background: var(--neutral-980);
  color: #fff;
  font-size: 26px;
  font-weight: 620;
  letter-spacing: -0.08em;
  box-shadow: 0 8px 20px rgba(32, 32, 32, 0.16);
}
.brand-copy { display: grid; gap: 2px; }
.brand-name { font-size: 15px; font-weight: 650; letter-spacing: 0.01em; }
.brand-meta, .version {
  color: var(--neutral-480);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.card {
  padding: 28px;
  border: 1px solid var(--neutral-260);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 96%, transparent);
  box-shadow: 0 24px 70px -32px rgba(20, 30, 55, 0.32);
}
.status-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.status-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--accent);
  background: var(--accent-soft);
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(49, 87, 213, 0.22);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 850ms linear infinite;
}
.failure-mark { display: none; font-size: 20px; line-height: 1; }
h1 {
  margin: 1px 0 6px;
  font-size: 22px;
  line-height: 1.3;
  font-weight: 640;
  letter-spacing: -0.02em;
}
.detail {
  margin: 0;
  min-height: 42px;
  color: var(--neutral-680);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.progress {
  height: 3px;
  margin-top: 24px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--neutral-200);
}
.progress span {
  display: block;
  width: 38%;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  animation: progress 1.4s var(--ease) infinite;
}
.actions { display: none; margin-top: 22px; }
.retry {
  min-width: 112px;
  min-height: 40px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--radius-md);
  color: #fff;
  background: var(--accent);
  font: 600 13px/1 var(--font-sans);
  cursor: pointer;
  transition: background 160ms ease, transform 160ms ease;
}
.retry:hover { background: var(--accent-hover); }
.retry:active { transform: scale(0.985); }
.retry:focus-visible { outline: 3px solid rgba(49, 87, 213, 0.24); outline-offset: 2px; }
.footer {
  margin: 18px 0 0;
  color: var(--neutral-480);
  font-size: 11px;
  text-align: center;
}
.card[data-state="failed"] {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}
.card[data-state="failed"] .status-icon {
  color: var(--danger);
  background: rgba(158, 47, 47, 0.09);
}
.card[data-state="failed"] .spinner { display: none; }
.card[data-state="failed"] .failure-mark { display: block; }
.card[data-state="failed"] .progress { display: none; }
.card[data-state="failed"] .actions { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes enter {
  from { opacity: 0; transform: translateY(10px) scale(0.992); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes progress {
  0% { transform: translateX(-120%); }
  55% { transform: translateX(120%); }
  100% { transform: translateX(290%); }
}
@media (max-width: 520px) {
  .shell { margin-top: 2rem; width: calc(100vw - 1.5rem); }
  .card { padding: 22px; border-radius: 17px; }
  h1 { font-size: 20px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
`;

const startupScript = `
const card = document.getElementById('startup-card');
const title = document.getElementById('startup-title');
const detail = document.getElementById('startup-detail');
window.setEveStartupState = function (state) {
  card.dataset.state = state.failed ? 'failed' : 'working';
  title.textContent = state.title || '';
  detail.textContent = state.detail || '';
  card.setAttribute('aria-busy', state.failed ? 'false' : 'true');
};
document.getElementById('startup-retry')?.addEventListener('click', () => {
  if (window.suwenDesktop?.retryStartup) window.suwenDesktop.retryStartup();
});
window.setEveStartupState(window.__eveStartupInitial || {});
`;

export function startupPage(version: string, state: StartupState): string {
  const safeState: StartupState = {
    title: state.title || '正在准备 Eve',
    detail: state.detail || '',
    failed: Boolean(state.failed),
  };
  const initial = scriptJson(safeState);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Eve</title>
  <style>${startupStyle}</style>
</head>
<body>
  <div class="window-bar"></div>
  <main class="shell">
    <header class="brand">
      <div class="mark" aria-hidden="true">E</div>
      <div class="brand-copy">
        <div class="brand-name">Eve</div>
        <div class="brand-meta">科研工作台</div>
      </div>
      <span class="version" style="margin-left:auto">${escapeHtml(version)}</span>
    </header>
    <section class="card" id="startup-card" role="status" aria-live="polite">
      <div class="status-row">
        <div class="status-icon" aria-hidden="true">
          <span class="spinner"></span>
          <span class="failure-mark">!</span>
        </div>
        <div>
          <h1 id="startup-title">${escapeHtml(safeState.title)}</h1>
          <p class="detail" id="startup-detail">${escapeHtml(safeState.detail)}</p>
        </div>
      </div>
      <div class="progress" aria-hidden="true"><span></span></div>
      <div class="actions">
        <button class="retry" id="startup-retry" type="button">重试启动</button>
      </div>
    </section>
    <p class="footer">本地运行 · 数据保留在当前账户</p>
  </main>
  <script>window.__eveStartupInitial=${initial};${startupScript}</script>
</body>
</html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

export function startupStateScript(state: StartupState): string {
  return `window.setEveStartupState?.(${scriptJson(state)})`;
}
