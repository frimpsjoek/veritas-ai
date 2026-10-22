// The Zotero bundle (zotero/content/agent.js, global SecondBrainAgent). Zotero is a client of the Veritas server, like
// the Obsidian plugin: content/agent-host.js turns its HTTP transport into an AgentService with createRemoteRuntime, and
// the Settings pane reads the outside-sources catalog. Nothing here runs an agent inside Zotero.
export { createRemoteRuntime } from './remote.js';
export { MCP_CATALOG } from './catalog.js';
