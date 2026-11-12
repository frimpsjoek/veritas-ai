import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, hubOnly, WEIGHTS, nameKey } from '../src/radar-score.js';
import { normalise } from '../src/radar.js';
import { radarLibrary, profile } from './support/radar-fakes.mjs';

const item = (n, over = {}) => normalise({ title: `Study ${n} of cortical oscillations`, doi: `10.9999/inv.${n}`, authors: [], venue: '', abstract: 'Invented recordings.', ...over }, 's');
const ctx = (backend, over = {}) => ({ backend, collections: null, profile: profile({ topics: [] }), state: { examples: { positive: [], negative: [] } }, ...over });

test('score is similarity plus the bonuses, and every part is kept on the row', async () => {
  const items = [
    item(1, { authors: ['Jane Q. Doe'], venue: 'Journal of Invented Results', title: 'Sleep spindle dynamics in the thalamus', abstract: 'Spindle bursts.' }),
    item(2),
  ];
  const lib = radarLibrary({ sim: () => 0.9 });
  const out = await score(items, ctx(lib, {
    profile: profile({ topics: [{ text: 'sleep spindle', weight: 2, origin: 'user' }], authors: [{ name: 'Doe, J.', openalexId: null, weight: 1, origin: 'user' }], journals: [{ name: 'journal of invented results', openalexId: null, weight: 1, origin: 'user' }] }),
  }));
  const [a, b] = out;
  assert.deepEqual(a.why, { similarity: 0.9, author: WEIGHTS.followedAuthor, journal: WEIGHTS.watchedJournal, topic: WEIGHTS.topicMatch * 2, negative: 0 });
  assert.ok(Math.abs(a.score - (0.9 + WEIGHTS.followedAuthor + WEIGHTS.watchedJournal + WEIGHTS.topicMatch * 2)) < 1e-9);
  assert.deepEqual(b.why, { similarity: 0.9, author: 0, journal: 0, topic: 0, negative: 0 });
  assert.equal(lib.calls.score[0].items.length, 2, 'one scoring call for the whole run');
});

test('the negative penalty starts at 0.8 closeness and is the full weight at 1.0', async () => {
  const lib = radarLibrary({ sim: () => 1, neg: (t) => (/Study 1 /.test(t) ? 0.9 : /Study 2 /.test(t) ? 1 : 0.7) });
  const out = await score([item(1), item(2), item(3)], ctx(lib));
  const by = Object.fromEntries(out.map((r) => [r.doi, r.why.negative]));
  assert.equal(by['10.9999/inv.1'], -0.15);
  assert.equal(by['10.9999/inv.2'], -WEIGHTS.negativePenalty);
  assert.equal(by['10.9999/inv.3'], 0);
});

test('rows under the floor are dropped', async () => {
  const out = await score([item(1), item(2)], ctx(radarLibrary({ sim: (t) => (/Study 1 /.test(t) ? WEIGHTS.floor : WEIGHTS.floor - 0.01) })));
  assert.deepEqual(out.map((r) => r.doi), ['10.9999/inv.1']);
});

test('names match across "Smith, J.", "J. Smith" and "Jane Smith"; accents fold', () => {
  assert.equal(nameKey('Smith, J.'), nameKey('J. Smith'));
  assert.equal(nameKey('Jane Smith'), nameKey('Smith, Jane'));
  assert.equal(nameKey('José Ñandú'), nameKey('Jose Nandu'));
  assert.notEqual(nameKey('Jane Smith'), nameKey('Bob Smith'));
});

test('followed authors and journals from switched-on sources count like profile entries', async () => {
  const out = await score([item(1, { authors: ['Ann Author'], venue: 'Invented Letters' })], ctx(radarLibrary({ sim: () => 0.9 }), { watched: { authors: ['Author, A.'], journals: ['Invented Letters'] } }));
  assert.equal(out[0].why.author, WEIGHTS.followedAuthor);
  assert.equal(out[0].why.journal, WEIGHTS.watchedJournal);
});

test('spec check 7: 10 dismissals near one topic push that topic out of the top 10', async () => {
  const topicA = (n) => item(100 + n, { title: `Perovskite film number ${n} stability`, abstract: 'perovskite solar cell film' });
  const topicB = (n) => item(200 + n, { title: `Spindle burst number ${n} timing`, abstract: 'sleep spindle burst' });
  const items = [...Array.from({ length: 10 }, (_, i) => topicA(i)), ...Array.from({ length: 10 }, (_, i) => topicB(i))];
  // topic A is slightly closer to the library, so it wins the top 10 until the user dismisses it
  const lib = radarLibrary({ sim: (t) => (/perovskite/i.test(t) ? 0.92 : 0.9) });
  const state = (negatives) => ({ examples: { positive: [], negative: negatives } });
  const top10 = async (negatives) => (await score(items, ctx(lib, { state: state(negatives) }))).slice(0, 10);

  const before = await top10([]);
  assert.equal(before.filter((r) => /perovskite/i.test(r.title)).length, 10);

  const dismissed = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, text: `Perovskite film paper ${i}: perovskite solar cell film`, at: 'x' }));
  const after = await top10(dismissed);
  assert.equal(after.filter((r) => /perovskite/i.test(r.title)).length, 0, 'none of the dismissed topic is left in the top 10');
  assert.equal(lib.calls.score.at(-1).negatives.length, 10, 'the examples reach the scorer');
});

test('more items than one server call takes are scored in batches, and every item gets its score', async () => {
  const calls = [];
  const backend = { async radarScore(q) { calls.push(q.items.length); return Object.fromEntries(q.items.map((i) => [i.id, { similarity: 0.9, negative: 0 }])); } };
  const items = Array.from({ length: 1200 }, (_, n) => item(n));
  const out = await score(items, ctx(backend));
  assert.deepEqual(calls, [500, 500, 200]);
  assert.equal(out.length, 1200);
  assert.ok(out.every((it) => it.why.similarity === 0.9));
});

test('a paper with no abstract is discounted, not dropped, and its why says it was judged on its title only', async () => {
  const lib = radarLibrary({ sim: () => 0.85 });
  const [read, bare] = await score([item(1), item(2, { abstract: '' })], ctx(lib));
  assert.equal(read.why.titleOnly, undefined);
  assert.equal(bare.why.titleOnly, -WEIGHTS.titleOnly);
  assert.equal(bare.why.similarity, 0.85, 'the plain similarity is still what people read');
  assert.ok(Math.abs(bare.score - (0.85 - WEIGHTS.titleOnly)) < 1e-9);
  const floor = await score([item(3, { abstract: '' })], ctx(radarLibrary({ sim: () => WEIGHTS.floor + WEIGHTS.titleOnly / 2 })));
  assert.deepEqual(floor, [], 'a title alone must clear the floor by the discount');
});

test('a seed radar keeps a title-only paper only when its margin clears the cut by the discount', async () => {
  const backend = { async radarScore(q) { return Object.fromEntries(q.items.map((i) => [i.id, { similarity: 0, negative: 0, seed_max: 0.8, seed_raw: 0.8, seed_best: 'zotero/S1' }])); } };
  const seeds = { keys: ['S1'], collections: [], texts: [] };
  const out = await score([item(1), item(2, { abstract: '' })], ctx(backend, { seeds, cut: 0.75 }));
  assert.deepEqual(out.map((r) => r.doi), ['10.9999/inv.1']);
  assert.equal((await score([item(2, { abstract: '' })], ctx(backend, { seeds, cut: 0.7 })))[0].why.titleOnly, -WEIGHTS.titleOnly);
});

test('a followed author with a full given name is not any namesake with the same initial; an initial-only side still matches', async () => {
  const { sameName } = await import('../src/radar-score.js');
  assert.ok(sameName('Zhen-Fei Liu', 'Z. Liu'));
  assert.ok(sameName('Liu, Zhen-Fei', 'Zhen-Fei Liu'));
  assert.ok(!sameName('Zhen-Fei Liu', 'Zhao Liu'));
  assert.ok(!sameName('Zhen-Fei Liu', 'Zhen Liu'));
  const lib = radarLibrary({ sim: () => 0.9 });
  const prof = profile({ topics: [], authors: [{ name: 'Zhen-Fei Liu', openalexId: null, weight: 1, origin: 'user' }] });
  const by = Object.fromEntries((await score([item(1, { authors: ['Zhao Liu'] }), item(2, { authors: ['Z. Liu'] })], ctx(lib, { profile: prof }))).map((r) => [r.doi, r.why.author]));
  assert.equal(by['10.9999/inv.1'], 0, 'a namesake with another given name');
  assert.equal(by['10.9999/inv.2'], WEIGHTS.followedAuthor, 'an initial still matches');
});

test('a topic matches on its content words, not on "for" or "and"', async () => {
  const prof = profile({ topics: [{ text: 'AI agents for science', weight: 1, origin: 'user' }] });
  const by = Object.fromEntries((await score([item(1, { title: 'Agents for software engineering', abstract: 'agents for code' }), item(2, { title: 'AI agents for science labs', abstract: 'agents run science experiments' })], ctx(radarLibrary({ sim: () => 0.9 }), { profile: prof }))).map((r) => [r.doi, r.why.topic]));
  assert.equal(by['10.9999/inv.1'], 0, '"agents" and "for" alone are not the topic');
  assert.equal(by['10.9999/inv.2'], WEIGHTS.topicMatch);
});

test('a calibrated seed radar sizes the bonuses to the margin past its bar', async () => {
  const { BAR_WEIGHTS } = await import('../src/radar-score.js');
  const backend = { async radarScore(q) { return Object.fromEntries(q.items.map((i) => [i.id, { similarity: 0, negative: 0.9, seed_max: 0.15, seed_raw: 0.8, seed_best: 'zotero/S1' }])); } };
  const prof = profile({ topics: [{ text: 'sleep spindle', weight: 1, origin: 'user' }], authors: [{ name: 'Jane Doe', openalexId: null, weight: 1, origin: 'user' }], journals: [{ name: 'Journal of Invented Results', openalexId: null, weight: 1, origin: 'user' }] });
  const it = item(1, { authors: ['Jane Doe'], venue: 'Journal of Invented Results', title: 'Sleep spindle dynamics', abstract: 'spindle' });
  const [row] = await score([it], ctx(backend, { profile: prof, seeds: { keys: ['S1'], collections: [], texts: [] }, cut: 0.1, baseline: { labels: ['zotero/S1'], abstract: [0.6], full: [0.6] }, rankBar: 0.1 }));
  assert.deepEqual([row.why.author, row.why.journal, row.why.topic, row.why.negative], [BAR_WEIGHTS.followedAuthor, BAR_WEIGHTS.watchedJournal, BAR_WEIGHTS.topicMatch, -0.193]);
  assert.ok(Math.abs(row.score - (0.05 + 0.02 + 0.01 + 0.01 - 0.193)) < 1e-9);
});

test('a paper only one seed likes is a broad seed winning by default, unless a topic says so or that seed stands alone', () => {
  const row = (seed, text = 'a harness for software agents') => ({ title: 'Invented paper', abstract: text, why: { seed: { label: 'zotero/S1', title: 's', whole: true, margin: 0.1, ...seed } } });
  const topics = [{ text: 'quantum dot theory', weight: 1, origin: 'user' }, { text: 'AI agents for science', weight: 1, origin: 'user' }, { text: 'X-ray absorption spectroscopy simulation', weight: 1, origin: 'user' }];
  assert.ok(hubOnly(row({ second: 0.06 }), topics), 'gap 0.04');
  assert.ok(!hubOnly(row({ second: 0.08 }), topics), 'a second seed agrees');
  assert.ok(!hubOnly(row({}), topics), 'one seed, or a server that does not say');
  assert.ok(!hubOnly(row({ second: 0.01, lonely: true }), topics), 'a single-seed interest survives');
  assert.ok(!hubOnly(row({ second: 0.01 }, 'theory of colloidal quantum dots'), topics), 'a topic matches, plural or not');
  assert.ok(!hubOnly(row({ second: 0.01 }, 'simulation of x-ray absorption near the edge'), topics), 'three words of four is the topic');
  assert.ok(!hubOnly(row({ second: 0.01 }, 'ai agents run science experiments'), topics));
  assert.ok(hubOnly(row({ second: 0.01 }, 'agents for science, in general'), topics), 'two words of three are not');
});
