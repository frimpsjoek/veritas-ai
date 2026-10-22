// The chat's source pills and the Settings chips are one state: these are the pure pieces that keep them so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pillsFrom, migrationPatch, togglePatch, webFor } from '../src/chat/sources-sync.js';

test('a fresh install has everything on except the web, whatever Research says', () => {
  assert.deepEqual(pillsFrom({ sources: null, webSearchDefault: 'off' }), { papers: true, notes: true, scholarly: true, web: false });
  assert.deepEqual(pillsFrom(null), { papers: true, notes: true, scholarly: true, web: false });
  assert.deepEqual(pillsFrom({ sources: null, webSearchDefault: 'cached' }).web, false, 'Research alone does not turn the pill on');
  assert.deepEqual(pillsFrom({ sources: { notes: false, web: true }, webSearchDefault: 'off' }), { papers: true, notes: false, scholarly: true, web: true });
});

test('an old {library: false} pref moves over as papers and notes off, only the switches that differ', () => {
  const settings = { sources: null, webSearchDefault: 'off' };
  assert.deepEqual(migrationPatch({ library: false, scholarly: true, web: false }, settings), { sources: { papers: false, notes: false } });
  assert.equal(migrationPatch({ papers: true, notes: true, scholarly: true, web: false }, settings), null, 'the defaults: nothing to write');
  assert.equal(migrationPatch(undefined, settings), null);
  assert.equal(migrationPatch('junk', settings), null);
});

test('a pref with the web on writes sources.web, and a pref with it off writes nothing over the off default', () => {
  assert.deepEqual(migrationPatch({ papers: true, notes: true, scholarly: true, web: true }, { sources: null }), { sources: { web: true } });
  for (const mode of ['off', 'cached', 'live']) {
    assert.equal(migrationPatch({ papers: true, notes: true, scholarly: true, web: false }, { sources: null, webSearchDefault: mode }), null, `web off + Research ${mode}`);
  }
});

test('a later app writes only what differs from what the engine holds', () => {
  const pref = { papers: true, notes: false, scholarly: false, web: false };
  assert.deepEqual(migrationPatch(pref, { sources: { papers: true, notes: false, scholarly: true, web: false } }), { sources: { scholarly: false } });
  assert.equal(migrationPatch(pref, { sources: { papers: true, notes: false, scholarly: false, web: false } }), null);
});

test('the migration never names the Research web default', () => {
  for (const mode of ['off', 'cached', 'live']) {
    for (const web of [true, false]) {
      const patch = migrationPatch({ papers: false, notes: true, scholarly: true, web }, { sources: null, webSearchDefault: mode });
      assert.ok(!('webSearchDefault' in patch), `web ${web} + ${mode}`);
    }
  }
});

test('flipping a pill, the web included, writes only its own key', () => {
  const pills = pillsFrom({ sources: { papers: true, notes: true, scholarly: false, web: false } });
  assert.deepEqual(togglePatch('notes', pills), { sources: { notes: false } });
  assert.deepEqual(togglePatch('scholarly', pills), { sources: { scholarly: true } });
  assert.deepEqual(togglePatch('web', pills), { sources: { web: true } });
  assert.deepEqual(togglePatch('web', { ...pills, web: true }), { sources: { web: false } });
});

test('a pill flipped from stale pills names no other switch, so it can not put one back', () => {
  const stale = pillsFrom({ sources: { notes: true } });
  assert.deepEqual(Object.keys(togglePatch('scholarly', stale).sources), ['scholarly']);
});

test('a send carries off, or the mode Research picked: cached stays cached, anything else is live', () => {
  const on = { papers: true, notes: true, scholarly: true, web: true };
  assert.equal(webFor(on, { webSearchDefault: 'cached' }), 'cached');
  assert.equal(webFor(on, { webSearchDefault: 'live' }), 'live');
  assert.equal(webFor(on, { webSearchDefault: 'off' }), 'live', 'on over Research off means live');
  assert.equal(webFor(on, null), 'live');
  assert.equal(webFor({ ...on, web: false }, { webSearchDefault: 'cached' }), 'off');
  assert.equal(webFor({ ...on, web: false }, { webSearchDefault: 'live' }), 'off');
});
