// @ts-check
// agent-src/src/scholarly.js. A port of content/discover.js's multi-source scholarly search for the
// search_scholarly tool. discover.js itself is untouched; this takes an injected `fetch` (the platform's) instead
// of Zotero.HTTP.request, so it runs in Node and Zotero alike, and drops the Zotero-only bits (adding to the
// library, "related papers for an item") that belong to T4.2's LibraryBackend, not a read-only search tool.

export const SOURCES = ['openalex', 'semanticscholar', 'arxiv', 'crossref', 'europepmc', 'biorxiv', 'chemrxiv'];

export const OPENALEX_FIELDS = 'id,doi,ids,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,best_oa_location,type,abstract_inverted_index,keywords';
const CHEMRXIV_SOURCE_ID = 'S4393918830';

async function getJSON(fetchFn, url, headers = {}) {
  const response = await fetchFn(url, { headers });
  if (response.status === 429) throw new Error(`${new URL(url).host}: too many requests`);
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return response.json();
}

/** OpenAlex ships abstracts as a word -> positions index; put the words back in order. */
function openAlexAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const at of positions) words[at] = word;
  return words.filter((w) => w !== undefined).join(' ').trim();
}

/** Abstracts from JATS-flavoured sources (Crossref, Europe PMC) come with markup. */
const plain = (text) => String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/^abstract\b[:.\s]*/i, '').replace(/\s+([.,;:!?)])/g, '$1').trim();

export function fromOpenAlex(work) {
  const arxiv = /arxiv\.org\/abs\/([^\s?#v]+)/i.exec(work.primary_location?.landing_page_url ?? '')?.[1] ?? null;
  return {
    doi: (work.doi ?? '').replace(/^https?:\/\/doi\.org\//i, '') || null,
    arxiv,
    title: work.display_name ?? '',
    authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name ?? '',
    cites: work.cited_by_count ?? 0,
    url: work.best_oa_location?.pdf_url ?? work.primary_location?.landing_page_url ?? null,
    abstract: openAlexAbstract(work.abstract_inverted_index),
    source: 'OpenAlex',
    date: /^\d{4}-\d{2}-\d{2}$/.test(work.publication_date ?? '') ? work.publication_date : null,
    openalexId: String(work.id ?? '').replace(/^https?:\/\/openalex\.org\//, '') || null,
    kind: work.type || null,
    ...((work.keywords ?? []).length ? { keywords: work.keywords.map((k) => k?.display_name).filter(Boolean).slice(0, 8) } : {}),
  };
}

async function openAlex(fetchFn, path) {
  const data = await getJSON(fetchFn, `https://api.openalex.org${path}`);
  return (data.results ?? []).map(fromOpenAlex);
}

/** OpenAlex works for a raw filter (the radar's journal and author sources). `filter` is the already-built filter string. */
export function openAlexWorks(fetchFn, filter, limit = 50) {
  return openAlex(fetchFn, `/works?filter=${filter}&sort=publication_date:desc&per_page=${limit}&select=${OPENALEX_FIELDS}`);
}

/** `since` is a YYYY-MM-DD date; anything else is ignored, so a bad value can never break a search. */
const validSince = (since) => (typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null);

async function arxiv(fetchFn, query, limit, since = /** @type {string | null} */ (null)) {
  const STOP = new Set('the and for with from into between about over under using use how what which why when does can are was were this that these those its their our your via of in on to by at an as is be or not'.split(' '));
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5);
  if (!words.length) return [];
  const range = since ? `+AND+submittedDate:[${since.replace(/-/g, '')}0000+TO+209912312359]` : '';
  const url = `https://export.arxiv.org/api/query?search_query=${words.map((w) => `all:${encodeURIComponent(w)}`).join('+AND+')}${range}&max_results=${limit}&sortBy=relevance`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`arxiv: HTTP ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const tag = (entry, name) => entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return entries.map((entry) => {
    const id = tag(entry, 'id').replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    return {
      doi: tag(entry, 'arxiv:doi') || null, arxiv: id, title: tag(entry, 'title'),
      authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => m[1].trim()),
      year: Number(tag(entry, 'published').slice(0, 4)) || null, venue: 'arXiv', cites: 0,
      url: `https://arxiv.org/pdf/${id}`, abstract: tag(entry, 'summary'), source: 'arXiv',
      date: /^\d{4}-\d{2}-\d{2}/.test(tag(entry, 'published')) ? tag(entry, 'published').slice(0, 10) : null, openalexId: null, kind: 'preprint',
    };
  });
}

// ---------------------------------------------------------------- arXiv for the seed radar (spec 021 G2)

/** @param {string} xml */
function arxivEntries(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const tag = (/** @type {string} */ entry, /** @type {string} */ name) => entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return entries.map((entry) => {
    const id = tag(entry, 'id').replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    const published = tag(entry, 'published');
    return {
      doi: tag(entry, 'arxiv:doi') || null, arxiv: id, title: tag(entry, 'title'),
      authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => m[1].trim()),
      year: Number(published.slice(0, 4)) || null, venue: 'arXiv', cites: 0,
      url: `https://arxiv.org/abs/${id}`, abstract: tag(entry, 'summary'), source: 'arXiv',
      date: /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : null, openalexId: null, kind: 'preprint',
      category: entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] ?? null,
    };
  });
}

export const ARXIV_RETRY_MS = [10_000, 30_000];
const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** arXiv answers 429 or 503 when it is busy or a client asks too often; it gives no Retry-After, so wait and try
 *  again twice before giving up. @param {typeof fetch} fetchFn @param {string} query arXiv's search_query syntax
 *  @param {number} limit @param {string} [sort] @param {(ms: number) => Promise<void>} [sleep] */
export async function arxivQuery(fetchFn, query, limit, sort = 'submittedDate', sleep = pause) {
  const url = `https://export.arxiv.org/api/query?search_query=${query}&max_results=${limit}&sortBy=${sort}&sortOrder=descending`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchFn(url);
    if (response.ok) return arxivEntries(await response.text());
    if (![429, 503].includes(response.status) || attempt >= ARXIV_RETRY_MS.length) throw new Error(`arxiv: HTTP ${response.status}${response.status === 429 ? ' (arXiv asks to slow down; the next run tries again)' : ''}`);
    await sleep(ARXIV_RETRY_MS[attempt]);
  }
}

/** The daily listing of one arXiv category: arXiv's own RSS feed, abstracts included. The seed radar reads its
 *  categories here (no API rate limit) and lets the seed comparison decide. @param {string} category */
export const arxivCategoryFeed = (category) => `https://rss.arxiv.org/rss/${category}`;

/** Everything new in one arXiv category since `since` (YYYY-MM-DD), newest first: the seed radar reads its categories
 *  whole and lets the seed comparison decide. @param {typeof fetch} fetchFn @param {string} category @param {string} since @param {number} [limit] */
export function arxivRecent(fetchFn, category, since, limit = 100) {
  if (!/^[a-z-]+(\.[A-Za-z-]+)?$/.test(category)) return Promise.resolve([]);
  const from = (validSince(since) ?? since).replace(/-/g, '');
  return arxivQuery(fetchFn, `cat:${category}+AND+submittedDate:[${from}0000+TO+209912312359]`, limit);
}

/** The primary arXiv category of a paper found by its title, or null. @param {typeof fetch} fetchFn @param {string} title */
export async function arxivCategoryOf(fetchFn, title) {
  const words = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
  if (words.length < 2) return null;
  const hits = await arxivQuery(fetchFn, words.map((w) => `ti:${encodeURIComponent(w)}`).join('+AND+'), 3, 'relevance');
  const norm = (/** @type {string} */ t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return hits.find((h) => norm(h.title) === norm(title))?.category ?? null;
}

/** Crossref gives [y, m, d] with the tail missing for a coarse date; only a full date is a date. */
const dateParts = (parts) => (Array.isArray(parts) && parts.length >= 3 ? parts.slice(0, 3).map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-') : null);

/** Crossref names its types differently from OpenAlex; the radar's table is in OpenAlex's words. */
const CROSSREF_KINDS = /** @type {Record<string, string>} */ ({ 'journal-article': 'article', 'posted-content': 'preprint', 'proceedings-article': 'proceedings' });

async function crossref(fetchFn, query, limit, since = /** @type {string | null} */ (null)) {
  const types = ['journal-article', 'posted-content', 'proceedings-article', 'book-chapter', 'book'].map((t) => `type:${t}`).concat(since ? [`from-pub-date:${since}`] : []).join(',');
  const data = await getJSON(fetchFn, `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&filter=${types}`);
  return (data.message?.items ?? []).filter((w) => w.title?.[0] && !/\.s\d+$/i.test(w.DOI)).map((w) => ({
    doi: w.DOI, arxiv: null, title: w.title[0].replace(/<[^>]+>/g, ''),
    authors: (w.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    year: w.issued?.['date-parts']?.[0]?.[0] ?? null, venue: w['container-title']?.[0] ?? '',
    cites: w['is-referenced-by-count'] ?? 0, url: w.URL ?? null, abstract: plain(w.abstract), source: 'Crossref',
    date: dateParts(w.issued?.['date-parts']?.[0]), openalexId: null, kind: CROSSREF_KINDS[w.type] ?? w.type ?? null,
  }));
}

async function europePMC(fetchFn, query, limit, source = 'Europe PMC', since = /** @type {string | null} */ (null)) {
  const q = since ? `(${query}) AND FIRST_PDATE:[${since} TO *]` : query;
  const data = await getJSON(fetchFn, `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${limit}`);
  return (data.resultList?.result ?? []).map((r) => ({
    doi: r.doi ?? null, arxiv: null, title: (r.title ?? '').replace(/<[^>]+>/g, '').replace(/\.$/, ''),
    authors: (r.authorList?.author ?? []).map((a) => a.fullName).filter(Boolean),
    year: Number(r.pubYear) || null, venue: r.journalInfo?.journal?.title ?? (r.source === 'PPR' ? 'Preprint' : ''),
    cites: r.citedByCount ?? 0, abstract: plain(r.abstractText),
    url: (r.fullTextUrlList?.fullTextUrl ?? []).find((u) => u.documentStyle === 'pdf' && /open|free/i.test(u.availability ?? ''))?.url ?? null,
    source, date: /^\d{4}-\d{2}-\d{2}$/.test(r.firstPublicationDate ?? '') ? r.firstPublicationDate : null, openalexId: null,
  }));
}

async function semanticScholar(fetchFn, query, limit, since = /** @type {string | null} */ (null)) {
  const range = since ? `&publicationDateOrYear=${since}:` : '';
  const data = await getJSON(fetchFn, `https://api.semanticscholar.org/graph/v1/paper/search?limit=${limit}${range}&query=${encodeURIComponent(query)}&fields=title,year,authors,venue,externalIds,citationCount,openAccessPdf,abstract,publicationDate`);
  return (data.data ?? []).map((p) => ({
    doi: p.externalIds?.DOI ?? null, arxiv: p.externalIds?.ArXiv ?? null, title: p.title ?? '',
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean), year: p.year ?? null, venue: p.venue ?? '',
    cites: p.citationCount ?? 0, url: p.openAccessPdf?.url ?? null, abstract: p.abstract ?? '', source: 'Semantic Scholar',
    date: /^\d{4}-\d{2}-\d{2}$/.test(p.publicationDate ?? '') ? p.publicationDate : null, openalexId: null,
  }));
}

async function searchOne(fetchFn, id, query, limit, since = /** @type {string | null} */ (null)) {
  const from = since ? `from_publication_date:${since}` : '';
  switch (id) {
    case 'openalex': return openAlex(fetchFn, `/works?search=${encodeURIComponent(query)}${from ? `&filter=${from}` : ''}&per_page=${limit}&select=${OPENALEX_FIELDS}`);
    case 'chemrxiv': return openAlex(fetchFn, `/works?search=${encodeURIComponent(query)}&filter=primary_location.source.id:${CHEMRXIV_SOURCE_ID}${from ? `,${from}` : ''}&per_page=${limit}&select=${OPENALEX_FIELDS}`);
    case 'semanticscholar': return semanticScholar(fetchFn, query, limit, since);
    case 'arxiv': return arxiv(fetchFn, query, limit, since);
    case 'crossref': return crossref(fetchFn, query, limit, since);
    case 'europepmc': return europePMC(fetchFn, query, limit, 'Europe PMC', since);
    case 'biorxiv': return europePMC(fetchFn, `(${query}) AND SRC:PPR AND (PUBLISHER:"bioRxiv" OR PUBLISHER:"medRxiv")`, limit, 'bioRxiv/medRxiv', since);
    default: return [];
  }
}

/**
 * One source's search, with `since` validated. The radar calls this per source so it can report each source's own
 * result or error; `searchScholarly` below keeps its merged, error-swallowing contract.
 * @param {typeof fetch} fetchFn @param {string} id one of SOURCES @param {string} query @param {number} limit @param {string} [since]
 */
export function searchSource(fetchFn, id, query, limit, since) {
  return searchOne(fetchFn, id, query, limit, validSince(since));
}

/**
 * Abstracts for papers a researcher already named, looked up by DOI in OpenAlex (50 per request). A researcher is told
 * to copy abstracts as its tools returned them, so what it writes back is a model's copy or nothing; this is the
 * index's own text, and costs no tokens. Failures are quiet: a paper without one is simply left as it was.
 * @param {typeof fetch} fetchFn
 * @param {string[]} dois
 * @returns {Promise<Map<string, string>>} lower-cased DOI -> abstract
 */
export async function abstractsByDoi(fetchFn, dois) {
  const found = new Map();
  const unique = [...new Set(dois.map((d) => String(d ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')).filter(Boolean))];
  for (let at = 0; at < unique.length; at += 50) {
    const batch = unique.slice(at, at + 50);
    try {
      const data = await getJSON(fetchFn, `https://api.openalex.org/works?filter=doi:${batch.map(encodeURIComponent).join('|')}&per_page=50&select=doi,abstract_inverted_index`);
      for (const work of data.results ?? []) {
        const doi = String(work.doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '');
        const text = openAlexAbstract(work.abstract_inverted_index);
        if (doi && text.length > 80) found.set(doi, text);
      }
    } catch { /* best effort */ }
  }
  return found;
}

/**
 * Fans the query out to the chosen sources (Promise.allSettled, as discover.js does) and merges by DOI or
 * normalized title, alternating between sources so one doesn't crowd out the rest.
 * @param {typeof fetch} fetchFn
 * @param {string} query
 * @param {{ limit?: number, sources?: string[], since?: string }} [opts] `since`: YYYY-MM-DD, keep only papers published on or after it (routines pass it; absent means no filter)
 */
export async function searchScholarly(fetchFn, query, opts = {}) {
  const sources = opts.sources?.length ? opts.sources : ['openalex', 'arxiv', 'crossref', 'europepmc'];
  const perSource = opts.limit ?? 10;
  const runs = await Promise.allSettled(sources.map((id) => searchOne(fetchFn, id, query, perSource, validSince(opts.since))));
  // Every source erroring is a failed search, not "no results": the caller must not report an empty literature.
  const down = runs.filter((r) => r.status === 'rejected');
  if (down.length && down.length === runs.length) {
    const why = /** @type {PromiseRejectedResult} */ (down[0]).reason;
    if (why instanceof Error && why.name === 'OpenAlexLimit') throw why;
    throw new Error(`None of the literature sources answered (${why instanceof Error ? why.message : String(why)})`);
  }
  const merged = [];
  const seenKeys = new Map();
  for (let rank = 0; runs.some((r) => r.status === 'fulfilled' && rank < r.value.length); rank++) {
    for (const run of runs) {
      if (run.status !== 'fulfilled') continue;
      const paper = run.value[rank];
      if (!paper?.title) continue;
      const key = paper.doi ? `doi:${paper.doi.toLowerCase()}` : `title:${paper.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.set(key, true);
      merged.push(paper);
    }
  }
  return merged.slice(0, opts.limit ?? 10);
}
