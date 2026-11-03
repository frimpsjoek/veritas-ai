// The profile check: one model call says which candidates are outside the user's field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFit, judgePool, judgePrompt, JUDGE_POOL } from '../src/radar-judge.js';

const item = (n, over = {}) => ({ id: `doi:10.1/${n}`, doi: `10.1/${n}`, arxiv: null, title: `Invented paper ${n}`, authors: [], venue: 'J. Invented', date: null, year: 2026, abstract: `Abstract ${n}.`, url: null, links: [], sources: [], ...over });
const profile = { topics: ['quantum dots'], seeds: ['Defects in hBN'], rejected: ['A clinical trial'] };

test('fits=false entries are dropped by number; junk entries are ignored; every paper it is given is read', async () => {
  const items = Array.from({ length: JUDGE_POOL + 5 }, (_, i) => item(i + 1, i === 2 ? { abstract: '' } : {}));
  let prompt = '';
  const { off, error } = await judgeFit(items, { ...profile, turn: async (p) => { prompt = p; return { papers: [{ n: 2, fits: false }, { n: 3, fits: true }, { n: 99, fits: false }, { n: 'x', fits: false }, { n: 4 }] }; } });
  assert.equal(error, null);
  assert.deepEqual([...off], ['doi:10.1/2']);
  assert.equal((prompt.match(/### Paper/g) ?? []).length, JUDGE_POOL + 5);
  assert.match(prompt, /Abstract: \(none\)/, 'a title-only paper is judged on its title');
  assert.match(prompt, /Defects in hBN/);
  assert.match(prompt, /A clinical trial/);
});

test('a throwing model, or one that rejects everything, drops nothing', async () => {
  const failed = await judgeFit([item(1)], { ...profile, turn: async () => { throw new Error('rate limited'); } });
  assert.equal(failed.off.size, 0);
  assert.equal(failed.error, 'rate limited');
  const all = Array.from({ length: 6 }, (_, i) => item(i + 1));
  const sweeping = await judgeFit(all, { ...profile, turn: async () => ({ papers: all.map((_, i) => ({ n: i + 1, fits: false })) }) });
  assert.equal(sweeping.off.size, 0);
  assert.match(sweeping.error, /rejected every paper/);
});

test('the prompt states the interests and leans to keeping when unsure', () => {
  const p = judgePrompt([item(1)], { topics: [], seeds: [], rejected: [] });
  assert.match(p, /\(not stated\)/);
  assert.match(p, /When unsure, answer true/);
  assert.doesNotMatch(p, /typical of their own work/);
});

test('a long issue reads about three candidates per row', () => {
  assert.equal(judgePool(8), JUDGE_POOL);
  assert.equal(judgePool(30), 90);
});
