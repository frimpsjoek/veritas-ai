# Spec: folder sources — index any list of folders; Obsidian vaults and Zotero are recognised, not configured

Status: APPROVED 2026-10-20 (user: "continue with the spec"). D1 decided 2026-10-20 as recommended (first Obsidian vault, else ~/Second-Brain-Home); D2 decided 2026-10-20 as recommended (Markdown, text, PDF, images).
Written from the user's requests of 2026-10-20:

- "we should be able to connect to other vaults and also technically we should be able to have any kind of database
  with md files and pdfs so its not necessarily tied to zotero or obsidian"
- "any kind of folder with md or pdf files but can connect to obsidian and zotero with the plugins and the
  extensions"; main collection in mind: plain folders.
- "the zotero and obsidian itself are simple folders on the device so why does it matter?"
- "so obsidian is close to people using Zotero it can find the sqlite as well"

Builds on the indexer (`kb.py`), PDF and image reading (`media.py`), the Zotero reader (`zotero.py`) and the web app
(spec 013).

## The idea

Everything is a folder. The user gives the server a list of folders; the server looks at each one and reads it the
best way it can:

| The folder has | Read as |
|---|---|
| `zotero.sqlite` | Zotero library: paper details, collections, notes and highlights from the database, full text from `storage/` (today's `zotero.py`) |
| `.obsidian/` | Obsidian vault: today's note reading (wikilinks, folder labels, `Papers/` paper notes) |
| neither | plain folder: Markdown, text, PDFs and images |

No "kind" to choose. Plain folders also get `[[wikilinks]]` and frontmatter when they have them, so a vault that was
added before Obsidian was ever opened in it reads the same.

**Zotero is found, not added.** Most people who keep notes in Obsidian also use Zotero on the same machine. When the
list has no Zotero folder, the server looks for the library where Zotero keeps it (the `extensions.zotero.dataDir`
pref in Zotero's `prefs.js`, which `zotero_files.py:27` already locates, else `~/Zotero`) and, if a `zotero.sqlite` is there, adds it
as a source switched on. The user can switch it off.

## The problems today

1. **One folder, fixed by an environment variable.** `kb.VAULT` (`kb.py:40`) is `KB_VAULT` or
   `~/Documents/Second-Brain`; `vault_files` (`kb.py:269`) and `index_media` (`kb.py:544`) walk only it.
2. **Zotero is a fixed stage.** `index_zotero` runs every time (`kb.py:498`) from `KB_ZOTERO` or `~/Zotero`
   (`zotero.py:23`); it cannot be pointed elsewhere or switched off.
3. **Writes go into that one folder.** AI notes (`agent_api.py:222`), digests (`radar_api.py:200`), paper notes
   (`paper_notes.py:83`) and skills (`skills.py:37`) all write under `kb.VAULT`.

## Goals

### G1. A list of folders

- `data/sources.json`: `[{name, path, enabled}]`. `name` is short and unique and is the label in the search source
  filter. What each folder is (Zotero, Obsidian, plain) is detected at every index run and shown, never stored as
  a setting.
- First start after the update with no `sources.json`: written from today's setup (the current vault, then Zotero
  through the discovery above). Nothing the user sees changes and the index is not rebuilt.
- `KB_VAULT` and `KB_ZOTERO` keep working for one release as seeds when no `sources.json` exists.

### G2. Every folder is searchable the same way

- Files read from any non-Zotero folder: `.md`, `.markdown`, `.txt`, and the PDFs and images `media.py` reads
  (`media.media_files(root)` already takes a folder). Dot folders are skipped, plus optional per-folder `skip`
  patterns.
- Title: frontmatter `title`, else the first `# heading`, else the file name. Links: `[[wikilinks]]` and Markdown
  links to files in the same folder. Tags: frontmatter and `#tags`.
- Obsidian vaults also keep today's extras: folder labels and weights (`SOURCE_WEIGHTS`, `kb.py:62`), `[[name]]`
  lookup (`resolve`, `kb.py:1153`), `Papers/` paper notes, sync-conflict handling.
- Paths: the main folder (the first Obsidian vault, else the home folder of D1; it is always indexed) keeps bare
  relative paths, so today's index, links and plugin "open note" calls stay valid; every other folder is stored
  as `<name>:/<relative path>`; Zotero stays `zotero/KEY`.
- Search, related, links, read note, the MCP tools and the web app's Notes view accept all of these. Removing or
  switching off a folder deletes its rows on the next run.

### G3. Works with no Obsidian and no Zotero

- A list with only plain folders indexes, searches, serves the web app and answers MCP tools.
- Features that write notes use the home folder (D1); features that need Zotero (paper details, Add to Zotero,
  highlights) say "Needs Zotero" instead of failing.
- The plugins stay clients of the same server. A result from a folder that is not the Obsidian vault opens in the
  web app's reader; Zotero items open in Zotero as today.

### G4. Add and manage folders

- Web app Settings gets **Folders**: each folder with what it was recognised as, its path, its item count
  (`coverage()`, `kb.py:1371`, summed per folder rather than per label), an on/off switch and Remove. **Add folder**
  takes a path on the server's machine and a name, checks it is readable, and starts an index run.
- CLI: `kb.py sources list | add PATH [--name N] | remove N | on N | off N`.
- HTTP: `GET/POST /sources`, `PATCH/DELETE /sources/<name>`; local or token requests only, like the other writes.

## Success checks

- G1: today's data folder starts with a generated `sources.json` (vault + discovered Zotero); `/status` counts, the
  `eval.py` results and a `/related` sample are identical before and after.
- G2: a fixture folder (Markdown with and without frontmatter, wikilinks and Markdown links, a text PDF, a scanned
  PDF, an image) added as `papers` gives the expected titles, links and `papers:/...` paths; `--source papers`
  returns only them; read note and related work; removing it deletes its rows. A second fixture with `.obsidian/`
  is recognised as a vault; one with `zotero.sqlite` (test library) as Zotero.
- G3: a fresh data folder with one plain folder and no Zotero on the machine: index, search, MCP tools and web app
  work; Zotero-only routes return "Needs Zotero", not a 500. The existing server tests pass unchanged.
- G4: harness check of the Folders section at 1280, 700 and 360 px (add, switch off, remove); CLI and route tests
  including 403 for foreign requests.
- `eval.py` hit@5 on the existing set stays at or above 9/11.

## Decisions for the user (recommended first)

- D1. **Where AI notes, digests, paper notes and skills are written**: into the first Obsidian vault in the list,
  else a home folder `~/Second-Brain-Home` created on first need (recommended); or those features are off without
  an Obsidian vault.
- D2. **File types in plain folders**: Markdown, text, PDF and images (recommended); or Markdown and PDF only; or also
  Word (.docx) and HTML (adds a converter).

## Calls made in this spec (check while reading)

- Detection by marker files (`zotero.sqlite`, `.obsidian/`), never a user setting. One exception: the vault seeded
  from today's setup carries `"main": true` and stays the main folder even without `.obsidian/` (added in U3, so a
  vault never opened in Obsidian on that machine keeps its paths).
- `/sources` is not open to agents at all (they have no use for it).
- `add` refuses relative paths, the disk root, the home folder itself and anything inside a hidden folder: what is
  listed becomes readable through the API, also from the phone.
- Zotero is auto-discovered and added switched on when the list has none.
- The main folder keeps bare paths and is what `kb.VAULT` now means, so every writer (AI notes, digests, paper
  notes, skills) is unchanged; others `<name>:/`, so nothing is re-indexed.
- One Zotero library in v1: if the list has two, the first is used and the other is shown as ignored.
- Plain-folder results open in the web app reader from the plugins.
- Scanned PDFs on non-Mac machines: skipped in v1 (Apple Vision only); text-layer PDFs read everywhere.
- Order of work: G1, then G2 + G3, then G4; one release at the end.

## Non-goals

- Connecting a desktop Obsidian or Zotero to another machine's server (localhost lock in the Obsidian plugin's
  `api.ts:83`, no token in the Zotero plugin). Separate follow-up spec.
- Folders on another machine or cloud APIs (Dropbox, Google Drive); a folder is a path the server can read.
- Writing into plain folders (editing, highlighting).

## Note

Written on a Mac without a working checkout, from `origin/main` (last pushed 2026-10-12, roadmap at 0.50.3). If
the working checkout already has a spec 018, renumber this one. Numbered 018 on 2026-10-21 (015 to 017 are taken on the main computer).
