// The collection menu behind Add to Zotero (Home's split button, the reader, the PDF bar): what it lists. Invented names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionRows, collectionLabel, collectionTarget } from '../src/home/collection-data.js';

const TREE = [
  { key: 'A', name: 'Physics', parent: null, count: 3 },
  { key: 'C', name: 'Condensed matter', parent: 'A', count: 2 },
  { key: 'D', name: '2D materials', parent: 'C', count: 1 },
  { key: 'B', name: 'Biology', parent: null, count: 1 },
  { key: 'Z', name: 'Lost child', parent: 'GONE', count: 0 },
];

test('without a query: My Library first (default), then the tree by name, each row with its depth; the last used one is marked', () => {
  const rows = collectionRows(TREE, { query: '', lastUsed: 'C' });
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.depth, r.note]), [
    ['', 'My Library', 0, 'default'], ['B', 'Biology', 0, ''], ['Z', 'Lost child', 0, ''], ['A', 'Physics', 0, ''], ['C', 'Condensed matter', 1, 'last used'], ['D', '2D materials', 2, ''],
  ]);
});

test('with a query: the matching collections flat, named by their path, My Library only when it matches', () => {
  assert.deepEqual(collectionRows(TREE, { query: 'mat', lastUsed: '' }).map((r) => [r.key, r.name, r.depth]), [['C', 'Physics › Condensed matter', 0], ['D', 'Physics › Condensed matter › 2D materials', 0]]);
  assert.deepEqual(collectionRows(TREE, { query: 'libr', lastUsed: '' }).map((r) => r.key), ['']);
  assert.deepEqual(collectionRows(TREE, { query: 'nothing here', lastUsed: '' }), []);
  assert.deepEqual(collectionRows(/** @type {any} */ (null), { query: '', lastUsed: '' }).map((r) => r.key), ['']);
});

test('the split button names the chosen collection by its path, My Library for none', () => {
  assert.equal(collectionLabel(TREE, 'D'), 'Physics › Condensed matter › 2D materials');
  assert.equal(collectionLabel(TREE, ''), 'My Library');
  assert.equal(collectionLabel(TREE, 'NOPE'), 'My Library');
});

test('collectionTarget: the key to add to, only for a collection that still exists', () => {
  assert.equal(collectionTarget(TREE, 'C'), 'C');
  assert.equal(collectionTarget(TREE, 'GONE'), null);
  assert.equal(collectionTarget(TREE, ''), null);
  assert.equal(collectionTarget(null, 'C'), null);
});
