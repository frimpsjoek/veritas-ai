// @ts-check
// agent-src/src/radar-state.js. Spec 012 R1: a radar's own memory (seen set, source status, feed validators, examples)
// at `<dataDir>/radar/<routineId>/state.json`. Beside the routine record, not in it: the scheduler rewrites that record
// on every run. Written atomically like every store here; a file that does not parse reads as empty state.
// Beside it, `radar-candidates.jsonl`: an append-only log of what each run scored (radar-run.js candidateLog) and of
// each verdict the user gave since (found by comparing the verdicts with the file's), for replaying a ranking change
// (dev/radar-replay.mjs). Writing it never fails a state write.

/** @typedef {import("./radar-types").RadarState} RadarState */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** The seen set is a memory of what was shown, not an archive: oldest entries go first past this. */
export const MAX_SEEN = 5000;
const MAX_EXAMPLES = 200;
/** Details and undo records are kept for the newest rows only: enough for a digest or two. */
export const MAX_SHOWN = 300;
const MAX_LEARNED = 200;
/** Abstracts looked up for title-only papers (and the misses), newest kept: a paper reappears in the lookback window. */
export const MAX_ABSTRACTS = 2000;
/** The learning list is a short memory too: lowest counts, then oldest, go first. */
export const MAX_CANDIDATES = 300;

/** The candidate log, beside state.json. */
export const CANDIDATE_LOG = 'radar-candidates.jsonl';
/** A run trims the log once it is past LOG_TRIM_BYTES: lines older than LOG_DAYS go, then all but the newest LOG_LINES.
 *  A run logs a few hundred to a few thousand lines of about 400 bytes; 100k lines is about 40 MB. */
export const LOG_DAYS = 90;
export const LOG_LINES = 100_000;
const LOG_TRIM_BYTES = 4_000_000;
/** The verdicts a person gives; a paper going back to "shown" from one of them is an undo. */
const USER_VERDICTS = new Set(['added', 'later', 'liked', 'dismissed']);

/** @returns {import("./radar-types").PhraseLedger} */
export const emptyLedger = () => ({ learning: [], blocked: [], rotation: 0, announce: [] });

/** @returns {RadarState} */
export const emptyState = () => ({ seen: {}, sourceStatus: {}, feedCache: {}, refs: {}, examples: { positive: [], negative: [] }, shown: {}, learned: [], streaks: {}, undo: {}, phrases: emptyLedger(), abstracts: {} });

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
  return { seen: obj(r.seen), sourceStatus: obj(r.sourceStatus), feedCache: obj(r.feedCache), refs: obj(r.refs), examples: { positive: list(ex.positive), negative: list(ex.negative) }, shown: obj(r.shown), learned: list(r.learned), streaks: obj(r.streaks), undo: obj(r.undo), phrases: normaliseLedger(r.phrases), abstracts: obj(r.abstracts), ...(typeof r.calibrateTried === 'string' ? { calibrateTried: r.calibrateTried } : {}), ...(Array.isArray(r.nearBar?.rows) ? { nearBar: r.nearBar } : {}), ...(typeof r.logProblem?.error === 'string' ? { logProblem: r.logProblem } : {}) };
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
    abstracts: Object.fromEntries(Object.entries(state.abstracts ?? {}).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ABSTRACTS)),
  };
}

/** @param {import("./radar-types").PhraseCandidate[]} learning */
function trimCandidates(learning) {
  if (learning.length <= MAX_CANDIDATES) return learning;
  const drop = new Set([...learning.keys()].sort((a, b) => learning[a].papers.length - learning[b].papers.length || a - b).slice(0, learning.length - MAX_CANDIDATES));
  return learning.filter((_, i) => !drop.has(i));
}

/** A paper's verdict: that of the first of its keys the seen set has. @param {RadarState} state @param {string[]} keys */
const verdictOf = (state, keys) => { for (const k of keys) if (state.seen[k]) return state.seen[k].verdict; return null; };

/** One line per shown paper whose verdict the person changed between `before` and `after` (an undo logs "shown").
 *  @param {RadarState} before @param {RadarState} after @param {string} at */
export function verdictLines(before, after, at) {
  const out = [];
  for (const [id, paper] of Object.entries(after.shown)) {
    const was = verdictOf(before, paper.keys), now = verdictOf(after, paper.keys);
    if (now === was || !(USER_VERDICTS.has(now ?? '') || (USER_VERDICTS.has(was ?? '') && now === 'shown'))) continue;
    out.push({ at, type: 'verdict', id, keys: paper.keys, verdict: now });
  }
  return out;
}

/** Keeps lines newer than `days` before `now`, then the newest `max`; a line with no time is dropped.
 *  @param {string} text @param {number} now @param {number} days @param {number} max */
export function trimLog(text, now, days, max) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const kept = text.split('\n').filter((l) => { const at = /"at":"([^"]+)"/.exec(l)?.[1]; return at != null && at >= since; });
  return kept.slice(-max);
}

/** @param {Pick<import("./platform").Platform['fs'], 'read' | 'writeAtomic'> & Partial<Pick<import("./platform").Platform['fs'], 'append' | 'stat'>>} fs @param {string} dataDir
 *  @param {{ now?: () => number, logDays?: number, logLines?: number, trimBytes?: number }} [opts] tests pass a clock and small limits */
export function createRadarStore(fs, dataDir, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  /** @param {string} routineId */
  const folder = (routineId) => {
    if (!SAFE_ID.test(String(routineId))) throw new Error('Invalid routine id.');
    return `${dataDir}/radar/${routineId}`;
  };
  const file = (/** @type {string} */ routineId) => `${folder(routineId)}/state.json`;

  /** Appends a run's lines and the verdicts given since the file was written; a run's write trims the log first.
   *  @param {string} routineId @param {RadarState} state @param {Record<string, unknown>[]} pending */
  async function appendLog(routineId, state, pending) {
    const path = `${folder(routineId)}/${CANDIDATE_LOG}`;
    const text = await fs.read(file(routineId));
    let before = emptyState();
    try { if (text != null) before = normaliseState(JSON.parse(text)); } catch { /* a torn file: every verdict counts as new */ }
    const at = new Date(now()).toISOString();
    const out = [...verdictLines(before, state, at), ...pending].map((l) => JSON.stringify({ ...l, radar: routineId }));
    if (!out.length) return;
    if (!fs.append) throw new Error('this host cannot append to files');
    if (pending.length) {
      const size = fs.stat ? (await fs.stat(path))?.size ?? 0 : (await fs.read(path))?.length ?? 0;
      if (size > (opts.trimBytes ?? LOG_TRIM_BYTES)) {
        const kept = trimLog((await fs.read(path)) ?? '', now(), opts.logDays ?? LOG_DAYS, Math.max(0, (opts.logLines ?? LOG_LINES) - out.length));
        await fs.writeAtomic(path, kept.length ? `${kept.join('\n')}\n` : '');
      }
    }
    await fs.append(path, out.join('\n'));
  }

  return {
    /** @param {string} routineId @returns {Promise<RadarState>} */
    async read(routineId) {
      const text = await fs.read(file(routineId));
      if (text == null) return emptyState();
      try { return normaliseState(JSON.parse(text)); } catch { return emptyState(); }
    },
    /** A run's state carries its candidate lines (`pendingLog`); they go to the log, never into state.json. A log
     *  that cannot be written is noted on the state (`logProblem`) and the state is written all the same.
     *  @param {string} routineId @param {RadarState} state */
    async write(routineId, state) {
      const { pendingLog, logProblem: _was, ...rest } = state;
      /** @type {RadarState} */
      let next = rest;
      try { await appendLog(routineId, rest, pendingLog ?? []); } catch (e) {
        next = { ...rest, logProblem: { at: new Date(now()).toISOString(), error: String(/** @type {any} */ (e)?.message ?? e) } };
      }
      await fs.writeAtomic(file(routineId), JSON.stringify(trimState(next), null, 2));
    },
  };
}

/** Phrases that have come from at least two liked papers but are not topics yet, for "Learning… 2 of 3". @param {RadarState} state @returns {{ text: string, count: number }[]} */
export function learningOf(state) {
  return state.phrases.learning.filter((c) => c.papers.length >= 2).map((c) => ({ text: c.text, count: c.papers.length })).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1)).slice(0, 12);
}
