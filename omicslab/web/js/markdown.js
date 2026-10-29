// Lightweight, dependency-free markdown renderer for chat / skills / memory bodies.
// Everything is HTML-escaped first; generated tags are inserted only by this module,
// which keeps model output and user text inert (no raw HTML passthrough).

import { esc, safeUrl } from './util.js?v=2.1.1';
import { icon } from './icons.js?v=2.1.1';

const FENCE_RE = /^(\s*)(```+|~~~+)\s*([A-Za-z0-9_+.#-]{0,20})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:[-*_]\s*){3,}$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** Render inline markdown (bold, italic, strike, code, links). */
export function renderInline(text) {
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;

  // 1) Inline code spans are extracted first so their content is never re-parsed.
  let src = String(text ?? '');
  src = src.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, code) => {
    return stash(`<code class="md-inline-code">${esc(code.replace(/^ | $/g, ''))}</code>`);
  });

  // 2) Escape everything that remains.
  src = esc(src);

  // 3) Links: [label](url)
  src = src.replace(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/g, (m, label, rawUrl) => {
    const raw=decodeEntities(rawUrl).replace(/^<|>$/g,'');
    if(raw.startsWith('eve-artifact:')){
      let path;try{path=decodeURIComponent(raw.slice(13));}catch{return m;}
      if(!path||path.length>2000||!/\.html?$/i.test(path)||/[\0\r\n]/.test(path))return m;
      return stash(`<button type="button" class="artifact-card" data-artifact-path="${esc(path)}">${icon('file',{size:18})}<span><strong>${renderInline(label)}</strong><small>交互页面 · 点击查看</small></span>${icon('chevronRight',{size:16})}</button>`);
    }
    const url = safeUrl(raw);
    if (!url) return m;
    return stash(linkHtml(url, renderInline(label)));
  });

  // 4) Bare URLs (http/https only).
  src = src.replace(/https?:\/\/[^\s<>"'`)\]]+/g, (m) => {
    let url = m;
    let tail = '';
    while (/[.,;:!?]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    return stash(linkHtml(url, esc(url))) + tail;
  });

  // 5) Emphasis. Tokens contain no markup characters so these cannot cross them.
  src = src.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  src = src.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  src = src.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  src = src.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

  // 6) Restore protected fragments.
  return src.replace(/\u0000(\d+)\u0000/g, (_m, idx) => tokens[Number(idx)] ?? '');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function linkHtml(url, innerHtml) {
  const external = /^https?:/i.test(url);
  return (
    `<a class="md-link" href="${esc(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>` +
    `${innerHtml}</a>`
  );
}

/** Render a full markdown document to an HTML string. */
export function renderMarkdown(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  return renderBlocks(lines);
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2][0];
      const lang = fence[3] || '';
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = lines[i].match(FENCE_RE);
        if (close && close[2][0] === marker) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      const rawBody = body.join('\n');
      out.push(lang === 'json' ? (jsonSummaryHtml(rawBody) || codeBlockHtml(rawBody, lang)) : codeBlockHtml(rawBody, lang));
      continue;
    }

    // Heading
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      out.push('<hr class="md-hr">');
      i += 1;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(lines[i].match(QUOTE_RE)[1]);
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(body)}</blockquote>`);
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const c = cell.trim();
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(tableHtml(head, aligns, rows));
      continue;
    }

    // Lists
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const raw = lines[i];
        const ul = raw.match(UL_RE);
        const ol = raw.match(OL_RE);
        if (ul || ol) {
          const m = ul || ol;
          const indent = m[1].replace(/\t/g, '    ').length;
          items.push({ indent, ordered: Boolean(ol), text: (ul ? m[2] : m[3]) || '' });
          i += 1;
          continue;
        }
        // Continuation line of the previous item (indented, non-blank, not a new block)
        if (
          raw.trim() &&
          /^\s{2,}/.test(raw) &&
          items.length &&
          !FENCE_RE.test(raw) &&
          !HEADING_RE.test(raw) &&
          !QUOTE_RE.test(raw)
        ) {
          items[items.length - 1].text += `\n${raw.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(renderListItems(items));
      continue;
    }

    // Paragraph: consume until blank line or the start of another block.
    const para = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim()) break;
      if (
        FENCE_RE.test(raw) ||
        HEADING_RE.test(raw) ||
        HR_RE.test(raw) ||
        QUOTE_RE.test(raw) ||
        UL_RE.test(raw) ||
        OL_RE.test(raw) ||
        (raw.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
      ) {
        break;
      }
      para.push(raw.trim());
      i += 1;
    }
    if (para.length) {
      out.push(`<p class="md-p">${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('\n');
}

function codeBlockHtml(code, lang) {
  const safeLang = /^[A-Za-z0-9_+.#-]{1,20}$/.test(lang) ? lang : '';
  return (
    '<div class="md-code">' +
    '<div class="md-code-head">' +
    `<span class="md-code-lang">${esc(safeLang || 'text')}</span>` +
    `<button type="button" class="md-code-copy code-copy" title="复制代码" aria-label="复制代码">${icon('copy', { size: 13 })}<span>复制</span></button>` +
    '</div>' +
    `<pre class="md-pre"><code class="md-code-body${safeLang ? ` language-${esc(safeLang)}` : ''}">${esc(code)}</code></pre>` +
    '</div>'
  );
}

/** Compact, human-readable rendering for fenced JSON in assistant replies. */
function jsonSummaryHtml(code) {
  let value;
  try {
    value = JSON.parse(code);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const valueText = (item) => {
    if (item === null) return 'null';
    if (typeof item === 'object') return JSON.stringify(item).slice(0, 120);
    return String(item).slice(0, 120);
  };
  const rawHtml =
    '<details class="json-summary-raw"><summary>查看原文</summary>' +
    `<pre class="md-pre"><code class="md-code-body language-json">${esc(code)}</code></pre></details>`;
  if (Array.isArray(value)) {
    const total = value.length;
    const preview = value.slice(0, 8);
    if (preview.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      const keys = [...new Set(preview.flatMap((item) => Object.keys(item)))].slice(0, 4);
      const rows = preview
        .map(
          (item, index) =>
            '<tr>' +
            `<td class="json-summary-idx">${index + 1}</td>` +
            keys.map((key) => `<td>${esc(valueText(item[key]))}</td>`).join('') +
            '</tr>',
        )
        .join('');
      return (
        `<div class="json-summary" data-summary-json="true">` +
        `<div class="json-summary-head"><span>结构化结果 · ${total} 条记录</span></div>` +
        '<div class="json-summary-scroll"><table class="json-summary-table"><thead><tr>' +
        '<th></th>' +
        keys.map((key) => `<th>${esc(key)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table></div>' +
        rawHtml +
        '</div>'
      );
    }
    const chips = preview.map((item) => `<span class="json-summary-chip">${esc(valueText(item))}</span>`).join('');
    return (
      `<div class="json-summary" data-summary-json="true">` +
      `<div class="json-summary-head"><span>结构化结果 · ${total} 条记录</span></div>` +
      `<div class="json-summary-chips">${chips || '<span class="json-summary-chip">空数组</span>'}</div>` +
      rawHtml +
      '</div>'
    );
  }
  const entries = Object.entries(value).slice(0, 8);
  const rows = entries
    .map(
      ([key, item]) =>
        `<div class="json-summary-kv"><span>${esc(key)}</span><strong>${esc(valueText(item))}</strong></div>`,
    )
    .join('');
  return (
    `<div class="json-summary" data-summary-json="true">` +
    `<div class="json-summary-head"><span>结构化结果 · ${entries.length} 个字段</span></div>` +
    `<div class="json-summary-kvs">${rows}</div>` +
    rawHtml +
    '</div>'
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on pipes that are not escaped as \|
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function tableHtml(head, aligns, rows) {
  const alignAttr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '');
  const thead =
    '<thead><tr>' +
    head.map((c, idx) => `<th${alignAttr(idx)}>${renderInline(c)}</th>`).join('') +
    '</tr></thead>';
  const tbody =
    '<tbody>' +
    rows
      .map(
        (cells) =>
          '<tr>' +
          head
            .map((_h, idx) => `<td${alignAttr(idx)}>${renderInline(cells[idx] ?? '')}</td>`)
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody>';
  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

function renderListItems(items) {
  if (!items.length) return '';
  let html = '';
  const stack = []; // {indent, ordered}
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) {
      html += `</li>${stack.pop().ordered ? '</ol>' : '</ul>'}`;
    }
    if (stack.length && item.indent === stack[stack.length - 1].indent) {
      const top = stack[stack.length - 1];
      if (top.ordered !== item.ordered) {
        html += `</li>${stack.pop().ordered ? '</ol>' : '</ul>'}`;
        stack.push({ indent: item.indent, ordered: item.ordered });
        html += item.ordered ? '<ol class="md-list">' : '<ul class="md-list">';
      } else {
        html += '</li>';
      }
    } else {
      stack.push({ indent: item.indent, ordered: item.ordered });
      html += item.ordered ? '<ol class="md-list">' : '<ul class="md-list">';
    }
    html += `<li>${renderInline(item.text).replace(/\n/g, '<br>')}`;
  }
  while (stack.length) {
    html += `</li>${stack.pop().ordered ? '</ol>' : '</ul>'}`;
  }
  return html;
}

/** Strip markdown to a plain-text preview (used by lists / command palette). */
export function markdownToText(text, max = 160) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s-]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
