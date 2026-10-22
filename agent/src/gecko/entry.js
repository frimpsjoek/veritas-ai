// The Zotero bundle (content/agent.js, global SecondBrainAgent). content/agent-host.js is its only caller.
export { createGeckoPlatform } from './platform.js';
export { createLocalRuntime, ASK_SCHEMA, ASK_INSTRUCTIONS } from '../core.js';
export { createToolGateway, createMcpHttpHandler, reasonForVerdict } from '../tools.js';
export { createSettingsStore } from '../settings.js';
export { MCP_CATALOG, catalogEntry } from '../catalog.js';
export { createProviders } from '../providers/index.js';
export { createHttpLibraryBackend, createHttpSkillSource } from '../library-http.js';
export { extractCitationRefs, citationKey } from '../citations.js';
// agent-host.js's serverRuntime(): when the Second Brain server answers /agent/ping, this is what turns its
// remoteTransport() (an HTTP client, no Zotero-specific knowledge inside remote.js itself) into a real
// AgentService, the same contract createLocalRuntime satisfies above.
export { createRemoteRuntime } from '../remote.js';
export { createFolderSkillSource } from '../skills.js';
