# Plan: spec 014

Approved 2026-10-11 with D1-D5 as recommended. Three units, two of them in parallel, then the port and one release.

| Unit | Goals | Where | Builds on |
|---|---|---|---|
| U1 | G1 onboarding + G2 "Might interest you" | ZP worktree `.wt/014-radar`, branch `ai/014-radar` (agent-src radar, ui-src web) | radar config, `ai.radar.profile` / `checkSource`, radar-older.js |
| U2 | G3 highlighting | ZP worktree `.wt/014-highlight` (ui-src paper reader, content/pending-adds.js) + server worktree `.wt/014-server` (pending_adds.py, http_api.py) | spec 013 W3 queue, `/zotero/pdf`, paper_notes.py highlights |
| U3 | G4 Home in Zotero and Obsidian, then release | after U1 and U2 merge | `ui-src/src/web/pages.js` Home |

U1 and U2 touch different files. Seams I own after they merge: the More menu (U1 adds Sources), `restart_when_code_changes` and the route list in http_api.py (U2), the ROADMAP ticks, and any `dev/web-checks.mjs` conflicts.

## U1: onboarding and discovery

Data shape: nothing new is stored. The Sources page reads and writes the radar routine's `RadarConfig` (`profile.topics/authors/journals`, `sources[]`) through the same `ai.routines.create/update` the setup sheet uses; `radar-data.js` (`newForm`, `formFromRoutine`, `draftFromForm`, `addFeed`, `addJournal`, `mergeSeed`) is reused, not copied.

1. Web route `#/sources`: the Dia-style page. Serif headline with "more" and "richer" in italics; a ring (SVG) counting followed entries (topics + authors + journals + feeds + databases on); one suggestion beside it (the seeded author or journal with the highest count not yet followed); five chip groups (Topics and keywords, Authors, Journals, Feeds, Databases), each chip `+` to follow / check to unfollow, a text box per group to add (feeds and journals through `checkSource`, authors and journals matched on OpenAlex as the sheet does); the explainer (today's cover with source monograms on dashed lines, "Powered by your sources", three columns). Save writes the routine (creates the radar if none).
2. First run: Home shows the Sources page's top half in place of the Today block when no radar routine exists and the user has not dismissed it (`prefs.sourcesIntroDone`). More menu gets "Sources". The radar banner gets a "Sources" link.
3. G2 engine: `radar-discover.js` with three finders, each pure over an injected `fetch` and returning `RadarItem[]` with `reason`:
   - `citingKeyPapers`: OpenAlex works from the last 30 days that cite two or more of the library's most-cited papers (`filter=cites:W1|W2…,from_publication_date`), reason "Cites N papers in your library".
   - `coauthorsOfFollowed`: recent works by co-authors of followed authors, reason "By a co-author of NAME".
   - `relatedToRated`: OpenAlex `related_works` of papers rated Add or Read later, reason "Related to TITLE, which you saved".
   Results drop anything a followed source returned this run, anything seen, anything in the library; scored with the profile; top `size.discover` (default 3). A third `papers` result titled "Might interest you" in the issue session, a third section in the vault note, rows rateable like the others. No OpenAlex key and the daily budget spent: skipped with one line in the summary.
4. Tests: unit tests per finder (replayed OpenAlex JSON), the merge and caps, the digest note section; web harness checks for the Sources page (chips, ring count, save writes the config, first run on an empty store) at 1280, 700, 360 px.

## U2: highlighting

Data shape: a highlight is a Zotero annotation JSON (`annotationType: "highlight"`, `annotationText`, `annotationComment`, `annotationColor`, `annotationPosition: {pageIndex, rects: [[x1,y1,x2,y2]…]}` in PDF points, `annotationSortIndex`), queued as kind `annotation` with the attachment key.

1. Vendor PDF.js (pinned version, no CDN) into ui-src; the paper reader's PDF section becomes a PDF.js viewer with a text layer, page by page, lazy.
2. Selecting text shows a small bar with Zotero's eight colours and an optional comment; a highlight draws at once (pending style) and POSTs `/zotero/annotate {key, annotation}`.
3. Server: `pending_adds.annotate()` queues `{kind: "annotation", key, annotation}`; the existing "apply now if Zotero runs" path triggers the plugin. Route added to http_api.py and its docstring.
4. Zotero plugin `content/pending-adds.js`: apply `annotation` entries with `Zotero.Annotations.saveFromJSON(attachment, json)`; idempotent by a stable key derived from the queue id.
5. Existing highlights: `/zotero` item detail already lists annotations; the reader draws them on their pages.
6. Obsidian: no new code; `paper_notes.py` copies Zotero highlights into the note on refresh. Check it end to end.
7. Tests: server tests for the queue kind and route; ui unit tests for selection rects to PDF points; harness check for drawing + queueing; live check on one real PDF with Zotero (owed to the user if Zotero's window is needed).

## U3: Home in Zotero and Obsidian, release

Move Home (`paintHome` and helpers) to a shared module the plugins can mount; Zotero: a "Second Brain Home" tab; Obsidian: a `HomeView` (ribbon + command). Fonts and covers bundled per plugin. Paper/note opens use the host's readers. Then `build.sh`, version bump, publish both plugins, check both live (Zotero harness, Obsidian CDP).

## Order and checks

U1 and U2 in parallel → review each diff → merge U1 (ZP) → merge U2 (server ff-only, ZP) → live checks → U3 → release. Every merge: agent-src tests, ui-src unit tests, web/webphone/weblib harness, server pytest.
