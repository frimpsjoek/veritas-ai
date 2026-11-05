// Seed radar (server spec 021): seeds in the config, closest-seed scoring, the whole-paper pass, arXiv's daily
// listings and spacing, the user's own papers, calibration, per-source seen/kept counts. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadar, seedBody, seedsKey, MIN_SEEDS } from '../src/radar.js';
import { collectRadar, SEED_WINDOW_DAYS, WHOLE_PAPERS, WHOLE_SEED_SHARE } from '../src/radar-run.js';
import { politeFetch } from '../src/radar-sources.js';
import { arxivQuery, arxivCategoryFeed } from '../src/scholarly.js';
import { myPapers, calibrateRadar, CALIBRATION_VERSION } from '../src/radar-seeds.js';
import { emptyState } from '../src/radar-state.js';
import { feedXml, res, routedFetch, radarLibrary, profile } from './support/radar-fakes.mjs';

const mine = (title, over = {}) => ({ title, year: 2025, doi: null, key: null, abstract: `${title} abstract`, openalexId: null, ...over });
const seeds = (over = {}) => ({ mine: [mine('Band gaps of frameworks', { key: 'K1' }), mine('Excitons in dots')], papers: ['K2'], collections: [], author: null, categories: ['cond-mat.mtrl-sci'], ...over });

test('a radar keeps its seeds and threshold; too few seeds is a plain error', () => {
  const base = { scope: { kind: 'library' }, profile: profile(), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 } };
  const r = validateRadar({ ...base, seeds: seeds(), threshold: { abstract: 0.78, full: 0.82 } });
  assert.deepEqual(r.seeds?.papers, ['K2']);
  assert.deepEqual(r.threshold, { abstract: 0.78, full: 0.82 });
  assert.throws(() => validateRadar({ ...base, seeds: seeds({ mine: [mine('Only one', { key: 'K1' })], papers: [] }) }), new RegExp(`at least ${MIN_SEEDS} papers`));
  assert.doesNotThrow(() => validateRadar({ ...base, seeds: seeds({ mine: [], papers: [], collections: ['C1'] }) }), 'a collection is enough');
  assert.throws(() => validateRadar({ ...base, seeds: seeds(), threshold: { abstract: 1.4 } }), /between 0 and 1/);
  assert.equal(validateRadar(base).seeds, undefined, 'a radar without seeds stays as it was');
  assert.deepEqual(seedBody(r.seeds), { keys: ['K1', 'K2'], collections: [], texts: [{ title: 'Excitons in dots', text: 'Excitons in dots abstract' }] });
});

test('requests to the arXiv API are at least 3 s apart; other hosts are not held', async () => {
  let clock = 0;
  const slept = [];
  const net = politeFetch(async () => res(200), 10, { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  await net.fetch('https://export.arxiv.org/api/query?a');
  clock += 1000;
  await net.fetch('https://export.arxiv.org/api/query?b');
  await net.fetch('https://api.openalex.org/works');
  assert.deepEqual(slept, [2000]);
});

test('arXiv busy (429/503) is waited out twice, then reported in words', async () => {
  const waits = [];
  let n = 0;
  const ok = '<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>T</title><summary>s</summary><published>2026-10-02T00:00:00Z</published><arxiv:primary_category term="cond-mat.mtrl-sci"/></entry></feed>';
  const rows = await arxivQuery(async () => (++n < 3 ? res(429) : res(200, ok)), 'cat:x', 5, 'submittedDate', async (ms) => { waits.push(ms); });
  assert.equal(rows[0].category, 'cond-mat.mtrl-sci');
  assert.deepEqual(waits, [10_000, 30_000]);
  await assert.rejects(arxivQuery(async () => res(429), 'cat:x', 5, 'submittedDate', async () => {}), /slow down/);
});

const NOW = '2026-10-20T07:00:00Z';
const RECENT = 'Mon, 19 Oct 2026 09:00:00 GMT';  // inside the 7-day window before NOW
const arxivFeed = (items) => feedXml(items.map((i) => ({ date: RECENT, ...i, link: `https://arxiv.org/abs/${i.id}` })));

function seedLibrary({ abstractSim, wholeSim }) {
  const lib = radarLibrary();
  lib.calls.fulltext = [];
  lib.items = async () => [{ key: 'K1', doi: null, title: 'Band gaps of <i>frameworks</i>', year: 2025, citekey: null }];
  // the plain similarity is the margin + 0.1 here, so the tests see which one decides and which one is shown
  lib.radarScore = async (q) => Object.fromEntries(q.items.map((i) => [i.id, { similarity: 0.5, negative: 0, seed_max: abstractSim(i.text), seed_best: 'zotero/K1', seed_raw: abstractSim(i.text) + 0.1 }]));
  lib.radarFulltext = async (q) => { lib.calls.fulltext.push(q); return Object.fromEntries(q.items.map((i) => [i.id, wholeSim(i.arxiv) == null ? { error: 'HTTP 404' } : { seed_max: wholeSim(i.arxiv), seed_best: 'zotero/K1', seed_raw: wholeSim(i.arxiv) + 0.1 }])); };
  return lib;
}

test('a seed run reads its categories from arXiv RSS, reads candidates whole, and decides on the whole paper', async () => {
  const feed = arxivFeed([
    { id: '2610.00001', title: 'Close in abstract and whole', summary: 'band gap frameworks' },
    { id: '2610.00002', title: 'Close in abstract, far whole', summary: 'band gap something' },
    { id: '2610.00003', title: 'Unreadable PDF, close abstract', summary: 'band gap pdf' },
    { id: '2610.00004', title: 'Far in abstract', summary: 'galaxies' },
  ]);
  const fetch = routedFetch({ [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, feed) });
  const abstract = { 'Close in abstract and whole': 0.8, 'Close in abstract, far whole': 0.79, 'Unreadable PDF, close abstract': 0.81, 'Far in abstract': 0.4 };
  const lib = seedLibrary({ abstractSim: (text) => abstract[text.split('. ')[0]] ?? 0, wholeSim: (id) => ({ '2610.00001': 0.86, '2610.00002': 0.6, '2610.00003': null }[id]) });
  const baseline = { labels: ['zotero/K1'], abstract: [0.5], full: [0.6] };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 }, seeds: seeds(), threshold: { abstract: 0.78, full: 0.82, calibration: { baseline } } });
  const scored = [];
  const score = lib.radarScore;
  lib.radarScore = async (q) => { scored.push(q); return score(q); };
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
  assert.deepEqual(scored[0].baseline, baseline, 'the abstract pass sends the per-seed baselines');
  assert.deepEqual(lib.calls.fulltext[0].baseline, baseline, 'so does the whole-paper pass');
  const titles = out.picked.map((p) => p.title);
  assert.deepEqual(titles, ['Close in abstract and whole', 'Unreadable PDF, close abstract']);
  assert.deepEqual(out.picked[0].why?.seed, { label: 'zotero/K1', title: 'Band gaps of frameworks', whole: true, margin: 0.86 });
  assert.equal(out.picked[0].why?.similarity, 0.96, 'the plain similarity is shown; the margin decided');
  assert.equal(out.picked[1].why?.seed?.whole, false, 'a PDF that could not be read is judged on its abstract');
  assert.deepEqual(lib.calls.fulltext[0].items.map((i) => i.arxiv).sort(), ['2610.00001', '2610.00002', '2610.00003'], 'only candidates past the abstract cut are read whole');
  const status = out.state.sourceStatus['database:arxiv'];
  assert.deepEqual(status.history?.map((h) => [h.items, h.kept]), [[4, 2]], 'the arXiv source says how many it gave and how many were kept');
});

test('a calibrated radar ranks on how far past its bar a paper is, not on plain similarity or on being read whole', async () => {
  const feedUrl = 'https://journal.example/rss';
  const feed = feedXml([
    { title: 'Close to the whole field', link: 'https://journal.example/1', summary: 'broad', date: RECENT },
    { title: 'Close to one seed', link: 'https://journal.example/2', summary: 'narrow', date: RECENT },
  ]);
  const fetch = routedFetch({ [feedUrl]: res(200, feed), [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, arxivFeed([{ id: '2610.00001', title: 'Read whole, barely past', summary: 'whole' }])) });
  const near = { 'Close to the whole field': [0.12, 0.85], 'Close to one seed': [0.2, 0.7], 'Read whole, barely past': [0.11, 0.7] };
  const lib = seedLibrary({ abstractSim: () => 0, wholeSim: () => null });
  lib.radarScore = async (q) => Object.fromEntries(q.items.map((i) => { const [seed_max, seed_raw] = near[i.text.split('. ')[0]]; return [i.id, { similarity: 0.5, negative: 0, seed_max, seed_best: 'zotero/K1', seed_raw }]; }));
  lib.radarFulltext = async (q) => Object.fromEntries(q.items.map((i) => [i.id, { seed_max: 0.04, seed_best: 'zotero/K1', seed_raw: 0.9 }]));
  const threshold = { abstract: 0.1, full: 0.03, calibration: { baseline: { labels: ['zotero/K1'], abstract: [0.6], full: [0.8] } } };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), size: { fresh: 15, older: 0 }, seeds: seeds(), threshold,
    sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }, { id: 'feed:j', on: true, kind: 'feed', url: feedUrl, title: 'Journal' }] });
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
  assert.deepEqual(out.picked.map((p) => p.title), ['Close to one seed', 'Close to the whole field', 'Read whole, barely past']);
  assert.deepEqual(out.picked.map((p) => p.score), [0.13, 0.05, 0.01], 'a paper with no arXiv copy ranks from the lower bar it has to clear');
  assert.equal(out.picked[2].why?.similarity, 0.9, 'the plain similarity stays on the row');
});

test('a radar with no baselines still ranks on plain similarity', async () => {
  const fetch = routedFetch({ [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, arxivFeed([{ id: '2610.00001', title: 'Plain', summary: 'band gap' }])) });
  const lib = seedLibrary({ abstractSim: () => 0.8, wholeSim: () => null });
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 }, seeds: seeds(), threshold: { abstract: 0.78, full: 0.82 } });
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
  assert.equal(out.picked[0].score, 0.9);
});

test('a seed run looks back at most a week, and a feed adds only what passes the threshold', async () => {
  const feedUrl = 'https://journal.example/rss';
  const feed = feedXml([{ title: 'Relevant feed paper', link: 'https://journal.example/1', summary: 'band gap', date: RECENT }, { title: 'Irrelevant feed paper', link: 'https://journal.example/2', summary: 'cooking', date: RECENT }, { title: 'Old feed paper', link: 'https://journal.example/3', summary: 'band gap', date: 'Mon, 05 Oct 2026 09:00:00 GMT' }]);
  const fetch = routedFetch({ [feedUrl]: res(200, feed), [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, arxivFeed([])) });
  const lib = seedLibrary({ abstractSim: (text) => (text.includes('Relevant') ? 0.85 : 0.5), wholeSim: () => null });
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), size: { fresh: 15, older: 0 }, seeds: seeds(), threshold: { abstract: 0.78, full: 0.82 },
    sources: [{ id: 'feed:j', on: true, kind: 'feed', url: feedUrl, title: 'Journal' }] });
  const before = { ...emptyState(), sourceStatus: { 'feed:j': { at: '2026-10-01T00:00:00Z', items: 9, error: null, quietRuns: 0, history: [{ at: '2026-10-01T00:00:00Z', items: 9, kept: 1 }, { at: '2026-10-18T00:00:00Z', items: 5, kept: 0 }] } } };
  const out = await collectRadar({ config, since: '2026-01-01', now: NOW, fetch, library: lib, state: before });
  assert.deepEqual(out.picked.map((p) => p.title), ['Relevant feed paper'], 'the irrelevant one is below the threshold, the old one outside the week');
  assert.deepEqual(out.state.sourceStatus['feed:j'].history?.map((h) => [h.items, h.kept]), [[5, 0], [2, 1]], 'history keeps the last week only');
  assert.equal(SEED_WINDOW_DAYS, 7);
});

test('your own papers: ORCID lookup, works newest first, each matched to the library by DOI or title', async () => {
  const author = { id: 'https://openalex.org/A1', display_name: 'Ada Example', works_count: 3, last_known_institutions: [{ display_name: 'Lab U' }] };
  const work = (n, over = {}) => ({ id: `https://openalex.org/W${n}`, doi: `https://doi.org/10.1/w${n}`, display_name: `Paper ${n}`, publication_year: 2025, type: 'article', abstract_inverted_index: { Abstract: [0], text: [1] }, ...over });
  const fetch = async (url) => {
    const u = String(url);
    if (u.includes('/authors?filter=orcid:0000-0002-1825-0097')) return res(200, JSON.stringify({ results: [author] }));
    if (u.includes('/works?filter=authorships.author.id:A1')) return res(200, JSON.stringify({ results: [work(1), work(2, { doi: null, display_name: 'Titled Match' }), work(3, { type: 'dataset' })] }));
    return res(404);
  };
  const library = { items: async () => [{ key: 'K1', doi: '10.1/W1', title: 'x', year: 2025, citekey: null }, { key: 'K2', doi: null, title: 'Titled match', year: 2025, citekey: null }] };
  const out = await myPapers({ fetch, library: /** @type {any} */ (library), name: 'ignored', orcid: 'https://orcid.org/0000-0002-1825-0097' });
  assert.equal(out.problem, null);
  assert.deepEqual(out.authors, [{ openalexId: 'A1', label: 'Ada Example, Lab U, 3 works' }]);
  assert.deepEqual(out.papers.map((p) => [p.title, p.key, p.inLibrary]), [['Paper 1', 'K1', true], ['Titled Match', 'K2', true]], 'a dataset is not a paper');
  assert.equal(out.papers[0].abstract, 'Abstract text');
  assert.match((await myPapers({ fetch, library: /** @type {any} */ (library), name: '' })).problem ?? '', /name or your ORCID/);
});

test('calibration fetches unrelated fields from arXiv RSS and keeps the server thresholds', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `2610.1000${i}`, title: `Unrelated ${i}`, summary: 'stars and galaxies' }));
  const fetch = async (url) => (String(url).startsWith('https://rss.arxiv.org/rss/') ? res(200, arxivFeed(items)) : res(404));
  const asked = [];
  const baseline = { labels: ['zotero/K1'], abstract: [0.6], full: [0.7] };
  const library = { async radarCalibrate(q) { asked.push(q); return { abstract: { threshold: 0.77, overlap: false, related: {}, unrelated: {}, n_related: 3, n_unrelated: 40 }, full: { threshold: 0.81, overlap: false, related: {}, unrelated: {}, n_related: 3, n_unrelated: 8 }, seeds: 3, at: 1792500000, baseline, field: { abstracts: 10, whole: 8 } }; } };
  const out = await calibrateRadar({ fetch, library: /** @type {any} */ (library), seeds: /** @type {any} */ (seeds()), sleep: async () => {} });
  assert.equal(out.problem, null);
  assert.equal(out.threshold?.abstract, 0.77);
  assert.equal(out.threshold?.full, 0.81);
  assert.equal(asked[0].unrelated.length, 40, '10 papers from each of 4 contrast fields');
  assert.ok(asked[0].unrelated.every((u) => u.arxiv), 'each with its arXiv id, for the whole-paper side');
  assert.equal(asked[0].field.length, 10, "today's papers from the seeds' own category set the baselines");
  assert.deepEqual(out.threshold?.calibration?.baseline, baseline, 'the baselines are kept with the threshold');
});

test('a seed radar that was never calibrated calibrates on its run, uses the baselines at once, and hands the threshold back', async () => {
  const unrelated = Array.from({ length: 10 }, (_, i) => ({ id: `2610.2000${i}`, title: `Unrelated ${i}`, summary: 'stars and galaxies' }));
  const fetch = async (url) => (String(url).startsWith('https://rss.arxiv.org/rss/') ? res(200, arxivFeed(unrelated)) : res(404));
  const baseline = { labels: ['zotero/K1'], abstract: [0.3], full: [0.4] };
  const lib = seedLibrary({ abstractSim: () => 0.5, wholeSim: () => null });
  const asked = [], scored = [];
  lib.radarCalibrate = async (q) => { asked.push(q); return { abstract: { threshold: 0.2, overlap: false }, full: null, seeds: 3, at: 1792500000, baseline }; };
  const score = lib.radarScore;
  lib.radarScore = async (q) => { scored.push(q); return score(q); };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 }, seeds: seeds() });
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState(), sleep: async () => {} });
  assert.equal(asked.length, 1);
  assert.deepEqual(scored.at(-1).baseline, baseline, 'the run that calibrated scores with the new baselines');
  assert.equal(out.threshold?.abstract, 0.2);
  assert.equal(out.threshold?.calibration?.seedsKey, seedsKey(config.seeds), 'the calibration knows which seeds it was made for');
  assert.equal(out.picked.length, 10, 'and keeps what passes the calibrated cut instead of the 0.70 default');
  assert.equal(out.state.calibrateTried, NOW);

  const later = await collectRadar({ config: { ...config, threshold: out.threshold }, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
  assert.equal(asked.length, 1, 'a calibrated radar is not calibrated again');
  assert.equal(later.threshold, null);
  const changed = { ...config, seeds: { ...config.seeds, papers: ['K2', 'K3'] }, threshold: out.threshold };
  await collectRadar({ config: changed, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState(), sleep: async () => {} });
  assert.equal(asked.length, 2, 'seeds changed since the calibration: calibrate again');
});

test('a run that could not calibrate tries again the next day, and a radar with too few seeds never asks', async () => {
  const lib = seedLibrary({ abstractSim: () => 0.75, wholeSim: () => null });
  let asked = 0;
  lib.radarCalibrate = async () => { asked += 1; throw new Error('calibration needs at least 3 seed papers'); };
  const fetch = async (url) => (String(url) === arxivCategoryFeed('cond-mat.mtrl-sci') ? res(200, arxivFeed([])) : res(404));
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 }, seeds: seeds() });
  const tried = { ...emptyState(), calibrateTried: '2026-10-20T01:00:00Z' };
  await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: tried, sleep: async () => {} });
  assert.equal(asked, 0, 'tried six hours ago');
  await collectRadar({ config, since: '2026-09-01', now: '2026-10-21T07:00:00Z', fetch, library: lib, state: tried, sleep: async () => {} });
  assert.equal(asked, 0, 'too few unrelated papers to fetch: calibrateRadar gives up before the server');
  const few = { ...config, seeds: { ...config.seeds, mine: [], papers: ['K1', 'K2'] } };
  const rss = async (url) => (String(url).startsWith('https://rss.arxiv.org/rss/') ? res(200, arxivFeed(Array.from({ length: 10 }, (_, i) => ({ id: `2610.3000${i}`, title: `U ${i}`, summary: 's' })))) : res(404));
  await collectRadar({ config: few, since: '2026-09-01', now: NOW, fetch: rss, library: lib, state: emptyState(), sleep: async () => {} });
  assert.equal(asked, 0, 'two seeds and no collection: the server would refuse');
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch: rss, library: lib, state: emptyState(), sleep: async () => {} });
  assert.equal(asked, 1);
  assert.equal(out.threshold, null, 'a failed calibration leaves the radar as it was');
  assert.equal(out.state.calibrateTried, NOW);
});

test('calibration reads the arXiv API when the daily RSS listings are empty (weekends, and between announcements)', async () => {
  const empty = feedXml([]);
  const entry = (c, i) => `<entry><id>http://arxiv.org/abs/2610.4${String(i).padStart(4, '0')}v1</id><title>Paper ${i} in ${c}</title><summary>Invented summary ${i}.</summary><published>2026-10-27T00:00:00Z</published></entry>`;
  const asked = [], urls = [];
  const fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith('https://rss.arxiv.org/rss/')) return res(200, empty);
    const c = /search_query=cat:([^&]+)/.exec(u)?.[1];
    return c ? res(200, `<feed>${Array.from({ length: 12 }, (_, i) => entry(c, i)).join('')}</feed>`) : res(404);
  };
  const library = { async radarCalibrate(q) { asked.push(q); return { abstract: { threshold: 0.6, overlap: false }, full: null, seeds: 3, at: 1792500000, baseline: null }; } };
  const out = await calibrateRadar({ fetch, library: /** @type {any} */ (library), seeds: /** @type {any} */ (seeds()), sleep: async () => {} });
  assert.equal(out.problem, null);
  assert.equal(asked[0].unrelated.length, 40);
  assert.ok(asked[0].unrelated.every((u) => u.arxiv && u.abstract));
  assert.equal(asked[0].field.length, 12, "the seeds' own category too");
  assert.ok(urls.some((u) => u.includes('search_query=cat:cond-mat.mtrl-sci')));
});

test('calibration reads all the seed categories and the ones the seeds are cross-listed in', async () => {
  const listing = (c) => arxivFeed(Array.from({ length: 10 }, (_, i) => ({ id: `2610.${String(c.length).padStart(2, '0')}0${i}`, title: `${c} paper ${i}`, summary: `about ${c}` })));
  const fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://rss.arxiv.org/rss/')) return res(200, listing(u.split('/').at(-1)));
    if (u.includes('search_query=all:')) {
      const title = u.includes('all:agents') ? 'Invented lab agents paper' : u.includes('all:excitons') ? 'Excitons in dots' : null;
      const terms = title?.includes('agents') ? ['cond-mat.mtrl-sci', 'cs.AI'] : ['physics.chem-ph'];
      return res(200, title ? `<feed><entry><id>http://arxiv.org/abs/2610.5v1</id><title>${title}</title><summary>s</summary><published>2026-10-02T00:00:00Z</published><arxiv:primary_category term="${terms[0]}"/>${terms.map((t) => `<category term="${t}"/>`).join('')}</entry></feed>` : '<feed></feed>');
    }
    return res(404);
  };
  const asked = [];
  const library = {
    items: async () => [{ key: 'K2', title: 'Invented lab <i>agents</i> paper' }],
    async radarCalibrate(q) { asked.push(q); return { abstract: { threshold: 0.6, overlap: false }, full: null, seeds: 3, at: 1792500000, baseline: null }; },
  };
  const out = await calibrateRadar({ fetch, library: /** @type {any} */ (library), seeds: /** @type {any} */ (seeds({ categories: ['cond-mat.mtrl-sci', 'physics.chem-ph', 'physics.comp-ph'] })), sleep: async () => {} });
  const count = (c) => asked[0].field.filter((p) => p.category === c).length;
  assert.deepEqual(['cond-mat.mtrl-sci', 'physics.chem-ph', 'physics.comp-ph', 'cs.AI'].map(count), [10, 10, 10, 10], 'every seed category, not the first two, and where a seed is cross-listed');
  assert.equal(asked[0].field.length, 40, 'each once');
  assert.equal(out.threshold?.calibration?.version, CALIBRATION_VERSION);
});

test('a radar calibrated by older logic calibrates again once; a failed try leaves its threshold standing', async () => {
  const unrelated = Array.from({ length: 10 }, (_, i) => ({ id: `2610.2100${i}`, title: `Unrelated ${i}`, summary: 'stars and galaxies' }));
  const fetch = async (url) => (String(url).startsWith('https://rss.arxiv.org/rss/') ? res(200, arxivFeed(unrelated)) : res(404));
  const lib = seedLibrary({ abstractSim: () => 0.5, wholeSim: () => null });
  let asked = 0, fail = true;
  lib.radarCalibrate = async () => { asked += 1; if (fail) throw new Error('busy'); return { abstract: { threshold: 0.2, overlap: false }, full: null, seeds: 3, at: 1792500000, baseline: null }; };
  const base = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 15, older: 0 }, seeds: seeds() });
  const old = { abstract: 0.3, full: null, calibration: { seedsKey: seedsKey(base.seeds), abstract: {}, full: null, seeds: 3, at: NOW } };
  const run = (threshold, state = emptyState()) => collectRadar({ config: { ...base, threshold }, since: '2026-09-01', now: NOW, fetch, library: lib, state, sleep: async () => {} });
  const failed = await run(old);
  assert.equal(asked, 1, 'made before the version: calibrate again');
  assert.equal(failed.threshold, null, 'the old threshold stands');
  await run(old, failed.state);
  assert.equal(asked, 1, 'and waits a day after a failed try');
  fail = false;
  const done = await run(old);
  assert.equal(done.threshold?.calibration?.version, CALIBRATION_VERSION);
  await run(done.threshold);
  assert.equal(asked, 2, 'the current version is not calibrated again');
});

const wholeRun = (feedItems, lib, over = {}) => {
  const fetch = routedFetch({ [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, arxivFeed(feedItems)) });
  const threshold = { abstract: 0.1, full: 0.05, calibration: { baseline: { labels: ['zotero/K1'], abstract: [0.5], full: [0.6] }, version: CALIBRATION_VERSION, seedsKey: seedsKey(seeds()) } };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh: 50, older: 0, discover: 0 }, seeds: seeds(), threshold, ...over });
  return collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
};

test('every arXiv paper past the lower bar is read whole, in batches the server takes, up to the total cap', async () => {
  const items = Array.from({ length: WHOLE_PAPERS + 10 }, (_, i) => ({ id: `2610.${String(10000 + i)}`, title: `Invented paper number ${i}`, summary: 'band gap' }));
  const lib = seedLibrary({ abstractSim: () => 0.09, wholeSim: () => 0.06 });
  // a different closest seed per ten papers, so no seed's share is the limit here
  lib.radarScore = async (q) => Object.fromEntries(q.items.map((it, i) => [it.id, { similarity: 0.5, negative: 0, seed_max: 0.09, seed_best: `zotero/K${i % 10}`, seed_raw: 0.6 }]));
  await wholeRun(items, lib);
  const read = lib.calls.fulltext.flatMap((q) => q.items);
  assert.equal(read.length, WHOLE_PAPERS, 'not the first 40');
  assert.ok(lib.calls.fulltext.every((q) => q.items.length <= 40), 'the server takes 40 a call');
});

test('one seed cannot fill the papers read whole', async () => {
  const items = Array.from({ length: WHOLE_SEED_SHARE + 12 }, (_, i) => ({ id: `2610.${String(20000 + i)}`, title: `Invented paper number ${i}`, summary: i >= WHOLE_SEED_SHARE + 10 ? 'other' : 'hub' }));
  const lib = seedLibrary({ abstractSim: (text) => (text.includes('other') ? 0.075 : 0.2), wholeSim: () => 0.06 });
  const score = lib.radarScore;
  lib.radarScore = async (q) => Object.fromEntries(Object.entries(await score(q)).map(([id, s]) => [id, { ...s, seed_best: q.items.find((i) => i.id === id).text.includes('other') ? 'zotero/NICHE' : 'zotero/HUB' }]));
  await wholeRun(items, lib);
  const read = lib.calls.fulltext.flatMap((q) => q.items.map((i) => i.arxiv));
  assert.equal(read.length, WHOLE_SEED_SHARE + 2, "the hub's share, and both of the niche seed's papers, though they rank below all of the hub's");
  assert.ok(read.includes(`2610.${20000 + WHOLE_SEED_SHARE + 10}`));
});

test('a journal paper cannot be read whole, so it is judged at the bar that gets an arXiv paper read, and ranks from there', async () => {
  const journal = { id: 'journal:S1', on: true, kind: 'journal', openalexId: 'S1', name: 'J Invented', issn: null };
  const works = { results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.9/j1', display_name: 'Journal paper near the bar', type: 'article', publication_date: '2026-10-19', publication_year: 2026, primary_location: { landing_page_url: 'https://doi.org/10.9/j1', source: { display_name: 'J Invented' } }, abstract_inverted_index: { band: [0], gap: [1] }, authorships: [] }] };
  const listing = arxivFeed([{ id: '2610.30001', title: 'Unreadable preprint near the bar', summary: 'band gap' }, { id: '2610.30002', title: 'Preprint at the whole bar', summary: 'band gap' }]);
  const fetch = async (url) => (String(url) === arxivCategoryFeed('cond-mat.mtrl-sci') ? res(200, listing) : String(url).startsWith('https://api.openalex.org/works') ? res(200, JSON.stringify(works)) : res(404));
  const lib = seedLibrary({ abstractSim: () => 0.08, wholeSim: (id) => (id === '2610.30002' ? 0.05 : null) });
  const threshold = { abstract: 0.1, full: 0.05, calibration: { baseline: { labels: ['zotero/K1'], abstract: [0.5], full: [0.6] }, version: CALIBRATION_VERSION, seedsKey: seedsKey(seeds()) } };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }, journal], size: { fresh: 50, older: 0, discover: 0 }, seeds: seeds(), threshold });
  const out = await collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState() });
  const by = Object.fromEntries(out.picked.map((r) => [r.title, r]));
  assert.ok(by['Journal paper near the bar'], '0.08 clears 0.1 - the margin');
  assert.ok(!by['Unreadable preprint near the bar'], 'a preprint that could not be read still needs the abstract bar');
  assert.equal(by['Journal paper near the bar'].score, 0.02, '0.01 past the bar a journal paper has to clear, and 0.01 for a watched journal');
  assert.equal(by['Preprint at the whole bar'].score, 0);
});

test('the lower bar never goes below where unrelated papers end', async () => {
  const items = [{ id: '2610.41001', title: 'Under unrelated papers', summary: 'x' }, { id: '2610.41002', title: 'Over unrelated papers', summary: 'y' }];
  const lib = seedLibrary({ abstractSim: (text) => (text.startsWith('Under') ? 0.03 : 0.05), wholeSim: () => 0.1 });
  const threshold = { abstract: 0.06, full: 0.05, calibration: { abstract: { unrelated: { p95: 0.04 } }, baseline: { labels: ['zotero/K1'], abstract: [0.5], full: [0.6] }, version: CALIBRATION_VERSION, seedsKey: seedsKey(seeds()) } };
  await wholeRun(items, lib, { threshold });
  assert.deepEqual(lib.calls.fulltext.flatMap((q) => q.items.map((i) => i.arxiv)), ['2610.41002'], '0.03 is past 0.06 - the margin, but not past 0.04');
});

test('a calibrated run leaves out what one broad seed alone holds up, and keeps what a second seed or a topic agrees with', async () => {
  const items = [{ id: '2610.40001', title: 'Harness for invented agents', summary: 'software' }, { id: '2610.40002', title: 'Two seeds agree here', summary: 'both' }, { id: '2610.40003', title: 'Topic in the text', summary: 'sleep spindle' }];
  const lib = seedLibrary({ abstractSim: () => 0.2, wholeSim: () => 0.1 });
  lib.radarFulltext = async (q) => Object.fromEntries(q.items.map((i) => [i.id, { seed_max: 0.1, seed_best: 'zotero/K1', seed_raw: 0.7, seed_second: i.arxiv === '2610.40002' ? 0.09 : 0.02 }]));
  const out = await wholeRun(items, lib, { profile: profile({ topics: [{ text: 'sleep spindle', weight: 1, origin: 'user' }] }) });
  assert.deepEqual(out.picked.map((r) => r.title).sort(), ['Topic in the text', 'Two seeds agree here']);
});

test('namesakes: the one with works in the library wins; with none, the one whose work reads closest to it', async () => {
  const people = [{ id: 'https://openalex.org/A1', display_name: 'Sam Vole', works_count: 30 }, { id: 'https://openalex.org/A2', display_name: 'Sam Vole', works_count: 8 }];
  const works = { A1: [{ id: 'W1', doi: 'https://doi.org/10.1/econ', display_name: 'Exchange rates in markets', type: 'article', abstract_inverted_index: { markets: [0] } }],
    A2: [{ id: 'W2', doi: 'https://doi.org/10.1/burrow', display_name: 'Burrow heat', type: 'article', abstract_inverted_index: { burrows: [0] } }] };
  const fetch = async (url) => {
    const u = String(url);
    if (u.includes('/authors?search=')) return res(200, JSON.stringify({ results: people }));
    const who = /authorships\.author\.id:(A\d)/.exec(u)?.[1];
    return who ? res(200, JSON.stringify({ results: works[who] })) : res(404);
  };
  const owned = { items: async () => [{ key: 'K9', doi: '10.1/burrow', title: 'Burrow heat', year: 2024, citekey: null }] };
  const a = await myPapers({ fetch, library: /** @type {any} */ (owned), name: 'Sam Vole' });
  assert.equal(a.chosen, 'A2');
  assert.equal(a.authors[0].openalexId, 'A2', 'the likeliest is listed first');
  // a library item with no title must not make an untitled work count as owned
  works.A1.push({ id: 'W3', doi: null, display_name: '', type: 'article' });
  const close = { items: async () => [{ key: 'K0', doi: null, title: '', year: null, citekey: null }], radarScore: async (q) => Object.fromEntries(q.items.map((i) => [i.id, { similarity: i.text.includes('burrows') ? 0.8 : 0.3, negative: 0 }])) };
  assert.equal((await myPapers({ fetch, library: /** @type {any} */ (close), name: 'Sam Vole' })).chosen, 'A2');
});

test('the why line is the AI summary alone; the seed is never named', async () => {
  const { whyLines } = await import('../src/radar-why.js');
  const item = (id, title) => /** @type {any} */ ({ id, title, abstract: 'a', authors: [], venue: '', why: { similarity: 0.84, seed: { label: 'zotero/K1', title: 'Band gaps of frameworks', whole: true } } });
  const out = await whyLines([item('a', 'One'), item('b', 'Two')], { topics: [], turn: async () => ({ lines: [{ n: 1, line: 'It measures band gaps in two new frameworks.' }] }) });
  assert.equal(out.lines.get('a'), 'It measures band gaps in two new frameworks.', 'no "Close to" in front of the summary');
  assert.equal(out.lines.get('b'), undefined, 'a row without a summary gets no line, not "Close to"');
});
