'use strict';
(function (root) {
  function create({ host, pageSize, previewChars, onSelect }) {
    const doc = host.ownerDocument;
    const summary = host.querySelector('summary');
    const search = host.querySelector('input');
    const list = host.querySelector('ol');
    const status = host.querySelector('[role="status"]');
    const previous = host.querySelector('[data-locator-previous]');
    const next = host.querySelector('[data-locator-next]');
    let entries = [], labels, page = 0, key;
    function paint() {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = entries.filter(entry => entry.text.toLocaleLowerCase().includes(query));
      const pages = Math.max(1, Math.ceil(matches.length / pageSize));
      page = Math.min(page, pages - 1);
      list.replaceChildren(...matches.slice(page * pageSize, (page + 1) * pageSize).map(entry => {
        const item = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button';
        const text = entry.text.replace(/\s+/g, ' ').trim();
        button.textContent = `${entry.ordinal}. ${text.slice(0, previewChars)}${text.length > previewChars ? '\u2026' : ''}`;
        button.title = text;
        button.addEventListener('click', () => { host.open = false; onSelect(entry); });
        item.append(button);
        return item;
      }));
      summary.textContent = labels.title(entries.length);
      search.placeholder = labels.search;
      search.setAttribute('aria-label', labels.search);
      previous.textContent = labels.previous;
      next.textContent = labels.next;
      previous.disabled = page === 0;
      next.disabled = page === pages - 1;
      status.textContent = matches.length ? labels.results(matches.length, page + 1, pages) : labels.empty;
    }
    search.addEventListener('input', () => { page = 0; paint(); });
    previous.addEventListener('click', () => { page -= 1; paint(); });
    next.addEventListener('click', () => { page += 1; paint(); });
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape' && host.open) {
        event.preventDefault();
        host.open = false;
        summary.focus();
      }
    });
    doc.addEventListener('pointerdown', event => { if (!host.contains(event.target)) host.open = false; });
    return {
      update(nextEntries, nextKey, nextLabels) {
        if (key === nextKey && labels?.search === nextLabels.search && entries.length === nextEntries.length &&
            entries.every((entry, index) => entry.index === nextEntries[index].index && entry.text === nextEntries[index].text)) return;
        if (key !== nextKey) { host.open = false; search.value = ''; page = 0; }
        key = nextKey;
        entries = nextEntries;
        labels = nextLabels;
        host.hidden = entries.length === 0;
        paint();
      },
    };
  }
  const api = Object.freeze({ create });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EveMessageLocator = api;
})(typeof window === 'undefined' ? globalThis : window);
