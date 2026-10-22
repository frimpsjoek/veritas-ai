// @ts-check
// ui-src/src/web/pages.js. The shell's own pages: Home (painted by home/home.js, shared with the plugins), Projects
// and Settings. They are small, read what the engine and server already expose, and open the shared chat for
// everything interactive.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatRoute } from './route.js';
import { paintPhone } from './phone.js';
import { paintHome } from '../home/home.js';
import { SettingsView } from '../settings/settings-view.js';
import { foldersWidget } from './folders-view.js';
import { progressPanel } from './progress-view.js';
import { mountSources } from './sources-view.js';

/** @typedef {import("./host.js").createWebHost extends (...a: any) => infer H ? H : never} WebHost */
/** @typedef {{ host: any, doc: Document, go: (route: import("./route.js").WebRoute) => void, links: import("../home/links.js").HomeLinks }} PageContext */


/** @param {Document} doc @param {string} title @param {string} [lead] */
function pageShell(doc, title, lead) {
  const root = h(doc, 'div', 'sbw-page');
  root.append(h(doc, 'h1', 'sbw-h1', title));
  if (lead) root.append(h(doc, 'p', 'sbw-lead', lead));
  return root;
}

/** A 56 px hairline row that links to a route. `fresh` puts the accent dot before the title and keeps the title at full contrast (ledger 4).
 *  @param {Document} doc @param {string} href @param {string} iconName @param {string} title @param {string} meta @param {boolean} [fresh] */
function linkCard(doc, href, iconName, title, meta, fresh = false) {
  const card = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-card'));
  card.href = href;
  const text = h(doc, 'span', 'sbw-card-text');
  text.append(h(doc, 'span', 'sbw-card-title', title), h(doc, 'span', 'sbw-card-meta', meta));
  card.append(fresh ? h(doc, 'span', 'sbw-dot') : icon(doc, iconName, 'sb-p-icon sbw-card-icon'), text);
  if (fresh) card.classList.add('is-new');
  return card;
}

/** The count on the rail's Home item. @param {Document} doc @param {number} n */
function showWaiting(doc, n) {
  const home = doc.querySelector('.sbw-nav-item[data-view="home"]');
  if (!home) return;
  let badge = /** @type {HTMLElement | null} */ (home.querySelector('.sbw-nav-badge'));
  if (!badge) { badge = h(doc, 'span', 'sbw-nav-badge'); home.append(badge); }
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/** Home under the router: every link is a hash route, and the waiting count shows on the rail's Home item.
 *  @param {HTMLElement} into @param {PageContext} ctx */
export function paintWebHome(into, { host, doc, links }, route) {
  return paintHome(into, { host, doc, links, issue: route?.issue, onWaiting: (n) => showWaiting(doc, n) });
}

/** Projects as cards with how many chats each holds; a card opens the chat filtered to it.
 *  @param {HTMLElement} into @param {PageContext} ctx */
export async function paintProjects(into, ctx) {
  const { host, doc, go } = ctx;
  const page = pageShell(doc, 'Projects', 'A project groups chats and reports on one subject.');
  into.replaceChildren(page);
  const list = h(doc, 'div', 'sbw-list');
  const make = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-cta', 'New project'));
  make.setAttribute('type', 'button');
  page.append(make, list);
  let projects = [];
  let conversations = [];
  try {
    const ai = await host.ai();
    if (!ai.projects) { list.append(h(doc, 'p', 'sbw-hint', 'This server has no projects yet.')); make.hidden = true; return; }
    [projects, conversations] = await Promise.all([ai.projects.list(), ai.conversations.list().catch(() => [])]);
    make.addEventListener('click', async () => {
      const name = await host.promptText('Name the project', '', { title: 'New project' });
      if (!name?.trim()) return;
      try {
        const project = await ai.projects.create(name.trim());
        go({ view: 'chat', project: project.id });
      } catch (error) { host.notice(String(/** @type {any} */ (error)?.message ?? error)); }
    });
  } catch (error) {
    host.logError(error);
    list.append(h(doc, 'p', 'sbw-hint', "Couldn't reach the Second Brain server."));
    make.hidden = true;
    return;
  }
  const known = new Set(projects.map((/** @type {any} */ p) => p.id));
  if (!projects.length) list.append(h(doc, 'p', 'sbw-hint', 'No projects yet.'));
  for (const project of projects) {
    const count = conversations.filter((/** @type {any} */ c) => c.project === project.id && known.has(c.project)).length;
    list.append(linkCard(doc, formatRoute({ view: 'chat', project: project.id }), 'folder', project.name, `${count} ${count === 1 ? 'chat' : 'chats'}`));
  }
}

/** @param {Document} doc @param {string | undefined} choice */
export function applyTheme(doc, choice) {
  const root = doc.documentElement;
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice); else root.removeAttribute('data-theme');
  try { doc.defaultView?.localStorage.setItem('sbw-theme', choice ?? 'system'); } catch { /* private window; the server copy still applies */ }
}

/** The web app's Settings: the shared SettingsView (settings/), plus the rows only the browser draws (phone sign-in
 *  code, search index status, the reading radar's setup, the routines) and its theme switch.
 *  @param {HTMLElement} into @param {PageContext & { section?: string }} ctx */
export async function paintSettings(into, { host, doc, section, links }) {
  const page = h(doc, 'div', 'sbw-page sbw-settings');
  into.replaceChildren(page);
  SettingsView(host, doc, page, {
    section,
    onChange: (row, value) => { if (row.id === 'general.theme') applyTheme(doc, /** @type {string} */ (value)); },
    renderers: {
      phone: (_row, ctx) => { const box = h(ctx.doc, 'div', 'sbw-phone'); void paintPhone(box, { host: ctx.host, doc: ctx.doc }); return box; },
      indexStatus: (_row, ctx) => indexStatus(ctx.doc, ctx.host),
      folders: (_row, ctx) => foldersWidget(ctx.doc, ctx.host),
      radarLink: (_row, ctx) => {
        const link = /** @type {HTMLAnchorElement} */ (h(ctx.doc, 'a', 'sb-button', 'Open Reading radar'));
        link.href = formatRoute({ view: 'settings', section: 'radar' });
        return link;
      },
      radarSetup: (_row, ctx) => { const box = h(ctx.doc, 'div', 'sbw-settings-radar'); void mountSources(box, { host: ctx.host, doc: ctx.doc, links }, { mode: 'settings' }); return box; },
      routinesList: (_row, ctx) => routinesList(ctx.doc, ctx.host),
      version: (_row, ctx) => versionLine(ctx.doc, ctx.host),
    },
    actions: { copyDiagnostics: () => copyDiagnostics(doc, host) },
  });
}

/** Settings > Routines: each routine with what it is and how it stands, and a way into the routines page to change one.
 *  @param {Document} doc @param {any} host */
function routinesList(doc, host) {
  const box = h(doc, 'div', 'sbw-routines');
  const body = h(doc, 'div', 'sbw-list');
  const open = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sb-button', 'Open routines'));
  open.href = formatRoute({ view: 'routines' });
  body.append(h(doc, 'p', 'sbw-hint', 'Loading…'));
  box.append(body, open);
  const KIND = { radar: 'Reading radar', watch: 'Watch', digest: 'Digest' };
  void (async () => {
    try {
      const ai = await host.ai();
      const all = /** @type {any[]} */ ((await ai.routines?.list()) ?? []).filter((r) => !r.broken && r.status !== 'archived');
      body.replaceChildren(...(all.length ? all.map((r) => {
        const last = r.lastRun?.at ? `last run ${new Date(r.lastRun.at).toLocaleDateString()}` : 'not run yet';
        const row = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-row'));
        row.href = formatRoute({ view: 'routines' });
        row.append(h(doc, 'span', 'sbw-row-name', r.name), h(doc, 'span', 'sbw-row-detail', [/** @type {any} */ (KIND)[r.kind ?? 'digest'] ?? 'Routine', r.status === 'paused' ? 'paused' : null, last].filter(Boolean).join(' · ')));
        return row;
      }) : [h(doc, 'p', 'sbw-hint', 'No routines yet.')]));
    } catch { body.replaceChildren(h(doc, 'p', 'sbw-hint', "Couldn't read the routines.")); }
  })();
  return box;
}

/** The search index rows: what each source holds, and Update now. @param {Document} doc @param {any} host */
function indexStatus(doc, host) {
  const box = h(doc, 'div', 'sbw-index');
  box.id = 'sbw-index';
  const body = h(doc, 'div', 'sbw-list');
  const update = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Update the index now'));
  update.setAttribute('type', 'button');
  const note = h(doc, 'p', 'sbw-hint');
  box.append(progressPanel(doc, host), body, update, note);
  const paint = async () => {
    try {
      const status = await host.json('/status');
      body.replaceChildren(...status.coverage.filter((/** @type {any} */ r) => !String(r.source).startsWith('_')).map((/** @type {any} */ r) =>
        linkRow(doc, r.source, `${r.documents} documents`)));
      update.disabled = Boolean(status.running);
    } catch { body.replaceChildren(h(doc, 'p', 'sbw-hint', "Couldn't read the index status.")); }
  };
  update.addEventListener('click', async () => {
    try { await host.json('/index', 'POST', {}); note.textContent = 'Started.'; } catch (error) { note.textContent = String(/** @type {any} */ (error)?.message ?? error); }
    void paint();
  });
  void paint();
  return box;
}

/** @param {Document} doc @param {any} host */
function versionLine(doc, host) {
  const line = h(doc, 'span', 'sbs-help', 'Second Brain web app');
  host.json('/status').then((status) => { if (status?.version) line.textContent = `Second Brain ${status.version}`; }).catch(() => {});
  return line;
}

/** Copies what is useful in a bug report: the server's status and this browser. No keys, no notes.
 *  @param {Document} doc @param {any} host */
async function copyDiagnostics(doc, host) {
  const status = await host.json('/status').catch(() => null);
  const text = JSON.stringify({ app: 'web', userAgent: doc.defaultView?.navigator.userAgent, server: status ? { version: status.version, running: status.running, coverage: status.coverage } : 'unreachable' }, null, 2);
  await doc.defaultView?.navigator.clipboard.writeText(text);
  host.notice('Diagnostics copied.');
}

/** @param {Document} doc @param {string} name @param {string} detail */
function linkRow(doc, name, detail) {
  const row = h(doc, 'div', 'sbw-row');
  row.append(h(doc, 'span', 'sbw-row-name', name), h(doc, 'span', 'sbw-row-detail', detail));
  return row;
}
