// @ts-check
// agent-src/src/radar-digest.js. Spec 012 R4: the words of a digest. The one-line summary shown above the tables, and the
// vault note (two Markdown tables) written beside it. Pure: no model, no fs.

import { NO_ABSTRACT } from './radar-why.js';

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RadarConfig} RadarConfig */

const DB_NAMES = { arxiv: 'arXiv', biorxiv: 'bioRxiv', chemrxiv: 'chemRxiv', openalex: 'OpenAlex', crossref: 'Crossref', semanticscholar: 'Semantic Scholar', europepmc: 'Europe PMC' };
const host = (/** @type {string} */ url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/** A source id as a person reads it: "chemRxiv", "j.example feed", "Giulia Galli". @param {string} id @param {RadarConfig} config */
export function sourceLabel(id, config) {
  if (id === 'discover') return 'OpenAlex';
  const s = config.sources.find((x) => x.id === id);
  if (!s) return id;
  switch (s.kind) {
    case 'database': return DB_NAMES[s.db] ?? s.db;
    case 'feed': return s.title && s.title !== s.url ? s.title : `${host(s.url)} feed`;
    case 'journal': case 'author': return s.name;
    case 'mcp': return s.server;
    default: return id;
  }
}

/** A failure on one line: "timed out after 30 s" stays as it is, "HTTP 403" too. @param {string} error */
const shortError = (error) => error.replace(/\s+/g, ' ').replace(/\.$/, '').slice(0, 80);

/**
 * "14 new from 6 sources · 5 worth reading · chemRxiv failed (timeout)".
 * @param {{ news: number, older: number, discover?: number, learned?: string[], skipped?: string | null, answered: number, failed: { source: string, error: string }[] }} run @param {RadarConfig} config
 */
export function summaryLine(run, config) {
  const parts = [`${run.news} new from ${run.answered} ${run.answered === 1 ? 'source' : 'sources'}`];
  if (run.older) parts.push(`${run.older} worth reading`);
  if (run.discover) parts.push(`${run.discover} might interest you`);
  if (run.learned?.length) parts.push(`Now also searching: ${run.learned.join(', ')}`);
  if (run.skipped) parts.push(run.skipped);
  if (run.failed.length) parts.push(run.failed.map((f) => `${sourceLabel(f.source, config)} failed (${shortError(f.error)})`).join(', '));
  return parts.join(' · ');
}

/** A vault note's file name: "2026-10-11 Sleep radar". The server allows letters, digits, spaces and . ( ) - _ only. @param {string} date @param {string} name */
export function digestFile(date, name) {
  const clean = name.replace(/[^\p{L}\p{N} .()_-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 90).trim();
  return `${date} ${clean || 'Reading radar'}`;
}

const plainText = (/** @type {string} */ s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const linkText = (/** @type {string} */ s) => plainText(s).replace(/[[\]]/g, '');
const linkOf = (/** @type {RadarItem} */ it) => (it.doi ? `https://doi.org/${it.doi}` : it.url);
const titleLink = (/** @type {RadarItem} */ it) => { const url = linkOf(it); return url ? `[${linkText(it.title)}](${url.replace(/\)/g, '%29')})` : linkText(it.title); };
const authorsLine = (/** @type {string[]} */ a) => plainText(a.length > 3 ? `${a.slice(0, 3).join(', ')} +${a.length - 3}` : a.join(', '));

/**
 * The vault note: a reading list, one entry per paper (title as a heading, then authors, venue and date on one line,
 * then why read it), so it reads the same in Obsidian, the web reader and on a phone. A five-column table squeezed
 * the date into "20 / 27 / -01" and the venue into one word a line.
 * @param {{ name: string, date: string, summary: string, news: RadarItem[], older: RadarItem[], discover?: RadarItem[], lines: Map<string, string> }} digest
 * @returns {string}
 */
export function digestMarkdown({ name, date, summary, news, older, discover = [], lines }) {
  const out = [`# ${plainText(name)}, ${date}`, '', `*${plainText(summary)}*`, ''];
  if (news.length) {
    out.push('## New', '');
    for (const it of news) {
      const meta = [authorsLine(it.authors), plainText(it.venue), String(it.date ?? it.year ?? '')].filter(Boolean).join(' · ');
      const why = plainText(lines.get(it.id) ?? (it.abstract ? '' : NO_ABSTRACT));
      out.push(`### ${titleLink(it)}`, ...(meta ? [`*${meta}*`] : []), '', ...(why ? [why, ''] : []));
    }
  }
  if (older.length) {
    out.push('## Worth reading', '');
    for (const it of older) out.push(`### ${titleLink(it)}`, ...(it.reason ? [plainText(it.reason)] : []), '');
  }
  if (discover.length) {
    out.push('## Might interest you', '');
    for (const it of discover) out.push(`### ${titleLink(it)}`, ...(it.reason ? [plainText(it.reason)] : []), '');
  }
  return out.join('\n');
}
