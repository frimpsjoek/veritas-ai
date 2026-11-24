# Spec 029: a better Read later view and Chat view

Status: APPROVED 2026-11-18 (user chose every option offered, in chat, and asked: "ALSO COMMIT FIRST SO WE CAN REVERSE
AND EACH IMPLEMENTAION").

Written from the user's request of 2026-11-18: "ALSO IMPROVE THE CHATS VIEW AND READ LATER VIEW NOT VERY GOOD.", after
screenshots of both views at 1280 px and 390 px (web shell, harness fake host) showed:

- Read later: a row is only title, authors, venue · year; three text buttons ("Open", "Mark as read", "Remove from Read
  later") are louder than the title and wrap to a second line on a phone; Read papers take as much room as Unread.
- Chat (new chat page): a large empty gap between the heading and the composer; the recent-chat cards repeat the
  sidebar and truncate on a phone ("Find pap…"); the composer has ten controls on two lines; the sidebar's count pill
  ("1") and kind icon say nothing on their own.

The chat UI is shared with the Zotero and Obsidian panes (`ui/`): every change must hold in a narrow pane too.

## Goals

### G1. Read later view (`web/src/later-view.js`, also Library's Read later filter)

- R1. Richer rows: under authors and venue · year, up to two lines of the abstract (TeX drawn as text, as titles are)
  where the entry has one, and "Saved <relative time>" (e.g. "Saved 3 days ago"). Entries with no abstract show none.
- R2. Quiet actions: Open stays a button; Mark as read / Mark as unread and Remove from Read later become icon buttons
  with the same words as tooltip and accessible name. A row's actions stay on one line at 360 px.
  Changed 2026-11-18 after the user saw it ("open is taking too much space and also make it wider. we can put those at
  the bottom like the other"): the actions sit under the words at every width, Open is a small accent text button,
  and the Read later page is up to 1040 px wide.
- R3. The Read section is folded by default under "Read · N"; one click opens it; the choice is kept for the window's
  life. Unread is never folded. With no unread papers, a line says so above the fold.
- R4. Search and sort, shown once the list holds 10 or more papers: a filter box (title, authors, venue; accents and
  case ignored) and a sort switch, Newest saved / Oldest saved. Fewer than 10: neither is shown.

### G2. Chat view (shared `ui/` chat, web shell)

- R5. Tighter start page: the welcome line and the suggestions sit just above the composer with no empty gap; the
  recent-chat cards are not shown where the chat list is on screen (web shell at ≥ 700 px); where it is not (phone,
  narrow panes) the recent chats are a compact list of at most 3 rows, never truncated to a word.
- R6. Simpler composer: Papers, Notes, Scholarly and Web fold into one "Sources" menu button that names what is on
  ("Sources: Papers, Notes, Scholarly"); mode, scope, Skills and Add papers stay. At 1280 px the controls fit one line.
- R7. Clearer chat list: the count pill has words or a tooltip saying what it counts; the kind icon has a tooltip
  (Chat, Find papers, Report …); a chat still titled "New chat" shows its first question when it has one.
- R8. Wider answer column on wide screens: the thread and the composer may grow to about 860 px (from about 710 px).

### G3. Liked papers on Read later (added 2026-11-18, user: "LIKED SHOULD ALSO APEAR AUTOMATICALLY IN READ LATER. AND
ALSO CAN WE ADD THE OLD PAPERS WE LIKED AS WELL?")

- R9. A Like on Home or in the reader puts the paper on Read later (the engine does it in `radar.feedback`, so every
  host gets it), marked `via: 'like'`. Taking the Like back (Undo, or changing it to another verdict) takes off a paper
  the Like put on; a paper saved by hand stays. The verdict stands if the list could not be changed. The open views
  re-read the list when a Like comes or goes.
- R10. Papers liked before R9 go on the list once, with `added` = the time of the Like, the first time the new engine
  reads the list; a marker file (`reading-list-liked-imported.json`) records it, so a paper taken off by hand is not
  put back. Only papers whose details the radar still keeps can be listed (on the user's machine: all 100 of 100).

### G4. A picture on each Read later row (added 2026-11-18, user: "ALSO ADD THE TOC IMAGE TO THE SIDE OF TEH READ
LATER AS WELL.")

- R11. Each Read later row shows the paper's TOC graphic (graphical abstract) beside the text when one can be found,
  using what the app already finds for papers; no picture, no empty box. It never makes the row taller than the text
  on a phone, and loads lazily.

- R12. (added 2026-11-18, user: "also clicking on images to open it full screen with pan and other features.") A
  click (or Enter) on a row's picture opens it full screen over the page: zoom with the wheel or trackpad (at the
  pointer), the + and − buttons or keys, a two-finger pinch on a touch screen; drag to pan when zoomed; double-click
  toggles fit and 2×; 0 or "Fit" fits it, "1:1" shows it at its own size; arrows pan; "Open original" opens the image
  address in a new tab; Escape, the close button or a click on the dark backdrop closes it and puts focus back on the
  picture. The zoom math is pure and unit-tested; the viewer is shared (`ui/src/image-viewer.js`) so other pictures
  can use it later.

- R13. (added 2026-11-18, user: "yes add it to home and reader images too") The same viewer opens a Home paper's
  picture (web app; in the Zotero and Obsidian panes the picture still leads to the paper, as their sheets have no
  viewer styles yet), the reader's graphical abstract, and a full text's figures, by click or Enter / Space. The
  title of a Home paper still leads to the paper.
  Changed 2026-11-18 (user: "yes add it to zotero and obsidian too"): the Zotero and Obsidian Home panes open the
  picture in the viewer too; its sheet (`ui/src/image-viewer.css`) is part of Home's sheet in every host, and "Open
  original" goes where the pane sends a web page.

### G5. Chat and Notes, more (added 2026-11-18)

- R14. (user: "put the user logo on the right and outside not in the chat text or remove it its not really useful
  anyway") Your own messages carry no avatar; answers keep the AI mark.
- R15. (user: "also fix the notes page like the way we did the read later the width etc and change the logos there to
  just different stuff") The Notes page is up to 1040 px wide, like Read later. Each row has a mark for its kind
  instead of the same person mark on every row: note, daily note, project note, saved chat, reading digest, AI note,
  web clipping, video notes, Notion import (`ui/src/note-kind.js`, pure, unit-tested), each its own icon and colour.
  A row shows the title (a saved chat without its date and id; a daily note as its day), up to two lines of the
  matching passage when searching, and "kind · when · folder". A kind filter (All, then each kind present, with
  counts) shows once the list holds two kinds or more; the choice is kept for the window's life. Recent is grouped
  Today, Yesterday, This week, Earlier.

## Non-goals

- No change to what the engine stores, to the reading-list API, or to answers themselves.
- Dark mode and the Zotero/Obsidian themes keep working; no new colours outside the existing tokens.

## Way of working

- The work before this spec is committed (65c6242), so each step can be reversed.
- Each requirement (R1–R8) is its own commit, with its tests and harness checks, so any one can be reverted alone.
- Evidence: `./check.sh` with `VERITAS_BROWSER=1`, and screenshots at 1280 px and 390 px of each view, light and dark,
  looked at before each requirement is called done. Recorded in `validation.md`.
