// ui/home-assets.mjs. What Home needs beside its stylesheet, for every build: web/build.mjs (dist-web/),
// zotero/build-ui.mjs (Zotero's content/home/) and the Obsidian plugin's esbuild.config.mjs (inlined as data: URLs).
// Paths are relative to ui/; `name` is the file name home.css and type.css use in their url()s.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (/** @type {string} */ path) => fileURLToPath(new URL(path, import.meta.url));

/** The sheets Home and the Sources page need, in order, after a host's token map and ui.css. */
export const HOME_CSS = ['src/home/type.css', 'src/home/home.css', 'src/sources/sources.css'].map(here);

// Fraunces (headings) and Inter (interface), both SIL OFL; cover photos from the NASA Image Library (covers/CREDITS.txt).
const FONTS = ['fraunces.woff2', 'fraunces-italic.woff2', 'fraunces-ext.woff2', 'fraunces-italic-ext.woff2', 'inter.woff2', 'inter-ext.woff2'];

/** @returns {{ name: string, path: string }[]} */
export function homeAssets() {
  const photos = readdirSync(here('covers')).filter((f) => f.endsWith('.webp')).sort();
  return [
    ...FONTS.map((f) => ({ name: f, path: here(`fonts/${f}`) })),
    ...photos.map((f) => ({ name: `cover-${f}`, path: here(`covers/${f}`) })),
  ];
}

/** The Home sheets as one, every url("name") of an asset replaced by `urlOf(asset)`. */
export function homeCss(/** @type {(asset: { name: string, path: string }) => string} */ urlOf = (a) => a.name) {
  const byName = new Map(homeAssets().map((a) => [a.name, a]));
  const css = HOME_CSS.map((f) => readFileSync(f, 'utf8')).join('\n');
  return css.replace(/url\("([^")]+)"\)/g, (whole, name) => {
    const asset = byName.get(name);
    if (!asset) throw new Error(`home css names ${name}, which no build ships`);
    return `url("${urlOf(asset)}")`;
  });
}

/** A data: URL for an asset (Obsidian serves a plugin's styles.css and main.js only). */
export const dataUrl = (/** @type {{ name: string, path: string }} */ a) =>
  `data:${a.name.endsWith('.woff2') ? 'font/woff2' : 'image/webp'};base64,${readFileSync(a.path).toString('base64')}`;
