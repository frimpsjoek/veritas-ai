// @ts-check
// agent-src/src/radar-setup.js. Spec 012 R2: what the setup sheet asks the engine. `seedProfile` turns the library's top
// terms, authors and journals into a profile the user can confirm (each author and journal matched in OpenAlex, with a
// label saying who or what matched). `checkSource` says what a pasted address, journal name or ISSN is. Neither
// throws for anything the user typed; a failed lookup is a plain sentence or an unmatched row.

import { politeFetch } from './radar-sources.js';
import { parseFeed, feedTitle } from './feeds.js';
import { normTitle } from './radar.js';
import { nameKey } from './radar-score.js';
import { NEEDS_SERVER } from './radar-run.js';

/** @typedef {import("./radar-types").JournalOption} JournalOption */
/** @typedef {import("./radar-types").SourceCheck} SourceCheck */

const API = 'https://api.openalex.org';
const MAX_PEOPLE = 8;
const MAX_JOURNALS = 8;
const MAX_TOPICS = 12;
const OPTIONS = 5;
const SOURCE_FIELDS = 'id,display_name,abbreviated_title,alternate_titles,issn_l,issn,works_count,host_organization_name';

const message = (/** @type {any} */ e) => String(e?.message ?? e);
const shortId = (/** @type {string} */ id) => String(id ?? '').replace(/^https?:\/\/openalex\.org\//, '');
const count = (/** @type {number} */ n) => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? 'work' : 'works'}`;

/** @param {typeof fetch} net @param {string} path @returns {Promise<any[]>} */
async function results(net, path) {
  const res = await net(`${API}${path}`);
  if (!res.ok) throw new Error(`OpenAlex answered HTTP ${res.status}`);
  return (await res.json()).results ?? [];
}

/** @param {any} s @returns {JournalOption} */
function journalOption(s) {
  const issn = s.issn_l ?? s.issn?.[0] ?? null;
  return {
    openalexId: shortId(s.id), name: String(s.display_name ?? ''), issn,
    match: [s.display_name, s.host_organization_name, count(s.works_count)].filter(Boolean).join(', '),
  };
}

/** "Galli, G." reads as "G. Galli" to a name search. @param {string} name */
const searchName = (name) => (name.includes(',') ? name.split(',').map((p) => p.trim()).reverse().join(' ') : name);

/** @param {typeof fetch} net @param {{ name: string }} person */
async function matchAuthor(net, person) {
  try {
    const [hit] = await results(net, `/authors?search=${encodeURIComponent(searchName(person.name))}&per_page=1&select=id,display_name,works_count,last_known_institutions`);
    if (!hit || nameKey(hit.display_name) !== nameKey(person.name)) return { openalexId: null, match: null };
    const where = hit.last_known_institutions?.[0]?.display_name;
    return { openalexId: shortId(hit.id), match: [hit.display_name, where, count(hit.works_count)].filter(Boolean).join(', ') };
  } catch { return { openalexId: null, match: null }; }
}

/** A library journal name matches when OpenAlex's title, abbreviation or an alternate title says the same words. @param {any} source @param {string} name */
const sameJournal = (source, name) => {
  const want = normTitle(name);
  return want !== '' && [source.display_name, source.abbreviated_title, ...(source.alternate_titles ?? [])].some((t) => normTitle(t) === want);
};

/** @param {typeof fetch} net @param {{ name: string }} journal */
async function matchJournal(net, journal) {
  try {
    const hits = await results(net, `/sources?search=${encodeURIComponent(journal.name)}&per_page=3&select=${SOURCE_FIELDS}`);
    const hit = hits.find((s) => sameJournal(s, journal.name));
    return hit ? { openalexId: shortId(hit.id), match: journalOption(hit).match } : { openalexId: null, match: null };
  } catch { return { openalexId: null, match: null }; }
}

/**
 * The library's seed profile with its authors and journals resolved in OpenAlex. One request each, at most 8 + 8, one at
 * a time per host.
 * @param {{ fetch: typeof fetch, library: import("./tools").LibraryBackend, scope: import("./domain").Scope | undefined }} run
 * @returns {Promise<import("./radar-types").RadarProfile>}
 */
export async function seedProfile({ fetch: fetchFn, library, scope }) {
  if (!library.radarProfile) throw new Error(NEEDS_SERVER);
  const seed = await library.radarProfile({ scope: { collections: scope?.kind === 'collections' ? scope.keys : null } });
  const net = politeFetch(fetchFn, MAX_PEOPLE + MAX_JOURNALS).fetch;
  const top = Math.max(0, ...seed.topics.map((t) => Number(t.weight) || 0)) || 1;
  const [authors, journals] = await Promise.all([
    Promise.all(seed.authors.slice(0, MAX_PEOPLE).map(async (a) => ({ name: a.name, weight: 1, origin: /** @type {const} */ ('seed'), ...(await matchAuthor(net, a)) }))),
    Promise.all(seed.journals.slice(0, MAX_JOURNALS).map(async (j) => ({ name: j.name, weight: 1, origin: /** @type {const} */ ('seed'), ...(await matchJournal(net, j)) }))),
  ]);
  return {
    topics: seed.topics.slice(0, MAX_TOPICS).map((t) => ({ text: t.text, weight: Math.max(0.1, (Number(t.weight) || 0) / top), origin: /** @type {const} */ ('seed') })),
    authors, journals,
  };
}

const ISSN = /^\d{4}-?\d{3}[\dxX]$/;
const SIGN_IN = /log-?in|sign-?in|sso|idp\.|\/auth\b|consent|cookie/i;

/** The registrable name of a host: "feeds.aps.org" gives "aps", "pubs.acs.org" gives "acs". @param {string} host */
function publisherOf(host) {
  const labels = host.toLowerCase().split('.').filter((l) => !['www', 'feeds', 'feed', 'rss', 'pubs', 'api'].includes(l));
  return labels.length > 1 ? labels.at(-2) ?? '' : labels[0] ?? '';
}

/** Journals worth offering for a feed that could not be read: by the page's own title, then by the publisher's name. @param {typeof fetch} net @param {string} url @param {string | null} pageTitle */
async function suggestJournals(net, url, pageTitle) {
  const host = new URL(url).hostname;
  const queries = [...new Set([pageTitle && !SIGN_IN.test(pageTitle) ? pageTitle : '', publisherOf(host)].filter((q) => q.length > 2))];
  /** @type {Map<string, JournalOption>} */
  const found = new Map();
  for (const q of queries) {
    try {
      for (const s of await results(net, `/sources?search=${encodeURIComponent(q)}&filter=type:journal&per_page=${OPTIONS}&select=${SOURCE_FIELDS}`)) {
        const option = journalOption(s);
        if (!found.has(option.openalexId)) found.set(option.openalexId, option);
      }
    } catch { /* a missing suggestion is fine */ }
  }
  return [...found.values()].slice(0, OPTIONS);
}

/** @param {typeof fetch} fetchFn @param {string} url @returns {Promise<SourceCheck>} */
async function checkAddress(fetchFn, url) {
  const net = politeFetch(fetchFn, 8).fetch;
  const blocked = async (/** @type {string} */ reason, /** @type {string | null} */ title = null) => ({ kind: /** @type {const} */ ('feed-blocked'), url, reason, journals: await suggestJournals(net, url, title) });
  let res;
  try {
    res = await net(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5' } });
  } catch (e) { return { kind: 'error', message: `Could not reach ${new URL(url).host}: ${message(e)}` }; }
  const where = `${res.headers?.get?.('location') ?? ''} ${res.redirected ? res.url : ''}`;
  if ((res.status >= 300 && res.status < 400 && SIGN_IN.test(where)) || (res.redirected && SIGN_IN.test(res.url))) return blocked('This site sends feed requests to a sign-in page.');
  if (res.status === 401 || res.status === 403) return blocked(`This site does not let other programs read its feed (HTTP ${res.status}).`);
  if (res.status >= 300 && res.status < 400) return blocked('This address moves somewhere else instead of giving a feed.');
  if (!res.ok) return { kind: 'error', message: `That address answered HTTP ${res.status}.` };
  const body = await res.text().catch(() => '');
  if (/<(rss|feed|rdf:RDF)\b/i.test(body)) return { kind: 'feed', url, title: feedTitle(body) ?? new URL(url).host, items: parseFeed(body).length };
  return blocked('That address is not an RSS or Atom feed.', /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() ?? null);
}

/**
 * What a typed address, ISSN or journal name is. Never throws.
 * @param {{ fetch: typeof fetch, library: import("./tools").LibraryBackend, input: string }} run
 * @returns {Promise<SourceCheck>}
 */
export async function checkSource({ fetch: fetchFn, library, input }) {
  if (!library.radarProfile) throw new Error(NEEDS_SERVER);
  const typed = String(input ?? '').trim();
  if (!typed) return { kind: 'error', message: 'Type a feed address, a journal name or an ISSN.' };
  try {
    if (/^https?:\/\//i.test(typed)) return await checkAddress(fetchFn, typed);
    const net = politeFetch(fetchFn, 4).fetch;
    if (ISSN.test(typed)) {
      const issn = typed.toUpperCase().replace(/^(\d{4})-?(\d{3}[\dX])$/, '$1-$2');
      const [hit] = await results(net, `/sources?filter=issn:${issn}&per_page=1&select=${SOURCE_FIELDS}`);
      return hit ? { kind: 'journal', ...journalOption(hit) } : { kind: 'error', message: `No journal has the ISSN ${issn}.` };
    }
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(typed) && !/\s/.test(typed)) return await checkAddress(fetchFn, `https://${typed}`);
    const options = (await results(net, `/sources?search=${encodeURIComponent(typed)}&filter=type:journal&per_page=${OPTIONS}&select=${SOURCE_FIELDS}`)).map(journalOption);
    return options.length ? { kind: 'journals', options } : { kind: 'error', message: `No journal found for "${typed}". Try its full name or its ISSN.` };
  } catch (e) {
    return { kind: 'error', message: `The lookup failed: ${message(e)}` };
  }
}
