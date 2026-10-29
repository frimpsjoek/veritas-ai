"""import_data.py: a new install reuses an index another one built, copying it read-only (spec 024 G3)."""
import json
import sqlite3

import pytest

import import_data


def make_index(folder, passages=3, model=True):
    folder.mkdir(parents=True)
    con = sqlite3.connect(folder / "kb.sqlite")
    con.execute("PRAGMA journal_mode=WAL")  # as the server runs it: the copy must include what is still in the WAL
    con.execute("CREATE TABLE notes (path TEXT PRIMARY KEY)")
    con.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT)")
    con.execute("INSERT INTO notes VALUES ('a.md')")
    con.executemany("INSERT INTO chunks (path) VALUES (?)", [("a.md",)] * passages)
    con.commit()
    (folder / "tantivy").mkdir()
    (folder / "tantivy" / "meta.json").write_text("{}")
    (folder / "sources.json").write_text(json.dumps({"folders": []}))
    (folder / "agent" / "chats").mkdir(parents=True)
    (folder / "agent" / "agentd.json").write_text('{"port": 1}')
    (folder / "agent" / "codex-home" / "tmp").mkdir(parents=True)
    if model:
        m = folder / "models" / "snowflake-arctic-embed-s"
        (m / "onnx").mkdir(parents=True)
        (m / "onnx" / "model.onnx").write_bytes(b"onnx")
        (m / "tokenizer.json").write_text("{}")
    return con  # left open, like a running server's connection


def test_copies_index_keyword_index_folders_agent_and_model(tmp_path):
    source, dest = tmp_path / "old", tmp_path / "new"
    live = make_index(source)
    result = import_data.import_data(source, dest)
    live.close()
    assert result["passages"] == 3 and result["notes"] == 1
    assert sqlite3.connect(dest / "kb.sqlite").execute("SELECT count(*) FROM chunks").fetchone()[0] == 3
    assert (dest / "tantivy" / "meta.json").exists() and (dest / "sources.json").exists()
    assert (dest / "agent" / "chats").is_dir() and not (dest / "agent" / "agentd.json").exists()
    assert not (dest / "agent" / "codex-home").exists()
    assert (dest / "models" / "snowflake-arctic-embed-s" / "onnx" / "model.onnx").read_bytes() == b"onnx"
    assert set(result["copied"]) == {"kb.sqlite", "tantivy", "sources.json", "agent", "models"}


def test_source_is_left_unchanged(tmp_path):
    source = tmp_path / "old"
    live = make_index(source)  # still open, as when another server is running on it
    before = {p.name: p.stat().st_mtime_ns for p in source.iterdir()}
    import_data.import_data(source, tmp_path / "new")
    assert {p.name: p.stat().st_mtime_ns for p in source.iterdir()} == before
    live.close()


def test_second_brain_layout_keeps_models_beside_data(tmp_path):
    root = tmp_path / "obsidian-kb"
    make_index(root / "data", model=False).close()
    m = root / "models" / "snowflake-arctic-embed-s"
    (m / "onnx").mkdir(parents=True)
    (m / "onnx" / "model.onnx").write_bytes(b"x")
    (m / "tokenizer.json").write_text("{}")
    result = import_data.import_data(root / "data", tmp_path / "new")
    assert "models" in result["copied"]


def test_refuses_an_empty_source_and_an_existing_index(tmp_path):
    with pytest.raises(ValueError, match="no Veritas index"):
        import_data.import_data(tmp_path / "missing", tmp_path / "new")
    make_index(tmp_path / "old").close()
    make_index(tmp_path / "new").close()
    with pytest.raises(ValueError, match="already has an index"):
        import_data.import_data(tmp_path / "old", tmp_path / "new")
    assert import_data.import_data(tmp_path / "old", tmp_path / "new", replace=True)["passages"] == 3


def test_find_lists_known_places_in_order_except_this_install(tmp_path, monkeypatch):
    brew, legacy, own = tmp_path / "brew", tmp_path / "legacy", tmp_path / "own"
    for folder in (brew, legacy, own):
        make_index(folder).close()
    monkeypatch.setattr(import_data, "known_places", lambda home=None: [own, tmp_path / "absent", brew, legacy])
    assert [f["path"] for f in import_data.find(dest=own)] == [str(brew), str(legacy)]
