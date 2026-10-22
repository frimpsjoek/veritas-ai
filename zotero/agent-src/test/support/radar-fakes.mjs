// Fakes for the radar tests: invented papers only (public repo).
export const feedXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.doi ? `<guid>doi:${i.doi}</guid>` : ''}<pubDate>${i.date ?? 'Tue, 06 Oct 2026 09:00:00 GMT'}</pubDate><description>${i.summary ?? ''}</description></item>`).join('')}</channel></rss>`;

export const res = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body || 'null'),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

/** A fetch that answers by exact URL; anything else is a 404. `calls` records every request. */
export function routedFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (r === undefined) return res(404);
    return typeof r === 'function' ? r(init) : r;
  };
  fn.calls = calls;
  return fn;
}

/**
 * A LibraryBackend with the four radar methods. `sim(text)` is each paper's similarity; `neg(text, negatives)` its
 * closeness to the dismissed examples (default: 0.95 when it shares a word of 5+ letters with any).
 */
export function radarLibrary({ known = [], sim = () => 0.8, neg } = {}) {
  const calls = { score: [], items: [] };
  const closeness = neg ?? ((text, negatives) => (negatives.some((n) => n.toLowerCase().split(/\W+/).some((w) => w.length >= 5 && text.toLowerCase().includes(w))) ? 0.95 : 0));
  return {
    calls,
    async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); },
    async items(q) { calls.items.push(q); return known; },
    async radarScore(q) {
      calls.score.push(q);
      return Object.fromEntries(q.items.map((i) => [i.id, { similarity: sim(i.text), negative: closeness(i.text, q.negatives) }]));
    },
    async radarProfile() { return { topics: [], authors: [], journals: [] }; },
    async writeDigest() {},
  };
}

export const profile = (over = {}) => ({ topics: [{ text: 'sleep spindle', weight: 1, origin: 'user' }], authors: [], journals: [], ...over });

/**
 * A fake OpenAlex that answers `filter=doi:a|b` and `filter=openalex:W1|W2` from a fixture graph. A work is
 * `{ id: 'W1', doi, title, refs: ['W2'], year, cited }`; `calls` records every URL.
 */
export function openAlexGraph(works) {
  const calls = [];
  const json = (w) => ({
    id: `https://openalex.org/${w.id}`, doi: w.doi ? `https://doi.org/${w.doi}` : null, display_name: w.title,
    publication_year: w.year ?? 1999, publication_date: `${w.year ?? 1999}-01-01`, cited_by_count: w.cited ?? 0,
    referenced_works: (w.refs ?? []).map((r) => `https://openalex.org/${r}`), authorships: [], primary_location: { source: { display_name: 'Journal of Invented Results' } },
    abstract_inverted_index: { Invented: [0], abstract: [1] },
  });
  const fn = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.host !== 'api.openalex.org') return res(404);
    const f = u.searchParams.get('filter') ?? '';
    const k = f.slice(0, f.indexOf(':')), want = f.slice(f.indexOf(':') + 1).split('|');
    const hit = works.filter((w) => (k === 'doi' ? want.includes(w.doi) : want.includes(w.id)));
    return res(200, JSON.stringify({ results: hit.map(json) }));
  };
  fn.calls = calls;
  fn.refCalls = () => calls.filter((c) => c.includes('referenced_works'));
  return fn;
}
