// @ts-check
// Spec 028 R6: a radar paper opened in the reader panel is no longer news. createBrowserPanel on the small fake DOM
// (support/fake-dom.js), with a server that does not answer, so the panel shows its card. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPanel } from '../src/browser-panel.js';
import { fakeDoc } from './support/fake-dom.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

test('opening a radar paper in the panel tells its issue it was viewed; a link without one tells nothing', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ ({ can: {}, json: async () => { throw new Error('offline'); }, openLink() {}, logError() {} });
  const into = /** @type {any} */ (doc.createElementNS('', 'main'));
  const panel = createBrowserPanel({ host, doc, win: doc.defaultView, into });
  let viewed = 0;
  const radar = /** @type {any} */ ({ routine: 'r1', key: 'k1', paper: { title: 'Invented study', doi: '10.9999/inv.1' }, verdict: () => null, tell: async () => null, viewed: async () => { viewed += 1; return true; } });
  panel.open('https://doi.org/10.9999/inv.1', radar);
  await flush();
  assert.equal(viewed, 1);
  assert.equal(panel.isOpen, true);
  panel.close();
  panel.open('https://example.org/page');
  await flush();
  assert.equal(viewed, 1);
});
