// Spec 012 R4: what a click on a digest row changes in the radar's state and profile, and that undo puts it back exactly.
// Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFeedback, PROFILE_STEP } from '../src/radar-feedback.js';
import { emptyState } from '../src/radar-state.js';
import { WEIGHTS } from '../src/radar-score.js';

const NOW = '2026-10-11T08:00:00.000Z';
const paper = (n, over = {}) => ({ keys: [`doi:10.1/p${n}`, `title:invented paper number ${n} on voles`], title: `Invented paper number ${n} on voles`, text: `Invented paper number ${n} on voles. Burrows.`, authors: ['Jane Bramble', 'Omar Thistle'], venue: 'Journal of Invented Results', sources: ['database:arxiv'], ...over });

function stateWith(count, over = {}) {
  const s = emptyState();
  for (let n = 1; n <= count; n++) {
    const p = paper(n, over);
    s.shown[`doi:10.1/p${n}`] = p;
    for (const k of p.keys) s.seen[k] = { at: NOW, verdict: 'shown' };
  }
  s.sourceStatus['database:arxiv'] = { at: NOW, items: 9, error: null, quietRuns: 0 };
  return s;
}
const profile = () => ({ topics: [], authors: [{ name: 'Bramble, J.', openalexId: 'A1', weight: 1, origin: 'user' }], journals: [] });
const click = (state, prof, n, verdict) => applyFeedback({ state, profile: prof, key: `doi:10.1/p${n}`, verdict, now: NOW });
const verdictOf = (s, n) => s.seen[`doi:10.1/p${n}`].verdict;

test('Add records the verdict on every key, a positive example, and +0.05 for the authors and venue', () => {
  const out = click(stateWith(1), profile(), 1, 'added');
  assert.equal(out.changed, true);
  assert.equal(out.verdict, 'added');
  assert.equal(out.state.seen['title:invented paper number 1 on voles'].verdict, 'added');
  assert.deepEqual(out.state.examples.positive.map((e) => e.id), ['doi:10.1/p1']);
  assert.equal(out.state.examples.positive[0].text, 'Invented paper number 1 on voles. Burrows.');
  const [bramble, thistle] = out.profile.authors;
  assert.equal(bramble.weight, 1 + PROFILE_STEP, 'a followed author gains weight and keeps her origin');
  assert.equal(bramble.origin, 'user');
  assert.deepEqual([thistle.name, thistle.weight, thistle.origin, thistle.openalexId], ['Omar Thistle', PROFILE_STEP, 'learned', null]);
  assert.deepEqual(out.profile.journals, [{ name: 'Journal of Invented Results', openalexId: null, weight: PROFILE_STEP, origin: 'learned' }]);
  assert.deepEqual(out.state.learned.map((l) => [l.kind, l.name, l.created]), [['author', 'Jane Bramble', false], ['author', 'Omar Thistle', true], ['venue', 'Journal of Invented Results', true]]);
});

test('Read later is a positive example and learns nothing; Not relevant is a negative example', () => {
  const later = click(stateWith(2), profile(), 1, 'later');
  assert.equal(later.state.examples.positive.length, 1);
  assert.deepEqual(later.state.learned, []);
  assert.equal(later.profile.authors[0].weight, 1);
  const no = click(stateWith(2), profile(), 2, 'dismissed');
  assert.deepEqual(no.state.examples.negative.map((e) => e.id), ['doi:10.1/p2']);
  assert.deepEqual(no.state.examples.positive, []);
});

test('Like is a positive example that learns no author or venue; an unknown verdict is refused', () => {
  const liked = click(stateWith(2), profile(), 1, 'liked');
  assert.equal(liked.verdict, 'liked');
  assert.deepEqual(liked.state.examples.positive.map((e) => e.id), ['doi:10.1/p1']);
  assert.deepEqual(liked.state.learned, []);
  assert.equal(liked.profile.authors[0].weight, 1);
  assert.throws(() => click(stateWith(1), profile(), 1, 'loved'), /Unknown verdict "loved"/);
});

test('the same verdict twice changes nothing, and the input state is never mutated', () => {
  const start = stateWith(1);
  const frozen = JSON.stringify(start);
  const once = click(start, profile(), 1, 'added');
  assert.equal(JSON.stringify(start), frozen);
  const twice = click(once.state, once.profile, 1, 'added');
  assert.equal(twice.changed, false);
  assert.equal(twice.state, once.state);
  assert.equal(twice.profile, once.profile);
});

test('undo restores the state and the profile exactly, for each verdict', () => {
  for (const verdict of ['added', 'later', 'liked', 'dismissed']) {
    const start = stateWith(3);
    start.examples.positive.push({ id: 'doi:old', text: 'an earlier example', at: NOW });
    const prof = profile();
    const done = click(start, prof, 2, verdict);
    const back = click(done.state, done.profile, 2, 'undo');
    assert.equal(back.changed, true);
    assert.equal(back.verdict, 'shown');
    assert.deepEqual(back.state, start, `state after undoing ${verdict}`);
    assert.deepEqual(back.profile, prof, `profile after undoing ${verdict}`);
  }
});

test('undo with nothing to undo is a no-op', () => {
  const out = click(stateWith(1), profile(), 1, 'undo');
  assert.equal(out.changed, false);
  const done = click(stateWith(1), profile(), 1, 'dismissed');
  const back = click(done.state, done.profile, 1, 'undo');
  assert.equal(click(back.state, back.profile, 1, 'undo').changed, false, 'a second undo does nothing');
});

test('a paper the radar never showed is refused', () => {
  assert.throws(() => click(stateWith(1), profile(), 9, 'added'), /not one this radar has shown/);
  assert.throws(() => click(stateWith(1), profile(), 1, 'loved'), /Unknown verdict/);
});

test('examples are capped at WEIGHTS.exampleCap, newest kept, and undo gives back the one the cap pushed out', () => {
  let s = stateWith(WEIGHTS.exampleCap + 1);
  let p = profile();
  for (let n = 1; n <= WEIGHTS.exampleCap; n++) ({ state: s, profile: p } = click(s, p, n, 'dismissed'));
  assert.equal(s.examples.negative.length, WEIGHTS.exampleCap);
  const full = structuredClone(s);
  const over = click(s, p, WEIGHTS.exampleCap + 1, 'dismissed');
  assert.equal(over.state.examples.negative.length, WEIGHTS.exampleCap);
  assert.equal(over.state.examples.negative.at(-1).id, `doi:10.1/p${WEIGHTS.exampleCap + 1}`, 'the newest is kept');
  assert.equal(over.state.examples.negative[0].id, 'doi:10.1/p2', 'the oldest went');
  assert.deepEqual(click(over.state, over.profile, WEIGHTS.exampleCap + 1, 'undo').state, full);
});

test('an author added twice from two papers gains 0.10; undoing one takes back only its 0.05', () => {
  let s = stateWith(2, { authors: ['Omar Thistle'], venue: '' });
  let p = profile();
  ({ state: s, profile: p } = click(s, p, 1, 'added'));
  ({ state: s, profile: p } = click(s, p, 2, 'added'));
  assert.equal(p.authors.find((a) => a.name === 'Omar Thistle').weight, 0.1);
  ({ state: s, profile: p } = click(s, p, 1, 'undo'));
  assert.equal(p.authors.find((a) => a.name === 'Omar Thistle').weight, PROFILE_STEP);
  ({ state: s, profile: p } = click(s, p, 2, 'undo'));
  assert.equal(p.authors.some((a) => a.name === 'Omar Thistle'), false, 'the learned entry is gone once nothing supports it');
  assert.deepEqual(s.learned, []);
});

test('a paper with fifty authors teaches the first three and the last, not all fifty', () => {
  const authors = Array.from({ length: 50 }, (_, i) => `Author Number${i}`);
  const out = click(stateWith(1, { authors, venue: '' }), { topics: [], authors: [], journals: [] }, 1, 'added');
  assert.deepEqual(out.profile.authors.map((a) => a.name), ['Author Number0', 'Author Number1', 'Author Number2', 'Author Number49']);
});

test('three dismissals in a row from one source suggest removing it; an Add resets the count; undo takes the suggestion back', () => {
  let s = stateWith(5);
  let p = profile();
  ({ state: s, profile: p } = click(s, p, 1, 'dismissed'));
  ({ state: s, profile: p } = click(s, p, 2, 'dismissed'));
  assert.equal(s.sourceStatus['database:arxiv'].suggestRemove, undefined, 'two is not enough');
  ({ state: s, profile: p } = click(s, p, 3, 'later'));
  ({ state: s, profile: p } = click(s, p, 4, 'dismissed'));
  ({ state: s, profile: p } = click(s, p, 5, 'dismissed'));
  assert.equal(s.sourceStatus['database:arxiv'].suggestRemove, undefined, 'a Read later in between starts the count again');
  const more = stateWith(8);
  let a = more, b = profile();
  for (const n of [1, 2, 3]) ({ state: a, profile: b } = click(a, b, n, 'dismissed'));
  assert.equal(a.sourceStatus['database:arxiv'].suggestRemove, true);
  const undone = click(a, b, 3, 'undo');
  assert.equal(undone.state.sourceStatus['database:arxiv'].suggestRemove, undefined);
  assert.equal(undone.state.streaks['database:arxiv'], 2);
  const cleared = click(a, b, 4, 'added');
  assert.equal(cleared.state.sourceStatus['database:arxiv'].suggestRemove, undefined, 'adding a paper from that source takes the suggestion away');
});

test('changing a verdict takes the old one back first; undoing the change brings it back', () => {
  const start = stateWith(1);
  const prof = profile();
  const added = click(start, prof, 1, 'added');
  const flipped = click(added.state, added.profile, 1, 'dismissed');
  assert.deepEqual(flipped.state.examples.positive, [], 'no longer a positive example');
  assert.deepEqual(flipped.state.examples.negative.map((e) => e.id), ['doi:10.1/p1']);
  assert.deepEqual(flipped.state.learned, []);
  assert.deepEqual(flipped.profile, prof, 'the authors it had taught are forgotten');
  const back = click(flipped.state, flipped.profile, 1, 'undo');
  assert.equal(back.verdict, 'added');
  assert.deepEqual(back.state.examples.positive.map((e) => e.id), ['doi:10.1/p1']);
  assert.deepEqual(back.profile, added.profile);
  assert.deepEqual(click(back.state, back.profile, 1, 'undo').state, start);
});

test('a paper whose details were trimmed still takes a verdict, with nothing to learn from', () => {
  const s = stateWith(1);
  delete s.shown['doi:10.1/p1'];
  const out = click(s, profile(), 1, 'added');
  assert.equal(out.verdict, 'added');
  assert.deepEqual(out.state.examples.positive, []);
  assert.deepEqual(out.profile, profile());
});
