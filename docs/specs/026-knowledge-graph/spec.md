# Spec 026: knowledge graph (reduced: a privacy fix, an extraction table and citation tools first; a graph store only if the evidence earns it)

Status: DRAFT 2026-11-04. Decision: Pending. Written from three review memos (data architecture, extraction and
evaluation, skeptic) that disagreed on scope; this draft resolves the disagreement in writing and leaves the
decisions D1-D14 to Joseph. A fourth reviewer's findings (installed code, a third index, chat history, a check that could not fail) are applied. No code was changed for this draft.
Phase 0 (TG0) was implemented on branch `ai/026-text-guard-effect` on 2026-11-04 (plan.md, TG0 evidence); the
"Where we are" facts below are updated to that branch and marked where they changed. Nothing is accepted.
A third, independent review (2026-11-11) found that the keyword index could keep rejected text, that the rule had
weak accepts and called non-Latin texts empty, and that the live check could pass having checked nothing; the
fixes are guard version 4, R23-R27 and decisions D12-D14 below.

**Summary.** Three reviewers looked at whether Veritas should get a knowledge graph. One wrote a graph schema, one
an extraction and evaluation method, one said "shrink". Live tests showed that of ten real research questions, three
are answered by today's search, four by a table of values pulled from papers, one by a single lookup, and only two
by graph edges (and one of those two has almost no data behind it). The name "knowledge graph" stays for
traceability, but the scope shrinks to four gated phases: (0) make the private-text guard actually take effect in
the installed apps, every served index and chat history, since the code change alone removes nothing; (1) cheap experiments with fixed pass and kill numbers
that decide whether any graph is worth building; (2) the smallest useful tools: a saved re-runnable extraction
table, a citation lookup and a citekey resolver; (3) a persistent graph store, only if phase 1's evidence
justifies it. Neo4j, link prediction, hypothesis suggestion and a visual graph are left out. Joseph's labelling time
(about 9 h for phases 0-2, a further 12.5 h if phase 3 is reached) is the scarce resource; the numbers below are
sized to it.

## Where we are

Checked in code 2026-11-04. Lines marked (branch) are from `ai/026-text-guard-effect` at its last TG0 commit; the
rest are from `dev` as reviewed, where `server/zotero.py` carried an uncommitted guard (now that branch's first commit).

- **The guard exists but did not take effect (fixed on the branch).** On `dev`, `text_belongs_to_item` filtered an
  attachment's cached text at document build and in `item_detail`, with 8 unit tests, but `_index_library` returned
  before reading any document while `json.dumps([zotero.fingerprint(), abstracts.stamp()])` matched the stored
  stamp. The guard was not part of that stamp, so installing it changed nothing until `kb.py index --reread-zotero`
  or a Zotero file changed. On the branch the stamp has four parts: `[fingerprint, abstracts stamp,
  zotero.TEXT_GUARD_VERSION, zotero.overrides_stamp()]` (`server/kb.py:853`, branch); a stamp of an older shape
  also mismatches and re-reads (tested). Once an item is re-stored, `store_note` -> `delete_note` removes its
  chunks, FTS rows, vectors and links (`kb.py:451-462, 730`). The Tantivy keyword index follows the index by chunk
  id (`server/keyword_index.py:58-80`), and that was not enough (third review, reproduced in a test): `chunks.id`
  was a plain rowid, so an item stored last and stored again got its old ids back, the sync saw nothing new and
  nothing gone, and Tantivy kept returning the foreign text of an item that still had an accepted attachment.
  Fixed on the branch: ids are never handed out twice (R23), and a guard or overrides change rebuilds the keyword
  index in an empty folder and compacts the database (R24).
- **The guard rule (branch).** `judge_text` (`server/zotero.py:122`, branch) reads only the first `HEAD_CHARS` =
  4,000 folded characters, because a document names itself on its first page while a reference list or a CV that
  cites the paper does so later; it accepts on the item's DOI, on half the title's judged words, or on a quarter of
  them together with half the authors' surnames; a title too short to judge needs one author surname when authors
  are known; caches under 200 characters are "empty" (not indexed, not counted foreign). Measured read-only on the
  real library on 2026-11-04 (1,124 cached texts on 868 items; keys and counts only): the `dev` rule (DOI or half
  the title anywhere) rejected 46 non-empty texts and 218 near-empty ones; the branch rule marks 49 texts on 44 items
  foreign (43 items with no accepted text left), 218 empty, 857 mine. Deltas versus `dev`: newly rejected
  6L3SUX48 (item 3RENW9VG), M8RZ44DL (76CNZC5I), HVZJPKZF (AXQLB6MI), 8GKLYZZ8 (DV6KXKGR); newly accepted B4PFQJRY
  (LIC7G6N9, "Large scale GW calculations", one of three title words and both authors on page one). The window was
  not chosen for a count: at 2,000 characters six texts whose own DOI or author line sits on page two (after a
  publisher cover) were lost; at 8,000 the two doubtful accepts come back. The Cowtan web page (8GW8WGHR /
  NAMPLC9N, 2 of 6 title words, no authors, 588 characters) stays rejected and needs an override. A heuristic
  cannot be right every time; `text_overrides.json` is the backstop in both directions.
- **The guard rule, version 4 (branch, third review; R26).** What changed, each with a test that fails without it:
  "empty" is measured in characters of any script (it was measured after dropping everything not Latin, so a
  Chinese or Russian text of any length was "empty", its highlights stayed indexed and `/zotero/pdf` served the
  file); the verbatim title is tried only for a non-Latin title, and whole (it ran for every title as a bare
  substring: "Catalysis" matched "photocatalysis", "Quantum dots" accepted any text mentioning quantum dots); a
  short title needs its wording near the top and the authors (any one surname was enough); a title alone needs
  at least three of its judged words and half of them (two of three accepted "Density functional theory"); the
  DOI is matched on the text itself with its punctuation (`10.1000/abc` matched `10.1000/abc.def` once
  punctuation was folded to spaces), and a DOI field that is not a DOI matches nothing; "the authors" means half
  the surnames and at least two (one surname is what an author's own CV or statement carries); two CV section
  headings on lines of their own ("Education", "Publications", ...) reject a text as a `listing`, one does not
  (a journal prints "Education" as an article type; "References" is not in the list). **Version 4 has not been
  measured on the real library**: the review's limits allowed synthetic fixtures only. Every change but the
  non-Latin one can only reject more than version 3 did, so the 843 / 56 / 8 / 218 counts above will move
  towards more rejected texts; Joseph runs `audit-text` before the release and looks at the difference (D13).
- **Stale copies.** `server/data/kb.sqlite` (289 MB, 2026-10-23) and `/opt/homebrew/var/veritas/backup-2026-10-28-before-import/kb.sqlite`
  (181 MB) predate the guard. `data/kb.sqlite.bak-before-vecs`, named in `server/README.md:46`, does not exist.
  `server/README.md:132` tells the user to delete `data/kb.sqlite` to rebuild. Both still exist (2026-11-04, R5 not done).
- **Installed code and three served indexes (found in review).** The guard is only on the branch. The Homebrew
  install has no guard (`grep -c text_belongs /opt/homebrew/opt/veritas/libexec/server/zotero.py` = 0, and
  `grep -c TEXT_GUARD_VERSION` = 0, 2026-11-04); `brew services list` shows `veritas error` with its plist in
  `~/Library/LaunchAgents`, so launchd may keep retrying it. The desktop app (`~/Applications/Veritas.app`) keeps its
  own index at `~/Library/Application Support/io.github.frimpsjoek.veritas/kb.sqlite` (307 MB, re-indexed
  2026-11-04 20:18), and Homebrew's is `/opt/homebrew/var/veritas/kb.sqlite` (305 MB, 2026-11-04 19:41). Installed
  servers spawn their own index runs (`server/http_api.py:334-337`), so if the dev code cleans an index, an installed
  server's next run computes a stamp without the guard version, sees a mismatch and re-reads every item unguarded.
  Cleaning from the dev repo alone can undo itself. Nothing in the new code can prevent this: the old code decides
  on its own, and the index has no version lock an old server would honour. The upgrade (R21) is required, not
  optional; until then the fix is to stop both installed servers.
- **Two more ways old code runs (found in a second review, 2026-11-04).** (i) A LaunchAgent,
  `~/Library/LaunchAgents/com.frimpsjoe.second-brain-dev.plist` (RunAtLoad, KeepAlive), runs the pre-Veritas
  `~/Documents/second-brain-dev/obsidian-kb/kb.py serve --port 27190`, with no guard and its own index
  `obsidian-kb/data/kb.sqlite` (about 40,700 full-text chunks), still indexing `~/Zotero`; it was running on
  2026-11-10 (PID 3991 on 127.0.0.1:27190). Stopping it needs `launchctl bootout`, because KeepAlive restarts it.
  (ii) Every MCP `veritas` process (`server/server.py:49-55`, the Homebrew copy) starts `kb.py serve` itself when
  127.0.0.1:27182 does not answer, so stopping the app and the service is not enough: while any Claude session has
  the old MCP server loaded, the next tool call can start an unguarded server. All Claude sessions must be closed,
  or the installed MCP server upgraded, before an index is cleaned. So there are four indexes to clean or retire:
  Homebrew's, the desktop app's, the main tree's `server/data/kb.sqlite`, and obsidian-kb's.
- **Chat history.** Chats are mirrored as Markdown into the vault (`agent/src/core.js:473-474`;
  `~/Documents/lab-notebook/chats`, 16 files) and kept as JSONL under each data folder's `agent/chats`; the vault is
  itself indexed. The mirror holds user and assistant text only (`agent/src/chat-markdown.js:44-48`); neither form
  records tool calls as such, and the agent's citekey is the Zotero key (`agent/src/library-http.js:19, 26`), so a
  read shows up as `zotero/KEY`, `[@KEY]` or a `citekey` field. `kb.py audit-chats` (branch) looks for those. Run
  read-only on 2026-11-04 over 191 chat files in four folders: 0 name any of the 44 foreign item keys.
- **Override (branch).** `text_overrides.json` in the install's data folder (`paths.data_dir()`, so each install has
  its own) maps an attachment key to `"mine"` or `"foreign"` and is consulted before the heuristic in `documents()`,
  `item_detail()`, `/zotero/pdf` and `audit-text`. A malformed file is ignored with a line on stderr (the heuristic
  still applies, nothing is admitted); an unknown value rejects that attachment. The two doubtful accepts named in
  memo 1 (3RENW9VG, 76CNZC5I) are now rejected by the rule itself (title words only after 4,000 characters, no author
  on page one); "Large scale GW calculations" is accepted by the rule. Any of these can be settled by hand (D3).
- **Other paths to an attachment's text (branch, traced).** Fixed: `item_detail.has_full_text` is judged whenever
  a cache exists (it was `cache.is_file()`, a claim); highlights on a foreign attachment are dropped in both
  `documents()` and `item_detail()` (they are the user's marks on the wrong document and quote it; `highlights_hidden`
  counts them), which also keeps them out of the Paper notes `paper_notes.py` writes into the vault; `/zotero/pdf`
  refuses (403) the file of an attachment whose cache is judged foreign, since the cache was extracted from that
  file. Derived from the index and therefore clean after re-index: `read_note` for `zotero/KEY`, `/note`, MCP
  `read_note` and `search_notes`, the agent's `read_source` (`/note`), `/zotero/status` and `/search`. Not touched,
  out of scope: `radar_api.fulltext` (arXiv texts, not caches); `zotero_files.py` (matches PDFs on disk to items by
  reading their first pages: a planning tool, output is file paths and item titles); online libraries'
  `zotero_web.fulltext` (Zotero's server-side extraction for `<account>:/zotero/KEY` items, same mismatch possible
  in principle, not judged); abstracts (OpenAlex, not caches). Paper notes already written into the vault from a
  foreign attachment's highlights are refreshed only when the item changes (`paper_notes.refresh_changed`), which
  the re-index triggers for re-stored items.
- **Chunk ids are not stable, and are no longer reused (branch).** `chunks.id` was a rowid alias, so SQLite
  handed a deleted top id out again; it is now `INTEGER PRIMARY KEY AUTOINCREMENT` (`kb.py:105-106`), and an
  existing index is copied once on `connect()` (`_stop_reusing_chunk_ids`, `kb.py:180`; ids, FTS rows and vectors
  keep their numbers). A re-store still deletes and re-inserts under new ids (`:730-745`); a full rebuild empties
  every table; `connect()` migrates ad hoc with no `PRAGMA user_version`. Anything that points at a chunk by id
  alone still breaks on the next index (R16 stands).
- **Agent privacy is route-based.** `X-KB-Client: agent` (`server/http_api.py:528`) turns on `private_paths()` and
  `guard()` (`:543-551`); a route not in `AGENT_ROUTES` (`:123`) is refused (`:554`); `/related` and `/links`
  strip private paths with `_without` (`:375-380, 586-594`). A new route that is added to `AGENT_ROUTES` without
  passing through `guard()` bypasses privacy.
- **Links that exist in the index.** Wikilinks resolve by title (`kb.py:1634`). `[@citekey]` links resolve only by
  `meta.citekey` = Zotero's `citationKey` field (`kb.py:1629`, `zotero.py:265`). In the 2026-10-23 copy of the index:
  16 `@` links in 4 notes, 3,534 Zotero items, 812 without a DOI, 37 duplicate-DOI groups (SQL, read-only). Memo 1's
  "0 of 16 resolve" was not re-run but matches the citekey format mismatch it describes.
- **No citation edges.** `referenced_works` are fetched at run time by the radar (`agent/src/radar-older.js:28-44`,
  50 DOIs per request, `onBatch` keeps partial results) and cached 30 days in `state.refs` (`radar-older.js:15,
  89-93`; `radar-state.js:24`); `radar-discover.js:75-80` counts them. Nothing is stored in the index.
- **Extraction exists.** `extract.js` reads up to `FULL_TEXT_CHARS = 20_000` characters per paper (`extract.js:11,
  271-272`), folds whitespace, case and typographic quotes (`foldText`, `:60-68`) and marks each cell `verified` only
  when `checkQuote` finds the quote in the text (`:72-75, 220`). Find-papers tables drive it (`core.js:631`,
  `review2.js:395`). `clean()` collapses whitespace (`kb.py:219`) and chunks are ~1,400 characters (`kb.py:84`), so a
  table row that reflows cannot be quoted contiguously.
- **MCP server.** All six tools are bare `@mcp.tool()` with no annotations (`server/server.py:66-108`); Veritas's own
  hub hides unannotated tools (`agent/src/mcp-hub.js:18-23`).
- **Owed before this spec.** Spec 025 has no plan.md, no `skills/`, no `.mcp.json` and no `readOnlyHint` (checked
  2026-11-04). Roadmap checks still open: radar rating (012 slice 5, `docs/specs/ROADMAP.md:21`), OpenAlex key (014 G2,
  `:28`), phone check (013 slice 4, `:49`).

Checked on the branch (2026-11-04): the foreign count (49 texts, 44 items, by `audit-text`, which reads caches to
decide and prints keys and numbers only); Tantivy drops a rejected item's chunks on the first `sync` after a
re-store (test). Still not checked: `server/eval.py`'s case count; current model prices (memo 2's figures are
repeated below as stated, with the arithmetic checked, not the prices).

## Goals

### G0. Phase 0: the privacy fix takes effect (gate for everything else)

- **R1.** `TEXT_GUARD_VERSION` (an integer in `zotero.py`, now 4) and `overrides_stamp()` are parts three and four
  of the fingerprint JSON at `kb.py:853` (branch), so a guard change or an overrides edit re-reads every library
  on the next ordinary `index` run. Test: bump the constant, run index on a
  fixture library, the Zotero stage runs; a stored stamp of the older shape (no version field) also re-reads.
- **R2.** `kb.py audit-text` lists every attachment with cached text as `item_key attachment_key decision reason
  doi=0|1 title=<fraction> authors=<fraction> chars=<n>` and never prints text (decision: mine, foreign, unknown,
  empty; `unknown` is a text nothing can be judged by, rejected like `foreign`).
  Test: no output line over 200 characters; a fixture cache containing a sentinel string never appears in the output.
- **R3.** `text_overrides.json` in the data folder (`VERITAS_DATA`, else `server/data`; `paths.data_dir()`)
  `{attachment_key: "mine" | "foreign"}` is consulted before the heuristic in both `documents()` and `item_detail()`
  (and in `/zotero/pdf` and `audit-text`). Tests: a forced reject and a forced accept, each in both call sites; a
  malformed file neither stops the index nor admits text; an unknown value rejects.
- **R4.** After re-index, in every served index, a rejected attachment's text is absent, and so are the highlights
  on it. Live check, printing no text: `kb.py verify-guard --index <data folder>` (R25) reports 0 in every store
  and "clean". The earlier check (`SELECT count(*) FROM chunks WHERE path='zotero/<KEY>' AND heading LIKE '%Full
  text%'` per foreign row) is kept inside it as the `full_text` count, but is not enough alone: it cannot see a
  highlight, the FTS index, or text that only Tantivy still holds. A title search cannot test this, because it
  matches the item's own title. On a fixture, a sentinel in a rejected cache returns nothing through `/search`
  (Tantivy included) and MCP `search_notes`; an item indexed under an older guard loses its text on the next
  ordinary run after the version bump. The same holds for highlights on the rejected attachment.
- **R5.** Stale copies (`server/data/kb.sqlite`, the 2026-10-28 backup, `obsidian-kb/data/kb.sqlite` with its
  Tantivy folder) are deleted or moved out of any served path;
  which of the two is D5. The spec records the `ls -la` before and after.
- **R21.** No installed server runs without the guard: a tagged release is installed through `brew upgrade` and the
  desktop app is upgraded, or both are stopped until then (D10). Test: `grep -c TEXT_GUARD_VERSION` on each installed
  `zotero.py` or bundle, and each served data folder is listed by path in the evidence. After the installed apps'
  next automatic index run, R4's count is still 0. Also: the obsidian-kb LaunchAgent is unloaded and its index
  retired (D5), and no `libexec/server/server.py` MCP process of an older version is running when the indexes are
  cleaned (`pgrep -fl server.py` empty, or all of them the upgraded version). The upgrade is required: an older server that runs after a newer
  one cleaned an index computes a stamp without the version, sees a mismatch and re-reads every item unguarded (the
  rejected text comes back); no code on the branch can stop code that is already installed.
- **R22.** Chat history is checked without printing it: `kb.py audit-chats` lists, by path only, chats that name a
  `zotero/<KEY>` marked foreign (as a path, a `[@KEY]` citation or a `citekey` field), across the vault mirror and
  each `agent/chats` folder. Joseph decides what happens to each (D11). Test: on a fixture chat, the listing names
  the file and prints no chat text. Known blind spot: a `search_notes` / `search_library` result carries a snippet
  of the matching passage without a read; the snippet is kept only when the answer cites the item, so a chat that
  saw a snippet and never cited the key is not listed.
- **R23.** A chunk id is never handed out twice: `chunks.id` is `AUTOINCREMENT`, and an index built before that is
  migrated on `connect()` with its rows, ids, FTS rows and vectors as they were. Tests: an item with one foreign
  and one accepted attachment, stored last, loses the foreign text in Tantivy after a guard bump (the review's
  reproduction, failing on the earlier code); a delete and re-store gets higher ids; an old-schema index is
  migrated and keeps its rows.
- **R24.** Text a guard change removes also leaves the files. A re-read caused by a guard or overrides change sets
  `text_guard_epoch` in `meta`: the keyword index is then rebuilt in an emptied folder instead of patched (Tantivy
  only marks deleted documents in its segments), the FTS index is merged into one segment (`optimize`), the
  database is rewritten without free pages (`VACUUM`) and the write-ahead log is emptied. A step that cannot run
  because another process is reading stays pending in `meta` and is finished by the next index run. Tests: after a
  guard bump the foreign sentinel is in no file of the data folder; a few deleted rows in a large FTS segment are
  gone from the file; a held checkpoint stays pending and then completes. Out of reach, and stated to the user:
  copies made before the purge (backups, Time Machine and APFS snapshots, another install's index) and blocks
  the SSD has not yet reused.
- **R25.** `kb.py verify-guard --index <data folder>` checks an index without printing text: for every attachment
  the guard rejects, judged with that folder's own `text_overrides.json`, it looks for phrases of the cached text
  and of the highlights on it in `chunks`, the FTS index, the vectors of such chunks and Tantivy, and prints keys
  and counts. The index is opened read-only. Exit 0 "clean"; 1 when something is found, when the keyword index
  cannot be read or when a rejected text gave no phrase to look for; 2 when nothing was checked (no index, no
  rejected attachment). Tests: clean index; an index built before the guard fails in every store; text left only
  in Tantivy is found; an indexed highlight is found; nothing-to-verify and a missing index are not a pass; the
  other install's overrides are used; no file of the index changes; no sentinel is printed.
- **R26.** The guard rule is version 4 as described under "Where we are"; each changed clause has a unit test and
  a mutation run that fails when the clause is removed (plan.md, third round).
- **R27.** The guard fails closed where it hands out a file: when Zotero's database cannot be copied or queried to
  judge an attachment, `/zotero/pdf` answers 503 instead of serving the file (it served it). An attachment with
  no cache, no parent item or not in the library still has nothing to judge and is served as before.
- **N1.** The re-read of the default library finishes in one ordinary index run and re-stores only items whose text
  changed; unchanged items are skipped because their signature and text length match (`kb.py:874`, branch). The
  first run after the upgrade re-stores more than the 43 cleaned items: 218 near-empty caches lose an empty
  "Full text" section too, and any item re-judged by the new rule. That first run also does one-time work on an
  index of about 300 MB: the `chunks` table is copied (R23), the keyword index is rebuilt (about 7 s) and the
  database is compacted (R24; needs free disk space of about the database's size while it runs).

### G1. Phase 1: experiments that decide whether a graph is justified

Tolerances are fixed here, before any result.

- **R6.** Three-paper manual trial: Joseph hand-labels every numeric value with unit, material, adsorbate and
  conditions in three ISAAC papers (one afternoon, about 3 h); `extract.js` as it is, with memo 2's vocabulary as
  column instructions, 3 samples per paper, temperature fixed. Output: a table of (cell, verified, correct, source_kind).
  Pass: nothing numeric; this trial only shapes the column instructions and the gold format.
- **R7.** Pilot table on the ISAAC collection (about 30 papers), 4 columns (material+facet, adsorbate, property with
  value+unit, method family), through the existing Find-papers path. Joseph checks 40 cells drawn at random from all
  filled cells, verified or not (about 1.5 h). Record precision p40 with its Wilson 95% interval, the fraction of
  filled cells whose quote verified, and the share of papers yielding any value.
- **R8.** Question log: for 14 days Joseph writes each real research question he asks Veritas or would want to, with
  the answer type it needs (search, table, citation edge, multi-hop, lookup). About 10 min a day, 2.5 h total.
- **R9.** Baseline on current search: 10 to 30 questions from the log (at least 10 before scoring), hit@5 judged by
  Joseph (about 2 h). Record the count; this is the number any later tool must beat.
- **R10.** Gold set and thresholds for the larger gate (R19) are committed to this folder before any full extraction
  run, with the measurement of the share of values sitting in tables and SI (memo 2 estimates >40%, unmeasured).
- **N2.** Phase 1 uses only subscription providers already configured; no new paid API key, no local small model
  (spec 010 recorded fabrication on real data).

### G2. Phase 2: the smallest useful tools

- **R11.** Saved, re-runnable extraction table: a Find-papers table definition (collection, columns, instructions,
  model, prompt version) saved as a note in the output folder and re-run on demand; each cell keeps quote, verified
  flag and source_kind. A cell with a value but no unit or no material is rejected, not stored.
- **R12.** `cites` lookup: for a DOI, the library items it references and the library items that reference it, from
  OpenAlex `referenced_works` through the radar's existing batch fetch, cached with `fetched_at`; edges outside the
  library are not stored. Checked against OpenAlex by hand on 20 DOIs.
- **R13.** Citekey resolver: `[@X]` resolves by `meta.citekey`, then by Zotero item key, then by first-author
  surname + year when unique; ambiguous matches are reported, not guessed. Fixes `kb.py:1629` regardless of phase 3.
- **R14.** Retraction check: one call (Crossref or OpenAlex `is_retracted`) for a DOI, answered as a line of text.
- **N3.** No new dependencies for R11-R14. `pymatgen` for composition normalisation is D7 and belongs to phase 3.

### G3. Phase 3: persistent graph store (only if G1 evidence passes the gates)

- **R15.** Separate `graph.sqlite`, `ATTACH`ed, with `PRAGMA user_version`, so `rm kb.sqlite` + full index never
  destroys extractions. Entities: papers by DOI first, then Zotero key, `ids` JSON for the duplicate groups.
- **R16.** Anchor = (source_path, heading_path, quote, quote_hash); `chunk_id` is a cache. On read, the quote is
  re-found in `chunks WHERE path=?` with one shared fold function tested against the `extract.js` fixtures; not
  found -> `anchor_state = 'lost'`, source deleted -> `'source_gone'`; a relation is never deleted by the index.
- **R17.** Relations carry conditions JSON, confidence, extracted_at, model, prompt_version, anchor_state.
  Contradictory values are both kept; a `claims` view groups by (src, rel, dst); nothing auto-resolves.
- **R18.** Every graph route is in `AGENT_ROUTES` and passes through `guard()`; an edge whose source note or either
  endpoint is private is dropped from agent results, including neighbours and paths. Test: a `#no-ai` note cited in a
  relation: `graph_neighbors` returns 0 rows to the agent client and N to the plugin.
- **R19.** Larger gate (200 items, 20 papers: 10 DFT CO2RR, 5 XAS, 5 mixed): value precision >= 0.85, verified-quote
  rate >= 0.95, coverage >= 0.60 split by source_kind; kill if precision < 0.75 or coverage < 0.40 after two prompt
  revisions. Self-agreement on 40 items two weeks later is recorded next to it.
- **R20.** Graph versus search: 30 questions from the log; the graph path must answer at least 6 more correctly than
  search alone (20 points of 30); else the graph stays a side table and no further graph tools are built.
- **N4.** `graph_path` depth <= 3 with a fan-out cap; ~3.5k entities and ~15k edges answer in under 200 ms on this Mac.
- **N5.** Re-anchor rate >= 95% after a full re-index of an unchanged library.

## Gates and numbers (one ladder)

| Gate | Sample | Pass | Kill | What 95% CI it can give | Joseph's time |
|---|---|---|---|---|---|
| Trial (R6) | 3 papers | none; shapes instructions | none | none | ~3 h |
| Pilot (R7) | 40 cells, ~30 papers | p40 >= 32/40 (0.80) and >= 50% of papers yield a value | p40 <= 26/40 (0.65) or < 50% of papers | at 32/40, Wilson 0.65-0.90: wide; the pilot can only rule out a bad extractor, not prove a good one | ~1.5 h |
| Log (R8) | 14 days of questions | >= 3 questions need citation or multi-hop edges | < 3 | none; it is a count | ~2.5 h |
| Baseline (R9) | 10-30 questions | recorded hit@5 | none | wide at 10 | ~2 h |
| Larger (R19) | 200 items | precision >= 0.85, quotes >= 0.95, coverage >= 0.60 | precision < 0.75 or coverage < 0.40 | +-5 points at p = 0.85 | ~9 h + 1.5 h self-agreement |
| Graph vs search (R20) | 30 questions | >= 6 more correct | fewer | a 6-of-30 difference is at the edge of significance; treat as a decision rule, not a proof | ~2 h |

Phases 0-2 cost about 9 h of labelling; phase 3's gates add about 12.5 h and are paid only if the pilot and log pass.
Phase 3 starts only when R7, R8 and R10 are recorded in plan.md as evidence.

Model cost for the larger run (memo 2's prices, arithmetic checked, prices not): 6.5k in + 1.5k out per paper, 3
samples: Sonnet about $0.084/paper, 300 papers about $25 ($13 batched); Opus about $50; Haiku about $1.30 (memo said
$1.50). Through subscriptions dollars may be zero but rate limits apply.

## Disagreements (with the orchestrator's framing and between memos)

- The skeptic's 40-cell, 80% threshold and the extraction memo's 200-item, 0.85 threshold are not rivals: the first
  is a kill gate, the second a pass gate. Written here as one ladder (above).
- Citation lookup is in phase 2 as asked, but ordered after the saved table: the live test answered one question of
  ten with citation edges, and the log (R8) may show it is not needed. If the log records zero citation questions,
  R12 is still built (one day) but R14 and any citation graph are dropped.
- Memo 1's "0 false drops on a 50-item sample" conflicts with its own known false reject; R3's overrides are the
  reconciliation, and the sample check becomes "0 unexplained drops".
- Memo 1's schema is good and is kept for phase 3 unchanged, but nothing in it is built before the gates.

## Decisions for Joseph (recommended first)

- **D1. Sequencing.** Phase 0 now, then spec 025 G1/G2 and the three roadmap checks, then phase 1 (recommended:
  phase 0 closes a privacy hole; 025's `readOnlyHint` blocks Veritas's own hub); or phases 0 and 1
  back to back, pushing 025 further.
- **D2. Graph store location.** Separate `graph.sqlite` with `user_version` (recommended: rebuilds cannot delete paid
  extractions); or tables inside `kb.sqlite`.
- **D3. Overrides.** The branch rule already rejects the two doubtful accepts (attachments 6L3SUX48 of 3RENW9VG and
  M8RZ44DL of 76CNZC5I) and accepts "Large scale GW calculations" (B4PFQJRY). Joseph looks at the 49 foreign rows
  in Zotero (`kb.py audit-text --only foreign`) and writes `"mine"` into `text_overrides.json` for any that are the
  right file (the Cowtan page NAMPLC9N is the known candidate; the two long web pages 8GKLYZZ8 and HVZJPKZF are
  newly rejected and unexamined), and `"foreign"` for any accepted one he knows is wrong (recommended); or leaves
  the rule's decisions as they are.
- **D4. OpenAlex citation pass timing.** On demand per DOI through `cites` (recommended: no pass until the log shows
  need); or one pass over the items with DOIs (about 2,700, 55 requests) at phase 2.
- **D5. Stale copies.** Delete `server/data/kb.sqlite` and the 2026-10-28 backup after phase 0's re-index succeeds
  (recommended; a deletion gate); or move them to a folder no server reads.
- **D6. Pilot collection.** The ISAAC collection (~30 papers) (recommended, matches the questions); or a hand-picked
  20 across DFT and XAS.
- **D7. Normalisation dependency.** No `pymatgen` before phase 3; if phase 3 starts, a pure function with >= 30 name
  pairs including 10 must-not-merge, and `pymatgen` only if the regex fails (recommended); or `pymatgen` at once
  (new install footprint for Homebrew and the desktop app).
- **D8. Larger-gate size.** 200 items (recommended: +-5 points, ~9 h); or 400 (+-3.5 points, ~18 h).
- **D9. Adopt `[@citekey]` in notes.** Keep writing `@ZoteroKey` and let the resolver handle both (recommended); or
  switch notes to Better BibTeX keys.
- **D10. Getting the guard installed.** Stop the Homebrew service and the desktop app, make a tagged release, upgrade
  both, then re-index and check (recommended: nothing can undo the clean-up); or keep them running and accept that
  the private text stays searchable until the upgrade.
- **D11. Chats that read foreign text.** Joseph reviews the path list and deletes or marks them `#no-ai` (recommended);
  or leaves them.
- **D12. Empty caches (Pending).** A cache with fewer than 200 characters of any script is "empty": its text is not
  indexed, the user's highlights on the attachment stay indexed and `/zotero/pdf` serves the file, exactly as for
  an attachment that has no cache at all (a scan has no text either way, and the guard has nothing to judge by)
  (recommended, and what the branch does; 218 caches on the real library); or treat a short cache that is not
  blank as `unknown`, which drops those highlights and refuses those files until each is marked `"mine"`. Only a
  text the guard judged `foreign` or `unknown`, or could not check, loses its highlights and its file.
- **D13. Version 4's thresholds on the real library (Pending).** Run `kb.py audit-text` after the merge and before
  the release, compare with version 3's 843 mine / 56 foreign / 8 unknown / 218 empty, and write `"mine"`
  overrides for the false rejects (recommended: the stricter rule stays, the overrides file carries the
  exceptions); or loosen a threshold (`MIN_TITLE_HITS`, `MIN_AUTHOR_HITS`, the CV headings) where the count of
  false rejects is too high to settle by hand, with a new guard version.
- **D14. Items whose authors cannot confirm (Pending).** The author line confirms only with two surnames longer
  than three letters. An item with one author, or whose authors are named Li, Wu or Kim, can therefore be accepted
  only by its DOI or its title, and a short-titled one of these only by an override (recommended and on the
  branch, the privacy-first choice: one surname is what the author's own statement carries); or let all the
  surnames of such an item confirm it, which accepts a statement by a sole author under that author's paper.

## Leave out

- Neo4j or any graph database; link prediction; hypothesis or experiment suggestion (the ISAAC boundary: Veritas
  holds no hypotheses, calculation records or spectra; it says what the literature says and exports a table).
- A visual graph UI. Joseph works in chat; agents through MCP; output is tables and citation lists.
- LLM-merged entities; auto-resolution of contradictions; citation edges outside the library; storing full
  `referenced_works`; free-text mechanisms; "improves" relations; claims without a number or a named comparison;
  synthesis recipes; a UMLS-style ontology; figure digitisation; a PDF table extractor before R10's measurement.
- Small local models for extraction.

## Open questions

- ~~Does the Tantivy index drop a rejected item's chunks on the first `sync` after re-store, or only on a rebuild?~~
  Answered 2026-11-04: on the first `sync`. Corrected 2026-11-11: only when the re-stored chunks got new ids; with
  reused ids it did not drop them at all (R23). Since guard version 4 the first `sync` after a guard change is a
  rebuild (R24), and an ordinary re-store is an incremental sync under ids that are never reused.
- A two- or three-letter surname is not counted as an author signal (Li, Wu, Kim, Lee). Should surnames of three
  letters count, as whole words? (Owner: Joseph, with D14; not measured.)
- Should online libraries' `zotero_web.fulltext` be judged by the same rule? (Owner: Joseph; not in phase 0.)
- How many of the 10 live-tested questions recur in the 14-day log? (Owner: Joseph, R8.)
