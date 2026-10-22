// @ts-check
// ui-src/src/host-words.js. The few phrases that name the app the paper library and notes live in. Zotero and
// Obsidian keep their existing wording byte for byte; only the web host, which has neither app open, says
// "library" and "notes" instead of naming them.

/** @typedef {import("./host").UiHost} UiHost */

/** @param {Pick<UiHost, "kind">} host */
const isWeb = (host) => host.kind === 'web';

const WEB_SOURCE_HINTS = {
  papers: 'Your paper library: metadata, abstract, your highlights and notes, full text',
  notes: 'Your notes',
};

/** Tooltip text of a source pill. @param {Pick<UiHost, "kind">} host @param {string} id @param {string} base */
export function sourceHint(host, id, base) {
  return (isWeb(host) && /** @type {Record<string, string>} */ (WEB_SOURCE_HINTS)[id]) || base;
}

/** "Add 3 to Zotero", "Add to Zotero", "Add all to Zotero". @param {Pick<UiHost, "kind">} host @param {number | "all" | null} [count] */
export function addLabel(host, count = null) {
  const where = isWeb(host) ? 'library' : 'Zotero';
  return count == null ? `Add to ${where}` : `Add ${count} to ${where}`;
}

/** A mode's empty-state sentence; Find papers drops "add them to Zotero" where that cannot happen.
 *  @param {Pick<UiHost, "kind" | "can">} host @param {string} text */
export function modeEmpty(host, text) {
  return isWeb(host) && !host.can.addToLibrary ? text.replace(', add them to Zotero or export them.', ' or export them.') : text;
}
