# Spec 032: keep the PDF, in Zotero or in Veritas's own folder

Status: APPROVED 2026-11-19 (user: "Approve, build it"; D1 Papers/ in the notes folder; D2 Zotero only).

Written from the user's request of 2026-11-19: "but it should be able to keep the PDF in the zotero folder or its own
folder if zotero does not eist" (after: "but can it run in the veritas only? without teh zotero").

## What happens today (spec 031, read from the code)

- Get PDF sends the paper and its free PDF's address to Add to Zotero. In the desktop app that is the plugin queue
  (`server/pending_adds.py`): the plugin downloads the PDF when it next runs. With Zotero closed, nothing is downloaded;
  on this Mac two papers have waited since 2026-11-17.
- A PDF saved from Browse (spec 027) is already kept by the server in `data/pdf-inbox/` and attached by the plugin
  later (`pending_adds.attach_pdf`). Get PDF does not use this.
- Without a Zotero library there is no place to keep a PDF: Open PDF only opens it, and a report keeps only the text.
- The index already reads PDF folders (spec 018): a listed folder's PDFs are searchable, open in the reader, and a
  report reads them as library papers.

## Goals

- R1. **One rule for where a PDF goes**, decided by the server:
  - a local Zotero library exists (its data folder is found, as today's Zotero routes check): the PDF goes to Zotero;
  - no Zotero library (or only an online one, whose Web API this app does not upload files to): the PDF goes to
    Veritas's own papers folder.
- R2. **Zotero, also when Zotero is closed.** Get PDF downloads the free copy at once (the server, as spec 031's reader
  does: public addresses only, a real PDF only, size cap) and queues it with the paper, as Browse's Save PDF does
  (`attach_pdf`); the plugin attaches the file at its next start. So the PDF is fetched while the link works, whether
  Zotero runs or not. A copy that cannot be downloaded is queued as today (the plugin tries, then its Find PDFs).
- R3. **Veritas's own folder.** Without Zotero, the PDF is saved as `<Papers folder>/<First author> <year> - <title>.pdf`
  (a name safe on every system, never overwriting: a second copy of the same file is not saved twice), with a small
  `.json` beside it (title, authors, year, DOI, where it came from). The folder is listed in the index the first time,
  so the paper shows in Library, is searchable, opens in the reader, and the next report reads it in full.
- R4. **Browse's Save PDF follows the same rule** (R1): to Zotero's queue as today, or to the papers folder.
- R5. **Say where it went.** Get PDF's line says "Saved to Zotero" (or "Saved for Zotero; it is attached when Zotero
  opens"), or "Saved to Veritas › Papers", and the row links to the paper.
- R6. Checks: server tests for the rule, the naming, no overwrite, the index listing; engine/UI tests and harness checks
  for both ends of the rule; one live run with Zotero closed (the PDF is in the inbox, then attached once Zotero opens)
  and one with the Zotero library hidden (the PDF is in the folder and found by search).

## Non-goals

- No writing into Zotero's own database or storage folder (Zotero owns them; the plugin attaches files).
- No change to what a report keeps (spec 031 D2: text only, PDFs only on Get PDF).
- No copy that is not legal (as spec 031).

## Decisions for the user (recommendation first)

- D1. Where Veritas's papers folder is. **(a, recommended) `Papers/` inside the folder Veritas writes notes to** (your
  vault, or `~/Documents/Veritas`), so it travels with your notes. (b) `~/Documents/Veritas Papers`, outside the vault.
- D2. With Zotero, also keep a copy in the papers folder? **(a, recommended) No, Zotero only** (one copy). (b) Both.

## Way of working

- The work before this spec is committed (485d842). One commit for the server rule and storage (R1–R4), one for the UI
  (R5), then the live runs; `VERITAS_BROWSER=1 ./check.sh` before each; recorded in `validation.md`.
