# Spec 035: the index as a library, one per user (slice 0)

Status: DRAFT 2026-11-20 (Trinity integration driver; decisions D1-D8 below taken by the driver). Plan: `plan.md`.

## What happens today

The search index (SQLite + FTS5, Tantivy keyword index, snowflake-arctic-embed-s vectors, fused ranking) lives in
`server/kb.py` and is bound to one index per process: the database path, the Tantivy folder, the model folder, the
embedding backend and the vector-reuse stash are module globals (`kb.DB_PATH`, `kb.data_dir()`, `kb.MODEL_DIR`,
`kb.USE_MLX`, `kb._VEC_STASH`). A host that wants one index per user (Trinity) cannot hold two in one process, and
there is no `pyproject.toml` to install the engine as a library.

## Goals

- R1. `KnowledgeBase(db_path, model_dir=None, *, keyword_dir=None, backend="auto", embedder=None, vector_gate=None)`
  in a new `server/veritas_kb.py`: one instance owns one SQLite file, one Tantivy folder and one in-memory searcher.
  Two instances share no mutable index state: ingest into A, search B returns nothing.
- R2. The only shared object is the embedding model, one per `(model dir, backend)`, built once, lazily, without
  holding a process-wide lock while it loads. The ONNX path only reads the model folder.
- R3. `backend="auto"` uses MLX on macOS and onnxruntime elsewhere, with no MLX attempt or warning on Linux.
- R4. Writes are atomic per call: `apply(add, remove, meta)` stores documents, removes paths and sets meta stamps in
  one SQLite transaction, all or nothing; a failed call leaves the index as it was and the instance usable.
- R5. Lifecycle: a failed constructor releases its claim on the files; `close()` is idempotent and returns only after
  in-flight work and the searcher's background rebuild have stopped; the same files can then be reopened.
- R5a. The keyword folder is derived data that a rebuild empties, so the constructor refuses (ValueError) a
  `keyword_dir` that contains the database or lies inside it, and either path that contains or lies inside one an
  open instance holds. A rebuild empties only a missing/empty folder or one holding nothing but Tantivy's files,
  `schema-version`, `ids.npy` and the `.veritas-keyword-index` marker it writes, with that marker present. An
  unmarked folder from before the marker must additionally have both `meta.json` and `schema-version`, open as a
  Tantivy index, and carry the keyword schema; anything else, a subfolder or a link refuses the rebuild untouched.
- R5b. A keyword folder is bound to its database (chunk ids are row numbers that two databases share): the database
  keeps a random id in `meta` (`db_uuid`, added when a writer first opens it) and the marker names it. A
  `keyword_dir` bound to another database is refused (`keyword_index.KeywordIndexBindingError`, a RuntimeError) and
  left untouched; so is any bound one, for a reader too, while the database has no id yet (no writer has opened it).
  An unbound one (from before the binding) is rebuilt once from the database and bound. `kb.Searcher` with neither
  path named (the legacy server's `data/tantivy`) rebuilds a folder bound to another database instead, as before; a
  reader of that pair leaves such a folder unloaded and searches SQLite FTS.
- R6. Back-compatibility: `kb.py` keeps its whole API and CLI, `kb.py serve`, `bin/veritas`, the LaunchAgent,
  Homebrew and PyInstaller builds are unchanged, the on-disk format is unchanged (a database written by a
  `KnowledgeBase` is a Veritas database), and every existing test passes without edits.
- R7. `server/pyproject.toml` (`veritas-kb` 0.1.0): a wheel installed in a clean venv outside the checkout can create,
  ingest, search, close and reopen an index.

## Decisions (driver, 2026-11-20)

- D1. Flat modules (`py-modules`), as the server's modules import each other top-level. Trinity runs Veritas in a
  separate worker subprocess with its own venv, so module names cannot collide and kb's import-time side effects stay
  out of Trinity's process. Importing kb never opens a port: only `kb.py serve` run as a script (and the frozen
  server's entry) listens early, so `veritas_kb` leaves `sys.argv` alone (review round 1; it used to swap in a
  neutral one around the import).
- D2. Package version 0.1.0, independent of the app's version (no release-script change).
- D3. `mlx_embed`'s own `MODEL_DIR` (ignores `VERITAS_DATA`) is left untouched; an upstream issue is drafted below, not
  filed. No MLX change in slice 0. Superseded by review round 1 (M3): `kb.Embedder` passes `model_dir` to
  `ArcticMLX`, which loads (and, when it may write, caches) the weights there; the draft below is now what the
  branch does.
- D4. Default backend `"auto"`.
- D5. kb's read-only folder-layout probe at import is acceptable (it runs in the worker).
- D6. Synchronous, simple API. No process-wide mutex is held while a model loads (per-key in-flight construction).
  SQLite serialises writers; Python locks only where shared in-memory state or a non-transactional write needs them,
  all per instance. The caller runs calls off its event loop.
- D9 (2026-11-20, answers to the plan's open questions). Searches on one instance wait on a per-instance lock with a
  bounded timeout (see the concurrency contract). A full vector reload follows every write that deleted rows. The
  clean-venv wheel test stays opt-in (`VERITAS_WHEEL_TEST=1`); its output is recorded as evidence.
- D7. Tenant layout (Trinity's concern; the class takes explicit paths):
  `<user>/knowledgebase/zotero/index/kb.sqlite` and `<user>/knowledgebase/zotero/index/tantivy/` (the default
  `keyword_dir` is `db_path.parent / "tantivy"`, so passing the db path is enough).
- D8. This spec before implementation.

## Concurrency contract (R1, D6)

- Different instances never wait for each other, except on the shared model while it is first built for the same key.
- On one instance: `search` / `similar_to_text` use the searcher's own connection and in-memory vectors, which are not
  safe for parallel use (upstream also serialises every searcher call, `http_api.LOCK`). They take a **per-instance
  search lock and wait** for it, at most `search_timeout` seconds (default 60), then raise `ConcurrentUseError` (a
  `TimeoutError`). Driver decision 2026-11-20, replacing the earlier fail-fast guard: Trinity serves concurrent HTTP
  requests for one user's index from a thread pool. Different instances never share this lock.
- `apply` and `embed_pending` open their own short-lived connections and share one per-instance write lock. It is
  required for correctness: `embed_pending` reads chunks, embeds them outside any transaction and then writes vectors
  by chunk id, and SQLite reuses the highest rowid after a delete (`INTEGER PRIMARY KEY` without `AUTOINCREMENT`), so a
  concurrent removal plus insert would give a new chunk the old chunk's vector. Upstream prevents the same with its
  one-indexer file lock (`kb.LOCK_FILE`). The lock is per instance, so it never stalls another tenant.
- Review round 1 (M1, adopted by the driver): searches also take the write lock, before the search lock (the order
  `close()` uses), so an `apply` cannot commit between a search's vector refresh and its row reads (with reused chunk
  ids that scored one document's vector and returned another; Tantivy and SQLite could disagree too). One
  `search_timeout` covers both locks. Searches therefore wait during `embed_pending`, which holds the write lock while
  it embeds; accepted for now, documented in the README.
- `stats`, `read`, `documents`, `get_meta` use their own short-lived read connections and no lock. They register as
  running reads (M2): once `close()` begins they raise `ClosedError`, and `close()` waits for those already running
  before it releases the files. Reads never wait for each other.
- Every call is blocking I/O; an async host runs them in worker threads (Trinity: the worker subprocess).

## T0-E: exact bounds and path-prefix visibility (2026-11-20)

Base inspected: `08bd2c3fb84b1ed9b9ba6ca4920f183851205ce8`. These are small, reusable engine additions, not a staged-generation implementation: the caller owns its durable visibility manifest and passes an immutable snapshot.

Inspected behavior pinned before the additions:

- `store_note` applies `chunk_note` to each document and, when that returns no chunks, stores one title-fallback chunk.
  `chunk_note` is `split_sections` → `clean` → `pack`, with same-section tiny-tail merging. There is no character-count
  estimator in that path.
- Default `Searcher.search` uses a 200-chunk RRF pool per side after inspecting up to 600 candidates. Keyword candidates
  are Tantivy all-words, all-but-one, then rare-word stages (SQLite FTS5 is the fallback). Vectors are cosine-gated
  before RRF (`k=60`). Results are source-weighted, one per document after text/paper deduplication. The existing API
  returned only a limited result list; it had no `total`.
- `embed_pending(batch=N)` committed each N-chunk round independently but looped until no pending chunks remained.
  `vectors_at` is stamped after success and on failure after rollback of the failed round, so committed earlier rounds
  remain searchable. `batch` alone did not bound the call.

New public API:

```python
KnowledgeBase.count_chunks(document: Document) -> int
KnowledgeBase.embed_pending(batch: int = 256, *, max_chunks: int | None = None) -> int
KnowledgeBase.search(query: str, limit: int = 8, *, allowed_path_prefixes=None,
                     include_total: bool = False, **filters) -> list[dict] | dict
```

- `count_chunks` returns exactly `len(chunk_note(document.text) or [Chunk("", document.title)])`, the same count
  `apply` stores, including empty/pathological input. It performs no I/O and uses no estimate.
- `max_chunks=None` preserves drain-all behavior. A nonnegative value bounds work attempted by one call; zero performs
  no model load. When bounded, `batch` must be positive, preventing SQLite's negative-LIMIT behavior from bypassing the
  cap. Committed rounds and failure/search-refresh semantics are unchanged, and repeated calls resume remaining work.
- `allowed_path_prefixes=None` preserves existing unfiltered behavior and the list return type. Otherwise the iterable
  is copied into one immutable tuple of deduplicated, literal, nonempty prefixes. An empty iterable returns no hits;
  an empty string prefix is rejected. Tantivy schema v3 indexes a raw path term and ANDs a zero-score prefix predicate
  into every keyword/rare-term query before candidate limits. SQLite FTS joins the literal prefix predicate before its
  limits. Vector scores for paths outside the snapshot are masked before top-candidate selection. This is not
  post-filtering a result page.
- `include_total=False` preserves the old 200/600 candidate pool and bare result list. `True` uses exhaustive visible
  candidates and returns `{"results": [...], "total": N}`: `total` counts fused documents after source weights,
  text/paper deduplication, and before `limit`; `results` is the requested page. It is therefore an expensive operation
  bounded by the visible index/candidate size, not an unfiltered or estimated count.
- Existing locks still pin one committed index version per search; no manifest or caller-owned predicate is evaluated
  under a lock. Physically staged/inactive documents can coexist but cannot enter hits or totals from another snapshot.

Tests use real SQLite/Tantivy with deterministic fake embedders for pathological chunking, a >600-candidate keyword
fixture, a >600-candidate vector fixture, old/new and staged isolation, literal metacharacter prefixes, SQLite fallback,
partial failure plus bounded retry, and concurrent large replacements. Real-ONNX latency/window measurement is not in
this lane; T0-V owns it.

## Out of scope

Moving code out of `kb.py`; multi-index versions of the folder/vault indexing, desktop Zotero, media/OCR, paper notes,
privacy rules, collections, `similar_notes`/`related`/`duplicates`; per-user HTTP API or auth; the incremental Zotero
Web sync (planned interface only, plan Task 7); MLX changes beyond honouring `model_dir` (M3); PyPI publishing; Trinity's worker, path authorisation
and tenant mapping (checked in Trinity's own lane).

## Way of working

TDD; unit tests in `server/tests` run by `check.sh`; a clean-venv wheel round trip as packaging evidence.

## Notes

Draft upstream issue (D3, not filed):

> **MLX backend ignores VERITAS_DATA.** `mlx_embed.MODEL_DIR` is `Path(__file__).parent / "models" /
> "snowflake-arctic-embed-s"` (`server/mlx_embed.py:13`), while `kb.MODEL_DIR` follows `VERITAS_DATA`
> (`paths.models_dir`). On installs that keep the model under `$VERITAS_DATA/models` (Homebrew, the desktop app) with
> `KB_BACKEND=mlx`, `ArcticMLX()` finds no model, `kb.Embedder` catches the error and silently falls back to
> onnxruntime on the CPU. `mlx_embed.load()` also writes `mlx-weights.npz` into the model folder on first use, so the
> MLX path fails on a read-only model folder. Suggested fix: `ArcticMLX(model_dir)` passed from `kb.Embedder`, and
> keep the extracted weights in memory when the folder is not writable.
