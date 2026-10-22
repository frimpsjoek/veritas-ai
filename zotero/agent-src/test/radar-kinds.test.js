import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource } from '../src/radar-sources.js';
import { collectRadar } from '../src/radar-run.js';
import { searchSource } from '../src/scholarly.js';
import { isNonPaper, RECORD_KINDS } from '../src/radar.js';
import { emptyState } from '../src/radar-state.js';
import { feedXml, res, routedFetch, radarLibrary, profile } from './support/radar-fakes.mjs';

const work = (n, type, extra = {}) => ({
  id: `https://openalex.org/W${n}`, doi: `https://doi.org/10.9999/inv.${n}`, display_name: `Invented ${type} number ${n} on spindles`, publication_date: '2026-10-03', publication_year: 2026,
  type, primary_location: { source: { display_name: 'J. Invented' }, landing_page_url: `https://journal.example/${n}` }, authorships: [], ...extra,
});
const openAlex = (works) => async () => res(200, JSON.stringify({ results: works }));
const db = { id: 'database:openalex', on: true, kind: 'database', db: 'openalex' };
const env = (fetchFn) => ({ fetch: fetchFn, profile: profile(), since: '2026-10-01' });

test('OpenAlex type survives as kind, and each non-paper kind is dropped and counted', async () => {
  const kept = ['article', 'preprint', 'review', 'book-chapter', 'proceedings'];
  const dropped = ['dataset', 'dissertation', 'other', 'paratext', 'peer-review', 'erratum', 'editorial', 'letter'];
  const works = [...kept, ...dropped].map((t, i) => work(i, t));
  const raw = await searchSource(openAlex(works), 'openalex', 'spindles', 20);
  assert.deepEqual(raw.map((r) => r.kind), [...kept, ...dropped]);
  const r = await fetchSource(db, env(openAlex(works)));
  assert.deepEqual(r.items.map((i) => i.kind), kept);
  assert.equal(r.skipped, dropped.length);
  assert.ok(dropped.every((k) => RECORD_KINDS[k] === false) && kept.every((k) => RECORD_KINDS[k]));
});

test('the R4 live examples, a Zenodo upload and a thesis dataset record, are dropped', async () => {
  const zenodo = work(1, 'article', { doi: 'https://doi.org/10.5281/zenodo.123', primary_location: { source: { display_name: 'Zenodo (CERN European Organization for Nuclear Research)' }, landing_page_url: 'https://zenodo.org/records/123' } });
  const dataset = work(2, 'dataset', { display_name: 'Dataset supporting the thesis "Spindles in sleep"' });
  const repo = work(3, 'article', { primary_location: { source: { display_name: 'University of Invented Research Repository' }, landing_page_url: 'https://repo.example/3' } });
  const figshare = work(4, 'article', { doi: 'https://doi.org/10.6084/m9.figshare.9', primary_location: { source: null, landing_page_url: 'https://figshare.com/articles/9' } });
  const real = work(5, 'article');
  const r = await fetchSource({ id: 'journal:S1', on: true, kind: 'journal', openalexId: 'S1', name: 'J', issn: null }, env(openAlex([zenodo, dataset, repo, figshare, real])));
  assert.deepEqual(r.items.map((i) => i.doi), ['10.9999/inv.5']);
  assert.equal(r.skipped, 4);
});

test('Crossref types map onto the same words; arXiv rows are preprints', async () => {
  const cr = (type) => ({ DOI: '10.9999/c.1', title: ['A Crossref record about spindles'], type, URL: 'https://doi.org/10.9999/c.1', issued: { 'date-parts': [[2026, 10, 3]] } });
  const [a] = await searchSource(async () => res(200, JSON.stringify({ message: { items: [cr('journal-article')] } })), 'crossref', 'x', 5);
  const [b] = await searchSource(async () => res(200, JSON.stringify({ message: { items: [cr('dissertation')] } })), 'crossref', 'x', 5);
  assert.equal(a.kind, 'article');
  assert.equal(b.kind, 'dissertation');
  const xml = '<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>An arXiv paper about spindles</title><summary>s</summary><published>2026-10-02T00:00:00Z</published></entry></feed>';
  const [c] = await searchSource(async () => res(200, xml), 'arxiv', 'spindles sleep', 5);
  assert.equal(c.kind, 'preprint');
});

test('a feed item and an MCP row without a type are kept, even from a repository', async () => {
  const xml = feedXml([{ title: 'Spindle study kept from a feed', link: 'https://zenodo.org/records/9' }]);
  const r = await fetchSource({ id: 'f', on: true, kind: 'feed', url: 'https://f.example/feed', title: 'Zenodo feed' }, env(routedFetch({ 'https://f.example/feed': res(200, xml) })));
  assert.equal(r.items.length, 1);
  assert.equal(r.skipped, 0);
  assert.equal(isNonPaper({ kind: null, venue: '', doi: null, url: 'https://x.example/1' }), false);
  assert.equal(isNonPaper({ kind: 'monograph-unknown', venue: 'Press', doi: null, url: null }), false, 'unknown kinds are kept');
});

test('a run records the skipped count on each source status', async () => {
  const works = [work(1, 'article'), work(2, 'dataset'), work(3, 'dissertation')];
  const out = await collectRadar({
    config: { scope: { kind: 'library' }, profile: profile(), sources: [db], size: { fresh: 8, older: 0 }, note: false },
    since: '2026-10-01', now: '2026-10-11T00:00:00Z', fetch: openAlex(works), library: radarLibrary(), state: emptyState(),
  });
  assert.equal(out.state.sourceStatus['database:openalex'].skipped, 2);
  assert.equal(out.state.sourceStatus['database:openalex'].items, 1);
  assert.equal(out.picked.length, 1);
});
