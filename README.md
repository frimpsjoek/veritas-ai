<p align="center"><img src="docs/images/veritas-logo.png" alt="Veritas" width="160"></p>

# Veritas AI

**An open-source research assistant you can check.** Veritas reads your own papers, notes and Zotero library, answers
with citations you can open, and finds new papers for you, on your own machine.

Built for the [OSI Hackathon 2026](https://scientificintelligence.org/campaigns/osi-hackathon-2026) by team
Veritas AI: Joseph Frimpong, Oded Asiedu and Huihuo Zheng.

![Veritas reading radar](docs/images/reading-radar.png)

**Demo video (2 min):** [docs/video/veritas-demo.mp4](https://github.com/frimpsjoek/veritas-ai/blob/main/docs/video/veritas-demo.mp4)

## What it does

- **Chat over your own library and notes**, with every answer cited to a paper or note you can open.
- **A reading radar and daily digest**, seeded by your own papers, that keeps only the new papers close to your work.
- **Links that open**: a DOI goes to your library's PDF or a legal open-access copy.
- **Connectors** for literature tools, including [Valency Bond](https://docs.valency.io/).
- **Research personas**: a [knowledge base](docs/research-personas/research-persona-knowledge-base.md) of 31
  researcher personas across six fields.

![Veritas answering from your reading digest, with citations](docs/images/chat-digest.png)

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

## Run it

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/) and Node 22.

```sh
(cd server && uv venv && uv pip install -r requirements.txt)
(cd agent && npm ci && npm run build)
(cd web && npm ci && ./install.sh)
cd server && .venv/bin/python kb.py serve
```

Open http://localhost:27182/app/, then add your folders and Zotero library in Settings.

## License

MIT. See [LICENSE](LICENSE).
