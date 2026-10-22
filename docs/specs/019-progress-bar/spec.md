# Spec: progress bar for building the index

Status: APPROVED 2026-10-20 (user: "GO ON"). Numbered 019 on 2026-10-21 (015 to 017 are taken on the main computer).
Written from the user's request of 2026-10-20: "we need to setup the progress bar for the embedding and knowledge
base build up." Part 1 of the plan "progress, keys, seeds, superuser" (approved 2026-10-20).

Builds on the folder-sources work (branch `ai/015-folders`): its Folders page is one of the places the bar shows.

## The problem

Building the index takes from seconds to over an hour (82,949 chunks at about 20 a second on a CPU-only Mac).
The server already knows how far it is: `kb.Progress` writes `data/index-progress.json` (stage, label, done,
total, rate, time left) and `GET /status` returns it as `indexing`. The web app shows only one line of text
("Updating…") on Settings > Search index, nothing anywhere else, and nothing says which stages are still to come.

## Goals

### G1. The server lists every stage

`indexing.stages`: the four stages in order (`notes`, `media`, `zotero`, `embedding`), each `{name, label, state:
done | running | waiting | skipped, done, total}`, plus the current one's `eta_seconds` as today. Written by
`kb.Progress` (the stage order is fixed; a stage with nothing to do is `skipped`). No new route.

### G2. A progress bar in the web app

- Settings > Search index and Settings > Folders: a bar for the current stage with "Making notes searchable by
  meaning · 22,784 of 82,949 · about 50 min left", the stage list under it (done stages ticked), and Stop
  (existing `POST /index/stop`). When idle: "Up to date · last built <time>", or the error.
- Everywhere else: a thin bar under the app header while a build runs, with the same line as a tooltip; clicking
  it opens Settings > Search index.
- The page asks `/status` every 2 s while a build runs and every 30 s otherwise.

## Success checks

- G1: unit test on `kb.Progress`: stages advance in order, skipped stages marked, `finish` marks all done.
- G2: harness (fixture `/status` with a running build, then an idle one) at 1280, 700 and 360 px: bar width matches
  done/total, stage list, header bar shows and hides, Stop calls `/index/stop`; no sideways scroll.
- Live: on the dev server, the bar moves through stages during a real build.

## Calls made in this spec (check while reading)

- One bar for the current stage plus a stage list, not one bar for the whole build: the stages differ in speed by
  orders of magnitude, so a single overall percentage would mislead.
- The Obsidian status-bar item keeps its own look; it gains nothing in this spec.

## Non-goals

- Progress for the Zotero plugin's own local model download (it has its own row).
- Pausing and resuming a build (Stop already keeps the work done so far).

## Progress

- [x] G1 stages in `kb.Progress` [2026-10-20, server 895f045; tests/test_progress.py; suite 226 passed]
- [x] G2 web progress bar, stage list, Stop, header bar [2026-10-20, ZP 49ddbc0; unit 319/319, harness web 341 / weblib 159 / webphone 36, 0 failures; checked by eye at 1280 px]
- [ ] Live: watch a real build move through the stages on the dev server (the build running at the time of writing was started by the old code, so it reports no stage list until the next run)
