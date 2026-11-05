// ui-src/dev/browser-checks.mjs. Playwright checks for spec 015 B3 against the built dist-web/ bundle: the in-app
// browser panel on the fake web host (dev/harness/web.html), its /web/page and /web/pdf answered by dev/web-fixtures.mjs.
// Framed page, reader view, the plain card, a PDF in the PDF reader, back / reload / outside / close, 1280 / 700 / 360 px.
// Invented sites only. Run by dev/run.mjs (SB_ONLY=browser).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFixtures } from './web-fixtures.mjs';

const dist = fileURLToPath(new URL('../../web/dist-web', import.meta.url));
const WIDTHS = [1280, 700, 360];

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runBrowserChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} browser: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const files = readdirSync(dist);
  const js = files.find((f) => /^app-[0-9a-f]{8}\.js$/.test(f));
  const css = files.find((f) => /^app-[0-9a-f]{8}\.css$/.test(f));
  if (!js || !css) { check('the bundle is built (run npm run build:web first)', false, files); return { failures, count }; }
  const origin = `http://127.0.0.1:${port}`;
  const fakeUrl = `${origin}/dev/harness/web.html?js=${encodeURIComponent(`/dist-web/${js}`)}&css=${encodeURIComponent(`/dist-web/${css}`)}`;

  for (const width of WIDTHS) {
    const tag = `${width}px`;
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    const calls = await useFixtures(page);
    await page.goto(fakeUrl);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const open = (url, opts) => page.evaluate(([u, o]) => window.__host.openLink(u, o), [url, opts]);
    const panel = () => page.evaluate(() => {
      const p = document.querySelector('.sbw-browser');
      const bar = document.querySelector('.sbw-browser-bar');
      return {
        open: Boolean(p) && !p.hidden,
        title: document.querySelector('.sbw-browser-title')?.textContent,
        address: document.querySelector('.sbw-browser-address')?.textContent,
        frame: document.querySelector('.sbw-browser-frame')?.getAttribute('src') ?? null,
        sandbox: document.querySelector('.sbw-browser-frame')?.getAttribute('sandbox') ?? null,
        article: document.querySelector('.sbw-browser-article h1')?.textContent ?? null,
        card: document.querySelector('.sbw-browser-card-title')?.textContent ?? null,
        pdf: Boolean(document.querySelector('.sbw-browser .sbw-pdf')),
        barFits: bar ? bar.scrollWidth <= bar.clientWidth : null,
        back: document.querySelector('.sbw-browser-tool[aria-label="Back"]')?.disabled,
        sideways: document.scrollingElement.scrollWidth > innerWidth,
      };
    });

    // a framed page
    await open('https://frame.example/page');
    await page.waitForSelector('.sbw-browser-frame');
    let s = await panel();
    check(`${tag} a link opens the panel with the page framed`, s.open && s.frame === 'https://frame.example/page' && s.title === 'A framed page' && s.address === 'frame.example/page', s);
    check(`${tag} the frame cannot navigate the app (sandbox has no top navigation)`, s.sandbox && !/top-navigation/.test(s.sandbox), s.sandbox);
    check(`${tag} the bar fits and the page does not scroll sideways`, s.barFits === true && !s.sideways, s);
    await page.screenshot({ path: join(outDir, `browser-frame-${width}.png`) });

    // Reader view of the same page, then a link inside it stays in the panel, and Back returns
    await page.click('.sbw-browser-text');
    await page.waitForSelector('.sbw-browser-article');
    s = await panel();
    check(`${tag} "Reader view" shows the readable article`, s.article === 'Voles in the reader' && !s.frame, s);
    await page.click('.sbw-browser-article a[href="https://reader.example/other"]');
    await page.waitForFunction(() => document.querySelector('.sbw-browser-title')?.textContent === 'The other article');
    s = await panel();
    check(`${tag} a link inside the reader stays in the panel and Back becomes available`, s.open && s.back === false, s);
    await page.click('.sbw-browser-tool[aria-label="Back"]');
    await page.waitForFunction(() => document.querySelector('.sbw-browser-title')?.textContent === 'Voles in the reader');
    await page.screenshot({ path: join(outDir, `browser-reader-${width}.png`) });
    // on the first page ← closes the panel instead of sitting greyed out
    await page.click('.sbw-browser-tool[aria-label="Close"]');
    await open('https://reader.example/first');
    await page.waitForSelector('.sbw-browser-article');
    const firstBack = (await panel()).back;
    await page.click('.sbw-browser-tool[aria-label="Back"]');
    check(`${tag} ← on the first page closes the panel`, firstBack === false && (await panel()).open === false, { firstBack });
    await open('https://frame.example/page');
    await page.waitForSelector('.sbw-browser-frame');
    await page.click('.sbw-browser-text');
    await page.waitForSelector('.sbw-browser-article');

    // a PDF link goes to the PDF reader, with no /web/page round trip
    const before = calls.filter((c) => c.includes('/web/page')).length;
    await page.click('.sbw-browser-article a[href="https://files.example/paper.pdf"]');
    await page.waitForSelector('.sbw-browser .sbw-pdf-pages canvas', { timeout: 8000 });
    s = await panel();
    check(`${tag} a PDF link opens in the PDF reader (D4) without asking /web/page`, s.pdf && calls.filter((c) => c.includes('/web/page')).length === before && calls.some((c) => c.includes('/web/pdf?url=https%3A%2F%2Ffiles.example%2Fpaper.pdf')), { s, calls: calls.slice(-4) });
    await page.screenshot({ path: join(outDir, `browser-pdf-${width}.png`) });

    // a page that cannot open says so, with the way out
    await open('https://nothing.example/closed');
    await page.waitForSelector('.sbw-browser-card');
    s = await panel();
    check(`${tag} a page with nothing to show gets the plain card`, s.card === "This page can't open here" && s.open, s);
    await page.evaluate(() => { window.__opened = []; });
    await page.click('.sbw-browser-card .is-primary');
    check(`${tag} the card's button opens the page in the system browser`, JSON.stringify(await page.evaluate(() => window.__opened)) === JSON.stringify([{ kind: 'url', url: 'https://nothing.example/closed', outside: true }]));

    // a paper link opens the copy the server found, and the bar says where it came from (spec 022)
    await open('https://doi.org/10.1000/voles');
    await page.waitForSelector('.sbw-browser .sbw-pdf-pages canvas', { timeout: 8000 });
    const address = await page.evaluate(() => document.querySelector('.sbw-browser-address')?.textContent ?? '');
    check(`${tag} a DOI opens the open-access PDF, labelled as a preprint`, address === 'Preprint (arXiv) · files.example/paper.pdf', { address });
    // a web PDF is read only: selecting its text offers no highlight colours (they could not be saved)
    await page.waitForSelector('.sbw-browser .textLayer span', { timeout: 8000 });
    await page.evaluate(() => { const span = document.querySelector('.sbw-browser .textLayer span'); const r = document.createRange(); r.selectNodeContents(span); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.waitForTimeout(400);
    const bar = await page.evaluate(() => { const b = document.querySelector('.sbw-browser .sbw-hl-bar'); return !!b && !b.hidden; });
    check(`${tag} selecting text in a web PDF offers no highlight bar`, !bar);
    await page.evaluate(() => getSelection().removeAllRanges());

    // an arXiv paper (2026-10-29): the title once, one font family, the abstract under a small label with its TeX
    // drawn, subject chips and the PDF / Full text buttons in the header; an ordinary page's "$5 and $10" stays text
    await open('https://arxiv.org/abs/2607.25690');
    await page.waitForSelector('.sbw-browser-article .sbw-reader-label');
    const paper = await page.evaluate(() => {
      const article = document.querySelector('.sbw-browser-article');
      const family = (sel) => { const n = article.querySelector(sel); return n ? getComputedStyle(n).fontFamily : null; };
      return {
        titles: (article.textContent.match(/First-Principles Wannier Representation/g) ?? []).length,
        titleFont: family('.sbw-reader-title'), bodyFont: family('.sbw-note-body p'), bylineFont: family('.sbw-reader-authors'),
        label: article.querySelector('.sbw-note-body .sbw-reader-label')?.textContent,
        quotes: article.querySelectorAll('blockquote').length,
        math: article.querySelectorAll('.sbw-note-body .sb-math math').length,
        chips: [...article.querySelectorAll('.sbw-reader-chip')].map((n) => n.textContent),
        links: [...article.querySelectorAll('.sbw-reader-links button')].map((n) => n.textContent),
        meta: article.querySelector('.sbw-reader-venue')?.textContent,
        sideways: document.scrollingElement.scrollWidth > innerWidth,
      };
    });
    check(`${tag} an arXiv paper shows its title once, in the same font family as its text`, paper.titles === 1 && paper.titleFont === paper.bodyFont && paper.bylineFont === paper.bodyFont, paper);
    check(`${tag} the abstract is body text under a small label, its TeX drawn`, paper.label === 'Abstract' && paper.quotes === 0 && paper.math === 1, paper);
    check(`${tag} subjects are chips and PDF / Full text are header buttons`, JSON.stringify(paper.chips) === '["Mesoscale and Nanoscale Physics","Materials Science"]' && JSON.stringify(paper.links) === '["PDF","Full text"]' && paper.meta === 'arXiv:2607.25690v2 · Submitted 28 Jul 2026 · revised 25 Oct 2026' && !paper.sideways, paper);
    await page.screenshot({ path: join(outDir, `browser-arxiv-${width}.png`) });
    await page.click('.sbw-reader-links button:last-child');
    await page.waitForFunction(() => document.querySelector('.sbw-browser-title')?.textContent === 'The other article');
    check(`${tag} "Full text" opens in the panel`, (await panel()).open);
    await open('https://shop.example/tickets');
    await page.waitForFunction(() => document.querySelector('.sbw-browser-title')?.textContent === 'Tickets');
    const shop = await page.evaluate(() => ({ math: document.querySelectorAll('.sbw-browser-article .sb-math').length, text: document.querySelector('.sbw-browser-article .sbw-note-body')?.textContent ?? '' }));
    check(`${tag} prices on an ordinary page stay text`, shop.math === 0 && shop.text.includes('$5 and $10'), shop);

    // the bar: ↗ outside, reload asks again, close and Escape
    await open('https://frame.example/page');
    await page.waitForSelector('.sbw-browser-frame');
    await page.evaluate(() => { window.__opened = []; });
    await page.click('.sbw-browser-tool[aria-label="Open in your browser"]');
    check(`${tag} ↗ in the bar opens the shown page outside`, (await page.evaluate(() => window.__opened))[0]?.url === 'https://frame.example/page');
    const asks = calls.filter((c) => c.includes('/web/page')).length;
    await page.click('.sbw-browser-tool[aria-label="Reload"]');
    await page.waitForTimeout(150);
    check(`${tag} Reload asks the server again`, calls.filter((c) => c.includes('/web/page')).length === asks + 1);
    await page.click('.sbw-browser-tool[aria-label="Close"]');
    check(`${tag} Close shuts the panel`, (await panel()).open === false);
    await open('https://frame.example/page');
    await page.waitForSelector('.sbw-browser-frame');
    await page.keyboard.press('Escape');
    check(`${tag} Escape shuts the panel`, (await panel()).open === false);

    // an outside link never opens the panel; navigating the app closes it
    await page.evaluate(() => { window.__opened = []; });
    await open('https://frame.example/page', { outside: true });
    check(`${tag} a link marked outside bypasses the panel`, (await panel()).open === false && (await page.evaluate(() => window.__opened)).length === 1);
    await open('https://frame.example/page');
    await page.waitForSelector('.sbw-browser-frame');
    await page.evaluate(() => { location.hash = '#/library'; });
    await page.waitForTimeout(150);
    check(`${tag} going to another page of the app closes it`, (await panel()).open === false);
    // links in a rendered note: a click opens the panel, the context menu offers both places, a ⌘-click goes outside
    const noteLink = '.sbw-note-body a[href="https://example.org/voles"]';
    await page.evaluate(() => { location.hash = '#/note/Voles/Winter%20diet.md'; });
    await page.waitForSelector(noteLink);
    await page.click(noteLink);
    await page.waitForSelector('.sbw-browser:not([hidden])');
    check(`${tag} a link in a note opens the panel`, (await panel()).address === 'example.org/voles', await panel());
    await page.click('.sbw-browser-tool[aria-label="Close"]');
    await page.click(noteLink, { button: 'right' });
    const menu = await page.evaluate(() => [...document.querySelectorAll('.sb-link-menu .sb-art-item-label')].map((n) => n.textContent));
    check(`${tag} right-click on a link offers both places`, JSON.stringify(menu) === '["Open in Veritas","Open in your browser"]', menu);
    await page.evaluate(() => { window.__opened = []; });
    await page.click('.sb-link-menu .sb-art-item:last-child');
    check(`${tag} "Open in your browser" goes outside and the menu closes`, (await page.evaluate(() => window.__opened))[0]?.url === 'https://example.org/voles' && (await page.locator('.sb-link-menu').count()) === 0 && (await panel()).open === false);
    await page.click(noteLink, { modifiers: ['Meta'] });
    check(`${tag} a ⌘-click on a link goes outside`, (await page.evaluate(() => window.__opened)).length === 2 && (await panel()).open === false);

    // Home's radar list (2026-10-29, the user: "Back does not work at all"): a paper's title opens the panel on the
    // paper's abstract-only page, ← on that first page closes the panel, and nothing opens it again afterwards (the
    // "viewed" call and the count refresh that follow the click)
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('a.sbw-paper-title[href="https://doi.org/10.1/vole"]');
    await page.click('a.sbw-paper-title[href="https://doi.org/10.1/vole"]');
    await page.waitForSelector('.sbw-browser-article .sbw-reader-title');
    const fromHome = await panel();
    await page.click('.sbw-browser-tool[aria-label="Back"]');
    await page.waitForTimeout(600);
    const afterBack = await page.evaluate(() => ({ open: !document.querySelector('.sbw-browser').hidden, hash: location.hash, home: Boolean(document.querySelector('.sbw-home')) }));
    check(`${tag} Home radar paper → panel → ← closes it and it stays closed on Home`, fromHome.open && fromHome.back === false && !afterBack.open && afterBack.hash === '#/home' && afterBack.home, { fromHome, afterBack });
    // and the same paper a second time (already "viewed"), then Escape-free: ← still closes
    await page.click('a.sbw-paper-title[href="https://doi.org/10.1/vole"]');
    await page.waitForSelector('.sbw-browser-article .sbw-reader-title');
    await page.click('.sbw-browser-tool[aria-label="Back"]');
    await page.waitForTimeout(300);
    check(`${tag} opening the same radar paper again, ← closes it again`, (await panel()).open === false);

    // the landing page of a closed paper (2026-10-29): journal and date, the abstract as paragraphs under its label
    // (sub, italic), no PDF, the publisher's page and the DOI open outside, a citation to copy; the figure only when
    // the figure finder has one (10.1/vole has, 10.1/stoat has not)
    await open('https://doi.org/10.1/stoat');
    await page.waitForSelector('.sbw-browser-article .sbw-reader-foot');
    await page.waitForTimeout(200);
    const landing = () => page.evaluate(() => {
      const article = document.querySelector('.sbw-browser-article');
      return {
        meta: article.querySelector('.sbw-reader-venue')?.textContent,
        label: article.querySelector('.sbw-note-body .sbw-reader-label')?.textContent,
        paragraphs: article.querySelectorAll('.sbw-note-body p').length,
        abstractWord: (article.querySelector('.sbw-note-body').textContent.match(/Abstract/g) ?? []).length,
        sub: article.querySelectorAll('.sbw-note-body sub').length,
        links: [...article.querySelectorAll('.sbw-reader-links button')].map((n) => n.textContent),
        icons: article.querySelectorAll('.sbw-reader-links .sb-p-icon').length,
        doi: article.querySelector('.sbw-reader-doi-line a')?.getAttribute('href'),
        access: article.querySelector('.sbw-reader-access')?.textContent,
        figure: Boolean(article.querySelector('.sbw-reader-figure:not([hidden]) img')),
        mode: !document.querySelector('.sbw-browser-text').hidden,
        fonts: new Set(['.sbw-reader-title', '.sbw-reader-authors', '.sbw-note-body p', '.sbw-reader-foot'].map((sel) => getComputedStyle(article.querySelector(sel)).fontFamily)).size,
        sideways: document.scrollingElement.scrollWidth > innerWidth,
      };
    });
    const stoat = await landing();
    check(`${tag} a closed paper's page: journal · date, paragraphs under one Abstract label, DOI and access note, one font family`, stoat.meta === 'Journal of Mustelid Studies · 28 Oct 2026' && stoat.label === 'Abstract' && stoat.paragraphs === 2 && stoat.abstractWord === 1 && stoat.doi === 'https://doi.org/10.1/stoat' && /^Only the abstract is open here\./.test(stoat.access ?? '') && stoat.fonts === 1 && !stoat.sideways, stoat);
    check(`${tag} its buttons: Publisher's page (outside icon) and Copy citation, no PDF, no figure, no "Original page"`, JSON.stringify(stoat.links) === `["Publisher's page","Copy citation"]` && stoat.icons === 2 && !stoat.figure && !stoat.mode, stoat);
    await page.screenshot({ path: join(outDir, `browser-landing-${width}.png`) });
    await page.evaluate(() => { window.__opened = []; });
    await page.click('.sbw-reader-links button:first-child');
    await page.click('.sbw-reader-doi-line a');
    await page.click('.sbw-reader-access a');
    const outs = await page.evaluate(() => window.__opened);
    check(`${tag} the publisher's page, the DOI and the access note all open doi.org outside, the panel stays`, outs.length === 3 && outs.every((o) => o.outside && o.url === 'https://doi.org/10.1/stoat') && (await panel()).open && (await panel()).address === 'Abstract only · doi.org/10.1/stoat', { outs, p: await panel() });
    await open('https://doi.org/10.1/vole');
    await page.waitForSelector('.sbw-browser-article .sbw-reader-figure:not([hidden]) img', { timeout: 5000 }).catch(() => {});
    const vole = await landing();
    check(`${tag} a paper with a graphical abstract shows it; sub and italic stay in the abstract`, vole.figure && vole.sub === 1 && vole.meta === 'Journal of Vole Ecology · 28 Oct 2026 · 12 (3), 101-118', vole);
    // ← from a paper's page reached from another page goes back to it
    await page.click('.sbw-browser-tool[aria-label="Back"]');
    await page.waitForFunction(() => document.querySelector('.sbw-browser-title')?.textContent === 'Stoat coat colour across a snow gradient');
    check(`${tag} ← from the second paper returns to the first`, (await panel()).open);
    await page.click('.sbw-browser-tool[aria-label="Close"]');
    check(`${tag} no page errors`, errors.length === 0, errors);
    await page.close();
  }
  // Home as a judging screen, and the reader opened from it (2026-11-04): the run line, the pills and their keys, the
  // collection menu, the reader's "For the radar", the server light. Invented papers only.
  const invented = (n) => Array.from({ length: n }, (_, i) => ({
    id: `x${i}`, title: `Vole burrow study number ${i + 1}`, authors: ['A. Vole'], venue: 'Ecology', year: 2026, doi: `10.1/x${i}`, url: `https://example.org/x${i}`, foundBy: ['bioRxiv'], abstract: 'Voles dig.', citations: 1,
    radar: { key: `doi:10.1/x${i}`, score: 0.8, links: [], sources: ['bioRxiv'], date: '2026-11-01', why_line: 'Burrows stay warm.', ...(i === 1 ? { nearBar: true } : {}), why: { similarity: 0.81, author: 0, journal: 0, topic: 1, negative: 0, seed: { label: 'text:s', title: 'Burrows of the northern vole', whole: true } } },
  }));
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
    const tag = `judging ${width}px ${theme}`;
    const shot = (name) => page.screenshot({ path: join(outDir, `judging-${name}-${width}-${theme}.png`), fullPage: false });
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await useFixtures(page);
    await page.goto(`${fakeUrl}&theme=${theme}`);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    // Zotero on, and a long issue; Home paints again on the way back
    await page.evaluate(([rows]) => {
      window.__host.can.addToLibrary = true;
      const [fresh, worth] = window.__store.resultsBy.c4;
      fresh.rows = rows.slice(0, 11).map((r, i) => (i === 0 ? { ...r, fullText: true, pdfUrl: 'https://files.example/paper.pdf' } : i === 3 ? { ...r, doi: '10.1/vole' } : r));
      worth.rows = rows.slice(11).map((r) => ({ ...r, radar: { ...r.radar, nearBar: undefined, why_line: undefined, reason: 'Cited by 3 papers in your library' } }));
      location.hash = '#/settings';
    }, [invented(16)]);
    await page.waitForTimeout(150);
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('.sbw-paper .sb-split');
    await page.evaluate(() => document.fonts.ready);
    const home = await page.evaluate(() => {
      const first = document.querySelector('.sbw-paper');
      return {
        acts: [...first.querySelectorAll('.sb-dg-act')].map((b) => b.textContent), keys: [...first.querySelectorAll('.sb-dg-act')].map((b) => b.dataset.key), current: first.classList.contains('is-current'),
        open: [...first.querySelectorAll('.sbw-paper-open a')].map((a) => a.textContent), lead: first.querySelector('.sbw-paper-open a').classList.contains('is-lead'),
        chips: [...first.querySelectorAll('.sbw-why-chip')].map((c) => c.textContent), chipTag: first.querySelector('.sbw-why-chip').tagName, near: document.querySelectorAll('.sbw-paper')[1].textContent.includes('Just under the bar'),
        judged: document.querySelector('.sbw-papers-judged')?.textContent, more: document.querySelector('.sbw-papers-more')?.textContent,
        worthHead: document.querySelector('h2.sbw-papers-head')?.firstChild.textContent, worthShown: document.querySelector('h2.sbw-papers-head').nextElementSibling.querySelectorAll('.sbw-paper').length, worthMore: document.querySelector('h2.sbw-papers-head').nextElementSibling.querySelector('.sbw-papers-more')?.textContent,
        run: document.querySelector('.sbw-run')?.textContent, sideways: document.scrollingElement.scrollWidth > innerWidth,
        summaryIcon: Boolean(document.querySelector('.sbw-paper-more > summary svg.sb-lucide')),
      };
    });
    check(`${tag} labelled pills with keys, on the first open paper`, JSON.stringify(home.acts) === '["Add to Zotero","Like","Not for me"]' && home.keys.join() === 'a,l,d' && home.current, home);
    check(`${tag} the open row leads with the full text; PDF and Abstract follow, each address once`, home.open.join() === 'Full text,PDF,Abstract' && home.lead, home.open);
    check(`${tag} why chips are display only; a row near the bar says so`, home.chips[0].startsWith('close to') && home.chipTag === 'SPAN' && home.near, home);
    check(`${tag} progress and steps: 8 shown of 11, 3 of 5 Worth reading, an h2`, home.judged === '0 of 11 judged \u00B7 every click teaches the radar' && home.more === 'Show 3 more' && home.worthHead === 'Worth reading' && home.worthShown === 3 && home.worthMore === 'Show 2 more', home);
    check(`${tag} the run line says when the issue came; no sideways scroll`, /Issue built at|Last issue built/.test(home.run) && /next /.test(home.run) && !home.sideways, home);
    check(`${tag} "Read the abstract" has a line icon, no arrow character`, home.summaryIcon, home);
    await shot('home');

    // the collection menu on the split button, then the pick is what Add uses
    await page.locator('.sbw-paper').first().locator('.sb-dg-chev').click();
    await page.waitForSelector('.sb-coll-pop');
    await page.evaluate(() => document.querySelector('.sb-coll-pop').scrollIntoView({ block: 'center' }));
    const menu = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.sb-coll-row .sb-coll-name')].map((r) => r.textContent), box: document.querySelector('.sb-coll-pop').getBoundingClientRect().right <= innerWidth }));
    check(`${tag} the menu lists My Library and the tree, inside the window`, menu.rows.join() === 'My Library,Doorknob Design,Ecology,Foraging,Migration' && menu.box, menu);
    await shot('menu');
    await page.locator('.sb-coll-row', { hasText: 'Foraging' }).click();
    await page.keyboard.press('Escape');

    // the keys: a judges the current paper (with the collection just picked) and moves on, typing in a field does nothing
    const feedback = () => page.evaluate(() => window.__store.feedback ?? []);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('a');
    await page.waitForFunction(() => document.querySelector('.sbw-paper .sb-dg-state')?.textContent.startsWith('Added to Zotero'));
    const added = await page.evaluate(() => ({ state: document.querySelector('.sbw-paper .sb-dg-state').textContent, call: window.__calls.filter((c) => c.kind === 'add-to-library').at(-1), second: document.querySelectorAll('.sbw-paper')[1].classList.contains('is-current'), head: document.querySelector('.sbw-home-date').textContent, judged: document.querySelector('.sbw-papers-judged').textContent }));
    check(`${tag} a adds to the picked collection, says where, and moves on`, added.call.collection === 'foraging' && added.state === 'Added to Zotero \u00B7 Ecology \u203A Foraging' && added.second && /1 judged/.test(added.head) && added.judged.startsWith('1 of 11'), added);
    check(`${tag} a sends one 'added'`, (await feedback()).filter((f) => f.verdict === 'added').length === 1, await feedback());
    await page.keyboard.press('l');
    await page.keyboard.press('d');
    await page.waitForFunction(() => document.querySelectorAll('.sbw-paper')[2].classList.contains('is-dismissed'));
    const collapsed = await page.evaluate(() => { const p = document.querySelectorAll('.sbw-paper')[2]; return { why: getComputedStyle(p.querySelector('.sbw-paper-why')).display, open: getComputedStyle(p.querySelector('.sbw-paper-open')).display, state: p.querySelector('.sb-dg-state').textContent, undo: [...p.querySelectorAll('.sb-dg-act')].map((b) => b.textContent) }; });
    check(`${tag} l likes, d folds the paper to its title and what was decided`, (await feedback()).map((f) => f.verdict).join() === 'added,liked,dismissed' && collapsed.why === 'none' && collapsed.open === 'none' && collapsed.state === 'Not for me: fewer like this' && collapsed.undo.join() === 'Undo', { f: await feedback(), collapsed });
    await page.keyboard.press('k');
    await page.keyboard.press('a');
    await page.waitForTimeout(100);
    check(`${tag} a settled paper is left alone by the keys`, (await feedback()).length === 3, await feedback());
    await page.waitForTimeout(100);
    await page.evaluate(() => document.querySelectorAll('.sbw-paper')[1].scrollIntoView({ block: 'start' }));
    await shot('settled');

    // from an issue, the reader judges the same paper: Like tells the radar once and the row on Home follows
    const row = page.locator('.sbw-paper').nth(3);
    await row.locator('a.sbw-paper-title').click();
    await page.waitForSelector('.sbw-reader-teach');
    const teach = await page.evaluate(() => ({ text: document.querySelector('.sbw-reader-teach').textContent, split: Boolean(document.querySelector('.sbw-reader-links .sb-split .sb-coll')), select: document.querySelectorAll('select.sbw-reader-collection').length }));
    check(`${tag} a paper opened from an issue has "For the radar" and the collection menu, no bare select`, /For the radar:LikeNot for me/.test(teach.text) && teach.split && teach.select === 0, teach);
    await shot('reader');
    const reader = page.locator('.sbw-browser');
    await reader.locator('.sbw-reader-links .sb-split > .sbw-reader-action').click();
    await page.waitForFunction(() => document.querySelector('.sbw-reader-teach .sb-dg-state')?.textContent === 'Added to Zotero');
    const toldOnce = (await feedback()).filter((f) => f.verdict === 'added' && f.key === 'doi:10.1/x3').length;
    check(`${tag} Add to Zotero from an issue sends 'added' once`, toldOnce === 1, await feedback());
    await page.locator('.sbw-browser-tool[aria-label="Close"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.sbw-paper')[3].querySelector('.sb-dg-state')?.textContent.startsWith('Added to Zotero'));
    check(`${tag} the row on Home follows what the reader did`, true);

    // the PDF from Home: read only, so it says what highlights need; judging and Add are in the bars
    await page.locator('.sbw-paper').nth(4).locator('.sbw-paper-open a').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => window.__host.openLink('https://files.example/paper.pdf'));
    await page.waitForFunction(() => /Highlights need the paper in Zotero/.test(document.querySelector('.sbw-pdf-status')?.textContent ?? ''));
    check(`${tag} a web PDF says highlights need the paper in Zotero`, true);
    await page.locator('.sbw-browser-tool[aria-label="Close"]').click();
    await page.locator('.sbw-paper').first().scrollIntoViewIfNeeded();
    await page.locator('.sbw-paper').first().locator('.sbw-paper-open a', { hasText: 'PDF' }).click();
    await page.waitForFunction(() => /Highlights need/.test(document.querySelector('.sbw-pdf-status')?.textContent ?? ''));
    const bars = await page.evaluate(() => ({ teach: Boolean(document.querySelector('.sbw-pdf-bar .sbw-reader-teach')), save: document.querySelector('.sbw-browser-save')?.textContent, title: document.querySelector('.sbw-browser-title').textContent, fits: document.querySelector('.sbw-browser-bar').scrollWidth <= document.querySelector('.sbw-browser-bar').clientWidth }));
    check(`${tag} a PDF opened from an issue keeps Add to Zotero and "For the radar"; the paper already added says so`, bars.teach && bars.save === 'Added to Zotero' && bars.title === 'Vole burrow study number 1' && bars.fits, bars);
    await shot('pdf');
    await page.locator('.sbw-browser-tool[aria-label="Close"]').click();

    // the run line's other two states, each from what the routines list says
    await page.evaluate(() => { window.__store.routines[1].running = true; location.hash = '#/settings'; });
    await page.waitForTimeout(150);
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('.sbw-run.is-running');
    const running = await page.evaluate(() => ({ line: document.querySelector('.sbw-run').textContent, run: document.querySelector('.sbw-today-run').textContent, disabled: document.querySelector('.sbw-today-run').disabled, stop: /Stop/.test(document.querySelector('.sbw-run').textContent) }));
    check(`${tag} a run going: Running, since when, Run now disabled, no Stop (the service has none)`, /^Running \u00B7 seen running since \d\d:\d\d$/.test(running.line) && running.run === 'Running\u2026' && running.disabled && !running.stop, running);
    await page.evaluate(() => document.querySelector('.sbw-view')?.scrollTo?.(0, 0));
    await shot('running');
    await page.evaluate(() => { const r = window.__store.routines[1]; r.running = false; r.lastRun = { at: new Date().toISOString(), slot: null, status: 'failed', reason: 'stopped' }; location.hash = '#/settings'; });
    await page.waitForTimeout(150);
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('.sbw-run.is-failed');
    const failed = await page.evaluate(() => document.querySelector('.sbw-run').textContent);
    check(`${tag} a run that failed says why in plain words, with Run again`, failed === "Today's run did not finish \u00B7 The server stopped during the run.Run again", failed);
    await shot('failed');

    // the server light: a 24 px target, a popover with since when; Try now where it is down
    const up = await page.evaluate(() => { const b = document.querySelector('.sbw-server-button').getBoundingClientRect(); const d = document.querySelector('.sbw-server-dot').getBoundingClientRect(); return { w: b.width, h: b.height, dot: d.width }; });
    check(`${tag} the light's target is 24 px round the 9 px dot`, up.w === 24 && up.h === 24 && up.dot === 9, up);
    await page.click('.sbw-server-button');
    await page.waitForSelector('.sbw-server-pop:not([hidden])');
    check(`${tag} up: the popover says since when, no Try now`, /Answering since \d\d:\d\d/.test(await page.locator('.sbw-server-pop').textContent()) && await page.locator('.sbw-server-try').count() === 0);
    await shot('light-up');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__host._setWhere('offline'));
    await page.click('.sbw-server-button');
    await page.waitForSelector('.sbw-server-try');
    const downText = await page.locator('.sbw-server-pop').textContent();
    check(`${tag} down: says when it last answered, offers Try now`, /The server is not answering/.test(downText) && /Last answered at \d\d:\d\d/.test(downText) && /Try now/.test(downText), downText);
    await shot('light-down');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__host._setWhere('server'));
    check(`${tag} no page errors`, errors.length === 0, errors);
    await page.close();
  }
  return { failures, count };
}
