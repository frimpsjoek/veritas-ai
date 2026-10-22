import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepeatGuard } from '../src/local/guards.js';

function feed(guard, text, size = 7) {
  for (let i = 0; i < text.length; i += size) if (guard.push(text.slice(i, i + size))) return true;
  return false;
}

test('three copies of the same line stop the stream and keep only the first', () => {
  const g = createRepeatGuard();
  const stopped = feed(g, 'The answer is in [@smith2020].\nThe model failed to converge on this data.\nThe model failed to converge on this data.\nThe model failed to converge on this data.\nmore');
  assert.equal(stopped, true);
  assert.equal(g.stopped(), true);
  assert.equal(g.text(), 'The answer is in [@smith2020].\nThe model failed to converge on this data.');
});

test('a repeated sentence without newlines is caught too', () => {
  const g = createRepeatGuard();
  assert.equal(feed(g, 'It works. It works well enough for this. It works well enough for this. It works well enough for this. And more'), true);
  assert.equal(g.text(), 'It works. It works well enough for this.');
});

test('short repeats and a line seen only twice are fine', () => {
  const g = createRepeatGuard();
  assert.equal(feed(g, 'Yes.\nYes.\nYes.\nYes.\nSee [@a1].\nSee [@a1].\nDone and dusted.\n'), false);
  assert.equal(g.stopped(), false);
  assert.match(g.text(), /Done and dusted/);
});

test('once tripped it stays tripped and the text does not grow', () => {
  const g = createRepeatGuard({ minChars: 5, times: 2 });
  assert.equal(g.push('hello world\nhello world\n'), true);
  assert.equal(g.push('more text'), true);
  assert.equal(g.text(), 'hello world');
});
