import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, WEIGHTS, nameKey } from '../src/radar-score.js';
import { normalise } from '../src/radar.js';
import { radarLibrary, profile } from './support/radar-fakes.mjs';

const item = (n, over = {}) => normalise({ title: `Study ${n} of cortical oscillations`, doi: `10.9999/inv.${n}`, authors: [], venue: '', abstract: '', ...over }, 's');
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
