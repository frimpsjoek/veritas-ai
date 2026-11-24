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


def test_plugin_builds_come_from_the_repo_or_the_data_folder_whichever_is_newer(monkeypatch, tmp_path):
    """The repo's builds beside server/; the desktop app has no repo, so <data dir>/plugins/ too (the newer wins)."""
    def publish(zotero_dir, obsidian_dir, version):
        zotero_dir.mkdir(parents=True, exist_ok=True)
        (zotero_dir / f"second-brain-{version}.xpi").write_bytes(b"PK")
        for name in ("main.js", "manifest.json", "styles.css"):
            (obsidian_dir / version).mkdir(parents=True, exist_ok=True)
            (obsidian_dir / version / name).write_text("x")
    repo, data = tmp_path / "repo", tmp_path / "data"
    monkeypatch.setattr(http_api.kb, "HOME", repo / "server")
    monkeypatch.setattr(http_api.kb, "data_dir", lambda: data)
    assert http_api._plugin_dirs() == (repo / "zotero" / "dist", repo / "obsidian" / "dist-versions")  # nothing yet
    publish(repo / "zotero" / "dist", repo / "obsidian" / "dist-versions", "0.53.0")
    publish(data / "plugins" / "zotero", data / "plugins" / "obsidian", "0.54.0")
    assert http_api._plugin_dirs() == (data / "plugins" / "zotero", data / "plugins" / "obsidian")
    publish(repo / "zotero" / "dist", repo / "obsidian" / "dist-versions", "0.55.0")
    assert http_api._plugin_dirs() == (repo / "zotero" / "dist", repo / "obsidian" / "dist-versions")


def test_a_released_app_offers_the_plugins_it_carries(monkeypatch, tmp_path):
    """Spec 033 R4: $VERITAS_PLUGINS (the app bundle's plugins) is a third place; the newest version wins."""
    bundle = tmp_path / "bundle"
    (bundle / "zotero").mkdir(parents=True)
    (bundle / "zotero" / "second-brain-0.56.0.xpi").write_bytes(b"PK")
    (bundle / "obsidian" / "0.56.0").mkdir(parents=True)
    for name in ("main.js", "manifest.json", "styles.css"):
        (bundle / "obsidian" / "0.56.0" / name).write_text("x")
    monkeypatch.setattr(http_api.kb, "HOME", tmp_path / "repo" / "server")
    monkeypatch.setattr(http_api.kb, "data_dir", lambda: tmp_path / "data")
    monkeypatch.setenv("VERITAS_PLUGINS", str(bundle))
    assert http_api._plugin_dirs() == (bundle / "zotero", bundle / "obsidian")
