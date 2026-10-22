// Declaration for remote.js. TypeScript resolves this sibling before the .js, so a consumer that imports
// "remote.js" (the Obsidian plugin, remote-entry.js for Zotero) is checked against the service.d.ts contract and never
// reaches into this package's JavaScript. agent-src's own `tsc` still checks remote.js itself (checkJs), which
// is annotated to return that same AgentService. How remote.js is bundled and loaded at runtime is unchanged.
export { createRemoteRuntime } from "./service";
