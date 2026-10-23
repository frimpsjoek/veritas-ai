# Connectors and MCP

## Literature tools in Veritas

Settings > Sources and tools > **Add from the catalog** connects outside tools over the Model Context Protocol (MCP).
The chat can then call them. The catalog includes:

| Tool | What it adds | Key |
|---|---|---|
| Valency Bond | 500M+ papers and preprints (ChemRxiv included): semantic search, similar and citing papers, author profiles, trends, BibTeX export | free token from [app.valency.io/settings](https://app.valency.io/settings) |
| PubMed / Europe PMC | biomedical literature and full text | optional |
| arXiv full text | whole arXiv papers | none |
| PubChem, ChEMBL | compounds, bioactivity | none |
| Unpaywall | legal open-access PDFs by DOI | your email |
| Wikipedia | background | none |

Keys are stored in the macOS Keychain and never shown again. Only tools that say they are read-only are offered to
the chat; a tool that can change things is listed as hidden.

**Valency Bond:** press **Connect** on its row, paste the token, and a **Valency** chip appears in the chat.

## Your library in other AI chats

`server/server.py` is an MCP server over your Veritas library, with six tools: `search_notes`, `read_note`,
`note_links`, `related_notes`, `recent_notes` and `index_status`. Register it with any MCP client, for example
Claude Code:

```sh
claude mcp add --scope user veritas -- /path/to/veritas-ai/server/.venv/bin/python /path/to/veritas-ai/server/server.py
```

Other clients (Claude Desktop, Codex, ChatGPT desktop) take the same command in their MCP settings. The MCP server
starts the Veritas server if it is not running.
