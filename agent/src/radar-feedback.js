// @ts-check
// agent-src/src/radar-feedback.js. Spec 012 R4 (section 7, "Learning"): what Add to Zotero, Read later and Not relevant change
// in a radar, and how Undo puts it back exactly. Pure: it takes the RadarState and the profile and returns new ones; core.js
// does the reading and writing. A paper's last verdict keeps an UndoRecord of every field it touched, so undo never guesses.

import { WEIGHTS, nameKey, venueKey } from './radar-score.js';
import { extractPhrases, phraseKey, carries, LEARN_AFTER, MAX_LEARNED, LEARNED_WEIGHT, LEARNED_STEP } from './radar-phrases.js';

/** @typedef {import("./radar-types").RadarState} RadarState */
/** @typedef {import("./radar-types").RadarProfile} RadarProfile */
/** @typedef {import("./radar-types").UndoRecord} UndoRecord */
/** @typedef {import("./radar-types").Verdict} Verdict */
/** @typedef {import("./radar-types").FeedbackVerdict} FeedbackVerdict */
/** @typedef {import("./radar-types").Followed} Followed */
/** @typedef {import("./radar-types").PhraseDelta} PhraseDelta */
/** @typedef {import("./radar-types").Weighted} Weighted */
/** @typedef {{ state: RadarState, profile: RadarProfile, changed: boolean, verdict: Verdict }} Outcome */

/** Weight an added paper's authors and venue gain in the profile. */
export const PROFILE_STEP = 0.05;
/** Dismissals in a row from one source before it is quietly suggested for removal. */
export const DISMISS_STREAK = 3;
const MAX_WEIGHT = 10;
const MAX_AUTHORS = 4;
/** A user or seed topic is weighed down by Not relevant but never below this, and never removed. */
const TOPIC_FLOOR = 0.1;

const round = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/** @param {RadarState} state @param {string} key */
const keysFor = (state, key) => state.shown[key]?.keys ?? [key];

/** @param {RadarState} state @param {string} key @returns {Verdict | null} */
function currentVerdict(state, key) {
  for (const k of keysFor(state, key)) if (state.seen[k]) return state.seen[k].verdict;
  return null;
}

/** The first authors and the last one: a 50-author paper does not put 50 people in the profile. @param {string[]} authors */
function followedAuthors(authors) {
  const picked = authors.length > MAX_AUTHORS ? [...authors.slice(0, MAX_AUTHORS - 1), authors[authors.length - 1]] : authors;
  const seen = new Set();
  return picked.filter((a) => { const k = nameKey(a); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/** @param {RadarState} state @returns {RadarState} */
const copy = (state) => ({
  ...state, seen: { ...state.seen }, sourceStatus: { ...state.sourceStatus }, streaks: { ...state.streaks }, undo: { ...state.undo },
  examples: { positive: [...state.examples.positive], negative: [...state.examples.negative] }, learned: [...state.learned],
  phrases: { ...state.phrases, learning: [...state.phrases.learning], blocked: [...state.phrases.blocked], announce: [...state.phrases.announce] },
});

/**
 * Spec 017 K1: a liked paper's key phrases go into the learning list, each remembering the papers it came from.
 * Mutates `state.phrases` (the caller owns a copy) and returns what it did, for the undo record.
 * @param {RadarState} state @param {RadarProfile} profile @param {string} key @param {import("./radar-types").ShownPaper} paper
 * @returns {{ profile: RadarProfile, deltas: PhraseDelta[] }}
 */
function learnPhrases(state, profile, key, paper) {
  /** @type {PhraseDelta[]} */
  const deltas = [];
  const ledger = state.phrases;
  const phrases = extractPhrases(paper, {
    liked: state.examples.positive.map((e) => e.text),
    dismissed: state.examples.negative.map((e) => e.text),
    seen: Object.entries(state.shown).filter(([id]) => id !== key).map(([, p]) => p.text),
  });
  let topics = profile.topics;
  for (const { key: pk, text } of phrases) {
    if (ledger.blocked.includes(pk)) continue;
    const known = topics.findIndex((t) => phraseKey(t.text) === pk);
    if (known >= 0) {
      const t = topics[known];
      const learnedTopic = t.origin === 'learned';
      const delta = round(Math.min(MAX_WEIGHT, t.weight + (learnedTopic ? LEARNED_STEP : PROFILE_STEP)) - t.weight);
      if (delta <= 0) continue;
      topics = topics.map((x, i) => (i === known ? { ...x, weight: round(x.weight + delta), ...(learnedTopic ? { papers: (x.papers ?? 0) + 1 } : {}) } : x));
      deltas.push({ kind: 'weight', key: pk, delta, papers: learnedTopic ? 1 : 0 });
      continue;
    }
    const at = ledger.learning.findIndex((c) => c.key === pk);
    if (at >= 0 && ledger.learning[at].papers.includes(key)) continue;
    const candidate = { key: pk, text: at >= 0 ? ledger.learning[at].text : text, papers: [...(at >= 0 ? ledger.learning[at].papers : []), key] };
    if (candidate.papers.length < LEARN_AFTER) {
      if (at >= 0) ledger.learning[at] = candidate; else ledger.learning.push(candidate);
      deltas.push({ kind: 'counted', key: pk });
      continue;
    }
    ledger.learning = ledger.learning.filter((c) => c.key !== pk);
    /** @type {Weighted | undefined} */
    let evicted;
    const learnedNow = topics.filter((t) => t.origin === 'learned');
    if (learnedNow.length >= MAX_LEARNED) {
      evicted = learnedNow.reduce((w, t) => (t.weight < w.weight || (t.weight === w.weight && (t.papers ?? 0) < (w.papers ?? 0)) ? t : w));
      topics = topics.filter((t) => t !== evicted);
    }
    topics = [...topics, { text: candidate.text, weight: LEARNED_WEIGHT, origin: 'learned', papers: candidate.papers.length }];
    ledger.announce = [...ledger.announce, candidate.text];
    deltas.push({ kind: 'promoted', key: pk, candidate, ...(evicted ? { evicted } : {}) });
  }
  return { profile: topics === profile.topics ? profile : { ...profile, topics }, deltas };
}

/**
 * Spec 017 K2: Not relevant weighs down every topic the paper carries. A learned topic that reaches zero is dropped and
 * blocked; yours and the seed's only get lighter.
 * @param {RadarState} state @param {RadarProfile} profile @param {import("./radar-types").ShownPaper} paper
 * @returns {{ profile: RadarProfile, deltas: PhraseDelta[] }}
 */
function weighPhrases(state, profile, paper) {
  /** @type {PhraseDelta[]} */
  const deltas = [];
  const ledger = state.phrases;
  /** @type {Weighted[]} */
  const kept = [];
  for (const t of profile.topics) {
    const pk = phraseKey(t.text);
    if (!carries(pk, paper.text)) { kept.push(t); continue; }
    if (t.origin !== 'learned') {
      const delta = -round(Math.min(PROFILE_STEP, Math.max(0, t.weight - TOPIC_FLOOR)));
      if (delta < 0) deltas.push({ kind: 'weight', key: pk, delta, papers: 0 });
      kept.push(delta < 0 ? { ...t, weight: round(t.weight + delta) } : t);
      continue;
    }
    const weight = round(t.weight - LEARNED_STEP);
    if (weight <= 0) {
      deltas.push({ kind: 'dropped', topic: t, blocked: true, announced: ledger.announce.some((a) => phraseKey(a) === pk) });
      ledger.blocked = [...ledger.blocked, pk];
      ledger.announce = ledger.announce.filter((a) => phraseKey(a) !== pk);
      continue;
    }
    deltas.push({ kind: 'weight', key: pk, delta: -LEARNED_STEP, papers: 0 });
    kept.push({ ...t, weight });
  }
  return { profile: deltas.length ? { ...profile, topics: kept } : profile, deltas };
}

/**
 * Takes back what `learnPhrases` and `weighPhrases` did for one paper, newest change first.
 * @param {RadarState} state @param {RadarProfile} profile @param {string} key @param {PhraseDelta[]} deltas
 * @returns {RadarProfile}
 */
function unlearnPhrases(state, profile, key, deltas) {
  const ledger = state.phrases;
  let topics = profile.topics;
  const same = (/** @type {string} */ pk) => (/** @type {Weighted} */ t) => phraseKey(t.text) === pk;
  for (const d of [...deltas].reverse()) {
    if (d.kind === 'counted') {
      ledger.learning = ledger.learning.flatMap((c) => {
        if (c.key !== d.key) return [c];
        const papers = c.papers.filter((p) => p !== key);
        return papers.length ? [{ ...c, papers }] : [];
      });
    } else if (d.kind === 'promoted') {
      topics = topics.filter((t) => !(same(d.key)(t) && t.origin === 'learned'));
      if (d.evicted) topics = [...topics, d.evicted];
      ledger.announce = ledger.announce.filter((a) => phraseKey(a) !== d.key);
      const papers = d.candidate.papers.filter((p) => p !== key);
      ledger.learning = [...ledger.learning.filter((c) => c.key !== d.key), ...(papers.length ? [{ ...d.candidate, papers }] : [])];
    } else if (d.kind === 'weight') {
      topics = topics.map((t) => (same(d.key)(t) ? { ...t, weight: round(t.weight - d.delta), ...(t.papers != null || d.papers ? { papers: Math.max(0, (t.papers ?? 0) - d.papers) } : {}) } : t));
    } else {
      const pk = phraseKey(d.topic.text);
      if (d.blocked) ledger.blocked = ledger.blocked.filter((b) => b !== pk);
      if (d.announced && !ledger.announce.some((a) => phraseKey(a) === pk)) ledger.announce = [...ledger.announce, d.topic.text];
      if (!topics.some(same(pk))) topics = [...topics, d.topic];
    }
  }
  return topics === profile.topics ? profile : { ...profile, topics };
}

/**
 * Puts the paper's verdict back to the state before `rec`, field by field.
 * @param {RadarState} before @param {RadarProfile} profile @param {string} key @param {UndoRecord} rec
 * @returns {{ state: RadarState, profile: RadarProfile }}
 */
function revert(before, profile, key, rec) {
  const state = copy(before);
  for (const [k, v] of Object.entries(rec.seen)) if (state.seen[k]) state.seen[k] = { ...state.seen[k], verdict: v ?? 'shown' };
  if (rec.pushed) {
    const { list, id } = rec.pushed;
    state.examples[list] = [...rec.dropped, ...state.examples[list].filter((e) => e.id !== id)];
  }
  for (const [src, was] of Object.entries(rec.streaks)) {
    if (was.streak == null) delete state.streaks[src]; else state.streaks[src] = was.streak;
    if (state.sourceStatus[src]) {
      const { suggestRemove: _drop, ...rest } = state.sourceStatus[src];
      state.sourceStatus[src] = was.suggestRemove == null ? rest : { ...rest, suggestRemove: was.suggestRemove };
    }
  }
  let next = profile;
  for (const id of rec.learned) {
    const entry = state.learned.find((l) => l.id === id);
    if (!entry) continue;
    state.learned = state.learned.filter((l) => l.id !== id);
    const field = entry.kind === 'author' ? 'authors' : 'journals';
    const same = entry.kind === 'author' ? nameKey : venueKey;
    const at = next[field].findIndex((f) => same(f.name) === same(entry.name));
    if (at < 0) continue;
    const weight = round(next[field][at].weight - PROFILE_STEP);
    // An entry the radar made itself goes once its last supporting paper is undone; one the user made keeps at least its own weight.
    const gone = next[field][at].origin === 'learned' && weight <= 0;
    const list = gone ? next[field].filter((_, i) => i !== at) : next[field].map((f, i) => (i === at ? { ...f, weight } : f));
    next = { ...next, [field]: list };
  }
  if (rec.phrases?.length) next = unlearnPhrases(state, next, key, rec.phrases);
  delete state.undo[key];
  return { state, profile: next };
}

/**
 * Records `verdict` for a paper that is currently only "shown".
 * @param {RadarState} before @param {RadarProfile} profile @param {string} key @param {'added' | 'later' | 'liked' | 'dismissed'} verdict
 * @param {UndoRecord["replaced"]} replaced @param {string} now
 * @returns {{ state: RadarState, profile: RadarProfile }}
 */
function apply(before, profile, key, verdict, replaced, now) {
  const state = copy(before);
  const paper = state.shown[key];
  /** @type {UndoRecord} */
  const rec = { verdict, replaced, seen: {}, pushed: null, dropped: [], learned: [], streaks: {}, phrases: /** @type {PhraseDelta[]} */ ([]) };
  for (const k of keysFor(state, key)) if (state.seen[k]) { rec.seen[k] = state.seen[k].verdict; state.seen[k] = { ...state.seen[k], verdict }; }

  let next = profile;
  if (paper) {
    const list = verdict === 'dismissed' ? 'negative' : 'positive';
    const grown = [...state.examples[list].filter((e) => e.id !== key), { id: key, text: paper.text, at: now }];
    const over = Math.max(0, grown.length - WEIGHTS.exampleCap);
    rec.dropped = grown.slice(0, over);
    state.examples[list] = grown.slice(over);
    rec.pushed = { list, id: key };
    const taught = verdict === 'dismissed' ? weighPhrases(state, next, paper) : learnPhrases(state, next, key, paper);
    next = taught.profile;
    rec.phrases?.push(...taught.deltas);

    for (const src of paper.sources) {
      const status = state.sourceStatus[src];
      rec.streaks[src] = { streak: state.streaks[src] ?? null, suggestRemove: status?.suggestRemove ?? null };
      if (verdict === 'dismissed') {
        state.streaks[src] = (state.streaks[src] ?? 0) + 1;
        if (state.streaks[src] >= DISMISS_STREAK && status) state.sourceStatus[src] = { ...status, suggestRemove: true };
      } else {
        state.streaks[src] = 0;
        if (status?.suggestRemove) { const { suggestRemove: _drop, ...rest } = status; state.sourceStatus[src] = rest; }
      }
    }

    if (verdict === 'added') {
      /** @param {'author' | 'venue'} kind @param {string} name */
      const learn = (kind, name) => {
        const field = kind === 'author' ? 'authors' : 'journals';
        const same = kind === 'author' ? nameKey : venueKey;
        const at = next[field].findIndex((f) => same(f.name) === same(name));
        if (at >= 0) next = { ...next, [field]: next[field].map((f, i) => (i === at ? { ...f, weight: round(Math.min(MAX_WEIGHT, f.weight + PROFILE_STEP)) } : f)) };
        else next = { ...next, [field]: [...next[field], /** @type {Followed} */ ({ name, openalexId: null, weight: PROFILE_STEP, origin: 'learned' })] };
        const id = `${key}|${kind}|${same(name)}`;
        state.learned.push({ id, paper: key, title: paper.title, kind, name, created: at < 0, at: now });
        rec.learned.push(id);
      };
      for (const name of followedAuthors(paper.authors)) learn('author', name);
      if (paper.venue && venueKey(paper.venue)) learn('venue', paper.venue);
    }
  }
  state.undo[key] = rec;
  return { state, profile: next };
}

/**
 * The user removed a learned topic: it goes, and the radar never learns it again (spec 017 K4). Not undoable by Undo.
 * @param {RadarState} state @param {RadarProfile} profile @param {string} text
 * @returns {{ state: RadarState, profile: RadarProfile, changed: boolean }}
 */
export function forgetLearned(state, profile, text) {
  const pk = phraseKey(text);
  if (!pk) return { state, profile, changed: false };
  const held = profile.topics.some((t) => t.origin === 'learned' && phraseKey(t.text) === pk);
  const next = copy(state);
  next.phrases.blocked = next.phrases.blocked.includes(pk) ? next.phrases.blocked : [...next.phrases.blocked, pk];
  next.phrases.learning = next.phrases.learning.filter((c) => c.key !== pk);
  next.phrases.announce = next.phrases.announce.filter((a) => phraseKey(a) !== pk);
  return { state: next, profile: held ? { ...profile, topics: profile.topics.filter((t) => !(t.origin === 'learned' && phraseKey(t.text) === pk)) } : profile, changed: true };
}

/**
 * A form saved from an older view must not undo what ratings taught since: learned topics are only ever removed through
 * `forgetLearned` (or weighed to zero), so a learned topic the saved profile lacks stays, and one it has takes the
 * radar's current weight. A topic the person typed over a learned one wins.
 * @param {RadarProfile} current the profile on disk @param {RadarProfile} saved the profile being saved @param {string[]} blocked
 * @returns {RadarProfile}
 */
export function mergeLearned(current, saved, blocked) {
  const keys = new Set(saved.topics.filter((t) => t.origin !== 'learned').map((t) => phraseKey(t.text)));
  const mine = current.topics.filter((t) => t.origin === 'learned' && !blocked.includes(phraseKey(t.text)) && !keys.has(phraseKey(t.text)));
  const rest = saved.topics.filter((t) => t.origin !== 'learned');
  return { ...saved, topics: [...rest, ...mine] };
}

/**
 * One click on a digest row. Idempotent: the same verdict twice changes nothing. A different verdict on a settled paper
 * first takes back the old one, so a paper is never both a positive and a negative example; undoing the new one brings
 * the old one back. `undo` reverts the paper's last verdict exactly.
 * @param {{ state: RadarState, profile: RadarProfile, key: string, verdict: FeedbackVerdict, now: string }} input
 * @returns {Outcome}
 */
export function applyFeedback({ state, profile, key, verdict, now }) {
  const current = currentVerdict(state, key);
  if (current == null) throw new Error('That paper is not one this radar has shown.');
  /** @type {Outcome} */
  const unchanged = { state, profile, changed: false, verdict: current };
  const done = (/** @type {{ state: RadarState, profile: RadarProfile }} */ r) => /** @type {Outcome} */ ({ ...r, changed: true, verdict: currentVerdict(r.state, key) });

  if (verdict === 'undo') {
    const rec = state.undo[key];
    if (!rec || current === 'shown') return unchanged;
    const back = revert(state, profile, key, rec);
    return done(rec.replaced ? apply(back.state, back.profile, key, rec.replaced, null, now) : back);
  }
  if (!['added', 'later', 'liked', 'dismissed'].includes(verdict)) throw new Error(`Unknown verdict "${verdict}".`);
  if (current === verdict) return unchanged;

  let base = { state, profile };
  /** @type {UndoRecord["replaced"]} */
  let replaced = null;
  if (current !== 'shown') {
    replaced = /** @type {UndoRecord["replaced"]} */ (current);
    const rec = state.undo[key];
    if (rec) base = revert(state, profile, key, rec);
    else {
      const s = copy(state);
      for (const k of keysFor(s, key)) if (s.seen[k]) s.seen[k] = { ...s.seen[k], verdict: 'shown' };
      base = { state: s, profile };
    }
  }
  return done(apply(base.state, base.profile, key, verdict, replaced, now));
}
