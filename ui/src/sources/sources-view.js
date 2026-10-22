// @ts-check
// ui-src/src/web/sources-view.js. Spec 014 G1: "Who and what do you want to follow?". One component, two places: the
// Sources page (#/sources) and, until the person has set a radar up or put it off, the top of Home. It reads and writes
// the reading radar routine's config through the same form the setup sheet uses (chat/radar-data.js), so the two never
// disagree; nothing new is stored but the `sourcesIntroDone` preference.
import { h, SVG_NS } from '../dom.js';
import { icon } from '../icons.js';
import { learnedNote, learningText, learningOf, newForm, formFromRoutine, radarProblem, draftFromForm, checkNotice, addFeed, addJournal, mcpChoices, mergeMcp } from '../chat/radar-data.js';
import { nextRunText } from '../chat/routines-data.js';
import { linkTo } from '../home/links.js';
import {
  GROUPS, startEmpty, isLearned, dropLearned, catalogOf, isFollowed, setFollowed, followedCount, suggestionOf, addTyped, whenText, monogram, sourceLabels, journalRow,
} from './sources-data.js';
import { seedsPanel, thresholdText } from './seeds-view.js';
import { logoFor, iconFor, siteIconUrl } from '../logos.js';
import { personAvatar } from '../avatars.js';

/** @typedef {import('./sources-data.js').Entry} Entry */
/** @typedef {import('./sources-data.js').GroupId} GroupId */

/** The ring fills as the count nears this many; more is still counted, the arc just stays full. */
const RING_GOAL = 12;
const isRadar = (/** @type {any} */ r) => !r.broken && (r.kind === 'radar' || r.radar);

/** @param {Document} doc @param {string} tag @param {Record<string, string | number>} [attrs] @param {string} [cls] @param {string} [text] */
function svgEl(doc, tag, attrs = /** @type {Record<string, string | number>} */ ({}), cls = '', text = undefined) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (cls) el.setAttribute('class', cls);
  if (text != null) el.textContent = text;
  return el;
}

/** The count in a ring. @param {Document} doc @param {number} n */
function ring(doc, n) {
  const r = 48, c = 2 * Math.PI * r;
  const svg = svgEl(doc, 'svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': `${n} followed` }, 'sbw-src-ring-svg');
  svg.append(
    svgEl(doc, 'circle', { cx: 60, cy: 60, r, fill: 'none', 'stroke-width': 6 }, 'sbw-src-ring-track'),
    // a zero-length round-capped arc still draws a dot, so nothing is drawn until something is followed
    svgEl(doc, 'circle', { cx: 60, cy: 60, r, fill: 'none', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * Math.min(1, n / RING_GOAL)} ${c}`, transform: 'rotate(-90 60 60)', ...(n ? {} : { visibility: 'hidden' }) }, 'sbw-src-ring-fill'),
    svgEl(doc, 'text', { x: 60, y: 66, 'text-anchor': 'middle' }, 'sbw-src-ring-n', String(n)),
  );
  return svg;
}

/** Today's cover in the middle, the followed sources around it on dashed lines. Site icons only in the web app, which
 *  shares the server's address. @param {Document} doc @param {string[]} labels @param {boolean} [web] */
function diagram(doc, labels, web = false) {
  const svg = svgEl(doc, 'svg', { viewBox: '0 0 480 220', role: 'img', 'aria-label': labels.length ? `Today's cover, fed by ${labels.join(', ')}` : "Today's cover, ready for the sources you follow" }, 'sbw-src-diagram');
  const spots = /** @type {[number, number, string][]} */ ([[50, 40, 'l'], [430, 40, 'r'], [50, 110, 'l'], [430, 110, 'r'], [50, 180, 'l'], [430, 180, 'r']]);
  spots.forEach(([x, y, side], i) => {
    const label = labels[i];
    const edge = side === 'l' ? 190 : 290;
    svg.append(svgEl(doc, 'line', { x1: side === 'l' ? x + 24 : x - 24, y1: y, x2: edge, y2: 60 + (i >> 1) * 50, 'stroke-dasharray': '4 4' }, `sbw-src-link${label ? '' : ' is-ghost'}`));
    svg.append(svgEl(doc, 'circle', { cx: x, cy: y, r: 24 }, `sbw-src-node${label ? '' : ' is-ghost'}`));
    if (label) {
      // the source's own logo when there is one (logos.js), else its monogram
      const logo = logoFor(label);
      const site = logo || !web ? null : siteIconUrl({ label });
      const initials = () => svgEl(doc, 'text', { x, y: y + 5, 'text-anchor': 'middle' }, 'sbw-src-mono', monogram(label));
      const mark = logo
        ? svgEl(doc, 'path', { d: logo.path, transform: `translate(${x - 12} ${y - 12})`, fill: logo.hex === '000000' ? 'currentColor' : `#${logo.hex}` }, 'sbw-src-logo')
        : site ? svgEl(doc, 'image', { href: site, x: x - 12, y: y - 12, width: 24, height: 24 }, 'sbw-src-logo') : initials();
      if (site) mark.addEventListener('error', () => { const t = initials(); t.append(svgEl(doc, 'title', {}, '', label)); mark.replaceWith(t); }, { once: true });
      mark.append(svgEl(doc, 'title', {}, '', label));
      svg.append(mark);
    }
  });
  const day = new Date();
  svg.append(
    svgEl(doc, 'rect', { x: 190, y: 20, width: 100, height: 180, rx: 6 }, 'sbw-src-cover'),
    svgEl(doc, 'text', { x: 240, y: 56, 'text-anchor': 'middle' }, 'sbw-src-cover-label', "TODAY'S"),
    svgEl(doc, 'text', { x: 240, y: 84, 'text-anchor': 'middle' }, 'sbw-src-cover-title', 'Reading'),
    svgEl(doc, 'text', { x: 240, y: 104, 'text-anchor': 'middle' }, 'sbw-src-cover-title', 'radar'),
    svgEl(doc, 'line', { x1: 228, y1: 118, x2: 252, y2: 118 }, 'sbw-src-cover-rule'),
    svgEl(doc, 'text', { x: 240, y: 180, 'text-anchor': 'middle' }, 'sbw-src-cover-date', day.toLocaleDateString([], { month: 'short', day: 'numeric' })),
  );
  return svg;
}

/**
 * Mounts the page. `intro` is Home's first-run top half: no explainer, "Not now" beside Save, and `onDone` when it ends.
 * @param {HTMLElement} into @param {{ host: any, doc: Document, links: import('../home/links.js').HomeLinks }} ctx
 * @param {{ mode: 'page' | 'intro' | 'settings', routines?: any[], onDone?: () => void }} options
 */
export async function mountSources(into, { host, doc, links }, { mode, routines: known, onDone }) {
  const root = h(doc, 'div', mode === 'intro' ? 'sbw-sources is-intro' : mode === 'settings' ? 'sbw-sources is-settings' : 'sbw-page sbw-sources');
  into.replaceChildren(root);
  const hint = (/** @type {string} */ text) => root.replaceChildren(h(doc, 'p', 'sbw-hint', text));
  hint('Loading…');

  /** @type {any} */ let ai;
  /** @type {any[]} */ let routines = known ?? [];
  try {
    ai = await host.ai();
    if (!known) routines = (await ai.routines?.list()) ?? [];
  } catch (error) {
    host.logError?.(error);
    hint("Couldn't reach the Veritas server.");
    return;
  }
  if (!ai.routines || !ai.radar) { hint('The reading radar needs the updated Veritas server. Restart it and try again.'); return; }

  let routine = routines.find((r) => isRadar(r) && r.status === 'active') ?? routines.find(isRadar) ?? null;
  const form = routine ? formFromRoutine(routine) : startEmpty(newForm());
  const seedsKey = (/** @type {any} */ seeds) => JSON.stringify([seeds.mine.map((/** @type {any} */ m) => m.title).sort(), [...seeds.papers].sort(), [...seeds.collections].sort()]);
  const seedsAtLoad = form.seeds ? seedsKey(form.seeds) : '';
  let calibrated = '';
  /** @type {{ topics: any[], authors: any[], journals: any[] } | null} */
  let seed = null;
  let seedNote = '';
  const [seeded, tools] = await Promise.allSettled([ai.radar.profile(form.scope), ai.mcp?.list?.() ?? []]);
  if (seeded.status === 'fulfilled') seed = seeded.value; else seedNote = `Could not read your library: ${String(seeded.reason?.message ?? seeded.reason)}`;
  if (tools.status === 'fulfilled') form.mcp = mergeMcp(mcpChoices(tools.value), form.mcp);
  const catalog = catalogOf(form, seed);
  const learning = learningOf(routine);

  // ---- the parts that repaint when anything is followed or dropped
  const ringBox = h(doc, 'div', 'sbw-src-ring');
  const suggest = h(doc, 'div', 'sbw-src-suggest');
  const explain = h(doc, 'section', 'sbw-src-explain');
  /** @type {Map<string, HTMLButtonElement>} */
  const chips = new Map();

  /** @param {Entry} e */
  function paintChip(e) {
    const id = `${e.group}|${e.key}`;
    let b = chips.get(id);
    if (!b && isLearned(e)) {
      // A learned topic is not a toggle: it stays on until the person removes it with the ×, and then it is never learned again.
      const chip = /** @type {HTMLElement} */ (h(doc, 'span', 'sbw-chip is-on is-learned'));
      chip.dataset.group = e.group;
      chip.title = learnedNote(e.value);
      const x = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-chip-x', '\u00D7'));
      x.type = 'button';
      x.setAttribute('aria-label', `Stop learning ${e.label}`);
      x.addEventListener('click', async () => {
        x.disabled = true;
        try {
          if (routine?.id) await ai.radar.forgetTopic(routine.id, e.label);
          dropLearned(form, catalog, e);
          chips.delete(id);
          for (const gr of groupViews) gr.draw();
          refresh();
        } catch (error) { x.disabled = false; host.logError?.(error); }
      });
      chip.append(h(doc, 'span', 'sbw-chip-label', e.label), h(doc, 'span', 'sbw-chip-tag', 'Learned'), x);
      chips.set(id, /** @type {any} */ (chip));
      return /** @type {any} */ (chip);
    }
    if (b && isLearned(e)) return b;
    if (!b) {
      b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-chip'));
      b.type = 'button';
      b.dataset.group = e.group;
      // the source's own mark: a bundled logo, else the site's icon (journals by OpenAlex id, feeds by address)
      if (e.group === 'authors') b.append(personAvatar(doc, { size: 16, label: e.label, name: e.label }));  // a person, not a publication
      else if (['databases', 'journals', 'feeds'].includes(e.group)) b.append(iconFor(doc, { label: e.label, openalexId: e.value?.openalexId ?? null, url: e.value?.url ?? null }, { size: 14, web: host.kind === 'web', cls: 'sb-logo sbw-chip-logo' }));
      b.append(h(doc, 'span', 'sbw-chip-label', e.label), h(doc, 'span', 'sbw-chip-mark'));
      if (e.meta) b.title = e.meta;
      b.addEventListener('click', () => { setFollowed(form, e, !isFollowed(form, e)); refresh(); });
      chips.set(id, b);
    }
    const on = isFollowed(form, e);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.querySelector('.sbw-chip-mark')?.replaceChildren(icon(doc, on ? 'check' : 'plus', 'sb-p-icon sbw-chip-icon'));
    return b;
  }

  function refresh() {
    for (const list of Object.values(catalog)) for (const e of list) paintChip(e);
    const n = followedCount(form);
    ringBox.replaceChildren(ring(doc, n), h(doc, 'span', 'sbw-src-ring-label', 'followed'));
    const next = suggestionOf(form, seed);
    suggest.replaceChildren();
    if (next) {
      const follow = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-src-follow', 'Follow'));
      follow.type = 'button';
      follow.addEventListener('click', () => { setFollowed(form, next.entry, true); refresh(); });
      suggest.append(h(doc, 'p', 'sbw-src-suggest-text', next.text), follow);
    } else {
      suggest.append(h(doc, 'p', 'sbw-src-suggest-text', seed ? 'You follow everything your library suggests. Add anything else below.' : seedNote || 'Add what you read about below.'));
    }
    paintExplain();
  }

  function paintExplain() {
    explain.replaceChildren();
    if (mode === 'intro') return;
    const sizes = form.size;
    const cols = h(doc, 'div', 'sbw-src-cols');
    const col = (/** @type {string} */ title, /** @type {string} */ text) => { const c = h(doc, 'div', 'sbw-src-col'); c.append(h(doc, 'h3', 'sbw-src-col-title', title), h(doc, 'p', 'sbw-src-col-text', text)); return c; };
    cols.append(
      col('What it includes', `Up to ${sizes.fresh} new papers from the places you follow, ${sizes.older} older ${sizes.older === 1 ? 'paper' : 'papers'} your library keeps citing, and up to ${sizes.discover} that none of them published.`),
      col('When', whenText(form)),
      col('How to read it', 'Open Today on Home. Each paper says why it is there. Add, Read later, Like and Dislike teach the radar what you want.'),
    );
    explain.append(h(doc, 'h2', 'sbw-src-h2', 'How your radar works'), diagram(doc, sourceLabels(form), host.kind === 'web'), h(doc, 'p', 'sbw-src-powered', 'Powered by your sources'), cols);
  }

  // ---- the five groups
  /** @param {{ id: GroupId, title: string, hint: string, add: string }} g */
  function paintGroup(g) {
    const box = h(doc, 'section', 'sbw-src-group');
    box.dataset.group = g.id;
    const heading = h(doc, 'h2', 'sbw-src-h2', g.title);
    const list = h(doc, 'div', 'sbw-chips');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', g.title);
    const draw = () => list.replaceChildren(...catalog[g.id].map(paintChip));
    box.append(heading, h(doc, 'p', 'sbw-src-hint', g.hint), list);
    draw();
    if (g.id === 'topics' && learning.length) {
      const wait = h(doc, 'p', 'sbw-src-learning');
      wait.append(h(doc, 'span', 'sbw-src-learning-h', 'Learning\u2026'), ' ', ...learning.flatMap((l, i) => [...(i ? [', '] : []), h(doc, 'span', 'sbw-src-learning-item', learningText(l))]));
      wait.title = 'Phrases from papers you kept. After three, the radar starts searching for them.';
      box.append(wait);
    }
    if (!g.add) return { box, draw };

    const row = h(doc, 'form', 'sbw-src-add');
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-src-input'));
    input.type = 'text'; input.placeholder = g.add; input.setAttribute('aria-label', g.add); input.autocomplete = 'off';
    const go = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Add'));
    go.type = 'submit';
    const note = h(doc, 'div', 'sbw-src-note');
    note.setAttribute('aria-live', 'polite');
    row.append(input, go);
    box.append(row, note);
    const say = (/** @type {string} */ text, /** @type {string} */ tone = 'ok', /** @type {Node[]} */ extra = []) => { note.className = `sbw-src-note is-${tone}`; note.replaceChildren(...(text ? [h(doc, 'span', '', text)] : []), ...extra); };
    const added = (/** @type {Entry} */ e, /** @type {string} */ text) => {
      if (!catalog[e.group].some((x) => x.key === e.key)) catalog[e.group].push(e);
      setFollowed(form, e, true);
      input.value = '';
      for (const gr of groupViews) gr.draw();
      refresh();
      say(text);
    };
    /** A checked address, name or ISSN lands in whichever group it belongs to, whichever box it was typed in. @param {import('../chat/radar-data.js').SourceCheck} result */
    const take = (result) => {
      const n = checkNotice(result);
      if (n.feed) { addFeed(form, n.feed); const e = catalog.feeds.find((x) => x.key === n.feed?.url) ?? { group: /** @type {const} */ ('feeds'), key: n.feed.url, label: n.feed.title, meta: n.feed.url, value: { ...n.feed, on: true } }; added(e, `Following ${n.feed.title}.`); return; }
      if (result.kind === 'journal') { addJournal(form, result); added(journalRow(result), `Following ${result.name}.`); return; }
      const picks = n.options.map((j) => {
        const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-src-pick'));
        b.type = 'button';
        b.append(h(doc, 'span', 'sbw-src-pick-name', j.name), h(doc, 'span', 'sbw-src-pick-meta', j.match));
        b.addEventListener('click', () => { addJournal(form, j); added(journalRow(j), `Following ${j.name}.`); });
        return b;
      });
      say(n.text, n.tone, picks);
    };
    row.addEventListener('submit', async (event) => {
      event.preventDefault();
      const typed = input.value.trim();
      if (!typed) return;
      if (g.id === 'topics' || g.id === 'authors') {
        const e = addTyped(form, catalog, g.id, typed);
        input.value = '';
        if (!e) { say(`You already follow ${typed}.`, 'warn'); return; }
        for (const gr of groupViews) gr.draw();
        refresh();
        say(`Following ${e.label}.`);
        return;
      }
      go.disabled = true;
      say('Checking…', 'warn');
      try { take(await ai.radar.checkSource(typed)); } catch (error) { say(String(/** @type {any} */ (error)?.message ?? error), 'error'); }
      go.disabled = false;
    });
    return { box, draw };
  }
  /** @type {{ box: HTMLElement, draw: () => void }[]} */
  const groupViews = GROUPS.map(paintGroup);

  // ---- save
  const status = h(doc, 'p', 'sbw-src-status');
  status.setAttribute('aria-live', 'polite');
  const save = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary sbw-src-save', mode === 'intro' ? 'Start my radar' : routine ? 'Save changes' : 'Save my radar'));
  save.type = 'button';
  const actions = h(doc, 'div', 'sbw-src-actions');
  actions.append(save);
  if (mode === 'intro') {
    const later = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-src-later', 'Not now'));
    later.type = 'button';
    later.addEventListener('click', () => { host.prefs.set('sourcesIntroDone', true); onDone?.(); });
    actions.append(later);
  }
  actions.append(status);
  save.addEventListener('click', async () => {
    const problem = radarProblem(form);
    if (problem) { status.className = 'sbw-src-status is-error'; status.textContent = problem.replace('Turn on at least one place to look.', 'Follow at least one place to look: a database, journal, author or feed.'); return; }
    save.disabled = true;
    status.className = 'sbw-src-status';
    status.textContent = 'Saving…';
    try {
      // Seeds chosen or changed: their arXiv categories and a threshold calibrated on this library (G2, G4).
      if (form.seeds && (!form.threshold || seedsKey(form.seeds) !== seedsAtLoad)) {
        status.textContent = 'Finding your arXiv categories and calibrating the threshold on your library. This takes a minute or two…';
        const prepared = await ai.radar.prepareSeeds(form.seeds);
        form.seeds.categories = prepared.categories;
        if (prepared.threshold) form.threshold = prepared.threshold;
        calibrated = prepared.problem ?? (prepared.threshold ? `${thresholdText(prepared.threshold, prepared.categories)} arXiv categories: ${prepared.categories.join(', ') || 'none found'}.` : '');
        status.textContent = 'Saving…';
      }
      const draft = draftFromForm(form);
      if (routine?.id) await ai.routines.update(routine.id, draft);
      else routine = (await ai.routines.create(draft)) ?? { id: null, ...draft };
      host.prefs.set('sourcesIntroDone', true);
    } catch (error) {
      save.disabled = false;
      status.className = 'sbw-src-status is-error';
      status.textContent = String(/** @type {any} */ (error)?.message ?? error);
      return;
    }
    save.disabled = false;
    if (mode === 'intro') { onDone?.(); return; }
    save.textContent = 'Save changes';
    status.textContent = `Saved. ${calibrated ? `${calibrated} ` : ''}${routine?.nextRun ? nextRunText(routine).replace(/^Next run: /, 'Your next issue: ') : 'Your first issue comes at the next run.'}`;
    status.replaceChildren(status.textContent, ' ', linkTo(h(doc, 'a', 'sbw-src-home', 'Back to Home'), { to: 'home' }, links));
  });

  // ---- assemble
  const title = h(doc, 'h1', 'sbw-src-title');
  title.append('The ', h(doc, 'em', '', 'more'), ' you follow, the ', h(doc, 'em', '', 'richer'), ' your radar gets.');
  const hero = h(doc, 'div', 'sbw-src-hero');
  hero.append(ringBox, suggest);
  // Spec radar-seeds G1: the radar starts from papers (yours first), then what else to follow.
  const seedsBox = seedsPanel(doc, host, ai, form, refresh);
  root.replaceChildren(title, hero, seedsBox, ...groupViews.map((g) => g.box), actions, explain);
  refresh();
}
