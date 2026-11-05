// @ts-check
// ui-src/src/home/home.js. Home (spec 013, moved here for spec 014 G4): a greeting, today's reading radar issue with
// its papers in abstract form, then shelves of reports and earlier issues. The web app paints it under its
// router (web/pages.js); Zotero and Obsidian mount HomeView in a tab and a view. Links go through HomeLinks
// (links.js), so the same page works with hash routes and with a plugin's own way of opening things.
import { h } from '../dom.js';
import { lucide } from '../icons.js';
import { nextRunText, runNowLine, runStatus } from '../chat/routines-data.js';
import { apiOf } from '../sources/view-kit.js';
import { mountSources } from '../sources/sources-view.js';
import { linkTo } from './links.js';
import { RadarDigest, markViewed } from '../chat/radar-digest.js';
import { whyChips, openLinks, judgedLine, keyAction, actionList } from '../chat/radar-digest-data.js';
import { arxivAuthors, plainName } from '../../../agent/src/paper-names.js';

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

/** Calls `onView` when the link is followed: a click, a middle click (a new tab), or Enter on a plugin's role=link span.
 *  @param {HTMLElement} el @param {(() => void) | undefined} onView */
function viewing(el, onView) {
  if (!onView) return;
  el.addEventListener('click', () => onView());
  el.addEventListener('auxclick', (event) => { if (/** @type {MouseEvent} */ (event).button === 1) onView(); });
  if (el.getAttribute('href') === null) el.addEventListener('keydown', (event) => { if (/** @type {KeyboardEvent} */ (event).key === 'Enter') onView(); });
}

/** Each way into a paper's entry has its line icon. */
const OPEN_ICON = /** @type {const} */ ({ full: 'bookOpen', pdf: 'fileText', abstract: 'text', publisher: 'externalLink' });

/** The row of ways into a paper, the best first and bold. All but the publisher's page open in the reader, which then
 *  knows the paper's issue; the publisher's page goes outside (publishers refuse to load in the panel).
 *  @param {Document} doc @param {import('../chat/radar-digest-data.js').OpenLink[]} ways @param {HomeLinks} links
 *  @param {import('../host').RadarLink | null} radar @param {(() => void) | undefined} onView @param {any} host */
function openRow(doc, ways, links, radar, onView, host) {
  const row = h(doc, 'p', 'sbw-paper-open');
  ways.forEach((way, at) => {
    const a = h(doc, 'a', at === 0 ? 'is-lead' : '');
    a.append(lucide(doc, OPEN_ICON[way.kind], 14), h(doc, 'span', '', way.label));
    if (way.outside && host?.openLink && 'href' in links) {
      a.setAttribute('href', way.url);
      a.setAttribute('rel', 'noopener noreferrer');
      a.addEventListener('click', (event) => { event.preventDefault(); host.openLink(way.url, { outside: true }); });
    } else linkTo(a, { to: 'url', url: way.url, radar: way.outside ? null : radar }, links);
    viewing(a, onView);
    row.append(a);
  });
  return row;
}

/** Why the radar matched a paper, as a quiet line of facts. Display only.
 *  @param {Document} doc @param {import('../chat/radar-digest-data.js').WhyChip[]} chips */
function whyRow(doc, chips) {
  const row = h(doc, 'p', 'sbw-paper-chips');
  row.append(h(doc, 'span', '', 'Why:'));
  for (const chip of chips) {
    const el = h(doc, 'span', chip.kind === 'via' ? 'sbw-why-via' : `sbw-why-chip is-${chip.kind}`, chip.kind === 'via' ? `\u00B7 ${chip.text}` : chip.text);
    el.title = chip.hint;
    row.append(el);
  }
  return row;
}

/** A paper of today's issue in abstract form: its graphical abstract on the right when the publisher has one, then the
 *  title (to the paper), who and where, why read it, and the full abstract behind "Read the abstract"; then the ways in
 *  (the open row, the best one bold), why it matched and where it was found (display only). Under it, the radar's
 *  actions (Add to Zotero, Read later, Like, Not for me), which teach the radar what to show.
 *  @param {Document} doc @param {any} row @param {HomeLinks} links @param {(route: string, params?: any) => Promise<any>} [api]
 *  @param {RadarDigest | null} [digest] the issue's radar, for the row actions
 *  @param {'summary' | 'abstract'} [show] what the line under the title is: the AI's summary, or the paper's abstract
 *  @param {() => void} [onView] the paper was opened (its link, its figure, or its abstract): it is no longer news
 *  @param {any} [host] opens a publisher's page outside */
function paperEntry(doc, row, links, api, digest, show = 'summary', onView, host) {
  const entry = h(doc, 'article', 'sbw-paper');
  const text = h(doc, 'div', 'sbw-paper-text');
  const url = row.doi ? `https://doi.org/${row.doi}` : row.url;
  const title = h(doc, url ? 'a' : 'span', 'sbw-paper-title', row.title);
  const radar = digest?.readerLink(row) ?? null;
  if (url) viewing(linkTo(title, { to: 'url', url, radar }, links), onView);
  // Issues written before 2026-11-02 hold arXiv's authors as one string of TeX.
  const authors = row.venue === 'arXiv' ? arxivAuthors(row.authors) : (row.authors ?? []).map(plainName);
  const who = authors.length > 3 ? `${authors.slice(0, 3).join(', ')} +${authors.length - 3}` : authors.join(', ');
  const meta = [who, row.venue, row.radar?.date ?? row.year].filter(Boolean).join(' · ');
  text.append(title);
  if (meta) text.append(h(doc, 'p', 'sbw-paper-meta', meta));
  const abstract = String(row.abstract ?? '').trim();
  // The AI summary unless the person chose abstracts; a paper with no abstract keeps its summary either way.
  // Issues written before 2026-10-29 may hold "Close to “seed” (0.84, whole paper).", alone or before the summary; it never shows.
  const line = String(row.radar?.why_line ?? row.radar?.reason ?? '').replace(/^Close to \u201C[^\u201D]*\u201D \([^)]*\)\.\s*/, '') || null;
  const why = show === 'abstract' && abstract ? null : line;
  if (why) text.append(h(doc, 'p', 'sbw-paper-why', why));
  else if (abstract) text.append(h(doc, 'p', 'sbw-paper-why', abstract));
  if (abstract && (why || abstract.length > 320)) {
    const more = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbw-paper-more'));
    const label = h(doc, 'summary');
    const labelText = h(doc, 'span', '', why ? 'Read the abstract' : 'Read more');
    label.append(labelText, lucide(doc, 'chevronDown', 14));
    more.append(label, h(doc, 'p', 'sbw-paper-abstract', abstract));
    // Without a why line the clamped preview above is the abstract itself; opening shows it in full instead.
    more.addEventListener('toggle', () => {
      if (more.open) onView?.();
      labelText.textContent = more.open ? 'Show less' : why ? 'Read the abstract' : 'Read more';
      if (!why) text.querySelector('.sbw-paper-why')?.toggleAttribute('hidden', more.open);
    });
    text.append(more);
  }
  const ways = openLinks(row);
  if (ways.length) text.append(openRow(doc, ways, links, radar, onView, host));
  const chips = whyChips(row);
  if (chips.length) text.append(whyRow(doc, chips));
  else {
    const via = (row.foundBy ?? []).filter(Boolean);
    if (via.length) text.append(h(doc, 'p', 'sbw-paper-source', `Found via ${via.join(', ')}`));
  }
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
      if (url) { viewing(linkTo(link, { to: 'url', url, radar }, links), onView); link.tabIndex = -1; }
      link.append(img);
      entry.append(link);
    }, () => {});
  }
  return entry;
}

/** A long issue comes in steps, so rating papers stays a choice; Worth reading starts shorter than New. */
const PAPER_STEP = 8;
const WORTH_READING = 'Worth reading';
const WORTH_STEP = 3;

/** "Show 8 more (22 left)" @param {number} left @param {number} [step] */
export const moreLabel = (left, step = PAPER_STEP) => `Show ${Math.min(left, step)} more${left > step ? ` (${left} left)` : ''}`;

/** How often Home looks at a running radar: every few seconds at first, then less often, for as long as Home is open.
 *  A run has no time limit and no way to read how far it got, so Home never decides by itself that one has stopped: only
 *  the server saying nothing is running, a few times over, ends the wait. */
const RUN_POLL_MS = 5000;
const RUN_POLL_TIMES = 120;
const RUN_POLL_SLOW_MS = 30000;
const RUN_GONE_TIMES = 3;
const REFUSAL_MS = 4000;

/**
 * The radar's run, in two places: the line under the banner (running, a run that did not finish and why, or when the
 * issue came and when the next will), with Run again or Redo today in it; and "Run now" in the today bar, which reads
 * "Running…" while it runs (also when it was already running as Home painted, as on a radar's first run). A refusal shows
 * in the button's own place for a moment. `onRan` is called once a run is recorded: Home is painted once, so it asks the
 * routines list. No Stop: the routines service has no way to stop one run, and no stage to show.
 * @param {Document} doc @param {any} ai @param {any} routine @param {HTMLElement} block @param {() => void} onRan
 */
function runControls(doc, ai, routine, block, onRan) {
  const line = h(doc, 'div', 'sbw-run');
  line.setAttribute('role', 'status');
  const text = h(doc, 'span', 'sbw-run-text');
  const act = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-run-act'));
  act.type = 'button';
  line.append(h(doc, 'span', 'sbw-run-dot'), text, act);
  const canRun = typeof ai.routines?.runNow === 'function';
  const canRedo = typeof ai.routines?.redo === 'function';
  const runNow = canRun ? /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-today-run')) : null;
  if (runNow) runNow.type = 'button';

  let seen = routine;
  let running = Boolean(routine.running);
  /** @type {number | null} */ let startedAt = null;
  /** @type {number | null} */ let seenAt = running ? Date.now() : null;
  let unanswered = false;
  let starting = false;
  /** @type {{ on: HTMLButtonElement, text: string } | null} */ let refusal = null;

  /** Says a button's words, or its refusal. @param {HTMLButtonElement} b @param {string} words */
  const say = (b, words) => {
    if (refusal?.on === b) { b.textContent = refusal.text; b.setAttribute('title', refusal.text); return; }
    b.textContent = words;
    b.removeAttribute('title');
  };
  const paint = () => {
    const status = runStatus({ ...seen, running }, { startedAt, seenAt, unanswered });
    line.classList.toggle('is-running', status.kind === 'running');
    line.classList.toggle('is-failed', status.kind === 'failed');
    text.replaceChildren(...(status.lead ? [h(doc, 'strong', '', status.lead)] : []), ...(status.detail ? [h(doc, 'span', '', `${status.lead ? ' \u00B7 ' : ''}${status.detail}`)] : []));
    if (runNow) {
      say(runNow, running ? 'Running\u2026' : 'Run now');
      runNow.disabled = running || starting || refusal?.on === runNow;
    }
    const again = status.action === 'again' && canRun;
    const redo = status.action === 'redo' && canRedo;
    act.hidden = !again && !redo;
    if (again || redo) {
      say(act, again ? 'Run again' : 'Redo today');
      if (again && refusal?.on !== act) act.prepend?.(lucide(doc, 'refreshCw', 14));
    }
    act.disabled = starting || refusal?.on === act;
  };

  let polling = false;
  let polls = 0;
  let gone = 0;
  /** @param {string | null} lastAt the lastRun.at before this run */
  const watch = (lastAt) => {
    if (polling) return;
    polling = true;
    gone = 0;
    const look = () => setTimeout(async () => {
      if (!block.isConnected) return; // Home was left or repainted
      polls += 1;
      /** @type {any} */ let all = null;
      try { all = await ai.routines.list(); unanswered = false; } catch { unanswered = true; }
      const now = all?.find((/** @type {any} */ r) => r.id === routine.id);
      if (now) seen = now;
      if (now && !now.running && (now.lastRun?.at ?? null) !== lastAt) { polling = false; running = false; paint(); onRan(); return; }
      if (all && !now?.running && ++gone >= RUN_GONE_TIMES) { polling = false; running = false; paint(); return; }
      if (now?.running) gone = 0;
      paint();
      look();
    }, polls < RUN_POLL_TIMES ? RUN_POLL_MS : RUN_POLL_SLOW_MS);
    look();
  };
  /** @param {HTMLButtonElement} b @param {(id: string) => Promise<any>} start */
  const go = async (b, start) => {
    const lastAt = seen.lastRun?.at ?? null;
    starting = true;
    paint();
    /** @type {string | null} */ let refused = null;
    try {
      const out = await start(routine.id);
      if (out.started) { running = true; startedAt = Date.now(); seenAt = null; watch(lastAt); }
      else refused = runNowLine(out);
    } catch (error) { refused = String(/** @type {any} */ (error)?.message ?? error); }
    starting = false;
    if (refused !== null) {
      refusal = { on: b, text: refused };
      setTimeout(() => { refusal = null; paint(); }, REFUSAL_MS);
    }
    paint();
  };
  runNow?.addEventListener('click', () => go(runNow, (id) => ai.routines.runNow(id)));
  act.addEventListener('click', () => go(act, (id) => (act.textContent === 'Redo today' ? ai.routines.redo(id) : ai.routines.runNow(id))));
  if (running) watch(routine.lastRun?.at ?? null);
  paint();
  return { line, runNow };
}

/** A row that says something went wrong, with a way to try again.
 *  @param {Document} doc @param {string} words @param {() => void} retry */
function troubleRow(doc, words, retry) {
  const row = h(doc, 'div', 'sbw-run is-failed');
  row.setAttribute('role', 'alert');
  const again = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-run-act'));
  again.type = 'button';
  again.append(lucide(doc, 'refreshCw', 14), h(doc, 'span', '', 'Try again'));
  again.addEventListener('click', retry);
  row.append(h(doc, 'span', 'sbw-run-dot'), h(doc, 'span', 'sbw-run-text', words), again);
  return row;
}

/** Today: a radar issue across the full width, a photo banner over its papers in abstract form, with ‹ › to step
 *  back through earlier days. Today with nothing new yet says so; no radar at all offers to set one up.
 *  @param {Document} doc @param {any} ai @param {any} host @param {HomeLinks} links
 *  @param {{ issues: any[], routine: any | null, pick?: string, unknown?: boolean, onRan?: (block: HTMLElement) => void, onViewed?: (conversations: any[]) => void, onJudged?: (judged: number) => void }} radar issues newest first; `pick` opens on that issue;
 *  `unknown`: the routines could not be read, so whether a radar exists is not known; `onRan(block)`: a run started or
 *  watched here was recorded; `onViewed(conversations)`: a paper opened here lowered the news, read again; `onJudged(n)`:
 *  how many papers of the issue shown have a verdict */
async function todayBlock(doc, ai, host, links, { issues, routine, pick, unknown, onRan, onViewed, onJudged }) {
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
  bar.append(nav, chat, sources);
  // Hosts whose server predates runNow or redo get no button rather than one that fails.
  const run = routine && onRan ? runControls(doc, ai, routine, block, () => onRan(block)) : null;
  if (run?.runNow) bar.append(run.runNow);
  // What the keys do, where there are keys and room to say so.
  const keysHint = h(doc, 'span', 'sbw-today-keys');
  keysHint.hidden = true;
  bar.append(keysHint, shows);
  nav.append(older, newer);
  block.append(stage, ...(run ? [run.line] : []), bar, list);

  let painting = 0;
  /** @type {Map<string, number>} */ const revealed = new Map(); // how many papers of each group are showing, kept across repaints
  /** @type {RadarDigest | null} */ let digest = null;
  // The papers on the page, in order, for the keys; the one the keys act on is `current`.
  /** @type {{ el: HTMLElement, row: any }[]} */ let cards = [];
  /** @type {any} */ let current = null;
  let keyed = false;
  /** @type {(() => void)[]} */ let progress = [];
  /** @param {{ el: HTMLElement, row: any } | null} card @param {boolean} [scroll] */
  const setCurrent = (card, scroll = false) => {
    current?.el.classList.remove('is-current');
    current = card;
    card?.el.classList.add('is-current');
    if (scroll) card?.el.scrollIntoView?.({ block: 'nearest' });
  };
  const nextOpen = (/** @type {number} */ from = 0) => cards.slice(from).find((c) => !digest?.settled(c.row)) ?? null;
  /** j at the last paper showing brings the next step first. */
  const step = (/** @type {number} */ by) => {
    let at = cards.indexOf(current) + by;
    if (at >= cards.length) current?.el.parentElement?.querySelector('.sbw-papers-more:not([hidden])')?.click();
    at = Math.max(0, Math.min(cards.length - 1, at));
    setCurrent(cards[at] ?? null, true);
  };
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (!block.isConnected) { doc.removeEventListener('keydown', onKey); return; }
    if (event.defaultPrevented || !digest || !cards.length) return;
    // Only while Home is what is on screen: not behind the reader or a dialog, not on a hidden view. In a plugin the
    // document holds the host's whole window, so only with the focus inside Home.
    const view = block.closest('.sb-home-view');
    if (view ? !view.contains(/** @type {Node} */ (event.target)) : !block.getClientRects().length || doc.querySelector('[role="dialog"]:not([hidden])')) return;
    const action = keyAction(event);
    if (!action) return;
    event.preventDefault();
    keyed = true;
    if (action === 'next') { step(1); return; }
    if (action === 'prev') { step(-1); return; }
    if (!current) return;
    digest.judgeKey(current.row, action);
    setCurrent(nextOpen(cards.indexOf(current) + 1) ?? nextOpen(), true);
  };
  doc.addEventListener?.('keydown', onKey);
  /** A paper opened here is one less paper of news on its issue: tell the engine, then read the counts again so the
   *  banner and the waiting count follow without repainting Home. @param {any} issue @param {any} row */
  const viewed = async (issue, row) => {
    if (!(await markViewed(host, issue.id, row.id))) return;
    try {
      const conversations = await ai.conversations.list();
      const fresh = conversations.find((/** @type {any} */ c) => c.id === issue.id);
      if (fresh?.news) issue.news = fresh.news;
      else delete issue.news;
      if (issues[at] === issue) stage.firstElementChild?.classList.toggle('is-new', Boolean(issue.news));
      onViewed?.(conversations);
    } catch (error) { host.logError(error); }
  };
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
    cards = [];
    progress = [];
    current = null;
    keysHint.hidden = true;
    if (!issue) {
      const quiet = h(doc, 'div', 'sbw-run');
      const done = routine?.lastRun?.status === 'done' && sameDay(routine.lastRun.at, now);
      quiet.append(h(doc, 'span', 'sbw-run-dot'), h(doc, 'span', 'sbw-run-text', done ? 'Nothing new above the bar today.' : 'No issue yet today.'), linkTo(h(doc, 'a', 'sbw-quiet sbw-run-act', 'Sources'), { to: 'sources' }, links));
      list.append(quiet);
      onJudged?.(0);
      return;
    }
    try {
      const view = await ai.sessions.view(issue.id);
      for (const result of view.results ?? []) {
        if (result.kind !== 'papers') continue;
        const body = await ai.sessions.read(issue.id, result.ref);
        const rows = body?.rows ?? [];
        if (mine !== painting) return;
        const worth = result.title === WORTH_READING;
        if (result.title && result.title !== 'New') {
          const head = h(doc, 'h2', 'sbw-papers-head', result.title);
          if (worth) head.append(h(doc, 'small', '', `${rows.length} today \u00B7 older papers your library keeps citing`));
          list.append(head);
        }
        // The same row actions as the issue's chat view, so a paper can be rated where it is read.
        const radar = body?.radar?.routine ? body.radar : null;
        digest = radar && (digest?.routine === radar.routine ? digest : new RadarDigest(host, doc, block, { routine: radar.routine, summary: radar.summary ?? '', judging: true }));
        const key = `${issue.id}/${result.ref?.id ?? result.title}`;
        const more = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-papers-more'));
        more.type = 'button';
        // Under the group: how far the judging has got (not for Worth reading, which is a suggestion list), and the next step.
        const foot = h(doc, 'div', 'sbw-papers-foot');
        if (digest && !worth && rows.length) {
          const track = h(doc, 'span', 'sbw-papers-track');
          const fill = h(doc, 'span', 'sbw-papers-fill');
          track.append(fill);
          const said = h(doc, 'span', 'sbw-papers-judged');
          foot.append(track, said);
          const shownDigest = digest;
          const update = () => {
            const judged = shownDigest.judged(rows);
            fill.style?.setProperty('width', `${Math.round((judged / rows.length) * 100)}%`);
            said.textContent = judgedLine(judged, rows.length);
            onJudged?.(judged);
          };
          update();
          progress.push(update);
        }
        foot.append(more);
        // One box per group (display: contents, so its papers stay in the page's grid), so a later group stays below.
        const group = h(doc, 'div', 'sbw-papers-group');
        list.append(group);
        const reveal = (/** @type {number} */ from) => {
          const upTo = Math.max(revealed.get(key) ?? (worth ? WORTH_STEP : PAPER_STEP), from + (from ? PAPER_STEP : 0));
          revealed.set(key, upTo);
          const drawn = rows.slice(from, upTo).map((/** @type {any} */ row) => {
            const el = paperEntry(doc, row, links, api, digest, textMode, () => { void viewed(issue, row); }, host);
            cards.push({ el, row });
            return el;
          });
          group.append(...drawn, foot);
          more.hidden = upTo >= rows.length;
          foot.hidden = !foot.children.length || (worth && more.hidden);
          more.textContent = upTo < rows.length ? moreLabel(rows.length - upTo) : '';
          more.onclick = () => reveal(upTo);
        };
        reveal(0);
      }
      if (digest) {
        const shown = digest;
        shown.onChange = () => {
          for (const update of progress) update();
          if (!keyed && (!current || shown.settled(current.row))) setCurrent(nextOpen());
        };
        shown.onChange();
        const save = actionList(shown.canAdd)[0].verdict === 'added' ? 'add' : 'save';
        keysHint.textContent = `j / k next paper \u00B7 a ${save} \u00B7 l like \u00B7 d not for me`;
        keysHint.hidden = !cards.length;
      }
    } catch {
      if (mine === painting) list.replaceChildren(troubleRow(doc, "Couldn't load this issue's papers.", () => { void paint(); }));
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
/** A one-row shelf before it is laid out: the desktop column count (home.css .sbw-covers). */
const ROW = 4;

/** A titled shelf of covers, 8 at a time, with Previous and Next under it when there are more. `oneRow` shows one row,
 *  as many covers as its grid has columns at this width (4 on a desktop), and pages a row at a time.
 *  @param {Document} doc @param {string} title @param {Shelved[]} items @param {HomeLinks} links @param {{ oneRow?: boolean }} [opts] */
function shelfSection(doc, title, items, links, { oneRow = false } = {}) {
  const box = h(doc, 'section', 'sbw-shelf');
  const head = h(doc, 'div', 'sbw-shelf-head');
  head.append(h(doc, 'h2', 'sbw-shelf-title', title), h(doc, 'span', 'sbw-shelf-count', String(items.length)));
  const grid = h(doc, 'div', 'sbw-covers');
  box.append(head, grid);
  // The columns come from the stylesheet (4, 3 or 2 by width), so a row is measured once the grid is on the page.
  const columns = () => (grid.isConnected ? doc.defaultView?.getComputedStyle(grid).gridTemplateColumns.split(' ').filter((track) => track && track !== 'none').length : 0) || ROW;
  let size = oneRow ? columns() : PAGE;
  let pages = Math.ceil(items.length / size);
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
    grid.replaceChildren(...items.slice(page * size, (page + 1) * size).map((item) => cover(doc, item.card, links)));
    where.textContent = `${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    if (pages > 1) box.append(pager);
    else pager.remove();
  };
  prev.addEventListener('click', () => { page = Math.max(0, page - 1); show(); });
  next.addEventListener('click', () => { page = Math.min(pages - 1, page + 1); show(); });
  show();
  const Observer = doc.defaultView?.ResizeObserver;
  if (oneRow && Observer) {
    // Laid out, or the width crossed a breakpoint: a row now holds a different number; keep the first cover shown in view.
    new Observer(() => {
      const now = columns();
      if (now === size) return;
      page = Math.floor((page * size) / now);
      size = now;
      pages = Math.ceil(items.length / size);
      show();
    }).observe(grid);
  }
  return box;
}

/** The active radars and the radar issues among the conversations, newest first. @param {any[]} conversations @param {any[]} routines */
function issuesOf(conversations, routines) {
  const radarRoutines = routines.filter((/** @type {any} */ r) => !r.broken && (r.kind === 'radar' || r.radar) && r.status === 'active');
  const radars = new Set(radarRoutines.map((/** @type {any} */ r) => r.id));
  const shown = conversations.filter((/** @type {any} */ c) => c.cover || !PLACEHOLDER_TITLES.has(c.title));
  const kindOf = (/** @type {any} */ c) => shelved(c, radars).card.kind;
  const issues = [...shown.filter((/** @type {any} */ c) => kindOf(c) === 'radar')].sort((a, b) => (a.updated < b.updated ? 1 : -1));
  return { radarRoutines, radars, shown, kindOf, issues };
}

/** A greeting with the count of what is waiting; today's radar issue across the full width; then research reports
 *  (8 a page) and earlier issues (one row a page), each its own shelf, newest first.
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
    content.replaceChildren(troubleRow(doc, "Couldn't reach the Veritas server.", () => { void paintHome(into, ctx); }));
    return;
  }

  const dateLine = count.textContent;
  // Also after a paper is opened on Home: the count goes down one paper at a time, back to the date at none.
  let waiting = 0;
  let judged = 0;
  const sayCount = () => { count.textContent = [waiting ? `${waiting} new ${waiting === 1 ? 'paper' : 'papers'}` : dateLine, judged ? `${judged} judged` : ''].filter(Boolean).join(' \u00B7 '); };
  const showWaiting = (/** @type {any[]} */ list) => {
    waiting = list.reduce((/** @type {number} */ sum, /** @type {any} */ c) => sum + (Number(c.news?.papers) || 0), 0);
    sayCount();
    ctx.onWaiting?.(waiting);
  };
  const showJudged = (/** @type {number} */ n) => { judged = n; sayCount(); };
  showWaiting(conversations);
  const { radarRoutines, radars, shown, kindOf, issues } = issuesOf(conversations, routines);
  const newest = (/** @type {Shelved[]} */ list) => list.sort((a, b) => (a.at < b.at ? 1 : -1));
  // A run started (or watched) from Home ends with a new issue: read again and swap only the today block, so the
  // shelves and anything a host put on the page stay as they are.
  const refreshToday = async (/** @type {HTMLElement} */ old) => {
    try {
      const [c, r] = await Promise.all([ai.conversations.list(), ai.routines.list()]);
      const fresh = issuesOf(c, r);
      old.replaceWith(await todayBlock(doc, ai, host, links, { issues: fresh.issues, routine: fresh.radarRoutines[0] ?? null, onRan: refreshToday, onViewed: showWaiting, onJudged: showJudged }));
    } catch (error) { host.logError(error); }
  };
  const today = issues[0] && sameDay(issues[0].updated, new Date().toISOString()) ? issues[0] : null;

  // Until a radar exists (or the person puts it off), Home opens on who and what to follow instead of an empty Today.
  const intro = !routinesFailed && !routines.some((/** @type {any} */ r) => r.kind === 'radar' || r.radar) && !host.prefs.get('sourcesIntroDone');
  const sections = [];
  if (intro) {
    const slot = h(doc, 'section', 'sbw-today');
    sections.push(slot);
    void mountSources(slot, { host, doc, links }, { mode: 'intro', routines, onDone: () => { void paintHome(into, ctx); } });
  } else sections.push(await todayBlock(doc, ai, host, links, { issues, routine: radarRoutines[0] ?? null, pick: ctx.issue, unknown: routinesFailed, onRan: refreshToday, onViewed: showWaiting, onJudged: showJudged }));
  // Chats are not shelved here: the Chat page lists them.
  const reports = newest(shown.filter((/** @type {any} */ c) => kindOf(c) === 'report').map((/** @type {any} */ c) => shelved(c, radars)));
  const earlier = newest(issues.filter((/** @type {any} */ c) => c !== today).map((/** @type {any} */ c) => shelved(c, radars)));
  for (const routine of radarRoutines) {
    const quiet = quietIssue(routine, conversations);
    if (quiet && !sameDay(quiet.at, new Date().toISOString())) earlier.push(quiet);
  }
  newest(earlier);
  if (reports.length) sections.push(shelfSection(doc, 'Research reports', reports, links));
  if (earlier.length) sections.push(shelfSection(doc, 'Earlier issues', earlier, links, { oneRow: true }));
  if (!reports.length && !earlier.length) sections.push(h(doc, 'p', 'sbw-hint', 'Your research reports will appear here.'));
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
  root.tabIndex = -1; // a click anywhere puts the focus here, which is what lets Home's keys work inside a host's window
  /** @type {'home' | 'sources'} */ let showing = 'home';
  let painted = 0;
  /** @type {HomeLinks} */
  const links = { open: (target) => {
    if (target.to === 'home' || target.to === 'sources') void show(target.to);
    else if (target.to === 'issue') void show('home', target.id);
    else if (target.to === 'url') open({ to: 'url', url: target.url }); // the radar link is for the web app's reader
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
