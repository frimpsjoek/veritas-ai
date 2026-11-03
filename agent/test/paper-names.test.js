// @ts-check
// Author names as a reader writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arxivAuthors, plainName } from '../src/paper-names.js';

test('TeX accents become letters', () => {
  assert.equal(plainName("S\\'{e}l\\`{e}ne Forget"), 'Sélène Forget');
  assert.equal(plainName('Malte R\\"osner'), 'Malte Rösner');
  assert.equal(plainName("Samuel Ponc\\'e"), 'Samuel Poncé');
  assert.equal(plainName('Jos\\v{e} \\c{C}elik'), 'Josě Çelik');
  assert.equal(plainName("Ant\\'{\\i}a M\\o ller"), 'Antía Møller');
  assert.equal(plainName('Ann Chen'), 'Ann Chen');
});

test("arXiv's one string of authors becomes one name each", () => {
  assert.deepEqual(arxivAuthors(["Raphael T. Husistein, S\\'{e}l\\`{e}ne Forget, Gemma C. Solomon and Markus Reiher"]), ['Raphael T. Husistein', 'Sélène Forget', 'Gemma C. Solomon', 'Markus Reiher']);
  assert.deepEqual(arxivAuthors(undefined), []);
});
