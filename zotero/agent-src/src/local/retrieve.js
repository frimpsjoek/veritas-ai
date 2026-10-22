// @ts-check
// agent-src/src/local/retrieve.js (spec 010 §4). A local model never drives tools. For Chat and Ask the engine fetches
// the passages itself: whatever the user attached (read in part), then the library search, up to 5 in all.
import { extractCitationRefs, citationKey } from '../citations.js';

export const PASSAGE_COUNT = 5;
const ATTACHED_CHARS = 1500;
const ATTACHED_MAX = 2;
const ATTACHED_MARK = '\n\nThe user attached:';

/** @typedef {{ ref: import("../domain").CitationRef, title: string, snippet: string, year?: number | null }} Passage */

/** The user's own words, without the attachment lines core.js appends. @param {string} input */
export function questionOf(input) {
  const at = input.indexOf(ATTACHED_MARK);
  return (at >= 0 ? input.slice(0, at) : input).trim();
}

const SMALL_TALK = /^(hi+|hey+|hello+|yo|hiya|howdy|good (morning|afternoon|evening|night)|morning|evening|thanks?( you)?( so much| a lot)?|thank u|thx|ty|cheers|ok(ay)?|cool|nice|great|awesome|got it|sounds good|bye|goodbye|see you|how are you( doing)?|how's it going|what's up|sup|who are you|what are you|what can you do|help)( (there|again|so much|friend|buddy))?$/;

/** A greeting, a thank-you or "what can you do": nothing to look up, so the engine skips the search.
 *  @param {string} input */
export function isSmallTalk(input) {
  if (input.includes(ATTACHED_MARK)) return false;
  const words = input.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return words.length > 0 && words.split(' ').length <= 6 && SMALL_TALK.test(words);
}

/** A short follow-up ("and the second one?") searches poorly alone, so it borrows the previous question.
 *  @param {string} question @param {import("../provider").HistoryMessage[]} history */
export function queryFor(question, history) {
  const words = question.split(/\s+/).filter(Boolean).length;
  const previous = [...history].reverse().find((h) => h.role === 'user')?.text;
  const joined = words < 5 && previous ? `${previous.split(ATTACHED_MARK)[0].trim()} ${question}` : question;
  return joined.slice(0, 300);
}

/** @param {string} input @returns {import("../domain").CitationRef[]} papers and notes the user attached */
export function attachedRefs(input) {
  const at = input.indexOf(ATTACHED_MARK);
  if (at < 0) return [];
  return extractCitationRefs(input.slice(at)).filter((r) => r.kind !== 'web');
}

/** @param {import("../domain").CitationRef} ref */
export function labelOf(ref) { return ref.kind === 'note' ? `[[${ref.path}]]` : ref.kind === 'paper' ? `[@${ref.citekey}]` : ref.url; }

/**
 * @param {{ library: import("../tools").LibraryBackend, ctx: import("../tools").ToolContext, input: string, history: import("../provider").HistoryMessage[] }} args
 * @returns {Promise<{ query: string, passages: Passage[] }>}
 */
export async function retrievePassages({ library, ctx, input, history }) {
  const query = queryFor(questionOf(input), history);
  const sources = ctx.sources;
  /** @type {Passage[]} */
  const passages = [];
  const have = new Set();
  const add = (p) => { const key = citationKey(p.ref); if (!have.has(key) && passages.length < PASSAGE_COUNT) { have.add(key); passages.push(p); } };

  for (const ref of attachedRefs(input).slice(0, ATTACHED_MAX)) {
    if ((ref.kind === 'paper' && !sources.papers) || (ref.kind === 'note' && !sources.notes)) continue;
    const read = await library.read(ref, { maxChars: ATTACHED_CHARS });
    if (read) add({ ref, title: read.title, snippet: read.text.trim().slice(0, ATTACHED_CHARS) });
  }
  if (sources.papers || sources.notes) {
    const only = sources.papers && !sources.notes ? 'papers' : (!sources.papers && sources.notes ? 'notes' : undefined);
    const hits = await library.search({ text: query, scope: ctx.scope, limit: PASSAGE_COUNT, only });
    for (const h of hits) add({ ref: h.ref, title: h.title, snippet: h.snippet, year: h.year });
  }
  return { query, passages };
}

const SET_SNIPPET_CHARS = 700;
const words = (/** @type {string} */ t) => t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

/** Chat with papers on a local model: the passages are the chosen papers themselves (title and abstract), best match to
 *  the question first, up to 5. No library search: a set can hold papers that are not in the library.
 *  @param {import("../domain").PaperRow[]} rows @param {string} query @returns {Passage[]} */
export function passagesFromSet(rows, query) {
  const want = new Set(words(query));
  return rows
    .map((row, index) => {
      const text = `${row.title} ${row.abstract ?? ''}`;
      const hit = new Set(words(text).filter((w) => want.has(w))).size;
      return { row, index, hit };
    })
    .sort((a, b) => b.hit - a.hit || a.index - b.index)
    .slice(0, PASSAGE_COUNT)
    .map(({ row }) => ({ ref: row.ref, title: row.title, snippet: (row.abstract?.trim() || row.title).slice(0, SET_SNIPPET_CHARS), year: row.year }));
}

/** @param {Passage[]} passages */
export function passageBlock(passages) {
  const lines = passages.map((p, i) => `${i + 1}. ${labelOf(p.ref)} ${p.title}${p.year ? ` (${p.year})` : ''}\n${p.snippet.replace(/\n{2,}/g, '\n')}`);
  return `Passages from the user's library (your only sources):\n\n${lines.join('\n\n')}`;
}

/** The answer when nothing was found: no model is started. @param {boolean} sourcesOff @param {object | null} schema */
export function notFoundAnswer(sourcesOff, schema) {
  const markdown = sourcesOff
    ? 'Papers and Notes are both turned off, so there is nothing to answer from. Turn one on and ask again.'
    : "I couldn't find anything in your library about this.";
  const structured = schema ? { status: 'not_found', markdown } : null;
  return { text: schema ? JSON.stringify(structured) : markdown, structured };
}
