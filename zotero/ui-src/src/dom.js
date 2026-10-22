// @ts-check
// ui-src/src/dom.js. One DOM helper used everywhere in this package: `h()` always creates an XHTML element
// through createElementNS, which is what makes the same code work in an ordinary HTML document (Obsidian, the
// harness) and a XUL chrome document (Zotero's tab and sidebar), where a framework's own
// `document.createElement` would create a XUL element instead.
export const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function h(doc, tag, cls, text) {
  const el = /** @type {HTMLElement} */ (doc.createElementNS(XHTML_NS, tag));
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** @param {HTMLElement} el @param {Record<string, string>} attrs */
export function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
