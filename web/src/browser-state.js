// @ts-check
// ui-src/src/web/browser-state.js. Spec 015 B3: the in-app browser panel's pure parts, kept apart from the DOM so they
// can be tested: its back stack and how a link is first asked for.

/** @typedef {{ url: string, prefer?: 'reader', fell?: true }} Entry `fell`: a PDF link that was not one, now asked for as a page (once) */

/** The panel's own history. A framed page's history is the site's and cannot be reached from here, so "back" steps
 *  through the pages the panel was asked to show. */
export function createHistory() {
  /** @type {Entry[]} */ const stack = [];
  return {
    /** @param {Entry} entry */ push(entry) { stack.push(entry); },
    /** @param {Entry} entry */ replace(entry) { if (stack.length) stack[stack.length - 1] = entry; else stack.push(entry); },
    /** Drops the current page and returns the one before it, or null when there is none. @returns {Entry | null} */
    back() { if (stack.length < 2) return null; stack.pop(); return stack[stack.length - 1]; },
    get current() { return stack[stack.length - 1] ?? null; },
    get canGoBack() { return stack.length > 1; },
    clear() { stack.length = 0; },
  };
}

/** What ← does: the page before in the panel, or, on the first page, close the panel (focus goes back to the link
 *  it was opened from), so ← always does something. A framed site's own history is not reachable from here.
 *  @param {ReturnType<typeof createHistory>} history @returns {{ show: Entry } | { close: true }} */
export function stepBack(history) {
  const entry = history.back();
  return entry ? { show: entry } : { close: true };
}

/** What to ask /web/page for. A framed http page inside an https app is blocked by the browser (mixed content), so it
 *  gets the reader view straight away. @param {string} url @param {string} appProtocol e.g. "https:" @returns {'reader' | undefined} */
export function firstPrefer(url, appProtocol) {
  return appProtocol === 'https:' && /^http:/i.test(url) ? 'reader' : undefined;
}

/** The query for GET /web/page. @param {Entry} entry */
export function pageQuery(entry) {
  return new URLSearchParams({ url: entry.url, ...(entry.prefer ? { prefer: entry.prefer } : {}) });
}

/** "arxiv.org/abs/2401.00001" for the bar's address line. @param {string} url */
export function addressOf(url) {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path.length > 48 ? `${path.slice(0, 47)}…` : path}`;
  } catch { return url; }
}

/** What the card says when the server could not give a page (its `reason`, or a plain default for a network error).
 *  @param {any} answer @param {unknown} error */
export function blockedReason(answer, error) {
  if (answer?.mode === 'blocked' && answer.reason) return String(answer.reason);
  const status = /** @type {any} */ (error)?.status;
  if (status === 400) return String(/** @type {any} */ (error)?.message || 'This link does not open here.');
  if (status === 401 || status === 403) return 'Sign in to Veritas again to open links here.';
  return "Veritas couldn't reach the page.";
}

/** The file a link names, for the bar while a PDF opens. @param {string} url */
export function fileNameOf(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'PDF'; } catch { return 'PDF'; }
}

/** Where the server found the copy it gives (spec 022), for the bar's address line: "Your library", "Preprint
 *  (arXiv)", "Open access (PMC)", "Abstract only"; '' for an ordinary page. @param {any} answer */
export function sourceOf(answer) {
  const where = String(answer?.where ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (answer?.source === 'library') return 'Your library';
  if (answer?.source === 'open access') {
    const kind = answer.version && answer.version !== 'published' ? 'Preprint' : 'Open access';
    return where ? `${kind} (${where})` : kind;
  }
  if (answer?.source === 'openalex') return 'Abstract only';
  return '';
}

/** What the reader view draws for a reader answer: the header and the text in the note's prose font (one family),
 *  an abstract as plain text under a small "Abstract" label, and math only where the server said the page has it
 *  (arXiv, LaTeXML, MathML), so "$5 and $10" on an ordinary page stays money. A paper (arXiv, or a DOI's abstract)
 *  adds a quiet line of id and dates, small subject chips and its links (PDF, Full text) as buttons in the header.
 *  A DOI's abstract-only answer (source openalex, 2026-10-29) is the paper's landing page: journal and date as the
 *  quiet line, the abstract's paragraphs (sub, sup, italic) as html, the DOI and a citation to copy; its publisher's
 *  page opens outside (`outside`), since publishers refuse loads in the panel (Cloudflare).
 *  @param {any} answer */
export function readerPlan(answer) {
  const paper = answer?.paper ?? {};
  const landing = answer?.source === 'openalex';
  /** @type {{ label: string, code: string, primary: boolean }[]} */
  const subjects = (Array.isArray(paper.subjects) ? paper.subjects : [])
    .map((/** @type {any} */ s) => ({ label: String(s?.name || s?.code || ''), code: String(s?.code ?? ''), primary: s?.primary === true }))
    .filter((s) => s.label);
  const numbers = [paper.volume && paper.issue ? `${paper.volume} (${paper.issue})` : paper.volume ?? '', paper.pages ?? ''].filter(Boolean).join(', ');
  const meta = (landing
    ? [paper.journal ?? '', paper.published ?? '', numbers]
    : [
      paper.arxiv ? `arXiv:${paper.arxiv}${paper.version ?? ''}` : '',
      paper.submitted ? `Submitted ${paper.submitted}` : '',
      paper.revised ? `revised ${paper.revised}` : '',
    ]).filter(Boolean).map(String).join(' · ');
  /** @type {{ label: string, url: string, kind: string, outside: boolean }[]} */
  const links = (Array.isArray(answer?.links) ? answer.links : [])
    .filter((/** @type {any} */ l) => l?.label && /^https?:\/\//i.test(String(l?.url ?? '')))
    .map((/** @type {any} */ l) => ({ label: String(l.label), url: String(l.url), kind: String(l.kind ?? ''), outside: l.kind === 'outside' }));
  const doi = landing ? String(paper.doi ?? '') : '';
  return {
    subjects,
    meta,
    links,
    paper: answer?.source === 'arxiv' || landing,
    landing,
    articleClass: 'sbw-browser-article sbw-prose',
    title: String(answer?.title ?? ''),
    byline: String(answer?.byline ?? ''),
    abstract: String(answer?.abstract ?? ''),
    abstractHtml: landing ? String(answer?.abstract_html ?? '') : '',
    abstractLabel: 'Abstract',
    arxiv: String(paper.arxiv ?? ''),
    doi,
    doiUrl: doi ? `https://doi.org/${doi}` : '',
    citation: landing ? String(paper.citation ?? '') : '',
    math: answer?.math === true,
    html: String(answer?.html ?? ''),
  };
}

/** What Add to Zotero sends for the paper on screen; null for a page that is not a paper. @param {any} answer */
export function paperToAdd(answer) {
  if (answer?.source !== 'arxiv' && answer?.source !== 'openalex' && answer?.source !== 'open access') return null;
  const paper = answer.paper ?? {};
  const links = Array.isArray(answer.links) ? answer.links : [];
  const year = /\b(?:19|20)\d\d\b/.exec(String(paper.published ?? paper.submitted ?? ''))?.[0];
  return {
    title: String(answer.title ?? ''),
    // The byline stops at "et al."; the paper's own list has everyone.
    authors: Array.isArray(paper.authors) ? paper.authors.map(String) : String(answer.byline ?? '').split(/,\s+/).filter(Boolean),
    year: year ? Number(year) : null,
    venue: answer.source === 'arxiv' ? 'arXiv' : String(paper.journal ?? ''),
    doi: paper.doi || null,
    abstract: String(answer.abstract ?? ''),
    // a PDF's address is one copy of the paper; the DOI is the paper
    url: answer.mode === 'pdf' && paper.doi ? `https://doi.org/${paper.doi}` : String(answer.url ?? ''),
    source: answer.source,
    arxiv: paper.arxiv || undefined,
    pdf: answer.mode === 'pdf' ? String(answer.url ?? '') : links.find((/** @type {any} */ l) => l?.kind === 'pdf')?.url,
    type: answer.source === 'arxiv' ? 'preprint' : undefined,
  };
}

/** The Zotero collections as a picker lists them: each under its parent, by name, indented.
 *  @param {{ key: string, name: string, parent?: string | null }[]} collections @returns {{ key: string, label: string }[]} */
export function collectionOptions(collections) {
  const list = Array.isArray(collections) ? collections : [];
  const keys = new Set(list.map((c) => c.key));
  /** @type {Map<string | null, typeof list>} */
  const under = new Map();
  for (const c of list) {
    const parent = c.parent && keys.has(c.parent) ? c.parent : null;
    under.set(parent, [...(under.get(parent) ?? []), c]);
  }
  /** @type {{ key: string, label: string }[]} */
  const out = [];
  const walk = (/** @type {string | null} */ parent, /** @type {number} */ depth) => {
    for (const c of [...(under.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ key: c.key, label: `${'\u00A0\u00A0'.repeat(depth)}${c.name}` }); // an <option> drops plain spaces
      walk(c.key, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Inline TeX in an answer the server marked as math: \(…\), \[…\], $$…$$ and $…$. Unlike titleNodes (chat/markdown.js),
// a $ may follow a letter, since arXiv writes "PtSe$_2$"; the money rules stay (no space inside the dollars, no digit
// after the closing one), so "$5 and $10" is still text.
const TEX = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$(.+?)\$\$|(?<![\\$])\$(?=[^\s$])((?:[^$\n]|\\\$)*?[^\s$\\])\$(?![\d$])/g;

/** A text split into plain runs and TeX. @param {string} text @returns {({ text: string } | { tex: string })[]} */
export function mathParts(text) {
  /** @type {({ text: string } | { tex: string })[]} */ const out = [];
  let at = 0;
  for (const m of String(text).matchAll(TEX)) {
    if ((m.index ?? 0) > at) out.push({ text: text.slice(at, m.index) });
    out.push({ tex: (m[1] ?? m[2] ?? m[3] ?? m[4]).trim() });
    at = (m.index ?? 0) + m[0].length;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) });
  return out;
}
