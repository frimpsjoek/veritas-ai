#!/usr/bin/env node
// agent-src/build.mjs. Bundles the sidecar to a single dependency-free file so `kb.py serve` can spawn it with a
// plain `node dist/agentd.mjs`, without the Python side needing to know about ES module resolution or our
// source layout. esbuild is a devDependency only (package.json); nothing in dist/ requires node_modules at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/node/agentd.mjs'],
  outfile: 'dist/agentd.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18', // agentd.mjs's own shebang line survives the bundle; esbuild keeps a leading `#!` verbatim
});
console.log('built dist/agentd.mjs');
