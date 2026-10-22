// @ts-check
// ui-src/src/settings/connect-guide.js (server spec 020 G3). Connecting an outside source, step by step:
// what it gives you, where to get the key, paste it, connect and test, done. Keys typed here go to the Keychain
// through the runtime (settings.js) and come back only as { set: true, last4 }, so a saved key is replaced, never shown.
import { h } from '../dom.js';
import { applySetup, setupMissing } from '../../../agent-src/src/catalog.js';

/** A key as the UI gets it: null, or { set: true, last4 }. A plain string (an older runtime) counts as set. @param {unknown} v */
export function keyState(v) {
  if (v && typeof v === 'object' && /** @type {any} */ (v).set) return { set: true, last4: String(/** @type {any} */ (v).last4 ?? '') };
  return typeof v === 'string' && v.trim() ? { set: true, last4: '' } : null;
}

/** "Key saved (•••• a1b2)", or "" when there is none. @param {unknown} v */
export function keyLine(v) {
  const k = keyState(v);
  return k ? `Key saved${k.last4 ? ` (•••• ${k.last4})` : ''}` : '';
}

/** What went wrong, in words a person can act on. @param {string | null | undefined} detail */
export function plainError(detail) {
  const text = String(detail ?? '');
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]*key|api key/i.test(text)) return 'The key was refused. Check that you copied all of it.';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|timed? ?out|unreachable|network/i.test(text)) return "Couldn't reach it. Check the address and your connection.";
  if (/ENOENT|command not found|spawn .* not found|\b(npx|uvx)\b/i.test(text)) return "Its program couldn't start. It needs Node (npx) or uv (uvx) on the computer running Second Brain.";
  return text ? `Couldn't connect: ${text}` : "Couldn't connect.";
}

/** @param {Document} doc @param {string} text @param {() => void | Promise<void>} onClick @param {string} [cls] */
function button(doc, text, onClick, cls = 'sb-button') {
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', cls, text));
  b.type = 'button';
  b.addEventListener('click', () => void onClick());
  return b;
}

/** @param {Document} doc @param {string} label @param {string} type @param {string} [hint] */
function field(doc, label, type, hint) {
  const wrap = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbs-guide-field'));
  const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  input.type = type;
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrap.append(h(doc, 'span', 'sbs-label', label), input);
  if (hint) wrap.append(h(doc, 'span', 'sbs-help', hint));
  return { wrap, input };
}

/** Saves `config`, then reads the list back to say whether it connected. @param {any} host @param {any} config */
async function connectAndTest(host, config) {
  const ai = await host.ai();
  await ai.mcp.save(config);
  const report = (await ai.mcp.list()).find((/** @type {any} */ r) => r.config.name === config.name);
  if (report?.state === 'connected') {
    const usable = report.tools.filter((/** @type {any} */ t) => t.verdict === 'exposed').length;
    return { ok: true, text: `Connected · ${usable} usable tool${usable === 1 ? '' : 's'}` };
  }
  return { ok: false, text: plainError(report?.error ?? (report ? 'it did not answer' : 'it was not saved')) };
}

/**
 * The guide for one catalog entry. `existing` is the saved config when replacing a key: a key field left empty
 * keeps the saved key.
 * @param {Document} doc @param {any} host @param {import("../../../agent-src/src/catalog").CatalogEntry} entry
 * @param {{ existing?: any, onDone: () => void | Promise<void>, onCancel: () => void }} opts
 */
export function connectGuide(doc, host, entry, { existing, onDone, onCancel }) {
  const root = h(doc, 'div', 'sbs-guide');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `Connect ${entry.name}`);
  const steps = h(doc, 'ol', 'sbs-guide-steps');
  const what = h(doc, 'li', 'sbs-guide-step');
  what.append(h(doc, 'span', 'sbs-label', 'What it gives you'), h(doc, 'p', 'sbs-help', `${entry.description} ${entry.auth}`));
  steps.append(what);
  const getKey = entry.setup?.getKey;
  if (getKey) {
    const get = h(doc, 'li', 'sbs-guide-step');
    get.append(h(doc, 'span', 'sbs-label', 'Get the key'), h(doc, 'p', 'sbs-help', getKey.steps),
      button(doc, `Open ${new URL(getKey.url).hostname}`, () => host.openLink(getKey.url, { outside: true }), 'sb-button sbs-guide-open'));
    steps.append(get);
  }
  const inputs = /** @type {Record<string, HTMLInputElement>} */ ({});
  const fields = entry.setup?.fields ?? [];
  if (fields.length) {
    const paste = h(doc, 'li', 'sbs-guide-step');
    paste.append(h(doc, 'span', 'sbs-label', fields.some((f) => f.kind === 'key') ? 'Paste it here' : 'Fill in'));
    for (const f of fields) {
      const saved = existing ? (f.in === 'env' ? existing.env?.[f.name] : existing.headers?.[f.name]) : null;
      const hint = [f.optional ? 'Optional.' : '', f.kind === 'key' ? 'Kept in the Keychain; never shown again.' : '', keyLine(saved) ? `${keyLine(saved)}. Leave empty to keep it.` : ''].filter(Boolean).join(' ');
      const { wrap, input } = field(doc, f.label, f.kind === 'key' ? 'password' : 'email', hint);
      input.dataset.field = f.name;
      inputs[f.name] = input;
      paste.append(wrap);
    }
    steps.append(paste);
  }
  const status = h(doc, 'p', 'sbs-help sbs-guide-status');
  status.setAttribute('aria-live', 'polite');
  const connect = button(doc, 'Connect and test', async () => {
    const values = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
    // Replacing: an empty key field keeps the saved key (the runtime fills it back in from the Keychain).
    const keep = Object.fromEntries(fields.filter((f) => !values[f.name]?.trim() && keyState(existing?.[f.in === 'env' ? 'env' : 'headers']?.[f.name])).map((f) => [f.name, f]));
    const missing = setupMissing(entry, { ...values, ...Object.fromEntries(Object.keys(keep).map((k) => [k, 'kept'])) });
    if (missing.length) { status.className = 'sbs-help sbs-guide-status is-bad'; status.textContent = `Fill in: ${missing.join(', ')}.`; return; }
    const config = /** @type {any} */ (applySetup(entry, values));
    for (const f of Object.values(keep)) (f.in === 'env' ? config.env : config.headers)[f.name] = { set: true };
    if (existing?.trustUnmarked) config.trustUnmarked = true;
    connect.disabled = true;
    status.className = 'sbs-help sbs-guide-status';
    status.textContent = 'Connecting…';
    try {
      const result = await connectAndTest(host, config);
      status.className = `sbs-help sbs-guide-status${result.ok ? ' is-good' : ' is-bad'}`;
      status.textContent = result.ok ? `${result.text}. Done.` : result.text;
      for (const input of Object.values(inputs)) if (input.type === 'password') input.value = '';
      if (result.ok) await onDone();
    } catch (error) {
      status.className = 'sbs-help sbs-guide-status is-bad';
      status.textContent = plainError(String(/** @type {any} */ (error)?.message ?? error));
    }
    connect.disabled = false;
  }, 'sb-button is-primary');
  const actions = h(doc, 'div', 'sbs-guide-actions');
  actions.append(connect, button(doc, 'Cancel', onCancel));
  root.append(steps, actions, status);
  return root;
}

/** "Add your own": a name, an address (https://…) or a command (npx …), and an optional key.
 *  @param {Document} doc @param {any} host @param {{ onDone: () => void | Promise<void> }} opts */
export function customServerForm(doc, host, { onDone }) {
  const root = h(doc, 'div', 'sbs-guide sbs-guide-custom');
  const name = field(doc, 'Name', 'text', 'Short, like "my-search".');
  const where = field(doc, 'Address or command', 'text', 'An address such as https://example.org/mcp, or the command its README gives, such as npx -y some-mcp-server.');
  const key = field(doc, 'Key', 'password', 'Optional. Kept in the Keychain; never shown again.');
  const keyName = field(doc, 'Key goes in', 'text', 'For an address: the header (Authorization sends "Bearer <key>"). For a command: the variable its README names, such as EXAMPLE_API_KEY.');
  keyName.input.value = 'Authorization';
  where.input.addEventListener('input', () => {
    if (/^https?:\/\//i.test(where.input.value.trim())) { if (/_KEY$/.test(keyName.input.value)) keyName.input.value = 'Authorization'; }
    else if (keyName.input.value === 'Authorization') keyName.input.value = 'API_KEY';
  });
  const status = h(doc, 'p', 'sbs-help sbs-guide-status');
  status.setAttribute('aria-live', 'polite');
  const bad = (/** @type {string} */ text) => { status.className = 'sbs-help sbs-guide-status is-bad'; status.textContent = text; };
  const add = button(doc, 'Connect and test', async () => {
    const n = name.input.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    const target = where.input.value.trim();
    const k = key.input.value.trim();
    const slot = keyName.input.value.trim();
    if (!n) return bad('Give it a short name.');
    if (!target) return bad('Paste its address or command.');
    if (k && !slot) return bad('Say where the key goes.');
    const http = /^https?:\/\//i.test(target);
    const config = http
      ? { name: n, enabled: true, transport: 'http', url: target, headers: k ? { [slot]: slot.toLowerCase() === 'authorization' ? `Bearer ${k}` : k } : {} }
      : { name: n, enabled: true, transport: 'stdio', command: target.split(/\s+/)[0], args: target.split(/\s+/).slice(1), env: k ? { [slot]: k } : {} };
    add.disabled = true;
    status.className = 'sbs-help sbs-guide-status';
    status.textContent = 'Connecting…';
    try {
      const result = await connectAndTest(host, config);
      status.className = `sbs-help sbs-guide-status${result.ok ? ' is-good' : ' is-bad'}`;
      status.textContent = result.ok ? `${result.text}. Done.` : result.text;
      key.input.value = '';
      if (result.ok) await onDone();
    } catch (error) { bad(plainError(String(/** @type {any} */ (error)?.message ?? error))); }
    add.disabled = false;
  }, 'sb-button is-primary');
  root.append(name.wrap, where.wrap, key.wrap, keyName.wrap, add, status);
  return root;
}
