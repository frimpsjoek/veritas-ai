// @ts-check
// ui-src/src/export/ris.js. RIS for paper rows, moved out of find-view.js unchanged (byte for byte: the Zotero
// harness tests compare it). Takes a Find papers row (`type` may be "book") or a result's PaperRow (no `type`, so
// a journal article); Zotero and every other reference manager reads the file the same way.

/**
 * @param {{ title: string, authors: string[], year: number | string | null, venue: string, doi: string | null,
 *           abstract: string, type?: string }[]} rows
 */
export function toRis(rows) {
  const clean = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  return rows.map((r) => [
    `TY  - ${r.type === 'book' ? 'BOOK' : 'JOUR'}`, `TI  - ${clean(r.title)}`,
    ...r.authors.map((a) => `AU  - ${clean(a)}`),
    r.year && `PY  - ${r.year}`, r.venue && `JO  - ${clean(r.venue)}`, r.doi && `DO  - ${r.doi}`,
    r.abstract && `AB  - ${clean(r.abstract)}`, 'ER  - ',
  ].filter(Boolean).join('\r\n')).join('\r\n\r\n') + '\r\n';
}
