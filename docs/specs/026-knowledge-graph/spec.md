# Spec 026: knowledge graph (reduced: a privacy fix, an extraction table and citation tools first; a graph store only if the evidence earns it)

Status: DRAFT 2026-11-04. Decision: Pending. Written from three review memos (data architecture, extraction and
evaluation, skeptic) that disagreed on scope; this draft resolves the disagreement in writing and leaves the
decisions D1-D11 to Joseph. A fourth reviewer's findings (installed code, a third index, chat history, a check that could not fail) are applied. No code was changed for this draft.

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

Checked in code 2026-11-04 (`server/zotero.py` carries an uncommitted guard, so its lines are from the working tree):

- **The guard exists but does not take effect.** `text_belongs_to_item` (`server/zotero.py:63-77`) filters an
  attachment's cached text at document build (`:253-255`) and in `item_detail` (`:352-357`), with 8 unit tests
  (`server/tests/test_zotero_text_match.py`). But `_index_library` returns before reading any document while
  `json.dumps([zotero.fingerprint(), abstracts.stamp()])` matches the stored stamp (`server/kb.py:828-834`). The
  guard is not part of that stamp, so installing it changes nothing until `kb.py index --reread-zotero`
  (`kb.py:588-591`) or a Zotero file changes. Once an item is re-stored, `store_note` -> `delete_note` removes its
  chunks, FTS rows, vectors and links (`kb.py:428-439, 708`); the Tantivy keyword index drops ids no longer live on
  its next `sync` (`server/keyword_index.py:54-68`, called at `kb.py:1095`), which was not exercised end to end.
- **Stale copies.** `server/data/kb.sqlite` (289 MB, 2026-10-23) and `/opt/homebrew/var/veritas/backup-2026-10-28-before-import/kb.sqlite`
  (181 MB) predate the guard. `data/kb.sqlite.bak-before-vecs`, named in `server/README.md:46`, does not exist.
  `server/README.md:132` tells the user to delete `data/kb.sqlite` to rebuild.
- **Installed code and three served indexes (found in review).** The guard is only in this working tree. The Homebrew
  install has no guard (`grep -c text_belongs /opt/homebrew/opt/veritas/libexec/server/zotero.py` = 0). The desktop
  app (`~/Applications/Veritas.app`, running) keeps its own index at `~/Library/Application
  Support/io.github.frimpsjoek.veritas/kb.sqlite` (307 MB, re-indexed 2026-11-04 20:13), and Homebrew's is
  `/opt/homebrew/var/veritas/kb.sqlite`. Installed servers spawn their own index runs (`server/http_api.py:334-337`),
  so if the dev code cleans an index, an installed server's next run computes a stamp without the guard version, sees
  a mismatch and re-reads every item unguarded. Cleaning from the dev repo alone can undo itself.
- **Chat history.** Chats are mirrored as Markdown into the vault (`agent/src/core.js:473-474`;
  `~/Documents/lab-notebook/chats`, 16 files) and kept as JSONL under each data folder's `agent/chats`; the vault is
  itself indexed. A past chat that read a foreign full text would stay searchable. Whether any did was not checked.
- **No override.** A false reject cannot be forced in and a false accept cannot be forced out except by editing
  Zotero. The two doubtful accepts named in memo 1 (3RENW9VG, 76CNZC5I) and the known false reject ("Large scale GW
  calculations") are not resolvable today.
- **Chunk ids are not stable.** `chunks.id INTEGER PRIMARY KEY` is a rowid alias (`kb.py:105-106`); a re-store
  deletes and re-inserts (`:708-716`); a full rebuild empties every table (`:620`); `connect()` migrates ad hoc with
  no `PRAGMA user_version` (`:137-141`). Anything that points at a chunk by id alone breaks on the next index.
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

Not checked here: the count of 46 foreign texts in the live index (would need reading cache files; not done, by the
privacy rule); whether Tantivy returns a rejected item after a re-store; `server/eval.py`'s case count; current
model prices (memo 2's figures are repeated below as stated, with the arithmetic checked, not the prices).

## Goals

### G0. Phase 0: the privacy fix takes effect (gate for everything else)

- **R1.** `TEXT_GUARD_VERSION` (an integer in `zotero.py`) is part of the fingerprint JSON at `kb.py:828`, so a
  guard change re-reads every library on the next ordinary `index` run. Test: bump the constant, run index on a
  fixture library, the Zotero stage runs.
- **R2.** `kb.py audit-text` lists every attachment with cached text as `(item key, attachment key, decision, doi_hit,
  title_word_fraction)` and never prints text. Test: no output line over 200 characters; a fixture cache containing a
  sentinel string never appears in the output.
- **R3.** `data/text_overrides.json` `{attachment_key: "mine" | "foreign"}` is consulted before the heuristic in both
  `documents()` and `item_detail()`. Tests: a forced reject and a forced accept, each in both call sites.
- **R4.** After re-index, in every served index, a rejected attachment's text is absent. Live check, reading no text:
  for each `audit-text` row marked foreign, `SELECT count(*) FROM chunks WHERE path='zotero/<KEY>' AND heading LIKE
  '%Full text%'` = 0 when no accepted attachment remains on that item. A title search cannot test this, because it
  matches the item's own title. On a fixture, a sentinel in a rejected cache returns nothing through `/search`
  (Tantivy included) and MCP `search_notes`.
- **R5.** Stale copies (`server/data/kb.sqlite`, the 2026-10-28 backup) are deleted or moved out of any served path;
  which of the two is D5. The spec records the `ls -la` before and after.
- **R21.** No installed server runs without the guard: a tagged release is installed through `brew upgrade` and the
  desktop app is upgraded, or both are stopped until then (D10). Test: `grep -c TEXT_GUARD_VERSION` on each installed
  `zotero.py` or bundle, and each served data folder is listed by path in the evidence. After the installed apps'
  next automatic index run, R4's count is still 0.
- **R22.** Chat history is checked without printing it: a script lists, by path only, chats whose tool calls read a
  `zotero/<KEY>` marked foreign, across the vault mirror and each `agent/chats` folder. Joseph decides what happens to
  each (D11). Test: on a fixture chat, the listing names the file and prints no chat text.
- **N1.** The re-read of the default library finishes in one ordinary index run and re-stores only items whose text
  changed; unchanged items are skipped because their signature and text length match (`kb.py:846`).

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
- **D3. Overrides for the two doubtful accepts.** Mark 3RENW9VG and 76CNZC5I `"foreign"` in `text_overrides.json`
  after Joseph looks at them in Zotero (recommended); or leave them in.
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

## Leave out

- Neo4j or any graph database; link prediction; hypothesis or experiment suggestion (the ISAAC boundary: Veritas
  holds no hypotheses, calculation records or spectra; it says what the literature says and exports a table).
- A visual graph UI. Joseph works in chat; agents through MCP; output is tables and citation lists.
- LLM-merged entities; auto-resolution of contradictions; citation edges outside the library; storing full
  `referenced_works`; free-text mechanisms; "improves" relations; claims without a number or a named comparison;
  synthesis recipes; a UMLS-style ontology; figure digitisation; a PDF table extractor before R10's measurement.
- Small local models for extraction.

## Open questions

- Does the Tantivy index drop a rejected item's chunks on the first `sync` after re-store, or only on a rebuild?
  (Owner: phase 0 implementer; R4 decides.)
- How many of the 10 live-tested questions recur in the 14-day log? (Owner: Joseph, R8.)
