// ui-src/dev/home-checks.mjs. Spec 014 G4: the plugins' Home (SecondBrainUI.HomeView from content/sb-ui.js, styled by
// content/home/sb-home.css) on a fake plugin host (dev/harness/home.html), under both token maps, light and dark.
// Today and the shelves render, every link goes to the host's open() instead of a hash route, /paper-figure goes
// through host.json, the fonts and photos load, and the colours are the host's. Under the Obsidian map the sheet is
// the one esbuild.config.mjs inlines into main.js (every font and photo a data: URL); under Zotero's, the files in
// content/home/.
// Invented content only. Run by dev/run.mjs (SB_ONLY=home, or with web). Needs `npm run build` first.
import { join } from 'node:path';
import { dataUrl, homeCss } from '../home-assets.mjs';

const HOST_COLOURS = { light: { bg: 'rgb(255, 255, 255)', text: 'rgb(27, 27, 31)' }, dark: { bg: 'rgb(30, 30, 32)', text: 'rgb(237, 237, 240)' } };

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runHomeChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} home: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };

  async function open(query, width, theme = 'light') {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    const missing = [];
    page.on('response', (r) => { if (r.status() >= 400) missing.push(r.url()); });
    if (query.includes('tokens=obsidian')) {
      const sheet = homeCss(dataUrl);
      await page.route('**/repo/content/home/sb-home.css', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: sheet }));
    }
    await page.goto(`http://127.0.0.1:${port}/dev/harness/home.html?${query}`);
    await page.waitForFunction(() => window.__sbHome?.ready === true, null, { timeout: 8000 });
    return { page, errors, missing };
  }
  const opened = (page) => page.evaluate(() => window.__sbHome.opened.splice(0));

  for (const tokens of ['zotero', 'obsidian']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${tokens} ${theme}`;
      const { page, errors, missing } = await open(`tokens=${tokens}&theme=${theme}`, theme === 'light' ? 1280 : 700, theme);
      await page.waitForSelector('.sbw-paper.has-figure');
      await page.evaluate(() => document.fonts.ready);

      const look = await page.evaluate(async () => {
        const view = document.querySelector('.sb-home-view');
        const banner = document.querySelector('.sbw-today-banner');
        return {
          bg: getComputedStyle(view).backgroundColor, text: getComputedStyle(document.querySelector('.sbw-paper-title')).color,
          h1: getComputedStyle(document.querySelector('.sbw-h1')).fontFamily, loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
          photo: getComputedStyle(banner).backgroundImage,
          photos: performance.getEntriesByType('resource').filter((e) => /cover-[a-z]+-\d+\.webp$/.test(e.name)).map((e) => e.responseStatus),
          decoded: await (async () => {
            const src = /url\("?([^")]+)"?\)\s*$/.exec(getComputedStyle(banner).backgroundImage)?.[1];
            const img = new Image();
            img.src = src ?? '';
            return img.decode().then(() => img.naturalWidth, () => 0);
          })(),
          sideways: document.scrollingElement.scrollWidth > innerWidth || view.scrollWidth > view.clientWidth,
        };
      });
      check(`${tag}: the page takes the host's colours (--sb-ui-* from the ${tokens} map), not the web palette`, look.bg === HOST_COLOURS[theme].bg && look.text === HOST_COLOURS[theme].text, look);
      const from = tokens === 'obsidian' ? 'data: URLs' : 'content/home/';
      check(`${tag}: Fraunces and Inter load from ${from} and the headings use Fraunces`, look.loaded.includes('Fraunces') && look.loaded.includes('Inter') && /^"?Fraunces\b/.test(look.h1), look);
      const photoOk = tokens === 'obsidian'
        ? look.photo.includes('url("data:image/webp;base64,') && look.photos.length === 0
        : /cover-wide-\d+\.webp/.test(look.photo) && look.photos.length > 0 && look.photos.every((s) => s === 200);
      check(`${tag}: the cover photos load from ${from} and decode (no missing file)`, photoOk && look.decoded > 0 && missing.length === 0, { photo: look.photo.slice(0, 120), photos: look.photos, decoded: look.decoded, missing });
      check(`${tag}: no sideways scroll`, !look.sideways, look);
      await page.screenshot({ path: join(outDir, `home-${tokens}-${theme}.png`), fullPage: false });
      if (theme === 'dark') { check(`${tag}: no page errors`, errors.length === 0, errors); await page.close(); continue; }

      const home = await page.evaluate(() => ({
        label: document.querySelector('.sbw-today-banner .sbw-cover-label')?.textContent,
        line: document.querySelector('.sbw-today-banner .sbw-cover-line')?.textContent,
        papers: [...document.querySelectorAll('.sbw-paper-title')].map((p) => p.textContent),
        heads: [...document.querySelectorAll('.sbw-papers-head')].map((x) => x.textContent),
        shelves: [...document.querySelectorAll('.sbw-shelf')].map((sh) => [sh.querySelector('.sbw-shelf-title')?.textContent, sh.querySelector('.sbw-shelf-count')?.textContent]),
        hrefs: document.querySelectorAll('.sb-home-view a[href]').length,
        links: document.querySelectorAll('.sb-home-view a[role="link"][tabindex="0"]').length,
        json: [...window.__sbHome.json],
      }));
      check(`${tag}: Today shows today's radar issue and its papers, with the Worth reading group`, home.label === "Today's reading radar" && home.line === '5 new papers'
        && JSON.stringify(home.papers) === '["Burrow microclimates in field voles","Seed caching under snow","A classic of vole ecology"]' && JSON.stringify(home.heads) === '["Worth reading"]', home);
      check(`${tag}: the shelves are Research reports, Chats and Earlier issues, counted`, JSON.stringify(home.shelves) === '[["Research reports","1"],["Chats","10"],["Earlier issues","1"]]', home.shelves);
      check(`${tag}: no link carries an href; each is a keyboard-reachable link the host opens`, home.hrefs === 0 && home.links > 10, { hrefs: home.hrefs, links: home.links });
      check(`${tag}: the graphical abstract was asked for through host.json`, home.json.includes('/paper-figure?doi=10.1%2Fvole'), home.json);

      const before = await page.evaluate(() => location.href);
      await page.locator('.sbw-shelf').filter({ hasText: 'Chats' }).locator('.sbw-cover').first().click();
      const fromCover = await opened(page);
      const bannerIsLink = await page.evaluate(() => document.querySelector('.sbw-today-banner').tagName === 'A');
      await page.locator('.sbw-today-chat:not([hidden])').click();
      const fromBanner = await opened(page);
      await page.locator('a.sbw-paper-title').first().click();
      const fromTitle = await opened(page);
      await page.locator('.sbw-shelf').filter({ hasText: 'Earlier issues' }).locator('.sbw-cover').first().focus();
      const todayTitle = await page.evaluate(() => document.querySelector('.sbw-today-banner .sbw-cover-title')?.textContent);
      await page.keyboard.press('Enter');
      await page.waitForFunction((t) => document.querySelector('.sbw-today-banner .sbw-cover-title')?.textContent !== t, todayTitle);
      const fromKey = await opened(page);
      const issueShown = await page.evaluate(() => ({ papers: document.querySelectorAll('.sbw-paper').length, newer: document.querySelector('.sbw-today-newer')?.textContent }));
      await page.locator('.sbw-today-chat:not([hidden])').click();
      const issueChat = await opened(page);
      const after = await page.evaluate(() => ({ href: location.href, hash: location.hash, pages: window.history.length }));
      check(`${tag}: clicking a chat cover calls the host's open() with that session and leaves location.hash alone`, JSON.stringify(fromCover) === '[{"to":"session","id":"c1"}]' && after.href === before && after.hash === '', { fromCover, before, after });
      check(`${tag}: the Today banner is a picture, not a way into the chat; "Chat about this issue" opens its chat through the host`, !bannerIsLink && JSON.stringify(fromBanner) === '[{"to":"session","id":"c4"}]', { bannerIsLink, fromBanner });
      check(`${tag}: a paper title opens its DOI through the host, not by navigating`, JSON.stringify(fromTitle) === '[{"to":"url","url":"https://doi.org/10.1/vole"}]' && page.url() === before, { fromTitle, url: page.url() });
      check(`${tag}: Enter on an earlier issue opens it on Home as a list (not the chat), with Today › back; its chat is one link away`, JSON.stringify(fromKey) === '[]' && issueShown.newer === 'Today ›' && JSON.stringify(issueChat) === '[{"to":"session","id":"c6"}]', { fromKey, issueShown, issueChat });

      await page.locator('.sbw-today-sources').click();
      await page.waitForSelector('.sbw-page.sbw-sources .sbw-chip');
      const sources = await page.evaluate(() => ({ title: document.querySelector('.sbw-src-title')?.textContent, home: document.querySelectorAll('.sbw-home').length, opened: window.__sbHome.opened.length }));
      check(`${tag}: Sources opens in place of Home, not through the host`, sources.title === 'The more you follow, the richer your radar gets.' && sources.home === 0 && sources.opened === 0, sources);
      check(`${tag}: no page errors`, errors.length === 0, errors);
      await page.close();
    }
  }

  // A fresh data folder: no radar yet, so Home opens on who and what to follow (spec 014 G1), in the plugin as on the web.
  const { page, errors } = await open('tokens=obsidian&routines=none', 900);
  await page.waitForSelector('.sbw-sources.is-intro .sbw-chip');
  const intro = await page.evaluate(() => ({ today: document.querySelectorAll('.sbw-today-banner').length, chats: [...document.querySelectorAll('.sbw-shelf-title')].map((x) => x.textContent) }));
  check('first run: Home opens on the Sources intro instead of Today, the shelves still below', intro.today === 0 && intro.chats.includes('Chats'), intro);
  await page.evaluate(() => window.__sbHome.refresh());
  const kept = await page.evaluate(() => document.querySelectorAll('.sbw-sources.is-intro').length);
  check('refresh() repaints Home in place', kept === 1 && errors.length === 0, { kept, errors });
  await page.close();

  return { failures, count };
}
