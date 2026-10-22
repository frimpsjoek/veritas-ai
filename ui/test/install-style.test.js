import test from 'node:test';
import assert from 'node:assert/strict';
import { installStyle } from '../src/chat/dom-helpers.js';

// A document with just what installStyle touches.
function fakeDoc() {
  const nodes = [];
  return {
    nodes,
    getElementById: (id) => nodes.find((n) => n.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    documentElement: { append: (n) => nodes.push(n) },
  };
}

test('installStyle adds the sheet once and refreshes it when the CSS changed (plugin updated without a restart)', () => {
  const doc = fakeDoc();
  installStyle(doc, 'x-style', 'a { color: red }');
  installStyle(doc, 'x-style', 'a { color: red }');
  assert.equal(doc.nodes.length, 1);
  installStyle(doc, 'x-style', 'a { color: blue }');
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].textContent, 'a { color: blue }');
});
