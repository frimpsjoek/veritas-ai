// @ts-check
// agent-src/src/errors.js. Reading a caught value, which is `unknown`. Structural rather than `instanceof Error`:
// in Zotero an error can come from another realm (IOUtils, the window's fetch, Subprocess), where instanceof fails.

/** The error's own message when it has one, else the value itself as text (what `String(e?.message ?? e)` did).
 *  @param {unknown} error @returns {string} */
export function errorMessage(error) {
  const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return String(message ?? error);
}

/** A string property of a caught error (`name` for DOMException-style errors, `code` for Node errno errors).
 *  @param {unknown} error @param {"name" | "code" | "kind"} key @returns {string | undefined} */
export function errorField(error, key) {
  if (error === null || typeof error !== 'object' || !(key in error)) return undefined;
  const value = /** @type {Record<string, unknown>} */ (error)[key];
  return typeof value === 'string' ? value : undefined;
}
