// The Sources chips widget on a minimal fake DOM: what it draws for each state, and what a click writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcesWidget } from '../src/settings/sources-widget.js';

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.dataset = {};
    this.className = ''; this._text = ''; this.disabled = false; this.hidden = false; this.open = false; this.id = '';
    this.classList = { contains: (c) => this.className.split(/\s+/).includes(c), add: (c) => { this.className += ` ${c}`; }, remove: () => {}, toggle: () => {} };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { return Promise.all((this.listeners.click ?? []).map((f) => f({}))); }
  focus() { doc.activeElement = this; }
  contains(node) { return node === this || this.walk().includes(node); }
  fire(type, event = {}) { for (const f of this.listeners[type] ?? []) f(event); }
  walk() { return this.children.flatMap((c) => [c, ...c.walk()]); }
  has(cls) { return `${this.className} ${this.attrs.class ?? ''}`.split(/\s+/).includes(cls); }
  find(cls) { return this.walk().filter((n) => n.has(cls)); }
  querySelectorAll(sel) { return this.walk().filter((n) => n.tag === sel); }
}
const docListeners = {};
const doc = {
  createElementNS: (_ns, tag) => new El(tag), activeElement: null,
  addEventListener: (type, fn) => { (docListeners[type] ??= new Set()).add(fn); },
  removeEventListener: (type, fn) => { docListeners[type]?.delete(fn); },
};
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

const status = { chunks: 100, indexed_at: '2026-10-14 21:14', running: false, coverage: [
  { source: 'zotero', documents: 10, chunks: 60 }, { source: 'ai_notes', documents: 20, chunks: 40 }, { source: 'Clippings', documents: 3, chunks: 5 }, { source: '_media_read', documents: 1, chunks: 1 },
] };
const report = (name, extra = {}) => ({ config: { name, command: 'x' }, state: 'connected', tools: [{ name: 't', verdict: 'exposed' }], ...extra });
const radar = (id, status = 'active') => ({ id, name: `Radar ${id}`, kind: 'radar', status, radar: { sources: [1, 2] } });

function setup({ settings = { sources: null, webSearchDefault: 'off' }, mcp = [report('PubMed')], routines = [radar('r1')], failStatus = false, kind = 'web', radarFeeds, gateStatus = false, prefs } = {}) {
  const calls = [];
  const state = { settings, release: () => {} };
  const gate = new Promise((resolve) => { state.release = resolve; });
  const ai = {
    // merges one source key at a time, like the engine
    settings: { get: async () => state.settings, update: async (patch) => {
      calls.push(['settings.update', patch]);
      state.settings = { ...state.settings, ...patch, ...(patch.sources ? { sources: { papers: true, notes: true, scholarly: true, web: false, ...state.settings.sources, ...patch.sources } } : {}) };
      return state.settings;
    } },
    mcp: { list: async () => { if (mcp === 'fail') throw new Error('down'); return mcp; }, save: async (config) => { calls.push(['mcp.save', config]); } },
    routines: { list: async () => routines, pause: async (id) => { calls.push(['pause', id]); }, resume: async (id) => { calls.push(['resume', id]); } },
  };
  const host = {
    kind, prefs, notice: (m) => calls.push(['notice', m]), logError: () => {},
    json: async () => { if (gateStatus) await gate; if (failStatus) throw new Error('down'); return status; },
    ai: async () => ai,
  };
  const selected = [];
  const root = sourcesWidget(doc, host, { select: (s) => selected.push(s), radarFeeds });
  return { root, calls, selected, state };
}
const chip = (root, id) => root.find('sbs-chip').find((c) => c.dataset.chip === id);

test('three groups with their chips, a ring each, and the footer', async () => {
  const { root } = setup();
  await flush();
  assert.deepEqual(root.find('sbs-src-title').map((t) => t.textContent), ['Your library', 'Look further', 'Keeping watch']);
  assert.equal(root.find('sbs-ring').length, 3);
  assert.ok(root.find('sbs-ring').every((r) => r.attrs['aria-hidden'] === 'true'));
  assert.deepEqual(root.find('sbs-chip').map((c) => c.dataset.chip), ['papers', 'notes', 'scholarly', 'web', 'mcp:PubMed', 'radar:r1']);
  assert.deepEqual(root.find('sbs-src-status').map((c) => c.dataset.chip), ['clippings']);
  assert.match(root.find('sbs-src-footer')[0].textContent, /Search index updated 2026-10-14 21:14/);
});

test('toggles are aria-pressed; the web chip shows its mode word; groups are labelled', async () => {
  const { root } = setup({ settings: { sources: { notes: false, web: true }, webSearchDefault: 'cached' } });
  await flush();
  assert.equal(chip(root, 'papers').attrs['aria-pressed'], 'true');
  assert.equal(chip(root, 'notes').attrs['aria-pressed'], 'false');
  assert.equal(chip(root, 'web').attrs['aria-pressed'], 'true');
  assert.match(chip(root, 'web').textContent, /When it helps/);
  const group = root.find('sbs-src-group')[0];
  assert.equal(group.attrs.role, 'group');
  assert.equal(group.attrs['aria-labelledby'], 'sbs-src-library');
});

test('clicking a library chip writes only its own switch, then repaints from a fresh read', async () => {
  const { root, calls } = setup();
  await flush();
  await chip(root, 'notes').click();
  await flush();
  assert.deepEqual(calls[0], ['settings.update', { sources: { notes: false } }]);
  assert.match(root.find('sbs-src-live')[0].textContent, /Obsidian notes turned off/);
  assert.equal(chip(root, 'notes').attrs['aria-pressed'], 'false');
  assert.equal(chip(root, 'notes').disabled, false);
});

test('the web chip is on or off and writes only sources.web, whatever Research says', async () => {
  for (const research of ['off', 'cached', 'live']) {
    const { root, calls, state } = setup({ settings: { sources: null, webSearchDefault: research } });
    await flush();
    assert.equal(chip(root, 'web').attrs['aria-pressed'], 'false', `Research ${research} alone leaves it off`);
    await chip(root, 'web').click();
    await flush();
    assert.equal(chip(root, 'web').attrs['aria-pressed'], 'true');
    await chip(root, 'web').click();
    await flush();
    assert.deepEqual(calls.map((c) => c[1]), [{ sources: { web: true } }, { sources: { web: false } }]);
    assert.equal(state.settings.webSearchDefault, research, 'Research untouched');
  }
  const off = setup({ settings: { sources: null, webSearchDefault: 'off' } });
  await flush();
  assert.match(chip(off.root, 'web').textContent, /Always/, 'Research off: on runs live');
});

test('a chip clicked after another window changed a different switch does not undo that change', async () => {
  const { root, state } = setup();
  await flush();
  state.settings = { ...state.settings, sources: { papers: true, notes: false, scholarly: true, web: false } }; // changed in chat, after this widget loaded
  await chip(root, 'scholarly').click();
  await flush();
  assert.deepEqual(state.settings.sources, { papers: true, notes: false, scholarly: false, web: false });
});

test('keyboard focus stays on the chip that was pressed, through the repaints', async () => {
  const { root } = setup();
  await flush();
  const before = chip(root, 'notes');
  doc.activeElement = before;
  await before.click();
  await flush();
  assert.notEqual(chip(root, 'notes'), before, 'the chip was redrawn');
  assert.equal(doc.activeElement, chip(root, 'notes'));
  assert.equal(chip(root, 'notes').disabled, false, 'never disabled, which would drop focus');
  doc.activeElement = null;
});

test('while /status is on its way there are no false errors, and the saved switches can already be used', async () => {
  const { root, calls, state } = setup({ gateStatus: true });
  await flush();
  const text = root.textContent;
  assert.doesNotMatch(text, /Server not running|isn't reachable|Nothing watched|Couldn't check/);
  assert.equal(root.find('sbs-src-footer').length, 0);
  await chip(root, 'notes').click();
  assert.deepEqual(calls[0], ['settings.update', { sources: { notes: false } }]);
  state.release();
  await flush();
  assert.match(root.find('sbs-src-footer')[0].textContent, /Search index updated/);
});

test('when outside sources cannot be read the group says so', async () => {
  const { root } = setup({ mcp: 'fail' });
  await flush();
  assert.match(root.find('sbs-src-group')[1].textContent, /Couldn't check outside sources\./);
  const none = setup({ mcp: [] });
  await flush();
  assert.doesNotMatch(none.root.textContent, /Couldn't check/);
});

test('an outside server saves its enabled flag; a radar pauses and resumes', async () => {
  const { root, calls } = setup({ routines: [radar('r1'), radar('r2', 'paused')] });
  await flush();
  await chip(root, 'mcp:PubMed').click();
  await chip(root, 'radar:r1').click();
  await chip(root, 'radar:r2').click();
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] !== 'notice'), [
    ['mcp.save', { name: 'PubMed', command: 'x', enabled: false }], ['pause', 'r1'], ['resume', 'r2'],
  ]);
});

test('a status item is plain text, not a pill: no button, no pressed state, and the reason is written out', async () => {
  const { root, calls } = setup();
  await flush();
  assert.equal(chip(root, 'clippings'), undefined, 'not drawn as a chip');
  const clippings = root.find('sbs-src-status').find((n) => n.dataset.chip === 'clippings');
  assert.ok(clippings, 'Clippings shows as a status line when the index holds some');
  assert.equal(clippings.tag, 'p');
  assert.equal(clippings.attrs['aria-pressed'], undefined);
  assert.match(clippings.textContent, /Clippings and videos.*Searched along with your notes\./);
  assert.equal(clippings.listeners.click, undefined);
  assert.deepEqual(calls, []);
});

test('a failed save tells the user and leaves the chip enabled and as it was', async () => {
  const calls = [];
  const host = { kind: 'web', json: async () => status, logError() {}, notice: (m) => calls.push(['notice', m]), ai: async () => ({
    settings: { get: async () => ({ sources: null, webSearchDefault: 'off' }), update: async () => { throw new Error('nope'); } },
    mcp: { list: async () => [] }, routines: { list: async () => [] },
  }) };
  const w = sourcesWidget(doc, host, { select() {} });
  await flush();
  await chip(w, 'papers').click();
  await flush();
  assert.equal(chip(w, 'papers').attrs['aria-pressed'], 'true');
  assert.equal(chip(w, 'papers').disabled, false);
  assert.match(w.find('sbs-note')[0].textContent, /Couldn't change Zotero papers/);
  assert.equal(w.find('sbs-src-live').length, 0, 'an error keeps the danger style, a confirmation does not');
  assert.equal(calls.length, 1);
});

test('with the server down the library still draws and the footer says so', async () => {
  const { root } = setup({ failStatus: true });
  await flush();
  assert.equal(root.find('sbs-ring').length, 2, 'no library ring without /status');
  assert.ok(chip(root, 'papers'));
  assert.match(root.find('sbs-src-footer')[0].textContent, /isn't reachable/);
});

test('the "…" menu lists the host\'s items; radar feeds only where the host passes a link', async () => {
  const web = setup({ radarFeeds: () => ({ click() {} }) });
  await flush();
  assert.deepEqual(web.root.find('sbs-src-item').map((b) => b.textContent), ['Outside sources and trust', 'OpenAlex key', 'Radar feeds', 'Search index status']);
  assert.ok(web.root.find('sbs-src-item').every((b) => b.attrs.role === 'menuitem'));
  const obsidian = setup({ kind: 'obsidian' });
  await flush();
  assert.deepEqual(obsidian.root.find('sbs-src-item').map((b) => b.textContent), ['Outside sources and trust', 'OpenAlex key', 'Search index status']);
});

test('menu items: index status goes to the section, the radar link is followed, a panel opens and closes', async () => {
  let followed = 0;
  const { root, selected } = setup({ radarFeeds: () => ({ click() { followed += 1; } }) });
  await flush();
  const item = (label) => root.find('sbs-src-item').find((b) => b.textContent === label);
  await item('Search index status').click();
  assert.deepEqual(selected, ['index']);
  await item('Radar feeds').click();
  assert.equal(followed, 1);
  await item('OpenAlex key').click();
  assert.equal(root.find('sbs-src-panel').length, 1);
  assert.equal(root.find('sbs-src-panel')[0].find('sbs-src-title')[0].textContent, 'OpenAlex key');
  await root.find('sbs-src-panel')[0].find('sbm-link')[0].click();
  await flush();
  assert.equal(root.find('sbs-src-panel').length, 0);
});

test('the "…" menu opens from the keyboard onto its first item, walks with arrows, Home and End, and closes on Tab out or a click outside', async () => {
  const { root } = setup();
  await flush();
  const menu = root.find('sbs-src-menu')[0];
  const summary = root.find('sbs-src-more')[0];
  assert.equal(summary.attrs['aria-expanded'], 'false');
  const items = () => root.find('sbs-src-item');
  const key = (k, target) => menu.fire('keydown', { key: k, target, preventDefault() {} });
  key('ArrowDown', summary);
  assert.equal(menu.open, true);
  menu.fire('toggle');
  assert.equal(summary.attrs['aria-expanded'], 'true');
  assert.equal(doc.activeElement, items()[0]);
  key('End', items()[0]);
  assert.equal(doc.activeElement, items().at(-1));
  key('Home', items().at(-1));
  assert.equal(doc.activeElement, items()[0]);
  key('ArrowUp', items()[0]);
  assert.equal(doc.activeElement, items().at(-1));
  menu.fire('focusout', { relatedTarget: items()[0] });
  assert.equal(menu.open, true, 'moving between items keeps it open');
  menu.fire('focusout', { relatedTarget: { outside: true } });
  assert.equal(menu.open, false, 'Tab out closes it');
  menu.fire('toggle');
  assert.equal(docListeners.pointerdown.size, 0);
  menu.open = true;
  menu.fire('toggle');
  assert.equal(docListeners.pointerdown.size, 1);
  [...docListeners.pointerdown][0]({ target: { outside: true } });
  assert.equal(menu.open, false, 'a click outside closes it');
  menu.fire('toggle');
  assert.equal(docListeners.pointerdown.size, 0, 'and stops listening');
});

test('Enter on the closed "…" opens the menu onto its first item, and a repaint does not rebuild the open menu', async () => {
  const { root } = setup();
  await flush();
  const menu = root.find('sbs-src-menu')[0];
  const summary = root.find('sbs-src-more')[0];
  menu.fire('keydown', { key: 'Enter', target: summary, preventDefault() {} });
  menu.open = true;
  menu.fire('toggle');
  const first = root.find('sbs-src-item')[0];
  assert.equal(doc.activeElement, first);
  await chip(root, 'notes').click();
  await flush();
  assert.equal(root.find('sbs-src-item')[0], first, 'same button, so focus is not dropped');
});

test('chips carry no pressed state until the saved settings answer, then show the real one', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const host = { kind: 'web', json: async () => status, logError() {}, ai: async () => ({
    settings: { get: async () => { await gate; return { sources: { notes: false }, webSearchDefault: 'off' }; }, update: async () => ({}) },
    mcp: { list: async () => [] }, routines: { list: async () => [] },
  }) };
  const w = sourcesWidget(doc, host, { select() {} });
  await flush();
  assert.equal(chip(w, 'papers').attrs['aria-pressed'], undefined);
  assert.equal(chip(w, 'papers').attrs['aria-busy'], 'true');
  release();
  await flush();
  assert.equal(chip(w, 'papers').attrs['aria-pressed'], 'true');
  assert.equal(chip(w, 'notes').attrs['aria-pressed'], 'false');
});

test('the intro says new chats and reports, since routines keep their own switches', async () => {
  const { root } = setup();
  await flush();
  assert.match(root.find('sbs-help')[0].textContent, /^Where new chats and reports look\./);
});

test('on an engine that drops `sources`, a chip click says so instead of reporting success', async () => {
  const { root, state } = setup({ settings: { webSearchDefault: 'off' } });
  await flush();
  // the engine ignores the write: its settings never gain a `sources` key
  Object.defineProperty(state, 'settings', { get: () => ({ webSearchDefault: 'off' }), set: () => {}, configurable: true });
  await chip(root, 'web').click();
  await flush();
  const line = root.find('sbs-src-live').concat(root.find('sbs-note')).map((n) => n.textContent).join(' ');
  assert.doesNotMatch(line, /turned on/);
  assert.match(line, /updated/);
});
