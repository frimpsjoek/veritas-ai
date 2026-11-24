// @ts-check
// agent/src/open-access.js. Spec 031 R2: a legal free copy of a paper outside the library. The sources are asked in
// order and the first PDF wins: arXiv (from the paper's arXiv id or an arXiv DOI), Unpaywall's open-access locations
// (only with the user's email, as its terms ask), OpenAlex's best open-access location, Semantic Scholar's
// openAccessPdf, Europe PMC (an open-access PMC copy). Nothing behind a paywall: without a free copy the answer is the
// publisher's page, which the user can open signed in with their own login (Browse, spec 027). Never throws.

/** `alternates`: the other free copies found, tried in turn when the first refuses an automated download (a publisher
 *  that answers 403 to anything but a browser); repository copies (PMC, university archives, arXiv) usually allow it.
 *  @typedef {{ access: "open", pdfUrl: string, via: string, alternates?: string[] } | { access: "publisher", page: string } | { access: "none" }} Access */

/** A DOI without its resolver prefix, lower case; '' for none. @param {unknown} doi */
export const bareDoi = (doi) => String(doi ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:/, '');

/**
 * The arXiv id of a paper, from its arXiv DOI (10.48550/arXiv.<id>), its URL or its PDF URL; null otherwise.
 * @param {{ doi?: string | null, url?: string | null, pdfUrl?: string | null, arxiv?: string | null }} paper
 */
export function arxivIdOf(paper) {
  if (paper.arxiv) return String(paper.arxiv).replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  const doi = /^10\.48550\/arxiv\.(.+)$/i.exec(bareDoi(paper.doi));
  if (doi) return doi[1].replace(/v\d+$/, '');
  for (const link of [paper.url, paper.pdfUrl]) {
    const m = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?(?:[?#]|$)/i.exec(String(link ?? ''));
    if (m) return m[1].replace(/v\d+$/, '');
  }
  return null;
}

/** The publisher's page of a paper: its DOI link, else its own web address. @param {{ doi?: string | null, url?: string | null }} paper */
export function publisherPage(paper) {
  const doi = bareDoi(paper.doi);
  if (doi) return `https://doi.org/${doi}`;
  return /^https?:\/\//i.test(String(paper.url ?? '')) && !/arxiv\.org/i.test(String(paper.url)) ? String(paper.url) : null;
}

/** @param {typeof fetch} fetchFn @param {string} url @param {Record<string, string>} [headers] */
async function getJSON(fetchFn, url, headers = {}) {
  const response = await fetchFn(url, { headers });
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return response.json();
}

/** At most this many free copies are kept per paper (the first plus alternates). */
const MAX_COPIES = 4;

/** A usable PDF address: http(s) only. @param {unknown} url */
const pdfLink = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

/**
 * The sources, in the order they are asked. Each returns a PDF address or null; a failure counts as null.
 * @param {typeof fetch} fetchFn @param {{ email?: string | null, s2Key?: string | null }} opts
 * @returns {{ id: string, find: (paper: { doi: string, arxiv: string | null }) => Promise<string | string[] | null> }[]}
 */
export function openAccessSources(fetchFn, opts = {}) {
  const email = String(opts.email ?? '').trim();
  return [
    { id: 'arXiv', find: async (p) => (p.arxiv ? `https://arxiv.org/pdf/${p.arxiv}` : null) },
    {
      id: 'Unpaywall',
      find: async (p) => {
        if (!p.doi || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
        const data = await getJSON(fetchFn, `https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=${encodeURIComponent(email)}`);
        return [data?.best_oa_location, ...(data?.oa_locations ?? [])].map((loc) => pdfLink(loc?.url_for_pdf)).filter((u) => u !== null);
      },
    },
    {
      id: 'OpenAlex',
      find: async (p) => {
        if (!p.doi) return null;
        const data = await getJSON(fetchFn, `https://api.openalex.org/works/doi:${encodeURIComponent(p.doi)}?select=best_oa_location,locations`);
        return [data?.best_oa_location, ...(data?.locations ?? [])].filter((loc) => loc?.is_oa !== false).map((loc) => pdfLink(loc?.pdf_url)).filter((u) => u !== null);
      },
    },
    {
      id: 'Semantic Scholar',
      find: async (p) => {
        if (!p.doi) return null;
        const headers = opts.s2Key ? { 'x-api-key': String(opts.s2Key) } : undefined;
        const data = await getJSON(fetchFn, `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(p.doi)}?fields=openAccessPdf`, headers);
        return pdfLink(data?.openAccessPdf?.url);
      },
    },
    {
      id: 'Europe PMC',
      find: async (p) => {
        if (!p.doi) return null;
        const data = await getJSON(fetchFn, `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(p.doi)}%22&format=json&resultType=core`);
        const hit = data?.resultList?.result?.[0];
        return hit?.pmcid && hit?.isOpenAccess === 'Y' ? `https://europepmc.org/articles/${hit.pmcid}?pdf=render` : null;
      },
    },
  ];
}

/**
 * Where a paper can be read: a free PDF, else the publisher's page, else nothing.
 * @param {typeof fetch} fetchFn
 * @param {{ doi?: string | null, url?: string | null, pdfUrl?: string | null, arxiv?: string | null }} paper
 * @param {{ email?: string | null, s2Key?: string | null, signal?: AbortSignal }} [opts]
 * @returns {Promise<Access>}
 */
export async function findOpenAccess(fetchFn, paper, opts = {}) {
  const known = pdfLink(paper.pdfUrl);
  if (known) return { access: 'open', pdfUrl: known, via: 'the search' };
  const asked = { doi: bareDoi(paper.doi), arxiv: arxivIdOf(paper) };
  if (asked.doi || asked.arxiv) {
    // every source is asked, so a copy a publisher refuses to hand to a program has others to fall back on
    /** @type {string[]} */ const urls = [];
    let via = '';
    for (const source of openAccessSources(fetchFn, opts)) {
      if (opts.signal?.aborted || urls.length >= MAX_COPIES) break;
      const got = await source.find(asked).catch(() => null);
      for (const url of (Array.isArray(got) ? got : got ? [got] : [])) {
        if (!urls.includes(url)) { urls.push(url); via ||= source.id; }
      }
      if (source.id === 'arXiv' && urls.length) break; // arXiv hands its PDFs to programs: no need to look further
    }
    if (urls.length) return { access: 'open', pdfUrl: urls[0], via, ...(urls.length > 1 ? { alternates: urls.slice(1, MAX_COPIES) } : {}) };
  }
  const page = publisherPage(paper);
  return page ? { access: 'publisher', page } : { access: 'none' };
}

/**
 * findOpenAccess for many papers, a few at a time. Results are parallel to `papers`.
 * @template {{ doi?: string | null, url?: string | null, pdfUrl?: string | null, arxiv?: string | null }} P
 * @param {typeof fetch} fetchFn @param {P[]} papers @param {{ email?: string | null, s2Key?: string | null, signal?: AbortSignal, workers?: number }} [opts]
 * @returns {Promise<Access[]>}
 */
export async function findOpenAccessAll(fetchFn, papers, opts = {}) {
  /** @type {Access[]} */
  const out = new Array(papers.length);
  let next = 0;
  const worker = async () => {
    while (!opts.signal?.aborted) {
      const i = next++;
      if (i >= papers.length) return;
      out[i] = await findOpenAccess(fetchFn, papers[i], opts).catch(() => /** @type {Access} */ ({ access: 'none' }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.workers ?? 4, Math.max(1, papers.length)) }, worker));
  return out.map((a, i) => a ?? (publisherPage(papers[i]) ? { access: 'publisher', page: /** @type {string} */ (publisherPage(papers[i])) } : { access: 'none' }));
}
