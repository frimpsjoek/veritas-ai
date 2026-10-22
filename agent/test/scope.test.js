import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateScope } from '../src/scope.js';

test('migrateScope: a current shape passes through, keys filtered to strings', () => {
  assert.deepEqual(migrateScope({ kind: 'collections', keys: ['ABC123', 'DEF456'] }), { kind: 'collections', keys: ['ABC123', 'DEF456'] });
  assert.deepEqual(migrateScope({ kind: 'collections', keys: ['ABC123', 7, null] }), { kind: 'collections', keys: ['ABC123'] });
  assert.deepEqual(migrateScope({ kind: 'collections' }), { kind: 'collections', keys: [] });
  assert.deepEqual(migrateScope({ kind: 'library' }), { kind: 'library' });
  assert.deepEqual(migrateScope({ kind: 'tag', name: 'important' }), { kind: 'tag', name: 'important' });
  assert.deepEqual(migrateScope({ kind: 'savedSearch', name: 'To read' }), { kind: 'savedSearch', name: 'To read' });
});

test('migrateScope: a pre-Z3 { kind: "collection", name } maps to the matching key(s), by name', () => {
  const collections = [
    { key: 'K1', name: 'Graphene' },
    { key: 'K2', name: 'Ecology' },
    { key: 'K3', name: 'Graphene' }, // Zotero allows the same name under different parents; every match counts
  ];
  assert.deepEqual(migrateScope({ kind: 'collection', name: 'Graphene' }, collections), { kind: 'collections', keys: ['K1', 'K3'] });
  assert.deepEqual(migrateScope({ kind: 'collection', name: 'Ecology' }, collections), { kind: 'collections', keys: ['K2'] });
});

test('migrateScope: an unresolved legacy name (no matching collection, or no list given) yields no keys, not a throw', () => {
  assert.deepEqual(migrateScope({ kind: 'collection', name: 'Deleted' }, [{ key: 'K1', name: 'Ecology' }]), { kind: 'collections', keys: [] });
  assert.deepEqual(migrateScope({ kind: 'collection', name: 'Ecology' }), { kind: 'collections', keys: [] });
});

test('migrateScope: garbage input (null, a string, an unknown kind) degrades to the whole library', () => {
  assert.deepEqual(migrateScope(null), { kind: 'library' });
  assert.deepEqual(migrateScope(undefined), { kind: 'library' });
  assert.deepEqual(migrateScope('collection'), { kind: 'library' });
  assert.deepEqual(migrateScope({ kind: 'somethingElse' }), { kind: 'library' });
});
