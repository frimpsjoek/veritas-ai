"""Processes and locks on Windows and Linux as well as macOS (spec 024 G2)."""
from __future__ import annotations

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
