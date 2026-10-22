// @ts-nocheck -- UI glue moved from content/*.js (spec 005 C1), which was never typechecked in Zotero either;
// host.d.ts, tools.d.ts and domain.d.ts are still the checked interfaces these files must match.
// ui-src/src/chat/dom-helpers.js. Tiny helpers shared by chat.js, find-view.js and report-view.js, split out of
// chat.js's ChatView (spec 005 C1): `el` is `h()` (dom.js) with the same four-argument shape
// `content/second-brain.js`'s `sb.el` had; `button` reproduces `sb.button`'s "sb-button"/"sb-button is-primary"
// classing so the CSS Zotero already loads for that class (not moved: it's second-brain.js's, not the chat's)
// keeps styling these buttons the same as before the move.
import { h } from '../dom.js';

export { h as el };

/** @param {Document} doc @param {string} label @param {() => void} onClick @param {boolean} [primary] */
export function button(doc, label, onClick, primary = false) {
  const btn = h(doc, 'button', primary ? 'sb-button is-primary' : 'sb-button', label);
  btn.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/** Adds a <style> once per document, or refreshes it: an update reloads the plugin without a restart, and a sheet
 *  from the old version would leave the new controls unstyled. */
export function installStyle(doc, id, css) {
  const old = doc.getElementById(id);
  if (old) { if (old.textContent !== css) old.textContent = css; return; }
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = css;
  doc.documentElement.append(style);
}
