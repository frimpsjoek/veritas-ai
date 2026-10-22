// @ts-nocheck -- UI glue moved from content/*.js (spec 005 C1), which was never typechecked in Zotero either;
// host.d.ts, tools.d.ts and domain.d.ts are still the checked interfaces these files must match.
// ui-src/src/chat/markdown.js. Markdown to DOM, built node by node (no innerHTML), with citations checked
// against the turn's citations. Moved from content/chat.js's `ChatView.markdown` static (spec 005 C1), unchanged
// except its two Zotero-only escapes: a paper citation used `view.openPaper` (chat.js, wrapping
// `this.sb.itemByCitekey`/`Zotero_Tabs.select`) and `view.paperLabel` (wrapping `this.sb.citeLabel`); a note
// wikilink used `view.sb.open`. Both now go through the host: `host.openRef`, `host.citeLabel`/`resolveLabel`,
// `host.openLink`.
import { el } from './dom-helpers.js';
import { outsideButton, wireLink } from '../links.js';
import katex from 'katex';
import { citationKey } from '../../../agent-src/src/citations.js';

/** @typedef {import("../../../agent-src/src/domain").Citation} Citation */
/** @typedef {import("../host").UiHost} UiHost */

// Math (spec: equations render as math, never as raw TeX). KaTeX's MathML output needs no fonts or stylesheet: Gecko
// (Zotero) and Chromium (Obsidian) both draw MathML natively. $...$ needs a non-space after the opening and before the
// closing dollar, and no digit right after it, so "$5 and $10" stays money.
const MATH_INLINE = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$(.+?)\$\$|(?<![\\$\w])\$(?=[^\s$])((?:[^$\n]|\\\$)*?[^\s$\\])\$(?![\d$])/g;

/** @param {Document} doc @param {string} tex @param {boolean} display */
export function mathNode(doc, tex, display) {
  const holder = el(doc, display ? 'div' : 'span', display ? 'sb-math sb-math-block' : 'sb-math');
  try {
    const out = katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false, strict: 'ignore', trust: false });
    const parsed = new doc.defaultView.DOMParser().parseFromString(out, 'text/html');
    const math = parsed.body.querySelector('math');
    if (!math) throw new Error('no math');
    math.querySelectorAll('annotation, annotation-xml').forEach((n) => n.remove()); // the source stays in the title; selecting the equation must not copy it twice
    holder.append(doc.importNode(math, true));
    holder.title = tex;
  } catch {
    holder.classList.add('is-raw');
    holder.textContent = tex;
  }
  return holder;
}

/**
 * A title or one-line label with its inline math drawn as MathML; the rest stays text, and "$5 sensor" stays money.
 * Sorting, searching and attributes keep the raw string, so only what is shown goes through here.
 * @param {Document} doc @param {string} text @returns {DocumentFragment}
 */
export function titleNodes(doc, text) {
  const out = doc.createDocumentFragment();
  let at = 0;
  for (const m of String(text).matchAll(MATH_INLINE)) {
    if (m.index > at) out.append(text.slice(at, m.index));
    out.append(mathNode(doc, (m[1] ?? m[2] ?? m[3] ?? m[4]).trim(), false));
    at = m.index + m[0].length;
  }
  out.append(text.slice(at));
  return out;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * @param {UiHost} host
 * @param {Document} doc
 * @param {string} markdown
 * @param {Citation[]} citationList
 * @param {{ pending?: boolean }} [opts] `pending`: the answer is still streaming (spec 008 S2), so citations
 *   aren't checked yet; they show as plain labels, never marked missing, never clickable, and never trigger a
 *   label lookup (this runs once per animation frame).
 */
export function renderMarkdown(host, doc, markdown, citationList, { pending = false } = {}) {
  const status = new Map(citationList.map((c) => [citationKey(c.ref), c]));
  const root = el(doc, 'div', 'sb-md sb-ai-md');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) { const p = el(doc, 'p'); inline(p, paragraph.join(' ')); root.append(p); }
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush(); list = null;
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      const pre = el(doc, 'pre');
      pre.append(el(doc, 'code', '', code.join('\n')));
      root.append(pre);
      continue;
    }
    const open = /^\s*(\$\$|\\\[)\s*(.*)$/.exec(line);
    if (open && !(open[1] === '$$' && /\$\$\s*$/.test(open[2]) && open[2].trim() !== '$$')) {
      const close = open[1] === '$$' ? '$$' : '\\]';
      const tex = [];
      let rest = open[2];
      let j = i;
      let done = false;
      for (;;) {
        const at = rest.indexOf(close);
        if (at >= 0) { tex.push(rest.slice(0, at)); done = rest.slice(at + close.length).trim() === ''; break; }
        tex.push(rest);
        if (++j >= lines.length || j - i > 40) break;
        rest = lines[j];
      }
      if (done) { flush(); list = null; root.append(mathNode(doc, tex.join('\n').trim(), true)); i = j; continue; }
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) { // a GitHub table (also what a table block that failed to parse is shown as)
      flush(); list = null;
      const table = el(doc, 'table');
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = el(doc, 'tr');
      for (const c of cells(line)) inline(head.appendChild(el(doc, 'th')), c);
      const thead = el(doc, 'thead');
      thead.append(head);
      const tbody = el(doc, 'tbody');
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
        const tr = el(doc, 'tr');
        for (const c of cells(lines[i])) inline(tr.appendChild(el(doc, 'td')), c);
        tbody.append(tr);
      }
      i--;
      table.append(thead, tbody);
      root.append(table);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) { flush(); list = null; continue; }
    if (heading) { flush(); list = null; const h = el(doc, `h${heading[1].length}`); inline(h, heading[2]); root.append(h); continue; }
    if (item) {
      flush();
      const kind = item[1] ? 'ol' : 'ul';
      if (!list || list.localName !== kind) { list = el(doc, kind); root.append(list); }
      const li = el(doc, 'li');
      inline(li, item[2]);
      list.append(li);
      continue;
    }
    if (quote) { flush(); list = null; const q = el(doc, 'blockquote'); inline(q, quote[1]); root.append(q); continue; }
    if (list && /^\s{2,}\S/.test(line)) { inline(list.lastChild, ' ' + line.trim()); continue; }
    list = null;
    paragraph.push(line.trim());
  }
  flush();
  return root;

  function inline(parent, text) {
    let at = 0;
    const code = [...text.matchAll(/`[^`]+`/g)].map((c) => [c.index, c.index + c[0].length]);
    for (const m of text.matchAll(MATH_INLINE)) {
      if (code.some(([from, to]) => m.index >= from && m.index < to)) continue; // a code span keeps its dollars and backslashes
      if (m.index < at) continue;
      if (m.index > at) plain(parent, text.slice(at, m.index));
      const tex = m[1] ?? m[2] ?? m[3] ?? m[4];
      parent.append(mathNode(doc, tex.trim(), m[3] != null || m[2] != null));
      at = m.index + m[0].length;
    }
    if (at === 0) { plain(parent, text); return; }
    if (at < text.length) plain(parent, text.slice(at));
  }

  function plain(parent, text) {
    // bold may hold single-star italics (models write **Author (2024), *Title*.**), so its body allows a lone `*` and a closing `***` (italic and bold ending together)
    const pattern = /\*\*((?:[^*]|\*(?!\*))+?\*?)\*\*(?!\*)|\*([^*\s][^*]*)\*|`([^`]+)`|\[\[(.+?)\]\](?!\])|\[(@[^\]]+)\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)\]"'<>]+)/g;
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) { const b = el(doc, 'strong'); inline(b, m[1]); parent.append(b); }
      else if (m[2]) { const e = el(doc, 'em'); inline(e, m[2]); parent.append(e); }
      else if (m[3]) parent.append(el(doc, 'code', '', m[3]));
      else if (m[4]) parent.append(note(m[4]));
      else if (m[5]) {
        const keys = m[5].split(/[;,]\s*/).map((k) => k.trim().replace(/^@/, '')).filter(Boolean);
        parent.append('(');
        keys.forEach((key, n) => { if (n) parent.append('; '); parent.append(paper(key)); });
        parent.append(')');
      } else if (m[6]) parent.append(link(m[6], m[7]));
      else if (m[8]) {
        const url = m[8].replace(/[.,;:]+$/, '');
        parent.append(link(url, url));
        last -= m[8].length - url.length;
      }
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function paper(key) {
    if (pending) return el(doc, 'span', 'cite is-pending', host.citeLabel(key)?.label ?? `@${key}`);
    const known = status.get(`paper:${key}`);
    const span = el(doc, 'span', 'cite');
    if (known?.status !== 'resolved') {
      span.classList.add('missing');
      span.textContent = `@${key}`;
      span.title = "Couldn't find this in your library";
      return span;
    }
    paperLabel(span, key);
    span.title = `${known.title}\nClick to show it in your library, ⌘-click to open its note`;
    span.addEventListener('click', (event) => host.openRef({ kind: 'paper', citekey: key }, { newTab: event.metaKey || event.ctrlKey }));
    return span;
  }

  function paperLabel(node, citekey) {
    const cached = host.citeLabel(citekey);
    node.textContent = cached?.label ?? citekey;
    if (!cached) host.resolveLabel(citekey).then((label) => { node.textContent = label; });
  }

  function note(path) {
    const known = status.get(`note:${path}`);
    const name = path.replace(/\.md$/, '').split('/').pop();
    if (pending) return el(doc, 'span', 'cite wikilink is-pending', name);
    const span = el(doc, 'span', 'cite wikilink', name);
    if (known?.status !== 'resolved') {
      span.classList.add('missing');
      span.title = "Couldn't find this note";
      return span;
    }
    span.title = `Open in Obsidian: ${path}`;
    span.addEventListener('click', () => host.openRef({ kind: 'note', path: /** @type {any} */ (path) }, { newTab: false }));
    return span;
  }

  function link(label, href) {
    const a = wireLink(el(doc, 'a', '', label), host, href);
    a.title = href;
    // A DOI/web citation the engine could not place (outside the set it was allowed to read) is marked like a missing paper.
    if (!pending && status.get(`web:${href}`)?.status === 'unknown') { a.classList.add('is-missing'); a.title = `${href}\nNot among the papers this answer was allowed to use`; }
    const out = outsideButton(doc, host, href);
    if (!out) return a;
    const both = doc.createDocumentFragment();
    both.append(a, out);
    return both;
  }
}
