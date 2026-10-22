// @ts-check
// agent-src/src/radar-seeds.js (server spec 021 G1, G2, G4). What the onboarding asks the engine before a seed
// radar exists: the user's own papers (OpenAlex, by ORCID or name, each marked when it is in the library), the arXiv
// categories the seeds were posted in, and a threshold calibrated on this library. Nothing here throws for what the
// user typed; a failed lookup comes back as a plain sentence.
import { politeFetch } from './radar-sources.js';
import { fetchFeed } from './feeds.js';
import { openAlexWorks, arxivCategoryOf, arxivCategoryFeed } from './scholarly.js';
import { normTitle, isNonPaper, seedBody } from './radar.js';
import { nameKey } from './radar-score.js';

/** @typedef {import("./radar-types").MyPaper} MyPaper */
/** @typedef {import("./radar-types").RadarSeeds} RadarSeeds */

const API = 'https://api.openalex.org';
const MY_WORKS = 100;
const CANDIDATES = 5;
const CATEGORY_LOOKUPS = 12;
const MAX_CATEGORIES = 4;
/** Fields far from most research, for the "unrelated" side of calibration; the seeds' own archives are left out. */
export const CONTRAST = ['astro-ph.GA', 'q-bio.PE', 'econ.GN', 'math.NT', 'cs.CY', 'physics.hist-ph', 'q-fin.GN', 'nlin.CD'];
const PER_CONTRAST = 10;
const FULL_UNRELATED = 8;
/** Papers from the seeds' own field per category, for the baselines and the field cut. */
const PER_FIELD = 40;

const message = (/** @type {any} */ e) => String(e?.message ?? e);
const shortId = (/** @type {string} */ id) => String(id ?? '').replace(/^https?:\/\/openalex\.org\//, '');
const orcidOf = (/** @type {string} */ v) => /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i.exec(String(v ?? ''))?.[1]?.toUpperCase() ?? null;
const doiKey = (/** @type {string | null | undefined} */ d) => String(d ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

/**
 * The user's own papers (D1): their OpenAlex author record, found by ORCID or name, and its works, newest first. Each is
 * matched to the library by DOI or title. Several people with the same name come back as `authors` to choose from.
 * @param {{ fetch: typeof fetch, library: import("./tools").LibraryBackend, name: string, orcid?: string | null, openalexId?: string | null }} q
 * @returns {Promise<{ authors: { openalexId: string, label: string }[], chosen: string | null, papers: (MyPaper & { inLibrary: boolean })[], problem: string | null }>}
 */
export async function myPapers(q) {
  const net = politeFetch(q.fetch, 10).fetch;
  const empty = (/** @type {string} */ problem) => ({ authors: [], chosen: null, papers: [], problem });
  const orcid = orcidOf(q.orcid ?? '') ?? orcidOf(q.name);
  if (!orcid && !String(q.name ?? '').trim() && !q.openalexId) return empty('Type your name or your ORCID.');
  let people;
  try {
    const filter = q.openalexId ? `/authors?filter=ids.openalex:${encodeURIComponent(shortId(q.openalexId))}`
      : orcid ? `/authors?filter=orcid:${orcid}`
      : `/authors?search=${encodeURIComponent(q.name.trim())}&per_page=${CANDIDATES}`;
    const res = await net(`${API}${filter}&select=id,display_name,works_count,last_known_institutions`);
    if (!res.ok) return empty(`OpenAlex answered HTTP ${res.status}. Try again in a minute.`);
    people = (await res.json()).results ?? [];
  } catch (e) { return empty(`Couldn't reach OpenAlex (${message(e)}).`); }
  // A name search returns namesakes; keep the ones whose name reads the same, most works first.
  const same = orcid || q.openalexId ? people : people.filter((p) => nameKey(p.display_name) === nameKey(q.name));
  const authors = same.map((p) => ({ openalexId: shortId(p.id), label: [p.display_name, p.last_known_institutions?.[0]?.display_name, `${p.works_count ?? 0} works`].filter(Boolean).join(', ') }));
  if (!authors.length) return empty(orcid ? `No OpenAlex author has the ORCID ${orcid}.` : `OpenAlex has no author named ${q.name.trim()}. Try your ORCID.`);
  const library = q.library.items ? await q.library.items({ collections: null }).catch(() => []) : [];
  const byDoi = new Map(library.filter((it) => it.doi).map((it) => [doiKey(it.doi), it.key]));
  // An empty title would match every untitled work: only real titles are looked up.
  const byTitle = new Map(library.filter((it) => normTitle(it.title)).map((it) => [normTitle(it.title), it.key]));
  const inLibrary = (/** @type {any} */ w) => Boolean((w.doi && byDoi.get(doiKey(w.doi))) || (normTitle(w.title) && byTitle.get(normTitle(w.title))));
  // Namesakes: the one whose works are in this library, else the one whose work reads closest to it, is most likely you.
  let chosen = authors[0].openalexId;
  if (authors.length > 1) chosen = await likeliest(net, q.library, authors.map((a) => a.openalexId), inLibrary) ?? chosen;
  authors.sort((a, b) => (a.openalexId === chosen ? -1 : b.openalexId === chosen ? 1 : 0));
  let works;
  try { works = await openAlexWorks(net, `authorships.author.id:${chosen}`, MY_WORKS); } catch (e) { return { ...empty(`Couldn't read your works from OpenAlex (${message(e)}).`), authors }; }
  const papers = works.filter((w) => w.title && !isNonPaper(/** @type {any} */ ({ ...w, kind: w.kind }))).map((w) => {
    const key = (w.doi && byDoi.get(doiKey(w.doi))) || (normTitle(w.title) && byTitle.get(normTitle(w.title))) || null;
    return { title: w.title, year: w.year ?? null, doi: w.doi ?? null, key, abstract: String(w.abstract ?? '').slice(0, 4000), openalexId: w.openalexId ?? null, inLibrary: Boolean(key) };
  });
  return { authors, chosen, papers, problem: papers.length ? null : 'OpenAlex lists no papers for you yet.' };
}

/**
 * Of several namesakes, the one most likely to be the person using this library: most works in the library, then the
 * highest mean similarity of their recent abstracts to the library (the radar's own comparison). Null when unsure.
 * @param {typeof fetch} net @param {import("./tools").LibraryBackend} library @param {string[]} ids
 * @param {(work: any) => boolean} inLibrary
 */
async function likeliest(net, library, ids, inLibrary) {
  const scored = [];
  for (const id of ids.slice(0, CANDIDATES)) {
    const works = await openAlexWorks(net, `authorships.author.id:${id}`, 20).catch(() => []);
    scored.push({ id, owned: works.filter(inLibrary).length, texts: works.filter((w) => w.abstract).slice(0, 10).map((w) => `${w.title}. ${w.abstract}`.slice(0, 2000)) });
  }
  const most = Math.max(...scored.map((c) => c.owned));
  if (most > 0) return scored.find((c) => c.owned === most)?.id ?? null;
  if (!library.radarScore) return null;
  let best = null, bestSim = -1;
  for (const c of scored.filter((x) => x.texts.length)) {
    const sims = await library.radarScore({ scope: { collections: null }, positives: [], negatives: [], items: c.texts.map((text, i) => ({ id: String(i), text })) }).catch(() => null);
    if (!sims) continue;
    const values = Object.values(sims).map((v) => v.similarity);
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
    if (mean > bestSim) { bestSim = mean; best = c.id; }
  }
  return best;
}

/**
 * The arXiv categories the seeds were posted in, most first (G2): each seed title looked up on arXiv, at most
 * CATEGORY_LOOKUPS requests, 3 s apart.
 * @param {typeof fetch} fetchFn @param {string[]} titles
 */
export async function seedCategories(fetchFn, titles) {
  const net = politeFetch(fetchFn, CATEGORY_LOOKUPS).fetch;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const title of titles.slice(0, CATEGORY_LOOKUPS)) {
    const category = await arxivCategoryOf(net, title).catch(() => null);
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_CATEGORIES).map(([c]) => c);
}

/**
 * Calibrates a seed radar (G4): the server compares the seeds with each other and with recent papers from fields far
 * from them (arXiv's daily listings), and sets the thresholds where the two separate.
 * @param {{ fetch: typeof fetch, library: import("./tools").LibraryBackend, seeds: RadarSeeds }} q
 * @returns {Promise<{ threshold: import("./radar-types").RadarThreshold | null, problem: string | null }>}
 */
export async function calibrateRadar(q) {
  if (!q.library.radarCalibrate) return { threshold: null, problem: 'The library server is too old to calibrate the radar.' };
  const own = new Set(q.seeds.categories.map((c) => c.split('.')[0]));
  const contrast = CONTRAST.filter((c) => !own.has(c.split('.')[0])).slice(0, 4);
  /** @type {{ title: string, abstract: string, arxiv: string | null }[]} */
  const unrelated = [];
  for (const category of contrast) {
    const got = await fetchFeed(q.fetch, arxivCategoryFeed(category), null).catch(() => ({ items: [], error: 'unreachable' }));
    unrelated.push(...got.items.filter((i) => i.summary).slice(0, PER_CONTRAST).map((i) => ({ title: i.title, abstract: i.summary, arxiv: i.arxiv ?? null })));
  }
  if (unrelated.length < 10) return { threshold: null, problem: "Couldn't fetch enough unrelated papers from arXiv to calibrate; the radar uses 0.70 until the next try." };
  // Today's papers in the seeds' own categories: most are not for this person, so they set each seed's baseline
  // and the cut that keeps only the closest tenth of the field.
  /** @type {{ title: string, abstract: string, arxiv: string | null }[]} */
  const field = [];
  for (const category of q.seeds.categories.slice(0, 2)) {
    const got = await fetchFeed(q.fetch, arxivCategoryFeed(category), null).catch(() => ({ items: [], error: 'unreachable' }));
    field.push(...got.items.filter((i) => i.summary).slice(0, PER_FIELD).map((i) => ({ title: i.title, abstract: i.summary, arxiv: i.arxiv ?? null })));
  }
  try {
    const r = await q.library.radarCalibrate({ seeds: seedBody(q.seeds), unrelated, field, full_papers: FULL_UNRELATED });
    return {
      threshold: { abstract: r.abstract.threshold, full: r.full?.threshold ?? null, calibration: { abstract: r.abstract, full: r.full, seeds: r.seeds, at: new Date(r.at * 1000).toISOString(), baseline: r.baseline ?? null, ...(r.field ? { field: r.field } : {}) } },
      problem: r.abstract.overlap ? 'Your seed papers are about as close to unrelated papers as to each other; the threshold is set just above the unrelated ones. More seeds help.' : null,
    };
  } catch (e) { return { threshold: null, problem: `Calibration failed (${message(e)}).` }; }
}
