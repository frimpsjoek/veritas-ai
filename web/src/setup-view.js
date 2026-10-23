// @ts-check
// web/src/setup-view.js. The setup screen (Phase 3 Task 3): the servers this browser knows, which one is in use, and a
// form to add one (server address + access code). Shown on first launch when the app is not served by a server, after
// a 401 from a saved server, and inside Settings > Server and phone. Connecting tests the address and code first,
// then saves the server, makes it current and reloads, so nothing of the previous server stays on screen.
import { h } from '../../ui/src/dom.js';
import { createFetchApi } from './transport.js';
import { CURRENT_KEY, HTTPS_WARNING, loadServers, needsHttpsWarning, normaliseServerUrl, removeServer, saveServer, switchServer, unreachableMessage } from './connection.js';


/** Reloads onto Home, which empties every in-memory cache of the previous server. @param {Window} win */
export function reloadHome(win) {
  win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}#/home`);
  win.location.reload();
}

/**
 * @param {HTMLElement} into
 * @param {{ doc: Document, win: Window, storage: Storage, fetch?: typeof fetch, problem?: string, server?: string, inSettings?: boolean, onConnected?: () => void }} o
 *   `problem`: why setup is showing (a refused code), `server` the address to fill in; `inSettings`: drawn as a
 *   Settings row, without the page title.
 */
/**
 * Asks before a sign-in link connects this browser to a server or changes its access code (anyone can send a link).
 * Resolves true for Connect, false for Not now. Text only, no HTML from the link.
 * @param {HTMLElement} into @param {{ doc: Document, target: string, isNew: boolean }} o @returns {Promise<boolean>}
 */
export function confirmSignIn(into, o) {
  const { doc } = o;
  return new Promise((resolve) => {
    const page = h(doc, 'main', 'sbw-login sbw-setup');
    let host = o.target;
    try { host = new URL(o.target).host; } catch { /* shown as it is */ }
    const lead = o.isNew
      ? `This link connects this browser to the Veritas server at ${host}. Connect only if it came from your own computer.`
      : `This link gives this browser a new access code for ${host}.`;
    const yes = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', o.isNew ? `Connect to ${host}` : 'Use the new code'));
    const no = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Not now'));
    yes.addEventListener('click', () => resolve(true), { once: true });
    no.addEventListener('click', () => resolve(false), { once: true });
    const row = h(doc, 'div', 'sbw-setup-actions');
    row.append(yes, no);
    page.append(h(doc, 'h1', 'sbw-h1', 'Veritas'), h(doc, 'p', 'sbw-lead', lead), h(doc, 'p', 'sbw-row-detail', o.target), row);
    into.replaceChildren(page);
  });
}

export function paintSetup(into, o) {
  const { doc, win, storage } = o;
  const onConnected = o.onConnected ?? (() => reloadHome(win));
  const page = h(doc, o.inSettings ? 'div' : 'main', o.inSettings ? 'sbw-setup is-settings' : 'sbw-login sbw-setup');
  if (!o.inSettings) {
    page.append(h(doc, 'h1', 'sbw-h1', 'Veritas'), h(doc, 'p', 'sbw-lead', 'Connect to the computer that runs your Veritas server. Its Settings show the address and access code, or scan its phone code.'));
  }
  const message = h(doc, 'p', 'sbw-hint sbw-setup-message', o.problem ?? '');
  message.setAttribute('role', 'status');
  message.hidden = !o.problem;

  // ---- saved servers
  const list = h(doc, 'div', 'sbw-list sbw-setup-servers');
  const paintList = () => {
    let current = null;
    try { current = storage.getItem(CURRENT_KEY); } catch { /* blocked storage */ }
    const servers = loadServers(storage);
    list.hidden = !servers.length;
    list.replaceChildren(...servers.map((server) => {
      const row = h(doc, 'div', 'sbw-row');
      const text = h(doc, 'div', 'sbw-setup-server');
      text.append(h(doc, 'span', 'sbw-row-name', server.name || server.url), h(doc, 'span', 'sbw-row-detail', server.url));
      const actions = h(doc, 'div', 'sbw-setup-actions');
      if (server.url === current) actions.append(h(doc, 'span', 'sbw-hint', 'In use'));
      else {
        const use = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Use'));
        use.type = 'button';
        use.addEventListener('click', () => { if (switchServer(storage, server.url)) onConnected(); });
        actions.append(use);
      }
      const forget = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Remove'));
      forget.type = 'button';
      forget.addEventListener('click', () => {
        removeServer(storage, server.url);
        if (server.url === current) onConnected(); else paintList();
      });
      actions.append(forget);
      row.append(text, actions);
      return row;
    }));
  };
  paintList();

  // ---- add a server
  const form = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-login-form'));
  const field = (/** @type {string} */ label, /** @type {string} */ type) => {
    const wrap = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbw-hint', label));
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input'));
    input.type = type;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    wrap.append(input);
    form.append(wrap);
    return input;
  };
  const address = field('Server address', 'url');
  address.placeholder = 'https://your-computer.example.ts.net';
  address.value = o.server ?? '';
  const code = field('Access code', 'password');
  const warning = h(doc, 'p', 'sbw-hint sbw-setup-warning', HTTPS_WARNING);
  warning.setAttribute('role', 'alert');
  warning.hidden = true;
  const submit = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Connect'));
  submit.type = 'submit';
  form.append(warning, submit);
  const checkAddress = () => { warning.hidden = !needsHttpsWarning(win.location.href, normaliseServerUrl(address.value)); };
  address.addEventListener('input', checkAddress);
  checkAddress();

  const say = (/** @type {string} */ text) => { message.textContent = text; message.hidden = !text; };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = normaliseServerUrl(address.value);
    const token = code.value.trim();
    if (!url || !token) { say('Enter the server address and the access code.'); return; }
    void (async () => {
      submit.disabled = true;
      say('Connecting…');
      try {
        await createFetchApi(url, { token, fetch: o.fetch }).call('/web/state');
        saveServer(storage, { url, token, name: '' });
        switchServer(storage, url);
        onConnected();
        return;
      } catch (error) {
        const status = /** @type {any} */ (error)?.status;
        if (status === 401) say("That access code didn't work. It may be out of date: check the server's Settings for the current one.");
        else if (status === 403) say(`The server does not accept this page yet. On the server, run: kb.py web-origins add ${win.location.origin}`);
        else if (status) say(`The server said ${status}. Try again in a moment.`);
        else say(unreachableMessage(win.location.href, url));
      }
      submit.disabled = false;
    })();
  });

  if (o.inSettings) page.append(list, h(doc, 'p', 'sbw-hint', 'Add another server:'), form, message);
  else page.append(message, list, form);
  into.replaceChildren(page);
  return page;
}
