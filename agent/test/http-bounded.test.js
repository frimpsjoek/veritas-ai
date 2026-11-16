import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText } from '../src/http-bounded.js';

function chunks(values) {
  let index = 0;
  const reader = {
    cancelled: false,
    async read() {
      return index >= values.length ? { done: true } : { done: false, value: new TextEncoder().encode(values[index++]) };
    },
    async cancel() { this.cancelled = true; },
    releaseLock() {},
  };
  return { body: { getReader: () => reader }, reader };
}

test('bounded reader stops and cancels an oversized chunked body before the cap is exceeded in memory', async () => {
  const response = chunks(['abc', 'def']);
  await assert.rejects(readBoundedText(response, 4), /too large/);
  assert.equal(response.reader.cancelled, true);
});

test('bounded reader handles multibyte boundaries and applies the fallback cap', async () => {
  const response = chunks(['a', 'b']);
  assert.equal(await readBoundedText(response, 2), 'ab');
  await assert.rejects(readBoundedText({ text: async () => 'abcdef' }, 2), /too large/);
});
