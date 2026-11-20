// @ts-check
// ui/src/get-paper-data.js. Spec 031 R5/R6 and spec 032, the pure part of "Get PDF": what is sent for a paper, what
// happened to it, and the one line that says how a batch went. get-paper.js does the calls.

/** Where a paper can be read, as the engine's ai.papers.access answers (agent/src/open-access.js).
 *  @typedef {{ access: "open", pdfUrl: string, via: string, alternates?: string[] } | { access: "publisher", page: string } | { access: "none" }} Access */
/** @typedef {{ title: string, doi?: string | null, url?: string | null, year?: number | null, authors?: string[], abstract?: string | null, arxiv?: string | null, pdfUrl?: string | null, venue?: string | null, source?: string | null }} PaperIn */
/** What happened to one paper:
 *  pdf: in Zotero with its PDF; waiting: the PDF is downloaded and held, Zotero attaches it when it opens;
 *  folder: saved in Veritas's Papers folder; publisher: no free copy could be kept, the publisher's page has it;
 *  searching: added to Zotero without a PDF, Zotero keeps looking; nocopy: no free copy and no page; failed: an error.
 *  @typedef {"pdf" | "waiting" | "folder" | "publisher" | "searching" | "nocopy" | "failed"} GotState */
/** @typedef {{ status: "added" | "queued" | "kept" | "failed", where: "zotero" | "folder", path?: string, downloaded: boolean, message?: string, access?: Access }} KeepResult */

/** The paper as Add to Zotero takes it, with the free PDF when there is one. @param {PaperIn} p @param {Access | undefined} a */
export function outsidePaper(p, a) {
  return {
    title: p.title, authors: p.authors ?? [], year: p.year ?? null, venue: p.venue ?? '', doi: p.doi ?? null,
    abstract: p.abstract ?? '', url: p.doi ? `https://doi.org/${String(p.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}` : p.url ?? null,
    source: p.source ?? 'report', arxiv: p.arxiv ?? null, pdf: a?.access === 'open' ? a.pdfUrl : p.pdfUrl ?? null,
  };
}

/** Zotero pane (Zotero is running): what happened once Add to Zotero answered. @param {Access | undefined} a @param {boolean} added */
export function gotState(a, added) {
  if (!added) return /** @type {GotState} */ ('failed');
  return a?.access === 'open' ? 'pdf' : a?.access === 'publisher' ? 'publisher' : 'searching';
}

/** Spec 032: what happened once the server kept (or could not keep) the PDF. @param {KeepResult} r @returns {GotState} */
export function keptState(r) {
  if (r.where === 'zotero') {
    if (r.status === 'failed') return 'failed';
    if (r.downloaded) return r.status === 'added' ? 'pdf' : 'waiting';
    return r.access?.access === 'publisher' ? 'publisher' : 'searching';
  }
  if (r.status === 'kept') return 'folder';
  return r.access?.access === 'publisher' ? 'publisher' : r.access?.access === 'open' ? 'failed' : 'nocopy';
}

/** The words shown beside a paper. @param {GotState} state */
export function stateWords(state) {
  return {
    pdf: 'Saved to Zotero with its PDF',
    waiting: 'PDF saved · Zotero attaches it when it opens',
    folder: 'Saved to Veritas › Papers',
    publisher: 'No free copy · the publisher’s page has it',
    searching: 'Added to Zotero · no free copy yet, Zotero keeps looking',
    nocopy: 'No free copy was found',
    failed: 'Couldn’t save it',
  }[state];
}

/** Where a paper can be opened: its free PDF, else its publisher's page, else nothing.
 *  @param {Access | undefined} a @returns {string | null} */
export function readLink(a) {
  return a?.access === 'open' ? a.pdfUrl : a?.access === 'publisher' ? a.page : null;
}

/** One line for a batch: "3 with a free PDF · 2 need the publisher's page …". @param {GotState[]} states */
export function batchLine(states) {
  const n = (/** @type {GotState} */ s) => states.filter((x) => x === s).length;
  const parts = [];
  if (n('pdf')) parts.push(`${n('pdf')} with a free PDF`);
  if (n('waiting')) parts.push(`${n('waiting')} PDF${n('waiting') === 1 ? '' : 's'} saved for Zotero`);
  if (n('folder')) parts.push(`${n('folder')} saved to Veritas › Papers`);
  if (n('publisher')) parts.push(`${n('publisher')} need${n('publisher') === 1 ? 's' : ''} the publisher’s page`);
  if (n('searching')) parts.push(`${n('searching')} not found yet (Zotero keeps looking)`);
  if (n('nocopy')) parts.push(`${n('nocopy')} with no free copy`);
  if (n('failed')) parts.push(`${n('failed')} couldn’t be saved`);
  return parts.join(' · ');
}
