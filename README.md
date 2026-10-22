# Veritas

Veritas is a research knowledge base: a server that reads your notes, PDF folders and Zotero libraries, with a
desktop/web app and Zotero and Obsidian plugins that talk to it. Everything it writes is plain Markdown.

| Part | What it is |
|---|---|
| `server/` | Python server: sources, index, search, agent host, auth, HTTP API |
| `agent/` | Node agent (`agentd`) and the agent logic the apps share |
| `ui/` | Shared UI kit used by every app |
| `web/` | Web app (browser and phone) |
| `zotero/` | Zotero plugin |
| `obsidian/` | Obsidian plugin |
| `docs/specs/` | Specs and plans |

Parts may import `ui/` and `agent/`, never each other; `tools/boundaries.mjs` enforces this. Run `./check.sh` to
test everything.

## Copied from

Veritas started on 2026-10-22 as a copy of the Second Brain dev clones (fresh history):

| Part | Source repo | Branch | Commit |
|---|---|---|---|
| `server/` | frimpsjoek/obsidian-kb | ai/web-page | 5edb6e74d2ab3c8a43b26dd483f1f834102a8e22 |
| `zotero/` (+ `agent/`, `ui/`, `web/`) | frimpsjoek/zotero-second-brain | ai/web-page | 3086f3dffb91219a1216f10385ffcb9900d0d524 |
| `obsidian/` | frimpsjoek/obsidian-second-brain-plugin | ai/015-folders | 72b2d796ac0d1acf85d35ad0c215c661ff37d043 |
