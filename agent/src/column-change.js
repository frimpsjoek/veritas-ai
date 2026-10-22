// @ts-check
// Spec 011 U2: a column change is a turn in the session's thread. The user's side reads "Add the column “X”" and the
// reply says in plain words how it went and which papers had nothing to give. Both are written by our code, not a
// model turn: the table's own cells already say everything, so an extra turn would only cost.

/** @typedef {import("./domain").ColumnSpec} ColumnSpec */
/** @typedef {import("./domain").Cell} Cell */

const NAMES_SHOWN = 4;
const quote = (/** @type {string} */ name) => `“${name}”`;
const list = (/** @type {string[]} */ names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The gap fill's user turn: the "not reported" cells are read again from a stronger text. */
export const gapFillUserText = () => 'Look again for the cells with no data';

/** @param {{ found: number, total: number, failed?: number, status: "done" | "failed" | "cancelled" | "stopped" }} a */
export function gapFillReply({ found, total, failed = 0, status }) {
  if (status === 'failed') return "I couldn't look again. The table is as it was.";
  const head = status === 'done' ? 'Done.' : 'Stopped before every paper was read.';
  const unread = failed > 0 ? `${failed} could not be read this time, ` : '';
  if (!found) {
    return `${head} Nothing more turned up for the ${total} cell${total === 1 ? '' : 's'} with no data${failed > 0 ? `; ${failed} could not be read this time` : ''}.`;
  }
  return `${head} Found a value for ${found} of ${total} cell${total === 1 ? '' : 's'} that had none; ${unread}the rest are still not reported.`;
}

/** What the user's turn says. @param {ColumnSpec[]} add */
export function columnChangeUserText(add) {
  if (add.length === 1) return `Add the column ${quote(add[0].name)}${add[0].instruction ? `: ${add[0].instruction}` : ''}`;
  return `Add ${add.length} columns: ${list(add.map((c) => quote(c.name)))}`;
}

/**
 * The reply once the step has ended. Counts per added column, then names the papers whose cell is "not reported".
 * @param {{ add: ColumnSpec[], rows: { id: string, title: string }[], cellOf: (rowId: string, columnId: string) => Cell | undefined,
 *   status: "done" | "failed" | "cancelled" | "stopped" }} a
 */
export function columnChangeReply({ add, rows, cellOf, status }) {
  if (status === 'failed') return `I couldn't fill ${list(add.map((c) => quote(c.name)))}. The table is as it was.`;
  const parts = [];
  for (const column of add) {
    let filled = 0;
    const blank = [];
    for (const row of rows) {
      const cell = cellOf(row.id, column.id);
      if (cell?.state === 'filled') filled++;
      else if (cell?.state === 'not_found') blank.push(row.title);
    }
    let line = `${quote(column.name)}: ${filled} of ${rows.length} filled`;
    if (blank.length) {
      const shown = blank.slice(0, NAMES_SHOWN).map((t) => (t.length > 70 ? `${t.slice(0, 67)}…` : t));
      line += `, ${blank.length} not reported (${shown.join('; ')}${blank.length > NAMES_SHOWN ? `; and ${blank.length - NAMES_SHOWN} more` : ''})`;
    }
    parts.push(line);
  }
  const head = status === 'done' ? 'Done.' : 'Stopped before every paper was read.';
  return `${head} ${parts.join('. ')}.`;
}
