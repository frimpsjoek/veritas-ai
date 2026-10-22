// Spec 012 R4: the why lines and the digest's words, without a runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whyLines, whyPrompt, MAX_WHY_ROWS } from '../src/radar-why.js';
import { summaryLine, digestFile, digestMarkdown } from '../src/radar-digest.js';

const item = (n, over = {}) => ({ id: `doi:10.1/${n}`, doi: `10.1/${n}`, arxiv: null, title: `Invented paper ${n}`, authors: [], venue: '', date: null, year: 2026, abstract: `Abstract ${n}.`, url: null, links: [], sources: [], ...over });
const config = { sources: [{ id: 'database:chemrxiv', on: true, kind: 'database', db: 'chemrxiv' }, { id: 'feed:https://a.example/rss', on: true, kind: 'feed', url: 'https://a.example/rss', title: 'Nature Invented' }] };

test('at most 20 rows are sent, abstracts only; lines map back by number; junk entries are ignored', async () => {
  const items = Array.from({ length: 30 }, (_, i) => item(i + 1));
  let prompt = '';
  const { lines, error } = await whyLines(items, { topics: ['voles'], turn: async (p) => { prompt = p; return { lines: [{ n: 1, line: '  First   line. ' }, { n: 21, line: 'beyond the cap' }, { n: 2, line: '' }, { n: 'x', line: 'no number' }, { n: 3, line: 'x'.repeat(500) }] }; } });
  assert.equal(error, null);
  assert.equal((prompt.match(/### Paper/g) ?? []).length, MAX_WHY_ROWS);
  assert.doesNotMatch(prompt, /Invented paper 21\b/);
  assert.equal(lines.get('doi:10.1/1'), 'First line.');
  assert.equal(lines.has('doi:10.1/2'), false);
  assert.equal(lines.get('doi:10.1/3').length, 220);
  assert.equal(lines.size, 2);
});

test('no row with an abstract means no model call; a throwing model gives no lines and an error', async () => {
  let calls = 0;
  const none = await whyLines([item(1, { abstract: '' })], { topics: [], turn: async () => { calls++; return {}; } });
  assert.equal(calls, 0);
  assert.equal(none.lines.size, 0);
  const failed = await whyLines([item(1)], { topics: [], turn: async () => { throw new Error('rate limited'); } });
  assert.equal(failed.lines.size, 0);
  assert.equal(failed.error, 'rate limited');
  assert.match(whyPrompt([item(1)], []), /- \(not stated\)/);
});

test('summaryLine: counts, singulars, Worth reading only when there is some, failures by plain name', () => {
  assert.equal(summaryLine({ news: 14, older: 5, answered: 6, failed: [{ source: 'database:chemrxiv', error: 'timeout' }] }, config), '14 new from 6 sources · 5 worth reading · chemRxiv failed (timeout)');
  assert.equal(summaryLine({ news: 1, older: 0, answered: 1, failed: [] }, config), '1 new from 1 source');
  assert.equal(summaryLine({ news: 2, older: 0, answered: 2, failed: [{ source: 'feed:https://a.example/rss', error: 'HTTP 403.' }, { source: 'database:gone', error: 'x' }] }, config), '2 new from 2 sources · Nature Invented failed (HTTP 403), database:gone failed (x)');
});

test('digestFile keeps to what the server allows; digestMarkdown is a reading list, one entry per paper', () => {
  assert.equal(digestFile('2026-10-11', 'Sleep: radar/1 <b>'), '2026-10-11 Sleep radar 1 b');
  assert.equal(digestFile('2026-10-11', '///'), '2026-10-11 Reading radar');
  const md = digestMarkdown({ name: 'N', date: '2026-10-11', summary: 'S', lines: new Map([['doi:10.1/1', 'a | b']]), older: [], news: [item(1, { title: 'A [x] | y', authors: ['A', 'B', 'C', 'D'], venue: 'PubMed', date: '2026-10-10', url: 'https://e.example/a_(1)' })] });
  assert.equal(md, '# N, 2026-10-11\n\n*S*\n\n## New\n\n### [A x | y](https://doi.org/10.1/1)\n*A, B, C +1 · PubMed · 2026-10-10*\n\na | b\n');
  assert.doesNotMatch(md, /^\|/m, 'no table rows');
  assert.doesNotMatch(md, /Worth reading/);
  const older = digestMarkdown({ name: 'N', date: 'd', summary: 'S', lines: new Map(), news: [], older: [item(2, { doi: null, url: null, reason: 'Cited by 9 of your papers' })] });
  assert.match(older, /## Worth reading\n\n### Invented paper 2\nCited by 9 of your papers\n/);
});
