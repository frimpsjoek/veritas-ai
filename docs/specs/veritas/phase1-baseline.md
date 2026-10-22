# Phase 1 baseline and evidence

## Before (source clones, 2026-10-22)

| Part | Command | Result |
|---|---|---|
| server (obsidian-kb @ 5edb6e7) | `KB_BACKEND=onnx .venv/bin/python -m pytest tests -q` | 280 passed |
| agent (zotero-plugin/agent-src @ 3086f3d) | `npm test` / `npm run typecheck` | 792 pass, 0 fail / clean |
| ui (zotero-plugin/ui-src) | `npm test` / `npm run typecheck` | 329 pass, 0 fail, then `dev/run.mjs` fails: Playwright Chromium not installed (pre-existing) / clean |
| zotero plugin | `node --test test/*.test.mjs` | 7 pass |
| obsidian (obsidian-plugin @ 72b2d79) | `npm test` / `npx tsc -p .` | 27 pass / clean |

## After Task 1 (veritas, fresh copy)

| Part | Result |
|---|---|
| server (`server/.venv` from `requirements.txt`, Python 3.12.11) | 277 passed, 3 skipped: `test_collections.py` needs a built index (`kb.sqlite` with collections); Veritas starts with empty data |
