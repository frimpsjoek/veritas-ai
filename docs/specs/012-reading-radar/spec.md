# Spec: Reading radar (papers you should read, new and old)

Status: APPROVED 2026-10-11 (D1-D5 yes; name "Reading radar"; each digest also writes a vault note; sites without
RSS skipped in v1; Hugging Face papers is the first MCP source; 8 new + 1 older per daily run, 15 + 5 weekly).
Drafted 2026-10-10, written from the user's request: "a feature that checks RSS feeds, user-entered journals,
papers, relevant sites, databases and MCPs like arXiv, chemRxiv and bioRxiv, and using a routine gives you the
necessary papers in your field, new and old, and what you might want to read."
Builds on spec 011 U4 (routines, `N new` badges, `since`), U5 (projects), `scholarly.js` (7 sources), `mcp-hub.js`
and the KB's local embeddings. Nothing here is built until the user approves this spec and its plan.

## The problem

Keeping up with a field today means checking several places by hand: arXiv listings, journal tables of contents,
bioRxiv/chemRxiv, a few lab pages, alerts in email. Second Brain can already search these sources when asked, and a
routine can repeat a search every week. But a routine only re-runs one prompt. It does not know:

- what the user's field is (their library already says it: collections, keywords, authors, venues);
- which journals, feeds, sites and authors the user trusts;
- which papers the user has already seen or rejected;
- which older papers the field rests on that the user has never read.

So the weekly report is a search result, not a reading list.

## Goals

1. **One reading list per run** with two parts: *New* (published since the last run) and *Worth reading* (older
   papers the user's field leans on that are not in their library).
2. **Sources the user picks**, all in one place:
   - built-in databases: arXiv, bioRxiv/medRxiv, chemRxiv, OpenAlex, Crossref, Semantic Scholar, Europe PMC;
   - RSS/Atom feeds the user pastes (journal TOCs, arXiv category feeds, lab blogs);
   - journals typed by name or ISSN (watched for new issues);
   - authors to follow;
   - connected MCP servers that offer a paper search tool.
3. **A field profile built from the library**, shown to the user in plain words and editable ("Topics: perovskite
   solar cells, DFT, defect chemistry; Authors: …; Journals: …").
4. **Ranking without model tokens.** Fetching, deduping and scoring run on the local embeddings. A model writes only
   the one-line "why read this" for the top items.
5. **It learns from use.** Add to Zotero, Read later and Not relevant change what the next run ranks first.
6. **Runs as a routine** (spec 011 U4): same scheduler, same `N new` badge, can belong to a project.
7. **Daily by default, how often is the user's choice**: daily, weekdays only, chosen days of the week, every N days,
   or weekly, at a time the user picks. Every run looks back to the previous run, so nothing is missed when the Mac
   was off.

## Non-goals

- Full-text access to paywalled papers. The list links out. It never downloads behind logins.
- Watching arbitrary web pages for changes in v1. A site without a feed is offered as a feed search, or skipped
  with a note (see Open questions).
- Email or Telegram delivery in v1 (routine `notify` stays reserved, D5 in u4-design).
- A social or shared feed.
- Replacing Find papers or reports. Those answer a question. The radar answers "what should I read today".

## Words used here

- **Radar**: one routine of kind `radar` with a profile and a source list.
- **Profile**: topics, authors and journals, each with a weight. Seeded from the library, edited by the user.
- **Source**: one place to fetch from (database query, feed URL, journal, author, MCP tool).
- **Digest**: the result of one run: a conversation with a *New* table and a *Worth reading* table.
- **Seen set**: every paper id already shown, added, or dismissed for this radar. Nothing is shown twice.

## The design

### 1. Profile

- Seed: when a radar is created, build a draft profile from the chosen scope (whole library, a collection, or a
  project): top terms from titles/abstracts, frequent authors, frequent venues, plus the centroid of the scope's
  paper embeddings. No model call is needed. A model may turn the terms into 3-8 readable topic lines if the user
  asks ("Tidy with AI").
- The user sees and edits it as three short lists (Topics, Authors, Journals) with remove and add. Topic lines become
  search queries. Authors and journals resolve to OpenAlex ids when found, and are shown with the match so the user
  can confirm the right person (same rule as LexImmigration's author check).

### 2. Sources

| Kind | How it fetches | `since` | Notes |
|---|---|---|---|
| Database | `searchScholarly(query, {sources, since})`, one query per topic line | yes (exists) | arXiv, bioRxiv/medRxiv, chemRxiv, OpenAlex, Crossref, S2, Europe PMC |
| Feed (RSS/Atom) | HTTP GET with ETag/Last-Modified, parse items | item date | DOI/arXiv id pulled from link or body; title-only items are matched in OpenAlex |
| Journal | OpenAlex `primary_location.source.id` + `from_publication_date` | yes | its TOC feed is found automatically when the publisher has one |
| Author | OpenAlex `authorships.author.id` + date filter | yes | |
| MCP tool | a connected server's search tool through `mcp-hub.js`, called with each topic query | if the tool takes one | only tools the user ticks; results go through the same normaliser |

Every source has a status line (last fetched, items, last error). A failing source never fails the run. The digest
says which sources failed.

Politeness: OpenAlex `mailto`, one request at a time per host, feed responses cached by ETag, at most N requests per
run (default 120).

### 3. One run

1. `since` = last run (existing `planSince`).
2. Fetch all sources in parallel through the existing slot pool. Normalise each item to
   `{doi, arxivId, title, authors, venue, date, abstract, url, source}`. Missing abstracts are filled through
   `abstractsByDoi` (exists).
3. Merge duplicates: DOI, arXiv id, then normalised title. A preprint and its journal version become one row that
   shows both links.
4. Drop anything in the library (DOI/citekey/title, same as `newRows`) or in the seen set.
5. Score: cosine to the profile centroid, plus bonuses for a followed author, a watched journal and a match to a
   topic line, minus a penalty for closeness to dismissed papers. Weights live in one place and are logged per row so
   "why is this here" can be answered.
6. **New**: the top 8 for a daily radar, 15 for weekly (the user can change it). **Worth reading**: see section 4.
   A run that finds nothing new above the score floor writes no digest and sets no badge, so quiet days stay quiet.
7. A model writes one line per top row: why it matters to *this* profile, from the abstract only. Rows without an
   abstract say so and get no line.
8. Write the digest conversation, set the `N new` badge, store the seen set.

### 4. Worth reading (older papers)

Older papers come from the citation graph. No model is involved:

- papers cited by at least 3 papers in the scope, not in the library (OpenAlex `referenced_works`);
- papers cited by several of this run's *New* rows;
- reviews in the profile's topics with high citation counts.

Rank by how many library papers cite it, then by closeness to the profile. Show 1 per daily run (5 per weekly run) and never repeat one. Each
row says why: "Cited by 7 papers in your library, including …".

### 5. How often (custom schedules for every routine)

This applies to **all routines**, not only the radar: the routine `Schedule` type (u4-design section 1), which today
has only `daily` and `weekly` with one time, becomes:

```js
/** @typedef {{
 *   days: { kind:'daily' }
 *       | { kind:'weekdays' }                                 // Mon-Fri
 *       | { kind:'some', weekdays: (0|1|2|3|4|5|6)[] }        // e.g. Mon, Wed, Fri
 *       | { kind:'every', n: number, from: string }           // every N days (2-30) from a YYYY-MM-DD date
 *       | { kind:'monthly', day: number },                    // day 1-28, or -1 = last day of the month
 *   times: { kind:'at', times: string[] }                     // 1-6 "HH:MM" local times, e.g. ["07:00", "18:30"]
 *        | { kind:'hourly', every: number, from: string, to: string } // every N hours (1-12) inside a window
 * }} Schedule */
```

Examples the user can set: daily at 07:00; weekdays at 07:00 and 18:30; Mon/Wed/Fri at 09:15; every 3 days at
06:00; every 4 hours from 08:00 to 20:00 on weekdays; the 1st of each month at 10:00.

- Old routines keep working: `{kind:'daily', time}` reads as `{days:{kind:'daily'}, times:{kind:'at', times:[time]}}`,
  and `weekly` reads as `some` with one weekday. Records are migrated on first load. No user action is needed.
- **UI:** one "When" row in the routine sheet: a Days picker (Every day / Weekdays / Pick days / Every N days /
  Monthly), then the times as chips with "+ Add time", or "Every N hours between … and …". Under it, a plain preview:
  "Next: today 18:30, then Mon 07:00". No cron syntax is shown.
- Floor: no routine runs more often than once an hour. A radar shows the expected requests per day next to the
  schedule, so a heavy setting is visible before saving.
- Default for a new radar: **daily at 07:00**. Other routines keep their current default.
- A change follows the existing rule D7: the next run counts from now.
- Missed runs (Mac asleep, server down) collapse into one catch-up run when it is back, covering the whole gap. The
  user never gets a pile of digests.
- Frequent runs keep the cost low: feeds use ETag caching, and a source that returned nothing new 7 runs in a row is
  checked every other run (shown on its status line).
- `nextRun` / `dueSlot` learn the new shape. Tests cover each kind, several times in one day, the hourly window edges,
  months shorter than the chosen day, and the DST dates already in the U4 tests.

### 6. Digest UI

- Opens like any routine result: a conversation with two tables (*New*, *Worth reading*) using the existing table
  artifact, so columns, filters, chat with papers and export already work.
- Row actions: **Add to Zotero** (goes to the radar's collection), **Read later** (a Zotero tag), **Not relevant**.
  One click each, undo for 5 s.
- Top of the digest: one line, e.g. "14 new from 6 sources · 5 worth reading · chemRxiv failed (timeout)".
- Radar setup is one sheet: Name, Scope, Profile (three lists), Sources (checkboxes + "Add a feed or journal" box
  that accepts a URL, a journal name or an ISSN), Schedule, Size. Advanced options go behind the ellipsis menu.

### 7. Learning

- Add / Read later: the paper's embedding pulls the centroid toward it; its authors and venue gain weight.
- Not relevant: stored as a negative example (penalty in step 5). Three dismissals from one source in a row raise a
  quiet suggestion to remove that source.
- The profile view shows changes the radar made itself, each with an undo.

## Success checks

1. A radar created from the user's real library shows a profile the user accepts with no more than 3 edits.
2. A real daily run over 6+ sources completes in under 3 minutes on this Mac, and fetching and scoring use 0 model
   tokens (only step 7 calls a model, at most 20 short lines).
3. 0 rows that are already in the library, 0 rows shown in an earlier digest, and an arXiv preprint and its journal
   version appear as one row (fixture test with known pairs).
4. A pasted journal TOC feed, an arXiv category feed and a chemRxiv query each produce rows. A broken feed URL shows
   an error on its source line, and the run still finishes.
5. The user rates the top 10 *New* rows of the first two real runs: at least 7 of 10 relevant.
6. Every *Worth reading* row is not in the library and its stated citation count can be checked in OpenAlex.
7. After 10 "Not relevant" clicks on one topic, the next run ranks fewer rows from that topic in the top 10
   (fixture test).
8. A routine set to weekdays at 07:00 and 18:30 runs at exactly those slots over a simulated week, an old
   daily/weekly routine still runs after migration, and the When row's preview matches `nextRun`.
9. The real-Zotero harness test `t-radar.js` passes, and the Obsidian view loads the digest.

## Release slices (for the plan)

0. Custom schedules for all routines (section 5): engine schedule math + migration + the When row. Ships on its own.
1. Engine: source kinds (feed, journal, author, MCP), normaliser, merge, seen set, scoring. Fixture tests.
2. Profile seed from library + editor UI + radar setup sheet.
3. Worth reading from the citation graph.
4. Digest view with row actions + learning.
5. Real run with the user, tune weights, publish.

## Decisions (proposed, need the user's yes)

- D1. The radar is a routine kind, not a new tab. It reuses scheduler, badge, projects.
- D2. Scoring is local (embeddings + rules). Models only write the "why" lines.
- D3. *Worth reading* uses citation counts from the user's own library, not global popularity alone.
- D4. Dismissed papers are never shown again for that radar, even when they gain citations.
- D5. Custom schedules (section 5) come to every routine, shipped first as their own slice; a new radar defaults to daily at 07:00.

## Open questions

1. Name in the UI: "Reading radar", "What to read", or "Paper feed"?
2. Should each digest also write an Obsidian note (`Second Brain/Digests/YYYY-MM-DD.md`) so it shows up in the vault?
3. Sites without RSS (lab pages): skip in v1, or check the page for new PDF/DOI links weekly?
4. Which MCP servers do you want as sources first? (Hugging Face papers is connected; others?)
5. Default size: 8 new + 1 older per day (15 + 5 for weekly), or different?
