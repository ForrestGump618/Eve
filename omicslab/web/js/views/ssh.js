// SSH 主机管理视图：档案列表、远程命令终端、SFTP 目录浏览与远端信息。
// 仅使用项目内置 API/UI 工具，无外部依赖；所有动态文本均经 esc() 转义。

import { setWorkspace, navigate } from '../store.js?v=1.4.0';
import { icon } from '../icons.js?v=1.4.0';
import { esc, fmtBytes, fmtDuration, relTime, copyText } from '../util.js?v=1.4.0';
import { api, errorMessage } from '../api.js?v=1.4.0';
import {
  toastSuccess,
  toastError,
  toastWarn,
  openModal,
  confirmDialog,
  emptyStateHtml,
  spinnerHtml,
} from '../ui.js?v=1.4.0';

const AUTH_PASSWORD = 'password';
const AUTH_KEY = 'key';
const DEFAULT_PORT = 22;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const TERMINAL_LIMIT = 500;
const DEFAULT_TAB = 'terminal';

let activeInstance = null;

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const sshApi = {
  listProfiles: () => api.request('/api/ssh/profiles'),
  createProfile: (body) => api.request('/api/ssh/profiles', { method: 'POST', body }),
  updateProfile: (id, body) =>
    api.request(`/api/ssh/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteProfile: (id) =>
    api.request(`/api/ssh/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testProfile: (id, password, remember=false) =>
    api.request(`/api/ssh/profiles/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: { ...(password ? {password} : {}), remember_password:remember },
      timeout: 60000,
    }),
  exec: (body, timeout) => api.request('/api/ssh/exec', { method: 'POST', body, timeout }),
  listDir: (profileId, path) =>
    api.request(
      `/api/ssh/ls?profile_id=${encodeURIComponent(profileId)}&path=${encodeURIComponent(path)}`,
      { timeout: 60000 }
    ),
  remoteInfo: (profileId) =>
    api.request(`/api/ssh/info?profile_id=${encodeURIComponent(profileId)}`, {
      timeout: 180000,
    }),
  upload: (form) =>
    api.request('/api/ssh/upload', { method: 'POST', body: form, timeout: 300000 }),
  downloadUrl: (profileId, remotePath) =>
    `/api/ssh/download?profile_id=${encodeURIComponent(profileId)}&remote_path=${encodeURIComponent(
      remotePath
    )}`,
};

/* ------------------------------------------------------------------ */
/* 纯工具函数                                                          */
/* ------------------------------------------------------------------ */

function joinRemote(dir, name) {
  const base = String(dir || '/').replace(/\/+$/, '');
  const leaf = String(name || '').replace(/^\/+/, '');
  return `${base || ''}/${leaf}` || '/';
}

function parentRemote(path) {
  const parts = String(path || '/')
    .split('/')
    .filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}

function authLabel(auth) {
  return auth === AUTH_KEY ? '密钥' : auth === 'agent' ? '系统 Agent' : '密码';
}

function profileStatus(profile) {
  if (!profile) return { kind: 'unknown', label: '未连接' };
  if (profile.last_error) return { kind: 'fail', label: '最近失败' };
  if (profile.auth === AUTH_PASSWORD && !profile.has_password_saved) return { kind: 'unknown', label: '需要重新输入密码' };
  if (profile.last_ok) return { kind: 'unknown', label: '曾连接成功 · 待检测' };
  return { kind: 'unknown', label: '尚未连接' };
}

function profileTarget(profile) {
  if (!profile) return '';
  return `${profile.username || ''}@${profile.host || ''}:${profile.port || DEFAULT_PORT}`;
}

function parseTags(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function downloadTo(profileId, remotePath) {
  const link = document.createElement('a');
  link.href = sshApi.downloadUrl(profileId, remotePath);
  link.download = String(remotePath).split('/').filter(Boolean).pop() || 'download';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ------------------------------------------------------------------ */
/* 视图主体                                                            */
/* ------------------------------------------------------------------ */

export async function mount(root, ctx = {}) {
  if (!root) throw new Error('SSH 视图缺少挂载节点');
  void ctx;
  const view = createView(root);
  activeInstance = view;
  await view.init();
  return {
    destroy() {
      view.destroy();
      if (activeInstance === view) activeInstance = null;
    },
  };
}

function createView(root) {
  const state = {
    loading: true,
    loadError: '',
    profiles: [],
    selectedId: '',
    tab: DEFAULT_TAB,
    command: '',
    timeoutS: DEFAULT_TIMEOUT_S,
    cwd: '',
    cmdBusy: false,
    logs: new Map(),
    fsPath: '/',
    fsEntries: [],
    fsLoading: false,
    fsOwnerId: '',
    info: null,
    infoLoading: false,
    infoOwnerId: '',
    testingId: '',
    lastTest: new Map(),
  };

  function selectedProfile() {
    return state.profiles.find((item) => item.id === state.selectedId) || null;
  }

  function logFor(profileId) {
    if (!state.logs.has(profileId)) state.logs.set(profileId, []);
    return state.logs.get(profileId);
  }

  function pushLog(profileId, entry) {
    const list = logFor(profileId);
    list.push({ ts: Date.now(), ...entry });
    while (list.length > TERMINAL_LIMIT) list.shift();
  }

  /* -- 数据加载 ---------------------------------------------------- */

  async function loadProfiles({ quiet = false } = {}) {
    if (!quiet) {
      state.loading = true;
      state.loadError = '';
      render();
    }
    try {
      const data = await sshApi.listProfiles();
      const list = data && Array.isArray(data.profiles) ? data.profiles : [];
      state.profiles = list;
      if (state.selectedId && !list.some((item) => item.id === state.selectedId)) {
        state.selectedId = '';
      }
      if (!state.selectedId && list.length) state.selectedId = list[0].id;
      state.loading = false;
      state.loadError = '';
    } catch (err) {
      state.loading = false;
      state.loadError = errorMessage(err);
      if (!quiet) toastError(state.loadError, { title: '读取 SSH 档案失败' });
    }
    render();
  }

  async function loadDir(path, { force = false } = {}) {
    const profile = selectedProfile();
    if (!profile) return;
    if (!force && state.fsOwnerId === profile.id && state.fsPath === path && state.fsEntries.length) {
      return;
    }
    state.fsLoading = true;
    state.fsPath = path || '/';
    state.fsOwnerId = profile.id;
    render();
    try {
      const data = await sshApi.listDir(profile.id, state.fsPath);
      state.fsPath = (data && data.path) || state.fsPath;
      state.fsEntries = data && Array.isArray(data.entries) ? data.entries : [];
    } catch (err) {
      state.fsEntries = [];
      toastError(errorMessage(err), { title: '读取远程目录失败' });
    } finally {
      state.fsLoading = false;
      render();
    }
  }

  async function loadInfo({ force = false } = {}) {
    const profile = selectedProfile();
    if (!profile) return;
    if (!force && state.infoOwnerId === profile.id && state.info) return;
    state.infoLoading = true;
    state.infoOwnerId = profile.id;
    render();
    try {
      state.info = await sshApi.remoteInfo(profile.id);
    } catch (err) {
      state.info = null;
      toastError(errorMessage(err), { title: '读取远端信息失败' });
    } finally {
      state.infoLoading = false;
      render();
    }
  }

  /* -- 交互动作 ---------------------------------------------------- */

  function selectProfile(profileId) {
    if (!profileId || profileId === state.selectedId) return;
    state.selectedId = profileId;
    state.command = '';
    state.cwd = '';
    state.tab = state.tab || DEFAULT_TAB;
    state.fsEntries = [];
    state.fsPath = '/';
    state.fsOwnerId = '';
    state.info = null;
    state.infoOwnerId = '';
    render();
    if (state.tab === 'files') void loadDir('/');
    if (state.tab === 'info') void loadInfo();
  }

  async function runCommand() {
    const profile = selectedProfile();
    if (!profile) {
      toastWarn('请先在左侧选择一个 SSH 档案');
      return;
    }
    const command = state.command.trim();
    if (!command) {
      toastWarn('请输入要执行的命令');
      return;
    }
    if (state.cmdBusy) return;
    const timeoutS = Math.min(
      MAX_TIMEOUT_S,
      Math.max(1, Number(state.timeoutS) || DEFAULT_TIMEOUT_S)
    );
    state.timeoutS = timeoutS;
    const profileId = profile.id;
    pushLog(profileId, {
      kind: 'cmd',
      text: command,
      cwd: state.cwd.trim(),
    });
    state.cmdBusy = true;
    render();
    try {
      const body = { profile_id: profileId, command, timeout_s: timeoutS };
      if (state.cwd.trim()) body.cwd = state.cwd.trim();
      const result = await sshApi.exec(body, (timeoutS + 45) * 1000);
      const res = result || {};
      if (res.stdout) pushLog(profileId, { kind: 'out', text: String(res.stdout) });
      if (res.stderr) pushLog(profileId, { kind: 'err', text: String(res.stderr) });
      const duration = fmtDuration(res.duration_ms);
      if (res.ok) {
        pushLog(profileId, {
          kind: 'meta',
          text: `执行完成 · exit_code=${res.exit_code}${duration ? ` · 耗时 ${duration}` : ''}`,
        });
      } else {
        pushLog(profileId, {
          kind: 'meta',
          text: `执行失败 · exit_code=${res.exit_code ?? 'n/a'}${
            duration ? ` · 耗时 ${duration}` : ''
          }`,
        });
      }
    } catch (err) {
      pushLog(profileId, { kind: 'err', text: errorMessage(err) });
      toastError(errorMessage(err), { title: '命令执行失败' });
    } finally {
      state.cmdBusy = false;
      render();
      scrollTerminal();
      void loadProfiles({ quiet: true });
    }
  }

  function clearTerminal() {
    if (!state.selectedId) return;
    state.logs.set(state.selectedId, []);
    render();
  }

  function terminalText() {
    const list = logFor(state.selectedId);
    return list
      .map((entry) => {
        if (entry.kind === 'cmd') {
          const prefix = entry.cwd ? `[${entry.cwd}] ` : '';
          return `$ ${prefix}${entry.text}`;
        }
        if (entry.kind === 'out') return entry.text;
        if (entry.kind === 'err') return entry.text;
        return `# ${entry.text}`;
      })
      .join('\n');
  }

  async function copyTerminal() {
    const text = terminalText().trim();
    if (!text) {
      toastWarn('终端还没有可复制的内容');
      return;
    }
    try {
      await copyText(text);
      toastSuccess('已复制终端输出');
    } catch {
      toastError('复制失败，请手动选择文本');
    }
  }

  function scrollTerminal() {
    const node = root.querySelector('[data-role="terminal"]');
    if (node) node.scrollTop = node.scrollHeight;
  }

  async function uploadFile(file) {
    const profile = selectedProfile();
    if (!profile) {
      toastWarn('请先选择一个 SSH 档案');
      return;
    }
    if (!file) return;
    const remotePath = joinRemote(state.fsPath, file.name);
    const form = new FormData();
    form.append('file', file);
    form.append('profile_id', profile.id);
    form.append('remote_path', remotePath);
    state.fsLoading = true;
    render();
    try {
      const result = await sshApi.upload(form);
      const bytes = result && Number.isFinite(Number(result.bytes)) ? Number(result.bytes) : file.size;
      toastSuccess(`已上传 ${file.name}（${fmtBytes(bytes)}）`);
      if (state.tab !== 'files') state.tab = 'files';
      await loadDir(state.fsPath, { force: true });
    } catch (err) {
      toastError(errorMessage(err), { title: '上传失败' });
      state.fsLoading = false;
      render();
    }
  }

  async function deleteProfile(profile) {
    const confirmed = await confirmDialog({
      title: '删除 SSH 档案',
      message: `确定删除「${profile.name}」吗？该操作不会影响远端服务器，只移除本地保存的连接信息。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await sshApi.deleteProfile(profile.id);
      toastSuccess(`已删除档案「${profile.name}」`);
      state.logs.delete(profile.id);
      state.lastTest.delete(profile.id);
      if (state.selectedId === profile.id) state.selectedId = '';
      await loadProfiles();
    } catch (err) {
      toastError(errorMessage(err), { title: '删除失败' });
    }
  }

  function showFormError(body, message) {
    const node = body.querySelector('.ssh-form-error');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('is-visible', Boolean(message));
  }

  function openEditor(profile = null) {
    const editing = Boolean(profile);
    const model = profile || {
      name: '',
      host: '',
      port: DEFAULT_PORT,
      username: '',
      auth: AUTH_PASSWORD,
      key_path: '',
      tags: [],
      has_password_saved: false,
    };
    const isKey = model.auth === AUTH_KEY;
    const html =
      '<div class="ssh-form">' +
      '<div class="ssh-form-error" role="alert"></div>' +
      '<div class="field"><label class="field-label" for="ssh-name">名称 <span class="ssh-req">*</span></label>' +
      `<input class="input" id="ssh-name" maxlength="80" placeholder="例如：生信服务器" value="${esc(
        model.name
      )}"></div>` +
      '<div class="ssh-form-grid">' +
      '<div class="field"><label class="field-label" for="ssh-host">主机地址 <span class="ssh-req">*</span></label>' +
      `<input class="input" id="ssh-host" placeholder="IP 或域名" value="${esc(model.host)}"></div>` +
      '<div class="field"><label class="field-label" for="ssh-port">端口</label>' +
      `<input class="input" id="ssh-port" type="number" min="1" max="65535" value="${esc(
        model.port || DEFAULT_PORT
      )}"></div>` +
      '</div>' +
      '<div class="field"><label class="field-label" for="ssh-user">用户名 <span class="ssh-req">*</span></label>' +
      `<input class="input" id="ssh-user" placeholder="例如：bioinfo" value="${esc(
        model.username
      )}"></div>` +
      '<div class="field"><label class="field-label" for="ssh-auth">认证方式</label>' +
      `<select class="input" id="ssh-auth">` +
      `<option value="password"${model.auth === AUTH_PASSWORD ? ' selected' : ''}>密码认证</option>` +
      `<option value="key"${isKey ? ' selected' : ''}>私钥认证</option>` +
      `<option value="agent"${model.auth === 'agent' ? ' selected' : ''}>系统 SSH Agent</option>` +
      '</select></div>' +
      `<div class="field ssh-auth-key"${isKey ? '' : ' hidden'}><label class="field-label" for="ssh-key">私钥路径（服务器本机路径）</label>` +
      `<input class="input" id="ssh-key" placeholder="例如：~/.ssh/id_ed25519" value="${esc(
        model.key_path || ''
      )}"><p class="field-hint">私钥只在本机读取，不会上传或写入日志。</p></div>` +
      `<div class="field ssh-auth-password"${isKey ? ' hidden' : ''}><label class="field-label" for="ssh-password">登录密码</label>` +
      `<input class="input" id="ssh-password" type="password" autocomplete="new-password" placeholder="${
        model.has_password_saved ? '已保存密码，留空则保持不变' : '仅当勾选“记住密码”时保存'
      }"></div>` +
      '<div class="ssh-remember-row ssh-auth-password"' +
      (isKey ? ' hidden' : '') +
      '><label class="ssh-check"><input type="checkbox" id="ssh-remember"' +
      (model.credential_stored ? ' checked' : '') +
      '> 记住密码</label>' +
      '<p class="field-hint ssh-warn-hint">勾选后尝试保存到系统凭据库；系统存储不可用时仅留在内存，并显示实际状态，不退回明文或 Base64。</p></div>' +
      '<div class="field"><label class="field-label" for="ssh-tags">标签</label>' +
      `<input class="input" id="ssh-tags" placeholder="用逗号分隔，例如：生信, GPU" value="${esc(
        (model.tags || []).join(', ')
      )}"></div>` +
      '</div>';

    const modal = openModal({
      title: editing ? `编辑档案 · ${model.name}` : '新增 SSH 档案',
      html,
      size: 'md',
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: editing ? '保存修改' : '创建档案',
          kind: 'primary',
          onClick: async ({ body }) => {
            const authSelect = body.querySelector('#ssh-auth');
            const auth = authSelect ? authSelect.value : AUTH_PASSWORD;
            const name = (body.querySelector('#ssh-name')?.value || '').trim();
            const host = (body.querySelector('#ssh-host')?.value || '').trim();
            const username = (body.querySelector('#ssh-user')?.value || '').trim();
            const port = Number(body.querySelector('#ssh-port')?.value);
            const keyPath = (body.querySelector('#ssh-key')?.value || '').trim();
            const password = body.querySelector('#ssh-password')?.value || '';
            const remember = Boolean(body.querySelector('#ssh-remember')?.checked);
            const tags = parseTags(body.querySelector('#ssh-tags')?.value);

            if (!name) return showFormError(body, '请填写档案名称'), false;
            if (!host) return showFormError(body, '请填写主机地址'), false;
            if (!username) return showFormError(body, '请填写用户名'), false;
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              return showFormError(body, '端口需为 1-65535 的整数'), false;
            }
            if (auth === AUTH_KEY && !keyPath) {
              return showFormError(body, '选择密钥认证时请填写私钥路径'), false;
            }

            const payload = {
              name,
              host,
              port,
              username,
              auth,
              key_path: auth === AUTH_KEY ? keyPath : '',
              tags,
              remember_password: auth === AUTH_PASSWORD ? remember : false,
            };
            if (auth === AUTH_PASSWORD && password) payload.password = password;

            showFormError(body, '');
            try {
              if (editing) {
                await sshApi.updateProfile(model.id, payload);
                toastSuccess(`已更新档案「${name}」`);
              } else {
                const created = await sshApi.createProfile(payload);
                const createdProfile = created && created.profile;
                if (createdProfile && createdProfile.id) state.selectedId = createdProfile.id;
                toastSuccess(`已创建档案「${name}」`);
              }
              await loadProfiles();
              return true;
            } catch (err) {
              showFormError(body, errorMessage(err));
              return false;
            }
          },
        },
      ],
    });

    const authSelect = modal.body.querySelector('#ssh-auth');
    const syncAuthFields = () => {
      const keyMode = authSelect && authSelect.value === AUTH_KEY;
      modal.body.querySelectorAll('.ssh-auth-key').forEach((node) => {
        node.hidden = !keyMode;
      });
      modal.body.querySelectorAll('.ssh-auth-password').forEach((node) => {
        node.hidden = authSelect?.value !== AUTH_PASSWORD;
      });
    };
    if (authSelect) authSelect.addEventListener('change', syncAuthFields);
    syncAuthFields();
    setTimeout(() => {
      const focusTarget = modal.body.querySelector('#ssh-name');
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    }, 30);
  }

  function renderTestResult(node, result) {
    const ok = Boolean(result && result.ok);
    const rows = [];
    if (result && result.server_version) rows.push(['服务端版本', result.server_version]);
    if (result && result.fingerprint) rows.push(['主机指纹', result.fingerprint]);
    if (result && Number.isFinite(Number(result.latency_ms))) {
      rows.push(['连接延迟', `${result.latency_ms} ms`]);
    }
    const parts = [`<div class="ssh-test-badge ${ok ? 'is-ok' : 'is-fail'}">`];
    parts.push(
      `${icon(ok ? 'checkCircle' : 'xCircle', { size: 16 })}<span>${
        ok ? '连接成功' : '连接失败'
      }</span></div>`
    );
    if (rows.length) {
      parts.push('<dl class="ssh-test-facts">');
      for (const [label, value] of rows) {
        parts.push(`<div><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`);
      }
      parts.push('</dl>');
    }
    if (result && result.error) {
      parts.push(`<div class="ssh-test-error">${esc(result.error)}</div>`);
    }
    if (result && result.warning) {
      parts.push(`<div class="ssh-test-warning">${icon('alert', { size: 14 })}<span>${esc(result.warning)}</span></div>`);
    }
    node.innerHTML = parts.join('');
  }

  function openTestDialog(profile) {
    const html =
      '<div class="ssh-test-dialog">' +
      '<p class="ssh-dialog-hint">将使用当前档案连接服务器并校验主机指纹，不会在服务器上执行命令。</p>' +
      '<div class="field"><label class="field-label" for="ssh-test-password">密码（可选）</label>' +
      `<input class="input" id="ssh-test-password" type="password" autocomplete="current-password" placeholder="${
        profile.has_password_saved
          ? '已保存密码，可留空'
          : profile.auth === AUTH_KEY
          ? '密钥认证无需密码'
          : '未保存密码，请输入以完成测试'
      }"></div>` +
      `<label class="ssh-check"><input type="checkbox" id="ssh-test-remember" ${profile.credential_stored?'checked':''}/>记住密码，重启后自动复用</label>` +
      '<p class="field-hint">保存到系统凭据库；不可持久保存时会明确提示。</p>' +
      '<div class="ssh-test-result" data-role="test-result"></div>' +
      '</div>';
    const modal = openModal({
      title: `测试连接 · ${profile.name}`,
      html,
      size: 'sm',
      actions: [
        { label: '关闭', kind: 'ghost' },
        {
          label: '开始测试',
          kind: 'primary',
          onClick: async ({ body }) => {
            const resultNode = body.querySelector('[data-role="test-result"]');
            const password = body.querySelector('#ssh-test-password')?.value || '';
            if (!resultNode) return false;
            resultNode.innerHTML = spinnerHtml('正在连接服务器…');
            state.testingId = profile.id;
            render();
            try {
              const result = await sshApi.testProfile(profile.id, password, Boolean(body.querySelector('#ssh-test-remember')?.checked));
              state.lastTest.set(profile.id, result || {});
              renderTestResult(resultNode, result || {});
              if (result && result.ok) {
                if (result.warning) toastWarn(result.warning, { title: '主机指纹变化' });
                else toastSuccess(`连接成功（${result.latency_ms} ms）`);
              } else {
                toastError((result && result.error) || '连接失败');
              }
              await loadProfiles({ quiet: true });
            } catch (err) {
              const message = errorMessage(err);
              resultNode.innerHTML = `<div class="ssh-test-error">${esc(message)}</div>`;
              toastError(message, { title: '测试连接失败' });
            } finally {
              state.testingId = '';
              render();
            }
            return false;
          },
        },
      ],
    });
    setTimeout(() => {
      const input = modal.body.querySelector('#ssh-test-password');
      if (input && typeof input.focus === 'function') input.focus();
    }, 30);
  }

  /* -- 渲染 -------------------------------------------------------- */

  function profileCard(profile) {
    const active = profile.id === state.selectedId;
    const status = profileStatus(profile);
    const lastTest = state.lastTest.get(profile.id);
    const testing = state.testingId === profile.id;
    const statusKind = lastTest
      ? lastTest.ok
        ? 'ok'
        : 'fail'
      : testing
      ? 'running'
      : status.kind;
    const statusLabel = testing ? '测试中' : lastTest ? (lastTest.ok ? '可连接' : '连接失败') : status.label;
    const meta = lastTest && lastTest.latency_ms ? ` · ${lastTest.latency_ms} ms` : '';
    return (
      `<div class="ssh-profile-card${active ? ' is-active' : ''}" role="button" tabindex="0" ` +
      `data-action="select" data-id="${esc(profile.id)}" aria-pressed="${active ? 'true' : 'false'}">` +
      '<div class="ssh-profile-top">' +
      `<span class="ssh-profile-name" title="${esc(profile.name)}">${esc(profile.name)}</span>` +
      `<span class="status-chip is-${statusKind}">${esc(statusLabel)}${esc(meta)}</span>` +
      '</div>' +
      `<div class="ssh-profile-meta">${esc(profileTarget(profile))}</div>` +
      '<div class="ssh-profile-sub">' +
      `<span>${esc(authLabel(profile.auth))}</span>` +
      '<span class="ssh-dot">·</span>' +
      `<span>${profile.last_ok ? `上次成功 ${esc(relTime(profile.last_ok))}` : '暂无成功记录'}</span>` +
      '</div>' +
      '<div class="ssh-profile-actions">' +
      `<button type="button" class="icon-btn" data-action="test" data-id="${esc(
        profile.id
      )}" title="测试连接" aria-label="测试连接">${icon('shield', { size: 14 })}</button>` +
      `<button type="button" class="icon-btn" data-action="edit" data-id="${esc(
        profile.id
      )}" title="编辑档案" aria-label="编辑档案">${icon('pencil', { size: 14 })}</button>` +
      `<button type="button" class="icon-btn" data-action="delete" data-id="${esc(
        profile.id
      )}" title="删除档案" aria-label="删除档案">${icon('trash', { size: 14 })}</button>` +
      '</div></div>'
    );
  }

  function sidebarHtml() {
    const cards = state.profiles.map(profileCard).join('');
    return (
      '<aside class="ssh-sidebar">' +
      '<div class="ssh-sidebar-head">' +
      '<div><h2 class="ssh-sidebar-title">SSH 主机</h2>' +
      '<p class="ssh-sidebar-sub">共 ' +
      state.profiles.length +
      ' 个档案</p></div>' +
      `<button type="button" class="btn btn-primary btn-sm" data-action="new">${icon('plus', {
        size: 14,
      })} 新增</button>` +
      '</div>' +
      `<div class="ssh-profile-list">${
        state.profiles.length
          ? cards
          : emptyStateHtml({
              iconName: 'terminal',
              title: '还没有 SSH 档案',
              hint: '新增一个主机档案后，即可远程执行命令、上传下载文件。',
            })
      }</div>` +
      '<div class="ssh-sidebar-foot">' +
      `${icon('shield', { size: 13 })} 密码默认仅留在进程内存。记住密码使用可用的系统凭据库；档案只保存引用。` +
      '</div></aside>'
    );
  }

  function detailHeadHtml(profile) {
    const status = profileStatus(profile);
    return (
      '<header class="ssh-detail-head">' +
      '<div class="ssh-detail-title"><h2 class="ssh-host-name">' +
      esc(profile.name) +
      '</h2><div class="ssh-host-meta">' +
      `<span class="status-chip is-${status.kind}">${esc(status.label)}</span>` +
      `<span>${esc(profileTarget(profile))}</span>` +
      `<span class="ssh-dot">·</span><span>${esc(authLabel(profile.auth))}</span>` +
      (profile.last_ok
        ? `<span class="ssh-dot">·</span><span>上次成功 ${esc(relTime(profile.last_ok))}</span>`
        : '') +
      '</div></div>' +
      '<div class="ssh-detail-actions">' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="open-workspace">' + icon('folder', {size: 14}) + '作为工作区打开</button>' +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="test" data-id="${esc(
        profile.id
      )}">${icon('shield', { size: 14 })} 测试连接</button>` +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-id="${esc(
        profile.id
      )}">${icon('pencil', { size: 14 })} 编辑</button>` +
      `<button type="button" class="btn btn-ghost btn-sm ssh-btn-danger" data-action="delete" data-id="${esc(
        profile.id
      )}">${icon('trash', { size: 14 })} 删除</button>` +
      '</div></header>'
    );
  }

  function tabsHtml(profile) {
    const tabs = [
      ['terminal', '命令终端', 'terminal'],
      ['files', '远程目录', 'folder'],
      ['info', '远端信息', 'cpu'],
    ];
    return (
      '<div class="ssh-tabs" role="tablist">' +
      tabs
        .map(([key, label, iconName]) => {
          const active = state.tab === key;
          return (
            `<button type="button" role="tab" aria-selected="${active}" class="ssh-tab${
              active ? ' is-active' : ''
            }" data-action="tab" data-tab="${key}">` +
            `${icon(iconName, { size: 15 })}<span>${label}</span>${
              key === 'files' && state.fsEntries.length
                ? `<span class="ssh-tab-count">${state.fsEntries.length}</span>`
                : ''
            }</button>`
          );
        })
        .join('') +
      (state.cmdBusy || state.fsLoading || state.infoLoading
        ? `<span class="ssh-tab-busy">${icon('spinner', { size: 14 })} 处理中…</span>`
        : '') +
      '</div>'
    );
  }

  function terminalEntriesHtml(profile) {
    const entries = logFor(profile.id);
    if (!entries.length) {
      return (
        '<div class="ssh-term-empty">' +
        `${icon('terminal', { size: 20 })}` +
        '<p>命令输出会显示在这里。快捷键：Ctrl + Enter 执行。</p>' +
        '</div>'
      );
    }
    const lines = entries.map((entry) => {
      if (entry.kind === 'cmd') {
        return (
          '<div class="ssh-term-line is-cmd"><span class="ssh-term-prompt">$</span>' +
          `<span class="ssh-term-text">${entry.cwd ? `[${esc(entry.cwd)}] ` : ''}${esc(
            entry.text
          )}</span></div>`
        );
      }
      if (entry.kind === 'meta') {
        return `<div class="ssh-term-line is-meta"><span class="ssh-term-text"># ${esc(
          entry.text
        )}</span></div>`;
      }
      if (entry.kind === 'err') {
        return `<div class="ssh-term-line is-err"><span class="ssh-term-text">${esc(
          entry.text
        )}</span></div>`;
      }
      return `<div class="ssh-term-line is-out"><span class="ssh-term-text">${esc(
        entry.text
      )}</span></div>`;
    });
    return lines.join('');
  }

  function terminalPanelHtml(profile) {
    return (
      '<div class="ssh-terminal-panel">' +
      '<div class="ssh-cmdbar">' +
      `<textarea class="input-area ssh-command-input" rows="2" spellcheck="false" placeholder="输入 Shell 命令，例如：nvidia-smi 或 ls -lh /data（Ctrl + Enter 执行）">${esc(
        state.command
      )}</textarea>` +
      '<div class="ssh-cmdbar-foot">' +
      '<div class="ssh-cmdbar-fields">' +
      '<label class="ssh-mini-field"><span>超时(秒)</span>' +
      `<input class="input ssh-timeout-input" type="number" min="1" max="${MAX_TIMEOUT_S}" value="${esc(
        state.timeoutS
      )}"></label>` +
      '<label class="ssh-mini-field"><span>工作目录</span>' +
      `<input class="input ssh-cwd-input" placeholder="可选，如 /data" value="${esc(
        state.cwd
      )}"></label>` +
      '</div>' +
      '<div class="ssh-cmdbar-buttons">' +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="copy-terminal">${icon(
        'copy',
        { size: 14 }
      )} 复制输出</button>` +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="clear-terminal">${icon(
        'trash',
        { size: 14 }
      )} 清空</button>` +
      `<button type="button" class="btn btn-primary btn-sm" data-action="run"${
        state.cmdBusy ? ' disabled' : ''
      }>${icon(state.cmdBusy ? 'spinner' : 'play', { size: 15 })} ${
        state.cmdBusy ? '执行中…' : '执行'
      }</button>` +
      '</div></div></div>' +
      `<div class="ssh-terminal" data-role="terminal" tabindex="0" aria-label="命令输出">${terminalEntriesHtml(
        profile
      )}</div>` +
      '</div>'
    );
  }

  function breadcrumbHtml() {
    const parts = String(state.fsPath || '/')
      .split('/')
      .filter(Boolean);
    const items = [`<button type="button" class="ssh-crumb" data-action="fs-open" data-path="/">${icon(
      'folder',
      { size: 13 }
    )} 根目录</button>`];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push(
        `<span class="ssh-crumb-sep" aria-hidden="true">${icon('chevronRight', {
          size: 12,
        })}</span>` +
          `<button type="button" class="ssh-crumb" data-action="fs-open" data-path="${esc(
            acc
          )}">${esc(part)}</button>`
      );
    }
    return `<nav class="ssh-breadcrumb" aria-label="远程路径">${items.join('')}</nav>`;
  }

  function fileRowsHtml(profile) {
    const parent = parentRemote(state.fsPath);
    const rows = [];
    if (state.fsPath !== '/') {
      rows.push(
        '<div class="ssh-file-row is-dir" data-action="fs-open" data-path="' +
          esc(parent) +
          '" role="button" tabindex="0">' +
          `<span class="ssh-file-icon">${icon('chevronUp', { size: 15 })}</span>` +
          '<span class="ssh-file-name">返回上级</span>' +
          '<span class="ssh-file-size">—</span><span class="ssh-file-time">—</span><span class="ssh-file-op"></span></div>'
      );
    }
    for (const entry of state.fsEntries) {
      const path = joinRemote(state.fsPath, entry.name);
      if (entry.is_dir) {
        rows.push(
          `<div class="ssh-file-row is-dir" data-action="fs-open" data-path="${esc(
            path
          )}" role="button" tabindex="0">` +
            `<span class="ssh-file-icon">${icon('folder', { size: 15 })}</span>` +
            `<span class="ssh-file-name" title="${esc(entry.name)}">${esc(entry.name)}</span>` +
            '<span class="ssh-file-size">目录</span>' +
            `<span class="ssh-file-time">${esc(relTime(entry.mtime))}</span>` +
            '<span class="ssh-file-op"></span></div>'
        );
      } else {
        rows.push(
          '<div class="ssh-file-row">' +
            `<span class="ssh-file-icon">${icon('file', { size: 15 })}</span>` +
            `<span class="ssh-file-name" title="${esc(entry.name)}">${esc(entry.name)}</span>` +
            `<span class="ssh-file-size">${esc(fmtBytes(entry.size))}</span>` +
            `<span class="ssh-file-time">${esc(relTime(entry.mtime))}</span>` +
            '<span class="ssh-file-op">' +
            `<button type="button" class="icon-btn" data-action="download" data-id="${esc(
              profile.id
            )}" data-path="${esc(path)}" title="下载" aria-label="下载 ${esc(entry.name)}">${icon(
              'download',
              { size: 14 }
            )}</button></span></div>`
        );
      }
    }
    if (!rows.length) {
      return emptyStateHtml({
        iconName: 'folder',
        title: '当前目录为空',
        hint: '可以上传文件，或返回上级目录。',
      });
    }
    return rows.join('');
  }

  function filesPanelHtml(profile) {
    return (
      '<div class="ssh-files-panel">' +
      '<div class="ssh-files-toolbar">' +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="fs-refresh">${icon(
        'refresh',
        { size: 14 }
      )} 刷新</button>` +
      `<button type="button" class="btn btn-primary btn-sm" data-action="fs-upload">${icon(
        'upload',
        { size: 14 }
      )} 上传到当前目录</button>` +
      '<input type="file" class="ssh-file-input" hidden>' +
      '<span class="ssh-files-path" title="当前远程目录">' +
      esc(state.fsPath) +
      '</span>' +
      '</div>' +
      breadcrumbHtml() +
      '<div class="ssh-file-table">' +
      '<div class="ssh-file-row is-head"><span class="ssh-file-icon"></span>' +
      '<span class="ssh-file-name">名称</span><span class="ssh-file-size">大小</span>' +
      '<span class="ssh-file-time">修改时间</span><span class="ssh-file-op">操作</span></div>' +
      (state.fsLoading ? `<div class="ssh-files-loading">${spinnerHtml('读取远程目录…')}</div>` : fileRowsHtml(profile)) +
      '</div>' +
      '<div class="ssh-files-foot">' +
      `${icon('info', { size: 13 })} 大文件（超过 200MB）请使用命令行工具传输；下载会先生成服务器端临时文件。` +
      '</div></div>'
    );
  }

  function infoPanelHtml() {
    if (state.infoLoading) {
      return `<div class="ssh-info-panel">${spinnerHtml('读取远端信息…')}</div>`;
    }
    const info = state.info;
    if (!info) {
      return (
        '<div class="ssh-info-panel">' +
        emptyStateHtml({
          iconName: 'cpu',
          title: '尚未获取远端信息',
          hint: '点击下方按钮读取系统、Python、内存、GPU 与磁盘信息（容错，缺失项显示为破折号）。',
        }) +
        '<div class="ssh-info-actions">' +
        `<button type="button" class="btn btn-primary btn-sm" data-action="info-refresh">${icon(
          'refresh',
          { size: 14 }
        )} 读取信息</button></div></div>`
      );
    }
    const rows = [
      ['操作系统', info.uname, 'terminal'],
      ['Python', info.python, 'code'],
      ['CPU 核心', Number.isFinite(Number(info.cpu_count)) && info.cpu_count ? `${info.cpu_count}` : null, 'cpu'],
      [
        '内存',
        Number.isFinite(Number(info.mem_total_mb)) && info.mem_total_mb
          ? `${Number(info.mem_total_mb).toLocaleString('zh-CN')} MB`
          : null,
        'layers',
      ],
      ['GPU', info.gpu, 'brain'],
      [
        '磁盘可用',
        Number.isFinite(Number(info.disk_free_gb)) && info.disk_free_gb
          ? `${Number(info.disk_free_gb).toLocaleString('zh-CN')} GB`
          : null,
        'save',
      ],
    ];
    return (
      '<div class="ssh-info-panel">' +
      '<div class="ssh-info-grid">' +
      rows
        .map(
          ([label, value, iconName]) =>
            '<div class="ssh-info-card">' +
            `<div class="ssh-info-label">${icon(iconName, { size: 14 })}<span>${label}</span></div>` +
            `<div class="ssh-info-value${value ? '' : ' is-empty'}">${
              value ? esc(String(value)) : '—'
            }</div></div>`
        )
        .join('') +
      '</div>' +
      '<div class="ssh-info-actions">' +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="info-refresh">${icon(
        'refresh',
        { size: 14 }
      )} 重新读取</button>` +
      `<span class="ssh-info-hint">信息通过远程命令采集，个别环境可能缺失。</span>` +
      '</div></div>'
    );
  }

  function mainHtml() {
    const profile = selectedProfile();
    if (!state.profiles.length) {
      return (
        '<section class="ssh-main ssh-main-empty">' +
        emptyStateHtml({
          iconName: 'terminal',
          title: '新增第一个 SSH 档案',
          hint: '填写主机地址、端口与登录方式，即可在浏览器中管理远程生信服务器。',
        }) +
        `<button type="button" class="btn btn-primary" data-action="new">${icon('plus', {
          size: 15,
        })} 新增 SSH 档案</button></section>`
      );
    }
    if (!profile) {
      return (
        '<section class="ssh-main ssh-main-empty">' +
        emptyStateHtml({
          iconName: 'terminal',
          title: '请选择左侧的 SSH 档案',
          hint: '选中档案后可执行命令、浏览远程目录与查看系统信息。',
        }) +
        '</section>'
      );
    }
    let panel = '';
    if (state.tab === 'terminal') panel = terminalPanelHtml(profile);
    else if (state.tab === 'files') panel = filesPanelHtml(profile);
    else panel = infoPanelHtml(profile);
    return (
      `<section class="ssh-main">${detailHeadHtml(profile)}${tabsHtml(profile)}` +
      `<div class="ssh-panel-body">${panel}</div></section>`
    );
  }

  function layoutHtml() {
    const header =
      '<header class="page-head ssh-page-head">' +
      '<div><h1 class="page-title">SSH 主机</h1>' +
      '<p class="page-subtitle">远程执行命令、浏览目录与传输文件。密码默认不落盘，所有操作仅在本机浏览器与目标服务器之间进行。</p></div>' +
      '<div class="page-actions">' +
      `<button type="button" class="btn btn-ghost btn-sm" data-action="reload">${icon('refresh', {
        size: 14,
      })} 刷新</button>` +
      '</div></header>';
    return `<div class="page ssh-page">${header}<div class="ssh-layout">${sidebarHtml()}${mainHtml()}</div></div>`;
  }

  function render() {
    if (state.loading) {
      root.innerHTML = `<div class="page ssh-page"><div class="ssh-boot">${spinnerHtml(
        '正在读取 SSH 档案…'
      )}</div></div>`;
      return;
    }
    if (state.loadError) {
      root.innerHTML =
        '<div class="page ssh-page"><div class="ssh-boot">' +
        `<div class="ssh-boot-error">${icon('xCircle', { size: 20 })}<p>${esc(
          state.loadError
        )}</p>` +
        `<button type="button" class="btn btn-primary btn-sm" data-action="reload">重试</button></div>` +
        '</div></div>';
      return;
    }
    root.innerHTML = layoutHtml();
    scrollTerminal();
  }

  /* -- 事件 -------------------------------------------------------- */

  function onClick(evt) {
    const target = evt.target instanceof Element ? evt.target.closest('[data-action]') : null;
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'open-workspace') {
      const profile = selectedProfile();
      if (!profile) return;
      openModal({title: '打开 SSH 工作区', size: 'md',
        html: '<div class="form-stack"><label class="field"><span class="field-label">工作区名称</span><input class="input" id="ssh-ws-name" value="' + esc(profile.name || profile.host) + '" /></label><label class="field"><span class="field-label">远程工作目录</span><input class="input" id="ssh-ws-root" value="' + esc(state.tab === 'files' ? state.fsPath : '~') + '" placeholder="/home/user/project" /></label><p class="field-hint">文件、控制台和任务都使用这个远程目录。</p></div>',
        actions: [{label: '取消', kind: 'ghost'}, {label: '验证并打开', kind: 'primary', onClick: async ({body}) => {
          try {
            const data = await api.workspaces.create({name: body.querySelector('#ssh-ws-name').value.trim() || profile.name,
              backend: 'ssh', remote: {profile_id: profile.id, root: body.querySelector('#ssh-ws-root').value.trim() || '~'}});
            setWorkspace(data.workspace); navigate('workbench'); toastSuccess('已打开远程工作区');
            return true;
          } catch (err) { toastError(errorMessage(err)); return false; }
        }}]});
      return;
    }
    const profile = state.profiles.find((item) => item.id === target.dataset.id) || null;

    if (action === 'reload') {
      void loadProfiles();
      return;
    }
    if (action === 'new') {
      openEditor(null);
      return;
    }
    if (action === 'select') {
      selectProfile(target.dataset.id);
      return;
    }
    if (action === 'test' && profile) {
      openTestDialog(profile);
      return;
    }
    if (action === 'edit' && profile) {
      openEditor(profile);
      return;
    }
    if (action === 'delete' && profile) {
      void deleteProfile(profile);
      return;
    }
    if (action === 'tab') {
      const tab = target.dataset.tab;
      if (!tab || tab === state.tab) return;
      state.tab = tab;
      render();
      if (tab === 'files') void loadDir(state.fsPath, { force: false });
      if (tab === 'info') void loadInfo({ force: false });
      return;
    }
    if (action === 'run') {
      void runCommand();
      return;
    }
    if (action === 'clear-terminal') {
      clearTerminal();
      return;
    }
    if (action === 'copy-terminal') {
      void copyTerminal();
      return;
    }
    if (action === 'download' && target.dataset.path) {
      downloadTo(target.dataset.id || state.selectedId, target.dataset.path);
      return;
    }
    if (action === 'fs-open' && target.dataset.path) {
      void loadDir(target.dataset.path, { force: true });
      return;
    }
    if (action === 'fs-refresh') {
      void loadDir(state.fsPath, { force: true });
      return;
    }
    if (action === 'fs-upload') {
      const input = root.querySelector('.ssh-file-input');
      if (input) input.click();
      return;
    }
    if (action === 'info-refresh') {
      void loadInfo({ force: true });
    }
  }

  function onKeydown(evt) {
    if (evt.key === 'Enter' && evt.ctrlKey) {
      const target = evt.target;
      if (target instanceof Element && target.classList.contains('ssh-command-input')) {
        evt.preventDefault();
        void runCommand();
      }
      return;
    }
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const target = evt.target instanceof Element ? evt.target.closest('.ssh-profile-card[role="button"]') : null;
    if (!target || !root.contains(target)) return;
    // 卡片内的操作按钮不触发选择
    if (evt.target instanceof Element && evt.target.closest('button')) return;
    evt.preventDefault();
    selectProfile(target.dataset.id);
  }

  function onInput(evt) {
    const target = evt.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains('ssh-command-input')) {
      state.command = target.value;
      return;
    }
    if (target.classList.contains('ssh-timeout-input')) {
      state.timeoutS = target.value;
      return;
    }
    if (target.classList.contains('ssh-cwd-input')) {
      state.cwd = target.value;
    }
  }

  function onChange(evt) {
    const target = evt.target;
    if (target instanceof HTMLInputElement && target.classList.contains('ssh-file-input')) {
      const file = target.files && target.files[0];
      target.value = '';
      if (file) void uploadFile(file);
    }
  }

  async function init() {
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    await loadProfiles();
    const profile = selectedProfile();
    if (profile) {
      render();
      if (state.tab === 'files') void loadDir('/');
      if (state.tab === 'info') void loadInfo();
    }
  }

  function destroy() {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeydown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.innerHTML = '';
  }

  return { init, destroy, state };
}

export function unmount() {
  if (activeInstance) {
    activeInstance.destroy();
    activeInstance = null;
  }
}

export default { mount, unmount };
