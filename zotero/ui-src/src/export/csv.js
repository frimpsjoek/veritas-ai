// @ts-check
// ui-src/src/export/csv.js. CSV for a papers or table result: paper columns (or the row label), then one column per
// result column, and with `quotes` a `<Column> quote` column after each. Fields are quoted only when they need it
// (comma, quote, line break), quotes doubled, rows end in CRLF (RFC 4180, what Excel and Numbers expect).
import { toGrid, refLabel, cellPlain, cellRefs, cellQuotes } from './common.js';

/** @param {unknown} value */
export function field(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {import("../../../agent-src/src/domain").Result} result
 * @param {{ quotes?: boolean, only?: Set<string> | null }} [opts]
 */
export function toCsv(result, opts = {}) {
  const grid = toGrid(result, opts.only ?? null);
  const head = grid.isPapers ? ['Title', 'Authors', 'Year', 'Venue', 'DOI', 'In library'] : ['Item'];
  for (const column of grid.columns) {
    head.push(column.name);
    if (opts.quotes) head.push(`${column.name} quote`);
  }
  const lines = [head.map(field).join(',')];
  for (const row of grid.rows) {
    const p = row.paper;
    const out = p ? [p.title, p.authors.join('; '), p.year ?? '', p.venue, p.doi ?? '', p.inLibrary ? 'yes' : 'no'] : [row.label];
    for (const column of grid.columns) {
      const cell = row.cells[column.id];
      const refs = cellRefs(cell).map(refLabel).join(' ');
      out.push([cellPlain(cell), refs].filter(Boolean).join(' '));
      if (opts.quotes) out.push(cellQuotes(cell).map((q) => (q.verified ? q.text : `${q.text} [unverified]`)).join(' | '));
    }
    lines.push(out.map(field).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
