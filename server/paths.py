"""Where the server keeps what it writes: data (index, settings, caches) and the search model.

By default `data/` and `models/` beside the code, as always. VERITAS_DATA moves both to a folder of their own, so an
install that replaces the code folder on every upgrade (Homebrew, the desktop app) keeps the user's data. Imports
nothing of ours, so any module can use it.
"""
from __future__ import annotations

import os
from pathlib import Path

HOME = Path(__file__).resolve().parent


def data_dir(home: Path | None = None) -> Path:
    """The data folder: $VERITAS_DATA, else <home>/data (home: the server folder)."""
    env = os.environ.get("VERITAS_DATA")
    return Path(env).expanduser() if env else (home or HOME) / "data"


def models_dir(home: Path | None = None) -> Path:
    """The model folder: $VERITAS_DATA/models, else <home>/models."""
    env = os.environ.get("VERITAS_DATA")
    return Path(env).expanduser() / "models" if env else (home or HOME) / "models"
