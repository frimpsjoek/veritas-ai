// @ts-check
// web/src/setup-card.js (spec 023). Home's guided setup for a new user: five steps, one open at a time, each done in
// place (add the Zotero library or a folder of PDFs, add notes, check the AI, find your papers, connect Valency) with
// what the server found on this computer (GET /setup/suggest). Hidden once every step is done or skipped, or when the
// user hides it (pref `setupHidden`). `setupSteps` and `currentStep` are the pure parts, tested without a DOM.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { iconFor } from '../../ui/src/logos.js';
import { catalogEntry } from '../../agent/src/catalog.js';

/**
 * @typedef {{ sources?: any, providers?: any[], routines?: any[], mcp?: any[], suggest?: any }} SetupFacts
 * @typedef {{ id: string, title: string, done: boolean, detail: string, optional?: boolean, brand?: string, glyph?: string }} SetupStep
 */

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');
const PROVIDERS = { claude: 'Claude', codex: 'Codex', local: 'a local model' };
const HELP = {
  claude: 'install Claude Code, then run `claude` once in Terminal to sign in',
  codex: 'install Codex, then run `codex login` in Terminal',
  local: 'start Ollama or LM Studio',
};
const enabled = (/** @type {any} */ x) => x.enabled !== false && x.role !== 'off';

/** The five steps and whether each is done. A folder counts once it is listed (indexing may still be running).
 *  @param {SetupFacts} f @returns {SetupStep[]} */
export function setupSteps(f) {
  const folders = Array.isArray(f.sources?.folders) ? f.sources.folders.filter(enabled) : [];
  const library = folders.filter((x) => x.kind === 'zotero' || x.kind === 'pdf');
  const notes = folders.filter((x) => x.kind !== 'zotero' && x.kind !== 'pdf' && (x.role !== 'main' || f.sources?.main_is_vault));
  const ready = (f.providers ?? []).filter((p) => p?.state === 'ready').map((p) => PROVIDERS[/** @type {keyof PROVIDERS} */ (p.provider)] ?? p.provider);
  const radar = (f.routines ?? []).find((r) => r?.kind === 'radar' && r.status !== 'archived' && (r.radar?.seeds?.mine?.length ?? 0) > 0);
  const valency = (f.mcp ?? []).find((r) => r?.config?.name === 'valency' && r.state === 'connected');
  const items = (/** @type {any[]} */ list, /** @type {string} */ unit) => list.map((x) => (x.documents > 0 ? `${x.name} (${count(x.documents)} ${unit})` : `${x.name} (indexing)`)).join(', ');
  return [
    { id: 'library', title: 'Your papers library', brand: 'Zotero', done: library.length > 0,
      detail: library.length ? items(library, 'items') : 'Your Zotero library, or a folder of PDFs' },
    { id: 'notes', title: 'Your notes', brand: 'Obsidian', done: notes.length > 0,
      detail: notes.length ? items(notes, 'notes') : 'Your Obsidian vault, or a folder of notes' },
    { id: 'ai', title: 'Your AI', glyph: 'sparkle', done: ready.length > 0,
      detail: ready.length ? `${ready.join(' and ')} ready` : 'Claude, Codex or a local model' },
    { id: 'papers', title: 'Your papers', glyph: 'paper', done: Boolean(radar),
      detail: radar ? `Reading radar from ${radar.radar.seeds.mine.length} of your papers` : 'The papers you wrote start your reading radar' },
    { id: 'valency', title: 'Valency Bond', brand: 'Valency Bond', done: Boolean(valency), optional: true,
      detail: valency ? `Connected: ${valency.tools?.length ?? 0} tools over 500M+ papers and preprints` : '500M+ papers and preprints, ChemRxiv included (optional)' },
  ];
}

/** The step to open: the first one neither done nor skipped, or null. @param {SetupStep[]} steps @param {string[]} skipped */
export function currentStep(steps, skipped) {
  return steps.find((s) => !s.done && !skipped.includes(s.id)) ?? null;
}

/** @param {any} host @returns {Promise<SetupFacts>} */
async function facts(host) {
  const ai = await host.ai().catch(() => null);
  const [sources, providers, routines, mcp, suggest] = await Promise.all([
    host.json('/sources').catch(() => null),
    ai?.providers?.status?.().catch(() => []) ?? [],
    ai?.routines?.list?.().catch(() => []) ?? [],
    ai?.mcp?.list?.().catch(() => []) ?? [],
    host.json('/setup/suggest').catch(() => null),
  ]);
  return { sources, providers, routines: Array.isArray(routines) ? routines : routines?.routines ?? [], mcp, suggest };
}

/** The card, or null when the user hid it or every step is done or skipped. @param {Document} doc @param {any} host */
export async function setupCard(doc, host) {
  if (host.prefs.get('setupHidden')) return null;
  const card = h(doc, 'section', 'sbw-setup');
  card.setAttribute('aria-label', 'Get set up');
  /** @type {string[]} */ const skipped = [...(host.prefs.get('setupSkipped') ?? [])];
  const say = h(doc, 'p', 'sbw-setup-say');
  say.setAttribute('role', 'status');
  let finished = false;

  const button = (/** @type {string} */ text, /** @type {() => Promise<unknown> | unknown} */ run, primary = false) => {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', primary ? 'sb-button is-primary' : 'sb-button', text));
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      say.textContent = '';
      try { await run(); } catch (error) { say.textContent = String(/** @type {any} */ (error)?.message ?? error); b.disabled = false; return; }
      await paint();
    });
    return b;
  };
  const add = (/** @type {string} */ path) => host.json('/sources', 'POST', { path });
  const pathField = (/** @type {string} */ placeholder) => {
    const row = h(doc, 'div', 'sbw-setup-row');
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input sbw-setup-path'));
    input.placeholder = placeholder;
    input.spellcheck = false;
    row.append(input, button('Add', () => {
      if (!input.value.trim()) throw new Error('Type the folder path first, for example ~/Documents/Papers.');
      return add(input.value.trim());
    }));
    return row;
  };
  const suggestion = (/** @type {any} */ item, /** @type {string} */ unit) => {
    const row = h(doc, 'div', 'sbw-setup-row');
    row.append(h(doc, 'span', 'sbw-setup-found', `${item.display} (${count(item.count)} ${unit})`), button('Add', () => add(item.path), true));
    return row;
  };

  /** What the open step shows and does. @param {SetupStep} step @param {SetupFacts} f */
  const body = (step, f) => {
    const box = h(doc, 'div', 'sbw-setup-body');
    const lead = (/** @type {string} */ text) => box.append(h(doc, 'p', 'sbw-setup-lead', text));
    const s = f.suggest ?? {};
    if (step.id === 'library') {
      if (s.zotero && !s.zotero.listed) {
        lead(`Found your Zotero library at ${s.zotero.display} (${count(s.zotero.count)} items).`);
        box.append(button('Use my Zotero library', () => add(s.zotero.path), true));
        lead('You can also add a folder of PDFs:');
      } else {
        lead('No Zotero library found on this computer. Where do you keep your papers?');
      }
      for (const folder of (s.pdf_folders ?? []).filter((/** @type {any} */ x) => !x.listed)) box.append(suggestion(folder, 'PDFs'));
      box.append(pathField('Folder of PDFs, e.g. ~/Documents/Papers'));
    } else if (step.id === 'notes') {
      const vaults = (s.vaults ?? []).filter((/** @type {any} */ x) => !x.listed);
      lead(vaults.length ? 'Found these Obsidian vaults on this computer:' : 'Where do you keep your notes? An Obsidian vault or any folder of Markdown notes.');
      for (const vault of vaults) box.append(suggestion(vault, 'notes'));
      box.append(pathField('Folder of notes, e.g. ~/Documents/Notes'));
    } else if (step.id === 'ai') {
      lead('Veritas answers with the AI you already use. Set up one of these on this computer:');
      const list = h(doc, 'ul', 'sbw-setup-list');
      for (const p of f.providers ?? []) {
        const name = PROVIDERS[/** @type {keyof PROVIDERS} */ (p.provider)] ?? p.provider;
        list.append(h(doc, 'li', '', `${name}: ${HELP[/** @type {keyof HELP} */ (p.provider)] ?? 'not ready'}`));
      }
      box.append(list, button('Check again', () => {}, true));
    } else if (step.id === 'papers') {
      lead('Tell Veritas your name and it finds the papers you wrote; they start your reading radar.');
      box.append(button('Find my papers', () => {
        const name = /** @type {HTMLInputElement | null} */ (doc.querySelector('.sbw-seeds input[placeholder="Your name"]'));
        if (!name) throw new Error('Scroll down to "Your papers" below this card.');
        name.scrollIntoView({ behavior: 'smooth', block: 'center' });
        name.focus();
      }, true));
    } else if (step.id === 'valency') {
      lead('Valency Bond adds 500M+ papers and preprints (ChemRxiv included) to your searches. It is free for researchers.');
      const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-setup-link', 'Get your free token at app.valency.io'));
      link.href = 'https://app.valency.io/settings';
      link.target = '_blank';
      link.rel = 'noopener';
      const row = h(doc, 'div', 'sbw-setup-row');
      const token = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input sbw-setup-path'));
      token.type = 'password';
      token.placeholder = 'Paste your Valency token';
      row.append(token, button('Connect', async () => {
        const entry = catalogEntry('valency');
        if (!entry) throw new Error('This build has no Valency connector.');
        if (!token.value.trim()) throw new Error('Paste the token from app.valency.io/settings first.');
        const ai = await host.ai();
        await ai.mcp.save({ ...entry.config, headers: { Authorization: `Bearer ${token.value.trim()}` } });
        const report = (await ai.mcp.list()).find((/** @type {any} */ r) => r.config.name === 'valency');
        if (report?.state !== 'connected') throw new Error(report?.error ? `Valency did not connect: ${report.error}` : 'Valency did not connect. Check the token.');
      }, true));
      box.append(link, row);
    }
    const foot = h(doc, 'div', 'sbw-setup-foot');
    foot.append(button(step.optional ? 'Not now' : 'Skip', () => {
      skipped.push(step.id);
      host.prefs.set('setupSkipped', skipped);
    }));
    box.append(foot);
    return box;
  };

  async function paint() {
    const f = await facts(host);
    const steps = setupSteps(f);
    const open = currentStep(steps, skipped);
    if (!open) { finished = true; card.remove(); return; }
    const head = h(doc, 'div', 'sbw-setup-head');
    head.append(h(doc, 'h2', 'sbw-setup-title', 'Welcome to Veritas'),
      h(doc, 'span', 'sbw-setup-count', `Step ${steps.indexOf(open) + 1} of ${steps.length}`));
    const list = h(doc, 'ol', 'sbw-setup-steps');
    for (const step of steps) {
      const li = h(doc, 'li', `sbw-setup-step${step.done ? ' is-done' : ''}${step === open ? ' is-open' : ''}`);
      li.dataset.step = step.id;
      const mark = h(doc, 'span', 'sbw-setup-mark');
      if (step.done) mark.append(icon(doc, 'check', 'sb-p-icon'));
      const logo = step.brand ? iconFor(doc, { label: step.brand }, { size: 22, web: true, cls: 'sbw-setup-logo' })
        : icon(doc, step.glyph ?? 'check', 'sb-p-icon sbw-setup-logo');
      const text = h(doc, 'span', 'sbw-setup-text');
      text.append(h(doc, 'span', 'sbw-setup-name', step.title), h(doc, 'span', 'sbw-setup-detail',
        !step.done && skipped.includes(step.id) ? 'Skipped' : step.detail));
      const line = h(doc, 'div', 'sbw-setup-line');
      line.append(mark, logo, text);
      li.append(line);
      if (step === open) li.append(body(step, f));
      list.append(li);
    }
    const hide = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-setup-hide', 'Hide this card'));
    hide.type = 'button';
    hide.addEventListener('click', () => { host.prefs.set('setupHidden', true); card.remove(); });
    card.replaceChildren(head, list, say, hide);
  }

  await paint();
  return finished ? null : card;
}
