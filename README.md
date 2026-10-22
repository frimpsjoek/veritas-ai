# Veritas AI

**A research assistant you can check.** Veritas reads your own papers, notes and Zotero library, answers with citations
to papers you can open, and finds new work for you, all on your own machine.

Built for the [OSI Hackathon 2026](https://scientificintelligence.org/campaigns/osi-hackathon-2026) (team Veritas AI).

## Why

A physicist or chemist keeps knowledge in three places that do not talk to each other: a reference manager, notes
(an Obsidian vault, a lab notebook) and the open literature. Chat assistants answer from none of them, and cite papers
that do not exist. Keeping up with new preprints means scrolling feeds that are mostly off-topic.

Veritas puts the three in one index and makes every answer traceable:

- **Chat over your own library and notes.** Answers cite the exact items in your Zotero library and the notes in your
  vault; a click opens the paper or the note.
- **A reading radar seeded by your own papers.** It finds the papers you wrote (OpenAlex), calibrates a similarity
  threshold on your library (your papers against each other, against random papers from other fields and against the
  day's papers in your own field), reads candidates whole, and each morning keeps only the new papers close to one of
  yours, saying which ("close to *Generalized Substrate Screening GW*, 0.84").
- **Links that open.** A DOI opens the PDF in your library, else a legal open-access copy (OpenAlex), else the
  abstract, before falling back to a publisher page that usually refuses bots and frames.
- **Connectors.** Literature tools plug in over MCP: PubMed, arXiv, PubChem, ChEMBL, Unpaywall, Wikipedia and
  **[Valency Bond](https://docs.valency.io/)** (500M+ papers and preprints, ChemRxiv included: semantic search,
  similar and citing papers, author profiles, trends, BibTeX export).
- **Yours.** The server runs on your Mac; the web app reaches it from your phone over your tailnet. Everything Veritas
  writes is plain Markdown.

## Built during the hackathon (Oct 21-22, 2026)

Veritas grew out of Second Brain, Joseph Frimpong's earlier tool. During the event:

| What | Where |
|---|---|
| Seed-paper radar: own papers via OpenAlex, calibration with per-seed field baselines, whole-paper second pass, two live runs on a real library | `server/radar_api.py`, `agent/`, `docs/specs/021-radar-seeds/spec.md` |
| In-app link panel, server half: `/web/page` (frame, reader view, PDF or a plain reason) and `/web/pdf`; DOI → library PDF → open-access PDF → abstract; public-host guard on every redirect | `server/web_page.py`, `server/tests/test_web_page.py`, `docs/specs/022-web-page-route/spec.md` |
| Valency Bond connector (Streamable HTTP, bearer token kept in the Keychain) | `agent/src/catalog.js` |
| Citations by Zotero item key resolve (libraries without Better BibTeX keys) | `server/kb.py` |
| Web app fixes: hidden views stay hidden, the page never scrolls past the app, long PDFs stay drawn in Safari | `web/src/` |
| One repo with enforced import boundaries and one check command, from three repos that reached into each other | `tools/boundaries.mjs`, `check.sh`, `docs/specs/veritas/` |

## What we learned

- Publisher pages are the wrong target for an assistant: ACS, APS, RSC and Elsevier answer a server with a bot check
  and a browser frame with `x-frame-options`. Open-access copies, found by DOI through OpenAlex, open far more often.
- One average of a whole library is a poor relevance filter: several lines of work average into a point near none of
  them. Comparing with each seed paper, minus that seed's own field baseline, separated real matches from the field.
- Specs first, then code, then recorded evidence: every feature here has a spec with checks and their actual results.

## Parts

| Part | What it is |
|---|---|
| `server/` | Python server: sources, index, search, agent host, auth, HTTP API |
| `agent/` | Node agent (`agentd`) and the agent logic the apps share |
| `ui/` | Shared UI kit used by every app |
| `web/` | Web app (browser and phone) |
| `zotero/` | Zotero plugin |
| `obsidian/` | Obsidian plugin |
| `docs/specs/` | Specs and plans, with evidence |

Parts may import `ui/` and `agent/`, never each other; `tools/boundaries.mjs` enforces this. Run `./check.sh` to
build and test everything.

To use Valency Bond: get a free token at [app.valency.io/settings](https://app.valency.io/settings), then in the app
open Settings > Sources and tools > Valency Bond > Connect.

## Copied from

Veritas started on 2026-10-22 as a copy of the Second Brain dev clones (fresh history):

| Part | Source repo | Branch | Commit |
|---|---|---|---|
| `server/` | frimpsjoek/obsidian-kb | ai/web-page | 5edb6e74d2ab3c8a43b26dd483f1f834102a8e22 |
| `zotero/` (+ `agent/`, `ui/`, `web/`) | frimpsjoek/zotero-second-brain | ai/web-page | 3086f3dffb91219a1216f10385ffcb9900d0d524, then f69ffcd and 1208974 ported |
| `obsidian/` | frimpsjoek/obsidian-second-brain-plugin | ai/015-folders | 72b2d796ac0d1acf85d35ad0c215c661ff37d043 |
