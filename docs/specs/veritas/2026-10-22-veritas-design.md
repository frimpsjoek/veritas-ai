# Veritas — design

Date: 2026-10-22. Status: draft for Joseph's approval.
Starting point: the three dev clones on this Mac in `~/Documents/second-brain-dev/`
(`obsidian-kb` and `zotero-plugin` on `ai/web-page`, `obsidian-plugin` on `ai/015-folders`), not the other computer.

## Intent

Second Brain is three repos that reach into each other through sibling paths: the web app lives inside the Zotero
plugin repo (`ui-src/src/web`), the Obsidian plugin imports `../zotero-plugin/ui-src`, and `install-web.sh` copies the
web build into the server. The shared UI kit sits inside the Zotero repo, so every app depends on the Zotero repo.
It also assumes one Obsidian vault ("Second-Brain") and one Zotero library.

Veritas replaces it with one new repo, organised as separate parts with enforced boundaries, and a server that reads
any set of sources through connectors. Only Joseph's Mac runs Second Brain today, so Veritas starts as a new tool:
no compatibility with old installs, no update redirects.

## Goals

1. **One new private GitHub repo, `frimpsjoek/veritas`**, holding every part:

   ```
   veritas/
     server/      Python server (from obsidian-kb): sources, index, search, agent host, auth, HTTP API
     agent/       Node agent (from zotero-plugin/agent-src): agentd sidecar + shared agent logic
     ui/          shared UI kit (from zotero-plugin/ui-src minus src/web): dom, icons, chat, home, panels,
                  settings, styles, fonts, home-assets
     web/         web app (from ui-src/src/web + build-web.mjs + PDF.js vendor files)
     zotero/      Zotero plugin (rest of zotero-plugin: bootstrap, content, engine-src, editor-src, locale)
     obsidian/    Obsidian plugin (from obsidian-plugin)
     docs/specs/  all specs, one numbering, carried over from obsidian-kb/specs (incl. ROADMAP.md)
   ```

   Note (checked in code): the Zotero plugin today also runs standalone, with its own local index (`engine-src`,
   `content/local-index.js`), an in-Zotero agent host (`content/agent-host.js`) and data in `<Zotero data>/second-brain/`.
   Today's main output folder is `~/Documents/lab-notebook` (`main: true` in `data/sources.json`), not the Second-Brain vault.
   Chats, radar state and routines are JSONL/JSON under `data/agent/`, plus `radar-fulltext.sqlite`.

2. **Enforced boundaries.** `web/`, `zotero/`, `obsidian/` may import `ui/` and `agent/`; never each other.
   `ui/` imports nothing from the apps. `server/` imports no JS; apps reach it only over HTTP. A boundary check
   script runs in CI and in the local test command and fails on a forbidden import or a `../` path out of a part.

3. **Web app separate from any server.** Built as static files, hosted once (default: GitHub Pages of the repo),
   and on first launch shows a setup screen: server URL + sign-in. It remembers servers and can switch between them.
   The phone QR link from the Mac carries both server URL and token, so a phone just scans.

4. **Sources as connectors.** The server reads any number of sources, each through a connector module with one
   interface (list items, read text/PDF/attachments, detect changes, stable item IDs). Launch connectors:
   1. Obsidian vault
   2. plain Markdown notes folder
   3. PDF folder
   4. Zotero local: read-only snapshot of `zotero.sqlite` + storage folder (today's `zotero.py`)
   5. Zotero online: Zotero Web API with user ID + API key (new; key stored in Keychain)

   Any number of each, including several Zotero libraries (today only one is read). A new source type = one new
   module registered in one place; search, index and apps need no change.

5. **Everything Veritas writes is plain Markdown.** AI notes, digests, paper notes, skills, chat exports: `.md` files
   with YAML frontmatter, readable and editable in any editor. The output folder is one setting (any folder),
   replacing today's required "main vault". The search index, embeddings and snapshots are caches: deleting them and
   re-indexing loses nothing.

6. **Setup on first launch** in every app (web, Zotero, Obsidian): connect to a server, then add sources (name, type
   detected or picked, path or account) and pick the notes output folder.

7. **Carries over all current behaviour** at the starting commits: search, chat/agent, radar (incl. radar-seeds),
   progress bar, hidden keys, folder sources, web page route, PDF reader, phone sign-in. Existing tests move with
   their code and pass.

8. **One knowledge base, on the server.** The Zotero plugin stops running standalone: its own index
   (`engine-src`, `content/local-index.js`), in-Zotero agent host (`content/agent-host.js`) and
   `<Zotero data>/second-brain/` storage are removed. Like the web app and Obsidian plugin, it is a client of the
   Veritas server over HTTP. `agent/` then only needs to run as `agentd` under the server. (Decided by Joseph.)

9. **Where notes go.** Default output folder: a new `~/Documents/Veritas/` created at setup (path is Claude's call).
   If the user has added an Obsidian vault as a source, setup offers it as the output instead; they choose. The
   choice can be changed later in settings. (Decided by Joseph.) Claude's call: notes Second Brain already wrote
   (e.g. in `~/Documents/lab-notebook`) stay where they are and are read as an ordinary source; old `[[Note]]`
   links in saved chats resolve through a lookup from old path to new source + item ID.

10. **Chats as Markdown.** Each chat is also written as one readable `.md` file (one per conversation, in the
    output folder's `chats/`), kept current as the chat grows; the JSONL under `data/agent/chats` stays as the
    app's working store. Radar state, routines and settings stay JSON (plain text). (Decided by Joseph.)

11. **Adding papers.** Setup asks for one default library for "+ Add" and pending adds, local or online. The
    Zotero online connector is read-write (adds items through the Zotero Web API); the local connector adds through
    the Zotero plugin as today. Other connectors are read-only. (Decided by Joseph.)

12. **Desktop app is the main way in.** `app/`: a Tauri shell with a Vite front end (the `web/` + `ui/` front end,
    built with Vite). The app bundles the backend: on launch Tauri starts the Python knowledge-base server and the
    Node agent (`agentd`) as sidecars and stops them on quit; the user installs no Python or Node. By default it uses
    its own bundled server and can also connect to another Veritas server. The browser/phone version (same front end,
    QR sign-in from the Mac) stays alongside. Zotero and Obsidian plugins connect to the running app's local port.
    (Decided by Joseph.) Claude's call: the Python server is packaged as one executable (PyInstaller) for the sidecar;
    no rewrite in Rust.

## Non-goals

- Merging or porting unpushed work from Joseph's other computer (its 015–017 specs). That is a later, separate job.
- Moving or renaming Joseph's vault (`~/Documents/Second-Brain`) or any of his note folders. Veritas only reads them
  and writes to the output folder he picks.
- Multi-user accounts, sharing, or a hosted Veritas server. One server per person; anyone can run their own.
- Connectors beyond the five above (Notion, YouTube, etc. stay as they work today, if they do, or wait).
- Publishing to the Obsidian community store or Zotero's plugin listing.

## Anti-goals (would count as failure even if it runs)

- Any part importing from a sibling app's folder, or a build that only works with a particular sibling layout.
- Notes or settings Joseph cares about stored only in a database or opaque format.
- Losing data from the current setup: `data/sources.json`, the API token, sessions, radar state, Keychain keys.
- The old repos deleted or force-pushed. They are archived after Veritas runs, read-only.

## Constraints

- macOS case-insensitive filesystem: the clone must not be `~/Documents/second-brain` (that is the vault). Clone at
  `~/Documents/second-brain-dev/veritas`.
- Veritas is a fresh copy with new git history (decided by Joseph): files copied from the source branch tips, source SHAs
  recorded. It runs as a new server with its own data; the old repos and the running Second Brain server are untouched.
- Auth moves to **Bearer tokens** for the web app (already supported by `http_api.py` alongside the `sb_session`
  cookie): a cross-origin page cannot rely on the cookie. The server adds CORS for configured web-app origins.
- HTTPS: a page on HTTPS can reach `http://localhost` and HTTPS servers, not plain-HTTP LAN IPs. Phone use goes through
  the HTTPS address `phone_link()` already produces. The setup screen says this when a plain-HTTP non-localhost URL is
  entered.
- Bundle stays lazy for PDF.js (as now). Python env: `.venv` in `server/`; tests with `KB_BACKEND=onnx`.
- Pushing the new repo, creating the GitHub repo, enabling Pages, and archiving old repos are Joseph-approved steps.

## Decided with Joseph

- One repo, parts as folders (not 4–5 repos).
- Name: Veritas.
- Web app points at whichever server it is given; setup at first launch.
- Extensible sources: vaults, notes folders, PDF folders, Zotero local (sqlite) and Zotero online.
- All notes as `.md`.
- Treated as a new tool; only Joseph's Mac uses it.
- One knowledge base on the server; no standalone copy in the Zotero plugin.
- Notes go to a new Veritas folder by default, or to an Obsidian vault if the user has one and picks it.
- Chats saved as readable .md (JSON kept for the app); one default library for "+ Add", online Zotero can write.
- Build from this Mac's code.
- Main app: Tauri + Vite desktop app bundling the KB backend; browser/phone version stays; repo first, app after.

## Calls made by Claude (check these)

- Product name "Veritas" everywhere it is user-visible and in IDs: plugin IDs, package names, Keychain service
  `veritas`, env vars `VERITAS_*` (replacing `KB_*` and `SECOND_BRAIN_*`), data folder `~/Library/Application Support/Veritas`
  (or `server/data/` in dev). Joseph's vault folder is not renamed.
- One-time copy script (not a move) copies current server data (sources list, token, sessions, radar state) into Veritas's data
  folder; no migration code inside the app.
- Web app hosted on GitHub Pages of `veritas` (private repo → needs Pages on a plan that allows it; fallback: the server
  keeps serving the built web app at `/app/` as a convenience, same build).
- Spec numbering in `docs/specs/` keeps this Mac's numbers (001–022) and continues from 023.
- The one-time copy script also copies Keychain entries (service `second-brain` → `veritas`) and the plugins'
  settings; the originals stay. Second Brain keeps running beside Veritas until Joseph retires it, so Veritas must
  not collide with it: own port (dev 27190; Phase 5 picks the default), own data folder, and from Phase 5 own plugin
  IDs. Until Phase 5, the Veritas Zotero/Obsidian builds are not installed into the live Zotero or vault.
- Cross-origin files (note images `/file?...`, PDFs, the browser-panel iframe): the web app fetches images and PDFs
  with the Bearer header and shows them as blob URLs (PDF.js gets the bytes, not a URL). The iframe gets a
  short-lived, single-use ticket in its URL (minutes, scoped to that one page); the long-lived token never goes in a URL.
- The web build is host-agnostic. Default host is GitHub Pages; the site is public even from a private repo, which is
  fine because the build holds no secrets. The server still serves the same build at `/app/` as a convenience.

## Left to the builder

- Exact connector interface signatures and how the index stores source + item IDs.
- Merge mechanics for history, CI layout, workspace tooling (npm workspaces or plain folders).
- How the Zotero plugin and Obsidian plugin find their server (default `http://localhost:<port>`, editable).
- Order of work, as long as each step leaves tests green.
