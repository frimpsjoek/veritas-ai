import sqlite3

import pytest

import kb


def test_a_request_closes_its_connections_even_when_it_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "kb.sqlite")
    kept = kb.connect(keep=True)
    with pytest.raises(FileNotFoundError):
        with kb.request_scope():
            opened = [kb.connect(), kb.connect()]
            raise FileNotFoundError("no such note")
    for db in opened:
        with pytest.raises(sqlite3.ProgrammingError):
            db.execute("SELECT 1")
    with kb.request_scope():
        inside_keep = kb.connect(keep=True)
    assert kept.execute("SELECT 1").fetchone() == (1,)
    assert inside_keep.execute("SELECT 1").fetchone() == (1,)
    outside = kb.connect()
    assert outside.execute("SELECT 1").fetchone() == (1,), "outside a request nothing is tracked or closed"
