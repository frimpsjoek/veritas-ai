// The chat half of "pills and chips are one state": ChatView's own syncSources, toggleSource and sendSources, run on a
// bare object with the real prototype (no DOM needed) against a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatView } from '../src/chat/chat.js';
import { zoteroHostPrefs } from './support/zotero-prefs.mjs';

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

function chatWith({ settings = { sources: null, webSearchDefault: 'off' }, pref, failUpdate = false, failGet = false, zotero = false } = {}) {
  const calls = [];
  const state = { settings };
  // zotero: the real Zotero host prefs over a strict Zotero.Prefs (throws on null, stringifies objects)
  const strict = zotero ? zoteroHostPrefs() : null;
  const store = new Map(pref === undefined ? [] : [['chatSources', pref]]);
  if (strict && pref !== undefined) strict.prefs.set('chatSources', pref);
  const prefs = strict ? strict.prefs : store;
  const hostPrefs = strict ? strict.prefs : { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } };
  const ai = { settings: {
    get: async () => { if (failGet) throw new Error('no engine'); return state.settings; },
    update: async (patch) => {
      if (failUpdate) throw new Error('nope');
      calls.push(patch);
      state.settings = { ...state.settings, ...patch, ...(patch.sources ? { sources: { papers: true, notes: true, scholarly: true, web: false, ...state.settings.sources, ...patch.sources } } : {}) };
      return state.settings;
    },
  } };
  const errors = [];
  const view = Object.assign(Object.create(ChatView.prototype), {
    host: { ai: async () => ai, prefs: hostPrefs, logError: (e) => errors.push(e) },
    engineSettings: null, sourceWrites: 0, sourcesSyncedAt: 0, mode: 'chat',
    thread: { querySelector: () => null },
    rendered: 0, renderSources() { this.rendered += 1; }, renderSend() {},
  });
  view.sources = view.savedSources();
  return { view, calls, state, prefs, errors };
}

test('syncSources takes the pills from the engine settings; Research only picks the mode', async () => {
  const { view } = chatWith({ settings: { sources: { notes: false, web: true }, webSearchDefault: 'cached' }, pref: { papers: true, notes: false, scholarly: true, web: true } });
  await view.syncSources();
  assert.deepEqual(view.sources, { papers: true, notes: false, scholarly: true, web: true });
  assert.equal(view.sendSources().web, 'cached');
  assert.equal(view.rendered, 1);
});

test('Research cached + old pref web:false: the pill is off, sends off, and Research is untouched', async () => {
  const { view, calls, state, prefs } = chatWith({ settings: { sources: null, webSearchDefault: 'cached' }, pref: { papers: true, notes: true, scholarly: false, web: false } });
  await view.syncSources();
  assert.deepEqual(calls, [{ sources: { scholarly: false } }], 'no web write');
  assert.deepEqual(view.sources, { papers: true, notes: true, scholarly: false, web: false });
  assert.equal(view.sendSources().web, 'off');
  assert.equal(state.settings.webSearchDefault, 'cached', 'Research untouched');
  await view.syncSources();
  assert.equal(calls.length, 1, 'nothing moves twice');
  assert.equal(prefs.get('sourcesMigrated'), true);
  assert.equal(view.sendSources().web, 'off', 'still off after the next sync');
});

test('old pref web:true moves over as sources.web, sending live when Research is off and cached when it is cached', async () => {
  const pref = { papers: true, notes: true, scholarly: true, web: true };
  for (const [research, sends] of [['off', 'live'], ['live', 'live'], ['cached', 'cached']]) {
    const { view, calls, state } = chatWith({ settings: { sources: null, webSearchDefault: research }, pref });
    await view.syncSources();
    assert.deepEqual(calls, [{ sources: { web: true } }], `Research ${research}`);
    assert.equal(view.sources.web, true);
    assert.equal(view.sendSources().web, sends);
    assert.equal(state.settings.webSearchDefault, research, 'Research untouched');
  }
});

test('an engine that drops `sources` keeps the pills from the pref, and is not asked again', async () => {
  const { view, calls, state } = chatWith({ pref: { papers: true, notes: false, scholarly: false, web: false } });
  const ai = await view.host.ai();
  ai.settings.update = async (patch) => { calls.push(patch); return state.settings; }; // old merge(): unknown key dropped
  await view.syncSources();
  assert.deepEqual(view.sources, { papers: true, notes: false, scholarly: false, web: false });
  await view.syncSources();
  assert.equal(calls.length, 1);
  view.toggleSource('scholarly');
  await flush();
  await view.syncSources();
  assert.equal(view.sources.scholarly, true, 'the pill the user flipped on stays on');
});

test('syncSources writes the engine\'s pills back to the offline pref', async () => {
  const { view, prefs } = chatWith({ settings: { sources: { scholarly: false }, webSearchDefault: 'cached' }, pref: { papers: true, notes: true, scholarly: false, web: true } });
  await view.syncSources();
  assert.deepEqual(prefs.get('chatSources'), { papers: true, notes: true, scholarly: false, web: true });
});

test('three apps: each migrates once from its own pref and none writes the Research web default', async () => {
  const shared = { sources: null, webSearchDefault: 'off' };
  const a = chatWith({ settings: shared, pref: { papers: true, notes: false, scholarly: true, web: true } });
  await a.view.syncSources();
  const b = chatWith({ settings: a.state.settings, pref: { papers: true, notes: true, scholarly: false, web: false } });
  await b.view.syncSources();
  assert.equal(b.state.settings.webSearchDefault, 'off', 'no web write from either');
  assert.deepEqual(a.state.settings.sources, { papers: true, notes: false, scholarly: true, web: true });
  assert.deepEqual(b.state.settings.sources, { papers: true, notes: true, scholarly: false, web: false }, 'each app writes what differs from the saved answer');
  assert.equal(a.view.sources.web, true);
  assert.equal(b.view.sources.web, false);
});

test('syncSources leaves a pill that is being written alone, and keeps the pills when there is no engine', async () => {
  const busy = chatWith({ settings: { sources: { notes: false }, webSearchDefault: 'off' } });
  busy.view.sourceWrites = 1;
  await busy.view.syncSources();
  assert.equal(busy.view.sources.notes, true, 'the write in flight is the newer truth');
  const offline = chatWith({ failGet: true, pref: { papers: false, notes: true, scholarly: true, web: false } });
  await offline.view.syncSources();
  assert.equal(offline.view.sources.papers, false);
  assert.equal(offline.errors.length, 1);
});

test('toggleSource writes only that switch to the engine, whatever stale settings the chat holds', async () => {
  const { view, calls, state, prefs } = chatWith();
  view.engineSettings = { sources: { notes: true } }; // stale: Settings has since turned notes off
  state.settings = { sources: { papers: true, notes: false, scholarly: true, web: false }, webSearchDefault: 'off' };
  view.toggleSource('scholarly');
  assert.equal(view.sourceWrites, 1);
  assert.equal(view.sources.scholarly, false, 'the pill flips at once');
  assert.equal(prefs.get('chatSources').scholarly, false, 'and the offline pref follows');
  await flush();
  assert.deepEqual(calls, [{ sources: { scholarly: false } }]);
  assert.deepEqual(state.settings.sources, { papers: true, notes: false, scholarly: false, web: false });
  assert.equal(view.sourceWrites, 0);
  assert.deepEqual(view.engineSettings.sources, { papers: true, notes: false, scholarly: false, web: false });
});

test('toggleSource on the web pill writes only sources.web, never the Research default', async () => {
  const { view, calls, state } = chatWith({ settings: { sources: null, webSearchDefault: 'cached' } });
  view.toggleSource('web');
  await flush();
  assert.deepEqual(calls, [{ sources: { web: true } }]);
  assert.equal(view.sendSources().web, 'cached');
  view.toggleSource('web');
  await flush();
  assert.deepEqual(calls.at(-1), { sources: { web: false } });
  assert.equal(view.sendSources().web, 'off');
  assert.equal(state.settings.webSearchDefault, 'cached', 'Research untouched');
  const failing = chatWith({ failUpdate: true });
  failing.view.toggleSource('notes');
  await flush();
  assert.equal(failing.view.sources.notes, false, 'a failed write leaves the pill as the user set it');
  assert.equal(failing.view.sourceWrites, 0);
  assert.equal(failing.errors.length, 1);
});

test('a send carries the synced pills and the mode Research picked', async () => {
  const { view } = chatWith({ settings: { sources: { scholarly: false, web: true }, webSearchDefault: 'cached' } });
  await view.syncSources();
  const { web, sources } = view.sendSources();
  assert.equal(web, 'cached');
  assert.deepEqual(sources, { papers: true, notes: true, scholarly: false, web: true });
  sources.papers = false;
  assert.equal(view.sources.papers, true, 'a copy, not the live pills');
  view.sources.web = false;
  assert.equal(view.sendSources().web, 'off');
});

test('on a Zotero host: the migration, the offline pref and the toggles never hand Zotero a null or a bare object', async () => {
  const { view, prefs, calls } = chatWith({ zotero: true, settings: { sources: null, webSearchDefault: 'cached' }, pref: { papers: true, notes: false, scholarly: true, web: true } });
  await view.syncSources();
  assert.deepEqual(calls, [{ sources: { notes: false, web: true } }]);
  assert.equal(prefs.get('sourcesMigrated'), true);
  assert.deepEqual(prefs.get('chatSources'), { papers: true, notes: false, scholarly: true, web: true });
  view.toggleSource('web');
  await flush();
  assert.deepEqual(prefs.get('chatSources'), { papers: true, notes: false, scholarly: true, web: false });
  assert.equal(view.errors?.length ?? 0, 0);
});

test('a read that began before a toggle can not repaint the old value after it', async () => {
  const { view, calls, state } = chatWith({ settings: { sources: { papers: true, notes: true, scholarly: true }, webSearchDefault: 'off' } });
  await view.syncSources();
  const stale = { ...state.settings };
  const ai = await view.host.ai();
  let release;
  ai.settings.get = async () => { await new Promise((r) => { release = r; }); return stale; };
  const pending = view.syncSources();
  await flush();
  view.toggleSource('notes');
  await flush();
  release();
  await pending;
  assert.deepEqual(calls.at(-1), { sources: { notes: false } });
  assert.equal(view.sources.notes, false, 'the GET that landed after the POST is dropped');
});

// An engine from before `sources`: get() has no `sources` key at all and update() drops it.
function oldEngineChat(pref, research = 'off') {
  const made = chatWith({ pref });
  const settings = { webSearchDefault: research };
  const ai = { settings: { get: async () => settings, update: async (p) => { made.calls.push(p); return settings; } } };
  made.view.host.ai = async () => ai;
  return made;
}

test('old engine, pref web:true: the web pill stays on across syncs and sends live', async () => {
  const { view, prefs } = oldEngineChat({ papers: true, notes: true, scholarly: true, web: true });
  await view.syncSources();
  await view.syncSources();
  assert.equal(view.sources.web, true);
  assert.equal(view.sendSources().web, 'live');
  assert.equal(prefs.get('chatSources').web, true);
});

test('old engine, pref equal to the defaults: not marked migrated, and a flipped web pill survives the next sync', async () => {
  const { view, prefs } = oldEngineChat({ papers: true, notes: true, scholarly: true, web: false });
  await view.syncSources();
  assert.notEqual(prefs.get('sourcesMigrated'), true, 'the engine never confirmed `sources`');
  view.toggleSource('web');
  await flush();
  view.sourcesSyncedAt = 0;
  await view.syncSources();
  assert.equal(view.sources.web, true);
  assert.equal(view.sendSources().web, 'live');
  assert.equal(prefs.get('chatSources').web, true);
});
