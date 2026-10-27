/* Eve markdown renderer - deliberately small, safe subset. Completed messages use render();
   streaming messages use planProgressive()/renderProgressivePlan(), which typeset only closed
   blocks and keep the still-open tail as plain text (see ui/app.js).

   Safety contract:
   - never uses innerHTML / insertAdjacentHTML / outerHTML; every string becomes a text node,
     and the only generated markup is built with createElement/textContent
   - raw HTML in the source is rendered as literal text, never parsed
   - links render only for absolute http(s) URLs; anything else stays plain text
   - LaTeX ($..$, $$..$$, \(..\), \[..\]) is rendered by the bundled offline KaTeX build when
     it is available; until then (or on error) the raw source stays visible as text
   - Mermaid fenced blocks are rendered by the bundled offline mermaid build, each in its own
     container; unclosed / oversized / failing diagrams fall back to a labelled code block
   - vendor scripts are loaded lazily from vendor/ (same-origin file, CSP 'self') at most once,
     one render per turn of the event loop so a large message never blocks the main thread
   - tables and code blocks always sit inside overflow containers (CSS)

   The tokenizer (parse / scanInlineMath / analyze) is DOM-free; render(doc, text) needs a
   document-like object with createElement/createTextNode/createDocumentFragment. Loaded as a
   classic script before app.js, so it attaches EveMarkdown to globalThis.
*/
(function (root) {
  'use strict';

  var MAX_CHARS = 200000;
  /* Per-expression caps: one pathological formula or diagram must not stall the renderer. */
  var MAX_MATH_CHARS = 4000;
  var MAX_DIAGRAM_CHARS = 20000;
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

  function shouldRenderMath(source) {
    var text = String(source == null ? '' : source).trim();
    return text.length > 0 && text.length <= MAX_MATH_CHARS;
  }

  function shouldRenderDiagram(source) {
    var text = String(source == null ? '' : source);
    return text.trim().length > 0 && text.length <= MAX_DIAGRAM_CHARS;
  }

  /* Pure tokenizer: returns a block list. No DOM access.
     Fenced code / diagram / block-math blocks carry closed:false when the closing delimiter
     has not been seen yet (the message is still streaming); callers must not hand those to
     the async renderers. */
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
        var closed = index < lines.length;
        if (closed) index += 1;
        var lowered = lang.toLowerCase();
        if (lowered === 'mermaid') {
          blocks.push({ type: 'diagram', lang: 'mermaid', text: code.join('\n'), closed: closed });
        } else {
          blocks.push({ type: 'code', lang: lang || 'text', text: code.join('\n'), closed: closed });
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
        var mathClosed = index < lines.length;
        if (mathClosed) index += 1;
        blocks.push({ type: 'math', display: true, text: math.join('\n'), closed: mathClosed });
        continue;
      }

      var inlineMath = line.match(MATH_LINE);
      if (inlineMath) {
        blocks.push({ type: 'math', display: true, text: inlineMath[1], closed: true });
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

  /* Pure streaming analysis: `open` means at least one fenced block (code, mermaid or block
     math) is still waiting for its closing delimiter, so async renderers must stay off. */
  function analyze(text) {
    var blocks = parse(text);
    var openFence = false;
    var openMath = false;
    for (var index = 0; index < blocks.length; index += 1) {
      var block = blocks[index];
      if (block.closed === false) {
        if (block.type === 'math') openMath = true;
        else openFence = true;
      }
    }
    return { blocks: blocks, openFence: openFence, openMath: openMath, open: openFence || openMath };
  }

  /* ---------- progressive (streaming) markdown ----------
     Stable prefixes are the streaming-safe subset: everything up to the last boundary that can
     never change retroactively. A boundary only counts when the line ending it is terminated by
     a newline and it is not inside a fenced block, a block-math block, or a table that has no
     completed body row yet. The remaining tail (partial word, open fence/math, partial table
     row) is handed back as plain text and is NEVER typeset. `parse()` cannot report an open
     block for a stable prefix; planProgressive() double-checks that and degrades to plain text
     if it ever did. */
  function stableScan(source) {
    var text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var stableEnd = 0;
    var mode = 'normal';
    var fenceMarker = '';
    var mathEnd = null;
    var tablePhase = null;
    var offset = 0;
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      var lineEnd = offset + line.length;
      var terminated = index < lines.length - 1; /* a newline follows this line */
      offset = lineEnd + 1;
      if (!terminated) {
        /* A final newline produces one trailing empty line; it belongs to the stable prefix
           immediately (it is not content), but only outside an open block. */
        if (line === '' && mode === 'normal') stableEnd = lineEnd;
        break; /* partial last line: never typeset it */
      }
      if (mode === 'fence') {
        if (line.trim().indexOf(fenceMarker.repeat(3)) === 0) { mode = 'normal'; stableEnd = lineEnd; }
        continue;
      }
      if (mode === 'math') {
        if (mathEnd && mathEnd.test(line)) { mode = 'normal'; stableEnd = lineEnd; }
        continue;
      }
      if (mode === 'table') {
        if (tablePhase === 'separator') {
          if (isTableSeparator(line)) { tablePhase = 'rows'; continue; }
          mode = 'normal'; tablePhase = null; stableEnd = lineEnd;
          continue;
        }
        if (TABLE_ROW.test(line)) { stableEnd = lineEnd; continue; }
        mode = 'normal'; tablePhase = null; stableEnd = lineEnd;
        continue;
      }
      var fence = line.match(FENCE);
      if (fence) { mode = 'fence'; fenceMarker = fence[1].charAt(0); continue; }
      if (MATH_FENCE.test(line)) { mode = 'math'; mathEnd = MATH_FENCE; continue; }
      if (BRACKET_MATH.test(line)) { mode = 'math'; mathEnd = BRACKET_MATH_END; continue; }
      if (TABLE_ROW.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        /* A table only becomes stable after at least one terminated body row (see below). */
        mode = 'table'; tablePhase = 'separator';
        continue;
      }
      stableEnd = lineEnd;
    }
    var stable = text.slice(0, stableEnd);
    return {
      stableChars: stableEnd,
      stable: stable,
      tail: text.slice(stableEnd),
      openKind: mode === 'fence' ? 'fence' : mode === 'math' ? 'math' : mode === 'table' ? 'table' : 'line',
    };
  }

  function stablePrefix(source) {
    return stableScan(source).stable;
  }

  /* Pure progressive plan. `previous` is an earlier plan for a prefix of the same text: when the
     newly scanned stable prefix is unchanged, the previously parsed block list is reused so
     tail-only deltas cost one linear line scan and no tokenization. */
  function planProgressive(source, previous) {
    var text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    var previousStable = previous && typeof previous.stable === 'string' ? previous.stable : '';
    var previousBlocks = previous && Array.isArray(previous.blocks) ? previous.blocks : null;
    var scannedStable = stablePrefix(text);
    var cached = Boolean(previousStable && previousBlocks &&
      scannedStable.length === previousStable.length && text.indexOf(previousStable) === 0);
    var stable = cached ? previousStable : scannedStable;
    var blocks = cached ? previousBlocks : parse(stable);
    if (!cached) {
      for (var index = 0; index < blocks.length; index += 1) {
        if (blocks[index].closed === false) {
          /* Defensive: never proceed with an unstable tokenization. */
          stable = '';
          blocks = [];
          break;
        }
      }
    }
    var tail = text.slice(stable.length);
    return {
      stableChars: stable.length,
      stable: stable,
      tail: tail,
      tailChars: tail.length,
      blocks: blocks,
      open: tail.length > 0,
    };
  }

  function isSafeUrl(url) {
    return /^https?:\/\//i.test(url);
  }

  /* ---------- inline math scanner (DOM-free) ----------
     Splits one inline text run into {type:'text'} / {type:'math'} segments. Rules:
     - $...$ must not cross a newline, must not be empty, cannot open on a space and cannot
       close on a space; $$...$$ never opens an inline span (block delimiters are handled by
       parse) and a lone $ stays literal text
     - \(...\) is math; \$ is a literal dollar and \\ a literal backslash
     - inline code spans (`...`) are copied verbatim and never scanned for math. */
  function findClosingDollar(source, start) {
    var index = start;
    var guard = 0;
    while (index < source.length && guard < MAX_MATH_CHARS + 16) {
      var ch = source.charAt(index);
      if (ch === '\\') { index += 2; guard += 1; continue; }
      if (ch === '\n') return -1;
      if (ch === '$') {
        if (index > start && source.charAt(index - 1) !== ' ' && source.charAt(index - 1) !== '$') return index;
        return -1;
      }
      index += 1;
      guard += 1;
    }
    return -1;
  }

  function scanInlineMath(text) {
    var source = String(text == null ? '' : text);
    var segments = [];
    var buffer = '';
    var index = 0;
    function flush() {
      if (buffer) { segments.push({ type: 'text', text: buffer }); buffer = ''; }
    }
    while (index < source.length) {
      var ch = source.charAt(index);
      if (ch === '\\' && source.charAt(index + 1) === '(') {
        var close = source.indexOf('\\)', index + 2);
        var newline = source.indexOf('\n', index + 2);
        if (close > index + 2 && (newline < 0 || close < newline)) {
          flush();
          segments.push({ type: 'math', text: source.slice(index + 2, close), display: false, closed: true });
          index = close + 2;
          continue;
        }
        buffer += ch;
        index += 1;
        continue;
      }
      if (ch === '\\' && source.charAt(index + 1) === '$') {
        buffer += '$';
        index += 2;
        continue;
      }
      if (ch === '\\' && source.charAt(index + 1) === '\\') {
        buffer += '\\';
        index += 2;
        continue;
      }
      if (ch === '$') {
        var next = source.charAt(index + 1);
        if (next === '$') {
          /* $$ inside running text stays literal; block math is tokenized by parse. */
          buffer += '$$';
          index += 2;
          continue;
        }
        var end = next === ' ' ? -1 : findClosingDollar(source, index + 1);
        if (end > index + 1) {
          flush();
          segments.push({ type: 'math', text: source.slice(index + 1, end), display: false, closed: true });
          index = end + 1;
          continue;
        }
        buffer += ch;
        index += 1;
        continue;
      }
      if (ch === '`') {
        var closeTick = source.indexOf('`', index + 1);
        if (closeTick > index + 1) {
          buffer += source.slice(index, closeTick + 1);
          index = closeTick + 1;
          continue;
        }
      }
      buffer += ch;
      index += 1;
    }
    flush();
    return segments;
  }

  /* Backwards-compatible alias used by unit tests. */
  function extractInlineMath(text) {
    return scanInlineMath(text);
  }

  /* ---------- DOM rendering ---------- */

  function mathPlaceholder(doc, source, display, options) {
    var opts = options || {};
    var node = doc.createElement(display ? 'div' : 'span');
    node.className = display ? 'md-math-block' : 'md-math-inline';
    node.setAttribute('data-math', source);
    node.setAttribute('data-display', display ? '1' : '0');
    var label = doc.createElement('code');
    label.className = 'md-math-source';
    label.textContent = display ? source : ('$' + source + '$');
    if (!shouldRenderMath(source)) {
      node.className += ' md-math-raw';
      node.title = opts.mathFallback || 'LaTeX not rendered';
      node.appendChild(label);
      return node;
    }
    node.title = opts.mathRendering || 'Rendering math...';
    node.appendChild(label);
    return node;
  }

  function diagramPlaceholder(doc, source, options) {
    var opts = options || {};
    var node = doc.createElement('div');
    node.className = 'md-diagram';
    node.setAttribute('data-mermaid', source);
    node.setAttribute('data-display', '1');
    var scroll = doc.createElement('div');
    scroll.className = 'md-diagram-scroll';
    var pre = doc.createElement('pre');
    pre.className = 'md-diagram-source';
    var code = doc.createElement('code');
    code.textContent = source;
    pre.appendChild(code);
    scroll.appendChild(pre);
    node.appendChild(scroll);
    node.title = opts.diagramRendering || 'Rendering diagram...';
    return node;
  }

  function renderInline(doc, text, options) {
    var nodes = [];
    var segments = scanInlineMath(text);
    var pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]*\)|\*[^*\n]+\*|_[^_\n]+_)/g;
    for (var s = 0; s < segments.length; s += 1) {
      var segment = segments[s];
      if (segment.type === 'math') {
        nodes.push(mathPlaceholder(doc, segment.text, false, options));
        continue;
      }
      var source = segment.text;
      var last = 0;
      var match;
      pattern.lastIndex = 0;
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
        } else if (token.charAt(0) === '*' || token.charAt(0) === '_') {
          var em = doc.createElement('em');
          em.textContent = token.slice(1, -1);
          nodes.push(em);
        } else {
          nodes.push(doc.createTextNode(token));
        }
        last = pattern.lastIndex;
      }
      if (last < source.length) nodes.push(doc.createTextNode(source.slice(last)));
    }
    return nodes;
  }

  function appendInline(node, doc, text, options) {
    var children = renderInline(doc, text, options);
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
    var opts = options || {};
    if (block.type === 'heading') {
      var level = Math.min(6, Math.max(3, block.level + 2));
      var heading = doc.createElement('h' + level);
      heading.className = 'md-heading';
      fragment.appendChild(appendInline(heading, doc, block.text, opts));
      return;
    }
    if (block.type === 'paragraph') {
      var paragraph = doc.createElement('p');
      paragraph.className = 'md-paragraph';
      fragment.appendChild(appendInline(paragraph, doc, block.text, opts));
      return;
    }
    if (block.type === 'code') {
      fragment.appendChild(renderCodeBlock(doc, block.lang, block.text, opts));
      return;
    }
    if (block.type === 'diagram') {
      if (block.closed && shouldRenderDiagram(block.text)) {
        fragment.appendChild(diagramPlaceholder(doc, block.text, opts));
      } else {
        var diagramLabel = block.closed
          ? (opts.diagramFallback || 'mermaid (not rendered)')
          : (opts.diagramWaiting || 'mermaid (waiting for closing fence)');
        fragment.appendChild(renderCodeBlock(doc, diagramLabel, block.text, opts));
      }
      return;
    }
    if (block.type === 'math') {
      if (block.closed && shouldRenderMath(block.text)) {
        fragment.appendChild(mathPlaceholder(doc, block.text, Boolean(block.display), opts));
      } else {
        var mathLabel = block.closed
          ? (opts.mathTooLarge || opts.mathFallback || 'latex (not rendered)')
          : (opts.mathWaiting || 'latex (waiting for closing delimiter)');
        fragment.appendChild(renderCodeBlock(doc, mathLabel, block.text, opts));
      }
      return;
    }
    if (block.type === 'list') {
      var list = doc.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      for (var item = 0; item < block.items.length; item += 1) {
        var li = doc.createElement('li');
        list.appendChild(appendInline(li, doc, block.items[item], opts));
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
      quote.appendChild(appendInline(quoteParagraph, doc, block.text, opts));
      fragment.appendChild(quote);
      return;
    }
    if (block.type === 'hr') {
      fragment.appendChild(doc.createElement('hr'));
    }
  }

  function appendBlocks(doc, fragment, blocks, options) {
    for (var index = 0; index < blocks.length; index += 1) {
      renderBlock(doc, fragment, blocks[index], options);
    }
    return fragment;
  }

  /* DOM renderer for completed messages. Returns a DocumentFragment.
     Math / diagram placeholders are inert text nodes here; enhance(container) upgrades them. */
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
    return appendBlocks(doc, fragment, parse(source), opts);
  }

  /* DOM renderer for a progressive plan: only plan.blocks (already closed by definition) are
     typeset; plan.tail is appended verbatim as plain text inside .md-stream-tail so an unfinished
     construct is visible immediately but never typeset. */
  function renderProgressivePlan(doc, plan, options) {
    var opts = options || {};
    var fragment = doc.createDocumentFragment();
    var value = plan && typeof plan === 'object' ? plan : { blocks: [], tail: '' };
    appendBlocks(doc, fragment, Array.isArray(value.blocks) ? value.blocks : [], opts);
    if (typeof value.tail === 'string' && value.tail) {
      var tailNode = doc.createElement('div');
      tailNode.className = 'md-stream-tail';
      tailNode.textContent = value.tail;
      fragment.appendChild(tailNode);
    }
    return fragment;
  }

  function renderProgressive(doc, text, options) {
    return renderProgressivePlan(doc, planProgressive(text), options);
  }

  /* ---------- lazy vendor loading + queued enhancement ----------
     KaTeX and Mermaid are built into vendor/ by scripts/copy-assets.mjs and served from the
     same file:// origin (CSP 'self'). They are loaded only when a completed message actually
     contains a math/diagram placeholder, at most once, and rendering is sliced over event-loop
     turns so a long answer cannot freeze the UI. Failure is non-fatal: the raw source text
     remains visible and labelled. */
  var enhancement = {
    vendorBase: 'vendor/',
    katex: 'idle',
    mermaid: 'idle',
    katexPromise: null,
    mermaidPromise: null,
    mermaidTheme: null,
    busymermaid: false,
    queue: [],
    timer: 0,
    sequence: 0,
    options: {},
  };

  function enhancedOptions(options) {
    var opts = options || {};
    return {
      vendorBase: typeof opts.vendorBase === 'string' && opts.vendorBase ? opts.vendorBase : 'vendor/',
      copyLabel: opts.copyLabel,
      copiedLabel: opts.copiedLabel,
      onCopy: opts.onCopy,
      mathLabel: opts.mathLabel,
      mathFallback: opts.mathFallback || 'LaTeX not rendered',
      mathRendering: opts.mathRendering || 'Rendering math...',
      mathTooLarge: opts.mathTooLarge || 'latex (too large to render)',
      mathWaiting: opts.mathWaiting || 'latex (waiting for closing delimiter)',
      diagramFallback: opts.diagramFallback || 'Mermaid not rendered',
      diagramRendering: opts.diagramRendering || 'Rendering diagram...',
      diagramTooLarge: opts.diagramTooLarge || 'mermaid (too large to render)',
      diagramWaiting: opts.diagramWaiting || 'mermaid (waiting for closing fence)',
      /* Progressive streaming upgrades complete inline math inside closed blocks, but leaves
         Mermaid for message completion: re-rendering a ~2.7 MB bundle's SVG on every closed
         block would be expensive and visually noisy. */
      allowDiagrams: opts.allowDiagrams !== false,
    };
  }

  function vendorUrl(base, path) {
    var prefix = String(base || 'vendor/').replace(/\/?$/, '/');
    return prefix + path;
  }

  function loadScriptOnce(src) {
    if (typeof document === 'undefined' || !document.head) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = function () { resolve(true); };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    });
  }

  function ensureKatex(base) {
    if (typeof window !== 'undefined' && window.katex) { enhancement.katex = 'ready'; return Promise.resolve(window.katex); }
    if (enhancement.katex === 'missing') return Promise.resolve(null);
    if (enhancement.katexPromise) return enhancement.katexPromise;
    enhancement.katex = 'loading';
    enhancement.katexPromise = loadScriptOnce(vendorUrl(base, 'katex/katex.min.js')).then(function (ok) {
      var katex = (typeof window !== 'undefined' && window.katex) || null;
      enhancement.katex = ok && katex ? 'ready' : 'missing';
      return katex;
    })['catch'](function () {
      enhancement.katex = 'missing';
      return null;
    });
    return enhancement.katexPromise;
  }

  function resolvedTheme() {
    try {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
    } catch (error) {
      return 'default';
    }
  }

  function initMermaid(mermaid) {
    var theme = resolvedTheme();
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'inherit',
        suppressErrorRendering: true,
        maxTextSize: MAX_DIAGRAM_CHARS,
      });
      enhancement.mermaidTheme = theme;
    } catch (error) { /* an uninitialized mermaid simply leaves text fallbacks */ }
  }

  function ensureMermaid(base) {
    if (typeof window !== 'undefined' && window.mermaid) {
      if (enhancement.mermaid !== 'ready') initMermaid(window.mermaid);
      enhancement.mermaid = 'ready';
      return Promise.resolve(window.mermaid);
    }
    if (enhancement.mermaid === 'missing') return Promise.resolve(null);
    if (enhancement.mermaidPromise) return enhancement.mermaidPromise;
    enhancement.mermaid = 'loading';
    enhancement.mermaidPromise = loadScriptOnce(vendorUrl(base, 'mermaid/mermaid.min.js')).then(function (ok) {
      var mermaid = (typeof window !== 'undefined' && window.mermaid) || null;
      if (ok && mermaid) {
        initMermaid(mermaid);
        enhancement.mermaid = 'ready';
        return mermaid;
      }
      enhancement.mermaid = 'missing';
      return null;
    })['catch'](function () {
      enhancement.mermaid = 'missing';
      return null;
    });
    return enhancement.mermaidPromise;
  }

  function markMathFailed(item) {
    var node = item.node;
    if (!node || !node.isConnected) return;
    var doc = node.ownerDocument;
    while (node.firstChild) node.removeChild(node.firstChild);
    var source = doc.createElement('code');
    source.className = 'md-math-source';
    source.textContent = item.source;
    node.appendChild(source);
    node.className += ' md-math-failed';
    node.title = enhancement.options.mathFallback || 'LaTeX not rendered';
    node.setAttribute('data-md-state', 'failed');
  }

  function markDiagramFailed(item) {
    var node = item.node;
    if (!node || !node.isConnected) return;
    var doc = node.ownerDocument;
    var fallback = renderCodeBlock(
      doc,
      (enhancement.options.diagramFallback || 'Mermaid not rendered') +
        (item.source.length > MAX_DIAGRAM_CHARS ? '' : ''),
      item.source,
      enhancement.options
    );
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(fallback);
    node.className += ' md-diagram-failed';
    node.setAttribute('data-md-state', 'failed');
  }

  function renderMathItem(item) {
    var katex = (typeof window !== 'undefined' && window.katex) || null;
    if (!katex) {
      if (enhancement.katex === 'missing') { markMathFailed(item); return; }
      enhancement.queue.unshift(item);
      if (enhancement.katex !== 'loading') {
        ensureKatex(enhancement.options.vendorBase).then(function (loaded) {
          if (!loaded) {
            /* mark every queued math node as failed in one pass */
            var pending = enhancement.queue.slice();
            enhancement.queue.length = 0;
            for (var i = 0; i < pending.length; i += 1) if (pending[i].kind !== 'diagram') markMathFailed(pending[i]);
            schedule();
          } else {
            schedule();
          }
        });
      }
      return;
    }
    var node = item.node;
    var display = node.getAttribute('data-display') === '1';
    try {
      while (node.firstChild) node.removeChild(node.firstChild);
      katex.render(item.source, node, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxSize: 20,
        maxExpand: 1000,
        output: 'html',
      });
      node.className += ' md-math-rendered';
      node.removeAttribute('title');
      node.setAttribute('data-md-state', 'rendered');
    } catch (error) {
      markMathFailed(item);
    }
  }

  function renderDiagramItem(item) {
    var mermaid = (typeof window !== 'undefined' && window.mermaid) || null;
    if (!mermaid) {
      if (enhancement.mermaid === 'missing') { markDiagramFailed(item); return; }
      enhancement.queue.unshift(item);
      if (enhancement.mermaid !== 'loading') {
        ensureMermaid(enhancement.options.vendorBase).then(function (loaded) {
          if (!loaded) {
            var pending = enhancement.queue.slice();
            enhancement.queue.length = 0;
            for (var i = 0; i < pending.length; i += 1) if (pending[i].kind === 'diagram') markDiagramFailed(pending[i]);
          }
          schedule();
        });
      }
      return;
    }
    if (enhancement.busymermaid) { enhancement.queue.unshift(item); return; }
    enhancement.busymermaid = true;
    var node = item.node;
    var id = 'md-mermaid-' + (enhancement.sequence += 1);
    var rendering;
    try {
      rendering = mermaid.render(id, item.source);
    } catch (error) {
      enhancement.busymermaid = false;
      markDiagramFailed(item);
      schedule();
      return;
    }
    Promise.resolve(rendering).then(function (result) {
      enhancement.busymermaid = false;
      if (!node || !node.isConnected) { schedule(); return; }
      var svg = result && typeof result.svg === 'string' ? result.svg : '';
      try {
        if (!svg) throw new Error('empty mermaid output');
        var parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        var rootNode = parsed && parsed.documentElement;
        if (!rootNode || rootNode.nodeName.toLowerCase() !== 'svg') throw new Error('mermaid output is not svg');
        var imported = document.importNode(rootNode, true);
        while (node.firstChild) node.removeChild(node.firstChild);
        var holder = node.ownerDocument.createElement('div');
        holder.className = 'md-diagram-svg';
        holder.appendChild(imported);
        node.appendChild(holder);
        node.className += ' md-diagram-rendered';
        node.removeAttribute('title');
        node.setAttribute('data-md-state', 'rendered');
        if (result && typeof result.bindFunctions === 'function') {
          try { result.bindFunctions(node); } catch (error) { /* interaction is optional */ }
        }
      } catch (error) {
        markDiagramFailed(item);
      }
      schedule();
    })['catch'](function () {
      enhancement.busymermaid = false;
      markDiagramFailed(item);
      schedule();
    });
  }

  function nextItem() {
    while (enhancement.queue.length) {
      var item = enhancement.queue.shift();
      if (item.node && item.node.isConnected && item.node.getAttribute('data-md-state') === 'queued') return item;
      if (item.node && !item.node.isConnected) { /* node was replaced by a re-render */ }
    }
    return null;
  }

  function processQueue() {
    enhancement.timer = 0;
    var deadline = Date.now() + 8;
    while (Date.now() < deadline) {
      var item = nextItem();
      if (!item) break;
      /* While a vendor bundle is in flight the item is re-queued untouched; stop this turn so
         the loader promise can resolve instead of spinning on the same node. */
      if (item.kind === 'diagram' && enhancement.mermaid === 'loading' && !(typeof window !== 'undefined' && window.mermaid)) {
        enhancement.queue.unshift(item);
        break;
      }
      if (item.kind === 'math' && enhancement.katex === 'loading' && !(typeof window !== 'undefined' && window.katex)) {
        enhancement.queue.unshift(item);
        break;
      }
      if (item.kind === 'diagram') renderDiagramItem(item);
      else renderMathItem(item);
    }
    schedule();
  }

  function schedule() {
    if (enhancement.timer) return;
    if (typeof setTimeout !== 'function') return;
    if (!enhancement.queue.length && enhancement.katex !== 'loading' && enhancement.mermaid !== 'loading') return;
    enhancement.timer = setTimeout(processQueue, 16);
  }

  /* Upgrade inert placeholders inside one rendered message body. Safe to call before the node
     is connected: items are checked again when they are processed. Never duplicates a render. */
  function enhance(container, options) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    enhancement.options = enhancedOptions(options);
    var mathNodes = container.querySelectorAll('[data-math]');
    for (var m = 0; m < mathNodes.length; m += 1) {
      var mathNode = mathNodes[m];
      if (mathNode.getAttribute('data-md-state')) continue;
      if (!shouldRenderMath(mathNode.getAttribute('data-math') || '')) continue;
      mathNode.setAttribute('data-md-state', 'queued');
      enhancement.queue.push({ kind: 'math', node: mathNode, source: mathNode.getAttribute('data-math') || '' });
    }
    var diagramNodes = enhancement.options.allowDiagrams ? container.querySelectorAll('[data-mermaid]') : [];
    for (var d = 0; d < diagramNodes.length; d += 1) {
      var diagramNode = diagramNodes[d];
      if (diagramNode.getAttribute('data-md-state')) continue;
      if (!shouldRenderDiagram(diagramNode.getAttribute('data-mermaid') || '')) continue;
      diagramNode.setAttribute('data-md-state', 'queued');
      enhancement.queue.push({ kind: 'diagram', node: diagramNode, source: diagramNode.getAttribute('data-mermaid') || '' });
    }
    if (enhancement.queue.length) schedule();
  }

  /* Re-color existing diagrams after a theme switch (mermaid bakes colors into the SVG).
     Re-renders in the background; the old SVG stays until the new one replaces it. */
  function refreshTheme(theme) {
    if (enhancement.mermaid !== 'ready' || typeof document === 'undefined') return;
    var next = theme === 'dark' ? 'dark' : 'default';
    if (enhancement.mermaidTheme === next) return;
    enhancement.mermaidTheme = next;
    try { if (window.mermaid) initMermaid(window.mermaid); } catch (error) { return; }
    var nodes = document.querySelectorAll('[data-mermaid][data-md-state="rendered"]');
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      node.setAttribute('data-md-state', 'queued');
      node.className = node.className.replace(/\s*md-diagram-rendered/, '');
      enhancement.queue.push({ kind: 'diagram', node: node, source: node.getAttribute('data-mermaid') || '' });
    }
    if (nodes.length) schedule();
  }

  var api = {
    MAX_CHARS: MAX_CHARS,
    MAX_MATH_CHARS: MAX_MATH_CHARS,
    MAX_DIAGRAM_CHARS: MAX_DIAGRAM_CHARS,
    parse: parse,
    analyze: analyze,
    render: render,
    stablePrefix: stablePrefix,
    planProgressive: planProgressive,
    renderProgressive: renderProgressive,
    renderProgressivePlan: renderProgressivePlan,
    enhance: enhance,
    refreshTheme: refreshTheme,
    extractInlineMath: extractInlineMath,
    scanInlineMath: scanInlineMath,
    shouldRenderMath: shouldRenderMath,
    shouldRenderDiagram: shouldRenderDiagram,
    isSafeUrl: isSafeUrl,
  };
  if (root) {root.EveMarkdown = api;root.SuwenMarkdown = api;}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
