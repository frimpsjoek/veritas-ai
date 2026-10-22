# Phase 3 evidence (2026-10-22): the web app on its own

Vite and the Pages workflow (tasks 6–7) were moved to later by Joseph; their work-in-progress is on branch
`phase3/vite`. The web app keeps the esbuild build for now.

## Checks

`./check.sh` → all parts passed (web 54 → 54 + ui 287 incl. site-icon tests; server 330 passed, 3 skipped).

## In a real browser (installed Chrome, headless, Playwright)

Server: Veritas on port 27191 with its own data folder (the copied index). The same build, served two ways:

| | Server's own `/app/` | Hosted on another origin (`http://127.0.0.1:8765`) |
|---|---|---|
| Start | Home, no setup needed | `#server=…&t=…` saved to `veritas.servers`, removed from the address bar |
| Library | 52 rows | 52 rows |
| Notes search "GW" | results | results |
| Paper with PDF | PDF drawn (7 pages) | PDF drawn (7 pages), fetched with the token |
| Console errors / failed requests | 0 | 0 (after the site-icon fix; before it, 12 icon requests went to the page's host) |

The test origin was allowed with `kb.py web-origins add http://127.0.0.1:8765`.

Chat, hosted app, one conversation, two turns (library search, then literature search): both answered in about 19 s,
no "Unauthorized" on the second turn (the Codex MCP-token fix, 6c23407), activity line "Conducted 2 searches".
The conversation was mirrored as Markdown in `<output folder>/chats/` with frontmatter, both turns and citations.

A paper whose PDF is not on this computer answers 404 "no PDF file for this attachment" on both the old and the new
server: missing file, not a defect.
