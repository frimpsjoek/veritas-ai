import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverOf, firstSentence, readableQuestion } from '../src/sessions.js';

const meta = { type: 'meta', id: 'C1', mode: 'chat', title: 'New chat', created: '2026-10-11T10:00:00Z' };
const papers = (id, rows) => ({ type: 'result', summary: { ref: { id, version: 1 }, kind: 'papers', title: 'Papers', versions: 1, rows, columns: [], updated: 'x' }, at: 'x' });

test('firstSentence strips markdown and citation marks and stops at the first sentence', () => {
  assert.equal(firstSentence('## Answer\n**Quantum dots** trap carriers [@smith2020]. Second sentence.'), 'Quantum dots trap carriers.');
  assert.equal(firstSentence('See [the paper](https://x.org) now'), 'See the paper now');
  assert.equal(firstSentence('word '.repeat(60), 40).length <= 40, true);
});

test('a chat cover is its first question, the opening of its last answer and its resolved sources', () => {
  const cover = coverOf([meta,
    { type: 'user', text: 'What limits dot coherence?', attachments: [], web: 'off', at: 'a' },
    { type: 'assistant', answer: { text: 'Charge noise dominates. More below.', citations: [{ status: 'resolved' }, { status: 'resolved' }, { status: 'unknown' }] }, at: 'b' }]);
  assert.deepEqual(cover, { kind: 'chat', title: 'What limits dot coherence?', quote: 'Charge noise dominates.', by: '2 sources' });
});

test('an empty chat has no cover', () => {
  assert.equal(coverOf([meta]), undefined);
});

test('a session holding a report reads as that report, even when it began as a find', () => {
  const cover = coverOf([meta,
    { type: 'step', id: 'S1', input: { kind: 'find', query: 'excited states' }, at: 'a' }, papers('R1', 42),
    { type: 'step', id: 'S2', input: { kind: 'report', request: { question: 'Recent reviews of excited states' } }, at: 'b' },
    { type: 'result', summary: { ref: { id: 'R2', version: 1 }, kind: 'report', title: 'Excited States: A Review', versions: 1, rows: null, columns: [], updated: 'c' }, at: 'c' }]);
  assert.deepEqual(cover, { kind: 'report', title: 'Excited States: A Review', quote: 'Recent reviews of excited states', by: '42 papers' });
});

test('a radar run reads as its top paper and how many it found', () => {
  const cover = coverOf([meta,
    { type: 'step', id: 'S1', input: { kind: 'radar', routine: 'RT' }, at: 'a' }, papers('R1', 8),
    { type: 'routine_run', routine: 'RT', added: 8, top: { title: 'Bright single-photon sources', by: 'A. Author, Nature' }, at: 'b' }]);
  assert.deepEqual(cover, { kind: 'radar', quote: 'Bright single-photon sources', by: 'A. Author, Nature', count: '8 new papers' });
});

test('a find reads as its query and its paper count', () => {
  assert.deepEqual(coverOf([meta, { type: 'step', id: 'S1', input: { kind: 'find', query: 'quantum dot defects' }, at: 'a' }, papers('R1', 1)]),
    { kind: 'find', quote: 'quantum dot defects', by: '1 paper' });
});

test('a machine-made attachment name in the question reads as what the attachment is', () => {
  assert.equal(readableQuestion('Summarize stn-UYsg1j5y8PFZRFNIpGk3zmuayGsiZTBuJeXRuJbN', [{ kind: 'note', path: 'attachments/stn-UYsg1j5y8PFZRFNIpGk3zmuayGsiZTBuJeXRuJbN.jpeg' }]), 'Summarize an image');
  assert.equal(readableQuestion('Summarize Inkpen et al. 2019', []), 'Summarize Inkpen et al. 2019');
  assert.equal(readableQuestion('What does the abstract-level-overview say?', []), 'What does the abstract-level-overview say?');
  assert.equal(firstSentence('Excitons form fast. [[attachments/x.jpeg]]'), 'Excitons form fast.');
  assert.equal(firstSentence('Excitons [[attachments/x.jpeg]] form fast.'), 'Excitons form fast.');
});
