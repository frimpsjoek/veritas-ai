# Spec: The chat docked beside the paper you're reading

Status: DONE 2026-09-26 as 0.21.0 (installed). APPROVED 2026-09-26. The user looked at a floating Grammarly-style window, then at the docked sidebar
built on branch `ai/sidebar-chat` (screenshots in ~/Downloads/second-brain-sidebar/), and chose the docked
sidebar ("2"), brought up to date. Builds on specs 002 (U1, U2) and 003.

## Objective

People should be able to search, learn and ask about the paper they're reading without leaving it: the chat
lives along the bottom of Zotero's right-hand pane (next to the library, and next to an open PDF), with the new
look from spec 003 and every mode, including Find papers. The paper you're reading comes along by itself, the
way Grammarly attaches the page you're on.

The user also doesn't like the Look in / Years / Depth row sitting inside the message box.

## What the sidebar branch already does (kept)

- `ChatView`: the chat's state and DOM, not tied to a tab. Hosts: `ChatTab` (the full tab) and `ChatSidebar`.
- `ChatSidebar`: a dock along the bottom of the item pane (library) and of the context pane (reader), with a drag
  handle for the split; Zotero's own sections keep the space above it. It moves to whichever pane is on screen,
  so the conversation carries over. A chat button in Zotero's right-hand icon strip and the toolbar's AI button
  open and close it. "Open in a tab" moves the conversation to the full tab.
- Below 560 px the history becomes a drawer over the thread.

## What changes

1. **Today's chat inside it**: the branch was built before 0.18, so the split is redone on today's `chat.js`
   (modes menu under the box, icons, empty state with pills, the card composer, Research report and Find papers
   in the thread).
2. **The paper you're reading is attached automatically** in the sidebar: a chip at the top of the message box
   ("Hou et al. 2024 · Reading now", or "· Selected" in the library) with × to leave it out of this message. It
   follows the reader tab or the library selection; the suggestions name it. Sending attaches it. The full tab
   keeps today's behaviour (suggestions from the selection, "+ Selected papers").
3. **Options leave the message box** in both places: one button in the controls row ("Whole library ▾", or
   "Whole library · 2019–2024 · Deep" for a report) opens a small panel above it with Look in, and for a report
   Years and Depth.
4. **Narrow layout** for the new pieces: Find papers shows one column (paper, then its summary), the controls row
   wraps cleanly, the empty state is compact.
5. Every open view refreshes its history when another view changes it (a chat sent in the sidebar shows up in
   the tab's list).

## Success checks

1. The toolbar AI button and the icon-strip button open the dock along the bottom of the item pane; Zotero's
   sections stay above it; the drag handle changes the split.
2. With a paper selected, the dock shows it as the context chip and the pills name it; sending attaches it; ×
   leaves it out of the next message; selecting another paper updates the chip.
3. Opening a PDF moves the same conversation into the reader's pane, with the reader's paper as the chip.
4. Options: one button in the controls row; its panel has Look in (Find papers) or Look in, Years, Depth
   (Research report); nothing about options sits between the text and the controls.
5. All four modes work in the dock; Find papers is one column there.
6. "Open in a tab" shows the same conversation in the tab.
7. All earlier harness tests still pass.

## Result (2026-09-26)

- `ai/sidebar-chat` merged into `feat/second-brain-ai` (merge not yet committed). chat.js took today's version and
  the split was redone on it: `ChatView` (view, `host` object), `ChatTab` (tab host, `open()`), `ChatSidebar`
  (branch's chat-sidebar.js, now with `autoContext` and `reading()`; polls the context every 0.7 s while open).
- Context chip: key is `reading|selected:<item keys>`, so opening a paper in the reader brings back a chip taken
  out while it was only selected. Not used in Find papers or Research report.
- Options: `optionsButton` + `reportOptions` as a panel above the box; closes on outside click or Escape.
- Harness `t-sidebar.js` 21/21 (pictures sidebar-library/options/find/reader.png); t-find-papers 19/19,
  t-unified-chat 29/29, t-chat-look 17/17, t43 22/22, t-history-collapse 17/17, t-focus-steady 4/4 (one run of
  seven failed "Focus off" once; not reproduced in three reruns, likely the note still settling).
- The toolbar AI button now opens the dock; the tab is reached with ⤢, the Tools menu and "Ask About This Paper…".
