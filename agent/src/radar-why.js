// @ts-check
// agent-src/src/radar-why.js. Spec 012 R4 (section 3, step 7): one short "why read this" line per top row, written by one
// model call from the abstracts alone. A failed call, or a line for a row that was never sent, leaves that row without a
// line; it never fails the run.

/** @typedef {import("./radar-types").RadarItem} RadarItem */

/** Spec success check 2: at most 20 short lines per run. */
export const MAX_WHY_ROWS = 20;
const MAX_ABSTRACT = 1200;
const MAX_LINE = 220;
export const NO_ABSTRACT = 'No abstract to go on';

export const WHY_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, line: { type: 'string' } }, required: ['n', 'line'], additionalProperties: false } } },
  required: ['lines'],
  additionalProperties: false,
};

/** @param {RadarItem[]} rows the rows that have an abstract @param {string[]} topics */
export function whyPrompt(rows, topics) {
  return [
    'You help a researcher decide which new papers to read. Their interests are:',
    topics.length ? topics.map((t) => `- ${t}`).join('\n') : '- (not stated)',
    'For each paper below, write ONE sentence (at most 25 words) saying why it may matter to someone with those interests.',
    'Use only what its abstract says. Do not invent results, numbers or methods, and do not repeat the title. If the abstract does not connect to the interests, say what the paper is about in one plain sentence.',
    'Answer with JSON: {"lines":[{"n":<paper number>,"line":"<the sentence>"}]}, one entry per paper.',
    ...rows.map((r, i) => `\n### Paper ${i + 1}\nTitle: ${r.title}\nAbstract: ${r.abstract.slice(0, MAX_ABSTRACT)}`),
  ].join('\n');
}

/** One plain line from whatever the model returned. @param {unknown} text */
function cleanLine(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

/**
 * @param {RadarItem[]} items the picked New rows, best first
 * @param {{ turn: (prompt: string, schema: object) => Promise<unknown>, topics: string[] }} ctx
 * @returns {Promise<{ lines: Map<string, string>, error: string | null }>} lines by item id; `error` says why there are none
 */
export async function whyLines(items, ctx) {
  const { lines, error } = await modelLines(items, ctx);
  // Spec 017: a row found through a learned topic says so, whatever the model did.
  for (const it of items) {
    const learned = it.why?.learned;
    if (!learned) continue;
    const said = lines.get(it.id);
    lines.set(it.id, `${learnedLine(learned)}${said ? ` ${said}` : ''}`);
  }
  // A seed radar's line is the AI summary alone (the user's choice, 2026-10-21); which seed a paper is close to stays in
  // why.seed. Only a row the model wrote nothing for falls back to naming that seed.
  for (const it of items) {
    const seed = it.why?.seed;
    if (seed && !lines.get(it.id)) lines.set(it.id, seedLine(seed.title, it.why?.similarity ?? 0, seed.whole));
  }
  return { lines, error };
}

/** "Close to “Title” (0.84, whole paper)." @param {string} title @param {number} similarity @param {boolean} whole */
export const seedLine = (title, similarity, whole) => `Close to \u201C${title.length > 90 ? `${title.slice(0, 89).trimEnd()}\u2026` : title}\u201D (${similarity.toFixed(2)}${whole ? ', whole paper' : ''}).`;

/** The fixed sentence for a row that matched a learned topic. @param {string} topic */
export const learnedLine = (topic) => `Matches \u201C${topic}\u201D, learned from your ratings.`;

/** @param {RadarItem[]} items @param {{ turn: (prompt: string, schema: object) => Promise<unknown>, topics: string[] }} ctx */
async function modelLines(items, ctx) {
  /** @type {Map<string, string>} */
  const lines = new Map();
  const rows = items.filter((it) => it.abstract).slice(0, MAX_WHY_ROWS);
  if (!rows.length) return { lines, error: null };
  try {
    const out = /** @type {any} */ (await ctx.turn(whyPrompt(rows, ctx.topics), WHY_SCHEMA));
    for (const entry of Array.isArray(out?.lines) ? out.lines : []) {
      const row = rows[Number(entry?.n) - 1];
      const line = cleanLine(entry?.line);
      if (row && line && !lines.has(row.id)) lines.set(row.id, line);
    }
    return { lines, error: null };
  } catch (e) {
    return { lines: new Map(), error: String(/** @type {any} */ (e)?.message ?? e) };
  }
}
