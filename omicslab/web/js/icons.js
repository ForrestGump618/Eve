// Self-authored inline SVG icon set (24x24, stroke = currentColor).
// No external icon fonts or CDN assets are used anywhere in this SPA.

const PATHS = {
  chat: '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H5l-2 2v-4.6A8.5 8.5 0 1 1 21 12Z"/>',
  vars: '<path d="M9 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2"/><path d="M15 3h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/>',
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  figures:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m4 17 4.5-4.5 3 3L15 12l5 5"/>',
  jobs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 2.5 3L7 15M12.5 15H17"/>',
  skills:
    '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9Z"/><path d="M18.5 3.5v3M20 5h-3"/>',
  memory:
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  settings:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash:
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1l.8-12M10 11v5M14 11v5"/>',
  pencil:
    '<path d="M4 20h4L18.5 9.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5Z"/><path d="m13.5 7 3.5 3.5"/>',
  copy: '<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5L16.5 11M5 20h14"/>',
  upload: '<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 20h14"/>',
  refresh:
    '<path d="M4.5 10A7.5 7.5 0 0 1 18 6.5L20 9"/><path d="M20 4.5V9h-4.5"/><path d="M19.5 14A7.5 7.5 0 0 1 6 17.5L4 15"/><path d="M4 19.5V15h4.5"/>',
  send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="M8 5.5v13l10-6.5Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M6 3h7l5 5v13H6Z"/><path d="M13 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m4 17 4.5-4.5 3 3L15 12l5 5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 2.5 3L7 15M12.5 15H17"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.8 2.8L16.5 9"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
  alert: '<path d="M12 4 3 20h18Z"/><path d="M12 10v4M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/>',
  history:
    '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4.5l3 1.8"/>',
  command:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  external:
    '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7.2 7 9 4-1.8 7-5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H11v18H5.5A1.5 1.5 0 0 0 4 22.5Z"/><path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H13v18h5.5a1.5 1.5 0 0 1 1.5 1.5Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  wand: '<path d="m4 20 10-10M13 5l1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/>',
  tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4Z"/><path d="M12 13v8"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9" />',
  brain:
    '<path d="M9.5 3.5A3 3 0 0 0 6.6 7 3.2 3.2 0 0 0 5 9.9a3 3 0 0 0 .6 6A3 3 0 0 0 11 18.6V5.6a2.2 2.2 0 0 0-1.5-2.1Z"/><path d="M14.5 3.5A3 3 0 0 1 17.4 7 3.2 3.2 0 0 1 19 9.9a3 3 0 0 1-.6 6A3 3 0 0 1 13 18.6V5.6a2.2 2.2 0 0 1 1.5-2.1Z"/>',
  fileText:
    '<path d="M6 3h7l5 5v13H6Z"/><path d="M13 3v5h5M9 12h6M9 15.5h6M9 19h4"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  paperclip:
    '<path d="m20 11.5-7.8 7.8a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.4-7.4"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  save: '<path d="M5 3h11l3 3v15H5Z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/>',
  folderPlus:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/>',
  filePlus: '<path d="M6 3h7l5 5v13H6Z"/><path d="M13 3v5h5M12 12v6M9 15h6"/>',
  filter: '<path d="M4 5h16l-6 7.2V20l-4-2v-5.8Z"/>',
  clockPlay: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9.2v5.6l4.3-2.8Z"/>',
  discovery:
    '<circle cx="12" cy="12" r="8.5"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1Z"/>',
  registry:
    '<path d="M14.4 5.6c-2.2 0-3.6 1.5-3.9 3.7L9.7 18.4"/><path d="M7.8 10.4h6.4"/><path d="M13.4 13.2 16.6 17l3.2-3.8"/>',
  ssh:
    '<circle cx="12" cy="4.8" r="2.3"/><circle cx="5" cy="19.2" r="2.3"/><circle cx="19" cy="19.2" r="2.3"/><path d="M12 7.1v4.4M12 11.5 6.4 16.9M12 11.5l5.6 5.4"/>',
};

/**
 * Build an inline SVG icon string.
 * @param {keyof typeof PATHS | string} name
 * @param {{size?: number, cls?: string, strokeWidth?: number, title?: string}} [opts]
 */
export function icon(name, opts = {}) {
  const { size = 18, cls = '', strokeWidth = 1.8, title = '' } = opts;
  const body = PATHS[name] || PATHS.dot;
  return (
    `<svg class="icon${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true"${title ? ` role="img"` : ''}>` +
    (title ? `<title>${title}</title>` : '') +
    `${body}</svg>`
  );
}

/** Brand mark: gradient rounded square with a stylised double helix. */
export function brandMark(size = 30, idSuffix = '') {
  const gradientId = `brand-gradient-${idSuffix || 'default'}`;
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs><rect x="1" y="1" width="38" height="38" rx="12" fill="url(#${gradientId})"/><path d="M12 14c1-5 13-5 15 0 3 7-12 7-12 13M13 29h.01" stroke="#ece7ff" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M10 22c5-6 13-6 20 0" stroke="#67e8f9" stroke-width="1.5" fill="none" opacity=".62"/></svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
