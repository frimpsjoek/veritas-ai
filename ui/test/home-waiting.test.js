// @ts-check
// Spec 028 R5–R7: the count of new papers is over the last 7 days only; a paper opened from the reader page is one
// less, told once even when Home tells it too. Invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingPapers, NEWS_DAYS } from '../src/home/waiting.js';
import { RadarDigest, markViewed } from '../src/chat/radar-digest.js';

const NOW = Date.parse('2026-11-17T09:00:00Z');
const ago = (/** @type {number} */ days) => new Date(NOW - days * 86_400_000).toISOString();

test('only issues with news from the last 7 days count', () => {
  assert.equal(NEWS_DAYS, 7);
  const list = [
    { id: 'today', updated: ago(0), news: { papers: 4, at: ago(0) } },
    { id: 'week', updated: ago(6.9), news: { papers: 2, at: ago(6.9) } },
    { id: 'old', updated: ago(8), news: { papers: 300, at: ago(8) } },
    { id: 'read', updated: ago(0) },
  ];
  assert.equal(waitingPapers(list, NOW), 6, 'the 8-day-old issue does not count; today and 6.9 days ago do');
});

test("news.at is the issue's age, not a later chat about it; updated is the fallback; a bad date still counts", () => {
  assert.equal(waitingPapers([{ updated: ago(0), news: { papers: 5, at: ago(9) } }], NOW), 0, 'chatting today about an old issue brings no new papers');
  assert.equal(waitingPapers([{ updated: ago(1), news: { papers: 5, at: '' } }], NOW), 5);
  assert.equal(waitingPapers([{ updated: ago(10), news: { papers: 5 } }], NOW), 0);
  assert.equal(waitingPapers([{ news: { papers: 2, at: 'not a date' } }], NOW), 2);
  assert.equal(waitingPapers([], NOW), 0);
});

/** @param {{ fail?: boolean }} [opts] */
function fakeHost({ fail = false } = {}) {
  const told = /** @type {any[]} */ ([]);
  let changed = 0;
  const ai = { conversations: { markViewed: async (/** @type {string} */ id, /** @type {string[]} */ rows) => { told.push([id, rows]); if (fail) throw new Error('down'); } } };
  const host = /** @type {any} */ ({ can: {}, ai: async () => ai, logError() {}, newsChanged: () => { changed += 1; } });
  return { host, told, changed: () => changed };
}

test('the reader and Home telling the same paper at once: the engine is told once, and both hear it was told', async () => {
  const { host, told, changed } = fakeHost();
  const [reader, home] = await Promise.all([markViewed(host, 'S-both', 'r1'), markViewed(host, 'S-both', 'r1')]);
  assert.deepEqual(told, [['S-both', ['r1']]]);
  assert.deepEqual([reader, home], [true, true], 'Home still recounts when the reader told first');
  assert.equal(await markViewed(host, 'S-both', 'r1'), false, 'told already: nothing new');
  assert.equal(changed(), 1, 'the host hears of the change once (the rail badge reads again)');
});

test('a failed tell is tried again on the next open', async () => {
  const down = fakeHost({ fail: true });
  assert.equal(await markViewed(down.host, 'S-fail', 'r1'), false);
  assert.equal(down.changed(), 0);
  const up = fakeHost();
  assert.equal(await markViewed(up.host, 'S-fail', 'r1'), true);
});

test("a reader link knows its issue's session and row: opening it marks the paper viewed", async () => {
  const { host, told } = fakeHost();
  const digest = new RadarDigest(host, /** @type {any} */ ({}), /** @type {any} */ ({}), { routine: 'rad', summary: '' });
  digest.session = 'S-issue';
  const link = digest.readerLink(/** @type {any} */ ({ id: 'row-7', title: 'An invented paper', doi: '10.1/x', radar: { key: 'doi:10.1/x' } }));
  digest.session = 'S-other'; // Home's digest moves on to another issue; the link keeps its own
  assert.ok(link?.viewed);
  await link.viewed();
  assert.deepEqual(told, [['S-issue', ['row-7']]]);
});
