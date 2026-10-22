// @ts-check
// agent-src/src/catalog.js (T6.3). Static data, not code: every entry becomes an McpServerConfig (tools.d.ts)
// with one click in Settings. Sourced from specs/001-second-brain-ai/research-mcp-catalog.md (2026-09-25) and
// re-verified against each repo's own README this task (2026-09-25) via WebFetch; `verified: true` entries had
// their exact package name and stdio invocation confirmed live, `verified: false` entries are carried over from
// the research doc as-is (either not re-checked, or the repo gives no fixed command to hardcode).

/** @typedef {import("./tools").McpServerConfig} McpServerConfig */
/**
 * @typedef {{
 *   id: string, name: string, homepage: string, description: string,
 *   tier: "default" | "niche" | "optional",
 *   auth: string,
 *   verified: boolean,
 *   note?: string,
 *   config: McpServerConfig,
 *   setup?: Setup,
 * }} CatalogEntry
 */
/**
 * What the Connect guide asks for (server spec 020 G3). A `key` field is secret: it goes to the Keychain and
 * is never shown again; an `email` is not secret. `prefix` is put in front of what the user pastes ("Bearer ").
 * @typedef {{ in: "env" | "header", name: string, label: string, kind: "key" | "email", optional?: boolean, prefix?: string }} SetupField
 * @typedef {{ fields: SetupField[], getKey?: { url: string, steps: string } }} Setup
 */

function stdio(name, command, args, env = {}) {
  return /** @type {McpServerConfig} */ ({ name, enabled: true, transport: 'stdio', command, args, env });
}

/** @type {CatalogEntry[]} */
export const MCP_CATALOG = [
  {
    id: 'pubmed', name: 'PubMed / Europe PMC', tier: 'default', verified: true,
    homepage: 'https://github.com/cyanheads/pubmed-mcp-server',
    description: 'MeSH terms, the PMC/EPMC/Unpaywall full-text chain, and citation formatting.',
    auth: 'None required; an optional free NCBI_API_KEY raises the rate limit from 3 to 10 requests/second.',
    config: stdio('pubmed', 'npx', ['-y', '@cyanheads/pubmed-mcp-server@latest'], { MCP_TRANSPORT_TYPE: 'stdio' }),
    setup: { fields: [{ in: 'env', name: 'NCBI_API_KEY', label: 'NCBI API key', kind: 'key', optional: true }], getKey: { url: 'https://account.ncbi.nlm.nih.gov/settings/', steps: 'Sign in to NCBI, open Account settings, find API Key Management and press Create an API Key. Optional: without it PubMed allows 3 requests a second.' } },
  },
  {
    id: 'clinicaltrials', name: 'ClinicalTrials.gov', tier: 'default', verified: true,
    homepage: 'https://github.com/cyanheads/clinicaltrialsgov-mcp-server',
    description: 'Trial registry search, study details and results, and patient-eligibility matching.',
    auth: 'None.',
    // The npm package has no @cyanheads scope even though the repo does (confirmed live, differs from the
    // research doc's assumption that every cyanheads repo publishes under its own npm scope).
    config: stdio('clinicaltrials', 'npx', ['-y', 'clinicaltrialsgov-mcp-server@latest'], { MCP_TRANSPORT_TYPE: 'stdio' }),
  },
  {
    id: 'pubchem', name: 'PubChem', tier: 'default', verified: true,
    homepage: 'https://github.com/cyanheads/pubchem-mcp-server',
    description: 'Compound properties and bioassay data.',
    auth: 'None; PubChem’s API is freely accessible.',
    config: stdio('pubchem', 'npx', ['-y', '@cyanheads/pubchem-mcp-server@latest'], { MCP_TRANSPORT_TYPE: 'stdio' }),
  },
  {
    id: 'chembl', name: 'ChEMBL', tier: 'default', verified: true,
    homepage: 'https://github.com/cyanheads/chembl-mcp-server',
    description: 'Bioactivity data and drug mechanisms.',
    auth: 'None.',
    config: stdio('chembl', 'npx', ['-y', '@cyanheads/chembl-mcp-server@latest'], { MCP_TRANSPORT_TYPE: 'stdio' }),
  },
  {
    id: 'arxiv', name: 'arXiv full text', tier: 'default', verified: true,
    homepage: 'https://github.com/cyanheads/arxiv-mcp-server',
    description: 'Full paper text from arXiv (HTML/ar5iv), not just abstracts.',
    auth: 'None.',
    config: stdio('arxiv', 'npx', ['-y', '@cyanheads/arxiv-mcp-server@latest'], {}),
  },
  {
    id: 'paper-search', name: 'Multi-source paper search', tier: 'default', verified: true,
    homepage: 'https://github.com/openags/paper-search-mcp',
    description: '20+ sources with PDF text extraction (arXiv, PubMed, bioRxiv, Semantic Scholar and more).',
    auth: 'A contact email for Unpaywall/OpenAlex’s polite pool; an optional free CORE key improves stability.',
    // Verified live (2026-09-25): the README documents no toggle, env var or CLI flag to disable any one of its
    // 20+ sources, including Google Scholar, individually -- despite that being exactly what the research doc
    // called for ("disable its Google Scholar source"). Left disabled by default and flagged with a loud note
    // rather than silently shipping a server this catalog can't actually keep off Google's ToS-fragile scraper;
    // see rationale.md's P6 reconciliation entry.
    note: 'Cannot be configured to skip Google Scholar. Off by default; review before enabling.',
    config: { ...stdio('paper-search', 'uvx', ['paper-search-mcp'], { PAPER_SEARCH_MCP_UNPAYWALL_EMAIL: '' }), enabled: false },
    setup: { fields: [{ in: 'env', name: 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL', label: 'Your email', kind: 'email' }] },
  },
  {
    id: 'unpaywall', name: 'Unpaywall', tier: 'default', verified: true,
    homepage: 'https://github.com/ElliotPadfield/unpaywall-mcp',
    description: 'Legal open-access PDFs by DOI.',
    auth: 'A contact email, required by the Unpaywall API.',
    config: stdio('unpaywall', 'npx', ['-y', 'unpaywall-mcp'], { UNPAYWALL_EMAIL: '' }),
    setup: { fields: [{ in: 'env', name: 'UNPAYWALL_EMAIL', label: 'Your email', kind: 'email' }] },
  },
  {
    id: 'wikipedia', name: 'Wikipedia', tier: 'default', verified: true,
    homepage: 'https://github.com/Rudra-ravi/wikipedia-mcp',
    description: 'Background definitions and general context.',
    auth: 'None; an optional WIKIPEDIA_ACCESS_TOKEN avoids rate limiting.',
    config: stdio('wikipedia', 'uvx', ['wikipedia-mcp', '--transport', 'stdio'], {}),
  },
  {
    id: 'nasa-ads', name: 'NASA ADS', tier: 'niche', verified: false,
    homepage: 'https://github.com/prtc/nasa-ads-mcp',
    description: 'Astronomy citation graph.',
    auth: 'A free ADS_API_KEY.',
    note: 'Not re-verified this pass; carried over from research-mcp-catalog.md. Confirm the package name before enabling.',
    config: stdio('nasa-ads', 'npx', ['-y', 'nasa-ads-mcp'], { ADS_API_KEY: '' }),
    setup: { fields: [{ in: 'env', name: 'ADS_API_KEY', label: 'ADS API token', kind: 'key' }], getKey: { url: 'https://ui.adsabs.harvard.edu/user/settings/token', steps: 'Sign in to NASA ADS (a free account), open Settings, API Token, and press Generate a new key.' } },
  },
  {
    id: 'inspirehep', name: 'INSPIRE-HEP', tier: 'niche', verified: false,
    homepage: 'https://github.com/MohamedElashri/inspirehep-mcp',
    description: 'High-energy-physics literature.',
    auth: 'None.',
    note: 'Not re-verified this pass; carried over from research-mcp-catalog.md. Confirm the package name before enabling.',
    config: stdio('inspirehep', 'npx', ['-y', 'inspirehep-mcp'], {}),
  },
  {
    id: 'consensus', name: 'Consensus', tier: 'optional', verified: false,
    homepage: 'https://consensus.app',
    description: 'Research-question search over a curated paper index.',
    auth: 'None for the free tier; paid ($20/mo) removes its 30-calls/month, top-3-results limit.',
    note: 'Paid or limited.',
    config: /** @type {McpServerConfig} */ ({ name: 'consensus', enabled: true, transport: 'http', url: 'https://mcp.consensus.app/mcp', headers: {} }),
  },
  {
    id: 'exa', name: 'Exa', tier: 'optional', verified: false,
    homepage: 'https://github.com/exa-labs/exa-mcp-server',
    description: 'General web search, useful as a search backend for local models.',
    auth: 'A free Exa API key.',
    note: 'Paid or limited.',
    config: /** @type {McpServerConfig} */ ({ name: 'exa', enabled: true, transport: 'http', url: 'https://mcp.exa.ai/mcp', headers: { Authorization: 'Bearer ' } }),
    setup: { fields: [{ in: 'header', name: 'Authorization', label: 'Exa API key', kind: 'key', prefix: 'Bearer ' }], getKey: { url: 'https://dashboard.exa.ai/api-keys', steps: 'Sign in to Exa and copy a key from the API Keys page.' } },
  },
  {
    id: 'tavily', name: 'Tavily', tier: 'optional', verified: false,
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
    description: 'General web search, useful as a search backend for local models.',
    auth: 'A free Tavily API key.',
    note: 'Paid or limited.',
    config: stdio('tavily', 'npx', ['-y', 'tavily-mcp'], { TAVILY_API_KEY: '' }),
    setup: { fields: [{ in: 'env', name: 'TAVILY_API_KEY', label: 'Tavily API key', kind: 'key' }], getKey: { url: 'https://app.tavily.com/home', steps: 'Sign in to Tavily; your API key is on the Home page.' } },
  },
];

/** @param {string} id */
export function catalogEntry(id) {
  return MCP_CATALOG.find((e) => e.id === id) ?? null;
}

/** The config a Connect guide saves: the entry's own, with what the user typed put in its place (trimmed, `prefix`
 *  added). Fields left empty stay as the entry has them. @param {CatalogEntry} entry @param {Record<string, string>} values by field name */
export function applySetup(entry, values) {
  const config = /** @type {any} */ (structuredClone(entry.config));
  for (const f of entry.setup?.fields ?? []) {
    const typed = (values[f.name] ?? '').trim();
    if (!typed) continue;
    const bag = f.in === 'env' ? (config.env ??= {}) : (config.headers ??= {});
    bag[f.name] = `${f.prefix ?? ''}${typed}`;
  }
  return /** @type {McpServerConfig} */ (config);
}

/** The labels of required fields still empty, and of emails that do not look like one. @param {CatalogEntry} entry @param {Record<string, string>} values */
export function setupMissing(entry, values) {
  return (entry.setup?.fields ?? []).filter((f) => {
    const typed = (values[f.name] ?? '').trim();
    if (!typed) return !f.optional;
    return f.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed);
  }).map((f) => f.label);
}
