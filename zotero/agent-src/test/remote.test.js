// A local runtime and a remote runtime, driven through the identical scenario, must produce identical event
// sequences (T3.3's acceptance). The "transport" here is a loopback built directly from agentd.mjs's own route
// table (`routes()`), so this exercises the real wire shapes remote.js assumes without needing a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { memoryFs } from './support/memory-fs.mjs';

function fakeProvider(events, delayMs = 5) {
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() { for (const ev of events) { await new Promise((r) => setTimeout(r, delayMs)); yield ev; } },
    async dispose() {},
  };
}

function fakeGateway() {
  const saved = [];
  return {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: {
      async reports() { return saved.map((config) => ({ config, state: 'connected', error: null, tools: [] })); },
      async save(config) { const i = saved.findIndex((c) => c.name === config.name); if (i >= 0) saved[i] = config; else saved.push(config); return { config, state: 'connected', error: null, tools: [] }; },
      async remove(name) { const i = saved.findIndex((c) => c.name === name); if (i >= 0) saved.splice(i, 1); },
      rows: () => [],
    },
    async dispose() {},
  };
}

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };

async function makeService({ fetch, library } = {}) {
  return createLocalRuntime({
    platform: { fs: memoryFs(), ...(fetch ? { fetch } : {}) }, library: library ?? noopLibrary, notes: {}, dataDir: 'data',
    providers: new Map([['fake', fakeProvider([
      { type: 'text', delta: 'See ' },
      { type: 'final', text: 'See [@smith2021].', json: null, usage: {} },
    ])]]),
    gateway: fakeGateway(),
    getRoleModel: async () => ({ provider: 'fake', model: null }),
    limits: { total: 6 },
  });
}

function parseQuery(search) {
  return Object.fromEntries(new URLSearchParams(search));
}

/** A loopback "wire": JSON round-trips the args and the result, the way an HTTP hop actually would, so a type
 *  that doesn't survive JSON (undefined, a class instance) would fail here exactly as it would over real HTTP. */
function loopbackTransport(service) {
  const table = routes();
  function wire(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }

  return {
    async request(method, path, body) {
      const [pathname, search] = path.split('?');
      const row = table.find((r) => r.method === method && r.path === pathname);
      if (!row) throw new Error(`no loopback route for ${method} ${path}`);
      const args = { ...parseQuery(search ?? ''), ...(body ?? {}) };
      return wire(await row.call(service, args, { signal: new AbortController().signal }));
    },
    async *stream(path, after, signal) {
      const [pathname, search] = path.split('?');
      const { id } = parseQuery(search ?? '');
      const row = table.find((r) => r.method === 'GET' && r.path === pathname);
      let cursor = after;
      while (!signal?.aborted) {
        const batch = /** @type {any[]} */ (await row.call(service, { id, after: cursor }, { signal }));
        for (const ev of batch) { cursor = ev.seq; yield { seq: ev.seq, data: wire(ev) }; }
        if (pathname === '/events' && batch.some((ev) => ev.type === 'done' || ev.type === 'failed')) return;
        if (pathname === '/reviews/events' && batch.some((ev) => ['done', 'stopped', 'awaiting_approval'].includes(ev.status?.state))) return;
      }
    },
  };
}

async function collect(iterable) {
  const out = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

function withoutSeq(events) {
  return events.map(({ seq, ...rest }) => rest);
}

test('createRemoteRuntime over a loopback transport sees the same events as the local runtime it wraps', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));

  const localId = await service.conversations.create('chat');
  const localEvents = await collect(service.conversations.send(localId, { text: 'hello' }));

  const remoteId = await remote.conversations.create('chat');
  const remoteEvents = await collect(remote.conversations.send(remoteId, { text: 'hello' }));

  assert.deepEqual(withoutSeq(remoteEvents), withoutSeq(localEvents));
  assert.ok(remoteEvents.at(-1).type === 'done');
  assert.equal(remote.where, 'server');
});

function fakeProviderReturning(text) {
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() { yield { type: 'final', text, json: null, usage: {} }; },
    async dispose() {},
  };
}

/** A gateway opened with the real ToolContext once per turn (core.js: `deps.gateway.open(req.tools)`), so this
 *  is where a test can see the scope a scoped Chat/Ask request narrowed search_library to. */
function scopeCapturingGateway(seen) {
  return {
    open(ctx) { seen.push(ctx.scope); return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } },
    async dispose() {},
  };
}

test('conversations.send: a scope survives the HTTP wire and reaches the ToolContext (collection narrowing)', async () => {
  const seen = [];
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: noopLibrary, notes: {}, dataDir: 'data',
    providers: new Map([['fake', fakeProviderReturning('ok')]]),
    gateway: scopeCapturingGateway(seen), getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  const remote = createRemoteRuntime(loopbackTransport(service));
  const id = await remote.conversations.create('chat');
  await collect(remote.conversations.send(id, { text: 'hello', scope: { kind: 'collections', keys: ['K1'] } }));
  assert.deepEqual(seen[0], { kind: 'collections', keys: ['K1'] });
});

test('ask: a scope survives the HTTP wire and reaches the ToolContext', async () => {
  const seen = [];
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: noopLibrary, notes: {}, dataDir: 'data',
    providers: new Map([['fake', fakeProviderReturning(JSON.stringify({ status: 'answered', markdown: 'ok' }))]]),
    gateway: scopeCapturingGateway(seen), getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  const remote = createRemoteRuntime(loopbackTransport(service));
  const events = [];
  for await (const ev of remote.ask('what?', { scope: { kind: 'tag', name: 'important' } })) events.push(ev);
  assert.deepEqual(seen[0], { kind: 'tag', name: 'important' });
});

test('a remote client reconnecting mid-turn (after > 0) still gets the rest, then stops at done', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  const id = await remote.conversations.create('chat');

  const full = await collect(remote.conversations.send(id, { text: 'hello' }));
  const firstSeq = full[0].seq;

  // A second client resumes from after the first event, as if it reconnected mid-turn.
  const resumed = await collect(remote.conversations.send(id, { text: '' }, { after: firstSeq }));
  assert.deepEqual(withoutSeq(resumed), withoutSeq(full.slice(1)));
});

test('conversations.list/load/rename/remove round-trip through the loopback wire', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));

  const id = await remote.conversations.create('ask');
  await remote.conversations.rename(id, 'Renamed');
  const list = await remote.conversations.list();
  assert.ok(list.some((c) => c.id === id && c.title === 'Renamed'));

  const loaded = await remote.conversations.load(id);
  assert.ok(loaded.some((r) => r.type === 'meta'));

  await remote.conversations.remove(id);
  const afterRemove = await remote.conversations.list();
  assert.ok(!afterRemove.some((c) => c.id === id));
});

test('conversations.adopt round-trips through the loopback wire and is idempotent', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));

  const incoming = [
    JSON.stringify({ type: 'meta', id: 'zotero-1', mode: 'chat', title: 'From Zotero', created: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01.000Z' }),
  ].join('\n');

  assert.deepEqual(await remote.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]), ['zotero-1']);
  assert.deepEqual(await remote.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]), ['zotero-1']);

  const records = await remote.conversations.load('zotero-1');
  assert.equal(records.filter((r) => r.type === 'meta').length, 1, 'adopting twice through the remote client must not duplicate the conversation');
});

test('providers.status round-trips', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  const status = await remote.providers.status();
  assert.equal(status[0].provider, 'fake');
});

// ---------- T6.2/T6.3 parity: roles, mcp servers and settings, the same way a Settings UI (either host) uses
// them, over the loopback wire. Obsidian never has a local runtime -- this is the only path it has to any of
// these, so a route missing here (agentd.mjs's table or remote.js's own shape) is a real user-facing gap, not
// just a style nit. Found live this way: remote.js had no `settings` property at all until this test existed. ----------

test('providers.roles/setRole round-trip, live on the next call (no restart)', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  assert.deepEqual((await remote.providers.roles()).chat, { provider: 'codex', model: null });
  await remote.providers.setRole('chat', { provider: 'fake', model: null });
  assert.deepEqual((await remote.providers.roles()).chat, { provider: 'fake', model: null });
  assert.deepEqual((await remote.providers.roles()).ask, { provider: 'codex', model: null }, 'setRole only touches the one role');
});

test('mcp.save/list/remove round-trip, and a saved server survives in settings.get() too', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  const config = { name: 'pubmed', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@cyanheads/pubmed-mcp-server@latest'], env: {} };

  const saved = await remote.mcp.save(config);
  assert.equal(saved.config.name, 'pubmed');
  assert.equal(saved.state, 'connected');
  assert.deepEqual((await remote.mcp.list()).map((r) => r.config.name), ['pubmed']);
  assert.deepEqual((await remote.settings.get()).mcp.map((c) => c.name), ['pubmed']);

  await remote.mcp.remove('pubmed');
  assert.deepEqual(await remote.mcp.list(), []);
  assert.deepEqual((await remote.settings.get()).mcp, []);
});

test('settings.get/update round-trip, and a partial update leaves the rest alone', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  assert.equal((await remote.settings.get()).webSearchDefault, 'off');

  const updated = await remote.settings.update({ webSearchDefault: 'live' });
  assert.equal(updated.webSearchDefault, 'live');
  assert.deepEqual((await remote.settings.get()).roles.chat, { provider: 'codex', model: null }, 'a partial update does not clobber roles');
});

test('settings.openalex is saved but never sent back (spec 020), a blank key clears it, limitUntil is status the update ignores', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));
  assert.deepEqual((await remote.settings.get()).openalex, { apiKey: null, limitUntil: null });
  const saved = await remote.settings.update({ openalex: { apiKey: ' abcdefgh12345678 ', limitUntil: '2030-01-01T00:00:00Z' } });
  assert.ok(!JSON.stringify(saved).includes('abcdefgh'), 'the update reply carries no key');
  assert.deepEqual((await remote.settings.get()).openalex, { apiKey: { set: true, last4: '5678' }, limitUntil: null });
  await remote.settings.update({ webSearchDefault: 'live' });
  assert.deepEqual((await remote.settings.get()).openalex.apiKey, { set: true, last4: '5678' }, 'an unrelated update keeps the key');
  await remote.settings.update({ openalex: { apiKey: { set: true, last4: '5678' } } });
  assert.deepEqual((await remote.settings.get()).openalex.apiKey, { set: true, last4: '5678' }, 'the marker sent back keeps the key');
  await remote.settings.update({ openalex: { apiKey: '  ' } });
  assert.equal((await remote.settings.get()).openalex.apiKey, null);
});

// ---------- reviews parity: a remote client (Zotero when the server runs, Obsidian always) must see the same
// review lifecycle the local runtime does, over the loopback wire (design/final/rationale.md's P5 note). ----------

function reviewProvider() {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      let json;
      if (/^Plan a literature review/.test(req.input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['library'] }] };
      else if (/researching one sub-question/.test(req.input)) json = { findings: [{ claim: 'c', sources: [{ citekey: 'k1', doi: null, url: null, title: 'P', year: 2022 }], quotes: [], confidence: 'high' }], searchLog: [{ query: 'q', source: 'library', results: 1 }] };
      else json = { title: 'T', scope: 'S', method: 'M', themes: [], evidence: [], disagreements: '', gaps: '' };
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

async function makeReviewService() {
  const published = [];
  return {
    published,
    service: await createLocalRuntime({
      platform: { fs: memoryFs() }, library: noopLibrary, notes: { async publish(n) { published.push(n); return { path: `ai_notes/Literature Reviews/${n.title}.md` }; } }, dataDir: 'data',
      providers: new Map([['fake', reviewProvider()]]), gateway: fakeGateway(),
      getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6, perRole: { researcher: 3 } },
    }),
  };
}

test('a remote review runs to awaiting_approval, is approved, and finishes, matching what watch() promises locally', async () => {
  const { service, published } = await makeReviewService();
  const remote = createRemoteRuntime(loopbackTransport(service));

  const id = await remote.reviews.start({ question: 'Does X help Y?', scope: { kind: 'library' }, sources: ['library'], years: { from: null, to: null }, depth: 'quick' });

  const waiting = await collect(remote.reviews.watch(id));
  assert.equal(waiting.at(-1).status.state, 'awaiting_approval');
  assert.equal(waiting.at(-1).status.plan.subQuestions.length, 1);

  await remote.reviews.approvePlan(id, waiting.at(-1).status.plan);

  const finished = await collect(remote.reviews.watch(id, { after: waiting.at(-1).seq }));
  assert.equal(finished.at(-1).status.state, 'done');
  assert.equal(published.length, 1);

  const listed = await remote.reviews.list();
  assert.equal(listed.find((p) => p.id === id).status.state, 'done');
});

// spec 007 E7: a pipeline-2 review over the remote runtime (Obsidian's path): the watch ends at awaiting_answer,
// `reviews.answer` goes through POST /reviews/answer, and the progress carries lines, counts and the table.
test('a remote pipeline-2 review asks, takes the answer over /reviews/answer, is approved and finishes with lines and counts', async () => {
  const cand = (n) => ({ citekey: `k${n}`, doi: null, url: null, title: `Paper ${n}`, year: 2020, abstract: `Spaced practice helped learners in study ${n}.`, authors: [], venue: '' });
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; }, async dispose() {},
    async *turn(req) {
      let json;
      if (/^A researcher wants a literature report/.test(req.input)) json = { questions: [{ id: 'route', question: 'Which route?', choices: ['Narrative', 'Formal'], other: false }] };
      else if (/^Plan a literature review/.test(req.input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] };
      else if (/finding papers for one sub-question/.test(req.input)) json = { candidates: [cand(1), cand(2)], searchLog: [{ query: 'q', source: 'papers', results: 2 }] };
      else if (/^You extract data/.test(req.input)) json = { rows: [...req.input.matchAll(/### Paper (\S+)/g)].map((m) => ({ row: m[1], cells: [{ column: 'main_findings', status: 'found', value: 'helped', quotes: ['Spaced practice helped'] }] })) };
      else json = { title: 'A report', scope: 's', method: 'm', themes: [], evidence: [{ claim: 'It helps', sources: ['k1'], strength: 'strong', cells: [{ row: 'p:k1', column: 'main_findings' }] }], disagreements: '', gaps: '' };
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
  };
  const published = [];
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: noopLibrary, notes: { async publish(n) { published.push(n); return { path: `ai_notes/${n.title}.md` }; } }, dataDir: 'data',
    providers: new Map([['fake', provider]]), gateway: fakeGateway(), getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6, perRole: { researcher: 3 } },
  });
  const remote = createRemoteRuntime(loopbackTransport(service));
  const id = await remote.reviews.start({ question: 'Does spaced practice work?', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick', pipeline: 2 });

  const asked = await collect(remote.reviews.watch(id));
  assert.equal(asked.at(-1).status.state, 'awaiting_answer');
  assert.equal(asked.at(-1).status.questions[0].choices[1], 'Formal');
  await remote.reviews.answer(id, [{ id: 'route', choice: 1, other: null }]);

  const waiting = await collect(remote.reviews.watch(id, { after: asked.at(-1).seq }));
  assert.equal(waiting.at(-1).status.state, 'awaiting_approval');
  assert.equal(waiting.at(-1).lines[0].detail, 'Formal');
  await remote.reviews.approvePlan(id, waiting.at(-1).status.plan);

  const finished = await collect(remote.reviews.watch(id, { after: waiting.at(-1).seq }));
  const last = finished.at(-1);
  assert.equal(last.status.state, 'done');
  assert.deepEqual(last.counts, { candidates: 2, included: 2, excluded: 0, extracted: 2 });
  assert.equal(last.table.rows.length, 2);
  assert.deepEqual(last.report.evidence[0].cells, [{ row: 'p:k1', column: 'main_findings' }]);
  assert.equal(published.length, 1);
});

test('every /projects route round-trips through the loopback wire; create(mode, { project }) sends the project', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(loopbackTransport(service));

  const p = await remote.projects.create('Voles');
  assert.equal(p.name, 'Voles');
  assert.equal((await remote.projects.rename(p.id, 'Field voles')).name, 'Field voles');
  assert.deepEqual((await remote.projects.list()).map((x) => x.name), ['Field voles']);

  const inside = await remote.conversations.create('chat', { project: p.id });
  const outside = await remote.conversations.create('chat');
  const moved = await remote.conversations.create('chat');
  let list = await remote.conversations.list();
  assert.equal(list.find((c) => c.id === inside).project, p.id);
  assert.equal(list.find((c) => c.id === outside).project, undefined);

  await remote.projects.assign({ kind: 'chat', id: moved }, p.id);
  list = await remote.conversations.list();
  assert.equal(list.find((c) => c.id === moved).project, p.id);
  await remote.projects.assign({ kind: 'chat', id: moved }, null);
  list = await remote.conversations.list();
  assert.equal(list.find((c) => c.id === moved).project, null);
  await assert.rejects(() => remote.projects.assign({ kind: 'chat', id: 'nope' }, p.id), /no chat with that id/);

  const rec = { id: 'zp1', name: 'From Zotero', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(await remote.projects.adopt([rec]), ['zp1']);
  assert.deepEqual(await remote.projects.adopt([rec]), ['zp1']);

  await remote.projects.remove(p.id);
  assert.deepEqual((await remote.projects.list()).map((x) => x.id), ['zp1']);
  list = await remote.conversations.list();
  assert.equal(list.find((c) => c.id === inside).project, p.id, 'members keep their history');
});

test('scholarly.search runs every outside source over the wire; a source that fails is named, the rest still answer', async () => {
  const work = { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1/x', display_name: 'Phonons from first principles', publication_year: 2026, publication_date: '2026-10-01', authorships: [{ author: { display_name: 'A. Author' } }], primary_location: { source: { display_name: 'Phys. Rev. B' } }, cited_by_count: 3 };
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('api.openalex.org')) return new Response(JSON.stringify({ results: [work] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('down', { status: 503 });
  };
  const service = await makeService({ fetch: fetchFn });
  const remote = createRemoteRuntime(loopbackTransport(service));
  const out = await remote.scholarly.search('phonons', 5);
  const fromOpenAlex = out.papers.filter((p) => p.source === 'openalex');
  assert.ok(fromOpenAlex.some((p) => p.title === 'Phonons from first principles' && p.doi === '10.1/x' && p.citations === 3));
  assert.ok(out.failed.includes('arxiv') && out.failed.includes('crossref'), 'failing sources are reported by name');
});

test('radar.profile and radar.checkSource round-trip over the wire, and say so plainly without the library server', async () => {
  const library = { ...noopLibrary, async radarProfile() { return { topics: [{ text: 'phonon transport', weight: 2 }], authors: [{ name: 'Galli, G.', count: 4 }], journals: [] }; } };
  const fetchFn = async (url) => {
    const u = String(url);
    const json = (results) => new Response(JSON.stringify({ results }), { status: 200 });
    if (u.includes('/authors?search=')) return json([{ id: 'https://openalex.org/A1', display_name: 'Giulia Galli', works_count: 781, last_known_institutions: [{ display_name: 'U Chicago' }] }]);
    if (u.includes('filter=issn:2057-3960')) return json([{ id: 'https://openalex.org/S5', display_name: 'npj Computational Materials', issn_l: '2057-3960', works_count: 900, host_organization_name: 'Invented Press' }]);
    if (u.startsWith('https://nature.example/')) return new Response('', { status: 403 });
    return json([]);
  };
  const remote = createRemoteRuntime(loopbackTransport(await makeService({ fetch: fetchFn, library })));
  const profile = await remote.radar.profile({ kind: 'library' });
  assert.deepEqual(profile.topics, [{ text: 'phonon transport', weight: 1, origin: 'seed' }]);
  assert.deepEqual(profile.authors, [{ name: 'Galli, G.', weight: 1, origin: 'seed', openalexId: 'A1', match: 'Giulia Galli, U Chicago, 781 works' }]);
  assert.equal((await remote.radar.checkSource('2057-3960')).name, 'npj Computational Materials');
  const blocked = await remote.radar.checkSource('https://nature.example/ncomms.rss');
  assert.equal(blocked.kind, 'feed-blocked');
  assert.deepEqual(blocked.journals, []);

  const bare = createRemoteRuntime(loopbackTransport(await makeService()));
  await assert.rejects(bare.radar.profile(), /needs the library server/);
  await assert.rejects(bare.radar.checkSource('x'), /needs the library server/);
});

test('radar.feedback carries routine id, paper key and verdict over the wire, and the service refuses what is not a radar', async () => {
  const remote = createRemoteRuntime(loopbackTransport(await makeService({ library: { ...noopLibrary, async items() { return []; }, async radarScore() { return {}; } } })));
  await assert.rejects(remote.radar.feedback('missing', 'doi:10.1/x', 'added'), /No such routine/);
  const plain = await remote.routines.create({ name: 'Plain', prompt: 'sleep spindles', schedule: { kind: 'daily', time: '07:00' }, target: { kind: 'session' } });
  await assert.rejects(remote.radar.feedback(plain.id, 'doi:10.1/x', 'added'), /not a reading radar/);
  const radar = await remote.routines.create({ name: 'R', kind: 'radar', schedule: { kind: 'daily', time: '07:00' }, radar: { scope: { kind: 'library' }, profile: { topics: [{ text: 'sleep' }] }, sources: [{ kind: 'database', db: 'arxiv' }] } });
  await assert.rejects(remote.radar.feedback(radar.id, 'doi:10.1/never', 'dismissed'), /not one this radar has shown/);
  await assert.rejects(remote.radar.feedback(radar.id, 'doi:10.1/never', 'undo'), /not one this radar has shown/);
});
