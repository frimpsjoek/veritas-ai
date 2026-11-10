# Plan: spec 026, knowledge graph (reduced), gated phases

Status: DRAFT 2026-11-04. Decision: Pending. No task group starts until Joseph approves the spec's decisions
D1-D11. Each task group runs in its own worktree and branch, merged after `./check.sh` passes. Deleting files,
re-indexing the live library, installing anything, and any paid API call are gates Joseph confirms.

Gate rule: a phase's task groups start only when the previous phase's evidence block in this file is filled in
with real numbers, dates and commit ids. "Not run" means not started.

| TG | Phase | Covers | Branch | Joseph's time |
|---|---|---|---|---|
| 0 | 0 | R1-R5, R21, R22, N1 | `ai/026-text-guard-effect` | ~2 h (review, release and upgrade, D3/D5/D10/D11 gates) |
| 1 | 1 | R6, R7, R10, N2 | `ai/026-pilot-table` | ~4.5 h labelling |
| 2 | 1 | R8, R9 | none (a note in the vault) | ~4.5 h over 14 days |
| 3 | 2 | R11, R13, N3 | `ai/026-saved-table` | ~0.5 h |
| 4 | 2 | R12, R14 | `ai/026-cites` | ~1 h (20-DOI check) |
| 5 | 3 | R15-R18, N4, N5 | `ai/026-graph-store` | ~0 h |
| 6 | 3 | R19, R20 | `ai/026-graph-gates` | ~12.5 h labelling |

Order: TG0 first. Then, per spec D1 (recommended), spec 025 G1/G2 and the three roadmap checks (radar rating
`docs/specs/ROADMAP.md:21`, OpenAlex key `:28`, phone `:49`) before TG1. TG1 and TG2 run in parallel; TG2 needs no code.
TG3 and TG4 need TG1's instructions. TG5 and TG6 need the phase 1 gate.

## The very next task group: TG0, privacy fix takes effect (phase 0)

Covers R1, R2, R3, R4, R5, R21, R22, N1.

1. Failing test first: a fixture library whose fingerprint is unchanged and whose guard version is bumped must run
   the Zotero stage. Then `TEXT_GUARD_VERSION = 1` in `server/zotero.py` and `json.dumps([zotero.fingerprint(),
   abstracts.stamp(), zotero.TEXT_GUARD_VERSION])` at `kb.py:828`. (R1)
2. `kb.py audit-text`: walks the same attachments `documents()` reads, prints one line per cached text:
   `item_key attachment_key decision doi_hit title_word_fraction`. Test asserts every line < 200 characters and that a
   sentinel planted in a fixture cache never appears. Never opens `~/Zotero/storage` in tests. (R2)
3. `data/text_overrides.json`, read once per `documents()` call and per `item_detail()` call; `"foreign"` rejects
   before the heuristic, `"mine"` accepts before it. Four tests. (R3)
4. Merge, tag a release, and per D10 stop the Homebrew service and desktop app, upgrade both, restart (Joseph's gate:
   install and publish). Record the installed version and `grep -c TEXT_GUARD_VERSION` for each. (R21)
5. Let each installed app run its index (the bumped version makes it a Zotero re-read, N1). For every served data
   folder (`/opt/homebrew/var/veritas`, the app's Application Support folder), run R4's `count(*)` query per foreign
   row; no text is read or printed. Repeat after the next automatic index run. On a fixture, run the sentinel check
   through `/search` and MCP `search_notes`, which also answers the Tantivy question. (R4)
6. `ls -la server/data/kb.sqlite /opt/homebrew/var/veritas/backup-2026-10-28-before-import/` before; Joseph decides
   D5; `ls -la` after is recorded here. (R5)
7. Chat check: list by path only the chats whose tool calls read a foreign `zotero/<KEY>`, in
   `~/Documents/lab-notebook/chats` and each `agent/chats`. Joseph decides D11. (R22)
8. Record for D3: `audit-text` lines for 3RENW9VG and 76CNZC5I (keys and fractions only).
- [ ] Done when V1-V6, V29 and V30 have real values and `./check.sh` is green.

### TG0 evidence
Not run.

## TG1: three-paper trial and the pilot table (phase 1)

Covers R6, R7, R10, N2.

1. Pick 3 ISAAC papers (Joseph). Gold file `docs/specs/026-knowledge-graph/gold/trial.csv`: one row per numeric
   value: paper key, value, unit, material, facet, adsorbate, property, conditions, method, quote, source_kind.
2. Column instructions from memo 2's vocabulary (Material, Adsorbate, Property enum, Condition bundle, Method
   bundle), as a Find-papers table; no code change. Run 3 samples per paper with the configured subscription provider
   (N2). Score each cell: verified (by `checkQuote`), correct against gold, source_kind.
3. Revise the instructions once from what the trial shows; freeze them as `gold/instructions-v1.md`.
4. Pilot: the ISAAC collection (D6), 4 columns, one run. Joseph checks 40 cells chosen by a seeded random draw
   from all filled cells (seed recorded). Record 40-cell precision with a Wilson 95% interval, the verified-quote
   fraction of filled cells, and the share of papers with at least one value. (R7)
5. Measure on the trial and pilot gold rows the share of values whose source is a table or SI (R10, first half).
6. Commit `gold/larger-gate.md`: the 20-paper list, the 200-item sampling rule, the thresholds copied from spec R19,
   before any larger run (R10, second half).
- [ ] Done when V7-V10 are filled in and the pilot verdict (pass, kill, or in between) is written here.

### TG1 evidence
Not run.

## TG2: question log and search baseline (phase 1, no code)

Covers R8, R9.

1. A vault note `Second Brain/026 question log.md`: date, question, answer type needed (search / table / citation
   edge / multi-hop / lookup), answered today? (yes / partly / no). 14 days.
2. After day 14: count by type. Gate: >= 3 need citation or multi-hop edges, else TG5/TG6 are dropped.
3. Baseline: 10-30 questions from the log through today's search; Joseph judges hit@5; record the count.
- [ ] Done when V11-V12 have counts.

### TG2 evidence
Not run.

## TG3: saved, re-runnable extraction table and the citekey resolver (phase 2)

Covers R11, R13, N3.

1. Table definition saved as a note in the output folder (front matter: collection, columns, instructions, model,
   prompt_version, created); "Run again" re-extracts and writes a dated results note; cells keep quote, verified,
   source_kind. Cells with a value but no unit or no material are rejected in `extract.js` with a test.
2. Citekey resolver in `kb.py` (`links()` at `kb.py:1629` and the search for `@` targets): `meta.citekey`, then
   Zotero item key, then unique first-author surname + year; ambiguous -> `"@X (ambiguous: n items)"`. Tests for
   each tier and for the ambiguous case; the 16 existing `@` links are re-counted after.
3. No dependency changes (N3): `server/requirements.txt` and every `package.json` diff is empty.
- [ ] Done when V13-V16 pass.

### TG3 evidence
Not run.

## TG4: cites and retraction lookups (phase 2)

Covers R12, R14.

1. `cites` tool (agent gateway and, through a new `AGENT_ROUTES` entry that passes `guard()`, the MCP server): given a
   DOI, library items it references and library items referencing it, via `radar-older.js`'s `referenced_works` batch
   fetch; cache rows `{doi, ids, fetched_at}`; edges outside the library are not stored (D4).
2. Retraction: one call per DOI; answer is one line with the source and date.
3. Hand check on 20 DOIs against OpenAlex's web page (Joseph, ~1 h).
- [ ] Done when V17-V19 pass.

### TG4 evidence
Not run.

## TG5: graph store (phase 3; starts only if TG1 pilot passed and TG2 counted >= 3)

Covers R15, R16, R17, R18, N4, N5.

1. `graph.sqlite` with `PRAGMA user_version = 1`, `ATTACH`ed by `connect()`; tables `entities(id, kind, name, ids
   JSON)`, `relations(id, src, rel, dst, value, unit, conditions JSON, confidence, extracted_at, model,
   prompt_version, source_path, heading_path, quote, quote_hash, chunk_id, anchor_state)`; view `claims`.
2. One fold function in Python, tested against the `extract.js` fixtures byte for byte; re-anchor on read.
3. `delete_note` sets `anchor_state='source_gone'` for relations whose `source_path` is removed; never deletes them.
4. Routes `/graph/neighbors`, `/graph/path` (depth <= 3, fan-out cap) in `AGENT_ROUTES`, through `guard()`, edges
   with a private source or endpoint dropped for agent clients.
5. Normalisation per D7.
- [ ] Done when V20-V25 pass.

### TG5 evidence
Not run.

## TG6: larger gate and graph-versus-search (phase 3)

Covers R19, R20.

1. Run the frozen instructions on the 20 gold papers; Joseph labels 200 items (~9 h) using `gold/larger-gate.md`.
2. Compute value precision, verified-quote rate, coverage by source_kind; at most two prompt revisions, each re-run
   recorded; the kill rule applies after the second.
3. Two weeks later: Joseph relabels 40 items; self-agreement recorded.
4. 30 questions from the log: search alone vs graph path; Joseph judges correctness; difference recorded.
- [ ] Done when V26-V28 have numbers and the verdict (graph stays, or stays a side table) is written here.

### TG6 evidence
Not run.

## Validation

| V | Covers | Command or check | Expected | Actual |
|---|---|---|---|---|
| V1 | R1 | `pytest server/tests -k guard_version` (fixture library, unchanged files, bumped constant) | Zotero stage runs; stamp now holds the version | Not run |
| V2 | R2 | `python server/kb.py audit-text \| awk 'length > 200' \| wc -l` and the sentinel test | `0`; sentinel test passes | Not run |
| V3 | R3 | `pytest server/tests -k text_overrides` (4 tests) | forced reject and accept honoured in `documents()` and `item_detail()` | Not run |
| V4 | R4 | for each served data folder and each `audit-text` foreign row: `sqlite3 <data>/kb.sqlite "SELECT count(*) FROM chunks WHERE path='zotero/<KEY>' AND heading LIKE '%Full text%'"`; fixture sentinel through `/search` and MCP `search_notes` | `0` when no accepted attachment remains on the item; sentinel not found | Not run |
| V5 | R5 | `ls -la server/data/kb.sqlite /opt/homebrew/var/veritas/backup-2026-10-28-before-import/` after D5 | absent, or moved to a folder no server reads | Not run |
| V6 | N1 | `kb.py index` log line for zotero | one run; "new or changed" count equals the rejected + changed items, not the whole library | Not run |
| V7 | R6 | `gold/trial.csv` and the 3-sample results note | one row per gold value; cells scored verified/correct/source_kind | Not run |
| V8 | R7 | pilot results note; 40-cell sheet with seed | p40 as k/40 with Wilson interval; verified-quote fraction; share of papers with a value | Not run |
| V9 | R10 | `gold/larger-gate.md` committed before any larger run; table/SI share recorded | file present with thresholds equal to spec R19; a number for the table/SI share | Not run |
| V10 | N2 | provider name in the results notes; `git diff` of keys | subscription provider only; no new key | Not run |
| V11 | R8 | question log note after 14 days | counts by answer type; citation+multi-hop count >= 3 or TG5/6 dropped | Not run |
| V12 | R9 | baseline sheet | hit@5 count over >= 10 questions | Not run |
| V13 | R11 | save a table, run again | definition note + dated results note; cells keep quote, verified, source_kind | Not run |
| V14 | R11 | `node --test agent/test/extract.test.js` (value without unit or material) | cell rejected | Not run |
| V15 | R13 | `pytest server/tests -k citekey_resolver`; then `sqlite3` count of resolved `@` links | each tier and the ambiguous case pass; resolved count > 0 of 16 | Not run |
| V16 | N3 | `git diff server/requirements.txt '**/package.json'` | empty | Not run |
| V17 | R12 | `cites` for 20 DOIs vs OpenAlex web page | 20 of 20 match on in-library references; only library edges stored | Not run |
| V18 | R12 | `cites` route as agent client for a private item | refused by `guard()` | Not run |
| V19 | R14 | retraction check on one known retracted and one clean DOI | one line each, correct | Not run |
| V20 | R15 | `rm kb.sqlite` on a scratch data folder, `kb.py index --full` | `graph.sqlite` rows unchanged; `user_version` = 1 | Not run |
| V21 | R16, N5 | full re-index of an unchanged fixture library; count `anchor_state` | >= 95% `ok`; rest `lost`; none deleted | Not run |
| V22 | R16 | `pytest server/tests -k fold` against `extract.js` fixtures | identical folded strings | Not run |
| V23 | R17 | insert two contradictory relations; query `claims` | both rows returned; no merge | Not run |
| V24 | R18 | `#no-ai` note cited in a relation; `/graph/neighbors` as agent and as plugin | 0 rows and N rows | Not run |
| V25 | N4 | `time` of `/graph/path` depth 3 on the full store | under 200 ms | Not run |
| V26 | R19 | larger-gate sheet | precision, quote rate, coverage by source_kind with CIs; pass or kill stated | Not run |
| V27 | R19 | self-agreement sheet (40 items, two weeks later) | agreement rate recorded | Not run |
| V28 | R20 | 30-question sheet | correct counts for search and graph; difference >= 6 or graph stays a side table | Not run |
| V29 | R21 | `grep -c TEXT_GUARD_VERSION` on each installed `zotero.py` or bundle; V4 again after the next automatic index run | at least 1 for each, or the service is stopped; counts still `0` | Not run |
| V30 | R22 | chat listing on a fixture chat, then on the real folders (paths only) | fixture text never printed; real path list recorded; D11 stated | Not run |

Every R1-R22 and N1-N5 appears above. Nothing here is accepted; Decision: Pending.
