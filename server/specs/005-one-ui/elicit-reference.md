# Design reference: Elicit (screenshots from the user, 2026-09-26 21:21–21:23)

Source images: `/Volumes/Content/Screen-grabs/CleanShot 2026-09-26 at 9.21.17 PM.webp` … `9.23.41 PM.webp`
(11 files). The user supplied these as the look and behaviour to follow; Elicit is the reference app for spec 005.
They had just hit Elicit's monthly limit, which is why this project exists.

## Patterns, and where each lands in our UI

| # | Elicit pattern | Screens | Ours today | Where it lands |
|---|---|---|---|---|
| 1 | **Clarifying-question card** before a long job: "Question" header, one question, numbered choices; the agent asks, the user taps | 9.21.17 | Report goes straight to a plan | Research report: before the plan, the lead may ask ≤2 question cards (engine: a `clarify` stage that can WAIT like approve) |
| 2 | **Activity lines**: one quiet line per step with an icon, e.g. "Ran analysis · Conducted 4 searches", "Read context · Referenced variable", "Asking a clarifying question"; collapsible reasoning text in grey | 9.21.17, 9.21.32 | Activity chips while streaming | Chat + reports: collapse tool activity into one line per step, expandable |
| 3 | **Prose answers with grey citation chips** after the sentence ("Kulik et al. 2022", "Brockherde et al. 2016 +1") | 9.21.32 | Citation chips exist | Keep; match the quiet grey chip and "+N" grouping |
| 4 | **Artifacts**: a table the chat builds shows as a card in the thread (thumbnail, "Table · 5 rows · V1"); opens in a right panel with Search, Sort, Filters, download, expand, close; versions V1/V2 when revised; "Artifacts (N)" list top right | 9.21.56, 9.22.03, 9.22.15 | None | New: `artifact` answer kind (table rows + citations per cell), side panel shared by both hosts |
| 5 | **Find papers results**: "Summary of top N sources" with linked citations; table: Paper (title, authors, journal, year · citations, Source, DOI, full text / abstract only) + Abstract summary; Sort, Filters, Export; checkboxes | 9.22.23, 9.23.41 | Find papers table + summary | Match row layout and summary block |
| 6 | **Manage columns**: "Search or create a column" (free text, example extractions) + presets Summary, Main findings, Methodology, Intervention, Outcome measured, Limitations; cells fill per paper with quotes | 9.22.23, 9.22.31 | Planned as U3 (spec 002) | Find papers + artifacts |
| 7 | **Filters popover**: Has PDF, publication date range, journal quality, study type (Review, Meta-analysis, Systematic review, RCT, Longitudinal), abstract contains / does not contain; Cancel/Apply | 9.22.31 | Years only (report) | Find papers filters |
| 8 | **Chat with papers** panel beside the results table ("Ask anything about the results"; answer card with citations) | 9.23.35, 9.23.41 | "Chat about these" sends ticked papers to the chat | Right panel next to Find papers results |
| 9 | **New page**: one centred composer; tool menu grouped Workflows (Research agent, Report, Systematic review) / Tools (Find papers, Chat with papers, Extract data); Source picker; suggestion cards incl. recent sessions | 9.22.54, 9.23.01 | Mode menu + suggestion pills | Group our modes the same way; recent sessions as suggestion cards in the empty state |
| 10 | **Skeleton loading** rows while results load | 9.23.35 | Spinner/text | Skeleton rows |
| 11 | **Overall look**: light calm surfaces, grey metadata, one accent colour, generous line height, sidebar Recents list with one-line titles | all | Spec 003 look | Tokens in spec 005 §tokens; accent from host |

## Not copying

Upgrade banners, multiplayer promo, Clinical trials source, "Save to library" as a paid step (ours is Add to Zotero).

## User priorities (2026-09-26, after C units)

All four, plus the ideas underneath them:

- **Modular work.** Elicit's "Add new step" turns a session into a stack of steps. Each step's output is data (a paper
  set or a table) that the next step works on: find papers → add columns → chat with these → narrow down → report.
  Ours should work the same way. A step holds a typed result (`papers`, `table`, `report`); every tool reads the
  current result and writes a new one, so tables and paper sets become the shared currency, not chat text.
- **How the research is done.** Scope first (clarifying cards, a PICOS-style protocol for systematic work), then
  searches, screening, extraction into a table, then synthesis from the table. The report is written from the
  extracted data, not from free-form notes.
- **Thinking compacted.** Planning, reasoning and tool calls collapse to one line per step ("Clarified the scope…",
  "Ran analysis · Conducted 4 searches") and expand on click. The thread shows the answer, the question cards and
  the artifacts; everything else is folded.
- **Data handled as data.** Tables are artifacts with versions (V1, V2), per-cell citations, search/sort/filter,
  export. Later steps reference them ("Read context · Referenced variable") instead of re-searching.

Proposed plan units, after C4 and before the D units (order to confirm):
E1 activity lines + folded reasoning · E2 artifacts (table result kind, side panel, versions) · E3 steps model
(session = stack of typed results; "Add new step") · E4 columns + filters on paper sets · E5 chat with papers
panel · E6 clarify cards + protocol before a report, report written from the extracted table.
