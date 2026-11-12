# Plan: spec 026, knowledge graph (reduced), gated phases

Status: DRAFT 2026-11-04. Decision: Pending. No task group starts until Joseph approves the spec's decisions
D1-D14. Each task group runs in its own worktree and branch, merged after `./check.sh` passes. Deleting files,
re-indexing the live library, installing anything, and any paid API call are gates Joseph confirms.

Gate rule: a phase's task groups start only when the previous phase's evidence block in this file is filled in
with real numbers, dates and commit ids. "Not run" means not started.

| TG | Phase | Covers | Branch | Joseph's time |
|---|---|---|---|---|
| 0 | 0 | R1-R5, R21-R27, N1 | `ai/026-text-guard-effect` | ~3 h (review, audit-text and overrides, release and upgrade, D3/D5/D10-D14 gates) |
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

Covers R1, R2, R3, R4, R5, R21, R22, R23, R24, R25, R26, R27, N1.

1. Failing test first: a fixture library whose fingerprint is unchanged and whose guard version is bumped must run
   the Zotero stage. Then `TEXT_GUARD_VERSION` in `server/zotero.py` and `json.dumps([zotero.fingerprint(),
   abstracts.stamp(), zotero.TEXT_GUARD_VERSION, zotero.overrides_stamp()])` in `_index_library`. (R1) Done: the
   version is now 4 (1 is the `dev` rule; the history is at the constant).
2. `kb.py audit-text`: walks the same attachments `documents()` reads, prints one line per cached text:
   `item_key attachment_key decision reason doi= title= authors= chars=`. Test asserts every line < 200 characters
   and that a sentinel planted in a fixture cache never appears. Never opens `~/Zotero/storage` in tests. (R2) Done.
3. `text_overrides.json` in the data folder, read once per `documents()` call and per `item_detail()` call;
   `"foreign"` rejects before the heuristic, `"mine"` accepts before it. Four tests, plus malformed file and unknown
   value. (R3) Done.
4. Merge, tag a release, and per D10 stop the Homebrew service and desktop app, upgrade both, restart (Joseph's gate:
   install and publish). Record the installed version and `grep -c TEXT_GUARD_VERSION` for each. (R21) Prepared, not
   performed: the commands are in the evidence block.
5. Let each installed app run its index (the bumped version makes it a Zotero re-read, N1). For every served data
   folder (`/opt/homebrew/var/veritas`, the app's Application Support folder), run `kb.py verify-guard --index
   <folder>` with the dev tree's `server/.venv/bin/python` (step 10; it replaces R4's `count(*)` loop, which used
   the system `python3`, passed on an empty key list, read the dev tree's overrides and saw neither highlights nor
   Tantivy). No text is printed. Repeat after the next automatic index run. On a fixture, run the sentinel check
   through `/search` and MCP `search_notes`. (R4) Fixture part done; "before" counts recorded; the live "after"
   waits for step 4.
6. `ls -la server/data/kb.sqlite /opt/homebrew/var/veritas/backup-2026-10-28-before-import/` before; Joseph decides
   D5; `ls -la` after is recorded here. (R5) "Before" recorded; nothing deleted.
7. Chat check: `kb.py audit-chats` lists by path only the chats that name a foreign `zotero/<KEY>`, in
   `~/Documents/lab-notebook/chats` and each `agent/chats`. Joseph decides D11. (R22) Done: 0 of 191.
8. Record for D3: `audit-text` lines for 3RENW9VG and 76CNZC5I (keys and fractions only). Done, below.
9. Added in implementation: the guard rule was strengthened (head of text, authors, empty caches), `has_full_text`
   judged, highlights of a foreign attachment dropped, `/zotero/pdf` refused for a foreign attachment; each
   measured read-only on the real library and tested on the fixture.
10. Third review (2026-11-11), each fix after a test that failed without it. Chunk ids never reused, with a
    migration for existing indexes (R23). A guard or overrides change rebuilds the keyword index and purges the
    deleted text from the database file (R24). `kb.py verify-guard` (R25). Guard version 4 (R26). `/zotero/pdf`
    fails closed (R27). Done; evidence in "Third round" below.
11. User-only, before the release: `audit-text` under version 4 on the real library, compared with version 3's
    counts; `"mine"` overrides for the false rejects; the same `text_overrides.json` copied into each install's
    data folder (each install reads its own). (D3, D13) Not run: the review allowed synthetic fixtures only.
12. User-only, after the upgrade: the first index run of each install copies the `chunks` table, rebuilds the
    keyword index and compacts the database (one-time, about 300 MB each; free disk space of the database's size
    is needed). If the log says the purge was postponed, the next run finishes it; `meta.purge_pending` is absent
    when it is done. Copies made before the purge are not reached: retire the stale indexes (step 6, D5) and
    decide about Time Machine and other backups of the data folders. (R24)
- [ ] Done when V1-V6, V29-V35 have real values and `./check.sh` is green. (V1-V3, V30 fixture part, V6 fixture
  part, V31-V35 and `./check.sh` are green; V4 live, V5, V29, V30's D11 and the D12-D14 decisions wait for Joseph.)

### TG0 evidence

Branch `ai/026-text-guard-effect`, worktree `../veritas-wt-026-text-guard`, 2026-11-04. Commits: `c8db96f` (the
`dev` working-tree guard, as a base), `63123fb` (version in the stamp, head-of-text rule, overrides, audit-text,
has_full_text, highlights, pdf route, tests), `45bc57d` (audit-chats), then the docs commit. Tests run with the
main tree's interpreter (`server/.venv` and `server/models` symlinked into the worktree, not committed) and
`KB_BACKEND=onnx`, as `check.sh` does.

- `./check.sh` (unmodified, first attempt): "check.sh: all parts passed"; server: 472 passed, 3 skipped, 85.9 s;
  app `cargo check` skipped by the script (sidecars not built). Log kept in the session scratchpad, not in the repo.
- `pytest server/tests/test_text_guard_effect.py server/tests/test_zotero_text_match.py server/tests/test_chat_audit.py -q`:
  36 passed.
- Guard rule measurement, read-only on `~/Zotero` (snapshot copy named "audit" in the temp folder; caches read to
  decide, nothing printed but keys and numbers): 1,124 cached texts on 868 items. `dev` rule: 46 rejected non-empty
  + 218 near-empty rejected. Branch rule: foreign 49 (44 items; 43 with no accepted attachment), empty 218, mine 857
  (doi 371, title 469, title_short 12, authors 4, title+authors 1). Window sensitivity, foreign count excluding
  empty: 2,000 chars 57 (loses six texts whose DOI/author line sits on page two), 4,000 chars 49, 8,000 chars 47
  (the two doubtful accepts back in), whole text 46. Author rescue (title >= 0.25 and authors >= 0.5) changes one
  decision at every window: B4PFQJRY (LIC7G6N9).
- `kb.py audit-text` (branch, `VERITAS_DATA` pointed at a scratch folder so nothing was written to a served data
  folder; the scratch folder stayed empty): `awk 'length > 200' | wc -l` = 0. D3 rows:
  `3RENW9VG XQFG4A6R empty empty doi=0 title=0.00 authors=0.00 chars=170`,
  `3RENW9VG 6L3SUX48 foreign foreign doi=0 title=0.33 authors=0.00 chars=24079`,
  `76CNZC5I M8RZ44DL foreign foreign doi=0 title=0.25 authors=0.00 chars=9850`,
  `LIC7G6N9 B4PFQJRY mine title+authors doi=0 title=0.33 authors=0.50 chars=6551`,
  `8GW8WGHR NAMPLC9N foreign foreign doi=0 title=0.33 authors=0.00 chars=588` (the Cowtan page: false reject,
  override candidate).
- V4 "before", read-only (`file:...?mode=ro`), the R4 query summed over the 43 foreign-only item keys:
  `/opt/homebrew/var/veritas/kb.sqlite` 43 of 43 items have Full text chunks (523 chunks);
  `~/Library/Application Support/io.github.frimpsjoek.veritas/kb.sqlite` 43 of 43 (523);
  `server/data/kb.sqlite` (main tree) 43 of 43 (523); the 2026-10-28 backup 43 of 43 (523). Whole-index counts:
  Homebrew 3,564 Zotero items, 777 with full text, 40,555 full-text chunks; app 3,564 / 779 / 40,734; main tree
  3,534 / 754 / 38,949; backup 3,534 / 754 / 38,949.
- V5 "before": `server/data/kb.sqlite` 289,275,904 bytes (Oct 23 15:53);
  `/opt/homebrew/var/veritas/backup-2026-10-28-before-import/kb.sqlite` 180,969,472 bytes (Oct 28 20:37). Nothing
  deleted or moved.
- V29 "before": `grep -c TEXT_GUARD_VERSION /opt/homebrew/opt/veritas/libexec/server/zotero.py` = 0 (and
  `text_belongs` = 0); `brew services list` shows `veritas error` (plist `~/Library/LaunchAgents/homebrew.mxcl.veritas.plist`);
  `~/Applications/Veritas.app/Contents/MacOS/` holds `agentd`, `veritas`, `veritas-server` (a PyInstaller bundle,
  so a grep for the constant is not a reliable check there; the app's version string is).
- V30: `kb.py audit-chats --keys <44 foreign item keys>` over `~/Documents/lab-notebook/chats`,
  `/opt/homebrew/var/veritas/agent/chats`, `~/Library/Application Support/io.github.frimpsjoek.veritas/agent/chats`
  and the main tree's `server/data/agent/chats`: 0 of 191 chat files name a foreign key. The blind spot (uncited
  search snippets) stands; no further check is possible without reading chats.
- Not run, by the hard limits: no re-index of a served folder, no deletion, no release, no upgrade, no service
  start or stop.

Second round, 2026-11-10 (after an adversarial review found the first round incomplete; guard version 3):

- Guard v3 (`server/zotero.py`): DOI matched as a whole (`10.1021/ja035` no longer matches `10.1021/ja0357902`); a
  title alone must sit in the first `TITLE_NEAR_CHARS` = 1,200 folded characters; a text with a CV or
  publication-list marker in its head is rejected (`listing`); the title verbatim near the top admits a non-Latin
  title (`title_exact`); a text nothing can be judged by (blank or non-Latin title, no usable author) is `unknown`
  and not admitted, instead of the benefit of the doubt. The index stamp also carries `zotero.overrides_stamp()`, so
  an overrides edit re-reads Zotero.
- Measured read-only on `~/Zotero` (1,125 cached texts; keys and numbers only, `VERITAS_DATA` on a scratch folder):
  v2 -> v3, 15 decisions changed: 4 accepted -> `foreign` or `listing` by the near-top title rule and markers, 8
  `title_short` accepts -> `unknown` (among them E3MSU439, a text v1 and v2 accepted wrongly), and 3 -> `listing`.
  Totals: mine 843, foreign 56, unknown 8, empty 218. Likely false rejects, now override candidates: IY342BMQ
  (`listing`, title 1.00, authors 1.00, 145k chars), LIC7G6N9 (`listing`), and the Cowtan page NAMPLC9N. 58 items
  have a rejected attachment; 57 of them keep no accepted text.
- Tests: `pytest tests/test_text_guard_effect.py tests/test_zotero_text_match.py tests/test_chat_audit.py`: 42 passed.
  Mutation runs in a temporary copy (removed afterwards), each must make a test fail: guard version out of the stamp
  (2 failed), overrides out of the stamp (1), guard removed from `documents()` (7), from `item_detail()` (2), from
  `/zotero/pdf` (1), DOI match without boundaries (1), `unknown` admitted (1), listing markers off (2). All eight
  were caught.
- `check.sh`: missing pytest now fails the run instead of skipping the server tests. Full `./check.sh` 2026-11-10: "all parts passed"; server 478 passed, 3 skipped; app `cargo check` skipped by the script (sidecars not built).
- Paper notes: 0 notes in the vault's `Papers/` and `Second Brain/` folders carry the `zotero-key` of a rejected item.
- `audit-chats` now also reads `~/.claude/projects` and Claude Desktop's session folders, where tool results are
  stored. 5 files name a rejected key, all Claude Code transcripts (this session, and four from the
  `frimpsjoek-github-io` project, two of them subagent transcripts). Whether each holds the text itself takes Joseph
  opening it (D11).
- `zotero_web.fulltext` has no caller (`grep -n "\.fulltext(" server/*.py`: only `radar_api.fulltext`, which reads
  arXiv), so online libraries do not index attachment text today.

Third round, 2026-11-11 (after an independent review of the second round; guard version 4). Synthetic fixtures
only: no real cache, library, index or chat was opened, and nothing was re-indexed, installed, started or deleted.
Commits `d413d80` (chunk ids, guard epoch, purge), `80ee8e4` (guard version 4, fail closed), `daf274e`
(`verify-guard`), then test and rule follow-ups and the docs commit (`git log dev..HEAD`).

- Finding 1, Tantivy kept foreign text under reused chunk ids: reproduced first
  (`test_tantivy_drops_the_foreign_text_of_an_item_that_keeps_an_accepted_attachment` returned the item for the
  foreign sentinel on the second-round code). Fixed three ways: `chunks.id` is `AUTOINCREMENT` with a one-time
  copy of an existing table on `connect()`; a guard or overrides change sets `meta.text_guard_epoch`, on which
  `keyword_index.sync` rebuilds in an emptied folder; `verify-guard` looks into Tantivy itself.
- Finding 2 and 4, weak accepts: the verbatim title only for a non-Latin title and whole; a short title needs its
  wording and the authors; a title alone needs three of its words; DOI matched on the text with its punctuation
  and only when the field holds a DOI; two surnames to confirm; two CV section headings reject. Bare
  "Publications" or "Education" anywhere was not added: both stand on real first pages (a publisher's name, a
  ministry, an article type); only two different heading lines count, and "References" is not one of them.
- Finding 3, non-Latin texts called empty: "empty" is now fewer than 200 characters of any script. D12 records
  that an empty cache keeps the user's highlights and its file, and a judged `foreign` or `unknown` one does not.
- Finding 5, a check that could pass having checked nothing: `kb.py verify-guard --index <data folder>`
  (`server/guard_verify.py`) and the rewritten step 4 below.
- Finding 6: `/zotero/pdf` answers 503 when the library cannot be read to judge; the purge (FTS `optimize`,
  `VACUUM`, write-ahead log emptied, Tantivy rebuilt) runs after a guard-driven re-read and is retried while
  pending; the spec's three-part stamp, the missing `unknown` and the test docstring's "VERSION 2" are corrected.
- Tests: `pytest tests/test_text_guard_effect.py tests/test_zotero_text_match.py tests/test_guard_verify.py`: 69
  passed (23 + 36 + 10; the first two files had 38 before this round). Full `./check.sh` 2026-11-11: "all
  parts passed"; server 509 passed, 3 skipped (478 before this round); app `cargo check` skipped by the script
  (sidecars not built).
- Mutation runs in a scratch copy of `server/` (removed afterwards), 26 changes, each must make a test fail:
  chunk ids reusable again (2 failed); no Tantivy rebuild on the guard epoch (1); purge without `VACUUM` (3);
  purge without the FTS `optimize` (2); guard change never detected (1); guard version out of the stamp (7);
  "empty" measured on folded text (3); non-Latin title without boundaries (1); verbatim title for every title (5);
  short title confirmed by any one surname (2); short title without its wording (1); title alone on half its
  words (2); DOI without the boundary after (1) and before (1); DOI field not checked for shape (1); one surname
  confirms (3); CV headings off (1); one CV heading enough (1); snapshot error fails open (1); highlights kept
  for a judged-foreign text (7); `verify-guard` without Tantivy (2), without FTS (2), passing on nothing checked
  (1), with the dev tree's overrides (1), without highlights (1), without the guard-version check (1). All 26
  were caught. On the first pass three were not (purge without `VACUUM`, purge without `optimize`, any one
  surname for a short title): the tests were too small or used surnames too short to count, and were
  strengthened until each mutation failed one.
- Not measured: guard version 4 on the real library (step 11, D13). Every clause but the non-Latin one can only
  reject more than version 3 did; the second round's 843 / 56 / 8 / 218 no longer describe the rule.
- Left open: sole-author items and short surnames (D14); the one-time cost of the first run after the upgrade on
  a 300 MB index is estimated, not timed (N1); copies outside the data folders are not purged (R24).

R21, exact commands for Joseph (not performed). Order matters: an old server that runs after an index was cleaned
puts the text back, and three kinds of old code can start one: the Homebrew service, the desktop app, the
obsidian-kb LaunchAgent, plus any Claude session whose old MCP `veritas` server restarts `kb.py serve`.

```
# 0. Stopgap, safe at once: stop and keep stopped the pre-Veritas server (KeepAlive would restart it).
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.frimpsjoe.second-brain-dev.plist
mkdir -p ~/Library/LaunchAgents.disabled && mv ~/Library/LaunchAgents/com.frimpsjoe.second-brain-dev.plist ~/Library/LaunchAgents.disabled/
# 1. Quit every Claude Code and Claude Desktop session (their MCP veritas server can start an old kb.py serve),
#    quit Veritas.app, stop the Homebrew service, then confirm nothing is left:
brew services stop veritas
pgrep -fl 'veritas-server|kb.py serve|libexec/server/server.py|obsidian-kb' ; echo "nothing above = stopped"
# 2. Merge and release (release.mjs commits and tags; it never pushes).
cd ~/Documents/second-brain-dev/veritas && git checkout dev && git merge --no-ff ai/026-text-guard-effect && ./check.sh
# 2b. Before releasing: what does guard version 4 reject on the real library? Keys and numbers only (D3, D13).
(cd server && .venv/bin/python kb.py audit-text > /dev/null)                  # the counts per decision, on stderr
(cd server && .venv/bin/python kb.py audit-text --only foreign; .venv/bin/python kb.py audit-text --only unknown)
#     look the rows up in Zotero; write {"ATTACHMENTKEY": "mine"} for each false reject into text_overrides.json
node tools/release.mjs 0.55.0      # then, as it prints: git push origin dev v0.55.0
# 3. Upgrade both installs after release.yml finishes.
brew update && brew upgrade veritas
grep -c TEXT_GUARD_VERSION /opt/homebrew/opt/veritas/libexec/server/zotero.py    # expect >= 1
#    install the 0.55.0 Veritas.app and check its version in Settings
#    each install reads its own overrides file: copy yours into both data folders before they index
for data in /opt/homebrew/var/veritas "$HOME/Library/Application Support/io.github.frimpsjoek.veritas"; do
  cp ~/Documents/second-brain-dev/veritas/server/data/text_overrides.json "$data/" || echo "no overrides file to copy to $data"
done
# 4. Start, let each install index once. The stamp re-reads Zotero; this first run also copies the chunks table,
#    rebuilds the keyword index and compacts the database (R23, R24), so give it a few minutes.
brew services start veritas    # and open Veritas.app
#    Then verify both served indexes, printing no text. Run the block as it is: it stops at the first failure,
#    it uses the server's own interpreter, and verify-guard exits 2 when it checked nothing and 1 when the index
#    was not read under this guard version, so it cannot pass by accident. Each report names the library it
#    judged with (it must be ~/Zotero) and ends in "-> clean".
( set -eu
  cd ~/Documents/second-brain-dev/veritas/server
  test -x .venv/bin/python
  for data in /opt/homebrew/var/veritas "$HOME/Library/Application Support/io.github.frimpsjoek.veritas"; do
    test -f "$data/kb.sqlite"
    .venv/bin/python kb.py verify-guard --index "$data"
    test -z "$(sqlite3 "file:$data/kb.sqlite?mode=ro" "SELECT value FROM meta WHERE key='purge_pending'")"   # the purge finished
  done
  echo "both served indexes: clean, purge finished" )
#    repeat the block after the next automatic index run (5 minutes) and record both reports in V4 and V29
# 5. D5, only after step 4 prints "clean" for both served folders (moving is the reversible choice):
#    mv ~/Documents/second-brain-dev/veritas/server/data/kb.sqlite ~/veritas-retired/
#    mv /opt/homebrew/var/veritas/backup-2026-10-28-before-import ~/veritas-retired/
#    mv ~/Documents/second-brain-dev/obsidian-kb/data ~/veritas-retired/obsidian-kb-data
#    (then delete ~/veritas-retired when you are sure; record ls -la in V5)
# 6. D11: open the five transcripts audit-chats lists and decide (delete, or keep).
```

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
| V1 | R1 | `pytest server/tests -k guard_version` (fixture library, unchanged files, bumped constant) | Zotero stage runs; stamp now holds the version | 2026-11-04: `test_guard_version_is_part_of_the_stamp_and_an_older_stamp_rereads` passed: unchanged library skipped; old-shape stamp re-reads; bumped constant re-reads; stamp JSON `[2]` = `TEXT_GUARD_VERSION` |
| V2 | R2 | `python server/kb.py audit-text \| awk 'length > 200' \| wc -l` and the sentinel test | `0`; sentinel test passes | 2026-11-04: `0` on the real library (1,124 lines); `test_audit_text_lists_decisions_and_prints_no_text` passed |
| V3 | R3 | `pytest server/tests -k text_overrides` (4 tests) | forced reject and accept honoured in `documents()` and `item_detail()` | 2026-11-04: 4 tests `test_override_*` passed, plus malformed file and unknown value tests |
| V4 | R4 | for each served data folder: `server/.venv/bin/python kb.py verify-guard --index <data>` (the block in the evidence section); fixture sentinel through `/search` and MCP `search_notes` | "-> clean", exit 0, every count `0`, `rejected` > 0; sentinel not found | Fixture: passed 2026-11-04 (`test_rejected_text_is_absent_from_every_store_and_every_search_path`, `test_an_already_indexed_foreign_text_is_removed_by_the_next_run_after_a_guard_bump`: chunks, FTS, vecs, Tantivy on first sync, `/search` as agent, MCP `search_notes`, `read_note`). Live: "before" = 43 of 43 foreign-only items with text in every served index (evidence block); "after" Not run: needs R21 (no re-index of a served folder on this branch) |
| V5 | R5 | `ls -la server/data/kb.sqlite /opt/homebrew/var/veritas/backup-2026-10-28-before-import/ ~/Documents/second-brain-dev/obsidian-kb/data/kb.sqlite` after D5 | absent, or moved to a folder no server reads | Not run: D5 is Joseph's; "before" sizes in the evidence block |
| V6 | N1 | `kb.py index` log line for zotero | one run; "new or changed" count equals the rejected + changed items, not the whole library | Fixture: `zotero_changed == 1` after the bump with one foreign and one clean item (test passed 2026-11-04). Live: Not run (needs R21); expect about 43 + 218 near-empty + re-judged items, not 3,564 |
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
| V29 | R21 | `grep -c TEXT_GUARD_VERSION` on each installed `zotero.py` or bundle; V4 again after the next automatic index run | at least 1 for each, or the service is stopped; counts still `0` | "Before" 2026-11-04: Homebrew `0`, service state `error`; app bundle not greppable. "After": Not run (release and upgrade are Joseph's; commands in the evidence block) |
| V31 | R23 | `pytest server/tests/test_text_guard_effect.py -k "tantivy_drops or never_handed_out or plain_rowids"` | the two-attachment item loses its foreign text in Tantivy; re-stored chunks get higher ids; an old index is migrated with its rows | 2026-11-11: 3 passed; the first failed on the second-round code (Tantivy returned the item for the foreign sentinel) |
| V32 | R24 | `pytest server/tests/test_text_guard_effect.py -k "purge or rebuilds_tantivy"`; live: `meta.purge_pending` absent after the upgrade run | the sentinel is in no file of the data folder; a held checkpoint stays pending, then completes | Fixture 2026-11-11: 3 passed (`rebuilds_tantivy_and_purges`, `purge_takes_a_deleted_word_out`, `purge_that_cannot_finish`). Live: Not run (needs R21) |
| V33 | R25 | `pytest server/tests/test_guard_verify.py` | 10 tests: clean passes, each store's leak is found, nothing checked is exit 2, another guard version is exit 1, no text printed, no file changed | 2026-11-11: 10 passed. Live: Not run (it is V4's command) |
| V34 | R26 | `pytest server/tests/test_zotero_text_match.py`; mutation runs in a scratch copy | every changed clause has a test that fails when the clause is removed | 2026-11-11: 36 passed; 26 of 26 mutations caught (evidence block, third round). Real-library counts under version 4: Not run (D13) |
| V35 | R27 | `pytest server/tests/test_text_guard_effect.py -k "cannot_be_read or nothing_to_judge"` | 503 when the library cannot be read; no cache or not in the library is still nothing to judge | 2026-11-11: 2 passed |
| V30 | R22 | chat listing on a fixture chat, then on the real folders (paths only) | fixture text never printed; real path list recorded; D11 stated | 2026-11-04: `test_chat_audit.py` 4 passed (sentinel never printed); real folders: 0 of 191 files listed (evidence block). D11: nothing to decide on this evidence; the uncited-snippet blind spot is stated |

Every R1-R27 and N1-N5 appears above. Nothing here is accepted; Decision: Pending.
