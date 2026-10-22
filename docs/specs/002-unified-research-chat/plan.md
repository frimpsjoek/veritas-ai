# Plan: One research chat

Status: APPROVED 2026-09-26 (all three). U1 done 2026-09-26 (plugin 0.18.0); U2 done 2026-09-26 (0.20.0); U3 next.

## Where the code is

- `zotero-plugin/content/chat.js`: the chat tab (modes in the header, composer, history, markdown renderer).
- `zotero-plugin/content/review-panel.js`: the separate Literature Review tab. Its logic moves into the chat.
- `zotero-plugin/content/discover.js`: outside paper search (OpenAlex, Semantic Scholar, arXiv, …) with
  abstracts, dedupe and "already in library" marking. Find papers reuses it as is.
- `zotero-plugin/agent-src/src/domain.d.ts`: `Report` already carries themes, an evidence table,
  disagreements, gaps and references; `Finding` carries quotes and confidence. The report can be rendered
  in the thread without changing the engine.

## Phases (each ends with a check you can see in Zotero)

### U1. One composer, mode menu, report inline (UI only; no engine change)
- Replace the header switch with a mode menu and option chips under the message box.
- Research report mode calls `ai.reviews.start/watch/approvePlan/resume/cancel` and renders the plan card,
  stage lines and the finished report as thread items (moved from review-panel.js).
- History merges `conversations.list()` and `reviews.list()`, with icons and status.
- The Tools menu and `openReview()` open the chat in Research report mode; review-panel.js is deleted.
- Check: success checks 1, 2, 3, 6, 7.
- Done 2026-09-26: `content/report-view.js` replaces `review-panel.js`; ReviewProgress gains `question`,
  `started` and (from watch) `report`; AgentHost.ai() now runs one runtime switch at a time (two callers
  mid-switch used to hand chats to the server twice). Harness `tests/t-unified-chat.js` 28/28, t43 22/22,
  history-collapse 17/17; agent-src 174/174, tsc clean. Not covered: clicking a report claim to see its
  quotes (the Report type has no claim→quote link; comes with U3), a real-model run by hand.

### U2. Find papers table
- Library results from the local index plus `Discover.search()`, merged by DOI and title.
- Table with Paper and Summary columns, row ticks, Chat about these / Add to Zotero / Export CSV and RIS.
- Summary of the top papers: one `ask()` call over the ticked-or-top 8 rows, cited.
- Store the search as a history item so it reopens.
- Check: success check 4.
- Done 2026-09-26 (0.20.0): `content/find-view.js`. Library hits (local index, scope from "Look in") and Discover
  results alternate by rank and merge by item key, DOI and title; an outside copy of a library paper shows as the
  library item. Summary column = the abstract's first two sentences (no model call); the cited summary above is
  one `ask()` over the top 8 (or "Summarize these" over the ticked rows), outside papers passed as quote
  attachments with their DOI link. Actions: Chat about these (library papers as items, outside as quotes),
  Add N to Zotero, Export CSV / RIS (file picker). Searches saved as JSON in `<data>/second-brain/searches/`
  and listed in the history. Harness `t-find-papers.js` 18/18 (Discover stubbed); one live run: 32 papers,
  13 in library, no duplicates, Semantic Scholar 429 shown as "couldn't reach". Not done: the summary isn't
  redone when rows are removed (rows can't be removed yet), no "+ Column" (U3), no "Report on these" (U3).

### U3. Added columns with quotes (small engine addition)
- New `ai.extract(papers, column)` in AgentService: fills one cell per paper from abstract (or full text
  when the paper is in the library) and returns `{ value, quote }`. Runs a few papers at a time.
- "Report on these" starts a review scoped to the ticked papers (a new `Scope` kind: `papers`).
- Check: success check 5.

### U4. Screening criteria in the plan card (engine change)
- `Plan` gains `criteria: { text, strict }[]`; the screen stage applies them and keeps unclear papers.
- The report's method section lists the criteria and how many papers each excluded.

## Verification

Build the xpi, install with `open -g -a Zotero --args -purgecaches`, and drive each check by hand in
Zotero. `agent-src` tests (`npm test`) must still pass after U3 and U4.

## Needs your approval

1. The four modes and their names (Chat, Quick answer, Find papers, Research report).
2. Deleting the separate Literature Review tab once U1 works.
3. Order: U1 → U2 → U3 → U4, starting with U1 now.
