import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeOf, pillsFor, togglePill, closeness, byline, shortAuthors, metaOf, badgeOf, tidy, duration, ago, until } from '../src/panels/data.js';

test('scopeOf: both or neither pill is no filter; Papers alone is source=zotero; Notes alone excludes zotero', () => {
  assert.deepEqual(scopeOf({ papers: true, notes: true }), { source: '', exclude: '' });
  assert.deepEqual(scopeOf({ papers: false, notes: false }), { source: '', exclude: '' });
  assert.deepEqual(scopeOf({ papers: true, notes: false }), { source: 'zotero', exclude: '' });
  assert.deepEqual(scopeOf({ papers: false, notes: true }), { source: '', exclude: 'zotero' });
});

test('scopeOf: a chosen source wins over the pills', () => {
  assert.deepEqual(scopeOf({ papers: false, notes: true, specific: 'pdf' }), { source: 'pdf', exclude: '' });
  assert.deepEqual(scopeOf({ papers: true, notes: true, specific: 'Notion' }), { source: 'Notion', exclude: '' });
});

test('pillsFor: Zotero is the Papers side, every other source the Notes side, none is both', () => {
  assert.deepEqual(pillsFor(''), { papers: true, notes: true });
  assert.deepEqual(pillsFor('zotero'), { papers: true, notes: false });
  for (const s of ['personal', 'Notion', 'pdf', 'image', 'ai_notes', 'People', 'Clippings', 'youtube']) assert.deepEqual(pillsFor(s), { papers: false, notes: true }, s);
});

test('togglePill: flips one side, drops a chosen source, never leaves both off', () => {
  assert.deepEqual(togglePill({ papers: true, notes: true }, 'papers'), { papers: false, notes: true, specific: '' });
  assert.deepEqual(togglePill({ papers: false, notes: true }, 'papers'), { papers: true, notes: true, specific: '' });
  assert.deepEqual(togglePill({ papers: false, notes: true }, 'notes'), { papers: true, notes: true, specific: '' }); // the last one on: reset
  assert.deepEqual(togglePill({ papers: false, notes: true, specific: 'pdf' }, 'papers'), { papers: true, notes: true, specific: '' });
  assert.deepEqual(togglePill({ papers: true, notes: false, specific: 'zotero' }, 'notes'), { papers: true, notes: true, specific: '' });
});

test('closeness: the fixed steps, and a host calibration moves them', () => {
  assert.deepEqual([0.95, 0.9, 0.86, 0.82, 0.7].map((s) => closeness(s).level), [5, 4, 3, 2, 1]);
  assert.equal(closeness(0.88).label, 'Close');
  const cal = { p50: 0.4, p90: 0.5, p99: 0.6, p999: 0.7, p9999: 0.8 };
  assert.equal(closeness(0.65, cal).level, 3);
  assert.match(closeness(0.65, cal).tip, /about 0\.40/);
  assert.match(closeness(0.9).tip, /about 0\.73/);
});

test('byline / shortAuthors / metaOf', () => {
  assert.equal(shortAuthors(['Ann Chen', 'Bo Ruiz']), 'Chen & Ruiz');
  assert.equal(shortAuthors(['Ann Chen', 'Bo Ruiz', 'Cy Doe']), 'Chen et al.');
  assert.equal(byline({ authors: ['Ann Chen'], year: 2022, venue: 'Nature' }), 'Chen · 2022 · Nature');
  assert.equal(byline(null), '');
  assert.equal(metaOf({ path: 'zotero/ABC', title: 't', zotero: { authors: ['Ann Chen'], year: '2020' } }), 'Chen · 2020');
  assert.equal(metaOf({ path: 'zotero/ABC', title: 't' }), 'Paper');
  assert.equal(metaOf({ path: 'Notes/a/b.md', title: 't', modified: '2024-01-02' }), 'Notes/a · 2024-01-02');
  assert.equal(metaOf({ path: 'top.md', title: 't' }), 'Vault');
});

test('badgeOf and tidy', () => {
  assert.equal(badgeOf('zotero/X'), 'Zotero');
  assert.equal(badgeOf('a/b.pdf'), 'PDF');
  assert.equal(badgeOf('a/b.png'), 'Image');
  assert.equal(badgeOf('a/b.md'), null);
  assert.equal(tidy('## **Bold** `code`\n\n  text'), 'Bold code text');
});

test('duration / ago / until', () => {
  assert.equal(duration(30), '30 s');
  assert.equal(duration(600), '10 min');
  assert.equal(duration(7200), '2.0 h');
  assert.equal(ago(1000, 1030), 'just now');
  assert.equal(ago(1000, 1600), '10 min ago');
  assert.equal(until(1010, 1000), 'any moment');
  assert.equal(until(1600, 1000), 'in 10 min');
});
