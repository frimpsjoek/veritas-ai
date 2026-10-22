import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentd } from '../src/node/agentd.mjs';
import { createLocalRuntime } from '../src/core.js';
import { createSlots } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

function fakeProvider(events, { delayMs = 0 } = {}) {
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() { for (const ev of events) { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); yield ev; } },
    async dispose() {},
  };
}

function fakeGateway() {
  return {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; }, async save() { throw new Error('n/a'); }, async remove() {}, rows: () => [] },
    async dispose() {},
  };
}

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };

async function makeService(events, providerOpts) {
  const platform = { fs: memoryFs() };
  return createLocalRuntime({
    platform, library: noopLibrary, notes: {}, dataDir: 'data',
    providers: new Map([['fake', fakeProvider(events, providerOpts)]]),
    gateway: fakeGateway(),
    getRoleModel: async () => ({ provider: 'fake', model: null }),
    limits: { total: 6 },
  });
}

async function withServer(service, run) {
  const agentd = createAgentd(service, { secret: 's3cret', mcpHandler: async () => ({ status: 200, body: '{}' }) });
  const port = await agentd.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await agentd.close();
  }
}

test('GET /ping answers ok, for a caller (agent-host.js) checking the server is reachable at all', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const res = await fetch(`${base}/ping`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('the route table dispatches GET /conversations to conversations.list, with the shared secret required', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const unauth = await fetch(`${base}/conversations`);
    assert.equal(unauth.status, 401);

    const id = await service.conversations.create('chat');
    const res = await fetch(`${base}/conversations`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.some((c) => c.id === id));
  });
});

test('an unknown route is a 404, not a crash', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const res = await fetch(`${base}/nope`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(res.status, 404);
  });
});

test('/mcp bypasses the control-route secret (it has its own per-session token)', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
  });
});

test('POST /conversations/send then GET /events?after= resumes a live turn without missing events', async () => {
  // A real provider streams over time; the delay gives a reconnecting client an actual in-flight turn to observe,
  // the way a dropped connection mid-turn would in production (an instant fake would race the two requests).
  const service = await makeService([
    { type: 'text', delta: 'hi' },
    { type: 'final', text: 'hi there', json: null, usage: {} },
  ], { delayMs: 30 });
  await withServer(service, async (base) => {
    const id = await service.conversations.create('chat');
    const sendPromise = fetch(`${base}/conversations/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ id, text: 'hello' }),
    }).then((r) => r.json());

    // Give /conversations/send a moment to call log.begin() before the reconnecting client asks for events,
    // then confirm it still gets every event the turn produces, including the final "done".
    await new Promise((r) => setTimeout(r, 10));
    const eventsRes = await fetch(`${base}/events?id=${id}&after=0`, { headers: { authorization: 'Bearer s3cret' } });
    const events = await eventsRes.json();
    assert.ok(events.some((e) => e.type === 'done'), `expected a done event, got ${JSON.stringify(events)}`);

    const sent = await sendPromise;
    assert.ok(sent.some((e) => e.type === 'done'));
  });
});

test('GET /events answers at the first event, not after the 25 s window: a slow turn reaches the client step by step', async () => {
  // Regression (2026-09-29): /events used collectAsync, which only stopped when an event arrived after the deadline, so a
  // turn's activity and text reached Obsidian in ~25 s lumps. Events 350 ms apart must come back in separate polls.
  const service = await makeService([
    { type: 'activity', id: 'a1', phase: 'start', kind: 'library', label: 'Searching your papers for "x"' },
    { type: 'activity', id: 'a1', phase: 'end', kind: 'library', label: 'Searching your papers for "x"', ok: true },
    { type: 'text', delta: 'hi' },
    { type: 'final', text: 'hi there', json: null, usage: {} },
  ], { delayMs: 350 });
  await withServer(service, async (base) => {
    const id = await service.conversations.create('chat');
    const sendPromise = fetch(`${base}/conversations/send`, {
      method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' }, body: JSON.stringify({ id, text: 'hello' }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    let after = 0;
    const polls = [];
    const seen = [];
    while (!seen.some((e) => e.type === 'done' || e.type === 'failed')) {
      const batch = await (await fetch(`${base}/events?id=${id}&after=${after}`, { headers: { authorization: 'Bearer s3cret' } })).json();
      polls.push({ at: Date.now() - started, n: batch.length });
      for (const e of batch) { assert.ok(e.seq > after, 'no event is delivered twice'); after = e.seq; seen.push(e); }
      assert.ok(polls.length < 40, 'the loop terminates');
    }
    await sendPromise;
    assert.ok(polls[0].at < 900, `the first poll must return at the first event, not wait for the turn: ${JSON.stringify(polls)}`);
    assert.ok(polls.length >= 3, `events must arrive over several polls, got ${JSON.stringify(polls)}`);
    assert.deepEqual(seen.filter((e) => e.type === 'activity').map((e) => e.phase), ['start', 'end'], 'nothing lost, in order');
  });
});

test('GET /events with no turn in flight returns immediately (no 25s hang)', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const id = await service.conversations.create('chat');
    const start = Date.now();
    const res = await fetch(`${base}/events?id=${id}&after=0`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - start < 5000, 'an idle conversation must not block the long-poll timeout');
    assert.deepEqual(await res.json(), []);
  });
});

test('POST /conversations/adopt is idempotent over HTTP: adopting the same id twice writes it once', async () => {
  const service = await makeService([]);
  await withServer(service, async (base) => {
    const incoming = [
      JSON.stringify({ type: 'meta', id: 'zotero-1', mode: 'chat', title: 'From Zotero', created: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01.000Z' }),
    ].join('\n');
    const post = () => fetch(`${base}/conversations/adopt`, {
      method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ id: 'zotero-1', jsonl: incoming }] }),
    }).then((r) => r.json());

    assert.deepEqual(await post(), ['zotero-1']);
    assert.deepEqual(await post(), ['zotero-1']);

    const records = await service.conversations.load('zotero-1');
    assert.equal(records.filter((r) => r.type === 'meta').length, 1, 'adopting twice over HTTP must not duplicate the conversation');
  });
});

// ---------- reviews over real HTTP (T5.4: agentd's route table must give remote.js the same review lifecycle
// the local runtime has, per design/final/rationale.md's "keeping local and remote parity" instruction) ----------

function reviewProvider() {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      let json;
      if (/^Plan a literature review/.test(req.input)) {
        json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['library'] }] };
      } else if (/researching one sub-question/.test(req.input)) {
        json = { findings: [{ claim: 'a claim', sources: [{ citekey: 'k1', doi: null, url: null, title: 'Paper', year: 2022 }], quotes: ['q'], confidence: 'high' }], searchLog: [{ query: 'q', source: 'library', results: 1 }] };
      } else {
        json = { title: 'A review', scope: 'the whole library', method: 'Searched the library.', themes: [], evidence: [], disagreements: '', gaps: '' };
      }
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

async function makeReviewService() {
  const platform = { fs: memoryFs() };
  const published = [];
  return {
    published,
    service: await createLocalRuntime({
      platform, library: noopLibrary, notes: { async publish(n) { published.push(n); return { path: `ai_notes/Literature Reviews/${n.title}.md` }; } }, dataDir: 'data',
      providers: new Map([['fake', reviewProvider()]]),
      gateway: fakeGateway(),
      getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
      limits: { total: 6, perRole: { researcher: 3 } },
    }),
  };
}

test('POST /reviews starts a review; GET /reviews/events long-polls it to awaiting_approval, then approve resumes it to done', async () => {
  const { service, published } = await makeReviewService();
  await withServer(service, async (base) => {
    const startRes = await fetch(`${base}/reviews`, {
      method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Does X help Y?', scope: { kind: 'library' }, sources: ['library'], years: { from: null, to: null }, depth: 'quick' }),
    });
    const id = await startRes.json();
    assert.equal(typeof id, 'string');

    let seq = 0;
    let plan = null;
    for (let i = 0; i < 20 && !plan; i++) {
      const res = await fetch(`${base}/reviews/events?id=${id}&after=${seq}`, { headers: { authorization: 'Bearer s3cret' } });
      const batch = await res.json();
      for (const p of batch) { seq = p.seq; if (p.status.state === 'awaiting_approval') plan = p.status.plan; }
    }
    assert.ok(plan, 'never reached awaiting_approval');
    assert.equal(plan.subQuestions.length, 1);

    const approveRes = await fetch(`${base}/reviews/approve`, {
      method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ id, plan }),
    });
    assert.equal(approveRes.status, 200);

    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const res = await fetch(`${base}/reviews/events?id=${id}&after=${seq}`, { headers: { authorization: 'Bearer s3cret' } });
      const batch = await res.json();
      for (const p of batch) { seq = p.seq; if (p.status.state === 'done') done = true; }
    }
    assert.ok(done, 'never reached done');
    assert.equal(published.length, 1);

    const list = await (await fetch(`${base}/reviews`, { headers: { authorization: 'Bearer s3cret' } })).json();
    assert.equal(list.find((p) => p.id === id).status.state, 'done');
  });
});
