import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeckoPlatform } from '../src/gecko/platform.js';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';

function pipe(chunks) {
  const queue = [...chunks];
  return { async readString() { return queue.shift() ?? ''; }, writes: [], async write(s) { this.writes.push(s); }, async close() {} };
}

function fakeDeps({ stdout = [], stderr = [], files = {} } = {}) {
  const endpoints = {};
  const calls = [];
  const notFound = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
  const deps = {
    Subprocess: {
      async call(opts) {
        calls.push(opts);
        const stdin = pipe([]);
        return { stdout: pipe(stdout), stderr: pipe(stderr), stdin, async kill() { this.killed = true; }, async wait() { return { exitCode: 0 }; } };
      },
    },
    IOUtils: {
      async exists(p) { return p in files; },
      async readUTF8(p) { if (!(p in files)) throw notFound(); return files[p]; },
      async writeUTF8(p, text, opts = {}) { files[p] = opts.mode === 'appendOrCreate' ? (files[p] ?? '') + text : text; },
      async makeDirectory() {},
      async getChildren(dir) { const kids = Object.keys(files).filter((p) => p.startsWith(`${dir}/`)); if (!kids.length) throw notFound(); return kids; },
      async remove(p) { delete files[p]; },
    },
    PathUtils: { join: (...parts) => parts.join('/'), parent: (p) => p.slice(0, p.lastIndexOf('/')), filename: (p) => p.slice(p.lastIndexOf('/') + 1), isAbsolute: (p) => p.startsWith('/') },
    Zotero: { Server: { Endpoints: endpoints }, Prefs: { get: () => 23191 } },
    fetch: async () => null,
    env: (name) => (name === 'PATH' ? '/usr/bin:/bin' : undefined),
    homeDir: '/Users/me',
  };
  return { deps, endpoints, calls, files };
}

test('stdout lines survive chunks split mid-line, and the last unterminated line is kept', async () => {
  const { deps } = fakeDeps({ stdout: ['{"a":', '1}\n{"b"', ':2}\r\n{"c":3}'] });
  const child = await createGeckoPlatform(deps).spawn({ cmd: '/bin/x', args: [], env: {}, cwd: '/tmp' });
  const lines = [];
  for await (const line of child.lines()) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('spawn merges the env into Zotero\'s own and pipes stderr into a tail', async () => {
  const { deps, calls } = fakeDeps({ stderr: ['boom\n'] });
  const child = await createGeckoPlatform(deps).spawn({ cmd: '/bin/x', args: ['a'], env: { CODEX_HOME: '/h' }, cwd: '/w' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls[0].environmentAppend, true);
  assert.deepEqual(calls[0].environment, { CODEX_HOME: '/h' });
  assert.equal(calls[0].workdir, '/w');
  assert.equal(child.stderrTail(), 'boom\n');
});

test('which finds a bare name in ~/.local/bin although PATH does not list it', async () => {
  const { deps } = fakeDeps({ files: { '/Users/me/.local/bin/claude': '' } });
  const platform = createGeckoPlatform(deps);
  assert.equal(await platform.which(['/nope/claude', 'claude']), '/Users/me/.local/bin/claude');
  assert.equal(await platform.which(['missing']), null);
});

test('fs: missing files read as null, appends accumulate, list gives names', async () => {
  const { deps } = fakeDeps();
  const { fs } = createGeckoPlatform(deps);
  assert.equal(await fs.read('/d/none.jsonl'), null);
  await fs.append('/d/a.jsonl', 'one');
  await fs.append('/d/a.jsonl', 'two');
  assert.equal(await fs.read('/d/a.jsonl'), 'one\ntwo\n');
  assert.deepEqual(await fs.list('/d'), ['a.jsonl']);
  assert.deepEqual(await fs.list('/empty'), []);
});

test('serve mounts a Zotero.Server endpoint that answers MCP with the bearer token, and unmount removes it', async () => {
  const { deps, endpoints } = fakeDeps();
  const platform = createGeckoPlatform(deps);
  const library = { search: async () => [], read: async () => null, resolve: async () => new Map(), related: async () => [] };
  const gateway = await createToolGateway(async () => null, library, {});
  const mount = await platform.serve('/second-brain/mcp', createMcpHttpHandler(gateway));
  assert.equal(mount.url, 'http://127.0.0.1:23191/second-brain/mcp');
  const session = gateway.open({ scope: { kind: 'library' }, web: 'off', sources: { library: true, scholarly: false, web: false }, audit: 't' });
  const Endpoint = endpoints['/second-brain/mcp'];
  const call = (headers, data) => new Endpoint().init({ method: 'POST', headers, data });

  const [status, type, body] = await call({ authorization: `Bearer ${session.mcp.token}` }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(status, 200);
  assert.equal(type, 'application/json');
  assert.ok(JSON.parse(body).result.tools.every((t) => t.annotations.readOnlyHint === true));
  assert.equal((await call({ authorization: 'Bearer wrong' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }))[0], 401);
  assert.deepEqual(await call({}, { jsonrpc: '2.0', method: 'notifications/initialized' }), [202, 'application/json', '']);

  mount.unmount();
  assert.equal(endpoints['/second-brain/mcp'], undefined);
});
