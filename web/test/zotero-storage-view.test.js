// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoteroStorageWidget, formatBytes } from '../src/zotero-storage-view.js';
import { ROWS } from '../../ui/src/settings/settings-schema.js';

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

function environment(reply = {}) {
  const doc = {
    confirmCalls: [],
    createElementNS(_namespace, tag) { return new FakeNode(tag); },
  };
  doc.defaultView = {
    confirm(message) { doc.confirmCalls.push(message); return reply.confirm ?? true; },
  };
  const status = reply.status ?? { enabled: true, issued: false, user_used: 0,
    user_quota: 5 * 1024 ** 3, pool_quota: 50 * 1024 ** 3 };
  const calls = [];
  const issued = reply.issued ?? { username: 'vyt_personal', password: 'only-once-secret',
    endpoint: 'https://veritas.example/webdav/vyt_personal' };
  const host = {
    async json(path, method = 'GET', body = undefined) {
      calls.push({ path, method, body });
      if (path === '/zotero-storage' && method === 'GET') return status;
      if (path === '/zotero-storage/credentials' && method === 'POST') {
        if (reply.issueError) throw new Error(reply.issueError);
        status.issued = true;
        return issued;
      }
      if (path === '/zotero-storage/credentials' && method === 'DELETE') return { ok: true };
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  return { doc, host, calls, issued, status };
}

function nodes(root) {
  const found = [];
  function walk(node) {
    found.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(root);
  return found;
}
function text(root) { return nodes(root).map((n) => n.textContent).filter(Boolean).join('\n'); }
function byText(root, content) { return nodes(root).find((n) => n.textContent === content); }
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('formatBytes reports the user quota without disclosing aggregate pool use', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GiB');
  const env = environment({ status: { enabled: true, issued: true, user_used: 5 * 1024 ** 2,
    user_quota: 5 * 1024 ** 3, pool_quota: 50 * 1024 ** 3 } });
  const root = zoteroStorageWidget(env.doc, env.host);
  env.root = root;
  return flush().then(() => {
    assert.match(text(root), /5.0 MiB of 5.0 GiB used/);
    assert.match(text(root), /Pool capacity: 50.0 GiB/);
    assert.doesNotMatch(text(root), /pool used/i);
  });
});

test('disabled configuration is read-only and makes no issuance request', async () => {
  const env = environment({ status: { enabled: false, issued: false, user_used: 0,
    user_quota: 5 * 1024 ** 3, pool_quota: 50 * 1024 ** 3 } });
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  assert.match(text(root), /not configured/);
  assert.equal(env.calls.length, 1);
  assert.equal(byText(root, 'Create WebDAV credentials'), undefined);
});

test('configured but unavailable storage is reported as unavailable, not unconfigured', async () => {
  const env = environment({ status: { enabled: false, issued: false, user_used: 0,
    user_quota: 5 * 1024 ** 3, pool_quota: 50 * 1024 ** 3,
    error: 'Zotero file storage is unavailable' } });
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  assert.match(text(root), /status is unavailable/);
  assert.doesNotMatch(text(root), /not configured/);
  assert.equal(byText(root, 'Create WebDAV credentials'), undefined);
});

test('pending first status is neutral, not reported as unconfigured', async () => {
  const env = environment();
  let resolveStatus;
  env.host.json = () => new Promise((resolve) => { resolveStatus = resolve; });
  const root = zoteroStorageWidget(env.doc, env.host);
  assert.match(text(root), /Checking Zotero file sync status/);
  assert.doesNotMatch(text(root), /not configured/);
  assert.equal(byText(root, 'Create WebDAV credentials'), undefined);
  resolveStatus(env.status);
  await flush();
  assert.doesNotMatch(text(root), /Checking Zotero file sync status/);
  assert.ok(byText(root, 'Create WebDAV credentials'));
});

test('issuance shows personal endpoint and password once, then hides it on refresh', async () => {
  const env = environment();
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  const create = byText(root, 'Create WebDAV credentials');
  assert.ok(create);
  await create.listeners.click();
  await flush();
  assert.deepEqual(env.calls[1], { path: '/zotero-storage/credentials', method: 'POST', body: {} });
  assert.match(text(root), /only-once-secret/);
  assert.match(text(root), /https:\/\/veritas.example\/webdav\/vyt_personal/);
  assert.match(text(root), /Zotero appends zotero\//);
  assert.match(text(root), /personal library attachments/);
  const hide = byText(root, 'Hide credentials and refresh');
  assert.ok(hide);
  await hide.listeners.click();
  await flush();
  assert.doesNotMatch(text(root), /only-once-secret/);
  assert.equal(env.status.issued, true);
});

test('hide removes the secret before a stalled status refresh resolves', async () => {
  const env = environment();
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  await byText(root, 'Create WebDAV credentials').listeners.click();
  await flush();
  assert.match(text(root), /only-once-secret/);
  let resolveStatus;
  env.host.json = () => new Promise((resolve) => { resolveStatus = resolve; });
  byText(root, 'Hide credentials and refresh').listeners.click();
  assert.doesNotMatch(text(root), /only-once-secret/);
  resolveStatus(env.status);
  await flush();
  assert.equal(env.status.issued, true);
});

test('revocation clears the secret before a stalled DELETE resolves', async () => {
  const env = environment();
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  await byText(root, 'Create WebDAV credentials').listeners.click();
  await flush();
  assert.match(text(root), /only-once-secret/);
  let resolveDelete;
  env.host.json = (path, method) => {
    if (method === 'DELETE') return new Promise((resolve) => { resolveDelete = resolve; });
    if (method === 'GET') return Promise.resolve(env.status);
    throw new Error(`unexpected ${method} ${path}`);
  };
  byText(root, 'Revoke WebDAV credentials').listeners.click();
  assert.doesNotMatch(text(root), /only-once-secret/);
  resolveDelete({ ok: true });
  await flush();
});

test('rotation and revocation require confirmation and safe errors are text-only', async (context) => {
  const env = environment({ status: { enabled: true, issued: true, user_used: 0,
    user_quota: 5 * 1024 ** 3, pool_quota: 50 * 1024 ** 3 } });
  const root = zoteroStorageWidget(env.doc, env.host);
  await flush();
  const rotate = byText(root, 'Rotate WebDAV credentials');
  await rotate.listeners.click();
  await flush();
  assert.equal(env.doc.confirmCalls.length, 1);
  assert.equal(byText(root, 'Revoke WebDAV credentials') !== undefined, true, 'rotation keeps a configured status');
  const revoke = byText(root, 'Revoke WebDAV credentials');
  context.mock.method(env.host, 'json', async () => { throw new Error('<b>unsafe server text</b>'); });
  await revoke.listeners.click();
  await flush();
  assert.equal(env.doc.confirmCalls.length, 2);
  assert.match(text(root), /<b>unsafe server text<\/b>/);
  assert.equal(nodes(root).some((n) => n.tagName === 'b'), false);
});

test('schema registers the web-only Zotero storage renderer and no persisted keys', () => {
  const row = ROWS.find((r) => r.id === 'folders.zoteroStorage');
  assert.ok(row);
  assert.equal(row.custom, 'zoteroStorage');
  assert.deepEqual(row.hosts, ['web']);
  assert.equal(row.store, 'none');
  assert.equal(Object.hasOwn(row, 'key'), false);
});
