// ui-src/dev/digest-checks.mjs. Playwright checks for spec 012 R4 (the Reading radar's digest), run by dev/run.mjs against
// dev/harness/steps.html on the fake host: the summary line, the why lines and the cited-by reasons, the three row actions
// with their five-second Undo toast, a dismissed row that greys out and stays, Add to Zotero only where the host can add,
// verdicts from an earlier session, and a failed save. Screenshots go to $SB_SHOTS (default dev/out/).
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const SUMMARY = '5 new from 4 sources · 2 worth reading · chemRxiv failed (timeout)';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runDigestChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} digest: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const shots = process.env.SB_SHOTS ?? outDir;
  await mkdir(shots, { recursive: true });

  async function open({ radar = {}, kind = 'zotero', theme = 'light', w = 1100, h = 800, bare = false, card = 'New', only = null } = {}) {
    const page = await browser.newPage({ viewport: { width: bare ? w : w + 32, height: h }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams({ tokens: kind === 'obsidian' ? 'obsidian' : 'zotero', theme, ...(bare ? { bare: '1', w: '' } : { w: String(w) }) })}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    await page.evaluate(async ({ radar, kind, only }) => {
      const ctx = await window.__sbS.make({ radar, kind });
      window.__ctx = ctx;
      await window.__sbS.withDigest(ctx, { only });
    }, { radar, kind, only });
    await page.locator('.sb-art-card', { hasText: card }).last().click();
    await page.waitForSelector('.sb-art-table, .sb-art-cardlist', { timeout: 4000 });
    await page.waitForSelector('.sb-dg-acts');
    page.errors = errors;
    return page;
  }
  const texts = (page, sel) => page.locator(sel).allTextContents().then((all) => all.map((t) => t.replace(/\s+/g, ' ').trim()));
  const calls = (page, kind) => page.evaluate((k) => window.__ctx.calls.filter((c) => c.kind === k), kind);
  const rowOf = (page, n) => page.locator(`[data-row="doi:10.9999/vole.${n}"]`).first();

  // ---------------------------------------------------------------- 1280 dark: the whole digest
  let page = await open({ theme: 'dark', w: 1280, h: 900 });
  check('the summary line is above the table', (await texts(page, '.sb-dg-summary')).join() === SUMMARY, await texts(page, '.sb-dg-summary'));
  check('five rows, none tinted as "new" (the dot-and-dim idea, not a wash)', await page.locator('.sb-art-row').count() === 5 && await page.locator('.sb-art-row-new').count() === 0);
  const lines = await texts(page, '.sb-art-row .sb-dg-line');
  check('each row with a why line shows it under the title; the row without an abstract says so', lines.length === 5 && lines[0].startsWith('Links burrow depth') && lines[2] === 'No abstract to go on' && lines[4].startsWith('Same group as'), lines);
  check('the no-abstract note is muted and the others are not', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sb-art-row .sb-dg-line')];
    return rows[2].classList.contains('is-muted') && !rows[0].classList.contains('is-muted');
  }));
  const placed = await page.evaluate(() => {
    const td = document.querySelector('.sb-art-row .sb-art-paper');
    const kids = [...td.children].map((c) => c.className.split(' ')[0]);
    return kids;
  });
  check('the line sits right under the title and the actions close the cell', placed[0] === 'sb-art-title' && placed[1] === 'sb-dg-line' && placed.at(-1) === 'sb-dg-acts', placed);
  check('every row offers Add to Zotero, the Read later bookmark, Like and Not for me', JSON.stringify(await texts(page, '.sb-art-row:first-child .sb-dg-act')) === '["Add to Zotero","Read later","Like","Not for me"]', await texts(page, '.sb-art-row:first-child .sb-dg-act'));
  // spec 028 R10: the bookmark is an icon toggle (aria-pressed) with no key letter, beside Add to Zotero
  const later = await page.locator('.sb-art-row:first-child .sb-dg-act.sb-bookmark').evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), icon: b.classList.contains('is-icon'), label: b.getAttribute('aria-label'), key: b.dataset.key ?? null, prev: b.previousElementSibling?.textContent }));
  check('the Read later bookmark is an icon button with aria-pressed and no key, right after Add to Zotero', later.pressed === 'false' && later.icon && later.label === 'Read later' && later.key === null && later.prev === 'Add to Zotero', later);
  const colors = await page.evaluate(() => {
    const acts = [...document.querySelectorAll('.sb-art-row:first-child .sb-dg-act:not(.sb-bookmark)')];
    const accent = getComputedStyle(document.querySelector('.sb-ai')).getPropertyValue('--sb-ui-accent').trim();
    const mark = document.querySelector('.sb-art-row:first-child .sb-dg-act.sb-bookmark');
    return { colors: acts.map((a) => getComputedStyle(a).color), fills: acts.map((a) => getComputedStyle(a).backgroundColor), later: [getComputedStyle(mark).color, getComputedStyle(mark).backgroundColor], accent };
  });
  check('only the primary action is accent-coloured, and none is filled (an unpressed Read later bookmark is plain too)', colors.colors[0] !== colors.colors[1] && colors.colors[1] === colors.colors[2] && colors.fills.every((f) => f === 'rgba(0, 0, 0, 0)') && colors.later[0] === colors.colors[1] && colors.later[1] === 'rgba(0, 0, 0, 0)', colors);
  await page.screenshot({ path: join(shots, 'r4-digest-1280-dark.png') });

  // ---------------------------------------------------------------- Not for me: folds, stays in place, toast with Undo
  const orderBefore = await page.locator('.sb-art-row').evaluateAll((rows) => rows.map((r) => r.dataset.row));
  await rowOf(page, 2).locator('.sb-dg-act', { hasText: 'Not for me' }).click();
  await page.waitForSelector('.sb-dg-toast');
  const fb = await calls(page, 'radar-feedback');
  check('Not for me tells the engine: routine, paper key, dismissed', fb.length === 1 && fb[0].routineId === 'radX' && fb[0].paperKey === 'doi:10.9999/vole.2' && fb[0].verdict === 'dismissed', fb);
  check('a toast says so with an Undo', (await page.locator('.sb-dg-toast').innerText()).replace(/\s+/g, ' ') === 'Not for me: fewer like this Undo');
  check('the row is marked dismissed, says so, and stays where it was', await rowOf(page, 2).evaluate((r) => r.classList.contains('is-dismissed')) && (await texts(rowOf(page, 2), '.sb-dg-state')).join() === 'Not for me: fewer like this'
    && JSON.stringify(await page.locator('.sb-art-row').evaluateAll((rows) => rows.map((r) => r.dataset.row))) === JSON.stringify(orderBefore));
  check('a greyed row is dimmed, the others are not', await page.evaluate(() => {
    const op = (n) => getComputedStyle(document.querySelector(`[data-row="doi:10.9999/vole.${n}"] .sb-art-td`)).opacity;
    return Number(op(2)) < 0.7 && Number(op(1)) === 1;
  }));
  await page.screenshot({ path: join(shots, 'r4-digest-1280-dark-dismissed.png') });
  await page.locator('.sb-dg-toast .sb-dg-act', { hasText: 'Undo' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-row="doi:10.9999/vole.2"]').classList.contains('is-dismissed'));
  const fb2 = await calls(page, 'radar-feedback');
  check('the toast Undo sends undo, and the row has its actions back', fb2.at(-1).verdict === 'undo' && fb2.at(-1).paperKey === 'doi:10.9999/vole.2' && (await texts(rowOf(page, 2), '.sb-dg-act')).join() === 'Add to Zotero,Read later,Like,Not for me');
  check('Undo says "Undone"', (await page.locator('.sb-dg-toast').innerText()).startsWith('Undone'));

  // ---------------------------------------------------------------- the toast goes after five seconds
  await rowOf(page, 3).locator('.sb-dg-act', { hasText: 'Not for me' }).click();
  await page.waitForSelector('.sb-dg-toast');
  const t0 = Date.now();
  await page.waitForSelector('.sb-dg-toast', { state: 'detached', timeout: 8000 });
  const took = Date.now() - t0;
  check('the toast stays about five seconds', took > 3800 && took < 6500, took);
  check('the settled row keeps its Read later bookmark and an Undo link after the toast is gone', (await texts(rowOf(page, 3), '.sb-dg-act')).join() === 'Read later,Undo');
  await rowOf(page, 3).locator('.sb-dg-act', { hasText: 'Undo' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-row="doi:10.9999/vole.3"]').classList.contains('is-dismissed'));

  // ---------------------------------------------------------------- Add to Zotero and Read later
  await rowOf(page, 1).locator('.sb-dg-act', { hasText: 'Add to Zotero' }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.1"] .sb-dg-state')?.textContent === 'Added to Zotero');
  const added = await calls(page, 'add-to-library');
  const fb3 = await calls(page, 'radar-feedback');
  check('Add to Zotero calls the host first, then records "added"', added.length === 1 && added[0].dois[0] === '10.9999/vole.1' && fb3.at(-1).verdict === 'added' && fb3.at(-1).paperKey === 'doi:10.9999/vole.1', { added, last: fb3.at(-1) });
  check('its toast says Added to Zotero', (await page.locator('.sb-dg-toast').innerText()).startsWith('Added to Zotero'));
  await rowOf(page, 1).locator('.sb-dg-act', { hasText: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.1"] .sb-dg-act.is-primary'));
  check('undoing an add says the paper stays in Zotero', (await page.locator('.sb-dg-toast').innerText()).startsWith('Undone. The paper stays in Zotero.'));
  await rowOf(page, 3).locator('.sb-dg-act', { hasText: /^Like$/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.3"] .sb-dg-state')?.textContent === 'Liked: more like this');
  check('Like records "liked", says Liked with a thumbs-up, and does not touch the library', (await calls(page, 'radar-feedback')).at(-1).verdict === 'liked' && (await calls(page, 'add-to-library')).length === 1
    && await rowOf(page, 3).locator('.sb-dg-state svg.sb-lucide').count() === 1);
  // Settings > Reading radar > Add liked papers to Zotero: the like also adds it, tagged Liked, in To classify
  await page.evaluate(() => window.__ctx.host.prefs.set('likeToZotero', true));
  await rowOf(page, 2).locator('.sb-dg-act', { hasText: /^Like$/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.2"] .sb-dg-state'));
  const liked = (await calls(page, 'add-to-library')).at(-1);
  check('with the setting on, Like also adds the paper to Zotero, tagged Liked, in To classify',
    (await calls(page, 'add-to-library')).length === 2 && liked.dois[0] === '10.9999/vole.2' && liked.tag === 'Liked' && liked.collectionName === 'To classify'
    && (await calls(page, 'radar-feedback')).at(-1).verdict === 'liked', liked);
  check('its toast says where it went', (await page.locator('.sb-dg-toast').innerText()).startsWith('Liked, and added to Zotero in To classify'));
  check('no page errors in the digest', page.errors.length === 0, page.errors);
  await page.close();

  // ---------------------------------------------------------------- Worth reading: the reason replaces the why line
  page = await open({ card: 'Worth reading' });
  const reasons = await texts(page, '.sb-art-row .sb-dg-line');
  check('a Worth reading row shows its cited-by reason under the title', reasons.length === 2 && reasons[0].startsWith('Cited by 7 papers in your library, including') && !(await texts(page, '.sb-art-row')).join().includes('No abstract'), reasons);
  check('and offers the same actions, the Read later bookmark among them', (await texts(page, '.sb-art-row:first-child .sb-dg-act')).join() === 'Add to Zotero,Read later,Like,Not for me');
  const marks = await page.evaluate(() => [...document.querySelectorAll('.sb-art-row:first-child .sb-dg-act')].map((b) => b.querySelector('svg')?.getAttribute('class')));
  check('Add to Zotero is the Zotero logo; Read later, Like and Not for me Lucide icons (bookmark, thumbs)', JSON.stringify(marks) === JSON.stringify(['sb-logo sb-dg-mark', 'sb-lucide', 'sb-lucide', 'sb-lucide']), marks);
  const named = await page.evaluate(() => [...document.querySelectorAll('.sb-art-row:first-child .sb-dg-act')].map((b) => [b.getAttribute('aria-label'), b.title, b.querySelector('.sb-dg-label')?.getBoundingClientRect().width]));
  check('the buttons are icons alone, each named and with a tooltip that says what it teaches', named.every(([label, title, w]) => label && title.startsWith(`${label}:`) && w <= 1), named);
  await page.close();

  // ---------------------------------------------------------------- a host that cannot add offers two actions
  page = await open({ kind: 'obsidian' });
  check('without host.can.addToLibrary there is no Add to Zotero', (await texts(page, '.sb-art-row:first-child .sb-dg-act')).join() === 'Read later,Like,Not for me');
  await rowOf(page, 4).locator('.sb-dg-act', { hasText: 'Read later' }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.4"] .sb-dg-state')?.textContent === 'Saved to read later');
  check('without Zotero the save button is Read later: records "later", touches no library', (await calls(page, 'radar-feedback')).at(-1).verdict === 'later' && (await calls(page, 'add-to-library')).length === 0);
  check('and Read later is the accent one', (await texts(page, '.sb-art-row:first-child .sb-dg-act.is-primary')).join() === 'Read later');
  await page.close();

  // ---------------------------------------------------------------- an earlier session's clicks show when the digest is reopened
  page = await open({ radar: { verdicts: { 'doi:10.9999/vole.5': 'dismissed', 'doi:10.9999/vole.4': 'added' } } });
  await page.waitForFunction(() => document.querySelector('[data-row="doi:10.9999/vole.5"]')?.classList.contains('is-dismissed'));
  check('a paper dismissed earlier is greyed on open, one added earlier says so', (await texts(rowOf(page, 5), '.sb-dg-state')).join() === 'Not for me: fewer like this' && (await texts(rowOf(page, 4), '.sb-dg-state')).join() === 'Added to Zotero');
  await page.close();

  // ---------------------------------------------------------------- a failed save changes nothing and says so
  page = await open({ radar: { failFeedback: true } });
  await rowOf(page, 2).locator('.sb-dg-act', { hasText: 'Not for me' }).click();
  await page.waitForFunction(() => window.__ctx.calls.some((c) => c.kind === 'notice'));
  check('a failed save leaves the row as it was and shows a notice', !(await rowOf(page, 2).evaluate((r) => r.classList.contains('is-dismissed'))) && (await calls(page, 'notice')).at(-1).text === "Couldn't save that. Try again." && await page.locator('.sb-dg-toast').count() === 0);
  await page.close();

  // ---------------------------------------------------------------- 390 light: cards
  page = await open({ theme: 'light', w: 390, h: 844, bare: true });
  const phone = { cards: await page.locator('.sb-art-rowcard').count(), lines: await page.locator('.sb-art-rowcard .sb-dg-line').count(), acts: await page.locator('.sb-art-rowcard .sb-dg-act').count(), later: await page.locator('.sb-art-rowcard .sb-dg-act.sb-bookmark').count() };
  check('on a phone the rows are cards with the line and the actions (four each, the Read later bookmark one of them)', phone.cards === 5 && phone.lines === 5 && phone.acts === 20 && phone.later === 5, phone);
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.querySelector('.sb-art-body').scrollWidth, bodyClient: document.querySelector('.sb-art-body').clientWidth }));
  check('no sideways scroll at 390 px', over.doc <= over.client && over.body <= over.bodyClient, over);
  await page.screenshot({ path: join(shots, 'r4-digest-390-light.png') });
  await rowOf(page, 2).locator('.sb-dg-act', { hasText: 'Not for me' }).click();
  await page.waitForSelector('.sb-dg-toast');
  const toastBox = await page.locator('.sb-dg-toast').boundingBox();
  check('the toast fits inside the 390 px screen', toastBox.x >= 0 && toastBox.x + toastBox.width <= 390, toastBox);
  await page.screenshot({ path: join(shots, 'r4-digest-390-light-dismissed.png') });
  await page.close();

  // ---------------------------------------------------------------- the profile shows what the radar learned, with an undo
  const learnedRadar = {
    id: 'radX', name: 'Vole radar', kind: 'radar', status: 'active', prompt: 'Reading radar', target: { kind: 'session' }, lastRun: null, running: false,
    schedule: { days: { kind: 'daily' }, times: { kind: 'at', times: ['07:00'] } }, nextRun: new Date(Date.now() + 86400e3).toISOString(),
    radarStatus: { 'database:arxiv': { at: new Date(Date.now() - 3600e3).toISOString(), items: 9, error: null, quietRuns: 0, suggestRemove: true } },
    radarLearned: [{ id: 'k|author|thistle o', paper: 'doi:10.9999/vole.1', title: 'Burrow depth tracks soil moisture', kind: 'author', name: 'O. Thistle', created: true, at: '2026-10-11T07:00:00.000Z' }],
    radar: {
      scope: { kind: 'library' }, note: true, size: { fresh: 8, older: 1 },
      profile: { topics: [{ text: 'burrow ecology', weight: 1, origin: 'user' }], authors: [{ name: 'O. Thistle', openalexId: null, weight: 0.05, origin: 'learned' }, { name: 'A. Bramblewood', openalexId: 'A1', weight: 1, origin: 'user' }], journals: [] },
      sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }],
    },
  };
  page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: 'light' });
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams({ tokens: 'zotero', theme: 'light' })}`);
  await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
  await page.evaluate((r) => window.__sbS.make({ radar: { routines: [r] } }).then((ctx) => { window.__ctx = ctx; ctx.chat.setMode('routines'); }), learnedRadar);
  await page.waitForSelector('.sb-rt');
  await page.locator('[data-action="edit"]').click();
  await page.waitForSelector('.sb-ra-card');
  const authorsRows = await texts(page, '[data-list="authors"] .sb-ra-main');
  check('the profile marks what the radar learned and offers an Undo on it only', authorsRows[0].startsWith('O. Thistle learned') && !authorsRows[1].includes('learned') && await page.locator('[data-list="authors"] .sb-ra-unlearn').count() === 1, authorsRows);
  check('a source the user dismissed three times in a row carries the quiet suggestion', (await texts(page, '.sb-ra-sources .sb-ra-main'))[0].includes('You marked the last 3 papers from here as not relevant. You could remove it.'));
  await page.screenshot({ path: join(shots, 'r4-profile-learned.png') });
  await page.locator('[data-list="authors"] .sb-ra-unlearn').click();
  await page.waitForFunction(() => !document.querySelector('[data-list="authors"] .sb-ra-unlearn'));
  const fbk = await calls(page, 'radar-feedback');
  check('Undo asks the engine to undo that paper, and the learned author leaves the profile', fbk.length === 1 && fbk[0].verdict === 'undo' && fbk[0].paperKey === 'doi:10.9999/vole.1' && (await texts(page, '[data-list="authors"] .sb-ra-title')).join() === 'A. Bramblewood', fbk);
  check('no page errors in the sheet', page.errors.length === 0, page.errors);
  await page.close();

  // ---------------------------------------------------------------- a new chat in Zotero's narrow item pane (user screenshot, 2026-11-10)
  {
    const narrow = await browser.newPage({ viewport: { width: 332, height: 700 } });
    await narrow.goto(`http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams({ tokens: 'zotero', theme: 'light', w: '300' })}`);
    await narrow.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    await narrow.evaluate(async () => { window.__ctx = await window.__sbS.make({ kind: 'zotero' }); });
    await narrow.waitForSelector('.sb-ai-box');
    const layout = await narrow.evaluate(async () => {
      document.querySelectorAll('.sb-ai-source[hidden]').forEach((b) => { b.hidden = false; }); // Valency, as when connected
      window.__ctx.chat.renderSources();
      const scroller = document.querySelector('.sb-ai-scroll') ?? document.querySelector('.sb-ai-thread')?.parentElement;
      if (scroller) { scroller.scrollTop = scroller.scrollHeight; await new Promise((r) => setTimeout(r, 30)); scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); }
      await new Promise((r) => setTimeout(r, 60));
      const box = document.querySelector('.sb-ai-box').getBoundingClientRect();
      const outside = (els) => els.filter((b) => b.getClientRects().length && (b.getBoundingClientRect().right > box.right + 1 || b.getBoundingClientRect().left < box.left - 1)).map((b) => b.textContent);
      const row = document.querySelector('.sb-ai-box > .sb-ai-row:not(.sb-ai-report-options)');
      const out = outside([...row.children]);
      // spec 029 R6: the sources are one button; its menu opens inside the pane, every source in it
      document.querySelector('.sb-ai-sources-btn').click();
      await new Promise((r) => setTimeout(r, 30));
      const menuOut = outside([document.querySelector('.sb-ai-sources-menu'), ...document.querySelectorAll('.sb-ai-source')]);
      const items = [...document.querySelectorAll('.sb-ai-sources-menu .sb-ai-source')].filter((b) => b.getClientRects().length).map((b) => b.textContent);
      const sideways = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      document.querySelector('.sb-ai-sources-btn').click();
      return { out, menuOut, items, sideways, label: document.querySelector('.sb-ai-sources-btn').textContent, jump: !document.querySelector('.sb-ai-jump')?.hidden };
    });
    check('narrow pane: the composer controls wrap inside the message box', layout.out.length === 0, layout);
    check('narrow pane (spec 029 R6): one Sources button names what is on; its menu lists every source inside the pane, no sideways scroll',
      layout.label === 'Sources: Papers, Notes, Scholarly, Valency' && layout.menuOut.length === 0 && layout.items.join() === 'Papers,Notes,Scholarly,Web,Valency' && !layout.sideways, layout);
    check('narrow pane: an empty chat scrolled up shows no "Jump to latest"', layout.jump === false, layout);
    await narrow.screenshot({ path: join(outDir, 'chat-narrow-empty.png') });
    await narrow.close();
  }

  // ---------------------------------------------------------------- right-click on a paper: copy its link, share it (2026-11-10)
  {
    const menuPage = await open();
    await menuPage.evaluate(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    const row = menuPage.locator('.sb-art-row').first();
    const want = await row.evaluate((tr) => tr.querySelector('.sb-art-first')?.textContent ?? '');
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await menuPage.waitForSelector('.sb-paper-menu');
    const labels = await texts(menuPage, '.sb-paper-menu .sb-art-item-label');
    check('right-click on a digest paper opens its menu', JSON.stringify(labels) === JSON.stringify(['Open', 'Open in your browser', 'Copy link', 'Copy title and link', 'Share…']), labels);
    await menuPage.screenshot({ path: join(shots, 'paper-menu.png') });
    await menuPage.click('.sb-paper-menu [data-action="copy-link"]');
    await menuPage.waitForFunction(() => window.__copied.length === 1);
    const link = (await menuPage.evaluate(() => window.__copied))[0];
    check('Copy link copies the paper\'s https link and the menu closes', /^https:\/\//.test(link) && await menuPage.locator('.sb-paper-menu').count() === 0, { link });
    check('…and says so', (await menuPage.locator('.sb-paper-flash').textContent()) === 'Link copied');
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await menuPage.click('.sb-paper-menu [data-action="share"]');
    await menuPage.waitForFunction(() => window.__copied.length === 2);
    const shared = (await menuPage.evaluate(() => window.__copied))[1];
    check('Share with no share menu copies the title and the link', shared.endsWith(`\n${link}`) && shared.split('\n')[0].length > 3 && want.includes(shared.split('\n')[0].slice(0, 12)), { shared, want });
    await menuPage.evaluate(() => {
      window.__shared = [];
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data); } });
    });
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await menuPage.click('.sb-paper-menu [data-action="share"]');
    await menuPage.waitForFunction(() => window.__shared.length === 1);
    const data = (await menuPage.evaluate(() => window.__shared))[0];
    check('Share opens the system share menu with the title and link where there is one', data.url === link && Boolean(data.title), data);
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await menuPage.keyboard.press('Escape');
    check('Escape closes the menu', await menuPage.locator('.sb-paper-menu').count() === 0);
    check('no page errors with the paper menu', menuPage.errors.length === 0, menuPage.errors);
    await menuPage.close();
  }
  return { failures, count };
}
