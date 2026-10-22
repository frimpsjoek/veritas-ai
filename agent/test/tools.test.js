import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolGateway, handleMcp, createMcpHttpHandler } from '../src/tools.js';

function fakeLibrary({ searchResults = [], relatedResults = [], readResult = null, resolveHits = new Map() } = {}) {
  const calls = { search: [], read: [], related: [] };
  return {
    calls,
    async search(q) { calls.search.push(q); return searchResults; },
    async read(ref, opts) { calls.read.push({ ref, opts }); return readResult; },
    async related(ref, opts) { calls.related.push({ ref, opts }); return relatedResults; },
    async resolve(refs) {
      const map = new Map();
      for (const ref of refs) map.set(ref.kind === 'note' ? `note:${ref.path}` : `paper:${ref.citekey}`, resolveHits.get(ref.citekey ?? ref.path) ?? null);
      return map;
    },
  };
}

const CTX = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: true, web: true }, audit: 'test' };

test('every built-in tool row declares annotations.readOnlyHint: true', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open(CTX);
  assert.ok(session.specs.length >= 3);
  // ToolSession.specs doesn't itself carry annotations (tools.d.ts); the MCP face stamps it. Verify via tools/list.
  const res = await handleMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), session);
  const body = JSON.parse(res.body);
  assert.ok(body.result.tools.length > 0);
  for (const tool of body.result.tools) assert.deepEqual(tool.annotations, { readOnlyHint: true });
});

test('search_library calls the library and reports what it saw for the citation validator', async () => {
  const ref = { kind: 'paper', citekey: 'smith2021' };
  const library = fakeLibrary({ searchResults: [{ ref, title: 'Smith 2021', snippet: 'about graphene', year: 2021 }] });
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open(CTX);
  const result = await session.call('search_library', { query: 'graphene' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Smith 2021/);
  assert.deepEqual(session.seen(), [ref]);
});

test('a scope-widening call is refused: the tool always uses ToolContext.scope, never an argument', async () => {
  const library = fakeLibrary();
  const gateway = await createToolGateway(fetch, library, {});
  const scoped = { ...CTX, scope: { kind: 'collections', keys: ['K1'] } };
  const session = gateway.open(scoped);
  await session.call('search_library', { query: 'x', scope: { kind: 'library' } }); // an attempt to widen it
  assert.deepEqual(library.calls.search[0].scope, { kind: 'collections', keys: ['K1'] });
});

test('a disabled source is not offered and refuses if called anyway', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open({ ...CTX, sources: { papers: false, notes: false, scholarly: false, web: false } });
  assert.deepEqual(session.specs, []);
  const result = await session.call('search_library', { query: 'x' });
  assert.equal(result.ok, false);
});

// ---------- spec 005: papers / notes source split (unit A2) ----------

const GATING = [
  { papers: true, notes: true, expectSearch: true, only: undefined },
  { papers: true, notes: false, expectSearch: true, only: 'papers' },
  { papers: false, notes: true, expectSearch: true, only: 'notes' },
  { papers: false, notes: false, expectSearch: false, only: undefined },
];

for (const row of GATING) {
  test(`search_library gating: papers=${row.papers} notes=${row.notes}`, async () => {
    const library = fakeLibrary();
    const gateway = await createToolGateway(fetch, library, {});
    const session = gateway.open({ ...CTX, sources: { papers: row.papers, notes: row.notes, scholarly: false, web: false } });
    const offered = session.specs.some((s) => s.name === 'search_library');
    assert.equal(offered, row.expectSearch);
    if (row.expectSearch) {
      await session.call('search_library', { query: 'x' });
      assert.equal(library.calls.search[0].only, row.only);
    }
  });
}

test('read_source refuses a paper ref when papers is off', async () => {
  const library = fakeLibrary({ readResult: { title: 'A paper', text: 'text' } });
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open({ ...CTX, sources: { papers: false, notes: true, scholarly: false, web: false } });
  const result = await session.call('read_source', { citekey: 'smith2021' });
  assert.equal(result.ok, true); // the row itself still runs (notes is on); it just refuses this ref
  assert.match(result.text, /turned off/);
  assert.equal(library.calls.read.length, 0);
});

test('read_source refuses a note ref when notes is off', async () => {
  const library = fakeLibrary({ readResult: { title: 'A note', text: 'text' } });
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open({ ...CTX, sources: { papers: true, notes: false, scholarly: false, web: false } });
  const result = await session.call('read_source', { note: 'foo.md' });
  assert.match(result.text, /turned off/);
  assert.equal(library.calls.read.length, 0);
});

test('related_sources drops a paper ref found while notes is off', async () => {
  const noteRef = { kind: 'note', path: 'foo.md' };
  const paperRef = { kind: 'paper', citekey: 'smith2021' };
  const library = fakeLibrary({ relatedResults: [
    { ref: noteRef, title: 'A note', snippet: 's' },
    { ref: paperRef, title: 'A paper', snippet: 's' },
  ] });
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open({ ...CTX, sources: { papers: false, notes: true, scholarly: false, web: false } });
  const result = await session.call('related_sources', { note: 'foo.md' });
  assert.match(result.text, /A note/);
  assert.doesNotMatch(result.text, /A paper/);
  assert.deepEqual(session.seen(), [noteRef]);
});

test('handleMcp: tools/call routes to the session and returns the tool text', async () => {
  const library = fakeLibrary({ searchResults: [] });
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open(CTX);
  const res = await handleMcp(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_library', arguments: { query: 'x' } } }), session);
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.result.isError, false);
  assert.match(body.result.content[0].text, /No matches/);
});

test('handleMcp: a notification (no id) gets 202 with an empty body, authenticated or not', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open(CTX);
  const authed = await handleMcp(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), session);
  const unauthed = await handleMcp(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(authed.status, 202);
  assert.equal(unauthed.status, 202);
});

test('createMcpHttpHandler: a wrong or missing bearer token gets a 401', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  gateway.open(CTX); // a real session exists, just not this token
  const handler = createMcpHttpHandler(gateway);
  const res = await handler({ headers: { authorization: 'Bearer not-the-real-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  const noAuth = await handler({ headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(noAuth.status, 401);
});

test('createMcpHttpHandler: the right bearer token lists every tool with readOnlyHint true (curl-equivalent check)', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open(CTX);
  const handler = createMcpHttpHandler(gateway);
  const res = await handler({ headers: { authorization: `Bearer ${session.mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.result.tools.length >= 3);
  assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint === true));
});

test('close() revokes the MCP token', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open(CTX);
  const handler = createMcpHttpHandler(gateway);
  session.close();
  const res = await handler({ headers: { authorization: `Bearer ${session.mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
});

// ---------- spec 007 E1: read_result ----------

function fakeSession(resultBody) {
  return {
    id: 'sess1',
    results: [{ ref: resultBody.ref, kind: resultBody.kind, title: resultBody.title, versions: resultBody.ref.version, rows: resultBody.rows?.length ?? null, columns: [], updated: 't' }],
    async read(ref) { return ref.id === resultBody.ref.id ? resultBody : null; },
  };
}

const PAPERS_RESULT = {
  ref: { id: 'R1', version: 1 }, title: 'Widgets', created: 't', madeBy: 'S1', from: [], change: '', kind: 'papers', query: 'widgets',
  rows: [{ id: 'p:doe2021', ref: { kind: 'paper', citekey: 'doe2021' }, inLibrary: true, title: 'A study of widgets', authors: [], year: 2021, venue: '', doi: null, url: null, abstract: 'x', citations: null, fullText: true, pdfUrl: null, studyType: null, foundBy: [] }],
  columns: [], cells: {}, screening: null, summary: null,
};

test('read_result is disabled without a session, and enabled with one', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const noSession = gateway.open(CTX);
  assert.ok(!noSession.specs.some((s) => s.name === 'read_result'));

  const withSession = gateway.open({ ...CTX, session: fakeSession(PAPERS_RESULT) });
  assert.ok(withSession.specs.some((s) => s.name === 'read_result'));
});

test('read_result renders the result and reports every row ref as seen (for the citation validator)', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open({ ...CTX, session: fakeSession(PAPERS_RESULT) });
  const result = await session.call('read_result', { result: 'R1' });
  assert.equal(result.ok, true);
  assert.match(result.text, /A study of widgets/);
  assert.deepEqual(session.seen(), [{ kind: 'paper', citekey: 'doe2021' }]);
});

test('read_result on an unknown result id says so plainly instead of throwing', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const session = gateway.open({ ...CTX, session: fakeSession(PAPERS_RESULT) });
  const result = await session.call('read_result', { result: 'R9' });
  assert.equal(result.ok, true); // the row itself never throws; it reports "no result" as text
  assert.match(result.text, /No result R9/);
});

test('read_result under a chat_papers scope (session.on set) refuses a different result id', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const scoped = { id: 'sess1', results: [], on: { result: { id: 'R1', version: 1 }, rows: 'all' }, async read(ref) { return ref.id === 'R1' ? PAPERS_RESULT : null; } };
  const session = gateway.open({ ...CTX, session: scoped });
  const result = await session.call('read_result', { result: 'R2' });
  assert.match(result.text, /only reads R1/);
});

// ---- live activity feed: end-event meta and friendly start labels ----

test('tool results carry activity meta: counts for searches, the title for reads', async () => {
  const ref = { kind: 'paper', citekey: 'smith2021' };
  const library = fakeLibrary({
    searchResults: [{ ref, title: 'Smith 2021', snippet: 's', year: 2021 }, { ref: { kind: 'paper', citekey: 'b' }, title: 'B', snippet: 's', year: null }],
    readResult: { title: 'A very long title '.repeat(10), text: 'body' },
  });
  const session = (await createToolGateway(fetch, library, {})).open(CTX);
  const s = await session.call('search_library', { query: 'graphene' });
  assert.equal(s.meta.count, 2);
  assert.equal(s.meta.detail, '2 results');
  assert.deepEqual(session.takeMeta('mcp__lib__search_library', { query: 'graphene' }), s.meta);
  assert.equal(session.takeMeta('search_library', { query: 'graphene' }), null, 'meta is handed out once');
  const r = await session.call('read_source', { citekey: 'smith2021' });
  assert.equal(r.meta.source.kind, 'paper');
  assert.ok(r.meta.source.title.length <= 80);
});

test('describe(): a read_source start is named by title (cached from search, or resolved), else "a source"', async () => {
  const ref = { kind: 'paper', citekey: 'smith2021' };
  const library = fakeLibrary({ searchResults: [{ ref, title: 'Smith 2021', snippet: 's', year: 2021 }], resolveHits: new Map([['other', { title: 'Other paper' }]]) });
  const session = (await createToolGateway(fetch, library, {})).open(CTX);
  await session.call('search_library', { query: 'x' });
  assert.equal(await session.describe('read_source', { citekey: 'smith2021' }), 'Reading “Smith 2021”');
  assert.equal(await session.describe('read_source', { citekey: 'other' }), 'Reading “Other paper”');
  assert.equal(await session.describe('read_source', { citekey: 'nope' }), 'Reading a source');
  assert.equal(await session.describe('search_library', { query: 'x' }), null);
});

test('search_library: a library that times out is a tool error (and a failed activity), not "No matches"', async () => {
  const library = { ...fakeLibrary(), async search() { throw Object.assign(new Error('/search did not answer within 90 seconds'), { status: 504 }); } };
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open(CTX);
  const events = [];
  session.onActivity((ev) => events.push(ev));
  const result = await session.call('search_library', { query: 'graphene' });
  assert.equal(result.ok, false);
  assert.match(result.text, /library search failed/);
  assert.match(result.text, /did not answer within 90 seconds/);
  assert.doesNotMatch(result.text, /^No matches/);
  const end = events.find((e) => e.phase === 'end');
  assert.equal(end.ok, false);
  assert.equal(end.count, undefined);
});

test('search_library passes the model\'s years, and a routine\'s since date as the lower bound', async () => {
  const library = fakeLibrary();
  const gateway = await createToolGateway(fetch, library, {});
  await gateway.open(CTX).call('search_library', { query: 'x', years: { from: 2019, to: 2021 } });
  assert.deepEqual(library.calls.search[0].years, { from: 2019, to: 2021 });
  await gateway.open(CTX).call('search_library', { query: 'x' });
  assert.equal(library.calls.search[1].years, undefined);
  // since wins over an earlier model year, never widens
  await gateway.open({ ...CTX, since: '2024-03-01' }).call('search_library', { query: 'x', years: { from: 2010, to: null } });
  assert.deepEqual(library.calls.search[2].years, { from: 2024, to: null });
  await gateway.open({ ...CTX, since: '2024-03-01' }).call('search_library', { query: 'x', years: { from: 2026, to: 2027 } });
  assert.deepEqual(library.calls.search[3].years, { from: 2026, to: 2027 });
  await gateway.open({ ...CTX, since: '2024-03-01' }).call('search_library', { query: 'x' });
  assert.deepEqual(library.calls.search[4].years, { from: 2024, to: null });
});

test('searchTally counts search calls and failures; a scholarly search with every source down is an error, not "No results"', async () => {
  const library = { ...fakeLibrary(), async search() { throw new Error('down'); } };
  const down = async () => { throw new Error('offline'); };
  const gateway = await createToolGateway(down, library, { scholarly: ['openalex', 'arxiv'] });
  const tally = { calls: 0, failed: 0 };
  const session = gateway.open({ ...CTX, searchTally: tally });
  const a = await session.call('search_library', { query: 'x' });
  const b = await session.call('search_scholarly', { query: 'graphene conductivity' });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.match(b.text, /None of the literature sources answered/);
  assert.equal(tally.calls, 2);
  assert.equal(tally.failed, 2);
  assert.match(tally.firstError, /library search failed/);
});

test('a conversation keeps one MCP token across turns, so a pooled Codex thread can still call tools', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const first = gateway.open(CTX, { key: 'chat-1' });
  first.close(); // turn 1 ends
  const second = gateway.open({ ...CTX, audit: 'turn 2' }, { key: 'chat-1' });
  assert.equal(second.mcp.token, first.mcp.token);
  assert.equal(gateway._sessionForToken(first.mcp.token), second); // the old token now reaches turn 2's tools
  const res = await handleMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), gateway._sessionForToken(first.mcp.token));
  assert.equal(res.status, 200);
});

test('other conversations, and a second live turn of the same one, get their own tokens', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  const a = gateway.open(CTX, { key: 'chat-a' });
  const b = gateway.open(CTX, { key: 'chat-b' });
  assert.notEqual(a.mcp.token, b.mcp.token);
  const overlapping = gateway.open(CTX, { key: 'chat-a' }); // chat-a's turn is still open
  assert.notEqual(overlapping.mcp.token, a.mcp.token);
  assert.equal(gateway._sessionForToken(a.mcp.token), a);
  const unkeyed = gateway.open(CTX);
  assert.notEqual(unkeyed.mcp.token, a.mcp.token);
});

test('read_digest reads the newest radar digest even with Papers and Notes off', async () => {
  const library = {
    ...fakeLibrary({ readResult: { title: '2026-10-22 Seed radar', text: '15 new papers: flat bands, GW, MOFs' } }),
    async digests() {
      return [
        { path: 'Second Brain/Digests/2026-10-22 Seed radar.md', title: '2026-10-22 Seed radar', modified: '2026-10-22 09:44' },
        { path: 'Second Brain/Digests/2026-10-21 Seed radar.md', title: '2026-10-21 Seed radar', modified: '2026-10-21 08:31' },
      ];
    },
  };
  const gateway = await createToolGateway(fetch, library, {});
  const session = gateway.open({ ...CTX, sources: { papers: false, notes: false, scholarly: true, web: true } });
  assert.ok(session.specs.some((s) => s.name === 'read_digest'));
  const latest = await session.call('read_digest', {});
  assert.equal(latest.ok, true);
  assert.match(latest.text, /flat bands/);
  assert.deepEqual(library.calls.read[0].ref, { kind: 'note', path: 'Second Brain/Digests/2026-10-22 Seed radar.md' });
  const missing = await session.call('read_digest', { date: '2026-10-01' });
  assert.match(missing.text, /No digest for 2026-10-01.*2026-10-22 Seed radar/);
});

test('read_digest is not offered by a library that cannot list digests', async () => {
  const gateway = await createToolGateway(fetch, fakeLibrary(), {});
  assert.ok(!gateway.open(CTX).specs.some((s) => s.name === 'read_digest'));
});
