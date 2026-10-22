// Models nest emphasis: bold around an italic title, italics beside bold. The renderer must draw it, never leave the
// asterisks in the text (user report 2026-09-29: "*Zhong et al. (2024), Universal ...*" showed literal stars).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/chat/markdown.js';

// A tiny DOM: enough for markdown.js (createElementNS, className, textContent, append, classList, listeners).
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.attrs = {}; this.classList = { add: (c) => { this.className = `${this.className} ${c}`.trim(); }, contains: (c) => this.className.split(' ').includes(c) }; }
  set textContent(t) { this.children = [String(t)]; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  get lastChild() { return this.children[this.children.length - 1]; }
  get localName() { return this.tag; }
}
const doc = { createElementNS: (_ns, tag) => new Node(tag), createTextNode: (t) => String(t) };
const host = { citeLabel: () => null, resolveLabel: async (k) => k, openRef() {}, openLink() {} };
const html = (n) => (typeof n === 'string' ? n : `<${n.tag}>${n.children.map(html).join('')}</${n.tag}>`);
const render = (md) => html(renderMarkdown(host, doc, md, [])).replace(/^<div>|<\/div>$/g, '');

test('bold around an italic title renders both, with no stray stars', () => {
  const out = render('- **Zhong et al. (2024), *Universal Machine Learning Kohn–Sham Hamiltonian*.** The strongest match.');
  assert.ok(!out.includes('*'), out);
  assert.match(out, /<strong>Zhong et al\. \(2024\), <em>Universal Machine Learning Kohn–Sham Hamiltonian<\/em>\.<\/strong>/);
});

test('bold and italic closing together with *** leaves no stray stars (real model output, 2026-09-29)', () => {
  const out = render('A narrower paper is **Zhang et al. (2022), *Equivariant analytical mapping of Hamiltonians***: its scope is aluminium.');
  assert.ok(!out.includes('*'), out);
  assert.match(out, /<strong>Zhang et al\. \(2022\), <em>Equivariant analytical mapping of Hamiltonians<\/em><\/strong>: its scope/);
});

test('plain bold, plain italic and bold next to italic still work', () => {
  assert.equal(render('a **b** c'), '<p>a <strong>b</strong> c</p>');
  assert.equal(render('a *b* c'), '<p>a <em>b</em> c</p>');
  const both = render('**one** and *two* and **three**');
  assert.ok(!both.includes('*'), both);
  assert.match(both, /<strong>one<\/strong> and <em>two<\/em> and <strong>three<\/strong>/);
});

test('a lone star (math, footnote mark) is left alone', () => {
  assert.equal(render('5 * 3 = 15'), '<p>5 * 3 = 15</p>');
});
