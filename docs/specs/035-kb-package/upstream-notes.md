# Spec 035: notes for upstream (drafts, not filed)

Drafted by the kb-package lane; nothing here has been sent upstream. The driver files or drops each one.

## Draft issue: the keyword index keeps a deleted chunk's text when SQLite reuses its id

> **Stale keyword hits after a re-index that deletes and re-adds passages.** `chunks.id` is an
> `INTEGER PRIMARY KEY` without `AUTOINCREMENT` (`server/kb.py`, schema), so after a delete SQLite hands the highest
> freed ids to the next inserts. `KeywordIndex.sync` (`server/keyword_index.py`) diffs id sets only:
> `new, gone = live - self.ids, self.ids - live`. When a run of `kb.py index` deletes a note's passages and the same
> run (or the next one before the server refreshes) stores other text under the freed ids, those ids are in both
> sets: not new, not gone, so Tantivy keeps the old passage's terms under an id whose row now holds different text.
> The server then returns the new passage for a query that only matches the old one, until the next full keyword
> rebuild. Reproduce: index a note A whose passages hold the highest chunk ids; edit it (or delete it and add B) so
> its passages are rewritten; refresh the searcher without a rebuild; search for a word only A's old text had: the
> hit is the new row. The in-memory vectors have the same shape of problem: `Searcher._load(full=False)` appends only
> ids above `max_id`, so a reused id keeps its old vector until the next full reload (hourly, or when enough rows
> are stale).
>
> Suggested fix (as on the `feat/kb-package` branch, spec 035): whoever deletes rows reports the deleted chunk ids;
> `KeywordIndex.sync(db, replaced)` re-indexes any of them that exist again (`new |= replaced & live`), and the
> searcher treats a write that deleted rows as "full": it bumps a generation, reloads every vector on the next
> refresh and discards a background rebuild begun under an older generation. In the app, `kb.py index` runs in
> another process, so it would pass the ids through the database (for example a `replaced_ids` table or a meta
> stamp that forces a full keyword sync) rather than in memory. Tests on the branch:
> `tests/test_kb_params.py::test_reused_chunk_id_gets_fresh_keywords` (and `..._fresh_vector`).
