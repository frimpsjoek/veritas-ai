// @ts-check
// agent-src/src/radar-judge.js. The profile check: one model call reads the best-ranked candidates against the user's
// profile and says which ones are off their field. Similarity to the closest seed ranks by shared words and materials
// ("graphene quantum dots for cancer therapy" sits next to a quantum-dot seed); whether the paper is the user's kind of
// work needs reading. A failed call rejects nothing, so the run falls back to the ranking alone.

/** @typedef {import("./radar-types").RadarItem} RadarItem */

/** Candidates read per run, best first; the New rows are then picked from those that pass. */
export const JUDGE_POOL = 40;
/** On 2026-11-02 the check rejected 29 of its 40, so a long issue needs about three candidates per row. */
export const judgePool = (/** @type {number} */ fresh) => Math.max(JUDGE_POOL, fresh * 3);
const MAX_ABSTRACT = 700;
const MAX_TITLES = 12;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { papers: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, fits: { type: 'boolean' } }, required: ['n', 'fits'], additionalProperties: false } } },
  required: ['papers'],
  additionalProperties: false,
};

/**
 * @param {RadarItem[]} rows
 * @param {{ topics: string[], seeds: string[], rejected: string[] }} profile `seeds`: titles of papers the user picked
 *   as typical of their work; `rejected`: titles they marked not relevant
 */
export function judgePrompt(rows, profile) {
  const list = (/** @type {string[]} */ xs) => xs.slice(0, MAX_TITLES).map((t) => `- ${t}`).join('\n');
  return [
    'You screen new papers for a researcher. Their interests:',
    profile.topics.length ? list(profile.topics) : '- (not stated)',
    ...(profile.seeds.length ? ['Papers typical of their own work:', list(profile.seeds)] : []),
    ...(profile.rejected.length ? ['Papers they marked as not relevant:', list(profile.rejected)] : []),
    'For each paper below, decide whether this researcher would plausibly want to read it.',
    'fits=false when its main subject is a different field (biology, medicine, clinical work, unrelated engineering, for example), even if it shares a material, a method or a word with their interests.',
    'fits=false when it is about AI, agents or software in general, with no application to chemistry, materials or physics: a framework, a benchmark, a harness, agent memory or safety. Interest in AI for science does not cover those, and being unsure does not make them fit.',
    'fits=true when it is in their field or a close neighbour of it. When unsure about a paper in chemistry, materials or physics, answer true.',
    'Answer with JSON: {"papers":[{"n":<paper number>,"fits":true|false}]}, one entry per paper.',
    ...rows.map((r, i) => `\n### Paper ${i + 1}\nTitle: ${r.title}${r.venue ? `\nVenue: ${r.venue}` : ''}\nAbstract: ${String(r.abstract ?? '').trim().slice(0, MAX_ABSTRACT) || '(none)'}`),
  ].join('\n');
}

/**
 * @param {RadarItem[]} pool the best-ranked candidates
 * @param {{ turn: (prompt: string, schema: object) => Promise<unknown>, topics: string[], seeds: string[], rejected: string[] }} ctx
 * @returns {Promise<{ off: Set<string>, error: string | null }>} ids judged off the profile; none when the call failed
 */
export async function judgeFit(pool, ctx) {
  const rows = pool;
  if (!rows.length) return { off: new Set(), error: null };
  try {
    const out = /** @type {any} */ (await ctx.turn(judgePrompt(rows, ctx), JUDGE_SCHEMA));
    const off = new Set();
    for (const entry of Array.isArray(out?.papers) ? out.papers : []) {
      const row = rows[Number(entry?.n) - 1];
      if (row && entry?.fits === false) off.add(row.id);
    }
    // A model that rejects every paper has misread the task more likely than the day is empty.
    if (off.size === rows.length && rows.length > 3) return { off: new Set(), error: 'the profile check rejected every paper; ignored' };
    return { off, error: null };
  } catch (e) {
    return { off: new Set(), error: String(/** @type {any} */ (e)?.message ?? e) };
  }
}
