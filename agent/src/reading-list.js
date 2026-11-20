// @ts-check
// agent/src/reading-list.js. Spec 028 R8: the Read later list, papers the user keeps to read when ready, one JSON file
// at `<dataDir>/reading-list.json`. An entry's id is `doi:<doi>`, else `arxiv:<id>`, else `url:<url>`; adding an id
// already listed changes nothing (it keeps its `added`). arXiv's own DOI (10.48550/arXiv.<id>) and an arxiv.org address
// are `arxiv:<id>`, a doi.org address is `doi:<doi>`, also for entries saved before that rule. No cap: the user curates
// it by hand. Written atomically like every store here; a file that does not parse reads as an empty list, and is kept
// aside as `reading-list.json.bad-<time>` before the first write goes over it.

/** @typedef {import("./service").ReadingListEntry} ReadingListEntry */
/** @typedef {import("./service").ReadingListPaper} ReadingListPaper */

export const READING_LIST_FILE = 'reading-list.json';

const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : '');
const cleanDoi = (/** @type {unknown} */ v) => text(v).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, '').toLowerCase();
// "2611.20723v2", "2611.20723v1.pdf" and "2611.20723" are one paper
const cleanArxiv = (/** @type {unknown} */ v) => text(v).replace(/^arxiv:/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const ARXIV_URL = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i;
const DOI_URL = /^https?:\/\/(?:dx\.)?doi\.org\/([^?#]+)/i;

/** An id as the one it stands for: `doi:10.48550/arxiv.<id>` and an arXiv address are `arxiv:<id>`, a doi.org
 *  address is `doi:`. Anything else is kept as it is. @param {string} id */
function canonical(id) {
  const [kind] = id.split(':', 1), value = id.slice(kind.length + 1);
  if (kind === 'doi') {
    const doi = cleanDoi(value), arxiv = ARXIV_DOI.exec(doi)?.[1];
    return arxiv ? `arxiv:${cleanArxiv(arxiv)}` : `doi:${doi}`;
  }
  if (kind === 'arxiv') return `arxiv:${cleanArxiv(value)}`;
  if (kind === 'url') {
    const arxiv = ARXIV_URL.exec(value)?.[1];
    if (arxiv) return `arxiv:${cleanArxiv(arxiv)}`;
    const doi = DOI_URL.exec(value)?.[1];
    if (doi) { try { return canonical(`doi:${decodeURIComponent(doi)}`); } catch { return canonical(`doi:${doi}`); } }
  }
  return id;
}

/** Every id a paper can be found by, the one it is listed under first: its DOI, its arXiv id, its address.
 *  @param {Partial<ReadingListPaper>} paper @returns {string[]} */
export function idsOf(paper) {
  /** @type {string[]} */
  const ids = [];
  for (const [kind, value] of /** @type {const} */ ([['doi', cleanDoi(paper?.doi)], ['arxiv', cleanArxiv(paper?.arxiv)], ['url', text(paper?.url)]])) {
    const id = value ? canonical(`${kind}:${value}`) : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The id a paper is listed under, or null when it has nothing to be found by. @param {Partial<ReadingListPaper>} paper */
export const idOf = (paper) => idsOf(paper)[0] ?? null;

/** The entry a paper becomes, without the optional fields it lacks. @param {ReadingListPaper} paper @param {string} now ISO time @returns {ReadingListEntry} */
function entryOf(paper, now) {
  const id = idOf(paper);
  if (!id) throw new Error('This paper has no DOI, arXiv id or address to save it by.');
  const title = text(paper.title);
  if (!title) throw new Error('This paper has no title to save it by.');
  const doi = cleanDoi(paper.doi), abstract = text(paper.abstract);
  const arxiv = cleanArxiv(paper.arxiv) || (id.startsWith('arxiv:') ? id.slice('arxiv:'.length) : '');
  return {
    id, title,
    authors: Array.isArray(paper.authors) ? paper.authors.map(String).filter(Boolean) : [],
    year: Number.isFinite(paper.year) ? Number(paper.year) : null,
    venue: text(paper.venue),
    ...(doi ? { doi: text(paper.doi).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, '') } : {}),
    ...(arxiv ? { arxiv } : {}),
    url: text(paper.url) || (doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : ''),
    ...(abstract ? { abstract } : {}),
    source: text(paper.source) || 'web',
    added: now,
  };
}

/** @param {ReadingListEntry[]} list @param {ReadingListPaper} paper @param {string} now
 *  @returns {{ list: ReadingListEntry[], entry: ReadingListEntry, changed: boolean }} */
export function addEntry(list, paper, now) {
  const entry = entryOf(paper, now);
  const have = list.find((e) => e.id === entry.id);
  return have ? { list, entry: have, changed: false } : { list: [...list, entry], entry, changed: true };
}

/** @param {ReadingListEntry[]} list @param {string} id @returns {{ list: ReadingListEntry[], changed: boolean }} */
export function removeEntry(list, id) {
  const want = canonical(id);
  const next = list.filter((e) => e.id !== want);
  return next.length === list.length ? { list, changed: false } : { list: next, changed: true };
}

/** `read` true stores when it was read; false takes that off. Refuses an id that is not listed.
 *  @param {ReadingListEntry[]} list @param {string} id @param {boolean} read @param {string} now
 *  @returns {{ list: ReadingListEntry[], entry: ReadingListEntry, changed: boolean }} */
export function markEntry(list, id, read, now) {
  const want = canonical(id);
  const have = list.find((e) => e.id === want);
  if (!have) throw new Error('That paper is not on your Read later list.');
  if (Boolean(have.read) === read) return { list, entry: have, changed: false };
  const { read: _was, ...rest } = have;
  const entry = read ? { ...rest, read: now } : rest;
  return { list: list.map((e) => (e === have ? entry : e)), entry, changed: true };
}

/** Newest first. @param {ReadingListEntry[]} list */
export const newestFirst = (list) => [...list].sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));

/** Tolerant read: entries without an id or a title are dropped, an alias id reads as the id it stands for, and a
 *  repeated id keeps its first entry. @param {any} raw @returns {ReadingListEntry[]} */
export function normaliseList(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  /** @type {Map<string, ReadingListEntry>} */
  const out = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^(doi|arxiv|url):./.test(e.id) || !text(e.title)) continue;
    const id = canonical(e.id);
    if (out.has(id)) continue;
    out.set(id, {
      ...e,
      id,
      authors: Array.isArray(e.authors) ? e.authors.map(String) : [],
      year: Number.isFinite(e.year) ? e.year : null,
      venue: typeof e.venue === 'string' ? e.venue : '',
      url: typeof e.url === 'string' ? e.url : '',
      source: typeof e.source === 'string' ? e.source : 'web',
      added: typeof e.added === 'string' ? e.added : new Date(0).toISOString(),
    });
  }
  return [...out.values()];
}

/** @param {Pick<import("./platform").Platform['fs'], 'read' | 'writeAtomic'>} fs @param {string} dataDir
 *  @param {() => number} [now] the clock, for the name a broken file is kept under */
export function createReadingListStore(fs, dataDir, now = Date.now) {
  const file = `${dataDir}/${READING_LIST_FILE}`;
  /** The text of a file that did not parse, until it is kept aside. @type {string | null} */
  let broken = null;
  return {
    /** @returns {Promise<ReadingListEntry[]>} */
    async read() {
      const raw = await fs.read(file);
      broken = null;
      if (raw == null) return [];
      try { return normaliseList(JSON.parse(raw)); } catch { broken = raw; return []; }
    },
    /** @param {ReadingListEntry[]} list */
    async write(list) {
      if (broken != null) {
        await fs.writeAtomic(`${file}.bad-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`, broken);
        broken = null;
      }
      await fs.writeAtomic(file, JSON.stringify({ version: 1, entries: list }, null, 2));
    },
  };
}

// Spec 029 R9/R10: a paper liked on Home goes on the list too. The entry remembers it came from a Like (`via: 'like'`),
// so taking the Like back takes it off again, and a paper saved by hand is never taken off by an Undo.

/** A paper the radar showed, as the list keeps it. Its `text` is the title and then the abstract.
 *  @param {import("./radar-types").ShownPaper} shown @returns {ReadingListPaper} */
export function shownPaper(shown) {
  const doi = shown.keys.find((k) => k.startsWith('doi:'))?.slice(4) ?? '';
  const arxiv = shown.keys.find((k) => k.startsWith('arxiv:'))?.slice(6) ?? '';
  const title = text(shown.title);
  const body = text(shown.text);
  const abstract = body.startsWith(title) ? body.slice(title.length).replace(/^[\s.:]+/, '') : body;
  return { title, authors: Array.isArray(shown.authors) ? shown.authors : [], venue: text(shown.venue), ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(abstract ? { abstract } : {}), source: 'radar' };
}

/** Every paper liked in one radar's state with the time of the Like, oldest first. Only papers whose details the radar
 *  still keeps (`shown`) can be listed. @param {import("./radar-types").RadarState} state
 *  @returns {{ paper: ReadingListPaper, at: string }[]} */
export function likedPapers(state) {
  const out = [];
  for (const shown of Object.values(state.shown ?? {})) {
    const seen = shown.keys.map((k) => state.seen?.[k]).find(Boolean);
    if (seen?.verdict === 'liked') out.push({ paper: shownPaper(shown), at: typeof seen.at === 'string' ? seen.at : new Date(0).toISOString() });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Adds liked papers not listed yet, each `added` at its Like and marked `via: 'like'`. One that cannot be listed (no
 *  id, no title) is skipped. @param {ReadingListEntry[]} list @param {{ paper: ReadingListPaper, at: string }[]} liked
 *  @returns {{ list: ReadingListEntry[], changed: boolean, added: number }} */
export function addLiked(list, liked) {
  let next = list, added = 0;
  for (const { paper, at } of liked) {
    try {
      const out = addEntry(next, paper, at);
      if (!out.changed) continue;
      next = out.list.map((e) => (e === out.entry ? { ...e, via: /** @type {'like'} */ ('like') } : e));
      added++;
    } catch { /* nothing to list it by */ }
  }
  return { list: next, changed: added > 0, added };
}

/** Takes off a paper the Like put on, and nothing else. @param {ReadingListEntry[]} list @param {ReadingListPaper} paper
 *  @returns {{ list: ReadingListEntry[], changed: boolean }} */
export function removeLiked(list, paper) {
  const id = idOf(paper);
  const next = list.filter((e) => !(e.id === id && e.via === 'like'));
  return { list: next, changed: next.length !== list.length };
}
