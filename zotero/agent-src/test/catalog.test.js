import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_CATALOG, catalogEntry } from '../src/catalog.js';

test('every entry has a unique id, a transport-appropriate config, and a name matching its config', () => {
  const ids = new Set();
  for (const entry of MCP_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(entry.config.name, entry.id);
    if (entry.config.transport === 'stdio') assert.ok(entry.config.command && Array.isArray(entry.config.args));
    else assert.ok(/^https?:\/\//.test(entry.config.url));
  }
});

test('paper-search is disabled by default: no verified way to turn off its Google Scholar source', () => {
  const entry = catalogEntry('paper-search');
  assert.equal(entry.config.enabled, false);
  assert.match(entry.note, /Google Scholar/);
});

test('the PubMed entry (criterion 5) is the exact npx invocation the README gives', () => {
  const entry = catalogEntry('pubmed');
  assert.equal(entry.config.transport, 'stdio');
  assert.equal(entry.config.command, 'npx');
  assert.deepEqual(entry.config.args, ['-y', '@cyanheads/pubmed-mcp-server@latest']);
  assert.equal(entry.config.enabled, true);
});

test('niche and optional tiers are marked, and unverified entries say so', () => {
  const niche = MCP_CATALOG.filter((e) => e.tier === 'niche');
  assert.ok(niche.length >= 2);
  for (const entry of niche) assert.equal(entry.verified, false, `${entry.id} should be marked unverified`);
  const optional = MCP_CATALOG.filter((e) => e.tier === 'optional');
  for (const entry of optional) assert.match(entry.note ?? '', /paid|limited/i);
});

test('catalogEntry returns null for an unknown id', () => {
  assert.equal(catalogEntry('does-not-exist'), null);
});
