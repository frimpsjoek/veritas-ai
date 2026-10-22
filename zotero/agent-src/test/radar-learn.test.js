// Spec 017 K2: a phrase becomes a search topic after 3 liked papers, weighs down on Not relevant, and undo is exact.
// Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFeedback, forgetLearned, mergeLearned } from '../src/radar-feedback.js';
import { emptyState, learningOf } from '../src/radar-state.js';
import { phraseKey, LEARNED_FLOOR, MAX_LEARNED } from '../src/radar-phrases.js';

const NOW = '2026-10-13T08:00:00.000Z';
const MOIRE = phraseKey('moiré excitons');
const side = ['flat bands and long lifetimes', 'a superlattice with tunable gaps', 'interlayer charge transfer', 'strain tuning of spectra', 'photoluminescence at low temperature', 'valley polarisation dynamics'];
const filler = ['Dormant volcanoes and basalt flows', 'Ant colonies forage along trails', 'Medieval tax records of towns', 'Kelp forests recover after removal', 'Glacier retreat by drone photogrammetry', 'Sourdough starters across bakeries', 'Tidal turbines and sediment', 'Owl pellets reveal vole cycles', 'Bridge cables corrode near marshes', 'Pollen records from peat cores'];

function world(count = 6, topic = 'moiré excitons') {
  const s = emptyState();
  const add = (id, title, text) => { s.shown[id] = { keys: [id], title, text, authors: [], venue: '', sources: ['database:openalex'] }; s.seen[id] = { at: NOW, verdict: 'shown' }; };
  for (let n = 1; n <= count; n++) add(`p${n}`, `Paper ${n} on ${topic}`, `Paper ${n} on ${topic}. We observe ${topic} with ${side[n - 1]}; the ${topic} are discussed.`);
  filler.forEach((t, i) => add(`f${i}`, t, `${t}. Field notes from the survey.`));
  return s;
}
const profile = () => ({ topics: [{ text: 'quantum dots', weight: 1, origin: 'user' }], authors: [], journals: [] });
const click = ({ state, profile: prof }, key, verdict) => applyFeedback({ state, profile: prof, key, verdict, now: NOW });
const snap = (o) => JSON.stringify({ state: { ...o.state, phrases: { ...o.state.phrases, learning: [...o.state.phrases.learning].sort((a, b) => (a.key < b.key ? -1 : 1)) } }, profile: o.profile });
const start = (count, topic) => ({ state: world(count, topic), profile: profile() });
const learnedTopics = (o) => o.profile.topics.filter((t) => t.origin === 'learned');

test('three liked papers make the phrase a learned topic; two do not; undo of the third takes it back (success check 1)', () => {
  let o = start();
  o = click(o, 'p1', 'added');
  o = click(o, 'p2', 'added');
  assert.equal(learnedTopics(o).length, 0, 'two papers are not enough');
  assert.equal(o.state.phrases.learning.find((c) => c.key === MOIRE).papers.length, 2);
  const two = snap(o);
  o = click(o, 'p3', 'later');
  const [topic] = learnedTopics(o);
  assert.equal(topic.text, 'moiré excitons');
  assert.equal(topic.papers, 3);
  assert.deepEqual(o.state.phrases.announce, ['moiré excitons']);
  assert.equal(o.state.phrases.learning.some((c) => c.key === MOIRE), false);
  o = click(o, 'p3', 'undo');
  assert.equal(JSON.stringify(o.profile), JSON.stringify(profile()), 'the topic is gone');
  assert.deepEqual(o.state.phrases.announce, []);
  assert.equal(snap(o), two, 'exactly the state after two papers');
});

test('a phrase already in the profile is strengthened, never duplicated, and undo puts the weight back', () => {
  const o = start(3);
  o.profile.topics.push({ text: 'excitons moiré', weight: 0.5, origin: 'user' });
  const a = click(o, 'p1', 'added');
  assert.equal(a.profile.topics.filter((t) => phraseKey(t.text) === MOIRE).length, 1);
  assert.ok(a.profile.topics[1].weight > 0.5);
  assert.equal(a.profile.topics[1].origin, 'user');
  assert.equal(JSON.stringify(click(a, 'p1', 'undo').profile), JSON.stringify(o.profile));
});

test('Not relevant drops a learned topic under the floor on the second paper, removes and blocks it on the third (success check 3)', () => {
  let o = start(6);
  for (const k of ['p1', 'p2', 'p3']) o = click(o, k, 'added');
  assert.equal(learnedTopics(o).length, 1);
  o = click(o, 'p4', 'dismissed');
  assert.ok(learnedTopics(o)[0].weight >= LEARNED_FLOOR);
  o = click(o, 'p5', 'dismissed');
  assert.ok(learnedTopics(o)[0].weight < LEARNED_FLOOR, 'no longer searched');
  const before = snap(o);
  o = click(o, 'p6', 'dismissed');
  assert.equal(learnedTopics(o).length, 0);
  assert.ok(o.state.phrases.blocked.includes(MOIRE));
  assert.deepEqual(o.profile.topics.map((t) => t.text), ['quantum dots'], 'the user topic is untouched');
  assert.equal(snap(click(o, 'p6', 'undo')), before, 'undo of the third drop brings it back exactly');
});

test('a blocked phrase is not learned again from three new liked papers', () => {
  let o = start(6);
  for (const k of ['p1', 'p2', 'p3']) o = click(o, k, 'added');
  for (const k of ['p4', 'p5', 'p6']) o = click(o, k, 'dismissed');
  const s = world(6);
  s.phrases = o.state.phrases;
  let again = { state: { ...s, seen: Object.fromEntries(Object.keys(s.seen).map((k) => [k, { at: NOW, verdict: 'shown' }])) }, profile: o.profile };
  for (const k of ['p1', 'p2', 'p3']) again = click(again, k, 'added');
  assert.equal(learnedTopics(again).length, 0);
  assert.equal(again.state.phrases.learning.some((c) => c.key === MOIRE), false);
});

test('Not relevant only lightens a user topic, never below the floor, and Undo restores it', () => {
  const o = start(3, 'quantum dots');
  const a = click(o, 'p1', 'dismissed');
  assert.ok(a.profile.topics[0].weight < 1 && a.profile.topics[0].weight >= 0.1);
  assert.equal(a.profile.topics.length, 1);
  assert.equal(JSON.stringify(click(a, 'p1', 'undo').profile), JSON.stringify(o.profile));
  let low = { state: o.state, profile: { ...o.profile, topics: [{ text: 'quantum dots', weight: 0.1, origin: 'user' }] } };
  low = click(low, 'p2', 'dismissed');
  assert.equal(low.profile.topics[0].weight, 0.1);
});

test('the 11th learned topic pushes out the weakest, and undo brings it back', () => {
  const o = start(3);
  for (let i = 0; i < MAX_LEARNED; i++) o.profile.topics.push({ text: `invented subject ${String.fromCharCode(97 + i)}${i}`, weight: i === 4 ? 0.3 : 0.6, origin: 'learned', papers: 3 });
  let c = click(o, 'p1', 'added');
  c = click(c, 'p2', 'added');
  c = click(c, 'p3', 'added');
  const names = learnedTopics(c).map((t) => t.text);
  assert.equal(names.length, MAX_LEARNED);
  assert.ok(names.includes('moiré excitons'));
  assert.ok(!names.includes('invented subject e4'), 'the weakest went');
  c = click(c, 'p3', 'undo');
  assert.ok(learnedTopics(c).some((t) => t.text === 'invented subject e4'));
  assert.ok(!learnedTopics(c).some((t) => t.text === 'moiré excitons'));
});

test('removing a learned chip drops the topic and blocks it; three new liked papers do not bring it back', () => {
  let o = start(6);
  for (const k of ['p1', 'p2', 'p3']) o = click(o, k, 'added');
  const gone = forgetLearned(o.state, o.profile, 'moiré excitons');
  assert.deepEqual(gone.profile.topics.map((t) => t.text), ['quantum dots']);
  assert.ok(gone.state.phrases.blocked.includes(MOIRE));
  assert.deepEqual(gone.state.phrases.announce, []);
  let again = { state: { ...gone.state, seen: Object.fromEntries(Object.keys(gone.state.seen).map((k) => [k, { at: NOW, verdict: 'shown' }])) }, profile: gone.profile };
  for (const k of ['p4', 'p5', 'p6']) again = click(again, k, 'later');
  assert.equal(learnedTopics(again).length, 0);
});

test('a save from an older form keeps what ratings learned since, unless it was removed on purpose', () => {
  let o = start(6);
  for (const k of ['p1', 'p2', 'p3']) o = click(o, k, 'added');
  const stale = { ...profile(), topics: [...profile().topics, { text: 'typed by hand', weight: 1, origin: 'user' }] };
  const kept = mergeLearned(o.profile, stale, []);
  assert.deepEqual(kept.topics.map((t) => t.text), ['quantum dots', 'typed by hand', 'moiré excitons']);
  assert.deepEqual(mergeLearned(o.profile, stale, [MOIRE]).topics.map((t) => t.text), ['quantum dots', 'typed by hand']);
  const typedOver = { ...profile(), topics: [{ text: 'excitons moiré', weight: 1, origin: 'user' }] };
  assert.equal(mergeLearned(o.profile, typedOver, []).topics.length, 1, 'the person\'s own topic wins over the learned one');
});

test('the learning list the UI shows keeps phrases from two papers or more, most first', () => {
  let o = start(6);
  for (const k of ['p1', 'p2']) o = click(o, k, 'added');
  const shown = learningOf(o.state);
  assert.deepEqual(shown[0], { text: 'moiré excitons', count: 2 });
  assert.ok(shown.every((s) => s.count >= 2));
});
