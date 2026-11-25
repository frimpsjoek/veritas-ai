// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  /** @param {string} name */
  getAttribute(name) { return this.attributes[name] ?? null; }
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
  return nodes.find((node) => node.tagName === 'a' && node.textContent === 'Continue with Globus');
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

test('empty access code explains what to enter without posting', async () => {
  const env = environment(() => response({ enabled: false }));
  await startLogin({ win: env.win, fetch: env.win.fetch });
  const form = env.nodes().find((node) => node.tagName === 'form');
  form.listeners.submit({ preventDefault() {} });
  const message = env.nodes().find((node) => node.className === 'sbw-auth-status');
  assert.match(message.textContent, /Enter the access code/);
  assert.equal(message.getAttribute('data-tone'), 'error');
  assert.equal(env.calls.filter(({ init }) => init.method === 'POST').length, 0);
});

// Why: the sign-in page once carried its own fixed palette, which made the front door a different product from the
// app behind it (and broke dark mode). It has to stay on --sb-ui-*, the same four neutrals and one accent as the app.
test('the sign-in sheet stays inside the app token system', () => {
  const css = readFileSync(new URL('../src/shell.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* The hosted sign-in (login.js)');
  const end = css.indexOf('/* setup-view.js', start);
  assert.ok(start >= 0 && end > start, 'the sign-in block is still delimited in shell.css');
  const block = css.slice(start, end);
  assert.equal(block.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'no literal colours: light and dark come from the tokens');
  assert.equal(block.match(/gradient\(/g), null, 'spec 013 ledger 11: no gradients');
  assert.ok(block.includes('background: var(--sb-ui-bg)'), 'the page sits on the app background');
});

test('the page names the task and the product in plain words', async () => {
  const env = environment(() => response({ enabled: false }));
  await startLogin({ win: env.win, fetch: env.win.fetch });
  const nodes = env.nodes();
  const headings = nodes.filter((node) => node.tagName === 'h1');
  assert.equal(headings.length, 1);
  assert.equal(headings[0].textContent, 'Sign in to Veritas');
  assert.equal(nodes.find((node) => node.tagName === 'button').textContent, 'Sign in');
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
