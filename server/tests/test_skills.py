"""Skills endpoints (spec 011 U3): list/get/put/delete against a TEMP vault, never the real one.

Run with the .venv python: `.venv/bin/python -m pytest tests/test_skills.py -v`.
"""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import kb
import skills

TEXT = "---\nname: Demo\ndescription: A demo.\n---\nDo the demo.\n"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "VAULT", tmp_path / "vault")
    (tmp_path / "vault").mkdir()
    return tmp_path / "vault"


@pytest.fixture
def api(vault, tmp_path, monkeypatch):
    token_file = tmp_path / "api-token"
    token_file.write_text("sekret")
    monkeypatch.setattr(http_api, "TOKEN_FILE", token_file)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, data, headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, (json.loads(raw) if raw else None)

    yield call
    server.shutdown()
    server.server_close()


def test_put_get_list_roundtrip_in_the_vault_folder(api, vault):
    status, saved = api("PUT", "/skills/Demo", {"text": TEXT})
    assert status == 200 and saved["name"] == "Demo" and len(saved["hash"]) == 64
    assert (vault / "Second Brain" / "Skills" / "Demo" / "SKILL.md").read_text() == TEXT
    assert api("GET", "/skills/Demo")[1]["text"] == TEXT
    listed = api("GET", "/skills")[1]
    assert [e["name"] for e in listed] == ["Demo"] and listed[0]["text"] == TEXT


def test_list_is_empty_without_a_folder_and_ignores_stray_files(api, vault):
    assert api("GET", "/skills") == (200, [])
    base = vault / "Second Brain" / "Skills"
    (base / "NoFile").mkdir(parents=True)
    (base / "loose.md").write_text("x")
    assert api("GET", "/skills")[1] == []


def test_unknown_skill_is_404(api):
    assert api("GET", "/skills/Nope")[0] == 404
    assert api("DELETE", "/skills/Nope")[0] == 404


@pytest.mark.parametrize("bad", ["..", "a..b", "%2e%2e", "a%2Fb", "..%2Fx", "a%5Cb", "%2Fetc", ".hidden", "trail.", "x" * 65])
def test_names_with_separators_or_traversal_are_refused_everywhere(api, vault, bad):
    for method, body in (("GET", None), ("PUT", {"text": TEXT}), ("DELETE", None)):
        status, _ = api(method, f"/skills/{bad}", body)
        assert status == 400, (method, bad)
    assert not any(vault.rglob("SKILL.md"))


def test_nothing_is_written_outside_the_skills_folder(api, vault, tmp_path):
    api("PUT", "/skills/..%2F..%2F..%2Foutside", {"text": TEXT})
    assert not (tmp_path / "outside").exists() and not (vault / "outside").exists()


def test_oversize_save_is_refused_and_oversize_file_is_listed_without_text(api, vault):
    assert api("PUT", "/skills/Big", {"text": "x" * (skills.MAX_BYTES + 1)})[0] == 413
    folder = vault / "Second Brain" / "Skills" / "Huge"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text("y" * (skills.MAX_BYTES + 10))
    entry = next(e for e in api("GET", "/skills")[1] if e["name"] == "Huge")
    assert entry["oversize"] is True and entry["text"] is None


def test_delete_moves_to_trash_and_never_removes(api, vault):
    api("PUT", "/skills/Demo", {"text": TEXT})
    assert api("DELETE", "/skills/Demo")[0] == 200
    base = vault / "Second Brain" / "Skills"
    assert not (base / "Demo").exists()
    kept = list((base / ".trash").glob("Demo-*/SKILL.md"))
    assert len(kept) == 1 and kept[0].read_text() == TEXT
    assert api("GET", "/skills")[1] == []  # the trash is not a skill
    # the same name deleted twice in one second keeps both
    api("PUT", "/skills/Demo", {"text": TEXT})
    api("DELETE", "/skills/Demo")
    assert len(list((base / ".trash").glob("Demo-*"))) == 2


def test_overwrite_replaces_the_text(api):
    api("PUT", "/skills/Demo", {"text": TEXT})
    api("PUT", "/skills/Demo", {"text": TEXT + "More.\n"})
    assert api("GET", "/skills/Demo")[1]["text"].endswith("More.\n")


def test_a_remote_host_needs_the_bearer_token(api):
    remote = {"Host": "mac.tail1234.ts.net"}
    assert api("GET", "/skills", headers=remote)[0] == 401
    assert api("PUT", "/skills/Demo", {"text": TEXT}, headers=remote)[0] == 401
    assert api("DELETE", "/skills/Demo", headers=remote)[0] == 401
    ok = {**remote, "Authorization": "Bearer sekret"}
    assert api("PUT", "/skills/Demo", {"text": TEXT}, headers=ok)[0] == 200
    assert api("GET", "/skills", headers=ok)[0] == 200


def test_agents_cannot_reach_skills(api):
    assert api("GET", "/skills", headers={"X-KB-Client": "agent"})[0] == 403
    assert api("PUT", "/skills/Demo", {"text": TEXT}, headers={"X-KB-Client": "agent"})[0] == 403


def test_symlinked_skills_are_ignored_and_refused(vault, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text(TEXT)
    base = skills.root()
    base.mkdir(parents=True)
    (base / "linked").symlink_to(outside, target_is_directory=True)
    real = base / "filelink"
    real.mkdir()
    (real / "SKILL.md").symlink_to(outside / "SKILL.md")
    skills.put_skill("good", TEXT)
    assert [s["name"] for s in skills.list_skills()] == ["good"]
    assert skills.get_skill("linked") is None
    assert skills.get_skill("filelink") is None
    with pytest.raises(skills.BadName):
        skills.put_skill("linked", "x")
    with pytest.raises(skills.BadName):
        skills.put_skill("filelink", "x")
    assert (outside / "SKILL.md").read_text() == TEXT
    assert skills.trash_skill("linked") is False
    assert (base / "linked").is_symlink() and (outside / "SKILL.md").exists()


def test_skills_root_symlink_outside_vault_is_still_listed_from_its_own_target(vault, tmp_path):
    # Skills/ itself being a link is the user's choice; entries are judged against its resolved root.
    target = tmp_path / "elsewhere"
    target.mkdir()
    skills.root().parent.mkdir(parents=True)
    skills.root().symlink_to(target, target_is_directory=True)
    skills.put_skill("one", TEXT)
    assert [s["name"] for s in skills.list_skills()] == ["one"]
