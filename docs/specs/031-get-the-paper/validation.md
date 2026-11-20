# Spec 031 validation

## Checks

| Req | Check | Result (2026-11-19) |
|---|---|---|
| R1 | `agent/test/review2.test.js` "spec 031 R1"; `local-runtime-reviews2.test.js` "spec 031 R1-R4" (empty abstract filled before screening) | pass |
| R2 | `agent/test/open-access.test.js` (7 tests: arXiv first; Unpaywall only with an email; OpenAlex, Semantic Scholar, Europe PMC; a non-http address refused; alternates kept) | pass |
| R3 | `server/tests/test_paper_text.py` (7: public addresses only, before any request and after a redirect; not-a-PDF refused; arXiv at the radar's pace; read once then cached; no-text PDF not cached; cache cap drops the oldest); engine test: a refused first copy, the second read | pass |
| R4 | `review2.test.js` "readSentence"; the end-to-end test's `readFrom` per row | pass |
| R5/R6 | `ui/test/get-paper.test.js` (5); harness: report "Get PDFs for these 3" (Zotero and Obsidian maps, light and dark; screenshot `report-get-pdf-*.png` looked at), Find table Add to Zotero (steps), Read later Open PDF (web) | pass |
| R7 | `agent/test/tools.test.js` "spec 031 R7" (free copy read and cited by its DOI link; abstract when no copy; not offered without Scholarly or a reader) | pass |
| R8 | `VERITAS_BROWSER=1 ./check.sh` | exit 0, 2064 browser checks |

Each new unit was written to fail without its change (the read-tracking, alternates and access tests were run against
the code before the change while it was being built).

## Live runs (installed app, real library, the spec 030 question)

| Run | Build | Kept | Read in full | Evidence | What stopped more |
|---|---|---|---|---|---|
| 030 run 3 | 554f229 | 12 | 0 (all abstracts) | 3 | (no lookup yet) |
| 031 run 4 | 61d1d26 | 6 | 0 | 4 | 2 free copies found (two publishers' PDFs via OpenAlex), both refused to a program (HTTP 403); 4 old papers (1982-2001, Elsevier/Springer) with no abstract anywhere |
| 031 run 5 | a3a7e69 | 6 | 0 | 3 | the same two papers have no repository copy to fall back on |

The report now says why it is thin: "Of the 6 papers with data extracted, 0 were read in full …, 2 from the abstract only
and 4 had no text to read. No text: …" and names them.

What was not done: no browser disguise to get past a publisher's refusal (a request to try one was refused by the
session's safety check, and it is not something Veritas should do). Unpaywall was not part of the live runs: no email
is set in Zotero or in the app yet (D3); the user's account email was not used without asking.

## Choices made while building

- R5 "Home" is covered through the Zotero plugin: any paper added without a PDF (Home's Add to Zotero too) now gets the
  plugin's own Find PDFs, batched a few seconds after the last add. Home has no separate Get PDF button.
- Hosts without a library (the web app with no Zotero) get "Open PDF": the free copy, else the publisher's page, opens.
- `read_paper` is not offered in a chat about a paper set (that turn is limited to the set's own tools, spec 007 §6).
