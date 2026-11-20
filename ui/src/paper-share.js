// @ts-check
// ui-src/src/paper-share.js. The pure part of a paper's right-click menu (paper-menu.js): the link to share for a
// paper, the text Copy and Share hand over, the menu's items, and what the person is told afterwards.

/** @typedef {{ title?: string | null, doi?: string | null, arxiv?: string | null, arxiv_id?: string | null, arxivId?: string | null, url?: string | null }} SharedPaper */
/** @typedef {{ id: 'open' | 'open-outside' | 'copy-link' | 'copy-text' | 'share', label: string, icon?: string }} PaperMenuItem */
/** @typedef {'shared' | 'cancelled' | 'copied' | 'failed'} ShareResult */

/** The address to share: https://doi.org/<doi> (also for a page whose address holds one), else the arXiv page, else
 *  the paper's own web address; null when
 *  there is none (a zotero: or file link is only meaningful on this computer). @param {SharedPaper | null | undefined} paper */
export function paperLink(paper) {
  const doi = String(paper?.doi ?? '').trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^10\.\d+\/\S+$/.test(doi)) return `https://doi.org/${doi}`;
  const arxiv = String(paper?.arxiv ?? paper?.arxiv_id ?? paper?.arxivId ?? '').trim();
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  const url = String(paper?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // a publisher's page or PDF with the DOI in its path: the DOI link, short and the same for everyone
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return url; }
  const inPath = path.match(/(?:^|\/)(10\.\d+\/[^\s?#]+)/)?.[1]?.replace(/\/+$/, '');
  return inPath ? `https://doi.org/${inPath}` : url;
}

/** "Title\nlink", or the link alone for a paper without a title; null without a link. @param {SharedPaper | null | undefined} paper */
export function shareText(paper) {
  const link = paperLink(paper);
  if (!link) return null;
  const title = String(paper?.title ?? '').replace(/\s+/g, ' ').trim();
  return title ? `${title}\n${link}` : link;
}

/** The menu for `paper`; empty when it has no link. `canOpen`: the place has a way to open links (a host).
 *  @param {SharedPaper | null | undefined} paper @param {{ canOpen?: boolean }} where @returns {PaperMenuItem[]} */
export function menuItems(paper, where) {
  if (!paperLink(paper)) return [];
  /** @type {PaperMenuItem[]} */
  const items = [];
  if (where.canOpen) items.push({ id: 'open', label: 'Open' }, { id: 'open-outside', label: 'Open in your browser', icon: 'open' });
  items.push(
    { id: 'copy-link', label: 'Copy link', icon: 'duplicate' },
    { id: 'copy-text', label: 'Copy title and link', icon: 'duplicate' },
    { id: 'share', label: 'Share…', icon: 'send' },
  );
  return items;
}

/** What to say after Share: nothing when the system's share menu took it (or the person closed it), else whether
 *  the link was copied instead. @param {ShareResult} result @returns {string | null} */
export function shareOutcome(result) {
  if (result === 'copied') return 'Link copied';
  if (result === 'failed') return "Couldn't copy the link";
  return null;
}
