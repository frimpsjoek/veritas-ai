// @ts-check
// agent-src/src/radar-sources.js. Spec 012 R1: one fetcher per RadarSource kind. Every fetcher returns `{ items, error }`
// and never throws, so one broken source is a line on the digest, not a failed run.

import { fetchFeed, findDoi, findArxiv } from './feeds.js';
import { searchSource, openAlexWorks, arxivCategoryFeed } from './scholarly.js';
import { normalise, isNonPaper } from './radar.js';
import { LEARNED_FLOOR } from './radar-phrases.js';

export { MCP_PRESETS } from './radar.js';

/** @typedef {import("./radar-types").RadarSource} RadarSource */
/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RawPaper} RawPaper */
/** @typedef {{ id: string, items: RadarItem[], error: string | null, skipped?: number, cache?: import("./feeds.js").FeedCache | null }} SourceResult */

export const REQUEST_BUDGET = 120;
/** Minimum milliseconds between two requests to one host (arXiv's terms of use for its API). */
export const HOST_GAPS = /** @type {Record<string, number>} */ ({ 'export.arxiv.org': 3000 });
/** Seed radar: phrase searches on the arXiv API per run, on top of the category feeds. */
const SEED_PHRASES = 3;
const DB_TOPICS = 5;
const MCP_TOPICS = 3;
const PER_QUERY = 20;

/**
 * A fetch that spends from a shared budget and lets one request per host through at a time. The lock covers the
 * request until its headers arrive, which is what the hosts' rate limits see.
 * @param {typeof fetch} fetchFn @param {number} [budget]
 * @param {{ gaps?: Record<string, number>, now?: () => number, sleep?: (ms: number) => Promise<void> }} [opts] tests pass a clock
 * @returns {{ fetch: typeof fetch, used(): number }}
 */
export function politeFetch(fetchFn, budget = REQUEST_BUDGET, opts = {}) {
  let used = 0;
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  /** When each host was last asked; arXiv's API wants 3 s between requests (spec 021 G2). @type {Map<string, number>} */
  const last = new Map();
  const gaps = opts.gaps ?? HOST_GAPS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {any} */
  const wrapped = async (url, init) => {
    if (used >= budget) throw new Error('request budget for this run reached');
    used += 1;
    const host = new URL(String(url)).host;
    const before = tails.get(host) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    tails.set(host, before.then(() => new Promise((r) => { release = r; })));
    await before;
    const gap = gaps[host] ?? 0;
    const wait = gap ? (last.get(host) ?? -Infinity) + gap - now() : 0;
    if (wait > 0) await sleep(wait);
    last.set(host, now());
    try { return await fetchFn(url, init); } finally { release(); }
  };
  return { fetch: wrapped, used: () => used };
}

const message = (/** @type {any} */ e) => String(e?.message ?? e);


const DETAIL_KEYS = 'title|summary|abstract|upvotes|created|published|date|web|url|link|arxiv|doi|authors|venue';
const DETAIL_SPLIT = new RegExp(`,\\s+(?=(?:${DETAIL_KEYS})=)`, 'i');
const unescapeMd = (/** @type {string} */ t) => t.replace(/\\([\\_*|[\]`])/g, '$1').trim();

/** "key=value, key=value" detail cells (a summary may hold commas, so only a known key starts a new pair). @param {string} cell */
function detailPairs(cell) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of cell.split(DETAIL_SPLIT)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

const tableCells = (/** @type {string} */ line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());

/** Markdown tables: a header row, a `|---|` separator, then one paper per row. @param {string} body @returns {RawPaper[]} */
function parseMarkdownTable(body) {
  const lines = body.split('\n');
  /** @type {RawPaper[]} */
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const head = tableCells(lines[i]).map((h) => h.toLowerCase());
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const cells = tableCells(lines[i]);
      /** @type {Record<string, string>} */
      const f = {};
      head.forEach((h, k) => { if (cells[k]) f[h] = cells[k]; });
      Object.assign(f, ...head.map((h, k) => (/detail|info|meta/.test(h) && cells[k] ? detailPairs(cells[k]) : {})));
      const title = unescapeMd(f.title ?? f.name ?? '');
      if (!title) continue;
      const row = cells.join(' | ');
      const arxiv = findArxiv(f.arxiv ?? '') ?? findArxiv(row) ?? (/^\d{4}\.\d{4,5}$/.test(f.path ?? '') ? f.path : null);
      out.push({
        title, arxiv, doi: findDoi(f.doi ?? '') ?? findDoi(row), authors: (f.authors ?? '').split(/;|,\s*/).map((a) => a.trim()).filter(Boolean),
        abstract: unescapeMd(f.summary ?? f.abstract ?? ''), date: /\d{4}-\d{2}-\d{2}/.exec(f.published ?? f.date ?? f.created ?? '')?.[0] ?? null,
        url: /https?:\/\/\S+/.exec(f.web ?? f.url ?? f.link ?? '')?.[0] ?? null, venue: unescapeMd(f.venue ?? ''),
      });
    }
    i -= 1;
  }
  return out;
}

/**
 * Papers out of an MCP tool's text. JSON (an array, or an object holding one) is read as records; anything else is read
 * as Markdown table rows when the text holds a table, else as blocks separated by blank lines or list bullets, and a block counts when it names a DOI or an arXiv id, or opens
 * with a heading or "Title:".
 * @param {string} text @returns {RawPaper[]}
 */
export function parseMcpPapers(text) {
  const body = String(text ?? '').trim();
  if (!body) return [];
  if (/^[[{]/.test(body)) {
    try {
      const data = JSON.parse(body);
      const rows = Array.isArray(data) ? data : (Object.values(data).find(Array.isArray) ?? []);
      const out = rows.filter((r) => r && typeof r === 'object' && (r.title || r.name)).map((r) => ({
        title: String(r.title ?? r.name), doi: r.doi ?? findDoi(JSON.stringify(r)), arxiv: r.arxivId ?? r.arxiv_id ?? r.arxiv ?? findArxiv(JSON.stringify(r)),
        authors: (r.authors ?? []).map((a) => (typeof a === 'string' ? a : a?.name ?? a?.fullName)).filter(Boolean),
        abstract: String(r.abstract ?? r.summary ?? ''), date: String(r.publishedAt ?? r.published ?? r.date ?? '').slice(0, 10) || null,
        url: r.url ?? r.link ?? null, venue: String(r.venue ?? r.journal ?? ''),
      }));
      if (out.length) return out;
    } catch { /* plain text that starts with a bracket */ }
  }
  const rows = parseMarkdownTable(body);
  if (rows.length) return rows;
  const blocks = body.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+[.)])\s+)|\n(?=#{1,4}\s)/);
  const out = [];
  for (const block of blocks) {
    const doi = findDoi(block), arxiv = findArxiv(block);
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const titled = /^Title:\s*(.+)$/im.exec(block)?.[1] ?? (/^#{1,4}\s+(.+)$/m.exec(block)?.[1]);
    if (!doi && !arxiv && !titled) continue;
    const clean = (/** @type {string} */ l) => l.replace(/^(?:[-*]|\d+[.)]|#{1,4})\s*/, '').replace(/\*\*|__/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^Title:\s*/i, '').replace(/https?:\/\/\S+/g, '').replace(/[\s:|-]+$/, '').trim();
    const title = clean(titled ?? lines.find((l) => !/^(https?:|doi:|arxiv:|authors?:|date:|url:)/i.test(clean(l)) && clean(l).length > 8) ?? '');
    if (!title) continue;
    const url = /https?:\/\/[^\s)>\]]+/.exec(block)?.[0] ?? null;
    out.push({ title, doi, arxiv, url, abstract: '', authors: [] });
  }
  return out;
}

/** The source's argument template with "{query}" replaced wherever it appears as a string, however deep. */
export function fillArgs(/** @type {any} */ template, /** @type {string} */ query) {
  if (typeof template === 'string') return template.split('{query}').join(query);
  if (Array.isArray(template)) return template.map((t) => fillArgs(t, query));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillArgs(v, query)]));
  return template;
}

/**
 * The phrases one database or tool is asked for. Your strongest topics take all but one slot; the last slot rotates
 * through the learned topics still above the floor, one per run (spec 017 D2). With no learned topic, or too few of
 * yours to fill the slots, the rest fill up as before.
 * @param {import("./radar-types").RadarProfile} profile @param {number} n @param {number} turn run counter plus this source's place among its kind
 */
export function topicsOf(profile, n, turn = 0) {
  const byWeight = (/** @type {import("./radar-types").Weighted} */ a, /** @type {import("./radar-types").Weighted} */ b) => b.weight - a.weight;
  const user = profile.topics.filter((t) => t.origin !== 'learned').sort(byWeight);
  const learned = profile.topics.filter((t) => t.origin === 'learned' && t.weight >= LEARNED_FLOOR).sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  if (!learned.length) return user.slice(0, n).map((t) => t.text);
  const mine = user.slice(0, Math.min(user.length, n - 1));
  const slots = Math.min(learned.length, n - mine.length);
  const turns = Array.from({ length: slots }, (_, i) => learned[(turn + i) % learned.length]);
  return [...mine, ...turns, ...user.slice(mine.length, mine.length + n - mine.length - slots)].slice(0, n).map((t) => t.text);
}

/** The first error, or null when anything answered. @param {string[]} errors @param {number} tried @param {number} got */
const allFailed = (errors, tried, got) => (errors.length && errors.length === tried && !got ? errors[0] : null);

/**
 * @param {RadarSource} source
 * @param {{ fetch: typeof fetch, hub?: { call(server: string, tool: string, args: object): Promise<string> }, profile: import("./radar-types").RadarProfile, since: string, feedCache?: import("./feeds.js").FeedCache | null, turn?: number, seedPlan?: SeedPlan | null, feedCaches?: Record<string, import("./feeds.js").FeedCache> }} env `turn`: which learned topic this source's rotating slot takes; `seedPlan`: a seed radar's arXiv categories and phrases
 * @returns {Promise<SourceResult>}
 */
export async function fetchSource(source, env) {
  /** @param {RawPaper[]} raws @param {string | null} [error] @param {import("./feeds.js").FeedCache | null} [cache] */
  const done = (raws, error = null, cache) => {
    const all = /** @type {RadarItem[]} */ (raws.map((r) => normalise(r, source.id)).filter(Boolean));
    // A feed or MCP tool is the user's own choice, so what it returns stays; the databases are filtered.
    const choice = source.kind === 'feed' || source.kind === 'mcp';
    const items = choice ? all : all.filter((it) => !isNonPaper(it));
    return { id: source.id, error, skipped: all.length - items.length, ...(cache !== undefined ? { cache } : {}), items };
  };
  try {
    switch (source.kind) {
      case 'database': {
        if (source.db === 'arxiv' && env.seedPlan) return done(...(await seededArxiv(env.fetch, env.seedPlan, env.since, env.feedCaches)));
        const topics = topicsOf(env.profile, DB_TOPICS, env.turn);
        if (!topics.length) return done([], 'no topics to search for');
        const raws = [], errors = [];
        for (const topic of topics) {
          try { raws.push(...(await searchSource(env.fetch, source.db, topic, PER_QUERY, env.since))); } catch (e) { errors.push(message(e)); }
        }
        return done(raws, allFailed(errors, topics.length, raws.length));
      }
      case 'journal': return done(await openAlexWorks(env.fetch, `primary_location.source.id:${shortId(source.openalexId)},from_publication_date:${env.since}`));
      case 'author': return done(await openAlexWorks(env.fetch, `authorships.author.id:${shortId(source.openalexId)},from_publication_date:${env.since}`));
      case 'feed': {
        const got = await fetchFeed(env.fetch, source.url, env.feedCache);
        const fresh = got.items.filter((i) => !i.date || i.date >= env.since);
        return done(fresh.map((i) => ({ title: i.title, doi: i.doi, arxiv: i.arxiv, authors: i.authors, abstract: i.summary, date: i.date, url: i.link, venue: source.title })), got.error, got.cache);
      }
      case 'mcp': {
        if (!env.hub) return done([], 'MCP servers are not available here');
        const topics = topicsOf(env.profile, MCP_TOPICS, env.turn);
        if (!topics.length) return done([], 'no topics to search for');
        const raws = [], errors = [];
        for (const query of topics) {
          try { raws.push(...parseMcpPapers(await env.hub.call(source.server, source.tool, source.args ? fillArgs(source.args, query) : { query })).filter((p) => !p.date || p.date >= env.since)); } catch (e) { errors.push(message(e)); }
        }
        return done(raws, allFailed(errors, topics.length, raws.length));
      }
    }
  } catch (e) {
    return done([], message(e));
  }
  return done([], 'unknown source');
}

const shortId = (/** @type {string} */ id) => id.replace(/^https?:\/\/openalex\.org\//, '');

/** @typedef {{ categories: string[], phrases: string[] }} SeedPlan */

/** A seed radar's arXiv (spec 021 G2): every new paper in the seeds' categories, from arXiv's daily RSS
 *  listing, plus a few phrase searches across all of arXiv for seeds outside those categories.
 *  @param {typeof fetch} fetchFn @param {SeedPlan} plan @param {string} since @param {Record<string, import("./feeds.js").FeedCache> | undefined} caches
 *  @returns {Promise<[RawPaper[], string | null]>} */
async function seededArxiv(fetchFn, plan, since, caches) {
  const raws = [], errors = [];
  for (const category of plan.categories) {
    const got = await fetchFeed(fetchFn, arxivCategoryFeed(category), caches?.[arxivCategoryFeed(category)] ?? null);
    if (got.error) { errors.push(`${category}: ${got.error}`); continue; }
    raws.push(...got.items.filter((i) => !i.date || i.date >= since).map((i) => ({ title: i.title, doi: i.doi, arxiv: i.arxiv, authors: i.authors, abstract: i.summary, date: i.date, url: i.link, venue: 'arXiv', kind: 'preprint' })));
  }
  for (const phrase of plan.phrases.slice(0, SEED_PHRASES)) {
    try { raws.push(...(await searchSource(fetchFn, 'arxiv', phrase, PER_QUERY, since))); } catch (e) { errors.push(message(e)); }
  }
  return [raws, allFailed(errors, plan.categories.length + Math.min(plan.phrases.length, SEED_PHRASES), raws.length)];
}

/**
 * Every enabled source at once, spending one shared request budget.
 * @param {{ sources: RadarSource[], profile: import("./radar-types").RadarProfile, since: string, fetch: typeof fetch, hub?: any, feedCache?: Record<string, import("./feeds.js").FeedCache>, budget?: number, rotation?: number, seedPlan?: SeedPlan | null }} run `rotation`: the radar's run counter; each database or tool source adds its own place so they do not all ask for the same learned topic
 * @returns {Promise<{ results: SourceResult[], requests: number }>}
 */
export async function fetchAll(run) {
  const net = politeFetch(run.fetch, run.budget);
  /** @type {Record<string, number>} */
  const placed = {};
  const results = await Promise.all(run.sources.filter((s) => s.on).map((s) => {
    const turn = (run.rotation ?? 0) + (placed[s.kind] = (placed[s.kind] ?? -1) + 1);
    return fetchSource(s, { fetch: net.fetch, hub: run.hub, profile: run.profile, since: run.since, feedCache: s.kind === 'feed' ? run.feedCache?.[s.url] : null, turn, seedPlan: run.seedPlan ?? null, feedCaches: run.feedCache });
  }));
  return { results, requests: net.used() };
}
