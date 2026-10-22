// ui-src/dev/panels-checks.mjs. Playwright checks for spec 005 D1: the panel components on the harness page
// dev/harness/panels.html, both token maps x light/dark, widths 960 / 700 / 360. Everything is measured (computed styles,
// bounding boxes), not eyeballed; screenshots go to dev/out/.
import { join } from 'node:path';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runPanelsChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} panels: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  // What Obsidian does to every button and input: a fill, a shadow, a fixed height and white-space: nowrap.
  const HOSTILE = 'button { justify-content: center; white-space: nowrap; height: 30px; box-shadow: 0 1px 1px rgba(0,0,0,.3); background: #ddd; } input { height: 30px; box-shadow: inset 0 0 0 1px #999; }';
  async function open({ tokens = 'zotero', theme = 'light', w = 960, hostile = false } = {}) {
    const page = await browser.newPage({ viewport: { width: Math.max(w + 40, 400), height: 1400 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/panels.html?${new URLSearchParams({ tokens, theme, w: String(w) })}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    if (hostile) await page.addStyleTag({ content: HOSTILE });
    page.errors = errors;
    return page;
  }

  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${tokens}/${theme}`;
      for (const w of [960, 700, 360]) {
        const page = await open({ tokens, theme, w, hostile: tokens === 'obsidian' });
        const m = await page.evaluate(() => {
          const frame = document.getElementById('frame');
          const over = [...frame.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > frame.getBoundingClientRect().right + 0.5 && getComputedStyle(e).position !== 'fixed').map((e) => `${e.tagName}.${e.className}`);
          return { frameW: frame.getBoundingClientRect().width, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, over: over.slice(0, 5) };
        });
        check(`${tag} @${w}: nothing sticks out of the panel and the page does not scroll sideways`, m.scrollW <= m.clientW && m.over.length === 0, m);
        await page.screenshot({ path: join(outDir, `panels-${tokens}-${theme}-${w}.png`), fullPage: true });
        check(`${tag} @${w}: no page errors`, page.errors.length === 0, page.errors);
        await page.close();
      }
    }
  }

  // ------------------------------------------------------------------ behaviour (Zotero map, light, 700; the hostile sheet on)
  const page = await open({ tokens: 'obsidian', theme: 'light', w: 700, hostile: true });
  const q = (sel) => page.locator(sel);

  // rows: text first, actions on hover / focus only
  const row = q('#section .sb-p-row').first();
  const acts = row.locator('.sb-p-acts');
  const opacity = () => acts.evaluate((e) => getComputedStyle(e).opacity);
  check('row actions are invisible at rest', (await opacity()) === '0', await opacity());
  await row.hover();
  check('row actions show on hover', (await opacity()) === '1', await opacity());
  await page.mouse.move(2, 2);
  await row.focus();
  check('row actions show on keyboard focus (focus-within)', (await opacity()) === '1', await opacity());
  const headActs = q('#section .sb-p-section-head .sb-p-acts');
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.activeElement?.blur());
  check('section toggle is left-aligned even when the host centres buttons (Obsidian)', await q('#section .sb-p-section-toggle').evaluate((e) => getComputedStyle(e).justifyContent === 'flex-start'), null);
  check('section header actions are invisible at rest', (await headActs.evaluate((e) => getComputedStyle(e).opacity)) === '0', null);
  await q('#section .sb-p-section-head').hover();
  check('section header actions show on hover', (await headActs.evaluate((e) => getComputedStyle(e).opacity)) === '1', null);

  // the hostile (Obsidian-like) button rules do not leak into the components
  const metrics = await page.evaluate(() => {
    const pick = (sel) => { const e = document.querySelector(sel); const s = getComputedStyle(e); return { white: s.whiteSpace, shadow: s.boxShadow, height: e.getBoundingClientRect().height }; };
    return { btn: pick('#papercard .sb-p-btn'), tab: pick('#tabs .sb-p-tab'), pill: pick('#searchbar .sb-p-pill'), icon: pick('#section .sb-p-iconbtn'), input: pick('#searchbar .sb-p-input') };
  });
  check('buttons wrap (white-space: normal) and ignore the host shadow', ['btn', 'tab', 'pill'].every((k) => metrics[k].white === 'normal' && metrics[k].shadow === 'none'), metrics);
  check('icon buttons are 24 px and the search input ignores the host height', Math.abs(metrics.icon.height - 24) < 0.5 && metrics.input.height !== 30 && metrics.input.shadow === 'none', metrics);

  // ------------------------------------------------------------------ narrow (360): long labels and titles wrap or clamp
  {
    const n = await open({ tokens: 'obsidian', theme: 'light', w: 360, hostile: true });
    const page = n;
  // a long action label wraps inside the card instead of widening it
  const wrap = await page.evaluate(() => {
    const frame = document.getElementById('frame').getBoundingClientRect();
    const long = [...document.querySelectorAll('#papercard .sb-p-btn')].find((b) => b.textContent.startsWith('Show in Zotero'));
    const r = long.getBoundingClientRect();
    return { right: r.right, frameRight: frame.right, lines: Math.round(r.height / 18), white: getComputedStyle(long).whiteSpace };
  });
  check('a long button label wraps (several lines) and stays inside the card', wrap.right <= wrap.frameRight && wrap.lines >= 2 && wrap.white === 'normal', wrap);

  // rows: long titles are clamped to two lines, meta stays on one line
  const title = await page.evaluate(() => {
    const t = document.querySelector('#section .sb-p-row:nth-child(2) .sb-p-row-text'); const meta = document.querySelector('#section .sb-p-row:nth-child(2) .sb-p-row-meta');
    const lh = parseFloat(getComputedStyle(t).lineHeight);
    return { h: t.getBoundingClientRect().height, lh, metaH: meta.getBoundingClientRect().height, metaWhite: getComputedStyle(meta).whiteSpace, scroll: t.scrollHeight > t.clientHeight };
  });
  check('a long row title clamps to two lines (and says so by overflowing hidden); the meta line stays one line', title.h <= title.lh * 2 + 1 && title.scroll && title.metaWhite === 'nowrap' && title.metaH < 20, title);

    await n.close();
  }

  // exactly one primary per card / status panel
  const primaries = await page.evaluate(() => ({ card: document.querySelectorAll('#papercard .sb-p-btn.is-primary').length, idle: document.querySelectorAll('#status-idle .sb-p-btn.is-primary').length, running: document.querySelectorAll('#status-running .sb-p-btn.is-primary').length }));
  check('one primary button per card (paper card 1, idle status 1, running status 0)', primaries.card === 1 && primaries.idle === 1 && primaries.running === 0, primaries);

  // the score bar: five levels, label as text, full sentence in the tooltip
  const score = await page.evaluate(() => { const s = document.querySelector('#section .sb-p-score'); const fill = s.querySelector('.sb-p-score-fill'); return { label: s.textContent, fill: fill.style.width, tip: s.title }; });
  check('related rows show a score bar at its level, the label as text and the similarity in the tooltip', score.label === 'Very close' && score.fill === '100%' && /similarity 0\.93/.test(score.tip), score);

  // section: toggle collapses, count shows, empty line shows
  await q('#section .sb-p-section-toggle').click();
  check('the section toggle hides the rows and says so (aria-expanded=false)', (await q('#section .sb-p-section-body').isHidden()) && (await q('#section .sb-p-section-toggle').getAttribute('aria-expanded')) === 'false', null);
  await q('#section .sb-p-section-toggle').click();
  check('and shows them again', await q('#section .sb-p-section-body').isVisible(), null);
  check('a section shows its count; an empty one shows one quiet line', (await q('#section .sb-p-section-label + .sb-p-count').textContent()) === '3' && (await q('#section-empty .sb-p-state.is-empty').count()) === 1 && (await q('#section-empty .sb-p-count').count()) === 1 && (await q('#section-empty .sb-p-count').evaluate((e) => getComputedStyle(e).display)) === 'none', null);

  // activating a row (click, Enter) and an action (does not open the row)
  await q('#section .sb-p-row').first().click({ position: { x: 100, y: 12 } });
  await q('#section .sb-p-row').first().focus();
  await page.keyboard.press('Enter');
  await q('#section .sb-p-row').first().hover();
  await q('#section .sb-p-row .sb-p-iconbtn').first().click();
  const calls = await page.evaluate(() => window.__sbPanels.calls);
  check('a row opens on click and on Enter; its action does not also open it', calls.opened.join() === 'vole,vole' && calls.actions.join() === 'copy-vole', calls);
  await q('#hit .sb-p-passage').nth(1).click();
  check('a passage opens on its own (not the whole hit)', (await page.evaluate(() => window.__sbPanels.calls.opened)).slice(-1)[0] === 'passage-2', null);

  // search bar: pills toggle with the same rules as the data helpers; More lists the sources and picks one
  await q('#searchbar .sb-p-pill').first().click(); // Papers off -> Notes only
  let scopes = await page.evaluate(() => window.__sbPanels.calls.scopes);
  check('Papers off leaves Notes only (aria-pressed follows)', JSON.stringify(scopes.at(-1)) === JSON.stringify({ papers: false, notes: true, specific: '' }) && (await q('#searchbar .sb-p-pill').first().getAttribute('aria-pressed')) === 'false', scopes);
  await q('#searchbar .sb-p-pill').nth(1).click(); // the last one on: reset to both
  scopes = await page.evaluate(() => window.__sbPanels.calls.scopes);
  check('turning the last pill off resets to both on', JSON.stringify(scopes.at(-1)) === JSON.stringify({ papers: true, notes: true, specific: '' }), scopes);
  await q('#searchbar .sb-p-more').click();
  const items = await q('#searchbar .sb-p-pop-item').allTextContents();
  check('More lists Any source plus the six finer sources', items.length === 7 && items[0] === 'Any source' && items.includes('PDFs') && items.includes('AI notes'), items);
  const popBox = await page.evaluate(() => { const p = document.querySelector('.sb-p-pop').getBoundingClientRect(); const f = document.getElementById('frame').getBoundingClientRect(); return { l: p.left, r: p.right, fl: f.left, fr: f.right }; });
  check('the More popover stays inside the panel', popBox.l >= popBox.fl - 0.5 && popBox.r <= popBox.fr + 0.5, popBox);
  await q('#searchbar .sb-p-pop-item').filter({ hasText: 'PDFs' }).click();
  scopes = await page.evaluate(() => window.__sbPanels.calls.scopes);
  check('picking PDFs sets the Notes side and names the source on the More button', JSON.stringify(scopes.at(-1)) === JSON.stringify({ papers: false, notes: true, specific: 'pdf' }) && (await q('#searchbar .sb-p-more').textContent()).trim() === 'PDFs', scopes);
  await q('#searchbar .sb-p-pill').first().click(); // toggling a pill drops the chosen source
  scopes = await page.evaluate(() => window.__sbPanels.calls.scopes);
  check('using a pill drops the chosen source', scopes.at(-1).specific === '' && (await q('#searchbar .sb-p-more').textContent()).trim() === 'More', scopes);
  await q('#searchbar .sb-p-input').fill('voles');
  await q('#searchbar .sb-p-input').press('Enter');
  const queries = await page.evaluate(() => window.__sbPanels.calls.queries);
  check('typing reports the query; Enter reports it as immediate', queries.at(-2)[0] === 'voles' && queries.at(-2)[1] === false && queries.at(-1)[1] === true, queries);
  // the field outline appears on hover / focus only
  const boxBorder = (state) => page.evaluate(() => getComputedStyle(document.querySelector('#searchbar .sb-p-searchbox')).borderTopColor);
  await page.mouse.move(2, 2); await page.evaluate(() => document.activeElement?.blur());
  const rest = await boxBorder();
  await q('#searchbar .sb-p-input').focus();
  const focused = await boxBorder();
  check('the search field has no outline at rest and gets one on focus', rest === 'rgba(0, 0, 0, 0)' && focused !== rest, { rest, focused });

  // paper card: "+N more" expands the authors
  await q('#papercard .sb-p-linkbtn').click();
  check('"+2 more" opens the full author list', !(await q('#papercard .sb-p-authors').textContent()).includes('more') && (await q('#papercard .sb-p-authors').textContent()).includes('K. Fennel'), await q('#papercard .sb-p-authors').textContent());
  check('the title is 20 px', (await q('#papercard .sb-p-paper-title').evaluate((e) => getComputedStyle(e).fontSize)) === '20px', null);
  // status panel
  const dot = await page.evaluate(() => ({ run: getComputedStyle(document.querySelector('#status-running .sb-p-dot')).animationName, idle: getComputedStyle(document.querySelector('#status-idle .sb-p-dot')).backgroundColor, bar: document.querySelector('#status-running .sb-p-progress').getAttribute('aria-valuenow'), rows: document.querySelectorAll('#status-running .sb-p-coverage-row').length }));
  const narrow = await page.evaluate(() => { const el = document.querySelector('#status-running .sb-p-coverage'); const host = el.parentElement; host.style.width = '260px'; const name = el.querySelector('.sb-p-coverage-row:not(.is-head) .sb-p-coverage-name'); const r = { w: name.getBoundingClientRect().width, h: name.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(name).lineHeight) || 18 }; host.style.width = ''; return r; });
  check('status coverage table in a 260 px pane (wide window): names are not broken letter by letter (the layout follows the pane, not the window)', narrow.w >= 100 && narrow.h <= narrow.lh * 2.2, narrow);
  check('the running status pulses, shows 34% (1200 of 3500) and a header plus three coverage rows; idle is green', dot.run !== 'none' && dot.bar === '34' && dot.rows === 4 && dot.idle !== 'rgba(0, 0, 0, 0)', dot);
  await page.close();


  // ------------------------------------------------------------------ SearchPanel (spec 005 D2)
  {
    const p = await open({ tokens: 'zotero', theme: 'light', w: 700 });
    const sp = () => p.evaluate(() => ({ s: window.__sbPanels.sp.searches.slice(), o: window.__sbPanels.sp.opens.slice() }));
    const root = p.locator('#searchpanel');
    check('the panel starts with its hint and no rows', (await root.locator('.sb-p-search-statusrow .sb-p-state').textContent()).startsWith('Search your notes') && (await root.locator('.sb-p-row').count()) === 0, null);
    await root.locator('.sb-p-input').fill('vole');
    await p.waitForSelector('#searchpanel .sb-p-row');
    let st = await sp();
    check('typing searches after a short pause (once) with no filter, limit 30', st.s.length === 1 && st.s[0].query === 'vole' && st.s[0].scope.source === '' && st.s[0].scope.exclude === '' && st.s[0].limit === 30, st);
    check('three rows: Papers first with its byline, notes with folder and date, a PDF badge', (await root.locator('.sb-p-row').count()) === 3
      && (await root.locator('.sb-p-row-meta').allTextContents()).join('|') === 'Bramblewood & Quills · 2021 · Journal of Invented Zoology|Notes · 2024-03-02|Scans · 2023-11-30'
      && (await root.locator('.sb-p-badge').allTextContents()).join() === 'PDF', await root.locator('.sb-p-row-meta').allTextContents());
    check('snippets are tidied (no ** or ##) and the heading shows its last part', (await root.locator('.sb-p-row-snippet').first().textContent()) === 'Voles were tracked across 14 plots.' && (await root.locator('.sb-p-passage-heading').first().textContent()) === 'Plots', await root.locator('.sb-p-row-snippet').first().textContent());
    check('the first row is selected, a status line counts results, the host footer button is there', (await root.locator('.sb-p-row.is-selected').count()) === 1 && (await root.locator('.sb-p-row').first().getAttribute('class')).includes('is-selected')
      && (await root.locator('.sb-p-search-statusrow .sb-p-state').textContent()) === '3 results' && (await root.locator('.sb-p-search-footer .sb-p-btn').textContent()) === 'Show 3 papers in library', await root.locator('.sb-p-search-statusrow .sb-p-state').textContent());
    // Papers-only
    await root.locator('.sb-p-pill').first().click(); // Papers off -> Notes only
    await p.waitForFunction(() => window.__sbPanels.sp.searches.length === 2);
    st = await sp();
    check('Papers off searches everything but Zotero (exclude_source=zotero) and shows only notes', st.s[1].scope.exclude === 'zotero' && (await root.locator('.sb-p-row').count()) === 2, st.s[1]);
    await root.locator('.sb-p-pill').first().click(); // back to both
    await root.locator('.sb-p-pill').nth(1).click(); // Notes off -> Papers only
    await p.waitForFunction(() => window.__sbPanels.sp.searches.length === 4);
    st = await sp();
    check('Notes off searches source=zotero and shows only papers', st.s[3].scope.source === 'zotero' && (await root.locator('.sb-p-row').count()) === 1, st.s[3]);
    await root.locator('.sb-p-more').click();
    await root.locator('.sb-p-pop-item').filter({ hasText: 'PDFs' }).click();
    await p.waitForFunction(() => window.__sbPanels.sp.searches.length === 5);
    st = await sp();
    check('More > PDFs searches source=pdf (the finer source wins)', st.s[4].scope.source === 'pdf' && st.s[4].scope.exclude === '', st.s[4]);
    await root.locator('.sb-p-more').click();
    await root.locator('.sb-p-pop-item').first().click(); // Any source
    await p.waitForFunction(() => window.__sbPanels.sp.searches.length === 6);
    // keyboard: arrows move the selection, Enter opens it; click opens; meta-click asks for a new tab; a passage opens with its heading
    await root.locator('.sb-p-input').focus();
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('ArrowDown');
    check('ArrowDown twice selects the third row and scrolls it into view', (await root.locator('.sb-p-row.is-selected').count()) === 1 && (await root.locator('.sb-p-row').nth(2).getAttribute('class')).includes('is-selected'), null);
    await p.keyboard.press('Enter');
    await root.locator('.sb-p-row').nth(1).locator('.sb-p-row-title').click();
    await root.locator('.sb-p-row').nth(0).locator('.sb-p-row-title').click({ modifiers: ['Meta'] });
    await root.locator('.sb-p-row').nth(0).locator('.sb-p-passage').click();
    st = await sp();
    check('Enter opens the selected hit; click opens a row; meta-click asks for a new tab; a passage opens at its heading',
      JSON.stringify(st.o) === JSON.stringify([{ path: 'Scans/handle.pdf', newTab: false, heading: null }, { path: 'Notes/Vole winter diet.md', newTab: false, heading: null }, { path: 'zotero/AAAA1111', newTab: true, heading: null }, { path: 'zotero/AAAA1111', newTab: false, heading: 'Methods > Plots' }]), st.o);
    await root.locator('.sb-p-row').first().hover();
    await root.locator('.sb-p-row .sb-p-iconbtn').first().click();
    check('a row action does not open the row', (await sp()).o.length === 4 && (await p.evaluate(() => window.__sbPanels.calls.actions)).includes('copy:zotero/AAAA1111'), null);
    // a slow older answer never replaces a newer one
    await root.locator('.sb-p-input').fill('slow');
    await p.waitForFunction(() => window.__sbPanels.sp.searches.at(-1).query === 'slow');
    await root.locator('.sb-p-input').fill('none');
    await p.waitForTimeout(600);
    check('a slow older search does not overwrite the newer "no matches"', (await root.locator('.sb-p-row').count()) === 0 && (await root.locator('.sb-p-search-statusrow .sb-p-state').textContent()) === 'No matches.', await root.locator('.sb-p-search-statusrow .sb-p-state').textContent());
    // empty query returns to the hint; errors become one alert line
    await root.locator('.sb-p-input').fill('');
    await p.waitForTimeout(300);
    check('clearing the box restores the hint and drops the rows', (await root.locator('.sb-p-search-statusrow .sb-p-state').textContent()).startsWith('Search your notes') && (await root.locator('.sb-p-row').count()) === 0, null);
    await p.evaluate(() => { window.__sbPanels.sp.mode = 'error'; });
    await root.locator('.sb-p-input').fill('boom');
    await p.waitForSelector('#searchpanel .sb-p-state.is-error');
    check('a failing search shows one alert line with the reason', (await root.locator('.sb-p-state.is-error').textContent()) === 'Search failed: Search backend exploded' && (await root.locator('.sb-p-state.is-error').getAttribute('role')) === 'alert', null);
    await p.evaluate(() => { window.__sbPanels.sp.mode = 'ok'; });
    // the decorating form (Obsidian): the host wires rows and passages, the panel adds no click of its own
    const deco = p.locator('#searchdeco');
    await deco.locator('.sb-p-input').fill('vole');
    await p.waitForSelector('#searchdeco .sb-p-row');
    await deco.locator('.sb-p-row').first().locator('.sb-p-passage').click();
    const opened = (await sp()).o.filter((o) => o.via);
    check('with a host decorator, opening goes through it (once per click) and the pills can be hidden', opened.length === 1 && opened[0].heading === 'Methods > Plots' && (await deco.locator('.sb-p-pill').count()) === 0 && (await p.evaluate(() => window.__sbPanels.sp.decorated)) === 6, opened);
    // selected row: the filled row is distinguishable from hover only by the same fill (no extra colour), checked by measuring
    check('layout: the results list is the only scroller in the panel (the panel itself does not scroll)', await p.evaluate(() => { const r = document.querySelector('#searchpanel .sb-p-search'); const l = r.querySelector('.sb-p-results'); return r.scrollHeight <= r.clientHeight + 1 && getComputedStyle(l).overflowY === 'auto'; }), null);
    await p.screenshot({ path: join(outDir, 'search-panel-zotero-light.png'), fullPage: true });
    await p.close();
  }

  // ------------------------------------------------------------------ the real content/search.js on stubbed chrome (spec 005 D2)
  {
    const page = await browser.newPage({ viewport: { width: 680, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/search-window.html?tokens=zotero`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    const calls = () => page.evaluate(() => window.__sbSearchWindow.calls);
    const input = page.locator('.sb-p-input');
    check('window: tabs, the box, Papers / Notes pills and More are there; the hint is the old one', (await page.locator('.sb-p-tab').allTextContents()).join('|') === 'My library|Find new papers'
      && (await page.locator('.sb-p-pill').count()) === 2 && (await page.locator('.sb-p-more').count()) === 1 && (await page.locator('.sb-p-search-statusrow .sb-p-state').textContent()).startsWith('Papers open in Zotero'), null);
    await input.fill('vole');
    await page.waitForSelector('.sb-p-row');
    let c = await calls();
    check('window: a query searches both sides (no source, no exclude), limit 30, and selects the first hit', c.searches.length === 1 && c.searches[0].source === '' && c.searches[0].exclude === '' && c.searches[0].limit === 30 && (await page.locator('.sb-p-row.is-selected').count()) === 1, c.searches);
    check('window: citekeys in snippets are chips; the footer offers "Show paper in library"', (await page.locator('.sb-cite-chip').textContent()) === 'Bramblewood 2021' && (await page.locator('.sb-p-search-footer .sb-p-btn').textContent()) === 'Show paper in library', null);
    await page.locator('.sb-p-search-footer .sb-p-btn').click();
    check('window: that button shows the paper keys', JSON.stringify((await calls()).shown) === '[["AAAA1111"]]', await calls());
    await page.locator('.sb-p-pill').nth(1).click(); // Notes off -> Papers only
    await page.waitForFunction(() => window.__sbSearchWindow.calls.searches.length === 2);
    c = await calls();
    check('window: Papers only searches source=zotero and lists one paper', c.searches[1].source === 'zotero' && (await page.locator('.sb-p-row').count()) === 1, c.searches[1]);
    await page.locator('.sb-p-pill').nth(1).click(); // back to both
    await page.locator('.sb-p-pill').first().click(); // Papers off -> Notes only
    await page.waitForFunction(() => window.__sbSearchWindow.calls.searches.length === 4);
    c = await calls();
    check('window: Notes only searches everything but Zotero (exclude_source)', c.searches[3].exclude === 'zotero' && (await page.locator('.sb-p-row').count()) === 1, c.searches[3]);
    await page.locator('.sb-p-more').click();
    check('window: More lists Any source, Zotero, My notes, Notion, PDFs, Images, AI notes', (await page.locator('.sb-p-pop-item').allTextContents()).join('|') === 'Any source|Zotero|My notes|Notion|PDFs|Images|AI notes', null);
    await page.keyboard.press('Escape');
    check('window: Escape closes the More menu and not the window', (await page.locator('.sb-p-pop').count()) === 0 && (await calls()).closed === 0, await calls());
    await page.locator('.sb-p-pill').first().click(); // reset to both
    await page.waitForFunction(() => window.__sbSearchWindow.calls.searches.length === 5);
    await input.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('.sb-p-row').first().locator('.sb-p-row-title').click();
    c = await calls();
    check('window: Enter opens the selected hit and a click opens a row (papers by key path, notes by vault path)', JSON.stringify(c.opened) === '["Notes/Vole winter diet.md","zotero/AAAA1111"]', c.opened);
    await page.keyboard.press('Escape');
    check('window: Escape with nothing open closes the window', (await calls()).closed === 1, await calls());
    await input.fill('offline-notes');
    await page.waitForSelector('.sb-p-state.is-error');
    check('window: a search the server must answer, with the server down, shows the host\'s message', (await page.locator('.sb-p-state.is-error').textContent()) === 'UNREACHABLE: Notes need the Second Brain server', null);
    // online mode
    await page.locator('.sb-p-tab').nth(1).click();
    check('window: Find new papers hides the pills and More, shows the service checkboxes and Google Scholar', (await page.locator('.sb-p-pill').count()) === 0 && (await page.locator('.sb-p-more').count()) === 0
      && (await page.locator('.sb-p-checks input[type=checkbox]').count()) === 2 && (await page.locator('.sb-p-checks .sb-p-btn').textContent()) === 'Google Scholar ↗', null);
    await input.fill('doorknob');
    await page.waitForSelector('.sb-p-row .sb-p-btn');
    check('window: online rows: title, byline, found-in, abstract, one Add button; an owned paper says "In your library"; failed services are named',
      (await page.locator('.sb-p-row-title').first().textContent()) === 'A Unified Theory of Doorknob Ergonomics'
      && (await page.locator('.sb-p-row-meta').first().textContent()) === 'Handlebar · 2019 · Proceedings of Everyday Design · cited 12× · found in OpenAlex'
      && (await page.locator('.sb-p-row .sb-p-btn').first().textContent()) === 'Add' && (await page.locator('.sb-p-row .sb-p-btn').nth(1).textContent()) === 'In your library'
      && (await page.locator('.sb-p-search-statusrow .sb-p-state').textContent()).includes('arXiv didn\'t answer'), await page.locator('.sb-p-search-statusrow .sb-p-state').textContent());
    await page.locator('.sb-p-row .sb-p-btn').first().click();
    await page.waitForFunction(() => window.__sbSearchWindow.calls.added.length === 1);
    await page.waitForFunction(() => document.querySelector('.sb-p-row .sb-p-btn').textContent === 'Added');
    await page.locator('.sb-p-row .sb-p-btn').first().click();
    c = await calls();
    check('window: Add adds once, then the button says Added and shows the paper in the library', c.added.length === 1 && c.opened.at(-1) === 'zotero/NEWKEY01', c);
    await page.locator('.sb-p-checks input').nth(1).check();
    check('window: ticking a service is remembered (the pref) and a service can never all be unticked', (await calls()).prefs['extensions.secondbrain.sources'] === '["openalex","arxiv"]', (await calls()).prefs);
    await page.screenshot({ path: join(outDir, 'search-window-online.png') });
    check('window: no page errors', errors.length === 0, errors);
    await page.close();
  }

  // ------------------------------------------------------------------ the Zotero item pane's lists (real second-brain.js list()), spec 005 D3
  for (const theme of ['light', 'dark']) for (const w of [960, 360, 280]) {
    const page = await browser.newPage({ viewport: { width: Math.max(w + 40, 320), height: 900 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/item-pane.html?theme=${theme}&w=${w}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    const tag = `item pane ${theme} @${w}`;
    const m = await page.evaluate(() => {
      const pane = document.getElementById('pane').getBoundingClientRect();
      const over = [...document.querySelectorAll('#pane *')].filter((e) => e.getBoundingClientRect().right > pane.right + 0.5).map((e) => `${e.tagName}.${e.className}`).slice(0, 4);
      const labels = [...document.querySelectorAll('.sb-p-section-label')].map((e) => e.textContent);
      const counts = [...document.querySelectorAll('.sb-p-section-head')].map((e) => e.querySelector('.sb-p-count')?.textContent ?? '');
      const rows = [...document.querySelectorAll('.sb-related .sb-p-row')];
      const scores = [...document.querySelectorAll('.sb-p-score-label')].map((e) => e.textContent);
      const bg = getComputedStyle(document.querySelector('.sb-related')).backgroundColor;
      const links = [...document.querySelectorAll('link[id^="sb-ui-"]')].map((l) => l.id);
      const kicker = document.querySelector('.sb-note-head .sb-p-kicker')?.textContent;
      const bar = document.querySelector('.sb-note-head .sb-p-paper-actions');
      const tokens = getComputedStyle(document.querySelector('.sb-related')).getPropertyValue('--sb-ui-text').trim();
      const emptyLines = [...document.querySelectorAll('.sb-p-state')].map((e) => e.textContent.slice(0, 30));
      return { over, labels, counts, rowCount: rows.length, scores, bg, links, kicker, hasBar: Boolean(bar), tokens, emptyLines, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)) };
    });
    check(`${tag}: three lists (counts 1, none, 2), an empty one shows its line, the similar rows carry closeness labels from the fixed and the calibrated grading`,
      m.labels.join('|') === 'Cited in your notes|Related notes|Similar papers in your library' && m.counts.join('|') === '1||2' && m.rowCount === 3 && m.scores.join('|') === 'Very close|Close' && m.emptyLines.some((t) => t.startsWith('Nothing close')), m);
    check(`${tag}: nothing sticks out of the pane, the page does not scroll sideways, the panel is transparent on the pane's own colour`, m.over.length === 0 && m.scrollW <= m.clientW && m.bg === 'rgba(0, 0, 0, 0)', m);
    check(`${tag}: addUiStyles stays idempotent (two links), tokens resolve, the paper-note header has a kicker and no empty action rule`, m.links.join() === 'sb-ui-zotero-tokens,sb-ui-components' && m.tokens !== '' && m.kicker === 'Paper note' && !m.hasBar, m);
    check(`${tag}: no page errors`, errors.length === 0, errors);
    if (w === 280) {
      // a long title clamps to two lines in the narrowest pane
      const r = await page.evaluate(() => { const t = document.querySelectorAll('.sb-related .sb-p-row')[1].querySelector('.sb-p-row-text'); return { h: t.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(t).lineHeight) }; });
      check(`${tag}: a long paper title clamps to two lines`, r.h <= r.lh * 2 + 1, r);
    }
    if (theme === 'light' && w === 360) {
      await page.locator('.sb-related .sb-p-row').nth(1).click();
      check(`${tag}: a row opens its paper (zotero/ key path)`, JSON.stringify(await page.evaluate(() => window.__sbItemPane.opened)) === '["zotero/AAAA1111"]', null);
    }
    await page.screenshot({ path: join(outDir, `item-pane-${theme}-${w}.png`) });
    await page.close();
  }

  // ------------------------------------------------------------------ duplicates and status look (spec 005 D4)
  for (const w of [960, 360]) {
    const p = await open({ tokens: 'obsidian', theme: 'dark', w, hostile: true });
    const tag = `dups/status @${w}`;
    const m = await p.evaluate(() => {
      const frame = document.getElementById('frame').getBoundingClientRect();
      const g = document.querySelector('#dups .sb-p-group'); const gs = getComputedStyle(g);
      const co = document.querySelector('#callout'); const cb = co.querySelector('.sb-p-btn').getBoundingClientRect();
      const coBox = co.querySelector('.sb-p-group').getBoundingClientRect();
      const lab = document.querySelector('#model-state .sb-p-status-label');
      return { border: gs.borderTopWidth, radius: gs.borderTopLeftRadius, btnRight: cb.right, boxRight: coBox.right, frameRight: frame.right, btnH: Math.round(cb.height), btnWhite: getComputedStyle(co.querySelector('.sb-p-btn')).whiteSpace,
        labW: getComputedStyle(lab).fontWeight, bg: getComputedStyle(document.querySelector('#model-state .sb-p')).backgroundColor, bar: Boolean(document.querySelector('#model-state .sb-p-progress.is-indeterminate')), scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
    });
    check(`${tag}: a duplicate group is a 1 px rule box with 10 px corners; the callout's long button wraps inside it and nothing scrolls sideways`, m.border === '1px' && m.radius === '10px' && m.btnRight <= m.boxRight + 0.5 && m.boxRight <= m.frameRight + 0.5 && m.btnWhite === 'normal' && m.scrollW <= m.clientW && (w !== 360 || m.btnH > 30), m);
    check(`${tag}: the settings state is compact (regular weight), transparent on the pane, indeterminate bar while it works`, m.labW === '400' && m.bg === 'rgba(0, 0, 0, 0)' && m.bar, m);
    if (w === 960) {
      // trash action marks the row removed: dimmed, struck through, no further clicks
      await p.locator('#dups .sb-p-row').nth(2).hover();
      await p.locator('#dups .sb-p-row').nth(2).locator('.sb-p-iconbtn').nth(1).click();
      const r = await p.evaluate(() => { const e = document.querySelectorAll('#dups .sb-p-row')[2]; const s = getComputedStyle(e); return { o: s.opacity, d: s.textDecorationLine, pe: s.pointerEvents }; });
      check(`${tag}: a trashed row is dimmed (0.35), struck through and no longer clickable`, r.o === '0.35' && r.d === 'line-through' && r.pe === 'none', r);
      // a status panel re-renders in place (the 2 s poll): same root, new content
      const same = await p.evaluate(() => { const el = window.__sbPanels.model.el; window.__sbPanels.model.render({ state: 'idle', label: 'Ready · 3,500 papers', compact: true }); return { same: el === document.querySelector('#model-state .sb-p-status'), label: el.querySelector('.sb-p-status-label').textContent, bar: Boolean(el.querySelector('.sb-p-progress')), dot: el.querySelector('.sb-p-dot').className }; });
      check(`${tag}: render() replaces the content in place (same element, label, no bar once idle, green dot)`, same.same && same.label === 'Ready · 3,500 papers' && !same.bar && same.dot.includes('is-idle'), same);
    }
    await p.screenshot({ path: join(outDir, `dups-status-${w}.png`), fullPage: true });
    await p.close();
  }

  // reduced motion: no pulse, no slide
  const rm = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 760, height: 1400 } });
  await rm.goto(`http://127.0.0.1:${port}/dev/harness/panels.html?w=700`);
  await rm.waitForFunction(() => window.__sbHarnessReady === true);
  const still = await rm.evaluate(() => getComputedStyle(document.querySelector('#status-running .sb-p-dot')).animationName);
  check('prefers-reduced-motion stops the status dot pulsing', still === 'none', still);
  await rm.close();

  return { failures, count };
}
