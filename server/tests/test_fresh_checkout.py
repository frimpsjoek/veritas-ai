"""A fresh checkout has no data/ folder and the tests never reach the machine's own Veritas folder."""
from __future__ import annotations

import kb
import sources


def test_progress_creates_its_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "PROGRESS_FILE", tmp_path / "no-data-yet" / "index-progress.json")
    progress = kb.Progress()
    progress.stage("notes", 3)
    progress.advance(3)
    progress.finish() if hasattr(progress, "finish") else None
    assert (tmp_path / "no-data-yet" / "index-progress.json").is_file()


def test_tests_never_write_the_real_veritas_folder():
    from pathlib import Path
    assert sources.OUTPUT_DEFAULT != Path.home() / "Documents" / "Veritas"
    assert "veritas-tests-" in str(sources.OUTPUT_DEFAULT)
