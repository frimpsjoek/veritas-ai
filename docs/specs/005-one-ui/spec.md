# Spec: One UI for Zotero and Obsidian, and a Papers / Notes choice

Status: APPROVED by the user 2026-09-26 (decisions at the end). Builds on specs 002 (one chat), 003 (the look) and 004
(the docked sidebar).

## The problem

The user, 2026-09-26: "why is the second brain and the [AI chat] feel like two diff apps in both apps?"

1. **Inside each app, two looks.** The chat has the spec-003 look (13 / 11.5 / 20 px type, radii 6 / 10 / 18,
   the card composer, one outline icon set). The older Second Brain panels do not: the Zotero item-pane section,
   the search window (`search.xhtml`) and the paper-note pane use their own CSS (`--sb-*` variables in
   second-brain.js, search.css); in Obsidian, search, related notes, duplicates, the Zotero paper view and status
   use `sbs-*` classes on Obsidian's size scale.
2. **Between the apps, two chats.** `obsidian-plugin/src/chat.ts` (0.3.0, 978 lines) is a hand port of
   `zotero-plugin/content/chat.js` (0.22.0). It is behind: lucide icons instead of the shared set, Obsidian's
   `MarkdownRenderer` instead of the chat's renderer, its own copies of the domain types, OpenAlex-only Find
   papers, no options panel, no source choice. Every change to the Zotero chat has to be redone by hand, and
   mostly hasn't been.
3. **"Library" is one switch.** "In the library context we should be able to choose whether just papers in
   zotero or also with notes in obsidian." Today `ToolContext.sources.library` turns papers and notes on or off
   together, and in Chat and Quick answer the library can't be turned off at all (chat.js shows only Web there).

## Decisions already made by the user (2026-09-26)

- **One shared UI**: one chat module that both apps load, and one design applied to the older panels too.
- **Source pills in every mode**, under the message box: **Papers · Notes · Scholarly · Web**, remembered
  between chats.

## Goals

1. One chat implementation, used by the Zotero tab, the Zotero dock and the Obsidian view. A change made once
   shows in both apps after each rebuilds.
2. One set of design tokens and components (rows, sections, chips, pills, buttons, empty states, icons) used by
   the chat and by every older panel, in both apps.
3. Papers and Notes are separate choices wherever the library is searched: the chat's four modes, and the
   search panels.
4. Both apps keep working after every plan unit.

## Non-goals

- The note editor (CodeMirror, `editor-src`) and Focus. They stay as they are.
- New chat features. The shared chat is today's Zotero chat (0.22), plus the pills.
- Obsidian gaining Zotero-only abilities (Add to Zotero, collections / tags / saved searches as scopes). The
  adapter says what a host can do; the UI hides what it can't.
- Mobile-specific layout work beyond what the 560 px narrow layout already does.
- Changing how ranking, privacy (privacy.json) or the agent engine work, apart from the source split.

## The design

### 1. Where the shared code lives

`zotero-plugin/ui-src/`, next to `agent-src` and `editor-src`.

- The Zotero repo is public (frimpsjoek/zotero-second-brain) and must build on its own; the Obsidian plugin is
  not a git repo and already imports from `../../zotero-plugin/agent-src`. So the shared code lives in the
  public repo and Obsidian imports it across folders, the same way it imports agent-src today.
- Nothing personal goes in it. Harness fixtures use invented papers and notes, never the user's library.
- Written like agent-src: plain JavaScript with `// @ts-check` and `.d.ts` files for the interfaces, so
  Obsidian's `tsc` checks its adapter against them.
- **Plain DOM, no framework.** Both current chats are plain DOM; the views are small; Zotero chrome documents
  are XUL documents where a framework's `document.createElement` makes XUL elements. One helper
  `h(doc, tag, cls, text)` always uses `createElementNS(XHTML)`, which works in both kinds of document.
- Build: `ui-src/build.mjs` (esbuild) writes `content/sb-ui.js` as an IIFE with the global `SecondBrainUI`,
  loaded by bootstrap.js with `loadSubScript` like `note-editor.js`, plus `content/sb-ui.css`. Obsidian's
  esbuild bundles `ui-src/src/index.js` directly into `main.js`, and its build script concatenates
  `sb-ui.css` + the Obsidian token map + what is left of its own CSS into `styles.css` (Obsidian only loads
  `styles.css`).

What moves into ui-src: `ChatView` (chat.js), `FindView` (find-view.js), `ReportView` (report-view.js), the
markdown + citation renderer (`ChatView.markdown`), the icon set (`ChatView.ICONS`), the chat CSS
(`ChatView.style`), and in stage 2 the panel components. What stays per host: the shells (Zotero `ChatTab`,
`ChatSidebar`, item-pane section, search window; Obsidian `ItemView`s), and one adapter file each.

### 2. The host adapter

Everything the shared UI needs from its app goes through one object. Sketch (`ui-src/src/host.d.ts`):

```ts
import type { AgentService } from "../../agent-src/src/service";
import type { Attachment, CitationRef, Scope } from "../../agent-src/src/domain";

export type HostKind = "zotero" | "obsidian";
export type Placement = "tab" | "sidebar" | "pane" | "dialog";

/** A paper or note the UI can show as a chip and send as an attachment. */
export interface ContextItem { attachment: Attachment; label: string; why: "reading" | "selected" | "active-note" }

/** Outside papers for Find papers (Zotero: discover.js, many services; Obsidian: OpenAlex via requestUrl). */
export interface OutsidePaper { title: string; authors: string[]; year: number | null; venue: string;
  doi: string | null; abstract: string; url: string | null; source: string }

export interface UiHost {
  readonly kind: HostKind;
  readonly placement: Placement;
  /** What this host can do; the UI hides, never greys out, what's missing. */
  readonly can: {
    scopes: boolean;          // collections, tags, saved searches (Zotero)
    addToLibrary: boolean;    // Add to Zotero (Zotero)
    openInTab: boolean;       // ⤢ from the dock (Zotero)
    notesWithoutServer: boolean; // false in both today: notes are only searchable through the server
  };

  // --- engine and connection
  ai(): Promise<AgentService>;
  /** "server" | "local" (Zotero standalone) | "offline"; the UI subscribes to show "Runs on this computer" etc. */
  where(): "server" | "local" | "offline";
  onWhereChange(listener: () => void): () => void;

  // --- remembered state (Zotero.Prefs under extensions.secondbrain.*; Obsidian plugin data)
  prefs: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void };
  /** Small JSON files the UI keeps (saved Find papers searches). Zotero: IOUtils under the data dir; Obsidian: vault adapter under the plugin folder. */
  files: { list(dir: string): Promise<string[]>; read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void>; remove(path: string): Promise<void> };

  // --- what the user is looking at
  context(): Promise<ContextItem | null>;              // reader paper / selected items / active note
  onContextChange(listener: () => void): () => void;   // Zotero polls or uses Notifier; Obsidian: active-leaf-change
  pickPapers(): Promise<ContextItem[]>;                // Zotero item picker dialog; Obsidian FuzzySuggestModal over /search?source=zotero
  scopeNames(kind: Exclude<Scope["kind"], "library">): Promise<string[]>; // only called when can.scopes

  // --- going places
  openRef(ref: CitationRef, opts: { newTab: boolean }): void; // paper: select in Zotero / open Zotero view; note: open in Obsidian
  openUrl(url: string): void;
  revealFile(path: string): void;
  openInTab?(): void;

  // --- outside papers
  searchOutside(query: string, perSource: number): Promise<{ papers: OutsidePaper[]; failed: string[] }>;
  addToLibrary?(papers: OutsidePaper[]): Promise<{ added: number; failed: string[] }>;

  // --- small chrome
  notice(text: string): void;           // Zotero: progress window; Obsidian: Notice
  logError(error: unknown): void;       // Zotero.logError / console.error
  /** The document and style injection point: Zotero adds sb-ui.css to each chrome document once; Obsidian does nothing (styles.css). */
  mount(root: HTMLElement): void;
}
```

Menus and popovers (mode menu, options panel, history drawer) are drawn by the shared UI itself, as the options
panel already is, so they look the same in both apps. Obsidian's `Menu` and Zotero's `menupopup` are not used
inside the chat.

### 3. Design tokens

One stylesheet, written only against `--sb-ui-*` tokens. Each host supplies a small map from its own theme
variables, so light and dark follow the app with no dark-mode rules of our own.

| Token | Use | Zotero (`sb-ui-zotero.css`) | Obsidian (`sb-ui-obsidian.css`) |
| --- | --- | --- | --- |
| `--sb-ui-bg` | view background | `--material-background` | `--background-primary` |
| `--sb-ui-bg-side` | history list, panels' sidebars | `--material-sidepane` | `--background-secondary` |
| `--sb-ui-control` | buttons, pills (off) | `--material-button` | `--interactive-normal` |
| `--sb-ui-text` | body text | `--fill-primary` | `--text-normal` |
| `--sb-ui-muted` | secondary text, icons | `--fill-secondary` | `--text-muted` |
| `--sb-ui-faint` | dates, counts | `--fill-tertiary` | `--text-faint` |
| `--sb-ui-line` | borders, dividers | `--fill-quinary` | `--background-modifier-border` |
| `--sb-ui-hover` | row hover | `--fill-quinary` | `--background-modifier-hover` |
| `--sb-ui-accent` | send, selected row, pills (on), links | `--color-accent` | `--interactive-accent` |
| `--sb-ui-on-accent` | text on accent | `#fff` | `--text-on-accent` |
| `--sb-ui-danger` | unresolved citation, errors | `--accent-red` | `--text-error` |
| `--sb-ui-ok` | "In library", ✓ | `--accent-green` | `--color-green` |
| `--sb-ui-font` | UI font | inherited (system) | `--font-interface` |
| `--sb-ui-mono` | code | `monospace` | `--font-monospace` |

Fixed in the shared sheet, not mapped (spec 003's scale): type 13 / 11.5 / 20 px; radii 6 (rows), 10 (chips,
user messages), 18 (composer), 999 (pills); spacing 4 / 8 / 12 / 16 px; icons 16 px, 1.5 px stroke,
`currentColor`. The old `--sb-*` variables in second-brain.js and Obsidian's `sbs-*` / `sbc-*` classes go away as
their panels move over. Shared class names keep the Zotero chat's `sb-ai-*` prefix (the Zotero harness tests
select on them); panel components use `sb-p-*`.

**Icons**: the shared 16-px outline set (today's `ChatView.ICONS`, extended with the icons the panels need:
paper, note, scholarly, web, related, duplicate, status). Obsidian stops using lucide inside our views; its
ribbon and command icons stay lucide because Obsidian draws those.

### 4. Design principles (apply to every shared component)

1. **Content reads as text first; controls appear on hover or focus.** No boxed inputs for content the user
   mostly reads. An editable line is plain text (`contenteditable="plaintext-only"`) that shows a field outline
   only on hover / focus; remove (×) and row actions appear on hover; one primary button per card, the rest quiet
   text buttons.
2. **One line of status, not a checklist.** Progress is a single line ("Step N of 6 · <stage>"); detail (the
   researchers) shows only while that stage runs.
3. Spec 003's scale and one icon per feature, everywhere.

**Reference**: the calmer report card both hosts got on 2026-09-26 (user found the old one cluttered: two boxed
textareas per sub-question with resize grips, a big ×, a six-line stage checklist). Zotero
`content/report-view.js` `stages()` / `planCard()` and Obsidian `src/chat.ts` `reportStages()` /
`reportPlanCard()`: one progress line, the plan as a plain numbered list with editable question and strategy
text, × on hover, "Start research" as the primary button, "Add a question" / "Cancel" as quiet text buttons.
The shared ReportView starts from the Zotero version; the older panels (stage 2) are redrawn to the same rules
(e.g. search result rows show actions on hover; status shows one line plus a details disclosure).

### 5. Source pills: Papers · Notes · Scholarly · Web

A row of four toggle pills under the message box, in every mode, next to the mode menu (the place the Web pill
and the Library / Scholarly pills sit today). On = accent fill; tooltip says what each searches.

**What each pill searches**

| Pill | Searches | Index `notes.source` values |
| --- | --- | --- |
| Papers | the Zotero library: metadata, abstract, the user's highlights and notes, full text | `zotero` (3517) |
| Notes | the Obsidian vault | everything else: `ai_notes` 5503, `Notion` 3008, `image` 3587, `Clippings` 145, `pdf` 62, `copilot` 33, `People` 25, `personal` 23, `youtube` 22 |
| Scholarly | OpenAlex, Semantic Scholar, arXiv, … (`search_scholarly`; Find papers' outside rows) | — |
| Web | the open web (`web_search`, WebMode `live`) | — |

**Why `pdf` and `image` count as Notes**: they are files the user saved in the vault (kb.py indexes them from the
vault folder tree with OCR text; `NON_NOTE_SOURCES` calls them "not the vault's Markdown notes"). A Zotero
paper's PDF is already inside the `zotero` entry's full text. So "Papers" means "in Zotero" and "Notes" means "in
Obsidian", which is the line the user drew. They are not Markdown, but a user who turns on Notes expects a
screenshot or PDF they clipped into Obsidian to be found.

**What each combination does**

| Mode | Papers | Notes | Scholarly | Web |
| --- | --- | --- | --- | --- |
| Chat, Quick answer | `search_library` over zotero; `read_source` / `related_sources` allowed on paper refs | same over non-zotero; note refs | `search_scholarly` offered | `web_search` offered |
| Find papers | library rows in the table | not used (the table lists papers); the pill is shown disabled with the reason as tooltip | outside rows | not used, disabled |
| Research report | `ReviewSource "papers"` | `ReviewSource "notes"` | `"scholarly"` | `"web"` |

- Papers + Notes on = today's "Library". Neither on = the library tools are not offered at all, and Quick answer
  says "Not in your library" only if it had a library to look in; otherwise it answers from Scholarly / Web.
- All four off: Send is disabled, and the empty state says "Turn on at least one source".
- A scope (collection / tag / saved search, Zotero only) narrows Papers. Notes are never scoped by it; the options
  label reads "Papers in <collection>" so this is visible.
- Offline (Zotero standalone, server down): Notes can't be searched (the local index holds only Zotero items).
  The Notes pill shows a small "offline" mark and the tooltip "Notes need the Second Brain server, which isn't
  running"; its remembered value is kept for when the server comes back. Obsidian always talks to the server, so
  when it is down the whole chat already says so.
- **Remembered**: one value per app, `chatSources = { papers, notes, scholarly, web }` (Zotero pref
  `extensions.secondbrain.chatSources`; Obsidian plugin data). Changing a pill changes the next message and every
  later chat until changed again. Opening an old chat doesn't change the pills. Default when nothing is saved:
  Papers, Notes and Scholarly on, Web off (today's behaviour; Obsidian's existing `webSearchDefault` setting seeds
  Web).

**Engine changes** (agent-src and the server):

- `ToolContext.sources` becomes `{ papers; notes; scholarly; web }`. `search_library` is enabled when papers or
  notes is on and passes `only: "papers" | "notes"` when just one is; `read_source` and `related_sources` refuse
  or drop refs of a kind that is off, so the model can't reach notes through a paper's related list.
- `SendInput` and `ask()` options gain `sources?: Sources`; `defaultToolContext` uses it when present, else
  today's defaults. The user record in a conversation stores `sources`.
- `LibraryBackend.search` replaces `source?: "personal" | "zotero"` with `only?: "papers" | "notes"`.
  `library-http.js` sends `source=zotero` for papers and `exclude_source=zotero` for notes.
- kb.py `Searcher._allowed` / `search` and `/search` in http_api.py gain `exclude_source` (comma list,
  `AND source NOT IN (...)`), and `kb.py search --not-source`.
- Zotero-local library (`agent-host.js` `ZoteroLibrary.search`): `only: "papers"` or a scope → today's local
  path; `only: "notes"` → server only, `[]` offline; neither → server, else local papers.
- `ReviewSource` becomes `"papers" | "notes" | "scholarly" | "web"`; the plan schema in prompts.js follows.

**How saved things map** (read-time, nothing rewritten on disk):

| Saved thing | Old shape | Read as |
| --- | --- | --- |
| Zotero pref `chatSources` | `{ library, scholarly, web }` | `{ papers: library, notes: library, scholarly, web }` |
| Chat / Quick answer turns | user record with `web` only | `{ papers: true, notes: true, scholarly: true, web: web !== "off" }` (what those turns actually searched) |
| Reviews (request, plan sub-questions) | `sources: ["library", …]` | `"library"` expands to `"papers", "notes"`; a resumed review keeps searching both |
| Find papers searches | `sources: { library, scholarly }` | `{ papers: library, scholarly }` |
| Obsidian saved finds (`listFinds`) | rows only | unchanged; opened in the shared FindView |

### 6. Older panels (stage 2)

Same components, same tokens; each panel keeps its data and behaviour.

| Panel | Zotero today | Obsidian today | Shared component |
| --- | --- | --- | --- |
| Search | `search.xhtml` window with a source `<select>` | `SearchView` with a source `<select>` | `SearchPanel`: box, Papers · Notes pills (finer source filter in a "More" popover), result rows |
| Related | item-pane section: "Related notes", "Similar papers" | `RelatedView` | `Section` + `Row` with score bar |
| Paper | item-pane section + paper-note pane | `ZoteroView` (details, highlights, notes) | `PaperCard`, `Section` |
| Duplicates | — | `DuplicatesView` | `Section`, `Row`, buttons |
| Status | preferences index state | `StatusView` | `StatusPanel` (counts per source, indexing now) |

Zotero-only search modes (online, related) keep working, drawn with the shared components.

### 7. Testing the shared UI

- **Shared harness** (`ui-src/dev/harness/`): `index.html` loads `sb-ui.js`, one token map and a **fake host**
  (`fake-host.js`: in-memory prefs and files, a scripted `AgentService` that streams canned events and records
  every `SendInput`, `ask` and `ReviewRequest`, invented papers and notes). Playwright drives it in headless
  Chromium (browsers already cached in `~/Library/Caches/ms-playwright`) for both token maps, light and dark.
  `npm test` in ui-src runs the node unit tests (source mapping, migrations) and the browser checks, and writes
  screenshots to `ui-src/dev/out/` (git-ignored).
- **Zotero**: the existing headless harness (`agent-src/dev/zotero-harness`) and `dev/live`, unchanged.
- **Obsidian**: the shared harness with the Obsidian map covers the UI. For the real app, a CDP smoke script
  (`obsidian-plugin/dev/smoke.mjs`) starts Obsidian with `--remote-debugging-port`, connects with Playwright's
  `connectOverCDP`, opens the chat and takes a screenshot. If Obsidian refuses the flag, the smoke is a manual
  checklist with screenshots.

## Success checks

1. `zotero-plugin/content/` has no chat UI code of its own: ChatView, FindView, ReportView and the chat CSS come
   from `sb-ui.js` / `sb-ui.css`; `obsidian-plugin/src/chat.ts` and the UI half of `find-papers.ts` are gone.
2. `grep` finds no color literal or host theme variable in `ui-src/src/*.css` other than inside the two token maps.
3. The shared harness renders every mode's empty state, a streamed chat answer with citations, a Find papers
   table and a report plan card in both token maps, light and dark, and the DOM class tree is identical between
   the Zotero and Obsidian runs.
4. Every existing Zotero harness test passes unchanged (t-unified-chat, t43, t-chat-look, t-sidebar,
   t-find-papers, t-history-collapse, t-chat-scope, t-focus-steady), and `agent-src` `npm test` and `typecheck`
   pass.
5. In the real Obsidian, the chat shows the Zotero chat's layout: card composer, the shared icons, mode menu,
   pills, options panel, suggestion pills, history; a chat, a Quick answer, a Find papers search and a report plan
   all run against the server.
6. Papers only: a chat's tool calls return only `zotero/…` hits; Notes only: none; both: either. Checked in the
   shared harness (recorded `SendInput.sources`) and against the server (`kb.py search --not-source zotero`
   returns no zotero path; agent-src tool tests with a fake backend).
7. The pills show in all four modes; Find papers shows Notes and Web disabled with a reason; a report started
   with Papers only sends `sources: ["papers", …]`.
8. The pill state survives a new chat, closing the view and restarting the app, in both apps; an old
   `{ library, scholarly, web }` Zotero pref opens as Papers + Notes on.
9. Old chats, reviews (including one paused at plan approval) and saved Find papers searches open and resume
   after the change.
10. Zotero with the server down: the Notes pill shows offline with its tooltip; a Papers chat still works.
11. After stage 2, each panel in the table in §6 uses the shared components; Obsidian's `styles.css` has no
    `sbs-` or `sbc-` rules left and second-brain.js has no `--sb-*` color variables.
12. The report plan card and progress follow §4 in both apps: one progress line, no boxed textarea or resize
    grip, × and field outlines only on hover / focus (checked in the shared harness by hovering and focusing a
    plan line and comparing pictures).
13. After every plan unit both apps build, install and open their chat.

## Decisions (user, 2026-09-26)

1. **Notes in Find papers:** disabled there, with the reason as a tooltip (the table lists papers).
2. **Pill memory:** per app.
3. **Obsidian type size:** follow Obsidian's interface font-size setting; the shared CSS uses host size tokens, not a fixed 13 px, in Obsidian.
4. **Git:** commit today's zotero-plugin work locally (no push) and `git init` obsidian-plugin locally (no remote) before C1.

Status: approved for building.
