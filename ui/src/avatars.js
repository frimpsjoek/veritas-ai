// @ts-check
// ui-src/src/avatars.js. Who made something: a person (your messages, the notes you wrote, the authors you follow) or
// Second Brain's AI (its answers, the notes agents wrote). One small mark each, so the two read apart at a glance.
import { SVG_NS } from './dom.js';

/** Folders agents write into; every other note is the person's own. */
const AI_FOLDERS = /^(ai_notes|copilot)\//i;

/** "ai" for a note an agent wrote, "human" for any other note, null for a paper (a paper has its own mark).
 *  @param {string} path */
export function authorOf(path) {
  if (!path || path.startsWith('zotero/')) return null;
  const inner = path.replace(/^[a-z0-9][a-z0-9-]{0,31}:\//, '');
  return AI_FOLDERS.test(inner) ? 'ai' : 'human';
}

/** @param {Document} doc @param {number} size @param {string} cls @param {string} label */
function frame(doc, size, cls, label) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `sb-avatar ${cls}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);  // a label, not <title>: a title's text would join the row's text
  return svg;
}

/** @param {Document} doc @param {string} tag @param {Record<string, string | number>} attrs */
function shape(doc, tag, attrs) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Muted, colour-blind-safe tones (Okabe-Ito, deepened) for initials; a name always gets the same one. */
const TONES = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#7A5195', '#C27C00', '#2F8FC4', '#8C6D31'];

/** @param {string} name */
function toneOf(name) {
  let n = 0;
  for (const ch of String(name)) n = (n * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TONES[n % TONES.length];
}

/** @param {string} name */
function initialsOf(name) {
  const clean = String(name).replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
  const parts = clean.includes(',') ? clean.split(',').map((p) => p.trim()).reverse() : clean.split(/\s+/);
  const words = parts.join(' ').split(/[\s.-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : words[0].slice(0, 2)).toUpperCase();
}

/** A person. With a `name` (a followed author): their initials on their own colour. Without (you): a teal figure.
 *  @param {Document} doc @param {{ size?: number, label?: string, name?: string }} [opts] */
export function personAvatar(doc, opts = {}) {
  const size = opts.size ?? 18;
  if (opts.name) {
    const svg = frame(doc, size, 'is-person is-named', opts.label ?? opts.name);
    const text = shape(doc, 'text', { x: 12, y: 16.2, 'text-anchor': 'middle', class: 'sb-avatar-initials', fill: '#FFFFFF' });
    text.textContent = initialsOf(opts.name);
    svg.append(shape(doc, 'circle', { cx: 12, cy: 12, r: 12, fill: toneOf(opts.name) }), text);
    return svg;
  }
  const svg = frame(doc, size, 'is-person', opts.label ?? 'Written by you');
  svg.append(
    // the colours live here, not in ui.css (which takes only --sb-ui-* tokens): a mark looks the same in every host
    shape(doc, 'circle', { cx: 12, cy: 12, r: 12, fill: '#CCE9E3' }),
    shape(doc, 'circle', { cx: 12, cy: 9.2, r: 3.9, fill: '#0F766E' }),
    shape(doc, 'path', { d: 'M5.2 19.6c1.3-3.3 3.9-5 6.8-5s5.5 1.7 6.8 5A11.6 11.6 0 0 1 12 23.4a11.6 11.6 0 0 1-6.8-3.8z', fill: '#0F766E' }),
  );
  return svg;
}

let gradients = 0;

/** Second Brain's AI: a white sparkle on an indigo-to-violet circle. @param {Document} doc @param {{ size?: number, label?: string }} [opts] */
export function aiAvatar(doc, opts = {}) {
  const svg = frame(doc, opts.size ?? 18, 'is-ai', opts.label ?? 'Written by Veritas AI');
  const id = `sb-ai-grad-${++gradients}`;  // one id per mark: two marks on a page must not share a removed <defs>
  const defs = shape(doc, 'defs', {});
  const grad = shape(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 });
  grad.append(shape(doc, 'stop', { offset: '0', 'stop-color': '#4F46E5' }), shape(doc, 'stop', { offset: '1', 'stop-color': '#A855F7' }));
  defs.append(grad);
  svg.append(
    defs,
    shape(doc, 'circle', { cx: 12, cy: 12, r: 12, fill: `url(#${id})` }),
    shape(doc, 'path', { d: 'M12 5c.55 3.6 2.4 5.45 6 6-3.6.55-5.45 2.4-6 6-.55-3.6-2.4-5.45-6-6 3.6-.55 5.45-2.4 6-6z', fill: '#FFFFFF' }),
    shape(doc, 'circle', { cx: 17.6, cy: 6.6, r: 1.25, fill: '#FFFFFF', 'fill-opacity': '0.85' }),
  );
  return svg;
}

/** The mark for a note by who wrote it, or null for a paper. @param {Document} doc @param {string} path @param {number} [size] */
export function authorAvatar(doc, path, size = 16) {
  const who = authorOf(path);
  return who === 'ai' ? aiAvatar(doc, { size }) : who === 'human' ? personAvatar(doc, { size }) : null;
}
