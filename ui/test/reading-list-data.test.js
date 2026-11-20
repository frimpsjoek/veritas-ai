// Spec 028 R10-R12: the pure part of Read later. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkCopy, entryMeta, filterLater, savedLine, laterSections, listedAs, readingId, unreadCount, zoteroKeys, LATER_EMPTY, IN_ZOTERO } from '../src/reading-list-data.js';

const entry = (n, over = {}) => ({ id: `doi:10.9999/inv.${n}`, title: `Invented study ${n}`, authors: [], year: 2026, venue: 'J. Invented', doi: `10.9999/inv.${n}`, url: `https://doi.org/10.9999/inv.${n}`, source: 'radar', added: `2026-11-0${n}T00:00:00.000Z`, ...over });

test('the words are the spec\'s', () => {
  assert.deepEqual(bookmarkCopy(false).label, 'Read later');
  assert.deepEqual(bookmarkCopy(true), { label: 'Saved to read later', hint: 'Remove from Read later' });
  assert.equal(LATER_EMPTY, 'Nothing saved to read later yet.');
  assert.equal(IN_ZOTERO, 'In your Zotero library');
});

test('readingId follows the engine: doi, else arXiv, else address', () => {
  assert.equal(readingId({ doi: '10.9999/INV.1' }), 'doi:10.9999/inv.1');
  assert.equal(readingId({ doi: null, arxiv: '2611.00001v2', url: 'https://arxiv.org/abs/2611.00001v2' }), 'arxiv:2611.00001');
  assert.equal(readingId({ url: 'https://example.org/a' }), 'url:https://example.org/a');
});

test('sections: Unread newest added first, then Read most recently read first; the badge counts unread', () => {
  const list = [entry(1), entry(3), entry(2, { read: '2026-11-09T00:00:00.000Z' }), entry(4, { read: '2026-11-08T00:00:00.000Z' })];
  const { unread, read } = laterSections(list);
  assert.deepEqual(unread.map((e) => e.id), ['doi:10.9999/inv.3', 'doi:10.9999/inv.1']);
  assert.deepEqual(read.map((e) => e.id), ['doi:10.9999/inv.2', 'doi:10.9999/inv.4']);
  assert.equal(unreadCount(list), 2);
  assert.equal(unreadCount([]), 0);
});

test('entryMeta: venue and year, either may be missing', () => {
  assert.equal(entryMeta(entry(1)), 'J. Invented · 2026');
  assert.equal(entryMeta(entry(1, { venue: '', year: null })), '');
});

test('zoteroKeys: by DOI (any case), else by title ignoring case, TeX and punctuation; short titles never match', () => {
  const rows = [{ key: 'AAAA1111', title: 'Other', doi: '10.9999/INV.1' }, { key: 'BBBB2222', title: 'Spindles in \\textit{invented} voles!', doi: '' }, { key: 'CCCC3333', title: 'Notes', doi: '' }];
  const keys = zoteroKeys([entry(1), entry(2, { doi: undefined, title: 'Spindles in invented voles' }), entry(3, { doi: undefined, title: 'Notes' })], rows);
  assert.deepEqual([...keys], [['doi:10.9999/inv.1', 'AAAA1111'], ['doi:10.9999/inv.2', 'BBBB2222']]);
});

test('zoteroKeys: TeX accents in either title read as their letters, so "M{\\o}ller" finds "Møller"', () => {
  const rows = [{ key: 'DDDD4444', title: 'M{\\o}ller--Plesset theory for invented voles', doi: '' }, { key: 'EEEE5555', title: 'Schr\\"{o}dinger cats in invented boxes', doi: '' }];
  const keys = zoteroKeys([entry(1, { doi: undefined, title: 'Møller–Plesset theory for invented voles' }), entry(2, { doi: undefined, title: 'Schrödinger cats in invented boxes' })], rows);
  assert.deepEqual([...keys], [['doi:10.9999/inv.1', 'DDDD4444'], ['doi:10.9999/inv.2', 'EEEE5555']]);
});

test('listedAs: the entry a paper is on the list as, found by any of its ids (DOI, arXiv id, address)', () => {
  const byArxiv = entry(1, { id: 'arxiv:2611.00001', doi: undefined, arxiv: '2611.00001', url: 'https://arxiv.org/abs/2611.00001' });
  const byDoi = entry(2);
  const list = [byArxiv, byDoi];
  assert.equal(listedAs(list, { doi: '10.1103/inv.9', arxiv: '2611.00001v2' }), byArxiv);
  assert.equal(listedAs(list, { doi: '10.48550/arXiv.2611.00001' }), byArxiv);
  assert.equal(listedAs(list, { url: 'https://arxiv.org/pdf/2611.00001v1' }), byArxiv);
  assert.equal(listedAs(list, { arxiv: '2611.77777', url: 'https://doi.org/10.9999/INV.2' }), byDoi);
  // an entry listed by its DOI that also knows its arXiv id is found by that id
  assert.equal(listedAs([entry(3, { arxiv: '2611.33333' })], { arxiv: '2611.33333' })?.id, 'doi:10.9999/inv.3');
  assert.equal(listedAs(list, { doi: '10.9999/other' }), null);
  assert.equal(listedAs(null, { doi: '10.9999/inv.2' }), null);
});

test('spec 029 R1: savedLine says when a paper went on the list, "Liked" for one a Like put there, the day after two weeks', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const e = (/** @type {string} */ added, over = {}) => /** @type {any} */ ({ id: 'doi:x', title: 't', authors: [], year: null, venue: '', url: '', source: 'radar', added, ...over });
  assert.equal(savedLine(e('2026-11-15T12:00:00.000Z'), now), 'Saved 3 days ago');
  assert.equal(savedLine(e('2026-11-18T09:00:00.000Z', { via: 'like' }), now), 'Liked 3 hours ago');
  assert.equal(savedLine(e('2026-11-18T11:59:50.000Z'), now), 'Saved just now');
  assert.equal(savedLine(e('2026-10-01T12:00:00.000Z'), now), `Saved on ${new Date('2026-10-01T12:00:00.000Z').toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
  assert.match(savedLine(e('2025-10-01T12:00:00.000Z'), now), /^Saved on .*2025/);
  assert.equal(savedLine(e('not a time'), now), '');
});

test('spec 029 R4: filterLater matches every word in title, authors or venue, accents and case off; laterSections sorts by order', () => {
  const e = (/** @type {number} */ n, over = {}) => /** @type {any} */ ({ id: `doi:x${n}`, title: `Study ${n}`, authors: ['A. Vole'], year: null, venue: 'J. Invented', url: '', source: 'web', added: `2026-11-0${n}T00:00:00.000Z`, ...over });
  const list = [e(1, { title: 'Møller–Plesset \\textit{gaps}' }), e(2, { authors: ['Kaoru Ohno'] }), e(3, { venue: 'J. Chem. Phys.' })];
  assert.deepEqual(filterLater(list, 'MOLLER gaps').map((x) => x.id), ['doi:x1']);
  assert.deepEqual(filterLater(list, 'ohno').map((x) => x.id), ['doi:x2']);
  assert.deepEqual(filterLater(list, 'chem phys').map((x) => x.id), ['doi:x3']);
  assert.equal(filterLater(list, '  ').length, 3);
  assert.equal(filterLater(list, 'ohno moller').length, 0, 'every word must match');
  assert.deepEqual(laterSections(list).unread.map((x) => x.id), ['doi:x3', 'doi:x2', 'doi:x1']);
  assert.deepEqual(laterSections(list, 'oldest').unread.map((x) => x.id), ['doi:x1', 'doi:x2', 'doi:x3']);
});
