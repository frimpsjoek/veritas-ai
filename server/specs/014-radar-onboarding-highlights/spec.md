# Spec: radar onboarding, discovery, highlighting in the app, and the new Home in Zotero and Obsidian

Status: APPROVED 2026-10-11 (user: "go ahead"; D1-D5 as recommended: onboarding on first Home visit + Sources in More; up to 3 "Might interest you" a day; Zotero's eight highlight colours; order G1, G2, G3, G4; one release after G4).
Written from the user's requests of 2026-10-11:

- "for onboarding we [need] to ask [the] user who they want to follow or RSS feeds or keywords and topics, authors,
  and important journals"
- "allow to be able [to] fetch papers that [are] not [in] the database that might be good to see. i like the current
  part of papers of interest"
- "can we be able to also highlight in this app too and the data is stored in obsidian and zotero"
- "lets add the UI changes to the main apps"
- plus the Dia references (a ring that counts connected sources, chips with + to connect, "Powered by your apps").

Builds on spec 012 (reading radar: profile, sources, digest, feedback), spec 013 (web app, Home, paper reader,
write-backs through the pending queue) and the Home shelf built 2026-10-11 (commits 4b4eed8..f0b9f08).

Already done on 2026-10-11, outside this spec: each paper says where it was found ("Found via chemRxiv"), Home steps
back through earlier radar issues, one or two columns for the papers.

## The problems

1. **Setting up the radar is one long sheet.** Topics, authors, journals, feeds and databases are checkboxes under
   six headings. A new user does not know what to fill in first, and nothing says how much a source adds.
2. **The radar only sees what its sources publish.** Papers you would want that are not in a followed feed or a
   searched database (a paper citing three of your key papers, a new paper by a co-author of someone you follow) never
   show up. The "Worth reading" pick already does this for older papers, and the user likes it.
3. **Reading in the web app is read-only.** The PDF opens in the browser's own viewer: you can read, but a highlight
   made there goes nowhere. Highlights live in Zotero (annotations) and are copied into the paper's Obsidian note.
4. **Home exists only in the browser.** Zotero and Obsidian still open on the chat, without today's issue or the
   shelves.

## Goals

### G1. Onboarding: "Who and what do you want to follow?"

A first-run flow (also reachable later as **Sources** in the More menu and from the radar banner) in the Dia style:

- A serif headline: "The *more* you follow, the *richer* your radar gets."
- A ring counting what is followed, with one suggestion beside it ("Follow npj Computational Materials, the journal
  your library cites most").
- Five groups of chips, each chip with + to follow and a check when followed:
  1. **Topics and keywords**: seeded from the library (the existing profile seed); type to add more.
  2. **Authors**: the authors your library cites most, matched on OpenAlex; type a name to add.
  3. **Journals**: the journals your library cites most; type a name or ISSN.
  4. **Feeds**: paste any RSS or Atom address (the existing check accepts addresses, names and ISSNs).
  5. **Databases**: arXiv, chemRxiv, bioRxiv, OpenAlex, Crossref, Semantic Scholar, Europe PMC, Hugging Face papers.
- Under it, the explainer from the second Dia screenshot: today's cover in the middle, the followed sources around
  it on dashed lines, "Powered by your sources", then three short columns: What it includes, When, How to read it.
- Saving creates or updates the reading radar routine. Nothing new is stored: the flow edits the same radar config
  the setup sheet edits, so the two always agree.

### G2. Discovery beyond the followed sources

A third group in each issue, after New and Worth reading: **Might interest you**, up to 3 papers a day that no
followed source published, found through the papers you kept or rated well:

- papers that cite two or more of your library's most-cited papers (OpenAlex `cites:` filter);
- recent papers by co-authors of the authors you follow;
- OpenAlex "related works" of the papers you rated well in the radar.

Each one says why: "Cites 3 papers in your library", "By a co-author of Giulia Galli". They are scored with the same
profile, and rating them teaches the radar like any other row. The OpenAlex calls count against the same daily
budget; with no API key the group is skipped and says so once.

### G3. Highlight in the app; stored in Zotero and Obsidian

- The paper reader's PDF becomes a PDF.js viewer (vendored, no CDN) with a text layer.
- Select text and pick a colour: a highlight is drawn at once and saved as a **Zotero annotation** on that PDF (same
  colours, page and position Zotero uses, so it shows in Zotero's own reader). An optional comment is the
  annotation's comment.
- Zotero writes go through the existing queue (`pending-adds`, spec 013 W3) with a new kind `annotation`, applied by
  the Zotero plugin with `Zotero.Annotations.saveFromJSON` when Zotero runs. Until then the highlight shows as
  "Waiting for Zotero" in the reader.
- The paper's Obsidian note gets the highlight through the existing path (paper_notes.py copies Zotero highlights
  into the "Highlights" section), so Obsidian always matches Zotero and nothing is written twice.
- Highlights already in Zotero are drawn in the web reader too (read from the KB index).
- Not in v1: ink, image and underline annotations; editing or deleting a highlight from the web (open Zotero for that).

### G4. The new Home in Zotero and Obsidian

- The Home page (greeting, today's issue with its papers, the shelves) moves into `ui-src` as a shared view, like the
  chat already is, and both plugins get a **Home** entry: a tab in Zotero, a view in Obsidian (ribbon icon and
  command "Open Second Brain Home").
- Fonts (Fraunces, Inter) and the cover photos ship inside each plugin (about 1.6 MB together). Each host keeps its
  own theme; the Home styles read the host's colours through the same `--sb-ui-*` tokens.
- Opening a paper or a note from Home uses the host's own reader (Zotero opens the item, Obsidian opens the note)
  instead of the web readers.

## Success checks

- G1: on a fresh data folder, the flow appears on first Home visit; following 2 topics, 1 author, 1 journal and 1
  feed and saving gives a radar routine whose config lists exactly those; the setup sheet shows the same; the ring
  counts 5. Harness checks at 1280, 700 and 360 px.
- G2: with a fixture library and OpenAlex replay, an issue has a "Might interest you" group of at most 3 papers, none
  from a followed source, each with its reason; with no key the group is skipped and the issue says so once.
  Unit tests for each finder.
- G3: a highlight made in the web reader appears in Zotero's reader on the same text after the plugin applies the
  queue (checked live on one real PDF), and in the paper's Obsidian note after the next note refresh; a highlight
  made in Zotero shows in the web reader. Harness check for drawing and queueing.
- G4: Zotero and Obsidian each open Home showing today's issue and the shelves (checked live: Zotero through the
  harness, Obsidian through CDP); both plugins build; plugin size grows by under 2 MB.

## Decisions for the user (recommended first)

- D1. **Where onboarding lives**: a first-run page on Home plus a Sources item in More (recommended), or only in
  Routines.
- D2. **Discovery size**: up to 3 "Might interest you" papers a day (recommended), or 5, or off by default.
- D3. **Highlight colours**: Zotero's own eight (recommended), or just yellow.
- D4. **Order of work**: G1, G2, G3, G4 (recommended: G1 and G2 change what you see every morning; G3 is the largest
  piece; G4 last so the ported Home already has G1 and G2), or another order.
- D5. **Releases**: one plugin release after G4 (recommended), or a release after each goal.

## Non-goals

- Editing or deleting existing Zotero annotations from the web app.
- Highlighting EPUB or web snapshots (PDF only in v1).
- Following sources that need a login (journals behind a paywall, private Slack-style feeds).
