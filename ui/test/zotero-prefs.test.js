// The Zotero host's prefs carry what the Sources pills need: an object pref survives a round trip, a boolean stays a
// boolean, and nothing is ever handed to Zotero.Prefs.set as null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoteroHostPrefs } from './support/zotero-prefs.mjs';

test('chatSources round-trips as an object and sourcesMigrated as a boolean', () => {
  const { prefs, raw } = zoteroHostPrefs();
  assert.equal(prefs.get('chatSources'), undefined);
  assert.equal(prefs.get('sourcesMigrated'), undefined);
  prefs.set('chatSources', { papers: true, notes: false, scholarly: true, web: true });
  assert.equal(typeof raw.get('extensions.secondbrain.chatSources'), 'string');
  assert.deepEqual(prefs.get('chatSources'), { papers: true, notes: false, scholarly: true, web: true });
  prefs.set('sourcesMigrated', true);
  assert.equal(prefs.get('sourcesMigrated'), true);
});

test('setting a pref to null clears it instead of throwing', () => {
  const { prefs } = zoteroHostPrefs();
  prefs.set('chatSources', { papers: true });
  assert.doesNotThrow(() => prefs.set('chatSources', null));
  assert.equal(prefs.get('chatSources'), undefined);
  assert.doesNotThrow(() => prefs.set('neverSet', undefined));
});
