// ui-src/src/host.d.ts. The one object the shared UI needs from its app (spec 005 §2). Everything the chat and
// the panels do to their host — reading prefs, going places, finding out what the user is looking at — goes
// through this interface, so the same DOM code runs unchanged in Zotero's chrome and Obsidian's ItemView.
import type { AgentService } from "../../agent/src/service";
import type { Attachment, CitationRef, Scope, StudyType } from "../../agent/src/domain";

export type HostKind = "zotero" | "obsidian" | "web";
export type Placement = "tab" | "sidebar" | "pane" | "dialog" | "page";

/** Find papers' library column, and the merge step's lookup by key — fuller than a plain search hit because the
 *  table (and its CSV/RIS export) wants authors/venue/DOI/abstract the way an outside search result has them.
 *  `key` is a host-specific handle (Zotero: the item key) another host call can look a paper up by again. */
export interface LibraryPaperRow {
  ref: CitationRef; title: string; authors: string[]; year: number | null; venue: string;
  doi: string | null; abstract: string; key: string | null;
  /** Spec 007 E4, all optional and never guessed: what the source knows. A host that doesn't know leaves them out
   *  (Obsidian's library rows have no studyType or fullText), and the Filters popover then hides that filter. */
  studyType?: StudyType | null; fullText?: boolean; pdfUrl?: string | null; citations?: number | null;
}

/** A paper or note the UI can show as a chip and send as an attachment. "reading" and "active-note" show as
 *  "<title> Current"; "selection" is text selected in the reading surface (spec 008 C2), sent as a quote. */
export interface ContextItem { attachment: Attachment; label: string; why: "reading" | "selected" | "active-note" | "selection" }

/** One row of the `+`/`@` picker (spec 008 C3). `detail` is a quiet second label (a note's folder). */
export interface ContextCandidate { category: "note" | "paper" | "collection"; label: string; detail?: string; attachment: Attachment }

/** Outside papers for Find papers (Zotero: discover.js, many services; Obsidian: OpenAlex via requestUrl).
 *  arxiv/pmid/pdf/type/key are optional: Zotero's discover.js fills them in (needed by addToLibrary's lookup and
 *  by the RIS export's item type); a host that can't produce them (Obsidian) just leaves them undefined and the
 *  reader (find-view.js) already falls back sensibly (type ?? "article", pdf/arxiv/pmid unused when absent). */
export interface OutsidePaper {
  title: string; authors: string[]; year: number | null; venue: string;
  doi: string | null; abstract: string; url: string | null; source: string;
  arxiv?: string | null; pmid?: string | null; pdf?: string | null; type?: string; key?: string | null;
  /** Spec 007 E4 (optional, never guessed): study type from the source's own metadata, full text / open PDF, counts. */
  studyType?: StudyType | null; fullText?: boolean; pdfUrl?: string | null; citations?: number | null;
}

/** Spec 008 Z1/Z4: one row of the Zotero collection tree, for the "Where to look" picker. `parent` is the
 *  parent's key, or null at the root; `count` is the collection's own item count, not its descendants' rolled up
 *  (the tree component sums those itself when it needs one). */
export interface CollectionNode { key: string; name: string; parent: string | null; count: number }

export interface UiHost {
  readonly kind: HostKind;
  readonly placement: Placement;
  /** What this host can do; the UI hides, never greys out, what's missing. */
  readonly can: {
    scopes: boolean;              // collections, tags, saved searches
    addToLibrary: boolean;        // Add to Zotero (Zotero)
    openInTab: boolean;           // the dock's "open in a tab" (Zotero)
    notesWithoutServer: boolean;  // false in both today: notes are only searchable through the server
    linksInside: boolean;         // spec 015: links can open inside the app (web app, Obsidian); false in Zotero, so no ↗ or link menu
  };

  // --- engine and connection
  ai(): Promise<AgentService>;
  /** "server" | "local" (Zotero standalone) | "offline"; the UI subscribes to show "Runs on this computer" etc. */
  where(): "server" | "local" | "offline";
  onWhereChange(listener: () => void): () => void;
  /** One call to the Second Brain server's HTTP API, resolving to its JSON reply and throwing on an error status (Home
   *  asks /paper-figure this way). Web: its transport; Zotero: the server URL it already knows; Obsidian: Api.call. */
  json(path: string, method?: "GET" | "POST" | "DELETE", body?: unknown): Promise<any>;

  // --- remembered state (Zotero.Prefs under extensions.secondbrain.*; Obsidian plugin data)
  prefs: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void };
  /** Small JSON files the UI keeps (saved Find papers searches). Zotero: IOUtils under the data dir; Obsidian:
   *  vault adapter under the plugin folder. */
  files: {
    list(dir: string): Promise<string[]>;
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
    remove(path: string): Promise<void>;
  };

  // --- what the user is looking at
  /** Deviates from the spec sketch's singular `ContextItem | null`: Zotero's library selection is often more
   *  than one paper ("3 selected papers" in the chip), so this returns every current item, `[]` for none. A
   *  single active note (Obsidian) is just a one-element array. */
  context(): Promise<ContextItem[]>;                    // reader paper / selected items / active note
  onContextChange(listener: () => void): () => void;   // Zotero polls or uses Notifier; Obsidian: active-leaf-change
  pickPapers(): Promise<ContextItem[]>;                // Zotero item picker dialog; Obsidian FuzzySuggestModal over /search?source=zotero
  /** Everything the `+`/`@` picker can offer; the UI ranks it (fuzzy.js). A host without it keeps "+ Add papers…"
   *  (pickPapers) and no `@`. Called once per picker opening. */
  contextCandidates?(): Promise<ContextCandidate[]>;
  // only called when can.scopes, for the "A tag" / "A saved search" options. Zotero's own data here is
  // synchronous (no I/O); its adapter returns a bare array rather than really wrapping it in a Promise, and
  // chat.js's fillScopeNames() branches on that (a pre-005 harness test needs the <select> populated in the same
  // script turn). A host that genuinely needs to await can still return a real Promise<string[]>.
  scopeNames(kind: Exclude<Scope["kind"], "library" | "collections">): Promise<string[]>;
  /** Spec 008 Z4: the collection tree for the "Where to look" picker's checkboxes; only called when can.scopes.
   *  Same bare-array-or-Promise contract as scopeNames. */
  collections(): Promise<CollectionNode[]>;

  // --- going places
  openRef(ref: CitationRef, opts: { newTab: boolean }): void; // paper: select in Zotero / open Zotero view; note: open in Obsidian
  /** Spec 015: every web link goes through here. `outside: true` is the system browser whatever the setting says;
   *  otherwise the host decides (the web app's browser panel, Obsidian's Web viewer, or, in Zotero, the system browser).
   *  The `openLinks` pref ('inside' | 'outside') is read by the host; see links.js. */
  openLink(url: string, opts?: { outside?: boolean }): void;
  revealFile(path: string): void;
  openInTab?(): void;

  // --- outside papers
  searchOutside(query: string, perSource: number): Promise<{ papers: OutsidePaper[]; failed: string[] }>;
  /** `items` is parallel to `papers` (index-for-index), `null` where that one failed, so a caller — find-view.js's
   *  table, ticking several at once — can mark exactly the rows that made it in, the way the pre-005 code mutated
   *  each row's `.key`/`.citekey` in place as `discover.add()` finished it. */
  addToLibrary?(papers: OutsidePaper[]): Promise<{ items: ({ key: string; citekey: string } | null)[] }>;

  // --- small chrome
  notice(text: string): void;           // Zotero: progress window; Obsidian: Notice
  logError(error: unknown): void;       // Zotero.logError / console.error
  /** The document and style injection point: Zotero adds sb-ui.css to each chrome document once; Obsidian does
   *  nothing (styles.css already has it). */
  mount(root: HTMLElement): void;

  // --- unit C1 additions: found moving chat.js/find-view.js/report-view.js over their ~40 Zotero.*/this.sb.*
  // calls (spec's host.d.ts sketch is explicitly a sketch, not exhaustive). Grouped here rather than folded into
  // the sketch above so a diff against the spec stays easy to read.

  /** Confirm / rename dialogs (Services.prompt in Zotero, a small Modal in Obsidian). */
  confirm(message: string, opts?: { title?: string }): Promise<boolean>;
  promptText(message: string, initial: string, opts?: { title?: string }): Promise<string | null>;

  /** A citekey's label, synchronously from whatever cache the host already keeps (Zotero: sb.citeLabel), for the
   *  citation the model just streamed back before any lookup has had a chance to run. */
  citeLabel(citekey: string): { label: string } | null;
  /** The slower, definite lookup `citeLabel` doesn't have cached yet. Resolves to the citekey itself, never null,
   *  if the paper turns out not to exist (Object.assign-then-the-same-word rather than growing another "unknown"
   *  state the caller has to handle). */
  resolveLabel(citekey: string): Promise<string>;

  /** Find papers' library column: the same search search_library uses, called directly (no model turn), but
   *  filled out with the paper's own fields (Zotero: the item's authors/venue/DOI/abstract), which is what the
   *  table's row and the CSV/RIS export need and a bare search snippet doesn't carry. */
  searchLibrary(query: string, scope: Scope, limit: number): Promise<LibraryPaperRow[]>;
  /** Find papers' merge step: an outside result that turns out to already be in the library (matched by the
   *  host's own item key, not found independently by searchLibrary — e.g. past its limit) is shown as the
   *  user's own copy instead of a duplicate row. Null if the host has nothing under that key (Obsidian: always
   *  null, it has no such keys). */
  libraryPaperByKey(key: string): Promise<LibraryPaperRow | null>;

  /** Find papers' CSV/RIS export: `text` is already serialized (find-view.js's own csv()/ris()); the host picks
   *  a save path, writes it and reveals it. Resolves to false, never throws, when the user cancels the save
   *  dialog or the write fails (the host has already shown why), so the caller never has to catch anything. */
  exportRows(text: string, format: "csv" | "ris", suggestedName: string): Promise<boolean>;
  /** Writes `text` to an arbitrary absolute path with no dialog — the pre-005 Zotero harness tests call
   *  find-view.js's writeExport(format, path) directly to check CSV/RIS content without a file picker in the
   *  way; that method is just this plus this.csv()/this.ris(). */
  writeFile(path: string, text: string): Promise<void>;

  /** Spec 007 E3: saves an export from the artifact panel (CSV, RIS, Markdown). The host picks the place (Zotero: a
   *  save dialog; Obsidian: `Second Brain/Exports/` in the vault, then opens it) and resolves to where it went, or
   *  nothing when the user cancelled. Optional: without it the panel falls back to `exportRows` for CSV and RIS,
   *  then to a browser download, and hides Download when none of those can work (export/save.js). */
  saveFile?(name: string, text: string, mime: string): Promise<{ path?: string } | void>;
}
