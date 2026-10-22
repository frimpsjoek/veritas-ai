// @ts-check
// Phase 3 Task 4: images, PDFs and opened files from a server on another origin, where no cookie goes along.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssets } from '../src/assets.js';

/** A fetch that records each call and answers from `reply`. @param {(url: string, init: any) => Response} reply */
function recorder(reply) {
  /** @type {{ url: string, init: any }[]} */ const calls = [];
  const fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => { calls.push({ url, init }); return reply(url, init); });
  return { calls, fetch };
}

/** URL.createObjectURL / revokeObjectURL stand-ins that count what is live. */
function blobUrls() {
  let n = 0;
  const live = new Set();
  return {
    live,
    URL: /** @type {any} */ ({
      createObjectURL: () => { const u = `blob:test/${++n}`; live.add(u); return u; },
      revokeObjectURL: (/** @type {string} */ u) => { live.delete(u); },
    }),
  };
}

test('same origin keeps plain paths', async () => {
  const { calls, fetch } = recorder(() => new Response(new Uint8Array([37, 80, 68, 70])));
  const urls = blobUrls();
  const assets = createAssets({ base: 'https://mac.example.ts.net', token: null, fetch, URL: urls.URL });
  assert.equal(await assets.url('/file?path=fig.png'), '/file?path=fig.png');
  assert.equal(await assets.frame('/zotero/pdf', { key: 'ABCD1234' }), 'https://mac.example.ts.net/zotero/pdf?key=ABCD1234');
  assert.equal(calls.length, 0, 'no fetch for an image or a frame');
  const bytes = await assets.bytes('/zotero/pdf?key=ABCD1234');
  assert.equal(new Uint8Array(bytes)[0], 37);
  assert.equal(calls[0].init.headers?.Authorization, undefined, 'the cookie signs in, not a header');
});

test('cross origin fetches with the token and returns a blob URL', async () => {
  const { calls, fetch } = recorder((url) => (url.includes('missing') ? new Response('{"error":"no such file"}', { status: 404 }) : new Response(new Blob(['png']))));
  const urls = blobUrls();
  const assets = createAssets({ base: 'https://mac.example.ts.net', token: 'tok', fetch, URL: urls.URL });
  const url = await assets.url('/file?path=fig.png');
  assert.match(url, /^blob:/);
  assert.equal(calls[0].url, 'https://mac.example.ts.net/file?path=fig.png');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(await assets.url('/file?path=fig.png'), url, 'the same path is fetched once');
  assert.equal(calls.length, 1);
  await assets.bytes('/zotero/pdf?key=K');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
  await assert.rejects(assets.url('/file?path=missing.png'), /no such file/);
  assert.equal(await assets.url('https://example.org/a.png'), 'https://example.org/a.png', 'a web address is left alone');
});

test('frames get a ticket URL', async () => {
  const { calls, fetch } = recorder(() => new Response(JSON.stringify({ ticket: 'tk 1', expires_in: 120 })));
  const assets = createAssets({ base: 'https://mac.example.ts.net', token: 'tok', fetch, URL: blobUrls().URL });
  const url = await assets.frame('/folder-file', { path: 'papers:/a b.pdf' });
  assert.equal(calls[0].url, 'https://mac.example.ts.net/web/ticket');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { route: '/folder-file', query: { path: 'papers:/a b.pdf' } });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://mac.example.ts.net/folder-file');
  assert.equal(parsed.searchParams.get('path'), 'papers:/a b.pdf');
  assert.equal(parsed.searchParams.get('ticket'), 'tk 1');
  assert.ok(!url.includes('tok&') && !url.endsWith('tok'), 'the long-lived token is not in the URL');
});

test('revokes blob URLs it made when the view closes', async () => {
  const { fetch } = recorder(() => new Response(new Blob(['x'])));
  const urls = blobUrls();
  const assets = createAssets({ base: 'https://mac.example.ts.net', token: 'tok', fetch, URL: urls.URL });
  await assets.url('/file?path=a.png');
  await assets.url('/file?path=b.png');
  assert.equal(urls.live.size, 2);
  assets.revokeAll();
  assert.equal(urls.live.size, 0);
  // after closing, the same image is fetched again rather than handed a dead URL
  const again = await assets.url('/file?path=a.png');
  assert.ok(urls.live.has(again));
});
