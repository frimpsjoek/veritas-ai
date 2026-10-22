import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkedRows, similarRows, tagRows, sectionRows, rowMeta, rowScore, relatedProblem, linkGroups,
  duplicateCount, duplicateGroups, conflictIntro, conflictMeta, titleOf,
} from '../src/panels/related-data.js';

const paper = { path: 'zotero/AAAA1111', title: 'A paper', zotero: { authors: ['Ann Chen', 'Bo Ruiz', 'Cy Diaz'], year: '2022', venue: 'Nature' } };
const related = {
  path: 'notes/a.md',
  links_to: ['notes/b.md', 'notes/gone (no note)', 'zotero/AAAA1111'],
  linked_from: ['notes/b.md', 'notes/c.md'],
  refs: { 'zotero/AAAA1111': paper },
  similar: [{ ...paper, score: 0.91 }],
  shared_tags: [{ path: 'notes/d.md', title: 'D', tags: ['ml', 'dft'], score: 6.9 }],
};

test('linkedRows: each note once, labelled by direction; unresolved wiki links dropped', () => {
  const rows = linkedRows(related);
  assert.deepEqual(rows.map((r) => [r.path, r.note]), [['notes/b.md', 'both ways'], ['zotero/AAAA1111', 'linked'], ['notes/c.md', 'links here']]);
  assert.equal(rows[1].title, 'A paper'); // titles and Zotero details come from refs
  assert.equal(rows[0].title, 'b');
});

test('linkedRows falls back to the host link graph when the index did not answer', () => {
  const rows = linkedRows(null, { links: ['x/y.md'], backlinks: ['x/y.md', 'z.md'] });
  assert.deepEqual(rows.map((r) => [r.title, r.note]), [['y', 'both ways'], ['z', 'links here']]);
  assert.deepEqual(linkedRows(null), []);
});

test('similarRows carry the byline and keep the score; tagRows have hashtags and no score', () => {
  const [s] = similarRows(related);
  assert.equal(s.note, 'Chen et al. · 2022 · Nature');
  assert.equal(rowScore(s)?.label, 'Close');
  const [t] = tagRows(related);
  assert.equal(t.note, '#ml #dft');
  assert.equal(rowScore(t), null);
});

test('rowMeta prefers the explicit note, then the generic meta line', () => {
  assert.equal(rowMeta({ path: 'a/b.md', title: 'b', note: 'linked' }), 'linked');
  assert.equal(rowMeta({ path: 'a/b.md', title: 'b' }), 'a');
  assert.equal(rowMeta({ path: 'zotero/K', title: 'p' }), 'Paper');
});

test('sectionRows tidy and cut the snippet', () => {
  const [r] = sectionRows([{ path: 'n.md', title: 'n', heading: 'H', score: 0.8, snippet: `**bold** ${'x'.repeat(300)}` }]);
  assert.equal(r.note?.length, 140);
  assert.ok(r.note?.startsWith('bold x'));
});

test('relatedProblem: 404 means not indexed yet (with the Add it now offer), anything else is the message', () => {
  assert.deepEqual(relatedProblem({ status: 404 }), { message: "This note isn't in the index yet. New notes are added every 5 minutes.", notIndexed: true });
  assert.deepEqual(relatedProblem({ status: 500, message: 'boom' }), { message: "Couldn't load related notes: boom", notIndexed: false });
});

test('linkGroups splits outgoing, incoming and notes that do not exist yet', () => {
  const g = linkGroups({ links_to: ['a/b.md', 'Idea (no note)'], linked_from: ['c.md'] });
  assert.deepEqual(g.outgoing.map((r) => r.title), ['b']);
  assert.deepEqual(g.incoming.map((r) => r.path), ['c.md']);
  assert.deepEqual(g.missing, ['Idea']);
  assert.deepEqual(linkGroups({}), { outgoing: [], incoming: [], missing: [] });
});

const dups = { exact: [['a/x.md', 'b/x.md']], near: [{ paths: ['a/y.md', 'b/y.md'], score: 0.99 }], zotero: [[paper, { ...paper, path: 'zotero/BBBB2222' }]] };
const conflicts = { total: 3, identical: [{ copy: 'a (conflict).md', original: 'a.md', copy_chars: 10, original_chars: 10, copy_newer: false }], different: [{ copy: 'f/b 2.md', original: 'f/b.md', copy_chars: 1200, original_chars: 900, copy_newer: true }], no_original: [] };

test('duplicate tabs count their own list; conflicts count the total', () => {
  assert.deepEqual(['exact', 'near', 'conflicts', 'zotero'].map((t) => duplicateCount(dups, conflicts, t)), [1, 1, 3, 1]);
  assert.equal(duplicateCount(null, null, 'exact'), 0);
});

test('duplicateGroups: identical, near (with score) and Zotero, each with its sentence; conflicts have their own layout', () => {
  const exact = duplicateGroups(dups, 'exact');
  assert.equal(exact?.intro, 'Notes with exactly the same text.');
  assert.deepEqual(exact?.groups[0].refs.map((r) => r.title), ['x', 'x']);
  assert.equal(duplicateGroups(dups, 'near')?.groups[0].score, 0.99);
  assert.match(duplicateGroups(dups, 'near')?.intro ?? '', /0\.985/);
  assert.equal(duplicateGroups(dups, 'zotero')?.groups[0].refs.length, 2);
  assert.equal(duplicateGroups(dups, 'conflicts'), null);
});

test('conflict wording', () => {
  assert.equal(conflictIntro(conflicts), '3 copies made by sync conflicts. 1 are identical to their original; 1 differ and need a look.');
  assert.equal(conflictMeta(conflicts.different[0]), 'f · copy 1,200 chars vs original 900 · copy is newer');
  assert.equal(conflictMeta(conflicts.identical[0]), 'Vault · copy 10 chars vs original 10');
  assert.equal(titleOf('a/b/c.md'), 'c');
});
