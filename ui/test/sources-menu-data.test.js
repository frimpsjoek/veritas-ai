// spec 029 R6: the composer's one Sources menu button
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcesLabel, menuStep } from '../src/chat/sources-menu-data.js';

const item = (id, label, on, usable = true) => ({ id, label, on, usable });

test('sourcesLabel names the sources that are on, in menu order', () => {
  assert.equal(sourcesLabel([item('papers', 'Papers', true), item('notes', 'Notes', true), item('scholarly', 'Scholarly', true), item('web', 'Web', false)]),
    'Sources: Papers, Notes, Scholarly');
  assert.equal(sourcesLabel([item('papers', 'Papers', false), item('notes', 'Notes', false), item('scholarly', 'Scholarly', false), item('web', 'Web', true)]), 'Sources: Web');
});

test('sourcesLabel leaves out a source that is hidden or disabled here (Find papers has no Notes or Web; Valency only when connected)', () => {
  assert.equal(sourcesLabel([item('papers', 'Papers', true), item('notes', 'Notes', true, false), item('scholarly', 'Scholarly', true), item('web', 'Web', true, false),
    item('valency', 'Valency', true, false)]), 'Sources: Papers, Scholarly');
  assert.equal(sourcesLabel([item('papers', 'Papers', true), item('valency', 'Valency', true)]), 'Sources: Papers, Valency');
});

test('sourcesLabel says none when nothing is on', () => {
  assert.equal(sourcesLabel([item('papers', 'Papers', false), item('web', 'Web', false)]), 'Sources: none');
  assert.equal(sourcesLabel([]), 'Sources: none');
});

test('menuStep: arrows step and wrap, Home and End jump, from no focus the arrows start at either end', () => {
  assert.equal(menuStep('ArrowDown', -1, 4), 0);
  assert.equal(menuStep('ArrowUp', -1, 4), 3);
  assert.equal(menuStep('ArrowDown', 1, 4), 2);
  assert.equal(menuStep('ArrowDown', 3, 4), 0);
  assert.equal(menuStep('ArrowUp', 0, 4), 3);
  assert.equal(menuStep('Home', 2, 4), 0);
  assert.equal(menuStep('End', 0, 4), 3);
  assert.equal(menuStep('a', 0, 4), null);
  assert.equal(menuStep('ArrowDown', -1, 0), null);
});
