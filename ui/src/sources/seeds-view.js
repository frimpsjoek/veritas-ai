// @ts-check
// ui-src/src/web/seeds-view.js (server spec 021 G1). The first steps of the radar's Sources page: "Your papers"
// (found through OpenAlex by name or ORCID, each marked when it is in the library) and "More papers like these" (library
// papers and whole collections). What is ticked becomes form.seeds; the radar compares every new paper with each seed.
import { h } from '../dom.js';
import { seedCount } from '../chat/radar-data.js';

/** @typedef {import('../chat/radar-data.js').RadarForm} RadarForm */
/** @typedef {import('../../../agent/src/radar-types').RadarSeeds} RadarSeeds */

/** @param {RadarForm} form @returns {RadarSeeds} */
export function ensureSeeds(form) {
  form.seeds ??= { mine: [], papers: [], collections: [], author: null, categories: [] };
  form.databases.arxiv = true;  // a seed radar reads arXiv (G2)
  return form.seeds;
}

/** "14 seed papers, 1 collection" @param {RadarSeeds | null | undefined} seeds */
export function seedSummary(seeds) {
  if (!seeds) return 'No seed papers yet.';
  const n = seedCount(seeds);
  const c = seeds.collections.length;
  return [`${n} seed paper${n === 1 ? '' : 's'}`, c ? `${c} collection${c === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') + (n < 3 && !c ? ' (at least 3 needed)' : '');
}

/** @param {Document} doc @param {string} text @param {string} [cls] */
function button(doc, text, cls = 'sb-button') {
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', cls, text));
  b.type = 'button';
  return b;
}

/**
 * @param {Document} doc @param {any} host @param {any} ai the AgentService
 * @param {RadarForm} form @param {() => void} onChange after every tick (the page repaints its count and ring)
 */
export function seedsPanel(doc, host, ai, form, onChange) {
  const root = h(doc, 'section', 'sbw-seeds');
  const count = h(doc, 'p', 'sbw-seeds-count');
  const changed = () => { count.textContent = seedSummary(form.seeds); onChange(); };

  // ---- step 1: your papers
  const mine = h(doc, 'div', 'sbw-seeds-step sbw-seeds-mine');
  mine.append(h(doc, 'h2', 'sbw-seeds-h2', 'Your papers'),
    h(doc, 'p', 'sbw-hint', 'The radar starts from your own work. Find your papers, then untick any it should not use.'));
  const ask = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-seeds-ask'));
  const name = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  name.placeholder = 'Your name';
  name.setAttribute('aria-label', 'Your name');
  name.value = form.seeds?.author?.name ?? '';
  const orcid = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  orcid.placeholder = 'ORCID (optional)';
  orcid.setAttribute('aria-label', 'Your ORCID');
  orcid.value = form.seeds?.author?.orcid ?? '';
  const find = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Find my papers'));
  find.type = 'submit';
  ask.append(name, orcid, find);
  const who = h(doc, 'div', 'sbw-seeds-who');
  const note = h(doc, 'p', 'sbw-hint sbw-seeds-note');
  note.setAttribute('aria-live', 'polite');
  const list = h(doc, 'ul', 'sbw-seeds-list');
  mine.append(ask, who, note, list);

  /** @param {any[]} papers */
  function paintMine(papers) {
    const seeds = ensureSeeds(form);
    const ticked = new Set(seeds.mine.map((m) => m.title));
    list.replaceChildren(...papers.map((p) => {
      const item = h(doc, 'li', 'sbw-seeds-paper');
      const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', ''));
      const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
      box.type = 'checkbox';
      box.checked = ticked.has(p.title);
      box.addEventListener('change', () => {
        const { inLibrary: _shown, ...paper } = p;
        seeds.mine = box.checked ? [...seeds.mine.filter((m) => m.title !== p.title), paper] : seeds.mine.filter((m) => m.title !== p.title);
        changed();
      });
      const where = p.inLibrary ? 'in your library' : p.abstract ? 'not in your library; its abstract is used' : 'not in your library and no abstract; it cannot be used';
      label.append(box, h(doc, 'span', 'sbw-seeds-title', p.title), h(doc, 'span', `sbw-seeds-meta${p.inLibrary ? ' is-in' : ''}`, [p.year, where].filter(Boolean).join(' · ')));
      item.append(label);
      return item;
    }));
  }

  /** @param {string | null} [openalexId] */
  async function lookUp(openalexId = null) {
    find.disabled = true;
    note.textContent = 'Looking you up in OpenAlex…';
    try {
      const out = await ai.radar.myPapers({ name: name.value.trim(), orcid: orcid.value.trim() || null, openalexId });
      who.replaceChildren();
      if (out.authors.length > 1) {
        const pick = /** @type {HTMLSelectElement} */ (h(doc, 'select', 'sb-input'));
        pick.setAttribute('aria-label', 'Which of these is you');
        for (const a of out.authors) { const o = /** @type {HTMLOptionElement} */ (h(doc, 'option', '', a.label)); o.value = a.openalexId; o.selected = a.openalexId === out.chosen; pick.append(o); }
        pick.addEventListener('change', () => void lookUp(pick.value));
        who.append(h(doc, 'span', 'sbw-hint', 'Several people have this name. Which is you? '), pick);
      } else if (out.authors.length === 1) who.append(h(doc, 'span', 'sbw-hint', out.authors[0].label));
      note.textContent = out.problem ?? `${out.papers.length} papers found, ${out.papers.filter((/** @type {any} */ p) => p.inLibrary).length} of them in your library.`;
      const seeds = ensureSeeds(form);
      seeds.author = out.chosen ? { name: name.value.trim(), orcid: orcid.value.trim() || null, openalexId: out.chosen } : seeds.author;
      // A first lookup ticks everything usable; a repeat keeps what was ticked.
      if (!seeds.mine.length) seeds.mine = out.papers.filter((/** @type {any} */ p) => p.inLibrary || p.abstract).map((/** @type {any} */ { inLibrary: _s, ...p }) => p);
      paintMine(out.papers);
      changed();
    } catch (error) { note.textContent = String(/** @type {any} */ (error)?.message ?? error); }
    find.disabled = false;
  }
  ask.addEventListener('submit', (event) => { event.preventDefault(); void lookUp(); });
  if (form.seeds?.mine.length) paintMine(form.seeds.mine.map((m) => ({ ...m, inLibrary: Boolean(m.key) })));

  // ---- step 2: more papers like these
  const more = h(doc, 'div', 'sbw-seeds-step sbw-seeds-more');
  more.append(h(doc, 'h2', 'sbw-seeds-h2', 'More papers like these'),
    h(doc, 'p', 'sbw-hint', 'Papers from your library, or whole collections, the radar should also compare against.'));
  const search = /** @type {HTMLFormElement} */ (h(doc, 'form', 'sbw-seeds-ask'));
  const q = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input'));
  q.placeholder = 'Search your library';
  q.setAttribute('aria-label', 'Search your library for seed papers');
  const go = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Search'));
  go.type = 'submit';
  search.append(q, go);
  const hits = h(doc, 'ul', 'sbw-seeds-list');
  const picked = h(doc, 'div', 'sbw-seeds-picked');
  const collections = h(doc, 'div', 'sbw-seeds-collections');
  more.append(search, hits, picked, collections);
  /** @type {Map<string, string>} */
  const titles = new Map();

  function paintPicked() {
    // Read only: a radar gets seeds when the person adds one, never by opening the page.
    picked.replaceChildren(...(form.seeds?.papers ?? []).map((key) => {
      const chip = h(doc, 'span', 'sbw-chip is-on');
      const x = button(doc, '×', 'sbw-chip-x');
      x.setAttribute('aria-label', `Remove ${titles.get(key) ?? key}`);
      x.addEventListener('click', () => { const seeds = ensureSeeds(form); seeds.papers = seeds.papers.filter((k) => k !== key); paintPicked(); changed(); });
      chip.append(h(doc, 'span', 'sbw-chip-label', titles.get(key) ?? key), x);
      return chip;
    }));
  }
  search.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!q.value.trim()) return;
    go.disabled = true;
    try {
      const found = await host.json(`/search?${new URLSearchParams({ q: q.value.trim(), source: 'zotero', limit: '10' })}`);
      hits.replaceChildren(...found.filter((/** @type {any} */ r) => String(r.path).startsWith('zotero/')).map((/** @type {any} */ r) => {
        const key = String(r.path).slice('zotero/'.length);
        titles.set(key, r.title);
        const item = h(doc, 'li', 'sbw-seeds-paper');
        const add = button(doc, form.seeds?.papers.includes(key) ? 'Added' : 'Add', 'sb-button sbw-seeds-add');
        add.disabled = Boolean(form.seeds?.papers.includes(key));
        add.addEventListener('click', () => { const seeds = ensureSeeds(form); seeds.papers = [...new Set([...seeds.papers, key])]; add.textContent = 'Added'; add.disabled = true; paintPicked(); changed(); });
        item.append(h(doc, 'span', 'sbw-seeds-title', r.title), add);
        return item;
      }));
    } catch (error) { hits.replaceChildren(h(doc, 'li', 'sbw-hint', String(/** @type {any} */ (error)?.message ?? error))); }
    go.disabled = false;
  });
  void host.json('/zotero/collections').then((/** @type {any[]} */ cols) => {
    if (!cols?.length) return;
    collections.append(h(doc, 'p', 'sbw-hint', 'Whole collections:'));
    for (const c of cols.filter((x) => !x.parent).slice(0, 30)) {
      const chip = button(doc, `${c.name}${c.count ? ` (${c.count})` : ''}`, `sbw-chip${form.seeds?.collections.includes(c.key) ? ' is-on' : ''}`);
      chip.setAttribute('aria-pressed', String(Boolean(form.seeds?.collections.includes(c.key))));
      chip.addEventListener('click', () => {
        const seeds = ensureSeeds(form);
        const on = !seeds.collections.includes(c.key);
        seeds.collections = on ? [...seeds.collections, c.key] : seeds.collections.filter((k) => k !== c.key);
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        changed();
      });
      collections.append(chip);
    }
  }, () => {});
  paintPicked();

  count.textContent = seedSummary(form.seeds);
  root.append(mine, more, count);
  return root;
}

/** What the calibrated threshold means, in words. Calibrated against the seeds' own field, the numbers are margins over
 *  each seed's usual similarity, which say little to a reader; the field share does.
 *  @param {import('../../../agent/src/radar-types').RadarThreshold} t @param {string[]} categories */
export function thresholdText(t, categories) {
  const field = t.calibration?.abstract?.field_cut;
  if (field != null) return `Keeping about the closest tenth of new papers in ${categories.join(', ') || 'your field'}: those nearer to one of your seed papers than that seed usually is to the field.`;
  return `Keeping papers at least ${t.abstract.toFixed(2)} close to a seed (abstract)${t.full != null ? `, ${t.full.toFixed(2)} for papers read whole` : ''}.`;
}
