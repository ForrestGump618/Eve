// REST client for the Eve backend. All calls are same-origin relative paths,
// the JSON error envelope {"error": {message, code, detail}} is normalised into ApiError.

import { emit } from './bus.js?v=2.1.1';

const DEFAULT_TIMEOUT = 30000;

export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? '';
    this.detail = opts.detail ?? null;
    this.url = opts.url ?? '';
    this.offline = Boolean(opts.offline);
  }
}

export function isApiError(err) {
  return err instanceof ApiError || Boolean(err && err.name === 'ApiError');
}

export function errorMessage(err) {
  if (!err) return '未知错误';
  if (isApiError(err)) {
    if (err.offline) return '无法连接后端服务，请检查服务是否运行';
    return err.message || `请求失败（${err.status}）`;
  }
  if (err.name === 'AbortError') return '请求已取消';
  return err.message || String(err);
}

function buildQuery(params) {
  if (!params) return '';
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function combineSignals(signal, timeout) {
  const ctrl = new AbortController();
  const cleanup = [];
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else {
      const onAbort = () => ctrl.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
    }
  }
  if (timeout && timeout > 0) {
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
    cleanup.push(() => clearTimeout(timer));
  }
  return {
    signal: ctrl.signal,
    done: () => cleanup.forEach((fn) => fn()),
    controller: ctrl,
  };
}

async function parseBody(res) {
  const type = res.headers.get('content-type') || '';
  if (res.status === 204) return null;
  if (type.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Perform a JSON request against the backend.
 * @param {string} path
 * @param {{method?: string, body?: any, headers?: Record<string,string>, signal?: AbortSignal,
 *          timeout?: number, quiet?: boolean, bodyType?: 'json'|'text'}} [opts]
 */
export async function request(path, opts = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeout = DEFAULT_TIMEOUT,
    quiet = false,
    bodyType = 'json',
  } = opts;

  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined && body !== null) {
    if (bodyType === 'text') {
      init.body = String(body);
      init.headers['Content-Type'] = 'text/plain;charset=utf-8';
    } else if (body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }

  const combined = combineSignals(signal, timeout);
  init.signal = combined.signal;
  if (!quiet) emit('api:busy', { delta: 1, path });

  try {
    const res = await fetch(path, init);
    const data = await parseBody(res);
    if (!res.ok) {
      let env = data && typeof data === 'object' ? data.error || data.detail || null : null;
      // FastAPI HTTPException raises {"detail": {"error": {...}}}; unwrap once so
      // error codes and machine-readable fields (run_id, trace_id, ...) survive.
      if (env && typeof env === 'object' && env.error && typeof env.error === 'object') {
        env = env.error;
      }
      const message =
        (env && typeof env === 'object' && (env.message || env.detail)) ||
        (typeof env === 'string' ? env : '') ||
        (data && typeof data === 'object' && typeof data.message === 'string' ? data.message : '') ||
        `请求失败（HTTP ${res.status}）`;
      throw new ApiError(message, {
        status: res.status,
        code: (env && env.code) || '',
        detail: env && typeof env === 'object' ? env : data,
        url: path,
      });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    if (err instanceof TypeError) {
      throw new ApiError('无法连接后端服务，请检查服务是否运行', { url: path, offline: true });
    }
    throw err;
  } finally {
    combined.done();
    if (!quiet) emit('api:busy', { delta: -1, path });
  }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * Try `paths` in order and return the first non-missing response.
 * Compatibility shim: the task-tree routes are deployed under
 * /api/runtime/* while CONTRACTS-3 §8 names the short form.
 */
async function requestFirst(paths, opts = {}) {
  let lastError = null;
  for (let index = 0; index < paths.length; index += 1) {
    const isLast = index === paths.length - 1;
    try {
      return await request(paths[index], isLast ? opts : { ...opts, quiet: true });
    } catch (err) {
      lastError = err;
      const missing =
        err && (err.status === 404 || err.status === 405) && err.code !== 'run_not_found';
      if (isLast || !missing) throw err;
    }
  }
  throw lastError;
}

export const api = {
  request,
  errorMessage,

  health: () => request('/api/health', { timeout: 5000, quiet: true }),
  systemInfo: () => request('/api/system/info', { quiet: true }),

  conversations: {
    list: () => request('/api/conversations'),
    create: (payload = {}) => request('/api/conversations', { method: 'POST', body: payload }),
    get: (id) => request(`/api/conversations/${encodeURIComponent(id)}`),
    update: (id, patch) =>
      request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    remove: (id) => request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  chat: {
    stop: (conversationId) => request('/api/chat/stop', { method: 'POST', body: { conversation_id: conversationId } }),
    approval: (id, decision) =>
      request(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } }),
  },

  agents: () => request('/api/agents', { quiet: true }),
  // Effective default agent (CONTRACTS-3 T07): explicit session > user default > builtin lead.
  agentsDefault: () => request('/api/agents/default', { quiet: true, timeout: 8000 }),

  // Global approval centre (CONTRACTS-3 §7).
  approvals: {
    list: (params = {}) => request(`/api/approvals${buildQuery(params)}`, { quiet: true }),
    decide: (id, decision) =>
      request(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } }),
  },

  // Independent runs + resumable trace subscription (CONTRACTS-3 §3).
  runtime: {
    createRun: (sessionId, payload = {}) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
        method: 'POST',
        body: payload,
        timeout: 60000,
      }),
    getRun: (runId) => request(`/api/runs/${encodeURIComponent(runId)}`, { quiet: true, timeout: 10000 }),
    cancelRun: (runId) =>
      request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} }),
    // Task tree: CONTRACTS-3 §8 path, with the deployed /api/runtime/* fallback.
    children: (runId) =>
      requestFirst(
        [
          `/api/runs/${encodeURIComponent(runId)}/children`,
          `/api/runtime/runs/${encodeURIComponent(runId)}/children`,
        ],
        { quiet: true, timeout: 15000 },
      ),
    timeline: (traceId, afterSeq = 0, limit = 500) =>
      request(
        `/api/runtime/timeline/${encodeURIComponent(traceId)}${buildQuery({ after_seq: afterSeq, limit })}`,
        { quiet: true, timeout: 15000 },
      ),
    messageRun: (runId, message) =>
      request(`/api/runs/${encodeURIComponent(runId)}/messages`, {
        method: 'POST',
        body: { message },
      }),
    traceEventsUrl: (traceId, afterSeq = 0) =>
      `/api/traces/${encodeURIComponent(traceId)}/events${buildQuery({ after_seq: afterSeq })}`,
    // Backend compatibility: GET /api/runs/{run_id}/stream replays the trace from
    // after_seq and then streams live frames (used while the trace endpoint is pending).
    runStreamUrl: (runId, afterSeq = 0) =>
      `/api/runs/${encodeURIComponent(runId)}/stream${buildQuery({ after_seq: afterSeq })}`,
    sessionRuns: (sessionId, limit = 20) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/runs${buildQuery({ limit })}`, {
        quiet: true,
      }),
  },

  // Child agent tasks / task tree (CONTRACTS-3 §8).
  agentTasks: {
    list: (parentRunId) =>
      requestFirst(
        [
          `/api/agent-tasks${buildQuery({ parent_run_id: parentRunId })}`,
          `/api/runtime/runs/${encodeURIComponent(parentRunId)}/children`,
        ],
        { quiet: true, timeout: 15000 },
      ),
    get: (id) =>
      requestFirst(
        [
          `/api/agent-tasks/${encodeURIComponent(id)}`,
          `/api/runtime/agent-tasks/${encodeURIComponent(id)}`,
        ],
        { quiet: true, timeout: 15000 },
      ),
    runs: (id) =>
      requestFirst(
        [
          `/api/agent-tasks/${encodeURIComponent(id)}/runs`,
          `/api/runtime/agent-tasks/${encodeURIComponent(id)}/runs`,
        ],
        { quiet: true, timeout: 15000 },
      ),
    message: (id, message) =>
      request(`/api/agent-tasks/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: { message },
      }),
    cancel: (id) =>
      requestFirst(
        [
          `/api/agent-tasks/${encodeURIComponent(id)}/cancel`,
          `/api/runtime/agent-tasks/${encodeURIComponent(id)}/cancel`,
        ],
        { method: 'POST', body: {} },
      ),
  },

  // Workspaces + kernels (CONTRACTS-3 §4, T04/T09).
  workspaces: {
    list: () => request('/api/workspaces', { quiet: true, timeout: 15000 }),
    create: (payload = {}) => request('/api/workspaces', { method: 'POST', body: payload }),
    get: (id) => request(`/api/workspaces/${encodeURIComponent(id)}`, { quiet: true }),
    remove: (id) => request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    probe: (id) =>
      request(`/api/workspaces/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
        body: {},
        timeout: 20000,
      }),
    files: {
      upload: (id, file, dir = '.', opts = {}) => uploadFile(file, dir, {...opts, workspaceId:id}),
      tree: (id, path = '.') =>
        request(
          `/api/workspaces/${encodeURIComponent(id)}/files/tree${buildQuery({ path })}`,
          { quiet: true },
        ),
      read: (id, path) =>
        request(
          `/api/workspaces/${encodeURIComponent(id)}/files/read${buildQuery({ path })}`,
        ),
      rawUrl: (id, path) =>
        `/api/workspaces/${encodeURIComponent(id)}/files/raw${buildQuery({ path })}`,
    },
  },

  kernels: {
    list: () => request('/api/kernels', { quiet: true }),
    start: (scope) =>
      request(`/api/kernels/${encodeURIComponent(scope)}/start`, { method: 'POST', body: {} }),
    restart: (scope) =>
      request(`/api/kernels/${encodeURIComponent(scope)}/restart`, { method: 'POST', body: {} }),
    stop: (scope) =>
      request(`/api/kernels/${encodeURIComponent(scope)}/stop`, { method: 'POST', body: {} }),
  },

  kernel: {
    status: () => request('/api/kernel/status', { quiet: true }),
    vars: () => request('/api/kernel/vars'),
    restart: () => request('/api/kernel/restart', { method: 'POST', body: {} }),
    interrupt: () => request('/api/kernel/interrupt', { method: 'POST', body: {} }),
    execute: (code) => request('/api/kernel/execute', { method: 'POST', body: { code } }),
    varDetail: (name) => request(`/api/kernel/var_detail${buildQuery({ name })}`),
  },

  files: {
    tree: (path = '.') => request(`/api/files/tree${buildQuery({ path })}`, { quiet: true }),
    read: (path, maxBytes = 256000) =>
      request(`/api/files/read${buildQuery({ path, max_bytes: maxBytes })}`),
    rawUrl: (path) => `/api/files/raw${buildQuery({ path })}`,
    write: (path, content) => request('/api/files/write', { method: 'POST', body: { path, content } }),
    mkdir: (path) => request('/api/files/mkdir', { method: 'POST', body: { path } }),
    remove: (path) => request(`/api/files${buildQuery({ path })}`, { method: 'DELETE' }),
    upload: (file, dir = '.', opts = {}) => uploadFile(file, dir, opts),
  },

  figures: {
    list: () => request('/api/figures', { quiet: true }),
    url: (fig) => {
      if (!fig) return '';
      if (typeof fig === 'string') {
        return /^(https?:|\/)/i.test(fig) ? fig : `/api/figures/${encodeURIComponent(fig)}`;
      }
      if (fig.url) return fig.url;
      return `/api/figures/${encodeURIComponent(fig.name || '')}`;
    },
    remove: (name) => request(`/api/figures/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  },

  jobs: {
    list: () => request('/api/jobs', { quiet: true }),
    create: (payload) => request('/api/jobs', { method: 'POST', body: payload }),
    log: (id, offset = 0) =>
      request(`/api/jobs/${encodeURIComponent(id)}/log${buildQuery({ offset })}`, {
        quiet: true,
        timeout: 15000,
      }),
    cancel: (id) => request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  },

  skills: {
    list: () => request('/api/skills'),
    get: (name) => request(`/api/skills/${encodeURIComponent(name)}`),
  },

  memory: {
    list: () => request('/api/memory'),
    get: (slug) => request(`/api/memory/${encodeURIComponent(slug)}`),
    save: (slug, payload) =>
      request(`/api/memory/${encodeURIComponent(slug)}`, { method: 'PUT', body: payload }),
    remove: (slug) => request(`/api/memory/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  },

  settings: {
    get: () => request('/api/settings', { timeout: 20000 }),
    update: (patch) => request('/api/settings', { method: 'PUT', body: { patch } }),
    // Atomic key + provider/model/api_base save (CONTRACTS-2 §3.3).
    saveKeys: (payload) => request('/api/settings/keys', { method: 'POST', body: payload || {} }),
    // Live connection test for the values currently typed in the form, saved or not (§3.4).
    testLLM: (payload) =>
      request('/api/settings/test_llm', {
        method: 'POST',
        body: payload || {},
        timeout: 60000,
        quiet: true,
      }),
    testVision: (payload) =>
      request('/api/settings/test_vision', {
        method: 'POST',
        body: payload || {},
        timeout: 90000,
        quiet: true,
      }),
    setVision: (payload) =>
      request('/api/settings/vision', { method: 'POST', body: payload || {} }),
  },

  discovery: {
    listProjects: () => request('/api/discovery/projects', { quiet: true }),
    createProject: (payload) =>
      request('/api/discovery/projects', { method: 'POST', body: payload || {} }),
    getProject: (id) => request(`/api/discovery/projects/${encodeURIComponent(id)}`),
    removeProject: (id) =>
      request(`/api/discovery/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    stopRun: (id) =>
      request(`/api/discovery/projects/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        body: {},
        quiet: true,
      }),
    report: (id, opts = {}) =>
      request(`/api/discovery/projects/${encodeURIComponent(id)}/report`, opts),
    ledger: (id, kind = 'hypotheses') =>
      request(
        `/api/discovery/projects/${encodeURIComponent(id)}/ledger${buildQuery({ kind })}`,
        { timeout: 30000 },
      ),
    addHypothesis: (id, payload) =>
      request(`/api/discovery/projects/${encodeURIComponent(id)}/hypotheses`, {
        method: 'POST',
        body: payload || {},
      }),
    seedStrategies: () =>
      request('/api/discovery/strategies/seed', { method: 'POST', body: {} }),
    runUrl: (id) => `/api/discovery/projects/${encodeURIComponent(id)}/run`,
  },

  registry: {
    search: (q, limit = 30) => request(`/api/registry/search${buildQuery({ q, limit })}`),
    modules: () => request('/api/registry/modules', { quiet: true }),
    func: (name) => request(`/api/registry/function${buildQuery({ name })}`),
    // Rebuilding the index may take ~30s on a cold import, so allow a long timeout.
    refresh: (packages) =>
      request('/api/registry/refresh', {
        method: 'POST',
        body: Array.isArray(packages) && packages.length ? { packages } : {},
        timeout: 180000,
      }),
  },
};

/* ------------------------------------------------------------------ */
/* Multipart upload with progress                                      */
/* ------------------------------------------------------------------ */

function uploadFile(file, dir, { signal, onProgress, workspaceId } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('dir', dir || '.');
    const xhr = new XMLHttpRequest();
    const url = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/files/upload${buildQuery({dir:dir||'.'})}` : '/api/files/upload';
    xhr.open('POST', url, true);
    xhr.responseType = 'text';

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };
    xhr.onerror = () => reject(new ApiError('上传失败，无法连接后端', { offline: true }));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    xhr.onload = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const env = data && typeof data === 'object' ? data.error || null : null;
        reject(
          new ApiError((env && env.message) || `上传失败（HTTP ${xhr.status}）`, {
            status: xhr.status,
            detail: data,
          }),
        );
      }
    };
    try {
      xhr.send(form);
    } catch (err) {
      reject(err);
    }
  });
}

export default api;
