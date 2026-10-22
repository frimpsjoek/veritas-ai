// Spec 017 K4 (engine side): what the radar says about a learned topic. Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../src/radar-score.js';
import { whyLines, learnedLine } from '../src/radar-why.js';
import { summaryLine } from '../src/radar-digest.js';
import { fromOpenAlex } from '../src/scholarly.js';
import { normalise } from '../src/radar.js';
import { collectRadar } from '../src/radar-run.js';
import { emptyState } from '../src/radar-state.js';
import { res, routedFetch, radarLibrary } from './support/radar-fakes.mjs';

const item = (id, title, abstract) => ({ id, doi: null, arxiv: null, openalexId: null, title, authors: [], venue: '', date: null, year: 2026, abstract, url: `https://x.example/${id}`, links: [], sources: ['database:openalex'] });
const profile = () => ({ topics: [{ text: 'quantum dots', weight: 1, origin: 'user' }, { text: 'moiré excitons', weight: 0.6, origin: 'learned', papers: 3 }], authors: [], journals: [] });

test('a row that matches a learned topic carries it in why.learned; one that matches only your topic does not', async () => {
  const rows = await score([item('a', 'Moiré excitons in twisted layers', 'We map moiré excitons.'), item('b', 'Quantum dots for sensing', 'Quantum dots again.')], { backend: radarLibrary(), collections: null, profile: profile(), state: emptyState() });
  assert.equal(rows.find((r) => r.id === 'a').why.learned, 'moiré excitons');
  assert.equal(rows.find((r) => r.id === 'b').why.learned, undefined);
});

test('the why-line names the learned topic, with or without a model line or an abstract', async () => {
  const a = { ...item('a', 'Moiré excitons in twisted layers', 'We map moiré excitons.'), why: { learned: 'moiré excitons' } };
  const bare = { ...item('c', 'Moiré excitons, no abstract', ''), why: { learned: 'moiré excitons' } };
  const plain = item('b', 'Quantum dots for sensing', 'Quantum dots again.');
  const out = await whyLines([a, bare, plain], { topics: [], turn: async () => ({ lines: [{ n: 1, line: 'Maps the excitons.' }, { n: 2, line: 'Senses with dots.' }] }) });
  assert.equal(out.lines.get('a'), `${learnedLine('moiré excitons')} Maps the excitons.`);
  assert.equal(out.lines.get('c'), learnedLine('moiré excitons'));
  assert.equal(out.lines.get('b'), 'Senses with dots.');
  const failed = await whyLines([a], { topics: [], turn: async () => { throw new Error('offline'); } });
  assert.equal(failed.lines.get('a'), learnedLine('moiré excitons'));
  assert.equal(failed.error, 'offline');
});

test('the digest summary says what is newly searched', () => {
  const cfg = { sources: [] };
  const run = { news: 3, older: 0, answered: 2, failed: [] };
  assert.equal(summaryLine({ ...run, learned: ['moiré excitons', 'spin liquids'] }, cfg), '3 new from 2 sources · Now also searching: moiré excitons, spin liquids');
  assert.equal(summaryLine(run, cfg), '3 new from 2 sources');
});

test('OpenAlex keywords travel from the work to the shown paper that feedback learns from', async () => {
  const raw = fromOpenAlex({ id: 'https://openalex.org/W1', display_name: 'Moiré study', keywords: [{ display_name: 'Moiré excitons' }, { display_name: 'Twistronics' }] });
  assert.deepEqual(raw.keywords, ['Moiré excitons', 'Twistronics']);
  assert.deepEqual(normalise(raw, 's').keywords, ['Moiré excitons', 'Twistronics']);
  assert.equal(fromOpenAlex({ id: 'W2', display_name: 'No keywords' }).keywords, undefined);
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>Moiré excitons mapped</title><link>https://f.example/1</link><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate><description>Moiré excitons mapped in bilayers.</description></item></channel></rss>`;
  const out = await collectRadar({
    config: { scope: { kind: 'library' }, profile: profile(), sources: [{ id: 'f', on: true, kind: 'feed', url: 'https://f.example/feed', title: 'f' }], size: { fresh: 5, older: 0, discover: 0 }, note: false },
    since: '2026-10-01', now: '2026-10-13T07:00:00.000Z', fetch: routedFetch({ 'https://f.example/feed': res(200, feed) }), library: radarLibrary(), state: emptyState(),
  });
  assert.equal(out.picked[0].why.learned, 'moiré excitons');
});
