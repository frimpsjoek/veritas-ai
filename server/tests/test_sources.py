"""sources.py: folder list, detection, Zotero discovery, main folder (spec 018 U1)."""
from __future__ import annotations

import json

import pytest

import sources


@pytest.fixture()
def home(tmp_path, monkeypatch):
    for var in ("KB_VAULT", "KB_ZOTERO"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "DEFAULT_VAULT", tmp_path / "Documents" / "Second-Brain")
    monkeypatch.setattr(sources, "HOME_FOLDER", tmp_path / "Second-Brain-Home")
    monkeypatch.setattr(sources, "ZOTERO_PROFILES", tmp_path / "Profiles")
    monkeypatch.setattr(sources.Path, "home", lambda: tmp_path)
    return tmp_path


def vault(path):
    (path / ".obsidian").mkdir(parents=True)
    return path


def library(path):
    path.mkdir(parents=True)
    (path / "zotero.sqlite").write_bytes(b"")
    return path


def test_detect(home):
    assert sources.detect(vault(home / "v")) == "obsidian"
    assert sources.detect(library(home / "z")) == "zotero"
    (home / "p").mkdir()
    assert sources.detect(home / "p") == "plain"
    assert sources.detect(home / "nowhere") == "missing"


def test_zotero_data_dir_follows_prefs(home):
    prefs = home / "Profiles" / "abc.default" / "prefs.js"
    prefs.parent.mkdir(parents=True)
    custom = library(home / "Elsewhere" / "Zotero")
    prefs.write_text(f'user_pref("extensions.zotero.dataDir", "{custom}");\n'
                     'user_pref("extensions.zotero.useDataDir", true);\n')
    assert sources.discover_zotero() == custom
    prefs.write_text(f'user_pref("extensions.zotero.dataDir", "{custom}");\n'
                     'user_pref("extensions.zotero.useDataDir", false);\n')
    assert sources.zotero_data_dir(prefs) == home / "Zotero"
    assert sources.discover_zotero() is None  # ~/Zotero has no database here


def test_defaults_are_todays_setup_and_nothing_is_written(home):
    v = vault(home / "Documents" / "Second-Brain")
    z = library(home / "Zotero")
    layout = sources.resolved()
    assert layout.main == v and layout.main_is_vault
    assert layout.zotero == z
    assert layout.others == [] and layout.ignored == []
    assert not sources.FILE.exists()
    assert sources.seed() == [
        {"name": "second-brain", "path": str(v), "enabled": True, "skip": [], "main": True},
        {"name": "zotero", "path": str(z), "enabled": True, "skip": []}]
    assert json.loads(sources.FILE.read_text())["version"] == 1


def test_env_vars_seed_the_list(home, monkeypatch):
    v = vault(home / "MyVault")
    monkeypatch.setenv("KB_VAULT", str(v))
    monkeypatch.setenv("KB_ZOTERO", str(library(home / "Zot")))
    names = [(e["name"], e["path"]) for e in sources.defaults()]
    assert names == [("myvault", str(v)), ("zotero", str(home / "Zot"))]


def test_no_vault_means_home_folder_is_main(home):
    plain = home / "papers"
    plain.mkdir()
    sources.save([{"name": "papers", "path": str(plain), "enabled": True, "skip": []}])
    layout = sources.resolved()
    assert layout.main == home / "Second-Brain-Home" and not layout.main_is_vault
    assert [f.name for f in layout.others] == ["papers"] and layout.others[0].prefix == "papers:/"
    assert layout.zotero is None
    assert not (home / "Second-Brain-Home").exists()  # created on first write need, not on read


def test_second_vault_and_second_library(home):
    v1, v2 = vault(home / "a"), vault(home / "b")
    z1, z2 = library(home / "z1"), library(home / "z2")
    sources.save([{"name": n, "path": str(p), "enabled": True, "skip": []}
                  for n, p in (("a", v1), ("z1", z1), ("b", v2), ("z2", z2))])
    layout = sources.resolved()
    assert layout.main == v1
    assert [f.name for f in layout.others] == ["b"]
    assert layout.zotero == z1 and [f.name for f in layout.ignored] == ["z2"]


def test_disabled_and_missing_folders_are_not_read(home):
    v = vault(home / "v")
    p = home / "p"
    p.mkdir()
    sources.save([{"name": "v", "path": str(v), "enabled": True},
                  {"name": "p", "path": str(p), "enabled": False},
                  {"name": "gone", "path": str(home / "gone"), "enabled": True}])
    layout = sources.resolved()
    assert layout.others == [] and [f.name for f in layout.ignored] == ["gone"]


def test_add_update_remove(home):
    vault(home / "Documents" / "Second-Brain")
    p = home / "My Papers"
    p.mkdir()
    folder = sources.add(p)
    assert (folder.name, folder.kind) == ("my-papers", "plain")
    with pytest.raises(sources.SourceError):
        sources.add(p)  # already listed
    with pytest.raises(sources.SourceError):
        sources.add(home / "nowhere")
    q = home / "q"
    q.mkdir()
    for bad in ("my-papers", "zotero", "Bad Name", "-x"):
        with pytest.raises(sources.SourceError):
            sources.add(q, bad)
    sources.update("my-papers", enabled=False, skip=["drafts/*"])
    entry = [e for e in sources.load() if e["name"] == "my-papers"][0]
    assert entry["enabled"] is False and entry["skip"] == ["drafts/*"]
    sources.remove("my-papers")
    assert [e["name"] for e in sources.load()] == ["second-brain"]
    with pytest.raises(KeyError):
        sources.remove("my-papers")


def test_added_library_is_named_zotero(home):
    z = library(home / "Lib")
    assert sources.add(z).name == "zotero"
    assert sources.add(library(home / "Lib2")).name == "lib2"


def test_seeded_vault_stays_main_without_obsidian_folder(home):
    v = home / "Documents" / "Second-Brain"
    (v / "notes").mkdir(parents=True)  # never opened in Obsidian on this machine
    sources.seed()
    layout = sources.resolved()
    assert layout.main == v and layout.others == []
