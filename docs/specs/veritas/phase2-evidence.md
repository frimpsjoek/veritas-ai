# Phase 2 evidence (2026-10-22)

## Checks

`./check.sh` → all parts passed: tools 15 · agent 799 · ui 284 · web 45 · obsidian 27 · zotero 11 · server 310 passed,
3 skipped (the 3 need a real Zotero library and index; tests/conftest.py keeps the suite off the machine's own data).

| Task | Commit | Tests added |
|---|---|---|
| 1 Output folder (`~/Documents/Veritas` unless a listed notes folder is chosen) | 234bd74 | test_output_folder.py (6) |
| 1b Vector reuse when a note moves or changes in part | a9f551a | test_vector_reuse.py (2) |
| 2 Connector registry (zotero, obsidian, pdf, plain, zotero-web) | 6886205 | test_connectors.py (4) |
| 3 Every enabled Zotero library (`<name>:/zotero/KEY` beyond the default) | cf7565b | test_zotero_libraries.py (6) |
| 4 Zotero online library (Web API, key in the Keychain) | see git log | test_zotero_web.py (8) |
| 5 "+ Add" to the default library (online: Web API; local: plugin queue) | see git log | test_pending_adds_target.py (2) |
| 6 Chats mirrored as Markdown in `<output>/chats/` | 566d105 | chat-markdown.test.js (8), test_spawn_passes_notes_dir |
| 7 Zotero plugin as a client of the server only | fc0ac4f | client-only.test.mjs (4) |

## Live check (port 27191, Veritas's own data folder)

- The index was copied from the running Second Brain server (SQLite backup of kb.sqlite, the keyword index and the
  sources list), not rebuilt: 4,021 documents, 84,114 passages, 84,114 vectors. `kb.py index` on the copy → 0 changed,
  0 embedded, 0.0 s.
- `GET /sources` → output folder `lab-notebook` (main, 487 notes), Zotero library 3,534 items.
- `/search?q=GW quasiparticle substrate screening` → Zotero items first.
- `POST /sources` with a folder holding one PDF → kind `pdf`; `DELETE /sources/pdf-test` removes it.

Not exercised live: a chat turn writing its `.md` mirror (unit-tested; a live turn needs a model run); the Zotero
plugin inside Zotero (not installed into the live Zotero); an online Zotero account (no account configured).
