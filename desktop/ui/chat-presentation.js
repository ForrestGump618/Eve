'use strict';
(function (root) {
  const painted = new WeakMap();
  function disclosure(doc, label) {
    const details = doc.createElement('details');
    details.className = 'chat-code-disclosure';
    const summary = doc.createElement('summary');
    summary.textContent = label;
    details.append(summary);
    return details;
  }
  function foldCode(host, label) {
    for (const fallback of host.querySelectorAll('.md-fallback > .md-paragraph:not(.md-muted)')) {
      if (!painted.has(fallback)) setPlainText(fallback, fallback.textContent, label);
    }
    for (const block of host.querySelectorAll('.md-code-block')) {
      if (block.parentElement?.classList.contains('chat-code-disclosure')) continue;
      const details = disclosure(host.ownerDocument, label);
      block.replaceWith(details);
      details.append(block);
    }
  }
  /* Open streaming fences are plain text in markdown.js. Keep their source behind the
     same disclosure as completed fences, including when the Markdown renderer fails. */
  function setPlainText(host, text, label) {
    if (painted.get(host) === text && host.dataset.codeLabel === label) return;
    painted.set(host, text);
    host.dataset.codeLabel = label;
    const doc = host.ownerDocument;
    const nodes = [];
    const fence = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)/g;
    let cursor = 0, match;
    while ((match = fence.exec(text))) {
      nodes.push(doc.createTextNode(text.slice(cursor, match.index)));
      const marker = match[2];
      const closing = new RegExp('(?:^|\\n)[ \\t]*' + marker[0] + '{' + marker.length + ',}[ \\t]*(?=\\n|$)', 'g');
      closing.lastIndex = Math.max(0, fence.lastIndex - 1);
      const end = closing.exec(text);
      const details = disclosure(doc, label);
      const pre = doc.createElement('pre');
      pre.textContent = text.slice(fence.lastIndex, end ? end.index : text.length);
      details.append(pre);
      nodes.push(details);
      cursor = end ? closing.lastIndex : text.length;
      fence.lastIndex = cursor;
    }
    nodes.push(doc.createTextNode(text.slice(cursor)));
    host.replaceChildren(...nodes);
  }
  const api = Object.freeze({ foldCode, setPlainText });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EveChatPresentation = api;
})(typeof window === 'undefined' ? globalThis : window);
