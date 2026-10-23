// @ts-check
// web/src/setup-card.js. Home's "Get set up" card for a new user: five steps, each linking to the screen that
// does it and ticking itself from what the server already reports. Hidden once every step is done, or when the user
// hides it (pref `setupHidden`). `setupSteps` is the pure part, so it can be tested without a DOM.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { formatRoute } from '../../ui/src/sources/route.js';

/**
 * @typedef {{ sources?: any, providers?: any[], routines?: any[], mcp?: any[] }} SetupFacts
 * @typedef {{ id: string, title: string, done: boolean, detail: string, route: import('../../ui/src/sources/route.js').WebRoute, optional?: boolean }} SetupStep
 */

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');
const PROVIDERS = { claude: 'Claude', codex: 'Codex', local: 'a local model' };

/** The five steps and whether each is done. @param {SetupFacts} f @returns {SetupStep[]} */
export function setupSteps(f) {
  const folders = Array.isArray(f.sources?.folders) ? f.sources.folders : [];
  const zotero = folders.find((x) => x.kind === 'zotero' && x.enabled && x.documents > 0);
  const notes = folders.filter((x) => x.kind !== 'zotero' && x.enabled && x.documents > 0
    && (x.role !== 'main' || f.sources?.main_is_vault));
  const ready = (f.providers ?? []).filter((p) => p?.state === 'ready').map((p) => PROVIDERS[/** @type {keyof PROVIDERS} */ (p.provider)] ?? p.provider);
  const radar = (f.routines ?? []).find((r) => r?.kind === 'radar' && r.status !== 'archived' && (r.radar?.seeds?.mine?.length ?? 0) > 0);
  const connected = (f.mcp ?? []).filter((r) => r?.state === 'connected').map((r) => r.config?.name);
  const settings = (/** @type {string} */ section) => /** @type {import('../../ui/src/sources/route.js').WebRoute} */ ({ view: 'settings', section });
  return [
    { id: 'library', title: 'Your library', done: Boolean(zotero),
      detail: zotero ? `Zotero: ${count(zotero.documents)} items` : 'Add your Zotero folder', route: settings('folders') },
    { id: 'notes', title: 'Your notes', done: notes.length > 0,
      detail: notes.length ? `${notes.map((x) => x.name).join(', ')}: ${count(notes.reduce((n, x) => n + x.documents, 0))} notes` : 'Add your Obsidian vault or a folder of notes and PDFs', route: settings('folders') },
    { id: 'ai', title: 'Your AI', done: ready.length > 0,
      detail: ready.length ? `${ready.join(' and ')} ready` : 'Sign in to Claude or Codex, or choose a local model', route: settings('models') },
    { id: 'papers', title: 'Your papers', done: Boolean(radar),
      detail: radar ? `Reading radar from ${radar.radar.seeds.mine.length} of your papers` : 'Find the papers you wrote (name or ORCID) to start the reading radar', route: settings('radar') },
    { id: 'connectors', title: 'Connectors', done: connected.length > 0, optional: true,
      detail: connected.length ? `${connected.join(', ')} connected` : 'Valency Bond and other literature tools (optional)', route: settings('sources') },
  ];
}

/** Fetches the facts; a part the server cannot answer stays empty (that step shows as not done). @param {any} host */
async function facts(host) {
  const ai = await host.ai().catch(() => null);
  const [sources, providers, routines, mcp] = await Promise.all([
    host.json('/sources').catch(() => null),
    ai?.providers?.status?.().catch(() => []) ?? [],
    ai?.routines?.list?.().catch(() => []) ?? [],
    ai?.mcp?.list?.().catch(() => []) ?? [],
  ]);
  return { sources, providers, routines: Array.isArray(routines) ? routines : routines?.routines ?? [], mcp };
}

/** The card, or null when the user hid it or every step is done. @param {Document} doc @param {any} host */
export async function setupCard(doc, host) {
  if (host.prefs.get('setupHidden')) return null;
  const steps = setupSteps(await facts(host));
  if (steps.every((s) => s.done)) return null;
  const card = h(doc, 'section', 'sbw-setup');
  card.setAttribute('aria-label', 'Get set up');
  const head = h(doc, 'div', 'sbw-setup-head');
  head.append(h(doc, 'h2', 'sbw-setup-title', 'Welcome to Veritas'),
    h(doc, 'span', 'sbw-setup-count', `${steps.filter((s) => s.done).length} of ${steps.length} done`));
  const list = h(doc, 'ol', 'sbw-setup-steps');
  for (const step of steps) {
    const row = /** @type {HTMLAnchorElement} */ (h(doc, 'a', `sbw-setup-step${step.done ? ' is-done' : ''}`));
    row.href = formatRoute(step.route);
    row.dataset.step = step.id;
    const mark = h(doc, 'span', 'sbw-setup-mark');
    if (step.done) mark.append(icon(doc, 'check', 'sb-p-icon'));
    const text = h(doc, 'span', 'sbw-setup-text');
    text.append(h(doc, 'span', 'sbw-setup-name', step.title), h(doc, 'span', 'sbw-setup-detail', step.detail));
    row.append(mark, text);
    if (!step.done) row.append(icon(doc, 'chevron', 'sb-p-icon sbw-setup-go'));
    const li = h(doc, 'li');
    li.append(row);
    list.append(li);
  }
  const hide = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-setup-hide', 'Hide this card'));
  hide.type = 'button';
  hide.addEventListener('click', () => { host.prefs.set('setupHidden', true); card.remove(); });
  card.append(head, list, hide);
  return card;
}
