// @ts-check
// The server light in the window's top corner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_MS, lightState, serverLight } from '../src/server-light.js';

function fakeDoc() {
  const element = () => {
    const classes = new Set();
    return {
      attrs: /** @type {Record<string, string>} */ ({}), title: '', className: '',
      classList: { toggle: (/** @type {string} */ c, /** @type {boolean} */ on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (/** @type {string} */ c) => classes.has(c) },
      setAttribute(/** @type {string} */ k, /** @type {string} */ v) { this.attrs[k] = v; },
      append() {},
    };
  };
  return { createElementNS: element };
}

function fakeHost() {
  let where = 'server';
  const listeners = new Set();
  const asked = [];
  return {
    asked,
    where: () => where,
    onWhereChange(/** @type {() => void} */ fn) { listeners.add(fn); return () => listeners.delete(fn); },
    json: async (/** @type {string} */ path) => { asked.push(path); },
    set(/** @type {string} */ next) { where = next; for (const fn of listeners) fn(); },
    listeners,
  };
}

function fakeClock() {
  const clock = { tick: /** @type {(() => void) | null} */ (null), every: 0, stopped: false,
    setInterval(/** @type {() => void} */ fn, /** @type {number} */ ms) { clock.tick = fn; clock.every = ms; return 1; },
    clearInterval() { clock.stopped = true; } };
  return clock;
}

test('the light says whether the server answers', () => {
  assert.deepEqual(lightState('server'), { on: true, label: 'Veritas server is running' });
  assert.deepEqual(lightState('offline'), { on: false, label: "Can't reach the Veritas server" });
});

test('the light follows the host, asks the server by itself, and stops when told', async () => {
  const host = fakeHost(), clock = fakeClock();
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  const root = /** @type {any} */ (light.root);
  assert.equal(root.classList.contains('is-on'), true);
  assert.equal(root.title, 'Veritas server is running');
  host.set('offline');
  assert.equal(root.classList.contains('is-on'), false);
  assert.equal(root.attrs['aria-label'], "Can't reach the Veritas server");
  host.set('server');
  assert.equal(root.classList.contains('is-on'), true);
  assert.equal(clock.every, CHECK_MS);
  clock.tick?.();
  assert.deepEqual(host.asked, ['/ping']);
  light.stop();
  assert.equal(clock.stopped, true);
  assert.equal(host.listeners.size, 0);
});
