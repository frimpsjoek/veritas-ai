"""Reuse an index another install already built, instead of embedding the whole library again (spec 024 G3).

A new install (the desktop app, Homebrew) starts with an empty data folder. When this computer already has a Veritas
or Second Brain index, copying it takes seconds where re-embedding takes hours; the server's normal incremental index
then only reads the notes that changed (kb.py keeps a passage's vector when only its path changed).

    kb.py import-data --find      the data folders found on this computer, as JSON (most preferred first)
    kb.py import-data <folder>    copy that folder's index into this install's data folder

The source may belong to a running server, so it is only ever opened read-only: kb.sqlite through SQLite's backup
API (a consistent copy even while the other server writes), everything else by plain copy. Imports nothing of ours
but paths, so it runs without loading the index.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

import paths

MODEL = "snowflake-arctic-embed-s"


def known_places(home: Path | None = None) -> list[Path]:
    """Where an index may already be, most preferred first: another Veritas install (Homebrew on macOS and Linux),
    then the server of Second Brain, Veritas' predecessor, at the place its setup used."""
    home = home or Path.home()
    return [
        Path("/opt/homebrew/var/veritas"),
        Path("/usr/local/var/veritas"),
        Path("/home/linuxbrew/.linuxbrew/var/veritas"),
        home / "Documents" / "second-brain-dev" / "obsidian-kb" / "data",
    ]


def _read_only(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)


def describe(folder: Path) -> dict | None:
    """The folder's index in a sentence's worth of numbers, or None when it holds no usable index."""
    db = folder / "kb.sqlite"
    if not db.is_file():
        return None
    try:
        con = _read_only(db)
        try:
            passages = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
            notes = con.execute("SELECT count(*) FROM notes").fetchone()[0]
        finally:
            con.close()
    except sqlite3.Error:
        return None
    if not passages:
        return None
    return {"path": str(folder), "passages": passages, "notes": notes, "model": _model_dir(folder) is not None}


def _model_dir(folder: Path) -> Path | None:
    # a Veritas data folder keeps models/ inside it; Second Brain kept it beside data/
    for models in (folder / "models", folder.parent / "models"):
        if (models / MODEL / "onnx" / "model.onnx").is_file() and (models / MODEL / "tokenizer.json").is_file():
            return models / MODEL
    return None


def find(dest: Path | None = None, home: Path | None = None) -> list[dict]:
    """The usable indexes on this computer, except this install's own."""
    dest = (dest or paths.data_dir()).resolve()
    found = []
    for place in known_places(home):
        if place.exists() and place.resolve() != dest:
            info = describe(place)
            if info:
                found.append(info)
    return found


def import_data(source: Path, dest: Path | None = None, replace: bool = False) -> dict:
    """Copies the index, keyword index, folder list, agent data and search model from `source` into `dest`
    (this install's data folder). Refuses to overwrite an index that already has passages unless `replace`."""
    source = source.expanduser().resolve()
    dest = (dest or paths.data_dir()).resolve()
    info = describe(source)
    if info is None:
        raise ValueError(f"{source} holds no Veritas index (kb.sqlite with passages)")
    if source == dest:
        raise ValueError("that is this install's own data folder")
    if not replace and describe(dest):
        raise ValueError(f"{dest} already has an index; pass --replace to overwrite it")
    dest.mkdir(parents=True, exist_ok=True)

    # kb.sqlite: a backup into a new file, renamed into place, so the server never sees a half-copied index
    fresh = dest / ".kb.sqlite.import"
    fresh.unlink(missing_ok=True)
    src, out = _read_only(source / "kb.sqlite"), sqlite3.connect(fresh)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    for leftover in ("kb.sqlite-wal", "kb.sqlite-shm"):
        (dest / leftover).unlink(missing_ok=True)
    os.replace(fresh, dest / "kb.sqlite")

    # The keyword index only saves rebuilding it; keyword_index.py rebuilds from kb.sqlite when it does not match.
    copied = ["kb.sqlite"]
    if (source / "tantivy").is_dir():
        shutil.rmtree(dest / "tantivy", ignore_errors=True)
        shutil.copytree(source / "tantivy", dest / "tantivy")
        copied.append("tantivy")
    if (source / "sources.json").is_file():
        shutil.copy2(source / "sources.json", dest / "sources.json")
        copied.append("sources.json")
    if (source / "agent").is_dir() and not (dest / "agent").exists():
        # chats, reviews, routines, settings. Not agentd.json (the other server's running sidecar) nor codex-home
        # (the Codex CLI's own home: sign-in, caches and temporary files, which the provider recreates).
        shutil.copytree(source / "agent", dest / "agent", symlinks=True,
                        ignore=shutil.ignore_patterns("agentd.json", "codex-home"))
        copied.append("agent")
    model = _model_dir(source)
    target = dest / "models" / MODEL
    if model and not (target / "onnx" / "model.onnx").is_file():
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(model, target)
        copied.append("models")
    return {**info, "copied": copied, "into": str(dest)}


def cli(target: str | None, find_only: bool, replace: bool) -> None:
    if find_only:
        print(json.dumps(find(), indent=2))
        return
    if not target:
        sys.exit("give the data folder to import from, or --find")
    try:
        result = import_data(Path(target), replace=replace)
    except (ValueError, OSError, sqlite3.Error) as error:
        sys.exit(f"import-data: {error}")
    print(json.dumps(result, indent=2))
