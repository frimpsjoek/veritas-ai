// @ts-check
// ui-src/src/chat/provider-switch.js. When a question fails because the AI chosen for chat is not installed, the error
// card offers one button per AI that is ready ("Use Claude instead"). A click moves the Chat and Ask roles to it and
// asks the same question again. With no AI ready it says where to add one. Used by the thread and the Chat with papers tab.
import { h } from '../dom.js';
import { MENU_ROLES } from './local-menu-data.js';

export const NONE_READY = 'No AI is set up yet. Open Settings → AI to add one.';
const NAMES = { codex: 'Codex', claude: 'Claude', local: 'On this Mac (local)' };

/** The error kind a provider reports when its program is missing (a structural code, not message text). */
export const NOT_INSTALLED = 'not_installed';

/** @param {string} id */
export function nameOf(id) { return NAMES[/** @type {keyof typeof NAMES} */ (id)] ?? id.replace(/^oss:/, ''); }

/** The AIs that are ready, as buttons: Codex and Claude first, then On this Mac, then any other.
 *  @param {{ provider: string, state: string }[] | null | undefined} statuses
 *  @returns {{ label: string, choice: import("../../../agent-src/src/domain").ModelChoice }[]} */
export function switchOptions(statuses) {
  const order = ['codex', 'claude', 'local'];
  const rank = (/** @type {string} */ id) => (order.includes(id) ? order.indexOf(id) : order.length);
  return (statuses ?? [])
    .filter((s) => s.state === 'ready')
    .sort((a, b) => rank(a.provider) - rank(b.provider))
    .map((s) => ({ label: `Use ${nameOf(s.provider)} instead`, choice: /** @type {any} */ ({ provider: s.provider, model: null }) }));
}

/**
 * Adds the switch buttons (or the "nothing is set up" line) under a not-installed error. `retry` asks the same question
 * again; without one the buttons only switch.
 * @param {{ doc: Document, host: any, localMenu?: any }} view @param {HTMLElement} box the error card @param {(() => any) | undefined} retry
 */
export async function offerSwitch(view, box, retry) {
  let statuses;
  let ai;
  try {
    ai = await view.host.ai();
    statuses = await ai.providers.status();
  } catch {
    return; // the plain error stays
  }
  const options = switchOptions(statuses);
  const row = h(view.doc, 'div', 'sb-ai-error-switch');
  if (!options.length) {
    row.append(h(view.doc, 'div', 'sb-ai-error-none', NONE_READY));
  }
  for (const option of options) {
    const button = h(view.doc, 'button', 'sb-ai-error-use', option.label);
    button.setAttribute('type', 'button');
    button.style.whiteSpace = 'normal'; // Obsidian buttons do not wrap by default
    button.addEventListener('click', async () => {
      for (const b of Array.from(row.querySelectorAll('button'))) b.setAttribute('disabled', 'true');
      try {
        for (const role of MENU_ROLES) await ai.providers.setRole(role, option.choice);
      } catch (error) {
        view.host.notice(String(/** @type {any} */ (error)?.message ?? error));
        for (const b of Array.from(row.querySelectorAll('button'))) b.removeAttribute('disabled');
        return;
      }
      row.replaceChildren(h(view.doc, 'div', 'sb-ai-error-none', `Switched to ${nameOf(option.choice.provider)}.${retry ? ' Asking again…' : ''}`));
      void view.localMenu?.refresh?.();
      await retry?.();
    });
    row.append(button);
  }
  box.append(row);
}
