# Spec 028: arXiv TeX on the reader page, a Home count that goes down, and a Read later list

Status: APPROVED 2026-11-17 (user chose, in chat: "Last 7 days", "Bookmark everywhere", "Subagents, 3 lanes").

Written from the user's request of 2026-11-17, with a screenshot of the reader page on arXiv:2611.20723:

- "see how this displays. let fix this" — the title shows `\textit{GW}`, the abstract `\ce{C2H4O}`, `\ce{S1}`,
  `\ce{S2}`, `\ce{C-O}`, `\textit{J. Chem. Phys.} \textbf{160}`, and the top bar repeats the raw title.
- "the number on the home is getting large and large but when we read it should reduce as you read because otherwise
  its a lot of papers there" — the rail badge read 366.
- "a new tab that allow us to add the saved later papers to read them when we are ready that can also have the number
  and also can be in your library as well".

## The problem, measured

- The reader page builds its title and abstract in `web/src/browser-panel.js` (`words` → `withMath`), which draws
  `$…$` math only. The TeX-to-text pass `plainProse`/`setPaperText` (`ui/src/paper-text.js`, used on Home and in
  chat tables) is never applied there, and no code anywhere handles mhchem `\ce{…}`.
- The badge is the sum of `news.papers` over every conversation (`ui/src/home/home.js` `showWaiting`), i.e. every
  radar issue ever. Viewing or rating a paper takes one off, but only from the issue Home shows; old issues never
  shrink. The badge is set only when Home paints (`web/src/pages.js` `showWaiting`).
- "Read later" exists only as a radar verdict (`later`), offered only where there is no Zotero; its paper details live
  in `RadarState.shown`, trimmed to 300 rows (`agent/src/radar-state.js` `MAX_SHOWN`). No durable reading list exists.

## Goals

### G1. arXiv TeX reads as text everywhere a title or abstract is shown

- R1. `\ce{…}` (mhchem) is drawn as a formula in text: digits after an element or a closing bracket are subscripts
  (`\ce{C2H4O}` → C₂H₄O as `C<sub>2</sub>H<sub>4</sub>O`), `\ce{S1}` → S<sub>1</sub>, a `-` between atoms is an en
  dash bond (`\ce{C-O}` → C–O), `=` and `#` stay, `^{2+}`/`^-` are superscripts, `->` is →. Anything it cannot parse
  is shown as its inner text without the command, never raw.
- R2. `\textit{…}`/`\emph{…}` are italic and `\textbf{…}` bold where nodes are drawn (reader page, Home, chat); where
  only a string fits (the top bar, a tab title, a window title, a toast), the plain text (`plainProse`).
- R3. The reader page (`browser-panel.js`) uses the same pass for title, byline, abstract and the bar title, for
  answers marked `math` and for arXiv answers; "$5 and $10" on an ordinary page stays money (existing rule).
- R4. What is sent on (Add to Zotero, copy, search, chat context) keeps the raw string (existing rule).

### G2. The Home count is what is waiting, and reading takes it down

- R5. The count (Home's "N new papers" line and the rail badge) sums unread papers only over radar issues updated in
  the last 7 days (`NEWS_DAYS = 7`). Older issues stay browsable under "Earlier issues"; their papers stop counting.
- R6. Opening a radar paper anywhere takes one off: from Home (as now), from a radar chat's table (as now), and from
  the reader page when it was opened from a radar row (it knows the row: `browser-panel.js` `radar`).
- R7. The rail badge is kept up to date on every view, not only while Home is painted: read again after a paper is
  opened or rated anywhere, and when the window regains focus.

### G3. Read later: a reading list with its own rail item, count and Library filter

- R8. A durable reading list in the agent store, `<dataDir>/reading-list.json`, written atomically like other stores.
  Entry: `{ id, title, authors[], year, venue, doi?, arxiv?, url, abstract?, source, added, read? }`. `id` is
  `doi:<doi>` else `arxiv:<id>` else `url:<url>`; adding an id already listed is a no-op (it keeps its `added`).
  No cap (my call: a list the user curates by hand).
- R9. Service API (`ai.readingList`): `list()`, `add(paper)`, `remove(id)`, `markRead(id, read=true)`, wired through
  `core.js`, `remote.js` and `agentd.mjs` routes, typed in `service.d.ts`, like `conversations.markViewed`.
- R10. Saving: a bookmark button "Read later" on every radar row (Home and the digest table), beside Add to Zotero
  rather than replacing it; the existing `later` verdict now also adds to the list. A bookmark button in the reader
  page header for any paper (`paperToAdd` non-null). Pressed state "Saved to read later"; pressing again removes it.
- R11. A **Read later** rail item (after Library, icon bookmark) with a badge = unread entries, hidden at 0. Its view
  lists Unread (newest first) then Read; each row: title (G1 drawing), authors, venue/year, open, mark read/unread,
  remove. Opening an entry opens the paper in the reader (or Browse where papers open there) and marks it read.
- R12. Library has a **Read later** filter showing the same entries (a chip/collection at the top of Library), with
  the count; an entry already in Zotero says so.
- R13. Works in the web app; the Zotero and Obsidian plugins compile unchanged (they may ignore the rail item).

## Non-goals

- Syncing the reading list to Zotero, or marking Zotero items read.
- A full mhchem implementation (arrows with conditions, states of matter are out).

## Copy, exact

"Read later", "Saved to read later", "Remove from Read later", "Mark as read", "Mark as unread", "Unread", "Read",
"Nothing saved to read later yet.", "In your Zotero library".

## Validation

| Req | Check |
|-----|-------|
| R1–R2 | `ui/test/paper-text.test.js`: the arXiv:2611.20723 title and abstract give no `\` in text; `\ce{C2H4O}` parts |
| R3 | web test on the reader plan/nodes for that answer; browser harness screenshot |
| R5 | `ui` test: issues 8 days old do not count; today's do |
| R6–R7 | test that reader open of a radar row calls `markViewed`; badge refresh on route change |
| R8–R9 | `agent` tests: add/dedupe/remove/markRead, persisted, tolerant read of a bad file; route test |
| R10–R12 | `web`/`ui` tests for the bookmark state, the view's sections and badge, the Library filter |
| all | `./check.sh` passes |
