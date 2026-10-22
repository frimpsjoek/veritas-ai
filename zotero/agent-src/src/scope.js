// @ts-check
// agent-src/src/scope.js. Spec 008 Z3: the Scope union dropped `{ kind: "collection"; name }` for `{ kind:
// "collections"; keys }` — descendant expansion and multi-collection search both work on keys, names don't. A
// scope saved before this change (a review's request.json, a Find papers search) still has the old shape on
// disk; nothing there is ever rewritten, so every reader treats it as untrusted input and maps it back to a real
// Scope at the point it's used, with migrateScope.
/** @typedef {{ key: string; name: string }} CollectionRef */

/**
 * @param {unknown} scope
 * @param {CollectionRef[]} [collections] the current collection list, for resolving a pre-Z3 `name` to its
 *   key(s); a name can match more than one collection (Zotero allows the same name under different parents), so
 *   every matching key is kept. Omit when the caller has no such list at hand — an unresolved name then yields no
 *   keys, the same as the pre-Z3 code finding no matching collection at all.
 * @returns {import("./domain").Scope}
 */
export function migrateScope(scope, collections = []) {
  const raw = /** @type {{ kind?: unknown; name?: unknown; keys?: unknown }} */ (scope ?? {});
  if (raw.kind === 'collection' && typeof raw.name === 'string') {
    return { kind: 'collections', keys: collections.filter((c) => c.name === raw.name).map((c) => c.key) };
  }
  if (raw.kind === 'collections') {
    return { kind: 'collections', keys: Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === 'string') : [] };
  }
  if (raw.kind === 'tag' && typeof raw.name === 'string') return { kind: 'tag', name: raw.name };
  if (raw.kind === 'savedSearch' && typeof raw.name === 'string') return { kind: 'savedSearch', name: raw.name };
  return { kind: 'library' };
}
