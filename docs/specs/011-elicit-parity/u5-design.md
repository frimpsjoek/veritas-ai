# U5 Projects + New from selection: design (spec 011, 0.44.0)

Date: 2026-10-07. Author: design counsel (Fable), read-only pass over the code. Follows plan.md section 9's two deferred items.
References: Elicit's sidebar (a "Projects" list above the task history, "+ New project", a task's "..." menu has "Add to project")
and Zotero's own conventions (a collection is a label, not a container: an item stays in the library when its collection is
deleted; "Add to Collection" lives in the item's context menu; the item pane and context menu act on the current selection).

## 0. Facts that shape the design

1. Two runtimes, two data folders: sidecar `~/obsidian-kb/data/agent`, Zotero `<Zotero.DataDirectory>/second-brain`. `AgentHost.ai()` (content/agent-host.js:28) switches to the server when `/agent/ping` answers and hands local files over: `adoptChatsInto` copies `chats/*.jsonl` verbatim (`store.adopt`, keep-the-first by id), `adoptRoutinesInto` sends `routines/*.json` through `routines.adopt` (idempotent, `mergeRoutines` keeps the later `updated`). Anything written INSIDE a chat's JSONL travels with it for free; anything beside it needs its own adopt.
2. A conversation's summary is rebuilt from records only (`conversationStore.summarize`, agent-src/src/store.js:36-50): `meta`, the last `rename`, `summaryExtras`. The only writes are `append`. `ConversationSummary` (domain.d.ts:286) already carries an optional `routine`.
3. Reports are not conversations: `reviews.list()` reads `reviews/<id>/request.json` (core.js:759, 1478-1490) and the history mixes `ConversationSummary`, `ReviewProgress` and saved Find searches (`refreshList`, ui-src/src/chat/chat.js:827-856; `historyEntries` in steps-data.js lists a search with a `session` as that session).
4. Remembered UI state goes through `host.prefs` (host.d.ts:63). Zotero stores any key (`extensions.secondbrain.<key>`, JSON for objects; content/ui-host-zotero.js:109-122). Obsidian's `prefs` is a whitelist of three keys over `plugin.settings` (obsidian-plugin/src/ui-host.ts:206-219, keys in src/api.ts:17-40): a new key needs a line in both.
5. Selection already reaches the chat three ways: the item context menu "Ask Second Brain about this" -> `openChat({ attach })` (content/second-brain.js:800-811, `ChatTab.open` content/chat.js:21-38, which also sets `view.selected` from `getSelectedItems()`); the picker row "Selected papers" built from `host.context()` items with `why: 'selected'` (chat.js `showPicker`, 2158-2170) -> `finishPick(kind, rows, label, 'selection')` (2222-2243) -> `sessions.put` import step -> `openPaperTool`; and `renderSuggestions` pills ("Compare these papers") when `this.selected` has items (chat.js 757-800). "Report on these" is `reportFrom(summary)` (2069).
6. `/agent/*` is forwarded whole by the Python server (`_forward_to_agent_sidecar`, http_api.py:320-326): new agentd routes need no Python change.
7. Another agent is editing the error cards: `fail()` at chat.js:1695-1710 and its callers (1302, 1947). Nothing here touches 1280-1320, 1680-1720 or 1940-1950.

## 1. Projects

### Data model
- A project is a label (Zotero collection semantics), stored one file per project like routines: `<dataDir>/projects/<ulid>.json` via `writeAtomic`, `{ id, name, created, updated }`. New module `agent-src/src/project-store.js` (list/create/rename/remove/adopt; a file that does not parse is skipped, never fatal; `adopt` is idempotent by id and keeps the later `updated`, the same shape as `routine-store.js`).
- Membership lives inside each member, never in the project file, so it survives adoption and a server outage:
  - chat: a new append-only record `{ type: 'project', project: ProjectId | null, at }` in the chat's JSONL (domain.d.ts `ConversationRecord` union, beside `rename`); `meta` gains optional `project` for chats born inside a project. `summarize` sets `ConversationSummary.project` = last `project` record's value ?? `meta.project` (`null` from a record means removed). Old chats have neither -> `project` undefined -> unchanged.
  - report: `ReviewRequest.project?: ProjectId` written into `request.json` at `reviews.start`; a later move rewrites only that field (read, patch, `writeAtomic`; every other reader of request.json ignores unknown fields). `ReviewProgress.project?` is read like `question`/`systematic`.
  - saved Find search without a session: not a member until it is opened (its first step runs `importFind`, chat.js 2073-2096, which makes the session); listed under "All chats" only.
- Deleting a project deletes its file only. Members keep a dangling id; the UI treats an id not in `projects.list()` as "no project". No JSONL is ever rewritten.
- Consistency across runtimes: Zotero alone writes `projects/<id>.json` and `project` records locally; `AgentHost.adoptInto` gains `adoptProjectsInto(server)` (same body as `adoptRoutinesInto`, folder `projects/`, moved to `projects-adopted/`) and keeps running `adoptChatsInto` first, so by the time Obsidian lists, both the names and the memberships are on the server. Obsidian is always remote (nothing to adopt).

### Engine API (service.d.ts, remote.js, agentd.mjs `routes()`)
```ts
projects: {
  list(): Promise<Project[]>;                                  // GET  /projects            name order
  create(name: string): Promise<Project>;                      // POST /projects            { name }
  rename(id: string, name: string): Promise<Project>;          // POST /projects/rename     { id, name }
  remove(id: string): Promise<void>;                           // DELETE /projects          { id }; members keep their history
  /** Moves one chat or report into a project (null = out of any). A chat gets a `project` record; a report's request.json is patched. */
  assign(target: { kind: 'chat' | 'review'; id: string }, project: string | null): Promise<void>;  // POST /projects/assign
  adopt(records: Project[]): Promise<string[]>;                // POST /projects/adopt      { records }
}
```
Also: `conversations.create(mode, opts?: { project?: string })` (meta.project; route body `{ mode, project }`; remote.js sends it) and `ReviewRequest.project?` (no new route: it is in the start body). `Project` type in domain.d.ts: `{ id: string; name: string; created: string; updated: string }`. core.js wires `projectStore = createProjectStore(platform.fs, `${dataDir}/projects`)` next to `routineStore`; `assign` for a chat is `store.append(id, { type:'project', project, at })`, for a review `readReviewFile` + `writeAtomic(reviewPath(id,'request.json'))`, refusing an unknown id with a plain message ("There is no chat with that id.").

### UI (shared chat, `ui-src/src/chat`)
Placement follows Elicit: projects sit at the top of the history column (`this.side`, chat.js:168-173), above New chat. One row, not a tree (we have no nesting, and a tree would fight the narrow drawer):
- `.sb-ai-project` switcher: a quiet button reading **All chats** or the open project's name, with a chevron. Click -> popover (`openPopover`, popover.js:17) listing **All chats**, then the projects (a check mark on the open one), a separator, **New project...**, and, when a project is open, **Rename project...** and **Delete project...**. Dialogs reuse `host.promptText` / `host.confirm`. Delete confirm: "Delete "Voles"? Its chats and reports stay in your history." Hidden entirely when `ai.projects` is missing (older server), the way `routinesService` guards U4.
- Open project is remembered in `host.prefs` key `chatProject` (string | null; Obsidian: add `chatProject` to `api.ts` settings and both `prefs` branches). `refreshList` filters `entries` to members of the open project (chats by `conversation.project`, reports by `progress.project`); the empty list reads "Nothing in Voles yet. Start a chat, or move one here from its ... menu." (`.sb-ai-list-empty`). `newChat`/`submit` pass `{ project }` to `conversations.create` and `project` into `ReviewRequest` while a project is open; `finishPick` and `importFind` do the same (they call `conversations.create`).
- Per row: the existing hover `×` stays (harness tests do not reference it, but Delete keeps its place). A `...` button (`.sb-ai-conv-more`, same hover rule as `.sb-ai-conv-x`) appears before it; right-click on the row opens the same menu (Zotero habit). Menu: **Rename**, **Move to project ▸** (projects + **New project...**), **Remove from project** (only when it has one), **Delete**. Report rows get the same menu minus Rename. The current "Double-click to rename" stays.
- Header: nothing new. The project name is already visible in the switcher; the header title keeps the chat's name.
- Empty-state cards (`cardSplit(this.recent)`) use the filtered list, so a project's empty state shows its own recent sessions.

Pure helpers in a new `ui-src/src/chat/projects-data.js` (node-tested): `projectOf(summary, knownIds)`, `filterEntries(entries, projectId, knownIds)`, `switcherLabel(project)`, `projectMenu(projects, openId)` (rows for the switcher), `rowMenu(entry, projects)` (rows for a chat/report), `emptyLine(project)`. The popover/menu DOM in a new `projects-menu.js`; chat.js only gets the switcher element, three `refreshList` lines, the `...`/contextmenu hook in `chatRow`/`reportRow`, and `{ project }` on its three `conversations.create` calls and two `reviews.start` requests (1239, 2080).

### Back-compat
Old chats and reviews: no record, no field -> listed under All chats, never under a project. Old server (no `/projects`): `ai.projects` undefined -> switcher and row menus' project items hidden; `×` and double-click rename work as today. Old `chatProject` pref pointing at a deleted project -> treated as All chats and reset.

## 2. New from selection (Zotero library)

What Elicit shows when papers are ticked in its Library is a panel with "New from selection: chat / extract / review". Our equivalent reuses the three existing selection paths (fact 5) and adds exactly one new method on ChatView, reached from two places.

### One entry point: `ChatView.startFromSelection(kind, items)`
`kind` is `'papers' | 'extract' | 'report'`; `items` are `ContextItem`s (`why: 'selected'`). Body: resolve rows the way the picker's "Selected papers" row does today (lift chat.js 2160-2168 into `rowsFromSelected(items)`: `host.searchLibrary(label, {kind:'library'}, 5)` matched by citekey, else `paperRowFromContext`), then `finishPick(kind === 'report' ? 'papers' : kind, rows, label, 'selection')` with the label the picker already uses ("3 selected papers" / the one title), then for `'report'` call `reportFrom(summary)` (chat.js 2069; it asks the question, plans, and writes back into this session). A session that is already open and holds artifacts is left alone: `startFromSelection` always starts a new session (that is what "New from selection" means; `finishPick` only reuses `this.sessionID`, so clear it first via `setMode('chat')`). Nothing new in the engine.

### Where it is offered
1. **In the chat (both hosts), when the thread is empty and the library selection has 1+ papers**: the suggestion area (`renderSuggestions`, chat.js 757) gets one card above the pills, `.sb-ai-selcard`: "**3 papers selected**" and three small buttons **Chat with these**, **Extract data**, **Write a report** (the last only when `this.engineCanReport`). Built in a new `ui-src/src/chat/selection-card.js` (`selectionCard(doc, items, can, onPick)`), so chat.js adds two lines. The pills underneath stay as they are (they ask a plain chat question). Source: `this.selected` (tab) or `activeContext` items with `why === 'selected'` (sidebar), the same two `renderSuggestions` reads now. No card for a single reader paper (`why: 'reading'`): that is the sidebar's existing "Ask about this paper" flow.
2. **Zotero item context menu**: the single "Ask Second Brain about this" item becomes a submenu **Second Brain AI ▸** (`Zotero.MenuManager.registerMenu`, content/second-brain.js:800-811; `menuType: "submenu"` with child `menus`; if the installed Zotero rejects submenus, register four flat items instead) with **Ask about this** (today's attach path), **Chat with these papers**, **Extract data from these papers**, **Write a report on these papers**. `onCommand` -> `this.openChat({ start: kind, items })`; `ChatTab.open` (content/chat.js:21) gains `start` and calls `view.startFromSelection(start, selected)` after `renderSuggestions`. Labels in `locale/en-US/second-brain.ftl` next to `second-brain-menu-ask` (line 21). Related / Discover / Find PDF stay where they are.
3. Not built: an item-pane section button (the pane is per paper, the feature is per selection) and an Obsidian equivalent (no multi-selection of papers there; the card appears when the picker has attached several).

### Wording
Card title "N papers selected" (1: "1 paper selected"). Buttons as above; the resulting session title is the picker's label. Report path keeps `reportFrom`'s own question prompt. No "session", "import", "artifact" in any string.

## 3. Tests

Unit (agent-src, `node --test`):
- `test/project-store.test.js`: create/list sorted by name; rename updates `updated`; remove then list; a torn file is skipped; adopt twice is a no-op; adopt of a newer copy keeps the later `updated`.
- `test/store.test.js` (add): `meta.project` seeds the summary; a `project` record overrides it; `project: null` clears it; a chat with neither has no `project` key; `adopt` carries the records across unchanged.
- `test/core-projects.test.js`: `assign` chat appends one record and `conversations.list` shows it; `assign` review patches `request.json` and keeps `question`/`skills`/`systematic`; `reviews.list` exposes `project`; `conversations.create('chat', { project })`; unknown id refused with a plain message; `remove` leaves members listed with the dangling id.
- `test/remote.test.js` (add a case): every `/projects*` route round-trips through the loopback transport; `create(mode, { project })` sends `project`.
Unit (ui-src): `test/projects-data.test.js` for every helper in projects-data.js (dangling id -> All; report filtering; menu rows with and without an open project); `test/steps-data.test.js` unchanged.

Real-Zotero harness (`agent-src/dev/zotero-harness/tests`, SB_SERVER at a dead port, scripted provider):
- `t-projects.js`: switcher reads "All chats"; New project "Voles" -> switcher reads "Voles", list shows the empty line; send one turn -> row appears, `conversations.list()` summary has `project`; switch to All chats -> row still there with the others; row `...` -> Remove from project -> gone from Voles; Move to project -> back; Rename project -> switcher and menu updated; Delete project -> chat still under All chats; close and reopen the tab -> `chatProject` pref remembered (and reset when the id is gone).
- `t-new-from-selection.js`: select 3 regular items in the library pane; open the chat tab -> `.sb-ai-selcard` says "3 papers selected"; Chat with these -> a new session with an `import from: "selection"` R1 of 3 rows and the Chat tab open; back in the library, context menu "Extract data from these papers" -> a second session, Columns popover open; "Write a report on these papers" -> `reviews.list()` gains one review with `session` set and `on: R1`.
Live check (two runtimes): Zotero alone, make project + chat; start `kb.py serve`; after the switch, Obsidian lists the project and the chat under it; `projects-adopted/` holds the moved file; a second switch adopts nothing.

## 4. Work units (parallel, file ownership)

| Unit | Owns | chat.js? |
|---|---|---|
| **A. Projects engine + hosts** | `agent-src/src/project-store.js` (new), `core.js` (projects block, `assign`, create/start `project`), `store.js` (`summarize`, `project` record), `service.d.ts`, `domain.d.ts`, `remote.js`, `node/agentd.mjs`, tests above; `content/agent-host.js` (`adoptProjectsInto`); `obsidian-plugin/src/api.ts` + `ui-host.ts` (`chatProject` pref) | No |
| **B. Projects UI** | `ui-src/src/chat/projects-data.js`, `projects-menu.js` (new), `ui-src/test/projects-data.test.js`, harness `t-projects.js`; chat.js hooks only at `build()` 168-185 (switcher), `refreshList`/`chatRow`/`reportRow` 827-930 (filter, `...`, contextmenu), `remove`/`rename` 991-1005, the `conversations.create`/`reviews.start` call sites (1239, 1286, 2080, 2231) and new methods appended at the end of the class; CSS block at the end of chat.js | Yes, those ranges |
| **C. New from selection** | `ui-src/src/chat/selection-card.js` (new), `content/second-brain.js` (submenu), `content/chat.js` (`start` option), `locale/en-US/second-brain.ftl`, harness `t-new-from-selection.js`; chat.js hooks only at `renderSuggestions` 757-800 (card), `showPicker` 2158-2170 (lift `rowsFromSelected`), and the new `startFromSelection` method appended at the end of the class | Yes, those ranges |

A and C can start now in parallel (disjoint files). B depends on A's `service.d.ts` and can be written against it at once, but its chat.js edits and C's are in different regions of the same file: land C's chat.js hunk first (small), then B's, or give both to one agent in sequence. Neither B nor C touches the error-card region (1280-1320, 1680-1720, 1940-1950) the other agent is working in. Version 0.44.0 for both manifests; `npm test` + `npm run typecheck` in agent-src and ui-src, then both harness tests on fresh profiles, then the live two-runtime check.

## 5. Decisions to confirm
D1 project = label, membership stored in the member (chat record / request.json field), project file holds the name only. D2 open project is a UI pref, not engine state (Zotero and Obsidian may differ; fine). D3 one switcher row at the top of the history, menus behind `...`/right-click, no tree and no drag. D4 selection card + context submenu both funnel into `startFromSelection`; no item-pane button. D5 saved searches without a session join a project only once opened. D6 routines are not project-aware (a session a routine starts has no project); follow-up if asked.
