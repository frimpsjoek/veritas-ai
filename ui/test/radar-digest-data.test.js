// Spec 012 R4: what a digest row says and offers. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, keyOf, rowLine, actionList, settledLabel, toastText, outsidePaper, NO_ABSTRACT } from '../src/chat/radar-digest-data.js';

const row = (over = {}, radar = {}) => ({ id: 'a', title: 'Burrow depth', authors: ['A. B'], year: 2026, venue: 'J', doi: '10.1/a', url: 'https://doi.org/10.1/a', abstract: 'Words.', citations: 3, foundBy: ['arXiv'], pdfUrl: null,
  radar: { key: 'doi:10.1/a', score: 0.8, why: {}, links: [], sources: [], date: null, ...radar }, ...over });

test('digestOf reads the routine and summary from a radar result only', () => {
  assert.deepEqual(digestOf({ kind: 'papers', radar: { routine: 'r1', summary: '3 new from 1 source' } }), { routine: 'r1', summary: '3 new from 1 source' });
  assert.equal(digestOf({ kind: 'papers' }), null);
  assert.equal(digestOf({ kind: 'table', radar: { routine: 'r1' } }), null);
  assert.equal(digestOf(null), null);
});

test('rowLine: the reason beats the why line; no line and no abstract is the muted note; no radar data means nothing', () => {
  assert.deepEqual(rowLine(row({}, { reason: 'Cited by 7 papers', why_line: 'ignored' })), { text: 'Cited by 7 papers', muted: false });
  assert.deepEqual(rowLine(row({}, { why_line: 'Why.' })), { text: 'Why.', muted: false });
  assert.deepEqual(rowLine(row({ abstract: '' })), { text: NO_ABSTRACT, muted: true });
  assert.equal(rowLine(row()), null, 'an abstract but no line (the model failed): quiet');
  assert.equal(rowLine({ ...row(), radar: undefined }), null);
  assert.equal(keyOf(row()), 'doi:10.1/a');
  assert.equal(keyOf({ ...row(), radar: undefined }), null);
});

test('actions: one save button (Add to Zotero with Zotero, Read later without), then Like and Dislike', () => {
  assert.deepEqual(actionList(true).map((a) => [a.verdict, a.label, a.primary]), [['added', 'Add to Zotero', true], ['liked', 'Like', false], ['dismissed', 'Dislike', false]]);
  assert.deepEqual(actionList(false).map((a) => [a.verdict, a.label, a.primary]), [['later', 'Read later', true], ['liked', 'Like', false], ['dismissed', 'Dislike', false]]);
  assert.deepEqual(actionList(true).map((a) => a.mark), [{ logo: 'zotero' }, { lucide: 'thumbsUp' }, { lucide: 'thumbsDown' }]);
  assert.deepEqual(actionList(false)[0].mark, { lucide: 'bookmark' });
  assert.ok([...actionList(true), ...actionList(false)].every((a) => a.hint.startsWith(`${a.label}:`)), 'each icon says what it is and what it teaches');
  assert.equal(settledLabel('dismissed'), 'Disliked');
  assert.equal(settledLabel('liked'), 'Liked');
  assert.equal(toastText('liked'), 'Liked: more like this');
  assert.equal(toastText('added'), 'Added to Zotero');
  assert.equal(toastText('undo'), 'Undone');
});

test('outsidePaper hands the host what it needs to add the paper', () => {
  const paper = outsidePaper(row({ pdfUrl: 'https://arxiv.org/pdf/2601.01234' }));
  assert.deepEqual([paper.title, paper.doi, paper.url, paper.source, paper.arxiv, paper.citations], ['Burrow depth', '10.1/a', 'https://doi.org/10.1/a', 'arXiv', '2601.01234', 3]);
  assert.equal(outsidePaper(row({ doi: null, url: 'https://x.example/p' })).url, 'https://x.example/p');
});
