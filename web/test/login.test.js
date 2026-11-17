// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLogin } from '../src/login.js';

class FakeNode {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
  }

  /** @param {...any} nodes */
  append(...nodes) { this.children.push(...nodes); }
  /** @param {...any} nodes */
  replaceChildren(...nodes) { this.children = [...nodes]; }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) { this.attributes[name] = value; }
  /** @param {string} name @param {(...args: any[]) => any} callback */
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

function environment(reply) {
  const document = {
    body: new FakeNode('body'),
    createElementNS(_namespace, tag) { return new FakeNode(tag); },
  };
  const calls = [];
  const win = {
    document,
    location: {
      hash: '', pathname: '/app/login', search: '', origin: 'https://veritas.example',
      href: 'https://veritas.example/app/login', replaced: '',
      replace(value) { this.replaced = value; },
    },
    history: { replaceState() {} },
    async fetch(url, init) {
      calls.push({ url, init });
      return reply(url, init);
    },
  };
  const nodes = [];
  function walk(node) {
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(document.body);
  return { win, calls, nodes: () => { nodes.length = 0; walk(document.body); return nodes; } };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function globusLink(nodes) {
  return nodes.find((node) => node.tagName === 'a' && node.textContent === 'Sign in with Globus');
}

test('configured Globus login adds a same-origin independent sign-in link', async () => {
  const env = environment((url) => url === 'https://veritas.example/auth/globus/status'
    ? response({ enabled: true }) : response({}, 500));
  await startLogin({ win: env.win, fetch: env.win.fetch });
  const link = globusLink(env.nodes());
  assert.ok(link);
  assert.equal(link.href, '/auth/globus/login');
  assert.equal(link.rel, 'noopener');
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].init.credentials, 'same-origin');
  assert.ok(!JSON.stringify(link).includes('token'));
});

test('disabled or failed discovery leaves access-code login unchanged', async (context) => {
  for (const [name, reply] of [
    ['disabled', () => response({ enabled: false })],
    ['unreachable', () => { throw new Error('offline'); }],
    ['invalid', () => response({ enabled: 'yes' })],
  ]) {
    await context.test(name, async () => {
      const env = environment(reply);
      await startLogin({ win: env.win, fetch: env.win.fetch });
      assert.equal(globusLink(env.nodes()), undefined);
      assert.ok(env.nodes().some((node) => node.tagName === 'input' && node.type === 'password'));
      assert.equal(env.calls.length, 1);
    });
  }
});

test('access-code submit still posts once to the existing login route', async () => {
  const env = environment((url) => url === 'https://veritas.example/auth/globus/status'
    ? response({ enabled: false }) : response({ ok: true }));
  await startLogin({ win: env.win, fetch: env.win.fetch });
  const input = env.nodes().find((node) => node.tagName === 'input' && node.type === 'password');
  const form = env.nodes().find((node) => node.tagName === 'form');
  input.value = 'legacy-code';
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  const logins = env.calls.filter(({ init }) => init.method === 'POST');
  assert.equal(logins.length, 1);
  assert.equal(logins[0].url, 'https://veritas.example/app/login');
  assert.deepEqual(JSON.parse(logins[0].init.body), { token: 'legacy-code' });
  assert.equal(env.win.location.replaced, 'https://veritas.example/app/#/home');
});
