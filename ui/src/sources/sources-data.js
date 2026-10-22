// @ts-check
// ui-src/src/web/sources-data.js. Spec 014 G1: the model behind the Sources page. It edits the same RadarForm the setup
// sheet edits (chat/radar-data.js), so the two always agree. A chip is one thing the radar can follow; this file knows
// which chips exist, whether each is followed, how to follow and unfollow it, the ring's count and the one suggestion.
// No DOM, so node tests run it.

import { DATABASES, addEntry, addJournal, addFeed } from '../chat/radar-data.js';

/** @typedef {import('../chat/radar-data.js').RadarForm} RadarForm */
/** @typedef {'topics' | 'authors' | 'journals' | 'feeds' | 'databases'} GroupId */
/** @typedef {{ group: GroupId, key: string, label: string, meta: string, value: any }} Entry */

export const GROUPS = /** @type {const} */ ([
  { id: 'topics', title: 'Topics and keywords', hint: 'Subjects to look for. Suggested from your library.', add: 'Add a topic' },
  { id: 'authors', title: 'Authors', hint: 'People whose new work you want to see.', add: 'Add an author' },
  { id: 'journals', title: 'Journals', hint: 'The journals your library cites most.', add: 'Add a journal by name or ISSN' },
  { id: 'feeds', title: 'Feeds', hint: 'Any RSS or Atom address.', add: 'Paste a feed address' },
  { id: 'databases', title: 'Databases', hint: 'Places that publish new papers every day.', add: '' },
]);

const fold = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** A new radar from this page follows only what the person picks: the databases the setup sheet turns on for a new
 *  radar start off, so the ring counts what was chosen. @param {RadarForm} form */
export function startEmpty(form) {
  for (const id of Object.keys(form.databases)) form.databases[id] = false;
  return form;
}

/** True for a topic the radar learned itself (spec 017): it gets a Learned chip with a × instead of a toggle. @param {Entry} e */
export const isLearned = (e) => e.group === 'topics' && e.value?.origin === 'learned';

/** Takes a learned chip out of the form and the catalog once the engine has forgotten it. @param {RadarForm} form @param {Record<GroupId, Entry[]>} catalog @param {Entry} e */
export function dropLearned(form, catalog, e) {
  form.profile.topics = form.profile.topics.filter((t) => fold(t.text) !== e.key);
  catalog.topics = catalog.topics.filter((x) => x.key !== e.key);
}

/** @param {any} f a Followed entry @returns {Entry} */
const person = (f, /** @type {GroupId} */ group) => ({ group, key: f.openalexId || fold(f.name), label: f.name, meta: f.match ?? '', value: f });

/**
 * Every chip the page can show, in a fixed order that does not change when one is followed: what the radar already
 * follows first, then what the library suggests. `seed` is `ai.radar.profile`'s answer.
 * @param {RadarForm} form @param {{ topics?: any[], authors: any[], journals: any[] } | null} seed @returns {Record<GroupId, Entry[]>}
 */
export function catalogOf(form, seed) {
  /** @type {Record<GroupId, Entry[]>} */
  const out = { topics: [], authors: [], journals: [], feeds: [], databases: [] };
  // A followed person is keyed by their OpenAlex id, the library's suggestion of the same person by name: one chip each.
  const put = (/** @type {Entry} */ e) => { if (!out[e.group].some((x) => x.key === e.key || fold(x.label) === fold(e.label))) out[e.group].push(e); };
  for (const t of form.profile.topics) put({ group: 'topics', key: fold(t.text), label: t.text, meta: '', value: t });
  for (const a of form.profile.authors) put(person(a, 'authors'));
  for (const j of form.profile.journals) put(person(j, 'journals'));
  for (const j of form.journals) put(journalRow(j));
  for (const f of form.feeds) put({ group: 'feeds', key: f.url, label: f.title, meta: f.url, value: f });
  for (const [id, label] of DATABASES) put({ group: 'databases', key: id, label, meta: '', value: id });
  for (const m of form.mcp) put({ group: 'databases', key: `mcp:${m.server}/${m.tool}`, label: m.label, meta: '', value: m });
  for (const t of seed?.topics ?? []) put({ group: 'topics', key: fold(t.text), label: t.text, meta: '', value: t });
  for (const a of seed?.authors ?? []) put(person(a, 'authors'));
  for (const j of seed?.journals ?? []) put(person(j, 'journals'));
  return out;
}

/** @param {{ openalexId: string, name: string, issn: string | null }} j @returns {Entry} */
export const journalRow = (j) => ({ group: 'journals', key: j.openalexId, label: j.name, meta: j.issn ? `ISSN ${j.issn}` : '', value: { ...j, kind: 'row' } });

/** @param {RadarForm} form @param {Entry} e */
export function isFollowed(form, e) {
  switch (e.group) {
    case 'topics': return form.profile.topics.some((t) => fold(t.text) === e.key);
    case 'authors': return form.profile.authors.some((a) => (a.openalexId || fold(a.name)) === e.key);
    case 'journals': return form.profile.journals.some((j) => (j.openalexId || fold(j.name)) === e.key) || form.journals.some((j) => j.openalexId === e.key && j.on);
    case 'feeds': return form.feeds.some((f) => f.url === e.key && f.on);
    default: return e.key.startsWith('mcp:') ? form.mcp.some((m) => `mcp:${m.server}/${m.tool}` === e.key && m.on) : Boolean(form.databases[e.key]);
  }
}

/** Follows or unfollows one chip. What the person picks becomes theirs (origin "user"), so a later "refresh from library" does not replace it.
 *  @param {RadarForm} form @param {Entry} e @param {boolean} on */
export function setFollowed(form, e, on) {
  if (isFollowed(form, e) === on) return;
  const p = form.profile;
  switch (e.group) {
    case 'topics':
      if (on) p.topics = [...p.topics, { text: e.value.text, weight: e.value.weight ?? 1, origin: 'user' }];
      else p.topics = p.topics.filter((t) => fold(t.text) !== e.key);
      return;
    case 'authors':
      if (on) p.authors = [...p.authors, { name: e.value.name, openalexId: e.value.openalexId ?? null, weight: e.value.weight ?? 1, origin: 'user', ...(e.value.match ? { match: e.value.match } : {}) }];
      else p.authors = p.authors.filter((a) => (a.openalexId || fold(a.name)) !== e.key);
      return;
    case 'journals':
      if (on) {
        if (e.value.kind === 'row') {
          const mine = form.journals.find((j) => j.openalexId === e.key);
          if (mine) mine.on = true; else addJournal(form, e.value);
        } else p.journals = [...p.journals, { name: e.value.name, openalexId: e.value.openalexId ?? null, weight: e.value.weight ?? 1, origin: 'user', ...(e.value.match ? { match: e.value.match } : {}) }];
      } else {
        p.journals = p.journals.filter((j) => (j.openalexId || fold(j.name)) !== e.key);
        form.journals = form.journals.filter((j) => j.openalexId !== e.key);
      }
      return;
    case 'feeds': {
      const mine = form.feeds.find((f) => f.url === e.key);
      if (mine) mine.on = on; else if (on) addFeed(form, e.value);
      return;
    }
    default: {
      const mcp = e.key.startsWith('mcp:') ? form.mcp.find((m) => `mcp:${m.server}/${m.tool}` === e.key) : null;
      if (mcp) mcp.on = on; else form.databases[e.key] = on;
    }
  }
}

/** How many things the radar follows now: what the ring counts. @param {RadarForm} form */
export function followedCount(form) {
  const c = catalogOf(form, null);
  return Object.values(c).flat().filter((e) => isFollowed(form, e)).length;
}

/** The one thing worth following next: the library's most-cited journal or author not yet followed. @param {RadarForm} form @param {{ topics?: any[], authors: any[], journals: any[] } | null} seed
 *  @returns {{ entry: Entry, text: string } | null} */
export function suggestionOf(form, seed) {
  if (!seed) return null;
  const c = catalogOf(form, seed);
  const pick = (/** @type {GroupId} */ group, /** @type {any[]} */ list) => [...list]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .map((f) => c[group].find((e) => e.key === (f.openalexId || fold(f.name))))
    .filter((e) => e && !isFollowed(form, e))
    .map((e) => /** @type {Entry} */ (e));
  const journal = pick('journals', seed.journals)[0];
  const author = pick('authors', seed.authors)[0];
  if (!journal && !author) return null;
  const weight = (/** @type {Entry | undefined} */ e) => e?.value.weight ?? 0;
  const [entry, kind] = journal && (!author || weight(journal) >= weight(author)) ? [journal, 'journal'] : [/** @type {Entry} */ (author), 'author'];
  return { entry, text: `Follow ${entry.label}, the ${kind} your library cites most.` };
}

/** Adds a typed value to a group and follows it: a topic or an author name. Returns the new entry, or null when it was empty or already there.
 *  @param {RadarForm} form @param {Record<GroupId, Entry[]>} catalog @param {'topics' | 'authors'} group @param {string} typed */
export function addTyped(form, catalog, group, typed) {
  const field = group === 'topics' ? 'text' : 'name';
  const { list, added } = addEntry(/** @type {any[]} */ (form.profile[group]), field, typed);
  if (!added) {
    const have = catalog[group].find((e) => e.key === fold(typed));
    if (have && !isFollowed(form, have)) { setFollowed(form, have, true); return have; }
    return null;
  }
  form.profile[group] = list;
  const value = list[list.length - 1];
  const entry = group === 'topics' ? { group, key: fold(value.text), label: value.text, meta: '', value } : person(value, group);
  if (!catalog[group].some((e) => e.key === entry.key)) catalog[group].push(entry);
  return entry;
}

/** What the page says about the schedule, in the person's words. @param {RadarForm} form */
export function whenText(form) {
  const w = form.when;
  const at = w.mode === 'hourly' ? `every ${w.every} hours` : `at ${w.times.join(' and ')}`;
  const days = w.days === 'daily' ? 'Every day' : w.days === 'some' ? 'On the days you chose' : w.days === 'every' ? `Every ${w.n} days` : 'Once a month';
  return `${days}, ${at}. Change it any time in Routines.`;
}

/** Short letters for a source on the explainer's dashed lines: "Nature Methods" is NM, "arXiv" is ar. @param {string} label */
export function monogram(label) {
  const all = label.replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !/^(of|the|and|for|in|on|a|an)$/i.test(w));
  if (!words.length) return all.length ? all[0].slice(0, 2) : '?';
  return words.length > 1 ? words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') : words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/** The followed sources the explainer draws around the cover, databases first, at most six. @param {RadarForm} form */
export function sourceLabels(form) {
  const c = catalogOf(form, null);
  const order = /** @type {GroupId[]} */ (['databases', 'feeds', 'journals', 'authors']);
  return order.flatMap((g) => c[g].filter((e) => isFollowed(form, e)).map((e) => e.label)).slice(0, 6);
}
