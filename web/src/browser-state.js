// @ts-check
// ui-src/src/web/browser-state.js. Spec 015 B3: the in-app browser panel's pure parts, kept apart from the DOM so they
// can be tested: its back stack and how a link is first asked for.

/** @typedef {{ url: string, prefer?: 'reader' }} Entry */

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
