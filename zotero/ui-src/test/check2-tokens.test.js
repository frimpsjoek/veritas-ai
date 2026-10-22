// Success check 2 (spec 005): "grep finds no color literal or host theme variable in ui-src/src/*.css other
// than inside the two token maps." styles/ui.css must only ever reference --sb-ui-* custom properties (or plain
// CSS keyword values like "none", "round", numbers); the token maps (tokens-zotero.css, tokens-obsidian.css) are
// the only place a host variable (--material-*, --fill-*, --background-*, --interactive-*, --text-*, --color-*,
// --accent-*, --font-*) or a hex/rgb color literal may appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stylesDir = fileURLToPath(new URL('../styles', import.meta.url));
const HOST_VAR = /--(?:material|fill|background|interactive|text|color-accent|accent|font)-[\w-]*/g;
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_COLOR = /\brgba?\(/g;

test('ui.css (the component sheet, not a token map) references only --sb-ui-* custom properties, no host variable or color literal', () => {
  const css = readFileSync(`${stylesDir}/ui.css`, 'utf8');
  const hostVars = css.match(HOST_VAR) ?? [];
  const hexColors = css.match(HEX_COLOR) ?? [];
  const rgbColors = css.match(RGB_COLOR) ?? [];
  assert.deepEqual(hostVars, [], 'ui.css must not reference a host theme variable directly');
  assert.deepEqual(hexColors, [], 'ui.css must not contain a hex color literal');
  assert.deepEqual(rgbColors, [], 'ui.css must not contain an rgb()/rgba() color literal');
});

test('every custom property ui.css uses is --sb-ui-*', () => {
  const css = readFileSync(`${stylesDir}/ui.css`, 'utf8');
  const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'sanity: ui.css should use at least one custom property');
  for (const name of used) assert.match(name, /^--sb-ui-/, `${name} is not an --sb-ui-* token`);
});

test('the token maps are the only *.css files allowed to define --sb-ui-* against a host variable', () => {
  const files = readdirSync(stylesDir).filter((f) => f.endsWith('.css'));
  assert.deepEqual(files.sort(), ['tokens-obsidian.css', 'tokens-web.css', 'tokens-zotero.css', 'ui.css']);
  for (const file of files) {
    if (file === 'ui.css') continue;
    const css = readFileSync(`${stylesDir}/${file}`, 'utf8');
    assert.match(css, /--sb-ui-bg:/, `${file} should define the --sb-ui-* token set`);
  }
});

// Spec 008: the chat's own component CSS lives in template strings in src/chat/*.js (injected by ChatView.style()
// and friends), not in ui.css, so the same rule applies there: --sb-ui-* tokens only, no color literal.
test('the CSS strings in src/chat/*.js use only --sb-ui-* custom properties and no color literal', () => {
  const chatDir = fileURLToPath(new URL('../src/chat', import.meta.url));
  for (const file of readdirSync(chatDir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(`${chatDir}/${file}`, 'utf8');
    for (const [, css] of source.matchAll(/_CSS = `([\s\S]*?)`;/g)) {
      const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
      for (const name of used) assert.match(name, /^--sb-ui-/, `${file}: ${name} is not an --sb-ui-* token`);
      assert.deepEqual(css.match(HEX_COLOR) ?? [], [], `${file}: hex color literal`);
      assert.deepEqual(css.match(RGB_COLOR) ?? [], [], `${file}: rgb()/rgba() color literal`);
    }
  }
});

// Spec 014 G4: Home runs in Zotero and Obsidian too, so its sheets take colours from the host's --sb-ui-* map only.
// The literals they keep are the covers' own (white type and veils over a photo, the muted tones under it).
test('Home and Sources sheets read colours through --sb-ui-* only, never a host variable', () => {
  for (const file of ['../src/home/home.css', '../src/home/type.css', '../src/web/sources.css']) {
    const css = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.deepEqual(css.match(HOST_VAR) ?? [], [], `${file} must not reference a host theme variable`);
    for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) assert.match(name, /^--(?:sb-ui-|sbw-|photo$|tone$)/, `${file}: ${name}`);
  }
});
