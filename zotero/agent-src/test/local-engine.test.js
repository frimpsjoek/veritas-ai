import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime, createSlots, createTurnRunner, ASK_SCHEMA } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const HITS = [
  { ref: { kind: 'paper', citekey: 'smith2020' }, title: 'Smith on sleep', snippet: 'Smith found a 12% gain in recall.', year: 2020 },
  { ref: { kind: 'note', path: 'personal/sleep.md' }, title: 'Sleep note', snippet: 'My notes on sleep.', year: null },
];
const KNOWN = new Map([['paper:smith2020', { title: 'Smith on sleep' }], ['paper:jones2019', { title: 'Jones on memory' }], ['note:personal/sleep.md', { title: 'Sleep note' }]]);

function makeLibrary({ hits = HITS } = {}) {
  const searches = [];
  return {
    searches,
    async search(q) { searches.push(q); return hits; },
    async read(ref) { return ref.kind === 'paper' && ref.citekey === 'jones2019' ? { title: 'Jones on memory', text: 'Jones: a long text about memory. '.repeat(100) } : null; },
    async related() { return []; },
    async resolve(refs) { return new Map(refs.map((r) => [r.kind === 'note' ? `note:${r.path}` : `paper:${r.citekey}`, KNOWN.get(r.kind === 'note' ? `note:${r.path}` : `paper:${r.citekey}`) ?? null])); },
  };
}

/** A provider shaped like the real `local` one: id local, no tools, chat and ask only. `answer` is what the "model" says. */
function localLike({ answer = 'Smith found a gain [@smith2020].', notes } = {}) {
  const seen = [];
  return {
    seen,
    id: 'local', caps: { nativeWebSearch: false, nativeStructuredOutput: false, tools: false, roles: ['chat', 'ask'] },
    async status() { return null; }, async models() { return []; }, async signIn() {}, async signOut() {},
    async *turn(req) {
      seen.push(req);
      const text = req.outputSchema ? JSON.stringify({ status: 'answered', markdown: answer }) : answer;
      yield { type: 'text', delta: answer };
      yield { type: 'final', text, json: null, usage: {}, ...(notes ? { notes } : {}) };
    },
    async dispose() {},
  };
}

function gateway() {
  const opened = [];
  return {
    opened,
    open(ctx) { opened.push(ctx); return { specs: ctx.none ? [] : [{ name: 'search_library' }], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
}

async function runtime({ provider, library = makeLibrary(), role = { provider: 'local', model: null }, settings } = {}) {
  const gw = gateway();
  const fs = memoryFs();
  if (settings) await fs.writeAtomic('/data/settings.json', JSON.stringify(settings));
  const ai = await createLocalRuntime({
    platform: { fs }, library, notes: null, dataDir: '/data', providers: new Map([['local', provider]]), gateway: gw,
    ...(role === 'settings' ? {} : { getRoleModel: async () => role }),
  });
  return { ai, gw, library, provider };
}

async function send(ai, text, extra = {}) {
  const id = await ai.conversations.create('chat');
  const events = [];
  for await (const ev of ai.conversations.send(id, { text, ...extra })) events.push(ev);
  return { id, events };
}

test('a local Chat turn: the engine searches (limit 5), the model gets the passages and no tools, and the answer shows them', async () => {
  const { ai, gw, library, provider } = await runtime({ provider: localLike() });
  const { id, events } = await send(ai, 'What did Smith find about sleep?');
  assert.equal(library.searches.length, 1);
  assert.equal(library.searches[0].limit, 5);
  assert.equal(library.searches[0].text, 'What did Smith find about sleep?');
  const req = provider.seen[0];
  assert.match(req.instructions, /Answer only from the numbered passages/);
  assert.match(req.instructions, /1\. \[@smith2020\] Smith on sleep \(2020\)\nSmith found a 12% gain in recall\./);
  assert.match(req.instructions, /2\. \[\[personal\/sleep\.md\]\] Sleep note/);
  assert.doesNotMatch(req.instructions, /sb-table|search_library, read_source/);
  assert.deepEqual(req.tools.specs, [], 'the model is offered no tools');
  assert.equal(gw.opened[0].none, true);
  // the search shows as an activity line
  const act = events.filter((e) => e.type === 'activity');
  assert.deepEqual(act.map((e) => [e.phase, e.kind]), [['start', 'library'], ['end', 'library']]);
  assert.match(act[0].label, /Searching your papers for "What did Smith find about sleep\?"/);
  assert.equal(act[1].count, 2);
  // the answer carries the passages, and so does the stored record
  const done = events.find((e) => e.type === 'done');
  assert.deepEqual(done.answer.passages.map((p) => p.title), ['Smith on sleep', 'Sleep note']);
  assert.deepEqual(done.answer.citations.map((c) => [c.status, c.retrievedThisTurn]), [['resolved', true]]);
  const stored = (await ai.conversations.load(id)).find((r) => r.type === 'assistant');
  assert.equal(stored.answer.passages.length, 2);
});

test('a citation to a real library paper that was NOT retrieved comes back unknown; a retrieved one resolves', async () => {
  const { ai } = await runtime({ provider: localLike({ answer: 'See [@smith2020] and [@jones2019] and [[personal/sleep.md]] and https://example.org/x.' }) });
  const { events } = await send(ai, 'sleep?');
  const { citations } = events.find((e) => e.type === 'done').answer;
  const byKey = Object.fromEntries(citations.map((c) => [c.ref.citekey ?? c.ref.path ?? c.ref.url, c.status]));
  assert.deepEqual(byKey, { 'personal/sleep.md': 'resolved', smith2020: 'resolved', jones2019: 'unknown', 'https://example.org/x': 'unknown' });
});

test('zero hits: no model is asked (so none is started), and the not-found answer comes back', async () => {
  const { ai, provider } = await runtime({ provider: localLike(), library: makeLibrary({ hits: [] }) });
  const { events } = await send(ai, 'Anything about quantum gravity?');
  assert.equal(provider.seen.length, 0);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.answer.text, "I couldn't find anything in your library about this.");
  assert.deepEqual(done.answer.passages, []);
  assert.equal(events.some((e) => e.type === 'text'), false);
});

test('Ask on a local model: the not-found result is a typed not_found, and an answer is wrapped as answered', async () => {
  const empty = await runtime({ provider: localLike(), library: makeLibrary({ hits: [] }), role: { provider: 'local', model: null } });
  let result;
  for await (const ev of empty.ai.ask('Anything about quantum gravity?')) if (ev.type === 'done') result = ev.answer.structured;
  assert.deepEqual(result, { status: 'not_found', markdown: "I couldn't find anything in your library about this." });
  assert.equal(empty.provider.seen.length, 0);

  const found = await runtime({ provider: localLike({ answer: 'A gain [@smith2020].' }) });
  let answered;
  for await (const ev of found.ai.ask('What gain?')) if (ev.type === 'done') answered = ev.answer;
  assert.deepEqual(answered.structured, { status: 'answered', markdown: 'A gain [@smith2020].' });
  assert.equal(answered.passages.length, 2);
});

test('a short follow-up borrows the previous question; an attached paper is read into the passages first', async () => {
  const lib = makeLibrary();
  const { ai, provider } = await runtime({ provider: localLike(), library: lib });
  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'What did Smith find about sleep?' })) void ev;
  for await (const ev of ai.conversations.send(id, { text: 'and the notes?' })) void ev;
  assert.equal(lib.searches[1].text, 'What did Smith find about sleep? and the notes?');
  const attached = await runtime({ provider: localLike(), library: makeLibrary() });
  await send(attached.ai, 'Summarize this paper in detail please', { attachments: [{ kind: 'zoteroItem', citekey: 'jones2019' }] });
  const block = attached.provider.seen[0].instructions;
  assert.match(block, /1\. \[@jones2019\] Jones on memory\nJones: a long text/);
  assert.ok(block.indexOf('jones2019') < block.indexOf('smith2020'), 'attached first, then search hits');
  assert.ok(block.length < 4000, 'attached text is capped');
  assert.equal(attached.library.searches[0].text, 'Summarize this paper in detail please', 'the attachment lines are not searched for');
});

test('turn notes (a stopped repeat) reach the user as the turn notice and are stored', async () => {
  const { ai } = await runtime({ provider: localLike({ notes: ['Stopped a repeating answer.'] }) });
  const { id, events } = await send(ai, 'sleep?');
  assert.equal(events.find((e) => e.type === 'done').notice, 'Stopped a repeating answer.');
  assert.equal((await ai.conversations.load(id)).find((r) => r.type === 'assistant').notice, 'Stopped a repeating answer.');
});

test('sources: Papers only narrows the search; both off answers without a model', async () => {
  const lib = makeLibrary();
  const a = await runtime({ provider: localLike(), library: lib });
  await send(a.ai, 'sleep?', { sources: { papers: true, notes: false, scholarly: false, web: false } });
  assert.equal(lib.searches[0].only, 'papers');
  const b = await runtime({ provider: localLike(), library: makeLibrary() });
  const { events } = await send(b.ai, 'sleep?', { sources: { papers: false, notes: false, scholarly: true, web: false } });
  assert.match(events.find((e) => e.type === 'done').answer.text, /Papers and Notes are both turned off/);
  assert.equal(b.provider.seen.length, 0);
});

test('Chat with papers (session.on) on a local model answers from the set\'s own papers, not the library search', async () => {
  const { ai, provider, library } = await runtime({ provider: localLike({ answer: 'Brown slept well [@brown2018].' }) });
  const id = await ai.conversations.create('chat');
  const mk = (key, title, abstract) => ({ id: `p:${key}`, ref: { kind: 'paper', citekey: key }, inLibrary: true, title, authors: [], year: 2018, venue: null, doi: null, url: null, abstract, citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['library'] });
  const rows = [mk('brown2018', 'Brown on sleep', 'Sleep deprivation harms memory consolidation.'), mk('green2019', 'Green on taxes', 'Corporate tax rates changed.'), mk('smith2020', 'Smith on sleep', 'Sleep and recall.')];
  const put = await ai.sessions.put(id, { kind: 'find', query: 'sleep', sources: {}, scope: { kind: 'library' } },
    { kind: 'papers', ref: { id: '', version: 0 }, title: 'Set', created: '', madeBy: '', from: [], change: 'Found', query: 'sleep', rows, columns: [], cells: {}, screening: null, summary: null });
  const events = [];
  for await (const ev of ai.conversations.send(id, { text: 'what does sleep do to memory?', on: { result: put.ref, rows: ['p:brown2018', 'p:green2019'] } })) events.push(ev);
  assert.equal(events.find((e) => e.type === 'failed'), undefined);
  assert.equal(library.searches.length, 0);
  assert.equal(provider.seen.length, 1);
  const done = events.find((e) => e.type === 'done');
  assert.deepEqual(done.answer.passages.map((p) => p.ref.citekey), ['brown2018', 'green2019']); // only the ticked rows, best match first
  assert.match(provider.seen[0].instructions, /Brown on sleep/);
  assert.doesNotMatch(provider.seen[0].instructions, /Smith on sleep/);
});

// ---------- role gating at turn time ----------

test('a local model on a report role is refused at turn time unless the switch is on', async () => {
  const gw = gateway();
  const provider = localLike();
  const roleModel = { provider: 'local', model: null };
  const make = (allow) => createTurnRunner({
    providers: new Map([['local', provider]]), getRoleModel: async () => roleModel, gateway: gw, library: makeLibrary(),
    slots: createSlots({ total: 6 }), allowLocalReports: async () => allow,
  });
  const ctx = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'x' };
  const run = async (runner, role) => { const out = []; for await (const ev of runner.stream(role, { sessionKey: 's', instructions: 'i', history: [], input: 'q', tools: ctx }, new AbortController().signal)) out.push(ev); return out; };
  for (const role of ['lead', 'researcher', 'writer', 'extract']) {
    const events = await run(make(false), role);
    assert.deepEqual(events, [{ type: 'failed', error: { kind: 'model_unavailable', message: 'On this Mac models only answer questions in Chat and Ask. Pick Codex or Claude Code for reports in Settings.' } }], role);
  }
  assert.equal(provider.seen.length, 0);
  const allowed = await run(make(true), 'writer');
  assert.equal(allowed.at(-1).type, 'done', 'with the switch on, the report role runs (on the normal tool path)');
  assert.equal(provider.seen[0].instructions, 'i', 'not the guarded prompt');
  assert.deepEqual(provider.seen[0].tools.specs.map((s) => s.name), ['search_library'], 'and with its tools');
});

test('the persisted switch is read live by the runtime: setRole refuses, then works after the switch', async () => {
  const { ai } = await runtime({ provider: localLike(), role: 'settings' });
  await assert.rejects(() => ai.providers.setRole('writer', { provider: 'local', model: null }), /only answer questions/);
  await ai.settings.update({ local: { allowReports: true } });
  await ai.providers.setRole('writer', { provider: 'local', model: null });
  assert.equal((await ai.providers.roles()).writer.provider, 'local');
});

test('a greeting skips the search: the model gets the small-talk prompt and no passages', async () => {
  const { ai, library, provider } = await runtime({ provider: localLike({ answer: 'Hi! Ask me about your papers.' }) });
  const { events } = await send(ai, 'hi');
  assert.equal(library.searches.length, 0);
  assert.match(provider.seen[0].instructions, /small talk/);
  assert.doesNotMatch(provider.seen[0].instructions, /numbered passages/);
  assert.equal(events.some((e) => e.type === 'activity'), false);
  assert.equal(events.find((e) => e.type === 'done').answer.text, 'Hi! Ask me about your papers.');
});
