// @ts-check
// ui-src/src/web/login.js. The sign-in page (login.html): the QR code opens /app/login#t=<token>. The token is read
// from the fragment, which the browser never sends to a server or writes to a log, removed from the address bar
// at once, and posted once; the server answers with the sb_session cookie.
import { h } from '../../ui/src/dom.js';

const MESSAGES = {
  wrong: "That code didn't work. It may be out of date. On your Mac, open Second Brain, go to Settings, and scan the new code.",
  offline: "Couldn't reach your Mac. Check that it is awake and that Tailscale is on, then try again.",
};

/** @param {{ win?: Window, fetch?: typeof fetch }} [env] */
export function startLogin(env = {}) {
  const win = env.win ?? window;
  const doc = win.document;
  const doFetch = env.fetch ?? ((/** @type {string} */ input, /** @type {RequestInit} */ init) => win.fetch(input, init));
  const token = new URLSearchParams(win.location.hash.slice(1)).get('t') ?? '';
  if (win.location.hash) win.history.replaceState(null, '', win.location.pathname + win.location.search);

  const page = h(doc, 'main', 'sbw-login');
  const title = h(doc, 'h1', 'sbw-h1', 'Second Brain');
  const message = h(doc, 'p', 'sbw-lead');
  message.setAttribute('role', 'status');
  const form = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-login-form'));
  const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbw-hint', 'Access code'));
  const input = /** @type {HTMLInputElement} */ (h(doc, 'input'));
  input.type = 'password';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  label.append(input);
  const submit = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Sign in'));
  submit.type = 'submit';
  form.append(label, submit);
  page.append(title, message, form);
  doc.body.replaceChildren(page);

  /** @param {string} code */
  async function signIn(code) {
    submit.disabled = true;
    message.textContent = 'Signing in…';
    try {
      const response = await doFetch(new URL('login', win.location.href).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }),
      });
      if (response.ok) { win.location.replace(new URL('./#/home', win.location.href).href); return true; }
      message.textContent = response.status === 401 ? MESSAGES.wrong : `The server said ${response.status}. Try again in a moment.`;
    } catch {
      message.textContent = MESSAGES.offline;
    }
    submit.disabled = false;
    form.hidden = false;
    return false;
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim()) void signIn(input.value.trim()); });
  if (token) { form.hidden = true; return signIn(token); }
  message.textContent = 'Scan the code in Settings on your Mac with your phone camera, or paste the access code here.';
  return Promise.resolve(false);
}

if (typeof document !== 'undefined' && !(/** @type {any} */ (globalThis).__SB_NO_AUTOSTART__)) void startLogin();
