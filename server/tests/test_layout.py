"""Veritas repo layout (phase 1): the server finds agentd and the plugin builds in their parts beside server/."""
from pathlib import Path

import agent_api
import http_api
import kb

REPO = kb.HOME.parent


def test_agentd_entry_in_repo(monkeypatch):
    monkeypatch.delenv("SECOND_BRAIN_AGENTD_ENTRY", raising=False)
    assert agent_api._agentd_entry().resolve() == (REPO / "agent" / "dist" / "agentd.mjs").resolve()


def test_agentd_entry_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("SECOND_BRAIN_AGENTD_ENTRY", str(tmp_path / "agentd.mjs"))
    assert agent_api._agentd_entry() == tmp_path / "agentd.mjs"


def test_zotero_dist_in_repo():
    assert http_api.ZOTERO_DIST.resolve() == (REPO / "zotero" / "dist").resolve()


def test_obsidian_dist_in_repo():
    assert http_api.OBSIDIAN_DIST.resolve() == (REPO / "obsidian" / "dist-versions").resolve()
