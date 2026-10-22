#!/usr/bin/env node
// web/build.mjs. Bundles the browser app into dist-web/: index.html, app-<hash>.js (an ES module), PDF.js as
// pdf-<hash>.mjs and pdf-worker-<hash>.mjs,
// app-<hash>.css (tokens-web.css + type.css + ui.css + src/home/home.css + src/web/shell.css + src/web/views.css + src/web/sources.css), manifest.webmanifest and an icon. The server
// (web_app.py) serves the hashed files with a year of caching and everything else with no-cache, so a new
// release shows on the next page load.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homeAssets } from '../ui/home-assets.mjs';

// The shared sheets and Home's files come from ../ui; run from web/ (npm run build).
const ui = (/** @type {string} */ path) => `../ui/${path}`;

const out = 'dist-web';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const hashed = (name, ext, body) => `${name}-${createHash('sha256').update(body).digest('hex').slice(0, 8)}.${ext}`;
// PDF.js (Apache-2.0, see THIRD_PARTY.md) stays out of the bundle: the paper reader imports it the first time a PDF opens.
const pdfjs = {};
for (const [name, file] of [['lib', 'pdf.min.mjs'], ['worker', 'pdf.worker.min.mjs']]) {
  const body = readFileSync(`src/vendor/pdfjs/${file}`);
  pdfjs[name] = hashed(name === 'lib' ? 'pdf' : 'pdf-worker', 'mjs', body);
  writeFileSync(`${out}/${pdfjs[name]}`, body);
}

const js = await build({
  entryPoints: ['src/index.js'],
  define: { SB_PDFJS: JSON.stringify(pdfjs) },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'warning',
});
const loginJs = await build({ entryPoints: ['src/login.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, logLevel: 'warning' });
const css = [ui('styles/tokens-web.css'), ui('src/home/type.css'), ui('styles/ui.css'), ui('src/home/home.css'), 'src/shell.css', 'src/views.css', ui('src/sources/sources.css')].map((f) => readFileSync(f, 'utf8')).join('\n');

const jsName = hashed('app', 'js', js.outputFiles[0].contents);
const cssName = hashed('app', 'css', css);
const loginName = hashed('login', 'js', loginJs.outputFiles[0].contents);
writeFileSync(`${out}/${loginName}`, loginJs.outputFiles[0].contents);
writeFileSync(`${out}/${jsName}`, js.outputFiles[0].contents);
writeFileSync(`${out}/${cssName}`, css);
// Home's fonts and cover photos, served from the app itself so they look the same offline and on the phone.
for (const asset of homeAssets()) copyFileSync(asset.path, `${out}/${asset.name}`);

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#3b5bdb"/><path d="M256 112c-79 0-144 55-144 126 0 41 22 77 56 100l-8 58 63-34c10 2 22 3 33 3 79 0 144-55 144-127S335 112 256 112z" fill="none" stroke="#fff" stroke-width="28" stroke-linejoin="round"/><circle cx="200" cy="240" r="16" fill="#fff"/><circle cx="256" cy="240" r="16" fill="#fff"/><circle cx="312" cy="240" r="16" fill="#fff"/></svg>\n`;
writeFileSync(`${out}/icon.svg`, icon);

writeFileSync(`${out}/manifest.webmanifest`, `${JSON.stringify({
  name: 'Second Brain',
  short_name: 'Second Brain',
  start_url: '/app/',
  scope: '/app/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#3b5bdb',
  icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
}, null, 2)}\n`);

writeFileSync(`${out}/index.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Second Brain</title>
<meta name="theme-color" content="#3b5bdb">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon.svg">
<link rel="preload" href="inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="fraunces.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${cssName}">
</head>
<body>
<script type="module" src="${jsName}"></script>
</body>
</html>
`);

// The phone's first stop: public like the rest of the bundle, and the page the server's GET /app/login returns.
writeFileSync(`${out}/login.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Sign in · Second Brain</title>
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${cssName}">
</head>
<body>
<script type="module" src="${loginName}"></script>
</body>
</html>
`);

console.log(`built ${out}/ (${jsName}, ${cssName}, ${loginName})`);
