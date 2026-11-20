// @ts-check
// Spec 028 R5/R7: the rail's Home badge reads the count again on every view, at most once per 2 s, and counts only
// the last week's issues. Invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_GAP_MS, followNews, newsBadge, showWaiting } from '../src/news-badge.js';
import { fakeWin } from './support/fake-dom.js';

function fakeDoc() {
  const element = (/** @type {string} */ cls = '') => {
    const kids = /** @type {any[]} */ ([]);
    return {
      className: cls, textContent: '', hidden: false, kids, dataset: {},
      setAttribute() {}, append(/** @type {any[]} */ ...nodes) { kids.push(...nodes); },
      querySelector: (/** @type {string} */ sel) => kids.find((k) => `.${k.className}` === sel) ?? null,
    };
  };
  const home = element('sbw-nav-item');
  return { home, doc: /** @type {any} */ ({ createElementNS: () => element(), querySelector: (/** @type {string} */ sel) => (sel === '.sbw-nav-item[data-view="home"]' ? home : null) }) };
}

const NOW = Date.parse('2026-11-17T09:00:00Z');
const ago = (/** @type {number} */ days) => new Date(NOW - days * 86_400_000).toISOString();

function setup() {
  const { home, doc } = fakeDoc();
  let t = NOW;
  let lists = 0;
  /** @type {(() => void)[]} */ const timers = [];
  let conversations = [
    { id: 'today', updated: ago(0), news: { papers: 3, at: ago(0) } },
    { id: 'old', updated: ago(8), news: { papers: 363, at: ago(8) } },
  ];
  const host = { ai: async () => ({ conversations: { list: async () => { lists += 1; return conversations; } } }), logError() {} };
  const badge = newsBadge(doc, host, { now: () => t, setTimer: (fn) => { timers.push(fn); } });
  const text = () => home.querySelector('.sbw-nav-badge')?.textContent;
  return {
    badge, text, timers, home,
    lists: () => lists,
    tick: (/** @type {number} */ ms) => { t += ms; },
    set: (/** @type {any[]} */ next) => { conversations = next; },
  };
}

test('the badge counts only the last week, not every issue ever', async () => {
  const s = setup();
  await s.badge.refresh();
  assert.equal(s.text(), '3');
});

test('route changes inside 2 s read once more at the end of the gap; a forced read (markViewed) reads at once', async () => {
  const s = setup();
  await s.badge.refresh();
  assert.equal(s.lists(), 1);
  s.tick(500);
  await s.badge.refresh();
  await s.badge.refresh();
  assert.equal(s.lists(), 1, 'inside the gap: no read yet');
  assert.equal(s.timers.length, 1, 'one read queued for the end of the gap, however many calls');
  s.set([{ id: 'today', updated: ago(0), news: { papers: 2, at: ago(0) } }]);
  s.tick(BADGE_GAP_MS);
  s.timers[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.lists(), 2);
  assert.equal(s.text(), '2', 'the queued read shows the latest count');
  s.set([]);
  await s.badge.refresh(true);
  assert.equal(s.lists(), 3);
  assert.equal(s.home.querySelector('.sbw-nav-badge')?.hidden, true, 'none waiting: hidden');
});

test('a failed read leaves the badge as it was', async () => {
  const { home, doc } = fakeDoc();
  showWaiting(doc, 4);
  const badge = newsBadge(doc, { ai: async () => { throw new Error('down'); }, logError() {} });
  await badge.refresh();
  assert.equal(home.querySelector('.sbw-nav-badge')?.textContent, '4');
});

test('the shell\'s wiring: a route change and the window\'s focus read again, newsChanged reads at once; stop undoes it', () => {
  const win = /** @type {any} */ (fakeWin());
  const host = /** @type {any} */ ({});
  const reads = /** @type {string[]} */ ([]);
  const news = followNews(win, host, { refresh: async (force = false) => { reads.push(force ? 'now' : 'gap'); } });
  news.start();
  news.route();
  win.dispatchEvent({ type: 'focus' });
  host.newsChanged();
  assert.deepEqual(reads, ['gap', 'gap', 'now']);
  news.stop();
  assert.equal(win.count('focus'), 0);
  assert.equal(host.newsChanged, undefined);
});
