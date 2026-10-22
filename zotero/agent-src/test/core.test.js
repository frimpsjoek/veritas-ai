import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlots, createTurnRunner, createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

function fakeProvider(id, events) {
  return {
    id, caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: id, state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() { for (const ev of events) yield ev; },
    async dispose() {},
  };
}

function fakeGateway() {
  return {
    open(ctx) {
      return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} };
    },
    mcpServers: { async reports() { return []; }, async save() { throw new Error('n/a'); }, async remove() {}, rows: () => [] },
    async dispose() {},
  };
}

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };

async function collect(iterable) {
  const out = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

// ---------- slot pool ----------

test('createSlots: at most `total` acquisitions run concurrently, even with 10 waiters', async () => {
  const slots = createSlots({ total: 6 });
  let concurrent = 0;
  let maxConcurrent = 0;
  const controller = new AbortController();

  async function run() {
    const release = await slots.acquire('chat', controller.signal);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    release();
  }

  await Promise.all(Array.from({ length: 10 }, run));
  assert.ok(maxConcurrent <= 6, `expected at most 6 concurrent, saw ${maxConcurrent}`);
});

test('createSlots: a per-role cap is enforced within the total', async () => {
  const slots = createSlots({ total: 6, perRole: { researcher: 3 } });
  const releases = [];
  for (let i = 0; i < 3; i++) releases.push(await slots.acquire('researcher', new AbortController().signal));
  let fourthAcquired = false;
  const fourth = slots.acquire('researcher', new AbortController().signal).then((r) => { fourthAcquired = true; return r; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fourthAcquired, false, 'a 4th researcher must wait behind the per-role cap of 3');
  releases[0]();
  const release4 = await fourth;
  assert.equal(fourthAcquired, true);
  release4(); releases[1](); releases[2]();
});

test('createSlots: aborting a queued waiter releases it instead of leaving it stuck', async () => {
  const slots = createSlots({ total: 1 });
  const release1 = await slots.acquire('chat', new AbortController().signal);
  const controller = new AbortController();
  const waiter = slots.acquire('chat', controller.signal);
  controller.abort();
  await assert.rejects(waiter);
  release1();
});

// ---------- TurnRunner ----------

test('stream(): text then final becomes done with resolved citations', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [
    { type: 'text', delta: 'See ' },
    { type: 'final', text: 'See [@smith2021].', json: null, usage: {} },
  ])]]);
  const library = { ...noopLibrary, async resolve(refs) { return new Map(refs.map((r) => [`paper:${r.citekey}`, { title: 'Smith 2021' }])); } };
  const runner = createTurnRunner({ providers, getRoleModel: async () => ({ provider: 'fake', model: null }), gateway: fakeGateway(), library, slots: createSlots({ total: 6 }) });
  const events = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' } }, new AbortController().signal));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.answer.citations[0].status, 'resolved');
});

test('stream(): a provider failure ends the stream without a done event', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [{ type: 'failed', error: { kind: 'provider_crashed', message: 'x' } }])]]);
  const runner = createTurnRunner({ providers, getRoleModel: async () => ({ provider: 'fake', model: null }), gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }) });
  const events = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' } }, new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'failed');
});

test('a settings (role -> model) change applies to the next turn, not the one in flight', async () => {
  const providers = new Map([
    ['a', fakeProvider('a', [{ type: 'final', text: 'from a', json: null, usage: {} }])],
    ['b', fakeProvider('b', [{ type: 'final', text: 'from b', json: null, usage: {} }])],
  ]);
  let current = 'a';
  const runner = createTurnRunner({ providers, getRoleModel: async () => ({ provider: current, model: null }), gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }) });
  const ctx = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' };

  const first = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: ctx }, new AbortController().signal));
  assert.equal(first.find((e) => e.type === 'done').answer.text, 'from a');

  current = 'b'; // the settings change
  const second = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: ctx }, new AbortController().signal));
  assert.equal(second.find((e) => e.type === 'done').answer.text, 'from b');
});

test('an unconfigured role/provider fails with model_unavailable rather than throwing', async () => {
  const runner = createTurnRunner({ providers: new Map(), getRoleModel: async () => ({ provider: 'missing', model: null }), gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }) });
  const events = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' } }, new AbortController().signal));
  assert.equal(events[0].error.kind, 'model_unavailable');
});

// ---------- createLocalRuntime (the composition root every host and the sidecar call) ----------

test('createLocalRuntime: a real conversation turn completes end to end (regression: the slot pool it builds must reach the runner it builds)', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [{ type: 'final', text: 'hi there', json: null, usage: {} }])]]);
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: noopLibrary, notes: {}, dataDir: 'data',
    providers, gateway: fakeGateway(), getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  const id = await service.conversations.create('chat');
  const events = await collect(service.conversations.send(id, { text: 'hello' }));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, `expected a done event, got ${JSON.stringify(events)}`);
  assert.equal(done.answer.text, 'hi there');
});

// ---------- runaway-turn guards (T7.1: a lead's plan turn streamed text for 16 minutes with no cap) ----------

/** A provider whose `turn()` never yields on its own; it only resolves once its `signal` is aborted, and records
 *  whether that abort actually reached it (the same signal Cancel already reaches: turn/interrupt for Codex, a
 *  kill for Claude, a fetch abort for OpenAI-compatible). */
function stallingProvider(id, onAbort) {
  return {
    id, caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: id, state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn(req, signal) {
      await new Promise((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => { onAbort?.(); resolve(); }, { once: true });
      });
      yield { type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } };
    },
    async dispose() {},
  };
}

/** A provider that reports each tool call as an activity pair before ever reaching `final`. */
function manyToolCallsProvider(id, count) {
  return {
    id, caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: id, state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn(req, signal) {
      for (let i = 0; i < count; i++) {
        if (signal.aborted) return;
        yield { type: 'activity', id: String(i), phase: 'start', kind: 'library', label: 'Searching' };
        yield { type: 'activity', id: String(i), phase: 'end', kind: 'library', label: 'Searching', ok: true };
      }
      yield { type: 'final', text: 'answered after many tool calls', json: null, usage: {} };
    },
    async dispose() {},
  };
}

const testTools = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' };

test('stream(): a turn past its role\'s wall-clock limit ends with failed{kind:"timeout"}, and the abort reaches the provider', async () => {
  let providerSawAbort = false;
  const providers = new Map([['fake', stallingProvider('fake', () => { providerSawAbort = true; })]]);
  const runner = createTurnRunner({
    providers, getRoleModel: async () => ({ provider: 'fake', model: null }),
    getTurnLimits: async () => ({ wallClockMs: 20, toolCallBudget: 25 }),
    gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }),
  });
  const events = await collect(runner.stream('lead', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].error.kind, 'timeout');
  assert.match(events[0].error.message, /minute/);
  assert.ok(providerSawAbort, 'the provider must observe the abort, the same way an explicit Cancel reaches it');
});

test('stream(): a turn under its wall-clock limit is unaffected by the guard', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [{ type: 'final', text: 'fine', json: null, usage: {} }])]]);
  const runner = createTurnRunner({
    providers, getRoleModel: async () => ({ provider: 'fake', model: null }),
    getTurnLimits: async () => ({ wallClockMs: 5 * 60_000, toolCallBudget: 25 }),
    gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }),
  });
  const events = await collect(runner.stream('chat', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, new AbortController().signal));
  assert.equal(events.find((e) => e.type === 'done')?.answer.text, 'fine');
});

test('stream(): a turn that exceeds its tool-call budget ends with failed{kind:"tool_budget"} before reaching `final`', async () => {
  const providers = new Map([['fake', manyToolCallsProvider('fake', 10)]]);
  const runner = createTurnRunner({
    providers, getRoleModel: async () => ({ provider: 'fake', model: null }),
    getTurnLimits: async () => ({ wallClockMs: 5 * 60_000, toolCallBudget: 2 }),
    gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }),
  });
  const events = await collect(runner.stream('researcher', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, new AbortController().signal));
  const failed = events.find((e) => e.type === 'failed');
  assert.ok(failed, `expected a failed event, got ${JSON.stringify(events)}`);
  assert.equal(failed.error.kind, 'tool_budget');
  assert.match(failed.error.message, /2/);
  assert.ok(!events.some((e) => e.type === 'done'), 'the turn must not reach done once the budget is exceeded');
  assert.ok(events.filter((e) => e.type === 'activity' && e.phase === 'start').length <= 3, 'stops shortly after crossing the budget, not after all 10 calls');
});

test('structured(): a stage turn that times out throws with kind "timeout" (review.js\'s runReview writes this into stopped.json)', async () => {
  const providers = new Map([['fake', stallingProvider('fake')]]);
  const runner = createTurnRunner({
    providers, getRoleModel: async () => ({ provider: 'fake', model: null }),
    getTurnLimits: async () => ({ wallClockMs: 20, toolCallBudget: 25 }),
    gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }),
  });
  await assert.rejects(
    runner.structured('lead', 'plan this', { type: 'object' }, testTools, new AbortController().signal),
    (err) => err.kind === 'timeout',
  );
});

test('structured(): a schema turn returns the parsed JSON', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [{ type: 'final', text: '{"status":"not_found","markdown":"nope"}', json: null, usage: {} }])]]);
  const runner = createTurnRunner({ providers, getRoleModel: async () => ({ provider: 'fake', model: null }), gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }) });
  const result = await runner.structured('ask', 'q', { type: 'object' }, { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'test' }, new AbortController().signal);
  assert.deepEqual(result, { status: 'not_found', markdown: 'nope' });
});

// ---- live activity feed: the engine enriches activity events from the tool result ----
import { createToolGateway } from '../src/tools.js';

test('stream(): end events carry count/detail/source from the tool result; start labels name the source by title', async () => {
  const ref = { kind: 'paper', citekey: 'smith2021' };
  const library = {
    async search() { return [{ ref, title: 'Smith 2021', snippet: 's', year: 2021 }, { ref: { kind: 'paper', citekey: 'b' }, title: 'B', snippet: 's', year: null }]; },
    async read() { return { title: 'Smith 2021: graphene', text: 'body' }; },
    async related() { return []; }, async resolve() { return new Map(); },
  };
  const gateway = await createToolGateway(fetch, library, {});
  const provider = {
    id: 'scripted', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'scripted', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() {}, async signOut() {},
    async *turn(req) {
      const run = async function* (id, tool, args, kind, label) {
        yield { type: 'activity', id, phase: 'start', kind, label, tool, args };
        const r = await req.tools.call(tool, args, new AbortController().signal);
        yield { type: 'activity', id, phase: 'end', kind, label, ok: r.ok, tool, args };
      };
      yield* run('1', 'search_library', { query: 'graphene' }, 'library', 'Searching your papers for "graphene"');
      yield* run('2', 'read_source', { citekey: 'smith2021' }, 'read', 'Reading smith2021');
      // The CLI's own WebFetch never passes through our gateway; the engine reads the host from the arguments.
      const u = { url: 'https://www.example.com/x' };
      yield { type: 'activity', id: '3', phase: 'start', kind: 'web', label: 'Reading https://www.example.com/x', tool: 'WebFetch', args: u };
      yield { type: 'activity', id: '3', phase: 'end', kind: 'web', label: 'Reading https://www.example.com/x', ok: true, tool: 'WebFetch', args: u };
      yield { type: 'final', text: 'ok', json: null, usage: {} };
    },
    async dispose() {},
  };
  const runner = createTurnRunner({
    providers: new Map([['scripted', provider]]), getRoleModel: async () => ({ provider: 'scripted', model: null }),
    gateway, library, slots: createSlots({ total: 6 }),
  });
  const events = (await collect(runner.stream('lead', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, new AbortController().signal)))
    .filter((e) => e.type === 'activity');
  // Behaviour change (live activity from the tool host): our own lib tools are now reported by the host with ids
  // `h:<n>` and the provider's duplicate events are dropped; the WebFetch row (not ours) still comes from the provider.
  const by = (tool, phase) => events.find((e) => e.tool === tool && e.phase === phase);
  assert.equal(events.filter((e) => e.tool === 'search_library').length, 2, 'one start and one end, not doubled');
  assert.match(by('search_library', 'end').id, /^h:/);
  assert.equal(by('search_library', 'end').count, 2);
  assert.equal(by('search_library', 'end').detail, '2 results');
  assert.equal(by('read_source', 'start').label, 'Reading “Smith 2021”', 'a cached title replaces the raw citekey');
  assert.equal(by('read_source', 'end').label, 'Reading “Smith 2021”');
  assert.equal(by('read_source', 'end').source.title, 'Smith 2021: graphene');
  assert.equal(by('WebFetch', 'start').label, 'Reading example.com');
  assert.equal(by('WebFetch', 'end').source.host, 'example.com');
});

test('stream(): a failed call gets no meta, and a gateway without takeMeta still streams', async () => {
  const providers = new Map([['fake', fakeProvider('fake', [
    { type: 'activity', id: 'x', phase: 'start', kind: 'library', label: 'Searching', tool: 'search_library', args: {} },
    { type: 'activity', id: 'x', phase: 'end', kind: 'library', label: 'Searching', ok: false, tool: 'search_library', args: {} },
    { type: 'final', text: 'ok', json: null, usage: {} },
  ])]]);
  const runner = createTurnRunner({ providers, getRoleModel: async () => ({ provider: 'fake', model: null }), gateway: fakeGateway(), library: noopLibrary, slots: createSlots({ total: 6 }) });
  const end = (await collect(runner.stream('lead', { sessionKey: 's', instructions: '', history: [], input: 'hi', tools: testTools }, new AbortController().signal))).find((e) => e.type === 'activity' && e.phase === 'end');
  assert.equal(end.ok, false);
  assert.equal(end.detail, undefined);
});
