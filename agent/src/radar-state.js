// @ts-check
// agent-src/src/radar-state.js. Spec 012 R1: a radar's own memory (seen set, source status, feed validators, examples)
// at `<dataDir>/radar/<routineId>/state.json`. Beside the routine record, not in it: the scheduler rewrites that record
// on every run. Written atomically like every store here; a file that does not parse reads as empty state.

/** @typedef {import("./radar-types").RadarState} RadarState */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** The seen set is a memory of what was shown, not an archive: oldest entries go first past this. */
export const MAX_SEEN = 5000;
const MAX_EXAMPLES = 200;
/** Details and undo records are kept for the newest rows only: enough for a digest or two. */
export const MAX_SHOWN = 300;
const MAX_LEARNED = 200;
/** The learning list is a short memory too: lowest counts, then oldest, go first. */
export const MAX_CANDIDATES = 300;

/** @returns {import("./radar-types").PhraseLedger} */
export const emptyLedger = () => ({ learning: [], blocked: [], rotation: 0, announce: [] });

/** @returns {RadarState} */
export const emptyState = () => ({ seen: {}, sourceStatus: {}, feedCache: {}, refs: {}, examples: { positive: [], negative: [] }, shown: {}, learned: [], streaks: {}, undo: {}, phrases: emptyLedger() });

const obj = (/** @type {any} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);

/** @param {any} raw @returns {import("./radar-types").PhraseLedger} */
function normaliseLedger(raw) {
  const r = obj(raw);
  return { learning: list(r.learning), blocked: list(r.blocked), rotation: Number.isFinite(r.rotation) ? r.rotation : 0, announce: list(r.announce) };
}

/** Tolerant read: unknown shapes become the empty value, so a half-written or older file never stops a run. @param {any} raw @returns {RadarState} */
export function normaliseState(raw) {
  const r = obj(raw), ex = obj(r.examples);
  return { seen: obj(r.seen), sourceStatus: obj(r.sourceStatus), feedCache: obj(r.feedCache), refs: obj(r.refs), examples: { positive: list(ex.positive), negative: list(ex.negative) }, shown: obj(r.shown), learned: list(r.learned), streaks: obj(r.streaks), undo: obj(r.undo), phrases: normaliseLedger(r.phrases) };
}

/** Trims the oldest seen entries, examples, row details and undo records. @param {RadarState} state @returns {RadarState} */
export function trimState(state) {
  const ids = Object.keys(state.seen);
  let seen = state.seen;
  if (ids.length > MAX_SEEN) {
    const keep = ids.sort((a, b) => (state.seen[b].at < state.seen[a].at ? -1 : state.seen[b].at > state.seen[a].at ? 1 : 0)).slice(0, MAX_SEEN);
    seen = Object.fromEntries(keep.map((k) => [k, state.seen[k]]));
  }
  const newest = (/** @type {Record<string, any>} */ m) => Object.fromEntries(Object.entries(m).slice(-MAX_SHOWN));
  return {
    ...state, seen, examples: { positive: state.examples.positive.slice(-MAX_EXAMPLES), negative: state.examples.negative.slice(-MAX_EXAMPLES) },
    shown: newest(state.shown), undo: newest(state.undo), learned: state.learned.slice(-MAX_LEARNED),
    phrases: { ...state.phrases, learning: trimCandidates(state.phrases.learning), blocked: state.phrases.blocked.slice(-500) },
  };
}

/** @param {import("./radar-types").PhraseCandidate[]} learning */
function trimCandidates(learning) {
  if (learning.length <= MAX_CANDIDATES) return learning;
  const drop = new Set([...learning.keys()].sort((a, b) => learning[a].papers.length - learning[b].papers.length || a - b).slice(0, learning.length - MAX_CANDIDATES));
  return learning.filter((_, i) => !drop.has(i));
}

/** @param {Pick<import("./platform").Platform['fs'], 'read' | 'writeAtomic'>} fs @param {string} dataDir */
export function createRadarStore(fs, dataDir) {
  /** @param {string} routineId */
  const file = (routineId) => {
    if (!SAFE_ID.test(String(routineId))) throw new Error('Invalid routine id.');
    return `${dataDir}/radar/${routineId}/state.json`;
  };
  return {
    /** @param {string} routineId @returns {Promise<RadarState>} */
    async read(routineId) {
      const text = await fs.read(file(routineId));
      if (text == null) return emptyState();
      try { return normaliseState(JSON.parse(text)); } catch { return emptyState(); }
    },
    /** @param {string} routineId @param {RadarState} state */
    async write(routineId, state) {
      await fs.writeAtomic(file(routineId), JSON.stringify(trimState(state), null, 2));
    },
  };
}

/** Phrases that have come from at least two liked papers but are not topics yet, for "Learning… 2 of 3". @param {RadarState} state @returns {{ text: string, count: number }[]} */
export function learningOf(state) {
  return state.phrases.learning.filter((c) => c.papers.length >= 2).map((c) => ({ text: c.text, count: c.papers.length })).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1)).slice(0, 12);
}
