import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantPool, createTenantRuntime, createAlcfCredentialClient } from '../src/node/tenant-runtime.mjs';
import { memoryFs } from './support/memory-fs.mjs';
import { createSettingsStore } from '../src/settings.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

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
