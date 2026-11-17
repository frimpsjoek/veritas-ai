# Architecture

| Part | What it is |
|---|---|
| `server/` | Python server: reads the sources, keeps the index (SQLite, keyword search and 384-dimensional vectors from snowflake-arctic-embed-s), serves the HTTP API and the web app, and hosts the agent |
| `server/globus_auth.py` + `user_store.py` | optional independent Globus identity, Veritas-owned sessions and private per-user ALCF credential storage |
| `server/zotero_storage.py` + `webdav.py` | default-disabled, independently authenticated native Zotero personal WebDAV attachments, immutable blobs and transactional quota accounting |
| `agent/` | Node agent (`agentd`): chat, reports, the reading radar, routines, the model providers and the MCP tool gateway |
| `agent/src/node/tenant-runtime.mjs` + `providers/alcf.js` | optional per-Globus-tenant interactive runtimes, isolated stores/MCP handlers, and fixed-endpoint ALCF model/completion providers |
| `ui/` | shared UI kit: chat, home, settings, panels, styles |
| `web/` | the web app (browser and phone) |
| `zotero/` | Zotero plugin |
| `obsidian/` | Obsidian plugin |
| `docs/` | this documentation, specs, slides, the research persona knowledge base |

The apps (`web/`, `zotero/`, `obsidian/`) may import `ui/` and `agent/`, never each other, and reach the server only
over HTTP. `tools/boundaries.mjs` checks this. `./check.sh` builds and tests every part.

Sources are read through connectors (Obsidian vault, Markdown folder, PDF folder, Zotero local, Zotero online), so
a new kind of source is one new module. Notes Veritas writes are plain Markdown in the output folder; search indexes
are caches and can be rebuilt. Native WebDAV attachment blobs are authoritative user data, not Markdown or disposable
index data, and are protected by a separate independently authenticated protocol/storage service.

Each feature starts as a spec under `docs/specs/` with requirements and checks, before code.
