// @ts-check
// ui/src/get-paper.js. Spec 031 R5/R6, spec 032: "Get PDF" for papers outside the library.
// - In the Zotero pane (Zotero is running) the paper goes straight into Zotero, its free PDF attached; the plugin keeps
//   it only if it is a PDF, and looks further for the others.
// - Everywhere else the engine keeps it (ai.papers.keep): it finds the free copies and the server downloads the first
//   that comes, now, into Zotero's queue (attached when Zotero opens) when there is a Zotero library, else into
//   Veritas's own Papers folder. Nothing behind a paywall is fetched: the publisher's page is offered instead, where the
//   user's own login and Browse's "Save PDF" apply.
import { outsidePaper, gotState, keptState, readLink } from './get-paper-data.js';

/** @typedef {import("./get-paper-data.js").PaperIn} PaperIn */
/** @typedef {import("./get-paper-data.js").GotState} GotState */

/**
 * @param {any} host the UiHost
 * @param {PaperIn[]} papers
 * @param {{ openOne?: boolean }} [opts] openOne: a single paper that needs its publisher's page opens it
 * @returns {Promise<{ states: GotState[], links: (string | null)[], paths: (string | null)[], added: boolean }>}
 */
export async function getPapers(host, papers, opts = {}) {
  const ai = await host.ai();
  /** @type {GotState[]} */ const states = [];
  /** @type {(string | null)[]} */ const links = [];
  /** @type {(string | null)[]} */ const paths = [];
  if (host.kind === 'zotero' && host.addToLibrary) {
    /** @type {import("./get-paper-data.js").Access[]} */
    let access = [];
    try { access = await ai.papers.access(papers.map((p) => ({ doi: p.doi ?? null, url: p.url ?? null, pdfUrl: p.pdfUrl ?? null, arxiv: p.arxiv ?? null }))); } catch (error) { host.logError?.(error); }
    for (const [i, paper] of papers.entries()) {
      let added = false;
      try { added = Boolean((await host.addToLibrary([outsidePaper(paper, access[i])]))?.items?.[0]); } catch (error) { host.logError?.(error); }
      states.push(gotState(access[i], added));
      links.push(readLink(access[i]));
      paths.push(null);
    }
  } else {
    for (const paper of papers) {
      try {
        const kept = await ai.papers.keep({ title: paper.title, authors: paper.authors ?? [], year: paper.year ?? null, venue: paper.venue ?? null, doi: paper.doi ?? null, url: paper.url ?? null, arxiv: paper.arxiv ?? null, pdfUrl: paper.pdfUrl ?? null });
        states.push(keptState(kept));
        links.push(kept.access?.access === 'publisher' ? kept.access.page : null);
        paths.push(kept.path ?? null);
      } catch (error) {
        host.logError?.(error);
        states.push('failed');
        links.push(null);
        paths.push(null);
      }
    }
  }
  if (opts.openOne && papers.length === 1 && states[0] === 'publisher' && links[0]) host.openLink(links[0]);
  return { states, links, paths, added: states.some((s) => s === 'pdf' || s === 'waiting' || s === 'folder' || s === 'searching') };
}
