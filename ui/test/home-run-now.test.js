// Home's "Run now" under today's radar banner, on a minimal fake DOM: it starts the radar, reads "Running…" while it
// runs, shows a refusal in its place for a moment, repaints today's issue when the run is recorded, and is not there
// in a host without runNow. Invented content.
import { test, mock } from 'node:test';
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

const today = new Date();
const later = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59).toISOString();
const radar = (over = {}) => ({ id: 'rad', name: 'Reading radar', kind: 'radar', status: 'active', radar: { sources: [] }, nextRun: later, lastRun: null, ...over });
const issue = { id: 'S1', title: 'Radar', routine: 'rad', updated: new Date().toISOString(), cover: { kind: 'radar', count: '3 new papers' } };

function setup({ routine = radar(), runNow = async () => ({ started: true }), withRunNow = true } = {}) {
  const state = { routine, conversations: [], calls: [] };
  const routines = { list: async () => [state.routine] };
  if (withRunNow) routines.runNow = async (id) => { state.calls.push(id); return runNow(id); };
  const ai = {
    conversations: { list: async () => state.conversations },
    sessions: { view: async () => ({ results: [] }), read: async () => null },
    routines,
  };
  const host = { kind: 'web', prefs: { get: () => null, set() {} }, logError() {}, json: async () => ({}), ai: async () => ai };
  const links = { href: () => '#', open() {} };
  const into = new El('div');
  root.replaceChildren(into);
  return { state, into, paint: () => paintHome(into, { host, doc, links }) };
}
const runLink = (into) => into.find('sbw-today-run')[0];

test('Run now sits in the today bar as a quiet link beside Sources, and starts the radar', async () => {
  mock.timers.enable({ apis: ['setTimeout'] }); // no real 5 s poll left behind
  try {
    const t = setup();
    await t.paint();
    const bar = t.into.find('sbw-today-bar')[0];
    const run = runLink(t.into);
    assert.ok(run, 'the link is there while no issue exists yet ("Nothing new yet today")');
    assert.match(t.into.find('sbw-today-stage')[0].textContent, /Nothing new yet today/);
    assert.equal(run.parent, bar);
    assert.ok(run.classList.contains('sbw-quiet'));
    assert.equal(run.textContent, 'Run now');
    await run.click();
    assert.deepEqual(t.state.calls, ['rad']);
    assert.equal(run.textContent, 'Running…');
    assert.equal(run.disabled, true);
  } finally { mock.timers.reset(); }
});

test('while it runs Home checks the radar every 5 s and repaints today when the run is recorded', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = setup();
    await t.paint();
    await runLink(t.into).click();
    t.state.routine = radar({ running: true });
    mock.timers.tick(5000);
    await flush();
    assert.equal(runLink(t.into).textContent, 'Running…', 'still running: nothing changes');
    t.state.routine = radar({ lastRun: { at: new Date().toISOString(), status: 'done', added: 3, session: 'S1' } });
    t.state.conversations = [issue];
    mock.timers.tick(5000);
    await flush();
    assert.match(t.into.find('sbw-today-stage')[0].textContent, /3 new papers/, 'the new issue is on Home');
    assert.equal(runLink(t.into).textContent, 'Run now');
    assert.equal(runLink(t.into).disabled, false);
  } finally { mock.timers.reset(); }
});

test('a radar already running when Home paints (its first run) shows Running… and fills Home when it ends', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = setup({ routine: radar({ running: true }) });
    await t.paint();
    assert.equal(runLink(t.into).textContent, 'Running…');
    assert.equal(runLink(t.into).disabled, true);
    t.state.routine = radar({ lastRun: { at: new Date().toISOString(), status: 'done', added: 3, session: 'S1' } });
    t.state.conversations = [issue];
    mock.timers.tick(5000);
    await flush();
    assert.match(t.into.find('sbw-today-stage')[0].textContent, /3 new papers/);
  } finally { mock.timers.reset(); }
});

test('a refusal shows its reason in place of the link for a moment, then Run now comes back', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = setup({ runNow: async () => ({ started: false, reason: 'Another routine is running.' }) });
    await t.paint();
    const run = runLink(t.into);
    await run.click();
    assert.equal(run.textContent, 'Another routine is running.');
    assert.equal(run.getAttribute('title'), 'Another routine is running.');
    mock.timers.tick(4000);
    await flush();
    assert.equal(run.textContent, 'Run now');
    assert.equal(run.disabled, false);
  } finally { mock.timers.reset(); }
});

test('no Run now in a host whose routines service has no runNow', async () => {
  const t = setup({ withRunNow: false });
  await t.paint();
  assert.ok(t.into.find('sbw-today-bar')[0], 'the bar is still there');
  assert.equal(runLink(t.into), undefined);
});
