import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpLibraryBackend } from '../src/library-http.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init?.headers ?? {} });
    const body = routes[u.pathname]?.(u.searchParams) ?? null;
    return { ok: body !== null, status: body !== null ? 200 : 404, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('search: every request carries X-KB-Client: agent, and paths are mapped to CitationRefs', async () => {
  const fetchFn = fakeFetch({
    '/search': () => [
      { path: 'zotero/smith2021', title: 'Smith 2021', passages: [{ heading: 'Abstract', snippet: 'about graphene' }], zotero: { year: 2021 } },
      { path: 'Ideas/Graphene.md', title: 'Graphene', passages: [{ heading: '', snippet: 'my notes' }] },
    ],
  });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  const results = await library.search({ text: 'graphene', scope: { kind: 'library' }, limit: 8 });
  assert.deepEqual(results[0].ref, { kind: 'paper', citekey: 'smith2021' });
  assert.equal(results[0].year, 2021);
  assert.deepEqual(results[1].ref, { kind: 'note', path: 'Ideas/Graphene.md' });
  assert.equal(fetchFn.calls[0].headers['X-KB-Client'], 'agent');
});

test('search: a collections scope becomes ?collections=K1,K2, a tag scope ?tag=, a library scope neither', async () => {
  const fetchFn = fakeFetch({ '/search': () => [] });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await library.search({ text: 'q', scope: { kind: 'collections', keys: ['K1', 'K2'] }, limit: 8 });
  assert.equal(fetchFn.calls[0].params.collections, 'K1,K2');
  assert.equal('tag' in fetchFn.calls[0].params, false);
  await library.search({ text: 'q', scope: { kind: 'collections', keys: [] }, limit: 8 });
  assert.equal('collections' in fetchFn.calls[1].params, false); // nothing ticked: no narrowing, not an empty param
  await library.search({ text: 'q', scope: { kind: 'tag', name: 'important' }, limit: 8 });
  assert.equal(fetchFn.calls[2].params.tag, 'important');
  assert.equal('collections' in fetchFn.calls[2].params, false);
  await library.search({ text: 'q', scope: { kind: 'library' }, limit: 8 });
  assert.equal('collections' in fetchFn.calls[3].params, false);
  assert.equal('tag' in fetchFn.calls[3].params, false);
});

test('search: a pre-Z3 { kind: "collection", name } scope resolves through GET /zotero/collections, once, then reuses it', async () => {
  const fetchFn = fakeFetch({
    '/zotero/collections': () => [{ key: 'K1', name: 'Graphene', parent: null, count: 3 }, { key: 'K2', name: 'Other', parent: null, count: 1 }],
    '/search': () => [],
  });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await library.search({ text: 'q', scope: { kind: 'collection', name: 'Graphene' }, limit: 8 });
  await library.search({ text: 'q2', scope: { kind: 'collection', name: 'Graphene' }, limit: 8 });
  const collectionsCalls = fetchFn.calls.filter((c) => c.path === '/zotero/collections');
  assert.equal(collectionsCalls.length, 1, 'cached after the first resolution');
  const searchCalls = fetchFn.calls.filter((c) => c.path === '/search');
  assert.equal(searchCalls[0].params.collections, 'K1');
  assert.equal(searchCalls[1].params.collections, 'K1');
});

test('search: a savedSearch scope cannot be resolved server-side, so it is sent as a whole-library search', async () => {
  const fetchFn = fakeFetch({ '/search': () => [] });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await library.search({ text: 'q', scope: { kind: 'savedSearch', name: 'To read' }, limit: 8 });
  assert.equal('collection' in fetchFn.calls[0].params, false);
  assert.equal('tag' in fetchFn.calls[0].params, false);
});

test('search: only "papers" sends source=zotero; only "notes" sends exclude_source=zotero; neither sends nothing', async () => {
  const fetchFn = fakeFetch({ '/search': () => [] });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await library.search({ text: 'q', scope: { kind: 'library' }, limit: 8, only: 'papers' });
  assert.equal(fetchFn.calls[0].params.source, 'zotero');
  assert.equal('exclude_source' in fetchFn.calls[0].params, false);
  await library.search({ text: 'q', scope: { kind: 'library' }, limit: 8, only: 'notes' });
  assert.equal(fetchFn.calls[1].params.exclude_source, 'zotero');
  assert.equal('source' in fetchFn.calls[1].params, false);
  await library.search({ text: 'q', scope: { kind: 'library' }, limit: 8 });
  assert.equal('source' in fetchFn.calls[2].params, false);
  assert.equal('exclude_source' in fetchFn.calls[2].params, false);
});

test('read: a paper ref maps to zotero/<citekey>; a missing note returns null, not a throw', async () => {
  const fetchFn = fakeFetch({ '/note': (params) => (params.get('path') === 'zotero/smith2021' ? { title: 'Smith 2021', text: 'full text' } : null) });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  const hit = await library.read({ kind: 'paper', citekey: 'smith2021' });
  assert.equal(hit.text, 'full text');
  const miss = await library.read({ kind: 'note', path: 'Nope.md' });
  assert.equal(miss, null);
});

test('resolve: builds a title map keyed the same way citations.js does', async () => {
  const fetchFn = fakeFetch({ '/note': (params) => (params.get('path') === 'zotero/smith2021' ? { title: 'Smith 2021' } : null) });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  const map = await library.resolve([{ kind: 'paper', citekey: 'smith2021' }, { kind: 'paper', citekey: 'fabricated' }]);
  assert.deepEqual(map.get('paper:smith2021'), { title: 'Smith 2021' });
  assert.equal(map.get('paper:fabricated'), null);
});

test('resolve: a web ref is keyed web:<url> (never "paper:undefined") and never reaches the server', async () => {
  // Found by the real type check: resolve() used to build keys by hand as note:/paper:, so any web ref (or two
  // different ones) collapsed onto "paper:undefined" instead of the key citations.js looks it up by.
  const fetchFn = fakeFetch({ '/note': () => ({ title: 'should not be asked' }) });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  const map = await library.resolve([{ kind: 'web', url: 'https://a.example/x' }, { kind: 'web', url: 'https://b.example/y' }]);
  assert.equal(map.has('paper:undefined'), false);
  assert.equal(map.get('web:https://a.example/x'), null);
  assert.equal(map.get('web:https://b.example/y'), null);
  assert.equal(fetchFn.calls.length, 0);
});

test('related: maps the /related "similar" list to CitationRefs', async () => {
  const fetchFn = fakeFetch({ '/related': () => ({ similar: [{ path: 'zotero/other2020', title: 'Other 2020' }] }) });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  const results = await library.related({ kind: 'paper', citekey: 'smith2021' }, { limit: 5 });
  assert.deepEqual(results[0].ref, { kind: 'paper', citekey: 'other2020' });
});

test('search: a request that never answers fails as a timeout error (status 504), not as zero results', async () => {
  const hang = () => new Promise(() => {});
  const library = createHttpLibraryBackend(hang, { baseUrl: 'http://127.0.0.1:27182', searchTimeoutMs: 20 });
  await assert.rejects(() => library.search({ text: 'q', scope: { kind: 'library' }, limit: 5 }), (e) => {
    assert.equal(e.kind, 'timeout');
    assert.equal(e.status, 504, 'a status, so a host does not read it as "server gone" and fall back to a smaller index');
    assert.match(e.message, /\/search did not answer within/);
    assert.doesNotMatch(e.message, /timed out/i, 'second-brain.js isOffline() matches "timed out"');
    return true;
  });
});

test('search: an HTTP error carries its status and is thrown, not turned into an empty list', async () => {
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await assert.rejects(() => library.search({ text: 'q', scope: { kind: 'library' }, limit: 5 }), (e) => e.status === 500);
});

test('search: the default allows a cold first query (well past 30 s)', async () => {
  let aborted = false;
  const fetchFn = (url, init) => new Promise((resolve) => { init?.signal?.addEventListener('abort', () => { aborted = true; }); setTimeout(() => resolve({ ok: true, status: 200, json: async () => [] }), 30); });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  assert.deepEqual(await library.search({ text: 'q', scope: { kind: 'library' }, limit: 5 }), []);
  assert.equal(aborted, false);
});

test('search: years become year_from / year_to, and an absent bound sends nothing', async () => {
  const fetchFn = fakeFetch({ '/search': () => [] });
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  await library.search({ text: 'q', scope: { kind: 'library' }, years: { from: 2020, to: 2023 }, limit: 8 });
  assert.equal(fetchFn.calls[0].params.year_from, '2020');
  assert.equal(fetchFn.calls[0].params.year_to, '2023');
  await library.search({ text: 'q', scope: { kind: 'library' }, years: { from: 2020, to: null }, limit: 8 });
  assert.equal(fetchFn.calls[1].params.year_from, '2020');
  assert.equal('year_to' in fetchFn.calls[1].params, false);
  await library.search({ text: 'q', scope: { kind: 'library' }, limit: 8 });
  assert.equal('year_from' in fetchFn.calls[2].params, false);
});

test('radar methods: items, score, profile and digest go to the spec 012 routes as the agent', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    const json = { '/zotero/items': { items: [{ key: 'K1', doi: '10.1/x', title: 'T' }] }, '/radar/score': { scores: { a: { similarity: 0.5, negative: 0 } } }, '/radar/profile': { topics: [], authors: [], journals: [] }, '/digests/2026-10-11': {} }[u.pathname];
    return json ? { ok: true, status: 200, json: async () => json } : { ok: false, status: 404, json: async () => null };
  };
  const library = createHttpLibraryBackend(fetchFn, { baseUrl: 'http://127.0.0.1:27182' });
  assert.deepEqual(await library.items({ collections: ['A', 'B'] }), [{ key: 'K1', doi: '10.1/x', title: 'T' }]);
  assert.equal(calls[0].params.collections, 'A,B');
  await library.items({ collections: null });
  assert.deepEqual(calls[1].params, {}, 'no collections param means the whole library');
  const req = { scope: { collections: null }, positives: [], negatives: ['n'], items: [{ id: 'a', text: 't' }] };
  assert.deepEqual(await library.radarScore(req), { a: { similarity: 0.5, negative: 0 } });
  assert.equal(calls[2].method, 'POST');
  assert.deepEqual(calls[2].body, req);
  assert.equal(calls[2].headers['X-KB-Client'], 'agent');
  await library.radarProfile({ scope: { collections: null } });
  assert.equal(calls[3].path, '/radar/profile');
  await library.writeDigest('2026-10-11', '# Digest');
  assert.deepEqual([calls[4].method, calls[4].path, calls[4].body], ['PUT', '/digests/2026-10-11', { text: '# Digest' }]);
  await assert.rejects(library.radarScore({ ...req, items: [] }).then(() => library.writeDigest('missing', 'x')), /HTTP 404/);
});

test('items on a server without the route is an error, not an empty library', async () => {
  const library = createHttpLibraryBackend(async () => ({ ok: false, status: 404, json: async () => null }), { baseUrl: 'http://127.0.0.1:27182' });
  await assert.rejects(library.items({ collections: null }), /too old/);
});
