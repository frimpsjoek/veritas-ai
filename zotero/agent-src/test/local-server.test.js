import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer, checkMlx, pythonFor } from '../src/local/server.js';
import { DEFAULT_LOCAL } from '../src/settings.js';
import { fakeClock, fakeHost, fakeProc } from './support/fake-mlx-host.mjs';

const HOME = '/Users/test';
const PY = `${HOME}/woof-bench/.venv/bin/python`;
const GB = 1024 ** 3;
const woof4 = { id: 'mlx:ConwayResearch/Underdog-Woof-4B-1.1', label: 'Underdog Woof 4B 1.1', path: '/Volumes/Content/models/ConwayResearch/Underdog-Woof-4B-1.1', sizeBytes: 2 * GB };
const qwen = { id: 'mlx:mlx-community/Qwen3.5-4B-MLX-4bit', label: 'Qwen3.5 4B MLX 4bit', path: '/Volumes/Content/models/mlx-community/Qwen3.5-4B-MLX-4bit', sizeBytes: 2 * GB };

function setup(opts = {}, local = {}) {
  const host = fakeHost({
    stats: { [PY]: { size: 1, dir: false }, [`${HOME}/woof-bench/.venv/lib/python3.12/site-packages/mlx_lm`]: { size: 0, dir: true } },
    ...opts,
  });
  host.fs.list = async (dir) => (dir === `${HOME}/woof-bench/.venv/lib` ? ['python3.12'] : []);
  const clock = fakeClock();
  const server = createLocalServer({
    platform: { spawn: (s) => host.spawn(s), fetch: (u) => host.fetch(u), fs: host.fs },
    dataDir: '/data', home: HOME, timers: clock, pickPort: async () => 8750, pollMs: 10, startTimeoutMs: 100, reapWaitMs: 0,
    settings: async () => ({ ...DEFAULT_LOCAL, ...local }),
  });
  return { host, clock, server };
}

const modelSpawns = (host) => host.spawns.filter((s) => s.args.includes('mlx_lm.server'));

test('the first turn starts exactly one server with the guard flags; the same model again starts none', async () => {
  const { host, server } = setup();
  const a = await server.ensure(woof4);
  assert.equal(a.baseUrl, 'http://127.0.0.1:8750/v1');
  const [spawn] = modelSpawns(host);
  assert.equal(spawn.cmd, PY, 'the arm64 venv python, never python3 from PATH');
  assert.deepEqual(spawn.args.slice(0, 5), ['-m', 'mlx_lm.server', '--model', woof4.path, '--host']);
  assert.ok(spawn.args.includes('127.0.0.1'));
  assert.equal(spawn.args[spawn.args.indexOf('--temp') + 1], '0');
  assert.equal(spawn.args[spawn.args.indexOf('--max-tokens') + 1], '600');
  assert.equal(spawn.args[spawn.args.indexOf('--chat-template-args') + 1], '{"enable_thinking":false}');
  assert.equal(server.state().state, 'ready');
  await server.ensure(woof4);
  assert.equal(modelSpawns(host).length, 1);
  assert.equal(JSON.parse(host.fs.files.get('/data/local-server.json')).pid, host.procs[0].pid, 'a pid file is written');
});

test('nothing starts before the first turn, and readiness is polled until the server answers', async () => {
  const { host, server } = setup({ readyAfterPolls: 3 });
  assert.equal(modelSpawns(host).length, 0);
  assert.equal(server.state().state, 'stopped');
  const pending = server.ensure(woof4);
  await pending;
  assert.equal(host.polls >= 3, true);
});

test('asking for another model stops the first one before starting the second', async () => {
  const { host, server } = setup();
  await server.ensure(woof4);
  await server.ensure(qwen);
  assert.equal(modelSpawns(host).length, 2);
  assert.equal(host.procs[0].killed, true);
  assert.equal(host.procs.filter((p) => !p.killed).length, 1, 'only one model is ever running');
  assert.equal(server.state().id, qwen.id);
});

test('concurrent ensures for different models never run two at once', async () => {
  const { host, server } = setup();
  await Promise.all([server.ensure(woof4), server.ensure(qwen)]);
  assert.equal(host.procs.filter((p) => !p.killed).length, 1);
});

test('idle time stops the child; a turn in progress is never cut off; the next turn starts a fresh one', async () => {
  const { host, clock, server } = setup({}, { idleMinutes: 5 });
  server.begin();
  await server.ensure(woof4);
  await clock.advance(60 * 60_000);
  assert.equal(host.procs[0].killed, false, 'busy: no idle stop even after an hour');
  server.end(); await clock.advance(0);
  await clock.advance(4 * 60_000);
  assert.equal(host.procs[0].killed, false, 'not yet: 4 of 5 minutes');
  await clock.advance(61_000);
  assert.equal(host.procs[0].killed, true, 'stopped after 5 idle minutes');
  assert.equal(server.state().state, 'stopped');
  assert.equal(host.fs.files.has('/data/local-server.json'), false, 'the pid file goes with it');
  server.begin();
  await server.ensure(woof4);
  server.end(); await clock.advance(0);
  assert.equal(modelSpawns(host).length, 2);
});

test('a new turn resets the idle clock', async () => {
  const { host, clock, server } = setup({}, { idleMinutes: 5 });
  server.begin(); await server.ensure(woof4); server.end(); await clock.advance(0);
  await clock.advance(4 * 60_000);
  server.begin(); await server.ensure(woof4); server.end(); await clock.advance(0);
  await clock.advance(4 * 60_000);
  assert.equal(host.procs[0].killed, false);
  await clock.advance(2 * 60_000);
  assert.equal(host.procs[0].killed, true);
});

test('the idle minutes setting is read live', async () => {
  const { host, clock, server } = setup({}, { idleMinutes: 1 });
  server.begin(); await server.ensure(woof4); server.end(); await clock.advance(0);
  await clock.advance(61_000);
  assert.equal(host.procs[0].killed, true);
});

test('not enough free memory: a plain refusal and nothing is spawned', async () => {
  const vmStat = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 20000.\nPages inactive: 20000.\n'; // ~0.6 GB
  const { host, server } = setup({ vmStat });
  await assert.rejects(() => server.ensure(woof4), (e) => {
    assert.equal(e.kind, 'model_unavailable');
    assert.match(e.message, /There isn't enough free memory to open Underdog Woof 4B 1\.1 \(it needs about 3\.0 GB, about 0\.6 GB is free\)\. Close some apps and try again\./);
    return true;
  });
  assert.equal(modelSpawns(host).length, 0);
  assert.equal(server.state().state, 'stopped');
});

test('a child that dies while opening reports its own error text', async () => {
  const { host, server } = setup();
  host.spawnImpl = async () => { const p = fakeProc({ pid: 4999 }); p.stderr = 'Traceback...\nValueError: Model type qwen9 not supported.'; setTimeout(() => p.die(1), 0); return p; };
  host.readyAfterPolls = 1e9;
  await assert.rejects(() => server.ensure(woof4), /The model stopped while opening: .*Model type qwen9 not supported/);
});

test('a server that never answers is given up on, killed, and says so', async () => {
  const { host, server } = setup({ readyAfterPolls: 1e9 });
  await assert.rejects(() => server.ensure(woof4), (e) => e.kind === 'timeout' && /didn't open within/.test(e.message));
  assert.equal(host.procs[0].killed, true);
});

test('missing python or mlx-lm is reported plainly and nothing is spawned', async () => {
  const noPython = setup({ stats: {} });
  await assert.rejects(() => noPython.server.ensure(woof4), /The Python for local models wasn't found at/);
  assert.equal(modelSpawns(noPython.host).length, 0);
  const noMlx = setup({ stats: { [PY]: { size: 1, dir: false } } });
  await assert.rejects(() => noMlx.server.ensure(woof4), /need mlx-lm, which isn't installed/);
});

test('dispose kills the child and refuses further starts', async () => {
  const { host, server } = setup();
  await server.ensure(woof4);
  await server.dispose();
  assert.equal(host.procs[0].killed, true);
  assert.equal(host.fs.files.has('/data/local-server.json'), false);
  await assert.rejects(() => server.ensure(woof4), /closing/);
});

test('a stale pid file from a dead sidecar is reaped on the next start, only if it is still an mlx_lm.server', async () => {
  const stale = JSON.stringify({ pid: 777, model: 'x', port: 8700 });
  const mine = setup({ files: { '/data/local-server.json': stale }, psOutput: '/x/python -m mlx_lm.server --model m' });
  await mine.server.ensure(woof4);
  assert.deepEqual(mine.host.killed, ['777']);
  const other = setup({ files: { '/data/local-server.json': stale }, psOutput: '/usr/bin/vim notes.txt' });
  await other.server.ensure(woof4);
  assert.deepEqual(other.host.killed, [], 'a recycled pid that now belongs to something else is left alone');
});

test('a leftover server is reaped before the memory check, so its own memory cannot block the new start', async () => {
  const stale = JSON.stringify({ pid: 777, model: 'x', port: 8700 });
  const base = setup({ files: { '/data/local-server.json': stale }, psOutput: '/x/python -m mlx_lm.server --model m' });
  let freed = false;
  const orig = base.host.spawn;
  const server = createLocalServer({
    platform: { spawn: (s) => { if (s.cmd === '/bin/kill') freed = true; return orig(s); }, fetch: (u) => base.host.fetch(u), fs: base.host.fs },
    dataDir: '/data', home: HOME, timers: base.clock, pickPort: async () => 8750, pollMs: 10, startTimeoutMs: 100, reapWaitMs: 0,
    settings: async () => ({ ...DEFAULT_LOCAL }), memory: async () => (freed ? 20e9 : 1e9),
  });
  await server.ensure(woof4);
  assert.equal(freed, true);
});

test('checkMlx and pythonFor', async () => {
  assert.equal(pythonFor({ python: null }, '/h'), '/h/woof-bench/.venv/bin/python');
  assert.equal(pythonFor({ python: '/opt/py' }, '/h'), '/opt/py');
  const fs = { stat: async (p) => (p === '/v/bin/python' ? { size: 1, dir: false } : null), list: async () => [] };
  assert.deepEqual(await checkMlx(fs, '/v/bin/python'), { ok: true }, 'no venv lib folder: trust an existing python');
  assert.deepEqual(await checkMlx({ ...fs, stat: async () => null }, '/v/bin/python'), { ok: false, reason: 'no_python' });
});

test('swap nearly full: a model that fits on paper is refused before anything is spawned', async () => {
  const { host, server } = setup({ swapUsage: 'total = 16384.00M  used = 15076.38M  free = 1307.62M  (encrypted)', vmStat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4677.\nPages inactive: 157478.\nPages speculative: 3536.\n' });
  await assert.rejects(server.ensure(woof4), (e) => e.tooBig === true && /enough free memory/.test(e.message));
  assert.equal(modelSpawns(host).length, 0);
});
