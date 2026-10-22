"""Search index over the Obsidian vault and the Zotero library, for LLM agents and the Obsidian plugin.

Notes are split at headings into chunks of about CHUNK_CHARS. Each chunk goes into an SQLite FTS5 table
(keyword search, BM25) and gets a 384-d snowflake-arctic-embed-s vector (meaning search, run locally with
onnxruntime). A search runs both, fuses the two rankings (reciprocal rank fusion), scales by the note's
source weight and returns at most two chunks per note.

Re-indexing is incremental: a note is re-chunked only when its mtime or size changed.

CLI:
  kb.py index [--full]            build or update the index
  kb.py search "query" [-k 8] [--source ai_notes] [--folder Notion] [--tag x]
  kb.py read "path/in/vault.md"
  kb.py links "path/in/vault.md"
  kb.py related "path/in/vault.md"
  kb.py serve [--port 27182]      local HTTP API for the Obsidian plugin (http_api.py)
  kb.py recent [--days 7]
  kb.py stats
"""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import fnmatch
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import media
import sources
import zotero

# The folders to read (spec 018). VAULT is the main (output) folder: the listed folder chosen for notes, else
# ~/Documents/Veritas; it keeps bare paths and is where notes are written. Without data/sources.json this is today's KB_VAULT / KB_ZOTERO setup.
# No Zotero in the list (none found, or switched off): a folder that never exists, so the Zotero stage finds nothing
# and the Zotero-only routes say so, instead of falling back to ~/Zotero.
NO_ZOTERO = Path(__file__).resolve().parent / "data" / "no-zotero-library"


def reload_layout() -> None:
    """Re-reads the folder list; the server calls it after a change so its own reads follow the new list."""
    global LAYOUT, VAULT
    LAYOUT = sources.resolved()
    VAULT = LAYOUT.main
    zotero.ZOTERO = LAYOUT.zotero or NO_ZOTERO


reload_layout()
HOME = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("KB_DB", HOME / "data" / "kb.sqlite"))
MODEL_DIR = HOME / "models" / "snowflake-arctic-embed-s"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
DIM = 384
# "mlx" runs the model on the GPU (mlx_embed.py), "onnx" on the CPU. Both give the same vectors.
USE_MLX = os.environ.get("KB_BACKEND", "mlx") == "mlx"
# Vector hits below this cosine are dropped, so weak neighbours cannot outrank a real keyword match. eval.py
# recall is flat from 0.0 to 0.70 (2026-09-21, 11 paraphrases); 0.55 sits mid-plateau, under the 0.62-0.64 of
# real but lower-ranked targets. The vault's median chunk cosine to a query is about 0.39.
VECTOR_GATE = float(os.environ.get("KB_VECTOR_GATE", "0.55"))

CHUNK_CHARS = 1400
MIN_CHUNK_CHARS = 200

# Sync conflict copies, drawings (JSON, not prose), templates and agent instruction files are left out.
SKIP_DIRS = {"Excalidraw", "templates", "assets", "attachments"}
SKIP_NAME = re.compile(r"\.conflict-macos-|\.excalidraw\.md$|^_.*Template\.md$|^(CLAUDE|AGENTS)\.md$")
PLAIN_EXTENSIONS = (".md", ".markdown", ".txt")  # notes in plain folders (spec 018 D2); PDFs and images via media.py
FIRST_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.M)
# A Markdown link to another note in the same plain folder: [text](other%20note.md#section)
MD_NOTE_LINK = re.compile(r"\[[^\]]*\]\(<?([^)\s>]+?\.(?:md|markdown|txt))(?:#[^)\s>]*)?>?\)", re.I)

# The top-level folder decides a note's source. AI-generated notes rank a little lower so that the user's own
# notes win ties; they are still returned when they are the best match.
SOURCE_WEIGHTS = {"ai_notes": 0.85, "Notion": 1.0, "Clippings": 0.95, "youtube": 0.95, "People": 1.0,
                  "copilot": 0.85, "personal": 1.0, "zotero": 1.0, "pdf": 1.0, "image": 0.9}
NON_NOTE_SOURCES = ("zotero", "pdf", "image")  # indexed documents that are not the vault's Markdown notes

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY, title TEXT, folder TEXT, source TEXT, tags TEXT, mtime REAL, size INTEGER,
  frontmatter TEXT);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, path TEXT, ord INTEGER, heading TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS chunks_path_heading ON chunks(path, heading);
DROP INDEX IF EXISTS chunks_path;
CREATE TABLE IF NOT EXISTS vecs (id INTEGER PRIMARY KEY, path TEXT, vec BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS vecs_path ON vecs(path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, heading, text, tags, content='', contentless_delete=1, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS links (src TEXT, dst TEXT);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS collections (key TEXT PRIMARY KEY, name TEXT, parent TEXT);
"""
# Pandoc citations in notes, [@citekey] or [see @a; @b], link a note to the Zotero item with that citation key.
CITATION = re.compile(r"(?<![\w@])@([A-Za-z][\w:.#$%&+?<>~/-]*[\w])")
CITATION_BLOCK = re.compile(r"\[[^\[\]]*@[^\[\]]*\]")


_request = threading.local()


def connect(*, keep: bool = False) -> sqlite3.Connection:
    """A connection to the index. Inside `request_scope` it is closed when the request ends; `keep` is for the few
    that live as long as the process (the searcher's)."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=60, check_same_thread=False)
    tracked = getattr(_request, "dbs", None)
    if tracked is not None and not keep:
        tracked.append(db)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    db.execute(media.CACHE_SCHEMA)
    if "meta" not in {r[1] for r in db.execute("PRAGMA table_info(notes)")}:
        db.execute("ALTER TABLE notes ADD COLUMN meta TEXT")  # Zotero details: authors, year, citekey, DOI
    if "vec" in {r[1] for r in db.execute("PRAGMA table_info(chunks)")}:
        _move_vectors_out(db)
    return db


class request_scope:
    """Closes every connection a server request opened, when it ends, error or not. Without it each one waited for
    the garbage collector: a failed lookup keeps its frames (and connection) alive in the traceback, and on
    2026-10-11 the server ran out of file handles ("unable to open database file") after a day of use."""

    def __enter__(self) -> None:
        _request.dbs = []

    def __exit__(self, *_exc) -> None:
        dbs, _request.dbs = getattr(_request, "dbs", None) or [], None
        for db in dbs:
            try:
                db.close()
            except sqlite3.Error:
                pass


def _move_vectors_out(db: sqlite3.Connection) -> None:
    """Vectors used to live in `chunks` next to the text, so reading 250 MB of vectors (or counting them) read
    all 570 MB of rows: 20 s from a cold disk. They now have their own table, keyed by chunk id."""
    db.execute("BEGIN IMMEDIATE")
    try:
        if "vec" in {r[1] for r in db.execute("PRAGMA table_info(chunks)")}:
            db.execute("INSERT OR REPLACE INTO vecs SELECT id, path, vec FROM chunks WHERE vec IS NOT NULL")
            db.execute("DROP INDEX IF EXISTS chunks_with_vec")
            db.execute("ALTER TABLE chunks DROP COLUMN vec")
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("VACUUM")


# ---------------------------------------------------------------- parsing

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n?", re.S)
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.M)
FENCE = re.compile(r"^(`{3,}|~{3,}).*$", re.M)
WIKILINK = re.compile(r"!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]")
MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
MD_LINK = re.compile(r"\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)")
BARE_URL = re.compile(r"https?://\S{60,}")
DATA_URI = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+")
INLINE_TAG = re.compile(r"(?<![\w&/#:=?.-])#([A-Za-z][\w/-]{1,40})")
JUNK_TAG = re.compile(r"^(https?|www|[0-9a-f]{3}|[0-9a-f]{6})$", re.I)  # URL pieces and hex colours


def note_source(rel: str) -> tuple[str, str]:
    folder = rel.split("/", 1)[0] if "/" in rel else ""
    return folder, folder if folder in SOURCE_WEIGHTS else "personal"


def parse_frontmatter(text: str) -> tuple[dict, str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text
    fields: dict[str, object] = {}
    key = None
    for line in match.group(1).splitlines():
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item and key:
            existing = fields.get(key)
            fields[key] = (existing if isinstance(existing, list) else []) + [item.group(1).strip().strip("\"'")]
            continue
        pair = re.match(r"^([\w-]+):\s*(.*)$", line)
        if pair:
            key, value = pair.group(1), pair.group(2).strip()
            if value.startswith("[") and value.endswith("]"):
                fields[key] = [v.strip().strip("\"'") for v in value[1:-1].split(",") if v.strip()]
            else:
                fields[key] = value.strip("\"'")
    return fields, text[match.end():]


def clean(text: str) -> str:
    text = DATA_URI.sub("", text)
    text = MD_IMAGE.sub("", text)
    text = MD_LINK.sub(r"\1", text)
    text = BARE_URL.sub("", text)
    text = re.sub(r"<[^>]{1,200}>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _fence_spans(body: str) -> list[tuple[int, int]]:
    """Start/end offsets of fenced (```/~~~) code regions, so a heading-shaped line inside one (e.g. a shell
    comment `# Configure the API key`) isn't mistaken for a real heading."""
    spans, open_at = [], None
    for match in FENCE.finditer(body):
        if open_at is None:
            open_at = match.start()
        else:
            spans.append((open_at, match.end()))
            open_at = None
    if open_at is not None:
        spans.append((open_at, len(body)))  # unclosed fence: rest of the note
    return spans


def split_sections(body: str) -> list[tuple[str, str]]:
    """(heading path, section text) pairs, heading path like 'Setup > Install'."""
    sections, stack, last = [], [], 0
    heading_path = ""
    fences = _fence_spans(body)
    for match in HEADING.finditer(body):
        if any(start <= match.start() < end for start, end in fences):
            continue
        sections.append((heading_path, body[last:match.start()]))
        level = len(match.group(1))
        stack = [h for h in stack if h[0] < level] + [(level, match.group(2).strip())]
        heading_path = " > ".join(h[1] for h in stack)
        last = match.end()
    sections.append((heading_path, body[last:]))
    return [(h, t) for h, t in sections if t.strip() or h]


def pack(text: str) -> list[str]:
    """Split a section into pieces near CHUNK_CHARS, breaking at paragraphs, then lines, then sentences."""
    if len(text) <= CHUNK_CHARS:
        return [text]
    pieces, current = [], ""
    for para in re.split(r"\n\s*\n", text):
        units = [para] if len(para) <= CHUNK_CHARS else re.split(r"(?<=[.!?])\s+|\n", para)
        for unit in units:
            while len(unit) > CHUNK_CHARS:  # one unbroken run of text
                pieces.append(unit[:CHUNK_CHARS])
                unit = unit[CHUNK_CHARS:]
            if current and len(current) + len(unit) + 2 > CHUNK_CHARS:
                pieces.append(current)
                current = unit
            else:
                current = f"{current}\n\n{unit}" if current else unit
    if current:
        pieces.append(current)
    return pieces


@dataclass
class Chunk:
    heading: str
    text: str


def chunk_note(body: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    for heading, section in split_sections(body):
        section = clean(section)
        if not section:
            continue
        for piece in pack(section):
            # Tiny trailing pieces join the previous chunk of the same section.
            if chunks and len(piece) < MIN_CHUNK_CHARS and chunks[-1].heading == heading \
                    and len(chunks[-1].text) + len(piece) < CHUNK_CHARS * 1.3:
                chunks[-1].text += "\n\n" + piece
            else:
                chunks.append(Chunk(heading, piece))
    return chunks


def vault_files(top: Path | None = None, kind: str = "obsidian", skip: list[str] | tuple = ()) -> dict[str, os.stat_result]:
    """Notes under one folder. Obsidian vaults: .md, without drawings/templates/attachments folders. Plain folders
    (spec 018): .md, .markdown and .txt, every non-dot folder. Both drop the folder's own `skip` globs."""
    top = VAULT if top is None else top
    extensions = (".md",) if kind == "obsidian" else PLAIN_EXTENSIONS
    files = {}
    for root, dirs, names in os.walk(top):
        rel_root = os.path.relpath(root, top)
        dirs[:] = [d for d in dirs if not d.startswith(".") and (kind != "obsidian" or d not in SKIP_DIRS)]
        for name in names:
            if name.lower().endswith(extensions) and not SKIP_NAME.search(name):
                path = os.path.join(root, name)
                rel = name if rel_root == "." else f"{rel_root}/{name}"
                if not any(fnmatch.fnmatch(rel, pattern) for pattern in skip):
                    files[rel] = os.stat(path)
    return files


@dataclass
class Root:
    """One folder the notes and media stages read: the main folder (prefix "") or a listed one (`name:/`)."""
    prefix: str
    path: Path
    kind: str  # obsidian rules (folder labels, Obsidian skips) or plain
    name: str = ""
    skip: tuple = ()


def roots() -> list[Root]:
    # The main folder always gets Obsidian rules: it is the vault, or the home folder Second Brain itself writes
    # ai_notes/ and digests into, whose folder labels and weights must stay.
    return [Root("", VAULT, "obsidian")] + [Root(f.prefix, f.path, sources.connectors.indexed_as(f.kind), f.name, tuple(f.skip))
                                       for f in LAYOUT.others]


def kept_prefixes() -> tuple[str, ...]:
    """Listed folders that are switched on but not there (an unplugged drive): their rows stay until they return."""
    return tuple(f.prefix for f in LAYOUT.ignored if f.kind == "missing")


def split_prefixed(path: str) -> tuple[Path, str, str]:
    """(folder, prefix, path inside it) for an index path: `name:/rel` belongs to that listed folder."""
    name, sep, rest = path.partition(":/")
    if sep:
        for f in LAYOUT.others:
            if f.name == name:
                return f.path, f.prefix, rest
    return VAULT, "", path


def note_title(fields: dict, body: str, stem: str) -> str:
    """Plain folders: frontmatter title, else the first # heading, else the file name."""
    title = fields.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    match = FIRST_HEADING.search(body)
    return match.group(1).strip() if match else stem


# ---------------------------------------------------------------- embeddings

class Embedder:
    def __init__(self) -> None:
        from tokenizers import Tokenizer

        self.tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        # Lengths padded to a multiple of 32 keep the number of distinct batch shapes small.
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("[PAD]") or 0, pad_token="[PAD]",
                                      pad_to_multiple_of=32)
        self.mlx = None
        if USE_MLX:
            try:
                from mlx_embed import ArcticMLX

                self.mlx = ArcticMLX()
                return
            except Exception as error:  # no GPU or MLX missing: fall back to onnxruntime
                print(f"MLX unavailable, using CPU: {error}", file=sys.stderr)
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        options.enable_cpu_mem_arena = False  # batches vary in length; the arena would keep every size it saw
        options.intra_op_num_threads = int(os.environ.get("KB_THREADS", "4"))
        self.session = onnxruntime.InferenceSession(str(MODEL_DIR / "onnx" / "model.onnx"), options,
                                                    providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}

    def _run(self, batch: list[str]) -> np.ndarray:
        encoded = self.tokenizer.encode_batch(batch)
        ids = np.array([e.ids for e in encoded], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        if self.mlx is not None:
            return self.mlx(ids, mask)
        feed = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
        hidden = self.session.run(None, {k: v for k, v in feed.items() if k in self.inputs})[0]
        vectors = hidden[:, 0].astype(np.float32)  # CLS pooling
        return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)

    def __call__(self, texts: list[str], query: bool = False, batch_size: int = 16) -> np.ndarray:
        if query:
            texts = [QUERY_PREFIX + t for t in texts]
        out = np.zeros((len(texts), DIM), dtype=np.float32)
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))  # similar lengths pad less
        for start in range(0, len(order), batch_size):
            idx = order[start:start + batch_size]
            out[idx] = self._run([texts[i] for i in idx])
        return out


# ---------------------------------------------------------------- indexing

# During an index run, the vectors of deleted rows, keyed by the exact text they were made from. A note re-stored
# under a new path (its folder became the output or stopped being it) or with only some sections edited gets the
# vectors of its unchanged passages back instead of re-embedding them. None outside an index run.
_VEC_STASH: dict[str, bytes] | None = None


def _embed_text(title: str, heading: str, text: str) -> str:
    """What embed_pending embeds for a passage (and the stash key)."""
    return f"{title}" + (f" > {heading}" if heading else "") + f"\n{text}"


def delete_note(db: sqlite3.Connection, rel: str) -> None:
    if _VEC_STASH is not None:
        for title, heading, text, vec in db.execute(
                "SELECT n.title, c.heading, c.text, v.vec FROM chunks c JOIN notes n ON n.path=c.path "
                "JOIN vecs v ON v.id=c.id WHERE c.path=?", (rel,)):
            _VEC_STASH[_embed_text(title, heading, text)] = vec
    ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (rel,))]
    db.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
    db.execute("DELETE FROM chunks WHERE path=?", (rel,))
    db.execute("DELETE FROM vecs WHERE path=?", (rel,))
    db.execute("DELETE FROM links WHERE src=?", (rel,))
    db.execute("DELETE FROM notes WHERE path=?", (rel,))


# The code this process loaded. Long-lived processes (agent MCP servers, the plugin's server) outlive updates;
# one still running old code once deleted every Zotero item because the old code did not know about them.
_CODE = {path: path.stat().st_mtime for path in (
    HOME / "kb.py", HOME / "zotero.py", HOME / "media.py",
    HOME / "paper_notes.py", HOME / "keyword_index.py", HOME / "mlx_embed.py", HOME / "zotero_files.py",
    HOME / "sources.py")}


def code_is_current() -> bool:
    return all(path.stat().st_mtime == mtime for path, mtime in _CODE.items())


PROGRESS_FILE = HOME / "data" / "index-progress.json"
LOCK_FILE = HOME / "data" / "index.lock"
STOP = threading.Event()  # set by "Stop" in the plugin (or SIGTERM): indexing ends after its current batch


class Stopped(Exception):
    pass


class Progress:
    """What indexing is doing, in data/index-progress.json, for the plugin's status panel. Written at most once a
    second; the last state (with the run's result) stays after it finishes."""

    STAGES = {"notes": "Checking notes", "media": "Reading PDFs and images", "zotero": "Reading Zotero",
              "embedding": "Making notes searchable by meaning"}

    def __init__(self) -> None:
        self.state = {"running": True, "pid": os.getpid(), "started_at": time.time(), "stage": "notes",
                      "label": self.STAGES["notes"], "done": 0, "total": 0,
                      # every stage in order, so a page can show what is done and what is still to come
                      "stages": [{"name": n, "label": label, "state": "waiting", "done": 0, "total": 0}
                                 for n, label in self.STAGES.items()]}
        self.written = 0.0

    def _row(self, name: str) -> dict:
        return next(row for row in self.state["stages"] if row["name"] == name)

    def stage(self, name: str, total: int = 0) -> None:
        # Stages run in order: the one before is done, any between it and this one had nothing to do.
        reached = False
        for row in self.state["stages"]:
            if row["name"] == name:
                reached = True
                row.update(state="running", done=0, total=total)
            elif not reached and row["state"] in ("waiting", "running"):
                row["state"] = "done" if row["state"] == "running" else "skipped"
        self.state.update(stage=name, label=self.STAGES[name], done=0, total=total, stage_started_at=time.time())
        self.write(force=True)

    def advance(self, done: int, total: int | None = None) -> None:
        if STOP.is_set():
            raise Stopped
        self.state["done"] = done
        if total is not None:
            self.state["total"] = total
        row = self._row(self.state["stage"]) if self.state["stage"] in self.STAGES else None
        if row:
            row.update(done=done, total=self.state["total"])
        self.write()

    def write(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.written < 1:
            return
        self.written = now
        elapsed = now - self.state.get("stage_started_at", now)
        done, total = self.state["done"], self.state["total"]
        self.state["rate_per_min"] = round(done / elapsed * 60, 1) if elapsed > 5 and done else None
        self.state["eta_seconds"] = round((total - done) / (done / elapsed)) if elapsed > 5 and done and total else None
        self.state["updated_at"] = now
        tmp = PROGRESS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state))
        tmp.replace(PROGRESS_FILE)

    def finish(self, result: dict | None = None, error: str | None = None, stopped: bool = False) -> None:
        for row in self.state["stages"]:
            if row["state"] == "running":
                row["state"] = "failed" if error else "stopped" if stopped else "done"
            elif row["state"] == "waiting" and not (error or stopped):
                row["state"] = "skipped"
        self.state.update(running=False, stage="idle", label="Up to date" if not (error or stopped) else
                          ("Stopped" if stopped else "Failed"), finished_at=time.time(), result=result, error=error,
                          done=0, total=0)
        self.write(force=True)


def index_running() -> bool:
    """True when some process holds the index lock."""
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock, fcntl.LOCK_UN)
        return False


def index(full: bool = False, verbose: bool = True, reread_zotero: bool = False, reread_media: bool = False) -> dict:
    """Update the index; returns {'skipped': ...} when another process is indexing or this one runs old code.
    `reread_zotero` / `reread_media` read those sources again from scratch (after a Zotero plugin rewrote files,
    or to retry text recognition)."""
    if not code_is_current():
        return {"skipped": "this process runs out-of-date code; a fresh process will index"}
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"skipped": True}
        STOP.clear()
        progress = Progress()
        try:
            if reread_zotero or reread_media:
                db = connect()
                if reread_zotero:
                    db.execute("DELETE FROM meta WHERE key='zotero_fingerprint'")
                if reread_media:
                    db.execute("DELETE FROM media_cache")
                db.commit()
            result = _index(full, verbose, progress)
        except Stopped:
            progress.finish(stopped=True)
            return {"stopped": True}
        except Exception as error:
            progress.finish(error=f"{type(error).__name__}: {error}")
            raise
        progress.finish(result)
        return result


def _index(full: bool, verbose: bool, progress: Progress) -> dict:
    global _VEC_STASH
    _VEC_STASH = {}
    try:
        return _index_stages(full, verbose, progress)
    finally:
        _VEC_STASH = None


def _index_stages(full: bool, verbose: bool, progress: Progress) -> dict:
    started = time.time()
    db = connect()
    if full:
        db.executescript("DELETE FROM chunks; DELETE FROM vecs; DELETE FROM chunks_fts; DELETE FROM links; DELETE FROM notes;")
    files, where = {}, {}
    for root in roots():
        for rel, st in vault_files(root.path, root.kind, root.skip).items():
            files[root.prefix + rel] = st
            where[root.prefix + rel] = (root, rel)
    # Only Markdown notes here: Zotero items, PDFs and images have their own stages. Counting them here once
    # made the notes stage delete every Zotero item as a "removed file".
    known = {r[0]: (r[1], r[2]) for r in db.execute(
        f"SELECT path, mtime, size FROM notes WHERE source NOT IN ({','.join('?' * len(NON_NOTE_SOURCES))})",
        NON_NOTE_SOURCES)}
    # A folder taken off the list loses its rows here; one that is listed but missing keeps them.
    kept = kept_prefixes()
    removed = [p for p in known if p not in files and not (kept and p.startswith(kept))]
    changed = [p for p, st in files.items() if known.get(p) != (st.st_mtime, st.st_size)]
    for rel in removed:
        delete_note(db, rel)
    if verbose:
        print(f"{len(files)} notes: {len(changed)} new or changed, {len(removed)} removed", file=sys.stderr)

    # Stage 1: text, keyword index and links. Fast, so search works right after it.
    progress.stage("notes", len(changed))
    for n, rel in enumerate(changed, 1):
        st = files[rel]
        root, inner = where[rel]
        try:
            raw = (root.path / inner).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fields, body = parse_frontmatter(raw)
        # Listed folders are labelled by their name, so the source filter can pick one folder.
        folder, source = note_source(inner) if not root.prefix else (root.name, root.name)
        tags = fields.get("tags") or []
        tags = [tags] if isinstance(tags, str) else list(tags)
        tags = sorted({t.lstrip("#") for t in tags + INLINE_TAG.findall(body[:20000]) if t and not JUNK_TAG.match(t)})
        links = {Path(m.strip()).name.removesuffix(".md") for m in WIKILINK.findall(raw)}
        links |= {"@" + key for block in CITATION_BLOCK.findall(body) for key in CITATION.findall(block)}
        title = Path(inner).stem
        if root.kind == "plain":
            links |= {Path(urllib.parse.unquote(m)).stem for m in MD_NOTE_LINK.findall(body)}
            title = note_title(fields, body, title)
        store_note(db, rel, title, folder, source, tags, sorted(links), st.st_mtime, st.st_size,
                   json.dumps(fields, ensure_ascii=False)[:4000], None, body)
        if n % 100 == 0:
            db.commit()
            progress.advance(n)
            if verbose and n % 500 == 0:
                print(f"  text: {n}/{len(changed)} notes", file=sys.stderr)
    db.commit()
    refresh_paper_references([rel for rel in changed if rel.startswith("Papers/")])
    media_changed = index_media(db, verbose, progress)
    zotero_changed = index_zotero(db, verbose, progress)
    stamp(db, "indexed_at")
    db.commit()
    text_seconds = round(time.time() - started, 1)

    # Stage 2: vectors for every chunk that has none yet (new chunks, or a run that was interrupted).
    embedded = embed_pending(db, verbose, progress=progress)
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    result = {"notes": len(files), "changed": len(changed), "removed": len(removed), "zotero_changed": zotero_changed, "media_changed": media_changed,
              "embedded": embedded,
              "text_seconds": text_seconds, "seconds": round(time.time() - started, 1)}
    if verbose:
        print(json.dumps(result), file=sys.stderr)
    return result


def refresh_paper_references(paths: list[str]) -> None:
    """Paper notes edited in Obsidian: bring their References list in line with what "My notes" cites."""
    if not paths:
        return
    import paper_notes
    for rel in paths:
        try:
            key = parse_frontmatter((VAULT / rel).read_text(encoding="utf-8"))[0].get("zotero-key")
            if key:
                paper_notes.refresh(str(key), rel)
        except Exception as exc:  # noqa: BLE001 - a broken note must not stop indexing
            print(f"refresh_paper_references: {rel}: {exc}", file=sys.stderr)
            continue


def store_note(db: sqlite3.Connection, rel: str, title: str, folder: str, source: str, tags: list[str],
               links: list[str], mtime: float, size: int, frontmatter: str, meta: dict | None, body: str) -> None:
    delete_note(db, rel)
    db.execute("INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
               "VALUES (?,?,?,?,?,?,?,?,?)",
               (rel, title, folder, source, " ".join(tags), mtime, size, frontmatter,
                json.dumps(meta, ensure_ascii=False) if meta else None))
    db.executemany("INSERT INTO links VALUES (?,?)", [(rel, dst) for dst in links])
    for ord_, chunk in enumerate(chunk_note(body) or [Chunk("", title)]):
        cur = db.execute("INSERT INTO chunks (path, ord, heading, text) VALUES (?,?,?,?)",
                         (rel, ord_, chunk.heading, chunk.text))
        db.execute("INSERT INTO chunks_fts (rowid, title, heading, text, tags) VALUES (?,?,?,?,?)",
                   (cur.lastrowid, title, chunk.heading, chunk.text, " ".join(tags)))
        vec = _VEC_STASH.get(_embed_text(title, chunk.heading, chunk.text)) if _VEC_STASH is not None else None
        if vec is not None:
            db.execute("INSERT OR REPLACE INTO vecs VALUES (?,?,?)", (cur.lastrowid, rel, vec))


def index_media(db: sqlite3.Connection, verbose: bool, progress: Progress) -> int:
    """PDFs and images in the vault: extract text once per file version (cached), index files with real text."""
    from concurrent.futures import ThreadPoolExecutor

    files, where = {}, {}
    for root in roots():
        for rel, st in media.media_files(root.path).items():
            if not any(fnmatch.fnmatch(rel, pattern) for pattern in root.skip):
                files[root.prefix + rel] = st
                where[root.prefix + rel] = (root, rel)
    cached = {p: (m, z) for p, m, z in db.execute("SELECT path, mtime, size FROM media_cache")}
    todo = [rel for rel, st in files.items() if cached.get(rel) != (st.st_mtime, st.st_size)]
    progress.stage("media", len(todo))
    if verbose and todo:
        print(f"media: reading {len(todo)} PDFs and images", file=sys.stderr)
    # Two threads: Vision OCR barely scales past that (the Neural Engine is the bottleneck).
    with ThreadPoolExecutor(2) as pool:
        for n, (rel, text) in enumerate(zip(todo, pool.map(lambda r: media.extract(where[r][0].path, where[r][1]), todo)), 1):
            st = files[rel]
            db.execute("INSERT OR REPLACE INTO media_cache VALUES (?,?,?,?,?)",
                       (rel, st.st_mtime, st.st_size, media.kind_of(rel), text))
            if n % 10 == 0:
                db.commit()
                progress.advance(n)
                if verbose and n % 50 == 0:
                    print(f"  media: {n}/{len(todo)}", file=sys.stderr, flush=True)
    db.commit()
    indexed = {p: (m, z) for p, m, z in db.execute(
        "SELECT path, mtime, size FROM notes WHERE source IN ('pdf', 'image')")}
    changed = 0
    kept = kept_prefixes()
    for rel in indexed.keys() - files.keys():
        if kept and rel.startswith(kept):
            continue
        delete_note(db, rel)
        changed += 1
    texts = dict(db.execute("SELECT path, text FROM media_cache"))
    for rel, st in files.items():
        text = (texts.get(rel) or "").strip()
        if len(text) < media.MIN_TEXT:
            if rel in indexed:
                delete_note(db, rel)
                changed += 1
            continue
        if indexed.get(rel) == (st.st_mtime, st.st_size):
            continue
        kind = media.kind_of(rel)
        body = text if kind == "pdf" else f"## Text in image\n\n{text}"
        root, inner = where[rel]
        folder = root.name or (inner.split("/", 1)[0] if "/" in inner else "")
        store_note(db, rel, Path(inner).name, folder, kind, [], [], st.st_mtime, st.st_size, "", None, body)
        changed += 1
    db.commit()
    if verbose and changed:
        print(f"media: {changed} documents added, updated or removed", file=sys.stderr)
    return changed


def index_zotero(db: sqlite3.Connection, verbose: bool, progress: Progress) -> int:
    """Adds, updates and removes Zotero items. Skipped entirely when Zotero's files have not changed, unless some
    indexed item is still missing `collection_keys` (a one-time backfill after that field was added)."""
    if not zotero.available():
        return 0
    fingerprint = json.dumps(zotero.fingerprint())
    row = db.execute("SELECT value FROM meta WHERE key='zotero_fingerprint'").fetchone()
    missing_keys = {r[0] for r in db.execute(
        "SELECT path FROM notes WHERE source='zotero' AND (meta IS NULL OR json_extract(meta, '$.collection_keys') IS NULL)")}
    if row and row[0] == fingerprint and not missing_keys:
        return 0
    progress.stage("zotero")
    docs = zotero.documents()
    tree = zotero.collection_tree()
    db.execute("DELETE FROM collections")
    db.executemany("INSERT INTO collections VALUES (?,?,?)", [(c["key"], c["name"], c["parent"]) for c in tree])
    known = {r[0]: (r[1], r[2]) for r in db.execute("SELECT path, mtime, size FROM notes WHERE source='zotero'")}
    current = {d.path for d in docs}
    for rel in known.keys() - current:
        delete_note(db, rel)
    changed = [d for d in docs if known.get(d.path) != (d.signature, len(d.text))]
    changed_paths = {d.path for d in changed}
    for n, doc in enumerate(changed, 1):
        store_note(db, doc.path, doc.title, "zotero", "zotero", doc.tags, [], doc.signature, len(doc.text),
                   "", doc.meta, doc.text)
        if n % 50 == 0:
            db.commit()
            progress.advance(n, len(changed))
    # Items whose text is unchanged but whose meta lacks collection_keys: patch the column in place, so the
    # backfill never re-chunks or re-embeds content that did not change.
    backfilled = [d for d in docs if d.path in missing_keys and d.path not in changed_paths]
    if backfilled:
        db.executemany("UPDATE notes SET meta=? WHERE path=?",
                       [(json.dumps(d.meta, ensure_ascii=False), d.path) for d in backfilled])
    db.execute("INSERT OR REPLACE INTO meta VALUES ('zotero_fingerprint', ?)", (fingerprint,))
    db.commit()
    if verbose:
        print(f"zotero: {len(docs)} items, {len(changed)} new or changed, {len(backfilled)} meta-only backfilled, "
              f"{len(known.keys() - current)} removed", file=sys.stderr)
    if changed:
        import paper_notes
        refreshed = paper_notes.refresh_changed([d.key for d in changed])
        if verbose and refreshed:
            print(f"zotero: refreshed {refreshed} paper notes", file=sys.stderr)
    return len(changed)


# The user's own notes get vectors first; within a source, every note's opening chunks come before the deep
# chunks of long transcripts.
EMBED_ORDER = """CASE n.source WHEN 'personal' THEN 0 WHEN 'People' THEN 1 WHEN 'Notion' THEN 2 WHEN 'Clippings' THEN 3
  WHEN 'pdf' THEN 4 WHEN 'zotero' THEN 5 WHEN 'youtube' THEN 6 WHEN 'image' THEN 7 WHEN 'copilot' THEN 8 ELSE 9 END,
  c.ord, c.id"""


def collection_descendants(db: sqlite3.Connection, keys: list[str]) -> set[str]:
    """`keys` plus every collection nested under any of them, walking the `collections` table's parent links."""
    children: dict[str | None, list[str]] = {}
    for key, parent in db.execute("SELECT key, parent FROM collections"):
        children.setdefault(parent, []).append(key)
    result: set[str] = set()
    stack = list(keys)
    while stack:
        current = stack.pop()
        if current in result:
            continue
        result.add(current)
        stack.extend(children.get(current, []))
    return result


_collections_cache: list = []


def zotero_collections() -> list[dict]:
    """The collection tree for the plugin's scope picker: every collection with its parent key and how many
    indexed Zotero items are filed directly in it (not counting descendants), sorted by name. Counting walks every
    Zotero item's JSON (~12 ms), so the tree is kept until the next index run stamps `indexed_at`."""
    db = connect()
    version = (str(DB_PATH), db.execute("SELECT value FROM meta WHERE key='indexed_at'").fetchone())
    if _collections_cache and _collections_cache[0] == version:
        return _collections_cache[1]
    counts = dict(db.execute(
        "SELECT je.value, count(*) FROM notes, json_each(json_extract(notes.meta, '$.collection_keys')) je "
        "WHERE notes.source='zotero' GROUP BY je.value"))
    tree = [{"key": key, "name": name, "parent": parent, "count": counts.get(key, 0)}
            for key, name, parent in db.execute("SELECT key, name, parent FROM collections ORDER BY name")]
    _collections_cache[:] = [version, tree]
    return tree


def stamp(db: sqlite3.Connection, key: str) -> None:
    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, str(time.time())))


def embed_pending(db: sqlite3.Connection, verbose: bool = True, batch: int = 256,
                  progress: Progress | None = None) -> int:
    todo = db.execute("SELECT (SELECT count(*) FROM chunks) - (SELECT count(*) FROM vecs)").fetchone()[0]
    if not todo:
        return 0
    if progress:
        progress.stage("embedding", todo)
    embed = Embedder()
    done, started, last_stamp = 0, time.time(), time.time()
    while True:
        rows = db.execute(f"SELECT c.id, n.title, c.heading, c.text, c.path FROM chunks c JOIN notes n ON n.path=c.path "
                          f"WHERE c.id NOT IN (SELECT id FROM vecs) ORDER BY {EMBED_ORDER} LIMIT ?", (batch,)).fetchall()
        if not rows:
            break
        texts = [_embed_text(title, heading, text) for _, title, heading, text, _ in rows]
        vectors = embed(texts, batch_size=64 if embed.mlx is not None else 16).astype(np.float16)
        db.executemany("INSERT OR REPLACE INTO vecs VALUES (?,?,?)",
                       [(r[0], r[4], v.tobytes()) for r, v in zip(rows, vectors)])
        done += len(rows)
        if time.time() - last_stamp > 300:  # lets a running server pick up new vectors every few minutes
            stamp(db, "vectors_at")
            last_stamp = time.time()
        db.commit()
        if progress:
            progress.advance(done)
        if verbose:
            rate = done / (time.time() - started)
            eta = (todo - done) / max(rate, 1e-9) / 60
            print(f"  vectors: {done}/{todo}, {rate:.1f} chunks/s, ~{eta:.0f} min left", file=sys.stderr, flush=True)
    stamp(db, "vectors_at")
    db.commit()
    return done


# ---------------------------------------------------------------- search

STOPWORDS = set("""a an and are as at be but by did do does for from had has have how i in is it its my of on or
so that the their there this to was we were what when where which who why will with you your me about into""".split())


try:  # the GPU path for vector scans; numpy is the fallback
    import mlx.core as _mx
except Exception:  # noqa: BLE001 - no MLX (or no Metal): stay on the CPU
    _mx = None
if not USE_MLX:
    _mx = None


def _append_vectors(current, block: np.ndarray):
    if _mx is not None:
        block = _mx.array(block)
        merged = block if current is None else _mx.concatenate([current, block])
        _mx.eval(merged)
        return merged
    return block.copy() if current is None else np.vstack([current, block])


class Searcher:
    """Holds the vector matrix in memory; reloads it when the index changes."""

    def __init__(self, writer: bool = False) -> None:
        """`writer`: this process maintains the Tantivy keyword index (the index server does; others read it)."""
        from keyword_index import KeywordIndex

        self.db = connect(keep=True)
        self.keywords = KeywordIndex(HOME / "data" / "tantivy", writer)
        self.embed: Embedder | None = None
        self._query_vectors: dict[str, np.ndarray] = {}
        self.loaded_at = None
        self.checked_at = 0.0
        self.ids = np.zeros(0, dtype=np.int64)
        self.max_id = 0
        self.full_at = 0.0
        self.vectors = None  # an MLX array on the GPU when available, else numpy
        self.note_sums = np.zeros((0, DIM), dtype=np.float32)
        self.note_paths: list[str] = []
        self.note_index: dict[str, int] = {}
        self.note_matrix = np.zeros((0, DIM), dtype=np.float16)
        self._duplicates: tuple | None = None
        self._rebuilt: Searcher | None = None
        self._rebuilding = threading.Event()

    _VECTOR_STATE = ("ids", "max_id", "full_at", "vectors", "note_sums", "note_paths", "note_index", "note_matrix")

    def _refresh(self) -> None:
        """Keeps the vectors in memory current. New chunks are appended (cheap); a full reload happens on first
        use, hourly, or when many loaded chunks have been deleted, since deleted rows linger until then. Only the
        first load runs on the caller's thread: later full reloads (1-2 s) are built in the background and swapped
        in here, on the request thread, so no search ever sees half of the old state and half of the new."""
        rebuilt, self._rebuilt = self._rebuilt, None
        if rebuilt is not None:
            for name in self._VECTOR_STATE:
                setattr(self, name, getattr(rebuilt, name))
            self.loaded_at = ("rebuilt",)  # appends whatever arrived while the rebuild ran
            self.checked_at = 0.0
        version = tuple(r[0] for r in self.db.execute(
            "SELECT value FROM meta WHERE key IN ('indexed_at', 'vectors_at') ORDER BY key"))
        if version == self.loaded_at or (self.loaded_at is not None and time.time() - self.checked_at < 60):
            return
        self.checked_at = time.time()
        self.keywords.sync(self.db)
        live = self.db.execute("SELECT count(*) FROM vecs").fetchone()[0]
        stale = len(self.ids) - live
        if self.loaded_at is None:
            self._load(full=True)
        else:
            if (time.time() - self.full_at > 3600 or stale > max(2000, live // 20)) and not self._rebuilding.is_set():
                self._rebuilding.set()
                threading.Thread(target=self._rebuild, daemon=True).start()
            self._load(full=False)
        self.loaded_at = version

    def _rebuild(self) -> None:
        background_priority()
        try:
            shadow = Searcher.__new__(Searcher)
            shadow.db = connect(keep=True)
            shadow.ids, shadow.max_id, shadow.vectors = np.zeros(0, dtype=np.int64), 0, None
            shadow._load(full=True)
            shadow.db.close()
            self._rebuilt = shadow
        finally:
            self._rebuilding.clear()

    def _load(self, full: bool) -> None:
        start = 0 if full else self.max_id
        rows = self.db.execute("SELECT id, path, vec FROM vecs WHERE id > ? ORDER BY id",
                               (start,)).fetchall()
        ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        block = np.frombuffer(b"".join(r[2] for r in rows), dtype=np.float16).reshape(-1, DIM) \
            if rows else np.zeros((0, DIM), dtype=np.float16)
        if full:
            self.ids, self.full_at = ids, time.time()
            self.note_paths, self.note_index = [], {}
            self.note_sums = np.zeros((0, DIM), dtype=np.float32)
            self.vectors = None
        else:
            self.ids = np.concatenate([self.ids, ids])
        self.max_id = int(self.ids.max()) if len(self.ids) else 0
        # One vector per note: the normalised mean of its chunks ("similar notes"). Sums are kept so new chunks
        # add in without touching the rest; summed in blocks to avoid a float32 copy of the whole matrix.
        for path in dict.fromkeys(r[1] for r in rows):
            if path not in self.note_index:
                self.note_index[path] = len(self.note_paths)
                self.note_paths.append(path)
        if len(self.note_paths) > len(self.note_sums):
            self.note_sums = np.vstack([self.note_sums, np.zeros((len(self.note_paths) - len(self.note_sums), DIM), np.float32)])
        owner = np.fromiter((self.note_index[r[1]] for r in rows), dtype=np.int64, count=len(rows))
        for i in range(0, len(block), 20000):
            part = owner[i:i + 20000]
            order = np.argsort(part, kind="stable")
            notes, starts = np.unique(part[order], return_index=True)
            # reduceat over rows sorted by note: np.add.at did the same sum 10x slower
            self.note_sums[notes] += np.add.reduceat(block[i:i + 20000][order].astype(np.float32), starts)
        norms = np.maximum(np.linalg.norm(self.note_sums, axis=1, keepdims=True), 1e-9)
        self.note_matrix = (self.note_sums / norms).astype(np.float16)
        self.vectors = _append_vectors(self.vectors, block)

    def _query_vector(self, query: str) -> np.ndarray:
        """Query embeddings are cached: the plugin re-sends a query when filters change or results are re-opened."""
        vector = self._query_vectors.get(query)
        if vector is None:
            if len(self._query_vectors) > 512:
                self._query_vectors.clear()
            vector = self._query_vectors[query] = self.embed([query], query=True)[0]
        return vector

    def _scores(self, vector: np.ndarray) -> np.ndarray:
        """Cosine of `vector` against every loaded chunk: on the GPU when MLX is available (2 ms for 290k chunks
        against 120 ms with numpy), else on the CPU."""
        if self.vectors is None:
            return np.zeros(0, dtype=np.float32)
        if _mx is not None:
            result = self.vectors @ _mx.array(vector.astype(np.float16))
            return np.array(result.astype(_mx.float32))
        return self.vectors @ vector.astype(np.float16)

    def _allowed(self, source: str | None, folder: str | None, tag: str | None,
                 exclude_source: str | None = None, collections: list[str] | None = None,
                 year_from: int | None = None, year_to: int | None = None) -> set[str] | None:
        if not (source or folder or tag or exclude_source or collections or year_from is not None or year_to is not None):
            return None
        sql, args = "SELECT path FROM notes WHERE 1=1", []
        if source:
            sql += " AND source=?"
            args.append(source)
        if exclude_source:
            excluded = [s.strip() for s in exclude_source.split(",") if s.strip()]
            if excluded:
                sql += f" AND source NOT IN ({','.join('?' * len(excluded))})"
                args += excluded
        if folder:
            sql += " AND (path LIKE ? OR path LIKE ?)"
            args += [f"{folder.strip('/')}/%", f"%/{folder.strip('/')}/%"]
        if tag:
            sql += " AND (' ' || tags || ' ') LIKE ?"
            args.append(f"% {tag.lstrip('#')} %")
        if collections:
            # Zotero items whose direct collection_keys intersect any of `collections` or its descendants.
            keys = collection_descendants(self.db, collections)
            sql += (" AND source='zotero' AND EXISTS (SELECT 1 FROM json_each(notes.meta, '$.collection_keys') je "
                     f"WHERE je.value IN ({','.join('?' * len(keys))}))")
            args += list(keys)
        if year_from is not None or year_to is not None:
            # The paper's own year metadata (a number or a string); a note with none never matches a year filter.
            sql += " AND meta IS NOT NULL AND CAST(json_extract(meta, '$.year') AS INTEGER) > 0"
            if year_from is not None:
                sql += " AND CAST(json_extract(meta, '$.year') AS INTEGER) >= ?"
                args.append(int(year_from))
            if year_to is not None:
                sql += " AND CAST(json_extract(meta, '$.year') AS INTEGER) <= ?"
                args.append(int(year_to))
        return {r[0] for r in self.db.execute(sql, args)}

    def search(self, query: str, limit: int = 8, source: str | None = None, folder: str | None = None,
               tag: str | None = None, per_note: int = 2,
               exclude_source: str | None = None, collections: list[str] | None = None,
               year_from: int | None = None, year_to: int | None = None) -> list[dict]:
        self._refresh()
        allowed = self._allowed(source, folder, tag, exclude_source, collections, year_from, year_to)
        pool = 200
        ranks: dict[int, float] = {}

        # Keyword side: Tantivy BM25 over every query word (1-2 ms); SQLite FTS5 when no Tantivy index exists.
        terms = [t for t in re.findall(r"[\w][\w.+-]*", query.lower()) if t not in STOPWORDS]
        if terms:
            kw = self.keywords.search(terms, pool * 3) if self.keywords.usable() else self._fts_candidates(terms, pool)
            if allowed is not None:
                kw = self._filter_ids(kw, allowed)
            for rank, cid in enumerate(kw[:pool]):
                ranks[cid] = ranks.get(cid, 0) + 1 / (60 + rank)

        # Meaning side.
        if len(self.ids):
            if self.embed is None:
                self.embed = Embedder()
            scores = self._scores(self._query_vector(query))
            top = np.argpartition(-scores, min(pool * 3, len(scores) - 1))[:pool * 3]
            top = top[np.argsort(-scores[top])]
            vec_ids = [int(self.ids[i]) for i in top if scores[i] >= VECTOR_GATE]
            if allowed is not None:
                vec_ids = self._filter_ids(vec_ids, allowed)
            for rank, cid in enumerate(vec_ids[:pool]):
                ranks[cid] = ranks.get(cid, 0) + 1 / (60 + rank)

        if not ranks:
            return []
        placeholders = ",".join("?" * len(ranks))
        info = {r[0]: r[1:] for r in self.db.execute(
            f"SELECT c.id, c.path, c.heading, c.text, n.title, n.source, n.tags, n.mtime, n.meta FROM chunks c "
            f"JOIN notes n ON n.path=c.path WHERE c.id IN ({placeholders})", list(ranks))}
        scored = sorted(((score * SOURCE_WEIGHTS.get(info[cid][4], 1.0), cid) for cid, score in ranks.items()
                         if cid in info), reverse=True)
        # One result per note, carrying its best `per_note` passages. A passage whose text already appeared
        # (the same content saved under two paths) is skipped, so copies don't crowd out other notes.
        results: dict[str, dict] = {}
        seen_text: set[int] = set()
        for score, cid in scored:
            path, heading, text, title, src, tags, mtime, meta = info[cid]
            key = hash(" ".join(text.split())[:2000])
            if key in seen_text:
                continue
            seen_text.add(key)
            hit = results.get(path)
            if hit is None:
                if len(results) >= limit:
                    continue
                results[path] = {"path": path, "title": title, "source": src, "tags": tags.split() if tags else [],
                                 "modified": time.strftime("%Y-%m-%d", time.localtime(mtime)),
                                 "score": round(score * 1000, 2),
                                 "passages": [{"heading": heading, "snippet": snippet(text, terms)}]}
                if meta:
                    results[path]["zotero"] = json.loads(meta)
            elif len(hit["passages"]) < per_note:
                hit["passages"].append({"heading": heading, "snippet": snippet(text, terms)})
        return list(results.values())

    def similar_notes(self, path: str, limit: int = 10) -> list[dict]:
        """Notes whose overall meaning is closest to this note's, linked or not."""
        self._refresh()
        rel = note_path(path)
        if rel not in self.note_index:
            return []
        scores = self.note_matrix @ self.note_matrix[self.note_index[rel]]
        own = copy_key(Path(rel).stem)
        candidates = np.argsort(-scores)[:limit * 4]
        # The in-memory matrix can hold a deleted note's vector for up to an hour (full reload is hourly);
        # one query drops any candidate no longer in the notes table instead of note_info() fabricating a result.
        candidate_paths = [self.note_paths[i] for i in candidates]
        live = {r[0] for r in self.db.execute(
            f"SELECT path FROM notes WHERE path IN ({','.join('?' * len(candidate_paths))})",
            candidate_paths)} if candidate_paths else set()
        results = []
        for i in candidates:
            other = self.note_paths[i]
            if other == rel or other not in live or copy_key(Path(other).stem) == own:  # itself, deleted, or a copy
                continue
            if any(copy_key(Path(r["path"]).stem) == copy_key(Path(other).stem) for r in results):
                continue
            results.append({**note_info(self.db, other), "score": round(float(scores[i]), 3)})
            if len(results) >= limit:
                break
        return results

    def similar_to_text(self, text: str, exclude: str | None = None, limit: int = 8) -> list[dict]:
        """Notes with passages closest in meaning to `text` (a section being written), best passage each."""
        self._refresh()
        text = clean(text)[:4000]
        if len(text) < 40 or not len(self.ids):
            return []
        if self.embed is None:
            self.embed = Embedder()
        scores = self._scores(self.embed([text])[0])  # passage-to-passage: no query prefix
        top = np.argsort(-scores)[:limit * 12]
        chunk_ids = [int(self.ids[i]) for i in top]
        placeholders = ",".join("?" * len(chunk_ids))
        rows = dict((r[0], r[1:]) for r in self.db.execute(
            f"SELECT id, path, heading, text FROM chunks WHERE id IN ({placeholders})", chunk_ids))
        own = copy_key(Path(exclude).stem) if exclude else None
        results: dict[str, dict] = {}
        for i, cid in zip(top, chunk_ids):
            path, heading, chunk = rows[cid]
            if path == exclude or path in results or (own and copy_key(Path(path).stem) == own):
                continue
            if any(copy_key(Path(p).stem) == copy_key(Path(path).stem) for p in results):
                continue
            results[path] = {**note_info(self.db, path), "heading": heading, "score": round(float(scores[i]), 3),
                             "snippet": snippet(chunk, [], 300)}
            if len(results) >= limit:
                break
        return list(results.values())

    def duplicates(self, near: float = 0.985) -> dict:
        """Groups of notes that are the same note twice. Nothing here deletes anything.

        exact: identical text after whitespace is normalised. near: note vectors at cosine >= `near` and lengths
        within 20% (short or templated notes can share a vector without being copies). zotero: items sharing a DOI
        or a normalised title."""
        self._refresh()
        # Reading every chunk's text takes seconds, so the result is kept until a note is added, changed or removed
        # (each of those changes the chunk count or the highest chunk id) or new vectors arrive.
        version = self.db.execute("SELECT (SELECT max(id) FROM chunks), (SELECT count(*) FROM chunks), "
                                  "(SELECT count(*) FROM vecs)").fetchone() + (near,)
        if self._duplicates and self._duplicates[0] == version:
            return self._duplicates[1]
        texts: dict[str, list[str]] = {}
        for path, text in self.db.execute("SELECT path, text FROM chunks WHERE path NOT LIKE 'zotero/%' ORDER BY path, ord"):
            texts.setdefault(path, []).append(text)
        by_hash: dict[int, list[str]] = {}
        sizes = {}
        for path, parts in texts.items():
            body = " ".join(" ".join(parts).split())
            sizes[path] = len(body)
            if len(body) >= 80:
                by_hash.setdefault(hash(body), []).append(path)
        exact = [sorted(g) for g in by_hash.values() if len(g) > 1]
        in_exact = {p for g in exact for p in g}

        vault = [i for i, p in enumerate(self.note_paths) if not p.startswith(zotero.PREFIX) and p not in in_exact
                 and sizes.get(p, 0) >= 200]
        matrix = self.note_matrix[vault].astype(np.float32)
        near_groups: list[dict] = []
        parent = {i: i for i in range(len(vault))}

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        best: dict[tuple, float] = {}
        for start in range(0, len(vault), 1024):
            block = matrix[start:start + 1024] @ matrix.T
            rows, cols = np.nonzero(block >= near)
            for r, c in zip(rows, cols):
                a, b = start + int(r), int(c)
                if a >= b:
                    continue
                pa, pb = self.note_paths[vault[a]], self.note_paths[vault[b]]
                if min(sizes[pa], sizes[pb]) / max(sizes[pa], sizes[pb]) < 0.8:
                    continue
                parent[find(a)] = find(b)
                best[(a, b)] = float(block[r, c])
        groups: dict[int, list[int]] = {}
        for i in {i for pair in best for i in pair}:
            groups.setdefault(find(i), []).append(i)
        for members in groups.values():
            score = min(v for (a, b), v in best.items() if a in members and b in members)
            near_groups.append({"paths": sorted(self.note_paths[vault[i]] for i in members), "score": round(score, 3)})
        near_groups.sort(key=lambda g: -g["score"])

        zotero_groups: dict[str, list[str]] = {}
        for path, title, meta in self.db.execute("SELECT path, title, meta FROM notes WHERE source='zotero'"):
            info = json.loads(meta or "{}")
            key = (info.get("doi") or "").lower().strip() or re.sub(r"\W+", " ", title.lower()).strip()
            if key:
                zotero_groups.setdefault(key, []).append(path)
        zotero_dups = [[note_info(self.db, p) for p in sorted(g)] for g in zotero_groups.values() if len(g) > 1]
        result = {"exact": sorted(exact), "near": near_groups, "zotero": zotero_dups}
        self._duplicates = (version, result)
        return result

    def related(self, path: str, limit: int = 10) -> dict:
        """Everything related to a note: its links, backlinks, similar notes and notes sharing rare tags."""
        linked = links(path)
        refs = {p: note_info(self.db, p) for p in linked["links_to"] + linked["linked_from"] if not p.endswith("(no note)")}
        return {**linked, "refs": refs, "similar": self.similar_notes(path, limit), "shared_tags": shared_tags(path, limit)}

    def _fts_candidates(self, terms: list[str], pool: int) -> list[int]:
        """SQLite fallback, cheapest first: chunks with all the words; if few, all but one of them (AND queries only
        touch the overlap of posting lists); then any of the rarer words. ORing every word would score ~150k
        chunks when a query has "machine" or "learning" in it."""
        quoted = ['"' + t.replace('"', "") + '"' for t in terms][:8]
        kw = self._fts(" AND ".join(quoted), pool * 3)
        seen = set(kw)
        if len(kw) < pool and len(quoted) > 2:
            for i in range(len(quoted)):
                kw += [cid for cid in self._fts(" AND ".join(quoted[:i] + quoted[i + 1:]), pool) if cid not in seen]
                seen.update(kw)
        if len(kw) < pool and len(quoted) > 1:
            rare = [q for q in quoted if self._df(q) < 3000]
            if rare:
                kw += [cid for cid in self._fts(" OR ".join(rare), pool * 3) if cid not in seen]
        return kw

    def _fts(self, match: str, limit: int) -> list[int]:
        try:
            return [r[0] for r in self.db.execute(
                "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0, 2.0) "
                "LIMIT ?", (match, limit))]
        except sqlite3.OperationalError:
            return []

    def _df(self, quoted_term: str, cap: int = 3000) -> int:
        """How many chunks contain the term, counted only up to `cap` (a few ms)."""
        try:
            return self.db.execute("SELECT count(*) FROM (SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?)",
                                   (quoted_term, cap)).fetchone()[0]
        except sqlite3.OperationalError:
            return cap

    def _filter_ids(self, ids: list[int], allowed: set[str]) -> list[int]:
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        paths = dict(self.db.execute(f"SELECT id, path FROM chunks WHERE id IN ({placeholders})", ids))
        return [i for i in ids if paths.get(i) in allowed]


def snippet(text: str, terms: list[str], width: int = 420) -> str:
    """The window of `width` chars holding the most query terms."""
    if len(text) <= width:
        return text
    lower = text.lower()
    best, best_hits = 0, -1
    for start in range(0, len(text) - width + 1, 60):
        window = lower[start:start + width]
        hits = sum(window.count(t) for t in terms)
        if hits > best_hits:
            best, best_hits = start, hits
    piece = text[best:best + width].strip()
    return ("…" if best else "") + piece + ("…" if best + width < len(text) else "")


# ---------------------------------------------------------------- notes

def resolve(path: str) -> Path:
    """File for a relative path (in the main folder, or `name:/rel` in a listed one) or a bare note name
    (Obsidian's [[name]] style)."""
    top, _, inner = split_prefixed(path)
    candidate = (top / inner).resolve()
    if top.resolve() not in candidate.parents:
        raise ValueError("path is outside the vault")
    if candidate.is_file():
        return candidate
    if not inner.endswith(".md") and candidate.with_name(candidate.name + ".md").is_file():
        return candidate.with_name(candidate.name + ".md")
    # A bare path written when another folder was the output (old chats cite ai_notes/x.md): the listed folder that
    # has it now.
    if top == VAULT:
        for f in LAYOUT.others:
            moved = (f.path / inner).resolve()
            if f.path.resolve() in moved.parents and moved.is_file():
                return moved
    name = Path(inner).name.removesuffix(".md")
    db = connect()
    row = db.execute("SELECT path FROM notes WHERE title=? ORDER BY length(path) LIMIT 1", (name,)).fetchone()
    if row:
        found_top, _, found = split_prefixed(row[0])
        return found_top / found
    raise FileNotFoundError(f"no note named {path!r}")


def index_path(file: Path) -> str:
    """The index path of a file in the main folder or a listed one."""
    for root in sorted(roots(), key=lambda r: -len(str(r.path))):  # a listed folder inside the main one wins
        try:
            return root.prefix + str(file.relative_to(root.path.resolve()))
        except ValueError:
            continue
    raise ValueError(f"{file} is not in a listed folder")


def document_file(path: str) -> Path:
    """The file behind an indexed PDF or image, in the main folder or a listed one (spec 018). Only paths the index
    holds as pdf/image documents, so this never opens an arbitrary file."""
    db = connect()
    row = db.execute("SELECT source FROM notes WHERE path=?", (path,)).fetchone()
    if not row or row[0] not in ("pdf", "image"):
        raise FileNotFoundError("no such PDF or image in the index")
    top, _, inner = split_prefixed(path)
    file = (top / inner).resolve()
    if top.resolve() not in file.parents or not file.is_file():
        raise FileNotFoundError("no such PDF or image in the index")
    return file


def note_path(path: str) -> str:
    """Index path for a vault path, a bare note name, a Zotero path (zotero/KEY) or a citation key (@key)."""
    db = connect()
    if path.startswith("@"):
        row = db.execute("SELECT path FROM notes WHERE source='zotero' AND json_extract(meta, '$.citekey')=?",
                         (path[1:],)).fetchone()
        if row:
            return row[0]
        # a library without Better BibTeX keys: the chat cites the Zotero item key itself (@GAK94SHA)
        if re.fullmatch(r"[A-Z0-9]{8}", path[1:]) and db.execute("SELECT 1 FROM notes WHERE path=?",
                                                                    (zotero.PREFIX + path[1:],)).fetchone():
            return zotero.PREFIX + path[1:]
        raise FileNotFoundError(f"no Zotero item with citation key {path!r}")
    if path.startswith(zotero.PREFIX):
        if db.execute("SELECT 1 FROM notes WHERE path=?", (path,)).fetchone():
            return path
        raise FileNotFoundError(f"no Zotero item {path!r}")
    return index_path(resolve(path))


def note_info(db: sqlite3.Connection, rel: str) -> dict:
    """Title, source and (for Zotero items) authors, year, citekey, DOI and links out, for display."""
    row = db.execute("SELECT title, source, meta FROM notes WHERE path=?", (rel,)).fetchone()
    if not row:
        return {"path": rel, "title": Path(rel).stem, "source": ""}
    info = {"path": rel, "title": row[0], "source": row[1]}
    if row[2]:
        info["zotero"] = json.loads(row[2])
    return info


PRIVACY_FILE = HOME / "privacy.json"
_private_cache: dict = {}


def privacy() -> dict:
    try:
        return json.loads(PRIVACY_FILE.read_text())
    except (OSError, ValueError):
        return {"private_folders": [], "private_tags": ["private", "no-ai"],
                "private_frontmatter": {"private": True, "ai": False}, "agent_read_max_chars": 12000,
                "agent_search_max_results": 10}


def private_paths() -> set[str]:
    """Notes and Zotero items agents must not see: in a private folder, tagged private / no-ai (Zotero tags count),
    or with `private: true` / `ai: false` in their frontmatter. Cached until the index or privacy.json changes."""
    db = connect()
    stamp = (db.execute("SELECT value FROM meta WHERE key='indexed_at'").fetchone() or [""])[0]
    mtime = PRIVACY_FILE.stat().st_mtime if PRIVACY_FILE.exists() else 0
    if _private_cache.get("key") == (stamp, mtime):
        return _private_cache["paths"]
    rules = privacy()
    folders = [f.strip("/") + "/" for f in rules.get("private_folders", []) if f.strip("/")]
    tags = {t.lstrip("#").lower() for t in rules.get("private_tags", [])}
    flags = {k.lower(): str(v).lower() for k, v in rules.get("private_frontmatter", {}).items()}
    hidden = set()
    for path, note_tags, frontmatter in db.execute("SELECT path, tags, frontmatter FROM notes"):
        if any(path.startswith(f) for f in folders) or tags & {t.lower() for t in (note_tags or "").split()}:
            hidden.add(path)
            continue
        if frontmatter and flags:
            try:
                fields = {k.lower(): str(v).lower() for k, v in json.loads(frontmatter).items()}
            except ValueError:
                continue
            if any(fields.get(k) == v for k, v in flags.items()):
                hidden.add(path)
    _private_cache.update(key=(stamp, mtime), paths=hidden)
    return hidden


def read_note(path: str, heading: str | None = None, max_chars: int = 30000, offset: int = 0) -> dict:
    rel = note_path(path)
    if rel.startswith(zotero.PREFIX) or not rel.lower().endswith(PLAIN_EXTENSIONS):
        # Zotero items, PDFs and images are read back from the index: the text extracted from them.
        db = connect()
        rows = db.execute("SELECT heading, text FROM chunks WHERE path=? ORDER BY ord", (rel,)).fetchall()
        wanted = heading.lower().strip("# ") if heading else None
        parts, last = [], None
        for h, t in rows:
            if wanted and wanted not in (h or "").lower():
                continue
            if h != last:
                parts.append(f"## {h}" if h else "")
                last = h
            parts.append(t)
        raw = "\n\n".join(p for p in parts if p)
        return {**note_info(db, rel), **_page(raw, offset, max_chars)}
    top, _, inner = split_prefixed(rel)
    raw = (top / inner).read_text(encoding="utf-8", errors="replace")
    text = raw
    if heading:
        wanted = heading.lower().strip("# ")
        sections = split_sections(parse_frontmatter(raw)[1])
        matching = [f"{h}\n{t}" for h, t in sections if wanted in h.lower()]
        text = "\n\n".join(matching) if matching else raw
    return {"path": rel, **_page(text, offset, max_chars)}


def _page(text: str, offset: int, max_chars: int) -> dict:
    """One page of a long text; `next_offset` says where the next page starts (None at the end)."""
    offset = max(0, offset)
    end = offset + max_chars
    return {"chars": len(text), "offset": offset, "truncated": end < len(text),
            "next_offset": end if end < len(text) else None, "text": text[offset:end]}


def links(path: str) -> dict:
    rel = note_path(path)
    db = connect()
    outgoing = [r[0] for r in db.execute("SELECT dst FROM links WHERE src=? ORDER BY dst", (rel,))]
    resolved = []
    for dst in outgoing:
        if dst.startswith("@"):
            row = db.execute("SELECT path FROM notes WHERE source='zotero' AND json_extract(meta, '$.citekey')=?",
                             (dst[1:],)).fetchone()
            if not row:
                continue  # an @-mention that is not a citation key in the library
        else:  # a vault note wins over a Zotero item with the same title
            row = db.execute("SELECT path FROM notes WHERE title=? ORDER BY source='zotero', length(path) LIMIT 1",
                             (dst,)).fetchone()
        resolved.append(row[0] if row else f"{dst} (no note)")
    if rel.startswith(zotero.PREFIX):
        citekey = (note_info(db, rel).get("zotero") or {}).get("citekey")
        names = [f"@{citekey}"] if citekey else []
    else:
        names = [Path(rel).stem if rel.endswith(".md") else Path(rel).name]  # ![[photo.png]] keeps the extension
    backlinks = [r[0] for name in names
                 for r in db.execute("SELECT DISTINCT src FROM links WHERE dst=? ORDER BY src", (name,))]
    return {"path": rel, "links_to": resolved, "linked_from": backlinks}


COPY_SUFFIX = re.compile(r"(\s+[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})?(\s+[0-9a-f]{8})*\s*\[[0-9a-f]{8}\]$")


def copy_key(title: str) -> str:
    """Notion imports repeat a note as 'Title [3d1727f5]' or 'Title 3d1727f5 [3d1727f5]'; this maps all to 'title'."""
    return COPY_SUFFIX.sub("", title).strip().lower()


def shared_tags(path: str, limit: int = 10) -> list[dict]:
    """Notes sharing this note's tags, scored by how rare each shared tag is (log N/df)."""
    rel = note_path(path)
    db = connect()
    row = db.execute("SELECT tags FROM notes WHERE path=?", (rel,)).fetchone()
    tags = {t for t in row[0].split() if not JUNK_TAG.match(t)} if row and row[0] else set()
    if not tags:
        return []
    total = db.execute("SELECT count(*) FROM notes").fetchone()[0]
    scores: dict[str, float] = {}
    shared: dict[str, list[str]] = {}
    for tag in tags:
        others = [r[0] for r in db.execute("SELECT path FROM notes WHERE (' ' || tags || ' ') LIKE ? AND path != ?",
                                           (f"% {tag} %", rel))]
        if not others or len(others) > total * 0.2:  # tags on a fifth of the vault say nothing
            continue
        weight = float(np.log(total / (len(others) + 1)))
        for other in others:
            scores[other] = scores.get(other, 0) + weight
            shared.setdefault(other, []).append(tag)
    own = copy_key(Path(rel).stem)
    ranked = [p for p in sorted(scores, key=scores.get, reverse=True) if copy_key(Path(p).stem) != own]
    return [{**note_info(db, p), "tags": sorted(shared[p]), "score": round(scores[p], 2)} for p in ranked[:limit]]


FRESH_EVERY = 300  # seconds between automatic checks for changed notes


def background_priority() -> None:
    """Runs the calling thread at macOS background QoS (efficiency cores, throttled disk). For indexing inside the
    server: the server itself runs at normal priority so searches stay fast (a Background LaunchAgent made /related
    4.5x slower), while re-indexing still never competes with what the user is doing."""
    if sys.platform == "darwin":
        try:
            ctypes.CDLL(None).pthread_set_qos_class_self_np(0x09, 0)  # QOS_CLASS_BACKGROUND
        except (OSError, AttributeError):
            pass


def keep_fresh(every: int = FRESH_EVERY, on_check=None) -> None:
    """Re-index changed notes now and every `every` seconds. Only one process indexes at a time (index locks)."""
    background_priority()
    while True:
        if on_check:
            on_check()
        try:
            index(verbose=False)
        except Exception:
            pass
        time.sleep(every)


def recent(days: int = 7, folder: str | None = None, limit: int = 50) -> list[dict]:
    db = connect()
    sql, args = "SELECT path, title, source, mtime FROM notes WHERE mtime >= ?", [time.time() - days * 86400]
    if folder:
        sql += " AND path LIKE ?"
        args.append(f"{folder.strip('/')}/%")
    sql += " ORDER BY mtime DESC LIMIT ?"
    args.append(limit)
    return [{"path": p, "title": t, "source": s, "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(m))}
            for p, t, s, m in db.execute(sql, args)]


def coverage() -> list[dict]:
    """Per source: documents, chunks, and chunks searchable by meaning (with a vector)."""
    db = connect()
    docs = dict(db.execute("SELECT source, count(*) FROM notes GROUP BY source"))
    # Counted per path first (index-only), then summed per source: a join per row took 3-5x longer.
    chunks = dict(db.execute("SELECT n.source, sum(c.n) FROM (SELECT path, count(*) n FROM chunks GROUP BY path) c "
                             "JOIN notes n ON n.path=c.path GROUP BY 1"))
    vectors = dict(db.execute("SELECT n.source, sum(v.n) FROM (SELECT path, count(*) n FROM vecs GROUP BY path) v "
                              "JOIN notes n ON n.path=v.path GROUP BY 1"))
    media_read = db.execute("SELECT count(*), sum(length(trim(text)) >= ?) FROM media_cache", (media.MIN_TEXT,)).fetchone()
    rows = [{"source": s, "documents": n, "chunks": chunks.get(s, 0), "with_vectors": vectors.get(s, 0)}
            for s, n in sorted(docs.items(), key=lambda kv: -kv[1])]
    return rows + [{"source": "_media_read", "documents": media_read[0] or 0, "chunks": media_read[1] or 0,
                    "with_vectors": 0}]


def stats() -> dict:
    db = connect()
    stamp = db.execute("SELECT value FROM meta WHERE key='indexed_at'").fetchone()
    return {
        "vault": str(VAULT),
        "notes": db.execute("SELECT count(*) FROM notes").fetchone()[0],
        "chunks": db.execute("SELECT count(*) FROM chunks").fetchone()[0],
        "chunks_with_vectors": db.execute("SELECT count(*) FROM vecs").fetchone()[0],
        "by_source": dict(db.execute("SELECT source, count(*) FROM notes GROUP BY source ORDER BY 2 DESC")),
        "indexed_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(float(stamp[0]))) if stamp else None,
    }


def audit_report(days: float) -> None:
    """What AI agents received from the index recently (data/agent-access.log, written by http_api.audit)."""
    from collections import Counter

    log = HOME / "data" / "agent-access.log"
    since = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - days * 86400))
    entries = [e for e in (json.loads(l) for l in log.read_text().splitlines() if l.strip()) if e["at"] >= since] \
        if log.exists() else []
    chars = sum(e["chars"] for e in entries)
    print(f"Agent requests in the last {days:g} day(s): {len(entries)}, {chars:,} characters (~{chars // 4:,} tokens)")
    for route, n in Counter(e["route"] for e in entries).most_common():
        print(f"  {route:10} {n}")
    reads = Counter(p for e in entries if e["route"] in ("/note", "/zotero") for p in e["notes"])
    if reads:
        print("Most-read notes:")
        for path, n in reads.most_common(10):
            print(f"  {n:3}  {path}")


def sources_report() -> dict:
    """The folder list as the Folders page shows it: each folder's detected kind, role and document count."""
    db = connect()
    counts = {"": 0, "zotero/": 0}
    for (path,) in db.execute("SELECT path FROM notes"):
        name, sep, _ = path.partition(":/")
        key = f"{name}:/" if sep else ("zotero/" if path.startswith(zotero.PREFIX) else "")
        counts[key] = counts.get(key, 0) + 1
    ignored = {f.name for f in LAYOUT.ignored}
    rows = []
    for f in LAYOUT.folders:
        if not f.enabled:
            role, documents = "off", 0
        elif f.name in ignored:
            role, documents = "ignored", counts.get(f.prefix, 0)
        elif f.kind == "zotero":
            role, documents = "zotero", counts["zotero/"]
        elif f.path.resolve() == VAULT.resolve():
            role, documents = "main", counts[""]
        else:
            role, documents = "listed", counts.get(f.prefix, 0)
        rows.append({"name": f.name, "path": str(f.path), "enabled": f.enabled, "skip": f.skip, "kind": f.kind,
                     "role": role, "documents": documents})
    output = next((f.name for f in LAYOUT.folders if f.main and f.path.resolve() == VAULT.resolve()), None)
    return {"main": str(VAULT), "main_is_vault": LAYOUT.main_is_vault, "output": {"name": output, "path": str(VAULT)},
            "main_documents": counts[""] if not LAYOUT.main_is_vault else None,
            "zotero": str(LAYOUT.zotero) if LAYOUT.zotero else None, "folders": rows}


def sources_cli(action: str, target: str | None, name: str | None) -> None:
    try:
        if action == "add":
            if not target:
                raise sources.SourceError("give the folder's path: kb.py sources add PATH [--name N]")
            folder = sources.add(target, name)
            print(f"added {folder.name}: {folder.path} ({folder.kind}); run `kb.py index` to read it")
        elif action == "output":
            sources.set_output(target)
            print(f"notes now go to {target or 'the Veritas folder'}")
        elif action in ("remove", "on", "off"):
            if not target:
                raise sources.SourceError(f"give the folder's name: kb.py sources {action} NAME")
            sources.remove(target) if action == "remove" else sources.update(target, enabled=action == "on")
            print(f"{target}: {action}; run `kb.py index` to apply it")
    except KeyError as error:
        sys.exit(f"no folder named {error.args[0]!r}")
    except sources.SourceError as error:
        sys.exit(str(error))
    reload_layout()
    report = sources_report()
    for f in report["folders"]:
        print(f"{f['name']:<20} {f['role']:<8} {f['kind']:<9} {f['documents']:>7}  {f['path']}")
    if not report["main_is_vault"]:
        print(f"{'(Veritas folder)':<20} {'main':<8} {'plain':<9} {report['main_documents']:>7}  {report['main']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("index")
    p.add_argument("--full", action="store_true")
    p.add_argument("--reread-zotero", action="store_true")
    p.add_argument("--reread-media", action="store_true")
    p = sub.add_parser("search")
    p.add_argument("query")
    p.add_argument("-k", type=int, default=8)
    p.add_argument("--source")
    p.add_argument("--not-source")
    p.add_argument("--folder")
    p.add_argument("--tag")
    p = sub.add_parser("read")
    p.add_argument("path")
    p.add_argument("--heading")
    p = sub.add_parser("links")
    p.add_argument("path")
    p = sub.add_parser("related")
    p.add_argument("path")
    p = sub.add_parser("serve")
    p.add_argument("--port", type=int, default=int(os.environ.get("KB_PORT", "27182")))
    p = sub.add_parser("recent")
    p.add_argument("--days", type=int, default=7)
    sub.add_parser("stats")
    p = sub.add_parser("audit")
    p.add_argument("--days", type=float, default=1)
    p = sub.add_parser("sources", help="the folders the index reads (spec 018)")
    p.add_argument("action", nargs="?", default="list", choices=["list", "add", "remove", "on", "off", "output"])
    p.add_argument("target", nargs="?", help="a folder path (add) or a folder name")
    p.add_argument("--name")
    args = parser.parse_args()
    if args.cmd == "index":
        import signal

        signal.signal(signal.SIGTERM, lambda *_: STOP.set())  # "Stop" in the plugin: finish the batch, then exit
        index(full=args.full, reread_zotero=args.reread_zotero, reread_media=args.reread_media)
    elif args.cmd == "search":
        for r in Searcher().search(args.query, args.k, args.source, args.folder, args.tag,
                                    exclude_source=args.not_source):
            print(f"[{r['score']}] {r['path']}")
            for passage in r["passages"]:
                print(f"    § {passage['heading'] or '(top)'}: " + passage["snippet"].replace("\n", " ")[:240])
    elif args.cmd == "read":
        print(read_note(args.path, args.heading)["text"])
    elif args.cmd == "links":
        print(json.dumps(links(args.path), indent=2, ensure_ascii=False))
    elif args.cmd == "related":
        print(json.dumps(Searcher().related(args.path), indent=2, ensure_ascii=False))
    elif args.cmd == "serve":
        import http_api

        http_api.serve(args.port)
    elif args.cmd == "recent":
        print(json.dumps(recent(args.days), indent=2, ensure_ascii=False))
    elif args.cmd == "audit":
        audit_report(args.days)
    elif args.cmd == "sources":
        sources_cli(args.action, args.target, args.name)
    else:
        print(json.dumps(stats(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
