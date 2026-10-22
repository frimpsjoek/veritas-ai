import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameOf, addressOf, blockedReason, createHistory, firstPrefer, pageQuery, sourceOf } from '../src/browser-state.js';
import { isPdfUrl, isWebUrl, linkMode, planOpen } from '../../ui/src/links.js';

test('back steps through the pages the panel showed, and stops at the first', () => {
  const h = createHistory();
  assert.equal(h.back(), null);
  h.push({ url: 'https://a.org/' });
  assert.equal(h.canGoBack, false);
  h.push({ url: 'https://b.org/' });
  assert.equal(h.canGoBack, true);
  h.replace({ url: 'https://b.org/', prefer: 'reader' });
  assert.deepEqual(h.back(), { url: 'https://a.org/' });
  assert.equal(h.canGoBack, false);
  assert.equal(h.back(), null);
  h.clear();
  assert.equal(h.current, null);
});

test('an http page inside an https app skips the frame the browser would block', () => {
  assert.equal(firstPrefer('http://old.example/x', 'https:'), 'reader');
  assert.equal(firstPrefer('https://new.example/x', 'https:'), undefined);
  assert.equal(firstPrefer('http://old.example/x', 'http:'), undefined);
});

test('the page query carries the address, and the reader preference only when asked', () => {
  assert.equal(pageQuery({ url: 'https://a.org/p?q=1&r=2' }).toString(), 'url=https%3A%2F%2Fa.org%2Fp%3Fq%3D1%26r%3D2');
  assert.equal(pageQuery({ url: 'https://a.org/', prefer: 'reader' }).get('prefer'), 'reader');
});

test('the address line is short and readable', () => {
  assert.equal(addressOf('https://www.arxiv.org/abs/2401.00001'), 'arxiv.org/abs/2401.00001');
  assert.equal(addressOf('https://example.org/'), 'example.org');
  assert.ok(addressOf(`https://example.org/${'a'.repeat(200)}`).length <= 60);
  assert.equal(addressOf('not a url'), 'not a url');
});

test('a card says why: the server reason, a refusal, or a plain default', () => {
  assert.equal(blockedReason({ mode: 'blocked', reason: 'The site needs you to sign in.' }, null), 'The site needs you to sign in.');
  assert.equal(blockedReason(null, Object.assign(new Error('That address is not on the public web'), { status: 400 })), 'That address is not on the public web');
  assert.match(blockedReason(null, Object.assign(new Error('x'), { status: 401 })), /Sign in/);
  assert.match(blockedReason(null, new Error('network')), /couldn't reach/);
});

test('PDF links are recognised by their address (D4)', () => {
  for (const url of ['https://x.org/files/paper.pdf', 'https://x.org/a.PDF?download=1', 'https://arxiv.org/pdf/2401.00001', 'https://export.arxiv.org/pdf/2401.00001v2']) assert.equal(isPdfUrl(url), true, url);
  for (const url of ['https://arxiv.org/abs/2401.00001', 'https://x.org/pdf-guide', 'nonsense']) assert.equal(isPdfUrl(url), false, url);
  assert.equal(isWebUrl('zotero://select/x'), false);
  assert.equal(isWebUrl('HTTPS://x.org'), true);
});

test('the openLinks setting reads inside unless it says outside', () => {
  const prefs = (v) => ({ get: () => v });
  assert.equal(linkMode(prefs(undefined)), 'inside');
  assert.equal(linkMode(prefs('inside')), 'inside');
  assert.equal(linkMode(prefs('outside')), 'outside');
  assert.equal(linkMode(prefs('junk')), 'inside');
});

test('a PDF link names its file', () => {
  assert.equal(fileNameOf('https://x.org/a/My%20Paper.pdf?x=1'), 'My Paper.pdf');
  assert.equal(fileNameOf('https://arxiv.org/pdf/'), 'PDF');
  assert.equal(fileNameOf('https://x.org/%E0%A4%A.pdf'), 'PDF');
});

test('where a link goes: inside by default, outside when marked or set so, the system for other schemes', () => {
  const on = { mode: 'inside', hasBrowser: true };
  assert.equal(planOpen('https://x.org/', undefined, on), 'inside');
  assert.equal(planOpen('https://x.org/', { outside: false }, on), 'inside');
  assert.equal(planOpen('https://x.org/', { outside: true }, on), 'outside');
  assert.equal(planOpen('https://x.org/', undefined, { mode: 'outside', hasBrowser: true }), 'outside');
  assert.equal(planOpen('https://x.org/', { outside: false }, { mode: 'outside', hasBrowser: true }), 'outside');
  assert.equal(planOpen('https://x.org/', undefined, { mode: 'inside', hasBrowser: false }), 'outside');
  assert.equal(planOpen('zotero://select/library/items/K1', undefined, on), 'scheme');
  assert.equal(planOpen('obsidian://open?vault=v', { outside: true }, on), 'scheme');
});

test('the bar says where a paper copy came from (spec 022)', () => {
  assert.equal(sourceOf({ mode: 'pdf', source: 'library' }), 'Your library');
  assert.equal(sourceOf({ mode: 'pdf', source: 'open access', version: 'submitted', where: 'arXiv (Cornell University)' }), 'Preprint (arXiv)');
  assert.equal(sourceOf({ mode: 'pdf', source: 'open access', version: 'published', where: 'PubMed Central' }), 'Open access (PubMed Central)');
  assert.equal(sourceOf({ mode: 'reader', source: 'openalex' }), 'Abstract only');
  assert.equal(sourceOf({ mode: 'frame' }), '');
  assert.equal(sourceOf(null), '');
});
