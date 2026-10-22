// @ts-check
// ui-src/src/chat/openalex-key.js. The "OpenAlex API key" row of Settings. OpenAlex's shared free daily budget runs out
// for everyone on one IP; a personal key (free at openalex.org) lifts it. The engine owns the key (settings.openalex).
import { h } from '../dom.js';
import { keyLine } from '../settings/connect-guide.js';

export const KEY_PAGE = 'https://openalex.org/settings/api';

/** @param {{ apiKey?: string | { set: true, last4: string } | null, limitUntil?: string | null } | null | undefined} openalex @param {Date} [now]
 *  @returns {string} */
export function openAlexStatus(openalex, now = new Date()) {
  const until = openalex?.limitUntil ? new Date(openalex.limitUntil) : null;
  if (until && until > now) return `Limit reached until ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  // The runtime sends { set: true, last4 } in place of the key (spec 020 G2).
  return keyLine(openalex?.apiKey) || 'Using the shared free limit';
}

/** @param {Document} doc @param {{ ai(): Promise<any>, logError?(e: unknown): void, notice?(m: string): void, openLink?(u: string, opts?: { outside?: boolean }): void }} host
 *  @returns {HTMLElement} */
export function openAlexKeyRow(doc, host) {
  const row = h(doc, 'div', 'sb-openalex-key');
  const input = /** @type {HTMLInputElement} */ (h(doc, 'input'));
  input.type = 'password';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'OpenAlex API key');
  input.placeholder = 'OpenAlex API key';
  const save = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Save'));
  save.type = 'button';
  const remove = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Remove'));
  remove.type = 'button';
  remove.hidden = true;
  const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sb-openalex-link', 'Get a free key'));
  link.href = KEY_PAGE;
  link.rel = 'noopener';
  link.addEventListener('click', (event) => { if (!host.openLink) return; event.preventDefault(); host.openLink(KEY_PAGE, { outside: true }); });
  const status = h(doc, 'p', 'sbw-hint sb-openalex-status');
  status.setAttribute('role', 'status');
  row.append(input, save, remove, link, status);

  /** @param {any} openalex */
  const show = (openalex) => { status.textContent = openAlexStatus(openalex); remove.hidden = !openalex?.apiKey; };
  const apply = async (/** @type {string | null} */ apiKey) => {
    try {
      const ai = await host.ai();
      show((await ai.settings.update({ openalex: { apiKey } })).openalex);
      input.value = '';
    } catch (error) { host.logError?.(error); status.textContent = "Couldn't save the key."; }
  };
  save.addEventListener('click', () => { if (input.value.trim()) void apply(input.value.trim()); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) void apply(input.value.trim()); });
  remove.addEventListener('click', () => void apply(null));
  host.ai().then((ai) => ai.settings.get()).then((s) => show(s.openalex)).catch((error) => { host.logError?.(error); status.textContent = ''; });
  return row;
}
