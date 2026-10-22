// ui-src/dev/radar-checks.mjs. Playwright checks for spec 012 R2 (the Reading radar setup sheet), run by dev/run.mjs against
// dev/harness/steps.html on the fake host: the starter card opens the sheet, the library seeds the profile, topics add and
// remove, a blocked feed offers the journal by name, the When row changes the default size, Save produces a draft the
// engine's own validateDraft accepts, and editing opens the same sheet with each source's status line.
// Screenshots go to $SB_SHOTS (default dev/out/).
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { validateDraft } from '../../agent-src/src/routines.js';

const status = { 'database:arxiv': { at: new Date(Date.now() - 2 * 3600e3).toISOString(), items: 14, error: null, quietRuns: 0 }, 'feed:https://broken.example/feed': { at: new Date(Date.now() - 3600e3).toISOString(), items: 0, error: 'HTTP 403', quietRuns: 0 } };
const EXISTING = {
  id: 'radX', name: 'Vole radar', kind: 'radar', status: 'active', prompt: 'Reading radar', target: { kind: 'session' }, lastRun: null, running: false,
  schedule: { days: { kind: 'some', weekdays: [1] }, times: { kind: 'at', times: ['08:00'] } }, nextRun: new Date(Date.now() + 86400e3).toISOString(),
  radarStatus: status,
  radar: {
    scope: { kind: 'library' }, note: true, size: { fresh: 15, older: 5 },
    profile: { topics: [{ text: 'burrow ecology', weight: 1, origin: 'user' }], authors: [], journals: [] },
    sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }, { id: 'feed:https://broken.example/feed', on: true, kind: 'feed', url: 'https://broken.example/feed', title: 'Broken feed' }],
  },
};
const HF = { config: { name: 'huggingface' }, state: 'connected', error: null, tools: [{ name: 'hf_fs', description: 'Hub filesystem', verdict: 'ok' }] };

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runRadarChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} radar: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const shots = process.env.SB_SHOTS ?? outDir;
  await mkdir(shots, { recursive: true });
  async function open(radar, { theme = 'light', tokens = 'zotero', w = 1000, h = 900, bare = false } = {}) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(`http://127.0.0.1:${port}/dev/harness/steps.html?${new URLSearchParams({ tokens, theme, ...(bare ? { bare: '1' } : {}) })}`);
    await page.waitForFunction(() => window.__sbHarnessReady === true, null, { timeout: 8000 });
    await page.evaluate((r) => window.__sbS.make({ radar: r }).then((ctx) => { window.__ctx = ctx; ctx.chat.setMode('routines'); }), radar);
    await page.waitForSelector('.sb-rt');
    page.errors = errors;
    return page;
  }
  const texts = (page, sel) => page.locator(sel).allTextContents().then((all) => all.map((t) => t.replace(/\s+/g, ' ').trim()));
  const calls = (page, kind) => page.evaluate((k) => window.__ctx.calls.filter((c) => c.kind === k), kind);

  // ---------------------------------------------------------------- the starter card opens the sheet, the library seeds it
  let page = await open({ mcp: [HF] }, { bare: true, h: 1700 });
  const starters = await texts(page, '.sb-rt-template-title');
  check('Routines offers a Reading radar starter card first, and a New radar button', starters[0] === 'Reading radar' && await page.locator('.sb-rt-new-radar').count() === 1, starters);
  await page.locator('[data-template="reading-radar"]').click();
  await page.waitForSelector('.sb-ra-card');
  check('the sheet opens with the name filled', await page.inputValue('.sb-ra-name') === 'Reading radar');
  await page.waitForFunction(() => document.querySelectorAll('[data-list="topics"] .sb-ra-row:not(.sb-ra-add)').length === 3);
  check('the library seeds the topics, asked for the whole library', JSON.stringify(await texts(page, '[data-list="topics"] .sb-ra-title')) === JSON.stringify(['vole foraging behaviour', 'burrow ecology', 'seed hoarding'])
    && JSON.stringify((await calls(page, 'radar-profile'))[0].scope) === '{"kind":"library"}');
  const authors = await texts(page, '[data-list="authors"] .sb-ra-main');
  check('authors show the OpenAlex match, and an unmatched one says so', authors[0].includes('A. Bramblewood, Invented University, 120 works') && authors[1].includes('No match in OpenAlex'), authors);
  check('journals show their match', (await texts(page, '[data-list="journals"] .sb-ra-main'))[0].includes('Journal of Invented Zoology, Invented Press, 1,200 works'));
  const dbs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('input[data-source^="database:"]')].map((i) => [i.dataset.source.slice(9), i.checked])));
  check('arXiv, chemRxiv and OpenAlex are on by default, the other databases off', JSON.stringify(Object.entries(dbs).filter(([, on]) => on).map(([k]) => k)) === '["arxiv","chemrxiv","openalex"]' && Object.keys(dbs).length === 7, dbs);
  check('size starts at 8 + 1 for the daily default', await page.inputValue('.sb-ra-fresh') === '8' && await page.inputValue('.sb-ra-older') === '1');
  check('When defaults to daily at 07:00 with a preview', await page.inputValue('.sb-rt-time') === '07:00' && /^Next: /.test(await page.locator('.sb-rt-preview').innerText()), await page.locator('.sb-rt-preview').innerText());
  check('the Hugging Face preset is offered because the server is connected', (await texts(page, 'input[data-source="mcp:huggingface/hf_fs"] ~ .sb-ra-main .sb-ra-title')).join() === 'Hugging Face papers');
  await page.screenshot({ path: join(shots, 'r2-sheet-top.png') });

  // ---------------------------------------------------------------- topics
  await page.fill('[data-list="topics"] .sb-ra-add-in', 'meadow vole population cycles');
  await page.locator('[data-list="topics"] .sb-ra-add-go').click();
  check('adding a topic lists it', (await texts(page, '[data-list="topics"] .sb-ra-title')).includes('meadow vole population cycles'));
  await page.fill('[data-list="topics"] .sb-ra-add-in', 'Burrow ecology');
  await page.press('[data-list="topics"] .sb-ra-add-in', 'Enter');
  check('a repeat topic is not added', (await texts(page, '[data-list="topics"] .sb-ra-title')).length === 4);
  await page.locator('[data-list="topics"] .sb-ra-row', { hasText: 'seed hoarding' }).locator('.sb-ra-x').click();
  check('removing a topic takes it out', JSON.stringify(await texts(page, '[data-list="topics"] .sb-ra-title')) === '["vole foraging behaviour","burrow ecology","meadow vole population cycles"]');

  // ---------------------------------------------------------------- a blocked feed offers the journal by name
  await page.fill('.sb-ra-check-in', 'https://www.nature.example/ncomms.rss');
  await page.locator('.sb-ra-check-go').click();
  await page.waitForSelector('.sb-ra-note.is-warn');
  const blocked = await page.locator('.sb-ra-result').innerText();
  check('a feed that sends us to a sign-in says so and offers the journal by name', blocked.includes('This site sends feed requests to a sign-in page.') && blocked.includes('Add the journal by name') && blocked.includes('Nature of Voles') && blocked.includes('Nature Burrows'), blocked);
  await page.locator('.sb-ra-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'r2-sheet-blocked.png') });
  await page.locator('.sb-ra-result .sb-ra-row', { hasText: 'Nature of Voles' }).locator('.sb-ra-add-journal').click();
  const mineRow = await texts(page, 'input[data-source="journal:S2"] ~ .sb-ra-main');
  check('adding the suggested journal lists it under feeds and journals', mineRow.length === 1 && mineRow[0].includes('Nature of Voles'), mineRow);
  await page.fill('.sb-ra-check-in', 'https://good.example/feed');
  await page.press('.sb-ra-check-in', 'Enter');
  await page.waitForSelector('.sb-ra-add-feed');
  await page.locator('.sb-ra-add-feed').click();
  await page.fill('.sb-ra-check-in', '2057-3960');
  await page.press('.sb-ra-check-in', 'Enter');
  await page.waitForSelector('.sb-ra-add-journal');
  await page.locator('.sb-ra-add-journal').click();
  const mine = await page.evaluate(() => [...document.querySelectorAll('.sb-ra-sources input[data-source]')].map((i) => i.dataset.source).filter((s) => /^(feed|journal):/.test(s)));
  check('a good feed and an ISSN are added as sources', JSON.stringify(mine.sort()) === JSON.stringify(['feed:https://good.example/feed', 'journal:S2', 'journal:S4']), mine);
  await page.fill('.sb-ra-check-in', 'zzz');
  await page.press('.sb-ra-check-in', 'Enter');
  await page.waitForSelector('.sb-ra-note.is-error');
  check('a name nothing matches is a plain sentence', (await page.locator('.sb-ra-note').innerText()).startsWith('No journal found for "zzz"'));

  // ---------------------------------------------------------------- the When row changes the default size until the user types one
  await page.selectOption('.sb-rt-days', 'some');
  await page.waitForFunction(() => document.querySelector('.sb-ra-fresh').value === '15');
  check('a weekly schedule moves the size to 15 + 5', await page.inputValue('.sb-ra-fresh') === '15' && await page.inputValue('.sb-ra-older') === '5');
  await page.fill('.sb-ra-fresh', '12');
  await page.selectOption('.sb-rt-days', 'daily');
  check('a size the user typed stays', await page.inputValue('.sb-ra-fresh') === '12' && await page.inputValue('.sb-ra-older') === '5');

  // ---------------------------------------------------------------- save
  await page.screenshot({ path: join(shots, 'r2-sheet-sources.png'), fullPage: false });
  await page.locator('.sb-ra-save').click();
  await page.waitForSelector('.sb-ra-card', { state: 'detached' });
  const created = await calls(page, 'routine-create');
  let valid = null;
  try { valid = validateDraft(created[0].draft); } catch (error) { valid = String(error); }
  check('Save creates one kind:radar routine that the engine\'s validateDraft accepts', created.length === 1 && typeof valid === 'object' && valid.kind === 'radar', valid);
  check('the draft carries the topics, the ticked sources and the size', valid.radar.profile.topics.length === 3 && valid.radar.size.fresh === 12 && valid.radar.size.older === 5
    && valid.radar.sources.filter((s) => s.on).map((s) => s.id).includes('journal:S2') && valid.radar.sources.some((s) => s.id === 'author:A1') && !valid.radar.sources.some((s) => s.id === 'mcp:huggingface/hf_fs' && s.on), valid.radar?.sources?.map((s) => `${s.id}:${s.on}`));
  check('the new radar is listed', (await texts(page, '.sb-rt-name'))[0] === 'Reading radar' && (await page.locator('.sb-rt-target').innerText()).startsWith('Reading radar'));
  check('no page errors while setting up a radar', page.errors.length === 0, page.errors);
  await page.close();

  // ---------------------------------------------------------------- an empty topic list cannot be saved
  page = await open({ mcp: [] });
  await page.locator('.sb-rt-new-radar').click();
  await page.waitForSelector('.sb-ra-card');
  await page.waitForFunction(() => document.querySelectorAll('[data-list="topics"] .sb-ra-row:not(.sb-ra-add)').length === 3);
  for (let i = 0; i < 3; i++) await page.locator('[data-list="topics"] .sb-ra-x').first().click();
  await page.locator('.sb-ra-save').click();
  check('saving with no topic says what is missing and creates nothing', (await page.locator('.sb-sk-status').innerText()) === 'Add at least one topic to look for.' && (await calls(page, 'routine-create')).length === 0);
  check('no Connected tools block when no server is connected', await page.locator('.sb-ra-sources .sb-ra-sub', { hasText: 'Connected tools' }).count() === 0);
  await page.close();

  // ---------------------------------------------------------------- editing opens the same sheet with status lines
  page = await open({ routines: [EXISTING], mcp: [HF] }, { theme: 'dark' });
  check('with a radar listed the card says what it is', (await page.locator('.sb-rt-target').innerText()).startsWith('Reading radar'));
  await page.locator('[data-action="edit"]').click();
  await page.waitForSelector('.sb-ra-card');
  check('editing a radar opens the radar sheet, not the routine one', (await page.locator('.sb-sk-title').innerText()) === 'Edit reading radar' && await page.inputValue('.sb-ra-name') === 'Vole radar');
  check('an existing radar is not reseeded from the library', (await calls(page, 'radar-profile')).length === 0 && (await texts(page, '[data-list="topics"] .sb-ra-title')).join() === 'burrow ecology');
  const lines = await texts(page, '.sb-ra-sources .sb-ra-main');
  check('each source shows its last answer from the radar\'s state', lines.some((l) => l.startsWith('arXiv') && /Fetched 2 hours ago, 14 papers/.test(l)) && lines.some((l) => l.startsWith('Broken feed') && /Failed 1 hour ago: HTTP 403/.test(l)), lines);
  check('a weekly radar keeps its saved size and schedule', await page.inputValue('.sb-ra-fresh') === '15' && await page.inputValue('.sb-ra-older') === '5' && await page.inputValue('.sb-rt-time') === '08:00');
  await page.screenshot({ path: join(shots, 'r2-sheet-edit-dark.png') });
  await page.fill('.sb-ra-name', 'Vole radar 2');
  await page.locator('.sb-ra-save').click();
  await page.waitForSelector('.sb-ra-card', { state: 'detached' });
  const updates = await calls(page, 'routine-update');
  check('Save changes updates that routine with the kind and radar settings', updates.length === 1 && updates[0].id === 'radX' && updates[0].patch.name === 'Vole radar 2' && updates[0].patch.kind === 'radar' && updates[0].patch.project === null, updates[0]);
  await page.close();

  // ---------------------------------------------------------------- not on the library server
  page = await open({ mcp: [] });
  await page.evaluate(() => { window.__ctx.chat.host._setWhere('local'); window.__ctx.chat.setMode('chat'); window.__ctx.chat.setMode('routines'); });
  await page.waitForSelector('.sb-rt-templates');
  check('without the library server there is no New radar button and no radar card', await page.locator('.sb-rt-new-radar').count() === 0 && (await texts(page, '.sb-rt-template-title')).indexOf('Reading radar') < 0);
  await page.close();

  // ---------------------------------------------------------------- phone width: no sideways scroll, the card fits
  page = await open({ mcp: [HF] }, { w: 380, h: 800, bare: true });
  await page.locator('.sb-rt-new-radar').click();
  await page.waitForSelector('.sb-ra-card');
  await page.waitForFunction(() => document.querySelectorAll('[data-list="topics"] .sb-ra-row:not(.sb-ra-add)').length === 3);
  const fit = await page.evaluate(() => { const c = document.querySelector('.sb-ra-body'); return { body: c.scrollWidth <= c.clientWidth, root: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; });
  check('at phone width nothing scrolls sideways', fit.body && fit.root, fit);
  await page.screenshot({ path: join(shots, 'r2-sheet-phone.png') });
  await page.close();

  return { failures, count };
}
