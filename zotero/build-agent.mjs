// zotero/build-agent.mjs. Bundles the agent's remote client (../agent/src/remote-entry.js) for Zotero: content/agent.js,
// an IIFE that defines the SecondBrainAgent global (createRemoteRuntime, MCP_CATALOG). The agent itself runs on the
// Veritas server.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const agent = (/** @type {string} */ path) => fileURLToPath(new URL(`../agent/${path}`, import.meta.url));

await build({
  entryPoints: [agent('src/remote-entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'SecondBrainAgent',
  platform: 'neutral',
  target: 'es2022',
  outfile: fileURLToPath(new URL('./content/agent.js', import.meta.url)),
  logLevel: 'warning',
});
