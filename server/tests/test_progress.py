"""kb.Progress stage list (spec 019 G1)."""
from __future__ import annotations

import json

import pytest

import kb


@pytest.fixture()
def progress(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "PROGRESS_FILE", tmp_path / "index-progress.json")
    kb.STOP.clear()
    return kb.Progress()


def states(p):
    return [(r["name"], r["state"]) for r in p.state["stages"]]


def written():
    return json.loads(kb.PROGRESS_FILE.read_text())


def test_stages_advance_in_order_and_skip_what_had_nothing_to_do(progress):
    assert states(progress) == [("notes", "waiting"), ("media", "waiting"), ("zotero", "waiting"), ("embedding", "waiting")]
    progress.stage("notes", 10)
    progress.advance(4)
    assert states(progress)[0] == ("notes", "running") and progress.state["stages"][0]["done"] == 4
    progress.stage("media", 3)
    progress.stage("embedding", 100)  # Zotero had not changed: its stage never started
    progress.advance(40)
    assert states(progress) == [("notes", "done"), ("media", "done"), ("zotero", "skipped"), ("embedding", "running")]
    row = progress.state["stages"][3]  # the file is written at most once a second; the state is current
    assert (row["done"], row["total"]) == (40, 100)
    assert written()["stages"][2]["state"] == "skipped"  # a stage change is written at once
    progress.finish({"ok": True})
    assert states(progress) == [("notes", "done"), ("media", "done"), ("zotero", "skipped"), ("embedding", "done")]
    assert written()["running"] is False


def test_a_stopped_or_failed_run_says_where(progress):
    progress.stage("notes", 2)
    progress.stage("media", 5)
    progress.finish(stopped=True)
    assert states(progress) == [("notes", "done"), ("media", "stopped"), ("zotero", "waiting"), ("embedding", "waiting")]
