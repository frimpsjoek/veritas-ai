"""abstracts: OpenAlex abstracts for Zotero items that have none; Zotero is never changed."""
from __future__ import annotations

import pytest

import abstracts
import kb


@pytest.fixture()
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(abstracts, "_cache", None)
    return tmp_path


def test_inverted_index_back_to_text():
    assert abstracts.from_index({"Spins": [0], "flip": [1], "here.": [2]}) == "Spins flip here."
    assert abstracts.from_index(None) == ""


def test_fill_asks_once_per_batch_and_keeps_answers(fresh):
    calls = []

    def get(url):
        calls.append(url)
        return {"results": [{"doi": "https://doi.org/10.1103/physrevb.1", "abstract_inverted_index": {"Bands": [0], "cross.": [1]}},
                            {"doi": "https://doi.org/10.1016/j.x.2", "abstract_inverted_index": None}]}
    assert abstracts.fill(["10.1103/PhysRevB.1", "10.1016/j.x.2", ""], get=get, now=0) == 1
    assert len(calls) == 1 and "filter=doi%3A10.1016%2Fj.x.2%7C10.1103%2Fphysrevb.1" in calls[0]
    assert abstracts.cached("10.1103/physrevb.1")[:2] == ("Bands cross.", "openalex")
    assert abstracts.cached("10.1016/j.x.2") is None
    abstracts.fill(["10.1103/physrevb.1", "10.1016/j.x.2"], get=get, now=86400)
    assert len(calls) == 1, "known abstracts and recent nones are not asked again"
    abstracts.fill(["10.1016/j.x.2"], get=get, now=(abstracts.RETRY_DAYS + 1) * 86400)
    assert len(calls) == 2, "a none is asked again after RETRY_DAYS"
    abstracts._cache = None
    assert abstracts.cached("10.1103/physrevb.1")[0] == "Bands cross.", "kept in data/abstracts.json"


def test_openalex_away_changes_nothing(fresh):
    def get(url):
        raise TimeoutError("timed out")
    assert abstracts.fill(["10.1/a"], get=get, now=0) == 0
    assert abstracts.cached("10.1/a") is None


def test_an_error_backs_off_for_an_hour_then_tries_again(fresh):
    calls = []

    def failing(url):
        calls.append(url)
        raise OSError("HTTP Error 429: Too Many Requests")
    abstracts.fill(["10.1/a"], get=failing, now=0)
    abstracts.fill(["10.1/a"], get=failing, now=600)
    assert len(calls) == 1, "no second try within the hour"
    stamp_after_error = abstracts.stamp()
    assert stamp_after_error > 0, "the error is written down, so the next index run reads Zotero again"
    abstracts.fill(["10.1/a"], get=lambda url: {"results": [{"doi": "https://doi.org/10.1/a", "abstract_inverted_index": {"Ok.": [0]}}]},
                   now=abstracts.BACKOFF_S + 1)
    assert abstracts.cached("10.1/a")[0] == "Ok."
