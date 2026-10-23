"""paths: VERITAS_DATA moves the data and the model out of the code folder; unset, nothing moves."""
from pathlib import Path

import paths


def test_default_is_beside_the_code(monkeypatch):
    monkeypatch.delenv("VERITAS_DATA", raising=False)
    assert paths.data_dir(Path("/srv/veritas/server")) == Path("/srv/veritas/server/data")
    assert paths.models_dir(Path("/srv/veritas/server")) == Path("/srv/veritas/server/models")


def test_veritas_data_moves_both(monkeypatch):
    monkeypatch.setenv("VERITAS_DATA", "/opt/homebrew/var/veritas")
    assert paths.data_dir(Path("/anything")) == Path("/opt/homebrew/var/veritas")
    assert paths.models_dir() == Path("/opt/homebrew/var/veritas/models")
