// ui-src/dev/web-library-checks.mjs. Playwright checks for spec 013 W2 against the built dist-web/ bundle: Library,
// Notes, the paper and note readers, and the shared Related / Links / Duplicates panels. The shell runs on the fake web
// host (dev/harness/web.html) with its server calls answered by dev/web-fixtures.mjs: a 3,500-paper library, notes with
// wiki links and citations, a PDF that is served and one that is 404. Invented content only. Run by dev/run.mjs (SB_ONLY=weblib).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFixtures } from './web-fixtures.mjs';

const dist = fileURLToPath(new URL('../../web/dist-web', import.meta.url));
const WIDTHS = [1280, 700, 360];
const NOTE = '#/note/Voles/Winter%20diet.md';
const ROUTES = [
  ['#/library', '.sbw-lib-row'], ['#/library?collection=COLD', '.sbw-lib-row'], ['#/notes', '.sbw-note-row'], ['#/notes?q=seeds', '.sbw-note-row'],
  ['#/paper/K0001', '.sbw-pdf'], ['#/paper/K0002', '.sbw-pdf-missing'], ['#/paper/K0003', '.sbw-reader-article'],
  [NOTE, '.sbw-note-body a'], ['#/note/Inbox/Lonely.md', '.sbw-note-body'],
];

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runWebLibraryChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} weblib: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const files = readdirSync(dist);
  const js = files.find((f) => /^app-[0-9a-f]{8}\.js$/.test(f));
  const css = files.find((f) => /^app-[0-9a-f]{8}\.css$/.test(f));
  if (!js || !css) { check('the bundle is built (run npm run build:web first)', false, files); return { failures, count }; }
  const origin = `http://127.0.0.1:${port}`;
  const fakeUrl = `${origin}/dev/harness/web.html?js=${encodeURIComponent(`/dist-web/${js}`)}&css=${encodeURIComponent(`/dist-web/${css}`)}`;

  async function open(width, height = 800) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    // a 404 is part of the scenario (a PDF that is not on this Mac, a note that is gone); the checks assert what the page does about it
    page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 404/.test(msg.text())) errors.push(msg.text()); });
    page.errors = errors;
    page.calls = await useFixtures(page);
    await page.goto(fakeUrl);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    return page;
  }
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); };
  const noSideways = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
  const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
  const texts = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.textContent.trim()), selector);

  // ------------------------------------------------------------ every route, three widths, no sideways scroll
  for (const width of WIDTHS) {
    const page = await open(width);
    for (const [hash, ready] of ROUTES) {
      await go(page, hash);
      await page.waitForSelector(ready, { timeout: 6000 }).catch(() => {});
      check(`${width}px ${hash} renders its content`, await page.locator(ready).count() > 0, { hash });
      check(`${width}px ${hash} has no sideways page scroll`, await noSideways(page));
    }
    await go(page, '#/paper/K0001');
    await page.waitForSelector('.sbw-pdf');
    await page.locator('.sbw-reader-toggle').click();
    check(`${width}px the reader's top bar stays on one line`, await page.evaluate(() => document.querySelector('.sbw-reader-bar').getBoundingClientRect().height < 60), width);
    check(`${width}px the paper reader's panel toggle leaves no sideways scroll`, await noSideways(page));
    check(`${width}px the views logged no errors`, page.errors.length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ rail and phone bar
  {
    const page = await open(390);
    const bar = await page.evaluate(() => [...document.querySelectorAll('.sbw-nav-item')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.getAttribute('aria-label')));
    check('390px the phone bar is Home, Chat, Library, Notes and More', JSON.stringify(bar) === '["Home","Chat","Library","Notes","More"]', bar);
    await page.locator('.sbw-more').click();
    const menu = await page.evaluate(() => [...document.querySelectorAll('.sbw-menu-item')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.textContent));
    check('390px More holds the theme switch, Routines, Projects, Sources, Settings and Search index', JSON.stringify(menu) === '["Dark mode","Routines","Projects","Sources","Settings","Search index"]', menu);
    await page.close();
    const wide = await open(1280);
    const rail = await wide.evaluate(() => [...document.querySelectorAll('.sbw-nav-item:not(.sbw-more):not(.sbw-theme)')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.getAttribute('aria-label')));
    check('1280px the rail lists Home, Chat, Library, Notes, Routines and Projects', JSON.stringify(rail) === '["Home","Chat","Library","Notes","Routines","Projects"]', rail);
    await wide.locator('.sbw-more').click();
    const wideMenu = await wide.evaluate(() => [...document.querySelectorAll('.sbw-menu-item')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.textContent));
    check('1280px More holds only Sources, Settings and Search index', JSON.stringify(wideMenu) === '["Sources","Settings","Search index"]', wideMenu);
    await go(wide, `#/note/${encodeURIComponent('Inbox/Gauge $U(1)$ idea.md')}`);
    await wide.waitForSelector('.sbw-reader-article .sbw-table-wrap');
    const reader = await wide.evaluate(() => ({
      inline: [...document.querySelectorAll('.sbw-reader-article p .sb-math math')].length,
      display: [...document.querySelectorAll('.sbw-reader-article > * .sb-math-block math, .sbw-reader-article .sb-math-block math')].length,
      emphasis: document.querySelectorAll('.sbw-reader-article em').length,
      raw: /\$|SBMATH/.test(document.querySelector('.sbw-reader-article').textContent),
      font: getComputedStyle(document.querySelector('.sb-math math')).fontFamily,
      grips: document.querySelectorAll('.sbw-table-wrap th .sbw-col-grip').length,
    }));
    check('the note reader draws $…$ and $$…$$ as MathML in a maths font, with no raw TeX and no stray emphasis from a_i b_i', reader.inline === 2 && reader.display === 1 && reader.emphasis === 0 && !reader.raw && /STIX Two Math/.test(reader.font), reader);
    const grip = wide.locator('.sbw-table-wrap th').first().locator('.sbw-col-grip');
    const th = wide.locator('.sbw-table-wrap th').first();
    const before = (await th.boundingBox()).width;
    const g = await grip.boundingBox();
    await wide.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await wide.mouse.down();
    await wide.mouse.move(g.x + g.width / 2 + 120, g.y + g.height / 2, { steps: 6 });
    await wide.mouse.up();
    const after = (await th.boundingBox()).width;
    await grip.dblclick();
    const reset = (await th.boundingBox()).width;
    check('a note table column stretches by dragging its header edge, and double-click gives its width back', (after - before) >= 100 && Math.abs(reset - before) <= 2, { before, after, reset });
    await go(wide, '#/paper/K0001');
    await go(wide, '#/note/Inbox/Lonely.md');
    await wide.waitForSelector('.sbw-reader-article');
    const active = await wide.evaluate(() => document.querySelector('.sbw-nav-item.is-active')?.dataset.view);
    check('a note marks Notes in the rail and a paper marks Library', active === 'notes', active);
    await go(wide, '#/paper/K0001');
    await wide.waitForSelector('.sbw-pdf');
    check('a paper marks Library in the rail', await wide.evaluate(() => document.querySelector('.sbw-nav-item.is-active')?.dataset.view) === 'library');
    await wide.close();
  }

  // ------------------------------------------------------------ library: first render time
  const timings = [];
  let warm = null;
  for (let run = 0; run < 3; run++) {
    const page = await open(1280);
    await page.evaluate(() => { performance.mark('t0'); location.hash = '#/library'; });
    await page.waitForSelector('.sbw-lib-row');
    timings.push(await page.evaluate(() => {
      const [t0] = performance.getEntriesByName('t0');
      const [rows] = performance.getEntriesByName('sbw-library-first-rows');
      return Math.round(rows.startTime - t0.startTime);
    }));
    if (run === 2) {
      // a reload paints from the copy this browser kept while the server's 4 MB reply is still on its way
      await page.route('**/zotero/items*', (route) => setTimeout(() => route.fallback(), 1500));
      await page.reload();
      await page.waitForSelector('.sbw-lib-row');
      warm = await page.evaluate(() => Math.round(performance.getEntriesByName('sbw-library-first-rows')[0].startTime));
    }
    await page.close();
  }
  console.log(`  library first render (3,500 papers, 4 MB reply, 1280 px): ${timings.join(', ')} ms; on a reload with the server held back 1.5 s: ${warm} ms from page start`);
  check('the library draws its first rows in under 300 ms (3,500 papers, median of 3)', [...timings].sort((a, b) => a - b)[1] < 300, timings);
  check('a reload shows the stored library before the server answers (under 300 ms from page start, server held back 1.5 s)', warm !== null && warm < 300, warm);

  // ------------------------------------------------------------ library: tree, table, sort, search, ticks
  {
    const page = await open(1280);
    await go(page, '#/library');
    await page.waitForSelector('.sbw-lib-row');
    await page.waitForSelector('.sbw-tree-row');
    const state = await page.evaluate(() => ({
      domRows: document.querySelectorAll('.sbw-lib-row').length,
      status: document.querySelector('.sbw-lib-status').textContent,
      tree: document.querySelector('.sbw-lib-tree').getBoundingClientRect().width,
      head: document.querySelector('.sbw-tree-head').textContent,
      roots: [...document.querySelectorAll('.sbw-tree-row .sbw-tree-name')].map((n) => n.textContent),
      physics: [...document.querySelectorAll('.sbw-tree-row')].find((r) => r.textContent.includes('Physics'))?.querySelector('.sbw-tree-count').textContent,
      rowH: document.querySelector('.sbw-lib-row').getBoundingClientRect().height,
      years: [...document.querySelectorAll('.sbw-lib-row .sbw-lib-year')].slice(0, 6).map((n) => n.textContent),
      cols: getComputedStyle(document.querySelector('.sbw-lib-cols')).display,
      venue: getComputedStyle(document.querySelector('.sbw-lib-venue')).display,
    }));
    check('the table draws only the rows in view (virtualized) and says how many papers there are', state.domRows > 8 && state.domRows < 40 && state.status === '3,500 papers', state);
    check('the tree is 224 px wide with a COLLECTIONS header, All papers and counts', Math.round(state.tree) === 224 && state.head === 'Collections' && state.roots[0] === 'All papers' && state.physics === '500', state);
    check('rows are 56 px; the wide table shows column headers and a venue column', state.rowH === 56 && state.cols === 'grid' && state.venue === 'block', state);
    check('rows start newest first', state.years.every((y, i) => i === 0 || y <= state.years[i - 1] || y === ''), state.years);

    // sort by title and back
    await page.locator('.sbw-lib-sortbtn', { hasText: 'Title' }).click();
    const titles = await texts(page, '.sbw-lib-row .sbw-lib-link');
    check('sorting by title puts A to Z', titles.slice(0, 8).every((t, i) => i === 0 || titles[i - 1].localeCompare(t, undefined, { sensitivity: 'base', numeric: true }) <= 0), titles.slice(0, 8));

    // scrolling draws later rows
    await page.evaluate(() => { const s = document.querySelector('.sbw-lib-scroll'); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(100);
    const last = await page.evaluate(() => ({ n: document.querySelectorAll('.sbw-lib-row').length, lastTransform: [...document.querySelectorAll('.sbw-lib-row')].pop().style.transform }));
    check('scrolling to the end draws the last rows and still few rows', last.n < 40 && last.lastTransform.includes(`${3499 * 56}px`), last);
    await page.evaluate(() => { document.querySelector('.sbw-lib-scroll').scrollTop = 0; });

    // search
    await page.fill('.sbw-lib-search', 'doorknob');
    await page.waitForFunction(() => document.querySelector('.sbw-lib-status').textContent.includes('“doorknob”'));
    const found = await page.evaluate(() => ({ status: document.querySelector('.sbw-lib-status').textContent, titles: [...document.querySelectorAll('.sbw-lib-link')].map((n) => n.textContent) }));
    check('searching lists matching papers with the count', found.titles.includes('Doorknob ergonomics') && /^\d+\+? papers? for “doorknob”$/.test(found.status), found);
    // LaTeX in a title draws as MathML; the raw title stays in the tooltip, and a dollar amount stays text
    await page.fill('.sbw-lib-search', 'gauge-equivariant');
    await page.waitForSelector('.sbw-lib-link math');
    const tex = await page.evaluate(() => { const a = document.querySelector('.sbw-lib-link'); return { math: a.querySelectorAll('math').length, shown: a.textContent, raw: a.title, tag: a.querySelector('math')?.namespaceURI }; });
    check('a title with $U(1)$ draws a <math> element in its library row and keeps the raw title in the tooltip', tex.math === 1 && !tex.shown.includes('$') && tex.raw === 'Gauge-equivariant $U(1)$ flows' && tex.tag === 'http://www.w3.org/1998/Math/MathML', tex);
    await page.fill('.sbw-lib-search', '$5 sensor');
    await page.waitForFunction(() => document.querySelector('.sbw-lib-link')?.title.startsWith('A $5'));
    const money = await page.evaluate(() => { const a = document.querySelector('.sbw-lib-link'); return { math: a.querySelectorAll('math').length, shown: a.textContent }; });
    check('a title with a dollar amount stays text', money.math === 0 && money.shown === 'A $5 sensor for vole burrows', money);
    await page.fill('.sbw-lib-search', 'zzzz-nothing');
    await page.waitForFunction(() => document.querySelector('.sbw-lib-status').textContent.includes('No papers match'));
    check('a search with no match says so', true);
    await page.fill('.sbw-lib-search', '');
    await page.waitForFunction(() => document.querySelector('.sbw-lib-status').textContent === '3,500 papers');
    check('clearing the search brings the whole library back', true);

    // a collection from the tree, with its sub-collections
    await page.locator('.sbw-tree-row', { hasText: 'Physics' }).locator('.sbw-tree-twist').click();
    check('the twist opens a collection to show its children', (await texts(page, '.sbw-tree-name')).includes('Condensed matter'));
    await page.locator('.sbw-tree-row', { hasText: 'Condensed matter' }).click();
    await page.waitForFunction(() => location.hash === '#/library?collection=COLC' && document.querySelector('.sbw-lib-status').textContent === '250 papers');
    const col = await page.evaluate(() => ({ status: document.querySelector('.sbw-lib-status').textContent, crumb: document.querySelector('.sbw-lib-crumb').textContent, selected: document.querySelector('.sbw-tree-row.is-selected .sbw-tree-name').textContent }));
    check('choosing a collection shows its papers (children included) and marks it', col.status === '250 papers' && col.crumb === ' / Condensed matter' && col.selected === 'Condensed matter', col);

    // row click opens the paper
    await page.locator('.sbw-lib-row').first().click({ position: { x: 300, y: 28 } });
    await page.waitForFunction(() => location.hash.startsWith('#/paper/'));
    check('clicking a row opens the paper reader', true);
    await page.goBack();
    await page.waitForSelector('.sbw-lib-row');
    check('Back returns to the same collection', (await page.evaluate(() => location.hash)) === '#/library?collection=COLC');

    // tick two rows: one filled "Ask about 2", which opens Chat with two chips
    await page.locator('.sbw-lib-row').nth(0).hover();
    await page.locator('.sbw-lib-row').nth(0).locator('.sbw-chk input').check();
    check('ticking a row raises "Ask about 1"', (await text(page, '.sbw-lib-ask')) === 'Ask about 1');
    await page.locator('.sbw-lib-row').nth(1).locator('.sbw-chk input').check();
    const ask = await page.evaluate(() => {
      const b = document.querySelector('.sbw-lib-ask');
      return { label: b.textContent, hidden: b.hidden, primary: b.classList.contains('is-primary'), bg: getComputedStyle(b).backgroundColor, filled: document.querySelectorAll('.sbw-lib .sb-button.is-primary').length,
        accent: (() => { const p = document.createElement('i'); p.style.color = 'var(--sb-ui-accent)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })() };
    });
    check('"Ask about 2" is the one filled button in the library', ask.label === 'Ask about 2' && !ask.hidden && ask.primary && ask.bg === ask.accent && ask.filled === 1, ask);
    await page.screenshot({ path: join(outDir, 'web-library-1280.png') });
    await page.locator('.sbw-lib-ask').click();
    await page.waitForFunction(() => location.hash === '#/chat');
    await page.waitForSelector('.sb-ai-context');
    // the chat folds papers selected in a library into one "N selected papers" chip whose tooltip names them
    const chips = await page.evaluate(() => [...document.querySelectorAll('.sb-ai-context')].map((c) => [c.querySelector('.sb-ai-context-title').textContent, c.title.split('\n').length]));
    check('Ask about 2 opens Chat with those two papers as context (one "2 selected papers" chip naming both)', JSON.stringify(chips) === '[["2 selected papers",2]]', chips);
    await go(page, '#/library?collection=COLC');
    await page.waitForSelector('.sbw-lib-row');
    check('coming back to the library keeps the ticks', (await text(page, '.sbw-lib-ask')) === 'Ask about 2');
    await page.locator('.sbw-lib-clear').click();
    check('Clear unticks everything and hides the action', await page.locator('.sbw-lib-ask').isHidden());
    check('the library logged no errors', page.errors.length === 0, page.errors);
    await page.close();
  }

  // ------------------------------------------------------------ library on a phone
  {
    const page = await open(360, 740);
    await go(page, '#/library');
    await page.waitForSelector('.sbw-lib-row');
    const phone = await page.evaluate(() => ({
      tree: getComputedStyle(document.querySelector('.sbw-lib-tree')).display,
      toggle: getComputedStyle(document.querySelector('.sbw-lib-collections')).display,
      cols: getComputedStyle(document.querySelector('.sbw-lib-cols')).display,
      sub: getComputedStyle(document.querySelector('.sbw-lib-sub')).display,
      rowH: document.querySelector('.sbw-lib-row').getBoundingClientRect().height,
    }));
    check('360px the tree hides behind a Collections button and rows show a meta line', phone.tree === 'none' && phone.toggle !== 'none' && phone.cols === 'none' && phone.sub !== 'none' && phone.rowH === 56, phone);
    await page.locator('.sbw-lib-collections').click();
    check('360px the Collections button opens the tree', (await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-lib-tree')).display)) === 'block');
    await page.locator('.sbw-tree-row', { hasText: 'Biology' }).click();
    await page.waitForFunction(() => location.hash === '#/library?collection=COLB');
    check('360px choosing a collection closes the tree', (await page.evaluate(() => getComputedStyle(document.querySelector('.sbw-lib-tree')).display)) === 'none');
    await page.screenshot({ path: join(outDir, 'web-library-360.png') });
    await page.close();
  }

  // ------------------------------------------------------------ notes
  {
    const page = await open(1280);
    await go(page, '#/notes');
    await page.waitForSelector('.sbw-note-row');
    const recent = await texts(page, '.sbw-note-row .sbw-card-title');
    check('Notes lists recent notes and leaves papers out', recent.length === 5 && recent.includes('Winter diet') && !recent.includes('Foraging strategies of voles'), recent);
    check('a note title with $U(1)$ draws as math in its row', await page.evaluate(() => [...document.querySelectorAll('.sbw-note-row')].some((r) => r.querySelectorAll('.sbw-card-title math').length === 1 && r.getAttribute('href').includes('Gauge'))));
    await page.fill('.sbw-notes-search', 'seeds');
    await page.waitForFunction(() => document.querySelector('.sbw-notes .sbw-h2').textContent === 'Results');
    await page.waitForSelector('.sbw-note-row');
    const results = await texts(page, '.sbw-note-row .sbw-card-title');
    check('searching Notes lists matching notes', results.includes('Seeds') && results.includes('Winter diet'), results);
    await page.fill('.sbw-notes-search', 'zzzz-nothing');
    await page.waitForFunction(() => document.querySelector('.sbw-notes .sbw-hint').textContent.includes('No notes match'));
    check('a note search with no match says so', true);
    await page.fill('.sbw-notes-search', 'seeds');
    await page.locator('.sbw-note-row[href="#/note/Voles/Seeds.md"]').click();
    await page.waitForFunction(() => location.hash === '#/note/Voles/Seeds.md');
    await page.waitForSelector('.sbw-reader-title');
    check('a note row opens the note reader', (await text(page, '.sbw-reader-title')) === 'Seeds');
    await page.close();
  }

  // ------------------------------------------------------------ the paper reader
  {
    const page = await open(1280);
    await go(page, '#/paper/K0001');
    await page.waitForSelector('.sbw-pdf');
    await page.waitForSelector('.sbw-reader .sb-p-section-label');
    await page.waitForFunction(() => document.querySelectorAll('.sbw-reader-panel .sb-p-row').length > 0);
    const geo = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const abstract = document.querySelector('#sbw-sec-abstract p');
      // characters on the second line of the abstract (a full line)
      const node = abstract.firstChild;
      const range = document.createRange();
      const tops = [];
      for (let i = 0; i < node.length; i++) { range.setStart(node, i); range.setEnd(node, i + 1); tops.push(Math.round(range.getBoundingClientRect().top)); }
      const lines = [...new Set(tops)];
      const perLine = lines.map((t) => tops.filter((x) => x === t).length);
      return { rail: box('.sbw-rail').width, toc: box('.sbw-reader-toc').width, panel: box('.sbw-reader-panel').width, article: box('.sbw-reader-article').width, lineChars: perLine.slice(0, 4), font: getComputedStyle(abstract).fontFamily, size: getComputedStyle(abstract).fontSize,
        title: document.querySelector('.sbw-reader-title').textContent, authors: document.querySelector('.sbw-reader-authors').textContent, venue: document.querySelector('.sbw-reader-venue').textContent,
        doi: document.querySelector('.sbw-reader-doi').getAttribute('href'), toc_items: [...document.querySelectorAll('.sbw-toc-item')].map((n) => n.textContent) };
    });
    check('the reader is three columns: contents 200, article, panel 320, beside the 56 px rail', Math.round(geo.toc) === 200 && Math.round(geo.panel) === 320 && geo.article > 600 && Math.round(geo.rail) === 56, geo);
    check('the abstract runs 66 to 70 characters a line (serif, measured)', geo.lineChars.slice(1, 3).every((n) => n >= 62 && n <= 74), geo.lineChars);
    check('the header shows the title, authors, year and venue, and a DOI link', geo.title === 'Foraging strategies of voles' && geo.authors.includes('Ann Chen') && geo.venue.includes('1995') && geo.doi === 'https://doi.org/10.1000/invented.0', geo);
    check('the contents list Abstract, PDF, Highlights and Notes', JSON.stringify(geo.toc_items) === JSON.stringify(['Abstract', 'PDF', 'Highlights2', 'Notes1']), geo.toc_items);

    await page.waitForFunction(() => document.querySelectorAll('.sbw-pdf-page.is-drawn .textLayer span').length >= 1, null, { timeout: 8000 }).catch(() => {});
    const pdf = await page.evaluate(() => ({
      pages: document.querySelectorAll('.sbw-pdf-page').length, iframes: document.querySelectorAll('iframe').length,
      text: document.querySelector('.sbw-pdf-page[data-page-index="0"] .textLayer')?.textContent ?? '',
      open: document.querySelector('.sbw-pdf-open')?.getAttribute('href'), missing: Boolean(document.querySelector('.sbw-pdf-missing')),
    }));
    check('a PDF that resolves is drawn by PDF.js, page by page, with a text layer (no iframe)', pdf.pages === 2 && pdf.iframes === 0 && pdf.text.includes('Voles cache seeds in autumn.') && !pdf.missing, pdf);
    check('Open PDF links to the raw file', /\/zotero\/pdf\?key=ATTOK001$/.test(pdf.open ?? ''), pdf.open);
    await page.locator('.sbw-pdf-page[data-page-index="1"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.sbw-pdf-page[data-page-index="1"] .sbw-pdf-mark'), null, { timeout: 8000 }).catch(() => {});
    const marks = await page.evaluate(() => {
      const of = (index) => [...document.querySelectorAll(`.sbw-pdf-page[data-page-index="${index}"] .sbw-pdf-mark`)].map((m) => ({
        waiting: m.classList.contains('is-waiting'), title: m.title, color: m.style.getPropertyValue('--sbw-mark'),
        box: (({ left, top, width, height }) => ({ left, top, width, height }))(m.getBoundingClientRect()),
      }));
      const span = document.querySelector('.sbw-pdf-page[data-page-index="0"] .textLayer span')?.getBoundingClientRect();
      return { first: of(0), second: of(1), span: span && { left: span.left, top: span.top, height: span.height }, status: document.querySelector('.sbw-pdf-status')?.textContent };
    });
    const [saved] = marks.first;
    check("a highlight already in Zotero is drawn on its page, over its text, in its colour", marks.first.length === 1 && !saved.waiting && saved.color === '#ffd400'
      && Math.abs(saved.box.left - marks.span.left) < 4 && saved.box.top < marks.span.top + marks.span.height && saved.box.top + saved.box.height > marks.span.top, marks);
    check('a highlight still queued for Zotero is drawn on its page and says "Waiting for Zotero"', marks.second.length === 1 && marks.second[0].waiting && marks.second[0].title === 'Waiting for Zotero' && marks.status === '1 highlight waiting for Zotero', marks);

    await page.locator('.sbw-pdf-page[data-page-index="0"]').scrollIntoViewIfNeeded();
    const span = await page.locator('.sbw-pdf-page[data-page-index="0"] .textLayer span').first().boundingBox();
    await page.mouse.move(span.x + 1, span.y + span.height / 2);
    await page.mouse.down();
    await page.mouse.move(span.x + span.width - 1, span.y + span.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.sbw-hl-bar:not([hidden])', { timeout: 3000 }).catch(() => {});
    const bar = await page.evaluate(() => ({
      shown: !document.querySelector('.sbw-hl-bar').hidden, colors: [...document.querySelectorAll('.sbw-hl-swatch')].map((b) => b.dataset.color),
      labels: [...document.querySelectorAll('.sbw-hl-swatch')].map((b) => b.getAttribute('aria-label')),
    }));
    check("selecting text opens a bar with Zotero's eight colours", bar.shown && JSON.stringify(bar.colors) === JSON.stringify(['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa']) && bar.labels[2] === 'Highlight in green', bar);
    await page.locator('.sbw-hl-comment').fill('Compare with the field data');
    const posted = page.waitForRequest((r) => r.url().endsWith('/zotero/annotate') && r.method() === 'POST', { timeout: 3000 }).catch(() => null);
    await page.locator('.sbw-hl-swatch[data-color="#5fb236"]').click();
    const request = await posted;
    const sent = request ? JSON.parse(request.postData() ?? '{}') : {};
    const a = sent.annotation ?? {};
    const [rect] = a.position?.rects ?? [];
    check('picking a colour POSTs /zotero/annotate with the attachment key and a Zotero highlight', sent.key === 'ATTOK001' && a.type === 'highlight' && a.color === '#5fb236'
      && a.text === 'Voles cache seeds in autumn.' && a.comment === 'Compare with the field data' && a.pageLabel === '1', sent);
    // the fixture's text: Helvetica 14 pt from x 20 at baseline y 150 on a 300 x 200 pt page, so the line's box spans about y 147..163
    check('the highlight is one rect in PDF points around the line, bottom-left origin, with its sort index', a.position?.pageIndex === 0 && a.position.rects.length === 1
      && Math.abs(rect[0] - 20) < 3 && rect[2] > 180 && rect[2] < 215 && rect[1] > 140 && rect[1] < 152 && rect[3] > 157 && rect[3] < 170
      && /^00000\|00000\d\|000[3-4]\d$/.test(a.sortIndex), a);
    await page.waitForFunction(() => document.querySelectorAll('.sbw-pdf-page[data-page-index="0"] .sbw-pdf-mark').length === 2, null, { timeout: 3000 }).catch(() => {});
    const drawn = await page.evaluate(() => ({
      marks: [...document.querySelectorAll('.sbw-pdf-page[data-page-index="0"] .sbw-pdf-mark')].map((m) => [m.style.getPropertyValue('--sbw-mark'), m.classList.contains('is-waiting')]),
      bar: document.querySelector('.sbw-hl-bar').hidden, selection: String(getSelection()), status: document.querySelector('.sbw-pdf-status')?.textContent,
    }));
    check('the new highlight is drawn at once, waiting for Zotero (queued), and the bar closes', JSON.stringify(drawn.marks) === '[["#ffd400",false],["#5fb236",true]]' && drawn.bar && drawn.selection === '' && drawn.status === '2 highlights waiting for Zotero', drawn);
    await page.screenshot({ path: join(outDir, 'web-paper-highlight-1280.png') });
    const hl = await texts(page, '.sbw-highlights .sb-p-highlight-text');
    check('highlights list the quoted text', hl.length === 2 && hl[0].startsWith('Voles cache seeds'), hl);
    check('notes are rendered', (await text(page, '#sbw-sec-notes .sbw-note-body')).includes('Voles cache seeds'));
    const panel = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('.sbw-reader-panel .sbw-panel-h')].map((n) => n.textContent),
      facts: [...document.querySelectorAll('.sbw-facts dt')].map((n) => n.textContent),
      inner: [...document.querySelectorAll('.sbw-reader-panel .sb-p-related .sb-p-section-label')].map((n) => n.textContent),
      rows: [...document.querySelectorAll('.sbw-reader-panel .sb-p-related .sb-p-row-text')].map((n) => n.textContent),
      meta: [...document.querySelectorAll('.sbw-reader-panel .sb-p-related .sb-p-row-meta')].map((n) => n.textContent),
      links: [...document.querySelectorAll('.sbw-reader-panel .sb-p-links .sb-p-state')].map((n) => n.textContent),
    }));
    check('the panel has Info, Related and Links', JSON.stringify(panel.sections) === '["Info","Related","Links"]', panel.sections);
    check('Info lists type, date, volume, citekey and link', JSON.stringify(panel.facts) === '["Type","Date","Volume","Cite as","Link"]', panel.facts);
    check('Related shows Similar and Shared tags with bylines (no Linked section next to Links)', JSON.stringify(panel.inner) === '["Similar","Shared tags"]' && panel.rows.includes('Habitat') && panel.meta.some((m) => m.includes('et al.') || m.includes('Ruiz')), panel);
    check('Links shows its empty states', panel.links.includes('This note links to nothing yet.') && panel.links.includes('No note links here.'), panel.links);
    await page.screenshot({ path: join(outDir, 'web-paper-1280.png') });
    const zotero = await page.evaluate(() => [...document.querySelectorAll('.sbw-reader-bar a')].map((a) => a.getAttribute('href')));
    check('Open in Zotero links to zotero://select', zotero.includes('zotero://select/library/items/K0001'), zotero);

    // a related paper opens in the app
    await page.locator('.sbw-reader-panel .sb-p-related .sb-p-row', { hasText: 'study 3' }).first().click().catch(() => {});
    await page.waitForFunction(() => location.hash === '#/paper/K0004', null, { timeout: 3000 }).catch(() => {});
    check('a related paper opens its reader', (await page.evaluate(() => location.hash)) === '#/paper/K0004');

    // Ask about this
    await go(page, '#/paper/K0001');
    await page.waitForSelector('.sbw-pdf');
    await page.locator('.sbw-reader-bar .sb-button.is-primary').click();
    await page.waitForFunction(() => location.hash === '#/chat');
    await page.waitForSelector('.sb-ai-context');
    check('"Ask about this" opens Chat with the paper as a context chip', (await texts(page, '.sb-ai-context')).length === 1);
    await page.close();
  }
  {
    const page = await open(1280);
    await go(page, '#/paper/K0002');
    await page.waitForSelector('.sbw-pdf-missing');
    const missing = await page.evaluate(() => ({
      text: document.querySelector('.sbw-pdf-missing').textContent, iframe: document.querySelectorAll('.sbw-pdf').length,
      open: document.querySelector('.sbw-pdf-missing a').getAttribute('href'), label: document.querySelector('.sbw-pdf-missing a').textContent,
    }));
    check('a PDF that is 404 shows the server\'s message and Open in Zotero', missing.text.includes('no PDF file for this attachment') && missing.iframe === 0 && missing.label === 'Open in Zotero' && missing.open === 'zotero://open-pdf/library/items/ATTK0002', missing);
    await page.screenshot({ path: join(outDir, 'web-paper-missing-pdf-1280.png') });
    await go(page, '#/paper/K0021');
    await page.waitForSelector('.sbw-reader-title math');
    const head = await page.evaluate(() => ({ math: document.querySelectorAll('.sbw-reader-title math').length, text: document.querySelector('.sbw-reader-title').textContent, tab: document.title }));
    check('the reader header draws $U(1)$ as math while the tab title keeps the raw text', head.math === 1 && !head.text.includes('$') && head.tab.startsWith('Gauge-equivariant $U(1)$ flows'), head);
    await go(page, '#/paper/K0003');
    await page.waitForSelector('#sbw-sec-pdf .sb-button');
    check('a paper with no PDF and no abstract says so', (await text(page, '#sbw-sec-pdf')).includes('No PDF is attached') && (await text(page, '#sbw-sec-abstract')).includes('no abstract'));
    await go(page, '#/paper/K0022');
    await page.waitForSelector('.sbw-reader-title');
    await page.waitForFunction(() => document.querySelector('.sbw-reader-title').textContent.startsWith('A $5'));
    check('the reader header leaves a dollar amount as text', await page.evaluate(() => document.querySelectorAll('.sbw-reader-title math').length) === 0);
    await go(page, '#/paper/NOPE');
    await page.waitForFunction(() => document.querySelector('.sbw-reader-status')?.textContent.includes("isn't in your library"));
    check('an unknown paper says it is not in the library', true);
    await page.close();
  }
  // the panel and contents collapse below 960
  {
    const page = await open(700);
    await go(page, '#/paper/K0001');
    await page.waitForSelector('.sbw-pdf');
    const narrow = await page.evaluate(() => ({ toc: getComputedStyle(document.querySelector('.sbw-reader-toc')).display, panel: getComputedStyle(document.querySelector('.sbw-reader-panel')).display, open: document.querySelector('.sbw-reader').classList.contains('is-panel-open') }));
    check('700px the reader shows the article only; the panel is behind the toggle', narrow.toc === 'none' && narrow.panel === 'none' && !narrow.open, narrow);
    await page.locator('.sbw-reader-toggle').click();
    const shown = await page.evaluate(() => ({ panel: getComputedStyle(document.querySelector('.sbw-reader-panel')).display, w: document.querySelector('.sbw-reader-panel').getBoundingClientRect().width }));
    check('700px the toggle opens the panel over the article', shown.panel === 'block' && shown.w > 280, shown);
    await page.close();
  }
  {
    const page = await open(360);
    await go(page, '#/paper/K0001');
    await page.waitForSelector('.sbw-pdf-page');
    check('360px a page far below the screen is not drawn yet', await page.evaluate(() => !document.querySelector('.sbw-pdf-page.is-drawn')));
    await page.locator('.sbw-pdf-page').first().scrollIntoViewIfNeeded();
    await page.waitForSelector('.sbw-pdf-page.is-drawn', { timeout: 8000 }).catch(() => {});
    const fit = await page.evaluate(() => ({ page: document.querySelector('.sbw-pdf-page')?.getBoundingClientRect().width, drawn: Boolean(document.querySelector('.sbw-pdf-page.is-drawn')), width: innerWidth }));
    check('360px the PDF pages are drawn to the column width', fit.drawn && fit.page > 250 && fit.page <= fit.width, fit);
    check('360px the PDF leaves no sideways scroll', await noSideways(page));
    await page.close();
  }

  // ------------------------------------------------------------ the note reader
  {
    const page = await open(1280);
    await go(page, NOTE);
    await page.waitForSelector('.sbw-note-body a');
    await page.waitForFunction(() => document.querySelectorAll('.sbw-reader-panel .sb-p-links .sb-p-row').length > 0);
    const read = await page.evaluate(() => ({
      title: document.querySelector('.sbw-reader-title').textContent,
      body: [...document.querySelectorAll('.sbw-note-body a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
      missing: [...document.querySelectorAll('.sbw-note-body .wikilink.is-missing')].map((n) => n.textContent),
      h1s: document.querySelectorAll('.sbw-note-body h1').length,
      toc: [...document.querySelectorAll('.sbw-toc-item')].map((n) => n.textContent),
      bar: [...document.querySelectorAll('.sbw-reader-bar a')].map((a) => a.getAttribute('href')),
      linksTo: [...document.querySelectorAll('.sbw-reader-panel .sb-p-links .sb-p-section')].map((s) => [s.querySelector('.sb-p-section-label').textContent, s.querySelector('.sb-p-count')?.textContent, [...s.querySelectorAll('.sb-p-row-text, .sb-p-meta')].map((n) => n.textContent)]),
    }));
    check('a note\'s wiki links point at in-app notes, aliases keep their label, the citation points at the paper, web links keep their address and open through the host (no target)',
      JSON.stringify(read.body) === JSON.stringify([['Seeds', '#/note/Voles/Seeds.md', null], ['Chen et al. 1995', '#/paper/K0001', null], ['the habitat', '#/note/Voles/Habitat.md', null], ['A site', 'https://example.org/voles', null]]), read.body);
    check('a link to a note that does not exist stays plain text', JSON.stringify(read.missing) === '["Ghost"]', read.missing);
    check('the note\'s own title is shown once, and its headings fill the contents', read.title === 'Winter diet' && read.h1s === 0 && JSON.stringify(read.toc) === '["Sources"]', read);
    check('Open in Obsidian links to the vault file', read.bar.includes('obsidian://open?vault=Second-Brain&file=Voles%2FWinter%20diet'), read.bar);
    check('Links lists what the note links to, what links here, and the note with no page yet', read.linksTo.some(([l, n]) => l === 'Links to' && n === '3') && read.linksTo.some(([l, n]) => l === 'Linked from' && n === '1') && read.linksTo.some(([l]) => l === 'No note yet'), read.linksTo);
    await page.screenshot({ path: join(outDir, 'web-note-1280.png') });
    await page.locator('.sbw-note-body a', { hasText: 'Seeds' }).click();
    await page.waitForFunction(() => location.hash === '#/note/Voles/Seeds.md');
    await page.waitForFunction(() => document.querySelector('.sbw-reader-title')?.textContent === 'Seeds');
    check('clicking a wiki link opens that note inside the app', true);
    await page.goBack();
    await page.waitForSelector('.sbw-note-body a');
    await page.locator('.sbw-note-body a.sbw-cite').click();
    await page.waitForFunction(() => location.hash === '#/paper/K0001');
    check('clicking a citation opens the paper inside the app', true);
    await go(page, NOTE);
    await page.waitForSelector('.sbw-note-body a');
    await page.locator('.sbw-reader-bar .sb-button.is-primary').click();
    await page.waitForFunction(() => location.hash === '#/chat');
    await page.waitForSelector('.sb-ai-context');
    check('"Ask about this" on a note opens Chat with the note as context', (await texts(page, '.sb-ai-context')).length === 1);
    await go(page, '#/note/Inbox/Missing.md');
    await page.waitForFunction(() => document.querySelector('.sbw-reader-status')?.textContent.includes("isn't in the vault"));
    check('a note that is gone says so', true);
    await go(page, '#/note/Inbox/Lonely.md');
    await page.waitForSelector('.sbw-reader-panel .sb-p-related .sb-p-state');
    await page.waitForFunction(() => document.querySelectorAll('.sbw-reader-panel .sb-p-related .sb-p-state.is-loading').length === 0);
    const empty = await texts(page, '.sbw-reader-panel .sb-p-state');
    check('a note with nothing around it shows the empty states', empty.includes('Nothing similar found.') && empty.includes('This note links to nothing yet.') && empty.includes('No note links here.'), empty);
    await page.close();
  }

  // ------------------------------------------------------------ safety of rendered HTML
  {
    const page = await open(1280);
    const result = await page.evaluate(async () => {
      const { noteFragment } = await import('/src/sources/view-kit.js');
      const frag = noteFragment(document, '<p onclick="window.__pwn=1">x</p><script>window.__pwn=2</script><a href="javascript:window.__pwn=3">j</a><a href="https://example.org">e</a><img src="x" onerror="window.__pwn=4"><iframe src="/x"></iframe>');
      const box = document.createElement('div');
      box.append(frag);
      return { html: box.innerHTML, pwn: window.__pwn ?? null };
    });
    check('rendered note HTML loses scripts, handlers, javascript: links and iframes; external links keep rel=noopener and no target (the host opens them)', !/script|onclick|onerror|javascript:|iframe/i.test(result.html) && result.html.includes('rel="noopener noreferrer"') && !result.html.includes('target=') && result.pwn === null, result);
    await page.close();
  }

  // ------------------------------------------------------------ the shared panels (the build Obsidian imports)
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${origin}/dev/harness/panels.html?tokens=obsidian`);
    await page.waitForFunction(() => window.__sbPanels && window.SecondBrainUI?.RelatedPanel);
    const run = (fn, arg) => page.evaluate(fn, arg);

    const related = await run(async () => {
      const U = window.SecondBrainUI;
      const paper = { path: 'zotero/AAAA1111', title: 'A paper', zotero: { authors: ['Ann Chen', 'Bo Ruiz', 'Cy Diaz'], year: '2022', venue: 'Nature', citekey: 'C22' } };
      const data = { path: 'n/a.md', links_to: ['n/b.md', 'n/gone (no note)', 'zotero/AAAA1111'], linked_from: ['n/b.md', 'n/c.md'], refs: { 'zotero/AAAA1111': paper },
        similar: [{ ...paper, score: 0.93 }], shared_tags: [{ path: 'n/d.md', title: 'D', tags: ['ml', 'dft'], score: 6.9 }] };
      const opened = [];
      const copied = [];
      const panel = U.RelatedPanel(document, { fetchJSON: async () => data, open: (ref, heading) => opened.push([ref.path, heading]), copyLinks: (rows) => copied.push(rows.length) });
      document.body.append(panel.el);
      await panel.show('n/a.md', { title: 'a' });
      const sections = [...panel.el.querySelectorAll('.sb-p-section')].map((s) => [s.querySelector('.sb-p-section-label').textContent, s.querySelector('.sb-p-count').textContent, [...s.querySelectorAll('.sb-p-row')].map((r) => [r.querySelector('.sb-p-row-text').textContent, r.querySelector('.sb-p-row-meta')?.textContent ?? null, Boolean(r.querySelector('.sb-p-score'))])]);
      panel.el.querySelector('.sb-p-row').click();
      panel.el.querySelector('.sb-p-section .sb-p-acts button').click();
      return { sections, forLine: panel.el.querySelector('.sb-p-for')?.textContent, opened, copied };
    });
    check('Related groups Linked, Similar and Shared tags with the Obsidian labels', JSON.stringify(related.sections) === JSON.stringify([
      ['Linked', '3', [['b', 'both ways', false], ['A paper', 'linked', false], ['c', 'links here', false]]],
      ['Similar', '1', [['A paper', 'Chen et al. · 2022 · Nature', true]]],
      ['Shared tags', '1', [['D', '#ml #dft', false]]],
    ]) && related.forLine === 'a', related.sections);
    check('Related rows call open(ref, heading) and Copy as links gets the section\'s rows', JSON.stringify(related.opened) === '[["n/b.md",null]]' && JSON.stringify(related.copied) === '[3]', related);

    const states = await run(async () => {
      const U = window.SecondBrainUI;
      const out = {};
      const texts = (panel) => [...panel.el.querySelectorAll('.sb-p-state')].map((n) => n.textContent);
      // empty answers
      let panel = U.RelatedPanel(document, { fetchJSON: async () => ({ path: 'x', links_to: [], linked_from: [], refs: {}, similar: [], shared_tags: [] }), open() {} });
      await panel.show('x');
      out.empty = texts(panel);
      // linked: false leaves the Linked section to the Links panel
      panel = U.RelatedPanel(document, { fetchJSON: async () => ({ path: 'x', links_to: ['a.md'], linked_from: [], similar: [], shared_tags: [] }), open() {}, linked: false });
      await panel.show('x');
      out.noLinked = [...panel.el.querySelectorAll('.sb-p-section-label')].map((n) => n.textContent);
      // not indexed: a 404 offers "Add it now", which asks the server to index and then looks again
      const calls = [];
      let related = 0;
      panel = U.RelatedPanel(document, { afterIndexMs: 30, open() {}, fetchJSON: async (route, params, init) => {
        calls.push(`${init?.method ?? 'GET'} ${route}`);
        if (route === '/related') { related += 1; if (related === 1) throw Object.assign(new Error('nf'), { status: 404 }); return { path: 'x', links_to: [], linked_from: [], similar: [], shared_tags: [] }; }
        return {};
      } });
      await panel.show('x');
      out.notIndexed = texts(panel);
      const add = panel.el.querySelector('.sb-p-btn.is-primary');
      out.addLabel = add.textContent;
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.after = { calls, label: texts(panel) };
      // any other failure, with the host's own links as the fallback
      panel = U.RelatedPanel(document, { open() {}, fetchJSON: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
        localLinks: () => ({ links: ['l/one.md'], backlinks: ['l/two.md'] }) });
      await panel.show('x');
      out.failed = { states: texts(panel), rows: [...panel.el.querySelectorAll('.sb-p-row-text')].map((n) => n.textContent), add: Boolean(panel.el.querySelector('.sb-p-btn')) };
      // a slow answer for an earlier note never overwrites a newer one
      let release;
      panel = U.RelatedPanel(document, { open() {}, fetchJSON: (route, { path }) => path === 'slow' ? new Promise((resolve) => { release = () => resolve({ path, links_to: ['slow.md'], linked_from: [], similar: [], shared_tags: [] }); }) : Promise.resolve({ path, links_to: ['fast.md'], linked_from: [], similar: [], shared_tags: [] }) });
      const first = panel.show('slow');
      await panel.show('fast');
      release();
      await first;
      out.stale = [...panel.el.querySelectorAll('.sb-p-row-text')].map((n) => n.textContent);
      return out;
    });
    check('Related empty answers read: no links, nothing similar, no shared tags', JSON.stringify(states.empty) === JSON.stringify(['No links to or from this note.', 'Nothing similar found.', "No other notes share this note's tags."]), states.empty);
    check('linked: false leaves out the Linked section', JSON.stringify(states.noLinked) === '["Similar","Shared tags"]', states.noLinked);
    check('a note missing from the index says so and offers "Add it now"', states.notIndexed.includes("This note isn't in the index yet. New notes are added every 5 minutes.") && states.addLabel === 'Add it now', states);
    check('Add it now asks the server to index, then looks again', states.after.calls.join(',') === 'GET /related,POST /index,GET /related', states.after);
    check('any other failure shows its message, falls back to the host\'s links and offers no Add button', states.failed.states.includes("Couldn't load related notes: boom") && JSON.stringify(states.failed.rows) === '["one","two"]' && !states.failed.add, states.failed);
    check('a slow answer for the previous note never overwrites the current one', JSON.stringify(states.stale) === '["fast"]', states.stale);

    const links = await run(async () => {
      const U = window.SecondBrainUI;
      const opened = [];
      const answer = { path: 'n/a.md', links_to: ['n/b.md', 'zotero/KEY12345', 'Idea (no note)'], linked_from: ['n/c.md'] };
      const panel = U.LinksPanel(document, { fetchJSON: async () => answer, open: (ref) => opened.push(ref.path), resolveTitle: async (path) => (path === 'zotero/KEY12345' ? 'A resolved title' : null) });
      await panel.show('n/a.md');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const sections = [...panel.el.querySelectorAll('.sb-p-section')].map((s) => [s.querySelector('.sb-p-section-label').textContent, s.querySelector('.sb-p-count').textContent, [...s.querySelectorAll('.sb-p-row-text, .sb-p-section-body > .sb-p-meta')].map((n) => n.textContent)]);
      panel.el.querySelectorAll('.sb-p-row')[1].click();
      const empty = U.LinksPanel(document, { fetchJSON: async () => ({ path: 'x', links_to: [], linked_from: [] }), open() {} });
      await empty.show('x');
      const failed = U.LinksPanel(document, { fetchJSON: async () => { throw new Error('down'); }, open() {} });
      await failed.show('x');
      return { sections, opened, empty: [...empty.el.querySelectorAll('.sb-p-state')].map((n) => n.textContent), failed: failed.el.textContent };
    });
    check('Links lists links to, linked from and notes with no page, resolving paper titles', JSON.stringify(links.sections) === JSON.stringify([['Links to', '2', ['b', 'A resolved title']], ['Linked from', '1', ['c']], ['No note yet', '1', ['Idea']]]) && JSON.stringify(links.opened) === '["zotero/KEY12345"]', links);
    check('Links reads its empty and error states', JSON.stringify(links.empty) === JSON.stringify(['This note links to nothing yet.', 'No note links here.']) && links.failed === "Couldn't load links: down", links);

    const dups = await run(async () => {
      const U = window.SecondBrainUI;
      const ref = (key) => ({ path: `zotero/${key}`, title: `Paper ${key}`, zotero: { authors: ['Ann Chen'], year: '2022', venue: 'Nature' } });
      const answers = {
        '/duplicates': { exact: [['a/x.md', 'b/x.md']], near: [{ paths: ['a/y.md', 'b/y.md'], score: 0.99 }], zotero: [[ref('AAAA1111'), ref('BBBB2222')]] },
        '/conflicts': { total: 2, identical: [{ copy: 'a (conflict).md', original: 'a.md', copy_chars: 5, original_chars: 5, copy_newer: false }], different: [{ copy: 'f/b 2.md', original: 'f/b.md', copy_chars: 1200, original_chars: 900, copy_newer: true }], no_original: [] },
      };
      const tabsOf = (panel) => [...panel.el.querySelectorAll('.sb-p-tab')].map((t) => t.textContent);
      const tabAt = async (panel, label) => { [...panel.el.querySelectorAll('.sb-p-tab')].find((t) => t.textContent.startsWith(label)).click(); };
      // read-only: no remove or compare buttons
      const readOnly = U.DuplicatesPanel(document, { fetchJSON: async (route) => answers[route], open() {} });
      await readOnly.check();
      const out = { tabs: tabsOf(readOnly), info: readOnly.el.querySelector('.sb-p-state').textContent, exact: [...readOnly.el.querySelectorAll('.sb-p-row-text')].map((n) => n.textContent), buttons: readOnly.el.querySelectorAll('.sb-p-row .sb-p-iconbtn').length };
      await tabAt(readOnly, 'Nearly');
      out.near = [readOnly.el.querySelector('.sb-p-group .sb-p-meta').textContent, readOnly.el.lastElementChild.querySelector('.sb-p-state').textContent];
      await tabAt(readOnly, 'Zotero');
      out.zotero = [...readOnly.el.querySelectorAll('.sb-p-row-meta')].map((n) => n.textContent);
      await tabAt(readOnly, 'Sync');
      out.conflicts = { intro: readOnly.el.lastElementChild.querySelector('.sb-p-state').textContent, callout: Boolean(readOnly.el.querySelector('.sb-p-callout')), meta: readOnly.el.querySelector('.sb-p-row-meta').textContent };
      // with removal hooks: trash and compare appear and call back
      const trashed = [];
      const compared = [];
      const full = U.DuplicatesPanel(document, { fetchJSON: async (route) => answers[route], open() {}, onTrash: (paths, row) => { trashed.push([paths, Boolean(row)]); }, onCompare: (a, b) => compared.push([a, b]) });
      await full.check();
      out.fullInfo = full.el.querySelector('.sb-p-state').textContent;
      const buttons = [...full.el.querySelectorAll('.sb-p-row .sb-p-iconbtn')].map((b) => b.getAttribute('aria-label'));
      out.buttons2 = buttons;
      full.el.querySelectorAll('.sb-p-row .sb-p-iconbtn[aria-label="Move this copy to trash"]')[0].click();
      full.el.querySelector('.sb-p-iconbtn[aria-label="Compare side by side"]').click();
      await tabAt(full, 'Sync');
      out.callout = full.el.querySelector('.sb-p-callout .sb-p-row-text').textContent;
      full.el.querySelector('.sb-p-callout button').click();
      out.trashed = trashed; out.compared = compared;
      // empty and error
      const none = U.DuplicatesPanel(document, { fetchJSON: async (route) => (route === '/duplicates' ? { exact: [], near: [], zotero: [] } : { total: 0, identical: [], different: [], no_original: [] }), open() {} });
      await none.check();
      out.none = [...none.el.lastElementChild.querySelectorAll('.sb-p-state')].map((n) => n.textContent);
      const bad = U.DuplicatesPanel(document, { fetchJSON: async () => { throw new Error('offline'); }, open() {} });
      await bad.check();
      out.bad = bad.el.querySelector('.sb-p-state.is-error').textContent;
      return out;
    });
    check('Duplicates shows its four tabs with counts, a read-only note and no remove buttons without hooks', JSON.stringify(dups.tabs) === '["Identical1","Nearly identical1","Sync conflicts2","Zotero1"]' && dups.info.startsWith('This is a report') && dups.buttons === 0 && JSON.stringify(dups.exact) === '["x","x"]', dups);
    check('Duplicates near, Zotero and conflict tabs word their groups like Obsidian\'s', dups.near[0] === 'Similarity 0.99' && dups.near[1].includes('0.985') && dups.zotero[0] === 'Chen · 2022 · Nature' && dups.conflicts.intro === '2 copies made by sync conflicts. 1 are identical to their original; 1 differ and need a look.' && !dups.conflicts.callout && dups.conflicts.meta === 'f · copy 1,200 chars vs original 900 · copy is newer', dups);
    check('with onTrash and onCompare the panel offers them and calls back (a row to strike through, or a whole batch)', dups.fullInfo.startsWith('Nothing is removed unless you click') && dups.buttons2.includes('Compare side by side') && JSON.stringify(dups.trashed) === '[[["a/x.md"],true],[["a (conflict).md"],false]]' && JSON.stringify(dups.compared) === '[["a/x.md","b/x.md"]]' && dups.callout === 'Remove the 1 identical copies', dups);
    check('Duplicates reads "None found." and reports a failed check', dups.none.includes('None found.') && dups.bad === "Couldn't check for duplicates: offline", dups);
    check('the shared panels logged no errors', errors.length === 0, errors);
    await page.close();
  }

  return { failures, count };
}
