// ui-src/dev/web-fixtures.mjs. An invented Second Brain server for the web app's Library, Notes and reader checks: a
// 3,500-paper library with real-sized abstracts (so the first-render time means something), collections, notes with wiki
// links and citations, related/links/duplicates answers, two PDFs (one served with a line of text per page, one 404) and
// a highlight waiting for Zotero. Invented content only.

const WORDS = ['voles', 'foraging', 'doorknob', 'ergonomics', 'lattice', 'phonon', 'moiré', 'graphene', 'kernel', 'tensor', 'gradient', 'seed', 'burrow', 'meadow', 'thermal', 'exciton', 'spectra', 'transport', 'neural', 'surface'];
const FIRST = ['Ann', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana'];
const LAST = ['Chen', 'Ruiz', 'Diaz', 'Okafor', 'Novak', 'Haas', 'Ito', 'Mensah'];
const VENUES = ['Nature', 'Physical Review B', 'Journal of Invented Results', '', 'Science Advances'];
const COUNT = 3500;

const abstractOf = (i) => `${Array.from({ length: 9 }, (_, n) => `Sentence ${n} about ${WORDS[(i + n) % WORDS.length]} and ${WORDS[(i * 3 + n) % WORDS.length]} in the invented study ${i}, measured across several conditions with care.`).join(' ')}`;

export const ITEMS = Array.from({ length: COUNT }, (_, i) => {
  const key = `K${String(i + 1).padStart(4, '0')}`;
  const authors = Array.from({ length: 1 + (i % 4) }, (_, n) => `${FIRST[(i + n) % FIRST.length]} ${LAST[(i * 2 + n) % LAST.length]}`);
  return {
    key, title: i === 0 ? 'Foraging strategies of voles' : i === 1 ? 'Doorknob ergonomics' : i === 20 ? 'Gauge-equivariant $U(1)$ flows' : i === 21 ? 'A $5 sensor for vole burrows' : `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} study ${i}`,
    year: i % 11 === 10 ? '' : String(1995 + (i % 31)), citekey: `C${i}`, authors, venue: VENUES[i % VENUES.length],
    doi: `10.1000/invented.${i}`, abstract: abstractOf(i),
  };
});

const FIGURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#cde"/><circle cx="200" cy="150" r="80" fill="#357"/></svg>')}`;
export const COLLECTIONS = [
  { key: 'COLA', name: 'Physics', parent: null, count: 500 },
  { key: 'COLB', name: 'Biology', parent: null, count: 100 },
  { key: 'COLC', name: 'Condensed matter', parent: 'COLA', count: 250 },
  { key: 'COLD', name: '2D materials', parent: 'COLC', count: 50 },
  ...Array.from({ length: 10 }, (_, n) => ({ key: `COLX${n}`, name: `Reading list ${n + 1}`, parent: null, count: n + 1 })),
];
/** Which papers a collection holds: every 7th for Physics, a subset of it for its children. */
const MEMBERS = {
  COLD: (i) => i % 70 === 0, COLC: (i) => i % 14 === 0, COLA: (i) => i % 7 === 0, COLB: (i) => i % 35 === 1,
};
const DESCENDANTS = { COLA: ['COLA', 'COLC', 'COLD'], COLC: ['COLC', 'COLD'], COLD: ['COLD'], COLB: ['COLB'] };

export const NOTES = {
  'Voles/Winter diet.md': '---\ntags: [voles]\n---\n# Winter diet\n\nVoles eat [[Seeds]] and roots ([@K0001]). See [[Voles/Habitat|the habitat]] and [[Ghost]].\n\n## Sources\n\n[A site](https://example.org/voles)\n',
  'Voles/Seeds.md': '# Seeds\n\nSmall and plentiful.\n',
  'Voles/Habitat.md': '# Habitat\n\nMeadows and hedgerows.\n',
  'Inbox/Gauge $U(1)$ idea.md': '# Gauge idea\n\nTrack the $U(1)$ phase and $a_i b_i$ sums.\n\n$$\\hat H \\psi = E \\psi$$\n\n| Field | Charge | A long column of notes that keeps going |\n| --- | --- | --- |\n| photon | 0 | massless |\n| electron | -1 | light |\n',
  'Inbox/Lonely.md': 'Nothing links here.\n',
};
const NOTE_LINKS = {
  'Voles/Winter diet.md': { links_to: ['Voles/Seeds.md', 'Voles/Habitat.md', 'zotero/K0001', 'Ghost (no note)'], linked_from: ['Inbox/Lonely.md'] },
  'Voles/Seeds.md': { links_to: [], linked_from: ['Voles/Winter diet.md'] },
  'Voles/Habitat.md': { links_to: [], linked_from: ['Voles/Winter diet.md'] },
};

const zoteroMeta = (item) => ({ authors: item.authors, year: item.year, venue: item.venue, doi: item.doi, citekey: item.citekey, collections: [], zotero_uri: `zotero://select/library/items/${item.key}` });
const ref = (item) => ({ path: `zotero/${item.key}`, title: item.title, source: 'zotero', zotero: zoteroMeta(item) });
const byKey = new Map(ITEMS.map((item) => [item.key, item]));

const attachmentsOf = (item) => {
  if (item.key === 'K0003') return [];
  const pdf = item.key === 'K0001' ? 'ATTOK001' : `ATT${item.key}`;
  return [{
    key: pdf, title: `${item.citekey}.pdf`, content_type: 'application/pdf', has_full_text: true, open_uri: `zotero://open-pdf/library/items/${pdf}`,
    highlights: item.key === 'K0001' ? [
      { type: 'highlight', text: 'Voles cache seeds in autumn.', comment: 'Check against the field data.', color: '#ffd400', page: '3', key: 'H1', sort_index: '00000|000000|00038', position: { pageIndex: 0, rects: [[20, 146, 120, 162]] } },
      { type: 'highlight', text: 'Winter diet shifts to roots.', comment: '', color: '#ff6666', page: '5', key: 'H2', sort_index: '', position: null },
    ] : [],
  }];
};

const detailOf = (item) => ({
  key: item.key, type: 'journalArticle', title: item.title, creators: item.authors.map((name) => ({ name, role: 'author' })), date: `${item.year || '2020'}-05-01`,
  year: item.year, venue: item.venue, volume: '12', issue: '3', pages: '101-118', doi: item.doi, url: `https://example.org/${item.key}`, citekey: item.citekey,
  abstract: item.key === 'K0003' ? '' : item.abstract, tags: ['invented', 'fixture'], collections: ['Physics'],
  notes: item.key === 'K0001' ? ['### Annotations\n\nVoles cache seeds in autumn. See [[Seeds]].'] : [], attachments: attachmentsOf(item), zotero_uri: `zotero://select/library/items/${item.key}`,
});

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Just enough Markdown for the fixtures: headings, paragraphs, [text](url), [[wiki|label]] and [@KEY]. */
export function renderMarkdown(markdown) {
  const inline = (text) => escapeHtml(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => `<span class="wikilink">${label || target}</span>`)
    .replace(/\[@(K\d{4})\]/g, (_, key) => `<span class="cite" data-key="${key}" title="${byKey.get(key)?.title ?? ''}">${byKey.get(key)?.authors[0].split(' ').pop() ?? key} et al. ${byKey.get(key)?.year ?? ''}</span>`);
  return markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => {
    if (block.startsWith('|')) {
      const rows = block.split('\n').filter((r) => !/^\|\s*-/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      return `<table><thead><tr>${rows[0].map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    const heading = /^(#{1,3}) (.*)$/.exec(block);
    return heading ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>` : `<p>${inline(block)}</p>`;
  }).join('\n');
}

/** A PDF with one line of Helvetica per page (300 x 200 pt, baseline at y 150, 14 pt), with a correct xref table. @param {string[]} lines */
function textPdf(lines) {
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}]/Count ${lines.length}>>`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  for (const [i, line] of lines.entries()) {
    const stream = `BT /F1 14 Tf 20 150 Td (${line}) Tj ET`;
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + i * 2} 0 R>>`, `<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  }
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${body}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
}
export const PDF_LINES = ['Voles cache seeds in autumn.', 'Winter diet shifts to roots.'];
const PDF = textPdf(PDF_LINES);
/** A highlight made in the web reader that the Zotero plugin has not saved yet, on the PDF's second page. */
export const WAITING = { id: 'q1', kind: 'annotation', key: 'ATTOK001', done: false, attempts: 0, annotation: {
  type: 'highlight', text: 'Winter diet shifts to roots.', comment: '', color: '#2ea8e5', pageLabel: '2', sortIndex: '00001|000000|00038',
  position: { pageIndex: 1, rects: [[20, 146, 200, 162]] }, key: 'WAIT2345' } };

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** GET /web/page for the invented sites of dev/browser-checks.mjs (spec 015). @param {string} url @param {string | null} prefer */
function webPage(url, prefer) {
  const host = new URL(url).hostname;
  // a paper link (spec 022): the server found an open-access preprint
  if (host === 'doi.org') return json({ mode: 'pdf', url: 'https://files.example/paper.pdf', title: 'Voles, the preprint', source: 'open access', version: 'submitted', where: 'arXiv (Cornell University)' });
  if (host === 'frame.example' && prefer !== 'reader') return json({ mode: 'frame', url, title: 'A framed page' });
  if (host === 'frame.example' || host === 'reader.example') {
    const html = `<p>Voles cache seeds in autumn and shift to roots in winter, which is why the study followed them for ${'a long season '.repeat(12)}.</p><p>Read <a href="https://reader.example/other">the other article</a>, <a href="https://files.example/paper.pdf">the preprint</a> or <a href="https://reader.example/blocked">a closed one</a>.</p>`;
    return json({ mode: 'reader', url: url.replace('/other', '/other'), title: url.endsWith('/other') ? 'The other article' : 'Voles in the reader', byline: 'Ann Chen, Bo Ruiz', html });
  }
  if (host === 'slow.example') return json({ mode: 'blocked', url, title: 'slow.example', reason: 'The site took too long to answer.' });
  return json({ mode: 'blocked', url, title: host, reason: 'This page has no text that can be shown here (it may need JavaScript or a sign-in).' });
}

// The folder list (server spec 018): a vault, the Zotero library and one plain folder; POST/PATCH/DELETE change it.
const FOLDERS = [
  { name: 'second-brain', path: '/Users/me/Documents/Second-Brain', enabled: true, skip: [], kind: 'obsidian', role: 'main', documents: 40 },
  { name: 'zotero', path: '/Users/me/Zotero', enabled: true, skip: [], kind: 'zotero', role: 'zotero', documents: 12 },
  { name: 'papers', path: '/Users/me/Papers', enabled: true, skip: [], kind: 'plain', role: 'listed', documents: 7 },
];
const foldersReport = () => ({ main: FOLDERS[0].path, main_is_vault: true, main_documents: null, zotero: FOLDERS[1].path, folders: FOLDERS });

/** @param {URL} url @param {string} method @param {string | null} post */
function folders(url, method, post) {
  const body = JSON.parse(post || '{}');
  if (url.pathname === '/sources' && method === 'GET') return json(foldersReport());
  if (url.pathname === '/sources' && method === 'POST') {
    if (!String(body.path ?? '').startsWith('/')) return json({ error: "give the folder's full path" }, 400);
    const name = body.name || body.path.split('/').filter(Boolean).pop().toLowerCase();
    if (FOLDERS.some((f) => f.name === name)) return json({ error: `there is already a folder named '${name}'` }, 409);
    FOLDERS.push({ name, path: body.path, enabled: true, skip: [], kind: 'plain', role: 'listed', documents: 0 });
    return json({ name, kind: 'plain', ...foldersReport() }, 201);
  }
  const at = FOLDERS.findIndex((f) => f.name === decodeURIComponent(url.pathname.slice('/sources/'.length)));
  if (at < 0) return json({ error: 'no such folder in the list' }, 404);
  if (method === 'DELETE') FOLDERS.splice(at, 1);
  if (method === 'PATCH' && 'enabled' in body) Object.assign(FOLDERS[at], { enabled: body.enabled, role: body.enabled ? (FOLDERS[at].kind === 'zotero' ? 'zotero' : 'listed') : 'off' });
  return json(foldersReport());
}

/** Answers one request, or returns null for paths that are not the server's (the harness serves those itself).
 *  @param {URL} url @param {string} method @param {string | null} post @param {Record<string, string>} [headers] */
export function answer(url, method, post, headers = {}) {
  const q = url.searchParams;
  // a framed page (spec 015): the iframe's own request to the invented site
  if (url.hostname === 'frame.example') return { status: 200, contentType: 'text/html', body: '<!doctype html><title>Framed</title><h1 id="framed">A framed page</h1>' };
  if (url.pathname === '/sources' || url.pathname.startsWith('/sources/')) return folders(url, method, post);
  switch (url.pathname) {
    case '/web/page': return webPage(q.get('url') ?? '', q.get('prefer'));
    case '/web/pdf': return q.get('url') === 'https://files.example/paper.pdf' ? { status: 200, contentType: 'application/pdf', body: PDF } : json({ error: 'This link is not a PDF' }, 415);
    case '/zotero/collections': return json(COLLECTIONS);
    case '/zotero/items': {
      const keys = (q.get('collections') ?? '').split(',').filter(Boolean);
      if (!keys.length) return json({ items: ITEMS });
      const tests = keys.flatMap((key) => DESCENDANTS[key] ?? [key]).map((key) => MEMBERS[key] ?? (() => false));
      return json({ items: ITEMS.filter((_, i) => tests.some((test) => test(i))) });
    }
    case '/search': {
      const text = (q.get('q') ?? '').toLowerCase();
      if (q.get('exclude_source') === 'zotero') {
        const hits = Object.keys(NOTES).filter((path) => `${path} ${NOTES[path]}`.toLowerCase().includes(text)).map((path) => ({
          path, title: path.split('/').pop().replace(/\.md$/, ''), source: 'personal', tags: [], modified: '2026-10-01',
          passages: [{ heading: 'Intro', snippet: NOTES[path].replace(/^---[\s\S]*?---\n/, '').slice(0, 120) }],
        }));
        return json(hits);
      }
      const limit = Number(q.get('limit') ?? 20);
      return json(ITEMS.filter((item) => item.title.toLowerCase().includes(text)).slice(0, limit).map((item) => ({ ...ref(item), passages: [] })));
    }
    case '/recent': return json([
      ...Object.keys(NOTES).map((path, n) => ({ path, title: path.split('/').pop().replace(/\.md$/, ''), source: 'personal', modified: `2026-10-0${n + 1} 09:00` })),
      { path: 'zotero/K0001', title: 'Foraging strategies of voles', source: 'zotero', modified: '2026-10-05 09:00' },
    ]);
    case '/note': {
      const text = NOTES[q.get('path')];
      return text === undefined ? json({ error: 'no such note' }, 404) : json({ path: q.get('path'), chars: text.length, offset: 0, truncated: false, next_offset: null, text });
    }
    // a figure for the radar's first paper only; the others have none (most ACS / APS papers)
    case '/paper-figure': return json({ image: url.searchParams.get('doi') === '10.1/vole' ? FIGURE : null });
    case '/render': return json({ html: renderMarkdown(JSON.parse(post ?? '{}').markdown ?? '') });
    case '/links': {
      const path = q.get('path') ?? '';
      if (path.startsWith('@')) { const item = ITEMS.find((i) => i.citekey === path.slice(1)); return json({ path: item ? `zotero/${item.key}` : path, links_to: [], linked_from: [] }); }
      return json({ path, ...(NOTE_LINKS[path] ?? { links_to: [], linked_from: [] }) });
    }
    case '/related': {
      const path = q.get('path') ?? '';
      if (path === 'Inbox/Missing.md') return json({ error: 'not indexed' }, 404);
      const links = NOTE_LINKS[path] ?? { links_to: [], linked_from: [] };
      const withData = path === 'zotero/K0001' || path === 'Voles/Winter diet.md';
      return json({
        path, ...links, refs: { 'zotero/K0001': ref(byKey.get('K0001')) },
        similar: withData ? [{ ...ref(byKey.get('K0004')), score: 0.93 }, { path: 'Voles/Habitat.md', title: 'Habitat', score: 0.81 }] : [],
        shared_tags: withData ? [{ path: 'Voles/Seeds.md', title: 'Seeds', tags: ['voles', 'diet'], score: 6.9 }] : [],
      });
    }
    case '/duplicates': return json({
      exact: [['Voles/Seeds.md', 'Inbox/Seeds copy.md']], near: [{ paths: ['Voles/Habitat.md', 'Inbox/Habitat 2.md'], score: 0.99 }], zotero: [[ref(byKey.get('K0004')), ref(byKey.get('K0005'))]],
    });
    case '/conflicts': return json({ total: 2, identical: [{ copy: 'Voles/Seeds (conflict).md', original: 'Voles/Seeds.md', copy_chars: 12, original_chars: 12, copy_newer: false }], different: [{ copy: 'Voles/Habitat 2.md', original: 'Voles/Habitat.md', copy_chars: 40, original_chars: 30, copy_newer: true }], no_original: [] });
    case '/index': return json({ started: true });
    // a site's own icon (the server fetches and keeps it); here every site has the same invented 1 x 1 icon
    case '/site-icon': return { status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') };
    case '/zotero/pdf': {
      if (q.get('key') !== 'ATTOK001') return json({ error: 'no PDF file for this attachment' }, 404);
      const range = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
      if (!range) return { status: 200, contentType: 'application/pdf', headers: { 'accept-ranges': 'bytes' }, body: PDF };
      const end = Math.min(Number(range[2] || PDF.length - 1), PDF.length - 1);
      return { status: 206, contentType: 'application/pdf', headers: { 'content-range': `bytes ${range[1]}-${end}/${PDF.length}`, 'accept-ranges': 'bytes' }, body: PDF.slice(Number(range[1]), end + 1) };
    }
    case '/zotero/pending-adds': return json([WAITING, { id: 'q0', kind: 'tag', key: 'K0001', tag: 'Read later', done: false, attempts: 0 }]);
    case '/zotero/annotate': return json({ status: 'queued', id: 'q2' });
    case '/zotero': {
      const item = byKey.get(q.get('key') ?? '');
      return item ? json(detailOf(item)) : json({ error: 'no Zotero item' }, 404);
    }
    default: return null;
  }
}

/** Routes every server path on a Playwright page to the fixture. @param {import("playwright").Page} page */
export async function useFixtures(page) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = answer(url, request.method(), request.postData(), request.headers());
    if (!reply) return route.continue();
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.fulfill(reply);
  });
  return calls;
}
