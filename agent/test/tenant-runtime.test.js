import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantPool, createTenantRuntime, createAlcfCredentialClient } from '../src/node/tenant-runtime.mjs';
import { memoryFs } from './support/memory-fs.mjs';
import { createSettingsStore } from '../src/settings.js';
import { createLocalRuntime } from '../src/core.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function platform(fs) {
  return {
    fs,
    homeDir: '/private/home',
    async fetch(url) { throw new Error(`unexpected network during construction: ${url}`); },
    async spawn() { throw new Error('unexpected subprocess'); },
    async which() { return null; },
  };
}

test('tenant composition isolates settings, conversations, secrets and private outputs', async () => {
  const fs = memoryFs();
  const deps = {
    platform: platform(fs), tenantRoot: 'users', tenant: A,
    kbBaseUrl: 'http://127.0.0.1:27182', agentSecret: 'sidecar-secret', port: 39000,
  };
  const first = await createTenantRuntime(deps);
  const second = await createTenantRuntime({ ...deps, tenant: B });

  assert.ok(first.service && second.service);
  assert.ok(!first.providers.has('codex') && !first.providers.has('claude') && !first.providers.has('local'));
  assert.deepEqual([...first.providers.keys()].sort(), ['oss:alcf-metis', 'oss:alcf-minerva', 'oss:alcf-sophia', 'oss:alcf-tara']);

  const id = await first.service.conversations.create('chat');
  await first.service.settings.update({ sources: { papers: false } });
  await second.service.settings.update({ sources: { papers: true } });
  assert.equal((await second.service.conversations.list()).some((chat) => chat.id === id), false);
  assert.equal((await first.service.settings.get()).sources.papers, false);
  assert.equal((await second.service.settings.get()).sources.papers, true);
  assert.ok(await fs.read(`users/${A}/agent/settings.json`));
  assert.ok(await fs.read(`users/${B}/agent/settings.json`));
  assert.ok(!(await fs.read('users/agent/settings.json')));

  await first.notes.publish({ reviewId: '../private-review', title: 'Private', markdown: '# Private', frontMatter: {} });
  await first.library.writeDigest('../private-digest.md', 'private digest');
  assert.equal(await fs.read(`users/${A}/agent/published/private-review.md`), '# Private');
  assert.equal(await fs.read(`users/${A}/agent/digests/private-digest.md`), 'private digest');
  await first.service.dispose();
  await second.service.dispose();
});

test('persisted custom endpoints and stdio configs are neutralized before reconstruction', async () => {
  const fs = memoryFs();
  const net = platform(fs);
  const spawned = [];
  const fetched = [];
  net.spawn = async (spec) => { spawned.push(spec); throw new Error('tenant subprocess executed'); };
  net.fetch = async (url, opts) => {
    const address = String(url);
    assert.ok(!address.includes('saved-but-ignored.example'));
    fetched.push({ address, opts });
    if (address.includes('/auth/globus/agent-token')) {
      return new Response(JSON.stringify({ access_token: 'tenant-token', expires_at: 1234 }), { status: 200 });
    }
    if (address.endsWith('/resource_server/list-endpoints')) return new Response('authorization denied', { status: 401 });
    throw new Error(`unexpected custom endpoint request: ${address}`);
  };
  const store = createSettingsStore(fs, `users/${A}/agent`);
  await store.saveMcpServer({ name: 'evil', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  await store.update({ endpoints: [{ name: 'alcf-metis', baseUrl: 'https://saved-but-ignored.example/v1', key: null }] });

  const runtime = await createTenantRuntime({
    platform: net, tenantRoot: 'users', tenant: A,
    kbBaseUrl: 'http://127.0.0.1:27182', agentSecret: 'sidecar-secret', port: 39000,
  });
  const settings = await runtime.service.settings.get();
  assert.deepEqual(settings.endpoints, []);
  assert.deepEqual(settings.mcp, []);
  assert.equal(spawned.length, 0);
  assert.ok(runtime.providers.has('oss:alcf-metis'));

  await runtime.providers.get('oss:alcf-metis').models();
  assert.ok(fetched.some(({ address }) => address.endsWith('/resource_server/list-endpoints')));
  for (const { opts } of fetched) {
    if (opts?.env) assert.ok(!Object.values(opts.env).includes('sidecar-secret'));
  }
  await runtime.service.dispose();
});

test('pool constructs once per tenant, isolates leases and evicts only idle runtimes', async () => {
  let now = 100_000;
  const builds = [];
  const disposed = [];
  const pool = createTenantPool({
    clock: () => now, idleMs: 1_000, sweepMs: 60_000, maxRuntimes: 2,
    async buildRuntime(tenant) {
      builds.push(tenant);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        service: { async dispose() { disposed.push(tenant); } },
        mcpHandler: async () => ({ status: 200, body: tenant }),
      };
    },
  });

  const [first, again] = await Promise.all([pool.acquire(A), pool.acquire(A)]);
  assert.equal(builds.filter((tenant) => tenant === A).length, 1);
  assert.notEqual(first, again, 'each request has an independent lease handle');
  again.release();
  await assert.rejects(pool.acquire('not-a-tenant'), /tenant/);

  const second = await pool.acquire(B);
  second.release();
  now += 2_000;
  const thirdTenant = 'c'.repeat(64);
  const third = await pool.acquire(thirdTenant);
  assert.equal(builds.length, 3);
  assert.ok(disposed.includes(B));
  third.release();
  first.release();

  now += 2_000;
  await pool.evictIdle();
  assert.ok(disposed.includes(A));
  await pool.dispose();
});

test('pool cap evicts an idle LRU but never an active lease', async () => {
  let now = 0;
  const disposed = [];
  const pool = createTenantPool({
    clock: () => now, maxRuntimes: 16, idleMs: 100_000_000,
    async buildRuntime(tenant) {
      return { service: { async dispose() { disposed.push(tenant); } }, mcpHandler: async () => ({ status: 200, body: '' }) };
    },
  });
  const leases = [];
  for (let i = 0; i < 16; i += 1) {
    now += 1;
    const lease = await pool.acquire(String(i).padStart(64, '0'));
    if (i !== 0) lease.release();
    leases.push(lease);
  }
  const activeA = leases[0];
  const seventeenth = await pool.acquire('f'.repeat(64));
  assert.ok(disposed.includes('1'.padStart(64, '0')));
  assert.ok(!disposed.includes('0'.repeat(64)));
  seventeenth.release();
  activeA.release();
  await pool.dispose();
});

test('17 simultaneous cold starts fill an empty 16-slot pool with only one rejection', async () => {
  const builds = [];
  const pool = createTenantPool({
    maxRuntimes: 16, idleMs: 100_000_000,
    async buildRuntime(tenant) {
      builds.push(tenant);
      return { service: { async dispose() {} }, mcpHandler: async () => ({ status: 200, body: '' }) };
    },
  });
  const outcomes = await Promise.allSettled(Array.from({ length: 17 }, (_, i) => pool.acquire(String(i).padStart(64, '0'))));
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 16);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 503);
  assert.equal(rejected[0].reason.message, 'too many active Veritas workspaces; try again later');
  assert.equal(builds.length, 16);
  for (const outcome of fulfilled) outcome.value.release();
  await pool.dispose();
});

for (const eviction of ['sweep', 'capacity']) {
  test(`pending acquisition claims protect publication from ${eviction} eviction`, async (t) => {
    let disposed = false;
    let probe;
    const pool = createTenantPool({
      maxRuntimes: 1,
      buildRuntime(tenant) {
        if (tenant === A) {
          // Run after the build's await publishes, but before acquire delivers its leases.
          queueMicrotask(() => queueMicrotask(() => {
            probe = eviction === 'sweep' ? pool.evictIdle(true)
              : assert.rejects(pool.acquire(B), (error) => error.status === 503);
            probe.catch(() => {});
          }));
        }
        return { service: { async dispose() { disposed = true; } } };
      },
    });
    t.after(() => pool.dispose());
    const [first, second] = await Promise.all([pool.acquire(A), pool.acquire(A)]);
    assert.equal(disposed, false, 'a delivered lease must not refer to a disposed service');
    await probe;
    assert.equal(first.service, second.service);
    first.release();
    first.release();
    await assert.rejects(pool.acquire(B), (error) => error.status === 503);
    second.release();
    (await pool.acquire(B)).release();
  });

  test(`real detached columns survive ${eviction} eviction after the request releases`, { timeout: 5_000 }, async (t) => {
    const finishing = deferred();
    const finishPersistence = deferred();
    const fs = memoryFs();
    const remove = fs.remove;
    fs.remove = async (path) => {
      finishing.resolve();
      await finishPersistence.promise;
      return remove(path);
    };
    let finishTurn;
    let turnSignal;
    let startTurn;
    const started = new Promise((resolve) => { startTurn = resolve; });
    const provider = {
      id: 'fake', caps: {},
      async *turn(_req, signal) {
        turnSignal = signal;
        await new Promise((resolve) => {
          finishTurn = resolve;
          signal.addEventListener('abort', resolve, { once: true });
          startTurn();
        });
        const json = { rows: [{ row: 'x:1', cells: [{ column: 'sample', status: 'found', value: '10', quotes: ['Sample size is 10.'] }] }] };
        yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
      },
      async dispose() {},
    };
    const pool = createTenantPool({
      maxRuntimes: 1,
      async buildRuntime(tenant) {
        const service = await createLocalRuntime({
          platform: platform(fs), dataDir: `users/${tenant}/agent`,
          library: {}, notes: {}, providers: new Map([['fake', provider]]),
          gateway: {
            open() { return { specs: [], seen: () => [], close() {} }; },
            async dispose() {},
          },
          getRoleModel: async () => ({ provider: 'fake', model: null }),
          routines: { isOwner: () => false },
        });
        return { service };
      },
    });
    t.after(async () => { finishTurn?.(); finishPersistence.resolve(); await pool.dispose(); });
    const request = await pool.acquire(A);
    const service = request.service;
    const id = await service.conversations.create('chat');
    const { ref } = await service.sessions.put(id, { kind: 'find', query: 'fixture' }, {
      kind: 'papers', title: 'Fixture', from: [], change: 'Found papers',
      rows: [{ id: 'x:1', title: 'Fixture', abstract: 'Sample size is 10.', ref: { kind: 'web', url: 'https://example.org/paper' } }],
      columns: [], cells: {},
    });
    const { step } = await service.sessions.run(id, {
      kind: 'columns', on: ref, rows: 'all', text: 'abstract',
      add: [{ id: 'sample', name: 'Sample size', instruction: 'How many?', kind: 'text' }],
    });
    request.release();
    await started;
    if (eviction === 'sweep') await pool.evictIdle(true);
    else await assert.rejects(pool.acquire(B), (error) => error.status === 503);
    assert.equal(turnSignal.aborted, false, 'request completion must not make detached work evictable');
    const resident = await pool.acquireExisting(A);
    assert.equal(resident.service, service);
    resident.release();
    finishTurn();
    await finishing.promise;
    await assert.rejects(pool.acquire(B), (error) => error.status === 503);
    assert.equal(service.hasActiveWork(), true, 'work includes final persistence, not only provider turns');
    finishPersistence.resolve();
    const events = [];
    for await (const event of service.sessions.events(id, step, 0)) events.push(event);
    assert.equal(events.at(-1).data.status, 'done');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.hasActiveWork(), false);
    (await pool.acquire(B)).release();
    await assert.rejects(pool.acquireExisting(A), (error) => error.status === 404);
  });
}

test('simultaneous full-pool replacements dispose distinct idle runtimes and preserve the cap', async () => {
  const C = 'c'.repeat(64);
  const D = 'd'.repeat(64);
  const disposed = [];
  const pool = createTenantPool({
    maxRuntimes: 2, idleMs: 100_000_000,
    async buildRuntime(tenant) {
      return { service: { async dispose() { disposed.push(tenant); } }, mcpHandler: async () => ({ status: 200, body: '' }) };
    },
  });
  (await pool.acquire(A)).release();
  (await pool.acquire(B)).release();
  const leases = await Promise.all([pool.acquire(C), pool.acquire(D)]);
  assert.deepEqual(disposed.sort(), [A, B], 'each admission reserves a different idle eviction');
  for (const lease of leases) lease.release();
  await assert.rejects(pool.acquireExisting(A), (error) => error.status === 404);
  await assert.rejects(pool.acquireExisting(B), (error) => error.status === 404);
  const residentC = await pool.acquireExisting(C);
  const residentD = await pool.acquireExisting(D);
  assert.equal(residentC.service, leases[0].service);
  assert.equal(residentD.service, leases[1].service);
  residentC.release();
  residentD.release();
  await pool.dispose();
});

test('same-tenant cold starts share construction across a delayed cap eviction', async () => {
  const C = 'c'.repeat(64);
  const builds = [];
  const disposed = [];
  let finishEviction;
  const pool = createTenantPool({
    maxRuntimes: 2, idleMs: 100_000_000,
    async buildRuntime(tenant) {
      builds.push(tenant);
      return {
        service: { async dispose() {
          disposed.push(tenant);
          if (tenant === A) await new Promise((resolve) => { finishEviction = resolve; });
        } },
        mcpHandler: async () => ({ status: 200, body: '' }),
      };
    },
  });
  (await pool.acquire(A)).release();
  (await pool.acquire(B)).release();
  const first = pool.acquire(C);
  const second = pool.acquire(C);
  await new Promise((resolve) => setImmediate(resolve));
  finishEviction();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(builds.filter((tenant) => tenant === C).length, 1);
  assert.deepEqual(disposed, [A]);
  assert.equal(one.service, two.service);
  one.release();
  two.release();
  await pool.dispose();
});

test('acquiring during an old runtime disposal waits and builds a fresh runtime', async () => {
  let finishDispose;
  let builds = 0;
  const pool = createTenantPool({
    maxRuntimes: 1,
    async buildRuntime() {
      builds += 1;
      return {
        service: { async dispose() {
          if (builds === 1) await new Promise((resolve) => { finishDispose = resolve; });
        } },
        mcpHandler: async () => ({ status: 200, body: '' }),
      };
    },
  });
  (await pool.acquire(A)).release();
  const disposing = pool.evictIdle(true);
  await new Promise((resolve) => setImmediate(resolve));
  const acquiring = pool.acquire(A);
  finishDispose();
  const fresh = await acquiring;
  assert.equal(typeof fresh.service.dispose, 'function');
  fresh.release();
  await disposing;
  await pool.dispose();
  assert.equal(builds, 2);
});

test('a queued eviction rechecks activity before disposing the next runtime', async () => {
  let finishFirst;
  const disposed = [];
  const pool = createTenantPool({
    idleMs: 0,
    async buildRuntime(tenant) {
      return {
        service: { async dispose() {
          disposed.push(tenant);
          if (disposed.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
        } },
        mcpHandler: async () => ({ status: 200, body: '' }),
      };
    },
  });
  (await pool.acquire(A)).release();
  (await pool.acquire(B)).release();
  const evicting = pool.evictIdle();
  await new Promise((resolve) => setImmediate(resolve));
  const active = await pool.acquire(B);
  finishFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!disposed.includes(B));
  active.release();
  await evicting;
  await pool.dispose();
});

test('simultaneous forced credential requests share one sidecar refresh', async () => {
  const calls = [];
  const net = {
    async fetch(url, opts) {
      calls.push({ url: String(url), opts });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: 'fresh-token', expires_at: 1234 }), { status: 200 });
    },
  };
  const credential = createAlcfCredentialClient(net, {
    kbBaseUrl: 'http://127.0.0.1:27182', agentSecret: 'sidecar-secret', tenant: A,
  });
  const [first, second] = await Promise.all([credential(true), credential(true)]);
  assert.equal(first, 'fresh-token');
  assert.equal(second, 'fresh-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes('refresh=1'), true);
});

test('rejected credential responses are cancelled and concealed', async () => {
  const rejected = new Response('private bearer diagnostic', { status: 401 });
  let cancellations = 0;
  const cancel = rejected.body.cancel.bind(rejected.body);
  rejected.body.cancel = async (...args) => { cancellations += 1; return cancel(...args); };
  const calls = [];
  const credential = createAlcfCredentialClient({ fetch: async () => {
    calls.push(true);
    return rejected;
  } }, { kbBaseUrl: 'http://127.0.0.1:27182', agentSecret: 'sidecar-secret', tenant: A });
  await assert.rejects(credential(), (error) => error.status === 401
    && error.message === 'ALCF credential delivery was rejected'
    && !error.message.includes('private bearer diagnostic'));
  assert.equal(calls.length, 1);
  assert.equal(cancellations, 1);
});

test('a failed runtime construction can be retried', async () => {
  let attempts = 0;
  const pool = createTenantPool({
    async buildRuntime(tenant) {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary build failure');
      return { service: { async dispose() {} }, mcpHandler: async () => ({ status: 200, body: tenant }) };
    },
  });
  await assert.rejects(pool.acquire(A), /temporary build failure/);
  const lease = await pool.acquire(A);
  assert.equal(typeof lease.service.dispose, 'function');
  lease.release();
  await pool.dispose();
  assert.equal(attempts, 2);
});

test('disposal keeps its capacity until resources are gone', async (t) => {
  const gate = deferred();
  const builds = [];
  const pool = createTenantPool({
    maxRuntimes: 1,
    buildRuntime(tenant) {
      builds.push(tenant);
      return { service: { dispose: () => tenant === A ? gate.promise : Promise.resolve() } };
    },
  });
  t.after(async () => { gate.resolve(); await pool.dispose(); });
  (await pool.acquire(A)).release();
  const replacement = pool.acquire(B);
  const sameReplacement = pool.acquire(B);
  await assert.rejects(pool.acquire('c'.repeat(64)), (error) => error.status === 503);
  await assert.rejects(pool.acquireExisting(A), (error) => error.status === 404);
  await assert.rejects(pool.acquireExisting(B), (error) => error.status === 404);
  assert.deepEqual(builds, [A]);
  gate.resolve();
  const [first, second] = await Promise.all([replacement, sameReplacement]);
  assert.equal(first.service, second.service);
  assert.deepEqual(builds, [A, B]);
  first.release();
  second.release();
});

test('replacement and reacquisition recheck the same freed slot without exceeding capacity', async (t) => {
  const gate = deferred();
  const builds = [];
  let live = 0;
  const pool = createTenantPool({
    maxRuntimes: 1,
    buildRuntime(tenant) {
      builds.push(tenant);
      live += 1;
      assert.equal(live, 1, 'construction must not overlap another live or disposing runtime');
      return { service: { async dispose() { await gate.promise; live -= 1; } } };
    },
  });
  t.after(async () => { gate.resolve(); await pool.dispose(); });
  (await pool.acquire(A)).release();
  const replacement = pool.acquire(B);
  const reacquisition = pool.acquire(A);
  const outcomes = Promise.allSettled([replacement, reacquisition]);
  gate.resolve();
  const results = await outcomes;
  const admitted = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(admitted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 503);
  assert.equal(builds.length, 2);
  admitted[0].value.release();
});

test('MCP acquisition never constructs or waits and reserves ready runtimes synchronously', async (t) => {
  const gate = deferred();
  let builds = 0;
  const runtime = { service: { async dispose() {} }, mcpHandler: () => 'mcp' };
  const pool = createTenantPool({
    maxRuntimes: 1,
    buildRuntime() { builds += 1; return gate.promise; },
  });
  t.after(() => pool.dispose());
  await assert.rejects(pool.acquireExisting(A), (error) => error.status === 404);
  assert.equal(builds, 0);
  const pending = pool.acquire(A);
  await assert.rejects(pool.acquireExisting(A), (error) => error.status === 404);
  gate.resolve(runtime);
  (await pending).release();
  const existing = pool.acquireExisting(A);
  await assert.rejects(pool.acquire(B), (error) => error.status === 503);
  const lease = await existing;
  assert.equal(lease.mcpHandler, runtime.mcpHandler);
  lease.release();
  assert.equal(builds, 1);
});

test('failed single-flight construction releases capacity and all claims', async (t) => {
  const gate = deferred();
  let attempts = 0;
  const pool = createTenantPool({
    maxRuntimes: 1,
    buildRuntime() {
      attempts += 1;
      if (attempts === 1) return gate.promise;
      return { service: { async dispose() {} } };
    },
  });
  t.after(() => pool.dispose());
  const first = assert.rejects(pool.acquire(A), /build failed/);
  const second = assert.rejects(pool.acquire(A), /build failed/);
  gate.reject(new Error('build failed'));
  await Promise.all([first, second]);
  assert.equal(attempts, 1);
  (await pool.acquire(B)).release();
  (await pool.acquire(A)).release();
  assert.equal(attempts, 3);
});

for (const synchronous of [true, false]) {
  test(`${synchronous ? 'thrown' : 'rejected'} disposal quarantines capacity and fails shutdown visibly`, async () => {
    const error = new Error('disposal failed');
    let builds = 0;
    let disposals = 0;
    const pool = createTenantPool({
      maxRuntimes: 1,
      buildRuntime() {
        builds += 1;
        return { service: { dispose() {
          disposals += 1;
          if (synchronous) throw error;
          return Promise.reject(error);
        } } };
      },
    });
    (await pool.acquire(A)).release();
    await assert.rejects(pool.acquire(B), (e) => e === error);
    await assert.rejects(pool.acquire(A), (e) => e === error);
    await assert.rejects(pool.acquire(B), (e) => e.status === 503);
    await assert.rejects(pool.acquireExisting(A), (e) => e.status === 404);
    await pool.evictIdle(true);
    await assert.rejects(pool.dispose(), (e) => e instanceof AggregateError && e.errors[0] === error);
    await assert.rejects(pool.dispose(), AggregateError);
    assert.equal(builds, 1);
    assert.equal(disposals, 1, 'failed disposal is not retried against a partially disposed service');
  });
}

test('shutdown rejects new and pending leases and disposes late construction exactly once', async () => {
  const gate = deferred();
  const started = deferred();
  let disposals = 0;
  const pool = createTenantPool({
    buildRuntime() { started.resolve(); return gate.promise; },
  });
  const pending = assert.rejects(pool.acquire(A), /shutting down/);
  const alsoPending = assert.rejects(pool.acquire(A), /shutting down/);
  await started.promise;
  const shutdown = pool.dispose();
  assert.equal(pool.dispose(), shutdown);
  await assert.rejects(pool.acquire(B), /shutting down/);
  await assert.rejects(pool.acquireExisting(A), /shutting down/);
  gate.resolve({ service: { async dispose() { disposals += 1; } } });
  await Promise.all([shutdown, pending, alsoPending]);
  await assert.rejects(pool.acquire(A), /shutting down/);
  assert.equal(disposals, 1);
});

test('shutdown during replacement waits for disposal but never builds its successor', async () => {
  const gate = deferred();
  const builds = [];
  const pool = createTenantPool({
    maxRuntimes: 1,
    buildRuntime(tenant) {
      builds.push(tenant);
      return { service: { dispose: () => gate.promise } };
    },
  });
  (await pool.acquire(A)).release();
  const replacement = assert.rejects(pool.acquire(B), /shutting down/);
  const reacquire = assert.rejects(pool.acquire(A), /shutting down/);
  const shutdown = pool.dispose();
  gate.resolve();
  await Promise.all([shutdown, replacement, reacquire]);
  assert.deepEqual(builds, [A]);
});

for (const change of ['work', 'idle deadline']) {
  test(`sweep rechecks ${change} after another disposal yields`, async (t) => {
    let now = 0;
    let working = false;
    const gate = deferred();
    const disposed = [];
    const pool = createTenantPool({
      clock: () => now, idleMs: 100,
      buildRuntime(tenant) {
        return { service: {
          hasActiveWork: () => tenant === B && working,
          async dispose() { disposed.push(tenant); if (tenant === A) await gate.promise; },
        } };
      },
    });
    t.after(async () => { gate.resolve(); await pool.dispose(); });
    (await pool.acquire(A)).release();
    (await pool.acquire(B)).release();
    now = 200;
    const sweeping = pool.evictIdle();
    const request = await pool.acquire(B);
    if (change === 'work') working = true;
    request.release();
    // Only the work predicate, not the renewed idle deadline, can protect this case.
    if (change === 'work') now += 200;
    gate.resolve();
    await sweeping;
    assert.deepEqual(disposed, [A]);
    working = false;
    now += 200;
    await pool.evictIdle();
    assert.deepEqual(disposed, [A, B]);
  });
}
