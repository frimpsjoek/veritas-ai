# Spec 034: one path format on every system (Windows)

Status: APPROVED 2026-11-20 (user: "fix the windows bugs next").

## What happens today

The first Check on Windows (2026-11-20) failed in the server tests:
- index paths of listed folders are built with the system's separator: `papers:/sub\methods note.md` on Windows,
  `papers:/sub/methods note.md` elsewhere (`kb.index_path`, `kb.vault_files`, `media.media_files`); paths returned for
  paper notes, AI notes and sync-conflict copies the same (`paper_notes`, `agent_api`, `http_api`). Links, citations
  and the plugins compare paths as text, so on Windows a note's path differs from what they expect.
- `tests/test_pdf_route.py` and `tests/test_sources.py` wrote a Windows path into a prefs.js string without the escaping
  Zotero itself writes (test mistakes, not bugs).

## Goals

- R1. Every path Veritas stores or answers with uses `/`, on every system (one helper, `kb.posix`).
- R2. An existing Windows index is moved over once, at the server's start: every stored path with `\` becomes the same
  path with `/` (notes, chunks, vectors, links, the media cache); a path that already exists in both forms keeps the
  `/` one. Done once (`meta` `paths_posix`); nothing is re-read or re-embedded. Only on Windows (a `\` is a legal
  character in a macOS or Linux file name).
- R3. The Windows job in check.yml blocks a release again once it passes.

## Way of working

Unit tests for the helper and the migration (run on every system), the Windows Check job in CI as the evidence.
