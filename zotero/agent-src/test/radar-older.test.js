import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worthReading, OLDER } from '../src/radar-older.js';
import { politeFetch } from '../src/radar-sources.js';
import { normalise, keysOf } from '../src/radar.js';
import { emptyState } from '../src/radar-state.js';
import { openAlexGraph, radarLibrary } from './support/radar-fakes.mjs';

// Invented graph. Library papers L1-L6 cite: X (4 of them), Y (2), Z (3, but L6 is Z), Q (3, but the library holds its
// title without a DOI), P (3, fine). New papers N1 and N2 both cite Y; N1 alone cites R.
const lib = (n, refs, extra = {}) => ({ id: `W${n}`, doi: `10.1/l${n}`, title: `Library paper ${n} on cortical oscillations`, year: 2020 + n, refs, ...extra });
const graph = [
  lib(1, ['X', 'Y', 'Z', 'Q', 'P']), lib(2, ['X', 'Y', 'Z', 'Q', 'P']), lib(3, ['X', 'Z', 'Q', 'P']), lib(4, ['X']), lib(5, []),
  { id: 'Z', doi: '10.1/z', title: 'Held under its OpenAlex id and DOI in the library', year: 1990, refs: [] },
  { id: 'X', doi: '10.1/x', title: 'Thalamic spindle generation revisited', year: 1995, refs: [], cited: 812 },
  { id: 'Y', doi: '10.1/y', title: 'A review of slow oscillation coupling', year: 1998, refs: [], cited: 300 },
  { id: 'Q', doi: '10.1/q', title: 'Already in the library under another record', year: 1991, refs: [] },
  { id: 'P', doi: '10.1/p', title: 'Cortical up states and their neighbours', year: 1993, refs: [] },
  { id: 'R', doi: '10.1/r', title: 'Cited by one new paper only', year: 1992, refs: [] },
  { id: 'N1', doi: '10.1/n1', title: 'New paper one', year: 2026, refs: ['Y', 'R'] },
  { id: 'N2', doi: '10.1/n2', title: 'New paper two', year: 2026, refs: ['Y'] },
];
const library = [
  ...[1, 2, 3, 4, 5].map((n) => ({ key: `K${n}`, doi: `10.1/l${n}`, title: `Library paper ${n} on cortical oscillations`, year: 2020 + n, citekey: null })),
  { key: 'K6', doi: '10.1/z', title: 'Held under its OpenAlex id and DOI in the library', year: 2019, citekey: null },
  { key: 'K7', doi: null, title: 'Already in the library under another record', year: 2019, citekey: null },
];
const newRows = ['n1', 'n2'].map((n) => normalise({ title: `New paper ${n}`, doi: `10.1/${n}` }, 's'));
const NOW = '2026-10-11T08:00:00.000Z';
const run = (over = {}) => worthReading({ libraryItems: library, scopeItems: library, newRows: [], state: emptyState(), fetch: openAlexGraph(graph), now: NOW, size: { older: 5 }, seenKeys: new Set(), ...over });

test('rows are cited by >= 3 library papers, are not in the library, and the stated counts match the fixture', async () => {
  const { rows, note } = await run();
  assert.equal(note, null);
  assert.deepEqual(rows.map((r) => r.doi), ['10.1/x', '10.1/p'], 'only X (4) and P (3) qualify, most cited first');
  const byDoi = Object.fromEntries(rows.map((r) => [r.doi, r]));
  assert.equal(byDoi['10.1/x'].why.citedBy.count, 4);
  assert.equal(byDoi['10.1/p'].why.citedBy.count, 3);
  const held = new Set(library.flatMap((l) => keysOf(l)));
  for (const r of rows) assert.ok(!keysOf(r).some((k) => held.has(k)), 'not in the library');
  // The fixture's own count, recomputed from the graph.
  for (const r of rows) assert.equal(r.why.citedBy.count, graph.filter((w) => w.id.startsWith('W') && w.refs.includes(graph.find((g) => g.doi === r.doi).id)).length);
  assert.equal(byDoi['10.1/x'].cites, 812);
  assert.match(byDoi['10.1/x'].reason, /^Cited by 4 papers in your library, including Library paper \d on cortical oscillations, /);
  assert.equal(byDoi['10.1/x'].why.citedBy.titles.length, 3);
});

test('a work cited by two library papers is not a candidate', async () => {
  const { rows } = await run();
  assert.ok(!rows.some((r) => r.doi === '10.1/y'));
});

test('a work cited by two of this run\'s New rows is a candidate, with a reason that says so', async () => {
  const { rows } = await run({ newRows });
  const y = rows.find((r) => r.doi === '10.1/y');
  assert.ok(y, 'Y: 2 library papers and both new papers');
  assert.equal(y.why.citedBy.count, 2);
  assert.equal(y.why.citedBy.newCount, 2);
  assert.match(y.reason, /^Cited by 2 papers in your library, including .*; also cited by 2 of this run's new papers$/);
  assert.ok(!rows.some((r) => r.doi === '10.1/r'), 'R is cited by one new paper only');
});

test('references are cached for 30 days: a second run asks for nothing, a 31-day-old entry is asked again', async () => {
  const fetch1 = openAlexGraph(graph);
  const first = await run({ fetch: fetch1 });
  assert.equal(fetch1.refCalls().length, 1, 'five library DOIs fit one request');
  assert.ok(first.state.refs['10.1/l1'].ids.includes('X'));
  assert.equal(first.state.refs['10.1/l1'].id, 'W1');

  const fetch2 = openAlexGraph(graph);
  const second = await run({ fetch: fetch2, state: first.state, now: '2026-11-05T08:00:00.000Z' });
  assert.equal(fetch2.refCalls().length, 0, 'cached DOIs are not requested');
  assert.deepEqual(second.rows.map((r) => r.doi), first.rows.map((r) => r.doi), 'same answer from the cache');

  const old = { ...first.state, refs: { ...first.state.refs, '10.1/l3': { ...first.state.refs['10.1/l3'], at: '2026-09-10T08:00:00.000Z' } } };
  const fetch3 = openAlexGraph(graph);
  await run({ fetch: fetch3, state: old });
  const asked = fetch3.refCalls();
  assert.equal(asked.length, 1);
  assert.match(decodeURIComponent(asked[0]), /doi:10\.1\/l3&/, 'only the stale DOI');
});

test('DOIs are batched 50 to a request', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ key: `M${i}`, doi: `10.2/m${i}`, title: `Invented library paper number ${i}`, year: 2000 + (i % 20), citekey: null }));
  const fetch = openAlexGraph([]);
  await run({ fetch, libraryItems: many, scopeItems: many });
  assert.equal(fetch.refCalls().length, 3);
});

test('a row shown before never comes back, whichever identity it is seen under', async () => {
  const first = await run();
  const seen = new Set(first.rows.flatMap(keysOf));
  const again = await run({ seenKeys: seen });
  assert.ok(again.rows.every((r) => !seen.has(r.id)));
  assert.deepEqual(again.rows.map((r) => r.doi), []);
});

test('size.older caps the rows and 0 skips the work', async () => {
  assert.equal((await run({ size: { older: 1 } })).rows.length, 1);
  const fetch = openAlexGraph(graph);
  assert.deepEqual((await run({ size: { older: 0 }, fetch })).rows, []);
  assert.equal(fetch.calls.length, 0);
});

test('running out of requests gives a note and the rows it could get, not a failure', async () => {
  const net = politeFetch(openAlexGraph(graph), 0);
  const none = await run({ fetch: net.fetch });
  assert.deepEqual(none.rows, []);
  assert.match(none.note, /request limit for this run was reached/);

  // The reference batch fits, the metadata lookup does not.
  const net2 = politeFetch(openAlexGraph(graph), 1);
  const some = await run({ fetch: net2.fetch });
  assert.deepEqual(some.rows, []);
  assert.match(some.note, /request limit/);
  assert.ok(some.state.refs['10.1/l1'], 'what was fetched is kept for next time');
});

test('a failing OpenAlex is a note too', async () => {
  const { rows, note } = await run({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(rows, []);
  assert.match(note, /HTTP 503/);
});

test('similarity from the library server breaks ties between equally cited works', async () => {
  const tied = graph.map((w) => (w.id === 'W4' ? { ...w, refs: ['X', 'P'] } : w));
  const lb = radarLibrary({ sim: (t) => (/spindle/i.test(t) ? 0.6 : 0.9) });
  const { rows } = await run({ fetch: openAlexGraph(tied), library: lb });
  assert.deepEqual(rows.map((r) => r.doi), ['10.1/p', '10.1/x'], 'both cited 4 times: P is closer to the library');
});

test('two OpenAlex records for one DOI: the one with references wins, whichever comes last', async () => {
  const dup = [...graph, { id: 'W1b', doi: '10.1/l1', title: 'Library paper 1 on cortical oscillations', year: 2021, refs: [] }];
  const base = await run({ fetch: openAlexGraph(dup) });
  assert.deepEqual(base.state.refs['10.1/l1'].ids, ['X', 'Y', 'Z', 'Q', 'P']);
  assert.equal(base.state.refs['10.1/l1'].id, 'W1');
});
