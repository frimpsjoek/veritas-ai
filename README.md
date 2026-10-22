# Veritas AI

**An open-source research assistant you can check.** Veritas reads your own papers, notes and Zotero library, answers
with citations you can open, and finds new papers for you, on your own machine.

Built for the [OSI Hackathon 2026](https://scientificintelligence.org/campaigns/osi-hackathon-2026) by team
Veritas AI: Joseph Frimpong, Oded Asiedu and Huihuo Zheng.

## What it does

- **Chat over your own library and notes**, with every answer cited to a paper or note you can open.
- **A reading radar and daily digest**, seeded by your own papers, that keeps only the new papers close to your work.
- **Links that open**: a DOI goes to your library's PDF or a legal open-access copy.
- **Connectors** for literature tools, including [Valency Bond](https://docs.valency.io/).
- **Research personas**: a [knowledge base](docs/research-personas/research-persona-knowledge-base.md) of 31
  researcher personas across six fields.

## Before and during the hackathon

Before the event we had built the Zotero and Obsidian tools (plugins, search index and chat over your library).
During the hackathon (Oct 21-22, 2026) we built the reading radar and digest with its tools, the link reader, the
Valency connector, the research personas, and Veritas itself: one repository and one knowledge base.

## Repository

| Part | What it is |
|---|---|
| `server/` | Python server: sources, index, search, HTTP API |
| `agent/` | Node agent and its tools |
| `ui/` | Shared UI kit |
| `web/` | Web app (browser and phone) |
| `zotero/` | Zotero plugin |
| `obsidian/` | Obsidian plugin |
| `docs/` | Specs and the research personas |

Run `./check.sh` to build and test everything.

## License

MIT. See [LICENSE](LICENSE).
