// Seed radar (server spec 021): seeds in the config, closest-seed scoring, the whole-paper pass, arXiv's daily
// listings and spacing, the user's own papers, calibration, per-source seen/kept counts. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadar, seedBody, MIN_SEEDS } from '../src/radar.js';
import { collectRadar, SEED_WINDOW_DAYS } from '../src/radar-run.js';
import { politeFetch } from '../src/radar-sources.js';
import { arxivQuery, arxivCategoryFeed } from '../src/scholarly.js';
import { myPapers, calibrateRadar } from '../src/radar-seeds.js';
import { seedLine } from '../src/radar-why.js';
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
  assert.equal(out.picked[0].why?.similarity, 0.96, 'the plain similarity is shown and ranks; the margin decided');
  assert.equal(out.picked[1].why?.seed?.whole, false, 'a PDF that could not be read is judged on its abstract');
  assert.deepEqual(lib.calls.fulltext[0].items.map((i) => i.arxiv).sort(), ['2610.00001', '2610.00002', '2610.00003'], 'only candidates past the abstract cut are read whole');
  const status = out.state.sourceStatus['database:arxiv'];
  assert.deepEqual(status.history?.map((h) => [h.items, h.kept]), [[4, 2]], 'the arXiv source says how many it gave and how many were kept');
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
  const out = await calibrateRadar({ fetch, library: /** @type {any} */ (library), seeds: /** @type {any} */ (seeds()) });
  assert.equal(out.problem, null);
  assert.equal(out.threshold?.abstract, 0.77);
  assert.equal(out.threshold?.full, 0.81);
  assert.equal(asked[0].unrelated.length, 40, '10 papers from each of 4 contrast fields');
  assert.ok(asked[0].unrelated.every((u) => u.arxiv), 'each with its arXiv id, for the whole-paper side');
  assert.equal(asked[0].field.length, 10, "today's papers from the seeds' own category set the baselines");
  assert.deepEqual(out.threshold?.calibration?.baseline, baseline, 'the baselines are kept with the threshold');
});

test('the why line names the closest seed', () => {
  assert.equal(seedLine('Band gaps of frameworks', 0.8412, true), 'Close to “Band gaps of frameworks” (0.84, whole paper).');
  assert.equal(seedLine('x'.repeat(120), 0.8, false).length < 110, true);
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

test('the why line is the AI summary; the seed is named only when the model wrote nothing', async () => {
  const { whyLines } = await import('../src/radar-why.js');
  const item = (id, title) => /** @type {any} */ ({ id, title, abstract: 'a', authors: [], venue: '', why: { similarity: 0.84, seed: { label: 'zotero/K1', title: 'Band gaps of frameworks', whole: true } } });
  const out = await whyLines([item('a', 'One'), item('b', 'Two')], { topics: [], turn: async () => ({ lines: [{ n: 1, line: 'It measures band gaps in two new frameworks.' }] }) });
  assert.equal(out.lines.get('a'), 'It measures band gaps in two new frameworks.', 'no "Close to" in front of the summary');
  assert.match(out.lines.get('b') ?? '', /^Close to/, 'a row without a summary still says why it is there');
});
