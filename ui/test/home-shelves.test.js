// Home's count of new papers going down as papers are opened, its Earlier issues shelf one row at a time, and no Chats
// shelf; on a minimal fake DOM, as home-run-now.test.js. Invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintHome } from '../src/home/home.js';

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.disabled = false; this.hidden = false; this.type = ''; this.tabIndex = -1;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (c) => { if (!this.classList.contains(c)) this.className += ` ${c}`; },
      remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle: (c, on) => (on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  get firstChild() { return this.children[0] ?? null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === root; }
  append(...nodes) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); } }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this._text = ''; this.children = []; this.append(...nodes); }
  replaceWith(node) { const p = this.parent; if (!p) return; node.parent?.children.splice(node.parent.children.indexOf(node), 1); p.children[p.children.indexOf(this)] = node; node.parent = p; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  toggleAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { return Promise.all((this.listeners.click ?? []).map((f) => f({ preventDefault() {} }))); }
  walk() { return this.children.flatMap((c) => [c, ...c.walk()]); }
  find(cls) { return this.walk().filter((n) => n.className.split(/\s+/).includes(cls)); }
  querySelector(sel) { return sel.startsWith('.') ? this.find(sel.slice(1))[0] ?? null : null; }
}
const doc = { createElementNS: (_ns, tag) => new El(tag) };
const root = new El('root');
const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const radar = { id: 'rad', name: 'Reading radar', kind: 'radar', status: 'active', radar: { sources: [] }, nextRun: daysAgo(-1), lastRun: null };
const rows = ['a', 'b', 'c'].map((id) => ({ id, title: `Invented paper ${id}`, url: `https://example.org/${id}`, authors: [] }));

/** @param {{ conversations: any[], markViewed?: boolean }} opts */
function setup({ conversations, markViewed = true }) {
  const state = { conversations, viewed: /** @type {any[]} */ ([]), waiting: /** @type {number[]} */ ([]) };
  const ai = {
    conversations: {
      list: async () => state.conversations.map((c) => ({ ...c })),
      // as the engine does, simplified: each row is one paper less of news
      ...(markViewed ? { markViewed: async (id, ids) => {
        state.viewed.push([id, ids]);
        const c = state.conversations.find((x) => x.id === id);
        if (c?.news) c.news = c.news.papers - ids.length > 0 ? { ...c.news, papers: c.news.papers - ids.length } : undefined;
      } } : {}),
    },
    sessions: { view: async () => ({ results: [{ kind: 'papers', ref: { id: 'R1', version: 1 }, title: 'New' }] }), read: async () => ({ rows }) },
    routines: { list: async () => [radar] },
  };
  const host = { kind: 'web', prefs: { get: () => null, set() {} }, logError() {}, json: async () => ({}), ai: async () => ai };
  const links = { href: () => '#', open() {} };
  const into = new El('div');
  root.replaceChildren(into);
  return { state, into, paint: () => paintHome(into, { host, doc, links, onWaiting: (n) => state.waiting.push(n) }) };
}
const countLine = (into) => into.find('sbw-home-date')[0].textContent;
const titles = (into) => into.find('sbw-paper-title');

test('opening a paper on Home lowers the new-paper count by one, once per paper, down to none', async () => {
  const t = setup({ conversations: [{ id: 'S1', mode: 'chat', title: 'Reading radar', routine: 'rad', updated: new Date().toISOString(), cover: { kind: 'radar', count: '3 new papers' }, news: { papers: 2, at: daysAgo(0) } }] });
  await t.paint();
  assert.equal(countLine(t.into), '2 new papers');
  assert.deepEqual(t.state.waiting, [2]);
  await titles(t.into)[0].click();
  await flush();
  assert.deepEqual(t.state.viewed, [['S1', ['a']]]);
  assert.equal(countLine(t.into), '1 new paper');
  assert.equal(t.state.waiting.at(-1), 1, 'the rail badge follows');
  await titles(t.into)[0].click();
  await flush();
  assert.equal(t.state.viewed.length, 1, 'the same paper is told once');
  await titles(t.into)[1].click();
  await flush();
  assert.equal(t.state.waiting.at(-1), 0);
  assert.doesNotMatch(countLine(t.into), /new paper/, 'none left: the date again');
});

test('an older server without markViewed: opening a paper changes nothing and throws nothing', async () => {
  const t = setup({ markViewed: false, conversations: [{ id: 'S2', mode: 'chat', title: 'Reading radar', routine: 'rad', updated: new Date().toISOString(), cover: { kind: 'radar' }, news: { papers: 3, at: daysAgo(0) } }] });
  await t.paint();
  await titles(t.into)[0].click();
  await flush();
  assert.equal(countLine(t.into), '3 new papers');
});

test('Earlier issues shows one row with Previous and Next a row at a time; Home has no Chats shelf', async () => {
  const issues = Array.from({ length: 6 }, (_, i) => ({ id: `I${i}`, mode: 'chat', title: 'Reading radar', routine: 'rad', updated: daysAgo(i + 1), cover: { kind: 'radar', quote: `Issue ${i}` } }));
  const chats = Array.from({ length: 3 }, (_, i) => ({ id: `C${i}`, mode: 'chat', title: `A question ${i}`, updated: daysAgo(i), kind: 'chat', cover: { kind: 'chat', title: `A question ${i}` } }));
  const report = { id: 'R', mode: 'chat', title: 'New chat', updated: daysAgo(3), kind: 'report', cover: { kind: 'report', title: 'An invented review' } };
  const t = setup({ conversations: [...issues, ...chats, report] });
  await t.paint();
  const shelves = t.into.find('sbw-shelf');
  assert.deepEqual(shelves.map((s) => s.find('sbw-shelf-title')[0].textContent), ['Research reports', 'Earlier issues']);
  const earlier = shelves[1];
  const covers = () => earlier.find('sbw-cover-line').map((c) => c.textContent);
  assert.equal(earlier.find('sbw-shelf-count')[0].textContent, '6');
  assert.deepEqual(covers(), ['Issue 0', 'Issue 1', 'Issue 2', 'Issue 3'], 'one row of four, newest first');
  assert.equal(earlier.find('sbw-pager-where')[0].textContent, '1 of 2');
  await earlier.find('sbw-pager-next')[0].click();
  assert.deepEqual(covers(), ['Issue 4', 'Issue 5']);
  assert.equal(earlier.find('sbw-pager-where')[0].textContent, '2 of 2');
  await earlier.find('sbw-pager-prev')[0].click();
  assert.deepEqual(covers(), ['Issue 0', 'Issue 1', 'Issue 2', 'Issue 3']);
  // Research reports keeps its pages of 8: one report, no pager
  assert.equal(shelves[0].find('sbw-pager').length, 0);
});

test('a long issue offers its next papers, and says how many are left', async () => {
  const { moreLabel } = await import('../src/home/home.js');
  assert.equal(moreLabel(22), 'Show 8 more (22 left)');
  assert.equal(moreLabel(8), 'Show 8 more');
  assert.equal(moreLabel(3), 'Show 3 more');
  assert.equal(moreLabel(5, 3), 'Show 3 more (5 left)');
  assert.equal(moreLabel(1, 3), 'Show 1 more');
});
