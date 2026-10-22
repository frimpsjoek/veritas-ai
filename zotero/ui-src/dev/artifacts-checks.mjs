// ui-src/dev/artifacts-checks.mjs. Playwright checks for spec 007 E3 (result cards, the artifact panel, versions,
// search and sort, export, the three widths, the streamed `sb-table` block, Find papers as a result), run by
// dev/run.mjs against dev/harness/artifacts.html. Screenshots go to dev/out/ (git-ignored).
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runArtifactChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const trees = {};
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} artifacts: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const url = (query) => `http://127.0.0.1:${port}/dev/harness/artifacts.html?${new URLSearchParams(query)}`;

  /** Opens the scenario page; the chat is `w` px wide (`bare`: the page is the chat, no padding). */
  async function open(query, viewport, colorScheme = 'light') {
    const page = await browser.newPage({ viewport, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(url(query));
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    page.errors = errors;
    return page;
  }
  const openCard = async (page, text) => {
    await page.locator('.sb-art-card', { hasText: text }).last().click();
    await page.waitForSelector('.sb-art-table, .sb-art-cardlist, .sb-art-empty', { timeout: 4000 });
  };
  const texts = (page, selector) => page.locator(selector).allTextContents();
  const layout = (page) => page.evaluate(() => {
    const root = document.querySelector('.sb-ai');
    const pane = document.querySelector('.sb-ai-artifact');
    const main = document.querySelector('.sb-ai-main');
    const body = document.querySelector('.sb-art-body');
    return {
      docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
      rootScroll: root.scrollWidth, rootClient: root.clientWidth,
      bodyScroll: body?.scrollWidth ?? 0, bodyClient: body?.clientWidth ?? 0,
      pane: pane && !pane.hidden ? pane.getBoundingClientRect().width : 0, main: main.getBoundingClientRect().width, mainShown: getComputedStyle(main).display !== 'none',
      classes: root.className,
    };
  });

  // ---------------------------------------------------------------- pictures: both token maps, light and dark, three widths
  const WIDTHS = [['side', 1100], ['cover', 700], ['full', 360]];
  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      for (const [mode, w] of WIDTHS) {
        const bare = mode === 'full';
        const page = await open({ tokens, theme, w: bare ? '' : String(w), bare: bare ? '1' : '' }, { width: bare ? w : w + 32, height: bare ? 780 : 760 }, theme);
        const cardsBefore = await page.locator('.sb-art-card').count();
        if (mode === 'cover') await page.screenshot({ path: join(outDir, `artifacts-thread-${tokens}-${theme}.png`) });
        await openCard(page, 'Papers');
        const l = await layout(page);
        await page.screenshot({ path: join(outDir, `artifacts-${tokens}-${theme}-${mode}.png`) });
        const expectClass = `is-art-${mode}`;
        const noScroll = l.docScroll <= l.docClient && l.rootScroll <= l.rootClient;
        check(`${tokens}/${theme} ${mode}: 3 cards in the thread, panel open in "${mode}" layout${bare ? ', no horizontal scroll' : ''}`,
          cardsBefore === 3 && l.classes.includes(expectClass) && page.errors.length === 0 && (!bare || (noScroll && l.bodyScroll <= l.bodyClient)),
          { cardsBefore, l, errors: page.errors });
        if (theme === 'light') {
          const tree = await page.evaluate(() => window.__sbArtifactTrees);
          trees[tokens] = tree;
        }
        await page.close();
      }
    }
  }
  const [zt, ot] = [trees.zotero, trees.obsidian];
  for (const key of ['artifact-thread', 'artifact-panel', 'papers-chat']) {
    check(`parity: ${key} DOM class tree is identical (Zotero token map vs. Obsidian token map)`, zt && ot && JSON.stringify(zt[key]) === JSON.stringify(ot[key]), null);
  }

  // ---------------------------------------------------------------- behaviour (one page, side layout)
  const page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 760 });
  const metas = await texts(page, '.sb-art-card-meta');
  check('cards say what they hold: table V1 is older, then the paper set and the table at their latest version',
    JSON.stringify(metas) === JSON.stringify(['Table · 2 rows · V1 · a newer version exists', 'Papers · 4 · 2 columns · V2', 'Table · 2 rows · V2']), metas);
  check('the header lists the session as "Artifacts (2)"', (await page.locator('.sb-ai-artifacts-button').textContent()) === 'Artifacts (2)', await page.locator('.sb-ai-artifacts-button').textContent());
  check('a reopened answer keeps the "Couldn\'t turn this into a table" notice', (await texts(page, '.sb-ai-notice')).some((t) => t.includes("Couldn't turn this into a table")), await texts(page, '.sb-ai-notice'));

  await page.locator('.sb-ai-artifacts-button').click();
  const listed = await texts(page, '.sb-art-listmenu .sb-art-item-label');
  check('Artifacts (N) lists every result, newest first', JSON.stringify(listed) === JSON.stringify(['Vole foraging models', 'Vole foraging and hoarding']), listed);
  const fits = await page.evaluate(() => [...document.querySelectorAll('.sb-art-listmenu .sb-art-item')].every((row) => { const r = row.getBoundingClientRect(), m = row.closest('.sb-art-listmenu').getBoundingClientRect(); return r.top >= m.top - 1 && r.bottom <= m.bottom + 1; }));
  check('Artifacts (N) shows every row whole, not clipped to the header bar\'s height', fits);
  await page.locator('.sb-art-listmenu .sb-art-item', { hasText: 'Vole foraging and hoarding' }).click();
  await page.waitForSelector('.sb-art-table');
  check('opening from the list opens the panel on the latest version', (await page.locator('.sb-art-version').textContent())?.trim() === 'V2'
    && (await page.locator('.sb-art-head-text').textContent()) === 'Vole foraging and hoarding', await page.locator('.sb-art-head').textContent());

  // the table itself
  const heads = await texts(page, '.sb-art-th');
  check('table: sticky first column with the paper count, then one column per result column', heads.join('|') === 'Paper (4)|Main finding|Sample size', heads);
  const sticky = await page.evaluate(() => {
    const first = document.querySelector('.sb-art-td.is-first');
    const head = document.querySelector('.sb-art-th.is-first');
    return { td: getComputedStyle(first).position, th: getComputedStyle(head).position };
  });
  check('table: first column and header row are sticky', sticky.td === 'sticky' && sticky.th === 'sticky', sticky);
  check('pending cells are skeleton bars, a failed cell says so, a not-found cell shows its note',
    (await page.locator('.sb-art-skel-bar').count()) === 3 && (await page.locator('.sb-art-fail').count()) === 1 && (await texts(page, '.sb-art-note')).includes('Not reported in the abstract'),
    { bars: await page.locator('.sb-art-skel-bar').count() });
  const chips = await texts(page, '.sb-art-chip');
  check('citation chips are grey text after the sentence, "+N" for more than one', chips.length === 4 && chips.some((c) => /\+1$/.test(c.trim())), chips);

  // chip popover: quote, where it came from, Unverified, Open
  await page.locator('.sb-art-row').nth(0).locator('.sb-art-chip').nth(1).click();
  await page.screenshot({ path: join(outDir, 'artifacts-chip-popover.png') });
  const evidence = (await page.locator('.sb-art-evidence').textContent()) ?? '';
  check('chip popover shows the quote, "From the full text" and the "Unverified" mark',
    evidence.includes('across three meadows') && evidence.includes('From the full text') && evidence.includes('Unverified'), evidence);
  await page.locator('.sb-art-evidence .sb-art-ev-open').click();
  const opened = await page.evaluate(() => window.__opened);
  check('Open in the chip popover calls host.openRef', opened.length === 1 && opened[0].kind === 'paper' && opened[0].citekey === 'bramblewood2021', opened);
  check('the popover closes after Open', (await page.locator('.sb-art-pop').count()) === 0, null);

  // search
  await page.locator('.sb-art-search-input').fill('doorknob');
  check('search narrows the rows (title) and says how many', (await page.locator('.sb-art-row').count()) === 1 && (await page.locator('.sb-art-count').textContent()) === 'Showing 1 of 4', await texts(page, '.sb-art-count'));
  await page.locator('.sb-art-search-input').fill('twenty-six');
  check('search looks in cell text too', (await page.locator('.sb-art-row').count()) === 1 && (await page.locator('.sb-art-title').textContent())?.startsWith('Voles,'), await texts(page, '.sb-art-title'));
  await page.locator('.sb-art-search-input').fill('zzz');
  check('a search with no match says so', (await page.locator('.sb-art-empty').textContent())?.includes('No rows match'), await texts(page, '.sb-art-empty'));
  await page.locator('.sb-art-search-input').fill('');

  // sort
  await page.locator('.sb-art-sort').click();
  const sortItems = await texts(page, '.sb-art-pop .sb-art-item-label');
  check('sort menu: None, title, year, citations and every column', sortItems.join('|') === 'None|Title|Year|Citations|Main finding|Sample size', sortItems);
  await page.locator('.sb-art-pop .sb-art-item', { hasText: 'Year' }).click();
  const firstTitles = async () => (await texts(page, '.sb-art-title')).map((t) => t.slice(0, 12));
  check('sort by year starts with the newest (years run high to low)', (await firstTitles()).join('|') === 'Seasonal Mig|Foraging Str|A Unified Th|Voles, "Squi', await firstTitles());
  await page.locator('.sb-art-sort').click();
  await page.locator('.sb-art-pop .sb-art-item', { hasText: 'Year' }).click();
  check('choosing the same sort again reverses it', (await firstTitles())[0] === 'Voles, "Squi', await firstTitles());
  await page.locator('.sb-art-sort').click();
  await page.locator('.sb-art-pop .sb-art-item', { hasText: 'Citations' }).click();
  check('sort by citations puts the most cited first and rows with none last', (await firstTitles()).join('|') === 'Foraging Str|A Unified Th|Voles, "Squi|Seasonal Mig', await firstTitles());
  await page.locator('.sb-art-sort').click();
  await page.locator('.sb-art-pop .sb-art-item', { hasText: 'Sample size' }).click();
  check('sort by a column orders by its cell text', (await firstTitles())[0] === 'A Unified Th', await firstTitles());
  await page.locator('.sb-art-sort').click();
  await page.locator('.sb-art-pop .sb-art-item', { hasText: 'None' }).click();

  // row ticks + download
  await page.locator('.sb-art-row .sb-art-tick').nth(0).check();
  await page.locator('.sb-art-row .sb-art-tick').nth(3).check();
  check('ticking rows says how many are ticked', (await page.locator('.sb-art-ticks').textContent())?.includes('2 ticked'), await page.locator('.sb-art-ticks').textContent());
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Download"]').click();
  const downloads = await texts(page, '.sb-art-downloadmenu .sb-art-item-label');
  check('download menu: CSV, CSV with quotes, RIS (paper rows), Markdown', downloads.join('|') === 'CSV|CSV with quotes|RIS|Markdown', downloads);
  check('the menu names what it will export', (await page.locator('.sb-art-pop-head').textContent()) === '2 ticked rows', await page.locator('.sb-art-pop-head').textContent());
  await page.locator('.sb-art-downloadmenu .sb-art-item', { hasText: 'CSV with quotes' }).click();
  await page.waitForFunction(() => window.__sbA.host._saved.length === 1);
  const saved = await page.evaluate(() => window.__sbA.host._saved[0]);
  check('CSV with quotes saves the two ticked rows through host.saveFile, quotes included',
    saved.name === 'Vole foraging and hoarding.csv' && saved.mime === 'text/csv' && saved.text.trim().split('\r\n').length === 3 && saved.text.includes('Main finding quote'), { name: saved.name, mime: saved.mime, lines: saved.text.split('\r\n').length });
  await page.locator('.sb-art-clear').click();
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Download"]').click();
  await page.locator('.sb-art-downloadmenu .sb-art-item', { hasText: 'RIS' }).click();
  await page.waitForFunction(() => window.__sbA.host._saved.length === 2);
  const ris = await page.evaluate(() => window.__sbA.host._saved[1]);
  check('RIS saves every paper row', ris.name.endsWith('.ris') && (ris.text.match(/^TY {2}- JOUR/gm) ?? []).length === 4, ris.name);
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Download"]').click();
  await page.locator('.sb-art-downloadmenu .sb-art-item', { hasText: 'Markdown' }).click();
  await page.waitForFunction(() => window.__sbA.host._saved.length === 3);
  const md = await page.evaluate(() => window.__sbA.host._saved[2]);
  check('Markdown saves a table with footnotes', md.name.endsWith('.md') && md.text.includes('| Paper |') && md.text.includes('[^1]:'), md.name);

  // versions: menu, read-only old version, restore
  await page.locator('.sb-art-version').click();
  const versionRows = await texts(page, '.sb-art-versionmenu .sb-art-item-text');
  await page.waitForFunction(() => !document.querySelector('.sb-art-versionmenu')?.textContent.includes('Loading'));
  const versionText = (await texts(page, '.sb-art-versionmenu .sb-art-item-text')).join(' || ');
  check('version menu: V2 (latest) and V1, each with its change line', versionRows.length === 2 && versionText.includes('V2 (latest)') && versionText.includes('Added columns Main finding, Sample size') && versionText.includes('V1') && versionText.includes('Found papers'), versionText);
  await page.screenshot({ path: join(outDir, 'artifacts-version-menu.png') });
  await page.locator('.sb-art-versionmenu .sb-art-item', { hasText: 'Found papers' }).click();
  await page.waitForFunction(() => document.querySelector('.sb-art-banner:not([hidden])'));
  const oldView = await page.evaluate(() => ({ banner: document.querySelector('.sb-art-banner').textContent, heads: [...document.querySelectorAll('.sb-art-th')].map((e) => e.textContent), version: document.querySelector('.sb-art-version').textContent }));
  check('an older version is read-only with "Restore as V3"', oldView.banner.includes('older version') && oldView.banner.includes('Restore as V3') && oldView.heads.join('|') === 'Paper (4)|Abstract summary' && oldView.version.trim() === 'V1', oldView);
  await page.screenshot({ path: join(outDir, 'artifacts-old-version.png') });
  await page.locator('.sb-art-banner-btn.is-primary').click();
  await page.waitForFunction(() => document.querySelector('.sb-art-banner[hidden]'));
  const restored = await page.evaluate(() => ({ restores: window.__sbA.store.restores, version: document.querySelector('.sb-art-version').textContent, heads: [...document.querySelectorAll('.sb-art-th')].map((e) => e.textContent) }));
  check('restoring calls sessions.restore and shows the new latest (V3, the old content)', restored.restores.length === 1 && restored.restores[0].version === 1 && restored.version.trim() === 'V3' && restored.heads.join('|') === 'Paper (4)|Abstract summary', restored);
  const metasAfter = await texts(page, '.sb-art-card-meta');
  check('after a restore the paper-set card says a newer version exists', metasAfter[1] === 'Papers · 4 · 2 columns · V2 · a newer version exists', metasAfter);

  // expand and close
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Make this bigger"]').click();
  const expanded = await layout(page);
  check('expand makes the panel the main pane; expanding again swaps back', expanded.classes.includes('is-art-expanded') && !expanded.mainShown, expanded);
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Shrink back beside the chat"]').click();
  const back = await layout(page);
  check('…and back beside the chat', !back.classes.includes('is-art-expanded') && back.mainShown, back);
  await page.locator('.sb-art-head .sb-art-iconbtn[title="Close"]').click();
  check('close hides the panel and shows the thread', (await page.locator('.sb-ai-artifact').isHidden()) && (await layout(page)).mainShown, null);
  await page.close();

  // ---------------------------------------------------------------- drag handle: neither side goes under 360 px
  const dragPage = await open({ tokens: 'zotero', bare: '1' }, { width: 1300, height: 760 });
  await openCard(dragPage, 'Papers');
  const start = await layout(dragPage);
  const box = await dragPage.locator('.sb-ai-artifact-handle').boundingBox();
  const drag = async (toX) => {
    const b = await dragPage.locator('.sb-ai-artifact-handle').boundingBox();
    await dragPage.mouse.move(b.x + b.width / 2, b.y + 200);
    await dragPage.mouse.down();
    await dragPage.mouse.move(toX, b.y + 200, { steps: 6 });
    await dragPage.mouse.up();
    return layout(dragPage);
  };
  const farLeft = await drag(60);
  const farRight = await drag(1290);
  const sideWidth = await dragPage.evaluate(() => document.querySelector('.sb-ai-side').getBoundingClientRect().width);
  check('side by side at 1300: the panel starts at half the room beside the history list', Math.abs(start.pane - (1300 - sideWidth) / 2) <= 1.5 && box.width > 0, { start, sideWidth });
  check('drag handle: dragged far left the thread keeps 360 px, dragged far right the panel keeps 360 px', farLeft.main >= 359 && farLeft.pane >= 359 && farRight.pane >= 359 && farRight.pane <= 361 && farRight.main >= 359, { farLeft, farRight });
  await dragPage.close();

  // ---------------------------------------------------------------- widths: 960 / 700 / 360, measured
  const w960 = await open({ tokens: 'zotero', bare: '1' }, { width: 960, height: 760 });
  await openCard(w960, 'Papers');
  const l960 = await layout(w960);
  check('960 px: side by side, thread and panel each at least 360 px', l960.classes.includes('is-art-side') && l960.mainShown && l960.pane >= 359 && l960.main >= 359 && l960.docScroll <= l960.docClient, l960);
  await w960.close();
  const w959 = await open({ tokens: 'zotero', bare: '1' }, { width: 959, height: 760 });
  await openCard(w959, 'Papers');
  check('959 px: the panel covers the thread, "← Chat" shown, no × (the back button closes)', (await layout(w959)).classes.includes('is-art-cover') && (await w959.locator('.sb-art-back').isVisible()) && (await w959.locator('.sb-art-iconbtn[title="Close"]').count()) === 0, await layout(w959));
  await w959.locator('.sb-art-back').click();
  check('"← Chat" returns to the thread', (await w959.locator('.sb-ai-artifact').isHidden()) && (await layout(w959)).mainShown, null);
  await w959.close();
  const w700 = await open({ tokens: 'zotero', bare: '1' }, { width: 700, height: 760 });
  await openCard(w700, 'Papers');
  const l700 = await layout(w700);
  check('700 px: over the thread, table still a table, no horizontal page scroll', l700.classes.includes('is-art-cover') && !l700.mainShown && (await w700.locator('.sb-art-table').count()) === 1 && l700.docScroll <= l700.docClient, l700);
  await w700.close();
  const w360 = await open({ tokens: 'zotero', bare: '1' }, { width: 360, height: 780 });
  await openCard(w360, 'Papers');
  const l360 = await layout(w360);
  const cards = await w360.evaluate(() => [...document.querySelectorAll('.sb-art-rowcard')].map((c) => ({
    labels: [...c.querySelectorAll('.sb-art-field-label')].map((e) => e.textContent), fits: c.scrollWidth <= c.clientWidth })));
  check('360 px: full view, the table is a card list (one card per row, label + value per column)', l360.classes.includes('is-art-full') && (await w360.locator('.sb-art-table').count()) === 0
    && cards.length === 4 && cards.every((c) => c.labels.join('|') === 'Main finding|Sample size' && c.fits), { l360, cards });
  check('360 px measured: document, chat and panel body have no horizontal scroll', l360.docScroll <= l360.docClient && l360.rootScroll <= l360.rootClient && l360.bodyScroll <= l360.bodyClient, l360);
  // a row card's chip still opens its popover, inside the viewport
  await w360.locator('.sb-art-rowcard .sb-art-chip').first().click();
  const popBox = await w360.locator('.sb-art-pop').boundingBox();
  check('360 px: the chip popover stays inside the screen', popBox && popBox.x >= 0 && popBox.x + popBox.width <= 360, popBox);
  await w360.keyboard.press('Escape');
  await w360.locator('.sb-art-head .sb-art-version').click();
  const vBox = await w360.locator('.sb-art-pop').boundingBox();
  check('360 px: the version menu stays inside the screen', vBox && vBox.x >= 0 && vBox.x + vBox.width <= 360, vBox);
  await w360.screenshot({ path: join(outDir, 'artifacts-360-version-menu.png') });
  await w360.close();

  // ---------------------------------------------------------------- Download without host.saveFile: a Blob download, CSV
  const blobPage = await open({ tokens: 'zotero', w: '1100', nosave: '1' }, { width: 1132, height: 760 });
  await openCard(blobPage, 'Papers');
  await blobPage.locator('.sb-art-head .sb-art-iconbtn[title="Download"]').click();
  const blobItems = await texts(blobPage, '.sb-art-downloadmenu .sb-art-item-label');
  const [download] = await Promise.all([
    blobPage.waitForEvent('download'),
    blobPage.locator('.sb-art-downloadmenu .sb-art-item').filter({ has: blobPage.getByText('CSV', { exact: true }) }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  check('no host.saveFile and no exportRows: CSV still downloads through a Blob', download.suggestedFilename() === 'Vole foraging and hoarding.csv' && csv.startsWith('Title,Authors,Year,Venue,DOI,In library,Main finding,Sample size') && blobItems.includes('CSV'),
    { name: download.suggestedFilename(), head: csv.slice(0, 60), blobItems });
  await blobPage.close();

  // ---------------------------------------------------------------- the streamed sb-table block, then a card
  const sp = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const streamed = await sp.evaluate(async () => {
    const { build, controlled } = window.__sbA;
    const ctl = controlled();
    const ctx = build({ reply: () => ctl.iter });
    const chat = new SecondBrainUI.ChatView(ctx.host, document);
    document.body.append(chat.root);
    chat.root.id = 'chat2';
    chat.root.style.cssText = 'height:640px;width:900px';
    const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    chat.input.value = 'Make a table of the vole models';
    const sent = chat.submit();
    await wait(200);
    const text = () => (answerRoot().querySelector('.sb-ai-md') ?? answerRoot().querySelector('.sb-ai-text'))?.textContent ?? '';
    const answerRoot = () => [...chat.thread.querySelectorAll(':scope > .sb-ai-answer')].pop();
    ctl.push({ type: 'text', delta: 'Here is a table of the models.\n\n```sb-t' });
    await wait(120);
    out.halfFence = text();
    ctl.push({ type: 'text', delta: 'able\n{ "title": "New models", "columns": ["A"],\n' });
    await wait(120);
    out.open = { text: text(), making: answerRoot().querySelector('.sb-ai-making')?.textContent ?? null };
    ctl.push({ type: 'text', delta: '"rows": [] }\n```\n\nThat is all.' });
    await wait(120);
    out.closed = { text: text(), making: answerRoot().querySelector('.sb-ai-making')?.textContent ?? null };
    // the engine wrote the table before `done`
    const version = { kind: 'table', ref: { id: 'R3', version: 1 }, title: 'New models', created: '2026-09-29T09:00:00.000Z', change: 'Made from the chat', columns: [{ id: 'a', name: 'A', instruction: '', kind: 'text' }], rows: [{ id: 'x:1', label: 'Row one', paper: null }], cells: { 'x:1': { a: { state: 'filled', value: 'Cell', quotes: [], citations: [] } } } };
    ctx.store.results.R3 = [version];
    ctl.push({ type: 'result', step: 'S9', summary: { ref: { id: 'R3', version: 1 }, kind: 'table', title: 'New models', versions: 1, rows: 1, columns: ['A'], updated: version.created } });
    ctl.push({ type: 'done', answer: { text: 'Here is a table of the models.\n\nThat is all.', citations: [], structured: null, usage: {} } });
    ctl.end();
    await sent;
    out.done = { text: text(), making: answerRoot().querySelector('.sb-ai-making')?.textContent ?? null, cards: [...answerRoot().querySelectorAll('.sb-art-card-meta')].map((e) => e.textContent), button: chat.artifactsButton.textContent };
    return out;
  });
  check('streaming: half a fence ("```sb-t") is held back, not shown', !streamed.halfFence.includes('`') && streamed.halfFence.includes('Here is a table'), streamed.halfFence);
  check('streaming: an open sb-table block is hidden and "Making a table…" is shown', !streamed.open.text.includes('sb-table') && !streamed.open.text.includes('"title"') && streamed.open.making === 'Making a table…', streamed.open);
  check('streaming: the closed block stays hidden, the text after it shows', !streamed.closed.text.includes('sb-table') && !streamed.closed.text.includes('"rows"') && streamed.closed.text.includes('That is all.') && streamed.closed.making === 'Making a table…', streamed.closed);
  check('a `result` event adds a card under the answer and the header count; the placeholder goes at `done`',
    streamed.done.making === null && streamed.done.cards.join('|') === 'Table · 1 row · V1' && streamed.done.button === 'Artifacts (3)', streamed.done);
  await sp.locator('#chat2 .sb-art-card').click();
  await sp.waitForSelector('#chat2 .sb-art-table');
  check('the new card opens the new table in the panel', (await sp.locator('#chat2 .sb-art-head-text').textContent()) === 'New models' && (await sp.locator('#chat2 .sb-art-row').count()) === 1, await sp.locator('#chat2 .sb-art-head-text').textContent());
  await sp.close();

  const noticePage = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const notice = await noticePage.evaluate(async () => {
    const { build, controlled } = window.__sbA;
    const ctl = controlled();
    const ctx = build({ reply: () => ctl.iter });
    const chat = new SecondBrainUI.ChatView(ctx.host, document);
    document.body.append(chat.root);
    chat.root.id = 'chat2';
    chat.root.style.cssText = 'height:640px;width:900px';
    chat.input.value = 'Make a table';
    const sent = chat.submit();
    await new Promise((r) => setTimeout(r, 200));
    ctl.push({ type: 'done', notice: "Couldn't turn this into a table", answer: { text: '| A |\n| --- |\n| 1 |', citations: [], structured: null, usage: {} } });
    ctl.end();
    await sent;
    const last = [...chat.thread.querySelectorAll(':scope > .sb-ai-answer')].pop();
    return { notice: last.querySelector('.sb-ai-notice')?.textContent, table: last.querySelectorAll('table').length, cards: last.querySelectorAll('.sb-art-card').length };
  });
  check('a malformed table block: the answer stays a Markdown table and the notice shows', notice.notice === "Couldn't turn this into a table" && notice.table === 1 && notice.cards === 0, notice);
  await noticePage.close();

  // ---------------------------------------------------------------- Find papers writes its result
  const fp = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  const found = await fp.evaluate(async () => {
    const { build } = window.__sbA;
    const ctx = build({});
    const chat = new SecondBrainUI.ChatView(ctx.host, document);
    document.body.append(chat.root);
    chat.root.id = 'chat3';
    chat.root.style.cssText = 'height:640px;width:900px';
    chat.setMode('find');
    chat.input.value = 'vole foraging';
    await chat.submit();
    const put = ctx.store.puts[0];
    const savedFiles = await ctx.host.files.list('searches');
    const saved = JSON.parse(await ctx.host.files.read(savedFiles[0]));
    const out = {
      puts: ctx.store.puts.length, input: put?.input, kind: put?.draft.kind, ids: put?.draft.rows.map((r) => r.id), refs: put?.draft.rows.map((r) => r.ref.kind),
      columns: put?.draft.columns.length, change: put?.draft.change, query: put?.draft.query, summary: put?.draft.summary, inLibrary: put?.draft.rows.map((r) => r.inLibrary),
      savedSession: saved.session, button: chat.artifactsButton.textContent, hidden: chat.artifactsButton.hidden, tableRows: chat.thread.querySelectorAll('.sb-fp-row').length,
    };
    // an old saved search (no session) opens exactly as before: no artifacts
    await ctx.host.files.write('searches/find-old.json', JSON.stringify({ id: 'find-old', query: 'old search', at: '2026-01-01T00:00:00.000Z', scope: { kind: 'library' }, sources: { library: true, scholarly: true }, failed: [],
      rows: [{ title: 'Old paper', authors: ['O. Author'], year: 2020, venue: 'Old Venue', doi: null, abstract: 'Old.', key: 'K9', citekey: 'author2020', sources: ['Your library'] }], summary: null }));
    await chat.openFind('find-old');
    out.old = { hidden: chat.artifactsButton.hidden, rows: chat.thread.querySelectorAll('.sb-fp-row').length, session: chat.sessionID };
    // …and the search we just made reopens with its result available
    await chat.openFind(savedFiles[0].replace(/^searches\//, '').replace(/\.json$/, ''));
    await new Promise((r) => setTimeout(r, 100));
    out.reopened = { hidden: chat.artifactsButton.hidden, text: chat.artifactsButton.textContent, session: chat.sessionID };
    window.__fpChat = chat;
    return out;
  });
  check('Find papers: a new search calls sessions.put with a find step and a PapersResult of its rows',
    found.puts === 1 && found.input.kind === 'find' && found.input.query === 'vole foraging' && found.kind === 'papers' && found.ids.length === 2 && new Set(found.ids).size === 2 && found.columns === 0 && found.change === 'Found papers' && found.query === 'vole foraging', found);
  check('Find papers: outside papers map to web refs (DOI link), not in the library, summary carried over', found.refs.every((k) => k === 'web') && found.inLibrary.every((v) => v === false) && found.summary?.markdown === 'ok', found);
  check('Find papers: the saved search remembers its session; the header offers "Artifacts (1)"; the old table is still in the thread', found.savedSession === 'conv1' && found.button === 'Artifacts (1)' && found.hidden === false && found.tableRows === 2, found);
  check('Find papers: an old saved search (no session) opens as before, with no artifacts', found.old.hidden === true && found.old.rows === 1 && found.old.session === null, found.old);
  check('Find papers: reopening a search that has a session lists its result', found.reopened.session === 'conv1' && found.reopened.hidden === false && found.reopened.text === 'Artifacts (3)' /* the fake store answers for every session */, found.reopened);
  await fp.evaluate(async () => { const chat = window.__fpChat; await chat.openArtifact({ id: 'R3' }); });
  await fp.waitForSelector('#chat3 .sb-art-table');
  check('Find papers: the result opens in the panel as a table of its papers', (await fp.locator('#chat3 .sb-art-row').count()) === 2 && (await fp.locator('#chat3 .sb-art-th').first().textContent())?.includes('Paper (2)'), await texts(fp, '#chat3 .sb-art-th'));
  await fp.close();

  return { failures, count };
}
