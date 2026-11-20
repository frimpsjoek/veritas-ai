"""Spec 034: one path format (`/`) on every system. The migration is run with force=True, so it is checked on macOS
and Linux too, where it never runs by itself (a `\\` is a legal file-name character there)."""
import sqlite3

import kb


def _db():
    db = sqlite3.connect(":memory:")
    db.executescript(kb.SCHEMA)
    db.execute(kb.media.CACHE_SCHEMA)
    db.execute("ALTER TABLE notes ADD COLUMN meta TEXT")
    return db


def test_a_windows_index_moves_to_slash_paths_once_and_keeps_the_slash_twin():
    db = _db()
    db.execute("INSERT INTO notes (path, title) VALUES ('papers:/sub\\note.md', 'old form')")
    db.execute("INSERT INTO notes (path, title) VALUES ('papers:/a\\twin.md', 'old twin')")
    db.execute("INSERT INTO notes (path, title) VALUES ('papers:/a/twin.md', 'new twin')")
    db.execute("INSERT INTO chunks (id, path, ord, heading, text) VALUES (1, 'papers:/sub\\note.md', 0, '', 'x')")
    db.execute("INSERT INTO chunks (id, path, ord, heading, text) VALUES (2, 'papers:/a\\twin.md', 0, '', 'y')")
    db.execute("INSERT INTO vecs (id, path, vec) VALUES (1, 'papers:/sub\\note.md', x'00')")
    db.execute("INSERT INTO links (src, dst) VALUES ('papers:/sub\\note.md', 'papers:/a\\twin.md')")
    db.execute("INSERT INTO media_cache VALUES ('Papers\\A.pdf', 1, 2, 'pdf', 't')")
    changed = kb.posix_paths(db, force=True)
    assert changed > 0
    notes = dict(db.execute("SELECT path, title FROM notes"))
    assert notes == {"papers:/sub/note.md": "old form", "papers:/a/twin.md": "new twin"}
    assert [r[0] for r in db.execute("SELECT path FROM chunks ORDER BY id")] == ["papers:/sub/note.md"]  # the twin's chunk went with it
    assert db.execute("SELECT path FROM vecs").fetchone()[0] == "papers:/sub/note.md"
    assert db.execute("SELECT src, dst FROM links").fetchone() == ("papers:/sub/note.md", "papers:/a/twin.md")
    assert db.execute("SELECT path FROM media_cache").fetchone()[0] == "Papers/A.pdf"
    assert kb.posix_paths(db) == 0  # once: marked done in meta


def test_posix_turns_this_systems_separator_into_slash():
    import os
    from pathlib import PurePath
    assert kb.posix(f"sub{os.sep}note.md") == "sub/note.md"
    assert kb.posix(PurePath("sub") / "note.md") == "sub/note.md"
    assert kb.posix("plain.md") == "plain.md"
