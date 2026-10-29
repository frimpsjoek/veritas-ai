"""Processes and locks on Windows and Linux as well as macOS (spec 024 G2)."""
from __future__ import annotations

import json
import signal
import subprocess
import sys

import pytest

import http_api
import kb


def test_index_lock_is_exclusive(tmp_path):
    """fcntl on macOS and Linux, msvcrt on Windows: a second holder is refused until the first lets go."""
    path = tmp_path / "index.lock"
    with open(path, "a") as first, open(path, "a") as second:
        assert kb._try_lock(first)
        assert not kb._try_lock(second)
        kb._unlock(first)
        assert kb._try_lock(second)
        kb._unlock(second)


@pytest.mark.parametrize("system, background", [("darwin", True), ("linux", False), ("win32", False)])
def test_indexing_process_starts_on_every_system(tmp_path, monkeypatch, system, background):
    """taskpolicy (background priority) exists only on macOS; elsewhere Python runs kb.py index itself."""
    started = {}
    monkeypatch.setattr(http_api.sys, "platform", system)
    monkeypatch.setattr(kb, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kw: started.update(args=args, kw=kw))
    http_api.start_indexing(None)
    args = started["args"]
    assert (args[0] == "/usr/sbin/taskpolicy") == background
    assert args[-3:] == [sys.executable, str(kb.HOME / "kb.py"), "index"]


@pytest.fixture()
def indexing_elsewhere(tmp_path, monkeypatch):
    """An indexing process (not this one) holds the lock and wrote its pid."""
    monkeypatch.setattr(kb, "PROGRESS_FILE", tmp_path / "index-progress.json")
    monkeypatch.setattr(kb, "STOP_FILE", tmp_path / "index-stop")
    monkeypatch.setattr(kb, "index_running", lambda: True)
    kb.PROGRESS_FILE.write_text(json.dumps({"pid": 4242}))
    kills = []
    monkeypatch.setattr(http_api.os, "kill", lambda pid, sig: kills.append((pid, sig)))
    kb.STOP.clear()
    return kills


@pytest.mark.parametrize("system, signalled", [("darwin", True), ("linux", True), ("win32", False)])
def test_stop_asks_the_indexing_process_through_a_file_and_signals_only_where_it_is_caught(
        indexing_elsewhere, monkeypatch, system, signalled):
    """On Windows os.kill(SIGTERM) is TerminateProcess: the run would die mid-batch. The stop file is read between
    batches on every system; SIGTERM stays the fast path where the process can catch it."""
    monkeypatch.setattr(http_api.sys, "platform", system)
    assert http_api.stop_indexing()
    assert kb.STOP_FILE.exists()
    assert indexing_elsewhere == ([(4242, signal.SIGTERM)] if signalled else [])


def test_indexing_stops_after_its_batch_when_the_stop_file_appears(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "PROGRESS_FILE", tmp_path / "index-progress.json")
    monkeypatch.setattr(kb, "STOP_FILE", tmp_path / "index-stop")
    kb.STOP_FILE.write_text("")  # a stop meant for an earlier run
    kb.clear_stop()
    assert not kb.STOP_FILE.exists() and not kb.STOP.is_set()
    progress = kb.Progress()
    progress.stage("notes", 10)
    progress.advance(1)
    kb.STOP_FILE.write_text("")
    with pytest.raises(kb.Stopped):
        progress.advance(2)
