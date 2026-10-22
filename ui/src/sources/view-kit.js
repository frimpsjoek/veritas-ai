// @ts-check
// ui-src/src/web/view-kit.js. What Library, Notes and the two readers share: the server call the shared panels take,
// how a paper or note reference becomes a route, and a few text helpers. No layout here.
import { h } from '../dom.js';
import { formatRoute } from './route.js';

/** @typedef {import("./route.js").WebRoute} WebRoute */
/** @typedef {import("../panels/related-panels.js").FetchJSON} FetchJSON */
/** @typedef {{ host: any, doc: Document, win: Window, go: (route: WebRoute) => void, links: import('../home/links.js').HomeLinks }} ViewContext */

export const VAULT = 'Second-Brain';

/** The shared panels' `fetchJSON`, over the web host's call. @param {any} host @returns {FetchJSON} */
export function apiOf(host) {
  return (route, params, init) => {
    const query = params && Object.keys(params).length
      ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
    return host.json(`${route}${query}`, init?.method, init?.body);
  };
}

/** The route a vault path opens in the app: zotero/KEY is a paper, anything else a note. @param {string} path @returns {WebRoute} */
export function routeOfPath(path) {
  return path.startsWith('zotero/') ? { view: 'paper', key: path.slice('zotero/'.length) } : { view: 'note', path };
}

/** @param {string} path */
export const hrefOfPath = (path) => formatRoute(routeOfPath(path));

/** The key of the Zotero item behind a "zotero/KEY" path. @param {string} path */
export const keyOfPath = (path) => path.replace(/^zotero\//, '');

/** @param {string} path */
export function obsidianUri(path) {
  return `obsidian://open?vault=${encodeURIComponent(VAULT)}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;
}

/** A path in a listed folder (server spec 018): "papers:/review.md". Obsidian cannot open these. @param {string} path */
export const isListedPath = (path) => /^[a-z0-9][a-z0-9-]{0,31}:\//.test(path);

/** An indexed PDF or image (any folder), as opposed to a note with a text reader. @param {string} path */
export const isDocumentPath = (path) => /\.(pdf|png|jpe?g|webp|heic|gif|tiff?|bmp)$/i.test(path);

/** A notes-reader path: Markdown in the vault, also .markdown and .txt in listed folders. @param {string} path */
export const isNotePath = (path) => /\.(md|markdown|txt)$/i.test(path) && !path.startsWith('zotero/');

/** The server URL (same origin) that streams an indexed PDF or image. @param {string} path */
export const documentUrl = (path) => `/folder-file?${new URLSearchParams({ path })}`;

/** What a related or linked row does: papers and notes open here; a PDF or image (any folder) opens from the server
 *  in the browser's own viewer: on the same origin by its plain URL, else through `openDocument` (the web app on
 *  another origin opens it with a single-use ticket).
 *  @param {Window} win @param {(route: WebRoute) => void} go @param {((path: string) => void) | undefined} [openDocument]
 *  @returns {(ref: { path: string }) => void} */
export function openRefHandler(win, go, openDocument) {
  return (ref) => {
    const route = routeOfPath(ref.path);
    if (route.view === 'note' && isDocumentPath(ref.path)) { if (openDocument) openDocument(ref.path); else win.location.assign(documentUrl(ref.path)); } else go(route);
  };
}

/** Authors for a row or a header: "Chen, Ruiz and Diaz". @param {string[]} authors @param {number} [max] */
export function authorLine(authors, max = 3) {
  if (!authors.length) return '';
  if (authors.length <= max) return authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors[authors.length - 1]}` : authors[0];
  return `${authors.slice(0, max).join(', ')} and ${authors.length - max} more`;
}

/** A note's name: its file name without the extension. @param {string} path */
export const titleFromPath = (path) => path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? path;

/** The part of a note path that is its folder, for a meta line. @param {string} path */
export function folderLabel(path) {
  if (isListedPath(path)) {
    const [name, inner] = [path.slice(0, path.indexOf(':/')), path.slice(path.indexOf(':/') + 2)];
    const i = inner.lastIndexOf('/');
    return i < 0 ? name : `${name}/${inner.slice(0, i)}`;
  }
  const i = path.lastIndexOf('/');
  return i < 0 ? 'Vault' : path.slice(0, i);
}

/** A DOI as a link target. @param {string} doi */
export const doiUrl = (doi) => `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}`;

/** Strips a YAML front matter block. @param {string} text */
export function withoutFrontMatter(text) {
  // Some imported notes carry two properties blocks one after the other; Obsidian shows neither as text.
  let out = text;
  for (let before = ''; before !== out;) { before = out; out = out.replace(/^\s*---\n[\s\S]*?\n---[ \t]*(\n|$)/, ''); }
  return out;
}

const SOURCE_LINE = /^\[(\d+)\]\s+(https?:\/\/\S+)\s+[—–-]{1,2}\s+(.+)$/;
const PLAIN_LINE = /^(?!\s*$)(?!\s*([#>|]|[-*+]\s|\d+[.)]\s|```|~~~|<|\$\$|!\[|\[\^))/;

/**
 * Note Markdown the way Obsidian reads it, for the server's strict renderer: a single line break stays a line break,
 * bare web addresses become links, and a numbered source line ("[1] https://doi.org/… — Title") becomes a list item
 * with the title as the link and the address under it. Fenced code is left alone.
 * @param {string} markdown
 */
export function readerMarkdown(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue; }
    if (fence) { out.push(line); continue; }
    // ![…](youtube link): Obsidian plays it; here it is the video's thumbnail, linked to the video. ![]() is dropped.
    line = line.replace(/!\[([^\]]*)\]\(\s*\)/g, '').replace(/!\[([^\]]*)\]\((https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{6,}))[^)]*\)/g,
      (_m, alt, url, id) => `[![${alt || 'YouTube video'}](https://i.ytimg.com/vi/${id}/hqdefault.jpg)](${url})`);
    const source = SOURCE_LINE.exec(line.trim());
    if (source) {
      const [, n, url, title] = source;
      const href = url.replace(/\)/g, '%29');
      out.push(`- **${n}.** [${title.replace(/[[\]]/g, '')}](${href})  `, `  [${url.replace(/^https?:\/\/(www\.)?/, '')}](${href})`);
      continue;
    }
    line = pandocScripts(line);
    if (PLAIN_LINE.test(line)) {
      line = line.replace(/(^|\s|(?<!\])\()(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g, (_m, pre, url) => `${pre}<${url}>`);
      if (i + 1 < lines.length && PLAIN_LINE.test(lines[i + 1]) && !/ {2}$/.test(line)) line = `${line}  `;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Pandoc's superscript and subscript, as in "d^6^" and "H~2~O" (no spaces inside), outside inline code. Not a
 *  footnote marker ([^1]), not ~~strikethrough~~, not a ~ inside a web address (/~user/).
 *  @param {string} line */
export function pandocScripts(line) {
  return line.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part
    .replace(/(?<![[\\^])\^([^\s^\]]+?)\^/g, '<sup>$1</sup>')
    .replace(/(?<![~/\\])~([^\s~/]+?)~(?!~)/g, '<sub>$1</sub>'))).join('');
}

/** Obsidian hides %% comments %% in reading view; so does the reader. @param {string} text */
export function withoutComments(text) {
  return text.replace(/%%[\s\S]*?%%/g, '');
}

// $$…$$ and \[…\] (display), $…$ and \(…\) (inline; a dollar amount like "$5 and $10" stays text, as in the chat).
const DISPLAY_MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
const INLINE_MATH = /\\\((.+?)\\\)|(?<![\\$\w])\$(?=[^\s$])((?:[^$\n]|\\\$)*?[^\s$\\])\$(?![\d$])/g;
const MATH_TOKEN = /SBMATH(\d+)X/g;

/**
 * Takes the TeX out of note Markdown before the server renders it (which would turn a_i b_i into emphasis) and puts
 * a plain token in its place; `restoreMath` draws each one as MathML afterwards. Code is left alone.
 * @param {string} markdown @returns {{ markdown: string, formulas: { tex: string, display: boolean }[] }}
 */
export function protectMath(markdown) {
  /** @type {{ tex: string, display: boolean }[]} */ const formulas = [];
  const put = (/** @type {string} */ tex, /** @type {boolean} */ display) => `SBMATH${formulas.push({ tex: tex.trim(), display }) - 1}X`;
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/);
  const out = parts.map((part, i) => (i % 2 ? part : part
    // $$…$$ on its own line is a display equation; inside a sentence (common in exported AI notes) it stays inline
    .replace(DISPLAY_MATH, (m, a, b, at, all) => {
      const alone = /(^|\n)[ \t>]*$/.test(all.slice(0, at)) && /^[ \t]*(\n|$)/.test(all.slice(at + m.length));
      return alone ? `\n\n${put(a ?? b, true)}\n\n` : put(a ?? b, false);
    })
    .replace(INLINE_MATH, (_m, a, b) => put(a ?? b, false)))).join('');
  return { markdown: out, formulas };
}

/** Draws the formulas `protectMath` took out with `draw` (markdown.js mathNode; passed in so this module stays free of
 *  KaTeX): a token alone in a paragraph becomes a display equation.
 *  @param {Document} doc @param {ParentNode} root @param {{ tex: string, display: boolean }[]} formulas
 *  @param {(doc: Document, tex: string, display: boolean) => HTMLElement} draw */
export function restoreMath(doc, root, formulas, draw) {
  if (!formulas.length) return;
  const walker = doc.createTreeWalker(root, 4);
  /** @type {Text[]} */ const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/SBMATH\d+X/.test(n.nodeValue ?? '')) texts.push(/** @type {Text} */ (n));
  for (const text of texts) {
    const value = text.nodeValue ?? '';
    const pieces = [];
    let last = 0;
    for (const m of value.matchAll(MATH_TOKEN)) {
      if (m.index > last) pieces.push(doc.createTextNode(value.slice(last, m.index)));
      const f = formulas[Number(m[1])];
      pieces.push(f ? draw(doc, f.tex, f.display) : doc.createTextNode(m[0]));
      last = m.index + m[0].length;
    }
    if (last < value.length) pieces.push(doc.createTextNode(value.slice(last)));
    const parent = text.parentElement;
    // a display equation alone in its paragraph replaces the paragraph, so it is not a block inside a <p>
    if (parent?.tagName === 'P' && parent.childNodes.length === 1 && pieces.length === 1 && /** @type {HTMLElement} */ (pieces[0]).classList?.contains('sb-math-block')) parent.replaceWith(pieces[0]);
    else text.replaceWith(...pieces);
  }
}

/**
 * A note's table in a sideways-scrolling box, with a grip on each header cell's right edge: drag to make that column
 * wider or narrower (the table may grow past the reading column and scroll), double-click to give it back its own width.
 * @param {Document} doc @param {HTMLTableElement} table
 */
export function resizableTable(doc, table) {
  const wrap = doc.createElement('div');
  wrap.className = 'sbw-table-wrap';
  table.replaceWith(wrap);
  wrap.append(table);
  const heads = Array.from(table.querySelectorAll('thead th, tr:first-child > th'));
  /** Fixed layout from the first drag on, starting from the widths the browser chose, so nothing jumps. */
  const freeze = () => {
    if (table.style.tableLayout === 'fixed') return;
    const widths = heads.map((th) => /** @type {HTMLElement} */ (th).getBoundingClientRect().width);
    heads.forEach((th, i) => { /** @type {HTMLElement} */ (th).style.width = `${widths[i]}px`; });
    table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    table.style.tableLayout = 'fixed';
  };
  const total = () => { table.style.width = `${heads.reduce((sum, th) => sum + /** @type {HTMLElement} */ (th).getBoundingClientRect().width, 0)}px`; };
  for (const th of /** @type {HTMLElement[]} */ (heads)) {
    const grip = doc.createElement('span');
    grip.className = 'sbw-col-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      freeze();
      const startX = event.clientX;
      const start = th.getBoundingClientRect().width;
      grip.setPointerCapture?.(event.pointerId);
      wrap.classList.add('is-resizing');
      const move = (/** @type {PointerEvent} */ e) => { th.style.width = `${Math.max(48, start + e.clientX - startX)}px`; total(); };
      const up = () => { grip.removeEventListener('pointermove', move); wrap.classList.remove('is-resizing'); };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });
    grip.addEventListener('dblclick', () => {
      heads.forEach((h) => { /** @type {HTMLElement} */ (h).style.width = ''; });
      table.style.width = '';
      table.style.tableLayout = '';
    });
    th.append(grip);
  }
}

const IMAGE_EMBED = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** A Markdown image with a path relative to the note (![Approach](data/2026-10-12/fig.png)) would load from the web
 *  app's own address; it is served by /file, which looks next to the note first. Web, data and absolute addresses stay.
 *  @param {string} markdown @param {string} notePath */
export function localImages(markdown, notePath) {
  return markdown.replace(/!\[([^\]]*)\]\(<?(?!https?:|data:|\/|#)([^)\s>]+)>?(\s+"[^"]*")?\)/g, (whole, alt, path) => {
    let rel = path;
    try { rel = decodeURIComponent(path); } catch { /* keep it as written */ }
    if (!IMAGE_EMBED.test(rel)) return whole;
    const src = `/file?${new URLSearchParams({ path: rel, ...(notePath ? { note: notePath } : {}) })}`;
    return `![${alt}](${src.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  });
}

/**
 * Turns [[target|label]] into a Markdown link to the in-app note when the note is one this note links to (`known`
 * holds those paths), so /render keeps both the label and the target. Unknown targets stay as [[wiki links]]. An
 * image embed (![[figure.png]]) becomes an image from the vault, looked up beside `notePath` first.
 * @param {string} markdown @param {string[]} known @param {string} [notePath]
 */

export function linkWikiTargets(markdown, known, notePath = '') {
  /** @type {Map<string, string>} */ const byName = new Map();
  for (const path of known) {
    byName.set(path.replace(/\.md$/, '').toLowerCase(), path);
    const base = path.replace(/\.md$/, '').split('/').pop()?.toLowerCase();
    if (base && !byName.has(base)) byName.set(base, path);
  }
  return localImages(markdown, notePath).replace(/(!?)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (whole, bang, target, label) => {
    if (bang) {
      // ![[figure.png|300]]: an image in the vault, served by the server's /file route (found by name, nearest this note first).
      const file = String(target).trim();
      if (!IMAGE_EMBED.test(file)) return whole;
      const src = `/file?${new URLSearchParams({ name: file, ...(notePath ? { note: notePath } : {}) })}`;
      return `![${file.split('/').pop()?.replace(/[[\]]/g, '') ?? ''}](${src.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    }
    const name = String(target).split('#')[0].trim().toLowerCase();
    const path = byName.get(name) ?? byName.get(name.split('/').pop() ?? name);
    if (!path) return whole;
    const text = String(label || String(target).split('#')[0].split('/').pop()).replace(/[[\]]/g, '');
    return `[${text}](${hrefOfPath(path).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  });
}

/**
 * Makes rendered note HTML safe to show and routes its links in-app: scripts and handlers are removed, `.cite` spans
 * become links to the paper, external links get rel=noopener (the caller routes their clicks with interceptLinks), `.wikilink` spans with no note stay as quiet text.
 * An image from the server (`/file?...`) goes through `host.assetUrl` when the host has one: the web app on another
 * origin swaps in a blob URL fetched with its token. Without the hook the path stays as it is.
 * @param {Document} doc @param {string} html
 * @param {{ assetUrl?: (path: string) => string | Promise<string> } | null} [host]
 * @returns {DocumentFragment}
 */
export function noteFragment(doc, html, host) {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  for (const bad of Array.from(root.querySelectorAll('script, style, iframe, object, embed, link, meta, form'))) bad.remove();
  for (const node of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || (['href', 'src'].includes(name) && /^\s*(javascript|data):/i.test(attr.value) && !(name === 'src' && /^\s*data:image\//i.test(attr.value)))) node.removeAttribute(attr.name);
    }
  }
  for (const cite of Array.from(root.querySelectorAll('span.cite[data-key]'))) {
    const link = doc.createElement('a');
    link.className = 'sbw-cite';
    link.href = formatRoute({ view: 'paper', key: /** @type {string} */ (cite.getAttribute('data-key')) });
    link.title = cite.getAttribute('title') ?? '';
    link.textContent = cite.textContent;
    cite.replaceWith(link);
  }
  for (const wiki of Array.from(root.querySelectorAll('span.wikilink'))) wiki.classList.add('is-missing');
  for (const table of Array.from(root.querySelectorAll('table'))) resizableTable(doc, /** @type {HTMLTableElement} */ (table));
  // An image whose address has died (an expired signed link, a moved site) says so and links to where it was.
  for (const img of /** @type {HTMLImageElement[]} */ (Array.from(root.querySelectorAll('img[src^="http"]')))) {
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.addEventListener('error', () => {
      const gone = doc.createElement('a');
      gone.className = 'sbw-img-gone';
      gone.href = img.getAttribute('src') ?? '';
      gone.rel = 'noopener noreferrer';
      gone.textContent = `Image no longer available${img.getAttribute('alt') ? `: ${img.getAttribute('alt')}` : ''}`;
      img.replaceWith(gone);
    }, { once: true });
    // YouTube answers a missing thumbnail with a 120 x 90 grey placeholder (a removed or private video).
    if (/i\.ytimg\.com/.test(img.getAttribute('src') ?? '')) {
      img.addEventListener('load', () => {
        const link = img.closest('a');
        if (img.naturalWidth > 120 || !link) return;
        const watch = doc.createElement('a');
        watch.className = 'sbw-img-gone';
        watch.href = link.getAttribute('href') ?? '';
        watch.rel = 'noopener noreferrer';
        watch.textContent = 'Watch on YouTube';
        link.replaceWith(watch);
      }, { once: true });
    }
  }
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) link.setAttribute('rel', 'noopener noreferrer'); // opened by interceptLinks (links.js) on the container
  }
  const assetUrl = host?.assetUrl;
  // The template's images have not loaded yet (its content is inert), so a swapped path is never requested without the token.
  if (assetUrl) for (const img of /** @type {HTMLImageElement[]} */ (Array.from(root.querySelectorAll('img[src^="/"]')))) {
    const path = img.getAttribute('src') ?? '';
    if (path.startsWith('//')) continue;
    const swapped = assetUrl(path);
    if (typeof swapped === 'string') { if (swapped !== path) img.setAttribute('src', swapped); continue; }
    img.removeAttribute('src');
    swapped.then((url) => img.setAttribute('src', url), () => { img.alt = `Image unavailable${img.alt ? `: ${img.alt}` : ''}`; });
  }
  return root;
}

/** Titles of library papers by "zotero/KEY", looked up once each; null when the item cannot be read.
 *  @param {import("../panels/related-panels.js").FetchJSON} api @returns {(path: string) => Promise<string | null>} */
export function titleResolver(api) {
  /** @type {Map<string, Promise<string | null>>} */
  const cache = new Map();
  return (path) => {
    let found = cache.get(path);
    if (!found) { found = api('/zotero', { key: keyOfPath(path) }).then((item) => String(item.title), () => null); cache.set(path, found); }
    return found;
  };
}

/** One headed block of a reader's side panel (Info, Related, Links). The panels inside carry their own collapsible sections.
 *  @param {Document} doc @param {string} title @param {...Node} content */
export function panelBlock(doc, title, ...content) {
  const block = h(doc, 'section', 'sbw-panel-block');
  block.append(h(doc, 'h2', 'sbw-panel-h', title), ...content);
  return block;
}
