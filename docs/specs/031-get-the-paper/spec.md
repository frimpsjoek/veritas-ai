# Spec 031: get the paper, not just its abstract

Status: APPROVED 2026-11-19 (user: "Approve, build it"; D1 kept papers, max 40; D2 only on Get PDF; D3 use Zotero's email and add it to the app; D4 not asked, the recommendation is used).

Written from the user's request of 2026-11-19: "Can we get the papers itself apart from if we just read the abstract and
it's relevant? How can we get the papers itself? [...] with regards to the tools that we have for Veritas. We want to
improve it and make sure that the papers not only are accessible, but also we can get the papers itself if there's a
need."

## What happens today (read from the code and the live runs of spec 030)

- Find papers and Research reports search the connectors (OpenAlex, Crossref, Europe PMC, arXiv, chemRxiv, Semantic
  Scholar) and keep **only the abstract each one returns**. A paper outside the library is never fetched or read
  (`agent/src/extract.js` `textFor`: full text only when `row.inLibrary && row.fullText`).
- When a connector returns no abstract (Crossref often does), the paper has **no text at all**: in the spec 030 live run
  8 of the 12 papers a report kept were empty, so the report could use only 2.
- Rows carry a `pdfUrl` only from arXiv in the radar (`agent/src/core.js:1309`) and from Europe PMC's search
  (`agent/src/scholarly.js:209`); none of the 12 rows above had one.
- What already exists, and is reused here:
  - the Zotero plugin's "Fix missing PDFs" / "Find PDFs" chain: Zotero's resolvers, Unpaywall (with the user's email),
    arXiv, OpenAlex, Semantic Scholar, Europe PMC; it checks that what arrived starts with `%PDF-`
    (`zotero/content/second-brain.js` `findOnline`, `unpaywall`, `attachPDF`). It runs only on items already in Zotero.
  - Add to Zotero from any host (spec 013 W3, `server/pending_adds.py`), which attaches a PDF only when the row
    already has one (`zotero/content/discover.js:372`). No open-access lookup on add.
  - Browse (spec 027): a publisher page inside the desktop app, signed in with the user's own institutional login, with
    "Save PDF to Zotero".
  - The radar reads arXiv PDFs whole and keeps the text in `radar-fulltext.sqlite` (`server/radar_api.py` `paper_text`,
    `media.pdf_text`).

## Goals

### G1. Read the paper when a free copy exists (engine)

- R1. **Abstract back-fill.** An outside paper with an empty abstract and a DOI gets one from OpenAlex, then Semantic
  Scholar, then Europe PMC, before screening. The row says where it came from.
- R2. **Open-access lookup.** For an outside paper with a DOI or an arXiv id, the engine looks for a legal free copy:
  arXiv, then Unpaywall's best open-access location, then OpenAlex `best_oa_location`, Semantic Scholar
  `openAccessPdf`, Europe PMC (PMC). The result is the row's `pdfUrl` and an `access` mark: `open` (a free PDF was
  found), `publisher` (no free copy; the publisher's page is known), or `none`.
- R3. **Read it.** In a Research report or Systematic review, a paper that was kept after screening and has an `open`
  copy is read from its text (the server downloads the PDF, checks it is a PDF, turns it into text once and caches the
  text, as the radar does), not from its abstract. Screening stays on abstracts, so only the papers that matter are
  downloaded.
- R4. **Say what was read.** Each cell's quotes already say `abstract` or `full_text`. The report's "How this was done"
  states: N papers read in full (library M, open access K), N from the abstract, N with no text; and lists the papers
  with no text, so a thin report says why.

### G2. Get the paper itself, when there is a need (all hosts)

- R5. **"Get PDF" on a paper.** Wherever an outside paper is shown (a Find table row, a report's references, Read
  later, Home), one action gets the paper into Zotero with its PDF:
  - `open`: Add to Zotero, the open-access PDF attached (the plugin downloads it and keeps it only if it is a PDF);
  - `publisher`: the paper's page opens in Browse (desktop app), signed in with the user's login, where "Save PDF to
    Zotero" already works; in hosts without Browse the page opens in the browser;
  - `none`: the paper is added to Zotero without a PDF, and the plugin's own "Find PDFs" runs on it.
  The row then shows that the paper is in the library; its full text is read from there on.
- R6. **Many at once.** Under a Find table and a finished report: "Get PDFs for these N papers" does R5 for all of
  them, open-access ones first, and says at the end how many got a PDF, how many need the publisher's page, and how many
  have none.
- R7. **An agent tool.** A chat (and the report's researcher) gets `read_paper {doi | arXiv id}`: the text of a paper
  outside the library when a free copy exists (R2–R3), else its abstract, else "no free copy". So "read this paper and
  tell me…" works without adding it to Zotero first. The model is told it may use it only for papers it has cited or
  been asked about.

### G3. Checks

- R8. Unit tests for the pure parts (which source answers first, the `access` rule, the PDF check, the counts line),
  engine tests with fake connectors, harness checks for the Get PDF action in the web shell, Zotero and Obsidian panes,
  and one live run: the spec 030 question again, its report compared with run 3 of spec 030 (papers read in full,
  evidence rows).

## Non-goals

- No copy that is not legal: only open-access locations (arXiv, Unpaywall, PMC, the publisher's free version) and the
  user's own signed-in access in Browse. No shadow libraries, no scraping behind paywalls, no shared logins.
- No change to the radar's own arXiv reading (spec 021); R3 reuses its PDF-to-text step.
- PDFs read for a report are not kept as files (only their text, in a cache the user can clear); a PDF is kept only when
  the user asks for it (R5, R6), in Zotero.

## Decisions for the user (recommendation first)

- D1. When does R3 download papers? **(a, recommended) Only papers kept after screening, at most 40 per report** (the
  table's cap), so a report costs a few minutes more, not an hour. (b) Every candidate with a free copy.
- D2. Does a report put the papers it read into Zotero? **(a, recommended) No; only on "Get PDF"** (your library stays
  yours). (b) Yes, all kept papers, in a "From reports" collection.
- D3. Unpaywall asks for a real email with each request. **(a, recommended) Use the email already in the Zotero
  plugin's settings, and add the same field to the app's Settings** (kept on this computer, sent only to Unpaywall and
  Crossref/OpenAlex as their terms ask). (b) Skip Unpaywall (arXiv, OpenAlex, Semantic Scholar, Europe PMC still work;
  fewer papers found).
- D4. The text cache. **(a, recommended) One cache file next to the radar's, capped at 2 GB, oldest out first, with a
  "Clear" button in Settings.**

## Way of working

- The work before this spec is committed (c464c3b).
- One commit per group: R1–R2 (lookup), R3–R4 (reading in reports), R5–R6 (Get PDF), R7 (tool), each with its tests and
  harness checks; then the live run.
- Evidence: `VERITAS_BROWSER=1 ./check.sh`, screenshots of Get PDF at 1280 px and in a narrow pane, light and dark, and
  the live report compared with spec 030 run 3; recorded in `validation.md`.
