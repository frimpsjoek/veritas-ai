// Keys on Windows and Linux (spec 024 G2): Windows Credential Manager through PowerShell, the Linux Secret Service
// through secret-tool, and the owner-only file when neither is usable. Every store is a fake process here; the key
// must reach it on stdin, never on the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore } from '../src/secrets.js';
import { memoryFs } from './support/memory-fs.mjs';

/** A fake child: `answer({ args, input })` returns { code, out?, err? } once stdin is closed (or at once with no input). */
function child(spec, answer, calls) {
  let input = '';
  let done;
  const exited = new Promise((resolve) => { done = resolve; });
  const out = [];
  let err = '';
  const call = { cmd: spec.cmd, args: spec.args, input: '' };
  calls.push(call);
  const run = () => {
    call.input = input;
    const r = answer(call);
    if (r.out !== undefined) out.push(...r.out.split('\n'));
    err = r.err ?? '';
    done(r.code);
  };
  let started = false;
  const start = () => { if (!started) { started = true; run(); } };
  setTimeout(start, 5);  // a command that reads no stdin answers on its own
  return {
    lines() { return (async function* () { await exited; yield* out; })(); },
    async write(line) { input += `${line}\n`; },
    async closeInput() { start(); },
    stderrTail() { return err; },
    async kill() {},
    get exited() { return exited; },
  };
}

/** @param {string} os @param {string[]} installed @param {(call: any) => any} answer */
function fakePlatform(os, installed, answer) {
  const calls = [];
  return {
    os, calls, fs: memoryFs(), homeDir: '/home/me',
    async which(names) { return names.find((n) => installed.includes(n)) ?? null; },
    async spawn(spec) { return child(spec, answer, calls); },
  };
}

/** secret-tool with a keyring in a Map: store reads the secret from stdin, lookup prints it, clear removes it. */
function secretTool(items) {
  return ({ args, input }) => {
    const account = args[args.indexOf('account') + 1];
    if (args[0] === 'store') { items.set(account, input.replace(/\n$/, '')); return { code: 0 }; }
    if (args[0] === 'lookup') return items.has(account) ? { code: 0, out: items.get(account) } : { code: 1 };
    if (args[0] === 'clear') { items.delete(account); return { code: 0 }; }
    return { code: 2 };
  };
}

test('Linux: keys go to the Secret Service through secret-tool, the key on stdin', async () => {
  const items = new Map();
  const platform = fakePlatform('linux', ['secret-tool', '/usr/bin/security'], secretTool(items));
  const store = createSecretStore(/** @type {any} */ (platform), '/data');
  assert.equal(await store.kind(), 'secret-service');
  await store.set('openalex', 'sk-abcdefgh 12345678');
  assert.equal(items.get('openalex'), 'sk-abcdefgh 12345678');
  assert.ok(platform.calls.every((c) => c.cmd === 'secret-tool'), 'never the macOS security command');
  assert.ok(platform.calls.every((c) => !c.args.join(' ').includes('12345678')), 'the key is never an argument');
  assert.deepEqual(platform.calls[0].args.slice(-4), ['service', 'second-brain', 'account', 'openalex']);
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('openalex'), 'sk-abcdefgh 12345678');
  await store.remove('openalex');
  assert.equal(items.has('openalex'), false);
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('openalex'), null);
  assert.equal(platform.fs.files.has('/data/secrets.json'), false, 'nothing in the file');
});

test('Linux without a Secret Service (no D-Bus session, as over SSH): the owner-only file', async () => {
  const platform = fakePlatform('linux', ['secret-tool'], ({ args }) => (args[0] === 'store'
    ? { code: 1, err: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' } : { code: 1 }));
  const store = createSecretStore(/** @type {any} */ (platform), '/data');
  await store.set('endpoint:lm', 'key-0000111122223333');
  assert.deepEqual(JSON.parse(platform.fs.files.get('/data/secrets.json')), { 'endpoint:lm': 'key-0000111122223333' });
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('endpoint:lm'), 'key-0000111122223333');
});

test('Linux without secret-tool: the owner-only file', async () => {
  const platform = fakePlatform('linux', [], () => assert.fail('nothing is spawned'));
  const store = createSecretStore(/** @type {any} */ (platform), '/data');
  assert.equal(await store.kind(), 'file');
  await store.set('openalex', 'oa-key-1234567890');
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('openalex'), 'oa-key-1234567890');
});

/** PowerShell with Credential Manager in a Map. The script comes as -EncodedCommand (UTF-16LE, base64). */
function powershell(items, { unusable = false } = {}) {
  return ({ args, input }) => {
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    assert.equal(args[4], '-EncodedCommand');
    const script = Buffer.from(args[5], 'base64').toString('utf16le');
    if (unusable) return { code: 3, err: 'no credential manager: Unable to find type [Windows.Security.Credentials.PasswordVault].' };
    const op = /\$op = '(\w+)'/.exec(script)?.[1];
    const name = /\$name = '([^']+)'/.exec(script)?.[1];
    assert.ok(script.includes("'second-brain'"), 'the service name');
    if (op === 'set') { items.set(name, input.replace(/\r?\n$/, '')); return { code: 0 }; }
    if (op === 'get') return items.has(name) ? { code: 0, out: items.get(name) } : { code: 44 };
    if (op === 'remove') return items.delete(name) ? { code: 0 } : { code: 44 };
    return { code: 2 };
  };
}

test('Windows: keys go to Credential Manager through PowerShell, the key on stdin', async () => {
  const items = new Map();
  const platform = fakePlatform('win32', ['powershell.exe'], powershell(items));
  const store = createSecretStore(/** @type {any} */ (platform), 'C:/Users/me/veritas');
  assert.equal(await store.kind(), 'credential-manager');
  await store.set('mcp:exa:header:Authorization', 'Bearer exa-key-99998888');
  assert.equal(items.get('mcp:exa:header:Authorization'), 'Bearer exa-key-99998888');
  for (const c of platform.calls) {
    assert.equal(c.cmd, 'powershell.exe');
    assert.ok(!Buffer.from(c.args[5], 'base64').toString('utf16le').includes('99998888'), 'the key is not in the script');
    assert.ok(!c.args.join(' ').includes('99998888'), 'nor any argument');
  }
  const again = createSecretStore(/** @type {any} */ (platform), 'C:/Users/me/veritas');
  assert.equal(await again.get('mcp:exa:header:Authorization'), 'Bearer exa-key-99998888');
  await again.remove('mcp:exa:header:Authorization');
  await again.remove('mcp:exa:header:Authorization');  // removing what is not there is fine
  assert.equal(await createSecretStore(/** @type {any} */ (platform), 'C:/Users/me/veritas').get('mcp:exa:header:Authorization'), null);
});

test('Windows where Credential Manager cannot be reached: the owner-only file', async () => {
  const platform = fakePlatform('win32', ['powershell.exe'], powershell(new Map(), { unusable: true }));
  const store = createSecretStore(/** @type {any} */ (platform), 'C:/data');
  await store.set('openalex', 'oa-key-1234567890');
  assert.deepEqual(JSON.parse(platform.fs.files.get('C:/data/secrets.json')), { openalex: 'oa-key-1234567890' });
  assert.equal(await createSecretStore(/** @type {any} */ (platform), 'C:/data').get('openalex'), 'oa-key-1234567890');
});

test('a store that fails for another reason still says so, naming the store', async () => {
  const platform = fakePlatform('linux', ['secret-tool'], () => ({ code: 1, err: 'secret-tool: disk full' }));
  await assert.rejects(createSecretStore(/** @type {any} */ (platform), '/data').set('k', 'v'),
    (e) => /Secret Service/.test(e.message) && /disk full/.test(e.message));
});
