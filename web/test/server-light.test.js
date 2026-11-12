// @ts-check
// The server light in the window's top corner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_MS, lightState, serverLight } from '../src/server-light.js';

function fakeDoc() {
  const element = () => {
    const classes = new Set();
    /** @type {Record<string, ((event?: any) => any)[]>} */ const on = {};
    const el = {
      attrs: /** @type {Record<string, string>} */ ({}), title: '', className: '', hidden: false, disabled: false, type: '', _text: '', kids: /** @type {any[]} */ ([]),
      classList: { toggle: (/** @type {string} */ c, /** @type {boolean} */ add) => { if (add) classes.add(c); else classes.delete(c); }, contains: (/** @type {string} */ c) => classes.has(c) },
      setAttribute(/** @type {string} */ k, /** @type {string} */ v) { el.attrs[k] = v; },
      removeAttribute(/** @type {string} */ k) { delete el.attrs[k]; },
      append(/** @type {any[]} */ ...nodes) { el.kids.push(...nodes); },
      replaceChildren(/** @type {any[]} */ ...nodes) { el.kids = nodes; },
      contains: () => true,
      addEventListener(/** @type {string} */ type, /** @type {(event?: any) => any} */ fn) { (on[type] ??= []).push(fn); },
      click: () => Promise.all((on.click ?? []).map((fn) => fn({ stopPropagation() {} }))),
      set textContent(/** @type {string} */ v) { el._text = String(v); el.kids = []; },
      get textContent() { return el._text + el.kids.map((/** @type {any} */ k) => (typeof k === 'string' ? k : k.textContent ?? '')).join(''); },
    };
    return el;
  };
  return { createElementNS: element, addEventListener() {}, removeEventListener() {} };
}

function fakeHost({ answer = /** @type {any} */ ({ ok: true }), routines = /** @type {any[] | null} */ (null) } = {}) {
  let where = 'server';
  const listeners = new Set();
  const asked = /** @type {string[]} */ ([]);
  const host = {
    asked, answer,
    where: () => where,
    onWhereChange(/** @type {() => void} */ fn) { listeners.add(fn); return () => listeners.delete(fn); },
    json: async (/** @type {string} */ path) => { asked.push(path); if (where === 'offline') throw new Error('no answer'); return host.answer; },
    ...(routines ? { ai: async () => ({ routines: { list: async () => routines } }) } : {}),
    set(/** @type {string} */ next) { where = next; for (const fn of listeners) fn(); },
    listeners,
  };
  return host;
}

function fakeClock() {
  const clock = { tick: /** @type {(() => void) | null} */ (null), every: 0, stopped: false, ms: Date.UTC(2026, 10, 4, 14, 41),
    now: () => clock.ms,
    setInterval(/** @type {() => void} */ fn, /** @type {number} */ ms) { clock.tick = fn; clock.every = ms; return 1; },
    clearInterval() { clock.stopped = true; } };
  return clock;
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
const hhmm = (/** @type {number} */ ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('the light has four states, each with its words and since-when', () => {
  const now = Date.UTC(2026, 10, 4, 14, 41);
  const up = lightState('server', { since: now });
  assert.equal(up.state, 'up');
  assert.equal(up.on, true);
  assert.equal(up.label, 'Veritas server is running');
  assert.equal(up.canTry, false);
  assert.equal(up.body, `Answering since ${hhmm(now)}.`);
  const down = lightState('offline', { since: now });
  assert.equal(down.state, 'down');
  assert.equal(down.on, false);
  assert.equal(down.label, "Can't reach the Veritas server");
  assert.equal(down.canTry, true);
  assert.match(down.body, new RegExp(`^Last answered at ${hhmm(now)}\\.`));
  const starting = lightState('server', { ready: false, since: now });
  assert.equal(starting.state, 'starting');
  assert.equal(starting.label, 'Veritas server is starting');
  const busy = lightState('server', { busy: 'Reading radar', since: now });
  assert.equal(busy.state, 'busy');
  assert.equal(busy.head, 'Reading radar is running');
  assert.equal(lightState('offline', { ready: false, busy: 'Reading radar' }).state, 'down', 'no answer beats whatever it last said');
  assert.equal(lightState('server', { ready: false, busy: 'Reading radar' }).state, 'starting');
});

test('the light follows the host, asks the server by itself, and stops when told', async () => {
  const host = fakeHost(), clock = fakeClock();
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  const root = /** @type {any} */ (light.root);
  const button = /** @type {any} */ (light.button);
  assert.equal(root.classList.contains('is-up'), true);
  assert.equal(button.title, 'Veritas server is running');
  host.set('offline');
  assert.equal(root.classList.contains('is-down'), true);
  assert.equal(root.classList.contains('is-up'), false);
  assert.equal(button.attrs['aria-label'], "Can't reach the Veritas server");
  host.set('server');
  assert.equal(root.classList.contains('is-up'), true);
  assert.equal(clock.every, CHECK_MS);
  host.asked.length = 0;
  clock.tick?.();
  await flush();
  assert.deepEqual(host.asked, ['/ping']);
  light.stop();
  assert.equal(clock.stopped, true);
  assert.equal(host.listeners.size, 0);
});

test('a ping saying ready: false is "starting"; no ready field at all means ready', async () => {
  const host = fakeHost({ answer: { ok: true, ready: false } }), clock = fakeClock();
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  await flush();
  assert.equal(/** @type {any} */ (light.root).classList.contains('is-starting'), true);
  host.answer = { ok: true };
  clock.tick?.();
  await flush();
  assert.equal(/** @type {any} */ (light.root).classList.contains('is-up'), true);
  light.stop();
});

test('a 503 from the ping is "starting" too: a phone or another origin gets that instead of ready: false', async () => {
  const host = fakeHost(), clock = fakeClock();
  const answered = host.json;
  host.json = async () => { throw Object.assign(new Error('the server is starting; try again in a moment'), { status: 503 }); };
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  await flush();
  assert.equal(/** @type {any} */ (light.root).classList.contains('is-starting'), true);
  host.json = answered;
  clock.tick?.();
  await flush();
  assert.equal(/** @type {any} */ (light.root).classList.contains('is-up'), true);
  light.stop();
});

test('busy comes from the routines the host can list; a host without them is simply up', async () => {
  const host = fakeHost({ routines: [{ id: 'r', name: 'Reading radar', running: true }] }), clock = fakeClock();
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  await flush();
  clock.tick?.();
  await flush();
  assert.equal(/** @type {any} */ (light.root).classList.contains('is-busy'), true);
  light.stop();
  const plain = fakeHost(), other = fakeClock();
  const second = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (plain), other);
  other.tick?.();
  await flush();
  assert.equal(/** @type {any} */ (second.root).classList.contains('is-up'), true);
  second.stop();
});

test('the popover says since when; Try now asks at once and says if there was still no answer', async () => {
  const host = fakeHost(), clock = fakeClock();
  const light = serverLight(/** @type {any} */ (fakeDoc()), /** @type {any} */ (host), clock);
  await flush();
  const button = /** @type {any} */ (light.button);
  clock.ms += 60000;
  host.set('offline');
  await button.click();
  assert.equal(button.attrs['aria-expanded'], 'true');
  const pop = /** @type {any} */ (light.pop);
  assert.match(pop.textContent, /The server is not answering/);
  assert.match(pop.textContent, /Try now/);
  host.asked.length = 0;
  const tryNow = pop.kids.find((/** @type {any} */ k) => typeof k !== 'string' && k.textContent.includes('Try now'));
  await tryNow.click();
  await flush();
  assert.deepEqual(host.asked, ['/ping']);
  assert.match(pop.textContent, /Still no answer/);
  light.stop();
});
