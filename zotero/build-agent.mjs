// zotero/build-agent.mjs. Bundles the agent core (../agent) for Zotero: content/agent.js, an IIFE that defines the
// SecondBrainAgent global.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const agent = (/** @type {string} */ path) => fileURLToPath(new URL(`../agent/${path}`, import.meta.url));

await build({
  entryPoints: [agent('src/gecko/entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'SecondBrainAgent',
  platform: 'neutral',
  target: 'es2022',
  inject: [agent('src/gecko/shims.js')],
  outfile: fileURLToPath(new URL('./content/agent.js', import.meta.url)),
  logLevel: 'warning',
});
