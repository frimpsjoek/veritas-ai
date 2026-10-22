// The not-installed error card: one button per AI that is ready; a click moves the Chat and Ask roles and asks again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchOptions, offerSwitch, NONE_READY, NOT_INSTALLED } from '../src/chat/provider-switch.js';

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.className = ''; this._text = ''; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { return this.listeners.click?.(); }
  all(tag) { return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.all(tag)]); }
}
const doc = { createElementNS: (_ns, tag) => new El(tag) };
El.prototype.querySelectorAll = function (sel) { return this.all(sel); };

const ready = (provider) => ({ provider, state: 'ready' });
const fake = (statuses, log = []) => ({
  doc, notice: log, localMenu: { refresh() { log.push('menu refreshed'); } },
  host: {
    notice: (m) => log.push(`notice: ${m}`),
    ai: async () => ({ providers: { status: async () => statuses, setRole: async (role, choice) => { log.push(['setRole', role, choice]); } } }),
  },
});

test('the error kind is the structural code the providers report', () => assert.equal(NOT_INSTALLED, 'not_installed'));

test('only ready AIs become buttons, Codex and Claude before On this Mac', () => {
  const options = switchOptions([ready('local'), { provider: 'codex', state: 'missing' }, ready('claude'), { provider: 'oss:box', state: 'signed_out' }]);
  assert.deepEqual(options.map((o) => o.label), ['Use Claude instead', 'Use On this Mac (local) instead']);
  assert.deepEqual(options.map((o) => o.choice), [{ provider: 'claude', model: null }, { provider: 'local', model: null }]);
  assert.deepEqual(switchOptions(null), []);
});

test('buttons render in the error card; a click sets chat and ask, then asks the same question again', async () => {
  const log = [];
  const view = fake([ready('claude'), ready('local')], log);
  const box = new El('div');
  await offerSwitch(view, box, async () => { log.push('resent'); });
  const buttons = box.all('button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Use Claude instead', 'Use On this Mac (local) instead']);
  assert.equal(buttons[0].style.whiteSpace, 'normal');
  await buttons[0].click();
  assert.deepEqual(log, [['setRole', 'chat', { provider: 'claude', model: null }], ['setRole', 'ask', { provider: 'claude', model: null }], 'menu refreshed', 'resent']);
  assert.match(box.textContent, /Switched to Claude\. Asking again/);
  assert.equal(box.all('button').length, 0);
});

test('with no AI ready it says where to add one', async () => {
  const box = new El('div');
  await offerSwitch(fake([{ provider: 'codex', state: 'missing' }]), box, async () => {});
  assert.equal(box.all('button').length, 0);
  assert.equal(box.textContent, NONE_READY);
  assert.equal(NONE_READY, 'No AI is set up yet. Open Settings → AI to add one.');
});

test('a role that cannot be saved is reported, the buttons come back, and nothing is asked', async () => {
  const log = [];
  const view = fake([ready('claude')], log);
  view.host.ai = async () => ({ providers: { status: async () => [ready('claude')], setRole: async () => { throw new Error('disk full'); } } });
  const box = new El('div');
  await offerSwitch(view, box, async () => { log.push('resent'); });
  await box.all('button')[0].click();
  assert.deepEqual(log, ['notice: disk full']);
  assert.equal(box.all('button').length, 1);
  assert.equal(box.all('button')[0].attrs.disabled, undefined);
});

test('an unreadable status leaves the plain error alone', async () => {
  const view = fake([]);
  view.host.ai = async () => { throw new Error('down'); };
  const box = new El('div');
  await offerSwitch(view, box, undefined);
  assert.equal(box.children.length, 0);
});
