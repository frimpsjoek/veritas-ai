#!/usr/bin/env node
// ui-src/build.mjs. Bundles the shared UI for Zotero: content/sb-ui.js, an IIFE that defines the global
// SecondBrainUI (loaded by bootstrap.js with loadSubScript, like every other content/*.js file), plus
// content/sb-ui.css (the token-free component styles) and content/sb-ui-zotero-tokens.css (Zotero's token map,
// injected once per chrome document by the host adapter) and content/home/ (Home's sheet, fonts and photos).
// Obsidian does not use this script: its own esbuild.config.mjs imports ui-src/src/index.js directly into main.js,
// concatenates ui.css + tokens-obsidian.css + its own remaining panel CSS into styles.css and inlines Home's sheet.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homeAssets, homeCss } from './home-assets.mjs';

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  globalName: 'SecondBrainUI',
  platform: 'neutral',
  target: 'es2022',
  outfile: '../content/sb-ui.js',
  logLevel: 'warning',
});

copyFileSync('styles/ui.css', '../content/sb-ui.css');
copyFileSync('styles/tokens-zotero.css', '../content/sb-ui-zotero-tokens.css');
// Home's sheet with its fonts and cover photos beside it, so its relative url()s resolve inside the xpi.
rmSync('../content/home', { recursive: true, force: true });
mkdirSync('../content/home');
writeFileSync('../content/home/sb-home.css', homeCss());
for (const asset of homeAssets()) copyFileSync(asset.path, `../content/home/${asset.name}`);
for (const notice of ['fonts/OFL-fraunces.txt', 'fonts/OFL-inter.txt', 'covers/CREDITS.txt']) copyFileSync(notice, `../content/home/${notice.split('/')[1]}`);

console.log('built content/sb-ui.js, content/sb-ui.css, content/sb-ui-zotero-tokens.css, content/home/');
