// @ts-check
// ui-src/src/icons.js. The shared 16-px outline icon set: today's Zotero ChatView.ICONS (content/chat.js),
// unchanged, plus the icons the older panels need (spec 005 §3). One style everywhere: a 16x16 viewBox, a bare
// stroke path (fill: none; stroke: currentColor; stroke-width: 1.5), drawn by icon() below with `h()` (dom.js)
// so it works in both an HTML document and a Zotero XUL chrome document.
import { SVG_NS, XHTML_NS } from './dom.js';

/** @type {Record<string, string>} */
export const ICONS = {
  // ---------- chat modes (content/chat.js ChatView.ICONS, moved verbatim) ----------
  chat: 'M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.75 13v-2.25h-.5a1.5 1.5 0 0 1-1.5-1.5z',
  ask: 'M8.75 1.75 3.75 9h4.5l-1 5.25L12.25 7h-4.5z',
  find: 'M7 12.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5z M10.75 10.75l3.5 3.5',
  report: 'M4 1.75h5.25L12 4.5v9.75H4z M9.25 1.75V4.5H12 M6.25 8h3.5 M6.25 10.75h3.5',
  send: 'M8 12.75V3.5 M4.25 7.25 8 3.5l3.75 3.75',
  stop: 'M5.25 5.25h5.5v5.5h-5.5z',

  // ---------- source pills and panels (spec 005 §3: "paper, note, scholarly, web, related, duplicate, status") ----------
  paper: 'M4.25 1.75h5.5L12.25 4.5v9.75h-8z M9.75 1.75V4.5H12.25',
  note: 'M3.25 2.75h9.5v10.5h-9.5z M5.5 5.75h5.5 M5.5 8h5.5 M5.5 10.25h3.5',
  scholarly: 'M8 2.25 2.5 5l5.5 2.75L13.5 5z M4.75 6.5v3.75c0 1 1.5 1.75 3.25 1.75s3.25-.75 3.25-1.75V6.5',
  web: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z M1.9 8h12.2 M8 1.75c1.5 1.7 2.35 3.9 2.35 6.25S9.5 12.55 8 14.25c-1.5-1.7-2.35-3.9-2.35-6.25S6.5 3.45 8 1.75z',
  related: 'M4.25 8a2.25 2.25 0 1 0 0 .01z M11.75 8a2.25 2.25 0 1 0 0 .01z M6.5 8h3',
  duplicate: 'M5.25 5.25h7.5v7.5h-7.5z M3.25 3.25h7.5v2 M3.25 3.25v7.5h2',
  status: 'M2.75 13.25v-3.5 M6.5 13.25v-7 M10.25 13.25v-4.5 M13.25 13.25V3.25',

  // ---------- artifact cards and panel (spec 007 E3) ----------
  table: 'M2.75 3.75h10.5v8.5H2.75z M2.75 7h10.5 M6.5 7v5.25',
  download: 'M8 2.75v7.5 M4.75 7.5 8 10.75l3.25-3.25 M3 13.25h10',
  open: 'M9.25 2.75h4v4 M13.25 2.75 7.5 8.5 M11.5 9.25v3a.75.75 0 0 1-.75.75h-6.5a.75.75 0 0 1-.75-.75v-6.5a.75.75 0 0 1 .75-.75h3',
  close: 'M4 4l8 8 M12 4 4 12',
  back: 'M13 8H3.5 M7.5 4 3.5 8l4 4',
  sort: 'M4.5 3v10 M2.5 11l2 2 2-2 M11.5 13V3 M9.5 5l2-2 2 2',
  expand: 'M9.5 2.75h3.75v3.75 M13.25 2.75 9 7 M6.5 13.25H2.75V9.5 M2.75 13.25 7 9',
  chevron: 'M4 6l4 4 4-4',
  check: 'M3.5 8.5l3 3 6-6.5',
  sparkle: 'M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z',

  // ---------- columns and filters (spec 007 E4) ----------
  filter: 'M2.75 4h10.5 M4.75 8h6.5 M6.75 12h2.5',
  columns: 'M2.75 3.5h10.5v9H2.75z M6.25 3.5v9 M9.75 3.5v9',
  plus: 'M8 3.25v9.5 M3.25 8h9.5',
  more: 'M3.5 8v.01 M8 8v.01 M12.5 8v.01',
  sun: 'M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z M8 1.5v1.25 M8 13.25v1.25 M1.5 8h1.25 M13.25 8h1.25 M3.4 3.4l.9.9 M11.7 11.7l.9.9 M3.4 12.6l.9-.9 M11.7 4.3l.9-.9',
  moon: 'M13.25 9.5A5.5 5.5 0 0 1 6.5 2.75a5.5 5.5 0 1 0 6.75 6.75z',
  // ---------- panels (spec 005 D1): row and card actions ----------
  trash: 'M3.25 4.5h9.5 M6.25 4.5V3h3.5v1.5 M4.5 4.5l.5 8.75h6l.5-8.75 M6.75 7v4 M9.25 7v4',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7 M13 2.75v2.75h-2.75',
  quote: 'M3.75 11.5v-3h2.5v3z M9.25 11.5v-3h2.5v3z M3.75 8.5c0-2 .75-3 2.5-3.25 M9.25 8.5c0-2 .75-3 2.5-3.25',
  book: 'M2.75 3.25h4.25a1 1 0 0 1 1 1v8.5a1 1 0 0 0-1-1H2.75z M13.25 3.25H9a1 1 0 0 0-1 1v8.5a1 1 0 0 1 1-1h4.25z',
  pen: 'M10.5 3l2.5 2.5-6.75 6.75-3 .5.5-3z',
  clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z M8 4.75V8l2.25 1.5',
  home: 'M2.75 7.5 8 2.75l5.25 4.75 M4.25 6.5v6.75h7.5V6.5 M6.75 13.25v-3.5h2.5v3.5',
  folder: 'M2.75 4.25h3.75l1.25 1.5h5.5v6.5H2.75z',
  grip: 'M6 4v.01 M6 8v.01 M6 12v.01 M10 4v.01 M10 8v.01 M10 12v.01',

  // ---------- Settings sections (spec 016 U2): same 1.5 stroke; the sidebar draws them at 20 px ----------
  settingsGeneral: 'M2.75 5h5.25 M11 5h2.25 M9.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M2.75 11h2.25 M8 11h5.25 M6.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  settingsModels: 'M4.5 4.5h7v7h-7z M6.75 1.75v2.75 M9.25 1.75v2.75 M6.75 11.5v2.75 M9.25 11.5v2.75 M1.75 6.75h2.75 M1.75 9.25h2.75 M11.5 6.75h2.75 M11.5 9.25h2.75',
  settingsMac: 'M3.25 3.25h9.5v6.5h-9.5z M1.75 12.25h12.5 M6.5 12.25h3',
  settingsResearch: 'M6.25 2.25h3.5 M7 2.25v4.25L3.25 12.5a1 1 0 0 0 .85 1.5h7.8a1 1 0 0 0 .85-1.5L9 6.5V2.25 M5 10h6',
  settingsPapers: 'M2.75 3.25h4.25a1 1 0 0 1 1 1v8.5a1 1 0 0 0-1-1H2.75z M10.5 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M12.25 11.25l1.75 2',
  settingsSources: 'M6 2.25v3 M10 2.25v3 M4.25 5.25h7.5v2.5a3.75 3.75 0 0 1-7.5 0z M8 11.5v2.25',
  settingsIndex: 'M8 2.25c-2.9 0-5.25.9-5.25 2s2.35 2 5.25 2 5.25-.9 5.25-2-2.35-2-5.25-2z M2.75 4.25v7.5c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2v-7.5 M2.75 8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2',
  settingsServer: 'M2.75 2.75h6.5v3.5h-6.5z M2.75 7.25h3 M2.75 10v3.25 M4.25 13.25h1.5 M10.25 6.25h3a.75.75 0 0 1 .75.75v6.25a.75.75 0 0 1-.75.75h-3a.75.75 0 0 1-.75-.75V7a.75.75 0 0 1 .75-.75z M11.75 12.25v.01',
  settingsRadar: 'M8 7.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z M5.35 10.65a3.75 3.75 0 0 1 0-5.3 M10.65 5.35a3.75 3.75 0 0 1 0 5.3 M3.4 12.6a6.5 6.5 0 0 1 0-9.2 M12.6 3.4a6.5 6.5 0 0 1 0 9.2',
  settingsAbout: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z M8 7.25v3.75 M8 4.75v.01',
};

/**
 * @param {Document} doc
 * @param {string} name
 * @param {string} [cls]
 * @returns {SVGSVGElement}
 */
export function icon(doc, name, cls = 'sb-p-icon') {
  const svg = /** @type {SVGSVGElement} */ (doc.createElementNS(SVG_NS, 'svg'));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  // One <path> per icon, its `d` the whole (possibly multi-subpath, multi-"M") string, matching
  // content/chat.js's original icon() exactly: the Zotero harness tests compare a rendered icon's single path's
  // `d` attribute against ICONS[name] verbatim (t-chat-look.js).
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** Lucide 0.460.0 (ISC, see THIRD_PARTY.md), for the radar's row actions: a 24x24 viewBox, stroke 2, round caps. */
export const LUCIDE = {
  thumbsUp: 'M7 10v12 M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
  thumbsDown: 'M17 14V2 M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
  bookmark: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z',
};

/** A Lucide icon, drawn in the text colour. @param {Document} doc @param {keyof typeof LUCIDE} name @param {number} [size] */
export function lucide(doc, name, size = 16) {
  const svg = /** @type {SVGSVGElement} */ (doc.createElementNS(SVG_NS, 'svg'));
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, class: 'sb-lucide', 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, String(v));
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', LUCIDE[name]);
  svg.append(path);
  return svg;
}

// Kept for a module that only wants the raw namespace constants without a DOM around (node tests).
export { SVG_NS, XHTML_NS };
