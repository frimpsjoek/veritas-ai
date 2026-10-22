// Bundles the core for Zotero: content/agent.js, an IIFE that defines the SecondBrainAgent global.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/gecko/entry.js'],
  bundle: true,
  format: 'iife',
  globalName: 'SecondBrainAgent',
  platform: 'neutral',
  target: 'es2022',
  inject: ['src/gecko/shims.js'],
  outfile: '../content/agent.js',
  logLevel: 'warning',
});
