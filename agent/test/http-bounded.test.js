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

test('bounded reader handles multibyte boundaries', async () => {
  const response = chunks(['a', 'b']);
  assert.equal(await readBoundedText(response, 2), 'ab');
});

test('bounded reader rejects a declared oversized fallback body without reading it', async () => {
  let reads = 0;
  let cancellations = 0;
  const response = {
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? '3' : null },
    body: { cancel: async () => { cancellations += 1; } },
    text: async () => { reads += 1; return 'abc'; },
  };
  await assert.rejects(readBoundedText(response, 2), (error) => error.status === 413);
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
});

test('bounded reader refuses a response without a streaming reader instead of buffering it', async () => {
  let reads = 0;
  const response = { text: async () => { reads += 1; return 'abc'; } };
  await assert.rejects(readBoundedText(response, 100), (error) => error.status === 503);
  assert.equal(reads, 0);
});
