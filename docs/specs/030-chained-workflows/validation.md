# Spec 030 validation

Base: `feat/027-browse` at 462af6e (the approved spec). Run: `VERITAS_BROWSER=1 ./check.sh`, exit 0, 2053 PASS, 0 FAIL;
the run's log is kept on the owner's machine. Unit tests: ui 389, agent 931, web 131, all pass.

| Req | Evidence | Observed |
|-----|----------|----------|
| R1 | harness "chain zotero/obsidian R1: switching to Find papers keeps the thread, its title and its session"; web "1280px spec 030 R1: switching an open chat to Find papers keeps the chat on screen and in the address"; "New chat still starts an empty thread" | pass |
| R2 | harness "chain … R2: the search runs under the chat, names its step, and its papers become a find step of the same session"; unit "spec 030 R2: a search run as a later step of a thread is not what the thread opens as" (`ui/test/steps-data.test.js`) | pass |
| R3 | harness "chain … R3: a Research report asked in the thread is a step of its session, on the papers just found, shown in the thread"; "Report on these … the report opens in the same thread, under the papers" | pass |
| R4 | harness "chain … R4/R5" (chat after the report), "chain … R4: Chat after a Find search goes into the search's session" | pass |
| R5 | harness "chain … R4/R5: … a Quick answer in the thread both go into the same session (no one-off ask)" | pass |
| R6 | harness "chain … R6: the history lists the thread once", "reopened, the thread shows every step in order", "listed once, it reopens as its table with the chat about it underneath"; unit `sessionlessReviews`, `reportStepLabel`; agent "spec 030 R6: reviews.list names the session" (fails with the `review.js` line removed) | pass |
| R7 | the chain asks two questions while its report is still at "Make a plan" (the fake review never finishes) | pass |
| R8 | the chain runs under the Zotero token map at 1100 px and the Obsidian map in a 380 px pane; screenshots `ui/dev/out/steps-chain-zotero.png`, `steps-chain-obsidian.png`, both looked at | pass |

## Choices made while building

- After a report inside a thread the composer stays in the mode you were in (it used to jump to Report).
- A report asked in a thread that holds a paper set or a table runs on it ("Report on these"); with neither it searches.
- A report started on an empty thread is still its own page and its own history row, as before. Chaining from such a
  report starts a new session for the next step; the report stays its own row.
- Reopening a chat from the history opens it in Chat mode, as before.
- The work went in as one commit, not one per requirement group as the spec planned: R1–R6 change the same few
  functions in `chat.js`, so separate commits would not each have stood alone.

## Not checked

- The real engine end to end (all UI runs use the harness fakes); the installed app and plugins are checked by hand after
  the rebuild.

## R9–R11 (added 2026-11-19 after the live test)

Live runs on the installed app, real library, real models, web app at 1280 px (dark), same chain and question each time
(Chat → Find papers → Research report on a question from the owner's field → Chat while it runs → Quick answer → reload → reopen).

| Run | Build | Screening | Text read | Evidence | Notes |
|---|---|---|---|---|---|
| 1 (TEST) | c585871 | 54 of 54 kept | 0 of 240 cells from a paper's text (all snippets) | 1 row | report said "The table provides no …"; Quick answer citation red; history row "Find papers" |
| standalone | c585871 | 31 of 31 kept | abstracts | 0 rows ("every row lacks a citekey") | own search; 0 library papers kept |
| 2 (TEST2) | 11e2577 | 43 out, 11 kept | the 15 library papers read from their full text (all judged not on topic, correctly) | 0 rows ("no citekey is available for that row") | Quick answer citation not red; row reads as a chat |
| 3 (TEST3) | 554f229 | 42 out, 12 kept | as run 2 | 3 rows, cited by link (two outside papers, 1999 and 2005) | 8/8 chain checks; screenshot `12-test3-evidence.png` looked at |

Causes found in the saved review files: `zotero/<citekey>` is no item (the server answered "no Zotero item 'zotero/<citekey>'");
only "prefer" criteria screen nothing out; the writer could cite only citekeys. Each fix has a unit test that fails
without it (mutation-checked), and `VERITAS_BROWSER=1 ./check.sh` passes (exit 0, 2057 browser checks).

Choices made while building: the topic criterion is added only when the planner marked none strict, and it shows in the
plan, so it can be removed before Start research; it also applies to "Report on these" on a hand-picked set (a paper is
left out only when its text says no; one it does not settle stays). Outside papers are cited only in the Evidence table
(by link); themes still name them in prose.
