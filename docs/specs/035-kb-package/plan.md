# Plan: spec 035, the index as a reusable package (slice 0)

Status: IMPLEMENTED (Tasks 1-6), revision 2 plus driver answers, 2026-11-20. Spec: `spec.md` (goals R1-R7, driver decisions D1-D8, concurrency
contract). Branch `feat/kb-package` from `d7d48ae` (Release 0.54.8).

This file is the plan as written before implementation, kept as history: the task checklists and code sketches below
are not updated. Where they differ from the code, the implemented contract is `spec.md` ("Concurrency contract") and
"Driver answers and implementation notes" at the end. In particular, a search does not fail fast: searches and writes
on one instance wait on per-instance locks (`_write_lock`, then `_search_lock`), bounded by `search_timeout`, then raise
`ConcurrentUseError` (a `TimeoutError`); `close()` also waits for in-flight reads.

## Revision 2 changelog

Driven by the independent plan review (argo-openai/gpt6sol, "DO NOT PROCEED") and the driver's decisions.

- Wrote `spec.md` first (D8); the open questions are replaced by decisions D1-D8, and the tenant layout
  `<user>/knowledgebase/zotero/index/{kb.sqlite,tantivy}` is stated (D7).
- Task 2: the shared-embedder cache no longer builds the model under the cache lock. Each key gets an in-flight
  `Future`: the first caller builds it outside the lock, concurrent callers for that key wait on the result, other
  keys never wait, and a failed build is dropped so the next call retries (review B1, option A).
- Task 5: no instance mutex around searches or model I/O. Searches take a non-blocking guard (a concurrent search on
  one instance raises `ConcurrentUseError`; it never waits; *superseded by driver answer 1: searches wait, bounded by
  `search_timeout`*). Writes and `embed_pending` open their own short-lived
  connections and share a per-instance write lock, kept because it is needed for correctness (chunk-id reuse; see
  "Verified repo facts"). Reads use their own connections. The calling contract (caller sequences one instance's calls
  and runs them off its event loop) is in spec.md (review B2, adapted per D6).
- Task 5: `apply(add, remove, meta)` is the single atomic write (`BEGIN IMMEDIATE` ... `COMMIT`, `ROLLBACK` on any
  error). Verified that `store_note`, `delete_note` and `stamp` never commit (review B4). Meta stamps go in the same
  transaction, so the later Zotero sync can update documents and its version stamp atomically (review N4).
- Task 5: the claim is released when the constructor fails; `close()` is idempotent and returns only after in-flight
  calls and the searcher's background rebuild have finished (review B3). New `Searcher.close()`.
- Task 4: full audit of `Searcher._refresh/_rebuild/_load/search/similar_to_text` and `KeywordIndex` for global
  access (three sites found: `_rebuild`'s `connect`, two `Embedder()` calls, plus `VECTOR_GATE`). New rebuild
  *generation*: a write that removed rows makes the next search reload in full and discards a background rebuild that
  started before it; tested with a write during a rebuild (review N5). Found during the audit: a write landing during
  a foreground `_refresh` could have its "reload in full" request overwritten; `_refresh` now compares generations
  instead of resetting state (test added).
- Task 1: checked the stash against thread pools and async contexts: nothing in the `_index` chain or in
  `KnowledgeBase` spawns tasks inside the stash scope, and `apply` always sets a fresh stash, so an inherited one is
  never used. Async test added (review N3).
- Dropped the MLX task (old Task 3) from slice 0; the `VERITAS_DATA` bug is a drafted upstream issue in spec.md
  (review N2, D3).
- Task 7 (Zotero sync) stays outside slice 0, interface only, now on top of the atomic `apply` (review N4).
- Acceptance: clean-venv wheel round trip (create, ingest, search, close, reopen), failure and lifecycle tests,
  concurrent first use of the shared model.

## Goal

Make the search index (SQLite + FTS5, Tantivy keyword index, 384-d snowflake-arctic-embed-s vectors, fused ranking)
usable as a library so one process can hold **one index per user**: `KnowledgeBase(db_path, model_dir, ...)` owns its
files and in-memory state, shares nothing mutable with another instance, and shares only the read-only embedding
model. `kb.py`, its CLI, the HTTP server and the on-disk format stay as they are; every existing test passes unchanged.

## Architecture

Nothing moves out of `kb.py`. Each process-wide global that pins one index becomes a *default*: the stateful function
or class gets an optional keyword-only parameter and falls back to the global **at call time**, so the tests that
`monkeypatch.setattr(kb, "DB_PATH", ...)` (and `HOME`, `Embedder`, `index_media`, ...) and `eval.py`'s
`kb.VECTOR_GATE = gate` keep working.

```
                    kb.py (API unchanged; globals are defaults)
  connect(path=None)   Embedder(model_dir=None, backend=None)   shared_embedder(model_dir, backend)  [per-key Future]
  store_note/delete_note: _VEC_STASH ContextVar + vector_stash()
  embed_pending(db, ..., embedder=None)
  Searcher(writer, *, db_path=None, keyword_dir=None, embed_factory=None, vector_gate=None)
           .changed(full=False)  .close()  rebuild generation
                ▲                                         ▲
  legacy callers (no arguments):                 veritas_kb.py (new)
  kb.main, http_api.searcher(), radar_api,       KnowledgeBase: claim(db, tantivy) -> Searcher (search guard)
  bench, eval, tests                             apply(): own connection, BEGIN IMMEDIATE, write lock
                                                 embed_pending(): own connection, write lock, shared embedder
                                                 stats/read/documents/get_meta: own read connections
```

Tenant layout (D7, Trinity's concern): `KnowledgeBase("<user>/knowledgebase/zotero/index/kb.sqlite", model_dir)`;
the Tantivy folder defaults to the sibling `tantivy/`. The model folder is shared and read-only. Trinity runs this in a
separate worker subprocess with its own venv (D1) and passes only the authenticated tenant's fixed paths.

## Verified repo facts

Line numbers are at `d7d48ae`.

Tests and conventions
- `./check.sh` runs `cd server && KB_BACKEND=onnx python -m pytest tests -q -p no:cacheprovider`; CI does the same
  after `pip install -r server/requirements.txt` (Python 3.12). Baseline on this branch: **614 passed, 4 skipped**
  (99.6 s, Linux, sibling venv `../veritas-zotero-sync/server/.venv`; no model needed, the suite never loads it).
- `server/tests/conftest.py` points `KB_SOURCES`, `KB_ZOTERO`, `KB_DB` at a scratch dir before `kb` is imported.
- Tests rebind kb globals: `DB_PATH`, `HOME` (13 files each), `LAYOUT` (8), `VAULT` (9), `index_running` (9),
  `Embedder` (`test_vector_reuse.py:30`), `index_media`, `index_zotero`, `embed_pending`, `PROGRESS_FILE`,
  `STOP_FILE`, `clean`, `CHUNKER_VERSION`, `connect`, `data_dir`. Moving logic out of the `kb` namespace would break
  them; hence parameters only.
- Fake embedders exist: `bench.HashEmbedder` (`bench.py:183`), `CountingEmbedder` (`test_vector_reuse.py:11`),
  `FakeEmbedder` (`test_radar_api.py:17`). Embedder protocol: `(texts, query=False, batch_size=16) -> float32[n,
  384]`, attribute `mlx`.
- Spec convention `docs/specs/NNN-name/{spec,plan}.md`; highest was 034. No pyproject/setup.py/setup.cfg anywhere.

Entry points that must not change
- `kb.py serve` → `http_api.serve`; `http_api.searcher()` keeps one `kb.Searcher(writer=True)` (`http_api.py:202`).
  Every searcher call in `http_api` runs under the global `http_api.LOCK` (`http_api.py:129`; `/search` `:579`,
  `/related` `:588`, `/zotero/items` `:671`, `/duplicates` `:715`, `/similar` `:860`): upstream treats `Searcher` as
  single-threaded.
- `install-service.sh` (macOS LaunchAgent `ai.veritas.server`, `kb.py serve`; no systemd `veritas.service` exists),
  `bin/veritas serve` (`KB_BACKEND=onnx`), Homebrew (`requirements.txt` into a uv venv), PyInstaller (globs every
  `server/*.py`, so a new module is bundled automatically).

Embedding backend
- `kb.USE_MLX = KB_BACKEND == "mlx"` (default mlx, `kb.py:84`). `Embedder.__init__` (`kb.py:415-441`) tries
  `mlx_embed.ArcticMLX()` and on any exception prints `MLX unavailable, using CPU` and opens
  `onnxruntime.InferenceSession(MODEL_DIR/"onnx"/"model.onnx")`, `intra_op_num_threads=KB_THREADS (4)`. So Linux
  works today, noisily. No other backend exists. The ONNX path only reads `tokenizer.json` and `onnx/model.onnx`.
- `mlx_embed.MODEL_DIR` ignores `VERITAS_DATA` and `load()` writes `mlx-weights.npz` (`mlx_embed.py:13,42-45`): left
  alone (D3).
- GPU vector scans: `_mx` chosen once per process (`kb.py:1101-1106`), read-only afterwards.

Transactions (review B4)
- Python's `sqlite3` here is in legacy transaction mode (`isolation_level == ""`, SQLite 3.45.1): an implicit `BEGIN`
  before the first INSERT/UPDATE/DELETE, nothing until `commit()`/`rollback()`.
- `delete_note` (`kb.py:478-489`): SELECTs (stash), DELETEs; no commit. `store_note` (`:769-787`): `delete_note`,
  INSERTs into notes/links/chunks/chunks_fts/vecs; no commit. `stamp` (`:1057-1058`): one INSERT OR REPLACE; no commit.
  `chunk_note`/`zotero.plain_title` are pure. So one explicit transaction around a batch is atomic, and FTS5
  (`contentless_delete=1`, needs SQLite >= 3.43) rolls back with it.
- `connect()` (`kb.py:136-153`) runs `executescript(SCHEMA)` (which commits) and one-time migrations
  (`_move_vectors_out`: `BEGIN IMMEDIATE` ... `VACUUM`; Windows `posix_paths` commits) **before** returning, i.e.
  before any batch begins.
- `embed_pending` (`kb.py:1061-1092`) per batch: SELECT chunks without vectors (autocommit), embed (seconds), INSERT
  OR REPLACE vecs by chunk id, commit. Not one transaction. Chunk ids are `INTEGER PRIMARY KEY` without
  `AUTOINCREMENT`: verified that deleting the highest row and inserting gives the new row the **same id**. A removal
  plus insert during an embedding batch would store the old text's vector under the new chunk. Upstream avoids it with
  one indexer per data dir (`LOCK_FILE`, `kb.py:505,625-634`). This is why KnowledgeBase keeps a per-instance write
  lock across `apply` and `embed_pending`.

Searcher paths (review N5), full audit
- `__init__` (`kb.py:1130-1150`): `connect(keep=True)` [global], `KeywordIndex(data_dir()/"tantivy", writer)`
  [global].
- `_refresh` (`:1154-1180`): swaps `self._rebuilt` in; reads meta via `self.db`; at most one check a minute
  (`:1167`); `self.keywords.sync(self.db)`; `_load(full)`; starts a daemon `_rebuild` thread (`:1176-1178`) hourly or
  when stale rows > max(2000, live/20). Nothing else global.
- `_rebuild` (`:1182-1192`): `background_priority()`, `connect(keep=True)` [global], `_load(full=True)`, closes it,
  publishes `self._rebuilt`. A rebuild that started before a write can publish an older matrix; with id reuse that
  older matrix holds a wrong vector for a reused id, and `_load(full=False)` appends only `id > max_id`, so an
  in-place reused id is never corrected until the next full reload.
- `_load`, `_scores`, `_allowed`, `_fts*`, `_filter_ids`: `self.db`, `DIM`, `_mx` only.
- `search` (`:1284-1358`): `Embedder()` [global, `:1305`], `VECTOR_GATE` [global, `:1309`], `SOURCE_WEIGHTS`,
  `STOPWORDS`, `same_paper_key`, `snippet` (constants/pure).
- `similar_to_text` (`:1387-1413`): `Embedder()` [global, `:1394`]; `note_info(self.db, ...)`.
- `similar_notes`, `related` (`:1360`, `:1485`): `note_path()`/`links()`/`shared_tags()` → `connect()` and `LAYOUT`
  [global]: not exposed by KnowledgeBase. `duplicates` uses `self.db` only; not exposed in slice 0.
- `KeywordIndex` (`keyword_index.py`): path-scoped; only the writer syncs/rebuilds its folder; no module state.

Concurrency in the stash chain (review N3)
- The only executors in `kb.py` are `index_media`'s `ThreadPoolExecutor(2)` (`kb.py:792-807`), whose workers only call
  `media.extract` (no `store_note`/`delete_note`; executor threads also do not inherit contextvars), and the
  searcher's rebuild thread (no writes). No `asyncio` anywhere in `kb.py`/`keyword_index.py`. KnowledgeBase spawns
  nothing inside a write. `asyncio.to_thread` copies the caller's context into the thread, so a stash set by an outer
  caller would be inherited; `apply` therefore always sets its own fresh stash.

Import side effects
- `kb` runs `listen_first.if_serving(sys.argv)` at import (`kb.py:24-27`), which binds port 27182 whenever
  `argv[1:2] == ["serve"]` (`listen_first.py:113-119`), whatever the program; and `reload_layout()` (reads
  `KB_SOURCES`/`data/sources.json`, probes Zotero prefs; read-only). Accepted in the worker (D5); argv neutralised.

## Globals that pin one process to one index

| Global | Where | Slice-0 treatment |
|---|---|---|
| `DB_PATH` (env `KB_DB`) | `kb.py:79` | `connect(path=)`; KB passes its own |
| `HOME`, `data_dir()` | `kb.py:71,74` | `Searcher(keyword_dir=)`; KB never calls `data_dir()` |
| `MODEL_DIR` | `kb.py:80` | `Embedder(model_dir=)`, `shared_embedder()` |
| `USE_MLX` (`KB_BACKEND`) | `kb.py:84` | `Embedder(backend=)`, `resolve_backend()` |
| `VECTOR_GATE` | `kb.py:88` | `Searcher(vector_gate=)`, else global at call time |
| `_VEC_STASH` | `kb.py:470` | `ContextVar` + `vector_stash()` |
| `_mx` | `kb.py:1101` | unchanged (read-only capability) |
| `_request` thread-local | `kb.py:133` | unchanged (KB passes `keep=True`, closes its own) |
| `LAYOUT`, `VAULT`, `reload_layout()`, `NO_ZOTERO` | `kb.py:59-70` | app-level; KB never reads them |
| `zotero.ZOTERO` (`KB_ZOTERO`) | `zotero.py:29` | app-level (`zotero._LIBRARY` is already a ContextVar) |
| `PROGRESS_FILE`, `LOCK_FILE`, `STOP`, `STOP_FILE` | `kb.py:504-509` | app-level; KB has its own write lock |
| `_CODE`/`code_is_current()` | `kb.py:494-501` | app-level (`kb.index()` only) |
| `_collections_cache` | `kb.py:1037` | unchanged; not exposed |
| `PRIVACY_FILE`, `_private_cache` (not keyed by db) | `kb.py:1633-1634` | app-level; later slice |
| `sources.FILE`, `OUTPUT_DEFAULT`, `ZOTERO_PROFILES` | `sources.py:35,36,56` | app-level |
| `abstracts._cache`, `_lock`, file in `kb.data_dir()` | `abstracts.py:25-30` | app-level |
| `zotero_web.OPENER`, `_secrets_file()`, `get_key()` | `zotero_web.py:33,95,116` | Task 7 takes `api_key`, `opener` |
| `paths.HOME`, `VERITAS_DATA` | `paths.py:12-24` | app-level |
| `mlx_embed.MODEL_DIR`, `WEIGHTS` | `mlx_embed.py:13-14` | untouched (D3; drafted issue) |
| `listen_first.if_serving(sys.argv)`, `KB_PORT` | `kb.py:24-27` | neutral argv in `veritas_kb` |
| `http_api.SEARCHER`, `http_api.LOCK` | `http_api.py:129,136` | unchanged |
| `media._PDFIUM_LOCK` | `media.py:31` | unchanged |
| `KB_THREADS` | `kb.py:438` | read once per shared embedder |

## File structure

| File | Change | Size |
|---|---|---|
| `server/kb.py` | params on `connect`, `Embedder`, `embed_pending`, `Searcher`, `stats`; `resolve_backend`, `shared_embedder` (per-key Future), `vector_stash`; `_VEC_STASH` ContextVar; `Searcher.changed(full)`, `Searcher.close()`, rebuild generation | ~+90 / −15 |
| `server/veritas_kb.py` | new: `Document`, `KnowledgeBase`, `ConcurrentUseError`, `ClosedError` | ~230 |
| `server/pyproject.toml` | new | ~40 |
| `server/tests/test_kb_params.py` | new: kb parameters default to the globals; stash; shared embedder; Searcher generation/close | ~200 |
| `server/tests/test_knowledge_base.py` | new: isolation, atomicity, lifecycle, concurrency, compatibility, import guard | ~300 |
| `server/tests/test_packaging.py` | new: module list complete; opt-in clean-venv wheel round trip | ~90 |
| `server/README.md` | "Using the index as a library" | ~+25 |

No change to `mlx_embed.py`, `zotero_web.py`, `requirements.txt`, `http_api.py`, packaging, or any non-server part.

## Tasks

TDD: test first, red, implement, green, then the whole suite (`cd server && KB_BACKEND=onnx python -m pytest tests
-q -p no:cacheprovider`) before ticking. All new tests use fake embedders (no model).

### Task 1: `connect(path=)` and the vector stash as a ContextVar

- [ ] `test_kb_params.py::test_connect_path_overrides_db_path`: creates that file with the full schema; the
      `kb.DB_PATH` file is not created.
- [ ] `::test_connect_default_follows_monkeypatched_db_path` (pins today's behaviour).
- [ ] `::test_vector_stash_is_per_thread`: thread A in `vector_stash()` deletes a note with text T from db A; thread B
      in its own `vector_stash()` stores T into db B; B gets no vector for it (two `threading.Event`s sequence it).
- [ ] `::test_vector_stash_not_shared_by_async_tasks`: inside an outer `vector_stash()`, `asyncio.gather` two
      `asyncio.to_thread` calls that each enter `vector_stash()` and stash/store different texts; each sees only its
      own entries, and the outer stash is unchanged.
- [ ] `::test_index_run_still_reuses_vectors`: the existing `test_vector_reuse.py` passes unchanged (run it).
- [ ] Implement:

```python
from contextvars import ContextVar
from contextlib import contextmanager

# During a write (an index run, or KnowledgeBase.apply), the vectors of deleted rows keyed by the text they were made
# from. Per context, so two indexes written at once never hand vectors to each other. Each write scope sets a fresh
# dict; never spawn tasks that write inside it.
_VEC_STASH: ContextVar[dict[str, bytes] | None] = ContextVar("kb_vec_stash", default=None)

@contextmanager
def vector_stash():
    token = _VEC_STASH.set({})
    try:
        yield
    finally:
        _VEC_STASH.reset(token)

def connect(*, keep: bool = False, path: Path | None = None) -> sqlite3.Connection:
    path = Path(path) if path is not None else DB_PATH   # read at call time
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=60, check_same_thread=False)
    ...  # unchanged
```

  `delete_note`: `stash = _VEC_STASH.get()`; `store_note`: `stash.pop(...) if stash is not None else None`;
  `_index`: `with vector_stash(): return _index_stages(...)`.

### Task 2: backend choice and one shared embedder per model, no lock across loading

- [ ] `::test_resolve_backend`: `None` follows `kb.USE_MLX`; `"auto"` → `"onnx"` with `sys.platform` patched to
      `"linux"`, `"mlx"` for `"darwin"`; unknown → `ValueError`.
- [ ] `::test_auto_backend_off_macos_never_tries_mlx`: `Embedder(dir, "auto")` on linux with a tiny real
      `tokenizer.json` (built with `tokenizers` WordLevel in the test) and a patched `onnxruntime.InferenceSession`:
      `mlx_embed` not imported, nothing on stderr.
- [ ] `::test_embedder_defaults_unchanged`: `Embedder()` opens `kb.MODEL_DIR/...` (patched loaders record paths).
- [ ] `::test_shared_embedder_one_build_per_key_concurrently`: patch `kb.Embedder` with a fake whose constructor
      sleeps 0.2 s and counts; 8 threads call `shared_embedder(d)` at once (and `d/"."`): one build, all get the same
      object.
- [ ] `::test_shared_embedder_keys_do_not_wait_for_each_other`: fake constructor waits on a 2-party
      `threading.Barrier(timeout=2)`; `shared_embedder(d1)` and `shared_embedder(d2)` in two threads both succeed
      (they would time out if construction were serialised).
- [ ] `::test_shared_embedder_failed_build_retries`: first construction raises; waiters for that key get the error;
      the next call builds again and succeeds.
- [ ] `::test_shared_embedder_thread_safe_encode`: one shared `Embedder` (tiny tokenizer, fake session returning
      zeros) called from 8 threads × 20 batches without exceptions (the tokenizer is configured only in `__init__`).
- [ ] Implement:

```python
def resolve_backend(backend: str | None = None) -> str:
    """'mlx' or 'onnx'. None keeps today's choice (KB_BACKEND, default mlx with a CPU fallback); 'auto' is MLX on
    macOS only, so other systems never try it."""
    if not backend:
        return "mlx" if USE_MLX else "onnx"
    if backend == "auto":
        return "mlx" if sys.platform == "darwin" else "onnx"
    if backend not in ("mlx", "onnx"):
        raise ValueError(f"unknown embedding backend {backend!r}")
    return backend

class Embedder:
    def __init__(self, model_dir: Path | None = None, backend: str | None = None) -> None:
        model_dir = Path(model_dir) if model_dir is not None else MODEL_DIR
        ...  # tokenizer from model_dir / "tokenizer.json", unchanged otherwise
        self.mlx = None
        if resolve_backend(backend) == "mlx":
            try:
                from mlx_embed import ArcticMLX
                self.mlx = ArcticMLX()          # unchanged (D3)
                return
            except Exception as error: ...      # unchanged fallback
        ...  # InferenceSession(str(model_dir / "onnx" / "model.onnx"), ...)

# Read-only models shared by every index in the process. The lock guards the dict only; a model loads outside it, and
# callers asking for a model that is still loading wait on that model's Future, not on the lock.
_EMBEDDERS: dict[tuple[str, str], Future] = {}
_EMBEDDERS_LOCK = threading.Lock()

def shared_embedder(model_dir: Path | None = None, backend: str | None = None) -> "Embedder":
    key = (str(Path(model_dir or MODEL_DIR).resolve()), resolve_backend(backend))
    with _EMBEDDERS_LOCK:
        future = _EMBEDDERS.get(key)
        builder = future is None
        if builder:
            future = _EMBEDDERS[key] = Future()
    if builder:
        try:
            future.set_result(Embedder(Path(key[0]), key[1]))   # kb.Embedder looked up at call time
        except BaseException as error:
            with _EMBEDDERS_LOCK:
                _EMBEDDERS.pop(key, None)                       # the next call tries again
            future.set_exception(error)
            raise
    return future.result()
```

  MLX thread-safety is not addressed (MLX is not used by the worker; macOS hosts with several instances on the MLX
  backend are out of scope, noted in the README).

### Task 3: `Searcher` and `embed_pending` take their index and model; rebuild generation; close

- [ ] `::test_searcher_db_path_and_keyword_dir`: `Searcher(writer=True, db_path=a, keyword_dir=ka)` creates `a` and
      `ka/` only; `kb.DB_PATH` and `kb.data_dir()/"tantivy"` stay absent, also after a forced `_rebuild()`.
- [ ] `::test_searcher_vector_gate_override` (gate 0.99 drops a vector hit the default keeps).
- [ ] `::test_embed_pending_uses_given_embedder` (no `kb.Embedder` construction).
- [ ] `::test_changed_sees_writes_at_once`: write + stamp within 60 s of a search, `changed()`, the next search sees it.
- [ ] `::test_reused_chunk_id_gets_fresh_vector`: index note X (highest chunk id k); search; delete X and store Y so
      that Y's chunk reuses id k with a different vector; `changed(full=True)`; a vector-only query near Y returns Y
      and one near X returns nothing.
- [ ] `::test_write_during_rebuild_is_not_lost`: patch `Searcher._load` on the shadow so `_rebuild` blocks on an
      Event; start a rebuild; replace a note (id reuse) and `changed(full=True)`; release the Event; the next search
      reflects the new note (the stale shadow is discarded, generation mismatch).
- [ ] `::test_searcher_close_waits_for_rebuild`: `close()` started while a rebuild blocks returns only after the
      Event is released; afterwards no thread is alive and `searcher.db` is closed; a second `close()` is a no-op.
- [ ] Implement:

```python
class Searcher:
    def __init__(self, writer=False, *, db_path=None, keyword_dir=None, embed_factory=None, vector_gate=None):
        from keyword_index import KeywordIndex
        self.db_path = db_path                                    # None: kb.DB_PATH, as today
        self.db = connect(keep=True, path=db_path)
        self.keywords = KeywordIndex(keyword_dir or data_dir() / "tantivy", writer)
        self._embed_factory, self.vector_gate = embed_factory, vector_gate
        self._generation, self._loaded_generation = 0, -1
        self._rebuild_thread, self._closed = None, False
        ...  # rest unchanged

    def _embedder(self):
        if self.embed is None:
            self.embed = self._embed_factory() if self._embed_factory else Embedder()
        return self.embed

    def changed(self, full: bool = False) -> None:
        """Look at the index again on the next call. `full` (rows were removed, so chunk ids may be reused): reload
        every vector and drop a background rebuild that started before this."""
        self.checked_at = 0.0
        if full:
            self._generation += 1      # an int bump by the writer thread; _refresh compares, never resets it

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        thread = self._rebuild_thread
        if thread is not None:
            thread.join()
        self.db.close()
```

  `_refresh`: `generation = self._generation` read once at the start; swap a rebuilt shadow only `if rebuilt[0] ==
  generation`; load in full when `generation != self._loaded_generation` (or on first use), and set
  `self._loaded_generation = generation` at the end. A `changed(full=True)` that lands *during* a refresh therefore
  forces a full load on the next one instead of being overwritten (`test_changed_during_refresh_forces_full_load`:
  patch `_load` to call `changed(full=True)` mid-refresh, then assert the next refresh is full). Never start a rebuild
  when `_closed`; keep the thread in `self._rebuild_thread`. `_rebuild`: `generation = self._generation` at start,
  `shadow.db = connect(keep=True, path=self.db_path)`, publish `self._rebuilt = (generation, shadow)`. `search` and
  `similar_to_text` use `self._embedder()`; `search` uses `VECTOR_GATE if self.vector_gate is None else
  self.vector_gate`. `embed_pending(..., *, embedder=None)`: `embed = embedder or Embedder()`. `stats(db=None)`:
  `db = db or connect()` (output unchanged). `radar_api.py:105` (`searcher.embed = kb.Embedder()`) keeps working.
  The legacy server never calls `changed`/`close`, so its behaviour is unchanged.

### Task 4: `KnowledgeBase` (`server/veritas_kb.py`)

Tests in `test_knowledge_base.py` (local hash embedder; paths follow D7: `tmp/<user>/knowledgebase/zotero/index/`):

Isolation
- [ ] `test_two_instances_are_isolated`: apply into A; `B.search(...) == []`; `A.search(...)` finds it; after
      `A.embed_pending()`, `B.stats()["chunks_with_vectors"] == 0` and `B.similar_to_text(...) == []`.
- [ ] `test_instances_touch_only_their_own_files`: A's files only under A's index dir, B's under B's; the module index
      (`kb.connect()` on conftest `KB_DB`) has no notes; `kb.DB_PATH` unchanged.
- [ ] `test_concurrent_tenants`: A and B each get 50 documents and 20 searches from their own threads at once; row
      counts, meta stamps, Tantivy hits and vector hits never cross.

Atomicity (review B4)
- [ ] `test_apply_is_all_or_nothing`: patch `kb.store_note` to raise on the 2nd document of 3: `apply` raises; no
      notes/chunks/fts/vecs rows from the batch; meta stamp in the same call not written; a later `apply` of other
      documents commits only those; `search` works.
- [ ] `test_apply_rolls_back_removals_too`: a failing call that removes P and adds Q leaves P intact.
- [ ] `test_reapply_reuses_vectors`: the same text re-added under a new path costs no embedding (counting embedder).

Lifecycle (review B3)
- [ ] `test_failed_constructor_releases_claim`: patch `kb.Searcher` to raise once: the constructor raises; a second
      `KnowledgeBase` on the same paths opens.
- [ ] `test_same_files_twice_refused`: a second live instance on the same `db_path` or `keyword_dir` raises
      `RuntimeError`; after `close()` it opens.
- [ ] `test_close_is_idempotent_and_waits`: `close()` twice is fine; `close()` while an `apply` (blocked inside a patched
      `store_note`) and a rebuild are in flight returns only after both finish; calls after close raise `ClosedError`;
      reopen sees the committed data.

Concurrency contract
- [ ] ~~`test_concurrent_search_on_one_instance_fails_fast`~~ (superseded by driver answer 1):
      `test_concurrent_search_on_one_instance_waits` (a second search waits for the blocked first one, then both
      return), `test_search_wait_is_bounded` (`search_timeout` exceeded: `ConcurrentUseError`, a `TimeoutError`; the
      instance stays usable), `test_instances_never_share_a_search_lock`.
- [ ] `test_search_during_write_is_consistent`: an `apply` that replaces documents runs while searches loop on the same
      instance; every hit's path exists in the db at the end or is from the committed old state, never a half batch.
- [ ] `test_embed_pending_serialised_with_apply`: `apply` started while `embed_pending` is inside the fake embedder
      waits until the batch is written; no vector is stored under a chunk id whose text changed.

Compatibility and import
- [ ] `test_on_disk_format_is_veritas`: a KB-made db opens through the legacy path (patch `kb.DB_PATH`/`kb.HOME`,
      Tantivy at `data/tantivy`) and `kb.Searcher(writer=True).search` finds the document; `sqlite_master` SQL equals a
      `kb.connect()`-made db's.
- [ ] `test_import_never_listens`: subprocess with `sys.argv = ["host", "serve", "--port", <free port>]` imports
      `veritas_kb`; the port is still free.
- [ ] `test_read_and_documents`: `read()` pages indexed text like `read_note`; `documents()` maps path → (version, size).

Implementation sketch (historical, pre-implementation: its fail-fast `_search_guard`, `_searching` and `close()` are
superseded by driver answer 1; see `server/veritas_kb.py` for the implemented locking and lifecycle):

```python
"""The search index as a library: one KnowledgeBase per index, many in one process (spec 035).

Each instance owns one SQLite file, one Tantivy folder and one Searcher and never reads kb's module settings
(DB_PATH, HOME, the folder list, the key store); only the embedding model is shared (kb.shared_embedder), read-only.
Calls are blocking: run them off an event loop. Sequence searches on one instance yourself (a concurrent one raises
ConcurrentUseError); writes on one instance queue behind each other; different instances never wait for each other.
"""
from __future__ import annotations
import sys, threading, time
from dataclasses import dataclass, field
from pathlib import Path

_argv, sys.argv = sys.argv, sys.argv[:1]     # kb listens on its port at import when argv[1] is "serve"
try:
    import kb
finally:
    sys.argv = _argv

class ConcurrentUseError(RuntimeError): ...
class ClosedError(RuntimeError): ...

_OPEN: set[Path] = set()
_OPEN_LOCK = threading.Lock()                 # guards _OPEN only

@dataclass
class Document:
    path: str                  # "zotero/ABCD1234", "uploads/report.md" ...
    title: str
    text: str                  # Markdown, split at headings like a note
    source: str = "zotero"     # kb.SOURCE_WEIGHTS; "zotero"/"pdf" also keep `kb.py index` from deleting it
    folder: str = ""
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    meta: dict | None = None
    version: float | None = None   # change signature (notes.mtime); default now

class KnowledgeBase:
    def __init__(self, db_path, model_dir=None, *, keyword_dir=None, backend="auto", embedder=None,
                 vector_gate=None):
        self.db_path = Path(db_path).resolve()
        self.keyword_dir = Path(keyword_dir).resolve() if keyword_dir else self.db_path.parent / "tantivy"
        self.model_dir = Path(model_dir) if model_dir else kb.MODEL_DIR
        self.backend, self._embedder = backend, embedder
        self._write_lock = threading.Lock()     # apply + embed_pending: see spec "Concurrency contract"
        self._search_guard = threading.Lock()   # never waited on (acquire(blocking=False)), except by close()
        self._state = threading.Lock()          # guards _closed only
        self._closed = False
        self._claim()                           # RuntimeError if either path is held in this process
        try:
            self._searcher = kb.Searcher(writer=True, db_path=self.db_path, keyword_dir=self.keyword_dir,
                                         embed_factory=lambda: self.embedder, vector_gate=vector_gate)
        except BaseException:
            self._release()
            raise

    @property
    def embedder(self):
        return self._embedder if self._embedder is not None else kb.shared_embedder(self.model_dir, self.backend)

    def _connection(self):
        return kb.connect(keep=True, path=self.db_path)

    def apply(self, add=(), remove=(), meta: dict[str, str] | None = None) -> dict:
        """One transaction: store `add`, delete `remove`, set `meta`; all or nothing."""
        add, remove = list(add), list(remove)
        with self._write_lock, kb.vector_stash():
            self._check_open()             # checked under the lock: close() may have run while we waited
            db = self._connection()
            try:
                db.execute("BEGIN IMMEDIATE")
                removed = 0
                for path in remove:
                    removed += bool(db.execute("SELECT 1 FROM notes WHERE path=?", (kb.posix(path),)).fetchone())
                    kb.delete_note(db, kb.posix(path))
                for d in add:
                    kb.store_note(db, kb.posix(d.path), d.title, d.folder, d.source, sorted(set(d.tags)),
                                  sorted(set(d.links)), time.time() if d.version is None else d.version,
                                  len(d.text), "", d.meta, d.text)
                for key, value in (meta or {}).items():
                    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, str(value)))
                kb.stamp(db, "indexed_at")
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()
        self._searcher.changed(full=bool(removed or add))   # replaced/removed rows may reuse chunk ids
        return {"added": len(add), "removed": removed}

    def add_documents(self, docs) -> int: return self.apply(add=list(docs))["added"]
    def remove_document(self, path) -> bool: return self.apply(remove=[path])["removed"] == 1

    def embed_pending(self, batch: int = 256) -> int:
        with self._write_lock:
            self._check_open()
            db = self._connection()
            try:
                n = kb.embed_pending(db, verbose=False, batch=batch, embedder=self.embedder)
            finally:
                db.close()
        self._searcher.changed()
        return n

    def search(self, query, limit=8, **filters) -> list[dict]:
        return self._searching(lambda s: s.search(query, limit, **filters))

    def similar_to_text(self, text, exclude=None, limit=8) -> list[dict]:
        return self._searching(lambda s: s.similar_to_text(text, exclude, limit))

    def _searching(self, call):
        if not self._search_guard.acquire(blocking=False):
            self._check_open()             # closing (close() holds the guard): ClosedError, not ConcurrentUseError
            raise ConcurrentUseError("one search at a time per KnowledgeBase; sequence calls per instance")
        try:
            self._check_open()
            return call(self._searcher)
        finally:
            self._search_guard.release()

    def read(self, path, max_chars=30000, offset=0) -> dict: ...      # own connection; chunks in order; kb._page
    def documents(self) -> dict[str, tuple[float, int]]: ...          # own connection
    def get_meta(self, key) -> str | None: ...                        # own connection
    def stats(self) -> dict: ...                                      # own connection; kb.stats(db) minus "vault"

    def close(self) -> None:
        with self._state:
            if self._closed:
                return
            self._closed = True            # new calls raise ClosedError from here on
        with self._write_lock, self._search_guard:   # wait for in-flight calls
            self._searcher.close()         # joins the background rebuild, closes its connection
        self._release()                    # files may be opened again only now

    def __enter__(self): return self
    def __exit__(self, *exc): self.close()
```

  Locks held across I/O, and why: `_write_lock` (per instance, writes and embedding only; the chunk-id reuse fact
  above makes it a correctness requirement); `close()` waits on both per-instance locks, by design. Nothing
  process-wide is held across I/O: `_OPEN_LOCK` and `kb._EMBEDDERS_LOCK` guard dicts only. A write with a 60 s
  SQLite busy timeout can still wait on another process writing the same file; Trinity has one worker per index.

### Task 5: packaging (`server/pyproject.toml`)

- [ ] `test_packaging.py::test_py_modules_cover_the_engine`: parse with `tomllib`; every listed module exists; the
      module-level imports of each listed module that name a sibling server module are listed too; `veritas_kb` is.
- [ ] `::test_extras_are_in_requirements`: each extra's distribution appears in `requirements.txt`.
- [ ] `::test_wheel_round_trip` (opt-in `VERITAS_WHEEL_TEST=1`, needs network for dependencies): `pip wheel server
      --no-deps -w tmp/dist`; `python -m venv tmp/venv`; install the wheel (`[onnx]`); in `cwd=tmp` (outside the
      checkout, `-I` isolated mode) run a script that creates a KnowledgeBase at `tmp/u/knowledgebase/zotero/index/
      kb.sqlite` with a hash embedder, applies 3 documents, `embed_pending()`, searches (keyword and vector hits),
      closes, reopens, searches again, and asserts `kb.__file__` is inside the venv. Recorded as evidence in the PR.
- [ ] Implement:

```toml
[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[project]
name = "veritas-kb"
version = "0.1.0"
description = "Veritas search index (SQLite FTS5 + Tantivy + snowflake-arctic-embed-s) as a library"
requires-python = ">=3.11"
license = "MIT"
dependencies = ["numpy>=2", "tantivy>=0.25", "tokenizers>=0.20"]

[project.optional-dependencies]
onnx  = ["onnxruntime>=1.20"]                      # the embedder off macOS (and on macOS without MLX)
mlx   = ["mlx>=0.20; sys_platform == 'darwin'", "onnx>=1.16; sys_platform == 'darwin'"]  # onnx: weight extraction
media = ["pypdfium2>=4", "pillow>=10"]             # only kb.index()'s PDF/image stage
test  = ["pytest>=8", "onnxruntime>=1.20"]

[tool.setuptools]
# Flat: the server's modules import each other as top-level modules (import media, import zotero). Only the engine and
# what it imports at module level; the HTTP server and the app run from a checkout.
py-modules = ["veritas_kb", "kb", "keyword_index", "mlx_embed", "listen_first", "media", "sources", "connectors",
              "abstracts", "zotero", "zotero_web", "paths"]
```

  Runtime requirement documented in the README: SQLite >= 3.43 in Python's `sqlite3` (FTS5 `contentless_delete`).

### Task 6: docs and wrap-up

- [ ] `server/README.md`: "Using the index as a library": install line, 12-line example with the D7 layout, what is
      shared (the model), the concurrency contract, the read-only ONNX model folder, MLX caveat.
- [ ] Full suite green; `git diff --stat` reviewed: only `server/kb.py`, the new files, README, `docs/specs/035-*`.

### Task 7 (not in slice 0): incremental Zotero Web sync, interface only

```python
@dataclass(frozen=True)
class Library:
    id: str                                  # numeric user or group id
    type: Literal["user", "group"] = "user"
    name: str = "zotero-online"              # paths f"{name}:/zotero/KEY"; stamp f"zotero_web_version:{name}"

@dataclass
class SyncResult:
    version: int; previous: int
    added: int = 0; updated: int = 0; removed: int = 0
    unchanged: bool = False                  # 304
    errors: list[str] = field(default_factory=list)

def sync(kb: KnowledgeBase, library: Library, api_key: str, *, opener=None, batch: int = 50,
         embed: bool = True) -> SyncResult: ...
```

Protocol (Zotero Web API v3): `since = kb.get_meta(stamp) or 0`; `GET .../items?since=&format=versions` with
`If-Modified-Since-Version` (304 → unchanged; else changed keys and `Last-Modified-Version = new`);
`GET .../deleted?since=`; changed keys fetched `?itemKey=` 50 at a time; a changed or deleted child marks its parent
dirty (parent found via `parentItem`, or `meta.child_keys` for deleted children); later requests send
`If-Unmodified-Since-Version: new` and restart on 412 (max 3); honour `Backoff`/`Retry-After` on 429/503; the API key
is a parameter, never the key store. Writes and the new version stamp go through **one** `kb.apply(add, remove,
meta={stamp: new})`, so a failed run leaves the old stamp and the next run redoes the same delta (idempotent). For
very large first syncs that one transaction may be split into chunks committed *without* the stamp, followed by a
final `apply(meta=...)`; re-running a chunk is harmless because `store_note` replaces by path. Needs
`zotero_web.Client(library_type=)`, 304 handling, `versions/deleted/items_by_key/children`, and `item_document()`
split out of `documents()`. Planned separately.

## Acceptance criteria

1. The 614 existing server tests pass without edits, plus all new tests.
2. Isolation: two instances at D7 paths, concurrently written and searched from separate threads, never share rows,
   meta stamps, Tantivy hits or vector hits; the module index is untouched.
3. Atomicity: a batch whose 2nd document fails leaves no trace (documents, removals, stamps) and the instance stays
   usable.
4. Lifecycle: constructor failure releases the claim; `close()` is idempotent, waits for in-flight calls and the
   background rebuild, and the same paths reopen with committed data.
5. Writes during a background rebuild and chunk-id reuse never leave a stale vector visible after the write returns.
6. Shared model: concurrent first use of one key builds once; different keys build in parallel; a failed build is
   retried; no process-wide lock is held during a build.
7. `backend="auto"` on Linux uses onnxruntime with no MLX attempt or warning; `kb.Embedder()` is unchanged; the ONNX
   model folder can be read-only.
8. A KnowledgeBase-written database is a Veritas database (legacy `kb.Searcher` finds its documents; same schema).
9. Clean-venv wheel round trip (create, ingest, embed, search, close, reopen, search) passes outside the checkout.
10. `kb.py index|search|serve`, `bin/veritas`, the LaunchAgent, Homebrew and PyInstaller need no change.

## Out of scope

Moving code out of `kb.py` or a real package layout; folder/vault indexing per instance, desktop Zotero, media/OCR,
paper notes, privacy rules, collections, `similar_notes`/`related`/`duplicates`; per-user HTTP API or auth; MLX
changes (D3) and MLX thread-safety; Task 7; PyPI; Trinity's worker, tenant-to-path mapping and default-deny path
authorisation (Trinity lane: the worker must accept only the authenticated tenant's fixed paths and run calls off its
event loop).

## Driver answers (2026-11-20) and implementation notes

1. Searches on one instance **wait** on a per-instance lock, bounded by `KnowledgeBase(search_timeout=60.0)`, then
   raise `ConcurrentUseError(TimeoutError)`; different instances never share it (spec D9, concurrency contract).
2. Full vector reload after replacing writes: accepted. Implemented as `changed(full=True)` only when the write
   deleted chunk rows (removals or replacements), the only case in which ids can be reused; a pure add appends.
3. Wheel round trip stays opt-in (`VERITAS_WHEEL_TEST=1`); it builds from a copy of `server/` so the checkout gets no
   `build/` or `*.egg-info`.

Found while implementing (beyond the plan):
- `KeywordIndex.sync` diffs id sets only, so a reused chunk id kept the old text's Tantivy entry. `sync(db, replaced)`
  re-indexes deleted ids that exist again; `Searcher.changed(full, replaced=ids)` carries them, and `apply` passes the
  ids of every chunk it deleted (`test_reused_chunk_id_gets_fresh_keywords`). The legacy server never passes any.
- `kb` stats `paper_notes.py` and `zotero_files.py` at import (`_CODE`), and `listen_first` imports `web_origins`, so
  all three are in `py-modules` (`test_py_modules_hold_the_files_kb_checks_at_import`).
- `mlx`/`onnx` (the `[mlx]` extra) are not in `requirements.txt` (the app bundles exclude MLX); the extras test skips
  darwin-only requirements and checks they carry the marker. `setuptools>=77` for the SPDX `license` string.
- `KnowledgeBase.embed_pending` returns 0 without loading the model when nothing is pending; `read` also takes
  `heading`.

Original open questions:

1. **Search guard behaviour** (answered: searches wait; driver answer 1). The plan makes a second concurrent search on one instance raise
   `ConcurrentUseError` rather than wait (no mutex across I/O). If you'd rather it waited (a blocking per-instance
   search lock, as upstream's `http_api.LOCK` does globally), say so; Trinity's worker sequencing makes the two
   equivalent in correct use.
2. **Full reload after every replacing write.** `changed(full=True)` reloads all vectors on the next search after any
   write that added or removed documents (cheap for per-user indexes of thousands of chunks, ~1-2 s at upstream's
   290k). OK, or should it trigger only when a reused id is actually detected (compare max ids before and after)?
3. **Wheel round-trip test needs network** for numpy/tantivy/tokenizers/onnxruntime. Is it acceptable to keep it
   opt-in (`VERITAS_WHEEL_TEST=1`) and attach its output as PR evidence, or should CI run it?
