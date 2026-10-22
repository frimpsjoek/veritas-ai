// @ts-check
// ui-src/src/export/markdown.js. A GitHub table for a papers or table result: paper cells link to the DOI and carry
// `[@citekey]`, cells carry their citations after the sentence, and each quote becomes a footnote under the table
// ("[^1]: “…” (from abstract) [@key]"), so the table stays readable and the evidence travels with it.
import { toGrid, refLabel, cellPlain, cellRefs, cellQuotes, authorsShort } from './common.js';

/** A value safe inside a table cell: pipes escaped, line breaks as <br>. @param {string} text */
function cellSafe(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, '<br>');
}

/**
 * @param {import("../../../agent-src/src/domain").Result} result
 * @param {{ only?: Set<string> | null }} [opts]
 */
export function toMarkdown(result, opts = {}) {
  const grid = toGrid(result, opts.only ?? null);
  const notes = /** @type {string[]} */ ([]);
  const head = [grid.isPapers ? 'Paper' : 'Item', ...grid.columns.map((c) => c.name)];
  const lines = [`# ${result.title}`, '', `| ${head.map(cellSafe).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of grid.rows) {
    const p = row.paper;
    let first = cellSafe(row.label);
    if (p) {
      const link = p.doi ? `[${cellSafe(p.title)}](https://doi.org/${p.doi})` : p.url ? `[${cellSafe(p.title)}](${p.url})` : cellSafe(p.title);
      const cite = p.ref.kind === 'paper' ? ` ${refLabel(p.ref)}` : '';
      const meta = [authorsShort(p.authors), p.year, p.venue].filter(Boolean).join(' · ');
      first = `${link}${cite}${meta ? `<br>${cellSafe(meta)}` : ''}`;
    }
    const cells = grid.columns.map((column) => {
      const cell = row.cells[column.id];
      if (cell?.state === 'not_found') return cell.note ? `*${cellSafe(cell.note)}*` : '';
      let text = cellSafe(cellPlain(cell));
      const refs = cellRefs(cell).map((ref) => (ref.kind === 'web' ? `[link](${ref.url})` : refLabel(ref)));
      if (refs.length) text += ` ${refs.map(cellSafe).join(' ')}`;
      for (const q of cellQuotes(cell)) {
        notes.push(`“${q.text.replace(/\s+/g, ' ').trim()}” (from ${q.from === 'full_text' ? 'full text' : 'abstract'}${q.verified ? '' : ', unverified'}) ${refLabel(q.ref)}`);
        text += `[^${notes.length}]`;
      }
      return text.trim();
    });
    lines.push(`| ${[first, ...cells].join(' | ')} |`);
  }
  if (notes.length) lines.push('', ...notes.map((note, i) => `[^${i + 1}]: ${note}`));
  return `${lines.join('\n')}\n`;
}
