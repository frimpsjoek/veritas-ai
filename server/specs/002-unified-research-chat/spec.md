# Spec: One research chat (Elicit-style)

Status: APPROVED 2026-09-26 (all three). U1 in progress.

## Objective

Everything the Second Brain AI does happens in one chat window. The user picks what kind of work they want
from a mode menu under the message box, the way they would pick a model, instead of moving between tabs.
Today Chat and Ask sit in a header switch, and "Review" opens a separate Literature Review tab with its own
form, history and progress screen. The finished review never shows in the app, only a link to a note file.

Elicit (elicit.com) does this work well but costs about $49/month for systematic review and bulk extraction.
This spec borrows the parts of its layout that make the information easy to read and keeps everything local.

## What we learned from Elicit (research 2026-09-26)

Sources: support.elicit.com articles 14757543, 14759154, 1418881; elicit.com/blog introducing-elicit-reports,
systematic-review, introducing-strict-screening-and-80-paper-reports, systematic-review-for-prisma-2020.

1. **Every claim traces to a quote.** Clicking a report claim or table cell shows the exact sentence it came
   from. This is the pattern Elicit repeats most, and it matters more than any other.
2. **Papers show as a table, one row per paper.** Title and a short summary to start. The user adds columns
   in plain words ("Sample size", "Method", "Main finding"), and the AI fills each cell from the paper.
3. **A short summary of the top papers sits above the table** and is rewritten when papers are removed.
4. **Reports are staged: plan → gather → screen → extract → write.** Each stage is visible and can be
   resumed. Reports carry a method section, an evidence table and references.
5. **Screening criteria are plain sentences the user can edit.** A strict criterion excludes a paper that
   fails it; unclear cases are kept, never dropped silently. The AI's call and the user's override are
   stored separately.
6. **The selected papers are the chat's context,** and they are shown as a visible list.
7. **One container per project.** Search results, table, chat and review for one question live on one page.
8. **Exports match where the output goes next:** report → Word/PDF, table → CSV, references → RIS/BibTeX.

What we do not copy: Elicit splits these into six separate tools on its home page. The user wants the
opposite, so here they are modes of one chat.

## The design

```
┌─ history ───────┐┌──────────────────────────────────────────────────────────┐
│ + New           ││                                                          │
│ 💬 GLP-1 and…   ││   (thread: messages, paper tables, plan cards,           │
│ 📋 Perovskite…  ││    progress steps and finished reports, all inline)      │
│ 🔎 MOF CO2…     ││                                                          │
│                 ││ ┌──────────────────────────────────────────────────────┐ │
│                 ││ │ [Hou 2024 ×] [Kim 2023 ×]                            │ │
│                 ││ │ Ask about your library…                              │ │
│                 ││ ├──────────────────────────────────────────────────────┤ │
│                 ││ │ [Chat ▾] [Library · Scholarly · Web ▾] [Whole library▾]│
│                 ││ │                        [+ Selected papers]    [Send] │ │
│                 ││ └──────────────────────────────────────────────────────┘ │
└─────────────────┘└──────────────────────────────────────────────────────────┘
```

**Mode menu** (bottom-left of the box; remembers the last choice):

| Mode | What you get in the thread |
| --- | --- |
| **Chat** | A conversation that remembers, with clickable citations. Unchanged. |
| **Quick answer** | Today's Ask: one grounded answer, or "Not in your library". |
| **Find papers** | A paper table: your library and outside sources merged, marked "In library" or "Add". Summary of the top papers above it. |
| **Research report** | Today's literature review, in the thread: plan card → progress steps → the full report. |

**Options next to the mode:** where to search (Library / Scholarly / Web), the scope (whole library,
collection, tag, saved search), and, for Research report only, years and depth (Quick / Standard / Deep).
Options a mode doesn't use are hidden, not greyed out.

**Paper table (Find papers):**
- Columns: Paper (title, authors, year, venue) and Summary (from the abstract). "+ Column" asks for a
  column name and fills each cell from the paper, with the supporting quote on hover.
- Tick rows, then: **Chat about these** (they become chips in the box), **Report on these** (starts a
  Research report limited to them), **Add to Zotero**, **Export** (CSV, RIS).
- The summary above the table cites papers in the table and is redone when rows are removed.

**Research report in the thread:**
- **Plan card:** sub-questions as editable lines, plus screening criteria as editable sentences, each
  marked Strict or Preferred. Buttons: Approve, Add a sub-question, Cancel.
- **Progress:** one line per stage (Plan, Research, Screen, Write, Save) with ✓ / running / waiting, and
  per sub-question status under Research. Stop and Resume work as now.
- **Finished report** shows in full: themes, an evidence table (claim, papers, strength), disagreements,
  gaps, references. Clicking a claim shows its supporting quotes. Export (Word, PDF, Markdown) and
  "Show the note" sit under it. Papers found outside the library are listed with Add to Zotero.

**History:** one list for chats, paper searches and reports, each with a small icon and a status for
reports that are running or waiting for approval. The separate Literature Review tab goes away; the
Tools menu item opens the chat in Research report mode.

## Success checks

1. One tab. Each of the four modes can be started from the same message box, and the Literature Review
   tab no longer opens from anywhere.
2. A Research report started in the chat shows its plan card, lets the user edit and approve it, shows
   progress, and renders the finished report in the thread with an evidence table and working citations.
3. Closing and reopening Zotero while a report runs: the history shows it, and opening it resumes the view.
4. Find papers returns a table that merges library and outside results with no duplicates, and "Chat
   about these" puts the ticked papers into the box as chips.
5. An added column fills every row, and each filled cell shows its supporting quote.
6. Every citation in a report or answer is clickable and resolves, or is marked red (as today).
7. Existing chats and reviews still open after the change.

## Out of scope for now

Full-text screening across hundreds of PDFs, PRISMA diagrams, team sharing, the Obsidian plugin's UI (it
keeps working against the same AgentService and can adopt this later).
