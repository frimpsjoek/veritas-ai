import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createToolGateway } from '../src/tools.js';
import { memoryFs } from './support/memory-fs.mjs';

function capturingScopeProvider(inputs) {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      inputs.push(req.input);
      yield { type: 'text', delta: 'Answer ' };
      yield { type: 'final', text: req.outputSchema ? JSON.stringify({ status: 'answered', markdown: 'ok' }) : 'Answer', json: null, usage: {} };
    },
    async dispose() {},
  };
}

function capturingProvider(inputs) {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      inputs.push(req.input);
      yield { type: 'text', delta: 'Answer ' };
      yield { type: 'final', text: req.outputSchema ? JSON.stringify({ status: 'answered', markdown: 'ok' }) : 'Answer [@smith2021]', json: null, usage: {} };
    },
    async dispose() {},
  };
}

async function runtimeWith(inputs) {
  const gateway = {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; },
    async resolve(refs) { return new Map(refs.map((r) => [`paper:${r.citekey}`, r.citekey === 'smith2021' ? { title: 'Smith' } : null])); } };
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', capturingProvider(inputs)]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
}

test('a chat turn runs through the composition root and the provider sees what the user attached', async () => {
  const inputs = [];
  const ai = await runtimeWith(inputs);
  const id = await ai.conversations.create('chat');
  const events = [];
  for await (const ev of ai.conversations.send(id, { text: 'Compare these', attachments: [{ kind: 'zoteroItem', citekey: 'smith2021' }, { kind: 'quote', text: 'sleep helps' }] })) events.push(ev);
  const done = events.find((ev) => ev.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.deepEqual(done.answer.citations.map((c) => c.status), ['resolved']);
  assert.match(inputs[0], /^Compare these\n\nThe user attached:\n- the paper \[@smith2021\]\n- this quoted passage: """sleep helps"""$/);
  const records = await ai.conversations.load(id);
  assert.deepEqual(records.map((r) => r.type), ['meta', 'user', 'assistant']);
});

// ---------- spec 005: sources (unit A2) ----------

test('send with no sources stores the default (papers, notes, scholarly on; web off) on the user record', async () => {
  const ai = await runtimeWith([]);
  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'hi' })) void ev;
  const records = await ai.conversations.load(id);
  const user = records.find((r) => r.type === 'user');
  assert.deepEqual(user.sources, { papers: true, notes: true, scholarly: true, web: false });
});

test('send with an explicit sources choice stores exactly what was searched', async () => {
  const ai = await runtimeWith([]);
  const id = await ai.conversations.create('chat');
  const sources = { papers: false, notes: true, scholarly: false, web: false };
  for await (const ev of ai.conversations.send(id, { text: 'hi', sources })) void ev;
  const records = await ai.conversations.load(id);
  assert.deepEqual(records.find((r) => r.type === 'user').sources, sources);
});

test('an old user record with no sources field still loads (conversations.load does not validate the shape)', async () => {
  const ai = await runtimeWith([]);
  const incoming = [
    { type: 'meta', id: 'old-1', mode: 'chat', title: 'Old', created: '2026-01-01T00:00:00.000Z' },
    { type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01.000Z' },
  ].map((r) => JSON.stringify(r)).join('\n');
  await ai.conversations.adopt([{ id: 'old-1', jsonl: incoming }]);
  const records = await ai.conversations.load('old-1');
  const user = records.find((r) => r.type === 'user');
  assert.equal(user.text, 'hi');
  assert.equal(user.sources, undefined);
});

test('ask passes attachments too, and a turn with none is sent unchanged', async () => {
  const inputs = [];
  const ai = await runtimeWith(inputs);
  for await (const ev of ai.ask('What is this?', { attachments: [{ kind: 'zoteroItem', citekey: 'K1' }] })) void ev;
  for await (const ev of ai.ask('Plain question')) void ev;
  assert.match(inputs[0], /\[@K1\]/);
  assert.equal(inputs[1], 'Plain question');
});

function runtimeForScope(inputs, scopes) {
  const gateway = {
    // The gateway is opened with the real ToolContext once per turn (core.js: `deps.gateway.open(req.tools)`),
    // so this is where a test can see the scope the provider's own tool calls would have been confined to.
    open(ctx) { scopes.push(ctx.scope); return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', capturingScopeProvider(inputs)]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
}

test('conversations.send: a collections scope reaches the ToolContext and is mentioned in the prompt', async () => {
  const inputs = [], scopes = [];
  const ai = await runtimeForScope(inputs, scopes);
  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'Summarize', scope: { kind: 'collections', keys: ['K1'] } })) void ev;
  assert.deepEqual(scopes[0], { kind: 'collections', keys: ['K1'] });
  assert.match(inputs[0], /library search is limited to the selected collection\b/);
});

test('conversations.send: no scope defaults the ToolContext to the whole library, as before', async () => {
  const inputs = [], scopes = [];
  const ai = await runtimeForScope(inputs, scopes);
  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'Summarize' })) void ev;
  assert.deepEqual(scopes[0], { kind: 'library' });
  assert.equal(inputs[0], 'Summarize');
});

test('ask: a tag scope reaches the ToolContext and is mentioned in the prompt', async () => {
  const inputs = [], scopes = [];
  const ai = await runtimeForScope(inputs, scopes);
  for await (const ev of ai.ask('What themes recur?', { scope: { kind: 'tag', name: 'important' } })) void ev;
  assert.deepEqual(scopes[0], { kind: 'tag', name: 'important' });
  assert.match(inputs[0], /library search is limited to papers tagged "important"/);
});

test('ask: valid JSON of the wrong shape ends as bad_output, never as a done answer without status/markdown', async () => {
  // Found by the real type check: ask() passed answer.structured through as an AskResult after only a JSON
  // parse, so an OpenAI-compatible server that ignores response_format could hand the UI {"answer": "..."}.
  const gateway = {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const wrongShape = {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn() { yield { type: 'final', text: JSON.stringify({ answer: 'looks fine' }), json: null, usage: {} }; },
    async dispose() {},
  };
  const ai = await createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', wrongShape]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  const events = [];
  for await (const ev of ai.ask('Anything')) events.push(ev);
  assert.equal(events.some((ev) => ev.type === 'done'), false, JSON.stringify(events));
  assert.deepEqual(events.at(-1), { type: 'failed', error: { kind: 'bad_output', message: 'The answer did not match the expected shape.' } });

  const right = [];
  for await (const ev of (await runtimeWith([])).ask('Anything')) right.push(ev);
  assert.deepEqual(right.find((ev) => ev.type === 'done').answer.structured, { status: 'answered', markdown: 'ok' });
});

// ---------- chat history (seam 1): the store is the source of truth, so the second turn of a chat must see
// the first turn's user message and answer, and must never see its own current message twice. ----------

function historyRecordingProvider(turns) {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      turns.push({ input: req.input, history: req.history });
      yield { type: 'final', text: `Answer ${turns.length}`, json: null, usage: {} };
    },
    async dispose() {},
  };
}

async function runtimeWithHistory(turns) {
  const gateway = {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', historyRecordingProvider(turns)]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
}

test('a second chat turn sees the first turn in its history, exactly once (not duplicated, not missing)', async () => {
  const turns = [];
  const ai = await runtimeWithHistory(turns);
  const id = await ai.conversations.create('chat');

  for await (const ev of ai.conversations.send(id, { text: 'What does my library say about embeddings?' })) void ev;
  for await (const ev of ai.conversations.send(id, { text: 'Which of those is the oldest?' })) void ev;

  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].history, [], 'the first turn of a conversation has no history yet');
  assert.deepEqual(turns[1].history, [
    { role: 'user', text: 'What does my library say about embeddings?' },
    { role: 'assistant', text: 'Answer 1' },
  ], 'turn 2 must see turn 1, and only once: not the current message duplicated onto the tail');
  assert.equal(turns[1].input, 'Which of those is the oldest?');
});

// ---------- conversations.adopt (seam 2) ----------

test('conversations.adopt is idempotent end to end: adopting the same conversation twice writes it once', async () => {
  const ai = await runtimeWith([]);
  const incoming = [
    { type: 'meta', id: 'zotero-1', mode: 'chat', title: 'From Zotero', created: '2026-01-01T00:00:00.000Z' },
    { type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01.000Z' },
  ].map((r) => JSON.stringify(r)).join('\n');

  const first = await ai.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]);
  assert.deepEqual(first, ['zotero-1']);
  const second = await ai.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]);
  assert.deepEqual(second, ['zotero-1'], 'a repeat adopt still reports the id as owned here');

  const records = await ai.conversations.load('zotero-1');
  assert.equal(records.filter((r) => r.type === 'meta').length, 1, 'adopting twice must not duplicate the conversation');
  assert.equal(records.length, 2);
});

// ---------- T6.2: settings-backed getRoleModel (criterion 10, no restart) ----------

test('with no getRoleModel override, the runtime resolves roles from its own settings.json, live on every turn', async () => {
  const seenProviders = [];
  const gateway = {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; }, async save(c) { return { config: c, state: 'connected', error: null, tools: [] }; }, async remove() {} },
    async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  function trackingProvider(id) {
    return {
      id, caps: {},
      async status() { return null; }, async models() { return []; },
      async *turn() { seenProviders.push(id); yield { type: 'final', text: 'ok', json: null, usage: {} }; },
      async dispose() {},
    };
  }
  const ai = await createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['codex', trackingProvider('codex')], ['fake', trackingProvider('fake')]]), gateway,
    // No getRoleModel: this is exactly what every real host (agent-host.js, agentd.mjs) does since T6.2.
  });

  assert.deepEqual(await ai.providers.roles(), {
    chat: { provider: 'codex', model: null }, ask: { provider: 'codex', model: null }, lead: { provider: 'codex', model: null },
    researcher: { provider: 'codex', model: null }, writer: { provider: 'codex', model: null },
    extract: null, // unset: follows the researcher (spec 007 E4)
  }, 'every role defaults to codex until Settings says otherwise');

  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'hi' })) void ev;
  assert.deepEqual(seenProviders, ['codex']);

  await ai.providers.setRole('chat', { provider: 'fake', model: null });
  assert.deepEqual((await ai.providers.roles()).chat, { provider: 'fake', model: null });
  assert.deepEqual((await ai.providers.roles()).ask, { provider: 'codex', model: null }, 'setRole only touches the one role');

  // The very next message on the same conversation, no restart: criterion 10.
  for await (const ev of ai.conversations.send(id, { text: 'again' })) void ev;
  assert.deepEqual(seenProviders, ['codex', 'fake']);
});

test('mcp.save persists the server into settings.json (survives a fresh runtime over the same dataDir)', async () => {
  const fs = memoryFs();
  const saved = [];
  function gatewayFor() {
    return {
      open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
      mcpServers: {
        async reports() { return saved.map((config) => ({ config, state: 'connected', error: null, tools: [] })); },
        async save(config) { saved.push(config); return { config, state: 'connected', error: null, tools: [] }; },
        async remove(name) { const i = saved.findIndex((c) => c.name === name); if (i >= 0) saved.splice(i, 1); },
      },
      async dispose() {},
    };
  }
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const deps = { platform: { fs }, library, notes: null, dataDir: '/data', providers: new Map(), gateway: gatewayFor() };

  const first = await createLocalRuntime(deps);
  const config = { name: 'pubmed', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@cyanheads/pubmed-mcp-server@latest'], env: {} };
  await first.mcp.save(config);
  assert.deepEqual((await first.mcp.list()).map((r) => r.config.name), ['pubmed']);

  // A fresh runtime over the same dataDir, its own fresh (empty) gateway: settings.json is what lets it re-seed.
  const second = await createLocalRuntime({ ...deps, gateway: gatewayFor() });
  const persisted = await second.settings.get();
  assert.deepEqual(persisted.mcp.map((c) => c.name), ['pubmed'], 'the saved server survived in settings.json');

  await second.mcp.remove('pubmed');
  assert.deepEqual((await second.settings.get()).mcp, []);
});

// ---------- spec 007 E1: sessions ----------

function draftPapers(over = {}) {
  return {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'Widgets', created: '', madeBy: '', from: [], change: 'Found 1 paper',
    query: 'widgets',
    rows: [{
      id: 'x:1', ref: { kind: 'web', url: 'https://doi.org/10.9/out' }, inLibrary: false,
      title: 'Outside widgets paper', authors: ['Doe'], year: 2022, venue: '', doi: '10.9/out', url: null,
      abstract: 'About widgets.', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['OpenAlex'],
    }],
    columns: [], cells: {}, screening: null, summary: null,
    ...over,
  };
}

async function runtimeForSessions() {
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const provider = {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn() { yield { type: 'final', text: 'ok', json: null, usage: {} }; },
    async dispose() {},
  };
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data', providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
}

test('sessions.put/read: V1 -> V2 -> restore V3 round trip; each version stays readable', async () => {
  const ai = await runtimeForSessions();
  const id = await ai.conversations.create('chat');

  const v1 = await ai.sessions.put(id, { kind: 'find', query: 'widgets', sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: 'library' } }, draftPapers());
  assert.equal(v1.ref.id, 'R1');
  assert.equal(v1.ref.version, 1);
  assert.equal(v1.rows, 1);

  const v2 = await ai.sessions.put(id, { kind: 'narrow', on: v1.ref, keep: ['x:1'], why: 'kept the only row' }, draftPapers({ ref: { id: 'R1', version: 0 }, change: 'Narrowed' }));
  assert.equal(v2.ref.id, 'R1');
  assert.equal(v2.ref.version, 2);

  const view = await ai.sessions.view(id);
  assert.equal(view.results.length, 1, 'one result id, latest version only in the summary list');
  assert.equal(view.results[0].ref.version, 2);
  assert.deepEqual(view.current, { id: 'R1', version: 2 });
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0].status, 'done');

  const readV1 = await ai.sessions.read(id, { id: 'R1', version: 1 });
  assert.equal(readV1.change, 'Found 1 paper'); // V1 still opens read-only, unchanged
  const readLatest = await ai.sessions.read(id, { id: 'R1' }); // no version: latest
  assert.equal(readLatest.ref.version, 2);

  const v3 = await ai.sessions.restore(id, { id: 'R1', version: 1 });
  assert.equal(v3.ref.version, 3);
  const restored = await ai.sessions.read(id, { id: 'R1', version: 3 });
  assert.equal(restored.change, 'Restored V1');
  assert.equal(restored.rows.length, 1); // the V1 body, not V2's
});

test('sessions.setCurrent records which result later steps read by default', async () => {
  const ai = await runtimeForSessions();
  const id = await ai.conversations.create('chat');
  const r1 = await ai.sessions.put(id, { kind: 'find', query: 'a', sources: {}, scope: { kind: 'library' } }, draftPapers());
  const r2 = await ai.sessions.put(id, { kind: 'find', query: 'b', sources: {}, scope: { kind: 'library' } }, draftPapers({ title: 'Other' }));
  assert.deepEqual((await ai.sessions.view(id)).current, r2.ref); // newest by default
  await ai.sessions.setCurrent(id, r1.ref);
  assert.deepEqual((await ai.sessions.view(id)).current, r1.ref);
});

test('a plain chat conversation (no sessions.put ever called) still has an empty session view, not an error', async () => {
  const ai = await runtimeForSessions();
  const id = await ai.conversations.create('chat');
  for await (const ev of ai.conversations.send(id, { text: 'hi' })) void ev;
  const view = await ai.sessions.view(id);
  assert.deepEqual(view.results, []);
  assert.equal(view.steps.length, 1); // the legacy view: one chat turn = one step
  assert.equal(view.steps[0].status, 'done');
});

test('a follow-up question about a session paper set calls read_result, not a search tool, and resolves the outside DOI citation', async () => {
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const gateway = await createToolGateway(fetch, library, {});
  const toolCalls = [];
  const provider = {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      const result = await req.tools.call('read_result', { result: 'R1' });
      toolCalls.push({ name: 'read_result', ok: result.ok, text: result.text });
      yield { type: 'activity', id: 'a1', phase: 'start', kind: 'result', label: 'Referenced result R1' };
      yield { type: 'activity', id: 'a1', phase: 'end', kind: 'result', label: 'Referenced result R1', ok: true };
      yield { type: 'final', text: 'The outside paper is https://doi.org/10.9/out.', json: null, usage: {} };
    },
    async dispose() {},
  };
  const ai = await createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  const id = await ai.conversations.create('chat');
  await ai.sessions.put(id, { kind: 'find', query: 'widgets', sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: 'library' } }, draftPapers());

  const events = [];
  for await (const ev of ai.conversations.send(id, { text: 'Tell me about the outside paper' })) events.push(ev);

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].ok, true);
  assert.match(toolCalls[0].text, /Outside widgets paper/);

  const done = events.find((ev) => ev.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.deepEqual(done.answer.citations, [{ ref: { kind: 'web', url: 'https://doi.org/10.9/out' }, status: 'resolved', title: 'https://doi.org/10.9/out', retrievedThisTurn: true }]);
});

test('a chat_papers turn (SendInput.on set) narrows tools to read_result/read_source: search_library is refused', async () => {
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const gateway = await createToolGateway(fetch, library, {});
  const specsSeen = [];
  const provider = {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      specsSeen.push(req.tools.specs.map((s) => s.name));
      const refused = await req.tools.call('search_library', { query: 'x' });
      yield { type: 'final', text: refused.ok ? 'searched' : `refused: ${refused.text}`, json: null, usage: {} };
    },
    async dispose() {},
  };
  const ai = await createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: null, dataDir: '/data',
    providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  const id = await ai.conversations.create('chat');
  const r1 = await ai.sessions.put(id, { kind: 'find', query: 'widgets', sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: 'library' } }, draftPapers());

  const events = [];
  for await (const ev of ai.conversations.send(id, { text: 'What does this say?', on: { result: r1.ref, rows: 'all' } })) events.push(ev);

  assert.ok(!specsSeen[0].includes('search_library'), specsSeen[0].join(','));
  assert.ok(specsSeen[0].includes('read_result'));
  const done = events.find((ev) => ev.type === 'done');
  assert.match(done.answer.text, /^refused:/);
});
