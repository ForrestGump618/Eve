// Server-Sent Events client for POST endpoints (POST /api/chat, POST /api/discovery/.../run).
// EventSource cannot POST, so the stream is read manually from fetch + ReadableStream.
// Wire format (CONTRACTS.md): each event is one `data: <json>\n\n` line whose JSON is
// an envelope {type, data, ts}.

import { ApiError } from './api.js?v=1.4.0';
import { sleep } from './util.js?v=1.4.0';

/** Parse one raw SSE block (text between blank lines) into a normalised envelope. */
export function parseEventBlock(block) {
  const lines = String(block).split(/\r?\n/);
  const dataLines = [];
  let eventName = '';
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return { type: 'done', data: {}, ts: Date.now() };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: '__raw__', data: { raw }, ts: Date.now() };
  }
  return normalizeEvent(parsed, eventName);
}

function normalizeEvent(parsed, eventName = '') {
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object') {
    return { type: eventName || 'message', data: { delta: String(parsed) }, ts: Date.now() };
  }
  let type = parsed.type || parsed.event || eventName || '';
  let data = parsed.data;
  const ts = parsed.ts ?? Date.now();
  if (!type) {
    // Tolerate backends that send flat payloads; explicit contract uses envelope form.
    type = 'message';
    data = parsed;
  }
  if (data === undefined || data === null) {
    data = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'type' || key === 'event' || key === 'ts') continue;
      data[key] = value;
    }
  } else if (typeof data !== 'object') {
    data = { delta: String(data) };
  } else {
    data = { ...data };
  }
  return { type, data, ts: Number(ts) || Date.now() };
}

async function readErrorResponse(res) {
  let body = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  // Error envelopes vary by backend version:
  //   {error:{message,code,...}}                       (flat, CONTRACTS-3 §1)
  //   {detail:{error:{message,code,run_id,...}}}       (FastAPI HTTPException)
  let env = null;
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') env = body.error;
    else if (body.detail && typeof body.detail === 'object') {
      env = body.detail.error && typeof body.detail.error === 'object' ? body.detail.error : body.detail;
    }
  }
  const stringDetail = typeof body?.detail === 'string' ? body.detail : '';
  const message =
    (env && (env.message || env.detail)) || stringDetail || `流式请求失败（HTTP ${res.status}）`;
  return new ApiError(message, {
    status: res.status,
    code: (env && env.code) || '',
    detail: env || stringDetail || body,
  });
}

/**
 * POST an arbitrary SSE endpoint and consume the event stream.
 * `opts.method = 'GET'` subscribes to a replayable GET stream (trace events).
 *
 * @param {string} url absolute API path, e.g. '/api/chat'
 * @param {object|null} payload request body (JSON), ignored for GET
 * @param {{signal?: AbortSignal, onEvent?: (ev: {type: string, data: any, ts: number}) => void,
 *          onOpen?: () => void, method?: 'GET'|'POST', headers?: object,
 *          retries?: number, onRetry?: (info: {attempt: number, delay: number, error: Error}) => void}} [opts]
 * @returns {Promise<{received: number, completed: boolean, aborted: boolean, error: Error|null}>}
 */
export async function streamSSE(url, payload, opts = {}) {
  const { signal, onEvent, onOpen, method = 'POST', headers = {}, retries = 0, onRetry } = opts;
  let received = 0;
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    if (signal && signal.aborted) return { received, completed: false, aborted: true, error: null };
    try {
      const result = await runSSE(url, payload, {
        signal,
        method,
        headers,
        onOpen,
        onEvent: (ev) => {
          received += 1;
          if (onEvent) onEvent(ev);
        },
      });
      return { received, completed: result.completed, aborted: result.aborted, error: null };
    } catch (err) {
      lastError = err;
      const aborted = Boolean(signal && signal.aborted) || err?.name === 'AbortError';
      if (aborted) return { received, completed: false, aborted: true, error: null };
      // Retrying after content has been received would duplicate server-side output,
      // so the single automatic retry is only allowed for a connection that never started.
      if (received > 0 || attempt >= retries) break;
      attempt += 1;
      const delay = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      if (onRetry) onRetry({ attempt, delay, error: err });
      await sleep(delay);
    }
  }
  return { received, completed: false, aborted: false, error: lastError };
}

/** POST /api/chat and consume the assistant stream (one automatic retry on cold connection). */
export function streamChat(payload, opts = {}) {
  return streamSSE('/api/chat', payload, { retries: 1, ...opts });
}

/**
 * Subscribe to a replayable trace event stream (CONTRACTS-3 §3):
 * GET /api/traces/{trace_id}/events?after_seq=N — server replays history first,
 * then streams live events plus periodic heartbeat frames.
 */
export function streamTrace(url, opts = {}) {
  return streamSSE(url, null, { method: 'GET', retries: 0, ...opts });
}

async function runSSE(url, payload, { signal, onEvent, onOpen, method = 'POST', headers = {} }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const connectTimer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, 120000);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const init = {
    method,
    headers:
      method === 'GET'
        ? { Accept: 'text/event-stream', ...headers }
        : { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    signal: ctrl.signal,
  };
  if (method !== 'GET') init.body = JSON.stringify(payload || {});
  else init.cache = 'no-store';

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(connectTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (timedOut) throw new ApiError('连接后端超时，请稍后重试', { offline: true });
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('无法连接后端服务，请检查服务是否运行', { offline: true });
  }
  clearTimeout(connectTimer);

  if (!res.ok) {
    if (signal) signal.removeEventListener('abort', onAbort);
    throw await readErrorResponse(res);
  }
  if (!res.body) {
    if (signal) signal.removeEventListener('abort', onAbort);
    throw new ApiError('后端未返回可读流（浏览器或代理不支持流式响应）', { status: res.status });
  }
  if (onOpen) {
    try {
      onOpen();
    } catch {
      /* non-fatal */
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;
  let aborted = false;

  const dispatch = (block) => {
    const ev = parseEventBlock(block);
    if (!ev) return;
    if (ev.type === 'done') sawDone = true;
    onEvent(ev);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) dispatch(block);
        idx = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } catch (err) {
    if (signal && signal.aborted) {
      aborted = true;
    } else {
      throw err instanceof ApiError
        ? err
        : new ApiError('流式连接中断，已保留已接收内容', { detail: String(err?.message || err) });
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }

  return { completed: sawDone, aborted };
}
