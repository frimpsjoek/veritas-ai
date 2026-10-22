// @ts-check
// agent-src/src/citations.js. Extracts citations from answer text and resolves them against the library and
// whatever a tool actually returned this turn. A fabricated [@key] or [[Note]] is flagged as "unknown", never
// silently shown as real (F2). A web link only counts as resolved if a tool result in this turn returned it.

const NOTE_RE = /\[\[(.+?)\]\](?!\])/g; // lazy + lookahead: titles may contain "[id]"
const CITEKEY_RE = /\[@([A-Za-z0-9_:.-]+)\]/g;
const URL_RE = /\bhttps?:\/\/[^\s)\]"']+/g;

/** @param {import("./domain").CitationRef} ref */
export function citationKey(ref) {
  if (ref.kind === 'note') return `note:${ref.path}`;
  if (ref.kind === 'paper') return `paper:${ref.citekey}`;
  return `web:${ref.url}`;
}

/** @param {string} text @returns {import("./domain").CitationRef[]} */
export function extractCitationRefs(text) {
  // What the answer text claims; resolving the claimed path or key against the library is validateCitations' job.
  /** @type {import("./domain").CitationRef[]} */
  const refs = [];
  for (const m of text.matchAll(NOTE_RE)) refs.push({ kind: 'note', path: /** @type {import("./domain").NotePath} */ (m[1]) });
  for (const m of text.matchAll(CITEKEY_RE)) refs.push({ kind: 'paper', citekey: /** @type {import("./domain").Citekey} */ (m[1]) });
  for (const m of text.matchAll(URL_RE)) refs.push({ kind: 'web', url: m[0].replace(/[).,;:]+$/, '') });
  return refs;
}

/**
 * @param {string} text
 * @param {import("./tools").LibraryBackend} library
 * @param {import("./domain").CitationRef[]} seen  everything a tool result returned this turn
 * @returns {Promise<import("./domain").Citation[]>}
 */
export async function validateCitations(text, library, seen) {
  const refs = extractCitationRefs(text);
  if (!refs.length) return [];
  const seenKeys = new Set(seen.map(citationKey));
  const nonWeb = refs.filter((r) => r.kind !== 'web');
  const resolved = nonWeb.length ? await library.resolve(nonWeb) : new Map();

  return refs.map((ref) => {
    const key = citationKey(ref);
    if (ref.kind === 'web') {
      return seenKeys.has(key)
        ? { ref, status: 'resolved', title: ref.url, retrievedThisTurn: true }
        : { ref, status: 'unknown' };
    }
    const hit = resolved.get(key);
    return hit
      ? { ref, status: 'resolved', title: hit.title, retrievedThisTurn: seenKeys.has(key) }
      : { ref, status: 'unknown' };
  });
}

/** A DOI link in any of its usual spellings maps to one key, so "https://doi.org/10.1/X" and "http://dx.doi.org/10.1/x"
 *  are the same paper. Everything else keeps its exact key. @param {import("./domain").CitationRef} ref */
export function scopeKey(ref) {
  if (ref.kind === 'web') {
    const m = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(ref.url);
    if (m) return `doi:${decodeURIComponent(m[1]).toLowerCase()}`;
  }
  return citationKey(ref);
}

/**
 * spec 007 §6: a `chat_papers` answer may only cite the papers of its subset. A citation inside the subset resolves
 * (a library paper through the library, an outside paper by its DOI link, both without needing a tool call this
 * turn); any other citation is flagged `unknown`, the validator's existing "unresolved" path, whatever the library says.
 * @param {import("./domain").Citation[]} citations
 * @param {{ ref: import("./domain").CitationRef, title: string }[]} rows the subset
 * @returns {import("./domain").Citation[]}
 */
export function restrictToRows(citations, rows) {
  const inside = new Map(rows.map((r) => [scopeKey(r.ref), r.title]));
  return citations.map((c) => {
    const title = inside.get(scopeKey(c.ref));
    if (title === undefined) return { ref: c.ref, status: 'unknown' };
    if (c.status === 'resolved') return c;
    // Not resolved by the validator: only an outside paper (web ref) is rescued, because the set itself vouches for it.
    return c.ref.kind === 'web' ? { ref: c.ref, status: 'resolved', title, retrievedThisTurn: false } : c;
  });
}
