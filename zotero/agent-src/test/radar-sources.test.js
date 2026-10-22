import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAll, fetchSource, politeFetch, parseMcpPapers, REQUEST_BUDGET } from '../src/radar-sources.js';
import { collectRadar } from '../src/radar-run.js';
import { emptyState } from '../src/radar-state.js';
import { feedXml, res, routedFetch, radarLibrary, profile } from './support/radar-fakes.mjs';

const GOOD = 'https://good.example/feed', BAD = 'https://broken.example/feed';
const feed = (id, url) => ({ id, on: true, kind: 'feed', url, title: id });

test('a broken feed URL puts an error on its source, the other sources still deliver, and the run finishes', async () => {
  const fetchFn = routedFetch({
    [GOOD]: res(200, feedXml([{ title: 'Spindle study of sleep in rats', link: 'https://good.example/1', doi: '10.9999/inv.1' }])),
    [BAD]: () => { throw new Error('getaddrinfo ENOTFOUND broken.example'); },
  });
  const out = await collectRadar({
    config: { scope: { kind: 'library' }, profile: profile(), sources: [feed('good', GOOD), feed('bad', BAD)], size: { fresh: 8, older: 0 }, note: false },
    since: '2026-10-01', now: '2026-10-07T07:00:00.000Z', fetch: fetchFn, library: radarLibrary(), state: emptyState(),
  });
  assert.equal(out.picked.length, 1);
  assert.match(out.state.sourceStatus.bad.error, /ENOTFOUND/);
  assert.equal(out.state.sourceStatus.bad.items, 0);
  assert.equal(out.state.sourceStatus.good.error, null);
  assert.deepEqual(out.failed.map((f) => f.source), ['bad']);
});

test('the request budget is spent across sources and then refuses, with the refusal landing on the source', async () => {
  const fetchFn = routedFetch({ 'https://api.openalex.org/works': res(200, '{}') });
  const net = politeFetch(fetchFn, 3);
  for (let i = 0; i < 3; i++) await net.fetch(`https://a.example/${i}`);
  await assert.rejects(net.fetch('https://a.example/4'), /budget/);
  assert.equal(net.used(), 3);
  assert.equal(fetchFn.calls.length, 3);

  const feeds = Array.from({ length: 6 }, (_, i) => feed(`f${i}`, `https://h${i}.example/feed`));
  const answers = Object.fromEntries(feeds.map((f) => [f.url, res(200, feedXml([{ title: `Paper from ${f.id} about spindles`, link: `${f.url}/1` }]))]));
  const fresh = routedFetch(answers);
  const { results, requests } = await fetchAll({ sources: feeds, profile: profile(), since: '2026-10-01', fetch: fresh, budget: 4 });
  assert.equal(requests, 4);
  assert.equal(fresh.calls.length, 4);
  assert.equal(results.filter((r) => r.error && /budget/.test(r.error)).length, 2);
  assert.equal(REQUEST_BUDGET, 120);
});

test('requests to one host go one at a time; different hosts go together', async () => {
  let inFlight = 0, peak = 0;
  const slow = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return res(200, '{}'); };
  const same = politeFetch(slow);
  await Promise.all([1, 2, 3, 4].map((i) => same.fetch(`https://one.example/${i}`)));
  assert.equal(peak, 1);
  peak = 0;
  const other = politeFetch(slow);
  await Promise.all([1, 2, 3].map((i) => other.fetch(`https://h${i}.example/x`)));
  assert.equal(peak, 3);
});

test('feed source: items before `since` are left out, a 304 keeps the cache and yields nothing', async () => {
  const xml = feedXml([
    { title: 'Old paper from long before the window', link: 'https://good.example/old', date: 'Mon, 01 Jun 2026 09:00:00 GMT' },
    { title: 'New paper inside the window of days', link: 'https://good.example/new', date: 'Tue, 06 Oct 2026 09:00:00 GMT' },
  ]);
  const env = (fetchFn, feedCache) => ({ fetch: fetchFn, profile: profile(), since: '2026-10-01', feedCache });
  const first = await fetchSource(feed('good', GOOD), env(routedFetch({ [GOOD]: res(200, xml, { etag: '"a"' }) })));
  assert.deepEqual(first.items.map((i) => i.title), ['New paper inside the window of days']);
  assert.deepEqual(first.cache, { etag: '"a"', modified: null });
  const second = await fetchSource(feed('good', GOOD), env(routedFetch({ [GOOD]: (init) => res(init.headers['If-None-Match'] === '"a"' ? 304 : 200, xml) }), first.cache));
  assert.deepEqual(second.items, []);
  assert.equal(second.error, null);
});

test('journal and author sources use the OpenAlex filters with the since date', async () => {
  const work = { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.9999/inv.9', display_name: 'Invented journal paper', publication_date: '2026-10-03', publication_year: 2026, primary_location: { source: { display_name: 'J. Invented' } }, authorships: [{ author: { display_name: 'Doe, J.' } }] };
  const fetchFn = routedFetch({});
  fetchFn.calls.length = 0;
  const answering = async (url) => { fetchFn.calls.push({ url: String(url) }); return res(200, JSON.stringify({ results: [work] })); };
  const env = { fetch: answering, profile: profile(), since: '2026-10-01' };
  const j = await fetchSource({ id: 'j', on: true, kind: 'journal', openalexId: 'https://openalex.org/S42', name: 'J. Invented', issn: null }, env);
  const a = await fetchSource({ id: 'a', on: true, kind: 'author', openalexId: 'A7', name: 'Doe' }, env);
  assert.match(decodeURIComponent(fetchFn.calls[0].url), /filter=primary_location\.source\.id:S42,from_publication_date:2026-10-01/);
  assert.match(decodeURIComponent(fetchFn.calls[1].url), /filter=authorships\.author\.id:A7,from_publication_date:2026-10-01/);
  assert.equal(j.items[0].date, '2026-10-03');
  assert.equal(j.items[0].openalexId, 'W1');
  assert.equal(j.items[0].doi, '10.9999/inv.9');
  assert.equal(a.items.length, 1);
});

test('database source runs one search per topic through the chosen database only, with since', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(String(url)); return res(200, JSON.stringify({ results: [] })); };
  const p = profile({ topics: [{ text: 'sleep spindle', weight: 1, origin: 'user' }, { text: 'thalamic reticular nucleus', weight: 3, origin: 'user' }] });
  const r = await fetchSource({ id: 'd', on: true, kind: 'database', db: 'openalex' }, { fetch: fetchFn, profile: p, since: '2026-10-01' });
  assert.equal(r.error, null);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith('https://api.openalex.org/works?search=') && u.includes('from_publication_date:2026-10-01')));
  assert.match(decodeURIComponent(urls[0]), /thalamic reticular nucleus/, 'heaviest topic first');
});

test('a database that fails for every topic reports the error; one that fails for some still delivers', async () => {
  const p = profile({ topics: [{ text: 'alpha topic', weight: 2, origin: 'user' }, { text: 'beta topic', weight: 1, origin: 'user' }] });
  const down = await fetchSource({ id: 'd', on: true, kind: 'database', db: 'openalex' }, { fetch: async () => res(500), profile: p, since: '2026-10-01' });
  assert.match(down.error, /HTTP 500/);
  let n = 0;
  const half = await fetchSource({ id: 'd', on: true, kind: 'database', db: 'openalex' }, { fetch: async () => (n++ ? res(500) : res(200, JSON.stringify({ results: [{ display_name: 'Only one paper survived', doi: null }] }))), profile: p, since: '2026-10-01' });
  assert.equal(half.error, null);
  assert.equal(half.items.length, 1);
});

test('mcp source calls the hub per topic and reads papers out of the text; a missing hub or a tool error is an error line', async () => {
  const calls = [];
  const hub = { async call(server, tool, args) { calls.push([server, tool, args]); return '- **Spindles gate memory in sleeping mice** https://arxiv.org/abs/2610.01111\n- Another note without an id'; } };
  const src = { id: 'm', on: true, kind: 'mcp', server: 'hf', tool: 'papers' };
  const r = await fetchSource(src, { fetch: routedFetch({}), hub, profile: profile(), since: '2026-10-01' });
  assert.deepEqual(calls, [['hf', 'papers', { query: 'sleep spindle' }]]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].arxiv, '2610.01111');
  assert.equal(r.items[0].title, 'Spindles gate memory in sleeping mice');
  assert.match((await fetchSource(src, { fetch: routedFetch({}), profile: profile(), since: '2026-10-01' })).error, /not available/);
  const broken = { async call() { throw new Error('hf is not connected'); } };
  assert.match((await fetchSource(src, { fetch: routedFetch({}), hub: broken, profile: profile(), since: '2026-10-01' })).error, /not connected/);
});

test('parseMcpPapers reads JSON records, headed blocks and DOI lines', () => {
  assert.deepEqual(parseMcpPapers(JSON.stringify({ papers: [{ title: 'Json paper title', authors: [{ name: 'A B' }], arxivId: '2610.02222', publishedAt: '2026-10-02T00:00:00Z' }] })).map((p) => [p.title, p.arxiv, p.date, p.authors]), [['Json paper title', '2610.02222', '2026-10-02', ['A B']]]);
  const text = '## First heading paper\nsome words\n\n## Second paper\nDOI: 10.9999/inv.8.\n\nnothing here';
  assert.deepEqual(parseMcpPapers(text).map((p) => [p.title, p.doi]), [['First heading paper', null], ['Second paper', '10.9999/inv.8']]);
  assert.deepEqual(parseMcpPapers(''), []);
});

test('parseMcpPapers reads every row of the real Hugging Face table', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('./fixtures/hf-fs-papers-search.md', import.meta.url), 'utf8');
  const papers = parseMcpPapers(text);
  assert.equal(papers.length, (text.match(/^\| paper \|/gm) ?? []).length);
  assert.equal(papers.length, 100);
  for (const p of papers) {
    assert.ok(p.title);
    assert.match(p.arxiv, /^\d{4}\.\d{4,5}$/);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.abstract);
  }
  assert.equal(papers[0].title, 'Chemical and Electronic Repair Mechanism of Sulfur Defects in MoS_2 Monolayers');
  assert.equal(papers[0].date, '2017-10-09');
  assert.equal(papers[0].url, 'https://huggingface.co/papers/1710.03191');
  assert.match(papers[0].abstract, /^Using \{\\em ab initio\} density functional theory/);
});

test('parseMcpPapers reads plain column tables', () => {
  const t = '| Title | Date | URL | DOI |\n|---|---|---|---|\n| A plain table paper | 2026-10-03 | https://x.example/a | 10.1234/abc.5 |';
  assert.deepEqual(parseMcpPapers(t).map((p) => [p.title, p.date, p.url, p.doi]), [['A plain table paper', '2026-10-03', 'https://x.example/a', '10.1234/abc.5']]);
});

test('mcp source fills "{query}" deep inside args, and drops items older than since but keeps undated ones', async () => {
  const calls = [];
  const table = '| Title | Date | arXiv |\n|---|---|---|\n| Old paper from long ago | 2020-01-01 | 2001.00001 |\n| New paper from this week | 2026-10-05 | 2610.00002 |\n| Undated paper kept anyway | | 2610.00003 |';
  const hub = { async call(server, tool, args) { calls.push(args); return table; } };
  const src = { id: 'm', on: true, kind: 'mcp', server: 'hf', tool: 'hf_fs', args: { operations: [{ cmd: 'search', args: ['hf://papers', '{query}'] }], keep: 3 } };
  const r = await fetchSource(src, { fetch: routedFetch({}), hub, profile: profile(), since: '2026-10-01' });
  assert.deepEqual(calls, [{ operations: [{ cmd: 'search', args: ['hf://papers', 'sleep spindle'] }], keep: 3 }]);
  assert.deepEqual(r.items.map((i) => i.title), ['New paper from this week', 'Undated paper kept anyway']);
});
