// @ts-check
// ui-src/src/home/home.js. Home (spec 013, moved here for spec 014 G4): a greeting, today's reading radar issue with
// its papers in abstract form, then shelves of reports, chats and earlier issues. The web app paints it under its
// router (web/pages.js); Zotero and Obsidian mount HomeView in a tab and a view. Links go through HomeLinks
// (links.js), so the same page works with hash routes and with a plugin's own way of opening things.
import { h } from '../dom.js';
import { nextRunText } from '../chat/routines-data.js';
import { apiOf } from '../sources/view-kit.js';
import { mountSources } from '../sources/sources-view.js';
import { linkTo } from './links.js';
import { RadarDigest } from '../chat/radar-digest.js';

/** @typedef {import('./links.js').HomeTarget} HomeTarget */
/** @typedef {import('./links.js').HomeLinks} HomeLinks */
/** @typedef {{ host: any, doc: Document, links: HomeLinks, issue?: string, onWaiting?: (papers: number) => void }} HomeContext */

/** @param {Date} now */
function greeting(now) {
  const hour = now.getHours();
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Cover photos (covers/*.webp, named cover-*.webp in home.css; home-assets.mjs ships them with each build): skies
 *  and water for the reading radar's issues, earth and forest for everything else. The muted tone under each is what
 *  shows while a photo loads. */
const PHOTOS = { sky: 6, earth: 14, wide: 6 };
const COVER_TONES = 8;
const KIND_LABEL = /** @type {Record<string, string>} */ ({ chat: 'Chat', find: 'Find papers', report: 'Research report', systematic: 'Systematic review', radar: 'Reading radar' });
const PLACEHOLDER_TITLES = new Set(['New chat', 'Ask', '(untitled)', '']);

/** @param {string} id */
function hashOf(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

/** The class whose --photo (home.css) is one of the family's photos; the URL lives in the stylesheet so it resolves
 *  beside the sheet wherever the page itself is. @param {string} id @param {'sky' | 'earth' | 'wide'} family */
function photoOf(id, family) {
  return `sbw-photo-${family}-${(hashOf(id) % PHOTOS[family]) + 1}`;
}

/**
 * A Folio-style cover: a photo, a small caps label, a serif title, a short rule, an italic quote credited underneath,
 * the date at the foot. `kind` picks the photo family and the report's inner frame.
 * @param {Document} doc
 * @param {{ to: HomeTarget, id: string, kind: string, label: string, title: string, quote?: string, by?: string, foot: string, fresh?: boolean }} c
 * @param {HomeLinks} links
 */
function cover(doc, c, links) {
  // Chats are text cards; the photo is for what the radar and the reports made.
  const photo = c.kind === 'chat' || c.kind === 'find' ? 'is-text' : `sbw-tone-${hashOf(c.id) % COVER_TONES} ${photoOf(c.id, c.kind === 'radar' ? 'sky' : 'earth')}`;
  const card = linkTo(h(doc, 'a', `sbw-cover ${photo} is-${c.kind}`), c.to, links);
  const body = h(doc, 'span', 'sbw-cover-body');
  body.append(h(doc, 'span', 'sbw-cover-label', c.label), h(doc, 'span', 'sbw-cover-title', c.title), h(doc, 'span', 'sbw-cover-rule'));
  if (c.quote) body.append(h(doc, 'span', 'sbw-cover-line', c.quote));
  if (c.by) body.append(h(doc, 'span', 'sbw-cover-by', `— ${c.by}`));
  card.append(body, h(doc, 'span', 'sbw-cover-foot', c.foot));
  if (c.fresh) card.classList.add('is-new');
  return card;
}

/** "Today, 2:56 PM", "Yesterday", "Oct 10", or "Oct 10, 2025" for an older year. @param {string} iso */
function coverDate(iso) {
  const date = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `Today, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A radar issue is titled by its day: "Monday, October 12". @param {string} iso */
const issueDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
const sameDay = (/** @type {string} */ a, /** @type {string} */ b) => new Date(a).toDateString() === new Date(b).toDateString();

/** @typedef {{ at: string, card: Parameters<typeof cover>[1] }} Shelved */

/** A conversation as a cover: a radar run is that day's issue, a report reads as the report, a chat as its question.
 *  @param {any} c @param {Set<string>} radars @returns {Shelved} */
function shelved(c, radars) {
  const kind = c.cover?.kind === 'radar' || (c.routine && radars.has(c.routine)) ? 'radar' : (c.kind === 'systematic' ? 'report' : c.cover?.kind ?? c.kind ?? 'chat');
  /** @type {HomeTarget} */ const to = { to: 'session', id: c.id };
  const fresh = Boolean(c.news && Number(c.news.papers) > 0);
  if (kind === 'radar') {
    return { at: c.updated, card: { to: { to: 'issue', id: c.id }, id: c.id, kind, label: KIND_LABEL.radar, title: issueDate(c.updated), quote: c.cover?.quote, by: c.cover?.by, foot: c.cover?.count ?? coverDate(c.updated), fresh } };
  }
  // A title with a machine-made name in it ("Summarize stn-UYsg1j5y…") gives way to the cover's readable one.
  const unreadable = PLACEHOLDER_TITLES.has(c.title) || /(?=[\w-]*\d)[\w-]{20,}/.test(c.title);
  const title = (kind === 'report' || unreadable) && c.cover?.title ? c.cover.title : c.title;
  const quote = c.cover?.quote && c.cover.quote.toLowerCase() !== title.toLowerCase() ? c.cover.quote : undefined;
  const label = kind === 'report' ? KIND_LABEL[c.kind === 'systematic' ? 'systematic' : 'report'] : KIND_LABEL[kind] ?? 'Chat';
  return { at: c.updated, card: { to, id: c.id, kind, label, title, quote, by: c.cover?.by, foot: coverDate(c.updated), fresh } };
}

/** A radar whose last run found nothing still gets that day's issue, so the shelf has one cover per run day; one that
 *  never ran shows when the first issue comes. @param {any} routine @param {any[]} sessions @returns {Shelved | null} */
function quietIssue(routine, sessions) {
  /** @type {HomeTarget} */ const to = { to: 'routines' };
  const next = nextRunText(routine).replace(/^Next run: /, 'Next: ');
  const done = routine.lastDone ?? routine.lastRun?.at;
  if (!done) {
    return { at: routine.created ?? new Date().toISOString(), card: { to, id: routine.id, kind: 'radar', label: KIND_LABEL.radar, title: 'The first issue', quote: 'New papers on your topics, picked each morning.', foot: next } };
  }
  if (sessions.some((c) => c.routine === routine.id && sameDay(c.updated, done))) return null;
  const failed = routine.lastRun?.status === 'failed' || routine.lastRun?.status === 'skipped';
  return { at: done, card: { to, id: `${routine.id}-${done.slice(0, 10)}`, kind: 'radar', label: KIND_LABEL.radar, title: issueDate(done), quote: failed ? 'This run did not finish.' : 'Nothing new above the bar today.', foot: next } };
}

/** A paper of today's issue in abstract form: its graphical abstract on the right when the publisher has one, then the
 *  title (to the paper), who and where, why read it, where it was found, and the full abstract behind "Read the abstract".
 *  Under it, the radar's actions (Add to Zotero, Read later, Like, Dislike), which teach the radar what to show.
 *  @param {Document} doc @param {any} row @param {HomeLinks} links @param {(route: string, params?: any) => Promise<any>} [api]
 *  @param {RadarDigest | null} [digest] the issue's radar, for the row actions
 *  @param {'summary' | 'abstract'} [show] what the line under the title is: the AI's summary, or the paper's abstract */
function paperEntry(doc, row, links, api, digest, show = 'summary') {
  const entry = h(doc, 'article', 'sbw-paper');
  const text = h(doc, 'div', 'sbw-paper-text');
  const url = row.doi ? `https://doi.org/${row.doi}` : row.url;
  const title = h(doc, url ? 'a' : 'span', 'sbw-paper-title', row.title);
  if (url) linkTo(title, { to: 'url', url }, links);
  const authors = row.authors ?? [];
  const who = authors.length > 3 ? `${authors.slice(0, 3).join(', ')} +${authors.length - 3}` : authors.join(', ');
  const meta = [who, row.venue, row.radar?.date ?? row.year].filter(Boolean).join(' · ');
  text.append(title);
  if (meta) text.append(h(doc, 'p', 'sbw-paper-meta', meta));
  const abstract = String(row.abstract ?? '').trim();
  // The AI summary unless the person chose abstracts; a paper with no abstract keeps its summary either way.
  // Issues written before 2026-10-21 put "Close to “seed” (0.84, whole paper)." in front of the summary; only the summary shows.
  const line = String(row.radar?.why_line ?? row.radar?.reason ?? '').replace(/^Close to \u201C[^\u201D]*\u201D \([^)]*\)\.\s+(?=\S)/, '') || null;
  const why = show === 'abstract' && abstract ? null : line;
  if (why) text.append(h(doc, 'p', 'sbw-paper-why', why));
  else if (abstract) text.append(h(doc, 'p', 'sbw-paper-why', abstract));
  if (abstract && (why || abstract.length > 320)) {
    const more = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbw-paper-more'));
    const label = h(doc, 'summary', '', why ? 'Read the abstract' : 'Read more');
    more.append(label, h(doc, 'p', 'sbw-paper-abstract', abstract));
    // Without a why line the clamped preview above is the abstract itself; opening shows it in full instead.
    more.addEventListener('toggle', () => {
      label.textContent = more.open ? 'Show less' : why ? 'Read the abstract' : 'Read more';
      if (!why) text.querySelector('.sbw-paper-why')?.toggleAttribute('hidden', more.open);
    });
    text.append(more);
  }
  const via = (row.foundBy ?? []).filter(Boolean);
  if (via.length) text.append(h(doc, 'p', 'sbw-paper-source', `Found via ${via.join(', ')}`));
  if (digest) { text.append(digest.actions(row)); digest.mark(entry, row); }
  entry.append(text);
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/.exec(`${row.pdfUrl ?? ''} ${row.url ?? ''}`)?.[1];
  if (api && (row.doi || arxiv)) {
    void api('/paper-figure', { doi: row.doi ?? '', ...(arxiv ? { arxiv } : {}) }).then((found) => {
      if (!found?.image) return;
      const img = /** @type {HTMLImageElement} */ (h(doc, 'img', 'sbw-paper-figure'));
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.addEventListener('load', () => entry.classList.add('has-figure'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = found.image;
      const link = h(doc, url ? 'a' : 'span', 'sbw-paper-figure-box');
      if (url) { linkTo(link, { to: 'url', url }, links); link.tabIndex = -1; }
      link.append(img);
      entry.append(link);
    }, () => {});
  }
  return entry;
}

/** Today: a radar issue across the full width, a photo banner over its papers in abstract form, with ‹ › to step
 *  back through earlier days. Today with nothing new yet says so; no radar at all offers to set one up.
 *  @param {Document} doc @param {any} ai @param {any} host @param {HomeLinks} links
 *  @param {{ issues: any[], routine: any | null, pick?: string, unknown?: boolean }} radar issues newest first; `pick` opens on that issue;
 *  `unknown`: the routines could not be read, so whether a radar exists is not known */
async function todayBlock(doc, ai, host, links, { issues, routine, pick, unknown }) {
  const block = h(doc, 'section', 'sbw-today');
  const api = apiOf(host);
  if (!routine && !issues.length && unknown) {
    block.append(h(doc, 'p', 'sbw-hint', "Couldn't read your reading radar from the server just now. It is still there; reload in a moment."));
    return block;
  }
  if (!routine && !issues.length) {
    const banner = linkTo(h(doc, 'a', `sbw-today-banner sbw-cover ${photoOf('setup', 'wide')} is-radar`), { to: 'sources' }, links);
    const body = h(doc, 'span', 'sbw-cover-body');
    body.append(h(doc, 'span', 'sbw-cover-label', KIND_LABEL.radar), h(doc, 'span', 'sbw-cover-title', 'Set up a reading radar'), h(doc, 'span', 'sbw-cover-rule'), h(doc, 'span', 'sbw-cover-line', 'New papers on your topics, every morning.'));
    banner.append(body);
    block.append(banner);
    return block;
  }
  const now = new Date().toISOString();
  // -1 is "today, nothing yet": shown only while today has no issue of its own.
  const first = issues[0] && sameDay(issues[0].updated, now) ? 0 : -1;
  const picked = pick ? issues.findIndex((i) => i.id === pick) : -1;
  let at = picked >= 0 ? picked : first;
  const stage = h(doc, 'div', 'sbw-today-stage');
  const nav = h(doc, 'nav', 'sbw-today-nav');
  nav.setAttribute('aria-label', 'Radar issues');
  const older = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-today-older'));
  const newer = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-today-newer'));
  older.type = 'button';
  newer.type = 'button';
  const list = h(doc, 'div', 'sbw-papers');
  // Two columns only where the page is wide enough (home.css, a container query); Settings > General can keep it to one.
  const oneColumn = host.prefs.get('homeColumns');
  list.classList.toggle('is-one', oneColumn === 'one' || oneColumn === 1);
  // Under each paper: the AI's summary (default) or the paper's own abstract, the person's choice, remembered.
  const shows = h(doc, 'div', 'sbw-layout');
  shows.setAttribute('role', 'group');
  shows.setAttribute('aria-label', 'Under each paper');
  /** @type {'summary' | 'abstract'} */ let textMode = host.prefs.get('radarText') === 'abstract' ? 'abstract' : 'summary';
  for (const [mode, label] of /** @type {const} */ ([['summary', 'AI summary'], ['abstract', 'Abstract']])) {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-layout-btn', label));
    b.type = 'button';
    b.dataset.text = mode;
    b.setAttribute('aria-pressed', String(textMode === mode));
    b.addEventListener('click', () => {
      if (textMode === mode) return;
      textMode = mode;
      host.prefs.set('radarText', mode);
      for (const x of Array.from(shows.children)) x.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (x).dataset.text === mode));
      void paint();
    });
    shows.append(b);
  }
  const bar = h(doc, 'div', 'sbw-today-bar');
  const sources = linkTo(h(doc, 'a', 'sbw-quiet sbw-today-sources', 'Sources'), { to: 'sources' }, links);
  // The issue reads here as a list; its chat is one step away for questions about it.
  const chat = h(doc, 'a', 'sbw-quiet sbw-today-chat', 'Chat about this issue');
  bar.append(nav, chat, sources, shows);
  nav.append(older, newer);
  block.append(stage, bar, list);

  let painting = 0;
  /** @type {RadarDigest | null} */ let digest = null;
  const paint = async () => {
    const mine = ++painting;
    const issue = at >= 0 ? issues[at] : null;
    const isToday = Boolean(issue && sameDay(issue.updated, now)) || at === -1;
    const look = `sbw-today-banner sbw-cover ${photoOf(issue?.id ?? routine?.id ?? 'today', 'wide')} is-radar`;
    const banner = issue ? h(doc, 'div', look) : linkTo(h(doc, 'a', look), { to: 'routines' }, links);
    const freshChat = h(doc, 'a', 'sbw-quiet sbw-today-chat', 'Chat about this issue');
    if (issue) linkTo(freshChat, { to: 'session', id: issue.id }, links);
    freshChat.hidden = !issue;
    bar.querySelector('.sbw-today-chat')?.replaceWith(freshChat);
    const body = h(doc, 'span', 'sbw-cover-body');
    const next = routine ? nextRunText(routine).replace(/^Next run: /, 'Next issue ') : '';
    body.append(h(doc, 'span', 'sbw-cover-label', isToday ? "Today's reading radar" : KIND_LABEL.radar), h(doc, 'span', 'sbw-cover-title', issueDate(issue?.updated ?? now)), h(doc, 'span', 'sbw-cover-rule'),
      h(doc, 'span', 'sbw-cover-line', issue ? (issue.cover?.count ?? '') : `Nothing new yet today. ${next}`.trim()));
    banner.append(body);
    if (issue?.news) banner.classList.add('is-new');
    stage.replaceChildren(banner);
    const olderIssue = issues[at + 1];
    const newerAt = at - 1 >= first ? at - 1 : null;
    older.hidden = !olderIssue;
    older.textContent = olderIssue ? `‹ ${shortDay(olderIssue.updated)}` : '';
    newer.hidden = newerAt === null;
    newer.textContent = newerAt === null ? '' : newerAt === -1 || sameDay(issues[newerAt].updated, now) ? 'Today ›' : `${shortDay(issues[newerAt].updated)} ›`;
    shows.hidden = !issue;
    list.replaceChildren();
    if (!issue) return;
    try {
      const view = await ai.sessions.view(issue.id);
      for (const result of view.results ?? []) {
        if (result.kind !== 'papers') continue;
        const body = await ai.sessions.read(issue.id, result.ref);
        const rows = body?.rows ?? [];
        if (mine !== painting) return;
        if (result.title && result.title !== 'New') list.append(h(doc, 'h3', 'sbw-papers-head', result.title));
        // The same row actions as the issue's chat view, so a paper can be rated where it is read.
        const radar = body?.radar?.routine ? body.radar : null;
        digest = radar && (digest?.routine === radar.routine ? digest : new RadarDigest(host, doc, block, { routine: radar.routine, summary: radar.summary ?? '' }));
        for (const row of rows) list.append(paperEntry(doc, row, links, api, digest, textMode));
      }
    } catch {
      if (mine === painting) list.replaceChildren(h(doc, 'p', 'sbw-hint', "Couldn't load this issue's papers."));
    }
  };
  older.addEventListener('click', () => { if (issues[at + 1]) { at += 1; void paint(); } });
  newer.addEventListener('click', () => { if (at - 1 >= first) { at -= 1; void paint(); } });
  await paint();
  return block;
}

/** "Oct 10" for the ‹ › buttons. @param {string} iso */
const shortDay = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

const PAGE = 8;

/** A titled shelf of covers, 8 at a time, with Previous and Next under it when there are more.
 *  @param {Document} doc @param {string} title @param {Shelved[]} items @param {HomeLinks} links */
function shelfSection(doc, title, items, links) {
  const box = h(doc, 'section', 'sbw-shelf');
  const head = h(doc, 'div', 'sbw-shelf-head');
  head.append(h(doc, 'h2', 'sbw-shelf-title', title), h(doc, 'span', 'sbw-shelf-count', String(items.length)));
  const grid = h(doc, 'div', 'sbw-covers');
  box.append(head, grid);
  const pages = Math.ceil(items.length / PAGE);
  const pager = h(doc, 'nav', 'sbw-pager');
  pager.setAttribute('aria-label', `${title} pages`);
  const prev = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-pager-prev', 'Previous'));
  const next = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-pager-next', 'Next'));
  const where = h(doc, 'span', 'sbw-pager-where');
  prev.type = 'button';
  next.type = 'button';
  pager.append(prev, where, next);
  let page = 0;
  const show = () => {
    grid.replaceChildren(...items.slice(page * PAGE, (page + 1) * PAGE).map((item) => cover(doc, item.card, links)));
    where.textContent = `${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  };
  prev.addEventListener('click', () => { page = Math.max(0, page - 1); show(); });
  next.addEventListener('click', () => { page = Math.min(pages - 1, page + 1); show(); });
  show();
  if (pages > 1) box.append(pager);
  return box;
}

/** A greeting with the count of what is waiting; today's radar issue across the full width; then research reports,
 *  chats and earlier issues, each its own shelf, newest first, 8 a page.
 *  @param {HTMLElement} into @param {HomeContext} ctx */
export async function paintHome(into, ctx) {
  const { host, doc, links } = ctx;
  const page = h(doc, 'div', 'sbw-page sbw-home');
  const top = h(doc, 'header', 'sbw-home-top');
  const count = h(doc, 'p', 'sbw-home-date', new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }));
  top.append(h(doc, 'h1', 'sbw-h1', greeting(new Date())), count);
  const content = h(doc, 'div', 'sbw-home-body');
  page.append(top, content);
  into.replaceChildren(page);
  content.replaceChildren(h(doc, 'p', 'sbw-hint', 'Loading…'));
  let ai;
  let conversations = [];
  let routines = [];
  // A failed routines call is not "no radar": Home must not offer to set one up while the server restarts.
  let routinesFailed = false;
  try {
    ai = await host.ai();
    [conversations, routines] = await Promise.all([ai.conversations.list().catch(() => []), ai.routines?.list().catch((/** @type {unknown} */ error) => { routinesFailed = true; host.logError(error); return []; }) ?? []]);
  } catch (error) {
    host.logError(error);
    content.replaceChildren(h(doc, 'p', 'sbw-hint', "Couldn't reach the Veritas server."));
    return;
  }

  const waiting = conversations.reduce((/** @type {number} */ sum, /** @type {any} */ c) => sum + (Number(c.news?.papers) || 0), 0);
  if (waiting) count.textContent = `${waiting} new ${waiting === 1 ? 'paper' : 'papers'}`;
  ctx.onWaiting?.(waiting);
  const radarRoutines = routines.filter((/** @type {any} */ r) => !r.broken && (r.kind === 'radar' || r.radar) && r.status === 'active');
  const radars = new Set(radarRoutines.map((/** @type {any} */ r) => r.id));
  const newest = (/** @type {Shelved[]} */ list) => list.sort((a, b) => (a.at < b.at ? 1 : -1));
  const shown = conversations.filter((/** @type {any} */ c) => c.cover || !PLACEHOLDER_TITLES.has(c.title));
  const kindOf = (/** @type {any} */ c) => shelved(c, radars).card.kind;
  const issues = [...shown.filter((/** @type {any} */ c) => kindOf(c) === 'radar')].sort((a, b) => (a.updated < b.updated ? 1 : -1));
  const today = issues[0] && sameDay(issues[0].updated, new Date().toISOString()) ? issues[0] : null;

  // Until a radar exists (or the person puts it off), Home opens on who and what to follow instead of an empty Today.
  const intro = !routinesFailed && !routines.some((/** @type {any} */ r) => r.kind === 'radar' || r.radar) && !host.prefs.get('sourcesIntroDone');
  const sections = [];
  if (intro) {
    const slot = h(doc, 'section', 'sbw-today');
    sections.push(slot);
    void mountSources(slot, { host, doc, links }, { mode: 'intro', routines, onDone: () => { void paintHome(into, ctx); } });
  } else sections.push(await todayBlock(doc, ai, host, links, { issues, routine: radarRoutines[0] ?? null, pick: ctx.issue, unknown: routinesFailed }));
  const reports = newest(shown.filter((/** @type {any} */ c) => kindOf(c) === 'report').map((/** @type {any} */ c) => shelved(c, radars)));
  const chats = newest(shown.filter((/** @type {any} */ c) => ['chat', 'find'].includes(kindOf(c))).map((/** @type {any} */ c) => shelved(c, radars)));
  const earlier = newest(issues.filter((/** @type {any} */ c) => c !== today).map((/** @type {any} */ c) => shelved(c, radars)));
  for (const routine of radarRoutines) {
    const quiet = quietIssue(routine, conversations);
    if (quiet && !sameDay(quiet.at, new Date().toISOString())) earlier.push(quiet);
  }
  newest(earlier);
  if (reports.length) sections.push(shelfSection(doc, 'Research reports', reports, links));
  if (chats.length) sections.push(shelfSection(doc, 'Chats', chats, links));
  if (earlier.length) sections.push(shelfSection(doc, 'Earlier issues', earlier, links));
  if (!reports.length && !chats.length) sections.push(h(doc, 'p', 'sbw-hint', 'Your conversations will appear here.'));
  content.replaceChildren(...sections);
  if (ctx.issue) page.scrollIntoView?.({ block: 'start' });
}


/**
 * Home for the plugins: a scrolling view that shows Home, or the Sources page in its place, and hands chats, routines
 * and web pages to `open` (Zotero opens its AI tab or the browser; Obsidian its chat view or the browser).
 * `refresh()` repaints out of sight and swaps the result in, so coming back to the tab does not flash "Loading…".
 * @param {Document} doc @param {any} host a UiHost
 * @param {{ open: (target: Exclude<HomeTarget, { to: 'home' | 'sources' | 'issue' }>) => void }} options
 */
export function HomeView(doc, host, { open }) {
  const root = h(doc, 'div', 'sb-home-view');
  /** @type {'home' | 'sources'} */ let showing = 'home';
  let painted = 0;
  /** @type {HomeLinks} */
  const links = { open: (target) => {
    if (target.to === 'home' || target.to === 'sources') void show(target.to);
    else if (target.to === 'issue') void show('home', target.id);
    else open(target);
  } };
  /** @param {'home' | 'sources'} page @param {string} [issue] an earlier radar issue to open on */
  async function show(page, issue) {
    const mine = ++painted;
    showing = page;
    const slot = h(doc, 'div', 'sb-home-slot');
    if (page === 'sources') {
      root.replaceChildren(slot);
      root.scrollTop = 0;
      await mountSources(slot, { host, doc, links }, { mode: 'page' });
      return;
    }
    if (!root.firstChild) root.append(slot);
    await paintHome(slot, { host, doc, links, issue });
    if (mine === painted && slot.parentNode !== root) root.replaceChildren(slot);
    if (issue) root.scrollTop = 0;
  }
  void show('home');
  return { root, refresh: () => (showing === 'home' ? show('home') : Promise.resolve()) };
}
