#!/usr/bin/env node
// zotero/build-ui.mjs. Bundles the shared UI (../ui) for Zotero: content/sb-ui.js, an IIFE that defines the global
// SecondBrainUI (loaded by bootstrap.js with loadSubScript, like every other content/*.js file), plus
// content/sb-ui.css (the token-free component styles) and content/sb-ui-zotero-tokens.css (Zotero's token map,
// injected once per chrome document by the host adapter) and content/home/ (Home's sheet, fonts and photos).
// Obsidian does not use this script: its own esbuild.config.mjs imports ui/src/index.js directly into main.js,
// concatenates ui.css + tokens-obsidian.css + its own remaining panel CSS into styles.css and inlines Home's sheet.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homeAssets, homeCss } from '../ui/home-assets.mjs';

// Inputs come from ../ui, outputs go to this plugin's content/, wherever the script is run from.
const ui = (/** @type {string} */ path) => fileURLToPath(new URL(`../ui/${path}`, import.meta.url));
const content = (/** @type {string} */ path) => fileURLToPath(new URL(`./content/${path}`, import.meta.url));

await build({
  entryPoints: [ui('src/index.js')],
  bundle: true,
  format: 'iife',
  globalName: 'SecondBrainUI',
  platform: 'neutral',
  target: 'es2022',
  outfile: content('sb-ui.js'),
  logLevel: 'warning',
});

copyFileSync(ui('styles/ui.css'), content('sb-ui.css'));
copyFileSync(ui('styles/tokens-zotero.css'), content('sb-ui-zotero-tokens.css'));
// Home's sheet with its fonts and cover photos beside it, so its relative url()s resolve inside the xpi.
rmSync(content('home'), { recursive: true, force: true });
mkdirSync(content('home'));
writeFileSync(content('home/sb-home.css'), homeCss());
for (const asset of homeAssets()) copyFileSync(asset.path, content(`home/${asset.name}`));
for (const notice of ['fonts/OFL-fraunces.txt', 'fonts/OFL-inter.txt', 'covers/CREDITS.txt']) copyFileSync(ui(notice), content(`home/${notice.split('/')[1]}`));

console.log('built content/sb-ui.js, content/sb-ui.css, content/sb-ui-zotero-tokens.css, content/home/');
