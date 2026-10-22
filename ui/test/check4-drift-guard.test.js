// Spec 005 C4 (drift guard). Two things must never come back into a host file now that the chat lives in
// ui-src: (a) a CSS rule that redefines the shared component's own classes (sb-ai-*/sb-fp-*/sb-rp-*) -- if a
// host needs to nudge layout it scopes the selector under its own class instead, the way
// content/chat-sidebar.js's ".sb-chat-dock.is-short .sb-ai-empty { margin-top: 12px; }" already does (kept
// legal on purpose: it's a host-scoped tweak, not a redefinition), and (b) a host shell building chat DOM
// itself again, which would show up as a quoted JS string naming one of those classes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const zoteroContent = fileURLToPath(new URL('../../zotero/content', import.meta.url));
const obsidianSrc = fileURLToPath(new URL('../../obsidian/src', import.meta.url));

// Only the chat's own host-side shell/adapter files: "sb-ai-" is also used as a generic prefix elsewhere in
// content/ (e.g. preferences.js's own settings-panel ids, unrelated to the chat), so this deliberately does not
// scan every content/*.js / src/*.ts file -- that would flag unrelated, legitimate code under the same prefix.
const ZOTERO_CHAT_FILES = ['chat.js', 'chat-sidebar.js', 'ui-host-zotero.js'];
const OBSIDIAN_CHAT_FILES = ['chat.ts', 'ui-host.ts'];

// A rule whose selector STARTS with a shared class (optionally after whitespace/a combinator) redefines it; a
// compound selector where the shared class is scoped under something else ("host-class .sb-ai-empty { }")
// is a host tweak and stays legal.
const OWN_RULE = /(^|\n)\s*\.(?:sb-ai|sb-fp|sb-rp)-[\w-]+(?:[:.][\w-]+)*\s*\{/;
// A quoted JS string naming one of the shared classes: the tell-tale of a host building the chat's own DOM
// again (el(doc, 'div', 'sb-ai-empty'), classList.add('sb-fp-row'), etc.) rather than mounting ui-src's view.
const DOM_STRING = /['"](?:sb-ai|sb-fp|sb-rp)-[\w-]+['"]/;

/** @param {string} dir @param {string[]} files */
function scan(dir, files) {
  const problems = [];
  for (const file of files) {
    const text = readFileSync(`${dir}/${file}`, 'utf8');
    if (OWN_RULE.test(text)) problems.push(`${file}: defines a .sb-ai-/.sb-fp-/.sb-rp- rule directly (host CSS drift)`);
    if (DOM_STRING.test(text)) problems.push(`${file}: names a shared class in a quoted string (host DOM drift)`);
  }
  return problems;
}

test('Zotero: chat.js/chat-sidebar.js/ui-host-zotero.js define no shared chat CSS and build no shared chat DOM', () => {
  const problems = scan(zoteroContent, ZOTERO_CHAT_FILES);
  assert.deepEqual(problems, []);
});

test('Obsidian: chat.ts/ui-host.ts define no shared chat CSS and build no shared chat DOM', () => {
  const problems = scan(obsidianSrc, OBSIDIAN_CHAT_FILES);
  assert.deepEqual(problems, []);
});

test('sanity: the guard actually catches a reintroduced .sb-ai-send rule (this is what "chat-sidebar.js: an .sb-ai-send rule would fail" means)', () => {
  const injected = 'const STYLE = `\n.sb-ai-send { background: red; }\n`;\n';
  assert.match(injected, OWN_RULE);
  const legit = 'const STYLE = `\n.sb-chat-dock.is-short .sb-ai-empty { margin-top: 12px; }\n`;\n';
  assert.doesNotMatch(legit, OWN_RULE);
});
