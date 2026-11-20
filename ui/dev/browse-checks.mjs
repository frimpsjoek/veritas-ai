// ui/dev/browse-checks.mjs. Playwright checks for spec 027 (Browse) on the fake web host (dev/harness/web.html) with a
// fake desktop bridge (web-fixtures.mjs fakeDesktop): the rail item only with the bridge, a paper link opens a tab,
// the page's rectangle follows the layout, menus and dialogs hide the page, the address rule, the Save states.
// There is no real webview here: the checks read what the web app asks the desktop app to do. Run by dev/run.mjs
// (SB_ONLY=browse).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDesktop, useFixtures } from './web-fixtures.mjs';

const dist = fileURLToPath(new URL('../../web/dist-web', import.meta.url));
const WIDTHS = [1280, 720];
const PAPER = 'https://doi.org/10.1021/acsnano.0c00001';
const SAVE_WORDS = { saving: 'Saving…', added: 'Saved to Zotero', queued: 'Waiting for Zotero', already: 'Already in Zotero', kept: 'Saved to Veritas › Papers' };

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runBrowseChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} browse: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const files = readdirSync(dist);
  const js = files.find((f) => /^app-[0-9a-f]{8}\.js$/.test(f));
  const css = files.find((f) => /^app-[0-9a-f]{8}\.css$/.test(f));
  if (!js || !css) { check('the bundle is built (run npm run build:web first)', false, files); return { failures, count }; }
  const origin = `http://127.0.0.1:${port}`;
  const fakeUrl = `${origin}/dev/harness/web.html?js=${encodeURIComponent(`/dist-web/${js}`)}&css=${encodeURIComponent(`/dist-web/${css}`)}`;

  async function open(width, desktop) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    await useFixtures(page);
    if (desktop) await fakeDesktop(page);
    await page.goto(fakeUrl);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    return { page, errors };
  }
  const calls = (page) => page.evaluate(() => window.__desk.calls);
  const last = async (page, cmd) => (await calls(page)).filter((c) => c.cmd === cmd).at(-1) ?? null;
  const countOf = async (page, cmd) => (await calls(page)).filter((c) => c.cmd === cmd).length;
  const settle = (page) => page.waitForTimeout(120);

  for (const width of WIDTHS) {
    const tag = `${width}px`;
    // no bridge (a web browser, the phone): no Browse
    {
      const { page } = await open(width, false);
      await settle(page);
      check(`${tag} without the desktop app there is no Browse in the rail`, (await page.locator('.sbw-nav-item[data-view="browse"]').count()) === 0);
      await page.close();
    }
    const { page, errors } = await open(width, true);
    await page.waitForSelector('.sbw-nav-item[data-view="browse"]');
    check(`${tag} in the desktop app Browse is in the rail, after Notes`, await page.evaluate(() => document.querySelector('.sbw-nav-item[data-view="browse"]')?.previousElementSibling?.getAttribute('data-view') === 'notes'));

    // a paper link opens a tab in Browse
    await page.evaluate((url) => window.__host.openLink(url), PAPER);
    await page.waitForFunction(() => location.hash === '#/browse');
    await page.waitForSelector('.sbw-browse-tab.is-active');
    const opened = await last(page, 'browse_open');
    check(`${tag} a paper link opens a Browse tab with its address`, opened?.args?.text === PAPER && typeof opened?.args?.tab === 'string', opened);
    const tab = opened?.args?.tab;
    check(`${tag} the reader is still there for a paper when asked`, await page.evaluate((url) => { window.__host.openLink(url, { reader: true }); return !document.querySelector('.sbw-browser')?.hidden; }, PAPER));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.sbw-browser')?.hidden !== false);
    await settle(page);

    // the page's rectangle follows the layout
    const areaRect = () => page.evaluate(() => { const r = document.querySelector('.sbw-browse-page').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const near = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
    let shown = await last(page, 'browse_show');
    check(`${tag} the shown tab is placed over the page area`, shown?.args?.tab === tab && near(shown?.args?.rect, await areaRect()), { shown, area: await areaRect() });
    await page.setViewportSize({ width: width - 100, height: 700 });
    await page.waitForTimeout(250);
    shown = await last(page, 'browse_show');
    check(`${tag} the rect follows the layout after a resize`, near(shown?.args?.rect, await areaRect()), { shown, area: await areaRect() });
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);

    // overlays hide the page, and it comes back after
    const hidesBefore = await countOf(page, 'browse_hide');
    const showsBefore = await countOf(page, 'browse_show');
    await page.click('.sbw-more');
    await settle(page);
    check(`${tag} opening the More menu hides the page`, (await countOf(page, 'browse_hide')) > hidesBefore);
    await page.keyboard.press('Escape');
    await settle(page);
    check(`${tag} closing the menu shows it again`, (await countOf(page, 'browse_show')) > showsBefore);
    const hides2 = await countOf(page, 'browse_hide');
    // a dialog as the web host draws one (dialogs.js): an .sbw-overlay on the body
    await page.evaluate(() => { const o = document.createElement('div'); o.className = 'sbw-overlay'; o.id = 'check-overlay'; document.body.append(o); });
    await settle(page);
    check(`${tag} a dialog hides the page`, (await countOf(page, 'browse_hide')) > hides2);
    const shows2 = await countOf(page, 'browse_show');
    await page.evaluate(() => document.getElementById('check-overlay')?.remove());
    await settle(page);
    check(`${tag} closing the dialog shows it again`, (await countOf(page, 'browse_show')) > shows2);
    const confirm = Promise.resolve();
    if (await page.locator('.sbw-overlay').count()) await page.keyboard.press('Escape');
    await confirm.catch(() => {});
    await settle(page);

    // the page's state reaches the bar
    await page.evaluate((t) => window.__desk.emit('browse://state', { tab: t, url: 'https://pubs.acs.org/doi/10.1021/acsnano.0c00001', title: 'An invented paper', canGoBack: true, canGoForward: false, loading: false }), tab);
    await settle(page);
    const bar = await page.evaluate(() => ({
      title: document.querySelector('.sbw-browse-tab.is-active .sbw-browse-tab-name')?.textContent,
      address: document.querySelector('.sbw-browse-address')?.value,
      back: document.querySelector('.sbw-browse-bar .sbw-browser-tool[aria-label="Back"]')?.disabled,
      forward: document.querySelector('.sbw-browse-bar .sbw-browser-tool[aria-label="Forward"]')?.disabled,
    }));
    check(`${tag} the tab takes the page's title, the bar its address and history`, bar.title === 'An invented paper' && bar.address === 'https://pubs.acs.org/doi/10.1021/acsnano.0c00001' && bar.back === false && bar.forward === true, bar);
    await page.click('.sbw-browse-bar .sbw-browser-tool[aria-label="Back"]');
    check(`${tag} Back asks the app to go back in that tab`, (await last(page, 'browse_back'))?.args?.tab === tab);

    // the address field
    await page.fill('.sbw-browse-address', 'vole burrows');
    await page.press('.sbw-browse-address', 'Enter');
    await page.waitForFunction(() => document.querySelector('.sbw-browse-problem')?.textContent !== '');
    check(`${tag} text that is not a link or a DOI says so`, (await page.textContent('.sbw-browse-problem')) === 'Type a link or a DOI');
    await page.fill('.sbw-browse-address', '10.1021/acsnano.0c00002');
    await page.press('.sbw-browse-address', 'Enter');
    await settle(page);
    const typed = await last(page, 'browse_open');
    check(`${tag} a DOI typed in goes to the shown tab`, typed?.args?.text === '10.1021/acsnano.0c00002' && typed?.args?.tab === tab, typed);

    // Save PDF to Zotero: the button's words follow the app's events
    await page.click('.sbw-browse-save');
    check(`${tag} Save asks the app to save the shown tab`, (await last(page, 'browse_save_pdf'))?.args?.tab === tab);
    for (const [status, words] of Object.entries(SAVE_WORDS)) {
      await page.evaluate(([t, s]) => window.__desk.emit('browse://saved', { tab: t, status: s, message: null }), [tab, status]);
      await settle(page);
      check(`${tag} Save says "${words}" for ${status}`, (await page.textContent('.sbw-browse-save')) === words);
    }
    await page.evaluate((t) => window.__desk.emit('browse://saved', { tab: t, status: 'failed', message: 'The site sent a page, not the PDF (sign in first?)' }), tab);
    await settle(page);
    check(`${tag} a failed Save says why, in the bar`, (await page.textContent('.sbw-browse-save-state')) === 'The site sent a page, not the PDF (sign in first?)' && (await page.textContent('.sbw-browse-save')) === 'Save PDF'); // spec 032: this fake server has no Zotero library

    // a page's new window becomes a tab; a tab closed by the app goes
    await page.evaluate(() => window.__desk.emit('browse://new-tab', { from: 'x', url: 'https://chemrxiv.org/engage/chemrxiv/article-details/66c9d14420ac769e5fb4ddd1' }));
    await page.waitForFunction(() => document.querySelectorAll('.sbw-browse-tab').length === 2);
    const second = await last(page, 'browse_open');
    check(`${tag} a page's new window opens as a new tab`, second?.args?.text?.startsWith('https://chemrxiv.org/') && second?.args?.tab !== tab, second);
    await page.evaluate((t) => window.__desk.emit('browse://closed', { tab: t }), second?.args?.tab);
    await settle(page);
    check(`${tag} a tab the app closed leaves the strip`, (await page.locator('.sbw-browse-tab').count()) === 1);

    // right-click on a tab: copy its link or share it (2026-11-10); the native page steps aside while the menu is open
    await page.evaluate(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    const hidesMenu = await countOf(page, 'browse_hide');
    await page.click('.sbw-browse-tab.is-active .sbw-browse-tab-name', { button: 'right' });
    await page.waitForSelector('.sb-paper-menu');
    await settle(page);
    const tabMenu = await page.locator('.sb-paper-menu .sb-art-item-label').allTextContents();
    check(`${tag} right-click on a tab: Copy link, Copy title and link, Share…`, JSON.stringify(tabMenu) === JSON.stringify(['Copy link', 'Copy title and link', 'Share…']), tabMenu);
    check(`${tag} the page steps aside while the menu is open`, (await countOf(page, 'browse_hide')) > hidesMenu);
    await page.click('.sb-paper-menu [data-action="copy-link"]');
    await page.waitForFunction(() => window.__copied.length === 1);
    await page.waitForFunction(() => document.querySelector('.sbw-browse-note')?.textContent === 'Link copied', null, { timeout: 1000 }).catch(() => {});
    check(`${tag} Copy link copies the tab's address and says so in the bar`, (await page.evaluate(() => window.__copied[0])) === PAPER && (await page.textContent('.sbw-browse-note')) === 'Link copied', await page.evaluate(() => [window.__copied, document.querySelector('.sbw-browse-note')?.textContent]));

    // leaving Browse hides the page
    const hides3 = await countOf(page, 'browse_hide');
    await page.evaluate(() => { location.hash = '#/library'; });
    await page.waitForSelector('.sbw-lib');
    await settle(page);
    check(`${tag} leaving Browse hides the page`, (await countOf(page, 'browse_hide')) > hides3);
    // right-click on a Library row: its DOI link
    await page.waitForSelector('.sbw-lib-row');
    await page.click('.sbw-lib-row >> nth=0', { button: 'right', position: { x: 300, y: 10 } });
    await page.waitForSelector('.sb-paper-menu');
    check(`${tag} right-click on a Library paper opens its menu with Open`, (await page.locator('.sb-paper-menu .sb-art-item-label').allTextContents())[0] === 'Open');
    await page.click('.sb-paper-menu [data-action="copy-text"]');
    await page.waitForFunction(() => window.__copied.length === 2);
    const libText = await page.evaluate(() => window.__copied[1]);
    check(`${tag} Copy title and link on a Library paper gives its title and DOI link`, /\nhttps:\/\/doi\.org\/10\.1000\/invented\.\d+$/.test(libText), libText);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#/browse'; });
    await page.waitForSelector('.sbw-browse-tab.is-active');
    await settle(page);
    check(`${tag} coming back shows the same tab again`, (await last(page, 'browse_show'))?.args?.tab === tab);

    const layout = await page.evaluate(() => ({ sideways: document.scrollingElement.scrollWidth > innerWidth, bar: (() => { const b = document.querySelector('.sbw-browse-bar'); return b.scrollWidth <= b.clientWidth + 1; })() }));
    check(`${tag} the bar fits and nothing scrolls sideways`, !layout.sideways && layout.bar, layout);
    await page.screenshot({ path: join(outDir, `browse-${width}.png`) });
    check(`${tag} no errors logged`, errors.length === 0, errors);
    await page.close();
  }
  // Save to Zotero in Browse is the app's own: when it answers "added", the Library asks the server again (it does not
  // go through the host, so the shell listens for the app's event)
  {
    const { page, errors } = await open(1280, true);
    await page.waitForSelector('.sbw-nav-item[data-view="browse"]');
    let asked = 0;
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/zotero/items' && !u.searchParams.get('collections')) asked += 1; });
    await page.evaluate(() => { location.hash = '#/library'; });
    await page.waitForSelector('.sbw-lib-row');
    await settle(page);
    const before = asked;
    await page.evaluate(() => window.__desk.emit('browse://saved', { tab: 't1', status: 'queued' }));
    await settle(page);
    const queued = asked - before;
    await page.evaluate(() => window.__desk.emit('browse://saved', { tab: 't1', status: 'added' }));
    await page.waitForTimeout(400);
    check('1280px a PDF saved to Zotero from Browse makes the Library ask again; one waiting for Zotero does not', queued === 0 && asked - before === 1, { queued, after: asked - before });
    check('1280px no errors logged (Browse saves and the Library)', errors.length === 0, errors);
    await page.close();
  }
  return { failures, count };
}
