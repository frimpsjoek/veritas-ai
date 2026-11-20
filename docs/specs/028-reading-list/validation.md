# Spec 028 validation

Base: `feat/027-browse` at 271915b. The change is uncommitted in the working tree: 48 files, +2377 / −125 (this log and
this file aside), new files marked intent-to-add (`git add -N`) so `git diff HEAD` shows them.
Run: `VERITAS_BROWSER=1 ./check.sh` on the main checkout, exit 0. The run's log (kept on the owner's machine, not in the repo) opened
with its date (2026-11-18T14:18:42Z), host (Darwin 25.6.0), base commit and `diff: f8ffe9abbe1bcb3d`: the first 16 hex
of the sha256 of `git diff HEAD -- . ':!docs/specs/028-reading-list/check-2026-11-18.log'
':!docs/specs/028-reading-list/validation.md'` at the time of the run (this file is excluded, so editing it after the
run does not change the hash). Counts: tools 30, agent 925, ui 365, web 124, browser harness 0 FAIL, obsidian 27,
zotero 28, server 595 passed / 3 skipped. The app's cargo check was skipped by the script (app sidecars not built).

How it was built: three lanes (A: G1, B: G2, C: G3) in separate worktrees, merged. Review 1 (sdd-verifier) said NO:
the badge did not drop when an issue's chat was opened, ten smaller bugs, missing evidence; all fixed with tests.
Review 2 said NO: Library's Read later filter left the table and search bar on screen (a `display: flex` rule beat
`[hidden]`); this record had wrongly said that screenshot was looked at. Fixed, the check now asserts the table and bar
are gone, plus R3 shots of the user's own paper, the shell's badge wiring, and five robustness fixes. Review 3 said NO: the new line-break
glue kept whole italic runs ("[J. Chem. Phys.") from wrapping and had no unit test. Now only a word glued to an inline
formula is kept whole (`wordGroups`, pure, unit-tested), the harness asserts no glued run holds a space and no sideways
scroll, and three notes are fixed (a failed first read says so with Try again; the later verdict reads the list
afresh; no stale banner over the Read later filter). Review 4 (on that
delta only) said APPROVE, with two notes fixed after it, each with a test that fails without its fix: an italic
phrase with spaces touching a formula is no longer glued, and a fresh read that failed (giving an older list) no
longer counts as "not listed before" for Undo. Its third note is fixed too: the harness now checks that, with the server
gone, the Read later filter shows no stale banner and the collection shows it again (the check fails with the
`laterOn` hiding removed from `web/src/library-view.js`). Every screenshot named below was opened and looked at after the run before
the last one; the last two fixes change no drawing on these fixtures.

| Req | Evidence (test name, file) | Observed |
|-----|----------------------------|----------|
| R1 | "mhchem formulas: digits after an atom or a bracket are subscripts, a bond is a dash, charges are superscripts" (`ui/test/paper-text.test.js`) | pass |
| R1–R2 | "the arXiv:2611.20723 title and abstract keep no TeX in their words" (fixture `ui/test/fixtures/arxiv-2611.20723.json`, real text from export.arxiv.org); "\textit and \emph are italic, \textbf bold, also inside brackets"; "where only a string fits, the title reads as text" | pass |
| R2 | "a dollar glued to a word opens math when a letter or a command follows it (TD$GW$-MD), not money" | pass |
| R3 | "the reader draws an arXiv answer's TeX as text: title, byline, abstract and the bar"; "an open-access copy's heading, byline and abstract get the same TeX pass as its bar title"; "an ordinary page keeps its words as they are" (`web/test/browser-state.test.js`); harness on the user's paper (fixture answer for arxiv.org/abs/2611.20723): "arXiv:2611.20723: no \\ or $ in its title, byline, abstract or the bar title", "GW in the title is one italic; C2H4O has its subscripts 2 and 4; HOMO → LUMO has its arrow", "TDGW-MD stays whole at a line's end; only words glued to a formula are, never a run with a space; no sideways scroll", each at 1280/700/360 px; `wordGroups` tests in `ui/test/paper-text.test.js`; screenshots `ui/dev/out/browser-arxiv-2611-{1280,360}.png` | pass; both looked at |
| R4 | same reader test asserts `paperToAdd` keeps the raw title and abstract; reading-list entries keep the raw title (`agent/src/reading-list.js` `entryOf`) and are drawn with `setPaperText` | pass |
| R5 | "only issues with news from the last 7 days count" (8 days out, 6.9 days in); "news.at is the issue's age…" (`ui/test/home-waiting.test.js`); "the badge counts only the last week" (`web/test/news-badge.test.js`) | pass |
| R6 | "opening a radar paper in the panel tells its issue it was viewed" (`web/test/browser-panel.test.js`, fails with the `viewed()` line removed); "the reader and Home telling the same paper at once: the engine is told once"; "a reader link knows its issue's session and row" | pass |
| R7 | "opening a session with news tells the engine, then the host" (`ui/test/chat-news.test.js`); harness "a paper viewed outside the page drops the rail Home badge on the next route change (Home → Library)" and "and on the window's focus, with no route change" (`ui/dev/web-checks.mjs`, 3 widths; the route check failed with `news.route()` removed from `render()`); `followNews` unit tests | pass |
| R8 | `agent/test/reading-list.test.js`: idOf / alias ids / dedupe keeps first `added` / atomic write / bad file read as empty and kept aside as `.bad-<time>` / two adds at once / persists across restart | pass |
| R9 | "the agentd routes and remote.js reach the same service" | pass |
| R10 | `web/test/read-later.test.js` bookmark tests (hidden until known, pressed copy, remove, any-id match, Undo only removes what the verdict added); harness "digest: the Read later bookmark is an icon button with aria-pressed and no key, right after Add to Zotero", "browser: judging … Read later bookmark (no key), on one line", reader header "Publisher's page, Read later (bookmark, aria-pressed) and Copy citation"; screenshot `judging-home-1280-light.png` | pass; screenshot looked at |
| R11 | "the view: Unread then Read; opening marks read; an entry in Zotero says so; the empty list has its line"; "the rail badge: unread entries, hidden at 0"; harness "weblib: 1280px the Read later view and its rail badge (1 unread)", screenshot `web-read-later-1280.png` | pass; screenshot looked at |
| R12 | harness "weblib: 1280px the Library tree has a Read later row with its count", "with the server gone: the Read later filter shows no stale banner, and the collection shows it again", "Read later in Library takes the table's place (no search bar, no table) and lists Unread then Read…", screenshot `web-library-later-1280.png`; `zoteroKeys` tests; "a hidden Read later pane (Library's filter, not open) asks nothing of Zotero until it is shown" | pass; screenshot looked at |
| R13 | obsidian typecheck + 27 tests + build, zotero build + 28 tests + package checks (in the log); "no reading list on this engine: no bookmark" | pass |

| robustness | "the first read failing is not \"no list\" and not \"Loading…\" for ever…", "a paper saved in another window since the last read is not taken off by Undo" (fails with the fresh read removed); `web/test/read-later.test.js`: "a fresh read that fails keeps the last good list…", "a bookmark just pressed stays visible when the read after the add fails", "the first read failing is not "no list"…", "…when "was it listed before" could not be read, Undo leaves the paper on the list", "Open comes back after the open…", "a bookmark built but never put on the page drops its listener after two changes" | pass |

## Choices made while building (for the user to accept or change)

- The 7-day window uses `news.at` (when the issue last brought unread papers), not the chat's `updated`.
- Read later is in the rail from 700 px; on a phone it is in More (the phone bar holds four items). The More item shows
  no count.
- The Library row counts all entries; the rail badge counts unread.
- `read` is stored as the time it was read.
- Undo of a `later` verdict removes the paper only if that verdict put it on the list, remembered in memory: after a
  reload, Undo leaves it on the list.
- Old issues keep their "new" dot on the cover; only the count changed.
- No bookmark in the PDF view's bar.

## Not checked

- The desktop app (Tauri) itself: the app check was skipped and Browse's native webview was not opened.
- The real server with a real radar issue; all UI runs use the harness fakes.

## Found on the way (fixed here, not in this spec)

`check.sh` ran the browser harness before the Zotero build, but the harness's digest page loads
`zotero/content/sb-ui.js`, which that build writes, so a tree whose Zotero bundle was older than its `ui/` code failed
the harness until `zotero/build.sh` had run once. The harness step now runs after the Zotero step (the run in the log
is in that order).
