// Spec 017 K1: key phrases out of liked papers, learned without a model. Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhrases, phraseKey, carries } from '../src/radar-phrases.js';
import { applyFeedback } from '../src/radar-feedback.js';
import { emptyState } from '../src/radar-state.js';

const NOW = '2026-10-13T08:00:00.000Z';
const abstracts = [
  'We study moiré excitons in twisted bilayers. The moiré excitons show flat bands and long lifetimes under strain.',
  'Optical spectra reveal moiré excitons trapped in a superlattice of twisted bilayers with tunable gaps.',
  'A theory of moiré excitons explains interlayer charge transfer in heterostructures of layered crystals.',
];
const filler = ['Dormant volcanoes and basalt flows in the Azores', 'Ant colonies forage along pheromone trails near streams', 'Medieval tax records of Flemish towns', 'Kelp forests recover after urchin removal', 'Glacier retreat measured by drone photogrammetry', 'Sourdough starters differ across bakeries', 'Tidal turbines and seabed sediment transport', 'Owl pellets reveal vole population cycles', 'Bridge cables corrode faster near salt marshes', 'Pollen records from peat cores in Finland'];

const profile = () => ({ topics: [{ text: 'quantum dots', weight: 1, origin: 'user' }], authors: [], journals: [] });

function world({ liked = [], dismissedTexts = [], papers = 3 } = {}) {
  const s = emptyState();
  for (let n = 1; n <= papers; n++) {
    const id = `doi:10.1/m${n}`;
    s.shown[id] = { keys: [id], title: `Paper ${n} on moiré excitons`, text: `Paper ${n} on moiré excitons. ${abstracts[n - 1]}`, authors: [], venue: '', sources: ['database:openalex'] };
    s.seen[id] = { at: NOW, verdict: 'shown' };
  }
  filler.forEach((t, i) => {
    const id = `doi:10.1/f${i}`;
    s.shown[id] = { keys: [id], title: t, text: `${t}. Field notes and measurements from the survey.`, authors: [], venue: '', sources: ['database:openalex'] };
    s.seen[id] = { at: NOW, verdict: 'shown' };
  });
  for (const t of dismissedTexts) s.examples.negative.push({ id: `neg:${t.slice(0, 8)}`, text: t, at: NOW });
  return s;
}
const click = (state, prof, n, verdict) => applyFeedback({ state, profile: prof, key: `doi:10.1/m${n}`, verdict, now: NOW });

test('the same paper teaches the same phrases every time, with the shared phrase first', () => {
  const ctx = { liked: [abstracts[0]], dismissed: [], seen: filler };
  const paper = { title: 'Paper 1 on moiré excitons', text: `Paper 1 on moiré excitons. ${abstracts[0]}` };
  const a = extractPhrases(paper, ctx), b = extractPhrases(paper, ctx);
  assert.deepEqual(a, b);
  assert.equal(a[0].text, 'moiré excitons');
  assert.ok(!a.some((p) => ['novel', 'study', 'show'].includes(p.key)), 'generic words never become phrases');
  assert.ok(!a.some((p) => p.key === 'excitons'), 'a word inside a longer phrase that is as frequent adds nothing');
});

test('phrases are word sets: order and plurals do not make a new phrase', () => {
  assert.equal(phraseKey('Moiré excitons'), phraseKey('exciton moiré'));
  assert.ok(carries(phraseKey('graph neural networks'), 'A network for neural graphs'));
});

test('a liked paper puts its phrases into the learning list, once per paper (success check 1, first half)', () => {
  const out = click(world(), profile(), 1, 'added');
  const c = out.state.phrases.learning.find((x) => x.key === phraseKey('moiré excitons'));
  assert.deepEqual(c.papers, ['doi:10.1/m1']);
  assert.equal(out.profile.topics.length, 1, 'one paper adds no topic');
});

test('Read later teaches phrases too, and undo takes exactly that back (D3)', () => {
  const start = world();
  const later = click(start, profile(), 1, 'later');
  assert.ok(later.state.phrases.learning.length > 0);
  const undone = click(later.state, later.profile, 1, 'undo');
  assert.deepEqual(undone.state.phrases.learning, []);
});

test('a phrase common to liked and dismissed papers and to most of the seen stream is never learned (success check 2)', () => {
  const common = 'Results of a randomised trial of sleep hygiene in adults. Sleep hygiene sleep hygiene was assessed weekly.';
  const stream = Array.from({ length: 12 }, (_, i) => `Sleep hygiene study ${i}. Sleep hygiene in adults of group ${i}.`);
  const paper = { title: 'Sleep hygiene trial', text: common };
  const free = extractPhrases(paper, { liked: [common], dismissed: [], seen: [] });
  assert.ok(free.some((p) => p.key === phraseKey('sleep hygiene')), 'alone it would be learned');
  const crowded = extractPhrases(paper, { liked: [common], dismissed: [], seen: stream });
  assert.ok(!crowded.some((p) => p.key === phraseKey('sleep hygiene')), 'common in the stream');
  const contested = extractPhrases(paper, { liked: [common], dismissed: [`${common} Another sleep hygiene paper.`], seen: [] });
  assert.ok(!contested.some((p) => p.key === phraseKey('sleep hygiene')), 'dismissed as often as liked');
  const s = world({ dismissedTexts: [common] });
  s.shown['doi:10.1/m1'].text = common;
  s.shown['doi:10.1/m1'].title = 'Sleep hygiene trial';
  const out = click(s, profile(), 1, 'added');
  assert.ok(!out.state.phrases.learning.some((c) => c.key === phraseKey('sleep hygiene')));
});

test('keywords the source gives are phrases too', () => {
  const got = extractPhrases({ title: 'A note', text: 'A note about samples.', keywords: ['spin liquid'] }, { liked: ['x'], dismissed: [], seen: [] });
  assert.ok(got.some((p) => p.key === phraseKey('spin liquid')));
});

// Real titles from a radar run (public papers). Generic single words recurred across papers and would have become
// search topics after three likes.
const REAL = [
  ['Comparing Symmetry-Adapted Perturbation Theory to Intermolecular Energy Decomposition Analysis', 'Advances in the available terms of the concept are reviewed. Symmetry-adapted perturbation theory is compared with energy decomposition analysis.'],
  ['High-throughput exploration of refractory high-entropy alloys for strength', 'Multiple candidate refractory high-entropy alloys are screened. Their properties and strength are predicted.'],
  ['Multifunctional peach gum-encapsulated selenium quantum dot nanocrystals', 'A selenium quantum dot is made. Advances are available in the thesis.'],
  ['Virtual Knapping with Neural Networks: Proofs of Concept', 'Proofs of concept in terms of advances.'],
];
test('generic single words are never returned, real phrases still are', () => {
  const seen = REAL.map(([t, a]) => `${t}. ${a}`);
  const got = REAL.flatMap(([title, abstract]) => extractPhrases({ title, text: `${title}. ${abstract}` }, { liked: seen, dismissed: [], seen: [] }).map((p) => p.text));
  for (const bad of ['terms', 'advances', 'available', 'thesis', 'concept', 'proofs', 'strength', 'multiple', 'candidate', 'properties', 'analysis', 'approach', 'slater']) assert.ok(!got.includes(bad), bad);
  assert.ok(got.every((t) => t.includes(' ') || t.includes('-') || /[A-Z]/.test(t)), 'a lone word is a compound, an acronym or a keyword');
  for (const good of ['symmetry-adapted perturbation theory', 'refractory high-entropy alloys', 'selenium quantum dot']) assert.ok(got.includes(good), good);
});

test('an acronym, a formula and a source keyword may stand alone', () => {
  const got = extractPhrases({ title: 'DFT for MoS2', text: 'DFT for MoS2. We use GW and some perovskite films.', keywords: ['perovskite'] }, { liked: ['x'], dismissed: [], seen: [] }).map((p) => p.text);
  for (const t of ['DFT', 'MoS2', 'GW', 'perovskite']) assert.ok(got.includes(t), t);
  assert.ok(!got.includes('films'));
});
