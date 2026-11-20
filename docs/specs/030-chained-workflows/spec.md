# Spec 030: one thread, many workflows

Status: APPROVED 2026-11-18 (user: "Approve, build it"; Quick answer in a thread: "Save it as a step").

Written from the user's request of 2026-11-18: "whenever you change the tools or workflows in Veritas, it tries to
create a new page or a new chat, which is not what we want. We want to be able to continue different workflows and
chain them together in some ways. Let's fix this. [...] it is also important for us to try to fix the same workflows
in Zotero and also Obsidian because they are kind of linked together in some ways."

## What happens today (read from the code, `ui/src/chat/chat.js`)

- The mode menu calls `setMode(mode)`, whose default `fresh: true` empties the thread, forgets the chat, the search
  and the report, and sets the title to "New chat" (`setMode`, ~line 872). Every mode change is a new page.
- Each workflow keeps its own record: a chat is a conversation (a session), a Find papers search is a saved search
  (`FindView`), a Research report or Systematic review is a review. Sending in a mode with nothing of that kind open
  makes a new one: a chat question after a Find search makes a new conversation; a report always opens a new review
  and replaces the thread (`openReport` clears it).
- Some chaining exists, from a finished result only: "Add step" under a paper table offers Chat, Columns or Report
  on it, and a report started that way is one `report` step of the session (`openReviewStep`, `agent/src/core.js`).
- The engine already stores a session as steps and results (spec 007): `find`, `import` and `report` steps can sit in
  one session beside chat turns. The gap is in the UI, which never puts a second kind of workflow into an open thread.
- Zotero and Obsidian mount the same `ChatView`, so the same bug is in both, and the same fix reaches both.

## Goals

- R1. Changing the mode (menu, keyboard, or the local menu) while a thread is open keeps that thread, its title and
  its session; only the composer changes (placeholder, options, sources). An empty thread shows the new mode's start
  page as today. "New chat" stays the one way to start an empty thread. Commands from outside the view (Obsidian's
  "Open research report", Home's Routines) still open their mode on an empty thread, as now.
- R2. Find papers in an open thread: the search runs under the earlier turns, in the same thread, and its paper table
  becomes a result of that thread's session (a `find` step). The thread keeps its title; the history shows one row.
- R3. Research report or Systematic review in an open thread: the review starts as a `report` step of the session
  (`request.session`; `on` = the current paper set or table when there is one, as "Add step" does) and its live
  view (plan, approval, progress, report) appears under the earlier turns, not on a new page. The report and its
  papers become results of the session when it finishes (the engine does this already).
- R4. Chat (or Chat with papers / Extract data) after a Find search or a report: the question goes into the same
  session and can use its results (the current result is the question's context, as now). A Find search that has no
  session yet gets one first (`importFind`), so the thread is never split in two.
- R5. Quick answer in an open thread: answered in the thread like a chat question, as a turn of the session (so it is
  saved and the next step can build on it). On an empty thread it stays a one-off answer, as now.
- R6. Reopening a session from the history shows every step in order: chat turns, each Find search (its query, then its
  table card), each report (its question, then the report view). A review that belongs to a session is listed once,
  as that session, not also as its own history row (the engine's review progress names its `session`).
- R7. While a report runs in a thread, the thread stays usable: a chat question can be asked meanwhile, and the report's
  view keeps updating where it is.
- R8. The same in the web app, the Zotero pane and the Obsidian view, checked in each: the harness runs the chain
  Chat → Find papers → Research report → Chat in one thread, then reopens it, on the web shell and under the Zotero
  and Obsidian token maps (narrow pane).

### Added 2026-11-19 after the live test on the installed app (user: "Go ahead and do that")

The chain Chat → Find papers → Research report → Chat → Quick answer was run on the real app and library (a question from
the owner's field). Every step stayed in one thread and reopened in order, but the report written on the Find search said almost
nothing ("the extracted table supports none of the effects asked about"), and two smaller faults showed. Read from the saved
review: every one of its 240 cells came from a search snippet, none from a paper's text, and all 54 papers were kept.

- R9. A Research report on a paper set (asked in a thread after a Find search, or "Report on these") reads the set's
  library papers' text, as a report's own search does, and screens on the question:
  - a Find table names a library paper by its citation key (e.g. `DOEX24`), and the engine asked the server for
    `zotero/DOEX24`, which is no item (`no Zotero item 'zotero/DOEX24'`), so the text read came back empty and the
    snippet was used. A citation key is now asked for as `@DOEX24`, which the server looks up; a Zotero item key keeps
    `zotero/KEY`. The same fix reaches `[@citekey]` citations in answers and Related.
  - the seeded rows of a library paper are marked as having a text (the report's own search does the same).
  - the report writer could cite only citekeys ("skip a paper with no citekey"), so a report resting on papers outside
    the library had no evidence and called its findings uncitable (both live reports, chained and standalone). Evidence
    now names any included paper by its table row id: a library paper is kept as its citekey, an outside paper as its
    DOI link (title and year), shown in the Evidence table and the exported note.
  - with only "prefer" criteria nothing is screened out; a report on a given set adds one strict criterion, "Is about
    the question: …": a paper whose text says no is left out, one it does not settle stays. Shown in the plan, so it can
    be removed before Start research.
- R10. A thread that began with a chat question is listed as a chat (kind and cover), not as "Find papers", whatever
  steps followed. A session that began with its Find search is still a Find search.
- R11. An answer in a thread may cite, by link, a paper the thread already holds (a row of one of its paper sets, or a
  link an earlier answer resolved); it is not marked red as "couldn't be found in your library". A link the thread does
  not hold still is.

- R12. (2026-11-20, user, with a screenshot: after chatting, a Research report asked "i need more papers on this" was
  planned as "a topic or research question": "it doesn't take the context of the previous conversation") A report
  asked in a thread reads the conversation it was asked in (the last turns, `request.thread`), and its message is first
  made a standalone question from it (`asked` keeps the words typed); the plan, the searches and the report's title
  work from that question. Not for "Report from this table", which works on the table.

## Non-goals

- Routines stays its own view (it lists schedules, it is not a conversation); leaving it starts a new chat, as now.
- No change to how a report is planned, run or written, or to what a Find search returns.
- Old sessions, searches and reviews open as they do today (a standalone review still opens as its own page).

## Way of working

- The work before this spec is committed (8b94cd8), so each step can be reversed.
- One commit per requirement group (R1; R2+R4; R3+R7; R5; R6; R8 harness), each with its tests and harness checks.
- Evidence: `VERITAS_BROWSER=1 ./check.sh`, screenshots of the chained thread at 1280 px and in a narrow pane, light and
  dark, looked at before a requirement is called done; recorded in `validation.md`.
