// @ts-check
// agent-src/src/feeds.js. Spec 012 R1: RSS 2.0, RSS 1.0 (RDF) and Atom by regex, so the same code runs in Node and in
// Gecko (neither has a DOMParser we can rely on here). Feeds are read leniently: a missing field is null, never an error.

/** @typedef {{ title: string, link: string | null, date: string | null, authors: string[], summary: string, doi: string | null, arxiv: string | null, guid: string | null }} FeedItem */
/** @typedef {{ etag: string | null, modified: string | null }} FeedCache */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** @param {string} s */
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const safeChar = (code, fallback) => { try { return String.fromCodePoint(code); } catch { return fallback; } };

/** CDATA is raw markup; anything else is entity-escaped, and escaped markup is markup once decoded. @param {string} s */
function text(s) {
  const cdata = /<!\[CDATA\[/.test(s);
  const decoded = decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  const stripped = decoded.replace(/<[^>]+>/g, ' ');
  // Escaped markup was HTML all along, so its own entities (&amp;amp;) need a second decode.
  return (!cdata && stripped !== decoded ? decode(stripped) : stripped).replace(/\s+/g, ' ').trim();
}

/** Contents of every `<name>` element (any namespace prefix) in `xml`. @param {string} xml @param {string} name */
function tags(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]);
}
const first = (xml, name) => tags(xml, name)[0];

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>&]+/i;
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7}))(?:v\d+)?|arxiv:\s*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7}))/i;

/** @param {string} s */
export function findDoi(s) {
  const m = DOI_RE.exec(decode(s));
  return m ? m[0].replace(/[.,;:)\]]+$/, '').toLowerCase() : null;
}
/** @param {string} s */
export function findArxiv(s) {
  const m = ARXIV_RE.exec(decode(s));
  return m ? (m[1] ?? m[2]).replace(/\.pdf$/, '') : null;
}

/** @param {string | undefined} s @returns {string | null} YYYY-MM-DD */
function dateOf(s) {
  if (!s) return null;
  const t = Date.parse(text(s));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** @param {string} item */
function linkOf(item) {
  const atom = [...item.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]).filter((a) => /href=/.test(a));
  if (atom.length) {
    const pick = atom.find((a) => /rel=["']alternate["']/.test(a)) ?? atom.find((a) => !/rel=/.test(a)) ?? atom[0];
    return decode(/href=["']([^"']+)["']/.exec(pick)?.[1] ?? '') || null;
  }
  const plain = first(item, 'link');
  return plain ? text(plain) || null : null;
}

/** @param {string} item */
function authorsOf(item) {
  const names = [];
  for (const a of tags(item, 'author')) {
    const name = first(a, 'name');
    // RSS 2.0 <author> is "mail@host (Name)"; keep the name part.
    const t = text(name ?? a);
    names.push(t.replace(/^.*\(([^)]+)\)\s*$/, '$1').replace(/\s*<[^>]*>/, ''));
  }
  for (const c of tags(item, 'creator')) names.push(text(c));
  return [...new Set(names.filter((n) => n && !/^[^\s@]+@[^\s@]+$/.test(n)))];
}

/**
 * Items of an RSS 2.0, RSS 1.0/RDF or Atom document, in document order.
 * @param {string} xml @returns {FeedItem[]}
 */
export function parseFeed(xml) {
  const body = String(xml ?? '');
  const blocks = [...body.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const out = [];
  for (const block of blocks) {
    const title = text(first(block, 'title') ?? '');
    if (!title) continue;
    const link = linkOf(block);
    const guid = text(first(block, 'guid') ?? first(block, 'id') ?? '') || null;
    const summary = text(first(block, 'encoded') ?? first(block, 'description') ?? first(block, 'summary') ?? first(block, 'content') ?? '');
    const date = dateOf(first(block, 'pubDate') ?? first(block, 'date') ?? first(block, 'published') ?? first(block, 'updated') ?? first(block, 'publicationDate'));
    const dcId = text(first(block, 'identifier') ?? '');
    const ids = [dcId, link ?? '', guid ?? '', block];
    out.push({
      title, link, date, authors: authorsOf(block), summary, guid,
      doi: ids.map(findDoi).find(Boolean) ?? null,
      arxiv: ids.map(findArxiv).find(Boolean) ?? null,
    });
  }
  return out;
}

/**
 * GET a feed, sending the validators from its last fetch. 304 means nothing new. Never throws.
 * @param {typeof fetch} fetchFn @param {string} url @param {FeedCache | null | undefined} cache
 * @returns {Promise<{ items: FeedItem[], cache: FeedCache | null, error: string | null, notModified?: true }>}
 */
export async function fetchFeed(fetchFn, url, cache) {
  const have = cache ?? null;
  try {
    const headers = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5' };
    if (have?.etag) headers['If-None-Match'] = have.etag;
    if (have?.modified) headers['If-Modified-Since'] = have.modified;
    const res = await fetchFn(url, { headers });
    if (res.status === 304) return { items: [], cache: have, error: null, notModified: true };
    if (!res.ok) return { items: [], cache: have, error: `HTTP ${res.status}` };
    const xml = await res.text();
    const items = parseFeed(xml);
    if (!items.length && !/<(rss|feed|rdf:RDF)\b/i.test(xml)) return { items: [], cache: have, error: 'not a feed' };
    return { items, cache: { etag: res.headers?.get?.('etag') ?? null, modified: res.headers?.get?.('last-modified') ?? null }, error: null };
  } catch (e) {
    return { items: [], cache: have, error: String(/** @type {any} */ (e)?.message ?? e) };
  }
}

/** The feed's own title (the one before its first item or entry), or null. @param {string} xml */
export function feedTitle(xml) {
  const head = xml.split(/<(?:[\w-]+:)?(?:item|entry)\b/i)[0];
  const t = first(head.replace(/<image\b[\s\S]*?<\/image>/gi, ''), 'title');
  return t ? text(t) || null : null;
}
