// The radar's candidate log: what a run scored, the features behind each score and where each paper was cut, plus
// the user's later verdicts, appended beside the radar's state so a ranking change can be replayed. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadar, seedsKey } from '../src/radar.js';
import { collectRadar } from '../src/radar-run.js';
import { CALIBRATION_VERSION } from '../src/radar-seeds.js';
import { arxivCategoryFeed } from '../src/scholarly.js';
import { applyFeedback } from '../src/radar-feedback.js';
import { createRadarStore, emptyState, CANDIDATE_LOG } from '../src/radar-state.js';
import { feedXml, res, routedFetch, radarLibrary, profile } from './support/radar-fakes.mjs';
import { memoryFs } from './support/memory-fs.mjs';

const NOW = '2026-10-20T07:00:00.000Z';
const RECENT = 'Mon, 19 Oct 2026 09:00:00 GMT';
const seeds = () => ({ mine: [{ title: 'Band gaps of frameworks', year: 2025, doi: null, key: 'K1', abstract: 'a', openalexId: null }, { title: 'Excitons in dots', year: 2025, doi: null, key: null, abstract: 'Excitons in dots abstract', openalexId: null }], papers: ['K2'], collections: [], author: null, categories: ['cond-mat.mtrl-sci'] });

/** A calibrated seed run. Each paper: its abstract margin (`abs`), whole-paper margin (`whole`), next seed (`second`). */
async function seedRun(papers, { judge, fresh = 3 } = {}) {
  const items = papers.map((p, i) => ({ id: `2610.${60000 + i}`, title: p.title, summary: 'invented summary text' }));
  const byArxiv = Object.fromEntries(items.map((it, i) => [it.id, papers[i]]));
  const byTitle = Object.fromEntries(papers.map((p) => [p.title, p]));
  const lib = radarLibrary();
  lib.items = async () => [{ key: 'K1', doi: null, title: 'Band gaps of frameworks', year: 2025, citekey: null }];
  lib.radarScore = async (q) => Object.fromEntries(q.items.map((it, i) => {
    const p = byTitle[it.text.split('. ')[0]];
    return [it.id, { similarity: 0.5, negative: p.neg ?? 0.1, seed_max: p.abs ?? 0.08, seed_best: `zotero/K${i % 5}`, seed_raw: 0.6, seed_second: (p.abs ?? 0.08) - 0.01 }];
  }));
  lib.radarFulltext = async (q) => Object.fromEntries(q.items.map((i) => { const p = byArxiv[i.arxiv]; return [i.id, { seed_max: p.whole, seed_best: 'zotero/K1', seed_raw: 0.7, seed_second: p.second ?? p.whole - 0.01 }]; }));
  const fetch = routedFetch({ [arxivCategoryFeed('cond-mat.mtrl-sci')]: res(200, feedXml(items.map((i) => ({ ...i, date: RECENT, link: `https://arxiv.org/abs/${i.id}` })))) });
  const threshold = { abstract: 0.1, full: 0.05, calibration: { abstract: { unrelated: { p95: 0.0 } }, full: { unrelated: { p95: 0.01 } }, baseline: { labels: ['zotero/K1'], abstract: [0.5], full: [0.6] }, version: CALIBRATION_VERSION, seedsKey: seedsKey(seeds()) } };
  const config = validateRadar({ scope: { kind: 'library' }, profile: profile({ topics: [] }), sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }], size: { fresh, older: 0, discover: 0 }, seeds: seeds(), threshold });
  return collectRadar({ config, since: '2026-09-01', now: NOW, fetch, library: lib, state: emptyState(), judge: judge ?? (async () => ({ off: new Set(), error: null })) });
}

const candidates = (out) => Object.fromEntries(out.state.pendingLog.filter((l) => l.type === 'candidate').map((l) => [l.title, l]));

test('a run logs every scored candidate with its features, score, the stage it was cut at and its rank if shown', async () => {
  const papers = [
    { title: 'Invented paper above 0', whole: 0.09 },
    { title: 'Invented paper above 1', whole: 0.08 },
    { title: 'Invented paper above 2', whole: 0.07 },
    { title: 'Invented paper above 3', whole: 0.065 }, // past every bar, but the issue holds three
    { title: 'Invented hub paper', whole: 0.2, second: 0.02 },
    { title: 'Invented rejected paper', whole: 0.1 },
    { title: 'Invented paper far under whole', whole: 0.005 },
    { title: 'Invented paper far on its abstract', abs: 0.01, whole: 0.5 },
  ];
  const judge = async (pool) => ({ off: new Set(pool.filter((p) => p.title === 'Invented rejected paper').map((p) => p.id)), error: null });
  const out = await seedRun(papers, { judge });
  const header = out.state.pendingLog[0];
  assert.equal(header.type, 'run');
  assert.equal(header.run, NOW);
  assert.equal(header.rankBar, 0.1);
  const by = candidates(out);
  assert.equal(Object.keys(by).length, papers.length, 'one line per scored candidate');
  assert.deepEqual(['above 0', 'above 1', 'above 2'].map((t) => [by[`Invented paper ${t}`].stage, by[`Invented paper ${t}`].rank]), [['shown', 1], ['shown', 2], ['shown', 3]]);
  assert.equal(by['Invented paper above 3'].stage, 'not picked');
  assert.equal(by['Invented paper above 3'].rank, undefined);
  assert.equal(by['Invented hub paper'].stage, 'hub filter');
  assert.equal(by['Invented rejected paper'].stage, 'profile check');
  assert.equal(by['Invented paper far under whole'].stage, 'whole-paper bar');
  assert.equal(by['Invented paper far on its abstract'].stage, 'abstract bar');

  const top = by['Invented paper above 0'];
  assert.equal(top.id, 'arxiv:2610.60000');
  assert.deepEqual(top.keys, ['arxiv:2610.60000', 'title:invented paper above 0']);
  assert.deepEqual(top.sources, ['database:arxiv']);
  assert.equal(top.score, out.picked[0].score);
  assert.deepEqual(top.f, { sim: 0.6, margin: 0.08, seed: 'zotero/K0', second: 0.07, negSim: 0.1, negative: 0, author: 0, journal: 0, topic: 0, titleOnly: false,
    whole: { sim: 0.7, margin: 0.09, seed: 'zotero/K1', second: 0.08 } });
  assert.equal(by['Invented paper far on its abstract'].f.whole, undefined, 'not read whole');
  assert.ok(!JSON.stringify(out.state.pendingLog).includes('invented summary text'), 'no abstracts in the log');
});

test('a radar without seeds logs what fell under the floor as cut at the abstract bar', async () => {
  const items = [{ title: 'Spindle study one of the invented', link: 'https://x.example/1' }, { title: 'Spindle study two of the invented', link: 'https://x.example/2' }, { title: 'Unrelated paper of the invented kind', link: 'https://x.example/3' }];
  const lib = radarLibrary({ sim: (t) => (/one/.test(t) ? 0.9 : /two/.test(t) ? 0.8 : 0.5) });
  const out = await collectRadar({
    config: { scope: { kind: 'library' }, profile: profile(), sources: [{ id: 'f', on: true, kind: 'feed', url: 'https://x.example/feed', title: 'F' }], size: { fresh: 1, older: 0 }, note: false },
    since: '2026-10-01', now: NOW, fetch: routedFetch({ 'https://x.example/feed': res(200, feedXml(items)) }), library: lib, state: emptyState(),
  });
  const by = candidates(out);
  assert.deepEqual(Object.values(by).map((l) => [l.title, l.stage, l.rank ?? null]).sort(), [
    ['Spindle study one of the invented', 'shown', 1], ['Spindle study two of the invented', 'not picked', null], ['Unrelated paper of the invented kind', 'abstract bar', null]]);
  assert.equal(by['Unrelated paper of the invented kind'].f.titleOnly, true);
  assert.deepEqual(out.picked.map((p) => p.title), ['Spindle study one of the invented'], 'the run picks as before');
});

// ---------------------------------------------------------------- the store writes the log

const shownState = () => {
  const s = emptyState();
  s.shown['doi:10.1/p1'] = { keys: ['doi:10.1/p1', 'title:invented paper one on voles'], title: 'Invented paper one on voles', text: 'Invented paper one on voles. x', authors: [], venue: '', sources: ['f'] };
  for (const k of s.shown['doi:10.1/p1'].keys) s.seen[k] = { at: NOW, verdict: 'shown' };
  return s;
};
const lines = (fs, id = 'r1') => (fs.files.get(`/data/radar/${id}/${CANDIDATE_LOG}`) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the store appends a run\'s lines beside state.json, with the radar id, and keeps them out of state.json', async () => {
  const fs = memoryFs();
  const store = createRadarStore(fs, '/data', { now: () => Date.parse(NOW) });
  await store.write('r1', { ...emptyState(), pendingLog: [{ type: 'run', at: NOW, run: NOW }, { type: 'candidate', at: NOW, run: NOW, id: 'doi:10.1/a', title: 'A' }] });
  assert.deepEqual(lines(fs).map((l) => [l.type, l.radar, l.id ?? null]), [['run', 'r1', null], ['candidate', 'r1', 'doi:10.1/a']]);
  assert.ok(!fs.files.get('/data/radar/r1/state.json').includes('pendingLog'));
  await store.write('r1', { ...emptyState(), pendingLog: [{ type: 'run', at: NOW, run: 'second' }] });
  assert.equal(lines(fs).length, 3, 'append-only');
});

test('a verdict, and its undo, are appended as the paper\'s new verdict; a paper merely shown is not', async () => {
  const fs = memoryFs();
  const store = createRadarStore(fs, '/data', { now: () => Date.parse(NOW) });
  const prof = { topics: [], authors: [], journals: [] };
  await store.write('r1', shownState());
  assert.deepEqual(lines(fs), []);
  for (const verdict of ['liked', 'dismissed', 'undo', 'later', 'added']) {
    const out = applyFeedback({ state: await store.read('r1'), profile: prof, key: 'doi:10.1/p1', verdict, now: NOW });
    await store.write('r1', out.state);
  }
  assert.deepEqual(lines(fs).map((l) => [l.type, l.id, l.verdict]), [['verdict', 'doi:10.1/p1', 'liked'], ['verdict', 'doi:10.1/p1', 'dismissed'], ['verdict', 'doi:10.1/p1', 'liked'], ['verdict', 'doi:10.1/p1', 'later'], ['verdict', 'doi:10.1/p1', 'added']]);
  assert.deepEqual(lines(fs)[0].keys, ['doi:10.1/p1', 'title:invented paper one on voles']);
  assert.equal(lines(fs)[0].at, NOW);
});

test('a log that cannot be written never stops the state write; the problem is noted in the state', async () => {
  const fs = memoryFs();
  fs.append = async () => { throw new Error('disk full'); };
  const store = createRadarStore(fs, '/data', { now: () => Date.parse(NOW) });
  await store.write('r1', { ...shownState(), pendingLog: [{ type: 'run', at: NOW, run: NOW }] });
  const back = await store.read('r1');
  assert.ok(back.shown['doi:10.1/p1']);
  assert.match(back.logProblem.error, /disk full/);
  fs.append = async (path, line) => { fs.files.set(path, (fs.files.get(path) ?? '') + line + '\n'); };
  await store.write('r1', back);
  assert.equal((await store.read('r1')).logProblem, undefined, 'cleared by the next write that logs');
});

test('the log is trimmed on a run: older than its days go, then all but its newest lines', async () => {
  const fs = memoryFs();
  const day = (d) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
  const old = [100, 95, 10, 9, 8, 7, 6].map((d, i) => JSON.stringify({ at: day(d), type: 'candidate', id: `doi:10.1/${i}` }));
  fs.files.set(`/data/radar/r1/${CANDIDATE_LOG}`, `${old.join('\n')}\n{ torn line\n`);
  const store = createRadarStore(fs, '/data', { now: () => Date.parse(NOW), logDays: 90, logLines: 4, trimBytes: 10 });
  await store.write('r1', { ...emptyState(), pendingLog: [{ type: 'run', at: NOW, run: NOW }] });
  assert.deepEqual(lines(fs).map((l) => l.id ?? l.type), ['doi:10.1/4', 'doi:10.1/5', 'doi:10.1/6', 'run']);
  // A small file is not read back to be trimmed.
  const big = createRadarStore(fs, '/data', { now: () => Date.parse(NOW) + 400 * 86_400_000, logDays: 90, logLines: 4, trimBytes: 1e9 });
  await big.write('r1', { ...emptyState(), pendingLog: [{ type: 'run', at: NOW, run: 'later' }] });
  assert.equal(lines(fs).length, 5);
});
