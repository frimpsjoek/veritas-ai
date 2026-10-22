import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchScholarly } from '../src/scholarly.js';

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const text = (body) => ({ ok: true, status: 200, text: async () => body });

test('OpenAlex abstracts are rebuilt from the positions index, in word order', async () => {
  const fetchFn = async () => json({ results: [{ display_name: 'A paper', doi: 'https://doi.org/10.1/x', abstract_inverted_index: { Electrons: [0], flow: [1, 4], through: [2], the: [3], wire: [5] } }] });
  const [paper] = await searchScholarly(fetchFn, 'wire', { sources: ['openalex'] });
  assert.equal(paper.abstract, 'Electrons flow through the flow wire');
});

test('a paper with no abstract gets an empty string, not undefined', async () => {
  const fetchFn = async () => json({ results: [{ display_name: 'Bare', doi: null }] });
  const [paper] = await searchScholarly(fetchFn, 'bare', { sources: ['openalex'] });
  assert.equal(paper.abstract, '');
});

test('arXiv carries its summary', async () => {
  const xml = '<feed><entry><id>http://arxiv.org/abs/1234.5678v2</id><title>T</title><summary>  Spaced\n summary. </summary><published>2020-01-01</published><author><name>A B</name></author></entry></feed>';
  const [paper] = await searchScholarly(async () => text(xml), 'spaced summary', { sources: ['arxiv'] });
  assert.equal(paper.abstract, 'Spaced summary.');
});

test('Europe PMC and Crossref markup is stripped from abstracts', async () => {
  const pmc = json({ resultList: { result: [{ title: 'E', abstractText: '<h4>Abstract</h4><p>Cells <i>grow</i>.</p>', pubYear: '2021' }] } });
  const [e] = await searchScholarly(async () => pmc, 'cells', { sources: ['europepmc'] });
  assert.equal(e.abstract, 'Cells grow.');
  const cr = json({ message: { items: [{ title: ['C'], DOI: '10.2/c', abstract: '<jats:p>Plain words.</jats:p>' }] } });
  const [c] = await searchScholarly(async () => cr, 'plain', { sources: ['crossref'] });
  assert.equal(c.abstract, 'Plain words.');
});

import { abstractsByDoi } from '../src/scholarly.js';
import { withIndexAbstracts } from '../src/review2.js';

const LONG = 'Electrons flow through a single wire, and measured conductance depends strongly on how each molecule binds nearby gold electrodes.';
const index = Object.fromEntries(LONG.split(' ').map((w, i) => [w, [i]]));

test('abstractsByDoi asks OpenAlex once per 50 DOIs and keys the result by lower-cased DOI', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return json({ results: [{ doi: 'https://doi.org/10.1/ABC', abstract_inverted_index: index }, { doi: 'https://doi.org/10.1/none', abstract_inverted_index: null }] }); };
  const dois = Array.from({ length: 60 }, (_, i) => `10.1/d${i}`).concat(['https://doi.org/10.1/ABC', '10.1/d3']);
  const found = await abstractsByDoi(fetchFn, dois);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('filter=doi:10.1%2Fd0|'));
  assert.equal(found.get('10.1/abc'), LONG);
  assert.equal(found.has('10.1/none'), false);
});

test('abstractsByDoi swallows a failing index and returns what it has', async () => {
  const found = await abstractsByDoi(async () => ({ ok: false, status: 500, json: async () => ({}) }), ['10.1/x']);
  assert.equal(found.size, 0);
});

test('withIndexAbstracts replaces an outside paper\'s copied abstract with the index text, marked "source"', async () => {
  const rows = [
    { id: 'a', inLibrary: false, doi: '10.1/ABC', abstract: 'a model wrote this', abstractStatus: 'unverified' },
    { id: 'b', inLibrary: true, doi: '10.1/abc', abstract: 'library text', abstractStatus: 'library' },
    { id: 'c', inLibrary: false, doi: null, abstract: '', abstractStatus: 'none' },
    { id: 'd', inLibrary: false, doi: '10.9/missing', abstract: '', abstractStatus: 'none' },
  ];
  const lookup = async (dois) => { assert.deepEqual(dois, ['10.1/ABC', '10.9/missing']); return new Map([['10.1/abc', LONG]]); };
  const out = await withIndexAbstracts(rows, lookup);
  assert.deepEqual([out[0].abstract, out[0].abstractStatus], [LONG, 'source']);
  assert.equal(out[1].abstract, 'library text');
  assert.equal(out[2].abstractStatus, 'none');
  assert.equal(out[3].abstractStatus, 'none');
  assert.equal(await withIndexAbstracts(rows, undefined), rows);
  assert.equal((await withIndexAbstracts(rows, async () => { throw new Error('down'); }))[0].abstract, 'a model wrote this');
});

// ---------- `since` (spec 011 U4) ----------

function capture(body) {
  const urls = [];
  const fetchFn = async (url) => { urls.push(String(url)); return body; };
  return { urls, fetchFn };
}

test('since adds each source\'s own date filter', async () => {
  const cases = [
    ['openalex', json({ results: [] }), (u) => assert.ok(u.includes('&filter=from_publication_date:2026-05-01&'), u)],
    ['chemrxiv', json({ results: [] }), (u) => assert.ok(/filter=primary_location\.source\.id:S\d+,from_publication_date:2026-05-01&/.test(u), u)],
    ['crossref', json({ message: { items: [] } }), (u) => assert.ok(u.endsWith(',from-pub-date:2026-05-01'), u)],
    ['europepmc', json({ resultList: { result: [] } }), (u) => assert.ok(u.includes(encodeURIComponent('(cells) AND FIRST_PDATE:[2026-05-01 TO *]')), u)],
    ['biorxiv', json({ resultList: { result: [] } }), (u) => assert.ok(u.includes(encodeURIComponent('FIRST_PDATE:[2026-05-01 TO *]')) && u.includes(encodeURIComponent('SRC:PPR')), u)],
    ['semanticscholar', json({ data: [] }), (u) => assert.ok(u.includes('&publicationDateOrYear=2026-05-01:&'), u)],
    ['arxiv', text('<feed></feed>'), (u) => assert.ok(u.includes('+AND+submittedDate:[202605010000+TO+209912312359]'), u)],
  ];
  for (const [source, body, check] of cases) {
    const { urls, fetchFn } = capture(body);
    await searchScholarly(fetchFn, 'cells', { sources: [source], since: '2026-05-01' });
    assert.equal(urls.length, 1, source);
    check(urls[0]);
  }
});

test('without since (or with a malformed one) the URLs are exactly what they were', async () => {
  for (const source of ['openalex', 'chemrxiv', 'crossref', 'europepmc', 'biorxiv', 'semanticscholar', 'arxiv']) {
    const a = capture(json({ results: [], message: { items: [] }, resultList: { result: [] }, data: [], text: '' }));
    const b = capture(json({ results: [], message: { items: [] }, resultList: { result: [] }, data: [], text: '' }));
    const c = capture(json({ results: [], message: { items: [] }, resultList: { result: [] }, data: [], text: '' }));
    await searchScholarly(a.fetchFn, 'cells', { sources: [source] });
    await searchScholarly(b.fetchFn, 'cells', { sources: [source], since: 'yesterday' });
    await searchScholarly(c.fetchFn, 'cells', { sources: [source], since: undefined });
    assert.deepEqual(b.urls, a.urls, source);
    assert.deepEqual(c.urls, a.urls, source);
    assert.ok(!/since|from_publication_date|from-pub-date|FIRST_PDATE|publicationDateOrYear|submittedDate/.test(a.urls[0]), source);
  }
});

test('the unfiltered URLs are pinned', async () => {
  const oa = capture(json({ results: [] }));
  await searchScholarly(oa.fetchFn, 'wire', { sources: ['openalex'], limit: 5 });
  assert.match(oa.urls[0], /^https:\/\/api\.openalex\.org\/works\?search=wire&per_page=5&select=/);
  const cr = capture(json({ message: { items: [] } }));
  await searchScholarly(cr.fetchFn, 'wire', { sources: ['crossref'], limit: 5 });
  assert.equal(cr.urls[0], 'https://api.crossref.org/works?query=wire&rows=5&filter=type:journal-article,type:posted-content,type:proceedings-article,type:book-chapter,type:book');
});
