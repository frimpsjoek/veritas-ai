// Spec 011 U5: the pure pieces behind "New from selection".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedPapers, selectionTitle, selectionLabel, selectionChoices } from '../src/chat/selection-card.js';

const paper = (key, label = key) => ({ attachment: { kind: 'zoteroItem', citekey: key }, label, why: 'selected' });

test('the card title counts the papers in plain words', () => {
  assert.equal(selectionTitle(1), '1 paper selected');
  assert.equal(selectionTitle(3), '3 papers selected');
});

test('selectedPapers keeps library papers once each and drops everything else', () => {
  const note = { attachment: { kind: 'note', path: 'a.md' }, label: 'A note', why: 'active-note' };
  assert.deepEqual(selectedPapers([paper('a'), note, paper('a'), paper('b')]).map((p) => p.attachment.citekey), ['a', 'b']);
  assert.deepEqual(selectedPapers(undefined), []);
});

test('the session name is the title for one paper, else a count', () => {
  assert.equal(selectionLabel([paper('a', 'Voles 2024')]), 'Voles 2024');
  assert.equal(selectionLabel([paper('a', 'Hou 2024'), paper('b', 'Lee 2023')]), 'Hou 2024 and 1 more');
  assert.equal(selectionLabel([paper('a', 'Hou 2024'), paper('b'), paper('c')]), 'Hou 2024 and 2 more');
});

test('Write a report is offered only where the engine can write one', () => {
  assert.deepEqual(selectionChoices({ report: true }).map((c) => c.kind), ['papers', 'extract', 'report']);
  assert.deepEqual(selectionChoices({ report: false }).map((c) => c.kind), ['papers', 'extract']);
  assert.deepEqual(selectionChoices(undefined).map((c) => c.kind), ['papers', 'extract']);
  for (const c of selectionChoices({ report: true })) assert.doesNotMatch(c.label, /session|import|artifact/i);
});
