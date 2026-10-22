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
    check(`${tag} right-click on a link offers both places`, JSON.stringify(menu) === '["Open in Second Brain","Open in your browser"]', menu);
    await page.evaluate(() => { window.__opened = []; });
    await page.click('.sb-link-menu .sb-art-item:last-child');
    check(`${tag} "Open in your browser" goes outside and the menu closes`, (await page.evaluate(() => window.__opened))[0]?.url === 'https://example.org/voles' && (await page.locator('.sb-link-menu').count()) === 0 && (await panel()).open === false);
    await page.click(noteLink, { modifiers: ['Meta'] });
    check(`${tag} a ⌘-click on a link goes outside`, (await page.evaluate(() => window.__opened)).length === 2 && (await panel()).open === false);
    check(`${tag} no page errors`, errors.length === 0, errors);
    await page.close();
  }
  return { failures, count };
}
