# Scholarly MCP catalog research (2026-09-25)

Sourced by a research subagent from live GitHub pages. The star and commit counts are maintenance proxies, not verified last-commit dates. Re-check before shipping the catalog.

## Default catalog (read-only, free)

| # | Server | Install | Auth | Adds |
| --- | --- | --- | --- | --- |
| 1 | PubMed / Europe PMC: https://github.com/cyanheads/pubmed-mcp-server | `npx -y @cyanheads/pubmed-mcp-server@latest` (stdio or HTTP) | none; optional `NCBI_API_KEY` | MeSH, PMC/EPMC/Unpaywall full-text chain, citation formatting |
| 2 | ClinicalTrials.gov: https://github.com/cyanheads/clinicaltrialsgov-mcp-server | npx | none | trial registry search |
| 3 | PubChem: https://github.com/cyanheads/pubchem-mcp-server | npx | none | compound properties, bioassays |
| 4 | ChEMBL: https://github.com/cyanheads/chembl-mcp-server | npx | none | bioactivity, mechanisms |
| 5 | arXiv full text: https://github.com/cyanheads/arxiv-mcp-server | npx | none | full paper text (arXiv HTML, ar5iv) |
| 6 | Multi-source: https://github.com/openags/paper-search-mcp | `uvx paper-search-mcp` | `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL`; optional CORE key | 20+ sources, PDF text. **Disable its Google Scholar source.** |
| 7 | Unpaywall: https://github.com/ElliotPadfield/unpaywall-mcp | `npx -y unpaywall-mcp` | email | legal OA PDF by DOI |
| 8 | Wikipedia: https://github.com/Rudra-ravi/wikipedia-mcp | see repo | none | background definitions |
| 9 | NASA ADS: https://github.com/prtc/nasa-ads-mcp | see repo | free `ADS_API_KEY` | astro citation graph (niche; verify activity) |
| 10 | INSPIRE-HEP: https://github.com/MohamedElashri/inspirehep-mcp | see repo | none | HEP literature (niche) |

## Optional (paid or limited; off by default)

- Consensus: remote `https://mcp.consensus.app/mcp`. The free tier allows 30 calls a month and returns the top 3 results. Pro costs $20 a month. Pricing comes from search snippets, not a direct read.
- Exa: https://github.com/exa-labs/exa-mcp-server, or hosted `https://mcp.exa.ai/mcp`. General web search.
- Tavily: `tavily-ai/tavily-mcp`. Needs a free key. General web search.

## Rejected

- Google Scholar scrapers: they break Google's ToS and are fragile.
- Scite and Elicit: no verified official public MCP.
- Brave Search: redundant with the providers' web search.
- Dedicated Semantic Scholar and OpenAlex MCPs: redundant with the built-in `discover.js` sources, and mostly toy repos.
- Patent MCPs: not verified; follow up only if users ask.
- HF daily papers and NASA PDS: out of scope.

Note: providers without a built-in web search, mainly open-source models, need a search backend. Exa or Tavily (keyed), or a self-hosted SearXNG, can fill that role, plus the built-in scholarly sources.
