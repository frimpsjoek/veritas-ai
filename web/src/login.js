// @ts-check
// ui-src/src/web/login.js. The sign-in page (login.html): the QR code opens /app/login#t=<token>. The token is read
// from the fragment, which the browser never sends to a server or writes to a log, removed from the address bar
// at once, and posted once; the server answers with the sb_session cookie. A newer link that also names the server
// (#server=&t=) is handed to the app next to this page (connection.js).
import { h } from '../../ui/src/dom.js';
import { parseSignInHash } from './connection.js';

const MESSAGES = {
  wrong: 'That code was not accepted. It may have been replaced: open Settings in Veritas on your Mac for the current one.',
  offline: 'Could not reach Veritas. Check that the Mac running it is awake and that Tailscale is on, then try again.',
  empty: 'Enter the access code from Veritas Settings.',
};

/** @param {{ win?: Window, fetch?: typeof fetch }} [env] */
export function startLogin(env = {}) {
  const win = env.win ?? window;
  const doc = win.document;
  const doFetch = env.fetch ?? ((/** @type {string} */ input, /** @type {RequestInit} */ init) => win.fetch(input, init));
  const link = parseSignInHash(win.location.hash);
  // A link that names its server (#server=&t=) is for the app itself, which saves the server and uses a Bearer token.
  if (link?.server) { win.location.replace(new URL(`./${win.location.hash}`, win.location.href).href); return Promise.resolve(false); }
  const token = link?.token ?? '';
  if (win.location.hash) win.history.replaceState(null, '', win.location.pathname + win.location.search);

  const page = h(doc, 'main', 'sbw-login sbw-auth');
  const column = h(doc, 'div', 'sbw-auth-col');

  const head = h(doc, 'header', 'sbw-auth-head');
  const mark = /** @type {HTMLImageElement} */ (h(doc, 'img', 'sbw-auth-mark'));
  mark.src = 'veritas-mark-180.png';
  mark.alt = '';
  mark.width = 40;
  mark.height = 40;
  const heading = h(doc, 'h1', 'sbw-auth-heading', 'Sign in to Veritas');
  heading.id = 'sbw-auth-heading';
  head.append(mark, heading, h(doc, 'p', 'sbw-auth-sub', 'Answers from your own papers, notes and Zotero library, with citations you can open.'));

  const entry = h(doc, 'section', 'sbw-auth-entry');
  entry.setAttribute('aria-labelledby', 'sbw-auth-heading');
  const globusSlot = h(doc, 'div', 'sbw-auth-globus-slot');
  globusSlot.hidden = true;
  const form = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-login-form'));
  const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbw-auth-code-label'));
  const labelText = h(doc, 'span', 'sbw-auth-label-text', 'Access code');
  const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-auth-code-input'));
  input.id = 'sbw-access-code';
  input.type = 'password';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-describedby', 'sbw-auth-code-note');
  label.htmlFor = input.id;
  const labelNote = h(doc, 'span', 'sbw-auth-label-note', 'From Settings in Veritas on your Mac.');
  labelNote.id = 'sbw-auth-code-note';
  label.append(labelText, input, labelNote);
  const submit = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary sbw-auth-code-submit', 'Sign in'));
  submit.type = 'submit';
  form.append(label, submit);
  const message = h(doc, 'p', 'sbw-auth-status');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');
  entry.append(globusSlot, form, message);

  const help = h(doc, 'p', 'sbw-auth-help', 'On a phone, scan the QR code under “Use on your phone” in Veritas Settings. It opens this page and signs you in.');
  column.append(head, entry, help);
  page.append(column);
  doc.body.replaceChildren(page);

  async function discoverGlobus() {
    try {
      const response = await doFetch(new URL('/auth/globus/status', win.location.href).href, { credentials: 'same-origin' });
      if (!response.ok) return false;
      const config = await response.json();
      if (config?.enabled !== true) return false;
      const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-auth-globus', 'Continue with Globus'));
      link.href = '/auth/globus/login';
      link.rel = 'noopener';
      const divider = h(doc, 'div', 'sbw-auth-divider');
      divider.append(h(doc, 'span', '', 'or'));
      globusSlot.append(link, h(doc, 'p', 'sbw-auth-globus-note', 'Use your institution or ALCF account.'), divider);
      globusSlot.hidden = false;
      page.setAttribute('data-globus', 'enabled');
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string} code */
  async function signIn(code) {
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    input.setAttribute('aria-invalid', 'false');
    message.setAttribute('data-tone', 'busy');
    message.textContent = token ? 'Signing you in…' : 'Checking your code…';
    try {
      const response = await doFetch(new URL('login', win.location.href).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }),
      });
      if (response.ok) { win.location.replace(new URL('./#/home', win.location.href).href); return true; }
      message.setAttribute('data-tone', 'error');
      message.textContent = response.status === 401 ? MESSAGES.wrong : `The server returned ${response.status}. Try again in a moment.`;
      if (response.status === 401) input.setAttribute('aria-invalid', 'true');
    } catch {
      message.setAttribute('data-tone', 'error');
      message.textContent = MESSAGES.offline;
    }
    submit.disabled = false;
    submit.textContent = 'Sign in';
    form.hidden = false;
    return false;
  }

  input.addEventListener('input', () => {
    input.setAttribute('aria-invalid', 'false');
    if (message.getAttribute('data-tone') === 'error') message.textContent = '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (!submit.disabled && code) void signIn(code);
    else if (!code) {
      message.setAttribute('data-tone', 'error');
      message.textContent = MESSAGES.empty;
      input.setAttribute('aria-invalid', 'true');
    }
  });
  if (token) { form.hidden = true; return signIn(token); }
  // The page carries one accent, on whichever way in is the main one here (spec 013 ledger 6): Globus when the
  // server offers it, the access code when it does not. The attribute is set only once discovery has answered.
  return discoverGlobus().then((enabled) => { if (!enabled) page.setAttribute('data-globus', 'off'); return false; });
}

if (typeof document !== 'undefined' && !(/** @type {any} */ (globalThis).__SB_NO_AUTOSTART__)) void startLogin();
