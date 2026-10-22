// Live activity from the tool host: the gateway session reports its own tool calls as they happen, core.js merges
// them into the turn's stream while the provider may be silent, and the provider's duplicates are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlots, createTurnRunner } from '../src/core.js';
import { createToolGateway, handleMcp } from '../src/tools.js';
import { mergeHostEvents } from '../src/merge.js';
import { compactActivities } from '../src/activity.js';

const ref = { kind: 'paper', citekey: 'smith2021' };
const library = {
  async search() { return [{ ref, title: 'Smith 2021', snippet: 's', year: 2021 }, { ref: { kind: 'paper', citekey: 'b' }, title: 'B', snippet: 's', year: null }]; },
  async read() { return { title: 'Smith 2021: graphene', text: 'body' }; },
  async related() { return []; }, async resolve() { return new Map(); },
};
const testTools = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' };
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (session, name, args) => handleMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), session);

/** @param {(req: any) => AsyncGenerator<any>} turn */
function provider(turn) {
  return {
    id: 'scripted', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'scripted', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() {}, async signOut() {}, turn, async dispose() {},
  };
}
async function runner(turn) {
  const gateway = await createToolGateway(fetch, library, {});
  return createTurnRunner({ providers: new Map([['scripted', provider(turn)]]), getRoleModel: async () => ({ provider: 'scripted', model: null }), gateway, library, slots: createSlots({ total: 6 }) });
}
const stream = (r, signal = new AbortController().signal) => r.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, signal);
const acts = (events) => events.filter((e) => e.type === 'activity');

test('a silent provider: host activity reaches the stream when each call happens, before the provider says anything', async () => {
  let session; let gate; const open = new Promise((r) => { gate = r; });
  let started; const hasSession = new Promise((r) => { started = r; });
  const r = await runner(async function* (req) { session = req.tools; started(); await open; yield { type: 'final', text: 'ok', json: null, usage: {} }; });
  const seen = []; const t0 = Date.now();
  const consumer = (async () => { for await (const ev of stream(r)) seen.push({ ev, at: Date.now() - t0 }); })();
  await hasSession;
  await later(60);
  assert.equal(acts(seen.map((s) => s.ev)).length, 0);
  await rpc(session, 'search_library', { query: 'graphene' });
  await later(60);
  // The provider has still said nothing, yet the search's start and end are already here.
  const early = acts(seen.map((s) => s.ev));
  assert.deepEqual(early.map((e) => `${e.phase}:${e.tool}`), ['start:search_library', 'end:search_library']);
  assert.equal(early[0].label, 'Searching your papers for "graphene"');
  assert.equal(early[1].count, 2);
  assert.equal(early[1].detail, '2 results');
  await rpc(session, 'read_source', { citekey: 'smith2021' });
  await later(30);
  const all = acts(seen.map((s) => s.ev));
  assert.equal(all.length, 4);
  assert.equal(all[2].label, 'Reading “Smith 2021”');
  assert.equal(all[3].source.title, 'Smith 2021: graphene');
  assert.ok(seen.every((s) => s.ev.type !== 'done'), 'the provider has not finished yet');
  assert.ok(seen[1].at >= 60, 'the events arrived when the calls happened, not at the start');
  gate();
  await consumer;
  assert.equal(seen.at(-1).ev.type, 'done');
  // Stored shape: compactActivities over the merged events folds them as a provider-fed turn would.
  const lines = compactActivities(seen.map((s) => s.ev));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.equal(lines[0].entries.length, 2);
});

test('no double rows when the provider also reports the same lib tool (bare and mcp__lib__ names)', async () => {
  const r = await runner(async function* (req) {
    const args = { query: 'graphene' };
    yield { type: 'activity', id: 'p1', phase: 'start', kind: 'library', label: 'Searching your papers for "graphene"', tool: 'mcp__lib__search_library', args };
    await req.tools.call('search_library', args, new AbortController().signal);
    yield { type: 'activity', id: 'p1', phase: 'end', kind: 'library', label: 'x', ok: true, tool: 'mcp__lib__search_library', args };
    yield { type: 'activity', id: 'p2', phase: 'start', kind: 'mcp', label: 'Running a tool script' };
    await req.tools.call('read_source', { citekey: 'smith2021' }, new AbortController().signal);
    yield { type: 'activity', id: 'p2', phase: 'end', kind: 'mcp', label: 'Running a tool script', ok: true };
    yield { type: 'activity', id: 'w', phase: 'start', kind: 'web', label: 'Searching the web for "x"', tool: 'web_search', args: { query: 'x' } };
    yield { type: 'activity', id: 'w', phase: 'end', kind: 'web', label: 'Searching the web for "x"', ok: true, tool: 'web_search', args: { query: 'x' } };
    yield { type: 'final', text: 'ok', json: null, usage: {} };
  });
  const a = acts(await collectAll(stream(r)));
  assert.deepEqual(a.map((e) => `${e.id}:${e.phase}`), ['h:1:start', 'h:1:end', 'h:2:start', 'h:2:end', 'w:start', 'w:end']);
});

test('fallback: when the host reports nothing for a lib tool, the provider\'s own events are kept, in order', async () => {
  const r = await runner(async function* () {
    yield { type: 'activity', id: 'p1', phase: 'start', kind: 'library', label: 'Searching your papers for "x"', tool: 'search_library', args: { query: 'x' } };
    yield { type: 'activity', id: 'p1', phase: 'end', kind: 'library', label: 'Searching your papers for "x"', ok: true, tool: 'search_library', args: { query: 'x' } };
    yield { type: 'text', delta: 'hello' };
    yield { type: 'activity', id: 'p2', phase: 'start', kind: 'library', label: 'Searching your papers for "y"', tool: 'search_library', args: { query: 'y' } };
    yield { type: 'activity', id: 'p2', phase: 'end', kind: 'library', label: 'Searching your papers for "y"', ok: true, tool: 'search_library', args: { query: 'y' } };
    yield { type: 'final', text: 'ok', json: null, usage: {} };
  });
  const events = await collectAll(stream(r));
  assert.deepEqual(events.filter((e) => e.type === 'activity' || e.type === 'text').map((e) => e.id ?? e.delta), ['p1', 'p1', 'hello', 'p2', 'p2']);
  assert.equal(events.at(-1).type, 'done');
});

test('mergeHostEvents: abort ends the merge after the grace, flushing queued host events first', async () => {
  const ac = new AbortController();
  let push;
  const stuck = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } };
  const out = [];
  const done = (async () => { for await (const x of mergeHostEvents(stuck, (p) => { push = p; return () => {}; }, ac.signal, 30)) out.push(x); })();
  push({ n: 1 }); await later(5); push({ n: 2 });
  ac.abort();
  await done; // resolves because the merge gives up on a provider that never unwinds
  assert.deepEqual(out.map((x) => x.ev.n), [1, 2]);
  assert.ok(out.every((x) => x.host));
});

test('mergeHostEvents: keeps each source in order and flushes host events queued when the provider ends', async () => {
  let push;
  const provider = (async function* () { yield 'p1'; await later(10); yield 'p2'; push('h-late'); })();
  const out = [];
  for await (const x of mergeHostEvents(provider, (p) => { push = p; return () => {}; }, new AbortController().signal)) { out.push(x.ev); if (x.ev === 'p1') push('h1'); }
  assert.deepEqual(out.filter((e) => e[0] === 'p'), ['p1', 'p2']);
  assert.deepEqual(out.filter((e) => e[0] === 'h'), ['h1', 'h-late']);
});

test('a real cancel: a provider that unwinds on abort still delivers its cancelled event through the merge', async () => {
  const ac = new AbortController();
  const r = await runner(async function* (_req, signal) {
    await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
    yield { type: 'failed', error: { kind: 'cancelled', message: 'Cancelled' } };
  });
  const p = collectAll(stream(r, ac.signal));
  await later(20); ac.abort();
  const events = await p;
  assert.equal(events.at(-1).type, 'failed');
  assert.equal(events.at(-1).error.kind, 'cancelled');
});

async function collectAll(it) { const out = []; for await (const e of it) out.push(e); return out; }
