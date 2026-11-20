// @ts-check
// ui-src/src/chat/sources-menu-data.js. The pure side of the composer's one "Sources" menu button (spec 029 R6): the
// words on the button, which name the sources that are on, and where the keyboard goes inside the menu. No DOM; chat.js
// draws the button and the menu of checkboxes.

/** @typedef {{ id: string, label: string, on: boolean, usable: boolean }} SourceItem `usable`: shown, and not disabled in this mode */

/** "Sources: Papers, Notes, Scholarly": the sources that are on and count here, in menu order; "Sources: none" when no
 *  source is on (Send is disabled then, and the empty state says why). @param {SourceItem[]} items */
export function sourcesLabel(items) {
  const on = items.filter((item) => item.usable && item.on).map((item) => item.label);
  return `Sources: ${on.length ? on.join(', ') : 'none'}`;
}

/**
 * The menu item a key moves to, as an index into the usable items, or null when the key is not a move: ArrowDown and
 * ArrowUp step and wrap, Home and End jump to the first and last. `at` is -1 when no item has focus yet.
 * @param {string} key @param {number} at @param {number} count @returns {number | null}
 */
export function menuStep(key, at, count) {
  if (!count) return null;
  if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % count;
  if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
