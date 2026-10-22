import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, mergeItems, dropKnown, pickTop, keysOf, validateRadar, MCP_PRESETS } from '../src/radar.js';
import { collectRadar } from '../src/radar-run.js';
import { emptyState } from '../src/radar-state.js';
import { feedXml, res, routedFetch, radarLibrary, profile } from './support/radar-fakes.mjs';

const raw = (over) => ({ title: 'Thalamic spindles gate memory consolidation', authors: ['Doe, J.'], venue: '', abstract: '', ...over });

test('a preprint and its journal version become one row that keeps both links and both sources', () => {
  const preprint = normalise(raw({ arxiv: '2610.01234', venue: 'arXiv', url: 'https://arxiv.org/pdf/2610.01234', date: '2026-09-01', authors: ['Doe, J.'] }), 'feed:arxiv');
  const journal = normalise(raw({ doi: '10.9999/inv.77', arxiv: '2610.01234', venue: 'J. Invented', url: 'https://doi.org/10.9999/inv.77', date: '2026-10-05', authors: ['Doe, J.', 'Roe, R.'], abstract: 'Spindles gate memory.' }), 'journal:j');
  const [row, ...rest] = mergeItems([preprint, journal]);
  assert.equal(rest.length, 0);
  assert.equal(row.venue, 'J. Invented', 'the journal version leads');
  assert.equal(row.doi, '10.9999/inv.77');
  assert.equal(row.arxiv, '2610.01234');
  assert.deepEqual(row.links.sort(), ['https://arxiv.org/pdf/2610.01234', 'https://doi.org/10.9999/inv.77']);
  assert.deepEqual(row.sources.sort(), ['feed:arxiv', 'journal:j']);
  assert.equal(row.date, '2026-09-01', 'first seen date');
  assert.deepEqual(row.authors, ['Doe, J.', 'Roe, R.']);
});

test('records join on title alone, and a bridging record joins two earlier rows', () => {
  const a = normalise(raw({ arxiv: '2610.00001', venue: 'arXiv' }), 's1');
  const b = normalise(raw({ doi: '10.9999/inv.5', venue: 'J. Invented' }), 's2');
  assert.equal(mergeItems([a, b]).length, 1);
  const x = normalise({ title: 'First paper title here', arxiv: '2610.00002' }, 's1');
  const y = normalise({ title: 'Other paper title there', doi: '10.9999/inv.6' }, 's2');
  const bridge = normalise({ title: 'Third unrelated words', doi: '10.9999/inv.6', arxiv: '2610.00002' }, 's3');
  assert.equal(mergeItems([x, y, bridge]).length, 1);
});

test('short generic titles never merge two different papers', () => {
  const a = normalise({ title: 'Introduction', doi: '10.9999/a' }, 's');
  const b = normalise({ title: 'Introduction', doi: '10.9999/b' }, 's');
  assert.equal(mergeItems([a, b]).length, 2);
});

test('arXiv DOIs count as the arXiv id', () => {
  assert.ok(keysOf({ doi: '10.48550/arXiv.2610.01234', title: 'x' }).includes('arxiv:2610.01234'));
});

test('library papers and seen papers are dropped, matched on any identity', () => {
  const items = [
    normalise(raw({ doi: '10.9999/lib.1', title: 'A paper already in the library' }), 's'),
    normalise(raw({ doi: '10.9999/other', title: 'Library title but a different doi' }), 's'),
    normalise(raw({ arxiv: '2610.99999', title: 'Seen last week as a preprint' }), 's'),
    normalise(raw({ doi: '10.9999/fresh.1', title: 'Genuinely new spindle result' }), 's'),
  ];
  const library = [{ doi: '10.9999/LIB.1', title: 'x' }, { doi: null, title: 'Library title but a different DOI' }];
  const seen = { 'arxiv:2610.99999': { at: 'x', verdict: 'shown' } };
  assert.deepEqual(dropKnown(items, library, seen).map((i) => i.title), ['Genuinely new spindle result']);
  const journalVersion = normalise(raw({ doi: '10.9999/j.9', arxiv: '2610.99999', title: 'Seen last week as a preprint' }), 's');
  assert.equal(dropKnown([journalVersion], [], seen).length, 0, 'the journal version of a shown preprint stays hidden');
});

test('pickTop is deterministic: score, then newer date, then id', () => {
  const rows = [{ id: 'b', score: 0.5, date: '2026-01-01' }, { id: 'a', score: 0.5, date: '2026-01-01' }, { id: 'c', score: 0.5, date: '2026-02-01' }, { id: 'd', score: 0.9, date: null }];
  assert.deepEqual(pickTop(rows, 3).map((r) => r.id), ['d', 'c', 'a']);
});

test('validateRadar fills defaults and refuses a broken source at the boundary', () => {
  const ok = validateRadar({ sources: [{ kind: 'database', db: 'arxiv' }, { kind: 'feed', url: 'https://j.example/rss' }], profile: { topics: [{ text: 'spindles' }] } });
  assert.deepEqual(ok.size, { fresh: 8, older: 1, discover: 3 });
  assert.equal(ok.note, true);
  assert.equal(ok.sources[0].id, 'database:arxiv');
  assert.equal(ok.sources[0].on, true);
  assert.equal(ok.profile.topics[0].weight, 1);
  assert.throws(() => validateRadar({ sources: [{ kind: 'feed', url: 'ftp://x' }] }), /http/);
  assert.throws(() => validateRadar({ sources: [{ kind: 'database', db: 'nope' }] }), /Unknown database/);
  assert.throws(() => validateRadar({ size: { fresh: 0 } }), /1 and 50/);
  assert.throws(() => validateRadar({ sources: [{ kind: 'database', db: 'arxiv' }, { kind: 'database', db: 'arxiv' }] }), /twice/);
  assert.throws(() => validateRadar(null), /settings/);
});

// ---- whole runs, through collectRadar ----

const FEED = 'https://j.example/feed';
const config = (over = {}) => ({ scope: { kind: 'library' }, profile: profile(), sources: [{ id: 'f', on: true, kind: 'feed', url: FEED, title: 'J' }], size: { fresh: 8, older: 1 }, note: true, ...over });
const feedWith = (n) => feedXml(Array.from({ length: n }, (_, i) => ({ title: `Spindle study number ${i + 1} of sleep`, link: `https://j.example/a/${i + 1}`, doi: `10.9999/inv.${i + 1}` })));

async function run(cfg, fetchFn, library, state = emptyState()) {
  return collectRadar({ config: cfg, since: '2026-10-01', now: '2026-10-07T07:00:00.000Z', fetch: fetchFn, library, state });
}

test('a second run never repeats a row, and a quiet day picks nothing', async () => {
  const fetchFn = routedFetch({ [FEED]: res(200, feedWith(3)) });
  const library = radarLibrary({ known: [{ key: 'K1', doi: '10.9999/inv.1', title: 'Spindle study number 1 of sleep', citekey: 'doe2026', year: 2026 }] });
  const first = await run(config(), fetchFn, library);
  assert.deepEqual(first.picked.map((p) => p.doi).sort(), ['10.9999/inv.2', '10.9999/inv.3'], 'the library paper is not offered');
  assert.equal(first.state.sourceStatus.f.items, 3);
  const second = await run(config(), fetchFn, library, first.state);
  assert.deepEqual(second.picked, [], 'everything above the bar was shown already');
});

test('below the score floor nothing is picked', async () => {
  const fetchFn = routedFetch({ [FEED]: res(200, feedWith(2)) });
  const out = await run(config(), fetchFn, radarLibrary({ sim: () => 0.05 }));
  assert.deepEqual(out.picked, []);
});

test('size.fresh caps the digest, best score first', async () => {
  const fetchFn = routedFetch({ [FEED]: res(200, feedWith(5)) });
  const library = radarLibrary({ sim: (t) => 0.7 + Number(/number (\d)/.exec(t)[1]) / 20 });
  const out = await run(config({ size: { fresh: 2, older: 0 } }), fetchFn, library);
  assert.deepEqual(out.picked.map((p) => p.doi), ['10.9999/inv.5', '10.9999/inv.4']);
});

test('a backend without the radar methods fails with a plain message', async () => {
  const bare = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  await assert.rejects(run(config(), routedFetch({}), bare), /library server/);
});

test('when every source fails the run fails, so the since window does not move', async () => {
  await assert.rejects(run(config(), routedFetch({}), radarLibrary()), /None of the sources answered \(HTTP 404\)/);
});

test('validateRadar keeps mcp args as a plain object under 4 KB and the Hugging Face preset passes', () => {
  const s = (args) => ({ sources: [{ kind: 'mcp', server: 'a', tool: 'b', ...(args === undefined ? {} : { args }) }] });
  assert.deepEqual(validateRadar(s({ q: '{query}' })).sources[0].args, { q: '{query}' });
  assert.equal('args' in validateRadar(s()).sources[0], false);
  assert.throws(() => validateRadar(s([1])), /object/);
  assert.throws(() => validateRadar(s('x')), /object/);
  assert.throws(() => validateRadar(s(null)), /object/);
  assert.throws(() => validateRadar(s({ big: 'x'.repeat(5000) })), /too long/);
  assert.equal(validateRadar({ sources: [{ kind: 'mcp', ...MCP_PRESETS.huggingface }] }).sources[0].tool, 'hf_fs');
});

test('a source that hits the OpenAlex limit records the message, and the run finishes with the other sources', async () => {
  const { openAlexFetch } = await import('../src/openalex.js');
  const net = openAlexFetch(routedFetch({ [FEED]: res(200, feedWith(3)), 'https://api.openalex.org/works?filter=authorships.author.id:A7,from_publication_date:2026-10-01&sort=publication_date:desc&per_page=50&select=id,doi,ids,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,best_oa_location,type,abstract_inverted_index,keywords': res(429, '{}', { 'retry-after': '600' }) }), () => null);
  const cfg = config({ sources: [{ id: 'f', on: true, kind: 'feed', url: FEED, title: 'J' }, { id: 'a', on: true, kind: 'author', openalexId: 'A7', name: 'Doe' }] });
  const out = await run(cfg, net, radarLibrary());
  assert.equal(out.picked.length, 3, 'the feed still gave its papers');
  assert.match(out.state.sourceStatus.a.error, /free daily limit is used up .*Add your free OpenAlex API key in Settings/);
  assert.equal(out.state.sourceStatus.f.error, null);
  assert.deepEqual(out.failed.map((f) => f.source), ['a']);
});

test('Worth reading stops with the limit message as its note when OpenAlex refuses', async () => {
  const { openAlexFetch } = await import('../src/openalex.js');
  const net = openAlexFetch(routedFetch({ [FEED]: res(200, feedWith(3)) }), () => null);
  const limited = async (url, init) => (String(url).startsWith('https://api.openalex.org') ? res(429, '{}', { 'retry-after': '600' }) : net(url, init));
  const wrapped = openAlexFetch(limited, () => null);
  const library = radarLibrary({ known: [{ key: 'K1', doi: '10.9999/lib.1', title: 'A library paper on oscillations', citekey: 'a2020', year: 2020 }] });
  const out = await run(config({ size: { fresh: 8, older: 3 } }), wrapped, library);
  assert.equal(out.picked.length, 3);
  assert.match(out.olderNote, /^Worth reading stopped: OpenAlex's free daily limit is used up/);
});
