/* SuWen markdown renderer - deliberately small, safe subset for COMPLETED assistant
   messages only. Streaming text stays plain text (see ui/app.js).

   Safety contract:
   - never uses innerHTML / insertAdjacentHTML / outerHTML; every string becomes a text node
   - raw HTML in the source is rendered as literal text, never parsed
   - links render only for absolute http(s) URLs; anything else stays plain text
   - LaTeX and Mermaid are NOT rendered; they degrade to a labelled code block
   - tables and code blocks always sit inside overflow containers (CSS)

   The tokenizer (parse) is DOM-free; render(doc, text) needs a document-like object with
   createElement/createTextNode/createDocumentFragment. Loaded as a classic script before
   app.js, so it attaches SuwenMarkdown to globalThis.
*/
(function (root) {
  'use strict';

  var MAX_CHARS = 200000;
  var FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  var HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  var HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var QUOTE = /^\s*>\s?(.*)$/;
  var UL = /^\s*[-*+]\s+(.*)$/;
  var OL = /^\s*\d+[.)]\s+(.*)$/;
  var TABLE_ROW = /^\s*\|.*\|\s*$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;
  var MATH_FENCE = /^\s*\$\$\s*$/;
  var MATH_LINE = /^\s*\$\$\s*(.+?)\s*\$\$\s*$/;
  var BRACKET_MATH = /^\s*\\\[\s*$/;
  var BRACKET_MATH_END = /^\s*\\\]\s*$/;

  function splitLines(text) {
    return String(text).replace(/\r\n?/g, '\n').split('\n');
  }

  function isBlockStart(line) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) ||
      UL.test(line) || OL.test(line) || TABLE_ROW.test(line) || MATH_FENCE.test(line) ||
      MATH_LINE.test(line) || BRACKET_MATH.test(line);
  }

  function splitTableRow(line) {
    var body = line.trim();
    if (body.charAt(0) === '|') body = body.slice(1);
    if (body.charAt(body.length - 1) === '|') body = body.slice(0, -1);
    return body.split('|').map(function (cell) { return cell.trim(); });
  }

  function isTableSeparator(line) {
    return TABLE_SEP.test(line) && line.indexOf('-') >= 0;
  }

  /* Pure tokenizer: returns a block list. No DOM access. */
  function parse(text) {
    var source = String(text == null ? '' : text);
    var lines = splitLines(source);
    var blocks = [];
    var index = 0;
    while (index < lines.length) {
      var line = lines[index];
      if (line.trim() === '') { index += 1; continue; }

      var fence = line.match(FENCE);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = (fence[2] || '').trim();
        var code = [];
        index += 1;
        while (index < lines.length && lines[index].trim().indexOf(marker.repeat(3)) !== 0) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        var lowered = lang.toLowerCase();
        if (lowered === 'mermaid') {
          blocks.push({ type: 'diagram', lang: 'mermaid', text: code.join('\n') });
        } else {
          blocks.push({ type: 'code', lang: lang || 'text', text: code.join('\n') });
        }
        continue;
      }

      if (MATH_FENCE.test(line) || BRACKET_MATH.test(line)) {
        var mathEnd = MATH_FENCE.test(line) ? MATH_FENCE : BRACKET_MATH_END;
        var math = [];
        index += 1;
        while (index < lines.length && !mathEnd.test(lines[index])) {
          math.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push({ type: 'math', text: math.join('\n') });
        continue;
      }

      var inlineMath = line.match(MATH_LINE);
      if (inlineMath) {
        blocks.push({ type: 'math', text: inlineMath[1] });
        index += 1;
        continue;
      }

      var heading = line.match(HEADING);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
        index += 1;
        continue;
      }

      if (HR.test(line)) {
        blocks.push({ type: 'hr' });
        index += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (index < lines.length) {
          var quoteMatch = lines[index].match(QUOTE);
          if (!quoteMatch) break;
          quoted.push(quoteMatch[1]);
          index += 1;
        }
        blocks.push({ type: 'quote', text: quoted.join('\n') });
        continue;
      }

      var unordered = line.match(UL);
      var ordered = line.match(OL);
      if (unordered || ordered) {
        var isOrdered = Boolean(ordered);
        var items = [];
        var matcher = isOrdered ? OL : UL;
        while (index < lines.length) {
          var item = lines[index].match(matcher);
          if (!item) break;
          items.push(item[1]);
          index += 1;
        }
        blocks.push({ type: 'list', ordered: isOrdered, items: items });
        continue;
      }

      if (TABLE_ROW.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        var header = splitTableRow(line);
        var rows = [];
        index += 2;
        while (index < lines.length && TABLE_ROW.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        blocks.push({ type: 'table', header: header, rows: rows });
        continue;
      }

      var paragraph = [];
      while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      if (paragraph.length === 0) {
        /* A block-looking line that did not form a block (for example a lone '|')
           must still make progress instead of looping forever. */
        paragraph.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    }
    return blocks;
  }

  function isSafeUrl(url) {
    return /^https?:\/\//i.test(url);
  }

  function renderInline(doc, text) {
    var nodes = [];
    var source = String(text == null ? '' : text);
    var pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\\\([^)]*\\\)|\[[^\]\n]*\]\([^)\s]*\)|\*[^*\n]+\*|_[^_\n]+_)/g;
    var last = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      if (match.index > last) nodes.push(doc.createTextNode(source.slice(last, match.index)));
      var token = match[0];
      if (token.indexOf('**') === 0 && token.length > 4) {
        var strong = doc.createElement('strong');
        strong.textContent = token.slice(2, -2);
        nodes.push(strong);
      } else if (token.indexOf('__') === 0 && token.length > 4) {
        var strongU = doc.createElement('strong');
        strongU.textContent = token.slice(2, -2);
        nodes.push(strongU);
      } else if (token.charAt(0) === '`' && token.length > 2) {
        var code = doc.createElement('code');
        code.className = 'md-inline-code';
        code.textContent = token.slice(1, -1);
        nodes.push(code);
      } else if (token.indexOf('\\(') === 0) {
        var math = doc.createElement('code');
        math.className = 'md-inline-code md-math';
        math.title = 'LaTeX is not rendered';
        math.textContent = token.slice(2, -2);
        nodes.push(math);
      } else if (token.charAt(0) === '[') {
        var linkMatch = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(token);
        if (linkMatch && isSafeUrl(linkMatch[2])) {
          var anchor = doc.createElement('a');
          anchor.className = 'md-link';
          anchor.href = linkMatch[2];
          anchor.target = '_blank';
          anchor.rel = 'noreferrer noopener';
          anchor.textContent = linkMatch[1] || linkMatch[2];
          nodes.push(anchor);
        } else {
          nodes.push(doc.createTextNode(token));
        }
      } else if (token.indexOf('**') !== 0 && token.length > 2 && (token.charAt(0) === '*' || token.charAt(0) === '_')) {
        var em = doc.createElement('em');
        em.textContent = token.slice(1, -1);
        nodes.push(em);
      } else {
        nodes.push(doc.createTextNode(token));
      }
      last = pattern.lastIndex;
    }
    if (last < source.length) nodes.push(doc.createTextNode(source.slice(last)));
    return nodes;
  }

  function appendInline(node, doc, text) {
    var children = renderInline(doc, text);
    for (var index = 0; index < children.length; index += 1) node.appendChild(children[index]);
    return node;
  }

  function renderCodeBlock(doc, label, text, options) {
    var opts = options || {};
    var wrap = doc.createElement('div');
    wrap.className = 'md-code-block';
    var head = doc.createElement('div');
    head.className = 'md-code-head';
    var labelNode = doc.createElement('span');
    labelNode.className = 'md-code-label';
    labelNode.textContent = label;
    head.appendChild(labelNode);
    if (opts.onCopy && opts.copyLabel) {
      /* Copy is a UI affordance only: the text never leaves the renderer and the
         renderer stays dependency free (clipboard access is injected by app.js). */
      var copy = doc.createElement('button');
      copy.type = 'button';
      copy.className = 'md-copy';
      copy.textContent = opts.copyLabel;
      copy.addEventListener('click', function () {
        var pending = null;
        try { pending = opts.onCopy(text); } catch (error) { pending = null; }
        if (!pending || typeof pending.then !== 'function') return;
        pending.then(function (ok) {
          if (!ok) return;
          copy.textContent = opts.copiedLabel || opts.copyLabel;
          copy.disabled = true;
        }).catch(function () { /* clipboard refusal stays silent; text is still selectable */ });
      });
      head.appendChild(copy);
    }
    var scroll = doc.createElement('div');
    scroll.className = 'md-code-scroll';
    var pre = doc.createElement('pre');
    var code = doc.createElement('code');
    code.textContent = text;
    pre.appendChild(code);
    scroll.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(scroll);
    return wrap;
  }

  function renderTable(doc, block) {
    var scroll = doc.createElement('div');
    scroll.className = 'md-table-scroll';
    var table = doc.createElement('table');
    table.className = 'md-table';
    var thead = doc.createElement('thead');
    var headRow = doc.createElement('tr');
    for (var h = 0; h < block.header.length; h += 1) {
      var th = doc.createElement('th');
      th.textContent = block.header[h];
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = doc.createElement('tbody');
    for (var r = 0; r < block.rows.length; r += 1) {
      var row = doc.createElement('tr');
      for (var c = 0; c < block.rows[r].length; c += 1) {
        var td = doc.createElement('td');
        td.textContent = block.rows[r][c];
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    return scroll;
  }

  function renderBlock(doc, fragment, block, options) {
    if (block.type === 'heading') {
      var level = Math.min(6, Math.max(3, block.level + 2));
      var heading = doc.createElement('h' + level);
      heading.className = 'md-heading';
      fragment.appendChild(appendInline(heading, doc, block.text));
      return;
    }
    if (block.type === 'paragraph') {
      var paragraph = doc.createElement('p');
      paragraph.className = 'md-paragraph';
      fragment.appendChild(appendInline(paragraph, doc, block.text));
      return;
    }
    if (block.type === 'code') {
      fragment.appendChild(renderCodeBlock(doc, block.lang, block.text, options));
      return;
    }
    if (block.type === 'diagram') {
      fragment.appendChild(renderCodeBlock(doc, 'mermaid (not rendered)', block.text, options));
      return;
    }
    if (block.type === 'math') {
      fragment.appendChild(renderCodeBlock(doc, 'latex (not rendered)', block.text, options));
      return;
    }
    if (block.type === 'list') {
      var list = doc.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      for (var item = 0; item < block.items.length; item += 1) {
        var li = doc.createElement('li');
        list.appendChild(appendInline(li, doc, block.items[item]));
      }
      fragment.appendChild(list);
      return;
    }
    if (block.type === 'table') {
      fragment.appendChild(renderTable(doc, block));
      return;
    }
    if (block.type === 'quote') {
      var quote = doc.createElement('blockquote');
      quote.className = 'md-quote';
      var quoteParagraph = doc.createElement('p');
      quote.appendChild(appendInline(quoteParagraph, doc, block.text));
      fragment.appendChild(quote);
      return;
    }
    if (block.type === 'hr') {
      fragment.appendChild(doc.createElement('hr'));
    }
  }

  /* DOM renderer for completed messages. Returns a DocumentFragment. */
  function render(doc, text, options) {
    var opts = options || {};
    var fragment = doc.createDocumentFragment();
    var source = String(text == null ? '' : text);
    var limit = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : MAX_CHARS;
    if (source.length > limit) {
      var fallback = doc.createElement('div');
      fallback.className = 'md-fallback';
      var note = doc.createElement('p');
      note.className = 'md-paragraph';
      note.textContent = source.slice(0, limit);
      var hint = doc.createElement('p');
      hint.className = 'md-paragraph md-muted';
      hint.textContent = '(message truncated: ' + source.length + ' characters; rendered as plain text)';
      fallback.appendChild(note);
      fallback.appendChild(hint);
      return fallback;
    }
    var blocks = parse(source);
    for (var index = 0; index < blocks.length; index += 1) {
      renderBlock(doc, fragment, blocks[index], opts);
    }
    return fragment;
  }

  var api = { MAX_CHARS: MAX_CHARS, parse: parse, render: render, isSafeUrl: isSafeUrl };
  if (root) root.SuwenMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
