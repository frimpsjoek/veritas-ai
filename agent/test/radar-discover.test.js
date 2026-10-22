import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citingKeyPapers, coauthorsOfFollowed, relatedToRated, mightInterest, DISCOVER } from '../src/radar-discover.js';
import { politeFetch } from '../src/radar-sources.js';
import { collectRadar } from '../src/radar-run.js';
import { digestMarkdown, summaryLine } from '../src/radar-digest.js';
import { emptyState } from '../src/radar-state.js';
import { validateRadar } from '../src/radar.js';
import { res, radarLibrary, profile } from './support/radar-fakes.mjs';

// Invented OpenAlex replay. Library papers K1-K4 have citation counts 900, 500, 40, 5; the top key papers are W1..W4.
const NOW = '2026-10-11T08:00:00.000Z';
const lib = [1, 2, 3, 4].map((n) => ({ key: `K${n}`, doi: `10.1/k${n}`, title: `Library paper ${n} on cortical oscillations`, year: 2020 + n, citekey: null }));
const keyWorks = [['W1', 'k1', 900], ['W2', 'k2', 500], ['W3', 'k3', 40], ['W4', 'k4', 5]];
const person = (id) => ({ author: { id: `https://openalex.org/${id}`, display_name: `Person ${id}` } });
const work = (id, title, over = {}) => ({
  id: `https://openalex.org/${id}`, doi: `https://doi.org/10.9/${id.toLowerCase()}`, display_name: title, publication_year: 2026, publication_date: '2026-10-01',
  cited_by_count: 1, type: 'article', authorships: [], primary_location: { source: { display_name: 'Journal of Invented Results' }, landing_page_url: `https://example.org/${id}` },
  abstract_inverted_index: { Invented: [0], abstract: [1] }, ...over,
});
const ref = (...ids) => ids.map((i) => `https://openalex.org/${i}`);

/** Answers by the shape of the filter; `calls` keeps every URL. */
function openAlex(extra = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const f = u.searchParams.get('filter') ?? '';
    if (f.startsWith('doi:10.1/k')) return res(200, JSON.stringify({ results: keyWorks.map(([id, d, c]) => ({ id: `https://openalex.org/${id}`, cited_by_count: c })) }));
    if (f.startsWith('cites:')) return res(200, JSON.stringify({ results: [
      work('C1', 'Cites three of yours', { referenced_works: ref('W1', 'W2', 'W3', 'X9') }),
      work('C2', 'Cites two of yours', { referenced_works: ref('W2', 'W4', 'X9') }),
      work('C3', 'Cites only one', { referenced_works: ref('W1', 'X9') }),
      work('C4', 'A dataset citing three', { type: 'dataset', referenced_works: ref('W1', 'W2', 'W3') }),
    ] }));
    if (f.startsWith('author.id:A1|A2') && u.searchParams.get('select') === 'id,authorships') return res(200, JSON.stringify({ results: [
      { id: 'x', authorships: [person('A1'), person('B1'), person('B2')] }, { id: 'y', authorships: [person('A1'), person('B1')] }, { id: 'z', authorships: [person('A2'), person('B3')] },
    ] }));
    if (f.startsWith('author.id:B1')) return res(200, JSON.stringify({ results: [
      work('D1', 'By a collaborator', { authorships: [person('B1'), person('Z7')] }),
      work('D2', 'Collaborator with the followed author', { authorships: [person('B1'), person('A1')] }),
      work('D3', 'Collaborator three', { authorships: [person('B3')] }),
    ] }));
    if (f.startsWith('doi:10.1/r')) return res(200, JSON.stringify({ results: [
      { id: 'https://openalex.org/R1', doi: 'https://doi.org/10.1/r1', display_name: 'A rated paper about spindles', related_works: ref('E1', 'E2', 'R1') },
    ] }));
    if (f.startsWith('openalex:E1')) return res(200, JSON.stringify({ results: [work('E1', 'A related paper'), work('E2', 'Another related paper')] }));
    return res(404);
  };
  Object.assign(fn, { calls }, extra);
  return fn;
}

const followed = [{ name: 'Ada Invented', openalexId: 'A1' }, { name: 'Bo Invented', openalexId: 'https://openalex.org/A2' }];
const rated = (verdicts) => ({ ...emptyState(), seen: Object.fromEntries(verdicts.map(([k, verdict, at]) => [k, { verdict, at }])) });

test('citingKeyPapers: two or more of the most-cited library papers, with the count in the reason, newest window only', async () => {
  const fetch = openAlex();
  const rows = await citingKeyPapers(fetch, { library: lib, now: NOW });
  assert.deepEqual(rows.map((r) => [r.title, r.reason]), [
    ['Cites three of yours', 'Cites 3 papers in your library'], ['A dataset citing three', 'Cites 3 papers in your library'], ['Cites two of yours', 'Cites 2 papers in your library'],
  ], 'one cited key paper is not enough; non-papers are mightInterest\'s to drop');
  const cites = fetch.calls.find((c) => c.includes('filter=cites'));
  assert.match(decodeURIComponent(cites), /cites:W1\|W2\|W3\|W4,from_publication_date:2026-09-11/);
});

test('citingKeyPapers: fewer than two key papers means no search at all', async () => {
  const fetch = openAlex();
  assert.deepEqual(await citingKeyPapers(fetch, { library: [], now: NOW }), []);
  assert.equal(fetch.calls.length, 0);
});

test('coauthorsOfFollowed: works by the most frequent co-authors, never ones that include a followed author', async () => {
  const fetch = openAlex();
  const rows = await coauthorsOfFollowed(fetch, { followed, now: NOW });
  assert.deepEqual(rows.map((r) => [r.title, r.reason]), [['By a collaborator', 'By a co-author of Ada Invented'], ['Collaborator three', 'By a co-author of Bo Invented']]);
  const last = decodeURIComponent(fetch.calls.at(-1));
  assert.match(last, /author\.id:B1\|B2\|B3,from_publication_date:2026-09-11/, 'co-authors by how often they appear, B1 first');
  assert.deepEqual(await coauthorsOfFollowed(openAlex(), { followed: [], now: NOW }), []);
});

test('relatedToRated: related works of Add and Read later papers only, named by the saved paper', async () => {
  const fetch = openAlex();
  const state = rated([['doi:10.1/r1', 'added', '2026-10-09T00:00:00Z'], ['doi:10.1/r2', 'dismissed', '2026-10-10T00:00:00Z'], ['doi:10.1/r3', 'shown', '2026-10-10T00:00:00Z']]);
  const rows = await relatedToRated(fetch, { state, now: NOW });
  assert.deepEqual(rows.map((r) => r.reason), ['Related to A rated paper about spindles, which you saved', 'Related to A rated paper about spindles, which you saved']);
  assert.deepEqual(rows.map((r) => r.title), ['A related paper', 'Another related paper']);
  const first = decodeURIComponent(fetch.calls[0]);
  assert.ok(first.includes('doi:10.1/r1') && !first.includes('r2') && !first.includes('r3'));
  assert.match(decodeURIComponent(fetch.calls[1]), /openalex:E1\|E2,from_publication_date:2024-10-11/, 'the paper itself (R1) is not asked for');
  assert.deepEqual(await relatedToRated(openAlex(), { state: emptyState(), now: NOW }), []);
});

const base = (over = {}) => ({
  libraryItems: lib, scopeItems: lib, config: { scope: { kind: 'library' }, profile: profile({ authors: [{ name: 'Ada Invented', openalexId: 'A1', weight: 1, origin: 'user' }] }), sources: [{ id: 'author:A2', on: true, kind: 'author', openalexId: 'A2', name: 'Bo Invented' }], size: { fresh: 8, older: 1, discover: 3 }, note: true },
  state: rated([['doi:10.1/r1', 'later', '2026-10-09T00:00:00Z']]), fetch: openAlex(), now: NOW, size: { discover: 3 }, seenKeys: new Set(), library: radarLibrary({ sim: () => 0.9 }), ...over,
});

test('mightInterest: merges the finders, drops datasets, held, seen and followed-source papers, caps at size.discover', async () => {
  const all = await mightInterest(base());
  assert.equal(all.note, null);
  assert.deepEqual(all.rows.map((r) => r.title), ['Cites three of yours', 'Cites two of yours', 'By a collaborator'], 'capped at 3; the dataset is gone');
  assert.ok(all.rows.every((r) => r.reason && r.sources[0] === 'discover'));

  const seen = new Set(['doi:10.9/c1', 'doi:10.9/d1']);
  const less = await mightInterest(base({ seenKeys: seen, size: { discover: 10 } }));
  assert.ok(!less.rows.some((r) => ['Cites three of yours', 'By a collaborator'].includes(r.title)), 'what a followed source returned is dropped');

  const heldTitle = [...lib, { key: 'K9', doi: '10.9/c2', title: 'x', year: 2020, citekey: null }];
  assert.ok(!(await mightInterest(base({ libraryItems: heldTitle, size: { discover: 10 } }))).rows.some((r) => r.title === 'Cites two of yours'));
  assert.deepEqual((await mightInterest(base({ size: { discover: 0 } }))).rows, []);
});

test('mightInterest: a paper two finders found keeps the first reason; rows are scored with the library server', async () => {
  const twice = openAlex();
  const fetch = async (url) => (new URL(url).searchParams.get('filter')?.startsWith('openalex:E1') ? res(200, JSON.stringify({ results: [work('C1', 'Cites three of yours')] })) : twice(url));
  const { rows } = await mightInterest(base({ fetch, size: { discover: 10 } }));
  assert.equal(rows.filter((r) => r.title === 'Cites three of yours').length, 1);
  assert.equal(rows.find((r) => r.title === 'Cites three of yours').reason, 'Cites 3 papers in your library');
  assert.ok(rows.every((r) => r.score >= 0.7 && r.why));
  const low = await mightInterest(base({ library: radarLibrary({ sim: () => 0.2 }) }));
  assert.deepEqual(low.rows, [], 'below the score floor is not shown');
});

test('mightInterest: a failing finder leaves a note and the others still answer; the budget is a note too', async () => {
  const inner = openAlex();
  const fetch = async (url) => (new URL(url).searchParams.get('filter')?.startsWith('cites:') ? res(503) : inner(url));
  const { rows, note } = await mightInterest(base({ fetch }));
  assert.match(note, /HTTP 503 while looking for papers that cite yours/);
  assert.ok(rows.some((r) => r.reason.startsWith('By a co-author')));

  const none = await mightInterest(base({ fetch: politeFetch(openAlex(), 0).fetch }));
  assert.deepEqual(none.rows, []);
  assert.match(none.note, /request limit for this run was reached/);
});

test('collectRadar: the third group needs the key; without one it is skipped with one line, with one it is found', async () => {
  const inner = openAlex();
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host !== 'api.openalex.org') return res(404);
    if (u.pathname === '/works' && u.searchParams.get('search')) return res(200, JSON.stringify({ results: [work('N1', 'A new paper on sleep spindle dynamics')] }));
    return inner(url);
  };
  const config = { scope: { kind: 'library' }, profile: profile(), sources: [{ id: 'database:openalex', on: true, kind: 'database', db: 'openalex' }], size: { fresh: 5, older: 0, discover: 3 }, note: true };
  const lb = radarLibrary({ sim: () => 0.9 });
  lb.items = async () => lib;
  const go = (keyed) => collectRadar({ config, since: '2026-10-01', now: NOW, fetch, library: lb, state: emptyState(), keyed });
  const off = await go(false);
  assert.deepEqual(off.discover, []);
  assert.equal(off.discoverNote, 'Might interest you skipped (no OpenAlex key)');
  assert.equal((await go(undefined)).discoverNote, null);
  const on = await go(true);
  assert.ok(on.discover.length >= 1 && on.discover.length <= 3);
  assert.ok(on.discover.every((r) => !on.picked.some((p) => p.id === r.id)), 'none from a followed source');
  assert.ok(on.discover.every((r) => on.state.seen[r.id]?.verdict === 'shown' && on.state.shown[r.id]));
});

test('validateRadar: size.discover defaults to 3, accepts 0 to 10, rejects the rest', () => {
  const cfg = (size) => validateRadar({ profile: { topics: [] }, sources: [{ kind: 'database', db: 'arxiv' }], ...(size ? { size } : {}) });
  assert.equal(cfg().size.discover, 3);
  assert.equal(cfg({ fresh: 4, older: 1, discover: 0 }).size.discover, 0);
  assert.throws(() => cfg({ discover: 11 }), /between 0 and 10/);
  assert.throws(() => cfg({ discover: 1.5 }), /between 0 and 10/);
});

test('digest: a third section with the reasons, a count and a skip line in the summary', () => {
  const it = (n, over = {}) => ({ id: `doi:10.1/${n}`, doi: `10.1/${n}`, arxiv: null, title: `Invented paper ${n}`, authors: [], venue: '', date: null, year: 2026, abstract: '', url: null, links: [], sources: [], ...over });
  const md = digestMarkdown({ name: 'N', date: 'd', summary: 'S', lines: new Map(), news: [], older: [], discover: [it(3, { reason: 'Cites 3 papers in your library' })] });
  assert.match(md, /## Might interest you\n\n### \[Invented paper 3\]\(https:\/\/doi\.org\/10\.1\/3\)\nCites 3 papers in your library\n/);
  assert.doesNotMatch(digestMarkdown({ name: 'N', date: 'd', summary: 'S', lines: new Map(), news: [], older: [] }), /Might interest/);
  const config = { sources: [] };
  assert.equal(summaryLine({ news: 4, older: 1, discover: 2, answered: 3, failed: [] }, config), '4 new from 3 sources · 1 worth reading · 2 might interest you');
  assert.equal(summaryLine({ news: 4, older: 0, discover: 0, skipped: 'Might interest you skipped (no OpenAlex key)', answered: 1, failed: [] }, config), '4 new from 1 source · Might interest you skipped (no OpenAlex key)');
  assert.ok(DISCOVER.windowDays > 0);
});
