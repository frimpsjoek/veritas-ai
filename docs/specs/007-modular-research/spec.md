# Spec: Modular research, with data as the results

Status: APPROVED by the user 2026-09-26 (decisions at the end).
Builds on spec 005 (shared `ui-src`, `UiHost`, source pills, §4 design principles); its units run after 005's C units (C4) and before the D units. Absorbs spec 002's planned U3
(columns with quotes, "Report on these") and U4 (screening criteria).

Design reference: `specs/005-one-ui/elicit-reference.md` (the "User priorities" section is the brief) and the
Elicit screenshots `/Volumes/Content/Screen-grabs/CleanShot 2026-09-26 at 9.21.17 PM.webp` … `9.23.41 PM.webp`.

## The problem

The user, 2026-09-26, after using Elicit until its monthly limit: build all four (artifacts side panel; columns +
filters; chat-with-papers panel; clarify cards + activity lines), plus "the modular nature and how they also do
their research and how the planning and thinking is compacted so it's not cluttering and how they essentially
deal with the data".

What we have today:

1. **Every mode is a separate island.** A chat, a Find papers search and a report are three history items with
   three storage formats (`chats/<id>.jsonl`; `second-brain/searches/find-*.json` in Zotero and a finds file in
   Obsidian; `reviews/<id>/*.json`). A Find papers table can be sent to the chat only as chips; nothing a step
   produces can be picked up by the next step as data.
2. **Results are text.** The only shared currency is chat prose. A table the model writes is a Markdown table in
   an answer; a report's evidence has no link back to the sentence that supports it (spec 002 U1 noted this).
3. **The AI re-searches.** A follow-up question about papers already found runs `search_library` /
   `search_scholarly` again, because the model has no way to read what the session already holds.
4. **Reports are written from notes, not data.** `research` stage researchers return free-form claims;
   `synthesize` writes from those. Nothing is screened against criteria, nothing is extracted into columns.
5. **Activity is noisy.** Each tool call is its own line (`sb-ai-activity`), and there is no reasoning to fold
   because the engine doesn't forward it.
6. **No scoping before long work.** A report goes straight to a plan, even when the question is ambiguous.

## Goals

1. A session is a **stack of steps**. Each step reads typed results and writes a new, versioned result
   (papers, table, report, answer). Find papers → add columns → narrow down → chat with these → report works as
   one session, and every result stays open for the next step.
2. **Data is first-class.** Paper sets and tables are artifacts with versions (V1, V2), a quote and citation per
   cell, search / sort / filter, and export (CSV, RIS, Markdown). The AI reads them with a tool instead of
   searching again.
3. **Research follows a method.** Clarify (≤ 2 question cards) → plan or protocol → searches → screening →
   extraction into a table → synthesis written from that table.
4. **Thinking is compacted.** One activity line per step ("Ran analysis · Conducted 4 searches"), reasoning
   folded under it, everything expandable. The thread shows answers, question cards and artifacts.
5. Both hosts get all of it through `ui-src`; both apps work after every plan unit.

## Non-goals

- Multiplayer, sharing, alerts, "Save to library" as a paid step, a Clinical trials source.
- Full-text screening of hundreds of PDFs the user doesn't have. Outside papers are screened and extracted from
  their abstracts; only papers in Zotero are read in full.
- PRISMA flow diagrams as pictures. The method section reports the counts (found, screened out by which
  criterion, extracted); a diagram can come later.
- Uploading PDFs into a session. Papers enter a session from Zotero, the vault index or outside search.
- Any tool that writes. Tools stay read-only by construction (spec 001 decision); every write (results, versions,
  notes) is done by our own code after a turn, as reviews already do.
- Changing ranking, privacy.json, providers or the slot pool.

## Words used here

| Word | Means |
| --- | --- |
| Session | What the history lists: one thread. Today's conversation, grown steps. Same id, same JSONL file. |
| Step | One unit of work in a session: a chat turn, a Find papers search, adding columns, narrowing, screening, a report. |
| Result | What a step writes: `papers`, `table`, `report` or `answer`. Named R1, R2 … per session. |
| Version | Each change to a result writes a new immutable version: V1, V2 … Older versions stay readable. |
| Artifact | A result shown to the user as a card in the thread and in the side panel. Every `papers`, `table` and `report` result is an artifact; `answer` results are not shown as cards. |
| Current result | The paper set or table the next step works on by default: the newest one, unless the user picks another. |

## The design

### 1. Sessions, steps and results

#### 1.1 Data types (sketch, `agent-src/src/domain.d.ts`)

```ts
export type SessionId = ConversationId;                    // a session is a conversation; no second id space
export type StepId = Brand<string, "StepId">;              // "S1", "S2" … per session
export type ResultId = Brand<string, "ResultId">;          // "R1", "R2" … per session; short so the model can name them
export type RowId = Brand<string, "RowId">;                // stable across versions: "p:<citekey>" | "doi:<doi>" | "t:<title hash>" | "x:<n>"
export type ColumnId = Brand<string, "ColumnId">;          // slug of the column name, unique within a result

export interface ResultRef { id: ResultId; version: number }
export type ResultKind = "papers" | "table" | "report" | "answer";

/** One paper in a set. `ref` is how answers cite it: a paper ref when it's in Zotero, a note ref for a vault PDF,
 *  a web ref to its DOI link (https://doi.org/…) or URL when it's outside. */
export interface PaperRow {
  id: RowId; ref: CitationRef; inLibrary: boolean;
  title: string; authors: string[]; year: number | null; venue: string;
  doi: string | null; url: string | null; abstract: string;
  citations: number | null;          // OpenAlex cited_by_count / S2 citationCount, when the source gave one
  fullText: boolean;                 // Zotero has full text for it (read_source works), or an open PDF link exists
  pdfUrl: string | null;
  studyType: StudyType | null;       // from source metadata; null = unknown, never guessed at import
  foundBy: string[];                 // "Your library", "OpenAlex", "Semantic Scholar" …
}
export type StudyType = "review" | "systematic_review" | "meta_analysis" | "rct" | "longitudinal" | "other";

export interface ColumnSpec {
  id: ColumnId; name: string;        // "Limitations"
  instruction: string;               // what to extract, in the user's words or the preset's
  kind: "text" | "number" | "criterion"; // criterion cells answer yes / no / unclear (screening, §2.4)
  preset?: "summary" | "main_findings" | "methodology" | "intervention" | "outcome" | "limitations"
         | "sample" | "study_type" | "population";
}

export interface Quote { text: string; ref: CitationRef; from: "abstract" | "full_text"; verified: boolean }
export type Cell =
  | { state: "filled"; value: string; quotes: Quote[]; citations: CitationRef[] }
  | { state: "not_found"; note: string }         // "Not reported in the abstract"
  | { state: "failed"; error: string }           // a turn failed; the cell can be re-run
  | { state: "pending" };                        // only while a step runs, or in a stopped step's partial file

export interface ScreenDecision {
  ai: "include" | "exclude" | "unclear";         // derived from criterion cells: any strict "no" excludes
  because: ColumnId[];                           // the criteria that decided it
  user: "include" | "exclude" | null;            // the user's override, kept apart from the AI's call
}

interface ResultBase {
  ref: ResultRef; title: string; created: string;
  madeBy: StepId; from: ResultRef[];              // lineage: what the step read
  change: string;                                 // one line for the version menu: "Added column Limitations"
}
export interface PapersResult extends ResultBase {
  kind: "papers"; query: string | null;
  rows: PaperRow[]; columns: ColumnSpec[];
  cells: Record<RowId, Record<ColumnId, Cell>>;
  screening: Record<RowId, ScreenDecision> | null;
  summary: { markdown: string; citations: Citation[] } | null; // "Summary of top N sources"
}
/** A table whose rows aren't papers (a comparison of models, methods, datasets): the chat builds these. */
export interface TableResult extends ResultBase {
  kind: "table"; columns: ColumnSpec[];
  rows: { id: RowId; label: string; paper: RowId | null }[];
  cells: Record<RowId, Record<ColumnId, Cell>>;
}
/** A pointer: the body stays in reviews/<id>/report.json (spec 002), never copied. */
export interface ReportResult extends ResultBase { kind: "report"; review: ReviewId }
/** Virtual: built at read time from an assistant record; no file. */
export interface AnswerResult extends ResultBase { kind: "answer"; answer: Answer<unknown> }
export type Result = PapersResult | TableResult | ReportResult | AnswerResult;

export interface ResultSummary {
  ref: ResultRef; kind: ResultKind; title: string; versions: number;
  rows: number | null; columns: string[]; updated: string;
}
```

#### 1.2 Steps

```ts
export type StepInput =
  | { kind: "chat"; text: string }                                            // today's chat turn
  | { kind: "ask"; text: string }                                             // Quick answer
  | { kind: "find"; query: string; sources: Sources; scope: Scope }           // the UI searches; the engine stores
  | { kind: "import"; from: `find:${string}` | `review:${string}` | "selection"; label: string }
  | { kind: "columns"; on: ResultRef; add: ColumnSpec[]; rows: RowId[] | "all"; text: "abstract" | "best" }
  | { kind: "narrow"; on: ResultRef; keep: RowId[]; why: string }            // "Kept 18 of 40: has PDF, 2020–2026"
  | { kind: "screen"; on: ResultRef; criteria: Criterion[] }
  | { kind: "chat_papers"; text: string; on: ResultRef; rows: RowId[] | "all" }
  | { kind: "report"; on: ResultRef | null; request: ReviewRequest }         // Research report / Systematic review
  | { kind: "synthesize"; on: ResultRef; question: string };                  // "Write a report from this table"

export interface Criterion { id: ColumnId; text: string; strict: boolean }   // spec 002 U4
export type StepKind = StepInput["kind"];
```

- **`find`, `import`, `narrow`** are made by the UI: Find papers already runs in the host (discover.js in
  Zotero, OpenAlex in Obsidian), and narrowing is a filter the user applied. The UI hands the finished result to
  `sessions.put` and the engine stores it.
- **`columns`, `screen`, `synthesize`, `chat_papers`, `chat`, `ask`, `report`** run in the engine through
  `sessions.run` (or `conversations.send` for chat turns) and stream events.
- A step reads `on` (or the current result when none is given) and writes one result: a new version of the
  same result for `columns` and `screen` (V1 → V2), a new result for `find`, `narrow` (R1 → R2, "from R1 V2"),
  `synthesize` and `report`.

#### 1.3 On disk

```
<dataDir>/chats/<id>.jsonl                   # the session log: existing records + the new ones below
<dataDir>/chats/<id>.d/results/R1/v1.json    # one immutable file per version, written with writeAtomic
<dataDir>/chats/<id>.d/results/R1/v2.json
<dataDir>/chats/<id>.d/steps/S4.partial.jsonl  # cells finished so far by a running columns / screen step
<dataDir>/reviews/<reviewId>/...             # unchanged; a report step points here
```

New JSONL record types (`ConversationRecord` grows; nothing existing changes shape):

```ts
export type SessionRecord =
  | ConversationRecord                                    // meta, rename, user, assistant, failed: unchanged
  | { type: "step"; id: StepId; input: StepInput; reads: ResultRef[]; at: string }
  | { type: "step_end"; id: StepId; status: "done" | "failed" | "cancelled" | "stopped";
      writes: ResultRef[]; line: ActivityLine; error?: AgentError; at: string }
  | { type: "result"; summary: ResultSummary; at: string } // one per version written; the body is in results/
  | { type: "current"; ref: ResultRef; at: string };      // the user chose which result later steps read
// user and assistant records gain an optional `step?: StepId` and `on?: { result: ResultRef; rows: RowId[] | "all" }`.
```

- `conversationStore.list()` already reads only `*.jsonl`, so the `<id>.d` folders are invisible to it. `list()`
  summaries gain `artifacts: number` and `kind: "chat" | "find" | "report" | "systematic"` (the first step's
  kind) for the history icon and the empty-state cards.
- The **manifest** of a session (its steps, results and current result) is rebuilt from the JSONL alone, as
  conversations are today. A result file with no `result` record (crash between the two writes) is ignored; a
  `step` with no `step_end` is shown as stopped and can be resumed (§5.4).
- `adopt` (Zotero standalone → server) takes `{ id, jsonl, files?: { path, text }[] }` and copies the `.d` folder
  with the same keep-the-first rule.

#### 1.4 How existing things map in (read-time; nothing on disk is rewritten)

| Existing | Read as |
| --- | --- |
| A chat (`chats/<id>.jsonl` with meta / user / assistant) | A session whose steps are its turns: each user + assistant pair is a `chat` step writing a virtual `answer` result. No artifacts. Adding any step to it just appends records. |
| A Quick answer conversation (`mode: "ask"`) | Same, with `ask` steps. |
| A saved Find papers search (Zotero `second-brain/searches/find-*.json`; Obsidian finds) | Opens as today in FindView. The first step-making action on it (add a column, chat with these, add step, narrow) creates a session with an `import` step `from: "find:<id>"` and a papers result R1 V1 built from its rows and summary. The history then shows the session and hides the saved search (matched by the import step), so it appears once. |
| A review (`reviews/<id>/`) started before this spec | Opens as today (ReportView). "Add step" on it creates a session with `import from: "review:<id>"`: a `report` pointer result, plus a papers result built from `screened.json` sources. The review folder is only read. |
| A review started from a session | `request.json` gains `session: { id, step }`; the history shows the session, not the review. |

#### 1.5 How the AI refers to results: `read_result`

A new read-only tool row in `tools.js`, enabled when the turn's `ToolContext` carries a session:

```ts
// ToolContext gains:  session?: { id: SessionId; results: ResultSummary[]; on?: { result: ResultRef; rows: RowId[] | "all" } }
read_result({ result: "R2", version?: 3, rows?: string[], columns?: string[], offset?: 0, maxChars?: 12000 })
```

- Returns a compact text rendering: a header line (`R2 "Excited-state ML" V3 · papers · 40 rows · columns:
  Summary, Methodology`) and one line per row: row id, citation label (`[@westermayr2020]` or the DOI link),
  title, year, then `Column: value` pairs. Quotes are included only when `columns` names specific columns, to
  keep it short. Pages with `offset` past `maxChars`.
- `seen` gets every returned row's `ref`, so the citation validator resolves citations to papers in the set,
  including outside papers (by their DOI link) that no search in this turn returned.
- Activity: `{ kind: "result", label: "Referenced “Excited-state ML” V3" }`, which compacts to the line
  **Read context · Referenced “Excited-state ML” V3** (Elicit's "Read context · Referenced variable").
- **The manifest goes into every turn's instructions** (≤ 1,200 characters): the session's results with kind,
  title, version, row count and columns, and which one is current. The instructions say: "When the question is
  about these results, read them with read_result before searching again. Cite papers by the labels it
  returns."
- A `chat_papers` step (§6) narrows the tools to `read_result` and `read_source` (for rows in the set), so answers
  stay inside the set.

#### 1.6 How the chat makes a table (without a writing tool)

"Make a table of all the DeepH models" (Elicit 9.22.15) needs the model to produce data, but tools stay
read-only. The chat instructions allow one fenced block per answer:

````
```sb-table
{ "title": "DeepH and similar models", "columns": ["Family / relation", "Learned object", "Why it matters"],
  "rows": [ { "label": "DeepH", "cells": { "Family / relation": { "value": "…", "cite": ["[@wang2024]"] } } } ] }
```
````

After the turn, `core.js` parses it against `TABLE_SCHEMA`, validates each `cite` like any citation, writes a
`table` result (a new one, or V+1 of the table the user referred to when the model names it with `"revises":
"R3"`), removes the block from the stored answer text and adds a `result` event. A block that fails to parse
stays in the answer as a Markdown table and a notice says "Couldn't turn this into a table". Quotes in chat-made
tables are optional (a cell may carry only citations); extraction-made tables always carry them.

### 2. The research process

#### 2.1 The stages, old and new

A review keeps its folder and stage machine (`review.js`, output file = done, `WAIT` for a human). New reviews
run a second stage table; `request.json` says which (`pipeline: 2`; missing = 1). A review started before this
spec resumes on its own table, unchanged.

| # | Stage (pipeline 2) | Output file | Replaces (pipeline 1) | What it does |
| --- | --- | --- | --- | --- |
| 1 | `clarify` | `clarify.json` | — (new) | Lead decides whether the question is clear. If not, writes `clarify-questions.json` (≤ 2 questions) and returns `WAIT`. Answers write `clarify.json`. |
| 2 | `plan` | `plan.json` | `plan` | Lead writes sub-questions + search strategies; for systematic mode also the protocol (§2.3), criteria and extraction columns. |
| 3 | `approve` | `approved-plan.json` | `approve` | Unchanged `WAIT`, now on the plan or protocol card. |
| 4 | `search` | `candidates.json` | `research` | One researcher per sub-question runs searches and returns **candidate papers** (not claims) with a search log. Per-sub-question files `search/<sq>.json`, as `findings/` today. Merged and de-duplicated with `screen()`'s DOI / citekey / title rules. |
| 5 | `screen` | `screening.json` | `screen` (dedupe only) | Criteria become criterion columns (§2.4); batches of abstracts; decisions per paper; unclear papers are kept. |
| 6 | `extract` | `table.json` | — (new) | The protocol's columns (or the report defaults: Main findings, Methodology, Limitations, plus one column per sub-question) filled for the included papers, with a quote per cell (§5). |
| 7 | `synthesize` | `report.json` | `synthesize` | Writer works **from `table.json` only**: themes, evidence entries that point at the cells they rest on, disagreements, gaps, method with counts. |
| 8 | `publish` | `note.json` | `publish` | Unchanged note; the evidence table and an extraction table appendix are rendered. |

Changes in `review.js`:

- `REVIEW_STAGES` stays as pipeline 1; `REVIEW_STAGES_2` is added; `runReview`, `deriveStatus` and
  `reviewProgress` take the table from `request.pipeline`.
- `ReviewStatus` gains `{ state: "awaiting_answer"; questions: ClarifyQuestion[] }`; `deriveStatus` returns it
  when `clarify-questions.json` exists without `clarify.json` and nothing runs.
- `reviews.answer(id, answers)` writes `clarify.json` and resumes (like `approvePlan`).
- `request.autoApprove` also skips `clarify`: the lead records its own choices as "Assumed: …" lines in the plan.
- `ReviewProgress` gains `lines: ActivityLine[]` (§3.3) and `counts: { candidates; included; excluded;
  extracted } | null`, both derived from the files.
- Spec 002's U3 `Scope` kind `papers` is not needed: "Report on these" starts a review with `on: ResultRef`; the
  `search` stage then starts from those rows (and searches more only if the user ticks "Also search").

#### 2.2 Clarify cards

```ts
export interface ClarifyQuestion {
  id: string; question: string;                    // "Which route should I use for this broad investigation?"
  choices: string[];                               // 2–4, short; shown numbered 1–4
  other: boolean;                                  // an "Other…" line the user can type into
}
export interface ClarifyAnswer { id: string; choice: number | null; other: string | null } // null + null = "You decide"
```

- The lead asks at most 2 questions, and only when an answer changes the plan (route, population, time frame,
  what counts as evidence). `CLARIFY_SCHEMA` caps it; the lead may return none, and then the stage finishes
  with no `WAIT`.
- Card (Elicit 9.21.17): a quiet "Question" header, the question, numbered choices as rows; a number key or a
  click answers. "Other…" is an editable line (spec 005 §4 rule 1). One quiet text button: "You decide".
- Both questions show together; the plan starts when both are answered. An answered card folds to one line:
  "Scope · Formal systematic review".

#### 2.3 Plan and protocol

`Plan` grows optional fields, so old plans parse:

```ts
export interface Plan {
  subQuestions: SubQuestion[];
  protocol?: Protocol;           // systematic mode only
  criteria?: Criterion[];        // both modes; report mode usually 0–2 "Preferred"
  columns?: ColumnSpec[];        // what extract fills; defaults per mode
  assumed?: string[];            // "Assumed: 2015 onward" when clarify was skipped
  caps?: { candidates: number; extract: number };
}
export interface Protocol {      // PICOS; fields that don't apply to the question are null, not invented
  population: string | null; intervention: string | null; comparison: string | null;
  outcomes: string | null; studyDesigns: StudyType[] | null;
}
```

The plan card stays the calm 2026-09-26 card (spec 005 §4): one numbered list of sub-questions; below it, as
plain editable lines, the protocol (five labelled lines, systematic only), the criteria (each with a
Strict / Preferred toggle shown on hover), and "Columns to extract" (chips with × on hover, "Add a column").
One primary button ("Start research" / "Start review"); "Cancel" and "Add a question" stay quiet text buttons.

#### 2.4 Screening is extraction with criteria

Each criterion is a `criterion` column: the extractor answers yes / no / unclear with a quote. The decision is
derived, never asked of the model: any strict criterion answered "no" excludes; otherwise include; unclear
never excludes. The user can override any row (`ScreenDecision.user`); the override is stored beside the AI's
call, and the report's method counts both ("12 excluded by the AI, 2 of them restored by you"). This makes
screening reuse §5's batching, caps, cancel and quote check, and shows in the table as ordinary columns.

#### 2.5 Report mode vs systematic mode

| | Research report | Systematic review |
| --- | --- | --- |
| Clarify | yes (≤ 2) | yes (≤ 2), usually route + population |
| Plan | sub-questions; criteria optional | PICOS protocol, criteria required (≥ 1 strict), columns from outcomes |
| Caps (candidates / extracted), by depth | quick 60 / 20 · standard 150 / 40 · deep 300 / 80 | standard 300 / 80 · deep 600 / 150, confirmed on the protocol card |
| Screening | one pass on abstracts | one pass on abstracts; unclear rows listed for the user before extract |
| Method section | search log + counts | + protocol, criteria, per-criterion exclusion counts, user overrides |

Systematic review asks one extra `WAIT` only when unclear rows exceed 10% of the candidates ("14 papers are
unclear. Include them all / Let me look"). "Let me look" opens the screening table in the side panel.

### 3. Compacted thinking

#### 3.1 Events the engine must emit

```ts
export type ActivityKind = "library" | "read" | "scholarly" | "web" | "mcp" | "thinking" | "result"; // + "result"

export interface ActivityLine {
  id: string;
  icon: ActivityKind | "clarify" | "plan" | "screen" | "extract" | "write";
  title: string;                   // "Ran analysis"
  detail: string | null;           // "Conducted 4 searches"
  state: "running" | "done" | "failed";
  items: string[];                 // the individual labels, shown when expanded
  reasoning: string | null;        // folded grey text, when the provider gave any
}

// text, activity, notice, done and failed are unchanged; these are added:
export type AgentEvent<S = never> = ExistingAgentEvent<S>
  | { type: "reasoning"; delta: string }                     // provider reasoning summary, streamed
  | { type: "line"; line: ActivityLine }                     // an engine-authored step line (pipeline stages, extraction)
  | { type: "result"; summary: ResultSummary }               // an artifact was written: the UI adds a card
  | { type: "cell"; result: ResultId; row: RowId; column: ColumnId; cell: Cell }; // live fill during columns / screen
```

- **Reasoning**: each provider adapter forwards what its wire already carries: Codex app-server reasoning
  summary items, Claude Code thinking blocks, an OpenAI-compatible `reasoning_content` field. A provider that
  sends none emits none, and the line simply has no fold. Reasoning is kept only on the assistant record
  (`reasoning?: string`, capped at 4,000 characters) and never sent back to a model as history.
- **Grouping** is one pure function in agent-src, `compactActivities(events): ActivityLine[]`, used by the
  runtime (to store `lines` on the assistant record) and by the UI (live), so a reopened chat folds the same way
  it streamed. Old records with only `activities: string[]` fold into one line "Used N tools".

#### 3.2 The grouping rules

1. Consecutive activity events with no answer text between them form one group; the reasoning streamed just
   before it belongs to it.
2. Title and detail by content: any searches → **Ran analysis · Conducted N searches** (+ " · read M sources");
   only reads → **Read sources · N papers**; a `read_result` → **Read context · Referenced “title” V2**;
   MCP only → **Used <server>**; nothing but reasoning → **Thought it through**.
3. While running, the detail is the current label ("Searching the literature for 'DeepH'…"), one line only
   (spec 005 §4 rule 2). When it ends, it becomes the summary.
4. Failed tool calls count toward the summary and show a quiet "1 failed" in the detail.
5. Expanded: the reasoning (grey, 11.5 px) and the list of labels. Collapsed by default, always.

#### 3.3 Lines for steps and reviews

Engine-authored steps emit their own lines, derived from files so a reopened review shows the same text:

| Stage / step | Line |
| --- | --- |
| clarify | "Clarified the scope" · the answers, e.g. "Formal systematic review; 2015 onward" |
| plan | "Planned 5 sub-questions" (systematic: "Wrote the protocol · 3 criteria, 6 columns") |
| search | "Ran searches · 14 searches, 212 papers" |
| screen | "Screened 212 papers · kept 48, 9 unclear" |
| extract / columns | "Extracted 4 columns from 48 papers" (running: "Extracting · 20 of 48") |
| synthesize | "Wrote the report from the table" |
| narrow | "Narrowed to 18 papers · has PDF, 2020–2026" |

### 4. Artifacts panel

A shared `ArtifactPanel` in `ui-src`, used by both hosts, opened by a result card in the thread, by the
"Artifacts (N)" button in the header, or by a `result` event while the user watches.

```
┌ history ┐┌ thread ─────────────────────────┐┌ artifact panel ────────────────────────────────┐
│         ││ ✓ Ran analysis · 4 searches   ▸ ││ ▦ DeepH and similar models   V2 ▾  ⤓ ▾  ⤢  × │
│         ││ answer text … (Wang 2024)       ││ [Search…] [Sort ▾] [Filters ▾] [Columns]       │
│         ││ ┌───────────────────────────┐   ││ Model      │ Family       │ Learned object     │
│         ││ │ ▦ DeepH and similar …     │   ││ DeepH      │ Original …   │ DFT Hamiltonian …  │
│         ││ │ Table · 9 rows · V2       │   ││            │ Wang 2024    │ Wang 2024          │
│         ││ └───────────────────────────┘   ││ …                                               │
│         ││ [composer]                      ││                                                 │
└─────────┘└─────────────────────────────────┘└─────────────────────────────────────────────────┘
```

- **Card in the thread**: icon, title, "Table · 9 rows · V2" (papers: "Papers · 40 · 2 columns · V1"), and on
  hover two quiet icons (download, open). A card for an older version says "V1 · a newer version exists".
- **Header**: title (editable text, §4 rule 1), version menu (V1 … Vn with each version's `change` line and
  date; picking an old one shows it read-only with "Restore as V(n+1)"), download menu (CSV, RIS for paper rows,
  Markdown), expand (⤢), close (×). "Artifacts (N)" lists every artifact in the session, newest first, with kind
  icon and version.
- **Toolbar**: Search (matches title, authors, abstract and cell text), Sort (any column, the paper's year or
  citations), Filters (§5.3), Columns (§5.1). Toolbar state is view state: kept per session and result in host
  prefs, never a new version. "Keep these N" turns the current view into a `narrow` step (a new result).
- **Table**: first column sticky (paper: title, authors "+N", venue, year · citations, "In library" / Add,
  Source, DOI links; free table: the row label). Cells are text first: value, then grey citation chips after the
  sentence (quiet 11.5 px, "+N" grouping, spec 005's chip). Clicking a chip opens a small popover with the quote,
  "from abstract" / "from full text", an "Unverified" mark when the quote check failed, and Open (host.openRef).
  Row ticks (hover or once any row is ticked) enable: Chat with these, Add columns to these, Keep these, Add to
  Zotero, Export. Pending cells are skeleton bars (Elicit 9.23.35).
- **Expand (⤢)**: the artifact becomes the main pane and the thread moves into the side panel as "Chat with
  papers" scoped to it (§6). Expand again (or ×) swaps back. This is the same layout Find papers uses.
- **Export** (pure serializers in `ui-src/src/export/`, saved through a new `UiHost.saveFile(name, text,
  mime)`: Zotero opens a save dialog; Obsidian writes into the vault under `Second Brain/Exports/` and opens it):
  - CSV: one column per result column, plus `<Column> quote` columns when "Include quotes" is ticked; paper
    columns (title, authors, year, venue, DOI, in library).
  - RIS: paper rows only (today's Find papers RIS writer, moved).
  - Markdown: a GitHub table with `[@citekey]` / DOI links, quotes as footnotes. Obsidian also offers "Save as
    note" (same Markdown into `ai_notes/`) because a vault is where Obsidian users keep tables.
- **Widths** (spec 005's 560 px narrow layout):
  - ≥ 960 px: thread and panel side by side; the panel starts at 50% and has a drag handle (min 360 px each).
  - 560–959 px: the panel covers the thread, sliding in from the right, with "← Chat" at its top left.
  - < 560 px (Zotero dock, Obsidian side leaf, the phone): the panel opens full-view, and the table becomes a card
    list, one card per row: title line, then each column as a label and value. Filters and Columns open as full
    sheets. `host.can.openInTab` adds "Open in tab" (Zotero dock). Nothing is hidden because the view is narrow;
    only the layout changes.

### 5. Columns and filters on paper sets

#### 5.1 Manage columns

A "Columns" panel (Elicit 9.22.23): "Search or create a column" (plain text line; describe the data, with an
example), then "Current columns" (each with its instruction on hover, reorder by drag, remove ×), then presets
as quiet "+" rows: Summary, Main findings, Methodology, Intervention, Outcome measured, Limitations, Sample,
Study type, Population. A new free-text column gets an `instruction` from the text as typed; nothing is
rewritten by a model first.

#### 5.2 Extraction engine (`agent-src/src/extract.js`)

- One structured turn fills **all new columns for a batch of papers** with `EXTRACT_SCHEMA`
  (`{ rows: [{ row, cells: { <column>: { value | not_found, quotes: string[] } } }] }`).
- **Text given to the model** is supplied by our code, not fetched by tools, so extraction turns run with **no
  tools** (tool budget 0; nothing to wander into):
  - `text: "abstract"` (default for chat steps): the abstract; batches of 8 papers per turn.
  - `text: "best"` (default in reviews for included papers): the full text via `library.read` for papers in
    Zotero (up to 20,000 characters, sections nearest the column instructions first), else the abstract; one
    paper per turn.
- **Quote check**: each quote must appear in the supplied text after whitespace and case folding; a quote that
  doesn't gets `verified: false` and the chip shows "Unverified". A cell with no verified quote is shown with a
  dashed underline. The check is a pure function with tests.
- **New role `extract`** in settings (per-role model like the others; unset = the researcher's choice), wall
  clock 3 min per batch turn. Screening uses the same role.
- **Caps** (settings `research` block, defaults): a chat-driven columns step over more than 50 rows or 200 cells
  asks first in one line with the cost ("Fill 3 columns for 120 papers? About 15 turns.") with Continue /
  Only the first 50; hard cap 400 rows per step. Batches run through the existing slot pool, so at most the pool's
  size run at once (default 3; never above the Mac's 6-process limit).
- **Cancel and resume**: the step line has a Stop control while running. Every finished batch appends its cells
  to `steps/<S>.partial.jsonl` and streams `cell` events; Stop or a crash writes the version with what is done
  (unfinished cells `pending`) and `step_end status: "stopped"`; "Fill the rest" re-runs only pending and failed
  cells as a new version.
- Only cells change between versions; rows, other columns and screening carry over unchanged.

#### 5.3 Filters

A Filters popover (Elicit 9.22.31) with Cancel / Apply; each filter is shown only when the rows carry the data
it needs (hidden, not greyed, spec 005 §2):

| Filter | Data | Where it comes from |
| --- | --- | --- |
| Has PDF / full text | `fullText`, `pdfUrl` | Zotero attachment with full text; OpenAlex `best_oa_location.pdf_url`; S2 `openAccessPdf` (all already fetched) |
| Publication date | `year` | every source (year range; months aren't reliable) |
| Study type | `studyType` | OpenAlex `type` ("review"), S2 `publicationTypes` and Europe PMC `pubTypeList` (both to be requested; discover.js drops them today). Rows still unknown can be classified by adding the Study type preset column. |
| Journal quality | none today | Hidden. No source we call gives quartiles (open question 3). |
| Abstract contains / does not contain | `abstract` | local, case-insensitive, several words each |
| In library / outside | `inLibrary` | ours |
| Screening | `screening` | Included / Excluded / Unclear, when the set was screened |
| Column value | a column | "contains" on any filled column |

Filters are view state (§4). "Keep these N" makes a `narrow` step whose `why` lists the filters.

### 6. Chat with papers

- A side-panel tab next to Columns whenever a paper set is the main pane (Find papers results, an expanded
  artifact): "Chat with papers" with its own composer, "Ask anything about these papers" (Elicit 9.23.41).
- Scope line under its composer: "These 18 papers" (the ticked rows, else the visible rows after filters), with
  a quiet "All 40" toggle. The scope is recorded on the user record (`on: { result, rows }`), so a reopened
  answer knows what it was about even after the view changed.
- Engine: `conversations.send` with `on` set. Tools: `read_result` (that result only) and `read_source` (rows in
  the set that are in the library); search tools off. Instructions: answer only from these papers; say which
  papers don't address the question. The first turn gets the set's titles and years inline so a short question
  needs no tool call.
- Answers are ordinary chat steps in the same session: they show in the thread too (the side panel is a view
  of the same turns filtered to `on` = this result), cite papers with grey chips, and can be followed by "Make a
  table from this" (§1.6).
- In the < 560 px layout, the set and its chat are two tabs at the top: "Papers | Chat".

### 7. Menu, steps and the empty state

- **Mode menu grouped** (Elicit 9.23.01), under the message box where it is now:
  - Workflows: **Chat** (the research agent: searches, reads, builds tables), **Research report**,
    **Systematic review**.
  - Tools: **Find papers**, **Chat with papers**, **Extract data**, **Quick answer**.
  - Chat with papers and Extract data need a paper set: with none in the session they start by picking one
    ("Selected papers", a collection or tag where `host.can.scopes`, or a saved search), which makes an
    `import from: "selection"` step.
- **Add step**: a quiet "+ Add step" button after the last step's result (not a floating pill). Its menu offers
  only steps that fit the current result: on a paper set: Add columns, Screen with criteria, Keep filtered rows,
  Chat with these, Find more like these, Write a report from this; on a table: Chat about this table, Write a
  report from this; on a report: Chat about this report. Picking one sets the composer's mode and its `on`.
- **Current result**: shown as a small chip in the composer ("On: Excited-state ML V2 ×"); removing it makes the
  next step start fresh; any artifact's "Use for next step" sets it (a `current` record).
- **Empty state** (spec 002's centred composer): up to three suggestion cards; the first ones are recent sessions
  (title, kind icon, "Research report · 4 days ago", artifact count), then suggestions from the current context
  (the paper being read, the active note). Cards are one click to reopen.
- **History** keeps one list; an item's icon is its first step's kind; a session with artifacts shows a small
  count; a running step shows a quiet dot, as reports do today.

### 8. Constraints this design respects

- **Local-first**: sessions, results and exports live in the runtime's data dir (server: `data/agent/chats`;
  Zotero standalone: `<Zotero data>/second-brain/chats`), adopted on switch like chats. Outside calls are the
  ones we already make (scholarly APIs, the chosen provider).
- **Providers and budgets**: every model call goes through `TurnRunner` with the role's `ModelChoice`, wall
  clock and tool budget from `settings.js`. New: role `extract`, and a `research` block in `Settings`:
  `{ extractBatch: 8, fullTextChars: 20000, confirmAboveRows: 50, confirmAboveCells: 200, maxRowsPerStep: 400 }`.
  Codex rate-limit and Claude cost notices show on the step line as they do in chat.
- **Parity through ui-src**: ArtifactPanel, ColumnsPanel, FiltersPopover, ChatWithPapers, ClarifyCard,
  ActivityLine, AddStepMenu and the exporters are shared components; hosts add only `saveFile` and, for Obsidian,
  the "Save as note" target. The C4 drift test covers the new class trees.
- **Public repo**: the engine, `ui-src` and harness fixtures contain no personal data; fixtures are invented
  papers ("Doe 2021, *A study of widgets*"). The user's sessions never enter the repo.
- **Spec 005 §4**: text first, controls on hover / focus, one primary button per card, one line of status per
  step, spec 003's type scale and one icon per feature (new icons: table, papers, columns, filter, step,
  question, versions, export).

## Success checks

1. A session can run find papers → add 2 columns → keep filtered rows → chat with these → write a report from
   the table, with no text copied between steps; the history shows it as one item with 4 artifacts.
2. On disk that session is one JSONL plus `results/R*/v*.json`; deleting the `.d` folder leaves a readable chat
   that says its artifacts are missing, and nothing else breaks.
3. Adding a column to R1 V1 writes R1 V2; V1 still opens read-only, and "Restore as V3" works.
4. Every chat, Quick answer, saved Find papers search and review made before this spec opens and behaves as
   before (including a review paused at plan approval, which resumes on pipeline 1); opening them changes no
   old file (checked by comparing hashes before and after in the harness).
5. A follow-up question about papers in the session runs `read_result`, not `search_*`, and the thread shows
   "Read context · Referenced “…” V2" (checked with a scripted provider in the harness and once with Codex).
6. Citations in a chat-with-papers answer resolve for outside papers in the set (DOI links) and for library
   papers, and none point outside the set.
7. "Make a table of …" in chat produces a table artifact with citations per cell; a malformed block falls back to
   a Markdown table plus the notice.
8. Each extracted cell has a quote; the quote check marks a planted wrong quote "Unverified" (unit test), and in
   a live run at least 90% of cells in a 20-paper, 3-column step have verified quotes.
9. A 60-row, 3-column step asks first with a turn estimate; Stop after the first batches keeps their cells and
   "Fill the rest" completes only the missing ones.
10. Filters: Has PDF, dates, study type, abstract contains / excludes and In library each narrow the visible
    rows correctly on a fixture set; a filter whose data no row has is not shown.
11. A research report asks at most 2 clarify cards (none for a precise question), waits for them like the plan
    card, and survives a restart while waiting.
12. A pipeline-2 report's evidence entries link to cells; clicking a claim shows the quotes it rests on. Its
    method section states candidates found, excluded per criterion, and papers extracted, and those numbers
    match the files.
13. A systematic review shows a PICOS protocol card with criteria and columns, screens with strict criteria,
    keeps unclear papers, and stores user overrides apart from the AI's calls.
14. Activity is one line per step everywhere (chat, find, columns, reports); expanding shows the labels and, for
    Codex and Claude, the reasoning; reopening a chat folds the same way it streamed.
15. Artifacts panel: search, sort, filters, versions, CSV / RIS / Markdown export and expand work in both hosts;
    at 360 px it becomes a card list with no horizontal scroll (measured, not eyeballed).
16. The mode menu shows Workflows and Tools groups; the empty state shows recent sessions as cards; "+ Add step"
    offers only steps that fit the current result.
17. The shared harness renders every new component in both token maps, light and dark, with identical class
    trees; all existing Zotero harness tests and agent-src / ui-src tests pass after every unit.
18. After every plan unit both apps build, install and open a session.

## Decisions (user, 2026-09-26)

1. Mode names: keep "Chat"; Quick answer stays (under Tools). Menu: Workflows (Chat, Research report, Systematic
   review) / Tools (Find papers, Chat with papers, Extract data, Quick answer).
2. Extraction reads abstracts in chat-driven columns and full text in research reports (Zotero papers with text).
3. Journal quality filter: left out for now.
4. Order: 005 A–C → 006 auto-update → 007 E1–E8 → 005 D units.

Status: approved for building.
