"""chat_audit.py (spec 026 R22): chats that name a Zotero item the guard rejects are listed by path only."""
from __future__ import annotations

import json

import chat_audit

SENTINEL = "QUOTED-PRIVATE-SENTENCE-7f3a"


def write_chats(folder):
    folder.mkdir(parents=True)
    read = [{"type": "meta", "id": "01J", "mode": "chat", "title": "Read one", "created": "2026-11-01T10:00:00Z"},
            {"type": "user", "text": "Read zotero/FORE1234 for me", "at": "2026-11-01T10:00:01Z"},
            {"type": "assistant", "answer": {"text": f"It says: {SENTINEL} [@FORE1234]", "citations": [{"ref": {"kind": "paper", "citekey": "FORE1234"}}]},
             "at": "2026-11-01T10:00:05Z"}]
    clean = [{"type": "meta", "id": "01K", "mode": "chat", "title": "Clean", "created": "2026-11-02T10:00:00Z"},
             {"type": "assistant", "answer": {"text": "About [@MINE5678] and zotero/MINE5678 only", "citations": []}, "at": "2026-11-02T10:00:05Z"}]
    (folder / "01J.jsonl").write_text("\n".join(json.dumps(r) for r in read) + "\n")
    (folder / "01K.jsonl").write_text("\n".join(json.dumps(r) for r in clean) + "\n")
    mirrors = folder / "mirror"
    mirrors.mkdir()
    (mirrors / "2026-11-01 Read one (01J).md").write_text(f"# Read one\n\n## Veritas\n\nIt says: {SENTINEL} [@FORE1234]\n")
    (mirrors / "2026-11-02 Clean (01K).md").write_text("# Clean\n\n## Veritas\n\nAbout [@MINE5678]\n")
    return folder


def test_mentions_in_all_three_forms():
    assert chat_audit.mentions('zotero/ABCD1234 and [@EFGH5678] and "citekey": "IJKL9012" but not zotero/short') == {"ABCD1234", "EFGH5678", "IJKL9012"}


def test_listing_names_the_chat_and_its_mirror_but_prints_no_chat_text(tmp_path, capsys):
    folder = write_chats(tmp_path / "chats")
    hits = chat_audit.scan([folder], {"FORE1234"})
    assert [h["path"] for h in hits] == [str(folder / "01J.jsonl"), str(folder / "mirror" / "2026-11-01 Read one (01J).md")]
    assert hits[0]["keys"] == ["FORE1234"] and hits[0]["records"] == 2  # the user turn and the answer
    for hit in hits:
        print(f"{hit['path']}\t{len(hit['keys'])} foreign key(s): {' '.join(hit['keys'])}\t{hit['records']} record(s)")
    out = capsys.readouterr().out
    assert "01J.jsonl" in out and SENTINEL not in out and "It says" not in out


def test_cli_with_a_keys_file_prints_paths_and_counts_only(tmp_path, capsys):
    folder = write_chats(tmp_path / "chats")
    keys = tmp_path / "keys.txt"
    keys.write_text("FORE1234\n")
    chat_audit.cli([str(folder)], str(keys))
    captured = capsys.readouterr()
    assert captured.out.count("\n") == 2 and "01K" not in captured.out and "Clean" not in captured.out
    assert SENTINEL not in captured.out + captured.err and "It says" not in captured.out + captured.err
    assert "2 of 4 chat files" in captured.err


def test_a_chat_that_names_no_foreign_key_is_not_listed(tmp_path):
    folder = write_chats(tmp_path / "chats")
    assert chat_audit.scan([folder], {"NONE0000"}) == []
    assert chat_audit.scan([tmp_path / "missing"], {"FORE1234"}) == []
