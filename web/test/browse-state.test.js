import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TABS, emptyTabs, reduceTabs, saveLabel, shownTab, tabTitle } from '../src/browse-state.js';

test('the Save button says what happened, in the spec\'s words', () => {
  assert.equal(saveLabel(null), 'Save PDF to Zotero');
  // spec 032: without a Zotero library the PDF goes to Veritas's Papers folder
  assert.equal(saveLabel(null, false), 'Save PDF');
  assert.equal(saveLabel({ status: 'kept' }), 'Saved to Veritas › Papers');
  assert.equal(saveLabel({ status: 'saving' }), 'Saving…');
  assert.equal(saveLabel({ status: 'added' }), 'Saved to Zotero');
  assert.equal(saveLabel({ status: 'queued' }), 'Waiting for Zotero');
  assert.equal(saveLabel({ status: 'already' }), 'Already in Zotero');
  assert.equal(saveLabel({ status: 'failed', message: 'No PDF on this page' }), 'No PDF on this page');
  assert.equal(saveLabel({ status: 'failed' }), 'The PDF could not be saved');
});

test('opening a tab adds it and shows it', () => {
  let s = reduceTabs(emptyTabs(), { type: 'open', tab: 'a', url: 'https://doi.org/10.1021/x' });
  assert.deepEqual(s.tabs.map((t) => t.id), ['a']);
  assert.equal(s.shown, 'a');
  assert.equal(shownTab(s)?.url, 'https://doi.org/10.1021/x');
  s = reduceTabs(s, { type: 'open', tab: 'b', url: 'https://chemrxiv.org/' });
  assert.equal(s.shown, 'b');
  s = reduceTabs(s, { type: 'show', tab: 'a' });
  assert.equal(s.shown, 'a');
});

test('a ninth tab closes the one used longest ago that is not shown', () => {
  let s = emptyTabs();
  for (let i = 0; i < MAX_TABS; i++) s = reduceTabs(s, { type: 'open', tab: `t${i}`, url: `https://a.org/${i}` });
  s = reduceTabs(s, { type: 'show', tab: 't0' }); // t0 is now the most recently used, t1 the oldest
  s = reduceTabs(s, { type: 'open', tab: 't8', url: 'https://a.org/8' });
  assert.equal(s.tabs.length, MAX_TABS);
  assert.ok(!s.tabs.some((t) => t.id === 't1'));
  assert.ok(s.tabs.some((t) => t.id === 't0'));
  assert.equal(s.shown, 't8');
});

test('a closed tab goes, and the next one is shown', () => {
  let s = emptyTabs();
  for (const id of ['a', 'b', 'c']) s = reduceTabs(s, { type: 'open', tab: id, url: `https://a.org/${id}` });
  s = reduceTabs(s, { type: 'show', tab: 'b' });
  s = reduceTabs(s, { type: 'closed', tab: 'b' });
  assert.deepEqual(s.tabs.map((t) => t.id), ['a', 'c']);
  assert.equal(s.shown, 'c');
  s = reduceTabs(s, { type: 'closed', tab: 'a' });
  s = reduceTabs(s, { type: 'closed', tab: 'c' });
  assert.equal(s.shown, null);
  assert.equal(shownTab(s), null);
  assert.deepEqual(reduceTabs(s, { type: 'closed', tab: 'zz' }), s);
});

test('a page\'s state updates its title, address and the back and forward buttons', () => {
  let s = reduceTabs(emptyTabs(), { type: 'open', tab: 'a', url: 'https://doi.org/10.1021/x' });
  assert.equal(tabTitle(shownTab(s)), 'doi.org');
  s = reduceTabs(s, { type: 'state', tab: 'a', url: 'https://pubs.acs.org/doi/10.1021/x', title: 'A paper', canGoBack: true, canGoForward: false, loading: false });
  const tab = shownTab(s);
  assert.equal(tab?.url, 'https://pubs.acs.org/doi/10.1021/x');
  assert.equal(tabTitle(tab), 'A paper');
  assert.equal(tab?.canGoBack, true);
  assert.equal(tab?.canGoForward, false);
  assert.deepEqual(reduceTabs(s, { type: 'state', tab: 'gone', url: 'x', title: 'y', canGoBack: false, canGoForward: false, loading: false }), s);
});

test('a page that opens a new window gets a new tab, shown', () => {
  let s = reduceTabs(emptyTabs(), { type: 'open', tab: 'a', url: 'https://a.org/' });
  s = reduceTabs(s, { type: 'new-tab', tab: 'b', url: 'https://b.org/' });
  assert.deepEqual(s.tabs.map((t) => t.id), ['a', 'b']);
  assert.equal(s.shown, 'b');
});

test('a save state belongs to its tab, and a new address clears it', () => {
  let s = reduceTabs(emptyTabs(), { type: 'open', tab: 'a', url: 'https://a.org/' });
  s = reduceTabs(s, { type: 'saved', tab: 'a', status: 'added' });
  assert.equal(saveLabel(shownTab(s)?.save ?? null), 'Saved to Zotero');
  s = reduceTabs(s, { type: 'state', tab: 'a', url: 'https://a.org/', title: 'A', canGoBack: false, canGoForward: false, loading: false });
  assert.equal(shownTab(s)?.save?.status, 'added', 'same address: the state stays');
  s = reduceTabs(s, { type: 'state', tab: 'a', url: 'https://a.org/other', title: 'B', canGoBack: true, canGoForward: false, loading: true });
  assert.equal(shownTab(s)?.save, null);
});

test('a tab with no title shows its site, or New tab', () => {
  assert.equal(tabTitle({ url: 'https://www.nature.com/articles/x', title: '' }), 'nature.com');
  assert.equal(tabTitle({ url: '', title: '' }), 'New tab');
  assert.equal(tabTitle({ url: 'about:blank', title: '' }), 'New tab');
});

test('an arXiv tab\'s title reads as text; other sites keep theirs', () => {
  assert.equal(tabTitle({ url: 'https://arxiv.org/abs/2611.20723', title: '[2611.20723] Time-Dependent \\textit{GW} of \\ce{C2H4O}' }), '[2611.20723] Time-Dependent GW of C₂H₄O');
  assert.equal(tabTitle({ url: 'https://example.org/', title: 'A -- B' }), 'A -- B');
});
