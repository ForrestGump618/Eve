// Pure utility helpers shared across the SPA.
// No DOM access at module scope so this file can also be imported by Node for tests.

/** Escape text for safe insertion into HTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value destined for an HTML attribute. */
export function escAttr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Normalise a timestamp (seconds or milliseconds) to milliseconds. */
export function tsMs(ts) {
  if (typeof ts === 'string' && /[T:-]/.test(ts) && !/^\d+(\.\d+)?$/.test(ts)) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Full local date-time string, e.g. 2025-03-08 14:05. */
export function fmtTime(ts) {
  const d = new Date(tsMs(ts));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Short local time, e.g. 14:05. */
export function fmtClock(ts) {
  const d = new Date(tsMs(ts));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Relative time in Chinese, falling back to a date for old values. */
export function relTime(ts) {
  const t = tsMs(ts);
  const diff = Date.now() - t;
  if (diff < 0) return fmtClock(t);
  if (diff < 45 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000) || 1} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 3 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString('zh-CN');
}

export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60000)} 分 ${Math.round((n % 60000) / 1000)} 秒`;
}

export function debounce(fn, wait = 150) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Throttle a function to at most one call per animation frame. */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  const run = () => {
    scheduled = false;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };
  const wrapped = (...args) => {
    lastArgs = args;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(run);
    }
  };
  wrapped.cancel = () => {
    scheduled = false;
    lastArgs = null;
  };
  return wrapped;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let uidSeq = 0;
export function uid(prefix = 'id') {
  uidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidSeq}`;
}

export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/**
 * Turn tool/API payloads into a short, readable line. Raw JSON remains
 * available through an explicit technical-details disclosure.
 */
export function summarizeValue(value, max = 220) {
  let current = value;
  if (typeof current === 'string') {
    const text = current.trim();
    if (!text) return '无输出';
    if (/^[{[]/.test(text)) {
      try {
        current = JSON.parse(text);
      } catch {
        return truncate(text.split(/\r?\n/, 1)[0], max);
      }
    } else {
      return truncate(text.split(/\r?\n/, 1)[0], max);
    }
  }
  if (current == null) return '无输出';
  if (typeof current !== 'object') return truncate(String(current), max);
  if (Array.isArray(current)) {
    const first = current.length
      ? summarizeValue(current[0], Math.max(40, Math.floor(max / 2)))
      : '';
    return truncate(`${current.length} 项${first ? ` · ${first}` : ''}`, max);
  }
  const source = current;
  const keys = ['summary', 'message', 'title', 'status', 'text', 'content', 'output', 'stdout', 'stderr', 'result', 'value', 'path', 'file'];
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === 'string' && candidate.trim() && !/^[{[]/.test(candidate.trim())) {
      return truncate(candidate.trim().split(/\r?\n/, 1)[0], max);
    }
  }
  if (source.metrics && typeof source.metrics === 'object' && !Array.isArray(source.metrics)) {
    const metrics = Object.entries(source.metrics)
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .slice(0, 4)
      .map(([key, value]) => `${key} ${value}`);
    if (metrics.length) return truncate(`指标 · ${metrics.join(' · ')}`, max);
  }
  if (Array.isArray(source.items)) return truncate(`${source.items.length} 项结果`, max);
  if (Array.isArray(source.rows)) {
    const columns = Array.isArray(source.columns) ? ` · ${source.columns.length} 列` : '';
    return truncate(`${source.rows.length} 行${columns}`, max);
  }
  if (source.count != null) return truncate(`${source.count} 项结果`, max);
  const fields = Object.keys(source).filter((key) => source[key] != null);
  return fields.length ? `${fields.length} 个字段` : '无输出';
}

export function prettyValue(value, max = 200_000) {
  if (value == null || value === '') return '';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return truncate(text, max);
  } catch {
    return truncate(String(value), max);
  }
}

export function extOf(name) {
  const s = String(name ?? '');
  const base = s.split(/[\\/]/).pop() || '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx).toLowerCase() : '';
}

export function baseName(path) {
  const s = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return s.split('/').pop() || '';
}

export function dirName(path) {
  const s = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(0, idx) || '.' : '.';
}

export function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 20));
}

/** Only allow safe URL schemes / relative paths through. */
export function safeUrl(url, { allowDataImage = false } = {}) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.startsWith('javascript:') || low.startsWith('vbscript:')) return null;
  if (low.startsWith('data:')) {
    return allowDataImage && /^data:image\//i.test(s) ? s : null;
  }
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s.startsWith('#')) return s;
  // Anything that is not an explicit scheme is treated as a relative path.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  return null;
}

/** RFC4180-ish delimited text parser (handles quotes, CRLF, embedded newlines). */
export function parseDelimited(text, delimiter = ',', maxRows = 5000) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else if (ch === '\r') {
      // handled together with \n; bare \r is ignored
    } else {
      field += ch;
    }
  }
  if (rows.length < maxRows && (field !== '' || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  // Drop a trailing empty row produced by the final newline.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

/** Trigger a client-side text download. */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const PREFIX = 'omicslab.';

/**
 * Coerce backend-provided display values into safe, readable text.
 *
 * Python repr artifacts such as "<bound method Path.cwd ...>" or
 * "<object at 0x...>" must never be shown to the user as a real path, so they
 * are dropped instead of rendered.
 */
export function cleanValue(value, max = 240) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!text) return '';
  if (text.startsWith('<') || /<bound method|<function |object at 0x/i.test(text)) return '';
  return truncate(text, max);
}

export function getPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode); settings simply do not persist */
  }
}

export function removePref(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Copy text to clipboard with a DOM fallback for non-secure contexts. */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Human-readable shape array, e.g. "1000 × 2000". */
export function fmtShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) return '—';
  return shape.map((v) => (v === null || v === undefined ? '?' : String(v))).join(' × ');
}
