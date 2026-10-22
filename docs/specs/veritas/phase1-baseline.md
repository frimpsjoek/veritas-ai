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

## After Tasks 2–5 (`./check.sh`)

tools 12 · agent 792 · ui 284 · web 45 (ui + web = 329, the baseline) · obsidian 27, type-check clean, build ok (main.js is git-ignored, so the rebuild was not compared byte for byte; an earlier note saying it was identical was wrong)
· zotero 7 + xpi 0.53.0 · server 281 passed, 3 skipped (277 + 4 layout tests). A deliberate web → obsidian import
makes `./check.sh` exit 1 at the boundary step.

## Task 6 live check (2026-10-22, port 27191, own empty data folder)

- One notes folder listed (a lab notebook, 480 notes, 6 PDFs); `kb.py index` → 35,363 passages embedded in 904 s
  (onnx, CPU).
- `kb.py serve --port 27191` with `SECOND_BRAIN_AGENTD_ENTRY` unset: `/ping` → ok; agentd runs from
  `<repo>/agent/dist/agentd.mjs`; `/agent/ping` with the token → ok.
- `web/install.sh` → `server/data/web/index.html`; `/app/` serves `app-<hash>.js` and `app-<hash>.css`.
- `/search?q=GW quasiparticle` → 3 results from the listed folder.
- The second-brain dev server on port 27190 kept running, untouched.
