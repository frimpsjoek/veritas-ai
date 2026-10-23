// Keys kept hidden (server spec 020 G1, G2): the secret store, keys moving out of settings.json, and the UI's
// view. The Keychain is a fake `security` process here; the live check on a real Keychain is in the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore, lastFour, SecretError } from '../src/secrets.js';
import { createSettingsStore, viewSettings, viewMcpConfig } from '../src/settings.js';
import { memoryFs } from './support/memory-fs.mjs';

/** A platform whose `security` keeps items in a Map, and records every call (args and what came on stdin). */
function fakeKeychainPlatform() {
  const items = new Map();
  const calls = [];
  const fs = memoryFs();
  return {
    items, calls, fs, homeDir: '/home/me',
    async which(names) { return names.includes('/usr/bin/security') ? '/usr/bin/security' : null; },
    async spawn({ cmd, args }) {
      assert.equal(cmd, '/usr/bin/security');
      let input = '';
      let done;
      const exited = new Promise((resolve) => { done = resolve; });
      const out = [];
      const call = { args, input: '' };
      calls.push(call);
      const account = (a) => a[a.indexOf('-a') + 1];
      const run = () => {
        if (args[0] === '-i') {
          call.input = input;
          const m = /^add-generic-password -U -s second-brain -a (\S+) -w "(.*)"\n?$/.exec(input);
          if (!m) return done(1);
          items.set(m[1], m[2]);
          return done(0);
        }
        if (args[0] === 'find-generic-password') {
          if (!items.has(account(args))) return done(44);
          out.push(items.get(account(args)));
          return done(0);
        }
        if (args[0] === 'delete-generic-password') return done(items.delete(account(args)) ? 0 : 44);
        return done(2);
      };
      if (args[0] !== '-i') queueMicrotask(run);
      return {
        lines() { return (async function* () { await exited; yield* out; })(); },
        async write(line) { input += `${line}\n`; },
        async closeInput() { run(); },
        stderrTail() { return ''; },
        async kill() {},
        exited,
      };
    },
  };
}

test('the Keychain store saves through stdin, never on the command line, and reads and removes', async () => {
  const platform = fakeKeychainPlatform();
  const store = createSecretStore(/** @type {any} */ (platform), '/data');
  assert.equal(await store.kind(), 'keychain');
  await store.set('openalex', 'sk-abcdefgh 12345678');
  assert.equal(platform.items.get('openalex'), 'sk-abcdefgh 12345678');
  assert.ok(platform.calls.every((c) => !c.args.join(' ').includes('12345678')), 'the key is never an argument');
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('openalex'), 'sk-abcdefgh 12345678');
  await store.remove('openalex');
  assert.equal(platform.items.has('openalex'), false);
  assert.equal(await createSecretStore(/** @type {any} */ (platform), '/data').get('openalex'), null);
  await store.remove('openalex');  // removing what is not there is fine
});

test('names and values that could not be passed safely are refused', async () => {
  const store = createSecretStore(/** @type {any} */ (fakeKeychainPlatform()), '/data');
  await assert.rejects(store.set('bad name', 'x'), SecretError);
  await assert.rejects(store.set('openalex', 'has"quote'), /cannot store safely/);
  await assert.rejects(store.set('openalex', 'back\\slash'), SecretError);
  await assert.rejects(store.set('openalex', 'two\nlines'), SecretError);
});

test('off a Mac the store is an owner-only file', async () => {
  const fs = memoryFs();
  const writes = [];
  const write = fs.writeAtomic;
  fs.writeAtomic = async (path, text, opts) => { writes.push({ path, opts }); return write(path, text); };
  const store = createSecretStore(/** @type {any} */ ({ fs, homeDir: '/home/me', async which() { return null; } }), '/data');
  assert.equal(await store.kind(), 'file');
  await store.set('endpoint:lm', 'key-0000111122223333');
  assert.deepEqual(writes.at(-1), { path: '/data/secrets.json', opts: { private: true } });
  assert.equal(await createSecretStore(/** @type {any} */ ({ fs, homeDir: '/', async which() { return null; } }), '/data').get('endpoint:lm'), 'key-0000111122223333');
});

test('keys written out in full before hidden-keys move into the store; the file keeps references, owner-only', async () => {
  const platform = fakeKeychainPlatform();
  const writes = [];
  const write = platform.fs.writeAtomic;
  platform.fs.writeAtomic = async (path, text, opts) => { writes.push(opts); return write(path, text); };
  platform.fs.files.set('/data/settings.json', JSON.stringify({
    openalex: { apiKey: 'oa-key-1234567890' },
    endpoints: [{ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', key: 'lm-key-abcdefghij' }],
    mcp: [{ name: 'nasa-ads', enabled: true, transport: 'stdio', command: 'npx', args: [], env: { ADS_API_KEY: 'ads-key-zzzzyyyy', REGION: 'us' } }],
  }));
  const secrets = createSecretStore(/** @type {any} */ (platform), '/data');
  const settings = createSettingsStore(platform.fs, '/data', { secrets });
  const s = await settings.get();
  assert.equal(s.openalex.apiKey, 'oa-key-1234567890', 'in memory the code that uses a key has it');
  assert.equal(s.endpoints[0].key, 'lm-key-abcdefghij');
  const file = platform.fs.files.get('/data/settings.json');
  for (const key of ['oa-key-1234567890', 'lm-key-abcdefghij', 'ads-key-zzzzyyyy']) assert.ok(!file.includes(key), `${key} left the file`);
  const saved = JSON.parse(file);
  assert.deepEqual(saved.openalex.apiKey, { secret: 'openalex', last4: '7890' });
  assert.deepEqual(saved.endpoints[0].key, { secret: 'endpoint:LM-Studio', last4: 'ghij' });
  assert.deepEqual(saved.mcp[0].env, { ADS_API_KEY: { secret: 'mcp:nasa-ads:env:ADS_API_KEY', last4: 'yyyy' }, REGION: 'us' });
  assert.deepEqual(writes.at(-1), { private: true });
  assert.equal(platform.items.get('mcp:nasa-ads:env:ADS_API_KEY'), 'ads-key-zzzzyyyy');
  // a fresh process reads the references back into values
  const again = await createSettingsStore(platform.fs, '/data', { secrets: createSecretStore(/** @type {any} */ (platform), '/data') }).get();
  assert.equal(again.mcp[0].env.ADS_API_KEY, 'ads-key-zzzzyyyy');
});

test('the UI view hides every key; a marker sent back keeps it; removing an endpoint removes its key', async () => {
  const platform = fakeKeychainPlatform();
  const settings = createSettingsStore(platform.fs, '/data', { secrets: createSecretStore(/** @type {any} */ (platform), '/data') });
  await settings.update({ openalex: { apiKey: 'oa-key-1234567890' }, endpoints: [{ name: 'lm', baseUrl: 'http://x/v1', key: 'lm-key-abcdefghij' }] });
  const view = viewSettings(await settings.get());
  assert.ok(!JSON.stringify(view).includes('1234567890') && !JSON.stringify(view).includes('abcdefghij'));
  assert.deepEqual(view.endpoints[0].key, { set: true, last4: 'ghij' });
  await settings.update({ endpoints: [{ ...view.endpoints[0], baseUrl: 'http://y/v1' }] });  // edit the address, keep the key
  assert.equal((await settings.get()).endpoints[0].key, 'lm-key-abcdefghij');
  await settings.update({ endpoints: [] });
  assert.equal(platform.items.has('endpoint:lm'), false);

  await settings.saveMcpServer({ name: 'exa', enabled: true, transport: 'stdio', command: 'npx', args: [], env: { EXA_API_KEY: 'exa-key-00001111' } });
  const shown = viewMcpConfig((await settings.get()).mcp[0]);
  assert.deepEqual(shown.env, { EXA_API_KEY: { set: true, last4: '1111' } });
  const full = await settings.saveMcpServer({ ...shown, trustUnmarked: true });  // "Trust it" round-trips the view
  assert.equal(full.env.EXA_API_KEY, 'exa-key-00001111');
  assert.equal(lastFour('short'), '', 'a short key shows nothing');
});

test('the Connect guide fills a catalog entry: prefix, trimming, optional and required fields, email check', async () => {
  const { catalogEntry, applySetup, setupMissing } = await import('../src/catalog.js');
  const exa = /** @type {any} */ (catalogEntry('exa'));
  assert.deepEqual(setupMissing(exa, {}), ['Exa API key']);
  assert.deepEqual(applySetup(exa, { Authorization: '  exa-123  ' }).headers, { Authorization: 'Bearer exa-123' });
  const pubmed = /** @type {any} */ (catalogEntry('pubmed'));
  assert.deepEqual(setupMissing(pubmed, {}), [], 'an optional key may stay empty');
  assert.deepEqual(applySetup(pubmed, {}).env, { MCP_TRANSPORT_TYPE: 'stdio' });
  const unpaywall = /** @type {any} */ (catalogEntry('unpaywall'));
  assert.deepEqual(setupMissing(unpaywall, { UNPAYWALL_EMAIL: 'not-an-email' }), ['Your email']);
  assert.deepEqual(setupMissing(unpaywall, { UNPAYWALL_EMAIL: 'me@uni.edu' }), []);
  // the key is secret once saved; the email is not
  const platform = fakeKeychainPlatform();
  const settings = createSettingsStore(platform.fs, '/data', { secrets: createSecretStore(/** @type {any} */ (platform), '/data') });
  await settings.saveMcpServer(applySetup(exa, { Authorization: 'exa-key-99998888' }));
  await settings.saveMcpServer(applySetup(unpaywall, { UNPAYWALL_EMAIL: 'me@uni.edu' }));
  const file = platform.fs.files.get('/data/settings.json');
  assert.ok(!file.includes('exa-key-99998888') && file.includes('me@uni.edu'));
  assert.equal(platform.items.get('mcp:exa:header:Authorization'), 'Bearer exa-key-99998888');
});

test('no Keychain for this login: the key goes to the owner-only file and reads back from it', async () => {
  const fs = memoryFs();
  const platform = {
    fs, homeDir: '/home/me',
    async which() { return '/usr/bin/security'; },
    async spawn({ args }) {
      const code = args[0] === '-i' ? 36 : 44;
      return {
        lines() { return (async function* () {})(); },
        async write() {}, async closeInput() {},
        exited: Promise.resolve(code),
        stderrTail() { return args[0] === '-i' ? 'security: SecKeychainItemCreateFromContent (<default>): A keychain cannot be found to store "mcp:valency:header:Authorization".' : ''; },
      };
    },
  };
  const store = createSecretStore(platform, '/data');
  await store.set('mcp:valency:header:Authorization', 'Bearer tok_123');
  const again = createSecretStore(platform, '/data');
  assert.equal(await again.get('mcp:valency:header:Authorization'), 'Bearer tok_123');
  await again.remove('mcp:valency:header:Authorization');
  assert.equal(await createSecretStore(platform, '/data').get('mcp:valency:header:Authorization'), null);
});

test('any other Keychain error still says so', async () => {
  const platform = {
    fs: memoryFs(), homeDir: '/home/me',
    async which() { return '/usr/bin/security'; },
    async spawn() {
      return { lines() { return (async function* () {})(); }, async write() {}, async closeInput() {}, exited: Promise.resolve(1), stderrTail() { return 'security: disk full'; } };
    },
  };
  await assert.rejects(createSecretStore(platform, '/data').set('k', 'v'), (e) => e instanceof SecretError && /disk full/.test(e.message));
});
