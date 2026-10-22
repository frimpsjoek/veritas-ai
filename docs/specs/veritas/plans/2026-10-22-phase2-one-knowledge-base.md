# Veritas Phase 2 — One Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One knowledge base on the server: sources read through registered connectors (Obsidian vault, notes folder, PDF folder, any number of local Zotero libraries, Zotero online), notes written to one output folder (`~/Documents/Veritas` by default), chats mirrored as Markdown, a default library for "+ Add", and the Zotero plugin reduced to a client of the server.

**Architecture:** Reuse the existing server code. `sources.py` already detects folder kinds and `kb._index` already has notes/media/Zotero stages; this phase puts the kinds behind a registry (`connectors.py`), lifts the one-Zotero limit by giving every library after the default a `name:/` prefix like other listed folders, adds a Zotero Web API connector, and moves the "main folder" to an explicit output setting. The agent mirrors chats to Markdown beside its JSONL. The Zotero plugin already prefers the server; this phase removes its local index and in-Zotero agent and adds the server token.

**Tech Stack:** Python 3.12 (server, pytest), Node 22 (agent, `node --test`), Zotero 7 plugin JS.

**Spec:** `docs/specs/veritas/2026-10-22-veritas-design.md` goals 4, 5, 8, 9, 10, 11.

## Global Constraints

- Repo is **public**: no personal paths, names of private folders, tokens or emails in committed files (tests use `tmp_path`).
- Default output folder: `~/Documents/Veritas` (created when first written). A listed Obsidian vault may be chosen instead.
- Everything Veritas writes is plain Markdown with YAML frontmatter.
- Writes into Zotero go through the plugin (local library) or the Zotero Web API (online library); the server never writes `zotero.sqlite`.
- Phase 1 behaviour for an existing `sources.json` with `"main": true` stays (that folder remains the output).
- No pushes; no installs into the live Zotero or vault (those wait for Joseph).
- Each task ends with `./check.sh` green.

## Review Focus

1. **Old links after the output moves.** A chat that cites `ai_notes/x.md` (bare path, old main) must still open once that folder is listed with a prefix → Task 1 test `test_bare_path_falls_back_to_listed_folder`.
2. **Two Zotero libraries with the same item key** (keys are only unique per library) → Task 3 test `test_two_libraries_same_key_are_two_items`.
3. **Zotero Web API rate limits and errors** (`Backoff`, 429, 403 bad key) must not wipe already-indexed items → Task 4 test `test_web_error_keeps_existing_items`.
4. **Chat mirror on a title rename** must rewrite one file, not leave two → Task 6 test `chat mirror: a rename keeps one file`.
5. **Zotero plugin without a server**: it must say the server is not running, not throw → Task 7 check `no local fallback references remain` + manual note in evidence.

---

### Task 1: Output folder

**Files:** Modify `server/sources.py`, `server/kb.py` (`resolve`, `read_note`), `server/http_api.py` (`GET/PATCH /sources`), `server/kb.py` CLI. Test: `server/tests/test_output_folder.py`.

**Interfaces:**
- Produces: `sources.OUTPUT_DEFAULT = Path.home() / "Documents" / "Veritas"`; `sources.set_output(name: str | None) -> None` (a listed obsidian/plain folder name, or `None` for the default); `Layout.main` = the folder marked `"main": true`, else `OUTPUT_DEFAULT` (no longer "first Obsidian vault"); `sources.resolved()` lists `OUTPUT_DEFAULT` as main even when it does not exist yet. `GET /sources` adds `"output": {"name"|null, "path"}`; `PATCH /sources/output {"name": str|null}`; CLI `kb.py sources output [name]`.
- `kb.resolve(path)`: a bare path missing in the main folder resolves to the first listed folder that has that relative path.

- [ ] Tests (fail first): `test_default_output_is_veritas_folder` (no main flag, an Obsidian vault listed → `Layout.main == OUTPUT_DEFAULT`, the vault is a prefixed `other`); `test_main_flag_still_wins`; `test_set_output_to_listed_vault`; `test_set_output_rejects_zotero_and_unknown` (`SourceError`); `test_bare_path_falls_back_to_listed_folder`; `test_output_route` (GET shows output; PATCH changes it).
- [ ] Implement; full server suite green; commit `feat(server): output folder setting, ~/Documents/Veritas by default`.

### Task 2: Connector registry

**Files:** Create `server/connectors.py`; modify `server/sources.py` (`detect`), `server/kb.py` (`_index` stages loop). Test: `server/tests/test_connectors.py`.

**Interfaces:**
- Produces: `@dataclass Connector(kind: str, label: str, detect: Callable[[Path], bool], writes_notes: bool, can_add_items: bool)`; `connectors.REGISTRY: dict[str, Connector]` in detection order `zotero` (has `zotero.sqlite`), `obsidian` (has `.obsidian/`), `pdf` (no notes, ≥1 PDF), `plain`; `connectors.detect(path) -> str` (`"missing"` if absent); `connectors.register(c)`. `sources.detect` delegates to it. The `pdf` kind is indexed by the existing plain/media stages (same as `plain`). `zotero-web` is registered by Task 4 with `detect=lambda p: False` (added by account, not by path).
- [ ] Tests: `test_detect_order` (zotero beats obsidian in one folder), `test_pdf_folder_kind`, `test_register_new_kind_is_detected`, existing `test_sources*` unchanged.
- [ ] Implement; suite green; commit `refactor(server): source kinds behind a connector registry`.

### Task 3: Several local Zotero libraries

**Files:** Modify `server/sources.py` (`resolved`: all enabled libraries read; first enabled = default unless `"default_library"` set), `server/zotero.py` (functions take `library: Path | None = None`, default = `zotero.ZOTERO`), `server/kb.py` (`index_zotero` per library; non-default libraries' paths `"<name>:/" + doc.path`, source `"zotero"`), `server/pdf_route.py`, `server/web_page.py`, `server/http_api.py` (`/zotero*` routes take `?library=<name>`, default library otherwise). Test: `server/tests/test_zotero_libraries.py` (two fixture sqlite libraries built in `tmp_path` from the existing test fixtures' schema helper).

**Interfaces:**
- Produces: `Layout.libraries: list[Folder]` (default first), `Layout.zotero` = default library path (unchanged meaning); `sources.set_default_library(name) -> None`; `zotero.library_for(path: str) -> tuple[Path, str]` (library dir, inner path) from an index path.
- [ ] Tests: `test_second_library_is_indexed_with_prefix`, `test_two_libraries_same_key_are_two_items`, `test_pdf_route_reads_second_library`, `test_default_library_setting`, existing Zotero tests unchanged.
- [ ] Implement; suite green; commit `feat(server): read every enabled Zotero library`.

### Task 4: Zotero online connector

**Files:** Create `server/zotero_web.py`; modify `server/sources.py` (entries `{"name","kind":"zotero-web","user_id","enabled"}` with no path), `server/kb.py` (stage `index_zotero_web`), `server/http_api.py` (`POST /sources {"kind":"zotero-web","user_id","name"?}`). Key: macOS Keychain service `second-brain` account `zotero-web:<user_id>` via `security find-generic-password` (same store as spec 020 hidden keys), env `VERITAS_ZOTERO_KEY` overrides for tests. Test: `server/tests/test_zotero_web.py` with a fake HTTP opener.

**Interfaces:**
- Produces: `zotero_web.Client(user_id: str, key: str, opener=urllib.request.urlopen)`, `.items(since: int) -> tuple[list[dict], int]` (paged `GET /users/<id>/items?since=&start=&limit=100&format=json`, `Last-Modified-Version` returned), `.fulltext(key) -> str | None`, `.create(item: dict) -> str` (POST `/users/<id>/items`, returns new key); `zotero_web.documents(entry, client) -> list[zotero.Doc]` (title, authors, year, DOI, abstract, notes as text; paths `"<name>:/zotero/<key>"`). Index keeps a `meta` row `zotero-web:<name>:version` for incremental sync.
- [ ] Tests: `test_items_paged_and_versioned`, `test_documents_from_items`, `test_web_error_keeps_existing_items` (403/429 → stage reports error, rows stay), `test_create_item_posts_json`.
- [ ] Implement; suite green; commit `feat(server): Zotero online library connector`.

### Task 5: Default library for "+ Add"

**Files:** Modify `server/pending_adds.py`, `server/http_api.py` (`/zotero/add`). Test: `server/tests/test_pending_adds_target.py`.

**Interfaces:** Consumes `sources.set_default_library`, `zotero_web.Client.create`. `pending_adds.add(item)` → if the default library is `zotero-web`, `Client.create` and return `{"added": key, "library": name}`; else the existing local queue (unchanged).
- [ ] Tests: `test_add_goes_to_local_queue_by_default`, `test_add_goes_to_web_library_when_default`.
- [ ] Implement; suite green; commit `feat(server): "+ Add" goes to the default library`.

### Task 6: Chats mirrored as Markdown

**Files:** Create `agent/src/chat-markdown.js`; modify `agent/src/store.js` (optional mirror hook), `agent/src/node/agentd.mjs` (`--notes <dir>`), `server/agent_api.py` (`_spawn` passes `--notes str(kb.VAULT)`). Tests: `agent/test/chat-markdown.test.js`, `server/tests/test_agent_api.py` addition.

**Interfaces:**
- Produces: `chatMarkdown(records: object[]) -> { name: string, text: string }` (name `YYYY-MM-DD <title> (<id first 8>).md`, sanitised; text = frontmatter `id`, `created`, `updated`, `type: chat` + `# title` + one `## You` / `## Veritas` section per turn, citations kept as written); `conversationStore(fs, dir, { mirrorDir? })` writes the mirror after every `append`, removes the previous name on rename, removes the file on `remove`.
- [ ] Tests: `chat mirror: one file per chat with frontmatter and turns`, `chat mirror: a rename keeps one file`, `chat mirror: remove deletes the file`, `chat mirror: no mirrorDir writes nothing`; server `test_spawn_passes_notes_dir`.
- [ ] Implement; agent + server suites green; commit `feat(agent): chats mirrored as Markdown in the notes folder`.

### Task 7: Zotero plugin as a client

**Files:** Delete `zotero/engine-src/`, `zotero/content/local-index.js`, `agent/src/gecko/`, `agent/test/gecko-*.test.js`, `LocalStore` in `zotero/content/store.js`, local paths in `zotero/content/agent-host.js` (`startLocal`, `ZoteroLibrary` local fallbacks, mirror/adopt), `searchLocally`/`similarLocally`/`planWithoutServer` fallbacks in `zotero/content/second-brain.js`, model section of `zotero/content/preferences.js`. Modify `zotero/build-agent.mjs` (entry = a new `agent/src/remote-entry.js` exporting `createRemoteRuntime` and `MCP_CATALOG` as the `SecondBrainAgent` global), `zotero/build.sh` (no engine-src), `zotero/content/second-brain.js` (`extensions.secondbrain.token` pref → `Authorization: Bearer` on every server call; offline = a "Veritas server is not running" state), `zotero/content/preferences.*` (token field). Tests: `zotero/test/client-only.test.mjs`.

**Interfaces:** Consumes `agent/src/remote.js` `createRemoteRuntime`. Produces `content/agent.js` exposing `SecondBrainAgent.createRemoteRuntime`, `SecondBrainAgent.MCP_CATALOG`.
- [ ] Tests: `no local fallback references remain` (grep content/*.js for `localIndex`, `startLocal`, `LocalStore`, `engine.js`, `searchLocally` → none), `every server call sends the token pref` (static check that `sb.api`/`sb.post`/`fetch` helpers set Authorization from the pref), `agent bundle exposes the remote runtime only` (build, then `content/agent.js` contains `createRemoteRuntime` and not `createLocalRuntime`).
- [ ] `./check.sh` green (ui drift guards updated where they read removed files); commit `refactor(zotero): client of the Veritas server only`.

### Task 8: Evidence

- [ ] Restart the smoke server (port 27191) on this phase's code: `GET /sources` shows output `~/Documents/Veritas`; add a temp PDF folder → kind `pdf`; a chat through `/agent` produces a `.md` in `<output>/chats/`. Record in `docs/specs/veritas/phase2-evidence.md` (no personal paths: write `~` and folder names only). Commit.
