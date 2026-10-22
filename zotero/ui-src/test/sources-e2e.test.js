// The Sources feature across its boundary: a Settings chip write (chipWrite -> ai.settings.update, one key) on a real
// local runtime, the chat's pills synced from it (ChatView.syncSources/sendSources/startReport on a bare prototype),
// and what the engine does with them (chat send, report request.web, tool context). No DOM, no network; invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../../agent-src/src/core.js';
import { createToolGateway } from '../../agent-src/src/tools.js';
import { memoryFs } from '../../agent-src/test/support/memory-fs.mjs';
import { sourcesModel, chipWrite } from '../src/settings/sources-model.js';
import { ChatView } from '../src/chat/chat.js';
import { zoteroHostPrefs } from './support/zotero-prefs.mjs';

const cand = (n) => ({ citekey: `k${n}`, doi: null, url: null, title: `Paper ${n}`, year: 2020, abstract: `Spaced practice helped learners in study ${n}.`, authors: [], venue: '' });

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

async function rig() {
  const searches = [];
  const library = {
    async search(q) { searches.push(q); return []; },
    async read() { return { text: 'Spaced practice helped learners in study 1.' }; },
    async related() { return []; }, async resolve() { return new Map(); },
  };
  const real = await createToolGateway(fetch, library, {});
  const opened = []; // every tool context the engine opened a session with
  const gateway = { ...real, open(ctx) { opened.push(ctx); return real.open(ctx); } };
  const chatTools = []; // what the model of a chat turn could see and do
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; },
    async *turn(req) {
      const input = req.input;
      let json;
      if (/^A researcher wants a literature report/.test(input)) json = { questions: [] };
      else if (/^Plan a literature review/.test(input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['papers', 'web'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] };
      else if (/^You are researching one sub-question/.test(input)) json = { findings: [{ claim: 'c', sources: [{ citekey: 'k1', doi: null, url: null, title: 'Paper 1', year: 2020, inLibrary: true }], quote: 'q', confidence: 'high' }], searchLog: [{ query: 'q', source: 'papers', results: 1 }] };
      else if (/finding papers for one sub-question/.test(input)) json = { candidates: [cand(1), cand(2)], searchLog: [{ query: 'q', source: 'papers', results: 2 }] };
      else if (/^You extract data/.test(input)) {
        const ids = [...input.matchAll(/### Paper (\S+)/g)].map((m) => m[1]);
        json = { rows: ids.map((row) => ({ row, cells: [{ column: 'main_findings', status: 'found', value: 'helped', quotes: ['Spaced practice helped'] }] })) };
      } else if (/^Write a literature review report/.test(input) && /exactly in the shape and length/.test(input)) json = { title: 'Short answer', scope: 's', method: 'm', body: 'It helps [@k1].' };
      else if (/^Write a literature review report/.test(input)) json = { title: 'A report', scope: 's', method: 'm', themes: [], evidence: [], disagreements: '', gaps: '' };
      if (json) { yield { type: 'final', text: JSON.stringify(json), json, usage: {} }; return; }
      // a chat turn: record the tools it was given and try both library tools
      const names = req.tools.specs.map((s) => s.name);
      const searched = await req.tools.call('search_library', { query: 'spaced practice' });
      chatTools.push({ names, web: req.web, searched: searched.ok });
      yield { type: 'final', text: 'Answer', json: null, usage: {} };
    },
    async dispose() {},
  };
  const fs = memoryFs();
  const skills = { async list() { return []; }, async get() { return null; }, async put() {}, async remove() {} };
  const ai = await createLocalRuntime({
    platform: { fs }, library, notes: { async publish(n) { return { path: `${n.title}.md` }; } }, skills, dataDir: '/data',
    providers: new Map([['fake', provider]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
  });
  return { ai, fs, searches, opened, chatTools };
}

/** The chat view's real sync/send/report methods on a bare object (no DOM), against the same runtime. */
function chatOver(ai, pref) {
  // the real Zotero host prefs over a strict Zotero.Prefs: a null write or an un-encoded object fails the test
  const { prefs: zprefs } = zoteroHostPrefs();
  if (pref !== undefined) zprefs.set('chatSources', pref);
  const prefs = { get: (k) => zprefs.get(k), set: (k, v) => { zprefs.set(k, v); } };
  const thread = { querySelector: () => null };
  const reports = [];
  const view = Object.assign(Object.create(ChatView.prototype), {
    host: { ai: async () => ai, prefs, logError: (e) => { throw e; } },
    engineSettings: null, sourceWrites: 0, sourceToggles: 0, mode: 'report', thread,
    renderSources() {}, renderSend() {}, renderChips() {}, fitInput() {}, fail(_t, e) { throw new Error(e.message); }, addAnswer() { return {}; },
    input: { value: 'Does spaced repetition beat massed practice?' }, depth: { value: 'quick' }, yearFrom: { value: '' }, yearTo: { value: '' },
    skills: [], scopeValue: () => ({ kind: 'library' }), projectOpt: () => null, openReport: (id) => reports.push(id),
  });
  view.sources = view.savedSources();
  return { view, reports };
}

/** What clicking a chip does in the Settings widget: build the model from fresh reads, take the chip, write its one key. */
async function click(ai, chipId) {
  const settings = await ai.settings.get();
  const chip = sourcesModel(null, settings, [], null).groups.flatMap((g) => g.chips).find((c) => c.id === chipId);
  assert.ok(chip, `no chip ${chipId}`);
  const write = chipWrite(chip, { settings, mcpReport: [] });
  assert.equal(write.kind, 'engine');
  assert.equal(Object.keys(write.patch).length, 1, 'a chip writes one key');
  await ai.settings.update(write.patch);
}

async function finish(ai, id) {
  let approved = false;
  for await (const p of ai.reviews.watch(id)) {
    if (p.status.state === 'awaiting_approval' && !approved) { approved = true; await ai.reviews.approvePlan(id, p.status.plan); }
    if (p.status.state === 'done') return p;
  }
  throw new Error('report did not finish');
}

const setResearch = (ai, mode) => ai.settings.update({ webSearchDefault: mode });

test('Notes chip off + Web chip on: a chat send reaches the engine with notes off, search_library on papers only, web as Research picks it', async () => {
  for (const [research, expected] of [['cached', 'cached'], ['off', 'live'], ['live', 'live']]) {
    const { ai, searches, opened, chatTools } = await rig();
    await setResearch(ai, research);
    await click(ai, 'notes');
    await click(ai, 'web');
    assert.deepEqual((await ai.settings.get()).sources, { papers: true, notes: false, scholarly: true, web: true });
    assert.equal((await ai.settings.get()).webSearchDefault, research, 'the chips left Research alone');
    const { view } = chatOver(ai);
    await view.syncSources();
    assert.deepEqual(view.sources, { papers: true, notes: false, scholarly: true, web: true });
    const { web, sources } = view.sendSources();
    assert.equal(web, expected, `Research ${research}`);
    const id = await ai.conversations.create('chat');
    for await (const _ of ai.conversations.send(id, { text: 'What helps learning?', web, sources })) { /* drain */ }
    const ctx = opened.at(-1);
    assert.deepEqual(ctx.sources, { papers: true, notes: false, scholarly: true, web: true });
    assert.equal(ctx.web, expected);
    assert.equal(chatTools.at(-1).web, expected);
    assert.ok(chatTools.at(-1).names.includes('search_library'));
    assert.equal(chatTools.at(-1).searched, true);
    assert.equal(searches.at(-1).only, 'papers');
  }
});

test('Research cached + old pref web:false: the pill is off, the send is off, and Research is untouched', async () => {
  const { ai, opened } = await rig();
  await setResearch(ai, 'cached');
  const { view } = chatOver(ai, { papers: true, notes: true, scholarly: true, web: false });
  await view.syncSources();
  assert.equal(view.sources.web, false);
  const { web, sources } = view.sendSources();
  assert.equal(web, 'off');
  const settings = await ai.settings.get();
  assert.equal(settings.webSearchDefault, 'cached');
  assert.notEqual(settings.sources?.web, true);
  const id = await ai.conversations.create('chat');
  for await (const _ of ai.conversations.send(id, { text: 'hi', web, sources })) { /* drain */ }
  assert.equal(opened.at(-1).web, 'off');
  assert.equal(opened.at(-1).sources.web, false);
});

test('old pref web:true becomes sources.web true; it sends live when Research is off and cached when Research is cached', async () => {
  for (const [research, expected] of [['off', 'live'], ['cached', 'cached']]) {
    const { ai } = await rig();
    await setResearch(ai, research);
    const { view } = chatOver(ai, { papers: true, notes: true, scholarly: true, web: true });
    await view.syncSources();
    const settings = await ai.settings.get();
    assert.equal(settings.sources.web, true);
    assert.equal(settings.webSearchDefault, research, 'Research untouched');
    assert.equal(view.sendSources().web, expected);
  }
});

test('a send that names neither web nor sources never searches the web on Research alone', async () => {
  const { ai, opened } = await rig();
  await setResearch(ai, 'live');
  const id = await ai.conversations.create('chat');
  for await (const _ of ai.conversations.send(id, { text: 'hi' })) { /* drain */ }
  assert.equal(opened.at(-1).web, 'off');
  assert.equal(opened.at(-1).sources.web, false);
  await click(ai, 'web');
  for await (const _ of ai.conversations.send(id, { text: 'again' })) { /* drain */ }
  assert.equal(opened.at(-1).web, 'live');
  assert.equal(opened.at(-1).sources.web, true);
});

test('a report started from those pills takes the web mode from Research, and its tool contexts honour the sources', async () => {
  const { ai, fs, opened } = await rig();
  await setResearch(ai, 'cached');
  await click(ai, 'notes');
  await click(ai, 'web');
  const { view, reports } = chatOver(ai);
  await view.syncSources();
  await view.startReport('Does spaced repetition beat massed practice?');
  assert.equal(reports.length, 1);
  const request = JSON.parse(await fs.read(`/data/reviews/${reports[0]}/request.json`));
  assert.deepEqual([...request.sources].sort(), ['papers', 'scholarly', 'web']);
  assert.equal(request.web, 'cached');
  await finish(ai, reports[0]);
  const searchCtxs = opened.filter((c) => /^review:/.test(c.audit) && c.sources && !c.none && (c.sources.papers || c.sources.web));
  assert.ok(searchCtxs.length, 'the report opened a searching session');
  for (const c of searchCtxs) {
    assert.equal(c.sources.notes, false);
    if (c.sources.web) assert.equal(c.web, 'cached');
  }
  assert.ok(searchCtxs.some((c) => c.sources.web && c.sources.papers));
});

test('a report with the web on and Research off or live records live; with the web pill off it lists no web', async () => {
  for (const research of ['off', 'live']) {
    const { ai, fs } = await rig();
    await setResearch(ai, research);
    await click(ai, 'web');
    const { view, reports } = chatOver(ai);
    await view.syncSources();
    await view.startReport('q');
    assert.equal(JSON.parse(await fs.read(`/data/reviews/${reports[0]}/request.json`)).web, 'live', `Research ${research}`);
  }
  const { ai, fs } = await rig();
  await setResearch(ai, 'live');
  const { view, reports } = chatOver(ai);
  await view.syncSources();
  await view.startReport('q');
  const request = JSON.parse(await fs.read(`/data/reviews/${reports[0]}/request.json`));
  assert.ok(!request.sources.includes('web'));
  assert.equal(request.web, undefined);
});

test('the web chip off then on is sources.web only, in the engine and on the chat pill; Research never moves', async () => {
  const { ai } = await rig();
  await setResearch(ai, 'cached');
  await click(ai, 'web');
  assert.equal((await ai.settings.get()).sources.web, true);
  await click(ai, 'web');
  assert.equal((await ai.settings.get()).sources.web, false);
  const { view } = chatOver(ai);
  await view.syncSources();
  assert.equal(view.sendSources().web, 'off');
  view.toggleSource('web');
  await flush();
  assert.equal((await ai.settings.get()).sources.web, true);
  assert.equal(view.sendSources().web, 'cached');
  view.toggleSource('web');
  await flush();
  assert.equal((await ai.settings.get()).sources.web, false);
  assert.equal((await ai.settings.get()).webSearchDefault, 'cached');
});

test('the Settings chip detail follows Research: When it helps for cached, Always for live or off', async () => {
  const { ai } = await rig();
  for (const [research, label] of [['cached', 'When it helps'], ['live', 'Always'], ['off', 'Always']]) {
    await setResearch(ai, research);
    const chip = sourcesModel(null, await ai.settings.get(), [], null).groups.flatMap((g) => g.chips).find((c) => c.id === 'web');
    assert.equal(chip.detail, label);
  }
});
