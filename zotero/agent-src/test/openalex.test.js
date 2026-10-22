import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAlexFetch, OpenAlexLimit } from '../src/openalex.js';
import { searchScholarly } from '../src/scholarly.js';
import { res, routedFetch } from './support/radar-fakes.mjs';

const WORKS = 'https://api.openalex.org/works?search=spindles';
const ok = () => res(200, JSON.stringify({ results: [] }));

test('the key is appended to OpenAlex calls only, read fresh each call, and other hosts are untouched', async () => {
  const seen = [];
  let key = null;
  const net = openAlexFetch(async (url) => { seen.push(String(url)); return ok(); }, () => key);
  await net(WORKS);
  key = ' secret-key ';
  await net(WORKS);
  await net('https://export.arxiv.org/api/query?x=1');
  assert.deepEqual(seen, [WORKS, `${WORKS}&api_key=secret-key`, 'https://export.arxiv.org/api/query?x=1']);
});

test('a 429 becomes OpenAlexLimit with resetsAt from retry-after, and the key never appears in the error', async () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  const net = openAlexFetch(async () => res(429, '{}', { 'retry-after': '3600' }), () => 'secret-key', { now: () => now });
  const err = await net(WORKS).catch((e) => e);
  assert.ok(err instanceof OpenAlexLimit);
  assert.equal(err.retryAfter, 3600);
  assert.equal(err.resetsAt, now + 3600_000);
  assert.match(err.message, /^OpenAlex's free daily limit is used up \(resets .+\)\. Add your free OpenAlex API key in Settings\.$/);
  assert.ok(!JSON.stringify(err).includes('secret-key') && !err.message.includes('secret-key') && !String(err.stack).includes('secret-key'));
});

test('without retry-after the block lasts until midnight UTC', async () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  const net = openAlexFetch(async () => res(429), () => null, { now: () => now });
  const err = await net(WORKS).catch((e) => e);
  assert.equal(err.resetsAt, Date.parse('2026-10-12T00:00:00Z'));
});

test('after a 429 later calls fail fast without a request, until the reset time; a newly saved key lifts it', async () => {
  let now = Date.parse('2026-10-11T10:00:00Z');
  let key = null;
  const calls = [];
  let answer = () => res(429, '{}', { 'retry-after': '60' });
  const net = openAlexFetch(async (url) => { calls.push(String(url)); return answer(); }, () => key, { now: () => now });
  await assert.rejects(net(WORKS), OpenAlexLimit);
  await assert.rejects(net(WORKS), OpenAlexLimit);
  await assert.rejects(net(WORKS), OpenAlexLimit);
  assert.equal(calls.length, 1, 'the breaker spent no second request');
  assert.equal(net.limitUntil(), now + 60_000);

  key = 'k';
  answer = ok;
  await net(WORKS);
  assert.equal(calls.length, 2, 'a key saved since the block is tried');
  assert.equal(net.limitUntil(), null);

  key = null;
  answer = () => res(429, '{}', { 'retry-after': '60' });
  await assert.rejects(net(WORKS), OpenAlexLimit);
  now += 61_000;
  answer = ok;
  await net(WORKS);
  assert.equal(calls.length, 4, 'after resetsAt requests flow again');
});

test('a scholarly search through the wrapper surfaces the limit message', async () => {
  const net = openAlexFetch(async () => res(429, '{}', { 'retry-after': '60' }), () => null);
  const err = await searchScholarly(net, 'spindles', { sources: ['openalex'] }).catch((e) => e);
  assert.ok(err instanceof OpenAlexLimit);
  assert.match(String(err?.message ?? err), /^OpenAlex's free daily limit is used up/);
});

test('routedFetch sanity: non-429 errors pass through unchanged', async () => {
  const net = openAlexFetch(routedFetch({}), () => null);
  assert.equal((await net(WORKS)).status, 404);
});
