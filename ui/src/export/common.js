// @ts-check
// ui-src/src/export/common.js. What the three exporters (csv.js, ris.js, markdown.js) share: turning a papers or
// table result into one flat grid, and the short text label for a citation. Pure: no DOM, no host, so node tests
// pin every exporter's output with goldens (spec 007 §4 "Export").

/** @typedef {import("../../../agent/src/domain").Result} Result */
/** @typedef {import("../../../agent/src/domain").Cell} Cell */
/** @typedef {import("../../../agent/src/domain").Quote} Quote */
/** @typedef {import("../../../agent/src/domain").CitationRef} CitationRef */
/** @typedef {import("../../../agent/src/domain").PaperRow} PaperRow */
/** @typedef {import("../../../agent/src/domain").ColumnSpec} ColumnSpec */

/**
 * @typedef {{ id: string, label: string, paper: PaperRow | null, cells: Record<string, Cell> }} GridRow
 * @typedef {{ isPapers: boolean, columns: ColumnSpec[], rows: GridRow[] }} Grid
 */

/**
 * A papers or table result as rows and columns. `only` (a set of row ids, e.g. the ticked rows) keeps just those
 * rows, in their original order. Report and answer results have no grid.
 * @param {Result} result @param {Set<string> | null} [only]
 * @returns {Grid}
 */
export function toGrid(result, only = null) {
  if (result.kind !== 'papers' && result.kind !== 'table') return { isPapers: false, columns: [], rows: [] };
  const isPapers = result.kind === 'papers';
  const rows = /** @type {any[]} */ (result.rows)
    .filter((row) => !only || only.has(row.id))
    .map((row) => ({
      id: row.id, label: isPapers ? row.title : row.label, paper: isPapers ? row : null,
      cells: /** @type {Record<string, Cell>} */ (result.cells?.[row.id] ?? {}),
    }));
  return { isPapers, columns: result.columns ?? [], rows };
}

/** How a citation reads in plain text: `[@citekey]`, `[[Note path]]` or the link. @param {CitationRef} ref */
export function refLabel(ref) {
  if (ref.kind === 'paper') return `[@${ref.citekey}]`;
  if (ref.kind === 'note') return `[[${ref.path}]]`;
  return ref.url;
}

/** @param {CitationRef} ref */
export function refKey(ref) {
  return ref.kind === 'paper' ? `paper:${ref.citekey}` : ref.kind === 'note' ? `note:${ref.path}` : `web:${ref.url}`;
}

/** Every citation a filled cell carries: its own list, then the quotes' refs, each once. @param {Cell | undefined} cell */
export function cellRefs(cell) {
  if (cell?.state !== 'filled') return [];
  const seen = new Set();
  const out = [];
  for (const ref of [...(cell.citations ?? []), ...(cell.quotes ?? []).map((q) => q.ref)]) {
    const key = refKey(ref);
    if (!ref || seen.has(key) || (ref.kind === 'web' && !ref.url)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** @param {Cell | undefined} cell @returns {Quote[]} */
export function cellQuotes(cell) {
  return cell?.state === 'filled' ? cell.quotes ?? [] : [];
}

/** A cell's words with no citations: the value, or the reason there isn't one. @param {Cell | undefined} cell */
export function cellPlain(cell) {
  if (!cell) return '';
  if (cell.state === 'filled') return cell.value ?? '';
  if (cell.state === 'not_found') return cell.note ?? '';
  return '';
}

/** "Wang, Li +2" for the paper column. @param {string[]} authors @param {number} [max] */
export function authorsShort(authors, max = 3) {
  const list = authors ?? [];
  return list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', ');
}
