// ui-src/dev/columns-checks.mjs. Playwright checks for spec 007 E4 (Columns panel, live fill, Stop / "Fill the rest",
// Filters, "Keep these N", the narrow sheets), run by dev/run.mjs against dev/harness/artifacts.html with the fake
// engine in dev/harness/fake-host.js. Screenshots go to dev/out/ (git-ignored). Invented papers only.
import { join } from 'node:path';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runColumnChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} columns: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const url = (query) => `http://127.0.0.1:${port}/dev/harness/artifacts.html?${new URLSearchParams(query)}`;
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
  const texts = (page, selector) => page.locator(selector).allTextContents();
  /** Adds an invented paper set of `n` papers to the fake session and opens it in the panel. */
  async function openSet(page, n, id = 'R9', bare = false) {
    await page.evaluate(async ({ n, id, bare }) => {
      const m = await import('/test/fixtures/artifacts.js');
      const { chat, store } = window.__sbA;
      const result = bare ? m.bareRows() : m.bigPapers(n, id);
      result.ref.id = id;
      store.results[id] = [result];
      chat.noteArtifact({ ref: result.ref, kind: 'papers', title: result.title, versions: 1, rows: result.rows.length, columns: [], updated: result.created });
      await chat.openArtifact({ id });
    }, { n, id, bare });
    await page.waitForSelector('.sb-art-table, .sb-art-cardlist');
  }
  const layout = (page) => page.evaluate(() => {
    const root = document.querySelector('.sb-ai');
    const body = document.querySelector('.sb-art-body');
    const sheet = document.querySelector('.sb-art-sheet');
    const sheetBody = document.querySelector('.sb-art-sheet-body');
    const box = sheet?.getBoundingClientRect();
    return {
      docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
      rootScroll: root.scrollWidth, rootClient: root.clientWidth, bodyScroll: body?.scrollWidth ?? 0, bodyClient: body?.clientWidth ?? 0,
      sheet: box ? { x: box.x, width: box.width, scroll: sheet.scrollWidth, client: sheet.clientWidth, bodyScroll: sheetBody.scrollWidth, bodyClient: sheetBody.clientWidth } : null,
    };
  });
  const classTree = (page, selector) => page.evaluate((sel) => {
    const walk = (node) => (node.nodeType !== 1 ? null : { tag: node.tagName.toLowerCase(), cls: [...node.classList].sort(), kids: [...node.childNodes].map(walk).filter(Boolean) });
    return walk(document.querySelector(sel));
  }, selector);
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitVersion = (page, v) => page.waitForFunction((want) => document.querySelector('.sb-art-version')?.textContent.trim() === `V${want}` && !document.querySelector('.sb-art-runbar:not([hidden]) .sb-art-stop'), v, { timeout: 12000 });

  // ================================================================ 1. a preset column: confirm-free run, skeletons, cells fill, V2
  const page = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await page.evaluate(() => { window.__sbA.store.cellDelay = 25; });
  await openSet(page, 40);
  const tools = await texts(page, '.sb-art-toolbar .sb-art-tool-label');
  check('a paper set offers Filters and Columns next to Search and Sort', tools.join('|') === 'Filters|Columns', tools);
  await page.locator('.sb-art-columns').click();
  await page.waitForSelector('.sb-col-pop');
  const label = await page.locator('.sb-col-label').textContent();
  const placeholder = await page.locator('.sb-col-input').getAttribute('placeholder');
  const presets = await texts(page, '.sb-col-row.is-preset .sb-col-row-text');
  check('Columns: "Search or create a column", a plain example, then the nine presets as quiet "+" rows',
    label === 'Search or create a column' && placeholder === 'e.g. Limitations, Survival time' && presets.join('|') === 'Summary|Main findings|Methodology|Intervention|Outcome measured|Limitations|Sample|Study type|Population'
    && (await page.locator('.sb-col-current .sb-col-item').count()) === 0 && !(await page.locator('.sb-col-pop').textContent())?.includes('Current columns'), { label, placeholder, presets });
  const hover = await page.locator('.sb-col-row.is-preset', { hasText: 'Methodology' }).getAttribute('title');
  check('a preset carries its instruction on hover', hover === 'How the study was done: its design, data and methods.', hover);
  await page.screenshot({ path: join(outDir, 'columns-popover.png') });
  await page.locator('.sb-col-input').fill('limi');
  const narrowed = await texts(page, '.sb-col-row .sb-col-row-text');
  check('typing narrows the presets and offers to create a column from the text as typed', narrowed.join('|') === 'Add “limi”|Limitations', narrowed);
  await page.locator('.sb-col-input').fill('');
  await page.locator('.sb-col-row.is-preset', { hasText: 'Summary' }).click();
  check('a preset is staged ("Ready to add"), leaves the list, and offers "Fill 1 column"',
    (await texts(page, '.sb-col-chip-text')).join('|') === 'Summary' && !(await texts(page, '.sb-col-row.is-preset')).includes('Summary') && (await page.locator('.sb-col-fill').textContent()) === 'Fill 1 column', await texts(page, '.sb-col-staged'));
  await page.locator('.sb-col-fill').click();
  await page.waitForFunction(() => window.__sbA.store.runs.length === 1);
  const first = await page.evaluate(() => ({ est: window.__sbA.store.estimates[0], run: window.__sbA.store.runs[0].input }));
  check('40 papers ask nothing first: estimate, then run with the preset spec, all rows, abstract text',
    first.est.rows === 'all' && first.run.kind === 'columns' && first.run.on.id === 'R9' && first.run.rows === 'all' && first.run.text === 'abstract' && first.run.add.length === 1
    && first.run.add[0].name === 'Summary' && first.run.add[0].preset === 'summary' && first.run.add[0].instruction.startsWith('A two-sentence summary'), first);
  await page.waitForFunction(() => document.querySelectorAll('.sb-art-value').length >= 4);
  const mid = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('.sb-art-th')].map((e) => e.textContent), skeleton: document.querySelectorAll('.sb-art-skel-bar').length, values: document.querySelectorAll('.sb-art-value').length,
    run: document.querySelector('.sb-art-runtext')?.textContent, stop: Boolean(document.querySelector('.sb-art-stop')), version: document.querySelector('.sb-art-version').textContent.trim(),
    popover: document.querySelector('.sb-col-pop') !== null,
  }));
  await page.screenshot({ path: join(outDir, 'columns-filling.png') });
  check('live fill: the new column appears at once, still-empty cells are skeleton bars, filled cells replace them one by one',
    mid.heads.join('|') === 'Paper (40)|Summary' && mid.skeleton > 0 && mid.values >= 4 && mid.values < 40 && mid.version === 'V1' && !mid.popover, mid);
  check('a progress line says what is filling and how far ("Filling 1 column · 12 of 40"), with Stop', /^Filling 1 column · \d+ of 40$/.test(mid.run ?? '') && mid.stop, mid);
  await waitVersion(page, 2);
  const end = await page.evaluate(() => ({
    skeleton: document.querySelectorAll('.sb-art-skel-bar').length, runbar: document.querySelector('.sb-art-runbar').hidden, values: document.querySelectorAll('.sb-art-value').length,
    notFound: [...document.querySelectorAll('.sb-art-note')].map((e) => e.textContent), dashed: document.querySelectorAll('.sb-art-value.is-unverified').length,
    unverifiedChips: document.querySelectorAll('.sb-art-chip-unverified').length, versions: window.__sbA.store.results.R9.length, card: [...document.querySelectorAll('.sb-art-card-meta')].map((e) => e.textContent),
    button: document.querySelector('.sb-ai-artifacts-button').textContent,
  }));
  check('done: the panel shows the new version V2 with every cell filled; progress line gone', end.skeleton === 0 && end.runbar && end.versions === 2 && end.values + end.notFound.length === 40, end);
  check('not-found cells read "Not reported in the abstract"; a value with no verified quote gets a dashed underline and its chip says Unverified',
    end.notFound.length > 0 && end.notFound.every((t) => t === 'Not reported in the abstract') && end.dashed > 0 && end.unverifiedChips > 0, end);
  const listed = await page.evaluate(() => window.__sbA.chat.artifacts.find((a) => a.ref.id === 'R9'));
  check('the chat\'s artifact list follows to V2 with the new column', listed.ref.version === 2 && listed.columns.join() === 'Summary' && listed.rows === 40, listed);
  await page.screenshot({ path: join(outDir, 'columns-done.png') });
  check('no console or page errors while filling', page.errors.length === 0, page.errors);

  // a failed cell's small retry, and a stored version with pending cells offers "Fill the rest"
  await page.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R1' }); });
  await page.waitForFunction(() => document.querySelector('.sb-art-head-text')?.textContent === 'Vole foraging and hoarding');
  check('a stored version with a pending cell says how far it got and offers "Fill the rest"; a failed cell has a small Retry',
    (await page.locator('.sb-art-runtext').textContent()) === '7 of 8 done' && (await page.locator('.sb-art-fillrest').count()) === 1 && (await page.locator('.sb-art-retry').count()) === 1, await page.locator('.sb-art-runbar').textContent());
  await page.locator('.sb-art-retry').click();
  await page.waitForFunction(() => window.__sbA.store.runs.length === 2);
  const retryRun = await page.evaluate(() => window.__sbA.store.runs[1].input);
  check('Retry adds that one column again for that one row (the engine replaces an existing column)', retryRun.add.length === 1 && retryRun.add[0].id === 'sample-size' && Array.isArray(retryRun.rows) && retryRun.rows.join() === 't:seasonal-migration-of-burrowing-owls', retryRun);
  await waitVersion(page, 3);
  check('…and V3 has no failed cell left', (await page.locator('.sb-art-fail').count()) === 0 && (await page.locator('.sb-art-retry').count()) === 0, null);

  // ================================================================ reorder and remove
  await page.locator('.sb-art-columns').click();
  const items = await texts(page, '.sb-col-item-name');
  const instruction = await page.locator('.sb-col-item').first().getAttribute('title');
  check('Current columns lists each column, its instruction on hover', items.join('|') === 'Main finding|Sample size' && instruction === 'What is the main finding?', { items, instruction });
  await page.locator('.sb-col-item').nth(1).dragTo(page.locator('.sb-col-item').nth(0));
  const order = await page.evaluate(() => window.__sbA.host.prefs.get('artifactView:conv1:R1')?.order);
  check('drag to reorder: the table follows at once and the order is view state in prefs (no new version)',
    JSON.stringify(order) === '["sample-size","main-finding"]' && (await texts(page, '.sb-art-th')).join('|') === 'Paper (4)|Sample size|Main finding' && (await page.locator('.sb-art-version').textContent())?.trim() === 'V3', { order });
  await page.locator('.sb-col-item').first().locator('.sb-col-grip').focus();
  await page.keyboard.press('ArrowDown');
  check('the grip moves a column with the arrow keys too', (await texts(page, '.sb-col-item-name')).join('|') === 'Main finding|Sample size', await texts(page, '.sb-col-item-name'));
  await page.locator('.sb-col-item', { hasText: 'Sample size' }).locator('.sb-col-x').click();
  await page.waitForFunction(() => document.querySelector('.sb-art-version').textContent.trim() === 'V4');
  const removed = await page.evaluate(() => ({ put: window.__sbA.store.puts.at(-1), heads: [...document.querySelectorAll('.sb-art-th')].map((e) => e.textContent), v3: window.__sbA.store.results.R1[2].columns.length }));
  check('removing a column writes a version without it (V4); V3 still has both', removed.put.draft.change === 'Removed column Sample size' && removed.put.draft.columns.length === 1 && removed.heads.join('|') === 'Paper (4)|Main finding' && removed.v3 === 2, removed);
  await page.close();

  // ================================================================ 2. the confirm line for 120 papers, Continue / Only the first 50
  const big = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await big.evaluate(() => { window.__sbA.store.cellDelay = 4; });
  await openSet(big, 120, 'R10');
  await big.locator('.sb-art-columns').click();
  for (const name of ['Summary', 'Limitations', 'Sample']) await big.locator('.sb-col-row.is-preset', { hasText: name }).first().click();
  check('three presets are staged: "Fill 3 columns"', (await big.locator('.sb-col-fill').textContent()) === 'Fill 3 columns' && (await big.locator('.sb-col-chip').count()) === 3, null);
  await big.locator('.sb-col-fill').click();
  await big.waitForSelector('.sb-col-confirm');
  const confirmText = await big.locator('.sb-col-confirm').textContent();
  const confirmButtons = await texts(big, '.sb-col-actions .sb-col-btn');
  check('120 papers x 3 columns asks first, in one line: "Fill 3 columns for 120 papers? About 15 turns." with Continue / Only the first 50',
    confirmText === 'Fill 3 columns for 120 papers? About 15 turns.' && confirmButtons.join('|') === 'Continue|Only the first 50|Not now' && (await big.evaluate(() => window.__sbA.store.runs.length)) === 0, { confirmText, confirmButtons });
  await big.screenshot({ path: join(outDir, 'columns-confirm.png') });
  await big.locator('.sb-col-btn', { hasText: 'Not now' }).click();
  check('"Not now" goes back to the staged list, nothing has run', (await big.locator('.sb-col-fill').count()) === 1 && (await big.evaluate(() => window.__sbA.store.runs.length)) === 0, null);
  await big.locator('.sb-col-fill').click();
  await big.waitForSelector('.sb-col-confirm');
  await big.locator('.sb-col-btn', { hasText: 'Only the first 50' }).click();
  await big.waitForFunction(() => window.__sbA.store.runs.length === 1);
  const only = await big.evaluate(() => ({ rows: window.__sbA.store.runs[0].input.rows, add: window.__sbA.store.runs[0].input.add.length }));
  check('"Only the first 50" runs exactly the first 50 rows in view order, all three columns', Array.isArray(only.rows) && only.rows.length === 50 && only.rows[0] === 'x:1' && only.rows[49] === 'x:50' && only.add === 3, only);
  await waitVersion(big, 2);
  check('the rest waits, honestly: "150 of 360 done" with "Fill the rest"', (await big.locator('.sb-art-runtext').textContent()) === '150 of 360 done' && (await big.locator('.sb-art-fillrest').count()) === 1, await big.locator('.sb-art-runtext').textContent());
  await big.locator('.sb-art-fillrest').click();
  await big.waitForFunction(() => window.__sbA.store.runs.length === 2);
  const restRun = await big.evaluate(() => window.__sbA.store.runs[1].input);
  check('"Fill the rest" after a limited step asks for the 70 rows it never touched, with the three columns',
    Array.isArray(restRun.rows) && restRun.rows.length === 70 && restRun.rows[0] === 'x:51' && restRun.add.map((c) => c.name).join() === 'Summary,Limitations,Sample', restRun);
  await waitVersion(big, 3);
  check('…and 360 of 360 are filled, the banner is gone', (await big.locator('.sb-art-runbar').isHidden()) && (await big.locator('.sb-art-skel-bar').count()) === 0, null);
  // ticked rows are what "which rows" means when any are ticked
  await big.locator('.sb-art-row .sb-art-tick').nth(2).check();
  await big.locator('.sb-art-row .sb-art-tick').nth(5).check();
  await big.locator('.sb-art-columns').click();
  await big.locator('.sb-col-row.is-preset', { hasText: 'Population' }).click();
  await big.locator('.sb-col-fill').click();
  await big.waitForFunction(() => window.__sbA.store.runs.length === 3);
  const ticked = await big.evaluate(() => window.__sbA.store.runs[2].input.rows);
  check('with rows ticked, only those rows are filled', Array.isArray(ticked) && ticked.join() === 'x:3,x:6', ticked);
  await waitVersion(big, 4);
  await big.close();

  // ================================================================ 3. Stop, then "Fill the rest" fills only what's missing
  const stop = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await stop.evaluate(() => { window.__sbA.store.cellDelay = 40; });
  await openSet(stop, 40, 'R11');
  await stop.locator('.sb-art-columns').click();
  await stop.locator('.sb-col-row.is-preset', { hasText: 'Methodology' }).click();
  await stop.locator('.sb-col-row.is-preset', { hasText: 'Outcome measured' }).click();
  await stop.locator('.sb-col-fill').click();
  await stop.waitForFunction(() => /· \d+ of 80$/.test(document.querySelector('.sb-art-runtext')?.textContent ?? '') && document.querySelectorAll('.sb-art-value').length >= 8);
  await stop.locator('.sb-art-stop').click();
  check('Stop calls cancel for that step', (await stop.evaluate(() => window.__sbA.store.cancels.length)) === 1, null);
  await waitVersion(stop, 2);
  const stopped = await stop.evaluate(() => {
    const text = document.querySelector('.sb-art-runtext').textContent;
    const filled = document.querySelectorAll('.sb-art-value').length + document.querySelectorAll('.sb-art-note').length;
    return { text, filled, skeleton: document.querySelectorAll('.sb-art-skel-bar').length / 3, fill: document.querySelectorAll('.sb-art-fillrest').length, versions: window.__sbA.store.results.R11.length };
  });
  await stop.screenshot({ path: join(outDir, 'columns-stopped.png') });
  const done = Number(/^Stopped - (\d+) of 80 done$/.exec(stopped.text)?.[1] ?? -1);
  check('after Stop: "Stopped - 24 of 80 done" (here N of 80), the cells that arrived are kept, the rest stay skeleton, "Fill the rest" is offered',
    done > 0 && done < 80 && stopped.filled === done && stopped.skeleton === 80 - done && stopped.fill === 1 && stopped.versions === 2, { stopped, done });
  await stop.evaluate(() => { window.__sbA.store.cellDelay = 4; });
  await stop.locator('.sb-art-fillrest').click();
  await stop.waitForFunction(() => window.__sbA.store.runs.length === 2);
  const rest = await stop.evaluate(() => window.__sbA.store.runs[1].input);
  check('"Fill the rest" runs rows "pending" with no new columns', rest.rows === 'pending' && rest.add.length === 0, rest);
  await waitVersion(stop, 3);
  const after = await stop.evaluate(() => ({ cellEvents: window.__sbA.store.steps[window.__sbA.store.runs[1].step].events.filter((e) => e.data.type === 'cell').length, skeleton: document.querySelectorAll('.sb-art-skel-bar').length, banner: document.querySelector('.sb-art-runbar').hidden }));
  check('…it fills only the missing cells (80 minus those already done), then V3 is complete and the banner is gone', after.cellEvents === 80 - done && after.skeleton === 0 && after.banner, { after, done });
  await stop.close();

  // ================================================================ 4. Filters: only what the rows carry, Cancel / Apply, chips, "Keep these N"
  const fp = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await openSet(fp, 40);
  await fp.locator('.sb-art-filters').click();
  await fp.waitForSelector('.sb-flt-pop');
  const sections = await texts(fp, '.sb-flt-title');
  const studyTypes = await texts(fp, '.sb-flt-sec:has(.sb-flt-title:text-is("Study type")) .sb-flt-check');
  check('Filters shows only what these rows carry: full text, dates, study type (values present), abstract words, where it is; not Screening or Column value',
    sections.join('|') === 'Full text|Publication date|Study type|Abstract keywords|Where it is' && studyTypes.join('|') === 'Review|Systematic review|Meta-analysis|RCT|Longitudinal', { sections, studyTypes });
  check('no Journal quality control (not built)', !(await fp.locator('.sb-flt-pop').textContent())?.toLowerCase().includes('journal quality'), null);
  await fp.screenshot({ path: join(outDir, 'filters-popover.png') });
  await fp.locator('.sb-flt-check.is-toggle input').check();
  await fp.locator('.sb-flt-btn', { hasText: 'Cancel' }).click();
  check('Cancel changes nothing', (await fp.locator('.sb-art-fchip').count()) === 0 && (await fp.locator('.sb-art-row').count()) === 40, null);
  await fp.locator('.sb-art-filters').click();
  await fp.locator('.sb-flt-check.is-toggle input').check();
  await fp.locator('.sb-flt-years input').nth(0).fill('2020');
  await fp.locator('.sb-flt-years input').nth(1).fill('2026');
  await fp.locator('.sb-flt-add input').nth(0).fill('Acorns');
  await fp.locator('.sb-flt-add .sb-flt-btn').nth(0).click();
  check('an abstract word is added as a small pill', (await texts(fp, '.sb-flt-word')).join('|').startsWith('Acorns'), await texts(fp, '.sb-flt-word'));
  await fp.locator('.sb-flt-btn.is-primary', { hasText: 'Apply' }).click();
  const expected = [...Array(40).keys()].filter((i) => i % 3 === 0 && 2015 + (i % 12) >= 2020 && i % 5 === 0).length;
  const chipsText = await texts(fp, '.sb-art-fchip-text');
  check('Apply narrows the rows (has PDF, 2020-2026, abstract has "Acorns"), shows removable chips and "Showing N of 40"',
    chipsText.join('|') === 'Has PDF|2020-2026|Abstract has “Acorns”' && (await fp.locator('.sb-art-row').count()) === expected && (await fp.locator('.sb-art-count').first().textContent()) === `Showing ${expected} of 40` && expected > 0, { chipsText, expected, rows: await fp.locator('.sb-art-row').count() });
  await fp.screenshot({ path: join(outDir, 'filters-applied.png') });
  const saved = await fp.evaluate(() => window.__sbA.host.prefs.get('artifactView:conv1:R9'));
  check('the filters are view state in host prefs, not a version', saved?.filters?.hasPdf === true && saved.filters.yearFrom === 2020 && (await fp.evaluate(() => window.__sbA.store.results.R9.length)) === 1, saved);
  await fp.locator('.sb-art-fchip', { hasText: 'Has PDF' }).locator('.sb-art-fchip-x').click();
  const looser = await fp.locator('.sb-art-row').count();
  check('removing a chip widens the rows again', looser > expected && (await texts(fp, '.sb-art-fchip-text')).join('|') === '2020-2026|Abstract has “Acorns”', { looser });
  await fp.locator('.sb-art-fchip', { hasText: 'Has PDF' }).count();
  // reopen: the view comes back
  await fp.evaluate(async () => { await window.__sbA.chat.openArtifact({ id: 'R1' }); await window.__sbA.chat.openArtifact({ id: 'R9' }); });
  await fp.waitForSelector('.sb-art-table');
  check('closing and reopening the result brings the filters back', (await texts(fp, '.sb-art-fchip-text')).join('|') === '2020-2026|Abstract has “Acorns”' && (await fp.locator('.sb-art-row').count()) === looser, null);
  await fp.locator('.sb-art-fchip-x').first().click();
  await fp.locator('.sb-art-filters').click();
  await fp.locator('.sb-flt-check.is-toggle input').check();
  await fp.locator('.sb-flt-btn.is-primary', { hasText: 'Apply' }).click();
  const expected2 = [...Array(40).keys()].filter((i) => i % 15 === 0).length; // has PDF (every 3rd) and mentions acorns (every 5th)
  const keepButton = await fp.locator('.sb-art-keep').textContent();
  check('"Keep these N" appears with the count of rows on screen', keepButton === `Keep these ${expected2}`, keepButton);
  await fp.locator('.sb-art-keep').click();
  await fp.waitForFunction(() => document.querySelector('.sb-art-head-text')?.textContent.includes('kept'));
  const kept = await fp.evaluate(() => { const p = window.__sbA.store.puts.at(-1); return { input: p.input, why: p.input.why, n: p.draft.rows.length, head: document.querySelector('.sb-art-head-text').textContent, rows: document.querySelectorAll('.sb-art-row').length, button: document.querySelector('.sb-ai-artifacts-button').textContent }; });
  check('Keep these N writes a `narrow` step (kept ids, why listing the filters) and opens the new paper set',
    kept.input.kind === 'narrow' && kept.input.on.id === 'R9' && kept.input.keep.length === expected2 && kept.why === `Kept ${expected2} of 40: has PDF, abstract has “Acorns”` && kept.n === expected2
    && kept.head === `Invented set of 40 (${expected2} kept)` && kept.rows === expected2, kept);
  await fp.close();

  // filters that the data can't support are not offered at all
  const bare = await open({ tokens: 'zotero', w: '1100' }, { width: 1132, height: 800 });
  await openSet(bare, 4, 'R8', true);
  const bareTools = await texts(bare, '.sb-art-toolbar .sb-art-tool-label');
  check('rows with no PDF, dates, study type or abstract offer no Filters button at all (only Columns)', bareTools.join('|') === 'Columns', bareTools);
  await bare.close();

  // ================================================================ 5. narrow: Filters and Columns are full sheets, no horizontal scroll at 360
  const narrow = await open({ tokens: 'zotero', bare: '1' }, { width: 360, height: 780 });
  await narrow.evaluate(() => { window.__sbA.store.cellDelay = 40; });
  await openSet(narrow, 40);
  await narrow.locator('.sb-art-columns').click();
  await narrow.waitForSelector('.sb-art-sheet');
  await narrow.locator('.sb-col-row.is-preset', { hasText: 'Limitations' }).click();
  const colSheet = await layout(narrow);
  await narrow.screenshot({ path: join(outDir, 'columns-360-sheet.png') });
  check('360 px: Columns opens as a full sheet, measured inside the screen with no horizontal scroll',
    colSheet.sheet && colSheet.sheet.x === 0 && colSheet.sheet.width === 360 && colSheet.sheet.scroll <= colSheet.sheet.client && colSheet.sheet.bodyScroll <= colSheet.sheet.bodyClient && colSheet.docScroll <= colSheet.docClient, colSheet);
  await narrow.locator('.sb-col-fill').click();
  await narrow.waitForFunction(() => document.querySelectorAll('.sb-art-value').length >= 2);
  const running = await layout(narrow);
  await narrow.screenshot({ path: join(outDir, 'columns-360-filling.png') });
  check('360 px: the sheet closes on Fill; the progress line and the filling cards fit with no horizontal scroll',
    running.sheet === null && running.docScroll <= running.docClient && running.rootScroll <= running.rootClient && running.bodyScroll <= running.bodyClient
    && (await narrow.locator('.sb-art-runtext').textContent())?.startsWith('Filling 1 column'), running);
  await narrow.locator('.sb-art-stop').click();
  await waitVersion(narrow, 2);
  await narrow.locator('.sb-art-filters').click();
  await narrow.waitForSelector('.sb-art-sheet');
  await narrow.locator('.sb-flt-add input').nth(0).fill('acorns');
  await narrow.locator('.sb-flt-add .sb-flt-btn').nth(0).click();
  const fltSheet = await layout(narrow);
  await narrow.screenshot({ path: join(outDir, 'filters-360-sheet.png') });
  const sections360 = await texts(narrow, '.sb-flt-title');
  check('360 px: Filters opens as a full sheet with the same sections (Column value now too), no horizontal scroll',
    fltSheet.sheet && fltSheet.sheet.width === 360 && fltSheet.sheet.bodyScroll <= fltSheet.sheet.bodyClient && fltSheet.docScroll <= fltSheet.docClient && sections360.includes('Column value'), { fltSheet, sections360 });
  await narrow.locator('.sb-flt-btn.is-primary', { hasText: 'Apply' }).click();
  await narrow.waitForSelector('.sb-art-fchip');
  const chips360 = await layout(narrow);
  check('360 px: applied chips and "Keep these N" wrap inside the screen', (await narrow.locator('.sb-art-keep').count()) === 1 && chips360.docScroll <= chips360.docClient && chips360.rootScroll <= chips360.rootClient, chips360);
  await narrow.screenshot({ path: join(outDir, 'filters-360-applied.png') });
  check('360 px: no page errors', narrow.errors.length === 0, narrow.errors);
  await narrow.close();

  // ================================================================ 6. both token maps, light and dark; same class tree in both
  const trees = {};
  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const t = await open({ tokens, theme, w: '1100' }, { width: 1132, height: 800 }, theme);
      await t.evaluate(() => { window.__sbA.store.cellDelay = 60; });
      await openSet(t, 40);
      await t.locator('.sb-art-columns').click();
      await t.locator('.sb-col-row.is-preset', { hasText: 'Summary' }).click();
      const colTree = await classTree(t, '.sb-col-pop');
      await t.screenshot({ path: join(outDir, `columns-staged-${tokens}-${theme}.png`) });
      await t.locator('.sb-col-fill').click();
      await t.waitForFunction(() => document.querySelectorAll('.sb-art-value').length >= 3);
      await t.screenshot({ path: join(outDir, `columns-filling-${tokens}-${theme}.png`) });
      const runTree = await classTree(t, '.sb-art-runbar');
      const colors = await t.evaluate(() => {
        const c = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
        return { runbar: c('.sb-art-runbar', 'backgroundColor'), text: c('.sb-art-runtext', 'color'), fill: c('.sb-art-runfill', 'backgroundColor'), bg: c('.sb-art', 'color') };
      });
      await t.locator('.sb-art-stop').click();
      await waitVersion(t, 2);
      await t.locator('.sb-art-filters').click();
      await t.locator('.sb-flt-check.is-toggle input').check();
      const filterTree = await classTree(t, '.sb-flt-pop');
      const popColors = await t.evaluate(() => ({ bg: getComputedStyle(document.querySelector('.sb-flt-pop')).backgroundColor, border: getComputedStyle(document.querySelector('.sb-flt-pop')).borderTopColor }));
      await t.screenshot({ path: join(outDir, `filters-open-${tokens}-${theme}.png`) });
      await t.locator('.sb-flt-btn.is-primary', { hasText: 'Apply' }).click();
      await t.screenshot({ path: join(outDir, `filters-applied-${tokens}-${theme}.png`) });
      check(`${tokens}/${theme}: columns, filling, filters render with resolved colors and no errors`,
        t.errors.length === 0 && colors.runbar !== 'rgba(0, 0, 0, 0)' && colors.fill !== 'rgba(0, 0, 0, 0)' && popColors.bg !== 'rgba(0, 0, 0, 0)' && popColors.border !== 'rgba(0, 0, 0, 0)', { colors, popColors, errors: t.errors });
      if (theme === 'light') trees[tokens] = { colTree, runTree, filterTree };
      await t.close();
    }
  }
  for (const key of ['colTree', 'runTree', 'filterTree']) {
    check(`parity: ${{ colTree: 'the Columns popover', runTree: 'the progress line', filterTree: 'the Filters popover' }[key]} has an identical class tree in both token maps`,
      JSON.stringify(trees.zotero?.[key]) === JSON.stringify(trees.obsidian?.[key]) && Boolean(trees.zotero?.[key]), null);
  }

  return { failures, count };
}
