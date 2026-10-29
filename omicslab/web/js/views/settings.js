// Settings view: LLM provider/model/key, vision model, generation params,
// approval policy, theme, workspace and health information.
//
// Provider metadata is NEVER hardcoded here: everything comes from
// GET /api/settings (§3.1 of CONTRACTS-2.md) so new providers (火山方舟, Ollama,
// 自定义 OpenAI 兼容端点 …) show up without a frontend release. Saving a key
// atomically persists provider/model/api_base and immediately runs a live
// test_llm call, which is what makes "配置 API 后无效" impossible to hit again.

import { icon } from '../icons.js?v=1.2.0';
import { esc, fmtDuration, copyText, clamp } from '../util.js?v=1.2.0';
import { api, errorMessage } from '../api.js?v=1.2.0';
import {
  toastSuccess,
  toastError,
  toastInfo,
  spinnerHtml,
  currentTheme,
  applyTheme,
} from '../ui.js?v=1.2.0';
import { setState } from '../store.js?v=1.2.0';
import { emit } from '../bus.js?v=1.2.0';

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;
const VISION_MODEL_SUGGESTIONS = [
  'gpt-4o-mini',
  'gpt-4o',
  'qwen-vl-plus',
  'qwen-vl-max',
  'gemini-2.0-flash',
  'glm-4v-flash',
  'claude-3-5-sonnet-latest',
];

/** Drop empty optional strings so the backend falls back to saved values. */
function compact(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  return out;
}

/** Normalise the provider catalog (object map or legacy array) into {map, order}. */
function normalizeProviders(raw) {
  const map = {};
  const order = [];
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw.map((item) => [item && (item.id || item.provider || item.name), item]);
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw);
  }
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const id = String(value.id || key || '').trim();
    if (!id) continue;
    const models = Array.isArray(value.models)
      ? value.models.map((m) => String(m)).filter(Boolean)
      : [];
    map[id] = {
      id,
      label: value.label || value.name || id,
      family: value.family || '',
      api_base: value.api_base || value.base_url || '',
      default_model: value.default_model || '',
      models,
      env_key: value.env_key || '',
      has_key: Boolean(value.has_key),
      configured: Boolean(value.configured),
      no_key_required: Boolean(value.no_key_required),
      needs_api_base: Boolean(value.needs_api_base),
      needs_model: Boolean(value.needs_model),
      hint: value.hint || '',
    };
    order.push(id);
  }
  return { map, order };
}

export async function mount(root, ctx = {}) {
  root.innerHTML = layout();
  const el = {
    form: root.querySelector('#settings-form'),
    pageStatus: root.querySelector('#settings-status'),
    save: root.querySelector('#settings-save'),
    errorBar: root.querySelector('#llm-error-bar'),

    provider: root.querySelector('#set-provider'),
    providerStatus: root.querySelector('#set-provider-status'),
    providerHint: root.querySelector('#set-provider-hint'),
    model: root.querySelector('#set-model'),
    modelList: root.querySelector('#set-model-list'),
    modelHint: root.querySelector('#set-model-hint'),
    apiBase: root.querySelector('#set-api-base'),
    apiBaseHint: root.querySelector('#set-api-base-hint'),
    apiKey: root.querySelector('#set-api-key'),
    keyHint: root.querySelector('#set-key-hint'),
    keyState: root.querySelector('#set-key-state'),
    saveKey: root.querySelector('#set-save-key'),
    test: root.querySelector('#settings-test'),
    testResult: root.querySelector('#test-result'),

    visionEnabled: root.querySelector('#vision-enabled'),
    visionModel: root.querySelector('#vision-model'),
    visionModelList: root.querySelector('#vision-model-list'),
    visionBase: root.querySelector('#vision-base'),
    visionKey: root.querySelector('#vision-key'),
    visionState: root.querySelector('#vision-state'),
    visionHint: root.querySelector('#vision-hint'),
    visionError: root.querySelector('#vision-error'),
    visionSave: root.querySelector('#vision-save'),
    visionTest: root.querySelector('#vision-test'),
    visionResult: root.querySelector('#vision-result'),

    temperature: root.querySelector('#set-temperature'),
    temperatureVal: root.querySelector('#set-temperature-val'),
    maxTokens: root.querySelector('#set-max-tokens'),
    policy: root.querySelector('#set-policy'),
    theme: root.querySelector('#set-theme'),
    health: root.querySelector('#settings-health'),
    healthRefresh: root.querySelector('#health-refresh'),
    system: root.querySelector('#settings-system'),
  };

  const local = {
    providers: {},
    order: [],
    llm: {},
    vision: {},
    settings: {},
    health: null,
    system: null,
    loading: true,
    busy: { save: false, test: false, settings: false, vision: false, visionTest: false },
  };

  /* ---------------------------------------------------------------- */
  /* Provider helpers                                                  */
  /* ---------------------------------------------------------------- */

  function currentProvider() {
    const id = el.provider.value;
    return local.providers[id] || null;
  }

  function providerIds() {
    return local.order.filter((id) => local.providers[id]);
  }

  function modelOptions() {
    const provider = currentProvider();
    const seen = new Set();
    const models = [];
    const push = (value, label = '') => {
      const id = String(value || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({ id, label: label || id });
    };
    if (provider) {
      push(provider.default_model, provider.default_model ? `${provider.default_model}（默认）` : '');
      provider.models.forEach((m) => push(m));
    }
    const saved = String(local.settings?.model || '').trim();
    if (saved) push(saved, `${saved}（已保存）`);
    const current = String(local.llm?.model || '').trim();
    if (current) push(current, `${current}（当前）`);
    return models;
  }

  function renderModelOptions() {
    el.modelList.innerHTML = modelOptions()
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
      .join('');
  }

  function renderProviderStatus() {
    const provider = currentProvider();
    const chips = [];
    if (provider) {
      const kind = provider.configured ? 'is-ok' : provider.no_key_required ? 'is-ok' : 'is-warn';
      const text = provider.configured ? '已配置' : provider.no_key_required ? '无需 Key' : '待配置';
      chips.push(`<span class="status-chip ${kind}"><span class="status-dot"></span>${esc(text)}</span>`);
      if (provider.family) chips.push(`<span class="tag tag-cyan">${esc(provider.family)}</span>`);
      if (provider.env_key) {
        chips.push(`<span class="tag" title="API Key 保存位置">${esc(provider.env_key)}</span>`);
      }
      if (provider.has_key) chips.push('<span class="tag tag-purple">Key 已保存</span>');
    } else {
      chips.push('<span class="status-chip is-off"><span class="status-dot"></span>自动检测</span>');
    }
    el.providerStatus.innerHTML = chips.join('');
  }

  function renderProviderHint() {
    const provider = currentProvider();
    const bits = [];
    if (!provider) {
      bits.push(
        '未指定 Provider 时，后端会根据已保存的 API Key / 模型名自动推断供应商。若推断失败，请显式选择 Provider。',
      );
    } else {
      if (provider.hint) bits.push(provider.hint);
      if (provider.needs_model && !provider.default_model) {
        bits.push('该 Provider 需要手动填写模型名（或接入点 ID），不能留空。');
      }
      if (provider.needs_api_base) bits.push('该 Provider 需要填写 API 地址。');
      if (provider.no_key_required) bits.push('该 Provider 不需要 API Key。');
      if (!bits.length) bits.push('该 Provider 使用官方默认地址；如需代理或私有部署可覆盖 API Base。');
    }
    el.providerHint.textContent = bits.join(' ');

    // Model hint
    const modelBits = [];
    if (provider && provider.needs_model && !provider.default_model) {
      modelBits.push('必填：例如火山方舟的 ep-2024… 推理接入点，或供应商的模型 ID。');
    } else if (provider && provider.models.length) {
      modelBits.push(`推荐：${provider.models.slice(0, 4).join(' / ')}`);
    } else {
      modelBits.push('留空则使用 Provider 的默认模型。');
    }
    el.modelHint.textContent = modelBits.join(' ');

    // API base hint
    const base = provider?.api_base || '';
    el.apiBase.placeholder = base || '例如 https://api.example.com/v1';
    el.apiBaseHint.textContent = provider?.needs_api_base
      ? '必填：自定义端点必须提供 OpenAI 兼容的 /v1 地址。'
      : base
        ? `留空使用默认地址：${base}`
        : '可选：留空使用 Provider 默认地址。';
  }

  function renderKeyHints() {
    const provider = currentProvider();
    const hasKey = provider ? provider.has_key : Boolean(local.llm?.has_key);
    const noKey = Boolean(provider?.no_key_required);
    el.apiKey.disabled = noKey;
    el.apiKey.placeholder = noKey
      ? '该 Provider 无需 API Key'
      : hasKey
        ? '已保存，留空则保持不变'
        : '粘贴 API Key（仅保存在本机后端）';
    el.keyHint.textContent = provider?.env_key
      ? `保存位置：环境变量 ${provider.env_key}（留空不会覆盖已保存的 Key）`
      : 'Key 会按所选 Provider 约定的环境变量保存';
    el.keyState.className = `status-chip ${hasKey || noKey ? 'is-ok' : 'is-warn'}`;
    el.keyState.innerHTML = `<span class="status-dot"></span>${hasKey ? 'Key 已配置' : noKey ? '无需 Key' : 'Key 未配置'}`;
    el.saveKey.disabled = Boolean(local.busy.save);
  }

  /**
   * Render the red banner when the backend reports that the active LLM target
   * cannot be used (missing key / wrong base / unknown provider …).
   */
  function renderLlmErrorBar() {
    const err = local.llm?.error;
    if (!err) {
      el.errorBar.hidden = true;
      el.errorBar.innerHTML = '';
      return;
    }
    el.errorBar.hidden = false;
    el.errorBar.innerHTML =
      '<div class="settings-alert is-error">' +
      icon('alert', { size: 16, cls: 'settings-alert-icon' }) +
      '<div class="settings-alert-body">' +
      '<div class="settings-alert-title">当前模型配置不可用</div>' +
      `<div class="settings-alert-msg">${esc(String(err))}</div>` +
      '<div class="settings-alert-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" id="llm-fix-provider">检查 Provider 配置</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="llm-fix-test">测试连接</button>' +
      '</div></div></div>';
    el.errorBar.querySelector('#llm-fix-provider')?.addEventListener('click', () => {
      el.provider.focus();
      el.provider.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    el.errorBar.querySelector('#llm-fix-test')?.addEventListener('click', () => runTest());
  }

  /* ---------------------------------------------------------------- */
  /* Form filling                                                      */
  /* ---------------------------------------------------------------- */

  function fillForm() {
    const preferred = String(local.settings?.provider || local.llm?.provider || 'auto');
    const options = ['<option value="auto">自动检测（根据 API Key 推断）</option>'];
    for (const id of providerIds()) {
      const provider = local.providers[id];
      const suffix = provider.configured ? ' · 已配置' : '';
      options.push(`<option value="${esc(id)}">${esc(provider.label)}${suffix}</option>`);
    }
    if (preferred && preferred !== 'auto' && !local.providers[preferred]) {
      options.push(`<option value="${esc(preferred)}">${esc(preferred)}（当前已保存）</option>`);
    }
    el.provider.innerHTML = options.join('');
    el.provider.value = preferred;
    if (el.provider.value !== preferred) el.provider.value = 'auto';

    const provider = currentProvider();
    const savedModel = String(local.settings?.model || '').trim();
    const liveModel = String(local.llm?.model || '').trim();
    if (savedModel) el.model.value = savedModel;
    else if (liveModel) el.model.value = liveModel;
    else el.model.value = provider?.default_model || '';
    el.model.placeholder = provider?.needs_model && !provider.default_model ? '必填，例如 ep-2024…' : '例如 deepseek-chat';

    const savedBase = String(local.settings?.api_base || '').trim();
    el.apiBase.value = savedBase || (provider ? provider.api_base : '');

    const temperature = local.settings?.temperature;
    const temp = Number.isFinite(Number(temperature)) ? clamp(Number(temperature), 0, 2) : DEFAULT_TEMPERATURE;
    el.temperature.value = String(temp);
    el.temperatureVal.textContent = String(temp);

    const maxTokens = Number(local.settings?.max_tokens);
    el.maxTokens.value = String(Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS);

    const policy = local.settings?.approval_policy || 'ask';
    el.policy.querySelectorAll('input[name="policy"]').forEach((input) => {
      input.checked = input.value === policy;
    });
    el.theme.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.theme === currentTheme());
    });

    renderModelOptions();
    renderProviderStatus();
    renderProviderHint();
    renderKeyHints();
  }

  /* ---------------------------------------------------------------- */
  /* Vision card                                                       */
  /* ---------------------------------------------------------------- */

  function renderVision() {
    const vision = local.vision || {};
    const enabled = Boolean(vision.enabled);
    const configured = Boolean(vision.configured);
    el.visionEnabled.checked = enabled;
    el.visionModel.value = String(vision.model || '');
    el.visionBase.value = String(vision.base_url || '');
    el.visionModel.placeholder = '例如 gpt-4o-mini / qwen-vl-plus';
    el.visionBase.placeholder = '留空默认 https://api.openai.com/v1';
    el.visionKey.placeholder = vision.has_key ? '已保存，留空则保持不变' : '粘贴视觉模型 API Key';
    el.visionModelList.innerHTML = VISION_MODEL_SUGGESTIONS.map(
      (m) => `<option value="${esc(m)}"></option>`,
    ).join('');
    el.visionState.className = `status-chip ${configured ? 'is-ok' : enabled ? 'is-warn' : 'is-off'}`;
    el.visionState.innerHTML = `<span class="status-dot"></span>${
      configured ? '视觉已启用' : enabled ? '视觉未就绪' : '视觉已关闭'
    }`;
    if (vision.error) {
      el.visionError.hidden = false;
      el.visionError.innerHTML = `${icon('alert', { size: 15 })}<span>${esc(String(vision.error))}</span>`;
    } else {
      el.visionError.hidden = true;
      el.visionError.innerHTML = '';
    }
    el.visionHint.textContent = configured
      ? `当前视觉模型：${vision.model}${vision.base_url ? ` · ${vision.base_url}` : ''}。聊天中的图片会自动解读。`
      : '启用后，聊天中发送的图片会先由视觉模型解读，再交给智能体分析。';
  }

  function renderVisionResult({ loading, ok, reply, latency, error, model } = {}) {
    if (loading) {
      el.visionResult.innerHTML = `<div class="test-loading">${spinnerHtml('正在测试视觉模型…')}</div>`;
      return;
    }
    if (ok) {
      el.visionResult.innerHTML =
        `<div class="test-result is-ok">${icon('checkCircle', { size: 16 })}` +
        '<div class="test-result-body">' +
        `<div class="test-result-title">视觉模型连接成功 · ${esc(String(model || ''))} · 延迟 ${esc(fmtDuration(latency))}</div>` +
        (reply ? `<div class="test-result-reply">${esc(String(reply))}</div>` : '') +
        '</div></div>';
    } else {
      el.visionResult.innerHTML =
        `<div class="test-result is-fail">${icon('xCircle', { size: 16 })}` +
        '<div class="test-result-body">' +
        '<div class="test-result-title">视觉模型连接失败</div>' +
        `<div class="test-result-msg">${esc(String(error || '未知错误'))}</div>` +
        '<div class="test-result-hint">建议：确认视觉模型名称、Base URL 与 API Key 是否匹配。</div>' +
        '</div></div>';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Health / system                                                   */
  /* ---------------------------------------------------------------- */

  function renderHealth() {
    if (!local.health) {
      el.health.innerHTML =
        '<div class="health-offline">' +
        '<span class="health-dot offline"></span><span>后端未连接</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="health-retry">重试</button></div>';
      el.health.querySelector('#health-retry')?.addEventListener('click', () => loadHealth());
      return;
    }
    const h = local.health;
    const kernelRunning = Boolean(h.kernel?.running);
    const llmConfigured = Boolean(h.llm?.configured);
    el.health.innerHTML =
      '<div class="health-grid">' +
      `<div class="health-item"><span class="health-label">服务状态</span><span class="health-value ${h.ok ? 'ok' : 'warn'}">${h.ok ? '运行中' : '异常'}</span></div>` +
      `<div class="health-item"><span class="health-label">版本</span><span class="health-value">${esc(h.version || '—')}</span></div>` +
      `<div class="health-item"><span class="health-label">运行时长</span><span class="health-value">${esc(h.uptime_s != null ? fmtDuration(Number(h.uptime_s) * 1000) : '—')}</span></div>` +
      `<div class="health-item"><span class="health-label">内核</span><span class="health-value ${kernelRunning ? 'ok' : 'warn'}">${kernelRunning ? '运行中' : '未启动'}</span></div>` +
      `<div class="health-item"><span class="health-label">LLM</span><span class="health-value ${llmConfigured ? 'ok' : 'warn'}">${llmConfigured ? '已配置' : '未配置'}${h.llm?.provider ? ` · ${esc(h.llm.provider)}` : ''}</span></div>` +
      `<div class="health-item"><span class="health-label">视觉</span><span class="health-value ${h.vision?.configured ? 'ok' : 'warn'}">${h.vision?.configured ? '已启用' : '未启用'}</span></div>` +
      '</div>' +
      '<div class="health-workspace">' +
      '<span class="health-label">工作区</span>' +
      `<code class="workspace-path" title="${esc(h.workspace || '')}">${esc(h.workspace || '—')}</code>` +
      `<button type="button" class="btn btn-ghost btn-sm" id="copy-workspace">${icon('copy', { size: 14 })}<span>复制</span></button>` +
      '</div>';
    el.health.querySelector('#copy-workspace')?.addEventListener('click', async () => {
      const ok = await copyText(h.workspace || '');
      if (ok) toastSuccess('工作区路径已复制');
      else toastError('复制失败');
    });
  }

  function renderSystem() {
    if (!local.system) {
      el.system.innerHTML = '<div class="muted">暂无系统信息</div>';
      return;
    }
    const s = local.system;
    const rows = [
      ['平台', s.platform || s.system],
      ['Python', s.python || s.python_version],
      ['工作目录', s.cwd || s.workspace],
      ['CPU', s.cpu_count != null ? `${s.cpu_count} 核` : ''],
      ['内存', s.memory || s.total_memory],
    ].filter(([, v]) => v != null && v !== '');
    el.system.innerHTML =
      '<div class="system-list">' +
      rows
        .map(
          ([k, v]) =>
            `<div class="system-row"><span class="system-key">${esc(k)}</span><span class="system-val" title="${esc(String(v))}">${esc(String(v))}</span></div>`,
        )
        .join('') +
      '</div>';
  }

  function setPageStatus(text, kind = '') {
    el.pageStatus.className = `status-chip ${kind}`.trim();
    el.pageStatus.innerHTML = `<span class="status-dot"></span>${esc(text)}`;
  }

  async function loadHealth() {
    try {
      local.health = await api.health();
      renderHealth();
      if (local.loading) setPageStatus('后端已连接', 'is-ok');
    } catch {
      local.health = null;
      renderHealth();
      setPageStatus('后端未连接', 'is-off');
    }
  }

  async function loadSystem() {
    try {
      local.system = await api.systemInfo();
      renderSystem();
    } catch {
      local.system = null;
      renderSystem();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Busy helpers                                                      */
  /* ---------------------------------------------------------------- */

  function busyButton(kind) {
    return {
      save: el.saveKey,
      test: el.test,
      settings: el.save,
      vision: el.visionSave,
      visionTest: el.visionTest,
    }[kind];
  }

  function setBusy(kind, value) {
    local.busy[kind] = value;
    const btn = busyButton(kind);
    if (!btn) return;
    btn.disabled = value;
    btn.classList.toggle('is-loading', value);
  }

  /* ---------------------------------------------------------------- */
  /* Data loading / saving                                             */
  /* ---------------------------------------------------------------- */

  function syncStore() {
    setState({
      settings: local.settings,
      providers: local.providers,
      llm: local.llm,
      vision: local.vision,
    });
    emit('llm:changed', {
      provider: local.llm?.provider || el.provider.value,
      model: local.llm?.model || el.model.value,
      configured: Boolean(local.llm?.configured),
      has_key: Boolean(local.llm?.has_key),
    });
  }

  function applySettingsPayload(data = {}, { fill = false } = {}) {
    if (data.settings) local.settings = data.settings;
    if (data.llm) local.llm = data.llm;
    if (data.vision) local.vision = data.vision;
    if (data.providers) {
      const normalized = normalizeProviders(data.providers);
      if (normalized.order.length) {
        local.providers = normalized.map;
        local.order = normalized.order;
      }
    }
    if (fill) {
      fillForm();
    } else {
      renderProviderStatus();
      renderProviderHint();
      renderKeyHints();
      renderModelOptions();
    }
    renderLlmErrorBar();
    renderVision();
    syncStore();
  }

  async function load() {
    local.loading = true;
    setPageStatus('加载设置…');
    el.form.classList.add('is-loading');
    try {
      const data = await api.settings.get();
      applySettingsPayload(data, { fill: true });
      setPageStatus('设置已加载', 'is-ok');
    } catch (err) {
      local.llm = {};
      local.settings = {};
      fillForm();
      renderLlmErrorBar();
      renderVision();
      setPageStatus('无法读取设置', 'is-off');
      toastError(`读取设置失败：${errorMessage(err)}`);
    } finally {
      local.loading = false;
      el.form.classList.remove('is-loading');
    }
    await Promise.all([loadHealth(), loadSystem()]);
  }

  function formSnapshot() {
    const providerId = el.provider.value;
    return {
      provider: providerId,
      meta: local.providers[providerId] || null,
      model: el.model.value.trim(),
      apiBase: el.apiBase.value.trim(),
      key: el.apiKey.value.trim(),
      temperature: clamp(Number(el.temperature.value) || 0, 0, 2),
      maxTokens: clamp(Number(el.maxTokens.value) || DEFAULT_MAX_TOKENS, 64, 200000),
      policy: el.policy.querySelector('input[name="policy"]:checked')?.value || 'ask',
    };
  }

  function renderTestResult({ loading, ok, reply, latency, error, provider, model } = {}) {
    if (loading) {
      el.testResult.innerHTML = `<div class="test-loading">${spinnerHtml('正在连接模型…')}</div>`;
      return;
    }
    if (ok) {
      el.testResult.innerHTML =
        `<div class="test-result is-ok">${icon('checkCircle', { size: 16 })}` +
        '<div class="test-result-body">' +
        `<div class="test-result-title">连接成功 · ${esc(String(provider || '—'))} / ${esc(String(model || '—'))} · 延迟 ${esc(fmtDuration(latency))}</div>` +
        (reply
          ? `<div class="test-result-reply">${esc(String(reply))}</div>`
          : '<div class="test-result-msg">模型未返回文本内容（可能只返回了空回复）</div>') +
        '</div></div>';
    } else {
      el.testResult.innerHTML =
        `<div class="test-result is-fail">${icon('xCircle', { size: 16 })}` +
        '<div class="test-result-body">' +
        '<div class="test-result-title">连接失败</div>' +
        `<div class="test-result-msg">${esc(String(error || '供应商返回错误'))}</div>` +
        '<div class="test-result-hint">建议：① 确认 API Key 未被空格/引号污染；② 确认 API Base 与模型名属于同一供应商；③ 火山方舟需填 ep-… 接入点或模型 ID。</div>' +
        '</div></div>';
    }
  }

  /** Live test using the values currently in the form (saved or not). */
  async function runTest({ silent = false } = {}) {
    if (local.busy.test) return;
    const snap = formSnapshot();
    setBusy('test', true);
    renderTestResult({ loading: true });
    const started = performance.now();
    try {
      const data = await api.settings.testLLM(
        compact({
          provider: snap.provider,
          model: snap.model,
          api_base: snap.apiBase,
          api_key: snap.key,
        }),
      );
      const latency =
        data?.latency_ms != null ? Number(data.latency_ms) : Math.round(performance.now() - started);
      if (data?.ok) {
        renderTestResult({
          ok: true,
          reply: data.reply,
          latency,
          provider: data.provider || snap.provider,
          model: data.model || snap.model,
        });
        if (!silent) toastSuccess(`连接成功（${fmtDuration(latency)}）`);
      } else {
        renderTestResult({ ok: false, error: data?.error || '供应商返回错误' });
        if (!silent) toastError(`连接失败：${data?.error || '未知错误'}`);
      }
    } catch (err) {
      renderTestResult({ ok: false, error: errorMessage(err) });
      if (!silent) toastError(`测试失败：${errorMessage(err)}`);
    } finally {
      setBusy('test', false);
    }
  }

  /** Save Key + provider + model + api_base atomically, then verify for real. */
  async function saveKeyAndTest() {
    if (local.busy.save) return;
    const snap = formSnapshot();
    if (snap.meta?.needs_model && !snap.model) {
      toastError('该 Provider 需要填写模型名（例如 ep-2024… 接入点 ID）');
      el.model.focus();
      return;
    }
    if (snap.meta?.needs_api_base && !snap.apiBase) {
      toastError('该 Provider 需要填写 API 地址（Base URL）');
      el.apiBase.focus();
      return;
    }
    if (snap.meta && !snap.meta.no_key_required && !snap.meta.has_key && !snap.key) {
      toastError('请先填写 API Key');
      el.apiKey.focus();
      return;
    }
    setBusy('save', true);
    try {
      const payload = compact({ provider: snap.provider, model: snap.model, api_base: snap.apiBase, key: snap.key });
      const data = await api.settings.saveKeys(payload);
      if (snap.key) el.apiKey.value = '';
      applySettingsPayload(data);
      toastSuccess('模型配置已保存，正在实测连接…');
      await runTest({ silent: true });
      await loadHealth();
    } catch (err) {
      toastError(`保存失败：${errorMessage(err)}`);
    } finally {
      setBusy('save', false);
      renderKeyHints();
    }
  }

  async function saveSettings() {
    if (local.busy.settings) return;
    const snap = formSnapshot();
    if (snap.provider !== 'auto' && !snap.model) {
      toastError('请填写模型名称');
      el.model.focus();
      return;
    }
    const patch = {
      provider: snap.provider,
      model: snap.model,
      temperature: snap.temperature,
      max_tokens: snap.maxTokens,
      approval_policy: snap.policy,
    };
    if (snap.apiBase) patch.api_base = snap.apiBase;
    setBusy('settings', true);
    try {
      const data = await api.settings.update(patch);
      applySettingsPayload(data || {});
      local.settings = { ...local.settings, ...patch };
      setPageStatus('设置已保存', 'is-ok');
      toastSuccess('设置已保存');
      await loadHealth();
    } catch (err) {
      toastError(`保存失败：${errorMessage(err)}`);
    } finally {
      setBusy('settings', false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Vision actions                                                    */
  /* ---------------------------------------------------------------- */

  async function saveVision() {
    if (local.busy.vision) return;
    const model = el.visionModel.value.trim();
    const baseUrl = el.visionBase.value.trim();
    const key = el.visionKey.value.trim();
    if (el.visionEnabled.checked && !model) {
      toastError('启用视觉模型前请填写模型名称');
      el.visionModel.focus();
      return;
    }
    setBusy('vision', true);
    try {
      const payload = compact({ enabled: el.visionEnabled.checked, model, base_url: baseUrl, api_key: key });
      const data = await api.settings.setVision(payload);
      if (data?.vision) local.vision = data.vision;
      if (key) el.visionKey.value = '';
      renderVision();
      syncStore();
      toastSuccess(el.visionEnabled.checked ? '视觉配置已保存' : '视觉能力已关闭');
    } catch (err) {
      toastError(`保存视觉配置失败：${errorMessage(err)}`);
    } finally {
      setBusy('vision', false);
    }
  }

  async function testVision() {
    if (local.busy.visionTest) return;
    const model = el.visionModel.value.trim();
    const baseUrl = el.visionBase.value.trim();
    const apiKey = el.visionKey.value.trim();
    setBusy('visionTest', true);
    renderVisionResult({ loading: true });
    const started = performance.now();
    try {
      const data = await api.settings.testVision(compact({ model, base_url: baseUrl, api_key: apiKey }));
      const latency =
        data?.latency_ms != null ? Number(data.latency_ms) : Math.round(performance.now() - started);
      if (data?.ok) {
        renderVisionResult({ ok: true, reply: data.reply, latency, model: data.model || model });
        toastSuccess(`视觉模型连接成功（${fmtDuration(latency)}）`);
      } else {
        renderVisionResult({ ok: false, error: data?.error || '视觉模型返回错误' });
      }
    } catch (err) {
      renderVisionResult({ ok: false, error: errorMessage(err) });
    } finally {
      setBusy('visionTest', false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  el.provider.addEventListener('change', () => {
    const provider = currentProvider();
    if (provider) {
      if (provider.api_base) el.apiBase.value = provider.api_base;
      if (provider.default_model) el.model.value = provider.default_model;
      else if (provider.models.length) el.model.value = provider.models[0];
      else if (provider.needs_model) el.model.value = '';
      if (provider.needs_model && !provider.default_model) el.model.focus();
    } else {
      el.apiBase.value = '';
    }
    renderModelOptions();
    renderProviderStatus();
    renderProviderHint();
    renderKeyHints();
  });

  el.model.addEventListener('input', () => {
    el.model.dataset.dirty = '1';
  });

  el.temperature.addEventListener('input', () => {
    el.temperatureVal.textContent = el.temperature.value;
  });

  el.maxTokens.addEventListener('change', () => {
    el.maxTokens.value = String(clamp(Number(el.maxTokens.value) || DEFAULT_MAX_TOKENS, 64, 200000));
  });

  el.save.addEventListener('click', (evt) => {
    evt.preventDefault();
    saveSettings();
  });
  el.form.addEventListener('submit', (evt) => {
    evt.preventDefault();
    saveSettings();
  });
  el.saveKey.addEventListener('click', (evt) => {
    evt.preventDefault();
    saveKeyAndTest();
  });
  el.apiKey.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      saveKeyAndTest();
    }
  });
  el.test.addEventListener('click', (evt) => {
    evt.preventDefault();
    runTest();
  });
  el.visionEnabled.addEventListener('change', () => {
    if (el.visionEnabled.checked && !local.vision?.configured) {
      toastInfo('启用后请填写视觉模型与 Key，并点击“保存视觉配置”。');
    }
  });
  el.visionSave.addEventListener('click', (evt) => {
    evt.preventDefault();
    saveVision();
  });
  el.visionTest.addEventListener('click', (evt) => {
    evt.preventDefault();
    testVision();
  });
  el.theme.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button[data-theme]');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    el.theme.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
  el.healthRefresh.addEventListener('click', async () => {
    el.healthRefresh.classList.add('is-spinning');
    await Promise.all([loadHealth(), loadSystem()]);
    el.healthRefresh.classList.remove('is-spinning');
  });

  await load();

  return {
    destroy() {
      root.innerHTML = '';
    },
  };
}

function layout() {
  const keyField =
    '<label class="field"><span class="field-label">API Key</span>' +
    '<div class="inline-field">' +
    '<input class="input" id="set-api-key" type="password" placeholder="粘贴 API Key（仅保存在本机后端）" autocomplete="off" />' +
    `<button type="button" class="btn btn-primary btn-sm" id="set-save-key">${icon('key', { size: 15 })}<span>保存并测试</span></button>` +
    '</div>' +
    '<span class="field-hint" id="set-key-hint">Key 会按所选 Provider 约定的环境变量保存</span></label>';

  return (
    '<div class="page settings-page">' +
    '<header class="page-head">' +
    '<div class="page-heading">' +
    '<h1 class="page-title">设置</h1>' +
    '<p class="page-subtitle">模型连接、视觉模型、生成参数、审批策略与系统信息</p>' +
    '</div>' +
    '<div class="page-actions">' +
    '<span class="status-chip" id="settings-status"><span class="status-dot"></span>加载中…</span>' +
    `<button type="button" class="btn btn-primary btn-sm" id="settings-save">${icon('save', { size: 15 })}<span>保存设置</span></button>` +
    '</div>' +
    '</header>' +
    '<div id="llm-error-bar" hidden></div>' +
    '<form id="settings-form" class="settings-grid">' +

    // ---- Provider / LLM card -------------------------------------
    '<section class="card settings-card settings-card-wide">' +
    '<div class="card-head"><h2 class="card-title">模型与供应商</h2>' +
    '<span class="status-chip" id="set-key-state"><span class="status-dot"></span>检查中…</span></div>' +
    '<div class="settings-body">' +
    '<div class="provider-row">' +
    '<label class="field field-grow"><span class="field-label">供应商</span>' +
    '<div class="select-wrap">' +
    `${icon('cpu', { size: 15 })}<select class="input" id="set-provider"></select>` +
    '</div></label>' +
    '<div class="provider-badges" id="set-provider-status"></div>' +
    '</div>' +
    '<span class="field-hint" id="set-provider-hint">供应商列表来自后端配置。</span>' +
    '<div class="field-grid">' +
    '<label class="field"><span class="field-label">模型</span>' +
    '<input class="input" id="set-model" list="set-model-list" placeholder="例如 deepseek-chat" autocomplete="off" />' +
    '<datalist id="set-model-list"></datalist>' +
    '<span class="field-hint" id="set-model-hint"></span></label>' +
    '<label class="field"><span class="field-label">API Base</span>' +
    '<input class="input" id="set-api-base" type="text" placeholder="默认使用供应商官方地址" autocomplete="off" />' +
    '<span class="field-hint" id="set-api-base-hint"></span></label>' +
    '</div>' +
    keyField +
    '<div class="inline-actions">' +
    `<button type="button" class="btn btn-ghost btn-sm" id="settings-test">${icon('play', { size: 14 })}<span>测试连接（不保存）</span></button>` +
    '<span class="field-hint">测试会真实发送一次极小请求，使用上方当前填写的值（含未保存的 Key）。</span>' +
    '</div>' +
    '<div id="test-result" class="test-result-wrap"></div>' +
    '</div></section>' +

    // ---- Vision card --------------------------------------------
    '<section class="card settings-card settings-card-wide">' +
    '<div class="card-head"><h2 class="card-title">视觉模型（图片理解）</h2>' +
    '<span class="status-chip" id="vision-state"><span class="status-dot"></span>检查中…</span></div>' +
    '<div class="settings-body">' +
    '<div class="provider-row">' +
    '<label class="switch-field">' +
    '<input type="checkbox" id="vision-enabled" />' +
    '<span class="switch-body"><span class="switch-title">启用视觉模型</span>' +
    '<span class="switch-hint">聊天中的图片会先由视觉模型解读，再交给智能体。</span></span></label>' +
    '</div>' +
    '<span class="field-hint" id="vision-hint"></span>' +
    '<div class="settings-alert is-error is-inline" id="vision-error" hidden></div>' +
    '<div class="field-grid">' +
    '<label class="field"><span class="field-label">视觉模型</span>' +
    '<input class="input" id="vision-model" list="vision-model-list" placeholder="例如 gpt-4o-mini" autocomplete="off" />' +
    '<datalist id="vision-model-list"></datalist></label>' +
    '<label class="field"><span class="field-label">Base URL</span>' +
    '<input class="input" id="vision-base" type="text" placeholder="留空默认 https://api.openai.com/v1" autocomplete="off" /></label>' +
    '</div>' +
    '<label class="field"><span class="field-label">视觉 API Key</span>' +
    '<input class="input" id="vision-key" type="password" placeholder="粘贴视觉模型 API Key" autocomplete="off" />' +
    '<span class="field-hint">留空则沿用已保存的视觉 Key（或环境变量 VISION_API_KEY）。</span></label>' +
    '<div class="inline-actions">' +
    `<button type="button" class="btn btn-primary btn-sm" id="vision-save">${icon('save', { size: 14 })}<span>保存视觉配置</span></button>` +
    `<button type="button" class="btn btn-ghost btn-sm" id="vision-test">${icon('play', { size: 14 })}<span>测试视觉</span></button>` +
    '</div>' +
    '<div id="vision-result" class="test-result-wrap"></div>' +
    '</div></section>' +

    // ---- Generation params -------------------------------------
    '<section class="card settings-card">' +
    '<div class="card-head"><h2 class="card-title">生成参数</h2></div>' +
    '<div class="settings-body">' +
    '<label class="field"><span class="field-label">温度 <span class="field-inline-val" id="set-temperature-val">0.3</span></span>' +
    '<input class="range" id="set-temperature" type="range" min="0" max="2" step="0.05" value="0.3" />' +
    '<span class="field-hint">越低越确定，越高越有创造性。代码与分析任务建议 0.1 – 0.4。</span></label>' +
    '<label class="field"><span class="field-label">最大 Token</span>' +
    '<input class="input" id="set-max-tokens" type="number" min="64" max="200000" step="256" value="4096" /></label>' +
    '</div></section>' +

    // ---- Approval policy ---------------------------------------
    '<section class="card settings-card">' +
    '<div class="card-head"><h2 class="card-title">工具审批策略</h2></div>' +
    '<div class="settings-body">' +
    '<div class="radio-group" id="set-policy">' +
    '<label class="radio-card"><input type="radio" name="policy" value="auto" /><span class="radio-body"><span class="radio-title">自动批准</span><span class="radio-hint">工具调用直接执行，适合可信的本地工作区。</span></span></label>' +
    '<label class="radio-card"><input type="radio" name="policy" value="ask" checked /><span class="radio-body"><span class="radio-title">每次询问</span><span class="radio-hint">执行敏感工具前在对话中请求你的批准（推荐）。</span></span></label>' +
    '</div></div></section>' +

    // ---- Appearance --------------------------------------------
    '<section class="card settings-card">' +
    '<div class="card-head"><h2 class="card-title">外观</h2></div>' +
    '<div class="settings-body">' +
    '<span class="field-label">主题</span>' +
    '<div class="segmented" id="set-theme">' +
    `<button type="button" class="seg-btn" data-theme="dark">${icon('moon', { size: 15 })}<span>深色</span></button>` +
    `<button type="button" class="seg-btn" data-theme="light">${icon('sun', { size: 15 })}<span>浅色</span></button>` +
    '</div>' +
    '<span class="field-hint">主题偏好保存在浏览器本地。</span>' +
    '</div></section>' +

    // ---- Health / system ---------------------------------------
    '<section class="card settings-card settings-card-wide">' +
    '<div class="card-head"><h2 class="card-title">工作区与健康状态</h2>' +
    `<button type="button" class="btn btn-ghost btn-sm" id="health-refresh">${icon('refresh', { size: 14 })}<span>刷新</span></button></div>` +
    '<div class="settings-body">' +
    '<div id="settings-health" class="health-panel"></div>' +
    '<div class="system-section"><h4>系统信息</h4><div id="settings-system"></div></div>' +
    '</div></section>' +

    '</form></div>'
  );
}
