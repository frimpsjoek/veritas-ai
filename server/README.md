# obsidian-kb

A local search index over the Obsidian vault (`~/Documents/Second-Brain`) and the Zotero library (`~/Zotero`). Agents reach it through an MCP server; Obsidian on the Mac and the phone reaches it through the Second Brain Search plugin. Nothing leaves your own devices.

## How it works

- **Chunking** (`kb.py`). Notes are split at headings into chunks of about 1,400 characters. Before indexing, markdown links become plain text, and images, data URIs and long URLs are removed. Each chunk keeps its heading path, for example `Setup > Install`.
- **Keyword search.** SQLite FTS5 with BM25 ranking. The weights are title 4, heading 2, text 1 and tags 2.
- **Meaning search.** snowflake-arctic-embed-s vectors: 384 dimensions, CLS pooling, stored as float16. This is the same model LexImmigration uses (recall@5 0.839 there). The model runs on the GPU through MLX (`mlx_embed.py` reads the weights out of the ONNX file and matches onnxruntime at cosine 1.000). If MLX is unavailable, or `KB_BACKEND=onnx` is set, it runs on the CPU with onnxruntime. The whole vault embeds in about 21 minutes on an M2 Pro. MLX's buffer cache is capped at 128 MB and cleared after every batch; uncapped, it grew to 11 GB in one run. The model is copied into `models/`, so the index works without the Content drive.
- **Fusion.** The two rankings are combined with reciprocal rank fusion (k = 60). Vector hits below cosine `VECTOR_GATE` (0.55) are dropped. Each result's score is multiplied by its source weight (`ai_notes` 0.85), and results are grouped one per note with up to two passages. A passage whose text already appeared under another path is skipped.
- **Incremental updates.** Only notes whose mtime or size changed are re-indexed. Vectors are filled in a separate, resumable pass (`embed_pending`) that saves as it goes. Your own notes are embedded first; `ai_notes` come last, opening chunks before deeper ones.
- **Zotero** (`zotero.py`): one document per top-level item. It holds the metadata, abstract, your child notes, your PDF highlights and comments, and the full text Zotero already extracted (`storage/*/.zotero-ft-cache`, so no PDFs are parsed). The database is read through SQLite's backup API into a private copy, and Zotero's own file is never written. The Zotero stage is skipped when neither the database nor any full-text cache has changed. Items are stored as `zotero/KEY` with the source `zotero`. `[@citekey]` citations in notes become links to the paper. Housekeeping tags written by Zotero plugins (`#broken`, `/unread`, `zotmoov`…) are dropped.
- **PDFs and images in the vault** (`media.py`): PDF text comes from pdfium, one `## Page N` section per page, so results open at that page. Scanned pages and images are read with Apple Vision text recognition, on the device, at about 600 files a minute. Results are cached in `media_cache` per file version, including images with no text, which are never re-read. Only files with at least 25 characters of text become documents (sources `pdf` and `image`). Figures are not described, only the text in them.
- **Not indexed:** `*.conflict-macos-*` sync copies, `Excalidraw/`, `templates/`, `assets/`, `attachments/`, `CLAUDE.md` and `AGENTS.md`.

## Performance (2026-09-21, M2 Pro, ~290k chunks)

| | Before | After |
|---|---|---|
| Search | 250–430 ms | 10–13 ms (Tantivy keyword index, `keyword_index.py`) |
| Section match | 138 ms | 26 ms |
| Related notes | 45 ms | 28 ms |
| Vector scan | 123 ms (numpy fp16) | 2.4 ms (MLX, GPU) |
| New vectors picked up | 1–4 s full reload | ~30 ms append |
| Plugin action overhead | +440 ms status check | none (connection cached 30 s; `/ping` is 1 ms) |
| Agent sessions | ~500 MB each (own index copy) | a few MB (thin client of the one server) |

What changed:
- **Keyword search, cheapest first:** chunks with all the words; if few, all-but-one of the words; then the rarer words only.
- **Vectors on the GPU,** loaded incrementally. A partial index `chunks_with_vec` makes the "which chunks have vectors" queries cheap.
- **One index server** (`kb.py serve`) for everything. The MCP server (`server.py`) is a thin client that starts it if it isn't running.

### 2026-09-23: vectors in their own table

Vectors used to sit in `chunks` next to the text, so reading or counting them read the whole 1.3 GB file. With the Mac deep in swap, that made cold calls take tens of seconds. They now live in `vecs(id, path, vec)`; `kb.connect()` migrated the old layout once (63 s, then VACUUM). Timings from a fresh process:

| | Before | After |
|---|---|---|
| Re-index with no changes (every 5 min) | 8.4 s warm, 30 s logged | 0.3 s |
| Count of chunks still needing vectors | 1.2–6.8 s | 12 ms |
| `/status` coverage (plugins poll it) | 0.6–18 s | 0.15 s |
| `/zotero/status` (Zotero column) | 0.4–15 s | 0.1 s |
| `/duplicates` | 5–12 s every call | 2.4 s first, 21 ms cached until the index changes |
| Full vector reload | 1.9 s (22 s cold), on a search thread, hourly | 1.3 s in a background thread, swapped in between requests |

The chunk index is now `chunks(path, heading)`, so the Zotero column is answered from the index alone. Note vectors are summed with a sort and `reduceat` instead of `np.add.at` (4x faster, identical result). The Obsidian plugin no longer waits for the server before showing its sidebars. Backup of the old database: `data/kb.sqlite.bak-before-vecs`.

Recall with Zotero included: hit@5 9/11, hit@1 6/11 (the old code on the same index scored 8/11 and 5/11).

## Privacy: what agents may see

`privacy.json` controls this.
- **Private notes:** a note in a listed folder, tagged `#private` or `#no-ai`, or with `private: true` / `ai: false` in its frontmatter is hidden from agent requests (search, related, links, recent) and refused on read.
- **Size caps:** agent reads are capped at 12,000 characters per page (`offset` and `next_offset` page through the rest), and search returns at most 10 results.
- **Audit:** every agent request is logged to `data/agent-access.log`; `kb.py audit --days 1` summarises it.
- **Scope:** the Obsidian plugin is not restricted. The rules cover the MCP tools only; Claude Code's own file tools need permission deny rules to keep them out of private folders.

## Using it

The MCP server (`server.py`) provides (all tools accept `zotero/KEY` or `@citekey` for papers) `search_notes`, `read_note`, `note_links`, `related_notes`, `recent_notes` and `index_status`. It is registered in:
- Claude Code: `claude mcp add --scope user obsidian-kb`
- Hermes: `~/.hermes/config.yaml`, under `mcp_servers`

The vault's `CLAUDE.md` tells agents to use it.

From the command line:

```bash
.venv/bin/python kb.py index            # update (text first, then any missing vectors)
.venv/bin/python kb.py search "query" -k 8 [--source ai_notes|personal|Notion|...] [--folder X] [--tag Y]
.venv/bin/python kb.py read "note name or path" [--heading X]
.venv/bin/python kb.py links "note"
.venv/bin/python kb.py stats
.venv/bin/python eval.py [gates...]     # paraphrase recall check; 2026-09-21: hit@5 9/11, hit@1 6/11
```

## Obsidian plugin (Mac and phone)

`obsidian-plugin/` holds "Second Brain Search". Run `./install.sh` to type-check it, build it and copy it into the vault; git sync takes it to the phone. `data.json` (settings and token) stays out of git on purpose.

- **Vault search** (left sidebar, ribbon icon): the agents' search, with a source filter that includes Zotero. Clicking a passage opens the note at that heading; Zotero results open an item panel with Open in Zotero, DOI and Insert/Copy citation.
- **Related notes** (right sidebar):
  - **This section:** notes closest to the heading section or paragraph under the cursor. It re-queries only when the section changes (`POST /similar`).
  - **Linked:** links and backlinks, including `[@citekey]` papers. When the Mac can't be reached it falls back to Obsidian's own link data.
  - **Similar** and **Shared tags**.
- **Links everywhere:** drag a result into a note (desktop), or right-click / long-press to Insert link, Copy link or Open in new tab. Each section can be copied as a list of `[[links]]`.
- **Find duplicate notes** (command): identical notes, nearly identical notes (cosine ≥ 0.985 and length within 20%), duplicate Zotero items (same DOI or title), and sync-conflict copies compared with their originals. It never removes anything on its own: removal is always a click, goes to Obsidian's trash, and bulk removal is offered only for byte-identical copies.
- **Copy for AI** (command, or right-click a note or folder): copies the note plus the notes it links to (depth set in settings, optionally plus the 5 most similar notes) as one Markdown block capped at 200k characters. It works offline on the phone.

**How it connects.** On the Mac the plugin uses `kb.py serve` on 127.0.0.1:27182, starting it if nothing is running. On the phone it uses the Mac's Tailscale address and sends `Authorization: Bearer <data/api-token>`. Setup is one scan of the QR code in the Mac's plugin settings (`obsidian://second-brain-search-setup?url=…&token=…`). The server trusts only requests addressed to localhost and not proxied; everything else needs the token.

**Phone requirements (manual, not yet done):**
1. `tailscale serve --bg --http=27182 http://127.0.0.1:27182`, so tailnet devices reach the server. It stays bound to loopback.
2. A running server. Today that only happens while Obsidian is open on the Mac. An always-on LaunchAgent (`kb.py serve`, KeepAlive) needs the one-time macOS "Documents" permission.

## Web app

Second Brain also runs in a browser, served by the same server: open `http://127.0.0.1:27182/app/` on the Mac. It has Home, Chat (ask, Find papers, reports), the Library table, Notes, the paper and note readers, Routines, Projects and Settings. Zotero and Obsidian do not need to be open.

**On the phone.** Settings has a "Use on your phone" section with a QR code. It encodes the sign-in link `<tailnet address>/app/login#t=<token>`, using the address that `tailscale serve` already forwards to this server (the step above). The sign-in page reads the token from the part after `#`, which browsers never send to a server, removes it from the address bar, posts it once to `/app/login` and receives an `sb_session` cookie. The link shows only in the Mac's own browser: `GET /web/phone-link` answers 403 to anything that arrives through Tailscale. If Tailscale is missing or does not forward to Second Brain, Settings says so and shows the one command to run; it never runs it. The app's files are public to the tailnet and carry no data; every data route needs the token or the cookie.

**Safety.** A request from another website (`Origin` or `Sec-Fetch-Site` says so) gets 403. There are no CORS headers. The web app's own state (preferences, queued adds, sign-in sessions) is in `data/web/` and is never served as a file.

**Releases.** `zotero-plugin/install-web.sh` builds the bundle and copies it into `data/web/`; the next page load shows it. `obsidian-plugin/install.sh` calls it, so installing a release publishes the web app too. The perf run (`perf/run.sh`) has rows for the web app's first load and its streaming render.

## Index status (plugin)

Cmd+P → "Show search index status" (or plugin settings → Index status) opens a panel, on the Mac and the phone. It shows:
- what indexing is doing now, with a progress bar, speed and time left;
- when the last run finished and when the next automatic check is;
- per source, how many items are indexed and what share is searchable by meaning.

Buttons: **Update now**, **Stop** (ends after the current batch; work so far is kept and the next run resumes), **Re-read Zotero** and **Re-read images & PDFs**. On the Mac a status-bar item shows "⟳ Reading PDFs and images 45% · 2 min left" while a run is going.

Under the hood, indexing writes `data/index-progress.json`; the server serves it at `GET /status`, starts runs as separate processes with `POST /index {"reread": "zotero"|"media"}`, and stops them with `POST /index/stop` (SIGTERM, handled as a graceful stop).

## Zotero plugin

`zotero-plugin/` holds "Second Brain" for Zotero 7–10 (bootstrapped add-on). It's packaged as `second-brain-zotero.xpi` with `cd zotero-plugin && zip -qr ../second-brain-zotero.xpi manifest.json bootstrap.js content locale`; install it with Tools → Plugins → gear → Install Plugin From File (a copy placed in the profile's `extensions/` folder has to be enabled once in Tools → Plugins).
- **Item pane section "Second Brain"** for the selected paper: the Obsidian notes citing it (`[@citekey]`), related notes, and similar papers (from `GET /related?path=zotero/KEY`). Notes open in Obsidian (`obsidian://open`); papers are selected in Zotero.
- **Tools → Search Second Brain…** and item right-click **Find Related in Second Brain**: a search window over notes, papers, PDFs and images (↑↓ and Enter to open).
- **API used:** `Zotero.ItemPaneManager.registerSection` and `Zotero.MenuManager.registerMenu`, checked against Zotero 10.0.3's own source.

## Staying fresh

The index server re-indexes changed notes (and Zotero, when its files changed) at startup and every 5 minutes. It re-executes itself when its code changes, and `kb.index()` refuses to run in any process whose loaded code is out of date. A file lock (`data/index.lock`) ensures only one process indexes at a time.

There is no launchd job. A launchd-started Python needs a one-time "allow access to Documents" approval from macOS, and without it the job hangs at the privacy prompt. To add one later, approve the prompt once, then load a LaunchAgent that runs `kb.py index` on a `StartInterval`.

## Files

- `data/kb.sqlite`: the index (notes, chunks with vectors, FTS, links). Delete it to rebuild from scratch.
- `data/index.log`: progress from manual or detached runs.
