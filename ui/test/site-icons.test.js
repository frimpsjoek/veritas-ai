import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconFor, setSiteIconResolver } from '../src/logos.js';

/** Just enough of a document for an <img>. */
const fakeDoc = { createElement: () => ({ addEventListener() {}, replaceWith() {} }) };
const journal = { label: 'Some Journal', openalexId: 'S123' };

test('a site icon is the server-relative path by default (the page is on the server)', () => {
  setSiteIconResolver(null);
  assert.equal(iconFor(/** @type {any} */ (fakeDoc), journal, { web: true }).src, '/site-icon?openalex=S123');
});

test('a web app on another origin asks its server for the icon (with the token, as a blob URL)', async () => {
  setSiteIconResolver(async (path) => `blob:veritas/${path.length}`);
  const img = iconFor(/** @type {any} */ (fakeDoc), journal, { web: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(img.src, `blob:veritas/${'/site-icon?openalex=S123'.length}`);
  setSiteIconResolver((path) => `http://server.example${path}`);
  assert.equal(iconFor(/** @type {any} */ (fakeDoc), journal, { web: true }).src, 'http://server.example/site-icon?openalex=S123');
  setSiteIconResolver(null);
});
