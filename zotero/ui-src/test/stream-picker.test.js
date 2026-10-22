// Spec 008: the pure pieces behind streaming (S5, A3) and the context picker (C3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleText, hasTableBlock, formatElapsed } from '../src/chat/stream.js';
import { rankCandidates, PICKER_LIMIT } from '../src/chat/fuzzy.js';

test('visibleText drops closed think blocks, cuts at an open one, and holds back a half-received tag', () => {
  assert.equal(visibleText('<think>plan</think>Answer'), 'Answer');
  assert.equal(visibleText('A <think>x</think>B <think>y</think>C'), 'A B C');
  assert.equal(visibleText('Answer so far <think>still going'), 'Answer so far ');
  assert.equal(visibleText('Answer <thi'), 'Answer ');
  assert.equal(visibleText('<'), '');
  assert.equal(visibleText('a < b and 2 > 1'), 'a < b and 2 > 1');
});

test('the chat\'s sb-table block never shows while streaming: cut at an open fence, removed once closed, half fence held back', () => {
  const open = 'Here is the table.\n\n```sb-table\n{ "title": "T",\n';
  assert.equal(visibleText(open), 'Here is the table.\n');
  assert.ok(hasTableBlock(open));
  const closed = `${open}"rows": [] }\n\`\`\`\n\nAnd a note.`;
  assert.equal(visibleText(closed), 'Here is the table.\n\n\nAnd a note.');
  assert.ok(hasTableBlock(closed));
  assert.equal(visibleText('Text\n```sb-tab'), 'Text\n');
  assert.ok(!hasTableBlock('Text\n```sb-tab'));
  // ordinary code fences and a closing fence at the very end are untouched
  assert.equal(visibleText('Code:\n```js\nlet a;\n```'), 'Code:\n```js\nlet a;\n```');
  assert.ok(!hasTableBlock('Code:\n```js\nlet a;\n```'));
  // the fence and the thinking filter compose
  assert.equal(visibleText('<think>x</think>Hi\n```sb-table\n{'), 'Hi');
});

test('formatElapsed reads Xs, Xm Ys, Xh Ym Zs', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(125_000), '2m 5s');
  assert.equal(formatElapsed(3_612_000), '1h 0m 12s');
});

const cand = (category, label) => ({ category, label, attachment: { kind: 'note', path: `${label}.md` } });

test('rankCandidates keeps categories in a fixed order and at most PICKER_LIMIT rows', () => {
  const candidates = [cand('collection', 'Voles'), cand('paper', 'Vole foraging'), ...Array.from({ length: 50 }, (_, i) => cand('note', `vole note ${i}`))];
  const groups = rankCandidates(candidates, 'vole');
  assert.deepEqual(groups.map((g) => g.category), ['note', 'paper', 'collection']);
  assert.equal(groups.flatMap((g) => g.items).length, PICKER_LIMIT);
});

test('a category with one match still shows it when another has many better ones', () => {
  const candidates = [cand('paper', 'Foraging Strategies of the Lesser Spangled Vole'), ...Array.from({ length: 50 }, (_, i) => cand('note', `vole ${i}`))];
  const papers = rankCandidates(candidates, 'vole').find((g) => g.category === 'paper');
  assert.equal(papers?.items.length, 1);
});

test('rankCandidates matches subsequences and ranks a whole-word hit first', () => {
  const candidates = [cand('note', 'various old entries'), cand('note', 'Vole diary'), cand('note', 'Doorknobs')];
  const labels = rankCandidates(candidates, 'vole').flatMap((g) => g.items.map((c) => c.label));
  assert.deepEqual(labels, ['Vole diary', 'various old entries']);
});
