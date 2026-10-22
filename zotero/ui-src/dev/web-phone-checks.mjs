// ui-src/dev/web-phone-checks.mjs. Playwright checks for spec 013 W4 against the built dist-web/ bundle: the sign-in page
// (token from the fragment, one POST, fragment cleared, plain messages), the Settings "Use on your phone" section
// (QR, link, the plain "not set up" answers), the 401 redirect, and the 360 px layout of chat, the readers and tables.
// Invented content only. Run by dev/run.mjs (SB_ONLY=webphone).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFixtures } from './web-fixtures.mjs';

const dist = fileURLToPath(new URL('../dist-web', import.meta.url));
const LINK = 'https://mac.tail1234.ts.net/app/login#t=invented-token-0123456789';

/** @param {import("playwright").Browser} browser @param {number} port @param {string} outDir */
export async function runWebPhoneChecks(browser, port, outDir) {
  let failures = 0;
  let count = 0;
  const check = (name, ok, detail) => {
    count += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} webphone: ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
  };
  const files = readdirSync(dist);
  const js = files.find((f) => /^app-[0-9a-f]{8}\.js$/.test(f));
  const css = files.find((f) => /^app-[0-9a-f]{8}\.css$/.test(f));
  if (!js || !css || !files.includes('login.html')) { check('the bundle is built with login.html (run npm run build:web first)', false, files); return { failures, count }; }
  const origin = `http://127.0.0.1:${port}`;
  const fakeUrl = `${origin}/dev/harness/web.html?js=${encodeURIComponent(`/dist-web/${js}`)}&css=${encodeURIComponent(`/dist-web/${css}`)}`;
  const noSideways = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
  const html = (body) => ({ status: 200, contentType: 'text/html', body: `<!doctype html><title>after</title>${body}` });

  async function newPage(width, height = 800) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.errors = [];
    page.on('pageerror', (error) => page.errors.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 40[13]|Failed to load resource/.test(msg.text())) page.errors.push(msg.text()); });
    return page;
  }

  // ------------------------------------------------------------ the sign-in page
  /** @param {number} width @param {string} hash @param {(route: import("playwright").Route) => Promise<void>} answer */
  async function login(width, hash, answer) {
    const page = await newPage(width);
    const posts = [];
    await page.route('**/dist-web/login', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts.push({ url: route.request().url(), body: JSON.parse(route.request().postData() ?? '{}') });
      await answer(route);
    });
    await page.route('**/dist-web/', (route) => route.fulfill(html('<p>home</p>')));
    await page.goto(`${origin}/dist-web/login.html${hash}`);
    return { page, posts };
  }

  for (const width of [360, 1280]) {
    const tag = `${width}px`;
    let { page, posts } = await login(width, '#t=invented-token', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.waitForURL('**/dist-web/#/home');
    check(`${tag} sign-in posts the fragment token once, to /login, with no query string`, posts.length === 1 && posts[0].body.token === 'invented-token' && !posts[0].url.includes('?'), posts);
    check(`${tag} after signing in the address holds neither the token nor a query`, !page.url().includes('invented-token') && !page.url().includes('?'), page.url());
    await page.close();

    ({ page, posts } = await login(width, '#t=stale', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"wrong token"}' })));
    await page.waitForFunction(() => /didn't work/.test(document.body.innerText));
    const wrong = await page.evaluate(() => ({ text: document.querySelector('.sbw-lead').textContent, form: !document.querySelector('.sbw-login-form').hidden, hash: location.hash, enabled: !document.querySelector('.sbw-login-form button').disabled }));
    check(`${tag} a wrong token gets a plain message, the form comes back and the fragment is gone`, /Settings/.test(wrong.text) && wrong.form && wrong.hash === '' && wrong.enabled && !/401|error/i.test(wrong.text), wrong);
    check(`${tag} the sign-in page has no sideways scroll`, await noSideways(page));
    if (width === 360) await page.setViewportSize({ width: 390, height: 844 }).then(() => page.screenshot({ path: join(outDir, 'w4-login-390.png') }));
    check(`${tag} the sign-in page logged no errors`, page.errors.length === 0, page.errors);
    await page.close();

    ({ page } = await login(width, '#t=x', (route) => route.abort()));
    await page.waitForFunction(() => /Couldn't reach your Mac/.test(document.body.innerText));
    check(`${tag} an unreachable Mac is said plainly`, true);
    await page.close();

    ({ page, posts } = await login(width, '', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })));
    const bare = await page.evaluate(() => ({ form: !document.querySelector('.sbw-login-form').hidden, size: getComputedStyle(document.querySelector('.sbw-login-form input')).fontSize }));
    check(`${tag} with no fragment the page asks for the code (16 px field so iOS does not zoom)`, bare.form && bare.size === '16px' && posts.length === 0, bare);
    await page.fill('.sbw-login-form input', ' pasted-code ');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/dist-web/#/home');
    check(`${tag} a pasted code is trimmed and posted`, posts.length === 1 && posts[0].body.token === 'pasted-code', posts);
    await page.close();
  }

  // ------------------------------------------------------------ a phone that has not signed in is sent to the sign-in page
  {
    const page = await newPage(360);
    await page.route('**/web/state', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"a valid token is required"}' }));
    await page.route('**/dist-web/login', (route) => route.fulfill(html('<p>sign in</p>')));
    await page.goto(`${origin}/dist-web/index.html#/home`);
    await page.waitForURL('**/dist-web/login');
    check('a 401 on /web/state sends the app to login next to index.html', true);
    await page.close();
  }

  // ------------------------------------------------------------ Settings: Use on your phone
  async function settings(width, answer, height = 800) {
    const page = await newPage(width, height);
    await useFixtures(page);
    await page.route('**/web/phone-link', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }));
    await page.goto(fakeUrl);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    await page.evaluate(() => { location.hash = '#/settings?section=server'; });
    await page.waitForSelector('.sbw-page');
    return page;
  }
  for (const width of [1280, 390, 360]) {
    const tag = `${width}px`;
    const page = await settings(width, { url: LINK, host: 'mac.tail1234.ts.net', secure: true });
    await page.waitForSelector('.sbw-qr svg');
    const qr = await page.evaluate(() => {
      const svg = document.querySelector('.sbw-qr svg'); const box = svg.getBoundingClientRect();
      const input = document.querySelector('.sbw-phone-url');
      const [, , w] = svg.getAttribute('viewBox').split(' ').map(Number);
      return { modules: w, dark: (svg.querySelector('path').getAttribute('d').match(/M/g) ?? []).length, w: box.width, h: box.height, url: input.value, inView: box.right <= innerWidth && input.getBoundingClientRect().right <= innerWidth,
        headings: [...document.querySelectorAll('.sbs-title')].map((n) => n.textContent) };
    });
    check(`${tag} Settings shows the sign-in link as a QR code and as text`, qr.url === LINK && qr.modules >= 29 && qr.dark > 300 && Math.abs(qr.w - qr.h) < 1 && qr.w >= 200 && qr.inView, qr);
    check(`${tag} the phone code sits in Server and phone`, JSON.stringify(qr.headings) === '["Server and phone"]', qr.headings);
    check(`${tag} Settings has no sideways scroll with the QR`, await noSideways(page));
    if (width === 390) await page.screenshot({ path: join(outDir, 'w4-settings-phone-390.png'), fullPage: true });
    check(`${tag} Settings logged no errors`, page.errors.length === 0, page.errors);
    await page.close();
  }
  {
    const page = await settings(390, { problem: 'Tailscale is running, but it does not forward to Second Brain yet. Run this once in Terminal:', command: 'tailscale serve --bg --https=8443 http://127.0.0.1:27182' });
    await page.waitForSelector('.sbw-command');
    const text = await page.evaluate(() => ({ cmd: document.querySelector('.sbw-command').textContent, hint: document.querySelector('.sbw-command').previousElementSibling.textContent, qr: document.querySelectorAll('.sbw-qr').length }));
    check('without tailscale serve, Settings says so plainly and shows the one command, no QR', text.cmd === 'tailscale serve --bg --https=8443 http://127.0.0.1:27182' && /does not forward/.test(text.hint) && text.qr === 0, text);
    await page.screenshot({ path: join(outDir, 'w4-settings-phone-missing-390.png') });
    await page.close();
  }

  // ------------------------------------------------------------ 360 px layout
  {
    const page = await newPage(360, 740);
    await useFixtures(page);
    await page.route('**/web/phone-link', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"only on the Mac itself"}' }));
    await page.goto(fakeUrl);
    await page.waitForFunction(() => window.__sbWebReady === true, null, { timeout: 8000 });
    const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(250); };

    await go('#/chat?session=c1');
    await page.waitForSelector('.sb-ai-input');
    const chat = await page.evaluate(() => {
      const input = document.querySelector('.sb-ai-composer').getBoundingClientRect();
      const rail = document.querySelector('.sbw-rail').getBoundingClientRect();
      return { gap: Math.round(rail.top - input.bottom), railBottom: Math.round(rail.bottom), vh: innerHeight, scrolls: document.scrollingElement.scrollHeight > innerHeight };
    });
    check('360px the composer sits right above the bottom bar and the page itself does not scroll', chat.gap >= 0 && chat.gap <= 1 && chat.railBottom === chat.vh && !chat.scrolls, chat);

    await go('#/paper/K0001');
    await page.waitForSelector('.sbw-reader-article');
    const reader = await page.evaluate(() => {
      const left = (s) => { const el = document.querySelector(s); if (!el || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; };
      return { article: left('.sbw-reader-article'), panel: left('.sbw-reader-panel'), toc: left('.sbw-reader-toc') };
    });
    const lefts = Object.values(reader).filter(Boolean).map((r) => r.l);
    check('360px the paper reader is one column', reader.article && reader.article.w >= 300 && new Set(lefts).size === 1, reader);
    check('360px the paper reader has no sideways scroll', await noSideways(page));

    await go('#/note/Voles/Winter%20diet.md');
    await page.waitForSelector('.sbw-note-body');
    const table = await page.evaluate(() => {
      const body = document.querySelector('.sbw-note-body');
      body.insertAdjacentHTML('beforeend', `<table id="wide"><tr>${Array.from({ length: 12 }, (_, i) => `<td>Column number ${i} of an invented table</td>`).join('')}</tr></table>`);
      const t = document.getElementById('wide');
      return { inner: t.scrollWidth, shown: t.clientWidth, page: document.scrollingElement.scrollWidth, vw: innerWidth };
    });
    check('360px a wide table scrolls inside its card and the page stays put', table.inner > table.shown && table.page <= table.vw, table);
    check('360px the note reader is one column', await page.evaluate(() => { const a = document.querySelector('.sbw-reader-article')?.getBoundingClientRect(); return !a || a.width >= 300; }));
    check('360px chat, readers and tables logged no errors', page.errors.length === 0, page.errors);
    await page.close();
  }

  return { failures, count };
}
