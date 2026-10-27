import { esc } from './util.js?v=2.1.1';
import { icon } from './icons.js?v=2.1.1';

let active = null;
let sequence = 0;

function closeActive() {
  if (!active) return;
  active.close();
  active = null;
}

function optionData(select) {
  return Array.from(select.options || []).map((option, index) => ({
    value: option.value,
    label: option.textContent?.trim() || option.value || '未命名选项',
    disabled: option.disabled,
    index,
  }));
}

function installValueBridge(select, refresh) {
  const proto = Object.getPrototypeOf(select);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!descriptor?.get || !descriptor?.set) return () => {};
  try {
    Object.defineProperty(select, 'value', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get.bind(select),
      set(value) {
        descriptor.set.call(select, value);
        refresh();
      },
    });
    return () => {
      try { delete select.value; } catch { /* already detached */ }
    };
  } catch {
    return () => {};
  }
}

function enhance(select) {
  if (!(select instanceof HTMLSelectElement) || select.dataset.eveSelectReady === '1') return () => {};
  if (select.multiple || select.size > 1) return () => {};
  select.dataset.eveSelectReady = '1';
  const parent = select.parentElement;
  if (!parent) return () => {};
  parent.classList.add('eve-select-host');
  const id = select.id || `eve-select-${++sequence}`;
  const menuId = `${id}-menu`;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'eve-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-controls', menuId);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.dataset.for = id;
  const menu = document.createElement('div');
  menu.className = 'eve-select-menu';
  menu.id = menuId;
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  document.body.appendChild(menu);
  select.classList.add('eve-native-select');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  select.after(trigger);

  let disposed = false;
  let keyIndex = -1;
  const refresh = () => {
    const current = select.options?.[select.selectedIndex];
    trigger.innerHTML = `<span class="eve-select-label">${esc(current?.textContent?.trim() || select.value || '请选择')}</span>${icon('chevronDown', { size: 13 })}`;
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-disabled', String(select.disabled));
    menu.innerHTML = optionData(select).map((option) =>
      `<button type="button" class="eve-select-option${option.value === select.value ? ' is-selected' : ''}" role="option" aria-selected="${option.value === select.value}" data-value="${esc(option.value)}"${option.disabled ? ' disabled' : ''}>` +
      `<span>${esc(option.label)}</span>${option.value === select.value ? icon('check', { size: 14 }) : ''}</button>`,
    ).join('');
  };
  const reposition = () => {
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 190);
    menu.style.minWidth = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
    const below = window.innerHeight - rect.bottom;
    const height = Math.min(360, Math.max(100, menu.scrollHeight || 240));
    menu.style.top = below >= height + 8 || below >= rect.top ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - height - 6)}px`;
  };
  const close = () => {
    if (disposed) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-open');
    if (active?.select === select) active = null;
  };
  const open = () => {
    if (disposed || select.disabled) return;
    closeActive();
    refresh();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-open');
    active = { select, close };
    requestAnimationFrame(reposition);
    const selected = menu.querySelector('.is-selected');
    selected?.scrollIntoView({ block: 'nearest' });
  };
  const onTrigger = (event) => { event.preventDefault(); if (menu.hidden) open(); else close(); };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (menu.hidden) { open(); return; }
    const options = Array.from(menu.querySelectorAll('.eve-select-option:not(:disabled)'));
    if (!options.length) return;
    if (event.key === 'Home') keyIndex = 0;
    else if (event.key === 'End') keyIndex = options.length - 1;
    else if (event.key === 'ArrowDown') keyIndex = Math.min(options.length - 1, keyIndex + 1);
    else if (event.key === 'ArrowUp') keyIndex = Math.max(0, keyIndex - 1);
    else if (event.key === 'Enter' || event.key === ' ') { options[Math.max(0, keyIndex)]?.click(); return; }
    options.forEach((node, index) => node.classList.toggle('is-keyboard', index === keyIndex));
    options[keyIndex]?.scrollIntoView({ block: 'nearest' });
  };
  const onMenu = (event) => {
    const option = event.target.closest('.eve-select-option');
    if (!option || option.disabled) return;
    select.value = option.dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
    close();
    trigger.focus();
  };
  const onChange = () => refresh();
  const onOutside = (event) => { if (!menu.hidden && !parent.contains(event.target) && !menu.contains(event.target)) close(); };
  const onViewport = () => { if (!menu.hidden) reposition(); };
  trigger.addEventListener('click', onTrigger);
  trigger.addEventListener('keydown', onKey);
  menu.addEventListener('click', onMenu);
  select.addEventListener('change', onChange);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onViewport);
  window.addEventListener('scroll', onViewport, true);
  const observer = new MutationObserver(() => refresh());
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  const restore = installValueBridge(select, refresh);
  refresh();
  return () => {
    disposed = true;
    close();
    observer.disconnect();
    trigger.removeEventListener('click', onTrigger);
    trigger.removeEventListener('keydown', onKey);
    menu.removeEventListener('click', onMenu);
    select.removeEventListener('change', onChange);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('scroll', onViewport, true);
    restore();
    trigger.remove();
    menu.remove();
    select.classList.remove('eve-native-select');
    select.removeAttribute('aria-hidden');
    delete select.dataset.eveSelectReady;
    parent.classList.remove('eve-select-host');
  };
}

export function mountEveSelects(root = document) {
  const mounted = new Map();
  const scan = () => root.querySelectorAll('select').forEach((select) => {
    if (!mounted.has(select)) mounted.set(select, enhance(select));
  });
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(root === document ? document.body : root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    mounted.forEach((dispose) => dispose());
    mounted.clear();
  };
}

