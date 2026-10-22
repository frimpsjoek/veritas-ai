// Spec 011 U4 part 2: the routines service inside the runtime (scheduler, watch and digest runs, the 50% rule, the
// usage memo) and its wire (agentd routes, remote.js). Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { createToolGateway } from '../src/tools.js';
import { memoryFs } from './support/memory-fs.mjs';
import { feedXml, res, routedFetch, radarLibrary, openAlexGraph } from './support/radar-fakes.mjs';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();

const cand = (n, over = {}) => ({ citekey: null, doi: `10.9999/inv.${n}`, url: null, title: `Invented study ${n} of sleep spindles`, year: 2026, abstract: `Spindles rose in study ${n}.`, authors: ['Doe, J.'], venue: 'J. Invented', ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A provider that answers a watch run's candidate turn from `state.found`, and a pipeline-2 report from fixed answers. */
function provider(state) {
  return {
    id: 'fake', caps: {},
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn(req, signal) {
      state.inputs.push(req.input);
      if (state.notice) yield { type: 'notice', kind: 'rate_limit', text: 'Fake: 63% of the 5h window used', usage: { percentUsed: 63, windowMinutes: 300 } };
      if (state.fail) { yield { type: 'failed', error: { kind: 'provider_crashed', message: 'the model fell over' } }; return; }
      if (state.gate) await new Promise((resolve) => { state.release = resolve; signal?.addEventListener('abort', resolve, { once: true }); });
      let json;
      if (/^Plan a literature review/.test(req.input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] };
      else if (/finding papers for one sub-question/.test(req.input)) json = { candidates: state.found, searchLog: [{ query: 'q', source: 'scholarly', results: state.found.length }] };
      else if (/^You extract data/.test(req.input)) {
        const ids = [...req.input.matchAll(/### Paper (\S+)/g)].map((m) => m[1]);
        json = { rows: ids.map((row) => ({ row, cells: [{ column: 'main_findings', status: 'found', value: 'helped', quotes: ['Spindles rose'] }] })) };
      } else if (/^You help a researcher decide which new papers to read/.test(req.input)) {
        state.whyPrompts = [...(state.whyPrompts ?? []), req.input];
        const n = [...req.input.matchAll(/### Paper (\d+)/g)].length;
        json = state.why ? state.why(n, req.input) : { lines: Array.from({ length: n }, (_, i) => ({ n: i + 1, line: `Why paper ${i + 1} matters.` })) };
      } else json = { title: 'A digest', scope: 's', method: 'm', themes: [], evidence: [], disagreements: '', gaps: '' };
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

function setup(over = {}) {
  const fs = over.fs ?? memoryFs();
  const state = { inputs: [], found: [cand(1), cand(2), cand(3)], contexts: [], ...over.state };
  const clock = over.clock ?? { t: local(2026, 5, 4, 8, 0) };
  const gateway = {
    open(ctx) { state.contexts.push(ctx); return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; } }, async dispose() {},
  };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const skills = { async list() { return []; }, async get() { return null; }, async put() {}, async remove() {} };
  const make = () => createLocalRuntime({
    platform: { fs, fetch: over.fetch ?? (async () => ({ ok: false, status: 500, json: async () => ({}) })) }, library: over.library ?? library, notes: { async publish(n) { return { path: `${n.title}.md` }; } }, skills, dataDir: '/data',
    providers: new Map([['fake', provider(state)]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
    clock: () => clock.t, routines: { tickMs: 15, startupGraceMs: 0, ...over.routines },
  });
  return { fs, state, clock, make };
}

/** A paper set with two rows already in it, inside a fresh session. */
async function seedSession(ai) {
  const id = await ai.conversations.create('chat');
  await ai.sessions.put(id, { kind: 'find', query: 'sleep', sources: {}, scope: { kind: 'library' } }, {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'Sleep spindles', created: '', madeBy: '', from: [], change: 'Found papers', query: 'sleep',
    rows: [1, 2].map((n) => ({ id: `doi:10.9999/inv.${n}`, ref: { kind: 'web', url: `https://doi.org/10.9999/inv.${n}` }, inLibrary: false, title: `Invented study ${n} of sleep spindles`, authors: [], year: 2026, venue: '', doi: `10.9999/inv.${n}`, url: null, abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] })),
    columns: [], cells: {}, screening: null, summary: null,
  });
  const view = await ai.sessions.view(id);
  return { id, ref: view.results[0].ref };
}

const watchDraft = (session, ref, over = {}) => ({ name: 'Spindle watch', prompt: 'new sleep spindle papers', schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'artifact', session, result: { id: ref.id } }, ...over });

test('a due watch routine adds only unseen papers as a new version, once, across two runtime lifetimes', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const routine = await ai.routines.create(watchDraft(id, ref));
  await until(async () => (await ai.routines.list())[0].lastRun, 'the first run');
  const [view] = await ai.routines.list();
  assert.equal(view.lastRun.status, 'done');
  assert.equal(view.lastRun.added, 1, 'studies 1 and 2 were already in the set');
  assert.equal(view.lastRun.summary, 'Routine: 1 new paper (2 already here)');
  assert.equal(view.lastDone, view.lastRun.at);
  assert.equal(view.running, false);
  assert.equal(new Date(view.nextRun).getTime() > t.clock.t, true);

  const v2 = await ai.sessions.read(id, { id: ref.id, version: 2 });
  assert.equal(v2.rows.length, 3);
  assert.deepEqual(v2.addedRows, [v2.rows[2].id]);
  assert.equal(v2.change, 'Routine: 1 new paper (2 already here)');
  assert.deepEqual(v2.from, [{ id: ref.id, version: 1 }]);
  const steps = (await ai.sessions.view(id)).steps;
  assert.equal(steps.at(-1).input.kind, 'routine');
  assert.equal(steps.at(-1).input.routine, routine.id);
  assert.equal(steps.at(-1).status, 'done');
  // the researcher's search tools were asked for papers since a day before creation, whatever the model does
  assert.equal(t.state.contexts.at(-1).since, '2026-05-03');
  assert.match(t.state.inputs[0], /Only papers published on or after 2026-05-03/);

  await ai.dispose();
  const turns = t.state.inputs.length;
  const again = await t.make(); // same files, a new process, the slot is already used
  await sleep(120);
  assert.equal(t.state.inputs.length, turns, 'the slot is not run a second time');
  await again.dispose();
});

test('a watch routine keeps fewer candidates at each lighter depth, fastest included', async () => {
  const asked = {};
  for (const depth of ['fastest', 'quick', 'standard', 'deep']) {
    const t = setup();
    const ai = await t.make();
    const { id, ref } = await seedSession(ai);
    await ai.routines.create(watchDraft(id, ref, { depth, schedule: { kind: 'daily', time: '07:30' } }));
    await until(async () => (await ai.routines.list())[0].lastRun, `the ${depth} run`);
    asked[depth] = Number(/at most (\d+)\./.exec(t.state.inputs[0])?.[1]);
    await ai.dispose();
  }
  assert.deepEqual(asked, { fastest: 12, quick: 15, standard: 30, deep: 60 });
});

test('Run now with nothing new writes no new version, and a failed run does not move lastDone', async () => {
  const t = setup({ state: { found: [cand(1), cand(2)] } });
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' } })); // not due yet
  assert.deepEqual(await ai.routines.runNow(r.id), { started: true });
  const done = await until(async () => (await ai.routines.list())[0].lastRun, 'the manual run');
  assert.equal(done.added, 0);
  assert.equal(done.summary, 'Routine: no new papers (2 already here)');
  assert.equal((await ai.sessions.view(id)).results[0].versions, 1, 'no V2');
  const firstDone = (await ai.routines.list())[0].lastDone;
  assert.ok(firstDone);

  t.state.fail = true;
  t.clock.t += 60_000;
  const before = (await ai.routines.list())[0].lastRun.at;
  await ai.routines.runNow(r.id);
  await until(async () => (await ai.routines.list())[0].lastRun.at !== before, 'the second run');
  const [view] = await ai.routines.list();
  assert.equal(view.lastRun.status, 'failed');
  assert.match(view.lastRun.reason, /the model fell over/);
  assert.equal(view.lastDone, firstDone, 'only a finished run moves the since window');
  await ai.dispose();
});

test('a routine owned elsewhere never runs here; becoming the owner runs it', async () => {
  let owner = false;
  const t = setup({ routines: { isOwner: () => owner } });
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  await ai.routines.create(watchDraft(id, ref));
  await sleep(100);
  assert.equal(t.state.inputs.length, 0);
  assert.equal((await ai.routines.list())[0].lastRun, null);
  owner = true;
  await until(async () => (await ai.routines.list())[0].lastRun, 'the run once owner');
  await ai.dispose();
});

test('runNow while another run is going is refused; update, pause, resume, archive and adopt', async () => {
  const t = setup({ state: { gate: true } });
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const a = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' }, name: 'A' }));
  const b = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' }, name: 'B' }));
  assert.deepEqual(await ai.routines.runNow(a.id), { started: true });
  await until(() => t.state.release, 'the run to reach the model');
  assert.equal((await ai.routines.list()).find((r) => r.id === a.id).running, true);
  assert.deepEqual(await ai.routines.runNow(b.id), { started: false, reason: 'Another routine is running.' });
  assert.deepEqual(await ai.routines.runNow('nope'), { started: false, reason: 'Another routine is running.' });
  t.state.gate = false;
  t.state.release();
  await until(async () => !(await ai.routines.list()).some((r) => r.running), 'the run to end');
  assert.deepEqual(await ai.routines.runNow('nope'), { started: false, reason: 'No such routine.' });

  // edits: a new schedule sets lastSlot to now (an old slot never fires); other edits do not
  const before = await ai.routines.update(b.id, { name: 'B2' });
  assert.equal(before.name, 'B2');
  assert.equal(before.lastSlot, b.lastSlot, 'a rename leaves the slot alone');
  const moved = await ai.routines.update(b.id, { schedule: { kind: 'weekly', weekday: 1, time: '07:30' } });
  assert.equal(moved.lastSlot, new Date(t.clock.t).toISOString());
  await assert.rejects(() => ai.routines.update(b.id, { prompt: '  ' }), /what the routine should look for/);
  await assert.rejects(() => ai.routines.update('nope', {}), /No such routine/);

  assert.equal((await ai.routines.pause(b.id)).status, 'paused');
  assert.equal((await ai.routines.list()).find((r) => r.id === b.id).nextRun, null);
  assert.equal((await ai.routines.archive(b.id)).status, 'archived');
  assert.equal((await ai.routines.resume(b.id)).status, 'active');
  assert.equal(typeof (await ai.routines.list()).find((r) => r.id === b.id).nextRun, 'string');

  const copy = { ...(await ai.routines.list()).find((r) => r.id === a.id), id: 'zotero1', name: 'From Zotero' };
  delete copy.nextRun; delete copy.running;
  assert.deepEqual(await ai.routines.adopt([copy]), ['zotero1']);
  assert.deepEqual(await ai.routines.adopt([copy]), ['zotero1']);
  assert.equal((await ai.routines.list()).filter((r) => r.id === 'zotero1').length, 1);
  await ai.dispose();
});

test('the 50% rule: a window remembered at 63% skips a scheduled run and says why; Run now ignores it', async () => {
  const t = setup({ state: { notice: true } });
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const first = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' }, name: 'first' }));
  await ai.routines.runNow(first.id); // a turn that reports 63% used
  await until(async () => (await ai.routines.list())[0].lastRun, 'the first run');
  const [status] = await ai.providers.status();
  assert.equal(status.usage.kind, 'rate_limit');
  assert.equal(status.usage.percentUsed, 63);
  assert.equal(status.usage.windowMinutes, 300);
  assert.equal(status.usage.at, new Date(t.clock.t).toISOString());

  const turns = t.state.inputs.length;
  const due = await ai.routines.create(watchDraft(id, ref, { name: 'due', schedule: { kind: 'daily', time: '07:30' } }));
  const skipped = await until(async () => (await ai.routines.list()).find((r) => r.id === due.id).lastRun, 'the skip');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.reason, /63% used at 08:00/);
  assert.equal(t.state.inputs.length, turns, 'no model turn');
  assert.equal((await ai.routines.list()).find((r) => r.id === due.id).lastSlot, new Date(local(2026, 5, 4, 7, 30)).toISOString(), 'the slot is consumed');

  assert.deepEqual(await ai.routines.runNow(due.id), { started: true });
  await until(() => t.state.inputs.length > turns, 'the manual run');

  // five hours later the reading says nothing about now
  t.clock.t += 6 * 3_600_000;
  assert.equal((await ai.providers.status())[0].usage, null);
  await ai.dispose();
});

test('a routine that names a missing skill runs without it and says so', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watchDraft(id, ref, { skills: ['No Such Skill'] }));
  const run = await until(async () => (await ai.routines.list()).find((x) => x.id === r.id).lastRun, 'the run');
  assert.equal(run.status, 'done');
  assert.match(run.reason, /Ran without the skill “No Such Skill”/);
  await ai.dispose();
});

test('a watch routine whose paper set is gone fails with a plain reason', async () => {
  const t = setup();
  const ai = await t.make();
  const r = await ai.routines.create(watchDraft('nosuchsession', { id: 'R1' }));
  const run = await until(async () => (await ai.routines.list()).find((x) => x.id === r.id).lastRun, 'the run');
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /not there any more/);
  await ai.dispose();
});

test('a digest routine starts a new session and a pipeline-2 report there, approved automatically', async () => {
  const t = setup({ state: { notice: true } });
  const ai = await t.make();
  const r = await ai.routines.create({ name: 'Daily digest', prompt: 'sleep spindles and memory', depth: 'quick', schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'session' } });
  const run = await until(async () => (await ai.routines.list()).find((x) => x.id === r.id).lastRun, 'the digest', 8000);
  assert.equal(run.status, 'done', run.reason);
  assert.ok(run.session && run.review);
  assert.equal(run.summary, 'A digest');
  const list = await ai.conversations.list();
  const made = list.find((c) => c.id === run.session);
  assert.equal(made.routine, r.id);
  assert.equal(made.title, 'Daily digest');
  const progress = (await ai.reviews.list()).find((p) => p.id === run.review);
  assert.equal(progress.status.state, 'done');
  assert.equal(progress.usage, 'Fake: 63% of the 5h window used', 'the report can show one quiet usage line');
  const request = JSON.parse(await t.fs.read(`/data/reviews/${run.review}/request.json`));
  assert.equal(request.pipeline, 2);
  assert.equal(request.autoApprove, true);
  assert.equal(request.session, run.session);
  await ai.dispose();
});

test('a routine made after its time yesterday does not fire for yesterday; one made after its time today runs once now', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const late = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' }, name: 'late' }));
  assert.equal(late.lastSlot, new Date(local(2026, 5, 3, 23, 59)).toISOString());
  await sleep(80);
  assert.equal(t.state.inputs.length, 0);
  const early = await ai.routines.create(watchDraft(id, ref, { name: 'early' }));
  assert.equal(early.lastSlot, null);
  await until(async () => (await ai.routines.list()).find((r) => r.id === early.id).lastRun, 'the catch-up run');
  assert.equal(t.state.inputs.length, 1);
  await ai.dispose();
});

test('dispose stops the scheduler: a routine that becomes due afterwards never runs', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' } }));
  await ai.dispose();
  t.clock.t = local(2026, 5, 5, 8, 0); // the 23:59 slot of the 4th has passed
  await sleep(80);
  assert.equal(t.state.inputs.length, 0);
  assert.equal(JSON.parse(await t.fs.read(`/data/routines/${r.id}.json`)).lastRun, null);
});

test('the review progress usage line is read back from the review folder after a restart', async () => {
  const t = setup({ state: { notice: true } });
  const ai = await t.make();
  const id = await ai.reviews.start({ question: 'sleep spindles', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick', pipeline: 2, autoApprove: true });
  await until(async () => (await ai.reviews.list()).find((p) => p.id === id)?.status.state === 'done', 'the report', 8000);
  await ai.dispose();
  const again = await t.make();
  assert.equal((await again.reviews.list()).find((p) => p.id === id).usage, 'Fake: 63% of the 5h window used');
  await again.dispose();
});

test('the agentd route table and remote.js carry every routines call, as JSON, to the same service', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const table = routes();
  const transport = {
    async request(method, path, body) {
      const url = new URL(`http://x${path}`);
      const row = table.find((r) => r.method === method && r.path === url.pathname);
      assert.ok(row, `${method} ${url.pathname} has a route`);
      const out = await row.call(ai, { ...Object.fromEntries(url.searchParams), ...(body ?? {}) }, { signal: new AbortController().signal });
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    },
    async *stream() {},
  };
  const remote = createRemoteRuntime(transport);
  const made = await remote.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' } }));
  assert.equal(made.status, 'active');
  assert.equal((await remote.routines.list())[0].id, made.id);
  assert.equal(typeof (await remote.routines.list())[0].nextRun, 'string');
  assert.equal((await remote.routines.update(made.id, { name: 'Renamed' })).name, 'Renamed');
  assert.equal((await remote.routines.pause(made.id)).status, 'paused');
  assert.equal((await remote.routines.resume(made.id)).status, 'active');
  assert.deepEqual(await remote.routines.runNow(made.id), { started: true });
  await until(async () => (await remote.routines.list())[0].lastRun, 'the run');
  assert.equal((await remote.routines.archive(made.id)).status, 'archived');
  assert.deepEqual(await remote.routines.adopt([made]), [made.id]);
  await ai.dispose();
});

test('the latest usage reading reaches the UI through GET /providers and remote.js, and goes quiet once its window has passed', async () => {
  const t = setup({ state: { notice: true } });
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const table = routes();
  const remote = createRemoteRuntime({
    async request(method, path, body) {
      const url = new URL(`http://x${path}`);
      const row = table.find((r) => r.method === method && r.path === url.pathname);
      assert.ok(row, `${method} ${url.pathname} has a route`);
      return JSON.parse(JSON.stringify(await row.call(ai, { ...Object.fromEntries(url.searchParams), ...(body ?? {}) }, { signal: new AbortController().signal })));
    },
    async *stream() {},
  });
  assert.equal((await remote.providers.status())[0].usage, null, 'nothing is known before a turn reports');
  const made = await ai.routines.create(watchDraft(id, ref, { schedule: { kind: 'daily', time: '23:59' } }));
  await ai.routines.runNow(made.id);
  await until(async () => (await ai.routines.list())[0].lastRun, 'the run');
  const read = (await remote.providers.status())[0].usage;
  assert.deepEqual({ kind: read.kind, percentUsed: read.percentUsed, windowMinutes: read.windowMinutes, at: read.at }, { kind: 'rate_limit', percentUsed: 63, windowMinutes: 300, at: new Date(t.clock.t).toISOString() });
  t.clock.t += 301 * 60_000;
  assert.equal((await remote.providers.status())[0].usage, null, 'a reading older than its window says nothing about now');
  await ai.dispose();
});

test('search_scholarly applies ToolContext.since whatever the model asks for', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' }; };
  const gateway = await createToolGateway(fetchFn, { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } }, { scholarly: ['openalex'] });
  const session = gateway.open({ scope: { kind: 'library' }, web: 'off', sources: { papers: false, notes: false, scholarly: true, web: false }, audit: 't', since: '2026-05-03' });
  await session.call('search_scholarly', { query: 'spindles', since: '1900-01-01' });
  assert.match(urls[0], /from_publication_date:2026-05-03/);
  const plain = gateway.open({ scope: { kind: 'library' }, web: 'off', sources: { papers: false, notes: false, scholarly: true, web: false }, audit: 't' });
  await plain.call('search_scholarly', { query: 'spindles' });
  assert.doesNotMatch(urls[1], /from_publication_date/);
});

test('routines.list() also returns a broken routine file as a { broken, file, name, problem } item, while the scheduler keeps skipping it', async () => {
  const { fs, make } = setup();
  const ai = await make();
  const ok = await ai.routines.create({ name: 'Fine', prompt: 'p', schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'session' } });
  fs.files.set('/data/routines/torn.json', '{ not json');
  const list = await ai.routines.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.id === ok.id).problem, undefined);
  const broken = list.find((r) => r.broken);
  assert.equal(broken.file, 'torn.json');
  assert.equal(broken.name, 'torn.json');
  assert.match(broken.problem, /not valid JSON/);
  await ai.dispose?.();
});

// ---- spec 012 R1: kind "radar" ----

const RADAR_FEED = 'https://j.example/feed';
const radarDraft = (over = {}) => ({
  name: 'Sleep radar', kind: 'radar', schedule: { kind: 'daily', time: '23:59' }, // not due: only Run now fires it
  radar: { scope: { kind: 'library' }, profile: { topics: [{ text: 'sleep spindle' }] }, sources: [{ kind: 'feed', url: RADAR_FEED, title: 'J' }, { kind: 'feed', url: 'https://broken.example/feed' }], size: { fresh: 5, older: 0 } },
  ...over,
});
const radarFeed = () => routedFetch({ [RADAR_FEED]: res(200, feedXml([1, 2, 3].map((n) => ({ title: `Spindle study number ${n} of sleep`, link: `https://j.example/a/${n}`, doi: `10.9999/inv.${n}` })))) });
const known = [{ key: 'K1', doi: '10.9999/inv.1', title: 'Spindle study number 1 of sleep', citekey: 'doe2026', year: 2026 }];

test('a radar routine writes one "New" papers result in a new session, with a news badge, and never repeats a row', async () => {
  const library = radarLibrary({ known });
  const t = setup({ library, fetch: radarFeed() });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  assert.equal(r.kind, 'radar');
  assert.equal(r.prompt, 'Reading radar');
  assert.equal(r.radar.sources[0].id, 'feed:https://j.example/feed');
  assert.equal(r.target.kind, 'session');
  assert.deepEqual(await ai.routines.runNow(r.id), { started: true });
  const run = await until(async () => (await ai.routines.list())[0].lastRun, 'the radar run');
  assert.equal(run.status, 'done');
  assert.equal(run.added, 2, 'study 1 is in the library');
  assert.match(run.summary, /Radar: 2 new papers from 1 source \(feed:https:\/\/broken\.example\/feed failed: HTTP 404\)/);
  assert.equal(t.state.inputs.length, 0, 'no model call');

  const summary = (await ai.conversations.list()).find((c) => c.id === run.session);
  assert.equal(summary.news.papers, 2);
  const view = await ai.sessions.view(run.session);
  assert.equal(view.results.length, 1);
  assert.equal(view.results[0].title, 'New');
  const body = await ai.sessions.read(run.session, view.results[0].ref);
  assert.deepEqual(body.rows.map((x) => x.doi).sort(), ['10.9999/inv.2', '10.9999/inv.3']);
  assert.ok(body.rows.every((x) => typeof x.radar.score === 'number' && 'similarity' in x.radar.why));
  assert.deepEqual(body.addedRows, body.rows.map((x) => x.id));

  t.clock.t += 60_000;
  await ai.routines.runNow(r.id);
  await until(async () => (await ai.routines.list())[0].lastRun.at !== run.at, 'the second run');
  const [second] = await ai.routines.list();
  assert.equal(second.lastRun.status, 'done');
  assert.equal(second.lastRun.added, 0);
  assert.equal(second.lastRun.session, undefined, 'a quiet day writes no session');
  assert.equal((await ai.conversations.list()).length, 1);
  const state = JSON.parse(t.fs.files.get(`/data/radar/${r.id}/state.json`));
  assert.ok(state.seen['doi:10.9999/inv.2'], 'the shown paper is remembered');
  assert.match(state.sourceStatus['feed:https://broken.example/feed'].error, /404/);
  assert.deepEqual((await ai.routines.list())[0].radarStatus, state.sourceStatus, 'the list carries each source\'s last answer for the setup sheet');
  await ai.dispose();
});

test('a radar with older papers writes "Worth reading" as its own result; the badge counts New only; a quiet day writes nothing', async () => {
  const libWorks = [1, 2, 3].map((n) => ({ id: `W${n}`, doi: `10.1/l${n}`, title: `Invented library paper ${n} on sleep`, year: 2020 + n, refs: n < 3 ? ['X', 'P'] : ['X'] }));
  const graph = [...libWorks, { id: 'X', doi: '10.1/x', title: 'Thalamic spindle generation revisited', year: 1995, cited: 812, refs: [] }, { id: 'P', doi: '10.1/p', title: 'Cortical up states', year: 1993, refs: [] }];
  const oa = openAlexGraph(graph);
  const feed = radarFeed();
  const fetch = async (url, init) => (new URL(String(url)).host === 'api.openalex.org' ? oa(url, init) : feed(url, init));
  const items = libWorks.map((w, i) => ({ key: `L${i}`, doi: w.doi, title: w.title, citekey: null, year: w.year }));
  const t = setup({ library: radarLibrary({ known: [...known, ...items] }), fetch });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft({ radar: { ...radarDraft().radar, size: { fresh: 5, older: 1 } } }));
  await ai.routines.runNow(r.id);
  const run = await until(async () => (await ai.routines.list())[0].lastRun, 'the radar run');
  assert.equal(run.status, 'done');
  assert.equal(run.added, 2, 'the badge counts New rows only');
  const view = await ai.sessions.view(run.session);
  assert.deepEqual(view.results.map((x) => x.title), ['New', 'Worth reading']);
  assert.equal(run.writes.length, 2);
  const body = await ai.sessions.read(run.session, view.results[1].ref);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].doi, '10.1/x');
  assert.equal(body.rows[0].citations, 812);
  assert.equal(body.rows[0].radar.why.citedBy.count, 3);
  assert.match(body.rows[0].radar.reason, /^Cited by 3 papers in your library, including /);
  const summary = (await ai.conversations.list()).find((c) => c.id === run.session);
  assert.equal(summary.news.papers, 2);

  const state = JSON.parse(t.fs.files.get(`/data/radar/${r.id}/state.json`));
  assert.ok(state.seen['doi:10.1/x'], 'the older row is remembered');
  assert.ok(state.refs['10.1/l1'], 'references are cached');

  const before = oa.calls.length;
  t.clock.t += 60_000;
  await ai.routines.runNow(r.id);
  await until(async () => (await ai.routines.list())[0].lastRun.at !== run.at, 'the second run');
  const [second] = await ai.routines.list();
  assert.equal(second.lastRun.session, undefined, 'no New rows: no session, even if older papers are waiting');
  assert.equal(oa.calls.length, before, 'and no OpenAlex requests');
  await ai.dispose();
});

test('a radar on a backend without the radar methods fails with a clear message and does not move lastDone', async () => {
  const t = setup({ fetch: radarFeed() }); // the default test library has no radar methods
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  await ai.routines.runNow(r.id);
  const run = await until(async () => (await ai.routines.list())[0].lastRun, 'the radar run');
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /needs the library server/);
  assert.equal((await ai.routines.list())[0].lastDone, null);
  await ai.dispose();
});

test('a radar ignores the 50% provider rule and routine edits keep kind and radar', async () => {
  const t = setup({ library: radarLibrary(), fetch: radarFeed() });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  const edited = await ai.routines.update(r.id, { name: 'Renamed', radar: { ...r.radar, size: { fresh: 3, older: 0 } } });
  assert.equal(edited.kind, 'radar');
  assert.equal(edited.radar.size.fresh, 3);
  await assert.rejects(ai.routines.update(r.id, { radar: { ...r.radar, size: { fresh: 0 } } }), /1 and 50/);
  await assert.rejects(ai.routines.create(radarDraft({ radar: { sources: [{ kind: 'nope' }] } })), /not a database/);
  await assert.rejects(ai.routines.create(radarDraft({ kind: 'sonar' })), /watch, a digest or a reading radar/);
  await ai.dispose();
});


function loopbackTransport(service) {
  const table = routes();
  const wire = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  return {
    async request(method, path, body) {
      const [pathname] = path.split('?');
      const row = table.find((r) => r.method === method && r.path === pathname);
      if (!row) throw new Error(`no loopback route for ${method} ${path}`);
      return wire(await row.call(service, body ?? {}, { signal: new AbortController().signal }));
    },
    async *stream() {},
  };
}

// ---- spec 012 R4: the digest's words, the vault note, and feedback ----

const summaryFeed = (n = 3, withSummary = [1, 2]) => routedFetch({ [RADAR_FEED]: res(200, feedXml(Array.from({ length: n }, (_, i) => i + 1).map((k) => ({
  title: `Spindle study number ${k} of sleep`, link: `https://j.example/a/${k}`, doi: `10.9999/inv.${k}`, summary: withSummary.includes(k) ? `Spindle density rose after training in study ${k}.` : '',
})))) });
const noted = (over = {}) => { const writes = []; const lib = radarLibrary({ known: [], ...over }); lib.writeDigest = async (file, text) => { if (lib.failNote) throw new Error('HTTP 507'); writes.push({ file, text }); }; return { lib, writes }; };
const brokenFeed = { kind: 'feed', url: 'https://broken.example/feed', title: 'Broken feed' };
const finish = async (ai, id, previous = null) => until(async () => { const r = (await ai.routines.list()).find((x) => x.id === id); return r.lastRun && r.lastRun.at !== previous ? r.lastRun : null; }, 'the radar run');

test('R4: one model call writes why lines from abstracts only; a row with no abstract has none; the summary line sits on both results', async () => {
  const { lib, writes } = noted();
  const t = setup({ library: lib, fetch: summaryFeed() });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  await ai.routines.runNow(r.id);
  const run = await finish(ai, r.id);
  assert.equal(run.status, 'done');
  assert.equal(t.state.whyPrompts.length, 1, 'one call for the whole digest');
  assert.equal((t.state.whyPrompts[0].match(/### Paper/g) ?? []).length, 2, 'only the two rows with an abstract are sent');
  assert.match(t.state.whyPrompts[0], /- sleep spindle/);
  assert.doesNotMatch(t.state.whyPrompts[0], /study number 3/);
  const view = await ai.sessions.view(run.session);
  const body = await ai.sessions.read(run.session, view.results[0].ref);
  const byDoi = Object.fromEntries(body.rows.map((x) => [x.doi, x]));
  assert.match(byDoi['10.9999/inv.1'].radar.why_line, /^Why paper \d matters\.$/);
  assert.ok(byDoi['10.9999/inv.2'].radar.why_line);
  assert.equal(byDoi['10.9999/inv.3'].radar.why_line, undefined, 'no abstract: no line');
  assert.equal(byDoi['10.9999/inv.3'].abstractStatus, 'none');
  assert.equal(byDoi['10.9999/inv.1'].radar.key, 'doi:10.9999/inv.1');
  assert.deepEqual(body.radar, { routine: r.id, summary: '3 new from 1 source · Might interest you skipped (no OpenAlex key) · broken.example feed failed (HTTP 404)' });
  assert.equal(writes.length, 1);
  await ai.dispose();
});

test('R4: the summary line names a failed database in plain words and counts Worth reading', async () => {
  const libWorks = [1, 2, 3].map((n) => ({ id: `W${n}`, doi: `10.1/l${n}`, title: `Invented library paper ${n} on sleep`, year: 2020 + n, refs: ['X'] }));
  const oa = openAlexGraph([...libWorks, { id: 'X', doi: '10.1/x', title: 'Thalamic spindle generation revisited', year: 1995, cited: 812, refs: [] }]);
  const feed = summaryFeed();
  const fetch = async (url, init) => {
    const host = new URL(String(url)).host;
    if (host === 'api.openalex.org') return oa(url, init);
    if (host === 'export.arxiv.org') throw new Error('timeout');
    return feed(url, init);
  };
  const { lib, writes } = noted({ known: libWorks.map((w, i) => ({ key: `L${i}`, doi: w.doi, title: w.title, citekey: null, year: w.year })) });
  const t = setup({ library: lib, fetch });
  const ai = await t.make();
  const radar = { ...radarDraft().radar, sources: [{ kind: 'feed', url: RADAR_FEED, title: 'J' }, { kind: 'database', db: 'arxiv' }], size: { fresh: 5, older: 1 } };
  const r = await ai.routines.create(radarDraft({ radar }));
  await ai.routines.runNow(r.id);
  const run = await finish(ai, r.id);
  const view = await ai.sessions.view(run.session);
  assert.deepEqual(view.results.map((x) => x.title), ['New', 'Worth reading']);
  for (const result of view.results) assert.equal((await ai.sessions.read(run.session, result.ref)).radar.summary, '3 new from 1 source · 1 worth reading · Might interest you skipped (no OpenAlex key) · arXiv failed (timeout)');
  assert.match(writes[0].text, /3 new from 1 source · 1 worth reading · Might interest you skipped \(no OpenAlex key\) · arXiv failed \(timeout\)/);
  await ai.dispose();
});

test('R4: the vault note is a reading list: the summary, a linked heading per paper, its why line, and the cited-by reason', async () => {
  const libWorks = [1, 2, 3].map((n) => ({ id: `W${n}`, doi: `10.1/l${n}`, title: `Invented library paper ${n} on sleep`, year: 2020 + n, refs: ['X'] }));
  const oa = openAlexGraph([...libWorks, { id: 'X', doi: '10.1/x', title: 'Thalamic spindle generation revisited', year: 1995, cited: 812, refs: [] }]);
  const feed = summaryFeed(2, [1]);
  const { lib, writes } = noted({ known: libWorks.map((w, i) => ({ key: `L${i}`, doi: w.doi, title: w.title, citekey: null, year: w.year })) });
  const t = setup({ library: lib, fetch: async (url, init) => (new URL(String(url)).host === 'api.openalex.org' ? oa(url, init) : feed(url, init)) });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft({ name: 'Sleep: radar/1', radar: { ...radarDraft().radar, sources: [{ kind: 'feed', url: RADAR_FEED, title: 'J' }], size: { fresh: 5, older: 1 } } }));
  await ai.routines.runNow(r.id);
  await finish(ai, r.id);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, '2026-05-04 Sleep radar 1', 'the name is made safe for the server');
  const lines = writes[0].text.split('\n');
  assert.equal(lines[0], '# Sleep: radar/1, 2026-05-04');
  assert.equal(lines[2], '*2 new from 1 source · 1 worth reading · Might interest you skipped (no OpenAlex key)*');
  const at = (h) => lines.indexOf(h);
  assert.ok(at('## New') > 0 && at('## Worth reading') > at('## New'));
  assert.equal(lines.some((l) => l.startsWith('|')), false, 'no table rows');
  const first = at('### [Spindle study number 1 of sleep](https://doi.org/10.9999/inv.1)');
  assert.ok(first > at('## New'));
  assert.equal(lines[first + 1], '*J · 2026-10-06*');
  assert.equal(lines[first + 3], 'Why paper 1 matters.');
  assert.ok(lines.includes('No abstract to go on'));
  const older = lines.slice(at('## Worth reading') + 2);
  assert.equal(older[0], '### [Thalamic spindle generation revisited](https://doi.org/10.1/x)');
  assert.match(older[1], /^Cited by 3 papers in your library, including /);
  await ai.dispose();
});

test('R4: a model failure leaves the rows without lines and never fails the run', async () => {
  const { lib, writes } = noted();
  const t = setup({ library: lib, fetch: summaryFeed(), state: { fail: true } });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  await ai.routines.runNow(r.id);
  const run = await finish(ai, r.id);
  assert.equal(run.status, 'done');
  assert.equal(run.added, 3);
  const body = await ai.sessions.read(run.session, (await ai.sessions.view(run.session)).results[0].ref);
  assert.ok(body.rows.every((x) => x.radar.why_line === undefined));
  assert.equal(writes.length, 1, 'the note is still written');
  assert.match(writes[0].text, /^No abstract to go on$/m);
  await ai.dispose();
});

test('R4: radar.note false writes no note; a failed note write is reported on the run and is not fatal', async () => {
  const off = noted();
  const t1 = setup({ library: off.lib, fetch: summaryFeed() });
  const a1 = await t1.make();
  const r1 = await a1.routines.create(radarDraft({ radar: { ...radarDraft().radar, note: false } }));
  await a1.routines.runNow(r1.id);
  assert.equal((await finish(a1, r1.id)).status, 'done');
  assert.equal(off.writes.length, 0);
  await a1.dispose();

  const bad = noted();
  bad.lib.failNote = true;
  const t2 = setup({ library: bad.lib, fetch: summaryFeed() });
  const a2 = await t2.make();
  const r2 = await a2.routines.create(radarDraft());
  await a2.routines.runNow(r2.id);
  const run = await finish(a2, r2.id);
  assert.equal(run.status, 'done');
  assert.equal(run.added, 3);
  assert.match(run.reason, /The vault note was not written \(HTTP 507\)/);
  await a2.dispose();
});

test('R4: feedback updates the radar state and profile through the service, over the wire, and undo puts both back', async () => {
  const { lib } = noted();
  const t = setup({ library: lib, fetch: summaryFeed() });
  const local = await t.make();
  const ai = createRemoteRuntime(loopbackTransport(local));
  const r = await ai.routines.create(radarDraft({ radar: { ...radarDraft().radar, profile: { topics: [{ text: 'sleep spindle' }], authors: [{ name: 'Doe, J.' }] } } }));
  await ai.routines.runNow(r.id);
  const run = await finish(ai, r.id);
  const stateFile = `/data/radar/${r.id}/state.json`;
  const key = 'doi:10.9999/inv.2';

  assert.deepEqual(await ai.radar.verdicts(r.id), {}, 'nothing done yet');
  assert.deepEqual(await ai.radar.feedback(r.id, key, 'dismissed'), { verdict: 'dismissed', changed: true });
  assert.deepEqual(await ai.radar.verdicts(r.id), { [key]: 'dismissed' });
  assert.deepEqual(await ai.radar.feedback(r.id, key, 'dismissed'), { verdict: 'dismissed', changed: false });
  let state = JSON.parse(t.fs.files.get(stateFile));
  assert.equal(state.seen[key].verdict, 'dismissed');
  assert.deepEqual(state.examples.negative.map((e) => e.id), [key]);
  assert.deepEqual(await ai.radar.feedback(r.id, key, 'undo'), { verdict: 'shown', changed: true });
  assert.deepEqual(await ai.radar.verdicts(r.id), {});
  state = JSON.parse(t.fs.files.get(stateFile));
  assert.equal(state.seen[key].verdict, 'shown');
  assert.deepEqual(state.examples.negative, []);

  const before = (await ai.routines.list())[0].radar.profile;
  await ai.radar.feedback(r.id, 'doi:10.9999/inv.1', 'added');
  const listed = (await ai.routines.list())[0];
  assert.deepEqual(listed.radarLearned.map((l) => [l.kind, l.name]), [['venue', 'J']], 'the feed row has no authors, only its venue');
  assert.deepEqual(listed.radar.profile.journals, [{ name: 'J', openalexId: null, weight: 0.05, origin: 'learned' }]);
  assert.deepEqual(listed.radar.profile.authors, before.authors);
  assert.deepEqual(JSON.parse(t.fs.files.get(stateFile)).examples.positive.map((e) => e.id), ['doi:10.9999/inv.1']);

  await ai.radar.feedback(r.id, 'doi:10.9999/inv.1', 'undo');
  const reverted = (await ai.routines.list())[0];
  assert.deepEqual(reverted.radar.profile, before);
  assert.deepEqual(reverted.radarLearned, []);

  await assert.rejects(ai.radar.feedback(r.id, 'doi:10.9999/never', 'added'), /not one this radar has shown/);
  await assert.rejects(ai.radar.feedback('nope', key, 'added'), /No such routine/);
  await local.dispose();
});

test('R4: a click made while a run is working survives that run\'s final write', async () => {
  const { lib } = noted();
  const first = summaryFeed(3, [1, 2, 3]);
  const t = setup({ library: lib, fetch: first });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft());
  await ai.routines.runNow(r.id);
  const run = await finish(ai, r.id);
  await ai.radar.feedback(r.id, 'doi:10.9999/inv.3', 'later');
  t.clock.t += 60_000;
  await ai.routines.runNow(r.id);
  await finish(ai, r.id, run.at);
  const state = JSON.parse(t.fs.files.get(`/data/radar/${r.id}/state.json`));
  assert.equal(state.seen['doi:10.9999/inv.3'].verdict, 'later', 'a later quiet run does not turn it back to shown');
  await ai.dispose();
});

test('R4 spec check 7: after 10 Not relevant clicks on one topic the next run ranks fewer of that topic in its top 10', async () => {
  const items = (prefix, base) => Array.from({ length: 10 }, (_, i) => ({ title: `${prefix} item number ${base + i} measured carefully`, link: `https://j.example/${prefix}/${base + i}`, doi: `10.9999/${prefix}.${base + i}`, summary: `${prefix} measurement ${base + i}.` }));
  let xml = feedXml([...items('Hippocampal', 0), ...items('Thalamic', 0)]);
  const fetch = routedFetch({ [RADAR_FEED]: () => res(200, xml) });
  const lib = radarLibrary({ neg: (text, negatives) => (negatives.length && /hippocampal/i.test(text) ? 0.95 : 0) });
  const t = setup({ library: lib, fetch });
  const ai = await t.make();
  const r = await ai.routines.create(radarDraft({ radar: { ...radarDraft().radar, sources: [{ kind: 'feed', url: RADAR_FEED, title: 'J' }], size: { fresh: 20, older: 0 } } }));
  const topicOf = (row) => (/hippocampal/i.test(row.title) ? 'hippocampal' : 'thalamic');
  await ai.routines.runNow(r.id);
  const run1 = await finish(ai, r.id);
  const rows1 = (await ai.sessions.read(run1.session, (await ai.sessions.view(run1.session)).results[0].ref)).rows;
  assert.equal(rows1.filter((x) => topicOf(x) === 'hippocampal').length, 10);
  for (const row of rows1.filter((x) => topicOf(x) === 'hippocampal')) await ai.radar.feedback(r.id, row.radar.key, 'dismissed');

  xml = feedXml([...items('Hippocampal', 10), ...items('Thalamic', 10)]);
  t.clock.t += 60_000;
  await ai.routines.runNow(r.id);
  const run2 = await finish(ai, r.id, run1.at);
  const rows2 = (await ai.sessions.read(run2.session, (await ai.sessions.view(run2.session)).results[0].ref)).rows.slice(0, 10);
  assert.equal(rows2.filter((x) => topicOf(x) === 'hippocampal').length, 0, 'none of the dismissed topic in the top 10 (it was 10 of 20 before)');
  assert.equal(rows2.length, 10);
  assert.equal(JSON.parse(t.fs.files.get(`/data/radar/${r.id}/state.json`)).sourceStatus['feed:https://j.example/feed'].suggestRemove, true, 'ten dismissals in a row also suggest dropping that feed');
  await ai.dispose();
});
