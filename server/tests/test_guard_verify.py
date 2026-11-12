"""kb.py verify-guard (spec 026 R25): counts, across SQLite chunks, FTS, vectors and Tantivy, of what an index still
holds of the texts the guard rejects. It prints keys and numbers, never text, and it cannot pass by having checked
nothing. Uses the fixture library of test_text_guard_effect.py."""
from __future__ import annotations

import json
import sqlite3

import pytest

import guard_verify
import kb
import zotero
from test_text_guard_effect import (ATT_FOREIGN, ATT_MINE, FOREIGN, FOREIGN_SENTINEL, HIGHLIGHT_SENTINEL, MINE, OK_SENTINEL,
                                    TWO, TWO_SENTINEL, add_two_attachment_item, library, make_searcher, tantivy_hits)  # noqa: F401

SENTINELS = (FOREIGN_SENTINEL, HIGHLIGHT_SENTINEL, OK_SENTINEL, TWO_SENTINEL, "questionnaire", "Questionnaire", "Tenancy")


def run(data, capsys) -> tuple[int, str, dict]:
    status = guard_verify.cli(str(data))
    out, err = capsys.readouterr()
    for sentinel in SENTINELS:
        assert sentinel not in out + err, "verify-guard prints keys and numbers, never text"
    totals = dict(pair.split("=") for pair in out.strip().splitlines()[-1].split() if "=" in pair)
    return status, out, {k: int(v) for k, v in totals.items() if v.isdigit()}


def old_guard(monkeypatch):
    real = zotero.judge_text
    monkeypatch.setattr(zotero, "judge_text", lambda *a, **k: zotero.TextDecision(True, "old-guard"))
    return lambda: monkeypatch.setattr(zotero, "judge_text", real)


def test_a_clean_index_passes_with_every_count_zero(library, capsys):
    kb.index(verbose=False)
    tantivy_hits(make_searcher(), OK_SENTINEL)  # builds the Tantivy folder
    status, out, totals = run(library[1], capsys)
    assert status == 0 and out.strip().endswith("clean")
    assert totals["rejected"] == 1 and totals["probes"] > 0
    assert (totals["chunks"], totals["fts"], totals["vectors"], totals["tantivy"], totals["full_text"]) == (0, 0, 0, 0, 0)


def test_an_index_built_before_the_guard_fails_in_every_store(library, monkeypatch, capsys):
    restore = old_guard(monkeypatch)
    kb.index(verbose=False)
    tantivy_hits(make_searcher(), OK_SENTINEL)
    restore()
    status, out, totals = run(library[1], capsys)
    assert status == 1 and "NOT clean" in out
    assert totals["chunks"] > 0 and totals["fts"] > 0 and totals["vectors"] > 0 and totals["tantivy"] > 0 and totals["full_text"] > 0
    assert any(line.startswith(f"{FOREIGN} ") for line in out.splitlines()) and not any(line.startswith(f"{MINE} ") for line in out.splitlines())


def test_text_left_only_in_tantivy_is_found(library, monkeypatch, capsys):
    """What the full-text chunk count could never see: SQLite is clean, the keyword index still holds the text."""
    add_two_attachment_item(library[0])
    restore = old_guard(monkeypatch)
    kb.index(verbose=False)
    tantivy_hits(make_searcher(), TWO_SENTINEL)  # Tantivy in step with the old index
    restore()
    monkeypatch.setattr(zotero, "TEXT_GUARD_VERSION", zotero.TEXT_GUARD_VERSION + 1)
    kb.index(verbose=False)  # SQLite is cleaned; no Searcher runs, so the Tantivy folder is as it was
    status, out, totals = run(library[1], capsys)
    assert status == 1 and (totals["chunks"], totals["fts"], totals["full_text"]) == (0, 0, 0) and totals["tantivy"] > 0
    assert any(line.startswith(f"{TWO} ") for line in out.splitlines())
    tantivy_hits(make_searcher(), "linewidths")  # the server's next sync rebuilds it
    status, out, totals = run(library[1], capsys)
    assert status == 0 and totals["tantivy"] == 0


def test_highlights_of_a_rejected_attachment_are_looked_for(library, monkeypatch, capsys):
    """The text is gone but the highlight quoting it is still indexed: not clean."""
    kb.index(verbose=False)
    db = kb.connect()
    kb.store_note(db, f"zotero/{FOREIGN}", "t", "zotero", "zotero", [], [], 1.0, 1, "", None,
                  f"# t\n\n## Highlights\n\n> {HIGHLIGHT_SENTINEL} sentence (p. 2)")
    db.commit()
    status, out, totals = run(library[1], capsys)
    assert status == 1 and totals["chunks"] == 1 and totals["fts"] == 1 and totals["full_text"] == 0


def test_nothing_to_verify_is_not_a_pass(library, capsys):
    (library[1]).mkdir(exist_ok=True)
    (library[1] / "text_overrides.json").write_text(json.dumps({ATT_FOREIGN: "mine"}))
    kb.index(verbose=False)
    status, out, totals = run(library[1], capsys)
    assert status == 2 and totals["rejected"] == 0 and "nothing to verify" in out


def test_a_missing_index_is_not_a_pass(library, tmp_path, capsys):
    assert guard_verify.cli(str(tmp_path / "nowhere")) == 2
    assert "no index" in capsys.readouterr().out


def test_overrides_are_read_from_the_index_folder_not_this_install(library, tmp_path, monkeypatch, capsys):
    """Each install has its own text_overrides.json: the index of install B is judged with B's file."""
    kb.index(verbose=False)  # this install: FOREIGN rejected, its text absent
    other = tmp_path / "other-install"
    other.mkdir()
    sqlite3.connect(other / "kb.sqlite").executescript(
        "CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT, ord INTEGER, heading TEXT, text TEXT);"
        "CREATE TABLE vecs (id INTEGER PRIMARY KEY, path TEXT, vec BLOB NOT NULL);"
        "CREATE VIRTUAL TABLE chunks_fts USING fts5(title, heading, text, tags, content='', contentless_delete=1, tokenize='porter unicode61');")
    (other / "text_overrides.json").write_text(json.dumps({ATT_MINE: "foreign"}))
    status, out, totals = run(other, capsys)
    assert totals["rejected"] == 2, "the other install's override rejects ATT_MINE as well"


def test_the_index_is_opened_read_only(library, capsys):
    kb.index(verbose=False)
    before = {p.name: p.stat().st_mtime_ns for p in library[1].rglob("*") if p.is_file()}
    run(library[1], capsys)
    assert {p.name: p.stat().st_mtime_ns for p in library[1].rglob("*") if p.is_file()} == before


def test_probe_phrases_are_plain_words_in_order():
    text = "The naïve tenancy agreement between the parties covers deposit, rent and <b>other</b> terms https://example.org/x."
    probes = guard_verify.phrases(text, limit=50)
    assert "tenancy agreement between the" in probes and all(p.isascii() and p == p.lower() for p in probes)
    assert not any("naive" in p or "other" in p or "example" in p for p in probes)
    assert guard_verify.phrases("tenancy agreement between the parties", 50, own=" tenancy agreement between the parties ") == []
    assert guard_verify.phrases("wrongdocquotation sentence", 3) == ["wrongdocquotation sentence"]
    assert guard_verify.phrases("my note", 3) == []
