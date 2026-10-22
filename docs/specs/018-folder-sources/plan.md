# Plan: spec 018

Spec approved 2026-10-20 with D1 and D2 as recommended. Four units: three on the server in order, the web and plugin
unit after U2. Server work on branch `ai/015-folders` (obsidian-kb), client work on `ai/015-folders` in ZP and OP.

| Unit | Goals | Where | Builds on |
|---|---|---|---|
| U1 | G1 list of folders, detection, Zotero discovery, main folder | new `sources.py`, `kb.py` config block | `kb.VAULT`, `zotero.ZOTERO`, `zotero_files.PREFS` |
| U2 | G2 + G3 indexing every folder, paths, no-Zotero setups | `kb.py` (`vault_files`, `_index`, `index_media`, `resolve`, `note_path`), `zotero.py`, `media.py` | notes stage, `media.media_files(root)`, `index_zotero` |
| U3 | G4 server side: CLI and `/sources` routes | `kb.py main`, `http_api.py` | `request_class` (http_api.py:120), `/index` |
| U4 | G4 Folders section; plugins open non-vault results in the web reader | ZP `ui-src/src/web/pages.js` (Settings), new `folders-view.js`; OP open handler | spec 013 note and PDF readers, `coverage()` |

Seams I own: the route list in `http_api.py`'s docstring, `ROADMAP.md` ticks, the spec Status line.

## U1: sources

Data shape: `data/sources.json` = `{"version": 1, "folders": [{"name", "path", "enabled", "skip": []}]}`.

1. `sources.py`:
   - `load()` / `save()` (atomic write, like `skills.py`), `validate_name()` (`[a-z0-9-]{1,32}`, unique, not `zotero`).
   - `detect(path) -> "zotero" | "obsidian" | "plain"`: `zotero.sqlite` file, else `.obsidian/` dir, else plain.
   - `discover_zotero()`: read `extensions.zotero.dataDir` (and `useDataDir`) from the `prefs.js` that
     `zotero_files.PREFS` finds, else `~/Zotero`; return the folder if `zotero.sqlite` is there.
   - `seed()`: with no file, write `[KB_VAULT or ~/Documents/Second-Brain if it exists]` + `discover_zotero()`
     (or `KB_ZOTERO`). Names: the folder's base name, lower-cased and slugged; Zotero is `zotero`.
   - `resolved()`: enabled folders with their detected kind; the main folder (first `obsidian`, else
     `home_folder()`); the Zotero folder (first `zotero`; later ones flagged `ignored`).
   - `home_folder()`: `~/Second-Brain-Home`, created on first write need, not at load.
2. `kb.py`: `VAULT` becomes the main folder from `sources.resolved()` at import; `zotero.ZOTERO` is set from the
   Zotero folder (or `None`). Env vars still win when no `sources.json` exists (seed).
3. Tests `tests/test_sources.py`: detection on three temp folders; seed from today's layout (temp vault + temp Zotero
   dir); `prefs.js` with and without `dataDir`; name validation; main folder falls back to home; two Zotero folders.

## U2: indexing every folder

1. `vault_files(root, prefix, kinds)`: today's walk with the root as a parameter; plain folders also take
   `.markdown` and `.txt`; dot folders skipped everywhere; `SKIP_DIRS`/`SKIP_NAME` only for Obsidian vaults; per-folder
   `skip` globs. Rel paths get `prefix` (`""` for the main folder, `name:/` for the others).
2. `_index`: loop over `resolved()` non-Zotero folders; `known` and `removed` are computed per prefix so one folder
   never deletes another's rows; a folder switched off or removed has its prefix's rows deleted.
3. Notes stage per file: `note_source` for the main folder and other Obsidian vaults as today; plain folders get
   source = folder name. Title: frontmatter `title`, else first `# heading` (plain folders only, so today's titles do
   not move), else stem. Links: wikilinks for all; Markdown links to `.md` files in the same folder for plain ones.
4. `index_media`: per folder through `media.media_files(root)`; `media_cache` keys get the same prefix.
5. `index_zotero`: skipped when `zotero.ZOTERO is None`; `zotero.py`, `paper_notes.py:175`, `pdf_route.py:92` read
   the module value as today.
6. `resolve()` / `note_path()`: a `name:/rel` path maps to that folder's root, with the same outside-the-folder check;
   bare names still look up by title. `read_note`, `links`, `/file` go through these.
7. "Needs Zotero": `/zotero*`, `/paper-note*`, `/paper-figure` answer 409 `{error: "needs_zotero"}` when there is no
   Zotero folder (`http_api.py` guard).
8. Tests: fixture with a vault + plain folder (`papers`) + no Zotero: paths, titles, links, `source=papers`, removal,
   `read_note` on `papers:/x.md`; Zotero-less routes; existing suite unchanged.

## U3: CLI and routes

1. `kb.py sources list | add PATH [--name] | remove N | on N | off N` (prints detected kind and counts).
2. `GET /sources` (folders, detected kind, counts per folder from `coverage()` summed by prefix, main folder, Zotero
   discovery result), `POST /sources {path, name?}`, `PATCH /sources/<name> {enabled?, skip?}`,
   `DELETE /sources/<name>`. Writes allowed for local and token requests only; agents (`X-KB-Client: agent`) get 403
   on every method (changed from "read only" while building: they have no use for it). A change starts an index run (`POST /index` path).
3. Tests: route tests in `tests/test_sources_api.py` incl. 403 foreign, 403 agent write, 400 unreadable path, 409
   duplicate name.

## U4: web app and plugins

1. ZP `ui-src/src/web/folders-view.js` (named Folders: the radar already owns "Sources"): list with kind icon, path,
   counts, on/off, Remove with confirm; Add folder (path + name, server error shown inline). Mounted as a section of
   Settings in `pages.js`.
2. Search results and Notes view: a `name:/` path opens the web note reader; PDFs the web PDF reader (already there
   for Zotero PDFs; add a `/file?path=` stream for folder PDFs, same range code as `pdf_route.py`).
3. OP: results whose path has `:/` open the web app reader in the browser instead of `openLinkText`; ZP the same.
4. Checks: web harness (`dev/*-checks.mjs`) Folders at 1280/700/360 px; OP `views.test.ts`-style unit test for the
   open handler.

## Order and checks

U1 → U2 → U3 on the server branch, each with `pytest tests/`; U4 after U2. Before merge: full server suite, ZP
`npm test` (agent-src, ui-src), OP `npx tsc -p .`, `eval.py` hit@5 ≥ 9/11 on the real index (owed on the main
computer, which holds the real vault and Zotero), and the G1 identity check (`/status`, eval results, `/related`
sample before vs after) on the real data. One lockstep release after U4.

## Progress

- [x] U1 sources.py, detection, Zotero discovery, main folder [2026-10-20, cbee281; tests/test_sources.py]
- [x] U2 indexing every folder, `name:/` paths, missing folders kept, needs_zotero [2026-10-20, 09f6df1; tests/test_folder_index.py]
- [x] U3 CLI, /sources routes, seeded vault stays main [2026-10-20, 776eae4; tests/test_sources_api.py; suite 220 passed, 3 skipped]
- [x] U4 Folders section in the web app; `/folder-file?path=` streams indexed PDFs/images from any folder (server 018acc0); listed-folder results open in the web reader from the web app, Zotero and Obsidian [2026-10-20, ZP c0ed155 + layout commit, OP e839784; ui-src unit 317/317, harness web 319 / weblib 159 / webphone 36 with 0 failures, OP tests 27/27 + tsc, zotero build.sh with OP beside it]
- [ ] Live checks owed: in real Zotero and Obsidian, open a listed-folder result (not run: no Second Brain server with real data on this Mac)
- [ ] Checks owed on real data (main computer): G1 identity check (`/status`, eval results, `/related` sample before vs after), `eval.py` hit@5 >= 9/11
