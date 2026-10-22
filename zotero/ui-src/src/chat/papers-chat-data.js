// @ts-check
// ui-src/src/chat/papers-chat-data.js. Pure logic for "Chat with papers" (spec 007 §6, unit E5): which papers a
// question is about (ticked, else visible, else all), how a recorded scope reads, and which stored turns belong to a
// result. No DOM, so node tests cover it.

/** What the tab offers before the first question: plain and generic, they fit any paper set. */
export const SUGGESTIONS = [
  'What do these papers have in common?',
  'Which of these used the largest samples?',
  'Where do these papers disagree?',
];

/** The follow-up that turns an answer into a table (spec 007 §1.6: the chat's own sb-table path). */
export const TABLE_ASK = 'Make a table from this answer.';

/**
 * The scope of a question. Ticked rows that are still visible win; else the visible rows (after search and filters);
 * "All N" (`all`) asks about every row of the version. When the visible rows are the whole set, the scope is the
 * whole set and there is nothing to toggle.
 * @param {{ visible: string[], ticked: Set<string> | string[], total: number, all?: boolean }} input
 * @returns {{ rows: string[] | "all", ids: string[], count: number, total: number, whole: boolean, empty: boolean, label: string,
 *             toggle: { label: string, to: "all" | "these" } | null, ticked: boolean }}
 */
export function chatScope({ visible, ticked, total, all = false }) {
  const tickSet = ticked instanceof Set ? ticked : new Set(ticked);
  const tickedVisible = visible.filter((id) => tickSet.has(id));
  const subset = tickedVisible.length ? tickedVisible : visible;
  const whole = all || (subset.length === total && total > 0);
  const count = whole ? total : subset.length;
  const noun = count === 1 ? 'paper' : 'papers';
  const label = count === 0 ? 'No papers to ask about' : count === 1 ? 'This paper' : whole ? `All ${count} papers` : `These ${count} ${noun}`;
  const narrower = subset.length < total;
  /** @type {{ label: string, to: "all" | "these" } | null} */
  const toggle = !narrower ? null : all ? { label: `These ${subset.length}`, to: 'these' } : { label: `All ${total}`, to: 'all' };
  return { rows: whole ? 'all' : subset, ids: subset, count, total, whole, empty: count === 0, label, toggle, ticked: tickedVisible.length > 0 };
}

/** How a recorded scope reads under a question: "All 40 papers", "18 of 40 papers", "1 paper".
 *  @param {{ rows: string[] | "all" } | undefined | null} on @param {number | null} [total] rows in the set, when known */
export function describeOn(on, total = null) {
  if (!on) return '';
  const n = on.rows === 'all' ? total : on.rows.length;
  if (on.rows === 'all' || (total != null && n === total)) return total == null ? 'All papers' : total === 1 ? '1 paper' : `All ${total} papers`;
  if (n === 1) return '1 paper';
  return total == null ? `${n} papers` : `${n} of ${total} papers`;
}

/**
 * The stored turns that were about one result: each user record whose `on.result.id` is `resultId`, with the record
 * that answered it (the next assistant or failed record, before any other user record).
 * @param {any[]} records @param {string} resultId
 * @returns {{ user: any, reply: any | null }[]}
 */
export function turnsOn(records, resultId) {
  /** @type {{ user: any, reply: any | null }[]} */
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type !== 'user' || r.on?.result?.id !== resultId) continue;
    let reply = null;
    for (let j = i + 1; j < records.length; j++) {
      const n = records[j];
      if (n.type === 'user') break;
      if (n.type === 'assistant' || n.type === 'failed') { reply = n; break; }
    }
    out.push({ user: r, reply });
  }
  return out;
}
